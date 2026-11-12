import type { OcrLogOutcome } from "../db/index.js";
import type { FailureKind } from "../providers/errors.js";

/** 失敗した行を、キューと ocr_log にどう記録するか。 */
export interface QueueFailureDecision {
  outcome: OcrLogOutcome;
  /** 失敗回数(retry_count)を増やすか。画像側の問題だけ true。 */
  countRetry: boolean;
  /** true なら status='error'(人間の確認待ち)。false なら 'pending' に戻して再挑戦する。 */
  permanent: boolean;
}

/**
 * 失敗の種類ごとの扱い。READMEの「エラーの扱い」の表と1対1で対応する。
 * プロバイダ側の状態更新(無効化・枯渇・休止)は ProviderPool が行う。
 *
 *  種類          記録(outcome)   失敗回数  行の状態
 *  rate_limited  rate_limited    増やさない pending(次のプロバイダで再挑戦)
 *  config_error  config_error    増やさない pending(そのプロバイダは無効化)
 *  server_error  server_error    増やさない pending(そのプロバイダを休止)
 *  image_error   error           増やす     上限に達したら error、それまでは pending
 */
export function decideQueueFailure(kind: FailureKind, retryCount: number, maxRetries: number): QueueFailureDecision {
  switch (kind) {
    case "rate_limited":
      return { outcome: "rate_limited", countRetry: false, permanent: false };
    case "config_error":
      return { outcome: "config_error", countRetry: false, permanent: false };
    case "server_error":
      return { outcome: "server_error", countRetry: false, permanent: false };
    case "image_error":
      return { outcome: "error", countRetry: true, permanent: retryCount + 1 >= maxRetries };
  }
}
