import type Anthropic from "@anthropic-ai/sdk";
import type { ProviderEntry } from "../config.js";
import type { ImageInput } from "../image-file.js";
import { BaseProvider } from "./base.js";
import type { OcrCallResult } from "./types.js";

/** 注意: ClaudeのtemperatureはOpenAI/Geminiと異なり 0.0〜1.0 の範囲(2.0ではない)。 */
export class AnthropicProvider extends BaseProvider<Anthropic> {
  readonly type = "anthropic" as const;

  constructor(entry: ProviderEntry, client: Anthropic) {
    super(entry, client);
  }

  protected async request(image: ImageInput, prompt: string): Promise<OcrCallResult> {
    // max_tokens は必須項目なので既定値を置き、options で上書きできるようにする。
    // model と messages は設定ファイルで上書きされないよう、options の後に置く。
    const response = await this.client.messages.create({
      max_tokens: 4096,
      ...this.options,
      model: this.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.bytes.toString("base64") } },
            { type: "text", text: prompt },
          ],
        },
      ],
    } as Anthropic.MessageCreateParamsNonStreaming);

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error(`Claudeからテキストが返りませんでした: ${JSON.stringify(response)}`);
    }
    return { text: textBlock.text, raw: response };
  }
}
