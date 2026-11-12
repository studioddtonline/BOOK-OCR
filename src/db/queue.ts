import type { DatabaseSync } from "node:sqlite";
import { insertOcrLog } from "./ocr-log.js";
import { inTransaction } from "./tx.js";
import { isReviewed, type OcrLogOutcome, type QueueRow, type QueueStatus, type SourceImageRow } from "./types.js";

export function insertQueueItem(db: DatabaseSync, params: { sourceImageId: number; imagePath: string }): void {
  db.prepare(`INSERT INTO ocr_queue (source_image_id, image_path) VALUES (?, ?)`).run(params.sourceImageId, params.imagePath);
}

export function hasPendingQueueItems(db: DatabaseSync): boolean {
  return db.prepare(`SELECT 1 FROM ocr_queue WHERE status = 'pending' LIMIT 1`).get() !== undefined;
}

/** 前回の worker が強制終了されて 'processing' のまま残った行を、'pending' に戻す。 */
export function resetProcessingToPending(db: DatabaseSync): number {
  const r = db.prepare(`UPDATE ocr_queue SET status = 'pending' WHERE status = 'processing'`).run();
  return Number(r.changes);
}

export function getQueueSummary(db: DatabaseSync): Record<QueueStatus, number> {
  const rows = db.prepare(`SELECT status, COUNT(*) c FROM ocr_queue GROUP BY status`).all() as { status: string; c: number }[];
  const summary: Record<QueueStatus, number> = { pending: 0, processing: 0, error: 0 };
  for (const r of rows) {
    if (r.status in summary) summary[r.status as QueueStatus] = r.c;
  }
  return summary;
}

export function listQueueItems(db: DatabaseSync, params: { status?: QueueStatus; limit?: number } = {}): QueueRow[] {
  const limit = params.limit ?? 20;
  if (params.status) {
    return db.prepare(`SELECT * FROM ocr_queue WHERE status = ? ORDER BY id LIMIT ?`).all(params.status, limit) as unknown as QueueRow[];
  }
  return db.prepare(`SELECT * FROM ocr_queue ORDER BY id LIMIT ?`).all(limit) as unknown as QueueRow[];
}

export function listErrorQueueItems(db: DatabaseSync, limit = 20): QueueRow[] {
  return listQueueItems(db, { status: "error", limit });
}

export function getQueueItemBySourceImage(db: DatabaseSync, sourceImageId: number): QueueRow | undefined {
  return db.prepare(`SELECT * FROM ocr_queue WHERE source_image_id = ?`).get(sourceImageId) as QueueRow | undefined;
}

export function claimNextQueueItem(db: DatabaseSync): QueueRow | undefined {
  return inTransaction(db, () => {
    const row = db.prepare(`SELECT * FROM ocr_queue WHERE status = 'pending' ORDER BY id LIMIT 1`).get() as QueueRow | undefined;
    if (!row) return undefined;
    db.prepare(`UPDATE ocr_queue SET status = 'processing' WHERE id = ?`).run(row.id);
    return { ...row, status: "processing" as const };
  });
}

/** OCR試行の記録に添える、再現性のためのメタ情報。 */
export interface AttemptMeta {
  provider: string | null;
  model: string | null;
  promptHash?: string | null;
  requestOptions?: string | null;
}

export interface OcrSavePayload extends AttemptMeta {
  ocrText: string;
  provider: string;
  model: string;
  rawResponse: string;
}

export type CompleteResult = "saved" | "reviewed" | "missing";

/**
 * OCR成功結果を保存する。1トランザクションで、
 * source_images.ocr_text の更新 → キューの行の削除 → ocr_log への記録 を行う。
 *
 * レビュー済み(reviewed が 0 以外)の行は上書きしない。人間が直した ocr_text は
 * source_images の中にしか存在せず、上書きすると取り戻せないため。
 * 判定は UPDATE の WHERE 句(reviewed = 0)で行うので、チェックと更新の間に
 * 他のプロセス(MCPサーバ等)が reviewed を立てても、人間の本文は上書きされない。
 * その場合は AI の出力を ocr_log にだけ残し、キューの行は理由付きの 'error' にして残す。
 */
export function completeQueueItem(db: DatabaseSync, item: QueueRow, p: OcrSavePayload): CompleteResult {
  return inTransaction(db, (): CompleteResult => {
    const log = {
      sourceImageId: item.source_image_id,
      provider: p.provider,
      model: p.model,
      outcome: "success" as const,
      ocrText: p.ocrText,
      rawResponse: p.rawResponse,
      promptHash: p.promptHash,
      requestOptions: p.requestOptions,
    };

    const updated = db.prepare(`UPDATE source_images SET ocr_text = ? WHERE id = ? AND reviewed = 0`).run(p.ocrText, item.source_image_id);
    if (Number(updated.changes) === 1) {
      db.prepare(`DELETE FROM ocr_queue WHERE id = ?`).run(item.id);
      insertOcrLog(db, log);
      return "saved";
    }

    // 更新されなかった = 行が無いか、レビュー済み
    const src = db.prepare(`SELECT reviewed FROM source_images WHERE id = ?`).get(item.source_image_id) as
      | Pick<SourceImageRow, "reviewed">
      | undefined;

    if (!src) {
      db.prepare(`DELETE FROM ocr_queue WHERE id = ?`).run(item.id);
      return "missing";
    }

    const message =
      `reviewed=${src.reviewed}(0以外 = レビュー済み)のため ocr_text を上書きしませんでした。AIの出力は ocr_log に残してあります。` +
      "再OCRの結果で上書きしたい場合は、source_images.reviewed を 0 に戻した上で、" +
      "`queue retry` でこの行を pending に戻してください。";
    insertOcrLog(db, { ...log, errorMessage: message });
    db.prepare(`UPDATE ocr_queue SET status = 'error', error_message = ? WHERE id = ?`).run(message, item.id);
    return "reviewed";
  });
}

