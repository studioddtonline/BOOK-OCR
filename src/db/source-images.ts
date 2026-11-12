import type { DatabaseSync } from "node:sqlite";
import type { SourceImageRow } from "./types.js";

/** source_images に1行追加し、そのidを返す。 */
export function insertSourceImage(db: DatabaseSync, params: { label: string | null; fileName: string }): number {
  const r = db.prepare(`INSERT INTO source_images (file_path, file_name) VALUES (?, ?)`).run(params.label, params.fileName);
  return Number(r.lastInsertRowid);
}

export function getSourceImage(db: DatabaseSync, id: number): SourceImageRow | undefined {
  return db.prepare(`SELECT * FROM source_images WHERE id = ?`).get(id) as SourceImageRow | undefined;
}

export interface ImageStats {
  total: number;
  withText: number;
  reviewed: number;
  unlabeled: number;
}

export function getImageStats(db: DatabaseSync): ImageStats {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(ocr_text IS NOT NULL AND ocr_text != ''), 0) AS withText,
              COALESCE(SUM(reviewed <> 0), 0) AS reviewed,
              COALESCE(SUM(file_path IS NULL), 0) AS unlabeled
       FROM source_images`,
    )
    .get() as unknown as ImageStats;
  return { total: r.total, withText: r.withText, reviewed: r.reviewed, unlabeled: r.unlabeled };
}
