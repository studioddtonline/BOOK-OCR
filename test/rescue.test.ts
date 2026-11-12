import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { QueueRow } from "../src/db/index.js";
import { appendRescueLog, applyRescueEntry, readRescueFile, type RescueEntry } from "../src/rescue.js";
import { addImage, addQueue, captureConsole, memDb, row, tmpDir } from "./helpers.js";

const entry = (sourceImageId: number, over: Partial<RescueEntry> = {}): RescueEntry => ({
  savedAt: "2026-01-01T00:00:00.000Z",
  queueId: 1,
  sourceImageId,
  ocrText: "救出本文",
  provider: "g",
  model: "m",
  rawResponse: "{}",
  promptHash: null,
  requestOptions: null,
  dbError: "boom",
  ...over,
});

test("appendRescueLog: 1行1件のJSONで追記される", (t) => {
  const dir = tmpDir(t);
  const file = join(dir, "r.jsonl");
  const item = { id: 3, source_image_id: 7 } as QueueRow;
  appendRescueLog(file, item, { ocrText: "A", provider: "p", model: "m", rawResponse: "{}" }, new Error("x"));
  appendRescueLog(file, item, { ocrText: "B", provider: "p", model: "m", rawResponse: "{}" }, new Error("y"));
  const lines = readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.ocrText), ["A", "B"]);
  assert.equal(lines[0].queueId, 3);
  assert.equal(lines[0].sourceImageId, 7);
  assert.match(lines[0].dbError, /x/);
});

test("appendRescueLog: 書き込めなくても例外は投げず、標準エラーに結果を出す", (t) => {
  const out = captureConsole(t);
  appendRescueLog("/nonexistent-dir/r.jsonl", { id: 1, source_image_id: 2 } as QueueRow, { ocrText: "失われない本文", provider: "p", model: "m", rawResponse: "{}" }, new Error("x"));
  assert.match(out.error.join("\n"), /失われない本文/);
});

test("readRescueFile: ファイルが無ければ空", () => {
  assert.deepEqual(readRescueFile("/nonexistent/r.jsonl"), { entries: [], invalidLines: [] });
});

test("readRescueFile: 空行は無視し、形式不正の行は行番号で報告し、省略された項目は補う", (t) => {
  const file = join(tmpDir(t), "r.jsonl");
  writeFileSync(
    file,
    [
      JSON.stringify(entry(1)),
      "",
      "{壊れたJSON",
      JSON.stringify({ sourceImageId: "文字列", ocrText: "x" }), // 型不正
      JSON.stringify({ sourceImageId: 5, ocrText: "最小限" }),
    ].join("\n"),
  );
  const r = readRescueFile(file);
  assert.deepEqual(r.invalidLines, [3, 4]);
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[1].sourceImageId, 5);
  assert.equal(r.entries[1].provider, "unknown");
  assert.equal(r.entries[1].rawResponse, "");
});

test("applyRescueEntry: キューに行があれば反映し、行は消え、ocr_log に残る", (t) => {
  const db = memDb(t);
  const id = addImage(db);
  addQueue(db, id, "/x", "processing");
  assert.deepEqual(applyRescueEntry(db, entry(id)), { kind: "applied" });
  assert.equal(row<{ ocr_text: string }>(db, "SELECT ocr_text FROM source_images")!.ocr_text, "救出本文");
  assert.equal(row(db, "SELECT 1 FROM ocr_queue"), undefined);
  assert.equal(row<{ outcome: string }>(db, "SELECT outcome FROM ocr_log")!.outcome, "success");
});

test("applyRescueEntry: dryRun は書き込まない", (t) => {
  const db = memDb(t);
  const id = addImage(db);
  addQueue(db, id, "/x", "processing");
  assert.deepEqual(applyRescueEntry(db, entry(id), true), { kind: "would_apply" });
  assert.equal(row<{ ocr_text: string | null }>(db, "SELECT ocr_text FROM source_images")!.ocr_text, null);
  assert.ok(row(db, "SELECT 1 FROM ocr_queue"));
});

test("applyRescueEntry: キューの行が無ければ(処理済み)スキップし、新しい結果を古い結果で上書きしない", (t) => {
  const db = memDb(t);
  const id = addImage(db, { text: "再OCRで得た新しい本文" });
  assert.deepEqual(applyRescueEntry(db, entry(id)), { kind: "skipped_already_processed" });
  assert.equal(row<{ ocr_text: string }>(db, "SELECT ocr_text FROM source_images")!.ocr_text, "再OCRで得た新しい本文");
});

test("applyRescueEntry: error で残っている行にも反映できる(結果が入ればエラーは解消)", (t) => {
  const db = memDb(t);
  const id = addImage(db);
  addQueue(db, id, "/x", "error", 5);
  assert.equal(applyRescueEntry(db, entry(id)).kind, "applied");
});

test("applyRescueEntry: レビュー済みなら上書きせず reviewed(AI出力は ocr_log に残る)", (t) => {
  const db = memDb(t);
  const id = addImage(db, { text: "人間の本文", reviewed: 2 });
  addQueue(db, id, "/x", "processing");
  assert.deepEqual(applyRescueEntry(db, entry(id)), { kind: "reviewed" });
  assert.equal(row<{ ocr_text: string }>(db, "SELECT ocr_text FROM source_images")!.ocr_text, "人間の本文");
  assert.equal(row<{ ocr_text: string }>(db, "SELECT ocr_text FROM ocr_log")!.ocr_text, "救出本文");
});

test("applyRescueEntry: メタ情報(promptHash / requestOptions)も ocr_log に引き継ぐ", (t) => {
  const db = memDb(t);
  const id = addImage(db);
  addQueue(db, id, "/x", "processing");
  applyRescueEntry(db, entry(id, { promptHash: "h1", requestOptions: '{"a":1}' }));
  const log = row<{ prompt_hash: string; request_options: string }>(db, "SELECT prompt_hash, request_options FROM ocr_log")!;
  assert.deepEqual([log.prompt_hash, log.request_options], ["h1", '{"a":1}']);
});
