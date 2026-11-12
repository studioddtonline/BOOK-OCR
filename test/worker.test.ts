import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getProviderUsageToday, openDb, type QueueRow } from "../src/db/index.js";
import { OCR_PROMPT_HASH } from "../src/ocr/prompt.js";
import { ProviderConfigError, RateLimitError, TransientServerError } from "../src/providers/errors.js";
import { ProviderHealth } from "../src/providers/health.js";
import type { OcrProvider } from "../src/providers/types.js";
import { StopController, runWorker, type RunWorkerOptions } from "../src/worker/worker.js";
import { FakeProvider, addImage, addQueue, captureConsole, dummyImage, fileDb, memDb, row, rows, tmpDir } from "./helpers.js";

interface Env {
  db: DatabaseSync;
  dir: string;
  rescue: string;
  run(providers: OcrProvider[], over?: Partial<RunWorkerOptions>, ctl?: StopController): ReturnType<typeof runWorker>;
  enqueue(label?: string): { id: number; qid: number; path: string };
}

function setup(t: import("node:test").TestContext, db: DatabaseSync = memDb(t)): Env {
  const dir = tmpDir(t);
  const rescue = join(dir, "rescue.jsonl");
  let n = 0;
  return {
    db,
    dir,
    rescue,
    run: (providers, over = {}, ctl) =>
      runWorker(
        {
          db,
          providers,
          rescueLogPath: rescue,
          pollIntervalMs: 1,
          stopWhenIdle: true,
          exhaustedSleepMs: 1,
          saveRetryWaitMs: 1,
          health: new ProviderHealth(5, 10),
          ...over,
        },
        ctl,
      ),
    enqueue: () => {
      n++;
      const path = dummyImage(dir, `${n}.webp`);
      const id = addImage(db, { fileName: `${n}.webp` });
      const qid = addQueue(db, id, path);
      return { id, qid, path };
    },
  };
}

const queue = (db: DatabaseSync, qid: number) => row<QueueRow>(db, "SELECT * FROM ocr_queue WHERE id = ?", qid);
const text = (db: DatabaseSync, id: number) => row<{ ocr_text: string | null }>(db, "SELECT ocr_text FROM source_images WHERE id = ?", id)?.ocr_text;

// ---- 正常系 --------------------------------------------------------------

test("成功: 本文を保存し、キューを消し、ocr_log と使用量を記録して idle で終わる", async (t) => {
  captureConsole(t);
  const e = setup(t);
  const { id, qid } = e.enqueue();
  const p = new FakeProvider("a", ["書き起こし結果"]);
  assert.equal(await e.run([p]), "idle");
  assert.equal(text(e.db, id), "書き起こし結果");
  assert.equal(queue(e.db, qid), undefined);
  const log = row<Record<string, unknown>>(e.db, "SELECT * FROM ocr_log")!;
  assert.equal(log.outcome, "success");
  assert.equal(log.provider, "a");
  assert.equal(log.model, "a-model");
  assert.equal(log.raw_response, JSON.stringify({ fake: true, name: "a" }));
  assert.equal(getProviderUsageToday(e.db, "a").requestCount, 1);
});

test("キューが空なら何もせず idle", async (t) => {
  captureConsole(t);
  const e = setup(t);
  const p = new FakeProvider("a");
  assert.equal(await e.run([p]), "idle");
  assert.equal(p.calls.length, 0);
});

test("複数件は id 順に処理される", async (t) => {
  captureConsole(t);
  const e = setup(t);
  const items = [e.enqueue(), e.enqueue(), e.enqueue()];
  const p = new FakeProvider("a");
  await e.run([p]);
  assert.deepEqual(p.calls, items.map((i) => basename(i.path)));
});

test("日次上限に達したら、priority の次のプロバイダに回る", async (t) => {
  captureConsole(t);
  const e = setup(t);
  e.enqueue();
  e.enqueue();
  e.enqueue();
  const a = new FakeProvider("a", [], 2);
  const b = new FakeProvider("b");
  assert.equal(await e.run([a, b]), "idle");
  assert.equal(a.calls.length, 2);
  assert.equal(b.calls.length, 1);
});

