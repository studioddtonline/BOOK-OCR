import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { openDb } from "../src/db/index.js";
import { addImage, addQueue, makeProject, rows, row, runCli } from "./helpers.js";

async function png(path: string, w = 40, h = 30) {
  mkdirSync(join(path, ".."), { recursive: true });
  await sharp({ create: { width: w, height: h, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toFile(path);
}

function open(dbPath: string) {
  return openDb(dbPath, 1000);
}

// ---- init-db -------------------------------------------------------------

test("init-db: DBを作成し、v3スキーマになる", (t) => {
  const p = makeProject(t);
  const r = runCli("init-db", [], p.configPath);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DBを初期化しました/);
  assert.ok(existsSync(p.dbPath));
  const db = open(p.dbPath);
  assert.ok(row(db, "SELECT 1 FROM sqlite_master WHERE name = 'ocr_queue'"));
  db.close();
});

test("init-db: 設定ファイルが無ければエラー終了(スタックトレースなし)", (t) => {
  const p = makeProject(t);
  const r = runCli("init-db", [], p.configPath + ".missing");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /設定ファイルを読み込めませんでした/);
  assert.ok(!r.stderr.includes("    at "));
});

// ---- ingest --------------------------------------------------------------

test("ingest: 自然順でIDが振られ、作業ファイルとキューが作られ、元ファイルは消える", async (t) => {
  const p = makeProject(t);
  for (const n of ["10.png", "2.png", "1.png"]) await png(join(p.watchDir, n));
  const r = runCli("ingest", ["--label", "テスト本"], p.configPath);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /新規 3 件, 保留\(要再試行\) 0 件, 失敗 0 件/);
  assert.match(r.stdout, /ラベル: "テスト本"/);

  const db = open(p.dbPath);
  const imgs = rows<{ id: number; file_path: string; file_name: string; ocr_text: string | null; reviewed: number }>(
    db,
    "SELECT * FROM source_images ORDER BY id",
  );
  assert.deepEqual(imgs.map((i) => i.file_name), ["1.png", "2.png", "10.png"]);
  assert.ok(imgs.every((i) => i.file_path === "テスト本" && i.ocr_text === null && i.reviewed === 0));

  const q = rows<{ source_image_id: number; image_path: string; status: string }>(db, "SELECT * FROM ocr_queue ORDER BY id");
  assert.equal(q.length, 3);
  for (const item of q) {
    assert.equal(item.status, "pending");
    assert.match(item.image_path, new RegExp(`${item.source_image_id}-[0-9a-f]{8}\\.webp$`));
    assert.ok(existsSync(item.image_path));
    assert.ok(item.image_path.startsWith(p.workDir));
  }
  db.close();
  assert.deepEqual(readdirSync(p.watchDir), [], "元ファイルは削除される");
  assert.deepEqual(readdirSync(p.workDir).filter((f) => f.endsWith(".tmp.webp")), [], "一時ファイルは残らない");
});

test("ingest: --label= 形式も使える", async (t) => {
  const p = makeProject(t);
  await png(join(p.watchDir, "a.png"));
  assert.equal(runCli("ingest", ["--label=雑誌X"], p.configPath).status, 0);
  const db = open(p.dbPath);
  assert.equal(row<{ file_path: string }>(db, "SELECT file_path FROM source_images")!.file_path, "雑誌X");
  db.close();
});

test("ingest: ラベル省略時は NULL で、未指定の旨を表示する", async (t) => {
  const p = makeProject(t);
  await png(join(p.watchDir, "a.png"));
  const r = runCli("ingest", [], p.configPath);
  assert.match(r.stdout, /ラベル未指定で 1 件取り込みました/);
  const db = open(p.dbPath);
  assert.equal(row<{ file_path: null }>(db, "SELECT file_path FROM source_images")!.file_path, null);
  db.close();
});

