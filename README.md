# book-ocr

書籍・雑誌のスキャン画像を、AI(Gemini / OpenAI / Anthropic)でOCRし、
SQLite + FTS5(trigram)で全文検索できるようにするツールです。GPUは不要です。

## 前提

- Node.js 24系(`node --version` で確認)
- Linux(Ubuntu系)想定。systemdでの常駐運転を前提にしています
- **DBはv3スキーマのみ対応です**(旧世代のDBは、旧バージョン(v0.3.x)の `migrate` コマンドでv3にしてから使ってください。「9. スキーマ番号」参照)

## 1. セットアップ

```bash
cd book-ocr
npm install
npm run build

cp .env.example .env     # 使うプロバイダのAPIキーを入れる(GEMINI_API_KEY など)
cp config.example.json config.json   # パスやプロバイダを自分の環境に合わせる(次章)
npm run init-db
```

すべての操作は `book-ocr <コマンド>` という1つのCLIにまとまっています(`npm run <コマンド> -- <引数>` で呼べます)。

| コマンド | 内容 |
|---|---|
| `ingest [--label 名前]` | `watchDir` の画像を取り込み、OCR待ちキューに登録する |
| `worker` | キューを順に処理し続ける(常駐) |
| `search <語> / --and/--or/--not/--query` | OCR結果の全文検索 |
| `status` | DBの状態と、`error` の行を表示する |
| `queue list / queue retry` | キューの確認、失敗した行の再試行 |
| `requeue <id> --image <画像>` | 既存の画像を再OCRのためにキューへ載せる |
| `rescue apply` | DB保存に失敗して退避された結果を、DBに反映する |
| `reindex` | 全文検索の索引を作り直す |
| `init-db` | DBの作成・マイグレーション適用(他のコマンドも自動で行う) |

`book-ocr <コマンド> --help` で、各コマンドの詳しい使い方が表示されます。
`worker` 以外はAPIキーを使わないので、`.env` が無くても動きます(`--env-file-if-exists` を使っています)。
`worker` だけは、`priority` に挙げたプロバイダのキーが必要です。

`npm install` 時に `node-domexception` の非推奨警告が1件出ますが、`@google/genai` の
深い依存の先にあるもので、脆弱性ではなく無視して問題ありません。

## 2. config.json の書き方

```json
{
  "watchDir": "/home/you/book-scans/incoming",
  "workDir":  "/home/you/book-scans/resized",
  "dbPath":   "/home/you/book-scans/db/library.sqlite3",
  "priority": ["gemini35fl"],
  "providers": [
    { "name": "gemini35fl", "type": "gemini", "model": "gemini-3.5-flash-lite",
      "dailyRequestLimit": 480, "options": { "temperature": 0.1 } },
    { "name": "gemini37f",  "type": "gemini", "model": "gemini-3.7-flash",
      "dailyRequestLimit": 20, "options": {} }
  ]
}
```

**未知のキーは拒否されます**(typoを黙って無視しないため。例: `pollIntervalMS` と書くとエラーになります)。

| キー | 意味 |
|---|---|
| `watchDir` | `ingest` が見る入力フォルダ(`incoming`)。直下の画像だけを見ます |
| `workDir` | OCR用にリサイズした作業ファイルの置き場。OCR済みのファイルは手動で消して構いません。**OCR待ち(`pending`)のファイルは消さないでください**(消すと、そのキューの行は「画像ファイルが見つかりません」で `error` になります) |
| `dbPath` | SQLiteファイル |
| `archiveDir` | (省略可)指定すると、取り込んだ元画像をここへ移動します。省略時は取り込み後に `watchDir` のコピーを削除します(正本は別の場所にある前提) |
| `priority` | **使うプロバイダの `name` を優先順に並べる**。`providers` に書いてあっても、ここに無いものは使われません |
| `providers[]` | プロバイダ(= アダプタ + モデル + 設定)の定義。下記 |
| `pollIntervalMs` | 1件処理するごとに空ける間隔(既定30000)。キューが空のときの待機間隔も兼ねます |
| `dbBusyTimeoutMs` | DBがロックされているときにSQLiteが自動で待つ時間(既定20000) |
| `resize.maxDimension` | 作業ファイルの長辺の最大px(既定1800) |
| `usageTimeZone` | プロバイダの「1日」の区切り(使用量の集計・枯渇フラグの日付)に使うタイムゾーン。IANA名(既定 `"UTC"`)。無料枠のリセット時刻に合わせたいときに指定します(例: `"America/Los_Angeles"`)。**途中で変えると、その日の使用量は新しい日付で数え直しになります** |

