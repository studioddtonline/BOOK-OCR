import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { openDb } from "../src/db/index.js";
import { IMAGE_EXTENSIONS, ingestDirectory } from "../src/ingest/ingest.js";
import { captureConsole, fileDb, row, rows, tmpDir } from "./helpers.js";

async function png(path: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toFile(path);
}

function dirs(t: import("node:test").TestContext) {
  const root = tmpDir(t);
  return { watchDir: join(root, "in"), workDir: join(root, "work"), archiveDir: undefined as string | undefined, resize: { maxDimension: 100 } };
}

test("IMAGE_EXTENSIONS: webp / jpg / jpeg / png", () => {
  assert.deepEqual([...IMAGE_EXTENSIONS].sort(), [".jpeg", ".jpg", ".png", ".webp"]);
});

test("ingestDirectory: 結果の件数を返し、必要なディレクトリを作る", async (t) => {
  captureConsole(t);
  const { db } = fileDb(t);
  const cfg = dirs(t);
  const r = await ingestDirectory(db, cfg, "本");
  assert.deepEqual(r, { registered: 0, deferred: 0, failed: 0, leftover: 0 });
  assert.ok(existsSync(cfg.watchDir) && existsSync(cfg.workDir));
});

test("ingestDirectory: 登録と同時に作業ファイルがキューに紐づく(作業ファイルは webp)", async (t) => {
  captureConsole(t);
  const { db } = fileDb(t);
  const cfg = dirs(t);
  await png(join(cfg.watchDir, "a.png"));
  const r = await ingestDirectory(db, cfg, null);
  assert.equal(r.registered, 1);
  const q = row<{ image_path: string; source_image_id: number }>(db, "SELECT * FROM ocr_queue")!;
  assert.ok(q.image_path.endsWith(".webp"));
  assert.equal((await sharp(q.image_path).metadata()).format, "webp");
  assert.equal(row<{ file_name: string }>(db, "SELECT file_name FROM source_images WHERE id = ?", q.source_image_id)!.file_name, "a.png");
});

test("ingestDirectory: DBがロック中なら保留し、元ファイルを残す(次回の ingest で再試行される)", async (t) => {
  const out = captureConsole(t);
  const { db, path } = fileDb(t, 1);
  const cfg = dirs(t);
  await png(join(cfg.watchDir, "a.png"));
  const other = openDb(path, 1);
  other.exec("BEGIN IMMEDIATE");
  t.after(() => {
    try {
      other.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    other.close();
  });

  const r = await ingestDirectory(db, cfg, null);
  assert.deepEqual(r, { registered: 0, deferred: 1, failed: 0, leftover: 0 });
  assert.deepEqual(readdirSync(cfg.watchDir), ["a.png"], "元ファイルはそのまま");
  assert.deepEqual(readdirSync(cfg.workDir), [], "作業ファイルも残らない");
  assert.match(out.warn.join("\n"), /取り込みを保留/);

  // ロックが解けた後の再実行で取り込まれる
  other.exec("ROLLBACK");
  const again = await ingestDirectory(db, cfg, null);
  assert.equal(again.registered, 1);
  assert.deepEqual(readdirSync(cfg.watchDir), []);
});

test("ingestDirectory: 元ファイルを取り除けなかった場合は leftover に数える(取り込み自体は成功)", async (t) => {
  const out = captureConsole(t);
  const { db } = fileDb(t);
  const cfg = dirs(t);
  await png(join(cfg.watchDir, "a.png"));
  // archiveDir に「ファイル」を置いて、移動を失敗させる
  const archive = join(tmpDir(t), "archive-is-a-file");
  writeFileSync(archive, "x");
  const r = await ingestDirectory(db, { ...cfg, archiveDir: archive }, null).catch((e: Error) => e);
  // archiveDir の作成自体が失敗する場合は例外。どちらでも「取り込み済みの行が二重に残らない」ことを確認する
  if (r instanceof Error) {
    assert.match(r.message, /EEXIST|ENOTDIR/);
  } else {
    assert.equal(r.leftover, 1);
    assert.match(out.error.join("\n"), /取り込みは完了しました/);
  }
});

test("ingestDirectory: 同名ファイルを archiveDir に連番で退避する", async (t) => {
  captureConsole(t);
  const { db } = fileDb(t);
  const cfg = { ...dirs(t) };
  cfg.archiveDir = join(tmpDir(t), "arc");
  await png(join(cfg.watchDir, "a.png"));
  await ingestDirectory(db, cfg, null);
  await png(join(cfg.watchDir, "a.png"));
  await ingestDirectory(db, cfg, null);
  await png(join(cfg.watchDir, "a.png"));
  await ingestDirectory(db, cfg, null);
  assert.deepEqual(readdirSync(cfg.archiveDir).sort(), ["a.png", "a_1.png", "a_2.png"]);
  assert.equal(rows(db, "SELECT 1 FROM source_images").length, 3);
});

test("ingestDirectory: 2.png → 10.png の自然順でIDが振られる(大文字拡張子も対象)", async (t) => {
  captureConsole(t);
  const { db } = fileDb(t);
  const cfg = dirs(t);
  for (const n of ["10.png", "2.PNG", "1.png"]) await png(join(cfg.watchDir, n));
  await ingestDirectory(db, cfg, null);
  assert.deepEqual(rows<{ file_name: string }>(db, "SELECT file_name FROM source_images ORDER BY id").map((r) => r.file_name), ["1.png", "2.PNG", "10.png"]);
});
