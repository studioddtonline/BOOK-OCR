import { readFileSync } from "node:fs";
import { z } from "zod";
import { isValidTimeZone } from "./db/usage.js";
import { UserError } from "./errors.js";

export const PROVIDER_TYPES = ["gemini", "openai", "anthropic"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/**
 * providers の1エントリ。
 * - name: 利用者が自由に付ける名前。priority・使用量の記録・ログではこの名前を使う。
 * - type: どのベンダー向けアダプタ(コード)で動かすか。モデルの世代ではなくベンダー単位。
 * - options: モデル固有のオプション。中身は検証せず、そのままSDKのリクエスト設定に流し込む
 *   (コード側でモデルごとの分岐は行わない)。例: { "temperature": 0.1 }
 *   書いたものだけが送られる。そのモデルが受け付けない項目を書くと、実行時に400エラーになり、
 *   設定エラーとして検出される。
 * 未知のキーは拒否する(typo を黙って無視しないため)。
 */
const ProviderEntrySchema = z.strictObject({
  name: z.string().min(1),
  type: z.enum(PROVIDER_TYPES),
  model: z.string().min(1),
  // 1日あたりのおおよその上限。厳密なAPI側の値は変動するので、
  // 安全側に倒した目安値をここで管理し、超えたら翌日までそのプロバイダを休ませる。
  dailyRequestLimit: z.number().int().positive(),
  options: z.record(z.string(), z.unknown()).default({}),
});

export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;

const ConfigSchema = z
  .strictObject({
    watchDir: z.string(),
    // 省略した場合、正本は別の場所で管理されている前提で、
    // 取り込み済みのincomingファイルはリサイズ成功後にそのまま削除する。
    archiveDir: z.string().optional(),
    workDir: z.string(),
    dbPath: z.string(),
    resize: z
      .strictObject({
        maxDimension: z.number().int().positive().default(1800),
      })
      .default({ maxDimension: 1800 }),
    // 使うプロバイダの名前を優先順に並べる。providers に書いてあっても
    // ここに無いものは使われない(切り替えは priority の書き換えだけで行える)。
    priority: z.array(z.string().min(1)).min(1),
    providers: z.array(ProviderEntrySchema).min(1),
    pollIntervalMs: z.number().int().positive().default(30000),
    // DB Browser for SQLite等で開いている間に書き込みが発生した場合、
    // この時間(ミリ秒)まではSQLite側が自動でリトライしてくれる。
    dbBusyTimeoutMs: z.number().int().positive().default(20000),
    // プロバイダの「1日」の区切りに使うタイムゾーン(IANA名。例: "America/Los_Angeles")。
    // 無料枠のリセット時刻に合わせたいときに指定する。既定はUTC。
    usageTimeZone: z
      .string()
      .refine(isValidTimeZone, { message: "不明なタイムゾーンです(例: \"UTC\", \"Asia/Tokyo\", \"America/Los_Angeles\")" })
      .default("UTC"),
  })
  .superRefine((cfg, ctx) => {
    const names = new Set<string>();
    for (const p of cfg.providers) {
      if (names.has(p.name)) {
        ctx.addIssue({ code: "custom", path: ["providers"], message: `providers の name が重複しています: "${p.name}"` });
      }
      names.add(p.name);
    }

    const seen = new Set<string>();
    for (const n of cfg.priority) {
      if (!names.has(n)) {
        ctx.addIssue({
          code: "custom",
          path: ["priority"],
          message:
            `priority に "${n}" がありますが、その name の providers エントリがありません。` +
            `providers に定義されている name: ${[...names].map((x) => `"${x}"`).join(", ")}`,
        });
      } else if (seen.has(n)) {
        ctx.addIssue({ code: "custom", path: ["priority"], message: `priority に "${n}" が重複しています。` });
      }
      seen.add(n);
    }
  });

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(path = process.env.CONFIG_PATH ?? "./config.json"): AppConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new UserError(
      `設定ファイルを読み込めませんでした: ${path}\n` +
        `config.example.json をコピーして config.json を作成してください。\n原因: ${(err as Error).message}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new UserError(`設定ファイルのJSONが不正です: ${path}\n原因: ${(err as Error).message}`);
  }

  const result = ConfigSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".") || "(トップレベル)"}: ${i.message}`).join("\n");
    throw new UserError(`設定ファイルの内容が不正です: ${path}\n${issues}`);
  }
  return result.data;
}
