import test from "node:test";
import assert from "node:assert/strict";
import { printStartupReport } from "../src/worker/report.js";
import { addImage, addQueue, captureConsole, FakeProvider, memDb } from "./helpers.js";

test("起動レポート: options があればJSONで、無ければ『各社の既定値』と表示する", (t) => {
  const out = captureConsole(t);
  const db = memDb(t);
  const withOptions = new FakeProvider("a");
  (withOptions as { options: Record<string, unknown> }).options = { temperature: 0.1 };
  printStartupReport(db, [withOptions, new FakeProvider("b")]);
  const log = out.log.join("\n");
  assert.match(log, /1\. a .*\n\s+SDKへ送る options: \{"temperature":0\.1\}/);
  assert.match(log, /2\. b .*\n\s+SDKへ送る options: \(なし/);
});

test("起動レポート: error の行が21件以上なら、先頭20件のみ表示と明記する", (t) => {
  const out = captureConsole(t);
  const db = memDb(t);
  for (let i = 0; i < 25; i++) addQueue(db, addImage(db), `/${i}`, "error", i);
  printStartupReport(db, []);
  const log = out.log.join("\n");
  assert.match(log, /先頭20件のみ表示/);
  assert.equal(log.split("\n").filter((l) => l.includes("失敗回数=")).length, 20);
  assert.match(log, /queue retry/);
});

test("起動レポート: error が無ければ error 一覧を出さない", (t) => {
  const out = captureConsole(t);
  printStartupReport(memDb(t), []);
  assert.ok(!out.log.join("\n").includes("人間の確認が必要"));
});

test("起動レポート: error メッセージの改行は1行にまとめ、160文字で切る", (t) => {
  const out = captureConsole(t);
  const db = memDb(t);
  const qid = addQueue(db, addImage(db), "/x", "error", 1);
  db.prepare("UPDATE ocr_queue SET error_message = ? WHERE id = ?").run("行1\n行2\n" + "あ".repeat(300), qid);
  printStartupReport(db, []);
  const line = out.log.join("\n").split("\n").find((l) => l.includes("失敗回数="))!;
  assert.ok(line.includes("行1 行2 "));
  assert.ok(!line.includes("あ".repeat(160)));
});
