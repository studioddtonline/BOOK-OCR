import type { DatabaseSync } from "node:sqlite";
import { getQueueSummary, listErrorQueueItems } from "../db/index.js";
import type { OcrProvider } from "../providers/types.js";

/** 起動時に、設定の実効値とキューの状況を表示する。人間の調整が必要な行はここで目に入る。 */
export function printStartupReport(db: DatabaseSync, providers: readonly OcrProvider[]): void {
  console.log("ワーカー起動。");
  console.log("使用するプロバイダ(優先順):");
  providers.forEach((p, i) => {
    const opts = Object.keys(p.options).length > 0 ? JSON.stringify(p.options) : "(なし — 各社の既定値で動作します)";
    console.log(`  ${i + 1}. ${p.name}  [type=${p.type}, model=${p.model}, 1日上限=${p.dailyRequestLimit}]`);
    console.log(`     SDKへ送る options: ${opts}`);
  });

  const summary = getQueueSummary(db);
  console.log(`キューの状況: pending=${summary.pending}, processing=${summary.processing}, error=${summary.error}`);

  if (summary.error > 0) {
    const shown = listErrorQueueItems(db, 20);
    console.log(`error の行(人間の確認が必要です。${summary.error > shown.length ? `先頭${shown.length}件のみ表示` : "全件表示"}):`);
    for (const e of shown) {
      const msg = (e.error_message ?? "").replace(/\s+/g, " ").slice(0, 160);
      console.log(`  queue#${e.id} source_image#${e.source_image_id} 失敗回数=${e.retry_count} : ${msg}`);
    }
    console.log("  → 原因を解消した上で、`queue retry <queue_id>`(全件なら `queue retry --all-errors`)で再試行されます。");
  }
}
