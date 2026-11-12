import test from "node:test";
import assert from "node:assert/strict";
import { getProviderUsageToday, markProviderExhausted, recordProviderRequest, usageDate } from "../src/db/index.js";
import type { ImageInput } from "../src/image-file.js";
import { ProviderConfigError, RateLimitError, TransientServerError } from "../src/providers/errors.js";
import { ProviderHealth } from "../src/providers/health.js";
import { ProviderPool } from "../src/providers/pool.js";
import { FakeProvider, captureConsole, memDb } from "./helpers.js";

const IMG: ImageInput = { bytes: Buffer.from("img"), mimeType: "image/webp" };

function pool(db: ReturnType<typeof memDb>, providers: FakeProvider[], health = new ProviderHealth(), now = 0) {
  return new ProviderPool(db, providers, { health, clock: () => now });
}

// ---- select --------------------------------------------------------------

test("select: 候補が無い・全て無効なら all_disabled", () => {
  assert.deepEqual(pool(memDb(), []).select(), { kind: "all_disabled" });
  const p = pool(memDb(), [new FakeProvider("a")]);
  p.disable("a");
  assert.equal(p.isDisabled("a"), true);
  assert.equal(p.select().kind, "all_disabled");
});

test("select: priority の先頭を選ぶ", () => {
  const s = pool(memDb(), [new FakeProvider("a"), new FakeProvider("b")]).select();
  assert.equal(s.kind === "ok" && s.provider.name, "a");
});

test("select: 無効化されたものは飛ばす", () => {
  const p = pool(memDb(), [new FakeProvider("a"), new FakeProvider("b")]);
  p.disable("a");
  const s = p.select();
  assert.equal(s.kind === "ok" && s.provider.name, "b");
});

test("select: 枯渇フラグ・日次上限に達したものは飛ばす", () => {
  const db = memDb();
  markProviderExhausted(db, "a", usageDate(new Date(0)));
  recordProviderRequest(db, "b", usageDate(new Date(0)));
  recordProviderRequest(db, "b", usageDate(new Date(0)));
  const s = pool(db, [new FakeProvider("a"), new FakeProvider("b", [], 2), new FakeProvider("c")]).select();
  assert.equal(s.kind === "ok" && s.provider.name, "c");
});

test("select: 上限未満ならまだ使える(境界)", () => {
  const db = memDb();
  const date = usageDate(new Date(0));
  const b = new FakeProvider("b", [], 2);
  recordProviderRequest(db, "b", date);
  assert.equal(pool(db, [b]).select().kind, "ok");
  recordProviderRequest(db, "b", date);
  assert.equal(pool(db, [b]).select().kind, "exhausted");
});

test("select: 全て上限なら exhausted", () => {
  const db = memDb();
  markProviderExhausted(db, "a", usageDate(new Date(0)));
  assert.deepEqual(pool(db, [new FakeProvider("a")]).select(), { kind: "exhausted" });
});

test("select: 休止中は飛ばし、他が無ければ backoff(最短の解除時刻まで)", () => {
  const h = new ProviderHealth(60_000, 600_000);
  h.recordTransientFailure("a", 1000); // 61000まで
  h.recordTransientFailure("b", 1000);
  h.recordTransientFailure("b", 1000); // 121000まで
  const p = pool(memDb(), [new FakeProvider("a"), new FakeProvider("b")], h, 2000);
  assert.deepEqual(p.select(), { kind: "backoff", waitMs: 59_000 });
});

test("select: backoff の待ち時間は最低1秒", () => {
  const h = new ProviderHealth(100, 100);
  h.recordTransientFailure("a", 0);
  assert.deepEqual(pool(memDb(), [new FakeProvider("a")], h, 99).select(), { kind: "backoff", waitMs: 1000 });
});

test("select: 休止が解除される時刻になれば再び選ばれる", () => {
  const h = new ProviderHealth(100, 100);
  h.recordTransientFailure("a", 0);
  assert.equal(pool(memDb(), [new FakeProvider("a")], h, 100).select().kind, "ok");
});

test("select: 一方が枯渇・他方が休止なら backoff(休止は待てば使える)", () => {
  const db = memDb();
  markProviderExhausted(db, "a", usageDate(new Date(0)));
  const h = new ProviderHealth(5000, 5000);
  h.recordTransientFailure("b", 0);
  assert.equal(pool(db, [new FakeProvider("a"), new FakeProvider("b")], h, 0).select().kind, "backoff");
});

test("select: 枯渇しているプロバイダの休止は待ち時間に含めない", () => {
  const db = memDb();
  markProviderExhausted(db, "a", usageDate(new Date(0)));
  const h = new ProviderHealth(5000, 5000);
  h.recordTransientFailure("a", 0);
  assert.deepEqual(pool(db, [new FakeProvider("a")], h, 0).select(), { kind: "exhausted" });
});

test("select(now): 引数の時刻で判定できる", () => {
  const h = new ProviderHealth(1000, 1000);
  h.recordTransientFailure("a", 0);
  const p = pool(memDb(), [new FakeProvider("a")], h, 0);
  assert.equal(p.select(500).kind, "backoff");
  assert.equal(p.select(1000).kind, "ok");
});

