import type { DatabaseSync } from "node:sqlite";
import {
  claimNextQueueItem,
  failQueueItem,
  hasPendingQueueItems,
  isBusyError,
  markQueueItemError,
  resetProcessingToPending,
  type AttemptMeta,
  type QueueRow,
} from "../db/index.js";
import { readImageFile } from "../image-file.js";
import { OCR_PROMPT, OCR_PROMPT_HASH } from "../ocr/prompt.js";
import { toFailure, type Failure } from "../providers/errors.js";
import type { ProviderHealth } from "../providers/health.js";
import { ProviderPool } from "../providers/pool.js";
import type { OcrProvider } from "../providers/types.js";
import { decideQueueFailure } from "./failure-policy.js";
import { preflight } from "./preflight.js";
import { printStartupReport } from "./report.js";
import { saveResultWithRetry } from "./save.js";
import { StopController } from "./stop-controller.js";

export { StopController } from "./stop-controller.js";

/** 画像側の問題での失敗が、この回数に達したら 'error' として人間の確認待ちにする。 */
const DEFAULT_MAX_RETRIES = 5;
/** 全プロバイダが本日分の上限に達しているときに待つ時間。 */
const DEFAULT_EXHAUSTED_SLEEP_MS = 5 * 60 * 1000;
/** OCR成功後のDB保存がロック等で失敗した場合の再試行回数。 */
const DEFAULT_SAVE_RETRIES = 3;
const DEFAULT_SAVE_RETRY_WAIT_MS = 1500;

export interface RunWorkerOptions {
  db: DatabaseSync;
  /** priority順に並んだ、使用するプロバイダ。pool を渡した場合は無視される。 */
  providers?: readonly OcrProvider[];
  /** 既存のプール(テストや拡張用)。省略すると providers から作る。 */
  pool?: ProviderPool;
  health?: ProviderHealth;
  usageTimeZone?: string;
  /** OCR成功後のDB保存が最終的に失敗した場合の退避先(JSON Lines)。 */
  rescueLogPath: string;
  /** 1件処理するごとに空ける間隔(APIへの連続アクセスを避ける)。キューが空のときの待機間隔も兼ねる。 */
  pollIntervalMs: number;
  /** キューが空、または使えるプロバイダが無くなったら終了する(主にテスト用)。 */
  stopWhenIdle?: boolean;
  maxRetries?: number;
  exhaustedSleepMs?: number;
  saveRetries?: number;
  /** 保存リトライの待ち時間(ミリ秒)。試行回数を掛けて使う。 */
  saveRetryWaitMs?: number;
}

export type WorkerExit = "idle" | "exhausted" | "all_disabled" | "stopped";

