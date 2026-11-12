# Changelog

## 0.4.0 — リファクタリング

挙動を変えない構造の整理が中心です。変更点のうち、**利用者から見える違い**を先に挙げます。

### 利用者から見える変更

- **CLIを `book-ocr <コマンド>` に統合**(`src/cli/`)。`npm run` のスクリプト名は `init-db` / `ingest` / `worker` / `search` / `reindex` のまま使えます。
  `search:advanced` は廃止され、`search` に統合されました(`--and` / `--or` / `--not` / `--query` をそのまま `search` に渡す)。
  **systemd の `ExecStart` を `dist/cli/index.js worker` に変更してください**(旧 `dist/worker.js` は無くなりました)。
- 引数解析を `util.parseArgs` に統一。未知のオプションは、使い方つきのエラーになります。検索語が `-` で始まるときは `--` の後に書きます。
- **新コマンド**: `status`、`queue list` / `queue retry`、`requeue`、`rescue apply`。READMEに書かれていた手作業のSQL(失敗した行の再試行、
  再OCRのキュー投入、`rescue.jsonl` の反映)を置き換えます。`reviewed` の保護などのルールを、毎回コードが守ります。
- **DBはv3スキーマ専用**に。`migrate:v1-to-v2` / `migrate:v2-to-v3`、旧形式の config.json の検出・書き換え案内は削除しました。
  旧世代のDBに向けると、案内して止まります。
- **スキーマ管理を `PRAGMA user_version` + 番号つきマイグレーションに**。既存のv3 DBは、初回に開いたとき自動で最新になります
  (v0.4.0: `ocr_log` に `prompt_hash` / `request_options` の2列を追加)。`source_images` / `images_fts` / トリガーなど、
  MCPサーバとの契約部分は変更していません。
- `ocr_log` に、使ったプロンプトのハッシュと送った options を記録します。
- config.json のトップレベルも、未知のキーを拒否します(typoの検出)。`usageTimeZone`(使用量の「1日」の区切り。既定UTC)を追加しました。

### 依存関係

- `sharp` を 0.35.5 に(librsvg の脆弱性 GHSA-wq5f-xc86-pv6w)、`zod` を 4.6.6 以上に(巨大なコレクションの検証でメモリを使い切る問題 GHSA-mrhx-c7xc-m3w5)更新。`npm audit` は 0 件。

### バグ修正

- `search` の複合クエリが、OCR未完了(`ocr_text` が NULL)の行に当たるとクラッシュしていた(NOTだけのクエリなど)。
  NULLの行は結果に含めないようにしました。
- キューの格納先(`source_images`)が無い行を処理すると、`ocr_log` の外部キー違反でワーカーが落ちていた。
  キューの行だけを `error` にするようにしました。
- 再OCRで元画像(jpg/png)を渡しても、常に `image/webp` として送っていた。拡張子からMIMEタイプを決めるようにしました。
- ワーカーの保存リトライの待機が同期的(`Atomics.wait`)で、待っている間 SIGTERM に反応できなかった。非同期の待機にしました。
- 失敗の記録(`failQueueItem`)がDBロックで書けなかったとき、ワーカーが落ちていた。警告を出して続行し、行は次回起動時に `pending` に戻ります。

### 内部の構造

- `db.ts`(475行)を `db/` に分割。`reviewed` の判定は `isReviewed()` に一本化。
- プロバイダの選択・呼び出し・状態(無効化・枯渇・休止)を `ProviderPool` に集約。
- エラーの扱いを `worker/failure-policy.ts` の表に(READMEの表と1対1)。ワーカーを `preflight` / `save` / `report` に分割。
- 3つのアダプタの重複を `BaseProvider` に。画像はワーカーが1回だけ読み、`{bytes, mimeType}` で渡します。ベンダー追加は「アダプタ1つ + レジストリに1行」。
- 検索を `searchImages()`(サービス層)に集約し、`search` と `search-advanced` の重複(型・`escapeLike`・上限50件の直書き)を解消。
- CLIは引数解析と表示だけにして、ロジックを関数として切り出しました(テスト可能)。
- テストを追加(0件 → 330件、Node標準の `node:test`、外部APIには接続しない)。
