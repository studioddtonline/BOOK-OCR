import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../config.js";
import { inTransaction, insertQueueItem, insertSourceImage, isBusyError } from "../db/index.js";
import { resizeForOcr } from "./resize.js";

export const IMAGE_EXTENSIONS = new Set([".webp", ".jpg", ".jpeg", ".png"]);

export interface IngestResult {
  registered: number;
  /** DBロックのため保留した(incomingに残してあり、次回再試行される)。 */
  deferred: number;
  failed: number;
  /** 取り込みは完了したが、incomingの元ファイルを移動/削除できなかった。 */
  leftover: number;
}

type IngestConfig = Pick<AppConfig, "watchDir" | "workDir" | "archiveDir" | "resize">;

/**
 * watchDir 直下の画像を取り込み、source_images と ocr_queue に登録する。
 * ファイル名の自然順(2.webp → 10.webp)でIDを振る。
 */
export async function ingestDirectory(db: DatabaseSync, config: IngestConfig, label: string | null): Promise<IngestResult> {
  mkdirSync(config.watchDir, { recursive: true });
  mkdirSync(config.workDir, { recursive: true });
  if (config.archiveDir) mkdirSync(config.archiveDir, { recursive: true });

  const entries = readdirSync(config.watchDir, { withFileTypes: true })
    .filter((e) => e.isFile() && IMAGE_EXTENSIONS.has(extname(e.name).toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));

  const result: IngestResult = { registered: 0, deferred: 0, failed: 0, leftover: 0 };

  for (const entry of entries) {
    const incomingPath = join(config.watchDir, entry.name);
    const tmpPath = join(config.workDir, `.ingest-${randomBytes(6).toString("hex")}.tmp.webp`);

    try {
      // 重要: DB登録が成功するまで、incomingのファイルには一切触れない(移動も削除もしない)。
      // DBがロック中などで登録に失敗しても incoming にファイルが残り続けるので、
      // 次回 ingest を実行した時に自然に再試行される。
      await resizeForOcr(incomingPath, tmpPath, config.resize.maxDimension);
      registerInDb(db, { label, fileName: entry.name, tmpPath, workDir: config.workDir });
    } catch (err) {
      safeUnlink(tmpPath);
      if (isBusyError(err)) {
        result.deferred++;
        console.warn(
          `取り込みを保留(DBが一時的にロック中): ${entry.name}\n` +
            `  DB Browser for SQLite等で書き込み中のトランザクションが残っていないか確認してください。\n` +
            `  incomingのファイルはそのままにしてあるので、次回 ingest 実行時に再試行されます。`,
        );
      } else {
        result.failed++;
        console.error(`取り込み失敗: ${incomingPath}`, err);
      }
      continue;
    }

    // ここまで来て初めて、incomingのファイルを消費済みとして扱う。
    try {
      if (config.archiveDir) {
        renameSync(incomingPath, uniqueDestination(config.archiveDir, entry.name));
      } else {
        // 正本は別の場所で管理されている前提なので、作業用コピーは削除して問題ない。
        unlinkSync(incomingPath);
      }
    } catch (err) {
      result.leftover++;
      console.error(
        `★ ${entry.name} の取り込みは完了しましたが、incomingのファイルを ${config.archiveDir ? "移動" : "削除"} できませんでした: ${(err as Error).message}\n` +
          `  手動で取り除かないと、次回の ingest で重複して取り込まれます。`,
      );
    }
    result.registered++;
  }
  return result;
}

/**
 * source_images と ocr_queue への登録、および作業ファイルの確定(リネーム)を
 * 1つのトランザクションで行う。どれかが失敗すれば全て巻き戻り、
 * 「キューに載っているのに画像が無い」状態は作らない。
 *
 * 作業ファイルの名前は `<id>-<ランダム8桁>.webp`。id を含めるのでDBの行との対応が目で追え、
 * ランダム部分があるので、DBを作り直した後などに古い作業ファイルが残っていても衝突しない
 * (同名ファイルが既にあれば別のランダム値を引き直し、既存ファイルは上書きしない)。
 */
function registerInDb(db: DatabaseSync, p: { label: string | null; fileName: string; tmpPath: string; workDir: string }): void {
  let finalPath: string | undefined;
  try {
    inTransaction(db, () => {
      const id = insertSourceImage(db, { label: p.label, fileName: p.fileName });
      finalPath = uniqueWorkPath(p.workDir, id);
      insertQueueItem(db, { sourceImageId: id, imagePath: finalPath });
      renameSync(p.tmpPath, finalPath);
    });
  } catch (err) {
    if (finalPath) safeUnlink(finalPath); // リネーム後にCOMMITが失敗した場合の後始末
    throw err;
  }
}

function uniqueWorkPath(workDir: string, id: number): string {
  for (let i = 0; i < 20; i++) {
    const candidate = join(workDir, `${id}-${randomBytes(4).toString("hex")}.webp`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`作業ファイル名を決められませんでした(id=${id})`);
}

function safeUnlink(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // 掃除に失敗しても致命的ではないので無視する
  }
}

function uniqueDestination(dir: string, filename: string): string {
  let candidate = join(dir, filename);
  if (!existsSync(candidate)) return candidate;

  const ext = extname(filename);
  const stem = basename(filename, ext);
  let i = 1;
  while (existsSync(candidate)) {
    candidate = join(dir, `${stem}_${i}${ext}`);
    i++;
  }
  return candidate;
}
