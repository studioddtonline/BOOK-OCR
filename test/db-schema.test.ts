import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, getUserVersion, inTransaction, isBusyError, openDb } from "../src/db/index.js";
import { UserError } from "../src/errors.js";
import { addImage, fileDb, memDb, row, rows, tmpDir } from "./helpers.js";
import { join } from "node:path";

test("openDb: 新規DBは最新のスキーマ番号(user_version)になる", () => {
  const db = memDb();
  assert.equal(getUserVersion(db), LATEST_SCHEMA_VERSION);
  assert.equal(LATEST_SCHEMA_VERSION, MIGRATIONS.length);
});

test("マイグレーションの番号は 1 からの連番", () => {
  assert.deepEqual(MIGRATIONS.map((m) => m.version), MIGRATIONS.map((_, i) => i + 1));
});

test("openDb: 新規作成時にディレクトリも作る", (t) => {
  const { path } = fileDb(t);
  assert.ok(path.includes("db"));
});

test("openDb: foreign_keys が有効、busy_timeout が反映される", () => {
  const db = openDb(":memory:", 1234);
  assert.equal(row<{ foreign_keys: number }>(db, "PRAGMA foreign_keys")?.foreign_keys, 1);
  assert.equal(row<{ timeout: number }>(db, "PRAGMA busy_timeout")?.timeout, 1234);
});

test("openDb: ファイルDBは WAL モード", (t) => {
  const { db } = fileDb(t);
  assert.equal(row<{ journal_mode: string }>(db, "PRAGMA journal_mode")?.journal_mode, "wal");
});

test("openDb: 何度開いてもマイグレーションは冪等で、データは消えない", (t) => {
  const { db, path } = fileDb(t);
  const id = addImage(db, { text: "残るはず" });
  db.close();
  const again = openDb(path, 1);
  t.after(() => again.close());
  assert.equal(row<{ ocr_text: string }>(again, "SELECT ocr_text FROM source_images WHERE id = ?", id)?.ocr_text, "残るはず");
});

for (const [version, cols] of [
  ["v1", "id INTEGER, raw_response TEXT"],
  ["v2", "id INTEGER, content_hash TEXT"],
] as const) {
  test(`openDb: ${version} のDBは移行案内つきで拒否する`, (t) => {
    const p = join(tmpDir(t), "old.sqlite3");
    const raw = new DatabaseSync(p);
    raw.exec(`CREATE TABLE source_images (${cols})`);
    raw.close();
    assert.throws(
      () => openDb(p),
      (e: unknown) => e instanceof UserError && e.message.includes(`旧スキーマ(${version})`) && e.message.includes("migrate"),
    );
  });
}

test("openDb: 想定外のスキーマは拒否する", (t) => {
  const p = join(tmpDir(t), "weird.sqlite3");
  const raw = new DatabaseSync(p);
  raw.exec(`CREATE TABLE source_images (id INTEGER, foo TEXT)`);
  raw.close();
  assert.throws(() => openDb(p), (e: unknown) => e instanceof UserError && e.message.includes("想定外"));
});

// ---- MCPサーバとの契約 ---------------------------------------------------

test("契約: source_images の列は5列(id/file_path/file_name/ocr_text/reviewed)", () => {
  const cols = rows<{ name: string; notnull: number; dflt_value: string | null }>(memDb(), "PRAGMA table_info(source_images)");
  assert.deepEqual(
    cols.map((c) => c.name),
    ["id", "file_path", "file_name", "ocr_text", "reviewed"],
  );
  const reviewed = cols.find((c) => c.name === "reviewed");
  assert.equal(reviewed?.notnull, 1);
  assert.equal(reviewed?.dflt_value, "0");
});

test("契約: images_fts は trigram の FTS5 外部contentテーブル", () => {
  const sql = row<{ sql: string }>(memDb(), `SELECT sql FROM sqlite_master WHERE name = 'images_fts'`)?.sql ?? "";
  assert.match(sql, /fts5/i);
  assert.match(sql, /trigram/);
  assert.match(sql, /content='source_images'/);
  assert.match(sql, /content_rowid='id'/);
});

