import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { UserError } from "../src/errors.js";
import { tmpDir } from "./helpers.js";

function base(): Record<string, unknown> {
  return {
    watchDir: "/w",
    workDir: "/k",
    dbPath: "/d.sqlite3",
    priority: ["a"],
    providers: [
      { name: "a", type: "gemini", model: "m1", dailyRequestLimit: 10, options: { temperature: 0.1 } },
      { name: "b", type: "openai", model: "m2", dailyRequestLimit: 5 },
    ],
  };
}

function write(t: import("node:test").TestContext, json: unknown): string {
  const p = join(tmpDir(t), "config.json");
  writeFileSync(p, typeof json === "string" ? json : JSON.stringify(json));
  return p;
}

function loadError(path: string): string {
  try {
    loadConfig(path);
  } catch (e) {
    assert.ok(e instanceof UserError, `UserError のはずが ${String(e)}`);
    return e.message;
  }
  assert.fail("エラーになるはず");
}

test("有効な設定を読み、既定値が入る", (t) => {
  const c = loadConfig(write(t, base()));
  assert.equal(c.watchDir, "/w");
  assert.equal(c.archiveDir, undefined);
  assert.equal(c.resize.maxDimension, 1800);
  assert.equal(c.pollIntervalMs, 30000);
  assert.equal(c.dbBusyTimeoutMs, 20000);
  assert.equal(c.usageTimeZone, "UTC");
  assert.deepEqual(c.priority, ["a"]);
  assert.deepEqual(c.providers[0].options, { temperature: 0.1 });
  assert.deepEqual(c.providers[1].options, {}, "options 省略時は空オブジェクト");
});

test("明示した値は既定値を上書きする", (t) => {
  const c = loadConfig(
    write(t, { ...base(), archiveDir: "/arc", resize: { maxDimension: 900 }, pollIntervalMs: 5, dbBusyTimeoutMs: 7 }),
  );
  assert.equal(c.archiveDir, "/arc");
  assert.equal(c.resize.maxDimension, 900);
  assert.equal(c.pollIntervalMs, 5);
  assert.equal(c.dbBusyTimeoutMs, 7);
});

test("CONFIG_PATH 環境変数が既定のパスになる", (t) => {
  const p = write(t, base());
  const old = process.env.CONFIG_PATH;
  process.env.CONFIG_PATH = p;
  t.after(() => {
    if (old === undefined) delete process.env.CONFIG_PATH;
    else process.env.CONFIG_PATH = old;
  });
  assert.equal(loadConfig().dbPath, "/d.sqlite3");
});

test("ファイルが無い場合は config.example.json への案内つきエラー", () => {
  const msg = loadError("/nonexistent/config.json");
  assert.match(msg, /設定ファイルを読み込めませんでした/);
  assert.match(msg, /config\.example\.json/);
});

test("JSONが壊れている場合のエラー", (t) => {
  assert.match(loadError(write(t, "{ not json")), /JSONが不正/);
});

test("必須キーが無い場合は、キーのパスつきで報告する", (t) => {
  const c = base();
  delete c.dbPath;
  assert.match(loadError(write(t, c)), /dbPath/);
});

test("priority が空配列・providers が空配列は不正", (t) => {
  assert.match(loadError(write(t, { ...base(), priority: [] })), /priority/);
  assert.match(loadError(write(t, { ...base(), providers: [] })), /providers/);
});

test("type が未知のベンダーなら不正", (t) => {
  const c = base();
  (c.providers as Record<string, unknown>[])[0].type = "cohere";
  assert.match(loadError(write(t, c)), /providers\.0\.type/);
});

test("providers の未知キーは拒否する(strict)", (t) => {
  const c = base();
  (c.providers as Record<string, unknown>[])[0].foo = 1;
  assert.match(loadError(write(t, c)), /providers/);
});

test("provider 直下の temperature(旧形式)は、未知のキーとして、キー名つきで拒否される", (t) => {
  const c = base();
  (c.providers as Record<string, unknown>[])[0].temperature = 0.3;
  const msg = loadError(write(t, c));
  assert.match(msg, /providers\.0/);
  assert.match(msg, /temperature/);
});

test("トップレベルの未知キー(typo)は拒否される", (t) => {
  const msg = loadError(write(t, { ...base(), pollIntervalMS: 5 }));
  assert.match(msg, /pollIntervalMS/);
});

test("resize の未知キーも拒否される", (t) => {
  assert.match(loadError(write(t, { ...base(), resize: { maxDimension: 10, quality: 5 } })), /resize/);
});

test("name の重複は不正", (t) => {
  const c = base();
  (c.providers as Record<string, unknown>[])[1].name = "a";
  assert.match(loadError(write(t, c)), /name が重複/);
});

test("priority に存在しない name があれば、定義済み name を示して不正", (t) => {
  const msg = loadError(write(t, { ...base(), priority: ["zzz"] }));
  assert.match(msg, /"zzz"/);
  assert.match(msg, /"a", "b"/);
});

test("priority の重複は不正", (t) => {
  assert.match(loadError(write(t, { ...base(), priority: ["a", "a"] })), /重複/);
});

test("providers に書いてあっても priority に無ければ使われない設定として通る", (t) => {
  const c = loadConfig(write(t, base()));
  assert.equal(c.providers.length, 2);
  assert.equal(c.priority.length, 1);
});

test("dailyRequestLimit は正の整数のみ", (t) => {
  const c = base();
  (c.providers as Record<string, unknown>[])[0].dailyRequestLimit = 0;
  assert.match(loadError(write(t, c)), /dailyRequestLimit/);
});

test("旧形式(providers の中に priority)は、設定として不正になる", (t) => {
  const old = {
    watchDir: "/w",
    workDir: "/k",
    dbPath: "/d",
    providers: { priority: ["gemini"], gemini: { model: "g", dailyRequestLimit: 10 } },
  };
  const msg = loadError(write(t, old));
  assert.match(msg, /priority/);
  assert.match(msg, /providers/);
});

test("usageTimeZone: 既定は UTC。IANA名を指定でき、不明な名前は拒否される", (t) => {
  assert.equal(loadConfig(write(t, base())).usageTimeZone, "UTC");
  assert.equal(loadConfig(write(t, { ...base(), usageTimeZone: "America/Los_Angeles" })).usageTimeZone, "America/Los_Angeles");
  assert.match(loadError(write(t, { ...base(), usageTimeZone: "Mars/Olympus" })), /usageTimeZone.*タイムゾーン/);
});

test("エラーメッセージには、不正な項目のパスが1行ずつ並ぶ", (t) => {
  const c = base();
  delete c.dbPath;
  delete c.watchDir;
  const msg = loadError(write(t, c));
  assert.match(msg, /- dbPath:/);
  assert.match(msg, /- watchDir:/);
});
