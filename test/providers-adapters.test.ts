import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderEntry } from "../src/config.js";
import type { ImageInput } from "../src/image-file.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { GeminiProvider } from "../src/providers/gemini.js";
import { OpenAiProvider } from "../src/providers/openai.js";
import { ProviderConfigError, RateLimitError, TransientServerError } from "../src/providers/errors.js";

const entry = (type: ProviderEntry["type"], options: Record<string, unknown> = {}): ProviderEntry => ({
  name: `${type}-x`,
  type,
  model: `${type}-model`,
  dailyRequestLimit: 7,
  options,
});

const IMG: ImageInput = { bytes: Buffer.from("abc"), mimeType: "image/webp" }; // base64 => YWJj

/** 偽のSDKクライアントを、アダプタのコンストラクタに直接渡す(ネットワークには出ない)。 */
const fake = (client: object) => client as never;

const geminiClient = (fn: (arg: any) => Promise<unknown>) => fake({ models: { generateContent: fn } });
const openAiClient = (fn: (arg: any) => Promise<unknown>) => fake({ chat: { completions: { create: fn } } });
const anthropicClient = (fn: (arg: any) => Promise<unknown>) => fake({ messages: { create: fn } });

// ---- Gemini --------------------------------------------------------------

test("Gemini: メタ情報がエントリから引き継がれる", () => {
  const p = new GeminiProvider(entry("gemini", { temperature: 0.2 }), fake({}));
  assert.equal(p.type, "gemini");
  assert.equal(p.name, "gemini-x");
  assert.equal(p.model, "gemini-model");
  assert.equal(p.dailyRequestLimit, 7);
  assert.deepEqual(p.options, { temperature: 0.2 });
});

test("Gemini: モデル・options(config)・画像(base64)・プロンプトを渡し、テキストを返す", async () => {
  let seen: any;
  const p = new GeminiProvider(
    entry("gemini", { temperature: 0.1, thinkingConfig: { thinkingBudget: 0 } }),
    geminiClient(async (a) => ((seen = a), { text: "結果" })),
  );
  const r = await p.callOcr(IMG, "PROMPT");
  assert.equal(r.text, "結果");
  assert.equal(seen.model, "gemini-model");
  assert.deepEqual(seen.config, { temperature: 0.1, thinkingConfig: { thinkingBudget: 0 } });
  const content = Array.isArray(seen.contents) ? seen.contents[0] : seen.contents;
  const parts = content.parts;
  assert.equal(parts[0].text, "PROMPT");
  assert.equal(parts[1].inlineData.data, "YWJj");
  assert.equal(parts[1].inlineData.mimeType, "image/webp");
});

test("Gemini: 画像のMIMEタイプは、渡された画像のものを使う(再OCRの元画像=jpeg等)", async () => {
  let seen: any;
  const p = new GeminiProvider(entry("gemini"), geminiClient(async (a) => ((seen = a), { text: "x" })));
  await p.callOcr({ bytes: Buffer.from("abc"), mimeType: "image/jpeg" }, "P");
  const content = Array.isArray(seen.contents) ? seen.contents[0] : seen.contents;
  assert.equal(content.parts[1].inlineData.mimeType, "image/jpeg");
});

test("Gemini: options が空でも config は空オブジェクトで送る(書いたものだけ送る)", async () => {
  let seen: any;
  const p = new GeminiProvider(entry("gemini"), geminiClient(async (a) => ((seen = a), { text: "x" })));
  await p.callOcr(IMG, "P");
  assert.deepEqual(seen.config, {});
});

test("Gemini: テキストが無い応答(安全フィルタ等)は、分類されない通常のErrorになる(画像側の問題)", async () => {
  const p = new GeminiProvider(entry("gemini"), geminiClient(async () => ({ text: undefined, promptFeedback: { blockReason: "SAFETY" } })));
  await assert.rejects(p.callOcr(IMG, "P"), (e: unknown) => {
    assert.ok(e instanceof Error);
    assert.ok(!(e instanceof RateLimitError || e instanceof ProviderConfigError || e instanceof TransientServerError));
    assert.match(e.message, /Gemini/);
    assert.match(e.message, /SAFETY/);
    return true;
  });
});

test("Gemini: SDKの429/404/503 が型つきエラーに分類される(provider名つき)", async () => {
  for (const [status, cls] of [
    [429, RateLimitError],
    [404, ProviderConfigError],
    [503, TransientServerError],
  ] as const) {
    const p = new GeminiProvider(
      entry("gemini"),
      geminiClient(async () => {
        throw Object.assign(new Error("e"), { status });
      }),
    );
    await assert.rejects(p.callOcr(IMG, "P"), (e: unknown) => e instanceof cls && (e as { provider: string }).provider === "gemini-x", String(status));
  }
});

// ---- OpenAI --------------------------------------------------------------