export async function runWorker(opts: RunWorkerOptions, ctl = new StopController()): Promise<WorkerExit> {
  const { db } = opts;
  const pool =
    opts.pool ?? new ProviderPool(db, opts.providers ?? [], { health: opts.health, usageTimeZone: opts.usageTimeZone });
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const exhaustedSleepMs = opts.exhaustedSleepMs ?? DEFAULT_EXHAUSTED_SLEEP_MS;

  const reset = resetProcessingToPending(db);
  if (reset > 0) {
    console.log(`前回の中断で「処理中」のまま残っていた ${reset} 件を pending に戻しました。`);
  }
  printStartupReport(db, pool.providers);

  let idleLogged = false;

  while (!ctl.stopped) {
    if (!hasPendingQueueItems(db)) {
      if (opts.stopWhenIdle) return "idle";
      if (!idleLogged) {
        console.log("処理待ちの画像がありません。新しい画像が追加されるまで待機します。");
        idleLogged = true;
      }
      await ctl.sleep(opts.pollIntervalMs);
      continue;
    }
    idleLogged = false;

    const selection = pool.select();
    if (selection.kind === "all_disabled") {
      console.error(
        "\n全てのプロバイダが設定エラーで使用不能です。" + "config.json のモデル名・options と .env のAPIキーを確認してください。\n",
      );
      return "all_disabled";
    }
    if (selection.kind === "exhausted") {
      if (opts.stopWhenIdle) return "exhausted";
      console.log(`全プロバイダが本日分の上限に達しています。${Math.round(exhaustedSleepMs / 60000)}分待機します。`);
      await ctl.sleep(exhaustedSleepMs);
      continue;
    }
    if (selection.kind === "backoff") {
      console.log(`全プロバイダが一時休止中です。${Math.ceil(selection.waitMs / 1000)}秒待機します。`);
      await ctl.sleep(selection.waitMs);
      continue;
    }

    const item = claimNextQueueItem(db);
    if (!item) continue; // 他のプロセスに先に取られた

    await processItem(item, selection.provider);
    await ctl.sleep(opts.pollIntervalMs);
  }
  return "stopped";

  async function processItem(item: QueueRow, provider: OcrProvider): Promise<void> {
    const pre = preflight(db, item);
    if (!pre.ok) {
      rejectBeforeCall(item, pre.message, pre.orphan === true);
      return;
    }

    console.log(`OCR実行: queue#${item.id} source_image#${item.source_image_id} ${item.image_path} (provider=${provider.name})`);

    const meta: AttemptMeta = {
      provider: provider.name,
      model: provider.model,
      promptHash: OCR_PROMPT_HASH,
      requestOptions: JSON.stringify(provider.options),
    };

    // --- API呼び出し ---
    let image;
    try {
      image = readImageFile(item.image_path);
    } catch (err) {
      handleFailure(item, provider, meta, toFailure(err), undefined);
      return;
    }
    const attempt = await pool.attempt(provider, image, OCR_PROMPT);
    if (!attempt.ok) {
      handleFailure(item, provider, meta, attempt.failure, attempt.backoffMs);
      return;
    }
    const result = attempt.result;

    // --- 結果の保存 ---
    const saved = await saveResultWithRetry(
      db,
      item,
      { ...meta, provider: provider.name, model: provider.model, ocrText: result.text, rawResponse: safeStringify(result.raw) },
      {
        attempts: opts.saveRetries ?? DEFAULT_SAVE_RETRIES,
        retryWaitMs: opts.saveRetryWaitMs ?? DEFAULT_SAVE_RETRY_WAIT_MS,
        rescueLogPath: opts.rescueLogPath,
        sleep: (ms) => ctl.sleep(ms),
      },
    );
    switch (saved) {
      case "saved":
        console.log(`  -> 完了 (${result.text.length}文字)`);
        break;
      case "reviewed":
        console.warn("  -> OCR中にレビュー済みになったため、結果は ocr_text に反映しませんでした(AIの出力は ocr_log に残してあります)。");
        break;
      case "missing":
        console.warn("  -> 格納先の source_images 行が無くなっていたため、結果を捨てました。");
        break;
      case "db_failed":
        // 結果は rescue.jsonl に退避済み。キューの行は 'processing' のまま残り、次回の起動時に pending に戻る。
        break;
    }
  }

  /** APIを呼ぶ前に、処理できないと分かった行を 'error' にして人間の確認待ちにする。 */
  function rejectBeforeCall(item: QueueRow, message: string, orphan: boolean): void {
    if (orphan) {
      // 格納先が無いので、外部キーの都合で ocr_log にも書けない。キューの行だけ error にする。
      markQueueItemError(db, item, message);
    } else {
      failQueueItem(db, item, { outcome: "error", provider: null, model: null, message, countRetry: false, permanent: true });
    }
    console.error(`[要確認] queue#${item.id} (source_image#${item.source_image_id}) を error にしました: ${message}`);
  }

  function handleFailure(item: QueueRow, provider: OcrProvider, meta: AttemptMeta, failure: Failure, backoffMs: number | undefined): void {
    const decision = decideQueueFailure(failure.kind, item.retry_count, maxRetries);
    try {
      failQueueItem(db, item, { ...meta, ...decision, message: failure.message, httpStatus: failure.status ?? null });
    } catch (err) {
      if (!isBusyError(err)) throw err;
      // 失敗の記録がロックで書けなかった。落ちずに続行し、行は 'processing' のまま残して、
      // 次回の起動時に pending に戻す。
      console.warn(`  -> 失敗の記録がDBロックで書けませんでした。行は処理中のまま残り、次回の起動時に pending に戻ります: ${failure.message}`);
      return;
    }

    switch (failure.kind) {
      case "config_error":
        console.error(
          `\n  -> ${provider.name} の設定に問題があります。このプロバイダを無効化します。\n` +
            `     ${failure.message}\n` +
            `     config.json の providers の name="${provider.name}" の model / options と .env のAPIキーを確認してください。\n`,
        );
        break;
      case "rate_limited":
        console.log(`  -> ${provider.name} がレート制限。本日分は使用不可としてマークし、キューに戻します。`);
        break;
      case "server_error":
        console.log(
          `  -> ${provider.name} で一時的なサーバー側エラー${failure.status ? `(${failure.status})` : ""}。` +
            `${Math.round((backoffMs ?? 0) / 1000)}秒休止し、画像はキューに戻します(失敗回数には数えません)。`,
        );
        break;
      case "image_error":
        if (decision.permanent) {
          console.error(
            `[要確認] queue#${item.id} (source_image#${item.source_image_id}) が ${maxRetries} 回失敗したため error にしました: ${failure.message}\n` +
              `  再試行するには、\`queue retry ${item.id}\` を実行してください。`,
          );
        } else {
          console.error(`  -> 画像側のエラー(${item.retry_count + 1}/${maxRetries}回目)。キューに戻します: ${failure.message}`);
        }
        break;
    }
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
