/**
 * レート制限(429相当)。そのプロバイダを本日分「枯渇」としてマークする。
 */
export class RateLimitError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

/**
 * モデル名の誤り・APIキー不正・モデルが受け付けないオプションなど、
 * 設定を直さない限り何度リトライしても必ず失敗する種類のエラー。
 * 画像側の問題ではないので、そのプロバイダをセッション中は無効化する。
 */
export class ProviderConfigError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

/**
 * サーバー側の一時的な問題(5xx・タイムアウト・ネットワーク断)。
 * 画像のせいではないので失敗回数には数えず、そのプロバイダを一定時間休ませる。
 */
export class TransientServerError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "TransientServerError";
  }
}

function getStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/** 400: リクエスト不正 / 401,403: 認証・権限 / 404: モデルが存在しない */
export function isConfigErrorStatus(status: number | undefined): boolean {
  return status === 400 || status === 401 || status === 403 || status === 404;
}

export function isTransientStatus(status: number | undefined): boolean {
  return status !== undefined && (status === 408 || (status >= 500 && status <= 599));
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (getStatus(err) !== undefined) return false; // HTTPステータスが付いているものはそちらで判定する

  const names = [err.name, err.constructor?.name];
  if (names.some((n) => n === "APIConnectionError" || n === "APIConnectionTimeoutError" || n === "TimeoutError" || n === "AbortError")) {
    return true;
  }
  const code = (err as { code?: unknown }).code ?? (err as { cause?: { code?: unknown } }).cause?.code;
  if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) return true;

  return /fetch failed|socket hang up|network|timed out|timeout/i.test(err.message);
}

/**
 * SDKが投げた生のエラーを、ワーカーが扱い分けられる種類のどれかに分類する。
 * - RateLimitError / ProviderConfigError / TransientServerError: プロバイダ側の事情
 * - それ以外(元のエラーのまま返す): 画像側の問題として、失敗回数を数える
 */
export function classifyProviderError(providerName: string, err: unknown): unknown {
  if (err instanceof RateLimitError || err instanceof ProviderConfigError || err instanceof TransientServerError) {
    return err;
  }
  const status = getStatus(err);
  const message = err instanceof Error ? err.message : String(err);

  if (status === 429 || /RESOURCE_EXHAUSTED|rate limit/i.test(message)) {
    return new RateLimitError(providerName, message);
  }
  if (isConfigErrorStatus(status)) {
    return new ProviderConfigError(providerName, message);
  }
  if (isTransientStatus(status) || isNetworkError(err)) {
    return new TransientServerError(providerName, message, status);
  }
  return err;
}

// ---------------------------------------------------------------------------
// 失敗の種類(ワーカーとプールが共有する)
// ---------------------------------------------------------------------------

export type FailureKind = "rate_limited" | "config_error" | "server_error" | "image_error";

export interface Failure {
  kind: FailureKind;
  message: string;
  /** HTTPステータス(分かる場合)。 */
  status?: number;
}

/** 例外を、失敗の種類に変換する。プロバイダが分類済みのエラー以外は、画像側の問題として扱う。 */
export function toFailure(err: unknown): Failure {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof RateLimitError) return { kind: "rate_limited", message };
  if (err instanceof ProviderConfigError) return { kind: "config_error", message };
  if (err instanceof TransientServerError) return { kind: "server_error", message, status: err.status };
  return { kind: "image_error", message };
}
