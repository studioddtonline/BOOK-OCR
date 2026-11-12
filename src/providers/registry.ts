import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import type { AppConfig, ProviderEntry, ProviderType } from "../config.js";
import { UserError } from "../errors.js";
import { AnthropicProvider } from "./anthropic.js";
import { GeminiProvider } from "./gemini.js";
import { OpenAiProvider } from "./openai.js";
import type { OcrProvider } from "./types.js";

interface VendorSpec {
  /** APIキーを読む環境変数名。APIキーはベンダー(type)単位で、同じtypeのエントリは同じキーを使う。 */
  envKey: string;
  create(entry: ProviderEntry, apiKey: string): OcrProvider;
}

/** ベンダーを追加するときは、アダプタを1つ書いて、ここに1行足す(config.ts の PROVIDER_TYPES にも追加)。 */
const VENDORS: Record<ProviderType, VendorSpec> = {
  gemini: { envKey: "GEMINI_API_KEY", create: (e, apiKey) => new GeminiProvider(e, new GoogleGenAI({ apiKey })) },
  openai: { envKey: "OPENAI_API_KEY", create: (e, apiKey) => new OpenAiProvider(e, new OpenAI({ apiKey })) },
  anthropic: { envKey: "ANTHROPIC_API_KEY", create: (e, apiKey) => new AnthropicProvider(e, new Anthropic({ apiKey })) },
};

export function apiKeyEnvName(type: ProviderType): string {
  return VENDORS[type].envKey;
}

/** config.priority に挙がっているエントリだけをアダプタとして生成する(優先順)。 */
export function buildProviders(config: AppConfig, env: NodeJS.ProcessEnv = process.env): OcrProvider[] {
  return config.priority.map((name) => {
    const entry = config.providers.find((p) => p.name === name);
    if (!entry) throw new UserError(`priority の "${name}" に対応する providers エントリがありません。`);

    const vendor = VENDORS[entry.type];
    const apiKey = env[vendor.envKey];
    if (!apiKey) {
      throw new UserError(`${vendor.envKey} が .env に設定されていません(provider "${entry.name}" は type="${entry.type}" です)。`);
    }
    return vendor.create(entry, apiKey);
  });
}
