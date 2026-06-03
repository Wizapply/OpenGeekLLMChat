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

### 🎯 ドラッグ&ドロップ統合UI
3つのドロップゾーンが状況に応じて自動で振り分け:
- **チャット入力欄**: 画像→Vision添付、その他→ドキュメント取り込み
- **左サイドバー（ドキュメント）**: RAG用ドキュメントとして取り込み（embedding生成）
- **右サイドバー（サーバーファイル）**: `public/uploads/` にバイナリ含めて保存

### 🌐 Web検索ON/OFFトグル
チャット入力欄の🌐ボタンで検索の有効/無効を即座に切り替え可能。社内ドキュメントだけで答えてほしい時はOFF、最新情報が必要な時はONに。デフォルトは `config.webSearch` で設定。

### 📐 履歴の重み付け（直近優先）
直近6件のメッセージはそのまま送信、それ以前は「参考情報」として圧縮、最新ユーザー質問には「今この質問に回答してください」マーカーを付加。長い会話でも最新文脈を確実に優先させます。`config.recentMessageCount` で件数調整可能。

### ⚡ マルチGPU・テンソル並列
1台のサーバー内で複数GPU（NVIDIA / AMD ROCm）を使ったテンソル並列推論が可能。`commonArgs` で `--device ROCm0,ROCm1` のように指定するだけ。VRAMを束ねて大規模モデルを実行できます。

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

- **テキストエディタ + リアルタイム JSON 構文チェック**: 編集中に構文エラーをハイライト
- **ツリービュー**: 構造を折りたたみ可能なツリーで可視化（読み取り専用）
- **整形（pretty-print）/ 破棄 / Ctrl+S 保存**: VS Code風の操作感
- **保存時に自動バックアップ**: `config.json.bak.<timestamp>` を最新10件まで保持
- **バックアップから復元**: サイドバーのバックアップ一覧からワンクリック復元
- **🔄 本体を再起動ボタン**: ブラウザから OpenGeekLLMChat 本体プロセスを再起動（systemd管理下なら自動復帰）
- **再起動状態のポーリング表示**: 再起動完了まで自動で監視、復活したら「✓ 再起動完了」と通知
- **PID / 起動時間表示**: サーバープロセスの状態が一目でわかる

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
- **通常チャットでの自動有効化**: 登録ドキュメントが1件以上あれば、UI 操作なしで自動的にツールがLLMに提供される。サイドバーに「📚 永続RAG (サーバー登録)」バッジを表示
- **embedding 未設定時の自動 OFF**: 4層防御 (UI非表示 / 起動時自動除外 / API 503 / agent_proxy ツール除外)
- **Python REST 経由で管理**: `/rag/documents` 等のエンドポイントで登録・一覧・削除

### 🖼️ 画像物体検出 (torchvision)
`/ml.html` の「画像」タブで、画像内の物体を検出できる。COCO事前学習モデルでの即時検出と、独自クラスのカスタムモデル学習の両方に対応。**追加パッケージは torchvision のみ** (YOLO等の外部依存なし、BSDライセンス)。