test("契約: 同期トリガー source_images_ai / _ad / _au が存在する", () => {
  const names = rows<{ name: string }>(memDb(), `SELECT name FROM sqlite_master WHERE type = 'trigger'`).map((r) => r.name);
  for (const n of ["source_images_ai", "source_images_ad", "source_images_au"]) assert.ok(names.includes(n), n);
});

test("契約: mcp_ocr_edit_history を作らない", () => {
  const found = row(memDb(), `SELECT 1 FROM sqlite_master WHERE name = 'mcp_ocr_edit_history'`);
  assert.equal(found, undefined);
});

test("契約: AUTOINCREMENT なので、削除した最大IDは再利用されない", () => {
  const db = memDb();
  const a = addImage(db);
  const b = addImage(db);
  db.prepare("DELETE FROM source_images WHERE id = ?").run(b);
  const c = addImage(db);
  assert.ok(c > b, `id ${c} は ${b} より大きい`);
  assert.equal(a, 1);
});

test("契約: reviewed の既定値は 0 で、0以外も格納できる", () => {
  const db = memDb();
  const id = addImage(db);
  assert.equal(row<{ reviewed: number }>(db, "SELECT reviewed FROM source_images WHERE id = ?", id)?.reviewed, 0);
  db.prepare("UPDATE source_images SET reviewed = -1 WHERE id = ?").run(id);
  assert.equal(row<{ reviewed: number }>(db, "SELECT reviewed FROM source_images WHERE id = ?", id)?.reviewed, -1);
});

test("全テーブルが作られる", () => {
  const names = rows<{ name: string }>(memDb(), `SELECT name FROM sqlite_master WHERE type = 'table'`).map((r) => r.name);
  for (const n of ["source_images", "ocr_queue", "ocr_log", "books", "pages", "provider_usage", "images_fts"]) {
    assert.ok(names.includes(n), n);
  }
});

test("ocr_queue: source_image_id は UNIQUE、親削除でCASCADE", () => {
  const db = memDb();
  const id = addImage(db);
  db.prepare("INSERT INTO ocr_queue (source_image_id, image_path) VALUES (?, 'x')").run(id);
  assert.throws(() => db.prepare("INSERT INTO ocr_queue (source_image_id, image_path) VALUES (?, 'y')").run(id), /UNIQUE/);
  db.prepare("DELETE FROM source_images WHERE id = ?").run(id);
  assert.equal(row(db, "SELECT 1 FROM ocr_queue"), undefined);
});

test("ocr_queue: 存在しない source_image_id は外部キー違反", () => {
  const db = memDb();
  assert.throws(() => db.prepare("INSERT INTO ocr_queue (source_image_id, image_path) VALUES (999, 'x')").run(), /FOREIGN KEY/);
});

test("ocr_log: OCR履歴のある画像は、そのままでは削除できない(外部キー。CASCADE ではない)", () => {
  // Web UI 等で画像を削除するときは、履歴(ocr_log)や pages の扱いを明示的に決める必要がある。
  const db = memDb();
  const id = addImage(db);
  db.prepare("INSERT INTO ocr_log (source_image_id, provider, model, outcome) VALUES (?, 'p', 'm', 'success')").run(id);
  assert.throws(() => db.prepare("DELETE FROM source_images WHERE id = ?").run(id), /FOREIGN KEY/);
  db.prepare("DELETE FROM ocr_log WHERE source_image_id = ?").run(id);
  assert.doesNotThrow(() => db.prepare("DELETE FROM source_images WHERE id = ?").run(id));
});

// ---- トランザクション / BUSY --------------------------------------------

test("inTransaction: 成功すればコミットされ、戻り値が返る", () => {
  const db = memDb();
  const r = inTransaction(db, () => addImage(db, { text: "x" }));
  assert.equal(r, 1);
  assert.equal(row<{ c: number }>(db, "SELECT COUNT(*) c FROM source_images")?.c, 1);
});

