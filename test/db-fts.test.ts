import test from "node:test";
import assert from "node:assert/strict";
import { getFtsIndexedTermCount } from "../src/db/index.js";
import { addImage, memDb, rows } from "./helpers.js";

const match = (db: ReturnType<typeof memDb>, q: string) =>
  rows<{ rowid: number }>(db, `SELECT rowid FROM images_fts WHERE images_fts MATCH ?`, `"${q}"`).map((r) => r.rowid);

test("INSERT トリガー: 挿入した本文が検索できる", () => {
  const db = memDb();
  const id = addImage(db, { text: "吾輩は猫である。名前はまだ無い。" });
  assert.deepEqual(match(db, "吾輩は"), [id]);
  assert.deepEqual(match(db, "名前は"), [id]);
  assert.deepEqual(match(db, "存在しない語"), []);
});

test("ocr_text が NULL の行を挿入しても壊れない", () => {
  const db = memDb();
  addImage(db, { text: null });
  assert.deepEqual(match(db, "なにか"), []);
});

test("UPDATE OF ocr_text トリガー: 旧本文は消え、新本文が引ける", () => {
  const db = memDb();
  const id = addImage(db, { text: "古い本文です" });
  db.prepare("UPDATE source_images SET ocr_text = ? WHERE id = ?").run("新しい本文です", id);
  assert.deepEqual(match(db, "古い本"), []);
  assert.deepEqual(match(db, "新しい本"), [id]);
});

test("NULL だった ocr_text を更新(OCR完了)すると引けるようになる", () => {
  const db = memDb();
  const id = addImage(db, { text: null });
  db.prepare("UPDATE source_images SET ocr_text = ? WHERE id = ?").run("OCR結果の本文", id);
  assert.deepEqual(match(db, "OCR結果"), [id]);
});

test("reviewed / file_path の更新では索引は変わらず、検索結果も保たれる", () => {
  const db = memDb();
  const id = addImage(db, { text: "変わらない本文" });
  db.prepare("UPDATE source_images SET reviewed = 1, file_path = 'x' WHERE id = ?").run(id);
  assert.deepEqual(match(db, "変わらな"), [id]);
});

test("DELETE トリガー: 削除した行は検索に出ない", () => {
  const db = memDb();
  const a = addImage(db, { text: "残る行の本文" });
  const b = addImage(db, { text: "消える行の本文" });
  db.prepare("DELETE FROM source_images WHERE id = ?").run(b);
  assert.deepEqual(match(db, "行の本"), [a]);
});

test("getFtsIndexedTermCount: 空なら0、本文を入れると増える", () => {
  const db = memDb();
  assert.equal(getFtsIndexedTermCount(db), 0);
  addImage(db, { text: "あいうえお" }); // トライグラム3個
  assert.equal(getFtsIndexedTermCount(db), 3);
});

test("getFtsIndexedTermCount: 何度呼んでも一時テーブルが残らず動く", () => {
  const db = memDb();
  addImage(db, { text: "あいうえお" });
  getFtsIndexedTermCount(db);
  assert.equal(getFtsIndexedTermCount(db), 3);
});

test("rebuild: 索引が壊れても source_images から再構築できる", () => {
  const db = memDb();
  const id = addImage(db, { text: "再構築の対象本文" });
  db.exec(`INSERT INTO images_fts(images_fts) VALUES ('delete-all')`);
  assert.equal(getFtsIndexedTermCount(db), 0);
  assert.deepEqual(match(db, "再構築の"), []);
  db.exec(`INSERT INTO images_fts(images_fts) VALUES ('rebuild')`);
  assert.ok(getFtsIndexedTermCount(db) > 0);
  assert.deepEqual(match(db, "再構築の"), [id]);
});

test("trigram は3文字未満のクエリでは常に0件(LIKE フォールバックが必要な理由)", () => {
  const db = memDb();
  addImage(db, { text: "猫がいる" });
  assert.deepEqual(match(db, "猫"), []);
  assert.deepEqual(match(db, "猫が"), []);
  assert.equal(match(db, "猫がい").length, 1);
});
