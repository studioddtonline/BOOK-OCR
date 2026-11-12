export const BACKOFF_INITIAL_MS = 60_000;
export const BACKOFF_MAX_MS = 10 * 60_000;

/**
 * サーバー側の一時的な問題(5xx等)が起きたプロバイダを、一定時間休ませるための状態。
 * 連続して失敗するたびに待ち時間が倍になる(1分→2分→4分…最大10分)。成功したら元に戻る。
 * プロセスの中だけで保持する(再起動すればリセットされる)。
 */
export class ProviderHealth {
  private readonly state = new Map<string, { blockedUntil: number; backoffMs: number }>();

  constructor(
    private readonly initialMs = BACKOFF_INITIAL_MS,
    private readonly maxMs = BACKOFF_MAX_MS,
  ) {}

  /** 失敗を記録し、今回休ませる時間(ミリ秒)を返す。 */
  recordTransientFailure(name: string, now = Date.now()): number {
    const prev = this.state.get(name);
    const backoffMs = prev ? Math.min(prev.backoffMs * 2, this.maxMs) : this.initialMs;
    this.state.set(name, { blockedUntil: now + backoffMs, backoffMs });
    return backoffMs;
  }

  recordSuccess(name: string): void {
    this.state.delete(name);
  }

  blockedUntil(name: string): number {
    return this.state.get(name)?.blockedUntil ?? 0;
  }
}
