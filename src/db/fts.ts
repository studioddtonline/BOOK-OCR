import type { DatabaseSync } from "node:sqlite";

/**
 * images_fts は外部content(content='source_images')のFTS5テーブルなので、
 * MATCH句を使わない素朴な `SELECT COUNT(*) FROM images_fts` は実際の索引状態を
 * 全く反映せず、常に source_images の行数と一致するだけの見せかけの数字になる
 * (非MATCHクエリは内部でcontentテーブル側の行をそのまま列挙するため)。
 * 実際に索引済みのトライグラム数を知るには fts5vocab を使う必要がある。
 */
export function getFtsIndexedTermCount(db: DatabaseSync): number {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS temp.fts_vocab_check USING fts5vocab('main', 'images_fts', 'row');`);
  const row = db.prepare(`SELECT COUNT(*) c FROM temp.fts_vocab_check`).get() as { c: number };
  db.exec(`DROP TABLE temp.fts_vocab_check;`);
  return row.c;
}

/** 索引を source_images.ocr_text から全件作り直す(データは失われない)。 */
export function rebuildFtsIndex(db: DatabaseSync): void {
  db.exec(`INSERT INTO images_fts(images_fts) VALUES ('rebuild');`);
}
