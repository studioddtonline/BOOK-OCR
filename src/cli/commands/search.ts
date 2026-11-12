import { parseArgs } from "node:util";
import { loadConfig } from "../../config.js";
import { openDb } from "../../db/index.js";
import { UserError } from "../../errors.js";
import { printDiagnostics } from "../../search/diagnostics.js";
import { printHits } from "../../search/format.js";
import { buildCasualQuery, compileQuery, QueryNodeSchema, type QueryNode } from "../../search/query.js";
import { DEFAULT_SEARCH_LIMIT, searchImages, usesFtsIndex } from "../../search/service.js";
import { parsePositiveInt, withUsage } from "../args.js";
import type { Command } from "../types.js";

const USAGE = `使い方:
  book-ocr search <検索語...>          スペース区切りの語は、スペースも含めた1つのフレーズとして検索
  book-ocr search [条件フラグ]         AND/OR/NOT を使った詳細検索
  book-ocr search --debug [検索語]     診断情報・解釈した検索条件・組み立てたSQLを表示

詳細検索の入力方法(どちらか一方):

  1. カジュアルなフラグ(手打ち用の簡易記法。カンマ区切りで複数語)
       --and "語A,語B"   全て含む(AND)
       --or  "語C,語D"   いずれかを含む(OR)
       --not "語E,語F"   いずれも含まない(NOT、それぞれ個別に除外)

     3つとも指定した場合は (AND群) AND (OR群) AND (NOTの否定群) というフラットな組み合わせになります。
     例: 「宮崎」と「監督」を両方含み、「アニメ」は含まない
       --and "宮崎,監督" --not "アニメ"

  2. 生のクエリ(JSON、Web UIのバックエンド等が組み立てるAPIと同じ形式。入れ子にできる)
       --query '<JSONクエリ>'

     クエリの形は次の4種類の入れ子:
       {"type":"term","value":"語"}
       {"type":"and","nodes":[...]}
       {"type":"or","nodes":[...]}
       {"type":"not","node":{...}}

     例: 「("あ" AND "い") OR ("う" AND NOT "え")」相当
       --query '{"type":"or","nodes":[
         {"type":"and","nodes":[{"type":"term","value":"あ"},{"type":"term","value":"い"}]},
         {"type":"and","nodes":[{"type":"term","value":"う"},{"type":"not","node":{"type":"term","value":"え"}}]}
       ]}'

共通オプション:
  --limit <N>  表示する最大件数(既定 ${DEFAULT_SEARCH_LIMIT})
  --debug      診断情報などを表示する
  --help       このヘルプを表示する

検索語が - で始まる場合は、-- の後に書いてください(例: book-ocr search -- -foo)。`;

function parseQueryJson(raw: string | undefined): QueryNode {
  if (!raw) throw new UserError("--query の後にJSON文字列を指定してください。");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new UserError(`--query のJSONが不正です: ${(err as Error).message}`);
  }
  const result = QueryNodeSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new UserError(`--query の内容がクエリの形式と一致しません:\n${issues}`);
  }
  return result.data;
}

export const command: Command = {
  usage: USAGE,
  run(argv) {
    const { values, positionals } = withUsage(USAGE, () =>
      parseArgs({
        args: argv,
        options: {
          and: { type: "string" },
          or: { type: "string" },
          not: { type: "string" },
          query: { type: "string" },
          limit: { type: "string" },
          debug: { type: "boolean" },
          help: { type: "boolean" },
        },
        allowPositionals: true,
        strict: true,
      }),
    );
    if (values.help) return void console.log(USAGE);

    const phrase = positionals.join(" ").trim();
    const hasQueryFlag = values.query !== undefined;
    const casual = buildCasualQuery({ and: values.and, or: values.or, not: values.not });
    const hasStructured = hasQueryFlag || casual !== undefined || values.and !== undefined || values.or !== undefined || values.not !== undefined;

    if (phrase && hasStructured) {
      throw new UserError(`検索語と --query / --and / --or / --not は同時に指定できません。\n\n${USAGE}`);
    }
    if (hasQueryFlag && casual) {
      throw new UserError(`--query と --and / --or / --not は同時に指定できません。\n\n${USAGE}`);
    }

    let query: QueryNode | undefined;
    if (hasQueryFlag) query = parseQueryJson(values.query);
    else if (casual) query = casual;
    else if (phrase) query = { type: "term", value: phrase };
    else if (hasStructured) {
      throw new UserError("検索条件が指定されていません。--query か --and/--or/--not のいずれかを指定してください。");
    }

    if (!query && !values.debug) throw new UserError(`検索語を指定してください。\n\n${USAGE}`);

    const limit = values.limit === undefined ? DEFAULT_SEARCH_LIMIT : parsePositiveInt(values.limit, "--limit", USAGE);

    const config = loadConfig();
    const db = openDb(config.dbPath, config.dbBusyTimeoutMs);
    try {
      if (values.debug) {
        printDiagnostics(db);
        if (!query) return;
        console.log("--- 検索実行 ---");
        console.log(`受け取った生の引数: ${JSON.stringify(argv)}`);
        if (query.type === "term") {
          console.log(`検索語: ${JSON.stringify(query.value)} (${[...query.value].length}文字)`);
          console.log(`検索方式: ${usesFtsIndex(query) ? "FTS5(trigram)" : "LIKE(全件走査、3文字未満のため)"}`);
        } else {
          console.log(`解釈したクエリ木: ${JSON.stringify(query)}`);
          const compiled = compileQuery(query);
          console.log(`組み立てたSQL(WHERE句): ${compiled.sql}`);
          console.log(`パラメータ: ${JSON.stringify(compiled.params)}`);
        }
      }

      const hits = searchImages(db, query!, { limit });
      if (hits.length === 0) {
        console.log("該当する結果はありませんでした。");
        if (!values.debug) console.log("(詳細を確認したい場合は、引数に --debug を追加して再実行してください)");
        return;
      }
      printHits(hits);
    } finally {
      db.close();
    }
  },
};
