import { GoogleGenAI, createPartFromBase64, createUserContent, type GenerateContentConfig } from "@google/genai";
import type { ProviderEntry } from "../config.js";
import type { ImageInput } from "../image-file.js";
import { BaseProvider } from "./base.js";
import type { OcrCallResult } from "./types.js";

export class GeminiProvider extends BaseProvider<GoogleGenAI> {
  readonly type = "gemini" as const;

  constructor(entry: ProviderEntry, client: GoogleGenAI) {
    super(entry, client);
  }

  protected async request(image: ImageInput, prompt: string): Promise<OcrCallResult> {
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: createUserContent([prompt, createPartFromBase64(image.bytes.toString("base64"), image.mimeType)]),
      // モデル固有のオプション(temperature, thinkingConfig 等)は、設定ファイルに
      // 書かれたものだけを、そのまま渡す。コード側でモデルごとの分岐はしない。
      config: { ...this.options } as GenerateContentConfig,
    });

    const text = response.text;
    if (text === undefined) {
      throw new Error(`Geminiからテキストが返りませんでした(safety filter等の可能性): ${JSON.stringify(response.promptFeedback)}`);
    }
    return { text, raw: response };
  }
}
