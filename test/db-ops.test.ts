import test from "node:test";
import assert from "node:assert/strict";
import {
  getFtsIndexedTermCount,
  getImageStats,
  getQueueItemBySourceImage,
  isReviewed,
  listQueueItems,
  markQueueItemError,
  rebuildFtsIndex,
  requeueSourceImage,
  retryAllErrors,
  retryQueueItems,
  usageDate,
  isValidTimeZone,
  insertOcrLog,
  type QueueRow,
} from "../src/db/index.js";
import { addImage, addQueue, memDb, row } from "./helpers.js";

const q = (db: ReturnType<typeof memDb>, id: number) => row<QueueRow>(db, "SELECT * FROM ocr_queue WHERE id = ?", id)!;

// ---- isReviewed / stats --------------------------------------------------

test("isReviewed: 0 だけが未レビュー。0以外(1, -1, 2)は全てレビュー済み", () => {
  assert.equal(isReviewed({ reviewed: 0 }), false);
  for (const r of [1, -1, 2, 99]) assert.equal(isReviewed({ reviewed: r }), true, String(r));
});

test("getImageStats: 総数・本文あり・レビュー済み・ラベル未設定(空文字の本文は『あり』に数えない)", () => {
  const db = memDb();
  assert.deepEqual(getImageStats(db), { total: 0, withText: 0, reviewed: 0, unlabeled: 0 });
  addImage(db, { text: "x", label: "本" });
  addImage(db, { text: "" });
  addImage(db, { text: null, reviewed: -1 });
  assert.deepEqual(getImageStats(db), { total: 3, withText: 1, reviewed: 1, unlabeled: 2 });
});

test("rebuildFtsIndex: 索引を作り直す", () => {
  const db = memDb();
  addImage(db, { text: "あいうえお" });
  db.exec(`INSERT INTO images_fts(images_fts) VALUES ('delete-all')`);
  assert.equal(getFtsIndexedTermCount(db), 0);
  rebuildFtsIndex(db);
  assert.equal(getFtsIndexedTermCount(db), 3);
});

// ---- listQueueItems / getQueueItemBySourceImage / markQueueItemError ---------

test("listQueueItems: 状態の絞り込みと limit(既定20)", () => {
  const db = memDb();
  for (let i = 0; i < 25; i++) addQueue(db, addImage(db), `/${i}`, i % 5 === 0 ? "error" : "pending");
  assert.equal(listQueueItems(db).length, 20);
  assert.equal(listQueueItems(db, { limit: 3 }).length, 3);
  assert.equal(listQueueItems(db, { status: "error", limit: 100 }).length, 5);
  assert.ok(listQueueItems(db, { status: "pending", limit: 100 }).every((r) => r.status === "pending"));
  assert.deepEqual(listQueueItems(db, { limit: 100 }).map((r) => r.id), [...Array(25).keys()].map((i) => i + 1));
});

test("getQueueItemBySourceImage: 行があれば返し、無ければ undefined", () => {
  const db = memDb();
  const id = addImage(db);
  assert.equal(getQueueItemBySourceImage(db, id), undefined);
  const qid = addQueue(db, id, "/x");
  assert.equal(getQueueItemBySourceImage(db, id)?.id, qid);
});

test("markQueueItemError: 行だけを理由つき error にする(ocr_log は触らない)", () => {
  const db = memDb();
  const qid = addQueue(db, addImage(db), "/x", "processing");
  markQueueItemError(db, q(db, qid), "理由");
  assert.deepEqual([q(db, qid).status, q(db, qid).error_message], ["error", "理由"]);
  assert.equal(row(db, "SELECT 1 FROM ocr_log"), undefined);
});

// ---- retry ---------------------------------------------------------------

test("retryQueueItems: error の行だけ pending に戻し、失敗回数とメッセージをリセットする", () => {
  const db = memDb();
  const e = addQueue(db, addImage(db), "/e", "error", 5);
  db.prepare("UPDATE ocr_queue SET error_message = 'x' WHERE id = ?").run(e);
  const p = addQueue(db, addImage(db), "/p", "pending", 1);
  const pr = addQueue(db, addImage(db), "/pr", "processing");
  const r = retryQueueItems(db, [e, p, pr, 999]);
  assert.deepEqual(r, {
    retried: [e],
    notFound: [999],
    skipped: [
      { id: p, status: "pending" },
      { id: pr, status: "processing" },
    ],
  });
  assert.deepEqual([q(db, e).status, q(db, e).retry_count, q(db, e).error_message], ["pending", 0, null]);
  assert.equal(q(db, p).retry_count, 1, "pending の行は触らない");
});

test("retryAllErrors: error を全て戻す。無ければ何もしない", () => {
  const db = memDb();
  assert.deepEqual(retryAllErrors(db), { retried: [], notFound: [], skipped: [] });
  const a = addQueue(db, addImage(db), "/a", "error", 3);
  const b = addQueue(db, addImage(db), "/b", "error", 4);
  addQueue(db, addImage(db), "/c", "pending");
  assert.deepEqual(retryAllErrors(db).retried, [a, b]);
});

