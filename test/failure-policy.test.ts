import test from "node:test";
import assert from "node:assert/strict";
import { decideQueueFailure } from "../src/worker/failure-policy.js";
import type { FailureKind } from "../src/providers/errors.js";

test("rate_limited / config_error / server_error は失敗回数を増やさず、pending に戻す", () => {
  for (const [kind, outcome] of [
    ["rate_limited", "rate_limited"],
    ["config_error", "config_error"],
    ["server_error", "server_error"],
  ] as const) {
    // retry_count や上限に関係なく同じ
    for (const retry of [0, 4, 100]) {
      assert.deepEqual(decideQueueFailure(kind, retry, 5), { outcome, countRetry: false, permanent: false }, `${kind}/${retry}`);
    }
  }
});

test("image_error は失敗回数を増やし、上限に達したら permanent", () => {
  assert.deepEqual(decideQueueFailure("image_error", 0, 5), { outcome: "error", countRetry: true, permanent: false });
  assert.deepEqual(decideQueueFailure("image_error", 3, 5), { outcome: "error", countRetry: true, permanent: false });
  assert.deepEqual(decideQueueFailure("image_error", 4, 5), { outcome: "error", countRetry: true, permanent: true }, "今回が5回目");
  assert.deepEqual(decideQueueFailure("image_error", 9, 5), { outcome: "error", countRetry: true, permanent: true });
});

test("image_error: 上限1なら最初の失敗で permanent", () => {
  assert.equal(decideQueueFailure("image_error", 0, 1).permanent, true);
});

test("全ての失敗の種類に対して決定が返る(網羅)", () => {
  const kinds: FailureKind[] = ["rate_limited", "config_error", "server_error", "image_error"];
  for (const k of kinds) assert.ok(decideQueueFailure(k, 0, 5).outcome);
});