test("ingest: 対応外の拡張子とサブディレクトリは無視される", async (t) => {
  const p = makeProject(t);
  await png(join(p.watchDir, "a.PNG".toLowerCase()));
  await png(join(p.watchDir, "UPPER.JPG".toLowerCase().replace("jpg", "png")));
  writeFileSync(join(p.watchDir, "notes.txt"), "x");
  await png(join(p.watchDir, "sub", "inner.png"));
  const r = runCli("ingest", [], p.configPath);
  assert.match(r.stdout, /新規 2 件/);
  assert.deepEqual(readdirSync(p.watchDir).sort(), ["notes.txt", "sub"]);
});

test("ingest: archiveDir を指定すると、元画像を移動する(同名は連番で衝突回避)", async (t) => {
  const p = makeProject(t, { archiveDir: undefined });
  const cfg = makeProject(t); // 別プロジェクトでは設定ファイルの差し替えが面倒なので、archive付きで作り直す
  void cfg;
  const root = p.root;
  const withArchive = join(root, "config-archive.json");
  writeFileSync(
    withArchive,
    JSON.stringify({
      watchDir: p.watchDir,
      workDir: p.workDir,
      dbPath: p.dbPath,
      archiveDir: p.archiveDir,
      priority: ["g"],
      providers: [{ name: "g", type: "gemini", model: "m", dailyRequestLimit: 10 }],
    }),
  );
  await png(join(p.watchDir, "a.png"));
  assert.equal(runCli("ingest", [], withArchive).status, 0);
  await png(join(p.watchDir, "a.png"));
  assert.equal(runCli("ingest", [], withArchive).status, 0);
  assert.deepEqual(readdirSync(p.archiveDir).sort(), ["a.png", "a_1.png"]);
  assert.deepEqual(readdirSync(p.watchDir), []);
});

test("ingest: 重複検出はしない(同じ画像を2回置くと2回取り込む)", async (t) => {
  const p = makeProject(t);
  await png(join(p.watchDir, "a.png"));
  runCli("ingest", [], p.configPath);
  await png(join(p.watchDir, "a.png"));
  runCli("ingest", [], p.configPath);
  const db = open(p.dbPath);
  assert.equal(row<{ c: number }>(db, "SELECT COUNT(*) c FROM source_images")!.c, 2);
  db.close();
});

test("ingest: 壊れた画像は失敗として数え、元ファイルは残る", async (t) => {
  const p = makeProject(t);
  await png(join(p.watchDir, "ok.png"));
  writeFileSync(join(p.watchDir, "broken.png"), "これは画像ではない");
  const r = runCli("ingest", [], p.configPath);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /新規 1 件, 保留\(要再試行\) 0 件, 失敗 1 件/);
  assert.deepEqual(readdirSync(p.watchDir), ["broken.png"]);
  const db = open(p.dbPath);
  assert.equal(row<{ c: number }>(db, "SELECT COUNT(*) c FROM source_images")!.c, 1, "失敗した画像はDBに登録されない");
  db.close();
});

test("ingest: 空ディレクトリでも正常終了", (t) => {
  const p = makeProject(t);
  const r = runCli("ingest", [], p.configPath);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /新規 0 件/);
});

test("ingest: 引数エラー(--label の値なし / 空ラベル / 不明な引数)は exit 1", (t) => {
  const p = makeProject(t);
  for (const args of [["--label"], ["--label", "--other"], ["--label", "  "], ["--bogus"]]) {
    const r = runCli("ingest", args, p.configPath);
    assert.equal(r.status, 1, JSON.stringify(args));
    assert.match(r.stderr, /使い方/);
  }
});

test("ingest: --help は使い方を表示して exit 0", (t) => {
  const p = makeProject(t);
  const r = runCli("ingest", ["--help"], p.configPath);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /使い方/);
});

test("ingest: 8桁ランダム付きの作業ファイル名はIDごとに衝突しない(複数回実行)", async (t) => {
  const p = makeProject(t);
  for (let i = 0; i < 3; i++) {
    await png(join(p.watchDir, "same.png"));
    runCli("ingest", [], p.configPath);
  }
  assert.equal(readdirSync(p.workDir).length, 3);
});

// ---- search --------------------------------------------------------------

