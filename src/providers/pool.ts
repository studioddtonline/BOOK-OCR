import type { DatabaseSync } from "node:sqlite";
import { getProviderUsageToday, markProviderExhausted, recordProviderRequest, usageDate } from "../db/index.js";
import type { ImageInput } from "../image-file.js";
import { toFailure, type Failure } from "./errors.js";
import { ProviderHealth } from "./health.js";
import type { OcrCallResult, OcrProvider } from "./types.js";

export type ProviderSelection =
  | { kind: "ok"; provider: OcrProvider }
  /** 使える枠はあるが、全て一時的に休止中。waitMs後に再挑戦できる。 */
  | { kind: "backoff"; waitMs: number }
  /** 全て本日分の上限(または枯渇)に達している。 */
  | { kind: "exhausted" }
  /** 全て設定エラーで無効化されている。待っても直らない。 */
  | { kind: "all_disabled" };

export type AttemptResult =
  | { ok: true; result: OcrCallResult }
  /** failure に応じたプロバイダの状態更新(無効化・枯渇・休止)は済んでいる。 */
  | { ok: false; failure: Failure; backoffMs?: number };

export interface ProviderPoolOptions {
  health?: ProviderHealth;
  /** 使用量の「1日」の区切りに使うタイムゾーン。既定はUTC。 */
  usageTimeZone?: string;
  /** テスト用の時計。 */
  clock?: () => number;
}

/**
 * 使うプロバイダの集まり。「どれを使うか選ぶ」「呼ぶ」「結果に応じて状態を更新する」を
 * ここに集約し、ワーカーは select() と attempt() だけを使う。
 *
 * 状態:
 *  - 無効化(設定エラー): このプロセスの間だけ(メモリ)
 *  - 休止(一時的なサーバーエラー): このプロセスの間だけ(ProviderHealth)
 *  - 使用量・枯渇: DB(provider_usage)。再起動しても保たれる
 */
export class ProviderPool {
  readonly health: ProviderHealth;
  private readonly disabled = new Set<string>();
  private readonly timeZone: string;
  private readonly clock: () => number;

  constructor(
    private readonly db: DatabaseSync,
    readonly providers: readonly OcrProvider[],
    opts: ProviderPoolOptions = {},
  ) {
    this.health = opts.health ?? new ProviderHealth();
    this.timeZone = opts.usageTimeZone ?? "UTC";
    this.clock = opts.clock ?? Date.now;
  }

  private today(now: number): string {
    return usageDate(new Date(now), this.timeZone);
  }

  disable(name: string): void {
    this.disabled.add(name);
  }

  isDisabled(name: string): boolean {
    return this.disabled.has(name);
  }

  /**
   * priority の順に見て、「無効化されておらず」「本日枯渇しておらず」「上限未満で」
   * 「休止中でもない」最初のプロバイダを返す。
   */
  select(now = this.clock()): ProviderSelection {
    const candidates = this.providers.filter((p) => !this.disabled.has(p.name));
    if (candidates.length === 0) return { kind: "all_disabled" };

    const date = this.today(now);
    let earliestRelease: number | undefined;
    for (const provider of candidates) {
      const usage = getProviderUsageToday(this.db, provider.name, date);
      if (usage.isExhausted || usage.requestCount >= provider.dailyRequestLimit) continue;

      const until = this.health.blockedUntil(provider.name);
      if (until > now) {
        earliestRelease = earliestRelease === undefined ? until : Math.min(earliestRelease, until);
        continue;
      }
      return { kind: "ok", provider };
    }

    if (earliestRelease !== undefined) {
      return { kind: "backoff", waitMs: Math.max(earliestRelease - now, 1000) };
    }
    return { kind: "exhausted" };
  }

  /**
   * OCRを1回試みる。成功なら使用量を記録し、失敗なら種類に応じてプロバイダの状態を更新する。
   *
   * 使用量・枯渇フラグの記録はあくまで目安なので、その書き込みがDBロック等で失敗しても、
   * 取得済みのOCR結果を失ったり、元のエラーを別のエラーで覆い隠したりしないよう、
   * 失敗は警告だけにして握りつぶす(APIのレート制限枠を消費して得た結果の方が貴重)。
   */
  async attempt(provider: OcrProvider, image: ImageInput, prompt: string): Promise<AttemptResult> {
    let result: OcrCallResult;
    try {
      result = await provider.callOcr(image, prompt);
    } catch (err) {
      return this.applyFailure(provider, toFailure(err));
    }

    this.health.recordSuccess(provider.name);
    try {
      recordProviderRequest(this.db, provider.name, this.today(this.clock()));
    } catch (dbErr) {
      console.warn(`  -> ${provider.name} の使用量を記録できませんでした(DBロック?)。OCR結果はそのまま保存を試みます: ${(dbErr as Error).message}`);
    }
    return { ok: true, result };
  }

  private applyFailure(provider: OcrProvider, failure: Failure): AttemptResult {
    switch (failure.kind) {
      case "config_error":
        // モデル名誤り・APIキー不正・受け付けないoptionsなど。リトライしても直らないので、
        // このプロセスが生きている間は無効化する。
        this.disable(provider.name);
        return { ok: false, failure };
      case "rate_limited":
        try {
          markProviderExhausted(this.db, provider.name, this.today(this.clock()));
        } catch (dbErr) {
          console.warn(`  -> ${provider.name} の枯渇フラグを記録できませんでした(DBロック?): ${(dbErr as Error).message}`);
        }
        return { ok: false, failure };
      case "server_error":
        return { ok: false, failure, backoffMs: this.health.recordTransientFailure(provider.name, this.clock()) };
      case "image_error":
        return { ok: false, failure };
    }
  }
}
