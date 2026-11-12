import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../../config.js";
import { openDb } from "../../db/index.js";
import { UserError } from "../../errors.js";
import { applyRescueEntry, readRescueFile, type RescueOutcome } from "../../rescue.js";
import { withUsage } from "../args.js";
import type { Command } from "../types.js";

const USAGE = `使い方: book-ocr rescue apply [--file <rescue.jsonl>] [--dry-run]

  OCRは成功したのにDB保存に失敗し、rescue.jsonl に退避された結果を、DBに反映します。
  --file      退避ファイル(既定: DBと同じディレクトリの rescue.jsonl)
  --dry-run   何も書き込まず、反映される予定の件数だけを表示します。

  キューに行が残っている(= まだ結果が入っていない)ものだけを反映するので、
  同じファイルを何度実行しても二重には反映されません。再OCRで既に新しい結果がある行は、古い結果で上書きしません。
  レビュー済みの行は上書きせず、AIの出力だけを ocr_log に残します。`;

const LABEL: Record<RescueOutcome["kind"], string> = {
  applied: "反映",
  would_apply: "反映予定",
  reviewed: "レビュー済みのため本文は上書きせず(ocr_logにのみ記録)",
  missing: "格納先の行が無い",
  skipped_already_processed: "処理済みのためスキップ",
};

export const command: Command = {
  usage: USAGE,
  run(argv) {
    const { values, positionals } = withUsage(USAGE, () =>
      parseArgs({
        args: argv,
        options: { file: { type: "string" }, "dry-run": { type: "boolean" }, help: { type: "boolean" } },
        allowPositionals: true,
        strict: true,
      }),
    );
    if (values.help) return void console.log(USAGE);
    if (positionals[0] !== "apply" || positionals.length !== 1) throw new UserError(`サブコマンド apply を指定してください。\n\n${USAGE}`);

    const config = loadConfig();
    const file = values.file ?? join(dirname(config.dbPath), "rescue.jsonl");
    const { entries, invalidLines } = readRescueFile(file);
    if (entries.length === 0 && invalidLines.length === 0) return void console.log(`反映する結果はありません: ${file}`);

    const db = openDb(config.dbPath, config.dbBusyTimeoutMs);
    const counts = new Map<RescueOutcome["kind"], number>();
    try {
      for (const entry of entries) {
        const outcome = applyRescueEntry(db, entry, values["dry-run"] === true);
        counts.set(outcome.kind, (counts.get(outcome.kind) ?? 0) + 1);
        console.log(`source_image#${entry.sourceImageId} (${entry.savedAt}): ${LABEL[outcome.kind]}`);
      }
    } finally {
      db.close();
    }

    console.log(`\n${file}: ${entries.length} 件中 ` + [...counts].map(([k, n]) => `${LABEL[k]} ${n} 件`).join(", "));
    if (invalidLines.length > 0) console.warn(`読み取れなかった行(形式不正): ${invalidLines.join(", ")} 行目`);
  },
};
