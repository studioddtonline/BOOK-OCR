import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { getSourceImage, isReviewed, type QueueRow } from "../db/index.js";

export type PreflightResult =
  | { ok: true }
  /** orphan=true は、格納先の行が無く、ocr_log にも(外部キーのため)記録できない場合。 */
  | { ok: false; message: string; orphan?: boolean };

/**
 * APIを呼ぶ前の確認。ここで弾けば、無料枠のリクエストを消費しない。
 * レビュー済み(reviewed が 0 以外。-1 や 2 でも)は、MCPサーバと同じ解釈で守る。
 */
export function preflight(db: DatabaseSync, item: QueueRow): PreflightResult {
  const src = getSourceImage(db, item.source_image_id);
  if (!src) {
    return { ok: false, orphan: true, message: `OCR結果の格納先(source_images.id=${item.source_image_id})が存在しません。` };
  }
  if (isReviewed(src)) {
    return {
      ok: false,
      message:
        `reviewed=${src.reviewed}(0以外 = レビュー済み)のため、OCRしませんでした(APIは使っていません)。` +
        "再OCRしたい場合は、source_images.reviewed を 0 に戻した上で、`queue retry` でこの行を pending に戻してください。",
    };
  }
  if (!existsSync(item.image_path)) {
    return {
      ok: false,
      message:
        `画像ファイルが見つかりません: ${item.image_path}\n` +
        "ファイルを用意した上で、`queue retry` でこの行を pending に戻してください(パスが違う場合は `requeue --force` で差し替えられます)。",
    };
  }
  return { ok: true };
}