### providers の各エントリ

| キー | 意味 |
|---|---|
| `name` | 自由に付ける名前。`priority`・使用量の集計・ログ・`ocr_log` ではこの名前を使います |
| `type` | `gemini` / `openai` / `anthropic`。**ベンダー単位のアダプタ**を選びます(モデルの世代では分けません) |
| `model` | モデルID |
| `dailyRequestLimit` | 1日あたりの使用上限の目安。超えたら翌日までそのプロバイダを休ませます |
| `options` | **モデル固有のオプション。SDKのリクエスト設定にそのまま渡されます** |

同じ `type` のエントリを何個でも並べられます。モデルを切り替えたいときは、`priority` を書き換えるだけです
(例: `"priority": ["gemini37f", "gemini35fl"]` で、3.7を先に使い、上限に達したら3.5に回す)。

### options は「書いたものだけ」送られる

- コード側ではモデルごとの分岐を一切しません。`options` の中身は検証されず、そのままSDKに渡されます
  (Gemini は `config`、OpenAI / Anthropic はリクエストの最上位に展開)。`model` と `messages` は上書きされません。
  Anthropic の `max_tokens` だけは必須なので既定で4096が入り、`options` で上書きできます。
- **書いていない項目は送られません。** たとえば `temperature` を書かなければ、各社・各モデルの既定値で動きます。
  OCRは創造性より再現性が重要なので、受け付けるモデルでは `"temperature": 0.1`(または0)を推奨します。
  起動時に、各プロバイダが実際に送る `options` がログに表示されます。
- **受け付けないオプションを書くと、実行時に400エラーになります**(設定エラーとして検出され、そのプロバイダは
  そのプロセスの間は無効化されます。画像は失われず、API側のメッセージ原文が表示されます)。
  - OpenAI の gpt-5 系(推論モデル)は `temperature` を受け付けません(既定値以外は400)。書かないでください。
  - Claude の `temperature` は 0.0〜1.0 です(OpenAI / Gemini は 0.0〜2.0)。
  - Gemini は新しいモデルで `temperature` が廃止されることがあります。400になったら `options` から外してください。

## 3. 使い方

### 画像を取り込む(ingest)

`watchDir` にWebP等の画像(`.webp` `.jpg` `.jpeg` `.png`)を置いて実行します。

```bash
npm run ingest -- --label foobaa
```

- `--label <名前>` は、この実行で取り込む全ての画像の `source_images.file_path` に入る**本の名前などのラベル**です。
  DBビューアでの絞り込み用で、実ファイルのパスではありません。
  **省略するとNULL**のままで、終了時に「ラベル未指定で◯件取り込みました」と表示されます。
  後から `file_path IS NULL` で絞り込んで入力できます。
- 画像1枚ごとに `source_images` に1行(`file_name` に元のファイル名)、`ocr_queue` にOCR待ちの1行が登録されます。
  ファイル名の自然順(`2.webp` → `10.webp`)で `id` が振られます。
- 作業ファイルは `workDir/<id>-<ランダム8桁>.webp` という名前になります。ランダム部分があるので、
  掃除を忘れて古いファイルが残っていても、DBを作り直して `id` が1に戻っても**衝突しません**
  (同名ファイルがあれば別の名前を引き直し、既存ファイルは上書きしません)。
- DB登録と作業ファイルの確定は1つのトランザクションです。**DB登録が成功するまで `watchDir` のファイルには触れない**ので、
  DBがロックされていて保留になっても、ファイルは残り、次回の `ingest` で自然に回収されます。
- **重複検出はありません。** 同じ画像を2回置くと2回取り込まれます。

### OCRワーカーを動かす(worker)

```bash
npm run worker
```

`ocr_queue` の `pending` を1件ずつ処理し、結果を `source_images.ocr_text` に書いて、成功したキューの行を消します。
Ctrl+C / SIGTERM で、待機中でもすぐに停止します。

起動時に、**使用するプロバイダと実際に送る `options`、キューの内訳、`error` の行**が表示されます。
人間の対応が必要な行は、ここと、`error` になった時点のログに出ます(`book-ocr status` でもいつでも見られます)。

systemdで常駐させる例:

