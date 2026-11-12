import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { QueueRow } from "../src/db/index.js";
import { preflight } from "../src/worker/preflight.js";
import { addImage, addQueue, dummyImage, memDb, row, tmpDir } from "./helpers.js";

function item(db: ReturnType<typeof memDb>, qid: number): QueueRow {
  return row<QueueRow>(db, "SELECT * FROM ocr_queue WHERE id = ?", qid)!;
}

test("preflight: 未レビューで画像ファイルがあれば ok", (t) => {
  const db = memDb(t);
  const path = dummyImage(tmpDir(t), "a.webp");
  const qid = addQueue(db, addImage(db), path);
  assert.deepEqual(preflight(db, item(db, qid)), { ok: true });
});

test("preflight: reviewed が 0 以外なら、値を示して拒否する(-1 や 2 でも)", (t) => {
  for (const reviewed of [1, -1, 2]) {
    const db = memDb(t);
    const path = dummyImage(tmpDir(t), "a.webp");
    const qid = addQueue(db, addImage(db, { reviewed }), path);
    const r = preflight(db, item(db, qid));
    assert.ok(!r.ok);
    assert.match(r.message, new RegExp(`reviewed=${reviewed}`));
    assert.match(r.message, /queue retry/);
    assert.equal(r.orphan, undefined);
  }
});

test("preflight: 画像ファイルが無ければ、パスを示して拒否する", (t) => {
  const db = memDb(t);
  const missing = join(tmpDir(t), "none.webp");
  const qid = addQueue(db, addImage(db), missing);
  const r = preflight(db, item(db, qid));
  assert.ok(!r.ok);
  assert.ok(r.message.includes(missing));
  assert.match(r.message, /requeue --force/);
});

test("preflight: 格納先が無ければ orphan として拒否する", (t) => {
  const db = memDb(t);
  const path = dummyImage(tmpDir(t), "a.webp");
  const qid = addQueue(db, addImage(db), path);
  const it = item(db, qid);
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare("DELETE FROM source_images").run();
  const r = preflight(db, it);
  assert.ok(!r.ok);
  assert.equal(r.orphan, true);
  assert.match(r.message, /格納先/);
});

test("preflight: 検査の順序は 格納先 → reviewed → ファイル(reviewed かつファイル無しなら reviewed を先に報告)", (t) => {
  const db = memDb(t);
  const qid = addQueue(db, addImage(db, { reviewed: 1 }), "/nonexistent.webp");
  const r = preflight(db, item(db, qid));
  assert.ok(!r.ok);
  assert.match(r.message, /reviewed=1/);
});
