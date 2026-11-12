import { parseArgs } from "node:util";
import { loadConfig } from "../../config.js";
import { getImageStats, getFtsIndexedTermCount, openDb, rebuildFtsIndex } from "../../db/index.js";
import { withUsage } from "../args.js";
import type { Command } from "../types.js";

const USAGE = `使い方: book-ocr reindex

  images_fts(全文検索の索引)を source_images.ocr_text から全件作り直します。
  通常はトリガーで自動同期されていますが、DB Browser等での直接編集などで索引がずれたときのために、
  任意のタイミングで実行できます。実行してもデータは失われません(索引の再構築のみ)。`;

export const command: Command = {
  usage: USAGE,
  run(argv) {
    const { values } = withUsage(USAGE, () => parseArgs({ args: argv, options: { help: { type: "boolean" } }, strict: true }));
    if (values.help) return void console.log(USAGE);

    const config = loadConfig();
    const db = openDb(config.dbPath, config.dbBusyTimeoutMs);
    try {
      const before = getFtsIndexedTermCount(db);
      console.log("インデックスを再構築しています...");
      rebuildFtsIndex(db);
      const after = getFtsIndexedTermCount(db);
      console.log(`完了。索引済みトライグラム数: ${before} -> ${after} (source_images総数: ${getImageStats(db).total})`);
    } finally {
      db.close();
    }
  },
};
