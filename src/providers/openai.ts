import type OpenAI from "openai";
import type { ProviderEntry } from "../config.js";
import type { ImageInput } from "../image-file.js";
import { BaseProvider } from "./base.js";
import type { OcrCallResult } from "./types.js";

/**
 * 注意: OpenAIのgpt-5系(推論モデル)は temperature を受け付けず、既定値(1)以外を
 * 送ると400エラーになることが報告されている。このアダプタは options に書かれた
 * ものだけを送るので、そのようなモデルでは options に temperature を書かなければよい。
 * 書いてしまった場合は400 → ProviderConfigError として検出され、OpenAI側のメッセージが
 * そのまま表示される。
 */
export class OpenAiProvider extends BaseProvider<OpenAI> {
  readonly type = "openai" as const;

  constructor(entry: ProviderEntry, client: OpenAI) {
    super(entry, client);
  }

  protected async request(image: ImageInput, prompt: string): Promise<OcrCallResult> {
    const dataUrl = `data:${image.mimeType};base64,${image.bytes.toString("base64")}`;

    // options を先に展開し、model と messages は設定ファイルで上書きされないようにする。
    const response = await this.client.chat.completions.create({
      ...this.options,
      model: this.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);

    const text = response.choices[0]?.message?.content;
    if (!text) {
      throw new Error(`OpenAIからテキストが返りませんでした: ${JSON.stringify(response)}`);
    }
    return { text, raw: response };
  }
}
