import test from "node:test";
import assert from "node:assert/strict";
import { ProviderConfigError, RateLimitError, TransientServerError, toFailure } from "../src/providers/errors.js";

test("toFailure: 分類済みのエラーは対応する種類になる", () => {
  assert.deepEqual(toFailure(new RateLimitError("p", "429")), { kind: "rate_limited", message: "429" });
  assert.deepEqual(toFailure(new ProviderConfigError("p", "bad")), { kind: "config_error", message: "bad" });
  assert.deepEqual(toFailure(new TransientServerError("p", "down", 503)), { kind: "server_error", message: "down", status: 503 });
  assert.deepEqual(toFailure(new TransientServerError("p", "net")), { kind: "server_error", message: "net", status: undefined });
});

test("toFailure: それ以外は画像側の問題(image_error)。文字列などもメッセージにする", () => {
  assert.deepEqual(toFailure(new Error("テキストなし")), { kind: "image_error", message: "テキストなし" });
  assert.deepEqual(toFailure("文字列のエラー"), { kind: "image_error", message: "文字列のエラー" });
  assert.deepEqual(toFailure(undefined), { kind: "image_error", message: "undefined" });
});