// ---- 使用量の日付(タイムゾーン) -----------------------------------------

test("使用量の日付はタイムゾーン設定に従う(UTC と東京で日付変わりが違う)", () => {
  // 2026-01-01 20:00 UTC = 2026-01-02 05:00 JST
  const now = Date.UTC(2026, 0, 1, 20, 0, 0);
  const db = memDb();
  const utc = new ProviderPool(db, [new FakeProvider("a")], { clock: () => now, usageTimeZone: "UTC" });
  const jst = new ProviderPool(db, [new FakeProvider("a")], { clock: () => now, usageTimeZone: "Asia/Tokyo" });

  markProviderExhausted(db, "a", "2026-01-01"); // UTCの「今日」だけ枯渇
  assert.equal(utc.select().kind, "exhausted");
  assert.equal(jst.select().kind, "ok", "東京ではもう翌日なので使える");
});

// ---- attempt -------------------------------------------------------------

test("attempt: 成功すると使用量を1増やし、休止状態を解除して、結果を返す", async () => {
  const db = memDb();
  const h = new ProviderHealth();
  h.recordTransientFailure("a", Date.now());
  const p = new ProviderPool(db, [], { health: h });
  const fake = new FakeProvider("a", ["hello"]);
  const r = await p.attempt(fake, IMG, "PROMPT");
  assert.ok(r.ok && r.result.text === "hello");
  assert.equal(getProviderUsageToday(db, "a").requestCount, 1);
  assert.equal(h.blockedUntil("a"), 0);
});

test("attempt: RateLimitError は枯渇としてマークする(件数は増えない)", async () => {
  const db = memDb();
  const r = await new ProviderPool(db, []).attempt(new FakeProvider("a", [new RateLimitError("a", "429")]), IMG, "P");
  assert.ok(!r.ok);
  assert.equal(!r.ok && r.failure.kind, "rate_limited");
  assert.deepEqual(getProviderUsageToday(db, "a"), { requestCount: 0, isExhausted: true });
});

test("attempt: ProviderConfigError はそのプロバイダを無効化する", async () => {
  const p = new ProviderPool(memDb(), []);
  const r = await p.attempt(new FakeProvider("a", [new ProviderConfigError("a", "bad model")]), IMG, "P");
  assert.equal(!r.ok && r.failure.kind, "config_error");
  assert.equal(p.isDisabled("a"), true);
});

test("attempt: TransientServerError は休止させ、休止時間(backoffMs)を返す。ステータスも保持する", async () => {
  const h = new ProviderHealth(1234, 9999);
  const p = new ProviderPool(memDb(), [], { health: h });
  const r = await p.attempt(new FakeProvider("a", [new TransientServerError("a", "x", 503)]), IMG, "P");
  assert.ok(!r.ok);
  assert.equal(r.failure.kind, "server_error");
  assert.equal(r.failure.status, 503);
  assert.equal(r.backoffMs, 1234);
  assert.ok(h.blockedUntil("a") > Date.now());
});

test("attempt: その他のエラーは画像側の問題(image_error)で、プロバイダの状態は変えない", async () => {
  const db = memDb();
  const p = new ProviderPool(db, []);
  const r = await p.attempt(new FakeProvider("a", [new Error("テキストなし")]), IMG, "P");
  assert.ok(!r.ok);
  assert.equal(r.failure.kind, "image_error");
  assert.equal(r.failure.message, "テキストなし");
  assert.equal(r.backoffMs, undefined);
  assert.deepEqual(getProviderUsageToday(db, "a"), { requestCount: 0, isExhausted: false });
  assert.equal(p.isDisabled("a"), false);
});

test("attempt: 使用量の記録に失敗しても、取得済みのOCR結果は返す(警告のみ)", async (t) => {
  const out = captureConsole(t);
  const db = memDb();
  db.exec("DROP TABLE provider_usage");
  const r = await new ProviderPool(db, []).attempt(new FakeProvider("a", ["ok"]), IMG, "P");
  assert.ok(r.ok && r.result.text === "ok");
  assert.match(out.warn.join("\n"), /使用量を記録できませんでした/);
});

test("attempt: 枯渇フラグの記録に失敗しても、元の失敗(rate_limited)を隠さない", async (t) => {
  const out = captureConsole(t);
  const db = memDb();
  db.exec("DROP TABLE provider_usage");
  const r = await new ProviderPool(db, []).attempt(new FakeProvider("a", [new RateLimitError("a", "429")]), IMG, "P");
  assert.equal(!r.ok && r.failure.kind, "rate_limited");
  assert.match(out.warn.join("\n"), /枯渇フラグを記録できませんでした/);
});

test("attempt: プロバイダにはバイト列とMIMEタイプ・プロンプトがそのまま渡る", async () => {
  const seen: unknown[] = [];
  const fake = new FakeProvider("a");
  const orig = fake.callOcr.bind(fake);
  fake.callOcr = async (image, prompt) => (seen.push(image, prompt), orig(image, prompt));
  await new ProviderPool(memDb(), []).attempt(fake, IMG, "PROMPT");
  assert.deepEqual(seen, [IMG, "PROMPT"]);
});
