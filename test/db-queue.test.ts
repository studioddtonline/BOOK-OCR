import test from "node:test";
import assert from "node:assert/strict";
import {
  claimNextQueueItem,
  completeQueueItem,
  failQueueItem,
  getQueueSummary,
  getSourceImage,
  hasPendingQueueItems,
  insertOcrLog,
  insertQueueItem,
  insertSourceImage,
  listErrorQueueItems,
  resetProcessingToPending,
  type QueueRow,
} from "../src/db/index.js";
import { addImage, addQueue, memDb, row, rows } from "./helpers.js";

const payload = { ocrText: "結果の本文", provider: "p", model: "m", rawResponse: '{"raw":1}' };

function queueRow(db: ReturnType<typeof memDb>, id: number): QueueRow {
  return row<QueueRow>(db, "SELECT * FROM ocr_queue WHERE id = ?", id)!;
}

test("insertSourceImage / insertQueueItem / getSourceImage", () => {
  const db = memDb();
  const id = insertSourceImage(db, { label: "本A", fileName: "1.webp" });
  insertQueueItem(db, { sourceImageId: id, imagePath: "/w/1.webp" });
  assert.deepEqual({ ...getSourceImage(db, id) }, { id, file_path: "本A", file_name: "1.webp", ocr_text: null, reviewed: 0 });
  assert.equal(getSourceImage(db, 999), undefined);
  const q = row<QueueRow>(db, "SELECT * FROM ocr_queue")!;
  assert.equal(q.status, "pending");
  assert.equal(q.retry_count, 0);
  assert.equal(q.error_message, null);
});

test("insertSourceImage: label が null なら file_path は NULL", () => {
  const db = memDb();
  const id = insertSourceImage(db, { label: null, fileName: "x.webp" });
  assert.equal(getSourceImage(db, id)?.file_path, null);
});

test("hasPendingQueueItems は pending だけを数える", () => {
  const db = memDb();
  assert.equal(hasPendingQueueItems(db), false);
  addQueue(db, addImage(db), "/a", "processing");
  addQueue(db, addImage(db), "/b", "error");
  assert.equal(hasPendingQueueItems(db), false);
  addQueue(db, addImage(db), "/c", "pending");
  assert.equal(hasPendingQueueItems(db), true);
});

test("claimNextQueueItem: id の小さい pending から順に processing にして返す", () => {
  const db = memDb();
  const q1 = addQueue(db, addImage(db), "/1");
  const q2 = addQueue(db, addImage(db), "/2");
  const first = claimNextQueueItem(db)!;
  assert.equal(first.id, q1);
  assert.equal(first.status, "processing");
  assert.equal(queueRow(db, q1).status, "processing");
  const second = claimNextQueueItem(db)!;
  assert.equal(second.id, q2);
  assert.equal(claimNextQueueItem(db), undefined);
});

test("claimNextQueueItem: error / processing の行は取らない", () => {
  const db = memDb();
  addQueue(db, addImage(db), "/1", "error");
  addQueue(db, addImage(db), "/2", "processing");
  assert.equal(claimNextQueueItem(db), undefined);
});

test("resetProcessingToPending: processing だけを pending に戻して件数を返す", () => {
  const db = memDb();
  const a = addQueue(db, addImage(db), "/1", "processing");
  const b = addQueue(db, addImage(db), "/2", "error");
  const c = addQueue(db, addImage(db), "/3", "pending");
  assert.equal(resetProcessingToPending(db), 1);
  assert.equal(queueRow(db, a).status, "pending");
  assert.equal(queueRow(db, b).status, "error");
  assert.equal(queueRow(db, c).status, "pending");
  assert.equal(resetProcessingToPending(db), 0);
});

test("getQueueSummary: 状態ごとの件数(無い状態は0)", () => {
  const db = memDb();
  assert.deepEqual(getQueueSummary(db), { pending: 0, processing: 0, error: 0 });
  addQueue(db, addImage(db), "/1");
  addQueue(db, addImage(db), "/2");
  addQueue(db, addImage(db), "/3", "error");
  assert.deepEqual(getQueueSummary(db), { pending: 2, processing: 0, error: 1 });
});

test("listErrorQueueItems: error だけを id 順に limit 件", () => {
  const db = memDb();
  addQueue(db, addImage(db), "/1");
  const e1 = addQueue(db, addImage(db), "/2", "error");
  const e2 = addQueue(db, addImage(db), "/3", "error");
  addQueue(db, addImage(db), "/4", "error");
  assert.deepEqual(
    listErrorQueueItems(db, 2).map((r) => r.id),
    [e1, e2],
  );
  assert.equal(listErrorQueueItems(db).length, 3);
});

test("insertOcrLog: 省略した項目は NULL になる", () => {
  const db = memDb();
  const id = addImage(db);
  insertOcrLog(db, { sourceImageId: id, provider: null, model: null, outcome: "error" });
  const r = row<Record<string, unknown>>(db, "SELECT * FROM ocr_log")!;
  assert.equal(r.provider, null);
  assert.equal(r.http_status, null);
  assert.equal(r.ocr_text, null);
  assert.equal(r.raw_response, null);
  assert.equal(r.error_message, null);
  assert.equal(r.outcome, "error");
  assert.ok(typeof r.created_at === "string");
});

// ---- completeQueueItem ---------------------------------------------------

