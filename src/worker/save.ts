import type { DatabaseSync } from "node:sqlite";
import { completeQueueItem, isBusyError, type CompleteResult, type OcrSavePayload, type QueueRow } from "../db/index.js";
import { appendRescueLog } from "../rescue.js";

export interface SaveOptions {
  /** 試行回数(最初の1回を含む)。 */
  attempts: number;
  /** リトライ間の待ち時間(ミリ秒)。試行回数を掛けて使う。 */
  retryWaitMs: number;
  rescueLogPath: string;
  /** 待機の実装(停止シグナルで中断できるもの)。 */
  sleep: (ms: number) => Promise<void>;
}

/**
 * OCR結果をDBに保存する。ロック(BUSY)で失敗したら数回リトライし、それでも駄目、
 * またはロック以外の理由で失敗したら rescue.jsonl に退避する。
 * OCR結果は既にAPIのレート制限枠を消費済みの貴重なデータなので、簡単には諦めない。
 */
export async function saveResultWithRetry(
  db: DatabaseSync,
  item: QueueRow,
  payload: OcrSavePayload,
  opts: SaveOptions,
): Promise<CompleteResult | "db_failed"> {
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return completeQueueItem(db, item, payload);
    } catch (err) {
      const isLast = attempt === opts.attempts;
      if (!isBusyError(err) || isLast) {
        appendRescueLog(opts.rescueLogPath, item, payload, err);
        console.error(
          `\n  -> DBへの保存に失敗しました(OCR自体は成功しています)。\n` +
            `     結果は ${opts.rescueLogPath} に退避しました。DB復旧後、\`rescue apply\` で反映できます。\n` +
            `     キューの行は処理中のまま残り、次回のworker起動時に pending に戻ります。\n`,
        );
        return "db_failed";
      }
      console.warn(`  -> DB書き込みに失敗(ロック中?)。${attempt}回目のリトライを行います...`);
      // busy_timeoutで既に待った上でさらに失敗しているので、少し長めに待ってから再試行する
      await opts.sleep(opts.retryWaitMs * attempt);
    }
  }
  return "db_failed";
}
