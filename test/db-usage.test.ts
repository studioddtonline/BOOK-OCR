import test from "node:test";
import assert from "node:assert/strict";
import { getProviderUsageToday, markProviderExhausted, recordProviderRequest } from "../src/db/index.js";
import { memDb, rows } from "./helpers.js";

test("使用量: 未記録なら0・未枯渇", () => {
  assert.deepEqual(getProviderUsageToday(memDb(), "p"), { requestCount: 0, isExhausted: false });
});

test("使用量: recordProviderRequest で1ずつ増える", () => {
  const db = memDb();
  recordProviderRequest(db, "p");
  recordProviderRequest(db, "p");
  recordProviderRequest(db, "p");
  assert.deepEqual(getProviderUsageToday(db, "p"), { requestCount: 3, isExhausted: false });
});

test("使用量: プロバイダ名ごとに独立", () => {
  const db = memDb();
  recordProviderRequest(db, "a");
  recordProviderRequest(db, "b");
  recordProviderRequest(db, "b");
  assert.equal(getProviderUsageToday(db, "a").requestCount, 1);
  assert.equal(getProviderUsageToday(db, "b").requestCount, 2);
});

test("使用量: markProviderExhausted は未記録でも枯渇を立てる(件数は0)", () => {
  const db = memDb();
  markProviderExhausted(db, "p");
  assert.deepEqual(getProviderUsageToday(db, "p"), { requestCount: 0, isExhausted: true });
});

test("使用量: 枯渇後にカウントしても枯渇フラグは保たれる", () => {
  const db = memDb();
  recordProviderRequest(db, "p");
  markProviderExhausted(db, "p");
  recordProviderRequest(db, "p");
  assert.deepEqual(getProviderUsageToday(db, "p"), { requestCount: 2, isExhausted: true });
});

test("使用量: 行は (provider, UTC日付) で1行", () => {
  const db = memDb();
  recordProviderRequest(db, "p");
  markProviderExhausted(db, "p");
  const r = rows<{ provider: string; date: string }>(db, "SELECT provider, date FROM provider_usage");
  assert.equal(r.length, 1);
  assert.equal(r[0].date, new Date().toISOString().slice(0, 10));
});

test("使用量: 過去日の行は今日の集計に影響しない", () => {
  const db = memDb();
  db.prepare("INSERT INTO provider_usage (provider, date, request_count, is_exhausted) VALUES ('p', '2000-01-01', 99, 1)").run();
  assert.deepEqual(getProviderUsageToday(db, "p"), { requestCount: 0, isExhausted: false });
});
