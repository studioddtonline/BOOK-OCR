import test from "node:test";
import assert from "node:assert/strict";
import {
  ProviderConfigError,
  RateLimitError,
  TransientServerError,
  classifyProviderError,
  isConfigErrorStatus,
  isTransientStatus,
} from "../src/providers/errors.js";

const withStatus = (status: number, message = "x") => Object.assign(new Error(message), { status });

test("isConfigErrorStatus: 400/401/403/404 だけ", () => {
  for (const s of [400, 401, 403, 404]) assert.equal(isConfigErrorStatus(s), true, String(s));
  for (const s of [200, 402, 408, 429, 500, undefined]) assert.equal(isConfigErrorStatus(s), false, String(s));
});

test("isTransientStatus: 408 と 5xx", () => {
  for (const s of [408, 500, 502, 503, 504, 599]) assert.equal(isTransientStatus(s), true, String(s));
  for (const s of [400, 404, 429, 600, undefined]) assert.equal(isTransientStatus(s), false, String(s));
});

test("429 は RateLimitError(provider名つき)", () => {
  const e = classifyProviderError("g", withStatus(429, "too many"));
  assert.ok(e instanceof RateLimitError);
  assert.equal((e as RateLimitError).provider, "g");
  assert.equal((e as RateLimitError).message, "too many");
});

test("ステータスが無くても RESOURCE_EXHAUSTED / rate limit の文言なら RateLimitError", () => {
  assert.ok(classifyProviderError("g", new Error("RESOURCE_EXHAUSTED: quota")) instanceof RateLimitError);
  assert.ok(classifyProviderError("g", new Error("You hit the Rate Limit")) instanceof RateLimitError);
});

test("400/401/403/404 は ProviderConfigError", () => {
  for (const s of [400, 401, 403, 404]) {
    assert.ok(classifyProviderError("g", withStatus(s)) instanceof ProviderConfigError, String(s));
  }
});

test("5xx と 408 は TransientServerError(ステータスを保持)", () => {
  for (const s of [408, 500, 503]) {
    const e = classifyProviderError("g", withStatus(s));
    assert.ok(e instanceof TransientServerError, String(s));
    assert.equal((e as TransientServerError).status, s);
  }
});

test("ネットワークエラー(code / name / メッセージ)は TransientServerError", () => {
  assert.ok(classifyProviderError("g", Object.assign(new Error("x"), { code: "ECONNRESET" })) instanceof TransientServerError);
  assert.ok(classifyProviderError("g", Object.assign(new Error("x"), { cause: { code: "ETIMEDOUT" } })) instanceof TransientServerError);
  assert.ok(classifyProviderError("g", Object.assign(new Error("x"), { name: "APIConnectionError" })) instanceof TransientServerError);
  assert.ok(classifyProviderError("g", Object.assign(new Error("x"), { name: "AbortError" })) instanceof TransientServerError);
  assert.ok(classifyProviderError("g", new TypeError("fetch failed")) instanceof TransientServerError);
  assert.ok(classifyProviderError("g", new Error("request timed out")) instanceof TransientServerError);
});

test("HTTPステータスが付いているエラーはネットワーク判定より優先して扱う", () => {
  // 418 はどの分類にも当たらず、メッセージに timeout があってもネットワーク扱いにしない
  const e = withStatus(418, "timeout teapot");
  assert.equal(classifyProviderError("g", e), e);
});

test("どれにも当たらないものは元のエラーをそのまま返す(=画像側の問題)", () => {
  const e = new Error("Geminiからテキストが返りませんでした");
  assert.equal(classifyProviderError("g", e), e);
  assert.equal(classifyProviderError("g", "文字列"), "文字列");
});

test("分類済みのエラーは再分類しない(同一オブジェクトを返す)", () => {
  for (const e of [new RateLimitError("g", "a"), new ProviderConfigError("g", "b"), new TransientServerError("g", "c")]) {
    assert.equal(classifyProviderError("other", e), e);
  }
});

test("429 は 5xx 判定より前(ステータスと文言で判定が割れない)", () => {
  assert.ok(classifyProviderError("g", withStatus(429, "server overloaded")) instanceof RateLimitError);
});