test("起動時に、前回の中断で processing のまま残った行を pending に戻して処理する", async (t) => {
  const out = captureConsole(t);
  const e = setup(t);
  const path = dummyImage(e.dir, "x.webp");
  const id = addImage(e.db);
  addQueue(e.db, id, path, "processing");
  const p = new FakeProvider("a", ["ok"]);
  await e.run([p]);
  assert.equal(p.calls.length, 1);
  assert.equal(text(e.db, id), "ok");
  assert.match(out.log.join("\n"), /1 件を pending に戻しました/);
});

test("起動時レポート: プロバイダ・options・キュー状況・error 行を表示する", async (t) => {
  const out = captureConsole(t);
  const e = setup(t);
  const id = addImage(e.db);
  const qid = addQueue(e.db, id, "/x", "error", 5);
  e.db.prepare("UPDATE ocr_queue SET error_message = '失敗理由メッセージ' WHERE id = ?").run(qid);
  await e.run([new FakeProvider("prov-a")]);
  const log = out.log.join("\n");
  assert.match(log, /ワーカー起動/);
  assert.match(log, /1\. prov-a\s+\[type=gemini, model=prov-a-model, 1日上限=1000\]/);
  assert.match(log, /各社の既定値で動作します/);
  assert.match(log, /pending=0, processing=0, error=1/);
  assert.match(log, new RegExp(`queue#${qid} source_image#${id} 失敗回数=5 : 失敗理由メッセージ`));
});

// ---- API呼び出し前の拒否 -------------------------------------------------

for (const reviewed of [1, -1, 2]) {
  test(`reviewed=${reviewed} の行は、APIを呼ばずに error にする`, async (t) => {
    const out = captureConsole(t);
    const e = setup(t);
    const path = dummyImage(e.dir, "r.webp");
    const id = addImage(e.db, { text: "人間の本文", reviewed });
    const qid = addQueue(e.db, id, path);
    const p = new FakeProvider("a");
    await e.run([p]);
    assert.equal(p.calls.length, 0);
    assert.equal(text(e.db, id), "人間の本文");
    const q = queue(e.db, qid)!;
    assert.equal(q.status, "error");
    assert.equal(q.retry_count, 0);
    assert.match(q.error_message ?? "", new RegExp(`reviewed=${reviewed}`));
    const log = row<Record<string, unknown>>(e.db, "SELECT * FROM ocr_log")!;
    assert.equal(log.outcome, "error");
    assert.equal(log.provider, null);
    assert.match(out.error.join("\n"), /\[要確認\]/);
    assert.equal(getProviderUsageToday(e.db, "a").requestCount, 0);
  });
}

test("画像ファイルが無ければ、APIを呼ばずに error", async (t) => {
  captureConsole(t);
  const e = setup(t);
  const id = addImage(e.db);
  const qid = addQueue(e.db, id, join(e.dir, "missing.webp"));
  const p = new FakeProvider("a");
  await e.run([p]);
  assert.equal(p.calls.length, 0);
  const q = queue(e.db, qid)!;
  assert.equal(q.status, "error");
  assert.match(q.error_message ?? "", /画像ファイルが見つかりません/);
});

test("格納先の source_images が無ければ、APIを呼ばずに error(ocr_log は外部キーのため書けないので、キューの行だけ更新)", async (t) => {
  captureConsole(t);
  const e = setup(t);
  e.db.exec("PRAGMA foreign_keys = OFF");
  e.db.prepare("INSERT INTO ocr_queue (source_image_id, image_path) VALUES (999, ?)").run(dummyImage(e.dir, "o.webp"));
  e.db.exec("PRAGMA foreign_keys = ON");
  const p = new FakeProvider("a");
  await e.run([p]);
  assert.equal(p.calls.length, 0);
  const q = row<{ status: string; error_message: string }>(e.db, "SELECT status, error_message FROM ocr_queue")!;
  assert.equal(q.status, "error");
  assert.match(q.error_message, /格納先.*存在しません/);
  assert.equal(row(e.db, "SELECT 1 FROM ocr_log"), undefined);
});