// ---- requeue -------------------------------------------------------------

test("requeueSourceImage: 未レビューの行をキューに載せる(本文は残る)", () => {
  const db = memDb();
  const id = addImage(db, { text: "古い結果" });
  const r = requeueSourceImage(db, { sourceImageId: id, imagePath: "/new.png" });
  assert.equal(r.kind, "queued");
  const item = getQueueItemBySourceImage(db, id)!;
  assert.deepEqual([item.status, item.image_path, item.retry_count], ["pending", "/new.png", 0]);
  assert.equal(row<{ ocr_text: string }>(db, "SELECT ocr_text FROM source_images")!.ocr_text, "古い結果");
});

test("requeueSourceImage: 存在しない行・レビュー済みの行は拒否し、キューに何も載せない", () => {
  const db = memDb();
  assert.deepEqual(requeueSourceImage(db, { sourceImageId: 99, imagePath: "/x" }), { kind: "no_source" });
  for (const reviewed of [1, -1, 2]) {
    const id = addImage(db, { reviewed });
    assert.deepEqual(requeueSourceImage(db, { sourceImageId: id, imagePath: "/x" }), { kind: "reviewed", reviewed });
  }
  assert.equal(row(db, "SELECT 1 FROM ocr_queue"), undefined);
});

test("requeueSourceImage: 既にキューにある行は二重に載せない(pending / processing / error)", () => {
  const db = memDb();
  for (const status of ["pending", "processing", "error"] as const) {
    const id = addImage(db);
    const qid = addQueue(db, id, "/old", status);
    assert.deepEqual(requeueSourceImage(db, { sourceImageId: id, imagePath: "/new", force: true }).kind, status === "error" ? "reset" : "already_queued");
    assert.equal(q(db, qid).image_path, status === "error" ? "/new" : "/old");
  }
});

test("requeueSourceImage: force なしでは error の行も差し替えない", () => {
  const db = memDb();
  const id = addImage(db);
  const qid = addQueue(db, id, "/old", "error", 5);
  assert.deepEqual(requeueSourceImage(db, { sourceImageId: id, imagePath: "/new" }), { kind: "already_queued", queueId: qid, status: "error" });
  assert.equal(q(db, qid).retry_count, 5);
});

test("requeueSourceImage: force で error の行を差し替えると、失敗回数もメッセージもリセットされる", () => {
  const db = memDb();
  const id = addImage(db);
  const qid = addQueue(db, id, "/old", "error", 5);
  db.prepare("UPDATE ocr_queue SET error_message = 'x' WHERE id = ?").run(qid);
  assert.deepEqual(requeueSourceImage(db, { sourceImageId: id, imagePath: "/new", force: true }), { kind: "reset", queueId: qid });
  assert.deepEqual([q(db, qid).status, q(db, qid).image_path, q(db, qid).retry_count, q(db, qid).error_message], ["pending", "/new", 0, null]);
});

// ---- ocr_log のメタ情報 --------------------------------------------------

test("insertOcrLog: promptHash / requestOptions を記録できる(省略時は NULL)", () => {
  const db = memDb();
  const id = addImage(db);
  insertOcrLog(db, { sourceImageId: id, provider: "p", model: "m", outcome: "success", promptHash: "h", requestOptions: '{"a":1}' });
  insertOcrLog(db, { sourceImageId: id, provider: "p", model: "m", outcome: "error" });
  const logs = db.prepare("SELECT prompt_hash, request_options FROM ocr_log ORDER BY id").all().map((r) => ({ ...r }));
  assert.deepEqual(logs, [
    { prompt_hash: "h", request_options: '{"a":1}' },
    { prompt_hash: null, request_options: null },
  ]);
});

// ---- 使用量の日付 --------------------------------------------------------

test("usageDate: 既定はUTC。タイムゾーンで日付変わりが変わる", () => {
  const t = new Date(Date.UTC(2026, 0, 1, 20, 0, 0)); // 2026-01-01 20:00 UTC
  assert.equal(usageDate(t), "2026-01-01");
  assert.equal(usageDate(t, "UTC"), "2026-01-01");
  assert.equal(usageDate(t, "Asia/Tokyo"), "2026-01-02"); // 翌日 05:00
  assert.equal(usageDate(t, "America/Los_Angeles"), "2026-01-01"); // 12:00
  assert.equal(usageDate(new Date(Date.UTC(2026, 0, 1, 7, 59, 59)), "America/Los_Angeles"), "2025-12-31"); // 前日 23:59
  assert.equal(usageDate(new Date(Date.UTC(2026, 0, 1, 8, 0, 0)), "America/Los_Angeles"), "2026-01-01");
});

test("usageDate: 常に YYYY-MM-DD 形式", () => {
  assert.match(usageDate(), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(usageDate(new Date(0), "Asia/Kolkata"), /^\d{4}-\d{2}-\d{2}$/);
});

test("isValidTimeZone", () => {
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("Asia/Tokyo"), true);
  assert.equal(isValidTimeZone("Mars/Olympus"), false);
  assert.equal(isValidTimeZone(""), false);
});
