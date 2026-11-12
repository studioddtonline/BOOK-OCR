import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { buildCasualQuery, type QueryNode } from "../src/search/query.js";
import { DEFAULT_SEARCH_LIMIT, searchImages, usesFtsIndex } from "../src/search/service.js";
import { addImage, memDb } from "./helpers.js";

const term = (value: string): QueryNode => ({ type: "term", value });

function seed(db: DatabaseSync) {
  return {
    a: addImage(db, { label: "本A", fileName: "1.webp", text: "吾輩は猫である。名前はまだ無い。" }),
    b: addImage(db, { label: "本A", fileName: "2.webp", text: "猫の話。猫猫猫猫の話。", reviewed: 1 }),
    c: addImage(db, { label: "本B", fileName: "3.webp", text: "宮崎駿監督のアニメ" }),
    d: addImage(db, { label: null, fileName: "4.webp", text: "宮崎駿監督の随筆" }),
    pending: addImage(db, { label: null, fileName: "5.webp", text: null }),
  };
}

test("usesFtsIndex: 1語で3文字以上(コードポイント)のときだけ true", () => {
  assert.equal(usesFtsIndex(term("猫")), false);
  assert.equal(usesFtsIndex(term("猫が")), false);
  assert.equal(usesFtsIndex(term("猫がい")), true);
  assert.equal(usesFtsIndex(term("𠮷野")), false);
  assert.equal(usesFtsIndex({ type: "and", nodes: [term("あいうえお")] }), false, "複合クエリは対象外");
});

test("searchImages: FTS(3文字以上)でヒットし、ラベル・ファイル名・reviewed・ハイライトつき抜粋を返す", (t) => {
  const db = memDb(t);
  const s = seed(db);
  const hits = searchImages(db, term("宮崎駿"));
  assert.deepEqual(hits.map((h) => h.id).sort(), [s.c, s.d]);
  const c = hits.find((h) => h.id === s.c)!;
  assert.equal(c.label, "本B");
  assert.equal(c.fileName, "3.webp");
  assert.equal(c.reviewed, 0);
  assert.equal(c.snippet, "[宮崎駿]監督のアニメ");
  assert.equal(hits.find((h) => h.id === s.d)!.label, null);
});

test("searchImages: FTSは関連度(rank)順 — 出現が多く短い本文が先に来る", (t) => {
  const db = memDb(t);
  const long = addImage(db, { text: "猫がいる。" + "あ".repeat(300) });
  const dense = addImage(db, { text: "猫がいる猫がいる猫がいる" });
  const hits = searchImages(db, term("猫がい"));
  assert.deepEqual(hits.map((h) => h.id), [dense, long]);
});

test("searchImages: 3文字未満は LIKE で、id順", (t) => {
  const db = memDb(t);
  const s = seed(db);
  assert.deepEqual(searchImages(db, term("猫")).map((h) => h.id), [s.a, s.b]);
  assert.equal(searchImages(db, term("猫"))[1].reviewed, 1);
});

test("searchImages: AND / OR / NOT の複合クエリ", (t) => {
  const db = memDb(t);
  const s = seed(db);
  const q = (and?: string, or?: string, not?: string) => searchImages(db, buildCasualQuery({ and, or, not })!).map((h) => h.id);
  assert.deepEqual(q("宮崎駿,監督"), [s.c, s.d]);
  assert.deepEqual(q("宮崎駿", undefined, "アニメ"), [s.d]);
  assert.deepEqual(q(undefined, "随筆,吾輩は"), [s.a, s.d]);
});

test("searchImages: NOTだけのクエリでも、OCR未完了(ocr_text が NULL)の行は結果に含めない(従来はクラッシュした)", (t) => {
  const db = memDb(t);
  const s = seed(db);
  const hits = searchImages(db, { type: "not", node: term("宮崎駿") });
  assert.deepEqual(hits.map((h) => h.id), [s.a, s.b]);
  assert.ok(hits.every((h) => typeof h.snippet === "string"));
});

test("searchImages: 一致語が複数ある複合クエリの抜粋は、最初に本文で見つかった語を使う", (t) => {
  const db = memDb(t);
  addImage(db, { text: "宮崎駿監督のアニメ" });
  const hits = searchImages(db, { type: "or", nodes: [term("存在しない語"), term("アニメ")] });
  assert.equal(hits[0].snippet, "宮崎駿監督の[アニメ]");
});

test("searchImages: limit で件数を絞る(既定は50)", (t) => {
  const db = memDb(t);
  for (let i = 0; i < 60; i++) addImage(db, { text: "共通のキーワード" });
  assert.equal(DEFAULT_SEARCH_LIMIT, 50);
  assert.equal(searchImages(db, term("キーワード")).length, 50);
  assert.equal(searchImages(db, term("共")).length, 50);
  assert.equal(searchImages(db, term("キーワード"), { limit: 3 }).length, 3);
  assert.equal(searchImages(db, term("共"), { limit: 7 }).length, 7);
  assert.equal(searchImages(db, { type: "or", nodes: [term("共"), term("通")] }, { limit: 2 }).length, 2);
});

test("searchImages: 該当なしは空配列。フレーズ内の二重引用符・LIKEメタ文字でも落ちない", (t) => {
  const db = memDb(t);
  addImage(db, { text: 'he said "hello" 100% sure_ok' });
  assert.deepEqual(searchImages(db, term("存在しない語")), []);
  assert.equal(searchImages(db, term('"hello"')).length, 1);
  assert.equal(searchImages(db, term("0%")).length, 1);
  assert.equal(searchImages(db, term("e_")).length, 1);
  assert.equal(searchImages(db, term("x_")).length, 0);
});

test("buildCasualQuery: フラグの組み合わせから木を作る", () => {
  assert.equal(buildCasualQuery({}), undefined);
  assert.equal(buildCasualQuery({ and: " , ", or: "" }), undefined);
  assert.deepEqual(buildCasualQuery({ and: "あ, い" }), { type: "and", nodes: [term("あ"), term("い")] });
  assert.deepEqual(buildCasualQuery({ or: "う" }), { type: "or", nodes: [term("う")] });
  assert.deepEqual(buildCasualQuery({ not: "え,お" }), {
    type: "and",
    nodes: [
      { type: "not", node: term("え") },
      { type: "not", node: term("お") },
    ],
  });
  assert.deepEqual(buildCasualQuery({ and: "あ", or: "い", not: "う" }), {
    type: "and",
    nodes: [
      { type: "and", nodes: [term("あ")] },
      { type: "or", nodes: [term("い")] },
      { type: "and", nodes: [{ type: "not", node: term("う") }] },
    ],
  });
});