// ---- API呼び出しのエラー -------------------------------------------------

test("429: そのプロバイダを枯渇扱いにして、同じ画像を次のプロバイダで処理する(失敗回数は増えない)", async (t) => {
  captureConsole(t);
  const e = setup(t);
  const { id } = e.enqueue();
  const a = new FakeProvider("a", [new RateLimitError("a", "429")]);
  const b = new FakeProvider("b", ["bの結果"]);
  assert.equal(await e.run([a, b]), "idle");
  assert.equal(text(e.db, id), "bの結果");
  assert.equal(getProviderUsageToday(e.db, "a").isExhausted, true);
  const logs = rows<{ provider: string; outcome: string }>(e.db, "SELECT provider, outcome FROM ocr_log ORDER BY id");
  assert.deepEqual(logs, [
    { provider: "a", outcome: "rate_limited" },
    { provider: "b", outcome: "success" },
  ]);
});

test("全プロバイダが枯渇したら exhausted で終了し、画像は pending のまま", async (t) => {
  captureConsole(t);
  const e = setup(t);
  const { qid } = e.enqueue();
  const a = new FakeProvider("a", [new RateLimitError("a", "429")]);
  assert.equal(await e.run([a]), "exhausted");
  const q = queue(e.db, qid)!;
  assert.equal(q.status, "pending");
  assert.equal(q.retry_count, 0);
});

test("一時的なサーバーエラー: pending に戻し、失敗回数は増やさず、そのプロバイダを休ませる", async (t) => {
  captureConsole(t);
  const e = setup(t);
  const { qid } = e.enqueue();
  const health = new ProviderHealth(60_000, 600_000);
  const ctl = new StopController();
  const a = new FakeProvider("a", [new TransientServerError("a", "unavailable", 503)]);
  a.onCall = () => ctl.stop(); // 1回呼んだら止める
  assert.equal(await e.run([a], { health }, ctl), "stopped");
  const q = queue(e.db, qid)!;
  assert.equal(q.status, "pending");
  assert.equal(q.retry_count, 0);
  assert.ok(health.blockedUntil("a") > Date.now(), "休止中になっている");
  const log = row<Record<string, unknown>>(e.db, "SELECT * FROM ocr_log")!;
  assert.equal(log.outcome, "server_error");
  assert.equal(log.http_status, 503);
});

test("一時的なサーバーエラーの後、休止明けに再試行して成功する", async (t) => {
  captureConsole(t);
  const e = setup(t);
  const { id } = e.enqueue();
  const a = new FakeProvider("a", [new TransientServerError("a", "unavailable", 503), "復旧後の結果"]);
  assert.equal(await e.run([a]), "idle");
  assert.equal(text(e.db, id), "復旧後の結果");
  assert.equal(a.calls.length, 2);
});

test("設定エラー: そのプロバイダを無効化し、全部無効なら all_disabled。画像は pending のまま", async (t) => {
  const out = captureConsole(t);
  const e = setup(t);
  const { qid } = e.enqueue();
  const a = new FakeProvider("a", [new ProviderConfigError("a", "model not found")]);
  assert.equal(await e.run([a]), "all_disabled");
  const q = queue(e.db, qid)!;
  assert.equal(q.status, "pending");
  assert.equal(q.retry_count, 0);
  assert.equal(row<{ outcome: string }>(e.db, "SELECT outcome FROM ocr_log")!.outcome, "config_error");
  assert.match(out.error.join("\n"), /全てのプロバイダが設定エラーで使用不能/);
});

test("設定エラーで1つ無効化されても、他のプロバイダで続行する", async (t) => {
  captureConsole(t);
  const e = setup(t);
  const { id } = e.enqueue();
  const a = new FakeProvider("a", [new ProviderConfigError("a", "bad key")]);
  const b = new FakeProvider("b", ["b結果"]);
  assert.equal(await e.run([a, b]), "idle");
  assert.equal(text(e.db, id), "b結果");
  assert.equal(a.calls.length, 1, "無効化後は a を呼ばない");
});

