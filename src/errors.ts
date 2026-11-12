/**
 * 設定ミスなど「利用者が自分で直せるエラー」。
 * fail() はこれをスタックトレース無しのメッセージだけで表示する。
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

/**
 * エントリポイントの最後で呼ぶ共通のエラー表示。
 * UserError はメッセージだけを読みやすく表示し、想定外のエラーは
 * 原因調査のためスタックトレースも出す。
 */
export function fail(err: unknown): never {
  if (err instanceof UserError) {
    console.error(`\nエラー: ${err.message}\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
}
