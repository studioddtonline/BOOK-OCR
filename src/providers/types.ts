import type { ProviderType } from "../config.js";
import type { ImageInput } from "../image-file.js";

export interface OcrCallResult {
  text: string;
  raw: unknown;
}

export interface OcrProvider {
  /** config.json の providers[].name。priority・使用量の記録・ログではこの名前を使う。 */
  readonly name: string;
  readonly type: ProviderType;
  readonly model: string;
  readonly dailyRequestLimit: number;
  /** SDKのリクエスト設定にそのまま流し込む、モデル固有のオプション。 */
  readonly options: Readonly<Record<string, unknown>>;
  /** 失敗時は、分類済みのエラー(errors.ts)か、画像側の問題を表す通常のErrorを投げる。 */
  callOcr(image: ImageInput, prompt: string): Promise<OcrCallResult>;
}
