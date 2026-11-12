import { parseArgs } from "node:util";
import { dirname, join } from "node:path";
import { loadConfig } from "../../config.js";
import { openDb } from "../../db/index.js";
import { ProviderPool } from "../../providers/pool.js";
import { buildProviders } from "../../providers/registry.js";
import { StopController, runWorker } from "../../worker/worker.js";
import { withUsage } from "../args.js";
import type { Command } from "../types.js";

const USAGE = `使い方: book-ocr worker

  OCR待ちキューを順に処理し続けます(常駐)。Ctrl+C / SIGTERM で、現在の処理が終わり次第停止します。
  使うプロバイダと優先順は config.json の priority / providers、APIキーは .env で指定します。`;

export const command: Command = {
  usage: USAGE,
  async run(argv) {
    const { values } = withUsage(USAGE, () => parseArgs({ args: argv, options: { help: { type: "boolean" } }, strict: true }));
    if (values.help) return void console.log(USAGE);

    const config = loadConfig();
    const db = openDb(config.dbPath, config.dbBusyTimeoutMs);
    const pool = new ProviderPool(db, buildProviders(config), { usageTimeZone: config.usageTimeZone });

    // Ctrl+C / systemdのstopで綺麗に終了させる(待機中のsleepは即座に中断される)
    const controller = new StopController();
    const shutdown = () => {
      console.log("終了シグナルを受信。現在の処理が終わり次第停止します...");
      controller.stop();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    const exit = await runWorker(
      { db, pool, rescueLogPath: join(dirname(config.dbPath), "rescue.jsonl"), pollIntervalMs: config.pollIntervalMs },
      controller,
    );

    db.close();
    if (exit === "all_disabled") process.exit(1);
    console.log("ワーカーを停止しました。");
  },
};
