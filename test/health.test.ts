import test from "node:test";
import assert from "node:assert/strict";
import { BACKOFF_INITIAL_MS, BACKOFF_MAX_MS, ProviderHealth } from "../src/providers/health.js";

test("ProviderHealth: 連続失敗で 1分→2分→4分… と倍になり、上限で止まる", () => {
  const h = new ProviderHealth();
  assert.equal(h.recordTransientFailure("p", 0), BACKOFF_INITIAL_MS);
  assert.equal(h.recordTransientFailure("p", 0), BACKOFF_INITIAL_MS * 2);
  assert.equal(h.recordTransientFailure("p", 0), BACKOFF_INITIAL_MS * 4);
  let last = 0;
  for (let i = 0; i < 10; i++) last = h.recordTransientFailure("p", 0);
  assert.equal(last, BACKOFF_MAX_MS);
});

test("ProviderHealth: blockedUntil は now + 待ち時間。成功で解除", () => {
  const h = new ProviderHealth(100, 1000);
  assert.equal(h.blockedUntil("p"), 0);
  h.recordTransientFailure("p", 5000);
  assert.equal(h.blockedUntil("p"), 5100);
  h.recordSuccess("p");
  assert.equal(h.blockedUntil("p"), 0);
  assert.equal(h.recordTransientFailure("p", 0), 100, "成功後は初期値から");
});

test("ProviderHealth: プロバイダごとに独立", () => {
  const h = new ProviderHealth(100, 1000);
  h.recordTransientFailure("a", 0);
  assert.equal(h.blockedUntil("b"), 0);
});