```ini
# /etc/systemd/system/book-ocr-worker.service
[Unit]
Description=Book OCR Worker
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/book-ocr
ExecStart=/usr/bin/node --env-file-if-exists=.env dist/cli/index.js worker
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now book-ocr-worker
journalctl -u book-ocr-worker -f   # ログ確認
```

#### エラーの扱い

| 種類 | 例 | 失敗回数 | 動作 |
|---|---|---|---|
| サーバー側の一時エラー | 5xx、タイムアウト、ネットワーク断 | **数えない** | 画像は `pending` に戻り、そのプロバイダを**1分→2分→4分…最大10分**休ませる(成功で元に戻る) |
| レート制限 | 429 | 数えない | そのプロバイダを本日分「枯渇」にして次のプロバイダへ。全て枯渇なら5分待機 |
| 設定エラー | 400/401/403/404 | 数えない | そのプロバイダをこのプロセスの間は無効化。全て無効化されたら終了(終了コード1) |
| 画像側の問題 | 応答にテキストが無い(安全フィルタ等)、画像が読めない | **数える** | 5回で `status='error'` にして、人間の確認待ち |

つまり、`error` になるのは「その画像自体に問題がありそうなもの」だけです。5xxが何時間続いても、
画像は `pending` のまま待つだけで、`error` に落ちたり失われたりしません。
また、APIを呼ぶ前に分かる問題(`reviewed` が0以外、画像ファイルが無い、格納先の行が無い)は、**APIを呼ばずに** `error` にします。
この表はコードの `src/worker/failure-policy.ts` と1対1に対応しています。

`error` の行は、原因を解消した上で、次のようにして再試行できます。

```bash
npm run queue -- list --status error        # error の行を見る
npm run queue -- retry 123                  # queue#123 を pending に戻す(失敗回数もリセット)
npm run queue -- retry --all-errors         # error を全て戻す
```

OCR成功後のDB保存だけがロックで失敗した場合は、数回リトライした上で、それでも失敗すれば
`<dbPathと同じディレクトリ>/rescue.jsonl` に結果を退避します(APIの枠を消費して得た結果を失わないための保険)。
キューの行は処理中のまま残り、次回の起動時に `pending` に戻ります。DBが復旧したら、次のコマンドで反映できます。

```bash
npm run rescue -- apply --dry-run    # 反映される予定の件数だけを見る
npm run rescue -- apply
```

キューに行が残っているもの(= まだ結果が入っていないもの)だけを反映し、反映した行はキューから消えるので、
同じファイルを何度実行しても二重には反映されません。既に再OCRで新しい結果がある行は、古い結果で上書きしません。
レビュー済みの行は上書きせず、AIの出力だけを `ocr_log` に残します。

#### 再OCRの手順

```bash
npm run requeue -- 1536 --image /path/to/original/110-111.webp
```

- `1536` は結果の格納先(`source_images.id`)で、worker は終わるとその行の `ocr_text` を上書きします。
- `--image` は「AIに送る画像」です。オリジナルでもリサイズ済みでも構いません(workerはリサイズしません)。
  画像のMIMEタイプは拡張子(`.webp` `.jpg` `.png`)から決めます。
- 同じ行が既に `pending` / `processing` でキューにある場合は、二重に載せません。`error` で残っている場合は、
  `--force` を付けると画像を差し替えて `pending` に戻します。
- **`reviewed` が0以外の行は拒否されます**(1でも-1でも2でも同じです。MCPサーバと同じ解釈で、0/1以外の値が
  入っていても人間の本文を守る側に倒します)。人間が直した `ocr_text` は `source_images` にしか無く、取り戻せないためです。
  OCRの最中にMCPサーバ等が `reviewed` を立てた場合も、保存は `UPDATE ... WHERE reviewed = 0` で行うので上書きされません
  (そのときもAIの出力は `ocr_log` に残り、キューの行は `error` になります)。
  本当に再OCRしたいときは、先に `UPDATE source_images SET reviewed = 0 WHERE id = ...;` してから `requeue` してください。
- 再OCRが成功すると、`ocr_text` は新しい結果で上書きされます。以前のAI出力は `ocr_log` に履歴として残ります。
  `ocr_log` には、使った**プロンプトのハッシュ**(`prompt_hash`)と、SDKに送った **options**(`request_options`)も
  記録されるので、プロンプトやモデル設定を変えた後で「どの出力がどの条件で作られたか」を区別できます。

### 検索する(search)

```bash
npm run search -- 検索したい語句
```