test("OpenAI: options を展開し、model と messages は上書きさせない", async () => {
  let seen: any;
  const p = new OpenAiProvider(
    entry("openai", { model: "evil", messages: [], max_completion_tokens: 100 }),
    openAiClient(async (a) => ((seen = a), { choices: [{ message: { content: "テキスト" } }] })),
  );
  const r = await p.callOcr(IMG, "PROMPT");
  assert.equal(r.text, "テキスト");
  assert.equal(seen.model, "openai-model");
  assert.equal(seen.max_completion_tokens, 100);
  assert.equal(seen.messages.length, 1);
  const content = seen.messages[0].content;
  assert.deepEqual(content[0], { type: "text", text: "PROMPT" });
  assert.equal(content[1].image_url.url, "data:image/webp;base64,YWJj");
});

test("OpenAI: data URL には画像のMIMEタイプが入る", async () => {
  let seen: any;
  const p = new OpenAiProvider(entry("openai"), openAiClient(async (a) => ((seen = a), { choices: [{ message: { content: "x" } }] })));
  await p.callOcr({ bytes: Buffer.from("abc"), mimeType: "image/png" }, "P");
  assert.equal(seen.messages[0].content[1].image_url.url, "data:image/png;base64,YWJj");
});

test("OpenAI: 空の応答は通常のErrorになる", async () => {
  const empty = new OpenAiProvider(entry("openai"), openAiClient(async () => ({ choices: [{ message: { content: "" } }] })));
  await assert.rejects(empty.callOcr(IMG, "P"), /OpenAI/);
  const none = new OpenAiProvider(entry("openai"), openAiClient(async () => ({ choices: [] })));
  await assert.rejects(none.callOcr(IMG, "P"), /OpenAI/);
});

test("OpenAI: SDKエラーが分類される", async () => {
  const p = new OpenAiProvider(
    entry("openai"),
    openAiClient(async () => {
      throw Object.assign(new Error("bad temperature"), { status: 400 });
    }),
  );
  await assert.rejects(p.callOcr(IMG, "P"), (e) => e instanceof ProviderConfigError);
});

// ---- Anthropic -----------------------------------------------------------

test("Anthropic: max_tokens の既定は4096で、options で上書きできる", async () => {
  const seen: any[] = [];
  const mk = (options: Record<string, unknown>) =>
    new AnthropicProvider(entry("anthropic", options), anthropicClient(async (a) => (seen.push(a), { content: [{ type: "text", text: "T" }] })));
  await mk({}).callOcr(IMG, "P");
  await mk({ max_tokens: 100, temperature: 0.1 }).callOcr(IMG, "P");
  assert.equal(seen[0].max_tokens, 4096);
  assert.equal(seen[1].max_tokens, 100);
  assert.equal(seen[1].temperature, 0.1);
});

test("Anthropic: model と messages は options で上書きさせず、画像→テキストの順で送る", async () => {
  let seen: any;
  const p = new AnthropicProvider(
    entry("anthropic", { model: "evil", messages: [] }),
    anthropicClient(async (a) => ((seen = a), { content: [{ type: "text", text: "T" }] })),
  );
  await p.callOcr(IMG, "PROMPT");
  assert.equal(seen.model, "anthropic-model");
  const c = seen.messages[0].content;
  assert.deepEqual(c[0], { type: "image", source: { type: "base64", media_type: "image/webp", data: "YWJj" } });
  assert.deepEqual(c[1], { type: "text", text: "PROMPT" });
});

test("Anthropic: 最初のテキストブロックを返す。無ければ通常のError", async () => {
  const ok = new AnthropicProvider(entry("anthropic"), anthropicClient(async () => ({ content: [{ type: "thinking" }, { type: "text", text: "本文" }] })));
  assert.equal((await ok.callOcr(IMG, "P")).text, "本文");
  const none = new AnthropicProvider(entry("anthropic"), anthropicClient(async () => ({ content: [] })));
  await assert.rejects(none.callOcr(IMG, "P"), /Claude/);
});

test("Anthropic: SDKエラーが分類される(529 は 5xx なので一時エラー)", async () => {
  const p = new AnthropicProvider(
    entry("anthropic"),
    anthropicClient(async () => {
      throw Object.assign(new Error("overloaded"), { status: 529 });
    }),
  );
  await assert.rejects(p.callOcr(IMG, "P"), (e) => e instanceof TransientServerError);
});

// ---- 共通(BaseProvider) --------------------------------------------------

test("共通: 3つのアダプタとも、分類済みエラーはそのまま再スローされる", async () => {
  const err = new RateLimitError("pre", "x");
  const boom = async () => {
    throw err;
  };
  for (const p of [
    new GeminiProvider(entry("gemini"), geminiClient(boom)),
    new OpenAiProvider(entry("openai"), openAiClient(boom)),
    new AnthropicProvider(entry("anthropic"), anthropicClient(boom)),
  ]) {
    await assert.rejects(p.callOcr(IMG, "P"), (e) => e === err);
  }
});
