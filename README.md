# OpenGeekLLMChat

<div align="center">
ギークのためのブラウザベース・ローカルLLMチャットアプリ。GPU監視・RAG・Web検索・Python実行を統合。
llama.cpp と React 1ファイル、Node.js サーバー1ファイル。ビルド不要、依存は最小（express + ws のみ）。
<br /><br />

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![llama.cpp](https://img.shields.io/badge/llama.cpp-OpenAI%20Compatible-blue)](https://github.com/ggml-org/llama.cpp)
[![Self-Hosted](https://img.shields.io/badge/Self--Hosted-100%25-blueviolet)](#)
[![No Cloud](https://img.shields.io/badge/No%20Cloud-ever-red)](#)

<!-- スクリーンショット -->
<img src="docs/image.png" alt="OpenGeekLLMChat" width="800" /><br />
<img src="docs/image_ft.png" alt="OpenGeekLLMChat Fine-Tuning" width="800" />
</div>

---

## 🎯 何ができるのか

OpenGeekLLMChatは、**クラウドに依存しないローカルLLM環境を自宅サーバーや社内LANで動かすため** に設計されたチャットアプリです。ギークが自由に弄り倒せるよう、**依存を最小限に絞り、すべてがファイル1枚で完結する構成** になっています。

- サーバー: `server.js` 1ファイル（依存は `express` と `ws` のみ）
- クライアント: `public/index.html` + `public/styles.css`（React/Babel CDN、ビルドツール不要）
- LLM推論: llama.cppの `llama-server` バイナリを子プロセスとして起動・管理

データは全て手元に残ります。**クラウドAPIへの送信は一切ありません。**

---

## ✨ 主な機能

### 🤖 Agentic RAG（マルチターン対応）
LLMが自ら検索要否を判断し、必要なときだけドキュメントRAG・Web検索・ファイル操作を呼び出します。最大3ターンのツール実行ループで、「一覧取得 → 内容読み込み → 応答」の段階的処理が可能。

### 🌐 DuckDuckGo Web検索（本文取得対応）
APIキー不要。検索結果のスニペットだけでなく、上位3件のページ本文も自動取得。天気・ニュース・株価なども回答可能。

### 📁 サーバーファイル読み書き
LLMが直接サーバーのファイルシステムに `.py` / `.xml` / `.json` 等を保存可能。Agenticツールとして `read_file`, `write_file`, `list_files` を実装。バイナリファイル（PNG/PDF/Parquet等）もFormData経由で安全にアップロード・ダウンロード可能。

### ☁️ Google Drive 連携（LLMがドライブを読み書き）
「ドライブの議事録まとめて」「あの資料の売上、月別に集計して」で、LLMが自分で Google Drive を検索・閲覧します。追加の npm パッケージは不要（Node標準の `https` / `crypto` だけで OAuth2 と Drive API v3 を実装）。

| ツール | できること |
|---|---|
| `gdrive_search_files` | ファイル名＋**本文の全文検索**でドライブ全体から探す |
| `gdrive_list_files` | フォルダの中身を一覧（`"資料/2026年度"` のようなパス指定も可） |
| `gdrive_read_file` | 中身をテキストで読む。**Google ドキュメント→テキスト、スプレッドシート→CSV に自動変換** |
| `gdrive_import_to_server` | PDF・画像・Excel 等を `uploads/` に取り込む → そのまま Python/DuckDB で処理できる |
| `gdrive_write_file` | Drive にファイルを作成・更新（書き込み許可時のみ） |
| `gdrive_upload_from_server` | `uploads/` のファイルを Drive にアップロード（書き込み許可時のみ） |
| `gdrive_create_folder` / `gdrive_delete_file` | フォルダ作成／ゴミ箱へ移動（それぞれ許可時のみ） |

**安全側に倒した設計**
- 既定は **読み取り専用**。書き込みは `allowWrite`、削除は `allowDelete` を明示的に true にした時だけツール自体が生えます
- `rootFolderId` を設定すると、**そのフォルダ配下だけ**にアクセスを限定（親を遡って範囲外を拒否）
- `clientSecret` はブラウザに一切返しません。リフレッシュトークンは `config.json` ではなく `gdrive_token.json`（chmod 600・gitignore 済み）に保存
- チャット入力欄の ☁️ ボタンでいつでも ON/OFF、右パネルの「☁️ GDrive」タブから接続・ファイル閲覧・取り込みができます

→ セットアップ手順は [☁️ Google Drive 連携のセットアップ](#️-google-drive-連携のセットアップ) を参照

### 📄 PDF OCR（Vision LLM → Markdown → RAG自動登録）

紙の技術書をスキャンしたPDFを `/ocr.html`（サイドバーの **「📄 永続RAG(OCR登録)」**）にドロップするだけで、**Vision LLM が1ページずつ Markdown に起こし、完了後そのまま永続RAGに登録**されます。以降はチャット画面で「あの資料の◯◯について」と普通に聞けます（フロントエンドの追加操作は不要）。

**流れ**

```
PDF アップロード
  → pdftoppm で1ページずつ 300dpi PNG 化
  → Vision LLM (Qwen2.5-VL 等) に投げて Markdown 化
  → ページ単位でキャッシュ (ml/ocr/cache/<jobId>/pXXXX.md)
  → 全ページ結合 → public/uploads/<名前>.md
  → ragIngestFile() で RAG 登録 → search_persistent_documents から参照可能
```

**特徴**

- **ページ単位でリアルタイム進捗**: SSE (`/ocr/jobs/:id/stream`) で `p42/258 (16%)` のように表示。経過時間と残り時間の推定も出る
**回答に書かれた数式の照合**

検索でヒットしたチャンクの本文は `ragSources[].text` として画面側に残るので、回答の数式（`$...$` / `$$...$$` / `\(...\)` / `\[...\]` / `\begin{equation}…\end{equation}`）がそこから写されたものかを、モデルに聞かずに文字列比較で確かめます。空白・波括弧・`\left`/`\right`/`\cdot` の差は正規化して吸収します。短すぎる式は何にでも一致してしまうため、**インラインは正規化後25文字以上、ブロック数式（`$$…$$`）は10文字以上**を判定対象にします。ブロック数式は「これが式です」という主張なので、`$$p_m = \frac{W}{2BD}$$`（正規化13文字）のような短いものも見ます。

**「一致しない」と「照合できない」を分けます。** 資料側に対応する式を示せない時は `? 照合できず` と中立に表示し、警告にはしません。理由が3つあり得て区別できないためです — モデルが書き換えた／モデルが式を変形した／**資料側のOCRが数式をLaTeX化できていない**。実際 `p_m = \frac{W}{2BD}` に対し資料が `pm = W2BD`（分数の横線が落ちている）という例があり、意味は同じなのに文字列は一致しません。ここを警告にすると正しい回答が毎回警告され、警告そのものが信用されなくなります。

インライン数式で資料側に近い式も見つからないものは、判定せず見送ります。文中で式の項を取り出して説明している箇所（`$\frac{1}{l}\sum W_i\delta_i$` など）が該当し、正しい回答でも必ず引っかかるためです。「元がこれだ」と示せない以上、書き換えなのか導出なのか区別できません。ブロック数式（`$$…$$`）は「これが式です」という提示なので、示せなくても知らせます。

判定は**本文中の数式そのものに付きます**（`✓ 資料と一致` / `⚠ 資料と不一致`）。出典欄にまとめて出すと、どの式のことか本文と突き合わせないと分からないためです。一致しないブロック数式には、資料側から一番近い式（Dice係数0.55以上）を探して**その場に回答と資料を並べ、食い違う部分だけを強調**します。実際に `Q_c = \frac{2BD}{\varepsilon}(...)` と `Q_c = 2BD\varepsilon(...)` の違い（ε が係数から分母へ移っている＝物理的に別の式）を、この表示で特定できました。その場から出典ビューアも開けます。**見ているのは「渡した資料どおりに書いたか」であって「式が正しいか」ではありません**（OCR が誤っていれば、忠実に写した時点で一致します）。式を変形して答えた場合も警告に出ます。

---

- **中断しても続きから**: ページごとに Markdown をキャッシュしているので、キャンセル・サーバー再起動のあと「▶ 再開」を押せば未処理ページだけを処理します。300ページのPDFで250ページ目に落ちても、やり直しは50ページぶんだけ
- **1ページ失敗してもジョブは止まらない**: リトライ後スキップして次ページへ進み、失敗ページを記録します（結合後のMarkdownにも `<!-- page=12 failed=1 -->` として残る）
- **完了後でもページ単位で引き直せる**: 完了ジョブの「🔄 再OCR」でページ番号（`240` / `133, 240` / `10-12`）を指定すると、そのページのキャッシュだけ捨てて取り直し、Markdownの再結合とRAG再登録まで自動で走ります。空欄なら全ページやり直し
- **依存パッケージ追加なし**: PDF→画像は poppler-utils の `pdftoppm` を `child_process` で呼ぶだけ。npm 依存は増えません
- **単一GPUを前提に1ジョブずつ順次処理**: Qwen2.5-VL 7B (~9GB) と embedding (~1.5GB) は同じGPUに同居できます。`maxConcurrentJobs` を上げれば将来のマルチGPUにも対応
- **数式・表・図に対応したプロンプト**: 表は Markdown テーブル、数式は LaTeX (`$...$` / `$$...$$`)、図は `[図: 説明]` で出力させます（`ocr.prompt` で変更可）

**必要なもの**

poppler-utils（`pdftoppm` / `pdfinfo`）。npm の依存追加はありません。

| OS | 導入方法 |
|---|---|
| Ubuntu / Debian | `sudo apt install poppler-utils` |
| macOS | `brew install poppler` |
| Windows | [poppler-windows](https://github.com/oschwartz10612/poppler-windows/releases) のZIPを展開し `Library\bin` を PATH に追加。PATHを通さない場合は `ocr.pdfToImageCmd` / `ocr.pdfInfoCmd` にフルパスを指定（例 `"C:/poppler/Library/bin/pdftoppm.exe"`） |

未導入のまま `/ocr.html` を開くと、**動作中のOSに合わせた導入手順**が画面上部に警告として出ます。

加えて、Vision対応モデルの llama-server を別ポートで起動しておきます（`config.ocr.vlmEndpoint` の指す先）。

```bash
llama-server -m /models/Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf \
  --mmproj /models/mmproj-Qwen2.5-VL-7B-f16.gguf \
  --port 8090 -ngl 99 -c 8192
```

**API**（認証は既存の `requireAuth` + 参照系 `ml:read` / 更新系 `ml:write`）

| Method | Path | 説明 |
|---|---|---|
| `POST` | `/ocr/upload` | PDF を受信 → ジョブ登録（既定でそのまま開始。`?autostart=0` で保留） |
| `GET` | `/ocr/jobs` | 全ジョブの状態一覧 |
| `GET` | `/ocr/jobs/:jobId` | 個別ジョブの詳細 |
| `GET` | `/ocr/jobs/:jobId/stream` | SSE でリアルタイム進捗配信 |
| `POST` | `/ocr/jobs/:jobId/start` | 開始 / 中断ジョブの再開。ボディ `{"redo":true}` で完了済みの引き直し、`{"redo":true,"pages":"133, 240"}` で指定ページだけ |
| `POST` | `/ocr/jobs/:jobId/cancel` | 実行中ジョブの中断 |
| `DELETE` | `/ocr/jobs/:jobId` | ジョブ削除（キャッシュ・PDF・Markdown・RAG登録もまとめて） |
| `GET` | `/ocr/status` | 依存コマンドと Vision LLM の生存確認 |

`curl` からも使えます（multipart でも、生のPDFボディでも受け付けます）。

```bash
curl -X POST 'http://localhost:3000/ocr/upload' \
  -H 'Authorization: Bearer <APIトークン>' \
  -F 'file=@book.pdf'

# 生ボディで送る場合
curl -X POST 'http://localhost:3000/ocr/upload?name=book.pdf' \
  -H 'Authorization: Bearer <APIトークン>' \
  -H 'Content-Type: application/pdf' --data-binary @book.pdf
```

**セキュリティ**: 拡張子・MIMEタイプ・ファイル先頭の `%PDF-` を三重にチェックし、ファイル名はサニタイズして `uploads` 直下に固定します。300MB（`ocr.maxUploadMB`）を超えるものとディスク残量不足は受信時に弾きます。

### 🎯 ドラッグ&ドロップ統合UI
3つのドロップゾーンが状況に応じて自動で振り分け:
- **チャット入力欄**: 画像→Vision添付、その他→ドキュメント取り込み
- **左サイドバー（ドキュメント）**: RAG用ドキュメントとして取り込み（embedding生成）
- **右サイドバー（サーバーファイル）**: `public/uploads/` にバイナリ含めて保存

### 🌐 Web検索ON/OFFトグル
チャット入力欄の🌐ボタンで検索の有効/無効を即座に切り替え可能。社内ドキュメントだけで答えてほしい時はOFF、最新情報が必要な時はONに。デフォルトは `config.webSearch` で設定。

### 📚 登録資料（永続RAG）ON/OFFトグル
チャット入力欄の📚ボタンで、サーバー登録資料の検索を切り替えられます（サーバーに資料が登録されている時だけ表示）。**デフォルトはOFF** で、OFFの間は `search_persistent_documents` ツールもRAG用の引用ルールもLLMに渡らないため、雑談やコード生成のたびにベクトル検索が走ることがありません。資料について尋ねたいチャットでONにしてください。新規チャットを開くと既定値に戻ります。初期値は `config.ragEnabledByDefault` で変更できます。

### 📐 コンテキスト管理（コンパクション / 重み付け）
会話履歴の送り方は `config.historyMode` で選択:
- **`compaction`（デフォルト、Claude風）**: 履歴は無圧縮のまま送信し、コンテキスト使用率が閾値（`contextCompaction.threshold`、既定75%）を超えた時だけ、LLM自身に古い会話を要約させて1つの要約メッセージに置き換えます。トークン使用率は圧縮が走るまで単調に増え、圧縮のタイミングで一段下がります。圧縮位置はチャット上に「📦 コンテキスト圧縮」の区切りとして表示され、クリックで要約を確認できます。
- **`weighted`（従来方式）**: 直近6件（`config.recentMessageCount`）はそのまま送信、それ以前は毎ターン「参考情報」として500文字に圧縮。

どちらのモードでも最新ユーザー質問には「今この質問に回答してください」マーカーを付加し、長い会話でも最新文脈を優先させます。

### ⚡ マルチGPU・テンソル並列
1台のサーバー内で複数GPU（NVIDIA / AMD ROCm）を使ったテンソル並列推論が可能。`commonArgs` で `--device ROCm0,ROCm1` のように指定するだけ。VRAMを束ねて大規模モデルを実行できます。

### 🎼 マルチLLMオーケストレーション（ワークフローエディタ付き）
複数のLLMを同時に立ち上げ、**どのモデルにどの役割をさせるか** を `editconfig.html` のワークフローエディタで組み立てられます。定義は `config.json` に保存され、**チャット画面の「チャットモデル」選択肢にそのまま並びます** — ユーザーは単一モデルを選ぶのと同じ操作でマルチLLMを選べます。

**5つのノードを組み合わせて構成**

| ノード | 役割 |
|---|---|
| 🤖 LLM | 1モデルに投げる基本ノード。上流ノードの出力を受け取れる |
| 🧩 統合 | 複数の上流出力を1モデルに渡してまとめさせる |
| 🔀 ルーター | モデルに分岐先を選ばせる。選ばれなかった枝はロードすらされない |
| 💬 討論 | 複数モデルが複数ラウンド議論する |
| 🎯 最終出力 | どのノードの出力をユーザーへの回答にするか指定 |

**すぐ使える5テンプレート**（エディタからワンクリックで雛形生成）
- **並列合議**: 同じ質問を複数モデルに同時投入 → 統合役が1つにまとめる（品質重視）
- **ルーター振り分け**: 小型モデルが質問を判定 → 最適な1モデルにだけ処理させる（速度・VRAM効率重視）
- **下書き→推敲**: 高速モデルが下書き → 高品質モデルが仕上げ
- **通常回答＋コード生成**: いつもの回答に加えて、コードが必要なときだけコード特化モデルを走らせる
- **討論→結論**: 賛成派・反対派が議論 → 司会役が結論を出す

**VRAM制約への自動対応**

ローカルLLM最大の制約はVRAMです。実行前に「使うモデルの合計サイズ」と「GPUの空きVRAM」を比較し、動作モードを自動で切り替えます。

- **常駐並列 (resident)**: 全モデルを別ポートで同時起動し、依存のないノードを本当に並列実行（最速）
- **逐次スワップ (swap)**: モデルを1つずつロード/アンロードしながら実行（VRAMが厳しい構成でも動く）

さらに、**メインチャットに同じモデルが載っていればそれを再利用**するため、実質1モデル分のVRAMが浮きます。swap時はメインチャットのモデルも一時アンロードして枠を空け、次の通常チャットで自動的に戻します。`poolMode` を `"resident"` / `"swap"` に固定して自動判定を切ることもできます。

**実行中は各モデルの動きが見える**

チャット内に進捗パネルが出て、ノードごとの状態（⚪待機 / ⏳実行中 / ✅完了 / ⏭️スキップ / ❌エラー）と所要時間、判定された実行モードとその理由（空き/必要VRAM）を表示します。ノードをクリックすると、そのモデルの生の出力を展開して確認できます。

**参照ドキュメント(RAG)と画像も渡せます。** ノード単位で「📚 参照ドキュメント(RAG)」「🖼️ 画像」を有効にすると、そのノードにだけ渡されます。

**ノードに実行条件を付けられます。** 「コードが必要なときだけコード特化モデルを追加で走らせる」といった構成が組めます（ルーターと違い排他ではないので、通常の回答に *加えて* 動かせます）。

> ⚠️ マルチLLM選択中は Web検索・ファイル操作などの **ツール実行** は使えません（RAGと画像は上記のとおり対応済み）。ツールが必要な質問は単一モデルに切り替えてください。

### 🖼️ Vision対応
gemma3 / llava 等のビジョンモデルに画像を直接送信。ペースト・D&D・アップロードに対応。

### 📊 matplotlib グラフ自動表示
`plt.show()` や `plt.savefig()` を呼ぶだけで、生成画像がチャットにインライン表示されます。日本語フォントも自動選択。生成画像は `public/plots/` に分離保存されるため、`list_files` でLLMの作業領域を汚しません。チャット内の **📎 チャットに添付** ボタンで、生成したグラフを次のチャット入力に画像として渡せます（Visionモデルとの連携）。

### 🦆 DuckDB 対応（高速SQL処理）
CSV / Parquet / JSON ファイルを直接SQLでクエリ可能。pandasより高速・省メモリで数百万行のデータを扱えます。LLMが大量データの集計依頼を受けたときに自動的にDuckDBコードを生成します。

### 🎮 Three.js / HTMLプレビュー
LLMが生成したThree.jsコードをチャット内でワンクリック実行。CDN自動注入・ESM→UMD変換・壊れたCDN URL自動修正。

### 🐍 Python対話実行
コードブロックの「▶ 実行」で対話的実行。`input()` 入力も可能。matplotlibでのグラフ描画自動対応。作業ディレクトリはuploads配下でLLMツールと統一。

### 🎤 音声入力 (Web Speech API)
マイクボタンから日本語音声認識。リアルタイムで入力欄に反映。**3秒無音で自動送信**、送信後は録音自動停止。

### 🔊 音声出力 (Web Speech Synthesis)
アシスタントメッセージ下の🔊ボタンでOS内蔵TTSでの読み上げ。Markdown記号・コードブロック自動除去。別メッセージ切替・チャット切替時は自動停止。

### 📈 リアルタイムメトリクス
トークン生成速度（tok/s）、コンテキスト使用率（%バー）、GPU使用率/温度/電力/VRAM を右サイドバーにリアルタイム表示。各GPUカードには **製品名**（例: `AMD Radeon AI PRO R9700`）も表示される。

- **GPU監視バックエンド**: `amd-smi`（ROCm 6.x以降の新標準、自動検出されると最優先） → `rocm-smi`（レガシー） → `nvidia-smi` の順に試行
- **iGPU 自動除外**: APUのiGPU（gfx10[345]x系、CU<8、VRAM≤4GB）はLLM用途に不要なので自動的に非表示
- **llama.cpp バージョン表示**: GPUモニタ上部に、稼働中の `llama-server` のビルド番号・コミットハッシュ（例: `b4589 (abc1234)`）をカード表示。起動時に `llama-server --version` を1回だけ実行してキャッシュ

### 🧹 VRAM強制解放
GPUモニターに **「🧹 強制的にVRAMを解放」** ボタンがあります。ロード中のモデル一覧が表示され、ワンクリックで全てアンロードしてVRAMを空けられます。学習を回したい、他のアプリにGPUを譲りたい、といった場面で使えます。

対象はチャットモデル・Embedding・マルチLLMワーカー・画像生成・音声合成です。**外部APIサーバーは対象外**（意図して公開しているため。止めたい場合は 🌐 API タブから個別に）。

チャットモデルは**次回の送信時に自動で再ロード**されるので、解放後もそのまま使い続けられます。実行後は「18.6GB → 0.4GB（18.2GB 解放）」のように結果が表示されます。

### 🔄 思考中断からの復旧 / ループ検出
Thinking中にモデルが停止した場合、メッセージ下の「🔄 続きを生成」ボタンで自動的に続きを要求できます。さらに、**同じ思考が3回繰り返されると自動的にループを検出して停止**し、「⚠️ 思考ループを中断・回答を要求」ボタンが表示されます。小型モデルの暴走を未然に防げます。

### ⏹️ 確実な生成停止
停止ボタンでHTTPストリームを切断、llama-serverのスロットを即座に解放します。

### ⚡ ツール判断の高速化
ツール（search_documents/web_search 等）を呼ぶか判断するフェーズでは `think: false` を指定し、思考プロセスをスキップして即座に判定。応答速度向上＆思考ループ防止を兼ねた効果あり。

### 🌐 外部APIサーバー公開（OpenAI互換、Ollama互換ポート）
右パネルの「🌐 API」タブから、選択したモデルを **独立した OpenAI互換 APIサーバー** として外部公開できる。OpenGeekLLMChat本体（ポート3000等）とは別プロセス・別ポートで動作するため、UIと外部APIを同時に運用可能。

- **OpenAI互換**: `/v1/chat/completions` エンドポイントで OpenAI SDK・LangChain・Continue.dev 等から利用可能
- **Ollama互換ポート**: デフォルト `11434`（Ollamaのデフォルトポート）。既存のOllama対応ツールがそのまま接続できる
- **APIキー認証**: 自動生成 or 手動指定。llama-serverの `--api-key` で強制
- **HTTPS対応**: OpenGeekLLMChat本体と同じ `cert.pem`/`key.pem` を使用してHTTPS起動可能（要 SSL対応ビルド: `-DLLAMA_SERVER_SSL=ON`）
- **HTTPS/HTTPバッジ表示**: 起動済みサーバーのプロトコルがUIで一目でわかる
- **ctx / parallel スロット数表示**: 起動済みサーバーカードに `ctx: 32,768` / `np: 1` のスペック情報をバッジ表示
- **起動/停止トグル**: 稼働中の `● 稼働中` ボタンをクリックでプロセス停止、`○ 停止中` を再クリックで同じ設定で再起動。`✕` ボタンで設定ごと削除
- **URL自動表示**: `host=0.0.0.0` で起動した場合、ブラウザのドメイン名を使った接続URL（例: `https://llm.example.com:11434/v1`）を自動表示・コピー
- **複数同時起動**: 異なるポートで複数モデルを同時公開
- **永続化**: 起動状態はディスクに保存（プロセス再起動後の自動復元は手動）

### ⚙️ 大きなリクエスト・並列制御対応
config.json から HTTPサーバーや llama-server の細かな設定を調整可能。デフォルト値は単一ユーザー＋大きなツール配列に最適化されている。

- **`maxRequestSize`**: JSONボディ上限（デフォルト `100mb`）。画像Base64や長文に対応
- **`maxFileSize`**: アップロードファイル上限（デフォルト `50` MB）
- **`maxHeaderSize`**: HTTPヘッダー上限（デフォルト `65536` バイト）。Authorization+大量toolsで64KB超に対応
- **`requestTimeoutSec`/`headersTimeoutSec`/`keepAliveTimeoutSec`**: 各種タイムアウト
- **`llamaServer.nParallel`** または モデル個別の **`nParallel`**: llama-server の並列スロット数 `-np`（デフォルト `1`）。1にすると ctx をフル活用、大きいリクエスト・長文プロンプトに有利

### 🔗 共有可能なURL（チャットIDをURLに反映）
各チャットには `https://example.com:3000/chat/abc123` のような直接アクセス可能なURLが割り当てられる。ブラウザの戻る・進むボタンでチャット切替に対応。履歴アイテムにホバーすると🔗ボタンが表示され、クリックでURLがクリップボードにコピーされる。チームでの会話共有や、ブックマークによる素早い復帰に便利。

### 📱 モバイルサイドバー閉じる機能
スマホサイズ(≤768px)では、サイドバー右上に×ボタンが表示される。チャット履歴アイテムや「+ 新規」をタップすると自動でサイドバーが閉じてチャット画面が見やすくなる。PCサイズではサイドバー固定のまま。

### ↕ サイドバーのドラッグリサイズ
左サイドバーの **チャット履歴** と **ドキュメント** の境界をドラッグして高さ配分を調整できる。設定した高さは `localStorage` に保存され、リロード後も維持。マウス・タッチ両対応（Pointer Events）。

### 🎭 LLMの役割設定（システムプロンプト追加）
新規チャット画面で「LLMに役割を与える」ボタンから、フリーテキストで役割や指示を設定できる。例：「あなたは熟練のPythonエンジニアです」「小学生向けに優しく説明してください」「回答は3行以内で関西弁」など。設定した役割は内部のシステムプロンプトに追加されてLLMの応答スタイル・専門性・形式を大きく変える。チャット中はヘッダー🎭アイコンからモーダルで再編集可能。チャット履歴と一緒に保存され、過去のチャットを開くと役割も自動復元される。継続チャットでは役割が引き継がれる。

### 💬 継続チャット（過去の会話をRAGとして引き継ぎ）
ヘッダーの「継続チャット」ボタンで、現在のチャット内容をLLMで詳細に要約 → markdownドキュメントとして自動アップロード → 新規チャット開始。新しいチャットからは過去の会話をRAGで参照できるため、長期的な対話の文脈を保持できる。要約はmarkdown形式で構造化され、検索しやすい。

### 🌐 日本語Markdown太字対応
日本語のテキストに直接接続した `**強調**` も正しく太字表示される（CommonMarkのIntraword Emphasis制約をゼロ幅空白で回避）。

### 🛌 モデル自動アンロード（idleUnloadMs）
チャットモデルのアイドル時間が `idleUnloadMs` を超えると自動でアンロード（VRAM解放）。次回リクエスト時に自動再ロード。複数モデルを切替使用するときのVRAM節約に有効。30秒間隔でチェック。Embeddingモデルも同設定でアンロード対象。

### 🚀 オンデマンドモデルロード
サーバー起動時にはモデルをロードせず、初回チャット送信時にロード。サーバー起動直後はVRAMほぼ空の状態を維持。前回使用モデル(`settings.json`)を記憶しUI上に表示、送信時に自動ロードされる。Embeddingも同様にドキュメントD&D時に初めてロード。

### 🔁 アイドル復帰の自動継続
アイドルアンロード後にチャット送信した場合、自動的にロード完了を待機してそのまま送信処理を続行。ユーザーは送信ボタンを再度押す必要なし（最大2分まで待機）。

### 🔒 生成中のモデル切替防止
チャット生成中は、設定パネルのモデル選択ドロップダウンが自動的に無効化され🔒アイコンが表示。生成完了/停止後に再度切替可能になる。生成途中で違うモデルに切り替えてしまう事故を防止。

### 🟠 ロード中のオレンジ色UI表示
モデル切替時、画面下部にオレンジ色の進捗トースト + 回転スピナーが表示。エラー（赤色）と明確に区別され、進行中であることが一目で分かる。

### 📱 モバイル対応（2行ヘッダー）
スマートフォンサイズでは自動的にヘッダーを2行レイアウトに切替。`100dvh` + iOSセーフエリア対応で、アドレスバー表示時もホームバー被りも回避。チャット入力欄は16pxフォントでiOSフォーカス時の自動ズームを抑制。

### 🔒 セキュリティ
- **HTTPS対応**: `cert.pem` / `key.pem` を配置で自動HTTPS起動。正規SSL証明書（Let's Encrypt等）も利用可能
- セッションCookie認証（HttpOnly + SameSite=Strict + Secure自動付与、24h TTL）
- **Cookie維持で再ログイン不要**（TTL以内）
- MD5/SHA-256ハッシュ（`crypto.timingSafeEqual` 使用）
- ログイン試行レートリミット（15分5回）
- パストラバーサル対策
- 全認証必須エンドポイント

### 🛠️ その他
- Markdown / LaTeX（KaTeX）/ コードハイライト（highlight.js）
- Thinking表示（DeepSeek R1 / gemma3等の `<think>` タグ対応）
- チャット履歴保存（メッセージ+ドキュメント+Embedding）
- チャットタイトル編集
- ストリーミング中のスクロール制御（ユーザーが上にスクロールしたら自動追従停止）
- systemd対応（`process.chdir(__dirname)` で起動位置非依存）
- レスポンシブ・ダークテーマ
- ログレベル制御（`logLevel: "quiet"` で本番運用ログを最小化）
- モデル選択ドロップダウンに `モデル名 (8,192)` 形式でctx併記
- 全設定を `config.json` でカスタマイズ可能

### 🧠 ファインチューニング機能（LoRA SFT）
チャットUIから完全独立した管理画面（`/tuning.html`）で、ローカルLLMのファインチューニング（LoRA / QLoRA / Full）を実行できる。

- **学習データ管理**: 手動追加・編集、CSV/JSONL インポート、JSONL エクスポート
- **TRL SFTTrainer + peft (LoRA)** ベース、AMD ROCm環境にも対応 (`HSA_OVERRIDE_GFX_VERSION` 等を自動設定)
- **マルチターン（messages）+ シングルターン（instruction/output）両対応**
- **学習開始**: ベースモデル選択（プリセット or HuggingFace ID 直接入力）、ハイパラ設定（epochs, LR, batch, accum, LoRA r/α, max_seq_length）
- **モデルプリセット**: `config.json` の `tuning.modelPresets` で自由に追加・編集可能。プリセットを選ぶとサイズに応じたハイパラが自動適用される
- **ジョブ管理**: 実行中・完了済みジョブ一覧、リアルタイムログ表示、停止、削除
- **後処理パイプライン**: 学習完了後にUIから「📦 マージ→GGUF→量子化」を1ボタン実行
- **タブ間状態保持**: タブを行き来しても入力中の値が消えない (display 切替方式)
- **チャット画面からワンクリック遷移**: モデル選択の下に「🧠 ファインチューニング」リンク

### ⚙️ ブラウザから config.json 編集
`/editconfig.html` で config.json を直接編集可能。チャット画面左下の小さな歯車アイコンからもアクセスできる。

- **🌳 ツリー編集（既定表示）**: 括弧・カンマ・`\n` エスケープを気にせず GUI で設定を編集。値は型ごとの入力UI（真偽値はトグル、長文プロンプトは複数行エリア）、キーの追加/改名/削除、配列の並べ替え・複製、キーの説明表示、キー名や値での絞り込み検索。まとまり単位で JSON テキスト編集する逃げ道も用意
- **📝 テキストエディタ + リアルタイム JSON 構文チェック**: 生JSONを直接見たい時用。編集中に構文エラーをハイライト（ツリー編集の結果もここで確認できる）
- **整形（pretty-print）/ 破棄 / Ctrl+S 保存**: VS Code風の操作感
- **保存時に自動バックアップ**: `config.json.bak.<timestamp>` を最新10件まで保持
- **バックアップから復元**: サイドバーのバックアップ一覧からワンクリック復元
- **🔄 本体を再起動ボタン**: ブラウザから OpenGeekLLMChat 本体プロセスを再起動（systemd管理下なら自動復帰）
- **再起動状態のポーリング表示**: 再起動完了まで自動で監視、復活したら「✓ 再起動完了」と通知
- **PID / 起動時間表示**: サーバープロセスの状態が一目でわかる
- **⬇ HuggingFace GGUF ワンボタン導入**: HuggingFace の GGUF リンクを貼って1ボタンで、モデルディレクトリへダウンロード → `config.json` の `chatModels` へ自動登録（進捗バー表示、mmproj / ctx / ngl / HFトークンも任意指定可）
- **ナビゲーション統一**: サイドバーから 💬 チャット / 🧠 ファインチューニング / 🤖 機械学習 / 📄 永続RAG(OCR登録) へ相互遷移

### 🎨 画像生成（stable-diffusion.cpp 連携）
チャットで「猫の絵を描いて」と頼むと、LLMが自動的に `generate_image` ツールを呼び出して画像を生成する。stable-diffusion.cpp の `sd-server` を内部プロセスとして管理し、ROCm/CUDA GPU で高速推論。

- **自動ツールコール**: LLMが「描いて」「画像にして」等を検出して自動使用
- **オンデマンドロード**: 初回 generate_image 時に sd-server 自動起動（〜10秒）
- **アイドルアンロード**: 10分使われなければ自動アンロード（VRAM節約）
- **SDXL / Flux / SD3対応**: stable-diffusion.cpp の対応モデルすべて使用可能
- **複数モデル切替**: `config.json` の `imageModels[]` で管理、モデル指定で自動切替
- **コンパクトなチャット表示**: 256x256 サムネイル + プロンプト + 拡大・💾保存・📋プロンプトコピー ボタン
- **ライトボックス**: クリックでフルサイズプレビュー、中央下部に大きなダウンロードボタン
- **複数枚一括生成**: `count: 4` パラメータで最大4枚同時生成
- **3分タイムアウト**: 大きいモデル・複雑なプロンプトでも対応

### 🔊 音声合成（Irodori-TTS 連携）
チャットで「『こんにちは』を30代男性の声で作って」と頼むと、LLMが自動的に `generate_speech` ツールを呼び出して音声(WAV)を生成する。日本語特化のローカル音声合成AI [Irodori-TTS](https://github.com/Aratako/Irodori-TTS) の OpenAI互換サーバー（`/v1/audio/speech`）を内部プロセスとして管理する（画像生成 sd-server と同じ方式）。

- **自動ツールコール**: LLMが「音声にして」「しゃべって」「読み上げて」「〇〇の声で作って」等を検出して自動使用
- **オンデマンドロード**: 初回 generate_speech 時に Irodori-TTS サーバーを自動起動（`irodoriTts.command` 設定時）
- **アイドルアンロード**: 一定時間使われなければ自動アンロード（VRAM節約、`idleUnloadMs`）
- **声のテキスト指定 (VoiceDesign)**: 「30代男性、落ち着いた低めの声」のように声の特徴をテキストで指定可能（`instructions` / `irodori.caption` で送信）
- **声プリセット**: `config.json` の `ttsVoices[]` で「30代男性」「20代女性」等の声を名前付き登録（voice ID / 声の記述をマッピング）
- **チャット内再生**: `<audio controls>` プレーヤーで即再生 + 💾保存ボタン
- **サーバー保存**: 生成WAVは画像生成と同じく `public/uploads/` に保存される

### 🤖 機械学習 (ML) - データ・学習・推論パイプライン
チャットUI から独立した管理画面（`/ml.html`）で、表データの取り込み・SQL分析・PyTorch学習・推論まで一気通貫に行える。LLMチャットからも自然言語で操作可能。

> **技術的な補足**: 「機械学習 (ML)」は広く一般に通じる上位概念としての呼称です。実際の学習エンジンの中身は **PyTorch によるニューラルネットワーク = 深層学習 (Deep Learning)** で、回帰・分類には MLP (多層パーセプトロン)、時系列には LSTM を使用しています。将来的に古典的ML (決定木・ランダムフォレスト等) を追加する余地を残すため、UI・ドキュメントとも上位概念の「機械学習 (ML)」という名称で統一しています。

- **データテーブル (DuckDB)**: 高速な列指向 OLAP エンジンを内蔵。CSV インポート、Web API インポート (JSON Path 指定可)、Python REST から行追記
- **SQL クエリ**: ブラウザの SQL エディタで読み取り専用クエリ実行 (SELECT/WITH のみ、書き込み・スキーマ変更は禁止)。DuckDB方言 (window関数、CTE、集約等) が使える
- **PyTorch 学習**: 回帰 (MLP)・分類 (MLP)・時系列 (LSTM) の3タスクに対応。データテーブルから特徴量とターゲットを選ぶだけで学習開始、ROCm/CUDA GPU 自動検出
- **自動前処理**: 数値列は StandardScaler、文字列列は LabelEncoder、日時列は自動で `year/month/day/dayofweek/dayofyear/is_weekend` の6特徴量に分解 (季節性や曜日効果を学習)
- **ジョブ管理**: 学習ジョブの開始・停止・リアルタイムログ表示、過去ジョブの履歴・メトリクス表示
- **推論 API + UI**: 学習済みモデルで予測実行。UI から特徴量を入力するフォーム (カテゴリ列は select、日時列は date picker)、回帰/分類別の結果表示 (確率バー付き)
- **LLM チャット連携**: `ml_list_datasets` / `ml_describe_dataset` / `ml_query_dataset` / `ml_list_models` / `ml_predict` の5ツールで、LLM が自律的に「データ確認 → 集計 → 予測 → 結果説明」を実行
- **外部 API 公開**: `Authorization: Bearer <token>` 方式の API トークンで、Python スクリプト等の外部プログラムから直接アクセス可能。`ml.apiTokens` でトークン管理 (権限: `ml:read` / `ml:write`)
- **DuckDB ロック調停**: 学習中は Node.js 側で CHECKPOINT + DB接続クローズ → Python が排他ロックで読み込み → 完了後自動再オープン
- **派生列自動復元**: LLM が `date_year: 2026, date_month: 4, date_day: 20` のような派生列を直接渡しても、サーバー送信前に `date: "2026-04-20"` に自動修正

### 🎮 強化学習 (RL) - オフライン学習 & リアルタイム外部API
`/ml.html` の「🎮 強化学習」タブで、エージェント (方策) を学習・評価・運用できる。アルゴリズムは **DQN / Double DQN (DDQN) / CQL / Behavior Cloning (BC)** に対応 (価値ベース off-policy + オフラインRL/模倣学習)。

- **オフラインRL (データテーブルから学習)**: DuckDB テーブルに記録した経験ログ (状態・行動・報酬・次状態・done) から方策を学習 (`rl_runner.py`)。遷移ベース (next_state あり) と contextual bandit (next_state なし) の両方に対応。`📈 学習曲線` で損失推移、`🔍 方策を評価` でログ行動との一致率・行動分布を確認。
- **オンラインRL (リアルタイム/外部API)**: 常駐ワーカー (`rl_online_server.py`) がモデルをメモリ保持し、HTTP で `act` (推論) / `learn` (経験投入+即時勾配更新) をループ実行。外部プログラム (Python 等) から強化学習ループを回せる。学習済みエージェントを「ウォームスタート」してオンライン継続学習も可能。
- **外部API の流れ**: `POST /ml/rl/online/create` (新規 spec / `fromAgent` でウォームスタート) → `POST /ml/rl/models/<name>/act` (state→action, `epsilon` で ε-greedy) → `/learn` (経験投入) → `/checkpoint` (保存)。認証は `Authorization: Bearer <token>` 方式 (権限 `ml:read` / `ml:write`)。
  - 例: Windows PC 上の MuJoCo 倒立振子 (InvertedPendulum) を環境にして、**物理シミュレーションは手元・行動決定と学習はサーバ側API**に委譲する構成が可能 (act で離散行動を取得、learn で経験を投入)。
- **UI の統一**: オフライン (📊) / オンライン (⚡) のエージェントカードは共通で `📈 学習曲線` `🔍 方策を評価` `⚡ オンライン操作/化` ボタンを持ち、クリックで右パネルが切り替わる同一の操作感。
  - オンラインの `📈 学習曲線` = reward/loss EMA のライブ推移 (パネル表示中にサンプリング)、`🔍 方策を評価` = 状態を入力して act(ε=0) の Q値・推奨行動をバーで可視化。
- **📝 操作ログ**: 評価・act・learn・チェックポイント・削除などの操作結果を、右パネル下部に時系列で常時表示。
- **自動チェックポイント**: オンラインワーカーは 500ステップ または 60秒ごとに最新の重みを `ml/rl_models/<name>/` (`model.pt` / `config.json` / `metrics.json`) へ自動保存。サーバ再起動後は次回 `act` 時にディスクから自動再ロード。

### 🔧 外部API: ツール対応モード (エージェント機能)
通常の外部APIは llama-server を直接公開する「素のLLM」モードですが、**ツール対応モード** ではWebチャットと同じツール群を外部プログラムからも使えます。

- **OpenAI互換 + エージェント動作**: `/v1/chat/completions` を叩くだけで、LLM が自律的にツールを選んで実行 → 結果に基づいて最終応答
- **対応ツール**: 機械学習 (`ml_*` 5ツール) / Web検索 / ファイル参照 / RAG文書検索
- **モデルロード保証**: 起動時に指定モデルを内部で自動ロード、アイドルアンロード後の再リクエストでも自動再ロード (ポーリング待機)
- **OpenAI互換エラー応答**: JSON パースエラーや404も HTML ではなく JSON で返す
- **`/health` はパブリック**: 認証なしでヘルスチェック可能 (ロードバランサー・監視ツール対応)
- **非対応**: `generate_image` / Python実行 (セキュリティのため外部公開しない)

### 📚 永続RAGドキュメント
サーバー側に永続保存された RAG ドキュメントストア。**Webチャットと外部API両方から利用可能**。

- **uploads フォルダのファイルを RAG 化**: テキスト/Markdown/CSV/JSON/HTML等を embedding 化して `ml/rag/` に保存
- **embedding ベクトル検索**: 内部embeddingサーバー (`mxbai-embed-large-v1` 等) で cosine 類似度検索
- **2系統RAG併用**: ブラウザ添付RAG (`search_documents`、その場・メモリ) と 永続RAG (`search_persistent_documents`、恒久・全ユーザー共有) を同時利用可能。LLMが状況に応じて使い分け
- **通常チャットでの自動有効化**: 登録ドキュメントが1件以上あれば、UI 操作なしで自動的にツールがLLMに提供される。左サイドバーのドキュメント欄には出さない (そこはチャット添付RAG専用)
- **embedding 未設定時の自動 OFF**: 4層防御 (UI非表示 / 起動時自動除外 / API 503 / agent_proxy ツール除外)
- **Python REST 経由で管理**: `/rag/documents` 等のエンドポイントで登録・一覧・削除
- **PDFからの登録**: スキャンPDFはサイドバーの **「📄 永続RAG(OCR登録)」** ([📄 PDF OCR](#-pdf-ocrvision-llm--markdown--rag自動登録)) を使えば、Markdown化から登録まで自動で行われる

### 🖼️ 画像物体検出 (torchvision)
`/ml.html` の「画像」タブで、画像内の物体を検出できる。COCO事前学習モデルでの即時検出と、独自クラスのカスタムモデル学習の両方に対応。**追加パッケージは torchvision のみ** (YOLO等の外部依存なし、BSDライセンス)。

- **COCO事前学習モデルで即検出**: Faster R-CNN / RetinaNet / SSD など5モデルから選択。人・車・動物・家具など80クラスを検出。信頼度しきい値の調整、クラス別色分け表示
- **カスタムモデル学習 (転移学習)**: 独自データセットを作り、Faster R-CNN をファインチューニング。少クラス・少量データ (数十枚〜) でも実用的。ベースモデルは ResNet50 / MobileNetV3 / 事前学習なし (scratch) から選択
- **ブラウザ完結アノテーション**: 画像をアップロードし、ブラウザ上で矩形を描画してラベル付け。2つの入力方式 (ドラッグで矩形 / クリックで固定サイズ矩形を生成、サイズ4〜300px)。矢印キーで画像送り、↑キーで保存。サムネイル一覧で進捗 (矩形個数バッジ) を一覧表示しクリックでジャンプ
- **YOLO / COCO / CSV インポート**: 既存の YOLO 形式 (正規化座標) や COCO 形式のアノテーションを取り込み可能。さらに **CSV (ロング形式)** にも対応 — `filename,class,x1,y1,x2,y2` で、先にアップロード済みの画像にファイル名で紐付けて一括ラベル付け
- **LLM チャット連携**: 画像を添付して「何が写ってる?」と聞くと、LLM が `detect_objects` ツールを呼んで物体を検出し、結果を解釈して回答 (Vision対応モデルなら誤認識の訂正も)
- **学習ジョブ管理**: 表データ学習とは独立した系統 (`currentImageJob`) で管理。リアルタイムログ、停止 (プロセスグループごとkill)、学習履歴
- **モデルのダウンロード**: 学習済みモデルを zip でダウンロード (model.pt + config.json + 推論サンプル `predict_example.py` + README)。Node標準のzlibで生成するため外部コマンド不要。ダウンロードすれば torchvision さえあれば他環境でも単体推論できる
- **外部API**: `POST /ml/image/detect` に画像を base64 で送ると検出結果を JSON で返す。COCO・カスタム両対応。`Authorization: Bearer <token>` (`ml:read` 権限)
- **GPU自動フォールバック**: ROCm/CUDA で実行し、失敗時はCPUに自動切替。MIOpenキャッシュパスもアプリ内に設定済み

---

### 🖐️ 画像キーポイント検出 (2D / 3D)
`/ml.html` の「画像学習」タブ内、上部の **タスク切替「📦 物体検出 / 🖐️ キーポイント」** で利用。手の関節などを「対象(バウンディングボックス)＋順序付きのキーポイント(点)」として関連付け、学習・推論する。物体検出と同じ操作フロー (検出 / データセット / 学習) で扱える。**追加パッケージは torchvision のみ**、MediaPipe 等の外部依存なし。

- **2D キーポイント (torchvision Keypoint R-CNN)**:
  - **COCO事前学習で即検出**: 人物の姿勢17点を検出
  - **カスタム学習 (転移学習)**: 独自のキーポイント定義 (手21点など) を学習。COCO事前学習バックボーンを初期値に使うため少量データでも立ち上がりやすい。複数インスタンス対応
  - ベースモデル: Keypoint R-CNN (ResNet50) / 事前学習なし (scratch)
- **3D キーポイント (ResNet 回帰・MediaPipe不使用)**:
  - RGB画像1枚から各キーポイントの **(x, y, z)** を回帰。z は学習時に手動で付けた **相対深度 (-1〜1)**
  - バックボーン: ResNet18 / 34 / 50 (ImageNet事前学習)
  - 単一インスタンス前提 (画像内に対象1つ)。z は単眼RGBからの相対値 (絶対距離ではない)
- **アノテーションUI**: 対象を矩形で囲み、定義した順番にキーポイントをクリックして配置。可視/隠れ(occluded)/クリアの切替、骨格エッジ描画。3Dモードでは各点に **z スライダー** が出る
- **プリセット**: ✋ 手 (21点・MediaPipe風スケルトン)、🧍 人物 (17点/COCO)、🙂 顔 (5点) をワンクリックで投入
- **CSV インポート**: ロング形式 CSV でアノテーションを一括取り込み。2D は `filename,keypoint,x,y,v[,instance]`、3D は z 列を追加。矩形(box)列が無ければ可視点の外接矩形から自動生成
- **FreiHAND 変換ツール**: `freihand_to_csv.py` で公開手データセット [FreiHAND](https://lmb.informatik.uni-freiburg.de/projects/freihand/) を画像フォルダ + CSV に変換 (3D→2D投影、相対深度の正規化込み)。標準ライブラリのみで動作
- **モデルのダウンロード**: 学習済みモデルを zip でダウンロード (model.pt + config.json + 推論サンプル + README)。2D/3D それぞれに合った推論サンプルを同梱
- **外部API**: `POST /ml/image/keypoint/detect` に画像を base64 で送ると検出結果を JSON で返す (COCO人物 / カスタム2D / カスタム3D)。`Authorization: Bearer <token>` (`ml:read` 権限)
- **GPU自動フォールバック**: 物体検出と同様、ROCm/CUDA → CPU に自動切替

---

## 🚀 クイックスタート（OS別）

OpenGeekLLMChat は **Windows / macOS / Linux** すべてで動作します。以下、OSごとに手順を案内します。

### 共通要件

- **Node.js 18 以上**
- **Python 3.9 以上**（matplotlib・DuckDB等の機能を使う場合）
- **GGUFモデルファイル**（HuggingFaceからダウンロード）
- **Embeddingモデル**（mxbai-embed-large等、RAG使用時）
- GPU推奨（CPU専用でも動作するが大幅に遅い）

---

## 🐧 Linux（Ubuntu / Debian）

### 1. 依存パッケージのインストール

```bash
# ビルドツール
sudo apt update
sudo apt install -y build-essential cmake git curl

# Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Python関連（任意）
sudo apt install -y python3 python3-pip python3-venv \
  fonts-ipaexfont fonts-noto-cjk

# PDF OCR機能を使う場合（任意、pdftoppm / pdfinfo が入る）
sudo apt install -y poppler-utils
```

### 2. llama.cpp ビルド

```bash
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp

# === NVIDIA GPU（CUDA）===
# 事前に CUDA Toolkit をインストール: https://developer.nvidia.com/cuda-downloads
cmake -S . -B build -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j$(nproc)

# === AMD GPU（ROCm）===
# 事前に ROCm をインストール: https://rocm.docs.amd.com/projects/install-on-linux/en/latest/
# AMDGPU_TARGETS は使用GPUに合わせて変更
# RX 7900: gfx1100, R9700: gfx1201, MI300: gfx942 等
HIPCXX="$(hipconfig -l)/clang" HIP_PATH="$(hipconfig -R)" \
  cmake -S . -B build -DGGML_HIP=ON -DAMDGPU_TARGETS=gfx1100 -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j$(nproc)

# === Vulkan（汎用GPU、AMD/NVIDIA/Intel全部OK）===
sudo apt install -y libvulkan-dev glslc
cmake -S . -B build -DGGML_VULKAN=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j$(nproc)

# === CPU専用 ===
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j$(nproc)

# バイナリをインストール
sudo cp build/bin/llama-server /usr/local/bin/
```

### 3. モデル取得・OpenGeekLLMChat配置

```bash
# モデル
mkdir -p ~/models && cd ~/models
wget https://huggingface.co/bartowski/google_gemma-3-12b-it-GGUF/resolve/main/google_gemma-3-12b-it-Q4_K_M.gguf
wget https://huggingface.co/mixedbread-ai/mxbai-embed-large-v1/resolve/main/gguf/mxbai-embed-large-v1-f16.gguf

# OpenGeekLLMChat
cd ~
git clone https://github.com/<your-username>/opengeek-llm-chat.git
cd opengeek-llm-chat
npm install

# Python venv（任意）
python3 -m venv venv
source venv/bin/activate
pip install matplotlib numpy pandas duckdb pillow
# 機械学習(ML)機能を使う場合は追加で:
pip install scikit-learn torch
deactivate
```

### 4. config.json 編集 → 起動

```json
{
  "pythonPath": "/home/USER/opengeek-llm-chat/venv/bin/python",
  "llamaServer": {
    "binPath": "/usr/local/bin/llama-server",
    "chatPort": 8080,
    "embeddingPort": 8081,
    "commonArgs": ["-fa", "on", "--device", "ROCm0,ROCm1"]
  },
  "chatModels": [
    {
      "name": "Gemma3 12B Q4",
      "path": "/home/USER/models/google_gemma-3-12b-it-Q4_K_M.gguf",
      "ctx": 8192,
      "ngl": 99
    }
  ],
  "embeddingModel": {
    "path": "/home/USER/models/mxbai-embed-large-v1-f16.gguf",
    "ctx": 512,
    "ngl": 99,
    "poolingType": "mean"
  }
}
```

```bash
npm start
# → ブラウザで http://localhost:3000
```

### systemd サービス化

[デプロイセクション](#-デプロイsystemd) を参照。

---

## 🍎 macOS（Apple Silicon / Intel）

Apple SiliconならMetalで高速動作。Mシリーズ統合GPUは大量のVRAMを使えるため、70Bクラスもメモリ次第で動かせます。

### 1. 依存パッケージのインストール

```bash
# Homebrewインストール（未インストールの場合）
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 必要なツール
brew install cmake git node python@3.12

# PDF OCR機能を使う場合（任意、pdftoppm / pdfinfo が入る）
brew install poppler
```

### 2. llama.cpp ビルド（Metal）

```bash
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp

# Metal はデフォルトで有効
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j$(sysctl -n hw.logicalcpu)

# バイナリをインストール
sudo cp build/bin/llama-server /usr/local/bin/
```

### 3. モデル取得・OpenGeekLLMChat配置

```bash
mkdir -p ~/models && cd ~/models
curl -L -O https://huggingface.co/bartowski/google_gemma-3-12b-it-GGUF/resolve/main/google_gemma-3-12b-it-Q4_K_M.gguf
curl -L -O https://huggingface.co/mixedbread-ai/mxbai-embed-large-v1/resolve/main/gguf/mxbai-embed-large-v1-f16.gguf

cd ~
git clone https://github.com/<your-username>/opengeek-llm-chat.git
cd opengeek-llm-chat
npm install

# Python venv
python3 -m venv venv
source venv/bin/activate
pip install matplotlib numpy pandas duckdb pillow
# 機械学習(ML)機能を使う場合は追加で:
pip install scikit-learn torch
deactivate
```

### 4. config.json 編集 → 起動

```json
{
  "pythonPath": "/Users/USER/opengeek-llm-chat/venv/bin/python",
  "llamaServer": {
    "binPath": "/usr/local/bin/llama-server",
    "chatPort": 8080,
    "embeddingPort": 8081,
    "commonArgs": ["-fa", "on"]
  },
  "chatModels": [
    {
      "name": "Gemma3 12B Q4",
      "path": "/Users/USER/models/google_gemma-3-12b-it-Q4_K_M.gguf",
      "ctx": 8192,
      "ngl": 99
    }
  ],
  "embeddingModel": {
    "path": "/Users/USER/models/mxbai-embed-large-v1-f16.gguf",
    "ctx": 512,
    "ngl": 99,
    "poolingType": "mean"
  }
}
```

```bash
npm start
# → ブラウザで http://localhost:3000
```

### macOSでの自動起動（launchd）

```bash
# ~/Library/LaunchAgents/com.opengeek.llmchat.plist
cat > ~/Library/LaunchAgents/com.opengeek.llmchat.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.opengeek.llmchat</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/USER/opengeek-llm-chat/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/USER/opengeek-llm-chat</string>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/opengeek-llmchat.out</string>
  <key>StandardErrorPath</key>
  <string>/tmp/opengeek-llmchat.err</string>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.opengeek.llmchat.plist
launchctl start com.opengeek.llmchat
```

---

## 🪟 Windows（10 / 11）

### Option A: WSL2を使う（推奨・最も安定）

WSL2 (Windows Subsystem for Linux) でUbuntuを動かし、Linux手順を実行する方法。NVIDIA GPUなら CUDA-on-WSL でフル性能を引き出せます。

```powershell
# PowerShellを管理者として起動
wsl --install -d Ubuntu-24.04
# → 再起動後、Ubuntuターミナルが開く
```

その後、上記の **Linux（Ubuntu / Debian）** の手順をWSL内で実行。NVIDIA GPUを使う場合:

1. ホストWindowsに最新のNVIDIAドライバをインストール（CUDA-on-WSL対応）
2. WSL内でCUDA Toolkitをインストール:
   ```bash
   wget https://developer.download.nvidia.com/compute/cuda/repos/wsl-ubuntu/x86_64/cuda-keyring_1.1-1_all.deb
   sudo dpkg -i cuda-keyring_1.1-1_all.deb
   sudo apt update && sudo apt install -y cuda-toolkit
   ```
3. llama.cpp を CUDA でビルド

ブラウザはWindows側で `http://localhost:3000` でアクセスできます（WSL2の自動ポートフォワーディング）。

### Option B: ネイティブ Windows

Visual Studio C++ ビルドツールが必要、設定は少し手間ですがWSLなしで動かせます。

#### 1. 依存ツールのインストール

- **Visual Studio 2022 Community** + 「C++によるデスクトップ開発」ワークロード
  - https://visualstudio.microsoft.com/ja/downloads/
- **CMake**: https://cmake.org/download/
- **Git for Windows**: https://git-scm.com/download/win
- **Node.js LTS**: https://nodejs.org/ja
- **Python 3.12**: https://www.python.org/downloads/
- **poppler for Windows**（PDF OCR機能を使う場合のみ）: https://github.com/oschwartz10612/poppler-windows/releases
  - ZIPを展開して `Library\bin` を PATH に追加（`pdftoppm.exe` / `pdfinfo.exe` が入っています）
  - PATHを通さない場合は `config.json` の `ocr.pdfToImageCmd` / `ocr.pdfInfoCmd` にフルパスを指定
    （JSONなのでバックスラッシュは `\\` にエスケープするか、`"C:/poppler/Library/bin/pdftoppm.exe"` のように `/` で書きます）

#### 2. llama.cpp ビルド

「Developer PowerShell for VS 2022」を起動して:

```powershell
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp

# === NVIDIA GPU（CUDA）===
# 事前に CUDA Toolkit for Windows をインストール
cmake -S . -B build -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release

# === Vulkan（AMD/NVIDIA/Intel）===
# 事前に Vulkan SDK をインストール: https://www.lunarg.com/vulkan-sdk/
cmake -S . -B build -DGGML_VULKAN=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release

# === CPU専用 ===
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release

# llama-server.exe が build\bin\Release\ に生成される
```

#### 3. モデル取得・OpenGeekLLMChat 配置

```powershell
# モデル配置先
mkdir C:\models
cd C:\models
# ブラウザで HuggingFace から手動DL、または curl で
curl -L -o gemma-3-12b-it-Q4_K_M.gguf https://huggingface.co/bartowski/google_gemma-3-12b-it-GGUF/resolve/main/google_gemma-3-12b-it-Q4_K_M.gguf
curl -L -o mxbai-embed-large-v1-f16.gguf https://huggingface.co/mixedbread-ai/mxbai-embed-large-v1/resolve/main/gguf/mxbai-embed-large-v1-f16.gguf

# OpenGeekLLMChat
cd C:\
git clone https://github.com/<your-username>/opengeek-llm-chat.git
cd opengeek-llm-chat
npm install

# Python venv
python -m venv venv
.\venv\Scripts\activate
pip install matplotlib numpy pandas duckdb pillow
# 機械学習(ML)機能を使う場合は追加で:
pip install scikit-learn torch
deactivate
```

#### 4. config.json 編集（Windowsパスに注意）

JSONではバックスラッシュをエスケープ（`\\`）するか、フォワードスラッシュ（`/`）を使います:

```json
{
  "pythonPath": "C:/opengeek-llm-chat/venv/Scripts/python.exe",
  "llamaServer": {
    "binPath": "C:/llama.cpp/build/bin/Release/llama-server.exe",
    "chatPort": 8080,
    "embeddingPort": 8081,
    "commonArgs": ["-fa", "on"]
  },
  "chatModels": [
    {
      "name": "Gemma3 12B Q4",
      "path": "C:/models/gemma-3-12b-it-Q4_K_M.gguf",
      "ctx": 8192,
      "ngl": 99
    }
  ],
  "embeddingModel": {
    "path": "C:/models/mxbai-embed-large-v1-f16.gguf",
    "ctx": 512,
    "ngl": 99,
    "poolingType": "mean"
  }
}
```

#### 5. 起動

```powershell
npm start
# → ブラウザで http://localhost:3000
```

#### 6. Windowsサービス化（任意）

[NSSM](https://nssm.cc/) を使ってサービス化:

```powershell
# nssm をダウンロードしてPATHに配置
nssm install OpenGeekLLMChat "C:\Program Files\nodejs\node.exe" "C:\opengeek-llm-chat\server.js"
nssm set OpenGeekLLMChat AppDirectory "C:\opengeek-llm-chat"
nssm set OpenGeekLLMChat AppStdout "C:\opengeek-llm-chat\stdout.log"
nssm set OpenGeekLLMChat AppStderr "C:\opengeek-llm-chat\stderr.log"
nssm start OpenGeekLLMChat
```

---

## 🌐 共通: HTTPS化（任意・推奨）

ブラウザのセキュリティ制約（マイク、音声合成、クリップボード等）を回避するためHTTPS化します。

### 自己署名証明書で試す（Linux/macOS）

```bash
./generate-cert.sh localhost 192.168.1.100 your-hostname.local
npm start
# → 起動バナーが https:// に変わる
```

### 自己署名証明書（Windows）

```powershell
# Git Bash で generate-cert.sh を実行（推奨）
bash generate-cert.sh localhost 192.168.1.100

# または PowerShell で OpenSSL を使用（要OpenSSLインストール）
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes `
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

### 正規SSL証明書（Let's Encrypt等）

```bash
# 証明書を cert.pem と key.pem として配置
cp /path/to/fullchain.pem cert.pem
cp /path/to/privkey.pem key.pem
chmod 600 key.pem
# 秘密鍵にパスフレーズがある場合は事前に解除
# openssl rsa -in key.pem -out key.pem
npm start
```

HTTPS化すると、マイク・音声合成・クリップボード等のブラウザAPI制約が全て解消されます。

---

## 🆘 OS別トラブルシューティング

### Linux

| 症状 | 対処 |
|:--|:--|
| `permission denied: /usr/local/bin/llama-server` | `chmod +x /usr/local/bin/llama-server` |
| AMD GPUが認識されない | `rocm-smi` で確認、`AMDGPU_TARGETS` を正しく指定してビルド |
| `iGPUが選択されてしまう` | `--device ROCm0,ROCm1` で dGPU だけ指定 |
| Python `MPLCONFIGDIR is not writable` | systemdで `Environment=MPLCONFIGDIR=/tmp/matplotlib` |

### macOS

| 症状 | 対処 |
|:--|:--|
| `xcrun: error: invalid active developer path` | `xcode-select --install` |
| Metalで遅い | `-fa on` を必ず指定、`-ngl 99` で全レイヤーGPU |
| `command not found: brew` | Homebrewインストール後、`eval "$(/opt/homebrew/bin/brew shellenv)"` |

### Windows

| 症状 | 対処 |
|:--|:--|
| `cmake: command not found` | CMakeをインストール、PATH追加 |
| ビルドエラー `MSVC not found` | Visual Studio "C++によるデスクトップ開発" を入れ直し |
| ファイアウォールでブロック | Windows Defender ファイアウォールで Node.js を許可 |
| 日本語ファイル名でエラー | コンソールを `chcp 65001` でUTF-8に |
| WSL2でGPU認識されない | NVIDIAドライバ最新版+`nvidia-smi` がWSL内で動くか確認 |

---

## 📁 リポジトリ構成

```
opengeek-llm-chat/
├── server.js                   # Express + WebSocket、llama-serverプロセス管理
├── generate-cert.sh            # 自己署名SSL証明書生成スクリプト
├── hashpass.py                 # パスワードハッシュ生成ツール
├── config.json                 # 全設定（tuning セクション含む）
├── package.json                # express + ws のみ
├── opengeek-llm-chat.service   # systemdサービステンプレート
├── transcribe-server.py        # Gemma4 E2B音声認識サーバー（参考実装・非推奨）
├── TRANSCRIBE.md               # 音声認識セットアップガイド（参考）
├── cert.pem / key.pem          # SSL証明書（配置時にHTTPSモード起動）
├── tune_runner.py              # ファインチューニング実行 (TRL SFTTrainer)
├── merge_adapter.py            # LoRAアダプタをベースモデルにマージ
├── convert_to_gguf.py          # HF→GGUF変換＆量子化 (llama.cpp呼び出し)
├── tune_requirements.txt       # ファインチューニング依存パッケージ
├── ml_runner.py                # 機械学習(ML)学習実行 (PyTorch MLP/LSTM)
├── ml_predict.py               # 機械学習(ML)推論実行 (subprocess単発)
├── ml_common.py                # 機械学習の共通前処理ロジック (学習・推論で共有)
├── rl_runner.py                # 強化学習(RL)オフライン学習 (DuckDB→PyTorch DQN/DDQN/CQL/BC)
├── rl_online_server.py         # 強化学習(RL)オンライン常駐ワーカー (act/learn HTTP API)
├── rl_common.py                # 強化学習の共通ロジック (Qネット構築・状態エンコード・損失計算)
├── agent_proxy.js              # 外部API用ツール対応モード (OpenAI互換 + エージェントループ)
├── google_drive.js             # Google Drive 連携 (OAuth2/サービスアカウント + Drive API v3、依存なし)
├── gdrive_token.json           # Driveのリフレッシュトークン (自動生成・gitignore済み・chmod600)
├── llm_pool.js                 # マルチLLMワーカープール (複数llama-server同時起動・VRAM自動判定)
├── gguf_info.js                # GGUFのVRAM見積り診断ツール (node gguf_info.js で全モデル診断)
├── orchestrator.js             # マルチLLMオーケストレーション実行エンジン (ワークフローDAG実行)
├── ocr.js                      # PDF OCR パイプライン (pdftoppm + Vision LLM + ジョブキュー、依存なし)
├── public/
│   ├── index.html              # React SPA（チャットUI）
│   ├── styles.css              # メインスタイルシート (CSS変数, レイアウト, コンポーネント)
│   ├── tuning.html             # React SPA（ファインチューニングUI）
│   ├── tuning-styles.css       # ファインチューニングUI用スタイル
│   ├── ml.html                 # React SPA（機械学習UI）
│   ├── ml-styles.css           # 機械学習UI用スタイル
│   ├── ocr.html                # React SPA（PDF OCR / RAG登録UI）
│   ├── ocr-styles.css          # OCR UI用スタイル（レイアウトは tuning-styles.css を共用）
│   ├── editconfig.html         # React SPA（config.json編集UI、本体再起動も可能）
│   ├── editconfig-styles.css   # config編集UI用スタイル
│   ├── aiicon.jpg              # アイコン（任意）
│   ├── uploads/                # LLMが読み書きするディレクトリ
│   │                           #  （Python実行の作業ディレクトリ、生成画像保存先）
│   └── plots/                  # matplotlibが自動生成した画像（list_filesから除外）
├── models/                     # 言語/画像モデル（自動生成、ユーザー配置）
│   ├── *.gguf                  # llama.cpp用 GGUF モデル
│   └── sd/                     # 画像生成用 (.safetensors)
│       ├── sd_xl_base_1.0.safetensors
│       └── sdxl_vae.safetensors
├── tuning/                     # ファインチューニングのデータ（自動生成）
│   ├── samples.jsonl           # 学習サンプルDB
│   ├── jobs.json               # ジョブ履歴
│   └── runs/<job_id>/          # ジョブ毎の作業ディレクトリ
│       ├── config.json         # ジョブ設定
│       ├── train.jsonl         # 実行時の学習データスナップショット
│       ├── training.log        # 学習ログ
│       ├── postprocess.log     # 後処理ログ
│       ├── adapter/            # 学習済みLoRAアダプタ
│       ├── merged/             # マージ済みフルモデル
│       └── *.gguf              # GGUF変換結果
├── ml/                         # 機械学習データ・モデル（自動生成）
│   ├── datasets.duckdb         # DuckDB データ本体 (全テーブル統合)
│   ├── meta.json               # テーブル説明・取得元URL等のメタ情報
│   ├── models.json             # モデル定義一覧
│   ├── jobs.json               # 学習ジョブ履歴
│   ├── models/<model_name>/    # 学習済みモデル成果物
│   │   ├── config.json         # モデル設定 + 派生情報
│   │   ├── model.pt            # PyTorch state_dict
│   │   ├── scaler.pkl          # StandardScaler 情報
│   │   ├── label_encoders.pkl  # カテゴリ列のエンコーダ
│   │   ├── metrics.json        # 学習指標 + 履歴
│   │   └── train.log           # 学習ログ
│   ├── rag/                    # 外部API用 永続RAGドキュメント
│   │   ├── index.json          # 登録ドキュメント一覧
│   │   └── <docId>.json        # チャンク + embeddingベクトル
│   └── ocr/                    # PDF OCR の作業データ（自動生成）
│       ├── jobs.json           # OCRジョブの状態（再起動しても復元される）
│       └── cache/<jobId>/      # ページ単位のMarkdownキャッシュ（中断ジョブの再開用）
│           └── pXXXX.md        # 1ページぶんのOCR結果
├── chats/                      # チャット履歴JSON（自動生成）
├── settings.json               # ユーザー設定（自動生成）
├── DESIGN.md                   # 設計ドキュメント
├── README.md                   # これ
├── RELEASE_NOTES.md            # リリースノート
└── LICENSE                     # MIT
```

---

## ⚙️ config.json

全ての挙動は `config.json` で制御できます。

```json
{
  "appName": "OpenGeekLLMChat",
  "logoMain": "OpenGeekLLM",
  "logoSub": "LLM Chat",
  "accentColor": "#34d399",
  "defaultModel": "",
  "password": "",
  "pythonPath": "python3",
  "logLevel": "quiet",

  "maxRequestSize": "100mb",
  "maxFileSize": 50,
  "maxHeaderSize": 65536,
  "requestTimeoutSec": 600,
  "headersTimeoutSec": 120,
  "keepAliveTimeoutSec": 60,

  "llamaServer": {
    "binPath": "/usr/local/bin/llama-server",
    "chatHost": "127.0.0.1",
    "chatPort": 8080,
    "embeddingHost": "127.0.0.1",
    "embeddingPort": 8081,
    "commonArgs": ["-fa", "on"],
    "readyTimeoutMs": 120000,
    "idleUnloadMs": 600000,
    "nParallel": 1
  },

  "chatModels": [
    {
      "name": "Gemma3 12B Q4",
      "path": "/home/USER/models/gemma-3-12b-it-Q4_K_M.gguf",
      "ctx": 8192,
      "ngl": 99,
      "nParallel": 1,
      "extraArgs": []
    }
  ],

  "embeddingModel": {
    "path": "/home/USER/models/mxbai-embed-large-v1-f16.gguf",
    "ctx": 512,
    "ngl": 99,
    "poolingType": "mean"
  },

  "webSearch": true,
  "fileAccess": true,

  "googleDrive": {
    "enabled": false,
    "authMode": "oauth",
    "clientId": "",
    "clientSecret": "",
    "redirectUri": "http://localhost:3000/gdrive/auth/callback",
    "serviceAccountKeyFile": "",
    "impersonateUser": "",
    "rootFolderId": "",
    "readOnly": true,
    "allowWrite": false,
    "allowDelete": false,
    "maxDownloadMB": 20,
    "maxUploadMB": 20,
    "maxTextChars": 20000,
    "defaultPageSize": 30,
    "sharedDrives": true,
    "tokenFile": "gdrive_token.json"
  },

  "ocr": {
    "enabled": true,
    "vlmEndpoint": "http://localhost:8090/v1/chat/completions",
    "vlmModel": "qwen2.5vl",
    "dpi": 300,
    "maxTokens": 6144,
    "temperature": 0.1,
    "pageTimeoutSec": 600,
    "pageRetries": 1,
    "maxConcurrentJobs": 1,
    "maxUploadMB": 300,
    "cacheDir": "ml/ocr/cache",
    "jobsFile": "ml/ocr/jobs.json",
    "pdfToImageCmd": "pdftoppm",
    "pdfInfoCmd": "pdfinfo",
    "autoRegisterToRag": true,
    "keepPdf": true,
    "prompt": "この画像は書籍のスキャンページです。..."
  },

  "ragTopK": 10,
  "ragMode": "agentic",
  "agentContext": {
    "smallPredict": 512,
    "largePredict": 8192,
    "judgeHistoryCount": 3,
    "largeGenKeywords": null
  },
  "tokenAvgWindow": 2000,
  "recentMessageCount": 6,
  "topK": 40, "topP": 0.9, "temperature": 0.7
}
```

| キー | 説明 |
|:--|:--|
| `appName` / `logoMain` / `logoSub` | 表示名・ロゴ |
| `accentColor` | テーマカラー（HEX） |
| `defaultModel` | 初期モデル名（chatModels の `name`、空→一覧先頭） |
| `password` | MD5/SHA-256ハッシュ（空→認証なし） |
| `pythonPath` | Python実行時のコマンド（venv対応、例: `.venv/bin/python3`） |
| `logLevel` | `normal`(全ログ) / `quiet`(最小限、本番推奨) |
| `maxRequestSize` | JSONボディ上限（Express、デフォルト `"100mb"`）。画像Base64・大きなtoolsに対応 |
| `maxFileSize` | アップロードファイル上限（MB、デフォルト `50`） |
| `maxHeaderSize` | HTTPヘッダー上限（バイト、デフォルト `65536`）。`Authorization` + 大きな`tools`配列でヘッダーが大きくなる場合に対応 |
| `requestTimeoutSec` | リクエストタイムアウト（秒、デフォルト `600`） |
| `headersTimeoutSec` | ヘッダー受信タイムアウト（秒、デフォルト `120`） |
| `keepAliveTimeoutSec` | Keep-Alive（秒、デフォルト `60`） |
| `llamaServer.binPath` | `llama-server` バイナリのパス |
| `llamaServer.chatPort` | チャット推論用llama-serverのポート（デフォルト8080） |
| `llamaServer.embeddingPort` | Embedding用llama-serverのポート（デフォルト8081） |
| `llamaServer.commonArgs` | 全モデル共通の起動引数（GPU指定、Flash Attention等） |
| `llamaServer.readyTimeoutMs` | モデル起動完了までのタイムアウト（デフォルト120000ms） |
| `llamaServer.idleUnloadMs` | アイドル時の自動アンロード時間（ms、0で無効、推奨600000=10分） |
| `llamaServer.nParallel` | llama-serverの並列スロット数 `-np`（デフォルト1）。1にすると ctx をフル活用、大きいリクエスト・長文に有利 |
| `chatModels[]` | 利用可能なチャットモデル一覧（複数可） |
| `chatModels[].name` | UIに表示される名前 |
| `chatModels[].path` | GGUFファイルのフルパス |
| `chatModels[].ctx` | コンテキスト長（モデル毎、起動時固定。UIにも表示される） |
| `chatModels[].ngl` | GPUレイヤー数（99で全レイヤーGPU、0でCPUのみ） |
| `chatModels[].nParallel` | このモデル個別の `-np` 値（指定時は `llamaServer.nParallel` より優先） |
| `chatModels[].extraArgs` | このモデル専用の追加引数（`--mmproj`によるVision対応等） |
| `embeddingModel.path` | RAG用Embeddingモデル（GGUF） |
| `embeddingModel.poolingType` | `mean` / `cls` / `last` / `none` |
| `embeddingModel.extraArgs` | Embedding専用の追加引数（GPU指定など） |
| `tuning.pythonPath` | ファインチューニング用Python（venv-tuning推奨）の絶対パス |
| `tuning.llamaCppDir` | llama.cppディレクトリの絶対パス（GGUF変換・量子化に使用） |
| `tuning.env` | ファインチューニング実行時に渡す環境変数（`HSA_OVERRIDE_GFX_VERSION` 等） |
| `tuning.modelPresets[]` | UIに表示されるベースモデルプリセット（自由に追加可） |
| `tuning.modelPresets[].value` | HuggingFace Model ID または ローカルHFディレクトリパス |
| `tuning.modelPresets[].size` | 表示用サイズ（`0.5B`、`7B` 等） |
| `tuning.modelPresets[].vramLora` | LoRA時VRAM目安（ホバー表示用） |
| `tuning.modelPresets[].desc` | ホバー時の説明 |
| `tuning.modelPresets[].epochs/lr/batch/accum/r/alpha/maxLen` | プリセット選択時に自動入力されるハイパラ |
| `webSearch` | DuckDuckGo検索 ON/OFF（UIトグル初期値） |
| `fileAccess` | サーバーファイル読み書き ON/OFF |
| `googleDrive.enabled` | Google Drive 連携 ON/OFF |
| `googleDrive.authMode` | `oauth`（個人アカウント・推奨） / `serviceAccount`（ヘッドレス・共有ドライブ） |
| `googleDrive.clientId` / `clientSecret` | OAuth クライアント認証情報（Google Cloud Console で発行）。`/config` では公開されない |
| `googleDrive.redirectUri` | OAuth のリダイレクト先。Cloud Console の「承認済みリダイレクトURI」と完全一致させる |
| `googleDrive.serviceAccountKeyFile` | サービスアカウントJSONキーのパス（相対ならサーバーのディレクトリ基準） |
| `googleDrive.impersonateUser` | Workspace のドメイン全体の委任で代理するユーザー（サービスアカウント時のみ） |
| `googleDrive.rootFolderId` | 指定するとこのフォルダ配下だけにアクセスを限定（親を遡って範囲外を拒否） |
| `googleDrive.readOnly` | `true`（既定）で読み取り専用。書き込みツールをLLMに提示しない |
| `googleDrive.allowWrite` | `readOnly:false` と両方 true で書き込み許可 |
| `googleDrive.allowDelete` | ゴミ箱への移動を許可 |
| `googleDrive.maxDownloadMB` / `maxUploadMB` | 1ファイルあたりの上限（既定20MB） |
| `googleDrive.maxTextChars` | LLMに渡すテキストの最大文字数（既定20000） |
| `googleDrive.sharedDrives` | 共有ドライブ（旧チームドライブ）も対象に含める |
| `googleDrive.tokenFile` | リフレッシュトークンの保存先（既定 `gdrive_token.json`、chmod600） |
| `ocr.enabled` | PDF OCR 機能 ON/OFF。要 poppler-utils（`pdftoppm` / `pdfinfo`） |
| `ocr.vlmEndpoint` | Vision LLM の OpenAI互換エンドポイント（Qwen2.5-VL 等を別ポートで起動しておく） |
| `ocr.vlmModel` | リクエストの `model` フィールドに入れる名前 |
| `ocr.dpi` | ページ画像化の解像度（既定300。上げると精度は上がるが遅く・重くなる） |
| `ocr.maxTokens` / `temperature` | 1ページあたりの生成上限とランダム性（既定 6144 / 0.1） |
| `ocr.pageTimeoutSec` | 1ページのOCRタイムアウト（秒、既定600） |
| `ocr.pageRetries` | ページ失敗時のリトライ回数（既定1）。使い切ったらそのページはスキップしジョブは継続 |
| `ocr.maxConcurrentJobs` | 同時実行ジョブ数（既定1＝単一GPU前提。マルチGPUなら増やせる） |
| `ocr.maxUploadMB` | PDF 1ファイルのアップロード上限（既定300MB） |
| `ocr.cacheDir` / `jobsFile` | ページキャッシュとジョブ状態の保存先（中断ジョブの再開・再起動復元に使う） |
| `ocr.pdfToImageCmd` / `pdfInfoCmd` | poppler-utils のコマンド名。PATHが通っていなければ絶対パスを指定（Windows は `"C:/poppler/Library/bin/pdftoppm.exe"` のように `/` 区切りが書きやすい） |
| `ocr.autoRegisterToRag` | 完了後に生成Markdownを自動でRAG登録するか（既定true） |
| `ocr.keepPdf` | 完了後もアップロードしたPDFを `uploads/` に残すか（既定true） |
| `ocr.prompt` | Vision LLM に渡すOCR指示。表・数式・図の扱いをここで調整する |
| `imageGen` | 画像生成（stable-diffusion.cpp連携）ON/OFF。`imageModels[]` を定義した上で `true` にして有効化 |
| `stableDiffusion.binPath` | sd-server バイナリの絶対パス |
| `stableDiffusion.port` | sd-server HTTP ポート（内部通信用、デフォルト 7860） |
| `stableDiffusion.readyTimeoutMs` | 起動完了待ちタイムアウト、デフォルト 90000ms |
| `stableDiffusion.idleUnloadMs` | アイドル時自動アンロード時間（VRAM節約）、0で無効 |
| `stableDiffusion.defaultModel` | デフォルトで使う画像生成モデル名 |
| `stableDiffusion.env` | sd-server 実行時環境変数（ROCm用 `HSA_OVERRIDE_GFX_VERSION` 等） |
| `imageModels[].name` | UI表示用モデル名 |
| `imageModels[].path` | モデルファイル(.safetensors)の絶対パス |
| `imageModels[].vae` | VAEモデルの絶対パス（任意、品質向上） |
| `imageModels[].extraArgs` | sd-server に渡す追加引数（例: `["--type", "f16"]`） |
| `ttsGen` | 音声合成（Irodori-TTS連携）ON/OFF。`irodoriTts` を設定した上で `true` にして有効化 |
| `irodoriTts.host` / `port` | Irodori-TTS サーバーの内部通信ホスト/ポート（デフォルト 127.0.0.1:8088） |
| `irodoriTts.endpoint` | OpenAI互換エンドポイント（デフォルト `/v1/audio/speech`） |
| `irodoriTts.model` | リクエストの `model` フィールド（デフォルト `irodori-tts`） |
| `irodoriTts.defaultVoice` | 声指定が無いときの voice ID（`voices/` のファイル名） |
| `irodoriTts.defaultFormat` | 出力フォーマット（`wav`/`mp3`/`flac`/`opus`/`aac`/`pcm`） |
| `irodoriTts.captionField` | 声のテキスト記述を `irodori` 内のどのキーで送るか（デフォルト `caption`、`null`で無効） |
| `irodoriTts.command` / `args` / `cwd` / `env` | サーバー子プロセス自動起動の spawn 設定。`command` を `null` にすると外部起動済みとみなし転送のみ |
| `irodoriTts.readyTimeoutMs` | 起動完了待ちタイムアウト、デフォルト 300000ms |
| `irodoriTts.idleUnloadMs` | アイドル時自動アンロード時間（VRAM節約）、0で無効 |
| `ttsVoices[].name` | 声プリセット名（LLMがこの名前で指定可能） |
| `ttsVoices[].voiceId` | サーバーの voice ID（リファレンス音声ファイル名）にマッピング |
| `ttsVoices[].instructions` | 声のテキスト記述（VoiceDesign のキャプション） |
| `ml.enabled` | 機械学習機能 ON/OFF。`true` で `/ml.html` UI と LLMツール (ml_*) を有効化、要 `npm install duckdb` |
| `ml.onlinePort` | 強化学習(RL)オンライン常駐ワーカー (`rl_online_server.py`) の localhost ポート、デフォルト 11600 |
| `ml.onlineIdleMs` | オンラインワーカーのアイドル自動停止時間 (ms)、0 で常駐 (停止しない) |
| `ml.onlineReadyTimeoutMs` | オンラインワーカー起動完了待ちタイムアウト、デフォルト 60000ms |
| `ml.apiTokens[].name` | API トークンの名前 (識別用) |
| `ml.apiTokens[].token` | トークン文字列 (推奨: ml.html の「📡 API」タブから生成) |
| `ml.apiTokens[].permissions` | 権限配列。`"ml:read"` / `"ml:write"` / `"*"` |
| `orchestration.enabled` | マルチLLMオーケストレーション ON/OFF（デフォルト `false`） |
| `orchestration.poolMode` | `"auto"`（空きVRAMで自動判定） / `"resident"`（全同時常駐） / `"swap"`（1つずつ載せ替え） |
| `orchestration.portRange` | ワーカーllama-serverに割り当てるポート範囲、デフォルト `[8100, 8149]` |
| `orchestration.maxResident` | 同時常駐ワーカー数の上限（resident時）、デフォルト3 |
| `orchestration.workerParallel` | ワーカーの `-np`、デフォルト1。2以上にすると同一モデルへ並列に投げられるが、llama.cpp は `ctx` をスロット数で分割するため1回あたりの文脈が狭くなる |
| `orchestration.workerHost` | ワーカーのバインドアドレス、デフォルト `127.0.0.1`（外部公開しない） |
| `orchestration.idleUnloadMs` | ワーカーのアイドルアンロード（ms、0で無効）、デフォルト600000=10分 |
| `orchestration.vramSafetyMarginMB` | auto判定で確保しておく空きVRAMの余裕、デフォルト1536 |
| `orchestration.reuseMainChat` | メインチャットに同じモデルが載っていれば再利用する、デフォルト `true` |
| `orchestration.swapUnloadsMainChat` | swap時にメインチャットモデルを一時アンロードして枠を空ける、デフォルト `true` |
| `orchestration.relayMaxChars` | 中間出力を下流ノードに渡す際の最大文字数、デフォルト6000 |
| `orchestration.includeBaseSystemPrompt` | 各ノードに `systemPrompts.base` を含めるか、デフォルト `true` |
| `orchestration.stopOnNodeError` | ノード失敗でワークフロー全体を中断するか、デフォルト `false`（他ノードの結果で回答） |
| `orchestration.defaultWorkflow` | チャット画面で初期選択するワークフローID（空=未選択） |
| `orchestration.workflows[]` | ワークフロー定義。**ブラウザのワークフローエディタから編集・保存される**（手書き不要） |
| `ragTopK` | RAG検索チャンク数 |
| `ragMode` | `agentic` / `always` |
| `ragChunkSize` / `ragChunkOverlap` | 分割の粒度と重なり。embedding の ctx（BERT系は512トークン）を超えないこと。変更したら再登録が必要 |
| `ragNeighborChunks` | ヒットの前後何チャンクを一緒に渡すか。数式と記号定義が分断されるのを防ぐ（0で無効） |
| `ragRelaxSamplers` | 検索結果を渡して回答させる時、繰り返しペナルティ（DRY・repeat_penalty）を外す。既定 `true`。**RAG で原文どおりの引用が必要なら切らないこと**（詳細は下記） |
| `ragAlwaysSearch` | 毎ターン必ず永続RAGを検索する。判断モデルが `web_search` を選んだり検索を省いたりする場合に `true`。既定 `false`（チャット欄の📚トグルがONのチャットでのみ効く） |
| `ragEnabledByDefault` | チャット欄の📚トグル（登録資料の検索）の初期値。既定 `false` = OFF。常時RAGを引く運用なら `true` |
| `ragLedgerTurns` | 直近いくつの回答ぶんの出典（資料名・ページ・抜粋）を次のターンへ持ち越すか、デフォルト1（0で無効） |
| `ragLedgerChars` | 持ち越す1出典あたりの抜粋文字数、デフォルト400（0ならページ対応表のみ） |
| `agentContext.smallPredict` | ツール判断時のmax_tokens（短文モード）デフォルト512 |
| `agentContext.largePredict` | ツール判断時のmax_tokens（長文モード）+ continueGen時、デフォルト8192 |
| `agentContext.judgeHistoryCount` | ツール判断時に送る直近メッセージ件数、デフォルト3 |
| `agentContext.largeGenKeywords` | 長文モード判定キーワード（null=デフォルト使用） |
| `historyMode` | 会話履歴の送信方式。`compaction`（Claude風、上限接近時のみLLM要約で圧縮、デフォルト）/ `weighted`（従来の直近優先圧縮） |
| `contextCompaction.threshold` | コンパクション発動の使用率閾値（n_ctx比）、デフォルト0.75 |
| `contextCompaction.keepRecent` | 圧縮後も原文のまま残す直近メッセージ件数、デフォルト4 |
| `contextCompaction.summaryMaxTokens` | 要約生成時のmax_tokens、デフォルト1024 |
| `recentMessageCount` | `weighted`モード時: 直近何件を「そのまま」送信するか（それ以前は「参考情報」化）デフォルト6 |
| `systemPrompts.*` | システムプロンプトのカスタマイズ（後述） |
| `topK`/`topP`/`temperature` | LLM推論パラメータ |

### ⚙️ logLevel について

llama-serverは起動時に大量のメタデータをstderrに出力します。本番運用では `"logLevel": "quiet"` を推奨します。

| 設定 | 動作 |
|:--|:--|
| `"normal"` (デフォルト) | llama-serverの全stdout/stderr + プロキシ毎リクエストログを表示 |
| `"quiet"` | llama-serverのstdout/stderrを破棄、プロキシログも抑制。残るのは起動バナー・spawn・認証・Python実行・Web検索・エラーのみ |

### 🛌 idleUnloadMs（自動アンロード）

`llamaServer.idleUnloadMs > 0` の場合、最終使用時刻から指定ms経過するとチャットモデル/Embeddingモデルを自動アンロード（VRAM解放）します。次のリクエスト時に自動再ロードされます。

| 値 | 動作 |
|:--|:--|
| `0` (デフォルト) | 自動アンロード無効（モデル常駐） |
| `300000` (5分) | 短め、頻繁にアンロード |
| `600000` (10分) | バランス推奨 |
| `1800000` (30分) | 長め |
| `3600000` (1時間) | ほぼ常駐 |

複数のモデルを使い分けたいが、VRAMを節約したい場合に有効です。30秒間隔でチェックするため、実際のアンロードは設定時間 +0〜30秒。

**動作仕様**:
- **サーバー起動時**: モデルは起動せず、前回使用モデル名のみ記憶（`settings.json`）
- **初回チャット送信時**: 記憶したモデルが自動ロード（10〜30秒）→ 送信処理続行
- **アイドル超過時**: 自動アンロード → 次回送信時に自動再ロード
- **モデル切替時**: 古いモデル停止 → 新モデル起動（自動）
- **Embeddingモデル**: ドキュメントD&D時にオンデマンドロード、同じ `idleUnloadMs` でアンロード

### 🎨 systemPrompts のカスタマイズ

LLMへの指示文を `config.json` の `systemPrompts` キーで完全カスタマイズ可能。`{date}` は実時間で、`{docList}` はドキュメント名カンマ区切りで、`{toolList}` は利用可能ツール一覧で動的に展開されます。

```json
{
  "systemPrompts": {
    "base": "あなたは親切で知識豊富なAIアシスタントです。今日の日付は{date}です。\n\n## 応答の基本\n- 日本語で、結論から書き始めてください。...",
    "documents": "## チャット添付ドキュメント: {docList}\n- ユーザーが「ドキュメント」「資料」「添付ファイル」に触れたら、まず search_documents で検索してから答えてください...",
    "webSearch": "## Web検索\n- 学習後に変わっている可能性がある情報（ニュース・価格・バージョン・日付に依存する事実）...は web_search で検索してから答えてください...",
    "fileAccess": "## サーバーファイル操作（uploads配下。チャット添付ドキュメントとは別物）\n- list_files: uploadsフォルダの一覧を取得\n...",
    "python": "## Pythonコード\n- コード作成・計算・グラフ・データ処理の依頼には、応答に ```python ... ``` コードブロックを含めるだけで完結します...",
    "meta": "## 最終応答の書き方\n- ユーザーへの応答は、結論から直接書き始めてください。...",
    "judge": "以下のツールが使えます。...\n{toolList}\n\n## 判断の基準\n...\n## 判断例\n..."
  }
}
```

デフォルトのプロンプトは次の方針で書かれています（27B級ローカルモデルでの指示追従を意識）:
- **Markdown見出しで構造化**: 複数セクションが連結されても、どこからどこまでが何の規則か判別できる
- **禁止列挙ではなく条件付き肯定形**: 「〜するな」より「この場合はこうする」の方が小型モデルに通りやすく、禁止語の混入も防げる
- **理由の一行添え**: 括弧書きで「なぜそうするか」を付け、ルールの過剰適用・誤発動を減らす
- **judge に few-shot 判断例**: 「入力→ツールを呼ぶ/直接応答」の対比例で、キーワード規則より汎化させる

部分的に上書きすることもできます（指定しないキーはデフォルトが使用される深いマージ）。例えば「役割」だけ変えたい場合:

```json
{
  "systemPrompts": {
    "base": "あなたは社内文書専門のアシスタントです。質問には必ず添付ドキュメントから根拠を引用して回答してください。今日の日付は{date}です。"
  }
}
```

| キー | 用途 | 利用可能変数 |
|:--|:--|:--|
| `base` | 全フェーズ共通の土台 | `{date}` |
| `documents` | ドキュメント添付時の追記 | `{docList}` |
| `webSearch` | Web検索有効時の追記 | - |
| `fileAccess` | サーバーファイル操作有効時の追記 | - |
| `googleDrive` | Google Drive 連携が有効かつ接続済みの時の追記 | - |
| `python` | Python実行案内（常時） | - |
| `meta` | メタ抑制指示（常時） | - |
| `judge` | ツール判断専用（軽量） | `{toolList}` |
| `rag` | サーバー登録ドキュメント（RAG）の引用ルール。原文どおりの数式・記号の書き写し、出典キー `【S1】` の付与、記憶に頼った引用の禁止など | - |

---

## 🔒 パスワード認証

```bash
# MD5ハッシュ生成
python3 hashpass.py mysecret
# → "098f6bcd..."
```

```json
"password": "098f6bcd4621d373cade4e832627b4f6"
```

サーバー再起動でログイン画面が表示されます。空文字で認証解除。

---

## ⚡ マルチGPU構成（テンソル並列）

llama.cppは1モデルを複数GPUに分散できます（テンソル並列）。VRAMを束ねて大規模モデルを動かしたい場合に有効。

### 全GPUを使う（デフォルト）

config.jsonで何も指定しなければ全GPUが使用されます:

```json
{
  "llamaServer": {
    "commonArgs": ["-fa", "on"]
  }
}
```

### 特定GPUのみ使う

複数GPUの中で特定のものだけ使いたい場合（iGPU除外、特定枚数だけ等）:

```json
{
  "llamaServer": {
    "commonArgs": ["-fa", "on", "--device", "ROCm0,ROCm1"]
  }
}
```

NVIDIA環境なら `--device CUDA0,CUDA1` のように指定。

### モデル毎にGPU指定

`chatModels[].extraArgs` でモデル毎にGPUを変えることも可能:

```json
{
  "chatModels": [
    {
      "name": "Big Model 70B",
      "path": "/models/big.gguf",
      "ctx": 8192,
      "ngl": 99,
      "extraArgs": ["--device", "ROCm0,ROCm1,ROCm2"]
    },
    {
      "name": "Small Model 7B",
      "path": "/models/small.gguf",
      "ctx": 16384,
      "ngl": 99,
      "extraArgs": ["--device", "ROCm0"]
    }
  ]
}
```

### Embedding専用GPU

軽量なEmbeddingモデルは1枚で十分:

```json
{
  "embeddingModel": {
    "path": "/models/mxbai-embed-large-v1-f16.gguf",
    "extraArgs": ["--device", "ROCm0"]
  }
}
```

### `amd-smi` / `nvidia-smi` / `rocm-smi` での確認

OpenGeekLLMChatのGPUタブで全GPUの使用率がリアルタイム表示されます。Linuxサーバーの場合、以下の順序で自動検出されます:

1. **`amd-smi`** (ROCm 6.x以降の新標準) - 最優先
2. **`rocm-smi`** (レガシー)
3. **`nvidia-smi`** (NVIDIA環境)

各GPUカードには **GPU名 / 使用率 / 温度 / 電力 / VRAM / クロック** がリアルタイム表示されます。APUのiGPU（VRAM≤4GB、CU<8、gfx10[345]x系）は LLM 用途に不要なので自動的に除外されます。

バックエンドはサーバー起動ログで確認可能:
```bash
sudo journalctl -u opengeek-llm-chat | grep "GPU backend"
# → GPU backend: amd-smi  などが表示される
```

---

## 🧠 Agentic RAG の仕組み

```
ユーザー: "今日のニュース教えて"
  ↓
LLM: 🌐 web_search("2026年4月14日 主要ニュース") → 5件取得
  ↓
LLM: 検索結果を元に回答生成（ストリーミング）

ユーザー: "このdata.jsonを要約して"
  ↓
LLM: 📁 read_file("data.json") → 内容取得
  ↓
LLM: 要約してストリーミング応答

ユーザー: "cube_sim.py に物理シミュレーションコードを保存"
  ↓
LLM: ✍️ write_file("cube_sim.py", "...長いコード...") → 保存完了
  ↓
LLM: 保存しましたと応答 + コード解説
```

LLMが自分で判断してツールを呼びます。プロンプトに「検索してから回答しろ」と書く必要はありません。

---

## ☁️ Google Drive 連携のセットアップ

LLMから Google Drive のファイルを検索・閲覧・（許可すれば）書き込みできるようにします。
**追加の npm パッケージは不要**です（Node標準の `https` / `crypto` だけで OAuth2 と Drive API v3 を実装しています）。

認証方式は2つ。ふつうは **OAuth（個人アカウント）** で十分です。

| 方式 | 向いている用途 | 特徴 |
|:--|:--|:--|
| `oauth` | 自分の Google アカウントのドライブを見せたい | ブラウザで1回同意するだけ。リフレッシュトークンを保存して以後は自動更新 |
| `serviceAccount` | ヘッドレス運用・共有ドライブ・Workspace | JSONキーだけで動く。ブラウザ操作不要。共有ドライブまたはフォルダをサービスアカウントに共有しておく必要あり |

---

### 方式A: OAuth（個人アカウント・推奨）

#### 1. Google Cloud Console で認証情報を作る

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成（または既存を選択）
2. **APIとサービス → ライブラリ** から **Google Drive API** を検索して **有効にする**
3. **APIとサービス → OAuth同意画面** を設定
   - User Type: 個人利用なら **外部**（社内だけなら **内部**）
   - スコープの追加で `.../auth/drive.readonly`（書き込みも使うなら `.../auth/drive`）を追加
   - **テストユーザー** に自分のGoogleアカウントを追加（同意画面を「公開」しない場合は必須）
4. **APIとサービス → 認証情報 → 認証情報を作成 → OAuth クライアント ID**
   - アプリケーションの種類: **ウェブ アプリケーション**
   - **承認済みのリダイレクト URI** に、これから `config.json` に書くものと**完全に同じ文字列**を登録:
     ```
     http://localhost:3000/gdrive/auth/callback
     ```
     （HTTPS化している／別ホスト名で使うなら `https://your-host:3000/gdrive/auth/callback` のように実際にブラウザからアクセスするURLに合わせる）
5. 発行された **クライアントID** と **クライアントシークレット** を控える

#### 2. config.json を編集

```jsonc
"googleDrive": {
  "enabled": true,                    // ← 機能ON
  "authMode": "oauth",
  "clientId": "xxxxxxxx.apps.googleusercontent.com",
  "clientSecret": "GOCSPX-xxxxxxxxxxxx",
  "redirectUri": "http://localhost:3000/gdrive/auth/callback",  // ← 手順4と完全一致させる

  "rootFolderId": "",                 // 特定フォルダ配下に限定したい時だけ設定（後述）
  "readOnly": true,                   // true = 読み取り専用（既定）
  "allowWrite": false,                // 書き込みを許すなら readOnly:false と両方設定
  "allowDelete": false,               // ゴミ箱への移動を許すなら true

  "maxDownloadMB": 20,                // 1ファイルのダウンロード上限
  "maxUploadMB": 20,
  "maxTextChars": 20000,              // LLMに渡すテキストの最大文字数
  "defaultPageSize": 30,
  "sharedDrives": true,               // 共有ドライブも対象に含める
  "tokenFile": "gdrive_token.json"    // リフレッシュトークンの保存先
}
```

#### 3. 再起動 → ブラウザから接続

```bash
npm start
```

1. 右上の **📁 ファイル**ボタン（右パネル）を開き、**☁️ GDrive** タブへ
2. **🔗 Google Drive に接続** をクリック → ポップアップで Google の同意画面が出る
3. 許可すると自動でタブが閉じ、パネルに `接続中: you@example.com` と表示されます

以後はチャット入力欄の **☁️ ボタン**が点灯し、LLM がドライブを使えるようになります。

> **補足: コールバックの作り**
> Google からのリダイレクト（`accounts.google.com` → 本体）は**クロスサイトのトップレベル遷移**なので、
> セッションCookie（`SameSite=Strict`）はブラウザから送られてきません。
> そのため `/gdrive/auth/callback` は**中継ページを返すだけ**にしてあり、
> 実際のトークン交換はそのページから同一サイトの `POST /gdrive/auth/exchange`（認証必須）で行います。
> セッションCookieを `SameSite=Lax` に緩めてアプリ全体のCSRF耐性を下げる、という選択はしていません。

---

### 方式B: サービスアカウント（ヘッドレス／共有ドライブ）

1. Google Cloud Console → **IAMと管理 → サービス アカウント** で作成
2. 作成したサービスアカウントの **キー → 鍵を追加 → JSON** をダウンロード
3. JSONをサーバーに置く（例: `/home/user/opengeek-llm-chat/gdrive-service-account.json`）
   - `.gitignore` に `gdrive-service-account*.json` を登録済みなので、リポジトリ直下に置いても誤コミットされません
4. **Drive 側で共有設定**: 見せたいフォルダ（または共有ドライブ）を、サービスアカウントのメールアドレス
   （`xxx@yyy.iam.gserviceaccount.com`）に **共有** する ← これを忘れると何も見えません
5. `config.json`:

```jsonc
"googleDrive": {
  "enabled": true,
  "authMode": "serviceAccount",
  "serviceAccountKeyFile": "gdrive-service-account.json",  // 相対パスならサーバーのディレクトリ基準
  "impersonateUser": "",              // Workspaceのドメイン全体の委任を使う場合のみユーザーを指定
  "rootFolderId": "",
  "readOnly": true,
  "allowWrite": false,
  "allowDelete": false
}
```

ブラウザでの接続操作は不要です。再起動すれば ☁️ GDrive タブが「接続中」になります。

---

### 権限モデル（安全側に倒してあります）

| config | 生えるツール |
|:--|:--|
| 既定（`readOnly: true`） | `gdrive_search_files` / `gdrive_list_files` / `gdrive_read_file` / `gdrive_import_to_server` |
| `readOnly: false` かつ `allowWrite: true` | ＋ `gdrive_write_file` / `gdrive_upload_from_server` / `gdrive_create_folder` |
| ＋ `allowDelete: true` | ＋ `gdrive_delete_file`（ゴミ箱へ移動。完全削除はAPIのみ） |

**許可していない操作のツールは、LLMに提示すらされません。** 「プロンプトで禁止する」のではなく、
そもそも呼べる関数として存在させない方式です。

`readOnly` の状態は OAuth のスコープにも反映されます（読み取り専用なら `drive.readonly` しか要求しない）。
**後から書き込みを許可した場合は、スコープが変わるため一度「連携解除」してから接続し直してください。**

### アクセス範囲を1フォルダに限定する（rootFolderId）

ドライブ全体ではなく、特定フォルダの中だけを見せたい場合:

1. ブラウザで Drive のフォルダを開き、URL の末尾からIDを取る
   `https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz` → `1AbCdEfGhIjKlMnOpQrStUvWxYz`
2. `"rootFolderId": "1AbCdEfGhIjKlMnOpQrStUvWxYz"` を設定

一覧・検索の基準がこのフォルダになり、ファイルIDを直接指定された場合も **親を遡って配下かどうかを検証**し、
範囲外なら 403 で拒否します。

### 使い方の例

```
ユーザー: "ドライブにある議事録を探して、直近のものを要約して"
  ↓
LLM: ☁️ gdrive_search_files("議事録") → 5件（id付き）取得
  ↓
LLM: ☁️ gdrive_read_file("1xY...") → Googleドキュメントをテキストに変換して取得
  ↓
LLM: 要約を応答

ユーザー: "ドライブの売上データ.xlsx を月別に集計してグラフにして"
  ↓
LLM: ☁️ gdrive_search_files("売上データ") → id取得
  ↓
LLM: ⬇️ gdrive_import_to_server(id) → uploads/売上データ.xlsx に保存
  ↓
LLM: ```python ... pandas/DuckDBで集計 + matplotlib``` を出力 → 実行してグラフ表示
```

Google ドキュメント／スプレッドシート／スライドは、そのままではダウンロードできない形式なので
**自動で テキスト／CSV／テキスト に変換**してから LLM に渡しています。
PDF・画像・Excel などのバイナリは `gdrive_read_file` では読めないため、LLM には
「`gdrive_import_to_server` を使え」というエラーメッセージを返し、自力でリカバリできるようにしてあります。

### 外部API（ツール対応モード）から使う

右パネルの **🌐 API** タブで外部APIサーバーを「ツール対応モード」で起動するとき、
**☁️ GDrive (gdrive_* ツール)** にチェックを入れると、OpenAI互換APIの向こう側からも
ドライブを触れます（Drive未接続の場合はチェックボックスが無効化されます）。

外部APIトークン（`config.json` の `ml.apiTokens`）には `gdrive:read` / `gdrive:write` 権限を指定できます:

```jsonc
"ml": {
  "apiTokens": [
    { "name": "読み取り専用BOT", "token": "xxx", "permissions": ["gdrive:read"] },
    { "name": "書き込みも可", "token": "yyy", "permissions": ["gdrive:read", "gdrive:write"] }
  ]
}
```

### トラブルシューティング

| 症状 | 原因と対処 |
|:--|:--|
| 「接続」ボタンが押せない | `clientId` / `clientSecret` が未設定。config.json を確認して再起動 |
| `redirect_uri_mismatch` と出る | Cloud Console の「承認済みのリダイレクトURI」と `config.json` の `redirectUri` が1文字でも違う。末尾スラッシュ・http/https・ポート番号まで一致させる |
| ポップアップが出ない | ブラウザのポップアップブロック。このサイトを許可する |
| 認可の途中で `{"error":"認証が必要です"}` と出る | 本体を古いバージョンのまま動かしている可能性。セッションCookieが `SameSite=Strict` のため、Googleからのリダイレクト（クロスサイト遷移）ではCookieが送られず、コールバックが401になる。現在は中継ページ方式で解消済み（`server.js` を更新して再起動してください） |
| 「OpenGeekLLMChat にログインしていません」と出る | OAuthの途中でセッションが切れた。元のタブでログインし直してから、もう一度「接続」する |
| 「有効期限切れか、すでに使用済みです」と出る | 認可の `state` は**1回限り・10分間**有効。コールバックページの再読み込みや、認可画面を開いたまま放置した場合に出る。「接続」からやり直す |
| `403 ... Drive API has not been used` | Cloud Console で **Google Drive API を有効化**していない |
| サービスアカウントで何も見えない | 対象フォルダ／共有ドライブをサービスアカウントのメールアドレスに**共有**していない |
| 「Google の認可が失効しています」 | リフレッシュトークンが取り消された（パスワード変更・長期間未使用など）。「連携解除」→再接続 |
| 書き込みツールが出てこない | `readOnly: false` **と** `allowWrite: true` の両方が必要。設定後は再起動＋（スコープが変わるので）連携解除→再接続 |
| ファイルが大きすぎると言われる | `maxDownloadMB` を上げる。ただしLLMのコンテキストを圧迫するので `gdrive_import_to_server` + Python 処理を推奨 |
| 読み込みの途中で応答が止まる / 「Let me try reading with the exact original ID...」で終わる | LLM が33文字のファイルIDを写し間違えて読み込みに失敗し、やり直しでツールのターンを使い切っていた。現在は**通し番号やファイル名でも指定でき、崩れたIDも自動補正**するよう修正済み（`public/js/index.jsx` を更新して再読み込み） |
| ファイルの内容を表示する途中で止まる | ループ検出の誤検出。CSVやログを引用すると同じ100文字が何度も現れるため打ち切られていた。現在は末尾の連続した繰り返しだけを見るよう修正済み |
| 「参照した資料」に `(類似度: NaN%)` やファイルIDが出る | GDrive はベクトル検索ではなく直接読み込みなのでスコアが無い。現在は**ファイル名（GDriveへのリンク付き）と GDrive バッジ**を表示し、スコアが無い時は類似度を出さないよう修正済み |

---

## 🧪 環境変数

| 変数名 | デフォルト | 説明 |
|:--|:--|:--|
| `PORT` | `3000` | HTTPサーバーポート |
| `PYTHON_TIMEOUT` | `60000` | Python実行タイムアウト(ms) |
| `GPU_INTERVAL` | `1000` | GPU監視間隔(ms) |
| `CHATS_DIR` | `./chats` | チャット履歴保存先 |

`llama-server` の接続先（ホスト・ポート）は `config.json` の `llamaServer.*` で設定します。

---

## 📡 API

| Method | Path | Auth | 説明 |
|:--|:--|:--:|:--|
| `*` | `/v1/*` | ✓ | llama-server (チャット推論) リバースプロキシ |
| `*` | `/embed/v1/*` | ✓ | llama-server (Embedding) リバースプロキシ |
| `GET` | `/models` | ✓ | 利用可能モデル一覧 + 現在ロード中モデル |
| `POST` | `/models/load` | ✓ | モデル切替（サーバー再起動） |
| `POST` | `/models/unload` | ✓ | 現在のチャットモデルをアンロード |
| `GET` | `/external-servers` | ✓ | 外部APIサーバー一覧（ctx/np含む） |
| `POST` | `/external-servers` | ✓ | 外部APIサーバー新規起動 |
| `POST` | `/external-servers/:id/stop` | ✓ | プロセスのみ停止（設定保持） |
| `POST` | `/external-servers/:id/start` | ✓ | 停止中サーバーを再起動 |
| `DELETE` | `/external-servers/:id` | ✓ | 設定ごと削除 |
| `GET` | `/external-servers/https-available` | ✓ | HTTPS用証明書の存在チェック |
| `GET` | `/gpu/release/targets` | ✓ | VRAMを掴んでいるモデルの一覧 |
| `POST` | `/gpu/release` | ✓ | ロード中モデルを一括アンロードしてVRAMを解放 |
| `GET` | `/orchestra/info` | ✓ | オーケストレーション情報（ワークフロー一覧+モデルVRAM見積り） |
| `GET/POST` | `/orchestra/workflows` | ✓ | ワークフロー一覧 / 保存（config.jsonに書き込み） |
| `DELETE` | `/orchestra/workflows/:id` | ✓ | ワークフロー削除 |
| `POST` | `/orchestra/validate` | ✓ | ワークフロー検証（循環参照等）+ 実行モード見込み |
| `GET` | `/orchestra/pool` | ✓ | LLMワーカープールの状態 |
| `POST` | `/orchestra/pool/unload` | ✓ | 全ワーカーをアンロード（VRAM解放） |
| `POST` | `/orchestra/run` | ✓ | ワークフロー実行（SSEでノード単位の進捗を配信） |
| `GET` | `/tuning/samples` | ✓ | 学習サンプル一覧 |
| `POST/PUT/DELETE` | `/tuning/samples` | ✓ | サンプル追加/更新/削除 |
| `POST` | `/tuning/samples/import` | ✓ | CSV/JSONL 一括インポート |
| `GET` | `/tuning/samples/export` | ✓ | JSONL ダウンロード |
| `GET` | `/tuning/presets` | ✓ | モデルプリセット返却 |
| `GET/POST` | `/tuning/jobs` | ✓ | ジョブ一覧 / 開始 |
| `GET` | `/tuning/jobs/:id/log` | ✓ | 学習ログ取得 |
| `POST` | `/tuning/jobs/:id/stop` | ✓ | 学習ジョブ停止 |
| `POST` | `/tuning/jobs/:id/postprocess` | ✓ | マージ→GGUF→量子化 |
| `DELETE` | `/tuning/jobs/:id` | ✓ | ジョブ削除 |
| `GET` | `/web-search?q=&n=&fetch=&bodyCount=` | ✓ | DuckDuckGo検索+本文取得 |
| `GET/POST` | `/files/*` | ✓ | サーバーファイル読み書き（画像等はバイナリ配信） |
| `DELETE` | `/files/*` | ✓ | ファイル削除 |
| `GET` | `/files` | ✓ | ファイル一覧 |
| `GET` | `/plots/*` | ✓ | matplotlib生成画像の配信（uploadsとは分離管理） |
| `GET` | `/gdrive/status` | ✓ | Google Drive の接続状態（機密は返さない） |
| `GET` | `/gdrive/about` | ✓ | 接続テスト（アカウント・空き容量） |
| `GET` | `/gdrive/auth/url` | ✓ | OAuth 認可URLの発行（state付き・10分有効） |
| `GET` | `/gdrive/auth/callback` | — | OAuth コールバックの中継ページ（特権処理なし。Cookieが届かないため認証を掛けられない） |
| `POST` | `/gdrive/auth/exchange` | ✓ | 認可コード→リフレッシュトークン保存（中継ページから same-site で呼ばれる。state は1回限り） |
| `POST` | `/gdrive/disconnect` | ✓ | 連携解除（トークンを失効させてローカルからも削除） |
| `GET` | `/gdrive/files?folderId=` | ✓ | フォルダの中身を一覧 |
| `GET` | `/gdrive/search?q=` | ✓ | ファイル名＋本文の全文検索 |
| `GET` | `/gdrive/files/:id` | ✓ | メタデータ取得 |
| `GET` | `/gdrive/files/:id/content` | ✓ | 中身をテキストで取得（`?raw=1` でバイナリ配信） |
| `POST` | `/gdrive/files` | ✓ | ファイル作成/更新（要 `allowWrite`） |
| `POST` | `/gdrive/folders` | ✓ | フォルダ作成（要 `allowWrite`） |
| `DELETE` | `/gdrive/files/:id` | ✓ | ゴミ箱へ移動（要 `allowDelete`。`?permanent=1` で完全削除） |
| `POST` | `/gdrive/import` | ✓ | Drive → `public/uploads` に取り込み |
| `POST` | `/gdrive/export` | ✓ | `public/uploads` → Drive にアップロード（要 `allowWrite`） |
| `GET` | `/external-servers/gdrive-available` | ✓ | Drive が外部APIツールで使えるか |
| `GET` | `/config` | — | 公開設定（セッション有効時は `authenticated:true`） |
| `GET` | `/config/raw` | ✓ | config.jsonの生テキスト取得（editconfig.html用） |
| `POST` | `/config/raw` | ✓ | config.json保存（自動バックアップ作成、JSON検証） |
| `GET` | `/config/backups` | ✓ | バックアップ一覧 |
| `POST` | `/config/restore` | ✓ | バックアップから復元 |
| `POST` | `/config/model-download` | ✓ | HuggingFace GGUF をダウンロード→`chatModels`登録（バックグラウンド） |
| `GET` | `/config/model-download/status` | ✓ | モデルダウンロードの進捗取得 |
| `GET` | `/restart/info` | ✓ | systemd下かどうか、PID、uptime取得 |
| `POST` | `/restart` | ✓ | 本体プロセスを終了（systemd管理下なら自動再起動） |
| `GET` | `/image-gen/info` | ✓ | 画像生成サーバー状態（モデル、起動中フラグ） |
| `POST` | `/image-gen` | ✓ | 画像生成（LLMの generate_image ツール用） |
| `POST` | `/image-gen/unload` | ✓ | sd-server を手動アンロード（VRAM解放） |
| `GET` | `/tts/info` | ✓ | 音声合成サーバー状態（声一覧、起動中フラグ） |
| `POST` | `/tts` | ✓ | 音声合成（LLMの generate_speech ツール用） |
| `POST` | `/tts/unload` | ✓ | Irodori-TTS サーバーを手動アンロード（VRAM解放） |
| `POST` | `/auth` | — | ログイン（Cookie発行・24h TTL） |
| `GET` | `/sse/gpu` | ✓ | GPU監視 SSE |
| `GET/POST` | `/settings` | ✓ | ユーザー設定 |
| `GET/POST/DELETE` | `/chats/:id` | ✓ | チャット履歴 |
| `WS` | `/ws/python` | ✓ | Python対話実行（画像生成対応） |

---

## 🖥️ デプロイ（systemd）

### OpenGeekLLMChat 本体

テンプレートファイル `opengeek-llm-chat.service` が同梱されています:

```bash
# 内容を確認・編集（User, WorkingDirectory, ExecStart等を環境に合わせる）
sudo cp opengeek-llm-chat.service /etc/systemd/system/
sudo nano /etc/systemd/system/opengeek-llm-chat.service

# 有効化・起動
sudo systemctl daemon-reload
sudo systemctl enable --now opengeek-llm-chat

# ログ確認
sudo journalctl -u opengeek-llm-chat -f
```

`process.chdir(__dirname)` により、systemd経由で起動してもカレントディレクトリは自動的にserver.jsと同じ場所になります。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now opengeek-llm-chat
sudo journalctl -u opengeek-llm-chat -f  # ログ確認
```

---

## 🌐 外部APIサーバーを使う（OpenAI互換）

右パネルの **🌐 API** タブから、ローカルLLMを外部公開できます。OpenAI SDK や LangChain、Continue.dev、ChatBox など、OpenAI互換APIに対応するツール全てから接続可能です。

### 起動方法

1. 右上の `🌐 API` ボタンを開く
2. モデルを選択
3. ポート（デフォルト: `11434` Ollama互換）
4. 公開範囲（`0.0.0.0` 全インターフェース / `127.0.0.1` ローカルのみ）
5. APIキー（空欄で自動生成）
6. HTTPS（任意、cert.pem/key.pem が必要）
7. `🚀 起動` をクリック

### ファイアウォール開放（Linux）

```bash
sudo ufw allow 11434/tcp
```

### 接続例

**OpenAI Python SDK**:
```python
from openai import OpenAI
client = OpenAI(
    base_url="https://llm.example.com:11434/v1",
    api_key="sk-xxxxxxxxxx"
)
res = client.chat.completions.create(
    model="any-name",  # llama-serverはモデル名を無視
    messages=[{"role": "user", "content": "こんにちは"}]
)
print(res.choices[0].message.content)
```

**curl**:
```bash
curl https://llm.example.com:11434/v1/chat/completions \
  -H "Authorization: Bearer sk-xxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "any",
    "messages": [{"role": "user", "content": "こんにちは"}]
  }'
```

**Continue.dev (VSCode拡張) の `config.json`**:
```json
{
  "models": [{
    "title": "OpenGeek LLM",
    "provider": "openai",
    "model": "any",
    "apiBase": "https://llm.example.com:11434/v1",
    "apiKey": "sk-xxxxxxxxxx"
  }]
}
```

**LangChain (Python)**:
```python
from langchain_openai import ChatOpenAI
chat = ChatOpenAI(
    base_url="https://llm.example.com:11434/v1",
    api_key="sk-xxxxxxxxxx",
    model="any",
)
```

### Ollama互換ポートの利点

デフォルトポート `11434` は **Ollamaと同じ** なので、すでにOllamaクライアントを設定済みのツールはURLを変えるだけで切替可能:

```
Ollama:           http://localhost:11434/v1
OpenGeekLLMChat:  https://your-server:11434/v1
                  ↑ ホスト/プロトコルだけ変更すればOK
```

### HTTPS化のポイント

- `cert.pem` と `key.pem` がOpenGeekLLMChatディレクトリにあれば、UIで「HTTPSで起動」を選択可能
- 同じ証明書を流用するため、追加設定不要
- 自己署名証明書の場合、クライアント側で `-k`（curl）や `verify=False`（Python）が必要
- 正規証明書（Let's Encrypt等）なら検証も問題なし

#### ⚠️ 前提: llama.cpp は SSL対応ビルドが必要

llama-server がHTTPS（`--ssl-cert-file`/`--ssl-key-file`）に対応するには、ビルド時に **`-DLLAMA_SERVER_SSL=ON`** を指定する必要があります。確認方法:

```bash
/usr/local/bin/llama-server --help 2>&1 | grep -i ssl
# 期待される出力:
#   --ssl-key-file FNAME
#   --ssl-cert-file FNAME
```

何も出ない場合はSSL非対応ビルドです。再ビルド手順:

```bash
cd ~/llama.cpp
sudo apt install -y libssl-dev
rm -rf build
cmake -S . -B build \
  -DGGML_HIP=ON \
  -DAMDGPU_TARGETS=gfx1201 \
  -DLLAMA_SERVER_SSL=ON \
  -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j$(nproc)
sudo cp build/bin/llama-server /usr/local/bin/
sudo systemctl restart opengeek-llm-chat
```

UIで「HTTPS で起動」したのに起動が止まる場合、ほぼ確実にSSL非対応ビルドです（`failed to initialize HTTP server` というエラーがllama-serverのstderrに出ます）。

### 大きいリクエスト（tools 19KB+）が切られる場合

llama.cpp の内部HTTPライブラリ（cpp-httplib）の挙動により、**chunked transfer encoding** で大きなリクエストが切断されることがあります（CVE-2025-46728関連）。

対処:
1. **クライアント側で `Content-Length` を明示する** （多くのHTTPライブラリではbytes/strを渡せば自動で付く）
2. llama.cpp を **b9030 以降** に更新（cpp-httplib 0.43.3 取り込み済み）
3. それでも切られる場合は **Nginx前段** でリバースプロキシ（chunked → Content-Length 変換）

```nginx
# Nginx前段の例
server {
    listen 11434 ssl http2;
    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    client_max_body_size 100M;
    proxy_request_buffering on;  # ← chunked → Content-Length 変換
    proxy_buffering off;          # ← SSEストリーミング維持
    proxy_http_version 1.1;
    proxy_read_timeout 600s;
    location / {
        proxy_pass http://127.0.0.1:11400;
        proxy_set_header Authorization $http_authorization;
    }
}
```

OpenGeekLLMChat側は外部APIサーバーを `127.0.0.1:11400`（HTTPで内部のみ）として起動します。

### 注意点

- 同時に複数モデルを起動できますが、各モデルが **個別にVRAMを消費** します
- メインのチャットUI用 llama-server（ポート8080）とは独立したプロセスのため、別途リソースを使います
- 外部APIサーバーには **アイドルアンロード機能なし**（手動停止のみ）
- OpenGeekLLMChat本体を再起動すると外部APIサーバーも全停止します（自動復元なし）

---

## 🔧 外部API: ツール対応モード (エージェント機能)

通常の外部APIは llama-server を直接公開する「素のLLM」モードです。一方 **ツール対応モード** では、Webチャットと同じツール群 (Web検索、ML予測、ファイル参照、RAG文書検索) を外部プログラムからも使えます。

### 何ができるか

Pythonスクリプトから OpenAI 互換APIで質問するだけで、LLM が自律的に:
1. 質問の意図を理解
2. 必要なツール (例: `ml_predict`) を選んで実行
3. 結果を基に最終回答を生成

```python
import requests
r = requests.post("https://llm.example.com:3001/v1/chat/completions",
    headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer sk-xxx"
    },
    json={
        "messages": [{"role": "user", "content": "sales_yosoku で東京 ProductA 5個 を2027-04-15に予測して"}]
    })
print(r.json()["choices"][0]["message"]["content"])
# → "2027年4月15日 東京 ProductA 5個の売上は約 ¥15,234 と予測されます (MAE: ¥3,300)"
print(r.json()["x_tools_used"])
# → ["ml_list_models", "ml_predict"]
```

### 起動方法

チャット画面 → 「⚙ 外部API」タブ → 設定:

1. モデル選択 (例: Qwen3.6 35B-A3B[MoE])
2. ホスト・ポート指定 (例: `0.0.0.0:3001`)
3. **「🔧 ツール対応モード」をチェック**
4. 使いたいツールを選択:
   - 🤖 機械学習 (`ml_*` 5ツール)
   - 🌐 Web検索 (`web_search`)
   - 📁 ファイル参照 (`list_files` / `read_file`)
   - 📚 RAG文書検索 (`search_documents`) — embeddingサーバー必要
   - ☁️ GDrive (`gdrive_*`) — GDrive連携が有効かつ接続済みの時のみ
5. 🚀 起動

起動後、起動中サーバー一覧に **「🔧 ツール対応」バッジ** が表示されます。

### 対応ツール

| ツール | 用途 | 備考 |
|:--|:--|:--|
| `ml_list_datasets` | データテーブル一覧 | DuckDB |
| `ml_describe_dataset` | テーブルスキーマ取得 | |
| `ml_query_dataset` | 読み取り専用SQL実行 | SELECT/WITHのみ |
| `ml_list_models` | 学習済みモデル一覧 + predictHint | |
| `ml_predict` | 学習済みモデルで予測 | 派生列自動復元 |
| `web_search` | DuckDuckGo 検索 + 本文取得 | 上位3件の本文も取得 |
| `list_files` | uploads フォルダの一覧 | |
| `read_file` | uploads のファイルを読む | |
| `search_documents` | 永続RAGドキュメントから embedding 検索 | 別途 RAG 登録必要 |
| `gdrive_search_files` | Google Drive をファイル名+本文で全文検索 | Drive接続必要 |
| `gdrive_list_files` | Drive フォルダの中身を一覧 | フォルダパス指定可 |
| `gdrive_read_file` | Drive のファイルをテキストで読む | Googleドキュメント/シートは自動変換 |
| `gdrive_import_to_server` | Drive のファイルを uploads に取り込む | バイナリ対応 |
| `gdrive_write_file` | Drive にファイル作成/更新 | 要 `allowWrite` |
| `gdrive_upload_from_server` | uploads のファイルを Drive へ | 要 `allowWrite` |
| `gdrive_create_folder` | Drive にフォルダ作成 | 要 `allowWrite` |
| `gdrive_delete_file` | Drive のファイルをゴミ箱へ | 要 `allowDelete` |

**非対応** (セキュリティ・複雑性のため):
- `generate_image` (画像生成)
- Python実行 (任意コード実行は外部公開で危険)

### embedding が無いと RAG は自動 OFF

RAG (`search_documents`) は内部 embedding サーバーが必要です。
`config.embeddingModel.path` が未設定、またはモデルファイルが存在しない場合は **自動的に RAG ツールが無効化** されます (4層の防御):

1. **UI**: RAGチェックボックスが灰色 + 「⚠️ embedding未設定のため利用不可」表示
2. **サーバー起動時**: rag を要求しても自動除外され、警告レスポンス
3. **API**: `POST /rag/documents` 等が 503 でエラー
4. **agent_proxy**: ツール一覧から自動除外

embedding を有効化するには `config.json` の `embeddingModel.path` に GGUF embedding モデル (例: `mxbai-embed-large-v1-f16.gguf`) のパスを指定してください。

### Google Drive も同じく段階的に無効化される

`gdrive_*` ツールも、**Drive連携が無効／未接続なら自動的にツール一覧から外れます**。
さらに `allowWrite` / `allowDelete` を許可していない場合、書き込み系・削除系のツールは
**そもそもLLMに提示されません**（プロンプトで禁止するのではなく、呼べる関数として存在させない）。

1. **UI**: GDriveチェックボックスが灰色 + 「⚠️ GDrive未接続のため利用不可」表示
2. **サーバー起動時**: gdrive を要求しても自動除外され、警告レスポンス
3. **API**: `/gdrive/*` が 400/401 で理由付きエラー
4. **agent_proxy**: ツール一覧から自動除外（権限に応じて write/delete も個別に除外）

### 動作原理

```
外部 → POST /v1/chat/completions (ツール対応モード外部API)
        ↓ agent_proxy.js (別ポートで Express)
        ├─ 1. ツール判断 (内部 llama-server に問い合わせ)
        ├─ 2. tool_call があればツール実行 (最大5ターン)
        ├─ 3. 結果を履歴に追加して再問い合わせ
        └─ 4. 最終応答を OpenAI 互換 JSON で返却
                ↑
            内部 llama-server (素のLLM)
```

通常モードと違い、**起動時に指定モデルがロードされているかチェック**し、未ロードなら自動でロードします。アイドルアンロードされた状態でリクエストが来た場合も、`ensureChatModelLoaded` で再ロードを自動実行 (最大 `readyTimeoutMs` 待機)。

### 制約・注意点

- **ツール対応モードは chat タイプのみ** (embedding タイプは非対応)
- **モデルは関数呼び出し対応が必要**: Qwen, Gemma 等の `tool_calls` をサポートするモデルのみ
- **ストリーミングは最終応答のみ一括返却** (途中のツール実行はストリームに乗らない)
- **MAX_TURNS=5**: ツール実行ループの上限 (無限ループ防止)
- **HTML応答を排除**: JSON パースエラー・404・予期しないエラーも全て JSON で返す (OpenAI 互換)
- **`/health` は認証スキップ**: ロードバランサーや監視ツール対応のためパブリック

### curl での確認

```bash
# ヘルスチェック (認証不要)
curl https://llm.example.com:3001/health
# → {"status":"ok","mode":"agent","model":"Qwen3.6 35B-A3B[MoE]"}

# 推論 (Linux/macOS)
curl -X POST https://llm.example.com:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-xxx" \
  -d '{"messages":[{"role":"user","content":"こんにちは"}]}'

# Windows cmd.exe の場合 (シングルクォートは使えないので \" でエスケープ)
curl -X POST https://llm.example.com:3001/v1/chat/completions ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer sk-xxx" ^
  -d "{\"messages\":[{\"role\":\"user\",\"content\":\"こんにちは\"}]}"
```

詳細な実装は [DESIGN.md](./DESIGN.md) の「ツール対応モード」セクションを参照。

---

## 📚 永続RAGドキュメント

サーバー側に永続的に保存された RAG ドキュメントストア。**外部APIのツール対応モードと、通常のWebチャットの両方から利用可能** です。チャット画面のブラウザ添付RAG (メモリ保持) とは独立した、サーバー側の永続ストアです。

### 2系統のRAGを併用

OpenGeekLLMChat には**2種類のRAG**があり、Webチャットでは両方同時に利用可能です:

| 種類 | スコープ | 保存 | 用途 |
|:--|:--|:--|:--|
| 📄 **ブラウザ添付RAG** (`search_documents`) | 個人・セッション単位 | ブラウザメモリ (タブ閉じで消失) | その場のドキュメントを一時的に質問 |
| 📚 **永続RAG** (`search_persistent_documents`) | サーバー全体 (全ユーザー共有) | `ml/rag/` ディレクトリ (恒久) | 社内文書・マニュアル・FAQ等の恒久参照 |

LLM は質問に応じて両方のツールを使い分けられます。例えば「**添付した契約書と社内ポリシーを比較して**」と聞けば、添付RAGで契約書を、永続RAGでポリシーを並行検索します。

### 通常チャットでの自動利用

- **登録済みドキュメントがあれば自動的にツールが追加** されます (UI操作不要)
- 左サイドバーのドキュメント欄には**表示されません**。あの欄はチャット添付RAG専用です。登録済みの永続RAGはサイドバーの **「📄 永続RAG(OCR登録)」** (`/ocr.html`) と `/rag/documents` で確認します
- embedding サーバーが利用できない場合や、登録ドキュメントが0件の場合は**自動的に無効化** されます

### 登録方法 (Pythonから)

`uploads` フォルダのファイルを RAG 化します:

```python
import requests
BASE = "https://llm.example.com:3000"
H = {"Authorization": "Bearer ogc_xxxxxxxxxxxxxxxxxxxx"}

# 単一ファイル
requests.post(f"{BASE}/rag/documents", headers=H, verify=False, json={
    "filename": "manual.txt"
})

# 複数ファイル一括
requests.post(f"{BASE}/rag/documents", headers=H, verify=False, json={
    "filenames": ["policy.md", "faq.md", "specs.txt"]
})

# 登録一覧
print(requests.get(f"{BASE}/rag/documents", headers=H, verify=False).json())
```

### 対応ファイル形式

テキスト系のみ: `.txt`, `.md`, `.markdown`, `.csv`, `.json`, `.log`, `.html`, `.xml`, `.yaml`, `.yml`, `.py`, `.js`, `.ts`

PDF/Word は事前にテキスト化が必要 (バイナリは拒否)。

### 仕組み

```
登録時:
  uploads/manual.txt
    ↓ ragChunkText (500文字, overlap 100)
  チャンク × N
    ↓ 内部embeddingサーバー (/v1/embeddings)
  ベクトル × N
    ↓
  ml/rag/<docId>.json に保存 (チャンク + ベクトル)

検索時 (search_documents ツール):
  クエリ文字列
    ↓ embedding 化
  クエリベクトル
    ↓ 全チャンクとcosine類似度計算
  top-5 のチャンク + ファイル名 + スコア
```

### API エンドポイント

| メソッド | パス | 権限 | 説明 |
|:--|:--|:--|:--|
| GET | `/rag/documents` | `ml:read` | 登録一覧 |
| POST | `/rag/documents` | `ml:write` | uploads のファイルを RAG 登録 |
| DELETE | `/rag/documents/:docId` | `ml:write` | ドキュメント削除 |
| POST | `/rag/search` | `ml:read` | RAG 検索 (テスト用) |

### ストレージ

```
ml/rag/
├── index.json          # 登録ドキュメント一覧
└── <docId>.json        # チャンク + embeddingベクトル
                        # (docId は filename の SHA1 先頭16文字)
```

### embedding が必要

embedding サーバーが利用できない場合、全てのRAG関連エンドポイントが 503 を返します。`config.embeddingModel.path` を設定してください。

---

## 🐍 Python実行機能

チャット応答に含まれる ` ```python ... ``` ` コードブロックの「▶ 実行」ボタンで対話的にPythonを実行できる。`input()` 入力にも対応、`matplotlib` でのグラフはチャットに自動表示。

### 仕組み

- LLMが `python` コードブロックを応答に含めると、コードブロックヘッダーに「▶ 実行」ボタンが表示される
- ユーザーがクリックすると、サーバーで Python が `spawn` され、stdout/stderr が WebSocket でストリーミング表示
- `matplotlib.pyplot.show()` を呼ぶと、サーバー側プレアンブルが自動でPNG保存 → `__OGC_IMAGE__:plots/xxx.png` マーカーでクライアントに通知 → チャット欄に画像表示
- 作業ディレクトリは `public/uploads/`（LLMツール `read_file` / `write_file` と共通、ファイル受け渡しが容易）

### 必須・推奨パッケージ

Python実行機能をフル活用するには、サーバーの Python 環境に以下のパッケージをインストール:

```bash
# 必須: matplotlib（グラフ自動表示）
pip install matplotlib --break-system-packages

# 強く推奨: DuckDB（大量データ・SQL処理）+ pandas
pip install duckdb pandas --break-system-packages

# よく使う: 数値計算・画像処理
pip install numpy scipy pillow openpyxl --break-system-packages

# 一気に全部
pip install matplotlib numpy pandas duckdb pillow scipy openpyxl --break-system-packages
```

`--break-system-packages` は Ubuntu 24.04 以降の PEP 668 制約を回避するためのフラグ。仮想環境を使う場合は不要。

### サーバー側のPython指定

`config.json` の `pythonPath` で実行するPythonを指定可能（デフォルト: `python3`）。

```json
"pythonPath": "/home/wizapply-ai/opengeek-llm-chat/venv/bin/python"
```

venv の Python を指定すれば、システムの Python と分離して管理可能。

### matplotlib 日本語フォント

プレアンブルで以下の順で日本語フォントを自動検出して設定（先勝ち）:

`IPAexGothic` → `IPAGothic` → `Noto Sans CJK JP` → `Noto Sans JP` → `Hiragino Sans` → `Yu Gothic` → `Meiryo` → `MS Gothic` → `TakaoPGothic` → `VL PGothic` → `DejaVu Sans`

日本語が豆腐 (`□□□`) になる場合は、Ubuntu なら `sudo apt install fonts-ipaexfont` または `sudo apt install fonts-noto-cjk` を実行。

### よくあるエラー

| エラー | 原因 | 対処 |
|:--|:--|:--|
| `ModuleNotFoundError: No module named 'matplotlib'` | matplotlibが未インストール | `pip install matplotlib --break-system-packages` |
| `AttributeError: module 'matplotlib' has no attribute 'use'` | matplotlibが不完全インストール、または同名のローカル `matplotlib.py` がある | `pip install --force-reinstall matplotlib --break-system-packages` 、ローカル `matplotlib.py` を削除 |
| `MPLCONFIGDIR is not writable` | systemdで HOME が `/root` 等の書けないパス | `systemd` ユニットに `Environment=MPLCONFIGDIR=/tmp/matplotlib` を追加 |
| 日本語が豆腐 (`□□□`) | 日本語フォント未インストール | `sudo apt install fonts-ipaexfont` または `fonts-noto-cjk` |
| `input()` で固まる | stdinを使うコードで対話入力欄を見落とし | 出力欄下部の「›」入力欄に文字を入れて送信ボタン |

---

## 🧠 ファインチューニング機能（LoRA SFT）

OpenGeekLLMChat はチャットUIに加えて、ファインチューニング管理画面を内蔵しています。`https://<your-host>:3000/tuning.html` でアクセスでき、認証は本体と共有（Cookie）。

### 機能概要

- 📚 **学習データ管理**: 手動追加、CSV/JSONLインポート、JSONLエクスポート
- 🚀 **学習開始**: LoRA / QLoRA / Full ファインチューニング (TRL `SFTTrainer` ベース)
- 📊 **ジョブ管理**: 実行中・完了済みジョブ一覧、リアルタイムログ、停止、削除
- 📦 **後処理パイプライン**: 学習 → マージ → GGUF変換 → 量子化 をUIから1ボタン
- 🎯 **チャット画面からワンクリック遷移**: モデル選択の下にリンクボタン
- 🔁 **タブ間状態保持**: 入力中の値が消えない

### 事前準備（サーバー側）

ファインチューニングを使うには、以下のサーバーセットアップが必要です。

#### 1. ファインチューニング用 Python venv の作成

OpenGeekLLMChat 本体用とは **別の venv** を使うことを推奨します（PyTorchのROCm版とllama.cppビルド用の依存が競合するため）。

```bash
cd ~/opengeek-llm-chat
python3 -m venv venv-tuning
source venv-tuning/bin/activate
```

#### 2. PyTorch インストール（環境別）

**AMD ROCm環境（R9700/gfx1201 など）:**
```bash
pip install --pre torch torchvision torchaudio \
  --index-url https://download.pytorch.org/whl/nightly/rocm7.0
```

**NVIDIA CUDA環境:**
```bash
pip install torch torchvision torchaudio \
  --index-url https://download.pytorch.org/whl/cu121
```

#### 3. 学習ライブラリのインストール

```bash
pip install -r tune_requirements.txt
# (transformers, peft, trl, datasets, accelerate, sentencepiece 等)
```

#### 4. llama.cpp のセットアップ（GGUF変換・量子化用）

```bash
cd ~
git clone https://github.com/ggerganov/llama.cpp.git
cd llama.cpp

# 量子化バイナリのビルド
cmake -B build -DGGML_NATIVE=ON
cmake --build build --config Release -j

# GGUF変換スクリプト用の依存（別venv推奨でtorch事故防止）
python3 -m venv .venv-llama
source .venv-llama/bin/activate
grep -v "^torch" requirements.txt > requirements-no-torch.txt
pip install -r requirements-no-torch.txt
```

#### 5. config.json で設定（重要）

ファインチューニング機能はすべて `config.json` の `tuning` セクションから制御します。

```json
"tuning": {
  "pythonPath": "/home/wizapply-ai/opengeek-llm-chat/venv-tuning/bin/python",
  "llamaCppDir": "/home/wizapply-ai/llama.cpp",
  "env": {
    "HSA_OVERRIDE_GFX_VERSION": "12.0.1",
    "PYTORCH_HIP_ALLOC_CONF": "expandable_segments:True",
    "HIP_VISIBLE_DEVICES": "0"
  },
  "modelPresets": [
    {
      "value": "Qwen/Qwen2.5-0.5B-Instruct",
      "size": "0.5B",
      "vramLora": "~4GB",
      "desc": "個人検証・実験用",
      "epochs": 5,
      "lr": 0.0002,
      "batch": 2,
      "accum": 4,
      "r": 8,
      "alpha": 16,
      "maxLen": 2048
    },
    {
      "value": "Qwen/Qwen2.5-7B-Instruct",
      "size": "7B",
      "vramLora": "~22GB",
      "desc": "本命・推奨",
      "epochs": 3,
      "lr": 0.0002,
      "batch": 1,
      "accum": 16,
      "r": 32,
      "alpha": 64,
      "maxLen": 2048
    }
  ]
}
```

| キー | 説明 |
|:--|:--|
| `pythonPath` | tune_runner.py を実行する Python の絶対パス（venv-tuning を指定） |
| `llamaCppDir` | llama.cpp の絶対パス（convert_hf_to_gguf.py と llama-quantize を使うため） |
| `env` | tune_runner.py 実行時の環境変数。ROCm環境の安定化に必須 |
| `modelPresets[]` | UI上に表示されるベースモデル選択ピル＆ハイパラ自動設定 |
| `modelPresets[].value` | HuggingFace Model ID（例: `Qwen/Qwen2.5-7B-Instruct`） |
| `modelPresets[].size` | 表示用のサイズ表記（例: `0.5B`、`7B`） |
| `modelPresets[].vramLora` | LoRA時のVRAM目安（ホバー表示用） |
| `modelPresets[].desc` | ホバー時の説明文 |
| `modelPresets[].epochs / lr / batch / accum / r / alpha / maxLen` | このモデルを選んだ際に自動入力されるハイパラ |

#### 6. systemd サービスファイルで環境変数を渡す（推奨）

```bash
sudo systemctl edit opengeek-llm-chat
```
追記:
```ini
[Service]
Environment="HSA_OVERRIDE_GFX_VERSION=12.0.1"
Environment="PYTORCH_HIP_ALLOC_CONF=expandable_segments:True"
Environment="HIP_VISIBLE_DEVICES=0"
Environment="HF_HOME=/home/wizapply-ai/.cache/huggingface"
Environment="HF_TOKEN=hf_xxxxxxxxxxxx"  # gated model用 (任意)
```

その後 `sudo systemctl restart opengeek-llm-chat`。

#### 7. HuggingFace モデルダウンロードツール（任意）

ファインチューニングはモデル名（`Qwen/Qwen2.5-7B-Instruct` 等）を指定すると `transformers` が自動でダウンロードします。明示的に事前ダウンロードしたい場合や `gated model`（Llama等）を使う場合は、HuggingFace 公式CLIをインストールします。

```bash
# 新しい CLI ツール (huggingface_hub 0.30+)
pip install "huggingface_hub[cli]"

# 確認: hf コマンドが使えるはず
hf --help

# Llama 等の gated model 用のログイン
hf auth login
# トークン入力 (https://huggingface.co/settings/tokens で発行)

# モデル事前ダウンロード（任意）
hf download Qwen/Qwen2.5-7B-Instruct --local-dir ~/.cache/huggingface/hub/...
```

旧 CLI 名 `huggingface-cli` は廃止予定で、新しいパッケージでは `hf` コマンドに置き換わっています。両方をサポートする過渡期なので、どちらか入っていれば動作します。

### 使い方

1. **ブラウザで `https://<host>:3000/tuning.html` にアクセス**
2. **「📚 学習データ」タブ**: サンプルを手動追加 or CSV/JSONLからインポート
3. **「🚀 学習開始」タブ**: プリセットからモデル選択 → ハイパラ確認 → `🚀 学習開始`
4. **「📊 ジョブ」タブ**: ログをリアルタイム確認、停止可能
5. **完了後**: ジョブカードの「📦」ボタンから マージ→GGUF→量子化
6. **アーティファクトをダウンロード** または **config.jsonのchatModelsに追加**

### データ形式

**シングルターン (instruction/response):**
```jsonl
{"instruction": "宮城県の県庁所在地は?", "response": "仙台市です。"}
```

**マルチターン (messages):**
```jsonl
{"messages": [
  {"role": "system", "content": "あなたは宮城県のアシスタント"},
  {"role": "user", "content": "県庁所在地は?"},
  {"role": "assistant", "content": "仙台市です。"}
]}
```

**CSV（インポート時）:** ヘッダー必須
```csv
instruction,response,system
"こんにちは","こんにちは!お元気ですか?",""
"宮城県の県庁所在地は?","仙台市です。","あなたは地理アシスタント"
```

### モデルサイズ別の量子化推奨

| モデル | 量子化推奨 | 理由 |
|:--|:--|:--|
| 0.5B〜1.5B | **F16 / Q8_0** | 強い量子化（Q4_K_M）は知識劣化が激しい |
| 3B | Q5_K_M / Q6_K | |
| **7B** | **Q4_K_M / Q5_K_M** | 最も実用的なスイートスポット |
| 13B+ | Q4_K_M | |
| 30B+ | Q4_K_M / Q3_K_M | |

### 留意点

- **AMD ROCm環境のbitsandbytes (QLoRA)** は制限あり → **LoRA推奨**
- **gated model**（Llama等）は事前に `hf auth login` （旧 `huggingface-cli login`）が必要
- **初回実行時** は HuggingFace からモデルをダウンロードするため数GB〜数十GBの通信が発生
- **学習中は VRAM が大量消費** されるので、チャット用 llama-server をアンロードしてから実行推奨
- **本格運用前** に 0.5Bモデル + 数十件サンプルで **パイプラインを完走** させて動作確認

詳細な実装の解説や、AMD ROCm での実体験ナレッジは [DESIGN.md](./DESIGN.md) のファインチューニングセクションを参照。

---

## 🎨 画像生成（stable-diffusion.cpp 連携）

LLMが `generate_image` ツールを呼び出して画像を生成する仕組み。stable-diffusion.cpp の `sd-server` を子プロセスとして管理し、内部HTTPで通信する。

### 事前準備（サーバー側）

#### 1. stable-diffusion.cpp のビルド

```bash
cd ~
git clone --recursive https://github.com/leejet/stable-diffusion.cpp.git
cd stable-diffusion.cpp

# ROCm 7.x 用ビルド（R9700/gfx1201）
# 注意: PIE エラーを避けるため -fno-pie を渡す
cmake -B build \
  -DSD_HIPBLAS=ON \
  -DAMDGPU_TARGETS=gfx1201 \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_POSITION_INDEPENDENT_CODE=OFF \
  -DCMAKE_EXE_LINKER_FLAGS="-no-pie" \
  -DCMAKE_C_FLAGS="-fno-pie" \
  -DCMAKE_CXX_FLAGS="-fno-pie"

cmake --build build --config Release -j$(nproc)

# シンボリックリンク
sudo ln -sf $(pwd)/build/bin/sd-server /usr/local/bin/sd-server
```

CUDA環境なら `-DSD_HIPBLAS=ON` を `-DSD_CUBLAS=ON` に置き換える。

#### 2. モデルダウンロード

```bash
mkdir -p ~/opengeek-llm-chat/models/sd
cd ~/opengeek-llm-chat/models/sd

# 推奨: SDXL Base 1.0 (約6.5GB)
wget https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors

# VAE (品質向上、約335MB)
wget https://huggingface.co/madebyollin/sdxl-vae-fp16-fix/resolve/main/sdxl_vae.safetensors
```

または新しい `hf` CLI:
```bash
hf download stabilityai/stable-diffusion-xl-base-1.0 \
  sd_xl_base_1.0.safetensors --local-dir ~/opengeek-llm-chat/models/sd/
hf download madebyollin/sdxl-vae-fp16-fix \
  sdxl_vae.safetensors --local-dir ~/opengeek-llm-chat/models/sd/
```

#### 3. config.json 設定

```json
"imageGen": true,
"stableDiffusion": {
  "binPath": "/usr/local/bin/sd-server",
  "port": 7860,
  "readyTimeoutMs": 90000,
  "idleUnloadMs": 600000,
  "defaultModel": "SDXL Base 1.0",
  "env": {
    "HSA_OVERRIDE_GFX_VERSION": "12.0.1",
    "HIP_VISIBLE_DEVICES": "0"
  }
},
"imageModels": [
  {
    "name": "SDXL Base 1.0",
    "desc": "万能、商用OK",
    "path": "/home/wizapply-ai/opengeek-llm-chat/models/sd/sd_xl_base_1.0.safetensors",
    "vae": "/home/wizapply-ai/opengeek-llm-chat/models/sd/sdxl_vae.safetensors",
    "extraArgs": []
  }
]
```

| キー | 説明 |
|:--|:--|
| `imageGen` | `true` で画像生成機能を有効化（LLMにツール提供） |
| `stableDiffusion.binPath` | `sd-server` バイナリの絶対パス |
| `stableDiffusion.port` | sd-server の HTTP ポート（内部通信用） |
| `stableDiffusion.readyTimeoutMs` | 起動完了待ちタイムアウト（モデル大きい場合は伸ばす） |
| `stableDiffusion.idleUnloadMs` | 何ms未使用で自動アンロードするか |
| `stableDiffusion.defaultModel` | デフォルトで使うモデル名 |
| `stableDiffusion.env` | sd-server 実行時の環境変数（ROCm用） |
| `imageModels[].name` | UI表示用の名前 |
| `imageModels[].path` | モデルファイル(.safetensors)の絶対パス |
| `imageModels[].vae` | VAE モデルの絶対パス（任意、品質向上） |
| `imageModels[].extraArgs` | sd-server に渡す追加引数 |

#### 4. 再起動

```bash
sudo systemctl restart opengeek-llm-chat
# またはブラウザの「🔄 本体を再起動」
```

### 使い方

ブラウザのチャットで:

```
かわいい猫のイラストを描いて
```

→ LLMが `generate_image` ツール呼び出し → 約10-30秒後にチャット欄に画像表示

英語プロンプトの方が高品質:
```
draw: a cute orange tabby cat sitting on a windowsill, soft sunlight, photorealistic, 8k, masterpiece
```

### 推奨モデル（R9700 32GB 環境）

| モデル | サイズ | 速度 | 品質 | 推奨度 |
|:--|:--|:--|:--|:--:|
| **SDXL Base 1.0** | 6.5GB | 中 (8-15秒) | ◎ | ⭐ 最初に試す |
| **SDXL Turbo** | 6.5GB | 高速 (2-4秒) | ○ | プロト向き |
| **Flux.1 schnell** | 24GB→Q4: 12GB | 中 (4step) | ◎◎ | 最新・高品質 |
| **SD 1.5** | 2GB | 高速 (3-5秒) | ○ | 軽量 |

### UI

生成された画像はチャット欄に**コンパクトなカード**として表示:

```
┌───────────────────────────┐
│ ┌─────────────────────┐   │
│ │   [サムネイル]      │   │ ← クリックで拡大
│ │   256x256           │   │
│ └─────────────────────┘   │
│ 📝 a cute cat...           │ ← プロンプト
│ [🔍拡大] [💾保存] [📋プロンプト] │
└───────────────────────────┘
```

- **🔍 拡大**: ライトボックスでフルサイズプレビュー
- **💾 保存**: 画像ファイルをダウンロード
- **📋 プロンプト**: プロンプトをクリップボードにコピー
- **ライトボックス内 💾 ダウンロード**: 拡大表示中にも大きなダウンロードボタン

### 留意点

- **VRAM共有に注意**: チャット用 llama-server と同じGPUを使う場合、合計VRAMに収まる必要がある。SDXL は約 8-10GB 消費するので、35Bチャットモデルと併用すると 32GB GPU でもギリギリ。`HIP_VISIBLE_DEVICES` で別GPUに分けるか、`idleUnloadMs` でアイドル時アンロード推奨
- **初回ロードは1〜2分**: 大きいモデル（Flux等）は初回ロード時間が長い。`readyTimeoutMs` をデフォルト 300000ms (5分) で設定済み、必要に応じて伸ばす
- **プロンプトは英語推奨**: 日本語でも動くが、トレーニングデータが英語中心なので品質に差が出る
- **生成画像は `public/uploads/` に保存**: ファイル名は `sd_<timestamp>_<rand>.png`。手動削除可能
- **sd-server の互換性**: AUTOMATIC1111互換 API だが完全互換ではないので、本実装では最小限のパラメータのみ送信。`sampler_name`/`cfg_scale`/`seed` 等を有効にしたい場合は config.json の `imageModels[].extraArgs` ではなく、コードを修正して条件付き追加
- **画像生成中の応答時間**: SDXL Base 1.0 で 1024x1024 / 20steps 程度なら 8〜30秒、サーバー側タイムアウトは 5分

詳細な実装と sd-server オプションは [DESIGN.md](./DESIGN.md) の画像生成セクションを参照。

---

## 🔊 音声合成（Irodori-TTS 連携）

LLMが `generate_speech` ツールを呼び出してテキストを音声(WAV)に合成する仕組み。日本語特化のローカル音声合成AI [Irodori-TTS](https://github.com/Aratako/Irodori-TTS) の OpenAI互換サーバー [Irodori-TTS-Server](https://github.com/Aratako/Irodori-TTS-Server)（`POST /v1/audio/speech`）を子プロセスとして管理し、内部HTTPで通信する（画像生成 sd-server と同じ方式）。

### セットアップ

#### 1. Irodori-TTS-Server の用意

Irodori-TTS-Server は Python 3.10 が必要。**venv 方式（uv 不要・本リポジトリの流儀に一致／推奨）** と **uv 方式** のどちらでも動く。

**A. venv + pip（推奨。`uv` を入れなくてよい）**
```bash
git clone https://github.com/Aratako/Irodori-TTS-Server.git
cd Irodori-TTS-Server
python3.10 -m venv venv
source venv/bin/activate
pip install -e .                      # pyproject.toml から依存をインストール
# PyTorch を環境に合わせて入れる（AMD ROCm の例。CUDA/CPU は適宜変更）:
pip install torch torchaudio --index-url https://download.pytorch.org/whl/rocm6.2
# 声のリファレンス音声は voices/ に配置（例: voices/sample.wav → voice "sample"）
# 単体起動の確認:
python -m irodori_openai_tts --host 127.0.0.1 --port 8088
```
→ config.json の `irodoriTts.command` は **venv の python の絶対パス**を指定する（下記）。systemd 等から spawn する場合 PATH に依存しない絶対パスが安全。

**B. uv 方式（upstream の標準。`uv` のインストールが必要）**
```bash
# uv を入れる（snap でも可: sudo snap install astral-uv）:
curl -LsSf https://astral.sh/uv/install.sh | sh      # ~/.local/bin/uv に入る
cd Irodori-TTS-Server
uv run python -m irodori_openai_tts --host 127.0.0.1 --port 8088
```
→ この場合 config.json は `"command": "/絶対パス/uv"`, `"args": ["run","python","-m","irodori_openai_tts", ...]` とする（`uv` 単体だと systemd の PATH に無く `ENOENT` になりやすいので絶対パス推奨）。

VoiceDesign（テキストで声を記述）を使う場合は VoiceDesign 対応モデルを利用する。

#### 2. config.json 設定

```json
"ttsGen": true,
"irodoriTts": {
  "host": "127.0.0.1",
  "port": 8088,
  "endpoint": "/v1/audio/speech",
  "model": "irodori-tts",
  "defaultVoice": "none",
  "defaultFormat": "wav",
  "defaultSpeed": 1.0,
  "captionField": "caption",
  "irodori": {},
  "timeoutMs": 180000,
  "command": "/home/wizapply-ai/Irodori-TTS-Server/venv/bin/python",
  "args": ["-m", "irodori_openai_tts", "--host", "127.0.0.1", "--port", "8088"],
  "cwd": "/home/wizapply-ai/Irodori-TTS-Server",
  "env": {
    "HSA_OVERRIDE_GFX_VERSION": "12.0.1",
    "HIP_VISIBLE_DEVICES": "0"
  },
  "readyTimeoutMs": 300000,
  "idleUnloadMs": 600000
},
"ttsVoices": [
  { "name": "標準", "desc": "参照音声なし（VoiceDesign/既定話者）", "voiceId": "none" },
  { "name": "30代男性", "desc": "落ち着いた30代男性の声", "instructions": "30代の男性、落ち着いた低めの声、明瞭で穏やかな話し方" },
  { "name": "20代女性", "desc": "明るい20代女性の声", "instructions": "20代の女性、明るく親しみやすい声、やや高めで元気なトーン" }
]
```

| キー | 説明 |
|:--|:--|
| `ttsGen` | `true` で音声合成機能を有効化（LLMにツール提供） |
| `irodoriTts.host` / `port` | Irodori-TTS サーバーの内部通信ホスト/ポート |
| `irodoriTts.endpoint` | OpenAI互換エンドポイント（既定 `/v1/audio/speech`） |
| `irodoriTts.model` | リクエストの `model` フィールド（既定 `irodori-tts`） |
| `irodoriTts.defaultVoice` | 声の指定が無いときに使う voice ID（`voices/` のファイル名） |
| `irodoriTts.defaultFormat` | 出力フォーマット（`wav`/`mp3`/`flac`/`opus`/`aac`/`pcm`） |
| `irodoriTts.captionField` | 声のテキスト記述を `irodori` 内のどのキーで送るか（既定 `caption`、`null`で無効） |
| `irodoriTts.irodori` | irodori 拡張の基底オプション（`num_steps`/`cfg_scale_text` 等） |
| `irodoriTts.command` / `args` / `cwd` / `env` | サーバーを子プロセス自動起動するための spawn 設定。`command` を `null` にすると「外部起動済み」とみなし転送のみ行う |
| `irodoriTts.readyTimeoutMs` | 起動完了（TCP接続）待ちタイムアウト |
| `irodoriTts.idleUnloadMs` | 何ms未使用で自動アンロードするか（`0`で無効） |
| `ttsVoices[].name` | 声プリセット名（LLMがこの名前で指定できる） |
| `ttsVoices[].voiceId` | サーバーの voice ID（リファレンス音声のファイル名）にマッピング |
| `ttsVoices[].instructions` | 声のテキスト記述（VoiceDesign のキャプション） |

> `command` を設定しない場合は、別途 Irodori-TTS サーバーを起動しておけば `/tts` が転送するだけで動作する（画像生成より手軽）。`command` を設定すると sd-server と同様にオンデマンド起動・アイドルアンロードされる。

#### 3. 再起動

```bash
sudo systemctl restart opengeek-llm-chat
# またはブラウザの「🔄 本体を再起動」
```

### 使い方

ブラウザのチャットで:

```
「こんにちは」を30代男性の声で作って
```

→ LLMが `generate_speech` ツール呼び出し → チャット欄に `<audio>` プレーヤーが表示され、その場で再生できる。生成WAVは `public/uploads/tts_<timestamp>_<rand>.wav` に保存される。

声はテキストで自由に指定できる:

```
落ち着いた女性アナウンサーの声で「本日のニュースをお伝えします」をしゃべって
```

### 声の指定方法

> **重要 / 現状の制約**: 公式の **Irodori-TTS-Server（OpenAI互換）はテキストでの声の指定（VoiceDesign）に非対応**で、声の制御は **`voices/` に置いた参照音声によるボイスクローンのみ**です。`instructions` / `irodori.caption` は送信していますが、現行サーバー（base 500M-v3 等）は無視します（ログに `speaker conditioning is disabled` と出る）。**特定の声（例: 30代男性）を出すには参照音声が必須**です。

- **`none`（参照音声なし）**: `voices/` が空でもエラーにならない既定話者。声は固定できない（女性寄りの既定声になりがち）。初期値は `defaultVoice: "none"`
- **参照音声でのボイスクローン（声を指定する正攻法）**:
  1. 数秒のクリアな音声（例: 30代男性の日本語）を `~/Irodori-TTS-Server/voices/otoko30.wav` に置く（ファイル名 `otoko30` が voice ID）
  2. `config.json` の `ttsVoices` に `{ "name": "30代男性", "voiceId": "otoko30" }` を登録
  3. 「30代男性の声で」と言うと `/tts` が `voice: "otoko30"` に解決し、その音声をクローンして合成する
  - エイリアスは `~/Irodori-TTS-Server/voices/voices.json` でも管理可能（サーバー仕様）
- **プリセット名**: `ttsVoices[]` の名前を指定すると、その `voiceId`（参照音声）が使われる。`voiceId` の無い（`instructions` のみの）プリセットは現行サーバーでは既定話者になる
- **フリーなテキスト記述**: 未登録の文字列は VoiceDesign キャプションとして送るが、**現行サーバーでは無視される**（将来 VoiceDesign 対応バックエンドに差し替えた場合に有効）

> `voices/` が空のとき `voice='sample'` 等は `Unknown voice` で 400 になるため、`defaultVoice` は `none` を推奨。特定の声は参照音声を `voices/` に追加して `voiceId` で指定する。

### 留意点

- **VRAM共有に注意**: チャット用 llama-server や sd-server と同じGPUを使う場合、合計VRAMに収まる必要がある。`HIP_VISIBLE_DEVICES` で別GPUに分けるか、`idleUnloadMs` でアイドル時アンロード推奨
- **生成音声は `public/uploads/` に保存**: ファイル名は `tts_<timestamp>_<rand>.wav`（画像生成と同じ場所）。手動削除可能
- **声の指定は参照音声のみ**: 現行 Irodori-TTS-Server はテキスト記述（VoiceDesign）非対応。`voices/` の参照音声 voice ID で指定する
- **未知フィールドの扱い**: `instructions` / `irodori.caption` を併送する。strict なサーバーで問題が出る場合は `captionField` を `null` にして送信を抑制できる

### VoiceDesign（テキストで声を指定）をチャットで使う

参照音声を用意せず、**テキストの説明（キャプション）だけで声を作りたい**場合は、Irodori-TTS の **VoiceDesign モデル**（`Aratako/Irodori-TTS-600M-v3-VoiceDesign` 等）を使う。ただし公式 `irodori_openai_tts` は VoiceDesign 非対応なので、本リポジトリ同梱の簡易ラッパー [`irodori_voicedesign_server.py`](./irodori_voicedesign_server.py) を使う（VoiceDesign の `infer.py` をリクエスト毎に呼び、`instructions`/`irodori.caption` を声のキャプションとして渡す。モデルを毎回ロードするため1回あたり数秒〜十数秒かかる簡易方式）。

**セットアップ**
```bash
# 1. Irodori-TTS 本体(core, infer.py を含む)を取得
cd ~ && git clone https://github.com/Aratako/Irodori-TTS.git

# 2. ラッパーを infer.py と同じ場所へ置く（このリポジトリの irodori_voicedesign_server.py）
cp /path/OpenGeekLLMChat/irodori_voicedesign_server.py ~/Irodori-TTS/

# 3. 依存入り venv で起動（Irodori-TTS-Server の venv を再利用可。fastapi/uvicorn/soundfile/torch/irodori-tts が必要）
cd ~/Irodori-TTS
VD_PYTHON=~/Irodori-TTS-Server/venv/bin/python \
VD_HF_CHECKPOINT=Aratako/Irodori-TTS-600M-v3-VoiceDesign \
~/Irodori-TTS-Server/venv/bin/python -m uvicorn irodori_voicedesign_server:app --host 127.0.0.1 --port 8089
# 確認: curl -s http://127.0.0.1:8089/health
```

**config.json をラッパー(8089)へ向ける**
```json
"irodoriTts": {
  "host": "127.0.0.1",
  "port": 8089,
  "endpoint": "/v1/audio/speech",
  "model": "irodori-tts",
  "defaultVoice": "none",
  "defaultFormat": "wav",
  "captionField": "caption",
  "irodori": {},
  "timeoutMs": 600000,
  "command": "/home/wizapply-ai/Irodori-TTS-Server/venv/bin/python",
  "args": ["-m", "uvicorn", "irodori_voicedesign_server:app", "--host", "127.0.0.1", "--port", "8089"],
  "cwd": "/home/wizapply-ai/Irodori-TTS",
  "env": {
    "VD_PYTHON": "/home/wizapply-ai/Irodori-TTS-Server/venv/bin/python",
    "VD_HF_CHECKPOINT": "Aratako/Irodori-TTS-600M-v3-VoiceDesign",
    "HSA_OVERRIDE_GFX_VERSION": "12.0.1",
    "HIP_VISIBLE_DEVICES": "0"
  },
  "readyTimeoutMs": 60000,
  "idleUnloadMs": 600000
}
```
本体を再起動すれば、`ttsVoices` のプリセット（例「30代男性」の `instructions`）や、チャットで言ったフリーな声の記述（例「ハスキーな低い男性の声で」）がキャプションとして VoiceDesign に渡り、声がテキスト指定どおりに変わる。

> ラッパーは出力 wav を 16bit PCM に正規化して返すため、ブラウザの `<audio>` で確実に再生できる。低速が気になる場合は、`infer.py` ではなく Irodori の推論ランタイムを常駐ロードする方式（高速）に拡張できる。

> **systemd で動かす場合の注意（`npm start` では動くのに service で生成されない時）**: `opengeek-llm-chat.service` は `ProtectHome=read-only` で `/home` 配下が読み取り専用になる。VoiceDesign ラッパーは (1) 一時 wav の書き込み、(2) HuggingFace モデルキャッシュへの書き込み が必要なので、次の対応を行う。
> - 一時 wav: ラッパーの `VD_OUT_DIR` は既定で `/tmp` 配下なので追加対応不要（明示するなら `config.json` の `irodoriTts.env` に `"VD_OUT_DIR": "/tmp/irodori_vd_outputs"`）。
> - モデルキャッシュ: service の `ReadWritePaths` に `~/.cache/huggingface` を追加する。
>   ```ini
>   ReadWritePaths=/home/wizapply-ai/opengeek-llm-chat /tmp /home/wizapply-ai/.cache/huggingface
>   ```
>   その後 `sudo systemctl daemon-reload && sudo systemctl restart opengeek-llm-chat`。
> - GPU(ROCm) で動かすなら service に `Environment=HSA_OVERRIDE_GFX_VERSION=12.0.1` 等を追加（CPUのままでも動作はする）。

---

## 🤖 機械学習 (ML)

`https://<host>:3000/ml.html` で、表データの取り込み・SQL分析・PyTorch学習・推論まで一気通貫に行える管理画面を提供する。

> **「機械学習」と「深層学習」について**
> 本機能は「機械学習 (ML)」という名称ですが、学習エンジンの実体は **PyTorch によるニューラルネットワーク (深層学習 / Deep Learning)** です。
> - 回帰・分類: **MLP** (Multi-Layer Perceptron、全結合多層ニューラルネット)
> - 時系列: **LSTM** (Long Short-Term Memory、リカレントニューラルネット)
>
> 深層学習は機械学習の一分野なので「機械学習」という呼称は上位概念として正確です。将来的に古典的機械学習 (決定木・ランダムフォレスト・線形回帰等、ニューラルネットを使わない手法) を追加する余地を残すため、あえて広い呼称で統一しています。小規模データ (数百行程度) では古典的MLの方が適することもあるため、用途に応じた手法選択は今後の拡張候補です。

### 事前準備

```bash
# Node.js 側 (npm install で自動で入る、duckdb は npm パッケージ)
cd ~/opengeek-llm-chat
npm install

# Python 側 (学習・推論用)
source venv/bin/activate
pip install duckdb pandas scikit-learn torch
# ROCm 環境では torch を ROCm 版に置き換え:
pip install torch --index-url https://download.pytorch.org/whl/rocm6.1
deactivate
```

### config.json 設定

```json
"ml": {
  "enabled": true,
  "apiTokens": [
    {
      "name": "python-scripts",
      "token": "ogc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "permissions": ["ml:read", "ml:write"]
    }
  ]
}
```

| キー | 説明 |
|:--|:--|
| `ml.enabled` | `true` で機械学習機能を有効化（LLMにツール提供、UIメニュー表示） |
| `ml.apiTokens[]` | 外部 API トークン (Python等の外部スクリプトから利用) |
| `ml.apiTokens[].name` | トークンの名前（識別用） |
| `ml.apiTokens[].token` | トークン文字列（推奨: `ml.html` の「📡 API」タブから「🎲 新規トークン生成」で安全に生成） |
| `ml.apiTokens[].permissions` | 権限。`ml:read` (読み取り) / `ml:write` (書き込み) / `*` (全権限) |

トークンが空配列 (`[]`) の場合、外部 API は使えないが、ブラウザ UI と LLM ツール経由のアクセスは Cookie 認証で動作する。

### サイドバーの統計表示

`ml.html` の左サイドバーには、各リソースの件数がまとめて表示される（認証後に並列取得）。

- 🗂️ テーブル数 / 合計行数 ・ 🧠 モデル数（`/ml/models`）
- 🖼️ 画像データセット（`/ml/image/datasets`）/ 画像学習モデル（`/ml/image/custom-models`）
- 🎮 強化学習エージェント（`/ml/rl/models`）

また `ml.html` / `tuning.html` のサイドバー下部には、チャット画面と同じ歯車の **「⚙ 設定」ボタン**（`/editconfig.html` への遷移）を備える。

### 4 つのタブ

#### 🗂️ データテーブル

- CSV インポート: ファイル選択 or 直接貼り付け、テーブル名・説明・モード (置換/追加) を指定
- 🌐 Web API インポート: URL・HTTPメソッド・ヘッダー・JSONパス・モードを指定して JSON データを取り込み (SSRF対策で内部IPはデフォルト拒否)
- テーブル一覧 + クリックで詳細 (スキーマ、プレビュー50行、取得元URL)
- 🗑️ テーブル削除

#### 🔍 SQL クエリ

- 読み取り専用 SQL エディタ (SELECT/WITH のみ、書き込み・スキーマ変更は禁止)
- Ctrl+Enter で実行
- LIMIT 無しは自動で 1000 行に制限 (暴走防止)
- DuckDB方言 (window関数、CTE、集約、`EXTRACT(month FROM date)` 等) が使える

#### 🧠 モデル (学習)

- ➕ モデル新規作成: テーブル選択 → 特徴量 (複数選択) + ターゲット (1つ) を選ぶだけ
- 3つのタスク種別: 📈 回帰 (MLP) / 🏷️ 分類 (MLP) / ⏱️ 時系列 (LSTM)
- 自動前処理: 数値列は StandardScaler、文字列列は LabelEncoder、**日時列は自動で 6 特徴量に分解** (year/month/day/dayofweek/dayofyear/is_weekend)
- ハイパーパラメータ調整: エポック数、学習率、バッチサイズ、隠れ層サイズ、層数、テスト分割比
- ▶ 学習開始: リアルタイムログ表示 (2秒ポーリング)、ジョブ履歴
- 🎯 予測ボタン: 学習済みモデルで予測実行。カテゴリ列は select、日時列は date picker、結果はビジュアル表示 (分類は確率バー)
- 学習中は DuckDB の排他ロック調停: Node 側で CHECKPOINT + 接続クローズ → Python が読み込み → 終了後 Node 再オープン

#### 📡 API (外部連携)

- 🎲 新規トークン生成: ワンクリックで `ogc_xxx...` 形式の安全なトークンを生成
- 登録済みトークン一覧 (権限バッジ付き、トークン本体は伏せて表示)
- Python サンプルコード (コピーボタン付き、ホスト/トークンが自動置換)
- curl サンプル
- エンドポイント一覧表 (各エンドポイントの権限要求も明示)

### LLM チャットからの利用

`ml.enabled: true` でチャット画面に5つのMLツールが自動追加される:

| ツール | 用途 |
|:--|:--|
| `ml_list_datasets()` | データテーブル一覧と各テーブルの行数・説明を取得 |
| `ml_describe_dataset(table)` | テーブルのカラム名・型を取得 |
| `ml_query_dataset(sql, limit?)` | 読み取り専用 SQL 実行 |
| `ml_list_models()` | 学習済みモデル一覧 (使い方ヒント `predictHint` 付き) |
| `ml_predict(modelName, features)` | 学習済みモデルで予測実行 |

これらのツールは、ユーザー発話に**具体的なテーブル名/モデル名**または**MLメタキーワード** (「ML」「機械学習」「データテーブル」「予測して」等) が含まれている時のみ自動的に有効化される。雑談やコード生成では呼ばれないので、LLM の応答品質を保ちつつ安全に共存できる。

会話例:
```
ユーザー: 「sales_yosoku で 2027-04-15 の東京 ProductA 5個 を予測して」

LLM 内部動作:
  → ml_list_models() で sales_yosoku の特徴量を確認 (predictHint で正しい呼び方を学ぶ)
  → ml_predict("sales_yosoku", {date: "2027-04-15", region: "Tokyo", product: "ProductA", quantity: 5})
  → Python が date を自動で year/month/day 等に分解 → 推論 → 約 ¥XX,XXX

LLM 応答: 「2027年4月15日 東京 ProductA 5個 の売上は約 ¥XX,XXX と予測されます (このモデルのMAE: ¥3,300)」
```

### Python から外部 API として利用

```python
import requests
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

BASE = "https://llm.example.com:3000"
TOKEN = "ogc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
H = {"Authorization": f"Bearer {TOKEN}"}

# テーブル一覧
print(requests.get(f"{BASE}/ml/datasets", headers=H, verify=False).json())

# センサーデータを1行追記 (テーブルが無ければ自動作成)
requests.post(f"{BASE}/ml/datasets/append", headers=H, verify=False, json={
    "tableName": "sensor_temps",
    "rows": [{"ts": "2026-05-26 15:00:00", "temp": 24.1, "device": "room1"}],
    "createIfMissing": True
})

# SQL 実行
r = requests.post(f"{BASE}/ml/query", headers=H, verify=False, json={
    "sql": "SELECT device, AVG(temp) FROM sensor_temps GROUP BY device"
})

# 学習済みモデルで推論
r = requests.post(f"{BASE}/ml/models/sales_yosoku/predict", headers=H, verify=False, json={
    "features": {"region": "Tokyo", "product": "ProductA", "quantity": 5}
})
print(r.json())
# → {"predictions": [15234.56], "task": "regression", ...}
```

### API エンドポイント一覧

| メソッド | パス | 権限 | 説明 |
|:--|:--|:--|:--|
| GET | `/ml/datasets` | `ml:read` | テーブル一覧 |
| GET | `/ml/datasets/:name/schema` | `ml:read` | カラム情報 |
| GET | `/ml/datasets/:name/preview` | `ml:read` | 先頭N行 |
| POST | `/ml/query` | `ml:read` | SELECT/WITH 実行 |
| POST | `/ml/datasets/append` | `ml:write` | 行追記 (新規作成可、最大10000行/req) |
| POST | `/ml/datasets/import/csv` | `ml:write` | CSV データ取り込み |
| POST | `/ml/datasets/import/api` | `ml:write` | Web API から取り込み |
| PUT | `/ml/datasets/:name` | `ml:write` | 説明文更新 |
| DELETE | `/ml/datasets/:name` | `ml:write` | テーブル削除 |
| GET | `/ml/models` | `ml:read` | モデル一覧 + predictHint |
| POST | `/ml/models` | `ml:write` | モデル定義作成/更新 |
| DELETE | `/ml/models/:name` | `ml:write` | モデル削除 |
| GET | `/ml/models/:name/config` | `ml:read` | モデル設定取得 |
| GET | `/ml/models/:name/metrics` | `ml:read` | 学習メトリクス |
| POST | `/ml/models/:name/predict` | `ml:read` | 推論実行 (単発/バッチ) |
| GET | `/ml/jobs` | `ml:read` | 学習ジョブ履歴 |
| POST | `/ml/jobs/start` | `ml:write` | 学習開始 |
| POST | `/ml/jobs/:id/stop` | `ml:write` | 学習停止 |
| GET | `/ml/jobs/:id/log` | `ml:read` | 学習ログ取得 |

#### 画像物体検出

| メソッド | パス | 権限 | 説明 |
|:--|:--|:--|:--|
| GET | `/ml/image/models` | `ml:read` | 検出モデル一覧 (COCO) |
| POST | `/ml/image/detect` | `ml:read` | 物体検出 (base64画像) |
| GET/POST | `/ml/image/datasets` | `ml:read`/`write` | データセット一覧/作成 |
| POST | `/ml/image/datasets/:name/images` | `ml:write` | 画像追加 |
| PUT | `/ml/image/datasets/:name/annotations/:imageId` | `ml:write` | 矩形アノテーション保存 |
| POST | `/ml/image/datasets/:name/import` | `ml:write` | YOLO / COCO / **CSV** インポート |
| POST | `/ml/image/train` | `ml:write` | カスタム学習開始 |
| GET | `/ml/image/custom-models` | `ml:read` | 学習済みモデル一覧 |
| GET | `/ml/image/custom-models/:name/download` | `ml:read` | モデルを zip でDL |

#### 画像キーポイント (2D / 3D)

| メソッド | パス | 権限 | 説明 |
|:--|:--|:--|:--|
| GET | `/ml/image/keypoint/models` | `ml:read` | 検出モデル一覧 (COCO人物) |
| POST | `/ml/image/keypoint/detect` | `ml:read` | キーポイント検出 (COCO/カスタム2D/3D) |
| GET/POST | `/ml/image/keypoint/datasets` | `ml:read`/`write` | データセット一覧/作成 (`dim`: 2d/3d) |
| POST | `/ml/image/keypoint/datasets/:name/images` | `ml:write` | 画像追加 |
| PUT | `/ml/image/keypoint/datasets/:name/annotations/:imageId` | `ml:write` | インスタンス(box+点+z)保存 |
| POST | `/ml/image/keypoint/datasets/:name/import` | `ml:write` | **CSV** インポート |
| GET | `/ml/image/keypoint/train/models` | `ml:read` | ベースモデル/バックボーン一覧 |
| POST | `/ml/image/keypoint/train` | `ml:write` | 学習開始 (dim で2D/3D自動振り分け) |
| GET | `/ml/image/keypoint/custom-models` | `ml:read` | 学習済みモデル一覧 |
| GET | `/ml/image/keypoint/custom-models/:name/download` | `ml:read` | モデルを zip でDL |

### ストレージ

```
ml/
├── datasets.duckdb     # DuckDB データ本体 (全テーブル)
├── meta.json           # テーブル説明・取得元URL等のメタ情報
├── models.json         # モデル定義一覧
├── jobs.json           # 学習ジョブ履歴
├── models/             # 表データ学習の成果物
│   └── <model_name>/
│       ├── config.json       # モデル設定 + 派生情報
│       ├── model.pt          # PyTorch state_dict
│       ├── scaler.pkl        # StandardScaler 情報
│       ├── label_encoders.pkl  # カテゴリ列のエンコーダ
│       ├── metrics.json      # 学習指標 + 履歴
│       └── train.log         # 学習ログ
├── image_datasets/     # 物体検出データセット (画像 + dataset.json)
├── image_models/       # 物体検出カスタムモデル
├── keypoint_datasets/  # キーポイントデータセット (dataset.json に dim:2d/3d)
├── keypoint_models/    # キーポイントカスタムモデル (config.json に dim)
└── torch_cache/        # torchvision の重みキャッシュ (ROCm MIOpen 含む)
```

### 留意点

- **DuckDB は1プロセス排他ロック** (1.x時点)。学習中は Node 側の DB アクセスをブロックして調停する
- **モデル名・テーブル名は英数字+アンダースコアのみ** (SQLインジェクション対策、最大64文字)
- **時系列タスク**は事前にデータを「単一系列」になるよう SQL で絞ってから使う (混在データだと意味が無い)
- **データ量の目安**: 回帰/分類は最低 50 行、時系列は最低 100 行 + ウィンドウサイズ。312行 × 500エポックの学習が R9700 で 2.8 秒
- **派生列を直接渡さない**: 日時列は自動分解されるので、推論時も元の日付文字列 (例: `"2027-04-15"`) を渡す。万一 LLM が派生列で呼んでも、サーバー側で自動修正される

詳細な実装は [DESIGN.md](./DESIGN.md) の機械学習セクションを参照。

---

## 🎼 マルチLLMオーケストレーションを使う

複数のLLMを同時に立ち上げ、ワークフローに従って協調させる機能。

### 有効化

`config.json` に以下を追加して本体を再起動する（サンプルワークフロー4種が同梱されています）。

```json
"orchestration": {
  "enabled": true,
  "poolMode": "auto",
  "workflows": []
}
```

`workflows` は空のままで構いません。ブラウザ側のエディタから作成すると自動で書き込まれます。

### 使い方（チャット側）

サイドバーの **「チャットモデル」** 選択肢に、単一モデルと並んで **🎼 マルチLLM（ワークフロー）** グループが出ます。

```
チャットモデル
  Qwen2.5 0.5B (8,192)
  Gemma4 31B (32,768)
  Qwen3.6 35B-A3B[MoE] (32,768)
  ── 🎼 マルチLLM（ワークフロー）──
  並列合議（3モデル）
  ルーター振り分け（3モデル）
  下書き→推敲（2モデル）
  討論→結論（2モデル）
```

ワークフローを選んでそのまま質問を送るだけです。単一モデルに戻したいときは、同じ選択肢からモデル名を選び直します。選択内容は `settings.json` に保存され、次回起動時も復元されます。

実行が始まると、チャット内に進捗パネルが表示され、どのモデルが今何をしているかが見えます。ノードをクリックすると、そのモデルの生の出力を確認できます。

### ワークフローを作る（editconfig.html）

`https://<host>:3000/editconfig.html` を開き、右上の **「🎼 マルチLLM」** タブに切り替えます（チャット画面左下の「⚙ 設定」からも遷移できます）。

**テンプレートから始めるのが簡単です。** 左の「並列合議」「ルーター振り分け」「下書き→推敲」「討論→結論」のいずれかを押すと雛形ができるので、モデルと役割を自分の環境に合わせて変えて保存してください。

ゼロから組む場合の流れ:

1. 「＋ 空のワークフロー」で作成し、名前を付ける（この名前がチャットのモデル選択に表示されます）
2. 下部の「ノードを追加」から必要なノードを足す
3. 各ノードで **モデル** と **役割・指示**（システムプロンプトに追加される文）を設定する
4. **入力** のチェックボックスで、そのノードがどのノードの出力を受け取るかを指定する ← これが依存関係になります
5. 最後に 🎯 最終出力 ノードを置き、ユーザーへの回答にしたいノードを入力に指定する
6. 「💾 ワークフローを保存」を押すと `config.json` に書き込まれます

**このタブでの保存は本体の再起動が不要です。** 保存した瞬間からチャット画面のモデル選択に出ます（他の設定項目は従来どおり再起動が必要です）。

編集中はリアルタイムで検証が走り、循環参照・存在しないモデル・壊れた参照があればその場で赤く表示されます。あわせて「このワークフローは常駐並列で走りそうか、逐次スワップになりそうか」も表示されるので、保存前にVRAM的な無理がないか判断できます。

> 📝 テキスト編集タブに未保存の変更がある状態ではワークフローを保存できません（保存時に config.json を再読み込みするため、その変更が失われるからです）。先にテキスト側を保存または破棄してください。

### VRAMが足りない場合

自動判定（`poolMode: "auto"`）が空きVRAMを見て、足りなければ **逐次スワップモード** に切り替えます。モデルを1つずつロード/アンロードしながら実行するため時間はかかりますが、31B級を複数使うワークフローでもVRAM 24GB程度の環境で動きます。

さらにVRAMを稼ぎたいときは:

- `workerParallel` を `1` にする（KVキャッシュがスロット数分必要なため）
- `idleUnloadMs` を短くして、使い終わったワーカーを早めに解放する
- `POST /orchestra/pool/unload` で全ワーカーを即座にアンロードする（`maxResident` を絞るのも有効）

### 必要なときだけ専用モデルを走らせる（実行条件）

エディタの各ノードに **実行条件** を設定できます。条件を満たさないノードは実行されず、
下流には他のノードの出力だけが渡ります。**ルーターと違って排他ではない**ので、
「通常の回答に *加えて* 動かす」構成が組めます。

```
質問 ─┬→ 🤖 通常回答（常に実行）      ─┐
      └→ 🤖 コード生成（条件付き）     ─┴→ 🧩 統合 → 🎯 最終回答
```

コードが不要な質問ではコード生成ノードがスキップされ、**そのモデルはロードすらされません**。
統合役は通常回答だけを受け取って、そのまま整えて返します。

| 条件の種類 | 内容 |
|---|---|
| 常に実行 | 既定。条件なし |
| キーワードを含むとき | 質問文にいずれかの語が含まれるか（大文字小文字は区別しません） |
| LLMが「はい」と判定したとき | 指定モデルに「はい／いいえ」で判定させる。判定は小型モデルが速くて安上がりです |

LLM判定が「はい／いいえ」以外を返した場合は **実行する側に倒します**
（機会損失より安全）。スキップされた場合は進捗パネルに理由が表示されます。

テンプレート「💻 通常回答＋コード生成」がこの構成の雛形です。

### 参照ドキュメント(RAG)と画像を使う

エディタでノードごとに有効化します。**そのノードにだけ**渡るので、資料を読む担当と
画像を見る担当を分ける、といった構成が組めます。

| チェック | 渡されるもの |
|---|---|
| 📚 参照ドキュメント(RAG) | チャットに添付したドキュメント ＋ 永続RAGドキュメント（`ml/rag`）を質問文で検索した上位チャンク |
| 🖼️ 画像 | チャットに添付した画像 |

**RAG** は2系統を自動で統合します。チャット添付分はブラウザ側に埋め込みがあるので
ブラウザで検索し、永続RAG分はサーバーで検索して、スコア順に上位 `ragTopK` 件を渡します。
資料は system ロールで「参考資料」として渡され、出典（ファイル名）も付きます。
embedding モデルが未設定だと検索できないため、エディタで警告が出ます。

**画像** は `--mmproj` が指定された Vision 対応モデルでのみ使えます。
非対応モデルに設定するとエディタが警告します。討論ノードでは1巡目にだけ渡します
（毎巡渡すとコンテキストを圧迫するため）。

画像を受け取るノードが1つも無いワークフローに画像を添付して送ろうとすると、
無視されるだけなのでチャット側で止めて知らせます。

実行中は進捗パネルのヘッダーに `📚 3件` `🖼️ 1枚` と表示されます。

### VRAMの内訳を確認する

進捗パネルの「VRAM内訳」を開くと、**どのモデルが何にどれだけ使うか** が出ます。

```
Gemma4 31B          ctx 32k
  重み 18.9 ＋ KVキャッシュ 3.2 ＋ 予備 0.9 = 23.0GB
Qwen3.6 35B-A3B     ctx 32k
  重み 19.1 ＋ KVキャッシュ 3.0 ＋ 予備 1.0 = 23.1GB
合計 46.1GB ＋ 安全余裕 2.0GB ≦ 空きVRAM 59.6GB
```

各行の下には、その数字がどこから来たかが出ます。

| 表示 | 意味 |
|---|---|
| `実測値` | 一度ロードした際に **llama-server 自身が報告した確保サイズ**。最も正確 |
| `GGUF算出` | GGUFヘッダの層数・KVヘッド数・ヘッド次元から計算（`gemma3 / 62層 × KV16ヘッド × 128次元`） |
| `概算` | GGUFを読めなかった場合の保守的な推定 |

**一度でもそのモデルをロードすれば、以降は実測値に置き換わります。** 実測値は
`vram-measured.json` に `(モデル名, ctx)` 単位で保存されます。Gemma系の
unified KV のようにアーキテクチャ固有の事情で推定がずれる場合も、実測なら正確です。

数値がおかしいと感じたら、付属の診断ツールで確認できます（llama-serverの起動は不要）:

```bash
cd ~/opengeek-llm-chat
node gguf_info.js                       # config.json の全モデルを診断
node gguf_info.js /path/to/model.gguf 32768   # 単体で診断
```

GGUFから読み取った値を接頭辞ごとに全部表示し、どの値を採用したか、
妥当性チェックのどれで落ちたかまで出します。

```
  general.architecture = gemma3
  ── 接頭辞ごとの読み取り結果 ──
    ★採用 gemma3.*
             block_count = 62
             attention.head_count_kv = 16
             ...
          clip.*                      ← ビジョンタワー側（採用しない）
             block_count = 27
  ── 妥当性チェック ──
    範囲チェック   : OK
    GQA制約        : OK
    次元の整合     : OK
    → GGUFの値を採用
```

「概算」と出る場合は GGUF を読めていない（または妥当性チェックで弾かれた）ので、
保守的な概算値が使われます。

> ⚠️ `llm_pool.js` は起動時に読み込まれるため、ファイルを差し替えたら
> **本体の再起動が必要**です（`sudo systemctl restart opengeek-llm-chat`）。
> 画面側はブラウザキャッシュのため Ctrl+Shift+R で再読み込みしてください。

**足りないときは `ctx` を下げるのが一番効きます。** KVキャッシュは ctx に正比例するので、
32768 → 8192 にすれば KV は 1/4 になります。同じ内訳が editconfig のワークフローエディタにも
表示されるので、**実行する前に**収まるかどうか確認できます。

### 「socket hang up」と出たとき

llama-server のプロセスが落ちたことを示しています。**ほぼVRAM不足** です。

進捗パネルのエラーに、終了コード・落ちた瞬間の実測VRAM・llama-server の最終出力が表示されます:

```
VRAM不足の可能性: モデル「Gemma4 31B」のllama-serverが異常終了しました (exit=1)
異常終了時のGPU: GPU 0 29.8/30.0GB使用 , GPU 1 29.6/30.0GB使用
対処: モデルの ctx を下げる（KVキャッシュが比例して減ります）/ 使うモデルを減らす /
 小さいモデルに変える / config.json の orchestration.maxResident を 1 にする
--- llama-server の最終出力 ---
ggml_backend_alloc_ctx_tensors_from_buft: failed to allocate buffer
llama_model_load: error loading model: unable to allocate ROCm0 buffer
```

常駐並列で落ちた場合は、**自動的に逐次スワップへ切り替えて落ちたノードだけ再実行** します
（進捗パネルに ⚠️ で表示されます）。多くの場合そのまま完走しますが、再試行でも落ちる場合は
本当にVRAMが足りていないので、上の「VRAMが足りない場合」の対策を取るか、
ワークフローで使うモデルを小さいものに置き換えてください。

> 💡 `logLevel: "quiet"` でもワーカーの出力は内部に保持されるので、原因は必ず表示されます。
> サーバーのコンソールログにも `[LLMプール] ワーカー異常終了` として残ります。

### どのワークフローを選ぶか

| やりたいこと | おすすめ | 理由 |
|---|---|---|
| とにかく回答の質を上げたい | 並列合議 | 複数モデルの視点を統合するので抜けが減る |
| 速度とVRAMを節約したい | ルーター振り分け | 実際に動くのは1モデルだけ。選ばれなかったモデルはロードすらされない |
| 長文・文章の完成度を上げたい | 下書き→推敲 | 小型モデルで骨子を作り、高品質モデルは仕上げに専念できる |
| 判断が割れる問いを扱いたい | 討論→結論 | 賛否両論を出し切ってから結論を出せる |

### 留意点

- 推論時間は素直に増えます。並列合議は最良でも「最も遅いモデル + 統合1回」、逐次スワップならモデルのロード時間が毎回乗ります
- **統合役には一番良いモデルを充ててください。** 0.5B級は振り分け（ルーター）は当たりますが、複数意見の統合は破綻しやすいです
- Web検索・ファイル操作などの **ツール実行はマルチLLM選択中は使えません**。ツールが要る質問は単一モデルに切り替えてください（RAGと画像は下記のとおり対応しています）
- 進捗パネルはチャット履歴にも保存されるので、後から開き直しても各モデルの出力を確認できます

詳細な設計は [DESIGN.md](./DESIGN.md) のマルチLLMオーケストレーションセクションを参照。

---

## ⚙️ config.json をブラウザから編集

`https://<host>:3000/editconfig.html` で config.json を直接編集可能。チャット画面の左下にある小さな歯車アイコン「⚙ 設定」からも遷移できる。認証は本体と共有（Cookie）。

### 主な機能

| 機能 | 説明 |
|:--|:--|
| 🌳 **ツリー編集**（既定） | **括弧やカンマを気にせず、GUIで設定を編集**。値の型ごとの入力UI、キーの追加/改名/削除、配列の並べ替え/複製、キーの説明表示、検索 |
| 📝 テキスト編集 | 行番号付き、リアルタイムJSON構文チェック、Ctrl+S 保存 |
| ✨ 整形 | JSON pretty-print（2スペースインデント、テキスト表示時のみ） |
| 💾 自動バックアップ | 保存時に `config.json.bak.<timestamp>` を作成、最新10件保持 |
| ⏮ 復元 | サイドバーのバックアップ一覧からワンクリック復元 |
| 🔄 本体を再起動 | ブラウザから OpenGeekLLMChat 本体プロセスを再起動 |
| 📊 サーバー情報 | PID、起動時間、systemd管理下かどうかを表示 |
| ⬇ モデル追加 | HuggingFace の GGUF リンクから1ボタンでダウンロード＆`chatModels`登録 |

### 🌳 ツリー編集（既定の表示）

生のJSONを直接いじると、括弧・カンマ・`\n` のエスケープの対応を人間が追うことになり、
1文字の打ち間違いで起動しなくなる。ツリー編集はそこを GUI に置き換えたもの。

```
▼ config.json : { 46 キー }
    appName    : [OpenGeekLLMChat        ]  ブラウザのタイトル・表示名
    webSearch  : ( true )                   Web検索（DuckDuckGo）を使えるようにする
  ▼ chatModels : [ 3 個 ]                   チャットに使うGGUFモデル一覧
    ▼ [0] : { 5 キー }          [型▼] { } ↑ ↓ ⧉ ✕
        name : [Gemma4 31B            ]     UIに表示する名前
        ctx  : [32768]                      コンテキスト長（起動時に固定）
```

| できること | 操作 |
|:--|:--|
| **値を編集** | 値をクリックして入力。確定は Enter またはフォーカスを外す、取り消しは Esc |
| **真偽値の切り替え** | `true` / `false` のバッジをクリック |
| **長文の編集** | `systemPrompts` のような改行入りの文字列は複数行のテキストエリアで編集（`\n` を手で書く必要なし） |
| **キー名の変更** | キー名をクリックして書き換え（キーの並び順は保たれる） |
| **キー / 要素の追加** | `＋ キーを追加` / `＋ 要素を追加`。型（文字列・数値・真偽・null・オブジェクト・配列）を選べる |
| **配列の並べ替え・複製・削除** | 行をホバーすると出る `↑ ↓ ⧉ ✕`。`⧉ 末尾を複製` でモデル定義を雛形からもう1つ増やせる |
| **型の変更** | 行右の型セレクタ。`"8080"`（文字列）→ `8080`（数値）のような直しに使う |
| **まとまりをJSONで編集** | オブジェクト/配列の行の `{ }` ボタン。その部分だけをJSONテキストで一括編集（構文エラーは適用前に弾く） |
| **検索** | 上部の検索ボックスにキー名や値を入れると該当箇所だけに絞り込み、自動で展開。一致したキーの配下は丸ごと表示される |
| **説明の表示** | 主要な設定キーには右側に用途の説明が出る（`llamaServer.chatPort` → 「チャット推論サーバーのポート」など） |
| **全展開 / 全折りたたみ** | 上部のボタン。既定はトップレベルだけ開いた状態 |

編集結果は内部で `JSON.stringify(root, null, 2)` としてテキストに書き戻されるので、
**📝 テキスト表示に切り替えればいつでも生JSONを確認でき**、保存・バックアップ・差分判定はこれまで通り動く。
編集しても「💾 保存」を押すまで config.json には書き込まれない。

テキスト表示側で構文を壊した場合、ツリー編集は**止まる**（壊れたデータを元に編集して
テキストの変更を巻き戻さないため）。その時はテキスト表示で直すか「↺ 破棄」で読み込み直す。

### ⬇ HuggingFace GGUF モデルのワンボタン導入

サイドバーの「モデル追加 (HuggingFace GGUF)」にダウンロードURLを貼って **「⬇ ダウンロード & 追加」** を押すだけで、モデルの取得から `config.json` への登録までを自動化できる。

```
1. HuggingFace の GGUF リンクを貼る（resolve / blob どちらのURLでも可）
   例: https://huggingface.co/bartowski/.../Model-Q4_K_M.gguf
2. 「⬇ ダウンロード & 追加」を押す（進捗バーでダウンロード状況を表示）
3. 完了すると config.json の chatModels に自動登録 → エディタも最新化
4. 「🔄 本体を再起動」で反映 → チャット画面のモデル選択に出現
```

- **保存先**: 既存モデルと同じディレクトリを自動検出（`chatModels[].path` → `embeddingModel.path` のフォルダ → なければ `models/`）。`.part` 一時ファイルに書き込み、完了時にリネーム
- **詳細オプション（任意）**: 表示名 / `ctx` / `ngl` / **mmproj URL**（Vision用、`extraArgs` に `--mmproj` で登録）/ **HFトークン**（gated・非公開モデル用。`huggingface.co` 宛のみ送信、CDNには付与しない）
- **安全策**: `huggingface.co` ドメイン・`.gguf` 拡張子のみ許可。HFの `resolve` → CDN署名URL へのリダイレクトを自動追従。書き込み前に config.json を自動バックアップ（最新10件保持）。同名/同パスは上書き
- **進捗の復帰**: 大容量ダウンロード中にページを再読込しても、進行中ジョブがあれば進捗表示を自動復帰
- **エンドポイント**: `POST /config/model-download`（開始）/ `GET /config/model-download/status`（進捗ポーリング）

### 再起動機能の動作

`🔄 本体を再起動` ボタンは systemd の `Restart=always` に依存する仕組み:

```
1. ブラウザから POST /restart
2. サーバー: レスポンス返却 → 1.5秒後 process.exit(0)
3. systemd: プロセス終了を検知 → RestartSec=3秒後に自動起動
4. ブラウザ: GET /restart/info を1秒ごとにポーリング
5. 新プロセスのuptimeが短い = 再起動完了と判定 → 「✓ 再起動完了」表示
```

### 安全装置

- **未保存変更がある状態で再起動**: 確認ダイアログ
- **systemd 下でない場合**: 警告（自動復帰されない可能性）
- **JSON構文エラーで保存できない**: 赤バナーで明示
- **必須キー（`chatModels`, `llamaServer`）欠落で保存拒否**: 暴発防止
- **パストラバーサル対策**: 復元ファイル名は `basename` のみ、プレフィックス検証

### 使い方

```
1. https://<host>:3000/editconfig.html を開く（左下の歯車アイコンから）
2. 編集（リアルタイム構文チェック）
3. Ctrl+S または 💾 保存ボタン
4. 「🔄 本体を再起動」をクリック
5. 約5〜7秒で復活、変更が反映される
```

### 注意点

- **systemd 起動前提**: 直接 `node server.js` で動かしている場合、再起動ボタンは「プロセス終了のみ」で復帰しない
- **複数人運用**: config.json には `password` ハッシュも含まれるため、編集できる人は実質admin権限
- **大きな変更時はSSHでも確認**: モデルパス・ポート番号を間違えると llama-server 起動失敗 → サーバー全体が動かない可能性。実機で `journalctl -u opengeek-llm-chat -f` を併用すると安心

---

## 🌐 GPUクラスタ化（複数PC接続）

llama.cppの **RPCモード** を使うと、複数PCのGPUを1つの仮想的なGPUプールとして扱えます。1台では収まらない大型モデル（405B、671B等）を動かしたり、推論速度を向上させたりできます。

### 必要環境

- **高速ネットワーク必須**: 100GbE以上推奨（NVIDIA Mellanox ConnectXシリーズ等）
- 1GbEや10GbEでは通信遅延で実用的な速度が出ない
- 全PCに同じバージョンのllama-serverがインストール済み

### 想定構成例

```
Master PC: R9700 ×2 (60GB VRAM)         ┐
   ConnectX-6/7 100/200/400GbE         │
        ├── Worker 1: R9700 ×2 (60GB)   ├ 合計 240GB VRAM
        ├── Worker 2: R9700 ×2 (60GB)   │ 405Bモデルも動作可能
        └── Worker 3: R9700 ×2 (60GB)   ┘
```

### 構築手順

#### 1. 各Worker PCで rpc-server を起動

```bash
# Worker 1 (例: 192.168.100.11)
llama-server \
  --rpc-server \
  --host 0.0.0.0 \
  --port 50052 \
  --device ROCm0,ROCm1 \
  -ngl 99

# Worker 2, 3 も同様
```

#### 2. Master PCでクラスタモード起動

```bash
llama-server \
  -m /path/to/large-model.gguf \
  --rpc 192.168.100.11:50052,192.168.100.12:50052,192.168.100.13:50052 \
  -ngl 99 \
  --tensor-split 0.25,0.25,0.25,0.25 \
  --port 8080 \
  -c 32768 -fa on
```

`--tensor-split` で各PCへのモデル配分を指定（合計1.0）。Master自身もGPUを使う場合は4分割。

#### 3. config.jsonでクラスタ用モデル定義

```json
"chatModels": [
  {
    "name": "DeepSeek V3 671B (4ノードクラスタ)",
    "path": "/path/to/DeepSeek-V3-Q2_K_S.gguf",
    "ctx": 32768,
    "ngl": 99,
    "extraArgs": [
      "--rpc", "192.168.100.11:50052,192.168.100.12:50052,192.168.100.13:50052",
      "--tensor-split", "0.25,0.25,0.25,0.25"
    ]
  }
]
```

OpenGeekLLMChat側では特別な改修不要。`extraArgs`で渡すだけ。

### ネットワーク帯域と推論速度

| 接続方式 | 帯域 | 70B Q4 推論速度の目安 |
|:--|:--|:--|
| 1GbE | 0.125 GB/s | ❌ 致命的に遅い |
| 10GbE | 1.25 GB/s | ⚠️ 遅い（単機の半分以下） |
| 25GbE | 3.1 GB/s | △ 何とか実用 |
| 100GbE (ConnectX-5) | 12.5 GB/s | ◯ 実用的 |
| 200GbE (ConnectX-6) | 25 GB/s | ◎ 快適 |
| 400GbE (ConnectX-7) | 50 GB/s | ◎◎ PCIeに近い |
| InfiniBand HDR | 25 GB/s + RDMA | ★ 最速 |

### メリット・デメリット

**メリット**:
- 単機VRAMに乗らない大型モデル（405B、671B等）が動作可能
- 4ノード構成で実効VRAM 240GB以上
- 推論速度も多少向上（線形ではないが1.5〜2倍程度）

**デメリット**:
- 通信オーバーヘッドで完全な線形スケールはしない
- 高速ネットワーク必須（コスト）
- 初回モデルロード時にネットワーク経由でモデル転送が発生
- 現状はTCP通信（RDMAネイティブ対応は将来）

### トラブルシューティング

```bash
# Worker側でrpc-serverが listen しているか確認
ss -tlnp | grep 50052

# Master側からWorkerへ疎通確認
nc -zv 192.168.100.11 50052

# 帯域実測（iperf3）
# Worker側: iperf3 -s
# Master側: iperf3 -c 192.168.100.11 -t 10
```

---

## 🛠️ 技術スタック

| Layer | Tech |
|:--|:--|
| Frontend | React 18 (CDN/Babel) · marked · highlight.js · KaTeX · Three.js r128 · Web Speech API (STT/TTS) |
| Backend | Node.js · Express · ws（依存2つのみ）· HTTPS対応 |
| AI | llama.cpp (llama-server, OpenAI互換API) · mxbai-embed-large · Tool Calling · マルチターン実行 |
| Python | matplotlib（画像自動表示）· 日本語フォント自動選択 · DuckDB（SQL処理） |
| Search | DuckDuckGo HTML Lite + 本文取得 |
| Cloud | Google Drive API v3（OAuth2 / サービスアカウントJWT を Node標準 https + crypto だけで実装、追加依存なし） |
| Auth | セッションCookie (24h) · MD5/SHA-256 + timingSafeEqual · HTTPS時Secure自動付与 |
| GPU監視 | rocm-smi / nvidia-smi |
| クラスタ | llama.cpp RPC mode（オプション、ConnectX等の高速NW推奨） |

---

## 🤝 Contributing

PR大歓迎。ギーク的な改造ほど歓迎します。

---

## 📝 ライセンス

[MIT](LICENSE)   
※一部はAIによって生成されています。
