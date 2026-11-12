import type { ProviderEntry, ProviderType } from "../config.js";
import type { ImageInput } from "../image-file.js";
import { classifyProviderError } from "./errors.js";
import type { OcrCallResult, OcrProvider } from "./types.js";

/**
 * ベンダーごとのアダプタの共通部分。サブクラスは「リクエストを組んで送る」と
 * 「応答からテキストを取り出す」だけを request() に書く。
 * SDKが投げた例外は callOcr() がまとめて分類する。
 */
export abstract class BaseProvider<TClient> implements OcrProvider {
  abstract readonly type: ProviderType;
  readonly name: string;
  readonly model: string;
  readonly dailyRequestLimit: number;
  readonly options: Readonly<Record<string, unknown>>;

  protected constructor(
    entry: ProviderEntry,
    protected readonly client: TClient,
  ) {
    this.name = entry.name;
    this.model = entry.model;
    this.dailyRequestLimit = entry.dailyRequestLimit;
    this.options = entry.options;
  }

  async callOcr(image: ImageInput, prompt: string): Promise<OcrCallResult> {
    try {
      return await this.request(image, prompt);
    } catch (err) {
      throw classifyProviderError(this.name, err);
    }
  }

  protected abstract request(image: ImageInput, prompt: string): Promise<OcrCallResult>;
}
