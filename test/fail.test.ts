import test from "node:test";
import assert from "node:assert/strict";
import { UserError, fail } from "../src/errors.js";
import { captureConsole } from "./helpers.js";

test("UserError は name と message を持つ Error", () => {
  const e = new UserError("boom");
  assert.ok(e instanceof Error);
  assert.equal(e.name, "UserError");
  assert.equal(e.message, "boom");
});

test("fail: UserError はメッセージだけを表示して exit(1)", (t) => {
  const out = captureConsole(t);
  const exit = t.mock.method(process, "exit", (() => {
    throw new Error("exit called");
  }) as never);
  assert.throws(() => fail(new UserError("設定が変です")), /exit called/);
  assert.equal(exit.mock.calls[0].arguments[0], 1);
  assert.match(out.error.join("\n"), /エラー: 設定が変です/);
  assert.ok(!out.error.join("\n").includes("at "), "スタックトレースを出さない");
});

test("fail: 想定外のエラーはエラーオブジェクトそのものを出力する", (t) => {
  const out = captureConsole(t);
  t.mock.method(process, "exit", (() => {
    throw new Error("exit called");
  }) as never);
  const err = new TypeError("unexpected");
  assert.throws(() => fail(err), /exit called/);
  assert.equal(out.error.length, 1);
  assert.equal(out.error[0], String(err));
});
