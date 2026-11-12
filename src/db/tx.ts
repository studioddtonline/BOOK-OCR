import type { DatabaseSync } from "node:sqlite";

export function isBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const withCode = err as { code?: string; errcode?: number };
  return /database is locked/i.test(err.message) || withCode.code === "SQLITE_BUSY" || withCode.errcode === 5;
}

/** BEGIN IMMEDIATE ... COMMIT で囲んで実行する。失敗したらROLLBACKして例外をそのまま投げる。 */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const result = fn();
    db.exec("COMMIT;");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // ROLLBACK自体の失敗は元の例外を優先する
    }
    throw err;
  }
}