test("画像側のエラー: 失敗回数を数え、上限で error にする", async (t) => {
  const out = captureConsole(t);
  const e = setup(t);
  const { qid } = e.enqueue();
  const boom = () => new Error("テキストが返りませんでした");
  const a = new FakeProvider("a", [boom(), boom(), boom(), boom()]);
  assert.equal(await e.run([a], { maxRetries: 3 }), "idle");
  assert.equal(a.calls.length, 3);
  const q = queue(e.db, qid)!;
  assert.equal(q.status, "error");
  assert.equal(q.retry_count, 3);
  assert.equal(q.error_message, "テキストが返りませんでした");
  assert.equal(rows(e.db, "SELECT 1 FROM ocr_log WHERE outcome = 'error'").length, 3);
  assert.match(out.error.join("\n"), /\[要確認\].*3 回失敗/);
});

test("画像側のエラーは、上限前に成功すれば救われる", async (t) => {
  captureConsole(t);
  const e = setup(t);
  const { id, qid } = e.enqueue();
  const a = new FakeProvider("a", [new Error("1回目だけ失敗"), "2回目で成功"]);
  await e.run([a]);
  assert.equal(text(e.db, id), "2回目で成功");
  assert.equal(queue(e.db, qid), undefined);
});

test("error になった行は、次のループでは再処理されない", async (t) => {
  captureConsole(t);
  const e = setup(t);
  e.enqueue();
  const a = new FakeProvider("a", [new Error("x")]);
  await e.run([a], { maxRetries: 1 });
  assert.equal(a.calls.length, 1);
});

// ---- 保存まわり ----------------------------------------------------------

test("OCR中に reviewed が立てられたら、本文は上書きせず、AI出力は ocr_log に残し、行は error", async (t) => {
  const out = captureConsole(t);
  const e = setup(t);
  const { id, qid } = e.enqueue();
  const a = new FakeProvider("a", ["AIの出力"]);
  a.onCall = () => e.db.prepare("UPDATE source_images SET ocr_text = '人間の本文', reviewed = 1 WHERE id = ?").run(id);
  await e.run([a]);
  assert.equal(text(e.db, id), "人間の本文");
  assert.equal(queue(e.db, qid)!.status, "error");
  assert.equal(row<{ ocr_text: string }>(e.db, "SELECT ocr_text FROM ocr_log")!.ocr_text, "AIの出力");
  assert.match(out.warn.join("\n"), /レビュー済みになった/);
});

test("OCR中に格納先が消えたら、結果を捨てて行も消す", async (t) => {
  const out = captureConsole(t);
  const e = setup(t);
  const { id, qid } = e.enqueue();
  const a = new FakeProvider("a", ["結果"]);
  a.onCall = () => {
    e.db.exec("PRAGMA foreign_keys = OFF");
    e.db.prepare("DELETE FROM source_images WHERE id = ?").run(id);
    e.db.exec("PRAGMA foreign_keys = ON");
  };
  await e.run([a]);
  assert.equal(queue(e.db, qid), undefined);
  assert.match(out.warn.join("\n"), /結果を捨てました/);
});

test("DB保存が(ロック以外の理由で)失敗したら rescue.jsonl に退避し、行は processing のまま残る", async (t) => {
  captureConsole(t);
  const e = setup(t);
  const { id, qid } = e.enqueue();
  const a = new FakeProvider("a", ["救出される結果"]);
  a.onCall = () => e.db.exec("DROP TABLE ocr_log"); // 保存トランザクションを失敗させる
  assert.equal(await e.run([a]), "idle");
  assert.equal(text(e.db, id), null);
  assert.equal(queue(e.db, qid)!.status, "processing");
  const lines = readFileSync(e.rescue, "utf-8").trim().split("\n");
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.queueId, qid);
  assert.equal(entry.sourceImageId, id);
  assert.equal(entry.ocrText, "救出される結果");
  assert.equal(entry.provider, "a");
  assert.equal(entry.model, "a-model");
  assert.equal(entry.rawResponse, JSON.stringify({ fake: true, name: "a" }));
  assert.match(entry.dbError, /ocr_log/);
  assert.ok(!Number.isNaN(Date.parse(entry.savedAt)));
});

