import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mimeTypeForPath, readImageFile } from "../src/image-file.js";
import { tmpDir } from "./helpers.js";

test("mimeTypeForPath: 拡張子(大文字小文字を問わない)からMIMEタイプを決める", () => {
  assert.equal(mimeTypeForPath("/a/b.webp"), "image/webp");
  assert.equal(mimeTypeForPath("x.JPG"), "image/jpeg");
  assert.equal(mimeTypeForPath("x.jpeg"), "image/jpeg");
  assert.equal(mimeTypeForPath("x.PNG"), "image/png");
});

test("mimeTypeForPath: 不明な拡張子は(従来どおり)image/webp", () => {
  assert.equal(mimeTypeForPath("noext"), "image/webp");
  assert.equal(mimeTypeForPath("x.tiff"), "image/webp");
});

test("readImageFile: バイト列とMIMEタイプを返す", (t) => {
  const p = join(tmpDir(t), "a.png");
  writeFileSync(p, "abc");
  const img = readImageFile(p);
  assert.equal(img.bytes.toString(), "abc");
  assert.equal(img.mimeType, "image/png");
});

test("readImageFile: ファイルが無ければ例外", () => {
  assert.throws(() => readImageFile("/nonexistent/a.webp"), /ENOENT/);
});
