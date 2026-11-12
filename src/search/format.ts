import { isReviewed } from "../db/index.js";
import type { SearchHit } from "./service.js";

export function printHits(hits: SearchHit[]): void {
  for (const hit of hits) {
    const flag = isReviewed(hit) ? "[レビュー済] " : "";
    const label = hit.label ?? "(ラベルなし)";
    const name = hit.fileName ?? "(ファイル名不明)";
    console.log(`#${hit.id} ${flag}${label} / ${name}`);
    console.log(`  ${hit.snippet.replace(/\n/g, " ")}`);
  }
  console.log(`\n${hits.length}件ヒット`);
}