test("inTransaction: 例外ならロールバックして、元の例外をそのまま投げる", () => {
  const db = memDb();
  const boom = new Error("boom");
  assert.throws(
    () =>
      inTransaction(db, () => {
        addImage(db);
        throw boom;
      }),
    (e) => e === boom,
  );
  assert.equal(row<{ c: number }>(db, "SELECT COUNT(*) c FROM source_images")?.c, 0);
  // 後続のトランザクションも普通に使える
  assert.equal(inTransaction(db, () => 7), 7);
});

test("isBusyError: メッセージ・code・errcode のいずれでも判定", () => {
  assert.equal(isBusyError(new Error("database is locked")), true);
  assert.equal(isBusyError(Object.assign(new Error("x"), { code: "SQLITE_BUSY" })), true);
  assert.equal(isBusyError(Object.assign(new Error("x"), { errcode: 5 })), true);
  assert.equal(isBusyError(new Error("other")), false);
  assert.equal(isBusyError("database is locked"), false);
  assert.equal(isBusyError(null), false);
});

test("本物のロック競合を isBusyError が検出する", (t) => {
  const { db, path } = fileDb(t, 1);
  const other = openDb(path, 1);
  t.after(() => other.close());
  other.exec("BEGIN IMMEDIATE");
  let caught: unknown;
  try {
    inTransaction(db, () => undefined);
  } catch (e) {
    caught = e;
  }
  other.exec("ROLLBACK");
  assert.ok(caught, "ロックされているので失敗するはず");
  assert.equal(isBusyError(caught), true);
});

// ---- マイグレーション(user_version) -------------------------------------

