import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * OCR送信用に画像をリサイズする。
 * - 見開き1080p程度の画像はそのまま(縮小しない)
 * - 4000x6000のような大きい画像は長辺 maxDimension まで縮小
 * ノド(綴じ部分)のズレを踏まえ、分割は一切行わない。1画像=1リクエストの単位として扱う。
 */
export async function resizeForOcr(
  inputPath: string,
  outputPath: string,
  maxDimension: number,
): Promise<void> {
  mkdirSync(dirname(outputPath), { recursive: true });
  await sharp(inputPath)
    .rotate() // Exifの向き情報があれば正しい向きに補正
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 90 })
    .toFile(outputPath);
}
