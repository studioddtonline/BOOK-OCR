import { parseArgs } from "node:util";
import { loadConfig } from "../../config.js";
import { listQueueItems, openDb, retryAllErrors, retryQueueItems, type QueueStatus, type RetryResult } from "../../db/index.js";
import { UserError } from "../../errors.js";
import { parsePositiveInt, withUsage } from "../args.js";
import type { Command } from "../types.js";

const USAGE = `使い方:
  book-ocr queue list [--status pending|processing|error] [--limit N]
      OCR待ちキューの行を表示します(既定: 全状態、先頭20件)。

  book-ocr queue retry <queue_id>...
  book-ocr queue retry --all-errors
      status が error の行を pending に戻し、失敗回数をリセットします。
      error 以外の行(pending / processing)は触りません。
      reviewed が立っている行は、再試行しても worker が拒否します(先に reviewed を 0 に戻してください)。`;

const STATUSES: readonly QueueStatus[] = ["pending", "processing", "error"];

function printRetryResult(r: RetryResult): void {
  console.log(`pending に戻しました: ${r.retried.length} 件${r.retried.length ? ` (queue#${r.retried.join(", #")})` : ""}`);
  if (r.skipped.length > 0) {
    console.log(`  error ではないため何もしませんでした: ${r.skipped.map((s) => `#${s.id}(${s.status})`).join(", ")}`);
  }
  if (r.notFound.length > 0) console.log(`  見つかりませんでした: ${r.notFound.map((id) => `#${id}`).join(", ")}`);
}

export const command: Command = {
  usage: USAGE,
  run(argv) {
    const { values, positionals } = withUsage(USAGE, () =>
      parseArgs({
        args: argv,
        options: { status: { type: "string" }, limit: { type: "string" }, "all-errors": { type: "boolean" }, help: { type: "boolean" } },
        allowPositionals: true,
        strict: true,
      }),
    );
    if (values.help) return void console.log(USAGE);

    const [sub, ...rest] = positionals;
    if (sub !== "list" && sub !== "retry") throw new UserError(`サブコマンド(list / retry)を指定してください。\n\n${USAGE}`);

    const config = loadConfig();
    const db = openDb(config.dbPath, config.dbBusyTimeoutMs);
    try {
      if (sub === "list") {
        if (rest.length > 0) throw new UserError(`余分な引数です: ${rest.join(" ")}\n\n${USAGE}`);
        const status = values.status as QueueStatus | undefined;
        if (status !== undefined && !STATUSES.includes(status)) {
          throw new UserError(`--status は ${STATUSES.join(" / ")} のいずれかです: ${status}\n\n${USAGE}`);
        }
        const limit = values.limit === undefined ? 20 : parsePositiveInt(values.limit, "--limit", USAGE);
        const items = listQueueItems(db, { status, limit });
        if (items.length === 0) return void console.log("該当する行はありません。");
        for (const q of items) {
          const msg = (q.error_message ?? "").replace(/\s+/g, " ").slice(0, 120);
          console.log(`queue#${q.id} source_image#${q.source_image_id} [${q.status}] 失敗回数=${q.retry_count} ${q.image_path}${msg ? `\n    ${msg}` : ""}`);
        }
        return;
      }

      // retry
      if (values["all-errors"]) {
        if (rest.length > 0) throw new UserError(`--all-errors と queue_id は同時に指定できません。\n\n${USAGE}`);
        return printRetryResult(retryAllErrors(db));
      }
      if (rest.length === 0) throw new UserError(`queue_id か --all-errors を指定してください。\n\n${USAGE}`);
      const ids = rest.map((s) => parsePositiveInt(s, "queue_id", USAGE));
      printRetryResult(retryQueueItems(db, ids));
    } finally {
      db.close();
    }
  },
};
