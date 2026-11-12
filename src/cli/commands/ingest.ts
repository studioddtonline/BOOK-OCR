import { parseArgs } from "node:util";
import { loadConfig } from "../../config.js";
import { openDb } from "../../db/index.js";
import { UserError } from "../../errors.js";
import { ingestDirectory } from "../../ingest/ingest.js";
import { withUsage } from "../args.js";
import type { Command } from "../types.js";

const USAGE = `使い方: book-ocr ingest [--label <本の名前など>]

  incoming(watchDir)直下の画像を取り込み、OCR待ちのキューに登録します。

  --label <名前>  この実行で取り込む全ての画像の source_images.file_path に入れる
                  (本の名前など、DBビューアで絞り込むためのラベル)。
                  省略するとNULLのままです。`;

export const command: Command = {
  usage: USAGE,
  async run(argv) {
    const { values } = withUsage(USAGE, () =>
      parseArgs({ args: argv, options: { label: { type: "string" }, help: { type: "boolean" } }, strict: true }),
    );
    if (values.help) return void console.log(USAGE);

    const label = values.label === undefined ? null : values.label.trim();
    if (label === "") throw new UserError(`--label に空の名前は指定できません。\n\n${USAGE}`);

    const config = loadConfig();
    const db = openDb(config.dbPath, config.dbBusyTimeoutMs);
    const r = await ingestDirectory(db, config, label).finally(() => db.close());

    console.log(`取り込み完了: 新規 ${r.registered} 件, 保留(要再試行) ${r.deferred} 件, 失敗 ${r.failed} 件`);
    if (label !== null) {
      console.log(`ラベル: "${label}" (source_images.file_path)`);
    } else if (r.registered > 0) {
      console.log(
        `ラベル未指定で ${r.registered} 件取り込みました(source_images.file_path は NULL です)。\n` +
          `  DBビューアで file_path IS NULL の行に、本の名前などを後から入力してください。`,
      );
    }
    if (r.leftover > 0) {
      console.error(`★ incomingに取り除けなかったファイルが ${r.leftover} 件あります(上のメッセージを参照)。`);
    }
  },
};
