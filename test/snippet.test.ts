import test from "node:test";
import assert from "node:assert/strict";
import { buildSnippet } from "../src/search/snippet.js";

test("buildSnippet: ヒット箇所を [ ] で囲み、前後20文字と省略記号をつける", () => {
  const text = "あ".repeat(30) + "ターゲット" + "い".repeat(30);
  assert.equal(buildSnippet(text, ["ターゲット"]), `...${"あ".repeat(20)}[ターゲット]${"い".repeat(20)}...`);
});

test("buildSnippet: 先頭・末尾に近いときは省略記号をつけない", () => {
  assert.equal(buildSnippet("ターゲットだけ", ["ターゲット"]), "[ターゲット]だけ");
  assert.equal(buildSnippet("前置きターゲット", ["ターゲット"]), "前置き[ターゲット]");
});

test("buildSnippet: 最初に本文に見つかった候補語を使う", () => {
  assert.equal(buildSnippet("本文にはBがある", ["A", "B", "本文"]), "本文には[B]がある");
});

test("buildSnippet: 候補が全て見つからなければ先頭60文字(超えたら ...)", () => {
  assert.equal(buildSnippet("短い本文", ["zzz"]), "短い本文");
  const long = "あ".repeat(100);
  assert.equal(buildSnippet(long, []), "あ".repeat(60) + "...");
  assert.equal(buildSnippet("x".repeat(60), []), "x".repeat(60));
});

test("buildSnippet: 空文字列でも落ちない", () => {
  assert.equal(buildSnippet("", ["a"]), "");
});
