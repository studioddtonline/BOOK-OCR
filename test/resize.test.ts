import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { resizeForOcr } from "../src/ingest/resize.js";
import { tmpDir } from "./helpers.js";

async function make(path: string, w: number, h: number, orientation?: number) {
  let img = sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 200, b: 200 } } }).jpeg();
  if (orientation) img = img.withMetadata({ orientation });
  await img.toFile(path);
}

test("大きい画像は、長辺が maxDimension に収まるよう縮小される(縦横比は維持)", async (t) => {
  const dir = tmpDir(t);
  const input = join(dir, "big.jpg");
  const out = join(dir, "out.webp");
  await make(input, 4000, 3000);
  await resizeForOcr(input, out, 1800);
  const m = await sharp(out).metadata();
  assert.equal(m.format, "webp");
  assert.equal(m.width, 1800);
  assert.equal(m.height, 1350);
});

test("縦長でも長辺が maxDimension", async (t) => {
  const dir = tmpDir(t);
  await make(join(dir, "tall.jpg"), 3000, 6000);
  await resizeForOcr(join(dir, "tall.jpg"), join(dir, "o.webp"), 1800);
  const m = await sharp(join(dir, "o.webp")).metadata();
  assert.deepEqual([m.width, m.height], [900, 1800]);
});

test("小さい画像は拡大しない", async (t) => {
  const dir = tmpDir(t);
  await make(join(dir, "s.jpg"), 800, 600);
  await resizeForOcr(join(dir, "s.jpg"), join(dir, "o.webp"), 1800);
  const m = await sharp(join(dir, "o.webp")).metadata();
  assert.deepEqual([m.width, m.height], [800, 600]);
});

test("Exif の向きを補正する(回転後の寸法になる)", async (t) => {
  const dir = tmpDir(t);
  await make(join(dir, "r.jpg"), 200, 100, 6);
  await resizeForOcr(join(dir, "r.jpg"), join(dir, "o.webp"), 1800);
  const m = await sharp(join(dir, "o.webp")).metadata();
  assert.deepEqual([m.width, m.height], [100, 200]);
});

test("出力先のディレクトリが無ければ作る", async (t) => {
  const dir = tmpDir(t);
  await make(join(dir, "a.jpg"), 10, 10);
  const out = join(dir, "deep", "er", "o.webp");
  await resizeForOcr(join(dir, "a.jpg"), out, 100);
  assert.ok(existsSync(out));
});

test("入力が画像でなければ例外", async (t) => {
  const dir = tmpDir(t);
  await assert.rejects(resizeForOcr(join(dir, "nope.jpg"), join(dir, "o.webp"), 100));
});
