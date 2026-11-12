import { parseArgs } from "node:util";
import { loadConfig } from "../../config.js";
import { openDb } from "../../db/index.js";
import { withUsage } from "../args.js";
import type { Command } from "../types.js";

const USAGE = `使い方: book-ocr init-db

  DBを作成(または未適用のマイグレーションを適用)します。
  他のコマンドもDBを開くときに自動で同じことを行うので、明示的に実行する必要はありません。`;

export const command: Command = {
  usage: USAGE,
  run(argv) {
    const { values } = withUsage(USAGE, () => parseArgs({ args: argv, options: { help: { type: "boolean" } }, strict: true }));
    if (values.help) return void console.log(USAGE);

    const config = loadConfig();
    openDb(config.dbPath, config.dbBusyTimeoutMs).close();
    console.log(`DBを初期化しました: ${config.dbPath}`);
  },
};