function seedSearch(dbPath: string) {
  const db = open(dbPath);
  const ins = db.prepare("INSERT INTO source_images (file_path, file_name, ocr_text, reviewed) VALUES (?, ?, ?, ?)");
  ins.run("本A", "1.webp", "吾輩は猫である。名前はまだ無い。", 0);
  ins.run("本A", "2.webp", "どこで生れたか頓と見当がつかぬ。猫の話。", 1);
  ins.run("本B", "3.webp", "宮崎駿監督のアニメについて", 0);
  ins.run("本B", "4.webp", "宮崎駿監督の随筆", 0);
  ins.run(null, "5.webp", null, 0); // OCR未完了
  db.close();
}

test("search: 3文字以上は FTS で検索し、ラベル・ファイル名・抜粋を表示する", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  seedSearch(p.dbPath);
  const r = runCli("search", ["宮崎駿"], p.configPath);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /#3 本B \/ 3\.webp/);
  assert.match(r.stdout, /#4 本B \/ 4\.webp/);
  assert.match(r.stdout, /\[宮崎駿\]/);
  assert.match(r.stdout, /2件ヒット/);
});

test("search: 1〜2文字は LIKE にフォールバックして検索できる", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  seedSearch(p.dbPath);
  const r = runCli("search", ["猫"], p.configPath);
  assert.match(r.stdout, /#1 /);
  assert.match(r.stdout, /#2 \[レビュー済\] /);
  assert.match(r.stdout, /2件ヒット/);
});

test("search: スペース区切りの複数語は1つのフレーズとして検索する", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  seedSearch(p.dbPath);
  assert.match(runCli("search", ["吾輩は", "猫である"], p.configPath).stdout, /該当する結果はありません/);
  const db = open(p.dbPath);
  db.prepare("UPDATE source_images SET ocr_text = 'foo bar baz' WHERE id = 5").run();
  db.close();
  assert.match(runCli("search", ["foo", "bar"], p.configPath).stdout, /#5 /);
});

test("search: 該当なしのメッセージと --debug の案内", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  seedSearch(p.dbPath);
  const r = runCli("search", ["存在しない言葉"], p.configPath);
  assert.match(r.stdout, /該当する結果はありませんでした/);
  assert.match(r.stdout, /--debug/);
});

test("search: 引数なしは使い方を表示して exit 1", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  const r = runCli("search", [], p.configPath);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /使い方/);
});

test("search: 単独の -- は検索語に含めない", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  seedSearch(p.dbPath);
  assert.match(runCli("search", ["--", "宮崎駿"], p.configPath).stdout, /2件ヒット/);
});

test("search --debug: 診断情報と検索方式を表示する", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  seedSearch(p.dbPath);
  const r = runCli("search", ["猫", "--debug"], p.configPath);
  assert.match(r.stdout, /--- 診断情報 ---/);
  assert.match(r.stdout, /source_images 総数: 5/);
  assert.match(r.stdout, /LIKE\(全件走査、3文字未満のため\)/);
  const r2 = runCli("search", ["宮崎駿", "--debug"], p.configPath);
  assert.match(r2.stdout, /FTS5\(trigram\)/);
});

test("search --debug: 検索語なしでも診断だけ表示して正常終了", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  const r = runCli("search", ["--debug"], p.configPath);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /診断情報/);
});

test("search: 結果は最大50件", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  const db = open(p.dbPath);
  const ins = db.prepare("INSERT INTO source_images (file_name, ocr_text) VALUES (?, ?)");
  for (let i = 0; i < 60; i++) ins.run(`${i}.webp`, "共通のキーワード");
  db.close();
  assert.match(runCli("search", ["キーワード"], p.configPath).stdout, /50件ヒット/);
  assert.match(runCli("search", ["共"], p.configPath).stdout, /50件ヒット/);
});

// ---- search-advanced -----------------------------------------------------

