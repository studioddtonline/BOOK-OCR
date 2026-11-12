import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrations.js";

export function openDb(dbPath: string, busyTimeoutMs = 20000): DatabaseSync {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    // 他プロセス(DB Browser for SQLite等)が書き込み中でロックされていても、
    // この時間内はSQLiteが内部で自動リトライしてから結果を返す。
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
    migrate(db, dbPath);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
