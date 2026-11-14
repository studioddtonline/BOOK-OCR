/**
 * book-ocr(DBの持ち主・書き手)と ocr-search(読み手)の契約テスト。
 *
 * 全文検索は別パッケージ ocr-search が持つ。book-ocr は、このDBが ocr-search の
 * 前提を満たし続けること(スキーマ・索引の同期・reviewed の解釈)に責任を持つ。
 * ocr-search の検索仕様そのもの(AND/OR/NOT、スニペット等)は、ここでは検証しない。
 *
 * ここで ocr-search は devDependency として、リリースの tgz を使う(README「開発」参照)。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createOcrSearch, type OcrSearch } from "ocr-search";
import { REQUIRED_SOURCE_IMAGE_COLUMNS, assertSearchDatabaseCompatible, assertTrigramSearchDatabaseCompatible } from "ocr-search/testing";
import type { DatabaseSync } from "node:sqlite";
import {
  claimNextQueueItem,
  completeQueueItem,
  insertQueueItem,
  insertSourceImage,
  rebuildFtsIndex,
} from "../src/db/index.js";
import { addImage, memDb, row, rows } from "./helpers.js";

function searcher(t: import("node:test").TestContext, db: DatabaseSync): OcrSearch {
  const search = createOcrSearch({ database: db });
  t.after(() => search.close());
  return search;
}

/** book-ocr の書き込み経路で「OCR成功」を再現する(ingest → worker が保存、と同じ関数)。 */
function ocrSucceeded(db: DatabaseSync, p: { label: string | null; fileName: string; text: string }): number {
  const id = insertSourceImage(db, { label: p.label, fileName: p.fileName });
  insertQueueItem(db, { sourceImageId: id, imagePath: `/work/${id}.webp` });
  const item = claimNextQueueItem(db);
  assert.ok(item && item.source_image_id === id);
  const r = completeQueueItem(db, item, { ocrText: p.text, provider: "p", model: "m", rawResponse: "{}" });
  assert.equal(r, "saved");
  return id;
}

// ---- スキーマ契約 ----------------------------------------------------------

test("契約: ocr-search の本番用の互換性検査を通る", (t) => {
  assert.doesNotThrow(() => assertSearchDatabaseCompatible(memDb(t)));
});

test("契約: ocr-search の厳格な検査(images_fts が trigram)を通る", (t) => {
  assert.doesNotThrow(() => assertTrigramSearchDatabaseCompatible(memDb(t)));
});

test("契約: ocr-search が要求する source_images の列を、すべて持っている", (t) => {
  const cols = rows<{ name: string }>(memDb(t), "PRAGMA table_info(source_images)").map((c) => c.name);
  for (const required of REQUIRED_SOURCE_IMAGE_COLUMNS) assert.ok(cols.includes(required), `列 ${required}`);
});

test("契約: source_images は AUTOINCREMENT(id を再利用しない)", (t) => {
  // 理由: mcp_ocr_edit_history は source_image_id を外部キー無しの素の整数で持つ。
  // 削除した id が再利用されると、履歴が別の画像のものとして黙って取り違えられる。
  const sql = row<{ sql: string }>(memDb(t), "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'source_images'")?.sql ?? "";
  assert.match(sql, /\bAUTOINCREMENT\b/i);
});

test("契約: 索引の同期トリガーが3つ揃っている(ocr-search の検証はトリガーを見ないので、ここで守る)", (t) => {
  const names = rows<{ name: string }>(memDb(t), "SELECT name FROM sqlite_master WHERE type = 'trigger'").map((r) => r.name).sort();
  assert.deepEqual(names, ["source_images_ad", "source_images_ai", "source_images_au"]);
});

// ---- 書き手(book-ocr) → 読み手(ocr-search) -------------------------------

test("OCR成功で保存した本文を、ocr-search が検索できる(結果の形も含めて)", async (t) => {
  const db = memDb(t);
  const id = ocrSucceeded(db, { label: "本A", fileName: "1.webp", text: "吾輩は猫である。名前はまだ無い。" });
  const r = await searcher(t, db).search({ query: "吾輩は猫" });
  assert.equal(r.returned, 1);
  assert.deepEqual({ ...r.results[0], snippet: undefined }, { id, label: "本A", fileName: "1.webp", reviewed: 0, snippet: undefined });
  assert.match(r.results[0].snippet, /吾輩は猫である/);
});

test("1〜2文字の語と、3文字以上の語(FTS)の両方で、book-ocr のDBを検索できる", async (t) => {
  const db = memDb(t);
  const id = ocrSucceeded(db, { label: "本A", fileName: "1.webp", text: "吾輩は猫である" });
  const search = searcher(t, db);
  assert.deepEqual((await search.search({ query: "猫" })).results.map((h) => h.id), [id], "1文字");
  assert.deepEqual((await search.search({ query: "吾輩" })).results.map((h) => h.id), [id], "2文字");
  assert.deepEqual((await search.search({ query: "猫である" })).results.map((h) => h.id), [id], "3文字以上");
});