test("search-advanced: --and / --not", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  seedSearch(p.dbPath);
  const r = runCli("search", ["--and", "宮崎駿,監督", "--not", "アニメ"], p.configPath);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /#4 /);
  assert.ok(!r.stdout.includes("#3 "));
  assert.match(r.stdout, /1件ヒット/);
});

test("search-advanced: --or と 短い語", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  seedSearch(p.dbPath);
  const r = runCli("search", ["--or", "随筆,頓と"], p.configPath);
  assert.match(r.stdout, /#2 /);
  assert.match(r.stdout, /#4 /);
  assert.match(r.stdout, /2件ヒット/);
});

test("search-advanced: --query に入れ子のJSONを渡せる", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  seedSearch(p.dbPath);
  const q = {
    type: "or",
    nodes: [
      { type: "and", nodes: [{ type: "term", value: "宮崎駿" }, { type: "not", node: { type: "term", value: "随筆" } }] },
      { type: "term", value: "吾輩は" },
    ],
  };
  const r = runCli("search", ["--query", JSON.stringify(q)], p.configPath);
  assert.match(r.stdout, /#1 /);
  assert.match(r.stdout, /#3 /);
  assert.match(r.stdout, /2件ヒット/);
});

test("search-advanced: 不正なJSON・不正な形式・条件なしは exit 1", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  const bad = runCli("search", ["--query", "{oops"], p.configPath);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /JSONが不正/);
  const shape = runCli("search", ["--query", '{"type":"and","nodes":[]}'], p.configPath);
  assert.equal(shape.status, 1);
  assert.match(shape.stderr, /形式と一致しません/);
  const blank = runCli("search", ["--and", " , "], p.configPath);
  assert.equal(blank.status, 1);
  assert.match(blank.stderr, /検索条件が指定されていません/);
  const missing = runCli("search", ["--query"], p.configPath);
  assert.equal(missing.status, 1);
});

test("search: --help は詳細検索の書き方を含む使い方を表示する", (t) => {
  const p = makeProject(t);
  const r = runCli("search", ["--help"], p.configPath);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /使い方/);
  assert.match(r.stdout, /--and/);
  assert.match(r.stdout, /--query/);
});

test("search-advanced --debug: 解釈したクエリ木と組み立てたSQLを表示", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  seedSearch(p.dbPath);
  const r = runCli("search", ["--and", "宮崎駿", "--debug"], p.configPath);
  assert.match(r.stdout, /解釈したクエリ木/);
  assert.match(r.stdout, /組み立てたSQL/);
  assert.match(r.stdout, /パラメータ/);
});

test("search: OCR未完了(ocr_textがNULL)の行を NOT で拾ってもクラッシュせず、結果にも出さない", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  seedSearch(p.dbPath);
  const r = runCli("search", ["--not", "宮崎駿"], p.configPath);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes("#5 "), "OCR未完了の行は結果に出さない");
  assert.match(r.stdout, /#1 /);
});

// ---- reindex -------------------------------------------------------------

test("reindex: 壊れた索引を作り直し、前後のトライグラム数を表示する", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  seedSearch(p.dbPath);
  const db = open(p.dbPath);
  db.exec(`INSERT INTO images_fts(images_fts) VALUES ('delete-all')`);
  db.close();
  assert.match(runCli("search", ["宮崎駿"], p.configPath).stdout, /該当する結果はありません/);
  const r = runCli("reindex", [], p.configPath);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /索引済みトライグラム数: 0 -> \d+ \(source_images総数: 5\)/);
  assert.match(runCli("search", ["宮崎駿"], p.configPath).stdout, /2件ヒット/);
});

// ---- 統合CLI(book-ocr) ---------------------------------------------------

test("book-ocr: 引数なし・help はコマンド一覧を表示する", (t) => {
  const p = makeProject(t);
  for (const args of [[], ["help"], ["--help"]]) {
    const r = spawnSync(process.execPath, ["--no-warnings", join(import.meta.dirname, "..", "src/cli/index.js"), ...args], {
      env: { ...process.env, CONFIG_PATH: p.configPath },
      encoding: "utf-8",
    });
    assert.equal(r.status, 0);
    for (const c of ["init-db", "ingest", "worker", "search", "status", "queue", "requeue", "rescue", "reindex"]) {
      assert.ok(r.stdout.includes(c), `${c} が一覧にある`);
    }
  }
});

