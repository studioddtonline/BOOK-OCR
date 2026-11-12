import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { openDb } from "../src/db/index.js";
import type { ImageInput } from "../src/image-file.js";
import type { OcrCallResult, OcrProvider } from "../src/providers/types.js";

/** 一時ディレクトリを作り、テスト終了時に消す。 */
export function tmpDir(t: TestContext, prefix = "book-ocr-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** メモリ上のDB(スキーマ作成済み)。 */
export function memDb(t?: TestContext): DatabaseSync {
  const db = openDb(":memory:", 100);
  t?.after(() => {
    try {
      db.close();
    } catch {
      /* 既に閉じている */
    }
  });
  return db;
}

/** ファイル上のDB(複数接続のテスト用)。 */
export function fileDb(t: TestContext, busyMs = 1): { db: DatabaseSync; path: string; dir: string } {
  const dir = tmpDir(t);
  const path = join(dir, "db", "library.sqlite3");
  const db = openDb(path, busyMs);
  t.after(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  });
  return { db, path, dir };
}

export function addImage(
  db: DatabaseSync,
  p: { label?: string | null; fileName?: string | null; text?: string | null; reviewed?: number } = {},
): number {
  const r = db
    .prepare(`INSERT INTO source_images (file_path, file_name, ocr_text, reviewed) VALUES (?, ?, ?, ?)`)
    .run(p.label ?? null, p.fileName ?? "a.webp", p.text ?? null, p.reviewed ?? 0);
  return Number(r.lastInsertRowid);
}

export function addQueue(
  db: DatabaseSync,
  sourceImageId: number,
  imagePath: string,
  status: "pending" | "processing" | "error" = "pending",
  retryCount = 0,
): number {
  const r = db
    .prepare(`INSERT INTO ocr_queue (source_image_id, image_path, status, retry_count) VALUES (?, ?, ?, ?)`)
    .run(sourceImageId, imagePath, status, retryCount);
  return Number(r.lastInsertRowid);
}

export function row<T = Record<string, unknown>>(db: DatabaseSync, sql: string, ...params: unknown[]): T | undefined {
  const r = db.prepare(sql).get(...(params as never[]));
  return r === undefined ? undefined : ({ ...r } as T); // null-prototype を通常のオブジェクトにする
}

export function rows<T = Record<string, unknown>>(db: DatabaseSync, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])).map((r) => ({ ...r }) as T);
}

/** console.log/warn/error を捕まえる。 */
export function captureConsole(t: TestContext): { log: string[]; warn: string[]; error: string[] } {
  const out = { log: [] as string[], warn: [] as string[], error: [] as string[] };
  const fmt = (args: unknown[]) => args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
  t.mock.method(console, "log", (...a: unknown[]) => void out.log.push(fmt(a)));
  t.mock.method(console, "warn", (...a: unknown[]) => void out.warn.push(fmt(a)));
  t.mock.method(console, "error", (...a: unknown[]) => void out.error.push(fmt(a)));
  return out;
}

export type Script = Array<string | Error>;

/** 台本どおりに応答する偽プロバイダ。台本が尽きたら "OCR(<path>)" を返す。 */
export class FakeProvider implements OcrProvider {
  readonly type = "gemini" as const;
  readonly model: string;
  readonly options: Readonly<Record<string, unknown>> = {};
  readonly calls: string[] = [];
  onCall?: () => void;

  constructor(
    readonly name: string,
    private script: Script = [],
    readonly dailyRequestLimit = 1000,
  ) {
    this.model = `${name}-model`;
  }

  /** 呼ばれた画像の中身(dummyImage は、ファイル名と同じ文字列を中身にする)。 */
  async callOcr(image: ImageInput, _prompt: string): Promise<OcrCallResult> {
    const imagePath = image.bytes.toString();
    this.calls.push(imagePath);
    this.onCall?.();
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    return { text: next ?? `OCR(${imagePath})`, raw: { fake: true, name: this.name } };
  }
}

/** ダミーの画像ファイルを作る。中身はファイル名と同じ文字列。 */
export function dummyImage(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, name); // 中身はファイル名(FakeProvider が受け取った画像を識別できるように)
  return p;
}

// ---------------------------------------------------------------------------
// CLI を別プロセスで実行する(E2E)
// ---------------------------------------------------------------------------

const BUILD_ROOT = resolve(import.meta.dirname, "..");

const CLI_ENTRY = "src/cli/index.js";

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** `book-ocr <command> ...args` を別プロセスで実行する。 */
export function runCli(command: string, args: string[], configPath: string): CliResult {
  const r = spawnSync(process.execPath, ["--no-warnings", join(BUILD_ROOT, CLI_ENTRY), command, ...args], {
    env: { ...process.env, CONFIG_PATH: configPath },
    encoding: "utf-8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** CLI E2E用の config.json と各ディレクトリを作る。 */
export function makeProject(
  t: TestContext,
  extra: Record<string, unknown> = {},
): { root: string; configPath: string; watchDir: string; workDir: string; dbPath: string; archiveDir: string } {
  const root = tmpDir(t);
  const watchDir = join(root, "incoming");
  const workDir = join(root, "resized");
  const dbPath = join(root, "db", "library.sqlite3");
  const archiveDir = join(root, "archive");
  const config = {
    watchDir,
    workDir,
    dbPath,
    priority: ["g"],
    providers: [{ name: "g", type: "gemini", model: "m", dailyRequestLimit: 10 }],
    ...extra,
  };
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  return { root, configPath, watchDir, workDir, dbPath, archiveDir };
}
