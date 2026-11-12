import test from "node:test";
import assert from "node:assert/strict";
import type { AppConfig } from "../src/config.js";
import { UserError } from "../src/errors.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { GeminiProvider } from "../src/providers/gemini.js";
import { OpenAiProvider } from "../src/providers/openai.js";
import { apiKeyEnvName, buildProviders } from "../src/providers/registry.js";

function cfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    watchDir: "/w",
    workDir: "/k",
    dbPath: "/d",
    resize: { maxDimension: 1800 },
    priority: ["g1", "o1", "c1"],
    providers: [
      { name: "g1", type: "gemini", model: "gm", dailyRequestLimit: 10, options: { temperature: 0.1 } },
      { name: "o1", type: "openai", model: "om", dailyRequestLimit: 20, options: {} },
      { name: "c1", type: "anthropic", model: "cm", dailyRequestLimit: 30, options: {} },
    ],
    pollIntervalMs: 1,
    dbBusyTimeoutMs: 1,
    usageTimeZone: "UTC",
    ...over,
  };
}

const ALL_KEYS = { GEMINI_API_KEY: "k1", OPENAI_API_KEY: "k2", ANTHROPIC_API_KEY: "k3" };

test("buildProviders: priority の順に、typeに応じたアダプタを作る", () => {
  const ps = buildProviders(cfg(), ALL_KEYS);
  assert.deepEqual(ps.map((p) => p.name), ["g1", "o1", "c1"]);
  assert.ok(ps[0] instanceof GeminiProvider);
  assert.ok(ps[1] instanceof OpenAiProvider);
  assert.ok(ps[2] instanceof AnthropicProvider);
  assert.equal(ps[0].model, "gm");
  assert.equal(ps[0].dailyRequestLimit, 10);
  assert.deepEqual(ps[0].options, { temperature: 0.1 });
});

test("buildProviders: priority の順序がそのまま反映される", () => {
  const ps = buildProviders(cfg({ priority: ["c1", "g1"] }), ALL_KEYS);
  assert.deepEqual(ps.map((p) => p.name), ["c1", "g1"]);
});

test("buildProviders: priority に無いプロバイダは作らず、そのAPIキーも要求しない", () => {
  const ps = buildProviders(cfg({ priority: ["g1"] }), { GEMINI_API_KEY: "k1" });
  assert.deepEqual(ps.map((p) => p.name), ["g1"]);
});

test("buildProviders: 同じ type のエントリを複数並べられる", () => {
  const c = cfg({
    priority: ["a", "b"],
    providers: [
      { name: "a", type: "gemini", model: "m1", dailyRequestLimit: 1, options: {} },
      { name: "b", type: "gemini", model: "m2", dailyRequestLimit: 2, options: {} },
    ],
  });
  assert.deepEqual(buildProviders(c, { GEMINI_API_KEY: "k" }).map((p) => p.model), ["m1", "m2"]);
});

test("buildProviders: APIキーが無ければ、環境変数名つきの UserError", () => {
  assert.throws(
    () => buildProviders(cfg({ priority: ["g1"] }), {}),
    (e: unknown) => e instanceof UserError && e.message.includes("GEMINI_API_KEY") && e.message.includes("g1"),
  );
});

test("buildProviders: priority に対応する providers が無ければ UserError", () => {
  assert.throws(() => buildProviders(cfg({ priority: ["nope"] }), ALL_KEYS), (e: unknown) => e instanceof UserError && e.message.includes("nope"));
});

test("buildProviders: 既定では process.env を使う", (t) => {
  const old = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "from-process-env";
  t.after(() => {
    if (old === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = old;
  });
  assert.equal(buildProviders(cfg({ priority: ["g1"] })).length, 1);
});

test("apiKeyEnvName: ベンダーごとの環境変数名", () => {
  assert.equal(apiKeyEnvName("gemini"), "GEMINI_API_KEY");
  assert.equal(apiKeyEnvName("openai"), "OPENAI_API_KEY");
  assert.equal(apiKeyEnvName("anthropic"), "ANTHROPIC_API_KEY");
});