検索は完全一致の部分文字列検索です(形態素解析はしていません)。結果は
`#id [レビュー済] <file_path(本の名前)> / <file_name>` と、該当箇所の抜粋で表示されます(既定で最大50件。`--limit N` で変更)。

- **3文字以上**: FTS5(trigram)の索引を使います(関連度順)。
- **1〜2文字**: trigramは3文字未満から索引を作れず常に0件になるため、自動的に `LIKE` の全件走査にフォールバックします
  (数千件規模なら速度は問題になりません)。
- スペース区切りで複数の語を渡すと、スペースも含めた**1つのフレーズ**として検索します(AND検索ではありません)。
  AND/OR/NOTは下の詳細検索を使ってください。
- 検索語が `-` で始まるときは、`--` の後に書きます(`npm run search -- -- -foo`)。
- OCR未完了(`ocr_text` がNULL)の行は、検索結果に含まれません。

0件のときは、`--debug` を付けると、`source_images` の件数・OCR済み件数・レビュー済み件数・キューの内訳、
**実際に索引済みのトライグラム数**(`fts5vocab` で検証。外部contentテーブルの素朴な `COUNT(*)` は
実際の索引状態を反映しないため)、実際に使われた検索語と検索方式が表示されます。
検索は `ocr_text` と索引だけを見るので、`books` / `pages` の書誌情報が未入力でも検索には影響しません。

索引がずれたと疑われる場合は、いつでも再構築できます(データは失われません。実行中は書き込みロックを取るので、
MCPサーバ等の書き込みが一時的に待たされます)。

```bash
npm run reindex
```

### AND/OR/NOTを使った詳細検索

```bash
# カジュアルな書き方(カンマ区切り): 宮崎と監督を両方含み、アニメは含まない
npm run search -- --and "宮崎,監督" --not "アニメ"

# 生のJSON(AND/OR/NOTを任意の深さでネストできる。Web UIのバックエンドが組み立てて渡す形式)
npm run search -- --query '{"type":"or","nodes":[...]}'

npm run search -- --help   # 書き方の詳細
```

内部では `src/search/query.ts` がクエリ木の各語を、3文字以上なら索引を使うサブクエリ、3文字未満なら `LIKE` に変換し、
組み立てはSQLの `AND` / `OR` / `NOT` で行います(FTS5自身の `NOT` は2項演算子限定などの制約があるため使いません)。
`--query` のJSONは `QueryNode` 型そのものなので、Web UI等を作る際は同じオブジェクトを `searchImages()`
(`src/search/service.ts`)に渡せます。

### DB Browser for SQLite で開いているとき

`ingest` / `worker` が書き込もうとしたとき、DB Browser が書き込みトランザクション(編集中・未保存)を持っていると、
一時的にロックされます。`dbBusyTimeoutMs` の間はSQLiteが自動で待ちます。それを超えると、`ingest` はファイルを消費せず保留に、
`worker` は上記の `rescue.jsonl` への退避になります。編集したら「Write Changes」で確定し、閲覧だけなら編集モードに入らないのが安全です。

## 4. データベース構造

```
source_images   閲覧・検索の対象。1画像=1レコードで、5列だけ。
                  id         連番(再OCRの格納先、pages等の参照先)
                  file_path  本の名前などのラベル(ingest --label で入る。列名は歴史的経緯でfile_pathのまま)
                  file_name  元のファイル名
                  ocr_text   OCR結果(人間が直したものもここ)
                  reviewed   0 = 未レビュー、0以外 = レビュー済み(workerもMCPサーバも上書きしない)
ocr_queue       OCR待ちのキュー。worker用の状態はここに分離してある。成功した行は消える。
                  source_image_id(UNIQUE)  結果の格納先
                  image_path               AIに送る画像の実パス
                  status                   pending / processing / error
                  retry_count, error_message, created_at
images_fts      source_images.ocr_text のFTS5(trigram)索引。トリガーで自動更新
ocr_log         OCR試行の全履歴(成功・失敗を問わず追記)。生のAPIレスポンス(raw_response)はここだけ。
                  provider には config の name が入る
                  prompt_hash      使ったプロンプトのハッシュ(プロンプト変更の追跡用)
                  request_options  SDKに送った options(JSON)
books / pages   書誌情報・ページ構造。後から人間が入力する(Web UI等で使う想定)。pagesは source_images.id を参照
provider_usage  プロバイダ(name)ごとの当日リクエスト数・枯渇フラグ(「当日」は usageTimeZone で決まる)
```

