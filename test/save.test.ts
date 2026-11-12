import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { QueueRow } from "../src/db/index.js";
import { saveResultWithRetry } from "../src/worker/save.js";
import { addImage, addQueue, captureConsole, memDb, row, tmpDir } from "./helpers.js";

const payload = { ocrText: "本文", provider: "p", model: "m", rawResponse: "{}" };
const sleepNone = async () => {};

function setup(t: import("node:test").TestContext) {
  const db = memDb(t);
  const id = addImage(db);
  const qid = addQueue(db, id, "/x", "processing");
  const item = row<QueueRow>(db, "SELECT * FROM ocr_queue WHERE id = ?", qid)!;
  const rescue = join(tmpDir(t), "rescue.jsonl");
  return { db, id, item, rescue };
}

test("saveResultWithRetry: 成功すれば saved", async (t) => {
  const { db, id, item, rescue } = setup(t);
  const r = await saveResultWithRetry(db, item, payload, { attempts: 3, retryWaitMs: 1, rescueLogPath: rescue, sleep: sleepNone });
  assert.equal(r, "saved");
  assert.equal(row<{ ocr_text: string }>(db, "SELECT ocr_text FROM source_images WHERE id = ?", id)!.ocr_text, "本文");
  assert.ok(!existsSync(rescue));
});

test("saveResultWithRetry: ロック以外の失敗は即座に退避する(リトライしない)", async (t) => {
  captureConsole(t);
  const { db, item, rescue } = setup(t);
  db.exec("DROP TABLE ocr_log");
  const slept: number[] = [];
  const r = await saveResultWithRetry(db, item, payload, {
    attempts: 3,
    retryWaitMs: 10,
    rescueLogPath: rescue,
    sleep: async (ms) => void slept.push(ms),
  });
  assert.equal(r, "db_failed");
  assert.deepEqual(slept, []);
  assert.equal(JSON.parse(readFileSync(rescue, "utf-8")).ocrText, "本文");
});

test("saveResultWithRetry: rescue に、再現性のメタ情報(promptHash / requestOptions)も残す", async (t) => {
  captureConsole(t);
  const { db, item, rescue } = setup(t);
  db.exec("DROP TABLE ocr_log");
  await saveResultWithRetry(db, item, { ...payload, promptHash: "abc123", requestOptions: '{"t":1}' }, {
    attempts: 1,
    retryWaitMs: 1,
    rescueLogPath: rescue,
    sleep: sleepNone,
  });
  const e = JSON.parse(readFileSync(rescue, "utf-8"));
  assert.equal(e.promptHash, "abc123");
  assert.equal(e.requestOptions, '{"t":1}');
});

test("saveResultWithRetry: reviewed / missing の結果もそのまま返す", async (t) => {
  const { db, id, item, rescue } = setup(t);
  db.prepare("UPDATE source_images SET reviewed = 1 WHERE id = ?").run(id);
  assert.equal(await saveResultWithRetry(db, item, payload, { attempts: 1, retryWaitMs: 1, rescueLogPath: rescue, sleep: sleepNone }), "reviewed");
});
