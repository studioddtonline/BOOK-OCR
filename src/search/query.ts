import { z } from "zod";

/**
 * AND/OR/NOTを任意の深さでネストできる構造化クエリ。
 * 将来Web UIのバックエンドがこのオブジェクトを直接組み立てて渡せるように、
 * FTS5の生の構文(文字列)ではなく素直なJSオブジェクトの木構造にしてある。
 *
 * 例: 「("あ" AND "い") OR ("う" AND NOT "え")」は
 * {
 *   type: "or",
 *   nodes: [
 *     { type: "and", nodes: [{type:"term",value:"あ"}, {type:"term",value:"い"}] },
 *     { type: "and", nodes: [
 *         {type:"term",value:"う"},
 *         {type:"not", node:{type:"term",value:"え"}}
 *     ]}
 *   ]
 * }
 */
export type QueryNode =
  | { type: "term"; value: string }
  | { type: "and"; nodes: QueryNode[] }
  | { type: "or"; nodes: QueryNode[] }
  | { type: "not"; node: QueryNode };

export const QueryNodeSchema: z.ZodType<QueryNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("term"), value: z.string().min(1) }),
    z.object({ type: z.literal("and"), nodes: z.array(QueryNodeSchema).min(1) }),
    z.object({ type: z.literal("or"), nodes: z.array(QueryNodeSchema).min(1) }),
    z.object({ type: z.literal("not"), node: QueryNodeSchema }),
  ]),
);

export interface CompiledQuery {
  /** source_images に対する WHERE句の中身(先頭・末尾の括弧込み)。 */
  sql: string;
  /** sql中の `?` に対応するパラメータ(順番通り)。 */
  params: unknown[];
}

/**
 * FTS5のtrigramトークナイザは3文字未満の語からは1つもトライグラムを作れず
 * 常に0件になってしまう。この関数は木構造の各termごとに、3文字以上なら
 * images_ftsのインデックスを使うサブクエリに、3文字未満ならocr_textへの
 * LIKEに振り分ける。
 *
 * NOT/AND/ORの組み立て自体はFTS5の構文を一切使わず、生のSQLブール演算子で行う。
 * SQLのNOTは単項演算子なので、FTS5のように「A NOT B」の2項限定という制約も無い。
 */
export function compileQuery(node: QueryNode): CompiledQuery {
  switch (node.type) {
    case "term":
      return compileTerm(node.value);
    case "and":
      return compileJunction(node.nodes, "AND", /* emptyValue */ "1");
    case "or":
      return compileJunction(node.nodes, "OR", /* emptyValue */ "0");
    case "not": {
      const inner = compileQuery(node.node);
      return { sql: `(NOT ${inner.sql})`, params: inner.params };
    }
  }
}

function compileJunction(nodes: QueryNode[], op: "AND" | "OR", emptyValue: string): CompiledQuery {
  if (nodes.length === 0) return { sql: emptyValue, params: [] };
  const compiled = nodes.map(compileQuery);
  return {
    sql: `(${compiled.map((c) => c.sql).join(` ${op} `)})`,
    params: compiled.flatMap((c) => c.params),
  };
}

function compileTerm(value: string): CompiledQuery {
  const codepointLength = [...value].length;
  if (codepointLength >= 3) {
    const escapedForPhrase = value.replace(/"/g, '""');
    return {
      sql: `id IN (SELECT rowid FROM images_fts WHERE images_fts MATCH ?)`,
      params: [`"${escapedForPhrase}"`],
    };
  }
  return {
    sql: `ocr_text LIKE ? ESCAPE '\\'`,
    params: [`%${escapeLike(value)}%`],
  };
}

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * 検索結果のスニペット表示用に、木構造の中の(NOTで否定されていない)
 * 検索語をすべて集める。NOT配下の語はそもそも「含まれない」ことを
 * 要求しているだけなので、ハイライト候補には含めない。
 */
export function extractPositiveTerms(node: QueryNode, negated = false): string[] {
  switch (node.type) {
    case "term":
      return negated ? [] : [node.value];
    case "and":
    case "or":
      return node.nodes.flatMap((n) => extractPositiveTerms(n, negated));
    case "not":
      return extractPositiveTerms(node.node, !negated);
  }
}

/**
 * CLIのカジュアルなフラグ(--and / --or / --not。それぞれカンマ区切りで複数語)から検索木を組み立てる。
 * 3つとも指定した場合は (AND群) AND (OR群) AND (NOTの否定群) というフラットな組み合わせになる。
 * ネストした条件が必要な場合は、JSONの --query を使う。
 */
export function buildCasualQuery(flags: { and?: string; or?: string; not?: string }): QueryNode | undefined {
  const split = (v: string | undefined): string[] =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  const andTerms = split(flags.and);
  const orTerms = split(flags.or);
  const notTerms = split(flags.not);
  if (andTerms.length === 0 && orTerms.length === 0 && notTerms.length === 0) return undefined;

  const term = (value: string): QueryNode => ({ type: "term", value });
  const groups: QueryNode[] = [];
  if (andTerms.length > 0) groups.push({ type: "and", nodes: andTerms.map(term) });
  if (orTerms.length > 0) groups.push({ type: "or", nodes: orTerms.map(term) });
  if (notTerms.length > 0) groups.push({ type: "and", nodes: notTerms.map((v) => ({ type: "not", node: term(v) })) });
  return groups.length === 1 ? groups[0] : { type: "and", nodes: groups };
}