/** マイグレーション導入前に作られた v3 のDB(user_version=0、ocr_log に新しい列が無い)を再現する。 */
function legacyV3Db(path: string): void {
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE source_images (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT, file_name TEXT, ocr_text TEXT, reviewed INTEGER NOT NULL DEFAULT 0);
    CREATE VIRTUAL TABLE images_fts USING fts5(ocr_text, content='source_images', content_rowid='id', tokenize='trigram');
    CREATE TRIGGER source_images_ai AFTER INSERT ON source_images BEGIN INSERT INTO images_fts(rowid, ocr_text) VALUES (new.id, new.ocr_text); END;
    CREATE TRIGGER source_images_ad AFTER DELETE ON source_images BEGIN INSERT INTO images_fts(images_fts, rowid, ocr_text) VALUES ('delete', old.id, old.ocr_text); END;
    CREATE TRIGGER source_images_au AFTER UPDATE OF ocr_text ON source_images BEGIN
      INSERT INTO images_fts(images_fts, rowid, ocr_text) VALUES ('delete', old.id, old.ocr_text);
      INSERT INTO images_fts(rowid, ocr_text) VALUES (new.id, new.ocr_text);
    END;
    CREATE TABLE ocr_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, source_image_id INTEGER NOT NULL UNIQUE REFERENCES source_images(id) ON DELETE CASCADE, image_path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', retry_count INTEGER NOT NULL DEFAULT 0, error_message TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE ocr_log (id INTEGER PRIMARY KEY AUTOINCREMENT, source_image_id INTEGER NOT NULL REFERENCES source_images(id), provider TEXT, model TEXT, outcome TEXT NOT NULL, http_status INTEGER, ocr_text TEXT, raw_response TEXT, error_message TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO source_images (file_path, file_name, ocr_text, reviewed) VALUES ('本A', '1.webp', '既存の本文です', 1);
    INSERT INTO ocr_log (source_image_id, provider, model, outcome, ocr_text) VALUES (1, 'old', 'm', 'success', '既存の本文です');
  `);
  raw.close();
}

test("マイグレーション: user_version=0 の既存v3 DBは、データを保ったまま最新になる", (t) => {
  const p = join(tmpDir(t), "legacy.sqlite3");
  legacyV3Db(p);
  const db = openDb(p);
  t.after(() => db.close());

  assert.equal(getUserVersion(db), LATEST_SCHEMA_VERSION);
  const cols = rows<{ name: string }>(db, "PRAGMA table_info(ocr_log)").map((c) => c.name);
  assert.ok(cols.includes("prompt_hash") && cols.includes("request_options"));
  // 既存データは無傷で、新しい列は NULL
  assert.deepEqual(row(db, "SELECT file_path, ocr_text, reviewed FROM source_images WHERE id = 1"), {
    file_path: "本A",
    ocr_text: "既存の本文です",
    reviewed: 1,
  });
  assert.equal(row<{ prompt_hash: string | null }>(db, "SELECT prompt_hash FROM ocr_log")?.prompt_hash, null);
  // 検索索引も生きている
  assert.equal(rows(db, `SELECT rowid FROM images_fts WHERE images_fts MATCH '"既存の本"'`).length, 1);
});

test("マイグレーション: 契約部分(source_images の列・トリガー)は適用の前後で変わらない", (t) => {
  const p = join(tmpDir(t), "legacy.sqlite3");
  legacyV3Db(p);
  const db = openDb(p);
  t.after(() => db.close());
  const migrated = rows<{ name: string }>(db, "PRAGMA table_info(source_images)").map((c) => c.name);
  assert.deepEqual(migrated, rows<{ name: string }>(memDb(), "PRAGMA table_info(source_images)").map((c) => c.name));
  const triggers = rows<{ name: string }>(db, `SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`).map((r) => r.name);
  assert.deepEqual(triggers, ["source_images_ad", "source_images_ai", "source_images_au"]);
});

test("マイグレーション: 新規DBと、既存DBを移行したものは、同じテーブル構成になる", (t) => {
  const p = join(tmpDir(t), "legacy.sqlite3");
  legacyV3Db(p);
  const migrated = openDb(p);
  t.after(() => migrated.close());
  const names = (d: DatabaseSync) =>
    rows<{ name: string }>(d, `SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'images_fts_%' ORDER BY name`).map((r) => r.name);
  const fresh = memDb();
  // 既存DBには books / pages / provider_usage / 一部のindex が無かったが、移行で揃う
  for (const n of names(fresh)) assert.ok(names(migrated).includes(n), n);
});

test("マイグレーション: 再度開いても何も変わらない(冪等)", (t) => {
  const { db, path } = fileDb(t);
  const before = getUserVersion(db);
  db.close();
  const again = openDb(path);
  t.after(() => again.close());
  assert.equal(getUserVersion(again), before);
});

test("マイグレーション: 新しいバージョンのツールで作られたDBは拒否する", (t) => {
  const p = join(tmpDir(t), "future.sqlite3");
  const raw = new DatabaseSync(p);
  raw.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`);
  raw.close();
  assert.throws(
    () => openDb(p),
    (e: unknown) => e instanceof UserError && e.message.includes("より新しい"),
  );
});

test("マイグレーション: 失敗したら元の状態のまま(user_version も進まない)", (t) => {
  const p = join(tmpDir(t), "broken.sqlite3");
  const raw = new DatabaseSync(p);
  // ocr_log が「テーブルではなくビュー」だと、列追加(v2)が失敗する
  raw.exec(`CREATE TABLE source_images (id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT, ocr_text TEXT, reviewed INTEGER NOT NULL DEFAULT 0);
            CREATE VIEW ocr_log AS SELECT 1 AS id;`);
  raw.close();
  assert.throws(() => openDb(p));
  const check = new DatabaseSync(p);
  const v = (check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  check.close();
  assert.ok(v < 2, "v2 は適用されていない");
});

test("user_version は PRAGMA で読める(MCPサーバ等の外部ツールには影響しない追加情報)", () => {
  assert.equal(row<{ user_version: number }>(memDb(), "PRAGMA user_version")?.user_version, LATEST_SCHEMA_VERSION);
});
