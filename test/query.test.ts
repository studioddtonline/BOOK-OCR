import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { QueryNodeSchema, compileQuery, escapeLike, extractPositiveTerms, type QueryNode } from "../src/search/query.js";
import { addImage, memDb, rows } from "./helpers.js";

const term = (value: string): QueryNode => ({ type: "term", value });
const and = (...nodes: QueryNode[]): QueryNode => ({ type: "and", nodes });
const or = (...nodes: QueryNode[]): QueryNode => ({ type: "or", nodes });
const not = (node: QueryNode): QueryNode => ({ type: "not", node });

const FTS_SQL = "id IN (SELECT rowid FROM images_fts WHERE images_fts MATCH ?)";

test("escapeLike: \\ % _ をエスケープする", () => {
  assert.equal(escapeLike("100%_ok\\"), "100\\%\\_ok\\\\");
  assert.equal(escapeLike("普通"), "普通");
});

test("compileQuery: 3文字以上の語は FTS5 サブクエリ(フレーズ)", () => {
  assert.deepEqual(compileQuery(term("吾輩は")), { sql: FTS_SQL, params: ['"吾輩は"'] });
});

test("compileQuery: FTS のフレーズ内の二重引用符は二重化する", () => {
  assert.deepEqual(compileQuery(term('a"bc')).params, ['"a""bc"']);
});

test("compileQuery: 3文字未満の語は LIKE(特殊文字はエスケープ)", () => {
  assert.deepEqual(compileQuery(term("猫")), { sql: "ocr_text LIKE ? ESCAPE '\\'", params: ["%猫%"] });
  assert.deepEqual(compileQuery(term("5%")).params, ["%5\\%%"]);
});

test("compileQuery: 文字数はコードポイントで数える(サロゲートペア)", () => {
  assert.equal(compileQuery(term("𠮷野")).sql.startsWith("ocr_text LIKE"), true, "2コードポイント");
  assert.equal(compileQuery(term("𠮷野家")).sql, FTS_SQL, "3コードポイント");
});

test("compileQuery: and / or / not の形とパラメータの順序", () => {
  const c = compileQuery(and(term("あいう"), or(term("え"), not(term("おかき")))));
  assert.equal(
    c.sql,
    `(${FTS_SQL} AND (ocr_text LIKE ? ESCAPE '\\' OR (NOT ${FTS_SQL})))`,
  );
  assert.deepEqual(c.params, ['"あいう"', "%え%", '"おかき"']);
});

test("compileQuery: 空の and は 1、空の or は 0", () => {
  assert.deepEqual(compileQuery({ type: "and", nodes: [] }), { sql: "1", params: [] });
  assert.deepEqual(compileQuery({ type: "or", nodes: [] }), { sql: "0", params: [] });
});

test("extractPositiveTerms: NOT 配下は除外し、二重否定は肯定に戻る", () => {
  assert.deepEqual(extractPositiveTerms(and(term("a"), not(term("b")), or(term("c")))), ["a", "c"]);
  assert.deepEqual(extractPositiveTerms(not(not(term("x")))), ["x"]);
  assert.deepEqual(extractPositiveTerms(not(term("x"))), []);
});

test("QueryNodeSchema: 正しい木を受理する", () => {
  const q = or(and(term("あ"), term("い")), and(term("う"), not(term("え"))));
  assert.deepEqual(QueryNodeSchema.parse(q), q);
});

test("QueryNodeSchema: 不正な形を拒否する", () => {
  for (const bad of [
    { type: "term", value: "" },
    { type: "term" },
    { type: "and", nodes: [] },
    { type: "or", nodes: [{ type: "xor" }] },
    { type: "not" },
    { type: "unknown" },
    "text",
    null,
  ]) {
    assert.equal(QueryNodeSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

// ---- 実際のDBに対する実行 -------------------------------------------------

function seed(db: DatabaseSync): Record<string, number> {
  return {
    miyazaki: addImage(db, { text: "宮崎駿監督の新作について語る" }),
    anime: addImage(db, { text: "宮崎駿監督のアニメ作品の歴史" }),
    cat: addImage(db, { text: "猫が好きな小説家の随筆" }),
    pct: addImage(db, { text: "割引は100%ではありません" }),
    under: addImage(db, { text: "under_score と 100x" }),
    pending: addImage(db, { text: null }),
  };
}

function search(db: DatabaseSync, q: QueryNode): number[] {
  const c = compileQuery(q);
  return rows<{ id: number }>(db, `SELECT id FROM source_images WHERE ${c.sql} ORDER BY id`, ...c.params).map((r) => r.id);
}

test("実行: 単語・フレーズ・短い語(LIKE)", () => {
  const db = memDb();
  const s = seed(db);
  assert.deepEqual(search(db, term("宮崎駿")), [s.miyazaki, s.anime]);
  assert.deepEqual(search(db, term("猫")), [s.cat]);
  assert.deepEqual(search(db, term("なにもない語")), []);
});

test("実行: AND / OR / NOT(3文字以上と未満の混在)", () => {
  const db = memDb();
  const s = seed(db);
  assert.deepEqual(search(db, and(term("宮崎駿"), term("監督"))), [s.miyazaki, s.anime]);
  assert.deepEqual(search(db, and(term("宮崎駿"), not(term("アニメ")))), [s.miyazaki]);
  assert.deepEqual(search(db, or(term("猫"), term("新作"))), [s.miyazaki, s.cat]);
  assert.deepEqual(search(db, or(and(term("宮崎駿"), term("歴史")), term("随筆"))), [s.anime, s.cat]);
});

test("実行: LIKE のメタ文字(% _)は文字として扱う", () => {
  const db = memDb();
  const s = seed(db);
  assert.deepEqual(search(db, term("0%")), [s.pct]);
  assert.deepEqual(search(db, term("r_")), [s.under]);
  assert.deepEqual(search(db, term("_s")), [s.under]);
  assert.deepEqual(search(db, term("x_")), [], "ワイルドカードとして働かない");
});

test("実行: FTS側の二重引用符を含む語でもエラーにならない", () => {
  const db = memDb();
  addImage(db, { text: 'he said "hello" to me' });
  assert.deepEqual(search(db, term('"hello"')).length, 1);
});

test("実行: 全体が NOT のとき、OCR未完了(ocr_text NULL)の行は 3文字以上の NOT では含まれてしまう(現状の挙動)", () => {
  const db = memDb();
  const s = seed(db);
  const ids = search(db, not(term("宮崎駿")));
  assert.ok(ids.includes(s.pending), "NULLの行が混ざる(= 呼び出し側で除外が必要)");
  assert.ok(!ids.includes(s.miyazaki));
});
