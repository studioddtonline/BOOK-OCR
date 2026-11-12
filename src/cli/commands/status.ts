import { parseArgs } from "node:util";
import { loadConfig } from "../../config.js";
import { LATEST_SCHEMA_VERSION, getUserVersion, listErrorQueueItems, openDb } from "../../db/index.js";
import { printDiagnostics } from "../../search/diagnostics.js";
import { withUsage } from "../args.js";
import type { Command } from "../types.js";

const USAGE = `使い方: book-ocr status

  DBの状態(件数・OCR待ちキュー・索引・スキーマ番号)と、error になっている行を表示します。`;

export const command: Command = {
  usage: USAGE,
  run(argv) {
    const { values } = withUsage(USAGE, () => parseArgs({ args: argv, options: { help: { type: "boolean" } }, strict: true }));
    if (values.help) return void console.log(USAGE);

    const config = loadConfig();
    const db = openDb(config.dbPath, config.dbBusyTimeoutMs);
    try {
      console.log(`DB: ${config.dbPath} (スキーマ番号 ${getUserVersion(db)} / 最新 ${LATEST_SCHEMA_VERSION})`);
      printDiagnostics(db);
      const errors = listErrorQueueItems(db, 20);
      if (errors.length > 0) {
        console.log("--- error の行(先頭20件まで) ---");
        for (const e of errors) {
          const msg = (e.error_message ?? "").replace(/\s+/g, " ").slice(0, 160);
          console.log(`  queue#${e.id} source_image#${e.source_image_id} 失敗回数=${e.retry_count} : ${msg}`);
        }
        console.log("  → 原因を解消したら `queue retry <queue_id>` / `queue retry --all-errors` で再試行できます。");
      }
    } finally {
      db.close();
    }
  },
};
