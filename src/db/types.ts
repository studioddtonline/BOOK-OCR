export type QueueStatus = "pending" | "processing" | "error";
export type OcrLogOutcome = "success" | "rate_limited" | "config_error" | "server_error" | "error";

/** 閲覧・検索の対象となる画像1枚分のレコード。worker用の作業状態はここに持たせない。 */
export interface SourceImageRow {
  id: number;
  /** 本の名前などの人間向けラベル(列名は歴史的経緯で file_path のまま)。ingest --label で入る。未指定ならNULL。 */
  file_path: string | null;
  /** 取り込み時の元のファイル名。 */
  file_name: string | null;
  ocr_text: string | null;
  /**
   * 人間がレビュー(修正)済みかどうか。0 = 未レビュー、**0以外はすべてレビュー済み**として扱い、
   * worker は上書きしない(MCPサーバ等の外部ツールと同じ解釈)。判定は isReviewed() を使う。
   */
  reviewed: number;
}

/** worker が処理するOCR待ちの1件。完了すると消える。 */
export interface QueueRow {
  id: number;
  /** OCR結果の格納先(source_images.id)。 */
  source_image_id: number;
  /** AIに送る画像の実ファイルパス。 */
  image_path: string;
  status: QueueStatus;
  retry_count: number;
  error_message: string | null;
  created_at: string;
}

/**
 * reviewed が 0 以外なら「レビュー済み」。0/1以外の値(旧運用の -1 など)が入っていても、
 * 人間の本文を守る側に倒す(MCPサーバと同じ解釈)。この判定はここだけに置く。
 */
export function isReviewed(row: { reviewed: number }): boolean {
  return row.reviewed !== 0;
}
