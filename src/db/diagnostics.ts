import type { DatabaseSync } from "node:sqlite";
import { getFtsIndexedTermCount } from "./fts.js";
import { getQueueSummary } from "./queue.js";
import { getImageStats, type ImageStats } from "./source-images.js";
import type { QueueStatus } from "./types.js";

export interface Diagnostics extends ImageStats {
  queue: Record<QueueStatus, number>;
  /** 実際に索引済みのトライグラム数(fts5vocab)。 */
  indexedTerms: number;
}

/**
 * 注意: images_fts は外部content(content='source_images')のテーブルなので、
 * MATCHを使わない SELECT COUNT(*) FROM images_fts は常に source_images の行数と
 * 一致するだけの見せかけの数字にしかならず、実際の索引状態の確認には使えない。
 * fts5vocab で実際に索引されているトライグラム数を見る必要がある。
 */
export function collectDiagnostics(db: DatabaseSync): Diagnostics {
  return { ...getImageStats(db), queue: getQueueSummary(db), indexedTerms: getFtsIndexedTermCount(db) };
}

/**
 * status 用の診断情報。「そもそもインデックスにデータが入っているか」
 * 「書誌情報が無いから検索できないのでは」といった疑問に答えるためのもの。
 * 全文検索(別パッケージ ocr-search)は books/pages の書誌情報には一切依存しない
 * (source_images.ocr_text と images_fts だけで完結する)ことが分かるようにしている。
 */
export function printDiagnostics(db: DatabaseSync): void {
  const d = collectDiagnostics(db);
  console.log("--- 診断情報 ---");
  console.log(`source_images 総数: ${d.total} (ラベル(file_path)未設定: ${d.unlabeled}, レビュー済み: ${d.reviewed})`);
  console.log(`ocr_text が入っている件数: ${d.withText}`);
  console.log(`OCR待ちキュー: pending=${d.queue.pending}, processing=${d.queue.processing}, error=${d.queue.error}`);
  console.log(`実際に索引済みのトライグラム数(fts5vocab): ${d.indexedTerms}`);
  if (d.withText > 0 && d.indexedTerms === 0) {
    console.log(
      `  ※ ocr_textはあるのに索引が空です。インデックスが同期されていません。\n` +
        `     npm run reindex での再構築を試してください。`,
    );
  }
  console.log(
    `※ 全文検索(ocr-search)は ocr_text / images_fts のみを見ます。books/pagesの書誌情報(タイトル・著者等)が\n` +
      `  未入力でも全文検索の可否には影響しません。`,
  );
}
