import { UserError } from "../errors.js";

/**
 * util.parseArgs が投げる引数エラーを、使い方つきの UserError に変換する。
 * (未知のオプション、値の指定漏れ、等)
 */
export function withUsage<T>(usage: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
      throw new UserError(`${(err as Error).message}\n\n${usage}`);
    }
    throw err;
  }
}

export function parsePositiveInt(raw: string, optionName: string, usage: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new UserError(`${optionName} には正の整数を指定してください: ${raw}\n\n${usage}`);
  return n;
}
