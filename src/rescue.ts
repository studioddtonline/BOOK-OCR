import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { completeQueueItem, getQueueItemBySourceImage, type OcrSavePayload, type QueueRow } from "./db/index.js";

/**
 * rescue.jsonl の1行。OCR自体は成功したのにDB保存が最終的に失敗したとき、
 * APIのレート制限枠を消費して得た結果を失わないよう、ここに追記しておく。
 */
export interface RescueEntry extends OcrSavePayload {
  savedAt: string;
  queueId: number;
  sourceImageId: number;
  dbError: string;
}

export function appendRescueLog(path: string, item: QueueRow, payload: OcrSavePayload, err: unknown): void {
  try {
    const entry: RescueEntry = {
      savedAt: new Date().toISOString(),
      queueId: item.id,
      sourceImageId: item.source_image_id,
      ...payload,
      dbError: String(err),
    };
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
  } catch (writeErr) {
    // ここまで失敗したら手が出せない。せめて標準エラーには全文を残す。
    console.error("rescue.jsonl への書き込みにも失敗しました。以下に結果を直接出力します:");
    console.error(JSON.stringify({ queueId: item.id, sourceImageId: item.source_image_id, ...payload }));
    console.error(writeErr);
  }
}

export interface RescueReadResult {
  entries: RescueEntry[];
  /** JSONとして読めなかった行の番号(1始まり)。 */
  invalidLines: number[];
}

export function readRescueFile(path: string): RescueReadResult {
  if (!existsSync(path)) return { entries: [], invalidLines: [] };
  const entries: RescueEntry[] = [];
  const invalidLines: number[] = [];
  readFileSync(path, "utf-8")
    .split("\n")
    .forEach((line, i) => {
      if (line.trim() === "") return;
      try {
        const e = JSON.parse(line) as Partial<RescueEntry>;
        if (typeof e.sourceImageId !== "number" || typeof e.ocrText !== "string") throw new Error("形式不正");
        entries.push({
          savedAt: e.savedAt ?? "",
          queueId: e.queueId ?? 0,
          sourceImageId: e.sourceImageId,
          ocrText: e.ocrText,
          provider: e.provider ?? "unknown",
          model: e.model ?? "unknown",
          rawResponse: e.rawResponse ?? "",
          promptHash: e.promptHash ?? null,
          requestOptions: e.requestOptions ?? null,
          dbError: e.dbError ?? "",
        });
      } catch {
        invalidLines.push(i + 1);
      }
    });
  return { entries, invalidLines };
}

export type RescueOutcome =
  | { kind: "applied" }
  | { kind: "would_apply" }
  /** レビュー済みだったため、本文は上書きせず、AI出力はocr_logに残した。 */
  | { kind: "reviewed" }
  | { kind: "missing" }
  /** キューに行が無い = 既に処理済み(反映済み、または再OCRで新しい結果がある)。古い結果で上書きしない。 */
  | { kind: "skipped_already_processed" };

/**
 * 退避された結果をDBに反映する。キューの行が残っている(= まだ結果が入っていない)ものだけを対象にし、
 * 反映すると通常の保存と同じくキューの行が消えるため、同じファイルを何度実行しても二重には反映されない。
 */
export function applyRescueEntry(db: DatabaseSync, entry: RescueEntry, dryRun = false): RescueOutcome {
  const item = getQueueItemBySourceImage(db, entry.sourceImageId);
  if (!item) return { kind: "skipped_already_processed" };
  if (dryRun) return { kind: "would_apply" };

  const result = completeQueueItem(db, item, {
    ocrText: entry.ocrText,
    provider: entry.provider,
    model: entry.model,
    rawResponse: entry.rawResponse,
    promptHash: entry.promptHash,
    requestOptions: entry.requestOptions,
  });
  return result === "saved" ? { kind: "applied" } : { kind: result };
}