export interface FailParams extends AttemptMeta {
  outcome: OcrLogOutcome;
  message: string;
  /** 失敗回数(retry_count)を増やすか。画像側の問題だけ true。 */
  countRetry: boolean;
  /** true なら status='error' で残す(人間の確認待ち)。false なら 'pending' に戻す。 */
  permanent: boolean;
  httpStatus?: number | null;
}

/** OCRに失敗した(または処理を始められなかった)キューの行を更新し、ocr_log に記録する。 */
export function failQueueItem(db: DatabaseSync, item: QueueRow, p: FailParams): void {
  inTransaction(db, () => {
    db.prepare(`UPDATE ocr_queue SET status = ?, retry_count = retry_count + ?, error_message = ? WHERE id = ?`).run(
      p.permanent ? "error" : "pending",
      p.countRetry ? 1 : 0,
      p.message,
      item.id,
    );
    insertOcrLog(db, {
      sourceImageId: item.source_image_id,
      provider: p.provider,
      model: p.model,
      outcome: p.outcome,
      httpStatus: p.httpStatus,
      errorMessage: p.message,
      promptHash: p.promptHash,
      requestOptions: p.requestOptions,
    });
  });
}

/**
 * ocr_log に残せない場合(格納先の source_images が無く、外部キーで記録できない)に、
 * キューの行だけを理由つきの 'error' にする。
 */
export function markQueueItemError(db: DatabaseSync, item: QueueRow, message: string): void {
  db.prepare(`UPDATE ocr_queue SET status = 'error', error_message = ? WHERE id = ?`).run(message, item.id);
}

// ---------------------------------------------------------------------------
// 人間の操作(CLI の queue / requeue から使う)
// ---------------------------------------------------------------------------

export interface RetryResult {
  retried: number[];
  notFound: number[];
  /** error 以外の行(pending / processing)は触らない。 */
  skipped: { id: number; status: QueueStatus }[];
}

/** error の行を pending に戻し、失敗回数をリセットする。 */
export function retryQueueItems(db: DatabaseSync, ids: number[]): RetryResult {
  const result: RetryResult = { retried: [], notFound: [], skipped: [] };
  inTransaction(db, () => {
    for (const id of ids) {
      const row = db.prepare(`SELECT status FROM ocr_queue WHERE id = ?`).get(id) as { status: QueueStatus } | undefined;
      if (!row) result.notFound.push(id);
      else if (row.status !== "error") result.skipped.push({ id, status: row.status });
      else {
        db.prepare(`UPDATE ocr_queue SET status = 'pending', retry_count = 0, error_message = NULL WHERE id = ?`).run(id);
        result.retried.push(id);
      }
    }
  });
  return result;
}

export function retryAllErrors(db: DatabaseSync): RetryResult {
  const ids = (db.prepare(`SELECT id FROM ocr_queue WHERE status = 'error' ORDER BY id`).all() as { id: number }[]).map((r) => r.id);
  return retryQueueItems(db, ids);
}

export type RequeueResult =
  | { kind: "queued"; queueId: number }
  | { kind: "reset"; queueId: number }
  | { kind: "no_source" }
  | { kind: "reviewed"; reviewed: number }
  | { kind: "already_queued"; queueId: number; status: QueueStatus };

/**
 * 再OCRのために、既存の source_images 行をキューに載せる。
 * - レビュー済みの行は拒否する(人間の本文を守る。再OCRしたければ先に reviewed を 0 に戻す)
 * - 同じ行が既にキューにあれば、error のときだけ force で差し替えられる
 */
export function requeueSourceImage(
  db: DatabaseSync,
  params: { sourceImageId: number; imagePath: string; force?: boolean },
): RequeueResult {
  return inTransaction(db, (): RequeueResult => {
    const src = db.prepare(`SELECT * FROM source_images WHERE id = ?`).get(params.sourceImageId) as SourceImageRow | undefined;
    if (!src) return { kind: "no_source" };
    if (isReviewed(src)) return { kind: "reviewed", reviewed: src.reviewed };

    const existing = getQueueItemBySourceImage(db, params.sourceImageId);
    if (existing) {
      if (existing.status === "error" && params.force) {
        db.prepare(
          `UPDATE ocr_queue SET image_path = ?, status = 'pending', retry_count = 0, error_message = NULL WHERE id = ?`,
        ).run(params.imagePath, existing.id);
        return { kind: "reset", queueId: existing.id };
      }
      return { kind: "already_queued", queueId: existing.id, status: existing.status };
    }

    const r = db.prepare(`INSERT INTO ocr_queue (source_image_id, image_path) VALUES (?, ?)`).run(params.sourceImageId, params.imagePath);
    return { kind: "queued", queueId: Number(r.lastInsertRowid) };
  });
}
