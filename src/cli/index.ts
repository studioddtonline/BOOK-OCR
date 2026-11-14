#!/usr/bin/env node
import { UserError, fail } from "../errors.js";
import type { Command } from "./types.js";

/** サブコマンド名 → 概要と、遅延読み込みする実装(例: status では各社のSDKを読み込まない)。 */
const COMMANDS: Record<string, { summary: string; load: () => Promise<{ command: Command }> }> = {
  "init-db": { summary: "DBを作成する(未適用のマイグレーションを適用する)", load: () => import("./commands/init-db.js") },
  ingest: { summary: "incoming の画像を取り込み、OCR待ちキューに登録する", load: () => import("./commands/ingest.js") },
  worker: { summary: "OCR待ちキューを処理し続ける(常駐)", load: () => import("./commands/worker.js") },
  status: { summary: "DBの状態と、error になっている行を表示する", load: () => import("./commands/status.js") },
  queue: { summary: "OCR待ちキューの確認(list)・失敗した行の再試行(retry)", load: () => import("./commands/queue.js") },
  requeue: { summary: "既存の画像を再OCRのためにキューへ載せる", load: () => import("./commands/requeue.js") },
  rescue: { summary: "退避された(DB保存に失敗した)OCR結果をDBに反映する", load: () => import("./commands/rescue.js") },
  reindex: { summary: "全文検索の索引を作り直す", load: () => import("./commands/reindex.js") },
};

const RETIRED_SEARCH_MESSAGE = [
  "search コマンドは v0.5.0 で廃止されました。全文検索は別パッケージ ocr-search に移りました。",
  "  例: ocr-search search --database=<dbPathの絶対パス> --query=\"検索語\"",
  "  日本語(形態素)検索は ocr-search search-japanese を使います。",
].join("\n");

function overview(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((n) => n.length));
  const lines = Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(width)}  ${c.summary}`);
  return `使い方: book-ocr <コマンド> [オプション]\n\nコマンド:\n${lines.join("\n")}\n\n各コマンドの詳細は book-ocr <コマンド> --help で表示できます。`;
}

async function main(argv: string[]): Promise<void> {
  const [name, ...rest] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    console.log(overview());
    return;
  }
  // v0.5.0 で全文検索を別パッケージ(ocr-search)へ移した。旧コマンドを打った人に移行先を示す。
  if (name === "search") throw new UserError(RETIRED_SEARCH_MESSAGE);
  const entry = COMMANDS[name];
  if (!entry) throw new UserError(`不明なコマンドです: ${name}\n\n${overview()}`);
  const { command } = await entry.load();
  await command.run(rest);
}

main(process.argv.slice(2)).catch(fail);