```sql
-- ラベルをまだ付けていない画像
SELECT id, file_name FROM source_images WHERE file_path IS NULL;

-- ある本の、未レビューのもの
SELECT id, file_name, ocr_text FROM source_images WHERE file_path = 'foobaa' AND reviewed = 0;

-- ある画像のOCR試行履歴(失敗も含めて)
SELECT * FROM ocr_log WHERE source_image_id = 123 ORDER BY id;
```

## 5. 開発

```bash
npm run build       # dist/ にビルド
npm test            # テストをビルドして実行(Node標準の node:test。外部のAPIには接続しません)
npm run typecheck   # 型チェックのみ
```

ソースの構成:

```
src/
  cli/              CLIの入口(index.ts)と各サブコマンド(commands/)。引数解析と表示だけで、処理本体は持たない
  db/               DB層。connection / migrations / queue / source-images / ocr-log / usage / fts
  providers/        AIプロバイダ。base(共通)・gemini/openai/anthropic(各社アダプタ)・registry(生成)・
                    errors(エラー分類)・health(休止)・pool(選択・呼び出し・状態更新)
  worker/           OCRワーカー。worker(主ループ)・failure-policy(エラーの扱い表)・preflight・save・report
  search/           検索。query(検索木→SQL)・service(searchImages)・snippet・format・diagnostics
  ingest/           取り込み(ingest)と画像のリサイズ(resize)
  rescue.ts         rescue.jsonl の退避と反映
  config.ts, errors.ts, image-file.ts, ocr/prompt.ts
test/               テスト(src の各モジュールに対応。cli-e2e は別プロセスでCLIを実行)
```

- **ベンダーを追加する**: `providers/` にアダプタを1つ書き(`BaseProvider` を継承し、`request()` だけ実装)、
  `providers/registry.ts` に1行、`config.ts` の `PROVIDER_TYPES` に名前を足します。
- **エラーの扱いを変える**: 種類ごとの扱いは `worker/failure-policy.ts` の表、プロバイダ側の状態更新(無効化・枯渇・休止)は
  `providers/pool.ts` の `attempt()` にあります。
- **スキーマを変える**: `db/migrations.ts` の `MIGRATIONS` に、番号つきの `up` を追加します(`PRAGMA user_version` で管理。
  各 `up` は何度実行しても安全に書き、`source_images` / `images_fts` / トリガーには触れないこと。次章)。

## 6. 他のツール(MCPサーバ等)と同じDBを使うとき

このDBは、別プロジェクトの **ocr-mcp-server** からも読み書きされます(`ocr_text` の編集と、編集履歴 `mcp_ocr_edit_history` の記録)。
**このプロジェクトが守る約束**は次のとおりです(`db/migrations.ts` の先頭コメントと、`test/db-schema.test.ts` の「契約」テストにも書いてあります)。

- **`mcp_ocr_edit_history` を作らない・触らない。** MCPサーバが自分で作って管理するテーブルです(`init-db`・マイグレーション・`reindex` は一切触れません)。
- **`source_images.id` を変えない。** 履歴は `source_image_id` を**外部キー無しの素の整数**で持っているため、`id` が変わると
  履歴が黙って孤児になります。
- **MCPサーバが検証・依存している形を維持する。** `source_images` の5列(`id` / `file_path` / `file_name` / `ocr_text` / `reviewed`)、
  `images_fts` がFTS5(trigram)で `MATCH` できること、`ocr_text` の更新トリガー(`source_images_ai` / `_ad` / `_au`)。
  MCPサーバは索引を直接触らず、トリガーに任せています。スキーマを変えるときは、相手側と合わせてください。
- **`reviewed` は「0 = 未レビュー、0以外 = レビュー済み」。** workerも、MCPサーバと同じく0以外を上書きしません。

**運用上の注意**:

- **新しいバージョンに更新して最初にDBを開いたとき**、未適用のマイグレーションが自動で適用されます(v0.4.0では `ocr_log` に
  2列を追加。一瞬の書き込みロックを取ります)。**念のため、DBファイルのバックアップを取ってから**、worker と MCPサーバを止めて
  実行してください。`source_images` / `images_fts` / トリガーには触れないので、MCPサーバは再起動すればそのまま動きます。