- **COCO事前学習モデルで即検出**: Faster R-CNN / RetinaNet / SSD など5モデルから選択。人・車・動物・家具など80クラスを検出。信頼度しきい値の調整、クラス別色分け表示
- **カスタムモデル学習 (転移学習)**: 独自データセットを作り、Faster R-CNN をファインチューニング。少クラス・少量データ (数十枚〜) でも実用的。ベースモデルは ResNet50 / MobileNetV3 / 事前学習なし (scratch) から選択
- **ブラウザ完結アノテーション**: 画像をアップロードし、ブラウザ上で矩形を描画してラベル付け。2つの入力方式 (ドラッグで矩形 / クリックで固定サイズ矩形を生成、サイズ4〜300px)。矢印キーで画像送り、↑キーで保存。サムネイル一覧で進捗 (矩形個数バッジ) を一覧表示しクリックでジャンプ
- **YOLO / COCO インポート**: 既存の YOLO 形式 (正規化座標) や COCO 形式のアノテーションを取り込み可能
- **LLM チャット連携**: 画像を添付して「何が写ってる?」と聞くと、LLM が `detect_objects` ツールを呼んで物体を検出し、結果を解釈して回答 (Vision対応モデルなら誤認識の訂正も)
- **学習ジョブ管理**: 表データ学習とは独立した系統 (`currentImageJob`) で管理。リアルタイムログ、停止 (プロセスグループごとkill)、学習履歴
- **モデルのダウンロード**: 学習済みモデルを zip でダウンロード (model.pt + config.json + 推論サンプル `predict_example.py` + README)。Node標準のzlibで生成するため外部コマンド不要。ダウンロードすれば torchvision さえあれば他環境でも単体推論できる
- **外部API**: `POST /ml/image/detect` に画像を base64 で送ると検出結果を JSON で返す。COCO・カスタム両対応。`Authorization: Bearer <token>` (`ml:read` 権限)
- **GPU自動フォールバック**: ROCm/CUDA で実行し、失敗時はCPUに自動切替。MIOpenキャッシュパスもアプリ内に設定済み

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
├── public/
│   ├── index.html              # React SPA（チャットUI）
│   ├── styles.css              # メインスタイルシート (CSS変数, レイアウト, コンポーネント)
│   ├── tuning.html             # React SPA（ファインチューニングUI）
│   ├── tuning-styles.css       # ファインチューニングUI用スタイル
│   ├── ml.html                 # React SPA（機械学習UI）
│   ├── ml-styles.css           # 機械学習UI用スタイル
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
│   └── rag/                    # 外部API用 永続RAGドキュメント
│       ├── index.json          # 登録ドキュメント一覧
│       └── <docId>.json        # チャンク + embeddingベクトル
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
| `ml.enabled` | 機械学習機能 ON/OFF。`true` で `/ml.html` UI と LLMツール (ml_*) を有効化、要 `npm install duckdb` |
| `ml.onlinePort` | 強化学習(RL)オンライン常駐ワーカー (`rl_online_server.py`) の localhost ポート、デフォルト 11600 |
| `ml.onlineIdleMs` | オンラインワーカーのアイドル自動停止時間 (ms)、0 で常駐 (停止しない) |
| `ml.onlineReadyTimeoutMs` | オンラインワーカー起動完了待ちタイムアウト、デフォルト 60000ms |
| `ml.apiTokens[].name` | API トークンの名前 (識別用) |
| `ml.apiTokens[].token` | トークン文字列 (推奨: ml.html の「📡 API」タブから生成) |
| `ml.apiTokens[].permissions` | 権限配列。`"ml:read"` / `"ml:write"` / `"*"` |
| `ragTopK` | RAG検索チャンク数 |
| `ragMode` | `agentic` / `always` |
| `agentContext.smallPredict` | ツール判断時のmax_tokens（短文モード）デフォルト512 |
| `agentContext.largePredict` | ツール判断時のmax_tokens（長文モード）+ continueGen時、デフォルト8192 |
| `agentContext.judgeHistoryCount` | ツール判断時に送る直近メッセージ件数、デフォルト3 |
| `agentContext.largeGenKeywords` | 長文モード判定キーワード（null=デフォルト使用） |
| `recentMessageCount` | 直近何件のメッセージを「そのまま」送信するか（それ以前は「参考情報」化）デフォルト6 |
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
    "base": "あなたは親切で知識豊富なAIアシスタントです。日本語で簡潔に回答してください。今日の日付は{date}です。\n\n重要な指示:\n- 思考は手短に済ませ...",
    "documents": "【参照可能なドキュメント】(チャットに添付されたファイル): {docList}\nユーザーの質問が「ドキュメントについて」「資料を見て」「添付ファイル」などを示唆する場合、必ず最初に search_documents ツールを使ってください。",
    "webSearch": "最新の情報や知らないことについては web_search ツールでインターネット検索できます。",
    "fileAccess": "【サーバーファイル操作】(uploads配下、ドキュメントとは別物)\n- list_files: uploadsフォルダの一覧を取得\n...",
    "python": "Pythonコード実行について:\n- 応答に ```python ... ``` のコードブロックを含めると...",
    "meta": "重要な指示:\n- 内部的な推論・検索戦略・計画・メタ的な説明は一切出力しないでください...",
    "judge": "以下の中から必要なツールを呼び出してください...\n{toolList}\n注意:..."
  }
}
```

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
| `python` | Python実行案内（常時） | - |
| `meta` | メタ抑制指示（常時） | - |
| `judge` | ツール判断専用（軽量） | `{toolList}` |

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
| `GET` | `/config` | — | 公開設定（セッション有効時は `authenticated:true`） |
| `GET` | `/config/raw` | ✓ | config.jsonの生テキスト取得（editconfig.html用） |
| `POST` | `/config/raw` | ✓ | config.json保存（自動バックアップ作成、JSON検証） |
| `GET` | `/config/backups` | ✓ | バックアップ一覧 |
| `POST` | `/config/restore` | ✓ | バックアップから復元 |
| `GET` | `/restart/info` | ✓ | systemd下かどうか、PID、uptime取得 |
| `POST` | `/restart` | ✓ | 本体プロセスを終了（systemd管理下なら自動再起動） |
| `GET` | `/image-gen/info` | ✓ | 画像生成サーバー状態（モデル、起動中フラグ） |
| `POST` | `/image-gen` | ✓ | 画像生成（LLMの generate_image ツール用） |
| `POST` | `/image-gen/unload` | ✓ | sd-server を手動アンロード（VRAM解放） |
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
- サイドバーのドキュメント欄に **「📚 永続RAG (サーバー登録)」** バッジが表示されます (件数つき)
- embedding サーバーが利用できない場合や、登録ドキュメントが0件の場合は**自動的に無効化** (UIにも表示されない)

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

### ストレージ

```
ml/
├── datasets.duckdb     # DuckDB データ本体 (全テーブル)
├── meta.json           # テーブル説明・取得元URL等のメタ情報
├── models.json         # モデル定義一覧
├── jobs.json           # 学習ジョブ履歴
└── models/             # 学習成果物
    └── <model_name>/
        ├── config.json       # モデル設定 + 派生情報
        ├── model.pt          # PyTorch state_dict
        ├── scaler.pkl        # StandardScaler 情報
        ├── label_encoders.pkl  # カテゴリ列のエンコーダ
        ├── metrics.json      # 学習指標 + 履歴
        └── train.log         # 学習ログ
