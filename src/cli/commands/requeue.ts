import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../../config.js";
import { openDb, requeueSourceImage } from "../../db/index.js";
import { UserError } from "../../errors.js";
import { parsePositiveInt, withUsage } from "../args.js";
import type { Command } from "../types.js";

const USAGE = `使い方: book-ocr requeue <source_image_id> --image <画像ファイル> [--force]

  既存の source_images の行を、再OCRのためにキューに載せます。
  --image   AIに送る画像(リサイズ済みでも元画像でも構いません)。
  --force   同じ行が status=error でキューに残っている場合に、画像を差し替えて pending に戻します。

  - レビュー済み(reviewed が 0 以外)の行は拒否します(人間が直した本文を守るため)。
    再OCRしたい場合は、先に source_images.reviewed を 0 に戻してください。
  - 既に pending / processing の行は、二重に載せません。
  - 再OCRが成功すると、ocr_text は新しい結果で上書きされます(以前の結果は ocr_log に履歴が残ります)。`;

export const command: Command = {
  usage: USAGE,
  run(argv) {
    const { values, positionals } = withUsage(USAGE, () =>
      parseArgs({
        args: argv,
        options: { image: { type: "string" }, force: { type: "boolean" }, help: { type: "boolean" } },
        allowPositionals: true,
        strict: true,
      }),
    );
    if (values.help) return void console.log(USAGE);

    if (positionals.length !== 1) throw new UserError(`source_image_id を1つ指定してください。\n\n${USAGE}`);
    if (!values.image) throw new UserError(`--image を指定してください。\n\n${USAGE}`);
    const sourceImageId = parsePositiveInt(positionals[0], "source_image_id", USAGE);

    const imagePath = resolve(values.image); // workerは別のカレントディレクトリで動くことがあるので、絶対パスで保存する
    if (!existsSync(imagePath)) throw new UserError(`画像ファイルが見つかりません: ${imagePath}`);

    const config = loadConfig();
    const db = openDb(config.dbPath, config.dbBusyTimeoutMs);
    try {
      const r = requeueSourceImage(db, { sourceImageId, imagePath, force: values.force });
      switch (r.kind) {
        case "queued":
          return void console.log(`キューに載せました: queue#${r.queueId} (source_image#${sourceImageId}) ${imagePath}`);
        case "reset":
          return void console.log(`error の行を差し替えて pending に戻しました: queue#${r.queueId} (source_image#${sourceImageId}) ${imagePath}`);
        case "no_source":
          throw new UserError(`source_images.id=${sourceImageId} は存在しません。`);
        case "reviewed":
          throw new UserError(
            `source_image#${sourceImageId} は reviewed=${r.reviewed}(レビュー済み)のため、キューに載せません。\n` +
              `  再OCRで上書きしてよい場合は、source_images.reviewed を 0 に戻してから、もう一度実行してください。`,
          );
        case "already_queued":
          throw new UserError(
            `source_image#${sourceImageId} は既にキューにあります: queue#${r.queueId} (status=${r.status})。` +
              (r.status === "error" ? "\n  画像を差し替えて再試行するには --force を付けてください。" : ""),
          );
      }
    } finally {
      db.close();
    }
  },
};
