import type { DatabaseSync } from "node:sqlite";
import { compileQuery, extractPositiveTerms, type QueryNode } from "./query.js";
import { buildSnippet } from "./snippet.js";

export interface SearchHit {
  id: number;
  /** 本の名前などのラベル(source_images.file_path)。 */
  label: string | null;
  fileName: string | null;
  reviewed: number;
  snippet: string;
}

export interface SearchOptions {
  limit?: number;
}

interface HitRow {
  id: number;
  label: string | null;
  fileName: string | null;
  reviewed: number;
  text: string | null;
}

export const DEFAULT_SEARCH_LIMIT = 50;

/** 1つの語(フレーズ)だけの検索で、FTS5のインデックスを使うか(trigramは3文字以上でないとヒットしない)。 */
export function usesFtsIndex(query: QueryNode): query is { type: "term"; value: string } {
  return query.type === "term" && [...query.value].length >= 3;
}

/**
 * 検索の入口。CLI・将来のWeb UI・MCP等は、検索木(QueryNode)を作ってこれを呼ぶ。
 *
 * - 1語で3文字以上: FTS5(trigram)のフレーズ検索。関連度(rank)順
 * - それ以外(3文字未満の語、AND/OR/NOTを含む複合クエリ): compileQuery が組み立てたWHERE句。id順
 *
 * OCR未完了(ocr_text が NULL)の行は、NOTだけの検索でも結果に含めない。
 */
export function searchImages(db: DatabaseSync, query: QueryNode, opts: SearchOptions = {}): SearchHit[] {
  const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;

  let rows: HitRow[];
  if (usesFtsIndex(query)) {
    // trigramトークナイザはFTS5の特殊クエリ構文と相性が悪い場合があるため、
    // ダブルクオートで囲んでフレーズ検索として扱う。
    const phrase = `"${query.value.replace(/"/g, '""')}"`;
    rows = db
      .prepare(
        `SELECT s.id AS id, s.file_path AS label, s.file_name AS fileName, s.reviewed AS reviewed, s.ocr_text AS text
         FROM images_fts
         JOIN source_images s ON s.id = images_fts.rowid
         WHERE images_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(phrase, limit) as unknown as HitRow[];
  } else {
    const compiled = compileQuery(query);
    rows = db
      .prepare(
        `SELECT id, file_path AS label, file_name AS fileName, reviewed, ocr_text AS text
         FROM source_images
         WHERE ocr_text IS NOT NULL AND ${compiled.sql}
         ORDER BY id
         LIMIT ?`,
      )
      .all(...(compiled.params as (string | number | bigint | Uint8Array | null)[]), limit) as unknown as HitRow[];
  }

  const highlight = extractPositiveTerms(query);
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    fileName: r.fileName,
    reviewed: r.reviewed,
    snippet: buildSnippet(r.text ?? "", highlight),
  }));
}