test("DBがロックされ続けたら、リトライの末に rescue.jsonl に退避する", async (t) => {
  const out = captureConsole(t);
  const { db, path } = fileDb(t, 1);
  const e = setup(t, db);
  const { id, qid } = e.enqueue();
  const other = openDb(path, 1);
  t.after(() => {
    try {
      other.exec("ROLLBACK");
    } catch {
      /* 既に終了 */
    }
    other.close();
  });
  const a = new FakeProvider("a", ["ロック中の結果"]);
  a.onCall = () => other.exec("BEGIN IMMEDIATE"); // 呼び出し後、保存の直前にロックを握る
  await e.run([a], { saveRetries: 2 });
  assert.ok(existsSync(e.rescue));
  assert.equal(JSON.parse(readFileSync(e.rescue, "utf-8").trim()).ocrText, "ロック中の結果");
  assert.equal(queue(db, qid)!.status, "processing");
  assert.equal(text(db, id), null);
  assert.match(out.warn.join("\n"), /リトライを行います/);
});

// ---- 停止 ----------------------------------------------------------------

test("待機中に stop すると、すぐに stopped で終わる", async (t) => {
  captureConsole(t);
  const e = setup(t);
  const ctl = new StopController();
  setTimeout(() => ctl.stop(), 30);
  const started = Date.now();
  const exit = await e.run([new FakeProvider("a")], { stopWhenIdle: false, pollIntervalMs: 60_000 }, ctl);
  assert.equal(exit, "stopped");
  assert.ok(Date.now() - started < 3000);
});

test("キューが空の間は、待機メッセージを1回だけ出す", async (t) => {
  const out = captureConsole(t);
  const e = setup(t);
  const ctl = new StopController();
  setTimeout(() => ctl.stop(), 60);
  await e.run([new FakeProvider("a")], { stopWhenIdle: false, pollIntervalMs: 5 }, ctl);
  assert.equal(out.log.filter((l) => l.includes("処理待ちの画像がありません")).length, 1);
});

test("StopController.sleep: 指定時間待つ / stop で即座に解除 / stop後は即解決", async () => {
  const c1 = new StopController();
  const t0 = Date.now();
  await c1.sleep(40);
  assert.ok(Date.now() - t0 >= 30);

  const c2 = new StopController();
  setTimeout(() => c2.stop(), 20);
  const t1 = Date.now();
  await c2.sleep(60_000);
  assert.ok(Date.now() - t1 < 2000);
  assert.equal(c2.stopped, true);

  const t2 = Date.now();
  await c2.sleep(60_000);
  assert.ok(Date.now() - t2 < 100);
});

// ---- ocr_log の再現性メタ情報 / 保存リトライ / 失敗記録のロック -------------

test("成功時の ocr_log に、プロンプトのハッシュと送った options が残る", async (t) => {
  captureConsole(t);
  const e = setup(t);
  e.enqueue();
  const p = new FakeProvider("a", ["x"]);
  await e.run([p]);
  const log = row<{ prompt_hash: string; request_options: string }>(e.db, "SELECT prompt_hash, request_options FROM ocr_log")!;
  assert.equal(log.prompt_hash, OCR_PROMPT_HASH);
  assert.equal(log.request_options, "{}");
});

test("失敗時の ocr_log にも、プロンプトのハッシュが残る", async (t) => {
  captureConsole(t);
  const e = setup(t);
  e.enqueue();
  await e.run([new FakeProvider("a", [new Error("x")])], { maxRetries: 1 });
  assert.equal(row<{ prompt_hash: string }>(e.db, "SELECT prompt_hash FROM ocr_log")!.prompt_hash, OCR_PROMPT_HASH);
});