test("completeQueueItem: 成功すると本文を保存し、キューを消し、ログを残す", () => {
  const db = memDb();
  const id = addImage(db);
  const qid = addQueue(db, id, "/x", "processing");
  assert.equal(completeQueueItem(db, queueRow(db, qid), payload), "saved");
  assert.equal(getSourceImage(db, id)?.ocr_text, "結果の本文");
  assert.equal(row(db, "SELECT 1 FROM ocr_queue WHERE id = ?", qid), undefined);
  const log = row<Record<string, unknown>>(db, "SELECT * FROM ocr_log")!;
  assert.equal(log.outcome, "success");
  assert.equal(log.provider, "p");
  assert.equal(log.model, "m");
  assert.equal(log.ocr_text, "結果の本文");
  assert.equal(log.raw_response, '{"raw":1}');
  assert.equal(log.error_message, null);
});

test("completeQueueItem: 保存した本文は全文検索の索引にも反映される", () => {
  const db = memDb();
  const id = addImage(db);
  const qid = addQueue(db, id, "/x", "processing");
  completeQueueItem(db, queueRow(db, qid), payload);
  const hit = rows<{ rowid: number }>(db, `SELECT rowid FROM images_fts WHERE images_fts MATCH '"結果の本"'`);
  assert.deepEqual(hit.map((h) => h.rowid), [id]);
});

for (const reviewed of [1, -1, 2]) {
  test(`completeQueueItem: reviewed=${reviewed} の行は上書きせず、理由つき error で残し、AI出力はログに残す`, () => {
    const db = memDb();
    const id = addImage(db, { text: "人間が直した本文", reviewed });
    const qid = addQueue(db, id, "/x", "processing");
    assert.equal(completeQueueItem(db, queueRow(db, qid), payload), "reviewed");
    assert.equal(getSourceImage(db, id)?.ocr_text, "人間が直した本文");
    const q = queueRow(db, qid);
    assert.equal(q.status, "error");
    assert.match(q.error_message ?? "", new RegExp(`reviewed=${reviewed}`));
    const log = row<Record<string, unknown>>(db, "SELECT * FROM ocr_log")!;
    assert.equal(log.outcome, "success");
    assert.equal(log.ocr_text, "結果の本文");
    assert.match(String(log.error_message), /上書きしませんでした/);
  });
}

test("completeQueueItem: 格納先が消えていたら missing(キューも消す)", () => {
  const db = memDb();
  const id = addImage(db);
  const qid = addQueue(db, id, "/x", "processing");
  const item = queueRow(db, qid);
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare("DELETE FROM source_images WHERE id = ?").run(id);
  assert.equal(completeQueueItem(db, item, payload), "missing");
  assert.equal(row(db, "SELECT 1 FROM ocr_queue WHERE id = ?", qid), undefined);
  assert.equal(row(db, "SELECT 1 FROM ocr_log"), undefined);
});

test("completeQueueItem: 途中で失敗したら全部ロールバックされる", () => {
  const db = memDb();
  const id = addImage(db);
  const qid = addQueue(db, id, "/x", "processing");
  db.exec("DROP TABLE ocr_log");
  assert.throws(() => completeQueueItem(db, queueRow(db, qid), payload));
  assert.equal(getSourceImage(db, id)?.ocr_text, null, "ocr_text の更新も巻き戻る");
  assert.ok(row(db, "SELECT 1 FROM ocr_queue WHERE id = ?", qid), "キューの行も残る");
});

// ---- failQueueItem -------------------------------------------------------

const baseFail = { outcome: "error" as const, provider: "p", model: "m", message: "msg" };

test("failQueueItem: countRetry=true なら retry_count が増え、permanent=false なら pending に戻る", () => {
  const db = memDb();
  const id = addImage(db);
  const qid = addQueue(db, id, "/x", "processing", 2);
  failQueueItem(db, queueRow(db, qid), { ...baseFail, countRetry: true, permanent: false });
  const q = queueRow(db, qid);
  assert.equal(q.status, "pending");
  assert.equal(q.retry_count, 3);
  assert.equal(q.error_message, "msg");
});

test("failQueueItem: countRetry=false なら retry_count は変わらない", () => {
  const db = memDb();
  const qid = addQueue(db, addImage(db), "/x", "processing", 2);
  failQueueItem(db, queueRow(db, qid), { ...baseFail, outcome: "rate_limited", countRetry: false, permanent: false });
  assert.equal(queueRow(db, qid).retry_count, 2);
});

test("failQueueItem: permanent=true なら error になる", () => {
  const db = memDb();
  const qid = addQueue(db, addImage(db), "/x", "processing");
  failQueueItem(db, queueRow(db, qid), { ...baseFail, countRetry: false, permanent: true });
  assert.equal(queueRow(db, qid).status, "error");
});

test("failQueueItem: ocr_log に outcome / http_status / メッセージを残す(本文は無し)", () => {
  const db = memDb();
  const id = addImage(db);
  const qid = addQueue(db, id, "/x", "processing");
  failQueueItem(db, queueRow(db, qid), {
    outcome: "server_error",
    provider: "p",
    model: "m",
    message: "503 unavailable",
    countRetry: false,
    permanent: false,
    httpStatus: 503,
  });
  const log = row<Record<string, unknown>>(db, "SELECT * FROM ocr_log")!;
  assert.equal(log.source_image_id, id);
  assert.equal(log.outcome, "server_error");
  assert.equal(log.http_status, 503);
  assert.equal(log.error_message, "503 unavailable");
  assert.equal(log.ocr_text, null);
});

test("failQueueItem: provider を null にして記録できる(API呼び出し前の拒否)", () => {
  const db = memDb();
  const qid = addQueue(db, addImage(db), "/x", "processing");
  failQueueItem(db, queueRow(db, qid), { outcome: "error", provider: null, model: null, message: "m", countRetry: false, permanent: true });
  assert.equal(row<{ provider: string | null }>(db, "SELECT provider FROM ocr_log")?.provider, null);
});