test("book-ocr: 不明なコマンドは一覧つきのエラー(exit 1)", (t) => {
  const p = makeProject(t);
  const r = runCli("nope", [], p.configPath);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /不明なコマンドです: nope/);
  assert.match(r.stderr, /ingest/);
});

test("全コマンドで --help が使え、exit 0 で使い方を表示する", (t) => {
  const p = makeProject(t);
  for (const c of ["init-db", "ingest", "worker", "search", "status", "queue", "requeue", "rescue", "reindex"]) {
    const r = runCli(c, ["--help"], p.configPath);
    assert.equal(r.status, 0, `${c}: ${r.stderr}`);
    assert.match(r.stdout, /使い方/, c);
  }
});

test("全コマンドで、未知のオプションは使い方つきで exit 1", (t) => {
  const p = makeProject(t);
  for (const c of ["init-db", "ingest", "worker", "search", "status", "queue", "requeue", "rescue", "reindex"]) {
    const r = runCli(c, ["--no-such-option"], p.configPath);
    assert.equal(r.status, 1, c);
    assert.match(r.stderr, /使い方/, c);
  }
});

test("init-db: スキーマ番号が最新になり、status で確認できる", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  const r = runCli("status", [], p.configPath);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /スキーマ番号 (\d+) \/ 最新 \1/);
  assert.match(r.stdout, /source_images 総数: 0/);
});

test("search: 検索語と構造化フラグの同時指定、--query と --and の同時指定はエラー", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  assert.match(runCli("search", ["語", "--and", "x"], p.configPath).stderr, /同時に指定できません/);
  assert.match(runCli("search", ["--query", '{"type":"term","value":"x"}', "--and", "y"], p.configPath).stderr, /同時に指定できません/);
});

test("search --limit: 件数を絞れる。不正な値はエラー", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  seedSearch(p.dbPath);
  assert.match(runCli("search", ["宮崎駿", "--limit", "1"], p.configPath).stdout, /1件ヒット/);
  for (const bad of ["0", "abc", "-3", "1.5"]) {
    const r = runCli("search", ["宮崎駿", "--limit", bad], p.configPath);
    assert.equal(r.status, 1, bad);
  }
});

// ---- status / queue / requeue / rescue ----------------------------------

function seedQueue(dbPath: string) {
  const db = open(dbPath);
  const a = addImage(db, { fileName: "a.webp" });
  const b = addImage(db, { fileName: "b.webp" });
  const c = addImage(db, { fileName: "c.webp" });
  const qa = addQueue(db, a, "/img/a.webp", "error", 5);
  const qb = addQueue(db, b, "/img/b.webp", "pending");
  const qc = addQueue(db, c, "/img/c.webp", "error", 2);
  db.prepare("UPDATE ocr_queue SET error_message = 'テキストが返りませんでした' WHERE id IN (?, ?)").run(qa, qc);
  db.close();
  return { a, b, c, qa, qb, qc };
}

test("status: error の行を一覧し、retry の案内を出す", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  const s = seedQueue(p.dbPath);
  const r = runCli("status", [], p.configPath);
  assert.match(r.stdout, /pending=1, processing=0, error=2/);
  assert.match(r.stdout, new RegExp(`queue#${s.qa} source_image#${s.a} 失敗回数=5 : テキストが返りませんでした`));
  assert.match(r.stdout, /queue retry/);
});

test("queue list: 状態で絞り込める。不正な --status はエラー", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  const s = seedQueue(p.dbPath);
  const all = runCli("queue", ["list"], p.configPath);
  assert.match(all.stdout, new RegExp(`queue#${s.qa} .*\\[error\\]`));
  assert.match(all.stdout, new RegExp(`queue#${s.qb} .*\\[pending\\]`));
  const errors = runCli("queue", ["list", "--status", "error"], p.configPath);
  assert.ok(!errors.stdout.includes(`queue#${s.qb} `));
  assert.match(runCli("queue", ["list", "--status", "bogus"], p.configPath).stderr, /--status は/);
  assert.match(runCli("queue", ["list", "--status", "processing"], p.configPath).stdout, /該当する行はありません/);
});

