import type { DatabaseSync } from "node:sqlite";
import type { OcrLogOutcome } from "./types.js";

export interface OcrLogEntry {
  sourceImageId: number;
  provider: string | null;
  model: string | null;
  outcome: OcrLogOutcome;
  httpStatus?: number | null;
  ocrText?: string | null;
  rawResponse?: string | null;
  errorMessage?: string | null;
  /** 使ったプロンプトのハッシュ(プロンプトを変えたときに、どの出力がどちらか追えるようにする)。 */
  promptHash?: string | null;
  /** SDKに送った options(JSON文字列)。 */
  requestOptions?: string | null;
}

export function insertOcrLog(db: DatabaseSync, e: OcrLogEntry): void {
  db.prepare(
    `INSERT INTO ocr_log
       (source_image_id, provider, model, outcome, http_status, ocr_text, raw_response, error_message, prompt_hash, request_options)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.sourceImageId,
    e.provider,
    e.model,
    e.outcome,
    e.httpStatus ?? null,
    e.ocrText ?? null,
    e.rawResponse ?? null,
    e.errorMessage ?? null,
    e.promptHash ?? null,
    e.requestOptions ?? null,
  );
}