test("本文の更新(人手・MCP等)はトリガー経由で検索に反映され、旧本文は検索に出なくなる", async (t) => {
  const db = memDb(t);
  const id = ocrSucceeded(db, { label: null, fileName: "1.webp", text: "古い本文のテキスト" });
  const search = searcher(t, db);
  assert.equal((await search.search({ query: "古い本文" })).returned, 1);
  db.prepare("UPDATE source_images SET ocr_text = ? WHERE id = ?").run("新しい文章の内容です", id);
  assert.equal((await search.search({ query: "古い本文" })).returned, 0);
  assert.equal((await search.search({ query: "新しい文章" })).returned, 1);
});

test("行を削除すると、検索に出なくなる", async (t) => {
  const db = memDb(t);
  // OCR履歴(ocr_log)のある行は外部キーで削除できない(db-schema.test.ts)ので、履歴のない行で検証する。
  const id = addImage(db, { label: null, fileName: "1.webp", text: "削除される予定の本文" });
  const search = searcher(t, db);
  assert.equal((await search.search({ query: "削除される" })).returned, 1);
  db.prepare("DELETE FROM source_images WHERE id = ?").run(id);
  assert.equal((await search.search({ query: "削除される" })).returned, 0);
});

test("OCR未完了(ocr_text が NULL)の行は、検索結果に出ない", async (t) => {
  const db = memDb(t);
  addImage(db, { text: null, fileName: "pending.webp" });
  const id = addImage(db, { text: "本文のあるページ", fileName: "done.webp" });
  const r = await searcher(t, db).search({ query: "本文のあ" });
  assert.deepEqual(r.results.map((h) => h.id), [id]);
});

test("索引(images_fts)が壊れても、reindex(rebuildFtsIndex)で検索が復旧する", async (t) => {
  const db = memDb(t);
  ocrSucceeded(db, { label: null, fileName: "1.webp", text: "再構築の対象になる本文" });
  const search = searcher(t, db);
  db.exec(`INSERT INTO images_fts(images_fts) VALUES ('delete-all')`);
  assert.equal((await search.search({ query: "再構築の対象" })).returned, 0, "索引が空");
  rebuildFtsIndex(db);
  assert.equal((await search.search({ query: "再構築の対象" })).returned, 1);
});

// ---- reviewed / label の解釈の共有 --------------------------------------------

test("reviewed の解釈: 0 だけが未レビュー。0以外(1, -1, 2)はすべてレビュー済み", async (t) => {
  const db = memDb(t);
  const ids = { unreviewed: addImage(db, { text: "共通の語句を含む本文", reviewed: 0 }) };
  const reviewed = [1, -1, 2].map((v) => addImage(db, { text: "共通の語句を含む本文", reviewed: v }));
  const search = searcher(t, db);
  const yes = (await search.search({ query: "共通の語句", reviewed: true })).results;
  const no = (await search.search({ query: "共通の語句", reviewed: false })).results;
  assert.deepEqual(yes.map((h) => h.id), reviewed);
  assert.deepEqual(yes.map((h) => h.reviewed), [1, -1, 2]);
  assert.deepEqual(no.map((h) => h.id), [ids.unreviewed]);
});

test("label の絞り込みは、source_images.file_path との完全一致", async (t) => {
  const db = memDb(t);
  const a = addImage(db, { text: "共通の本文テキスト", label: "本A" });
  addImage(db, { text: "共通の本文テキスト", label: "本B" });
  addImage(db, { text: "共通の本文テキスト", label: null });
  const search = searcher(t, db);
  assert.deepEqual((await search.search({ query: "共通の本文", label: "本A" })).results.map((h) => h.id), [a]);
  assert.equal((await search.search({ query: "共通の本文", label: "本" })).returned, 0, "部分一致ではない");
});

// ---- ページング・DBの所有 ------------------------------------------------------

test("afterId のページングで、全件を重複なく id 順に辿れる", async (t) => {
  const db = memDb(t);
  const all = [1, 2, 3, 4, 5].map((n) => addImage(db, { text: "ページングの対象本文", fileName: `${n}.webp` }));
  const search = searcher(t, db);
  const seen: number[] = [];
  let afterId: number | undefined;
  for (let pages = 0; pages < 10; pages++) {
    const r = await search.search({ query: "ページングの対象", limit: 2, afterId });
    seen.push(...r.results.map((h) => h.id));
    if (r.nextAfterId === null) break;
    afterId = r.nextAfterId;
  }
  assert.deepEqual(seen, all);
});

test("search.close() は、呼び出し側(book-ocr)のDB接続を閉じない", (t) => {
  const db = memDb(t);
  const search = createOcrSearch({ database: db });
  search.close();
  assert.doesNotThrow(() => db.prepare("SELECT 1").get(), "DBは呼び出し側のもの");
});