test("queue retry: 指定した error の行を pending に戻し、失敗回数とメッセージをリセットする", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  const s = seedQueue(p.dbPath);
  const r = runCli("queue", ["retry", String(s.qa), String(s.qb), "9999"], p.configPath);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /pending に戻しました: 1 件/);
  assert.match(r.stdout, new RegExp(`#${s.qb}\\(pending\\)`), "error ではない行は触らない");
  assert.match(r.stdout, /#9999/);
  const db = open(p.dbPath);
  const q = row<{ status: string; retry_count: number; error_message: string | null }>(db, "SELECT * FROM ocr_queue WHERE id = ?", s.qa)!;
  assert.deepEqual([q.status, q.retry_count, q.error_message], ["pending", 0, null]);
  assert.equal(row<{ status: string }>(db, "SELECT status FROM ocr_queue WHERE id = ?", s.qc)!.status, "error", "指定していない行はそのまま");
  db.close();
});

test("queue retry --all-errors: error を全て pending に戻す", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  seedQueue(p.dbPath);
  const r = runCli("queue", ["retry", "--all-errors"], p.configPath);
  assert.match(r.stdout, /pending に戻しました: 2 件/);
  const db = open(p.dbPath);
  assert.equal(row<{ c: number }>(db, "SELECT COUNT(*) c FROM ocr_queue WHERE status = 'error'")!.c, 0);
  db.close();
});

test("queue: サブコマンドなし・queue_id なし・不正な queue_id はエラー", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  assert.equal(runCli("queue", [], p.configPath).status, 1);
  assert.match(runCli("queue", ["retry"], p.configPath).stderr, /queue_id か --all-errors/);
  assert.equal(runCli("queue", ["retry", "abc"], p.configPath).status, 1);
  assert.match(runCli("queue", ["retry", "1", "--all-errors"], p.configPath).stderr, /同時に指定できません/);
});

test("requeue: 既存の画像をキューに載せる(画像パスは絶対パスで保存される)", async (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  const db = open(p.dbPath);
  const id = addImage(db, { text: "古いOCR結果" });
  db.close();
  const img = join(p.root, "orig.png");
  await png(img);
  const r = runCli("requeue", [String(id), "--image", img], p.configPath);
  assert.equal(r.status, 0, r.stderr);
  const db2 = open(p.dbPath);
  const q = row<{ image_path: string; status: string }>(db2, "SELECT * FROM ocr_queue WHERE source_image_id = ?", id)!;
  assert.equal(q.status, "pending");
  assert.equal(q.image_path, img);
  db2.close();
  // 二重には載せない
  const again = runCli("requeue", [String(id), "--image", img], p.configPath);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /既にキューにあります/);
});

test("requeue: レビュー済み・存在しない行・存在しない画像・引数不足は拒否する", async (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  const db = open(p.dbPath);
  const reviewed = addImage(db, { text: "人間が直した", reviewed: 1 });
  db.close();
  const img = join(p.root, "orig.png");
  await png(img);
  assert.match(runCli("requeue", [String(reviewed), "--image", img], p.configPath).stderr, /レビュー済み/);
  assert.match(runCli("requeue", ["9999", "--image", img], p.configPath).stderr, /存在しません/);
  assert.match(runCli("requeue", [String(reviewed), "--image", join(p.root, "none.png")], p.configPath).stderr, /画像ファイルが見つかりません/);
  assert.match(runCli("requeue", [String(reviewed)], p.configPath).stderr, /--image/);
  assert.match(runCli("requeue", ["--image", img], p.configPath).stderr, /source_image_id/);
  const db2 = open(p.dbPath);
  assert.equal(row(db2, "SELECT 1 FROM ocr_queue"), undefined, "拒否した行はキューに載らない");
  db2.close();
});

