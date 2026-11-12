import test from "node:test";
import assert from "node:assert/strict";
import { OCR_PROMPT } from "../src/ocr/prompt.js";

test("OCRプロンプト: 出力規約(後続処理が依存する記号)を含む", () => {
  assert.ok(OCR_PROMPT.includes("■"), "判読不能文字");
  assert.ok(OCR_PROMPT.includes("{{ }}"), "自信のない箇所");
  assert.ok(OCR_PROMPT.includes("[NO_TEXT]"), "文字なし");
  assert.ok(OCR_PROMPT.includes("ふりがな"));
});

test("OCRプロンプト: 空でなく、前後に余分な空白がない", () => {
  assert.ok(OCR_PROMPT.length > 500);
  assert.equal(OCR_PROMPT, OCR_PROMPT.trim());
});