- **`reindex` は書き込みロックを取ります。** その間、MCPサーバの書き込み(busy timeout 500ms)は一時的に
  `database_busy` になります(クライアント側で再試行できます)。
- **DBファイルのバックアップは、worker と MCPサーバの両方を止めてから行ってください。**
  稼働中の書き込みがあるとファイルコピーが不完全になる可能性があります。
- **`source_images` の行を削除しても、`mcp_ocr_edit_history` の履歴は自動では消えず、孤児として残ります**(外部キーが無いため)。
- **`INSERT OR REPLACE` / `REPLACE` で `source_images` を書き換えない**でください。`DELETE` トリガーが発火せず、索引がずれます
  (ずれたら `npm run reindex`)。通常の `INSERT` / `UPDATE` / `DELETE` はすべてトリガーを通ります。
- workerの再OCRが `ocr_text` を上書きするとき(`reviewed` が0の行のみ)、**上書き前の本文を保存する仕組みはありません。**
  直前の本文がAIの出力なら `ocr_log` に、MCP経由で直した本文なら `mcp_ocr_edit_history` の最後の `new_text` に残っています。
  復元できないのは、DB Browser等で直接直したのに `reviewed` を立て忘れた本文だけです。

## 7. モデル名・無料枠について(重要・要確認)

AIプロバイダのモデル名・無料枠の条件は**数ヶ月単位で頻繁に変わります**。Gemini 2.5世代は2026年9月時点で
新規ユーザー向けに提供終了しており、404エラーになります。実行前に必ず最新のモデル一覧を確認してください。

- Gemini: https://ai.google.dev/gemini-api/docs/models
- OpenAI: https://platform.openai.com/docs/models
- Anthropic: https://docs.claude.com/en/docs/about-claude/models

`config.example.json` のモデル名・`dailyRequestLimit`・`options` は**作成時点の目安**です。

### Geminiの無料枠はモデルで大きく違う

2026年9月時点の調査では、Geminiの無料枠のRPD(1日あたりのリクエスト数)は、Flash系で約20、Flash-Lite系で約500と、
**モデルによって25倍の差**がありました。数千枚をOCRする用途では決定的な差です(20/日なら数年、500/日なら1〜2週間)。
OCRは高度な推論を必要としないため、まず Flash-Lite で回し、読めなかったものだけ上位モデルに回す、という使い分けができます。
`name` ごとに使用量を数えるので、`"priority": ["gemini35fl"]` で回しておき、必要なときだけ
`"priority": ["gemini37f"]` に書き換える、といった運用ができます。

ただしGoogleは無料枠の数値を公式ドキュメントに載せなくなっており、上記は実測ベースの非公式情報です。
自分のキーの実際の枠は Google AI Studio で確認してください。厳密でなくても、APIが429を返せばworkerが自動検知して翌日まで待ちます。

### OpenAI / Anthropic

この2社は恒常的な無料枠がなく、従量課金または期間限定クレジットが基本です。`config.example.json` では、
`priority` に入れていません。使う場合のみ `priority` に追加してください(`.env` に該当のAPIキーが必要です)。

## 8. 既知の制約

- 画像1枚あたりのページ数(単ページ/見開き/折込み)は判定させず、常に「1画像=1テキストブロック」として保存します。
  ページの切れ目・ページ番号との対応付けは `pages` テーブルを使って人間が後から行う想定です。
- AIの出力は、劣化したスキャンでは誤りが多く、自己申告(`■` や `{{ }}`)も当てになりません。
  確実なテキストが必要な場合は人間のレビューが必要で、レビューしたら `reviewed = 1` にします(0以外ならレビュー済みとして扱われます)。
- 取り込み時の重複検出はありません。

## 9. スキーマ番号(マイグレーション)

DBのスキーマは `PRAGMA user_version` で管理します(`book-ocr status` で現在の番号と最新が見られます)。

- 新規DB・既存のv3 DBとも、開くと未適用のマイグレーションが自動で適用されます。各マイグレーションは1トランザクションで、
  失敗したらそのマイグレーションだけが巻き戻ります。
- **v3より古い世代のDB**(`source_images` に `raw_response` / `content_hash` がある)に向けると、何も壊さずに案内して止まります。
  旧バージョン(v0.3.x)の `migrate:v1-to-v2` → `migrate:v2-to-v3` でv3にしてから使ってください(このバージョンには移行コマンドは含まれません)。
- **このバージョンより新しいスキーマ番号のDB**は、拒否します(ツールを更新してください)。