test("requeue --force: error の行を、画像を差し替えて pending に戻す", async (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  const db = open(p.dbPath);
  const id = addImage(db);
  addQueue(db, id, "/old/path.webp", "error", 5);
  db.close();
  const img = join(p.root, "new.png");
  await png(img);
  assert.match(runCli("requeue", [String(id), "--image", img], p.configPath).stderr, /--force/);
  const r = runCli("requeue", [String(id), "--image", img, "--force"], p.configPath);
  assert.equal(r.status, 0, r.stderr);
  const db2 = open(p.dbPath);
  const q = row<{ image_path: string; status: string; retry_count: number }>(db2, "SELECT * FROM ocr_queue")!;
  assert.deepEqual([q.image_path, q.status, q.retry_count], [img, "pending", 0]);
  db2.close();
});

function writeRescue(path: string, entries: object[], extra = "") {
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n" + extra);
}

test("rescue apply: 退避された結果をDBに反映し、二重には反映しない", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  const db = open(p.dbPath);
  const id = addImage(db);
  addQueue(db, id, "/img", "processing");
  db.close();
  const file = join(p.root, "db", "rescue.jsonl");
  writeRescue(file, [
    { savedAt: "2026-01-01T00:00:00Z", queueId: 1, sourceImageId: id, ocrText: "救出された本文", provider: "g", model: "m", rawResponse: "{}", dbError: "x" },
  ]);

  const dry = runCli("rescue", ["apply", "--dry-run"], p.configPath);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /反映予定/);
  let d = open(p.dbPath);
  assert.equal(row<{ ocr_text: string | null }>(d, "SELECT ocr_text FROM source_images")!.ocr_text, null, "dry-run では書き込まない");
  d.close();

  const r = runCli("rescue", ["apply"], p.configPath);
  assert.match(r.stdout, /反映 1 件/);
  d = open(p.dbPath);
  assert.equal(row<{ ocr_text: string }>(d, "SELECT ocr_text FROM source_images")!.ocr_text, "救出された本文");
  assert.equal(row(d, "SELECT 1 FROM ocr_queue"), undefined);
  assert.equal(row<{ provider: string }>(d, "SELECT provider FROM ocr_log")!.provider, "g");
  d.close();

  const again = runCli("rescue", ["apply"], p.configPath);
  assert.match(again.stdout, /処理済みのためスキップ 1 件/);
});

test("rescue apply: ファイルが無ければ何もしない。形式不正の行は報告する。--file で別ファイルを指定できる", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  assert.match(runCli("rescue", ["apply"], p.configPath).stdout, /反映する結果はありません/);

  const file = join(p.root, "custom.jsonl");
  writeFileSync(file, "{ これはJSONではない\n");
  const r = runCli("rescue", ["apply", "--file", file], p.configPath);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /読み取れなかった行.*1 行目/);
  assert.equal(runCli("rescue", [], p.configPath).status, 1);
});

test("rescue apply: レビュー済みの行は上書きしない", (t) => {
  const p = makeProject(t);
  runCli("init-db", [], p.configPath);
  const db = open(p.dbPath);
  const id = addImage(db, { text: "人間の本文", reviewed: 1 });
  addQueue(db, id, "/img", "processing");
  db.close();
  const file = join(p.root, "db", "rescue.jsonl");
  writeRescue(file, [{ savedAt: "t", queueId: 1, sourceImageId: id, ocrText: "AIの本文", provider: "g", model: "m", rawResponse: "{}", dbError: "x" }]);
  const r = runCli("rescue", ["apply"], p.configPath);
  assert.match(r.stdout, /レビュー済みのため本文は上書きせず/);
  const d = open(p.dbPath);
  assert.equal(row<{ ocr_text: string }>(d, "SELECT ocr_text FROM source_images")!.ocr_text, "人間の本文");
  assert.equal(row<{ ocr_text: string }>(d, "SELECT ocr_text FROM ocr_log")!.ocr_text, "AIの本文");
  d.close();
});
