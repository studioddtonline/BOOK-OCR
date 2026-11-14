import test from "node:test";
import assert from "node:assert/strict";
import { collectDiagnostics, printDiagnostics } from "../src/db/index.js";
import { addImage, addQueue, captureConsole, memDb } from "./helpers.js";

function seeded() {
  const db = memDb();
  addImage(db, { text: "あいうえお", label: "本" });
  addImage(db, { text: null });
  addImage(db, { text: "かきくけこ", reviewed: 1, label: "本" });
  addQueue(db, addImage(db), "/x");
  return db;
}

test("collectDiagnostics: 件数・キュー・索引状態を集める", () => {
  assert.deepEqual(collectDiagnostics(seeded()), {
    total: 4,
    withText: 2,
    reviewed: 1,
    unlabeled: 2,
    queue: { pending: 1, processing: 0, error: 0 },
    indexedTerms: 6,
  });
});

test("printDiagnostics: 件数・キュー・索引状態を表示する", (t) => {
  const out = captureConsole(t);
  printDiagnostics(seeded());
  const log = out.log.join("\n");
  assert.match(log, /source_images 総数: 4 \(ラベル\(file_path\)未設定: 2, レビュー済み: 1\)/);
  assert.match(log, /ocr_text が入っている件数: 2/);
  assert.match(log, /pending=1, processing=0, error=0/);
  assert.match(log, /索引済みのトライグラム数\(fts5vocab\): 6/);
  assert.ok(!log.includes("同期されていません"));
});

test("printDiagnostics: 本文があるのに索引が空なら reindex を案内する", (t) => {
  const out = captureConsole(t);
  const db = memDb();
  addImage(db, { text: "あいうえお" });
  db.exec(`INSERT INTO images_fts(images_fts) VALUES ('delete-all')`);
  printDiagnostics(db);
  assert.match(out.log.join("\n"), /インデックスが同期されていません/);
  assert.match(out.log.join("\n"), /npm run reindex/);
});