test("DBロックが保存の途中で解消すれば、リトライで保存できる(rescue には退避しない)", async (t) => {
  const out = captureConsole(t);
  const { db, path } = fileDb(t, 1);
  const e = setup(t, db);
  const { id, qid } = e.enqueue();
  const other = openDb(path, 1);
  t.after(() => {
    try {
      other.exec("ROLLBACK");
    } catch {
      /* 解放済み */
    }
    other.close();
  });
  const a = new FakeProvider("a", ["ロック解消後に保存される"]);
  a.onCall = () => {
    other.exec("BEGIN IMMEDIATE");
    setTimeout(() => other.exec("ROLLBACK"), 30); // リトライの待機中(非同期)に解放される
  };
  await e.run([a], { saveRetries: 5, saveRetryWaitMs: 40 });
  assert.equal(text(db, id), "ロック解消後に保存される");
  assert.equal(queue(db, qid), undefined);
  assert.ok(!existsSync(e.rescue));
  assert.match(out.warn.join("\n"), /リトライを行います/);
});

test("失敗の記録がDBロックで書けなくても、ワーカーは落ちずに続行する(行は processing のまま)", async (t) => {
  const out = captureConsole(t);
  const { db, path } = fileDb(t, 1);
  const e = setup(t, db);
  const { qid } = e.enqueue();
  const other = openDb(path, 1);
  t.after(() => {
    try {
      other.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    other.close();
  });
  const a = new FakeProvider("a", [new Error("画像側のエラー")]);
  a.onCall = () => other.exec("BEGIN IMMEDIATE");
  assert.equal(await e.run([a]), "idle");
  assert.equal(queue(db, qid)!.status, "processing");
  assert.match(out.warn.join("\n"), /失敗の記録がDBロックで書けませんでした/);
});

test("失敗の記録がロック以外の理由で失敗したら、例外は握りつぶさない", async (t) => {
  captureConsole(t);
  const e = setup(t);
  e.enqueue();
  const a = new FakeProvider("a", [new Error("x")]);
  a.onCall = () => e.db.exec("DROP TABLE ocr_log");
  await assert.rejects(e.run([a]), /ocr_log/);
});

test("pool を直接渡しても動く(providers/health は無視される)", async (t) => {
  captureConsole(t);
  const e = setup(t);
  const { id } = e.enqueue();
  const a = new FakeProvider("a", ["pool経由"]);
  const { ProviderPool } = await import("../src/providers/pool.js");
  assert.equal(await e.run([], { pool: new ProviderPool(e.db, [a]) }), "idle");
  assert.equal(text(e.db, id), "pool経由");
});

test("画像ファイルが読めない(存在するがファイルではない)場合は、画像側のエラーとして失敗回数に数える", async (t) => {
  captureConsole(t);
  const e = setup(t);
  const dir = join(e.dir, "i-am-a-directory.webp");
  mkdirSync(dir);
  const id = addImage(e.db);
  const qid = addQueue(e.db, id, dir);
  const p = new FakeProvider("a");
  await e.run([p], { maxRetries: 2 });
  assert.equal(p.calls.length, 0, "APIは呼ばない");
  const q = queue(e.db, qid)!;
  assert.deepEqual([q.status, q.retry_count], ["error", 2]);
  assert.match(q.error_message ?? "", /EISDIR/);
});

test("再OCR: 元画像(jpg/png)が image_path でも、そのMIMEタイプでプロバイダに渡る", async (t) => {
  captureConsole(t);
  const e = setup(t);
  const id = addImage(e.db);
  const path = dummyImage(e.dir, "orig.jpg");
  addQueue(e.db, id, path);
  const seen: string[] = [];
  const p = new FakeProvider("a", ["x"]);
  const orig = p.callOcr.bind(p);
  p.callOcr = async (image, prompt) => (seen.push(image.mimeType), orig(image, prompt));
  await e.run([p]);
  assert.deepEqual(seen, ["image/jpeg"]);
});
