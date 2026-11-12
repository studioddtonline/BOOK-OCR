import type { DatabaseSync } from "node:sqlite";
import { UserError } from "../errors.js";
import { inTransaction } from "./tx.js";

/**
 * 【外部ツール(MCPサーバ等)との契約】
 * このDBは、別プロジェクトのMCPサーバ(ocr-mcp-server)からも読み書きされる。次を変えると、
 * 相手側が起動時の検証で止まる、または黙って壊れるので、変更するときは相手側と合わせること。
 *  - source_images の列: id / file_path / file_name / ocr_text / reviewed
 *  - source_images.id を変えない(相手の編集履歴 mcp_ocr_edit_history は、外部キー無しで
 *    source_image_id を素の整数で持っている。id が変わると履歴が黙って孤児になる)
 *  - images_fts が FTS5(trigram)で、MATCH できること
 *  - source_images_ai / _ad / _au の各トリガー(相手は索引を直接触らず、これに任せている)
 *  - reviewed は「0 = 未レビュー、0以外 = レビュー済み(上書き禁止)」
 *  - mcp_ocr_edit_history は相手が作って管理するテーブル。このプロジェクトでは作らず、触らない
 *
 * 下の BASELINE_SQL は、v3スキーマ(従来の SCHEMA_SQL)をそのまま移したもの。変更しないこと。
 * 以降のスキーマ変更は MIGRATIONS に番号つきで追加する(PRAGMA user_version で管理)。
 */
const BASELINE_SQL = `
-- 閲覧・検索の対象。worker用の状態(OCR待ちかどうか・失敗回数など)は ocr_queue 側に分離してある。
CREATE TABLE IF NOT EXISTS source_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 本の名前などの人間向けラベル。ingest の --label で入る(未指定ならNULL)。
  -- 実ファイルのパスではない。DBビューア上での絞り込み用。
  file_path TEXT,
  file_name TEXT,
  ocr_text TEXT,
  -- 0 = 未レビュー / 0以外 = 人間がレビュー済み(worker・MCPサーバとも上書きしない)
  reviewed INTEGER NOT NULL DEFAULT 0
);

-- OCR待ちのキュー。OCRに成功した行は消える。失敗が続いた行は status='error' で残る。
CREATE TABLE IF NOT EXISTS ocr_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_image_id INTEGER NOT NULL UNIQUE REFERENCES source_images(id) ON DELETE CASCADE,
  image_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending / processing / error
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ocr_queue_status ON ocr_queue(status);

CREATE VIRTUAL TABLE IF NOT EXISTS images_fts USING fts5(
  ocr_text,
  content='source_images',
  content_rowid='id',
  tokenize='trigram'
);

-- content='source_images' の外部contentテーブルは自動同期されないため、
-- トリガーで images_fts と source_images.ocr_text を同期する。
CREATE TRIGGER IF NOT EXISTS source_images_ai AFTER INSERT ON source_images BEGIN
  INSERT INTO images_fts(rowid, ocr_text) VALUES (new.id, new.ocr_text);
END;

CREATE TRIGGER IF NOT EXISTS source_images_ad AFTER DELETE ON source_images BEGIN
  INSERT INTO images_fts(images_fts, rowid, ocr_text) VALUES ('delete', old.id, old.ocr_text);
END;

-- ocr_text が変わったときだけ索引を更新する(file_path や reviewed の更新では索引に触れない)。
CREATE TRIGGER IF NOT EXISTS source_images_au AFTER UPDATE OF ocr_text ON source_images BEGIN
  INSERT INTO images_fts(images_fts, rowid, ocr_text) VALUES ('delete', old.id, old.ocr_text);
  INSERT INTO images_fts(rowid, ocr_text) VALUES (new.id, new.ocr_text);
END;

-- OCR試行ログ。成功・失敗を問わず全ての試行を追記していく。
-- provider には config.json の providers[].name を入れる。
-- 生のAPIレスポンス(raw_response)はここにだけ持つ。
CREATE TABLE IF NOT EXISTS ocr_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_image_id INTEGER NOT NULL REFERENCES source_images(id),
  provider TEXT,
  model TEXT,
  outcome TEXT NOT NULL, -- success / rate_limited / config_error / server_error / error
  http_status INTEGER,
  ocr_text TEXT,         -- 成功時のみ。source_images.ocr_textの複製だが、後で上書きされても履歴として残る
  raw_response TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ocr_log_source_image ON ocr_log(source_image_id);

-- 書誌情報(人間が後から入力する。Web UI等で使う想定)
CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  title_yomi TEXT,
  author TEXT,
  author_yomi TEXT,
  publisher TEXT,
  pub_year INTEGER,
  volume TEXT,
  memo TEXT
);

-- ページ構造(人間が後から入力する。1 source_image が複数ページに相当することもある)
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_image_id INTEGER NOT NULL REFERENCES source_images(id),
  book_id INTEGER REFERENCES books(id),
  page_no INTEGER,
  note TEXT
);

-- プロバイダごとの当日リクエスト数・枯渇フラグ。provider には providers[].name を入れる。
CREATE TABLE IF NOT EXISTS provider_usage (
  provider TEXT NOT NULL,
  date TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  is_exhausted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, date)
);
`;

