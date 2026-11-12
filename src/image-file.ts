import { readFileSync } from "node:fs";
import { extname } from "node:path";

/** AIに送る画像(ファイルから1回だけ読んで、各プロバイダに渡す)。 */
export interface ImageInput {
  bytes: Buffer;
  mimeType: string;
}

const MIME_BY_EXT: Record<string, string> = {
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

/** 拡張子からMIMEタイプを決める。再OCRでは元画像(jpg/png)がそのまま渡されることがあるため。 */
export function mimeTypeForPath(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "image/webp";
}

export function readImageFile(path: string): ImageInput {
  return { bytes: readFileSync(path), mimeType: mimeTypeForPath(path) };
}