```

### 留意点

- **DuckDB は1プロセス排他ロック** (1.x時点)。学習中は Node 側の DB アクセスをブロックして調停する
- **モデル名・テーブル名は英数字+アンダースコアのみ** (SQLインジェクション対策、最大64文字)
- **時系列タスク**は事前にデータを「単一系列」になるよう SQL で絞ってから使う (混在データだと意味が無い)
- **データ量の目安**: 回帰/分類は最低 50 行、時系列は最低 100 行 + ウィンドウサイズ。312行 × 500エポックの学習が R9700 で 2.8 秒
- **派生列を直接渡さない**: 日時列は自動分解されるので、推論時も元の日付文字列 (例: `"2027-04-15"`) を渡す。万一 LLM が派生列で呼んでも、サーバー側で自動修正される

詳細な実装は [DESIGN.md](./DESIGN.md) の機械学習セクションを参照。

---

## ⚙️ config.json をブラウザから編集

`https://<host>:3000/editconfig.html` で config.json を直接編集可能。チャット画面の左下にある小さな歯車アイコン「⚙ 設定」からも遷移できる。認証は本体と共有（Cookie）。

### 主な機能

| 機能 | 説明 |
|:--|:--|
| 📝 テキスト編集 | 行番号付き、リアルタイムJSON構文チェック、Ctrl+S 保存 |
| 🌳 ツリービュー | JSON構造を折りたたみ可能なツリーで可視化 |
| ✨ 整形 | JSON pretty-print（2スペースインデント） |
| 💾 自動バックアップ | 保存時に `config.json.bak.<timestamp>` を作成、最新10件保持 |
| ⏮ 復元 | サイドバーのバックアップ一覧からワンクリック復元 |
| 🔄 本体を再起動 | ブラウザから OpenGeekLLMChat 本体プロセスを再起動 |
| 📊 サーバー情報 | PID、起動時間、systemd管理下かどうかを表示 |

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