interface Migration {
  version: number;
  description: string;
  up(db: DatabaseSync): void;
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, type: string): void {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/**
 * 番号は連番で、一度リリースしたものは書き換えない。各 up は何度実行しても安全(冪等)に書く。
 * source_images / images_fts / トリガーには触れない(MCPサーバとの契約)。
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: "v3 baseline",
    up: (db) => db.exec(BASELINE_SQL),
  },
  {
    version: 2,
    description: "ocr_log に、使ったプロンプトのハッシュと送ったoptionsを記録する列を追加",
    up: (db) => {
      addColumnIfMissing(db, "ocr_log", "prompt_hash", "TEXT");
      addColumnIfMissing(db, "ocr_log", "request_options", "TEXT");
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export function getUserVersion(db: DatabaseSync): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

/**
 * このバージョンが扱えるのはv3スキーマ(source_images に reviewed がある世代)以降のみ。
 * 旧世代のDBは、旧バージョン(v0.3.x)の migrate コマンドでv3にしてから使う。
 */
function assertV3Layout(db: DatabaseSync, dbPath: string): void {
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_images'`).get();
  if (exists === undefined) return;

  const cols = new Set((db.prepare(`PRAGMA table_info(source_images)`).all() as { name: string }[]).map((c) => c.name));
  if (cols.has("reviewed") && cols.has("file_name") && !cols.has("raw_response") && !cols.has("content_hash")) return;

  const legacy = cols.has("raw_response") ? "v1" : cols.has("content_hash") ? "v2" : undefined;
  if (legacy) {
    throw new UserError(
      `DBが旧スキーマ(${legacy})です: ${dbPath}\n` +
        `  このバージョンはv3スキーマ専用です。旧バージョン(v0.3.x)の migrate コマンドでv3に移行してから使ってください。`,
    );
  }
  throw new UserError(`DBのスキーマが想定外です(source_images の列構成が既知のどの世代とも一致しません): ${dbPath}`);
}

/** 未適用のマイグレーションを順に適用する(各1トランザクション)。 */
export function migrate(db: DatabaseSync, dbPath = "(unknown)"): void {
  assertV3Layout(db, dbPath);

  if (getUserVersion(db) > LATEST_SCHEMA_VERSION) {
    throw new UserError(
      `DBのスキーマ番号(user_version=${getUserVersion(db)})が、このバージョンが知っている最新(${LATEST_SCHEMA_VERSION})より新しいです: ${dbPath}\n` +
        `  新しいバージョンで作られたDBです。このツールを更新してください。`,
    );
  }

  for (const m of MIGRATIONS) {
    inTransaction(db, () => {
      // 複数プロセスが同時に起動しても二重適用しないよう、ロックを取ってから番号を確認する。
      if (getUserVersion(db) >= m.version) return;
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
    });
  }
}
