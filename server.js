const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { WebSocketServer } = require('ws');
const { startAgentServer } = require('./agent_proxy');
const { createLlmPool } = require('./llm_pool');
const { createOrchestrator, validateWorkflow } = require('./orchestrator');
const { createGoogleDrive } = require('./google_drive');

// systemd等で起動された際、カレントディレクトリをserver.jsと同じに固定する
// これにより相対パスでアクセスされるリソース(モデルキャッシュ等)も安定動作する
process.chdir(__dirname);

// ─── 設定 ───
const PORT = process.env.PORT || 3000;
const PYTHON_TIMEOUT = parseInt(process.env.PYTHON_TIMEOUT) || 60000;
// このプロセスの起動時刻。再起動を検知するための識別子として公開する。
// セッションは再起動で消えるため、認証が要る /restart/info では復帰を判定できない。
const SERVER_STARTED_AT = Date.now();

// ─── アプリ設定 (config.json) ───
const CONFIG_FILE = path.join(__dirname, 'config.json');
const DEFAULT_CONFIG = {
  appName: 'OpenGeekLLMChat',
  logoMain: 'OpenGeekLLM',
  logoSub: 'Chat',
  welcomeMessage: 'ドキュメントをアップロードしてRAGベースの質問応答を行うか、自由にチャットを開始できます。',
  welcomeHints: ['ドキュメントを要約して', 'この資料の要点は？', '〇〇について教えて'],
  accentColor: '#34d399',
  defaultModel: '',  // chatModelsのname。空なら一覧の先頭
  password: '',
  pythonPath: 'python3',
  transcribe: {
    enabled: false,
    host: '127.0.0.1',
    port: 11500,
  },
  // ─── llama.cpp 設定 ───
  llamaServer: {
    binPath: '/usr/local/bin/llama-server',  // llama-server バイナリのパス
    chatHost: '127.0.0.1',
    chatPort: 8080,
    embeddingHost: '127.0.0.1',
    embeddingPort: 8081,
    // 起動時の追加共通引数（GPU offload等、chatModelsのextraArgsで上書き可）
    commonArgs: ['--host', '127.0.0.1', '-fa', 'on'],
    // 起動から ready 判定までのタイムアウト(ms)
    readyTimeoutMs: 120000,
    // モデルアンロードまでのアイドル時間(ms)、0で無効。※将来用、現在未使用
    idleUnloadMs: 0,
  },
  // チャット用モデル一覧
  chatModels: [
    // {
    //   name: 'Gemma3 12B',
    //   path: '/models/gemma-3-12b-it-Q4_K_M.gguf',
    //   ctx: 8192,
    //   ngl: 99,
    //   chatTemplate: '',  // 空ならGGUFのメタデータ使用
    //   extraArgs: []
    // }
  ],
  // RAG用Embeddingモデル（別ポートで起動）
  embeddingModel: {
    // path: '/models/mxbai-embed-large-v1-f16.gguf',
    // ctx: 512,
    // ngl: 99,
    // poolingType: 'mean'  // mean, cls, last, none
  },
  webSearch: true,
  fileAccess: true,
  imageGen: false,           // 画像生成（stable-diffusion.cpp連携）。imageModels[]を定義して有効化
  ttsGen: false,             // 音声合成（Irodori-TTS連携）。irodoriTts を設定して有効化
  // ─── 音声合成 (Irodori-TTS) 設定 ───
  // 画像生成(stable-diffusion.cpp)と同じ方式: Irodori-TTS の OpenAI互換サーバーを
  // 子プロセスで spawn し、オンデマンド起動・アイドルアンロードする。
  // 起動コマンド例: uv run python -m irodori_openai_tts --host 127.0.0.1 --port 8088
  irodoriTts: {
    host: '127.0.0.1',
    port: 8088,
    endpoint: '/v1/audio/speech',  // OpenAI互換エンドポイント
    model: 'irodori-tts',          // リクエストの model フィールド
    defaultVoice: 'none',          // voices/ 配下のリファレンス音声ID。'none' は参照音声なし(VoiceDesign/既定話者)
    defaultFormat: 'wav',          // wav / mp3 / flac / opus / aac / pcm
    defaultSpeed: 1.0,             // 0.25〜4.0
    // 声のテキスト記述(VoiceDesign)の送り先。'instructions'(OpenAI標準) と
    // irodori.caption の両方に入れる。strictなサーバー向けに captionField=null で無効化可。
    captionField: 'caption',       // irodori オブジェクト内に入れるキー名 (null で無効)
    irodori: {},                   // irodori 拡張の基底オプション (num_steps, cfg_scale_text 等)
    timeoutMs: 180000,             // 1リクエストのタイムアウト
    // ── 子プロセス管理 (sd-server と同じ方式) ──
    // command/args を設定すると server.js が Irodori-TTS サーバーを spawn し
    // オンデマンド起動する。未設定なら「外部で起動済み」とみなし転送のみ行う。
    command: null,                 // 例: 'uv'
    args: null,                    // 例: ['run','python','-m','irodori_openai_tts','--host','127.0.0.1','--port','8088']
    cwd: null,                     // Irodori-TTS-Server のディレクトリ
    env: {},                       // 追加環境変数 (HIP_VISIBLE_DEVICES 等)
    readyTimeoutMs: 300000,        // 起動完了(TCP接続)待ちタイムアウト
    idleUnloadMs: 600000,          // アイドルアンロード(ms)。0/未設定で無効
  },
  ttsVoices: [],                   // 声プリセット: [{ name, desc, voiceId, instructions }]
  // ─── 機械学習 (ML) 設定 ───
  // データテーブル(DuckDB)、Web API インポート、PyTorch学習、外部APIトークン
  // 旧フォーマット (`mlEnabled` / `apiTokens` トップレベル) も後方互換読み込み対応
  ml: {
    enabled: false,          // 機械学習機能の有効化。要 `npm install duckdb`
    apiTokens: [],           // 外部API用トークン: [{name, token, permissions}]
                             //   permissions: "ml:read" / "ml:write" / "*" (全部)
    onlinePort: 11600,       // リアルタイム/オンラインRLワーカーのポート (Node が遅延起動)
    onlineIdleMs: 0,         // ワーカーのアイドル停止(ms)。0=常駐(学習途中のバッファ保護のため既定無効)
    onlineReadyTimeoutMs: 60000, // ワーカー起動待ちタイムアウト(ms)
  },
  // ─── マルチLLMオーケストレーション設定 ───
  // 複数の llama-server を別ポートで同時に立ち上げ、ユーザーが組んだワークフロー
  // (ノードのつながり) に従って協調実行する。詳細は DESIGN.md 参照。
  orchestration: {
    enabled: false,           // 機能の有効化。workflows を1つ以上定義して使う
    poolMode: 'auto',         // 'auto' | 'resident'(全同時常駐) | 'swap'(逐次載せ替え)
    portRange: [8100, 8149],  // ワーカーllama-serverに割り当てるポート範囲
    maxResident: 3,           // 同時常駐させるワーカー数の上限 (resident時)
    workerParallel: 1,        // ワーカーの -np。2以上にすると同一モデルへ並列に投げられるが、
                              // llama.cpp は ctx をスロット数で分割するため1回あたりの文脈が狭くなる
    workerHost: '127.0.0.1',  // ワーカーのバインドアドレス (外部公開しないので localhost 推奨)
    idleUnloadMs: 600000,     // ワーカーのアイドルアンロード(ms)。0で無効
    vramSafetyMarginMB: 2048, // auto判定で確保しておく空きVRAMの余裕(MB)
    reuseMainChat: true,      // メインチャットに同じモデルが載っていれば再利用する
    swapUnloadsMainChat: true,// swap時にメインチャットモデルを一時アンロードして枠を空ける
    relayMaxChars: 6000,      // 中間出力を下流ノードに渡すときの最大文字数
    includeBaseSystemPrompt: true, // 各ノードに systemPrompts.base を含めるか
    stopOnNodeError: false,   // ノード失敗時にワークフロー全体を中断するか
    acquireTimeoutMs: 600000, // ワーカーの空き待ちタイムアウト(ms)
    defaultWorkflow: '',      // チャット画面で初期選択するワークフローID (空=未選択)
    workflows: [],            // ワークフロー定義。UIのエディタから編集・保存される
  },
  // ─── Google Drive 連携 ───
  // LLM が Drive のファイルを検索・閲覧し、必要なら書き込み・サーバー取り込みまで行う。
  // 認証は2方式:
  //   'oauth'          … 個人アカウントをブラウザで一度だけ認可 (推奨・手軽)
  //   'serviceAccount' … サービスアカウントJSONキー (ヘッドレス/共有ドライブ向け)
  // 秘密情報の扱い: clientSecret は /config で公開されない。リフレッシュトークンは
  // config.json ではなく tokenFile (既定 gdrive_token.json、chmod 600) に保存される。
  googleDrive: {
    enabled: false,                 // 機能の有効化
    authMode: 'oauth',              // 'oauth' | 'serviceAccount'
    // ── OAuth (Google Cloud Console → 認証情報 → OAuth クライアントID → ウェブアプリケーション) ──
    clientId: '',
    clientSecret: '',
    // 承認済みリダイレクトURIに、この値をそのまま登録すること
    redirectUri: 'http://localhost:3000/gdrive/auth/callback',
    // ── サービスアカウント ──
    serviceAccountKeyFile: '',      // JSONキーのパス (相対ならサーバーのディレクトリ基準)
    impersonateUser: '',            // Workspace のドメイン全体の委任で代理するユーザー
    // ── アクセス制御 ──
    rootFolderId: '',               // 指定するとこのフォルダ配下だけに限定 (サンドボックス)
    readOnly: true,                 // true = 読み取り専用 (書き込みツールを出さない)
    allowWrite: false,              // readOnly:false と両方 true で書き込み許可
    allowDelete: false,             // ゴミ箱への移動/削除を許可
    // ── 上限 ──
    maxDownloadMB: 20,              // 1ファイルのダウンロード上限
    maxUploadMB: 20,                // 1ファイルのアップロード上限
    maxTextChars: 20000,            // LLM に渡すテキストの最大文字数
    defaultPageSize: 30,            // 一覧・検索の既定件数
    sharedDrives: true,             // 共有ドライブ(旧チームドライブ)も対象に含める
    tokenFile: 'gdrive_token.json', // リフレッシュトークンの保存先
  },
  ragTopK: 10,
  ragMode: 'agentic',
  systemPrompts: {
    base: 'あなたは親切で知識豊富なAIアシスタントです。日本語で簡潔に回答してください。今日の日付は{date}です。\n\n重要な指示:\n- 思考は手短に済ませ、ユーザーへの回答を必ず出力してください。\n- ツールから取得した情報は信頼し、そのまま使ってください（妥当性を過度に疑わないこと）。\n- 日付に関する自己矛盾を感じても、与えられた{date}を真として処理してください。過去の学習データとの整合性を気にする必要はありません。\n- 天気・ニュース・株価など現在情報は、ツールの結果をそのまま引用してください。',
    documents: '【参照可能なドキュメント】(チャットに添付されたファイル): {docList}\nユーザーの質問が「ドキュメントについて」「資料を見て」「添付ファイル」などを示唆する場合、必ず最初に search_documents ツールを使ってください。\nこれらは添付ドキュメントであり、サーバーファイル（uploads配下）とは別物です。',
    webSearch: '最新の情報や知らないことについては web_search ツールでインターネット検索できます。',
    fileAccess: '【サーバーファイル操作】(uploads配下、ドキュメントとは別物)\n- list_files: uploadsフォルダの一覧を取得\n- read_file(path): uploadsフォルダのファイル読み込み\n- write_file(path, content): uploadsフォルダにファイル書き込み\n重要: pathには"uploads/"プレフィックスを付けずにファイル名のみを指定してください（例: "hello.py"、"data/config.json"）。\nユーザーが明確に「サーバーファイル」「uploadsフォルダ」「ファイルを保存して」など、サーバー側のファイルシステム操作を依頼した場合のみ使用してください。\nチャットに添付されたドキュメントについての質問では list_files/read_file/write_file は使わず、search_documents を使ってください。',
    python: 'Pythonコード実行について:\n- 応答に ```python ... ``` のコードブロックを含めると、ユーザー側で実行ボタンが表示されます。\n- グラフ・図の作成依頼には matplotlib を使ったPythonコードを提示してください（matplotlib.use(\'Agg\')の指定は不要、plt.show()で自動的にチャットに画像表示されます）。\n- データ処理・計算・可視化の依頼では、迷わずPythonコードブロックを返してください。それだけで完結します。ツール呼び出しは不要です。\n- 大量データ・CSV/Parquet/JSON処理・複雑な集計には DuckDB を使ってください。SQLでpandasより高速かつメモリ効率良く処理できます。\n  使い方: import duckdb; con = duckdb.connect(); df = con.execute("SELECT ... FROM \'data.csv\'").df()\n  CSVやParquetを直接 FROM で参照可能。pandasのDataFrameもテーブルとして使えます（con.execute("SELECT ... FROM df")）。',
    googleDrive: '【Google Drive】(サーバーのuploadsフォルダとも、チャット添付ドキュメントとも別物)\n- gdrive_search_files(query): Drive 全体からファイル名・本文で検索\n- gdrive_list_files(folderId): フォルダの中身を一覧 (folderId は省略可、フォルダ名やパスでも指定できる)\n- gdrive_read_file(fileId): ファイルの中身をテキストで読む (Google ドキュメント/スプレッドシートは自動でテキスト/CSVに変換される)\n- gdrive_import_to_server(fileId): Drive のファイルをサーバーの uploads に取り込む (Pythonで処理したい時やバイナリの時)\n- gdrive_write_file(name, content): Drive にファイルを作成/更新\n- gdrive_upload_from_server(path): uploads のファイルを Drive にアップロード\n- gdrive_create_folder(name): フォルダ作成\n- gdrive_delete_file(fileId): ゴミ箱に移動\n使い方の指針: まず gdrive_search_files か gdrive_list_files で目的のファイルを特定し、返ってきた id を gdrive_read_file に渡すこと。IDが分からないうちに読もうとしないこと。\nIDは長くて写し間違えやすいので、自信が無ければ一覧の【通し番号 (1, 2, 3...)】か【ファイル名】を fileId に渡してもよい。読み込みに失敗しても、同じIDで何度も試さず、候補の番号か名前で指定し直すこと。\nユーザーが「ドライブ」「Google Drive」「グーグルドライブ」「クラウドのファイル」等に言及した場合に使ってください。',
    meta: '重要な指示:\n- 内部的な推論・検索戦略・計画・メタ的な説明は一切出力しないでください。\n- "I need to...", "The user wants...", "I should..." のような独り言を書かないでください。\n- ツールを呼び出すと決めたら、即座にツールを呼び出してください。テキスト応答と併用しないでください。\n- 検索結果が得られなかった場合は、その旨を簡潔に伝え、自分の知識で回答してください。',
    judge: '以下の中から必要なツールを呼び出してください。通常の質問に答えられる場合はツールを使わずそのまま応答してください。\n{toolList}\n注意: チャット添付ドキュメントとサーバーuploadsファイルは別物。ドキュメント関連は search_documents、サーバーファイル関連は list_files/read_file/write_file。\nグラフ・計算・データ処理はツール不要。```python ... ``` コードブロックを応答に含めれば自動実行されます（matplotlibで画像表示、DuckDBで高速SQL処理可能）。\n内部推論は書かず、ツールを呼ぶか直接短く応答するかのみ。',
  },
  agentContext: {
    smallPredict: 512,        // ツール判断時のmax_tokens (短文モード)
    largePredict: 8192,       // ツール判断時のmax_tokens (長文モード) + continueGen時
    judgeHistoryCount: 3,     // ツール判断時に送信する直近メッセージ数
    largeGenKeywords: null,   // 長文モード判定キーワード (null=デフォルト使用)
  },
  tokenAvgWindow: 2000,
  recentMessageCount: 6,
  topK: 40,
  topP: 0.9,
  temperature: 0.7,
  // ─── 繰り返し/思考ループ対策のサンプラー (llama.cpp) ───
  // Qwen3 等の thinking が同じ文を繰り返してループするのを防ぐ。1.0/0で各々無効。
  repeatPenalty: 1.1,        // 繰り返しペナルティ (1.05〜1.15が無難、1.0で無効)
  repeatLastN: 320,          // ペナルティを適用する直近トークン数
  presencePenalty: 0,        // OpenAI互換 presence_penalty
  frequencyPenalty: 0,       // OpenAI互換 frequency_penalty
  // DRY サンプラー: 反復ループに非常に有効 (dryMultiplier=0 で無効)
  dryMultiplier: 0.8,
  dryBase: 1.75,
  dryAllowedLength: 2,
  dryPenaltyLastN: -1,       // -1 = コンテキスト全体を対象
  // 1応答あたりの最大生成トークン (暴走ループの安全網。agentContext.largePredict が優先)
  chatMaxTokens: 8192,
  // ログレベル: 'verbose' (全ログ), 'normal' (デフォルト), 'quiet' (最小限)
  // 'quiet' にすると /v1/* プロキシの毎リクエストログとllama-serverのstdoutを抑制
  logLevel: 'normal',
};
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const userConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      const merged = { ...DEFAULT_CONFIG, ...userConfig };
      ['systemPrompts', 'agentContext', 'transcribe', 'llamaServer', 'embeddingModel', 'ml', 'irodoriTts', 'orchestration', 'googleDrive'].forEach(key => {
        if (DEFAULT_CONFIG[key] && typeof DEFAULT_CONFIG[key] === 'object') {
          merged[key] = { ...DEFAULT_CONFIG[key], ...(userConfig[key] || {}) };
        }
      });
      return merged;
    }
  } catch {}
  return { ...DEFAULT_CONFIG };
}
const appConfig = loadConfig();

// ─── Google Drive クライアント ───
// 設定は毎回 appConfig から読む (config.json 編集 → 再起動で反映)。
// log は関数宣言なので巻き上げにより、この時点で参照しても問題ない。
const gdrive = createGoogleDrive({
  getConfig: () => appConfig.googleDrive,
  baseDir: __dirname,
  log: (ip, msg) => log(ip, msg),
});

// ─── llama-server プロセス管理 ───
// 1チャットモデル + 1Embeddingモデルを別プロセスで管理
// チャットモデル切替時はチャットサーバーを再起動

const chatModels = (appConfig.chatModels || []).map((m, i) => ({
  name: m.name || `model-${i}`,
  path: m.path,
  ctx: m.ctx || 4096,
  ngl: typeof m.ngl === 'number' ? m.ngl : 99,
  chatTemplate: m.chatTemplate || '',
  extraArgs: m.extraArgs || [],
}));

let chatProc = null;          // 現在起動中のチャットモデルプロセス
let chatProcModel = null;     // 起動中のモデル名
let chatProcStarting = false; // 起動中フラグ
let chatLastUsed = 0;         // 最終使用時刻（idleUnload用）
let firstChatLoadDone = false; // 起動後の初回チャットモデルロード完了フラグ
let embedProc = null;         // Embeddingプロセス
let embedProcStarting = false; // Embedding起動中フラグ
let embedLastUsed = 0;        // Embedding最終使用時刻（idleUnload用）

// ─── 外部API公開サーバー管理 ───
// 外部公開用の OpenAI 互換 llama-server を独立プロセスで起動・管理する。
// メインのチャット/Embedding用とは別ポート・別プロセス。
// 構造: Map<serverId, { proc, modelName, host, port, apiKey, type, startedAt }>
const externalServers = new Map();
let nextExternalServerId = 1;
const EXTERNAL_SERVERS_STATE_FILE = path.join(__dirname, 'external-servers.json');

function findModelByName(name) {
  return chatModels.find(m => m.name === name);
}

// llama-serverのreadyを待つ（/health か /v1/models をポーリング）
function waitForReady(host, port, timeoutMs, useHttps) {
  return new Promise((resolve) => {
    const start = Date.now();
    const httpsMod = require('https');
    const mod = useHttps ? httpsMod : http;
    const check = () => {
      const req = mod.request({
        hostname: host, port, path: '/health', method: 'GET', timeout: 2000,
        // 自己署名証明書の場合も受け入れる
        rejectUnauthorized: false,
      }, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          // status 200 でステータスがloadingでなければOK
          if (res.statusCode === 200) {
            try {
              const j = JSON.parse(body);
              if (j.status === 'ok' || !j.status) return resolve(true);
            } catch { return resolve(true); }
          }
          if (Date.now() - start > timeoutMs) return resolve(false);
          setTimeout(check, 1000);
        });
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(check, 1000);
      });
      req.on('timeout', () => { req.destroy(); });
      req.end();
    };
    check();
  });
}

// sd-server等、/health エンドポイントを持たないサーバー用
// TCP接続が成功すれば「ポートを開いてる」と判定。さらに2秒待ってモデルロード完了を待つ
function waitForTcpReady(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const net = require('net');
    const check = () => {
      const sock = new net.Socket();
      let done = false;
      const finish = (success) => {
        if (done) return;
        done = true;
        try { sock.destroy(); } catch {}
        if (success) return resolve(true);
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(check, 2000);
      };
      sock.setTimeout(2000);
      sock.once('connect', () => finish(true));
      sock.once('error', () => finish(false));
      sock.once('timeout', () => finish(false));
      sock.connect(port, host);
    };
    check();
  });
}

// onOutput を渡すと、logLevel に関係なく出力を受け取れる（異常終了時の原因調査用）。
// 画面へのエコーは従来どおり logLevel に従う。
function spawnLlamaServer(args, label, onOutput) {
  const ls = appConfig.llamaServer;
  log('-', `[${label}] spawn: ${ls.binPath} ${args.join(' ')}`);
  const isQuiet = appConfig.logLevel === 'quiet';
  // 外部APIサーバー(label='ext:...')は強制的にログを出す（デバッグ用）
  const isExternal = label.startsWith('ext:');
  const echo = !isQuiet || isExternal;
  // onOutput が要求されていればパイプは必ず開く（quietでも中身は捨てない）
  const capture = echo || !!onOutput;
  const proc = spawn(ls.binPath, args, {
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore'],
    env: { ...process.env },
  });
  if (capture) {
    const handle = (d) => {
      if (onOutput) { try { onOutput(d.toString()); } catch {} }
      if (echo) process.stdout.write(`[${label}] ${d}`);
    };
    proc.stdout.on('data', handle);
    proc.stderr.on('data', handle);
  }
  proc.on('exit', (code) => log('-', `[${label}] exited with code ${code}`));
  return proc;
}

// ─── 外部API公開サーバー: 起動・停止・状態管理 ───

function generateApiKey() {
  return 'sk-' + crypto.randomBytes(24).toString('hex');
}

// 外部APIサーバー一覧（メタ情報のみ、プロセスは含まない）
function listExternalServers() {
  const list = [];
  for (const [id, s] of externalServers) {
    list.push({
      id,
      modelName: s.modelName,
      host: s.host,
      port: s.port,
      apiKey: s.apiKey,
      type: s.type,
      https: !!s.https,
      ctx: s.ctx || null,
      nParallel: s.nParallel || null,
      agentMode: !!s.agentMode,      // ツール対応モードか
      tools: s.tools || null,         // 有効なツール
      running: !!(s.agentMode ? s.agentHandle : (s.proc && !s.proc.killed)),
      startedAt: s.startedAt,
    });
  }
  return list.sort((a, b) => a.id - b.id);
}

// 外部APIサーバーの状態をディスクに保存
function saveExternalServersState() {
  try {
    const data = listExternalServers().map(s => ({
      id: s.id, modelName: s.modelName, host: s.host, port: s.port,
      apiKey: s.apiKey, type: s.type,
      agentMode: s.agentMode, tools: s.tools, https: s.https,
    }));
    fs.writeFileSync(EXTERNAL_SERVERS_STATE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    log('-', `[外部API] 状態保存失敗: ${e.message}`);
  }
}

// ─── ツール対応モード(agent_proxy)用の依存オブジェクト ───
// agent_proxy.js に渡す内部関数群。循環参照を避けるため関数で遅延構築
function buildAgentDeps() {
  return {
    chatHost: appConfig.llamaServer.chatHost,
    chatPort: appConfig.llamaServer.chatPort,
    log,
    appConfig,
    // モデルロード保証 (アイドルアンロード後の再ロード対応)
    ensureChatModelLoaded,
    // web検索
    ddgSearch,
    fetchPageText,
    // ML
    getMlDb: () => {
      // agent_proxy は db.allAsync(sql, ...params) を呼ぶので、互換ラッパーを返す
      return {
        allAsync: (sql, ...params) => mlQuery(sql, params),
      };
    },
    loadMlModels,
    isValidTableName,
    isSafeReadOnlySql,
    ML_MODELS_DIR,
    runMlPredict,
    // 強化学習 (RL)
    RL_MODELS_DIR,
    loadRlAgents,
    runRlPolicy,
    runRlEval,
    startRlTraining,
    // オンラインRL (常駐ワーカー経由)
    rlOnlineAct: async (name, state, epsilon) => {
      await ensureRlOnlineWorker();
      return rlWorkerRequest('/act', { name, state, epsilon });
    },
    rlOnlineLearn: async (name, exp) => {
      await ensureRlOnlineWorker();
      return rlWorkerRequest('/learn', { name, ...exp });
    },
    // ファイル操作
    UPLOADS_DIR,
    listUploadFiles: async () => {
      const walk = (dir, base = '') => {
        const items = [];
        for (const name of fs.readdirSync(dir)) {
          // 隠しファイル・隠しディレクトリ (.で始まる) は除外
          if (name.startsWith('.')) continue;
          const full = path.join(dir, name);
          const rel = base ? `${base}/${name}` : name;
          try {
            const stat = fs.statSync(full);
            if (stat.isDirectory()) items.push(...walk(full, rel));
            else if (stat.isFile()) items.push({ path: rel, size: stat.size });
          } catch {}
        }
        return items;
      };
      return { files: walk(UPLOADS_DIR) };
    },
    readUploadFile: async (relPath) => {
      // 隠しファイル (パス中のどこかが . で始まる) は読み取り拒否
      if (String(relPath).split('/').some(seg => seg.startsWith('.'))) {
        throw new Error('隠しファイルにはアクセスできません');
      }
      const abs = safeUploadPath(relPath);
      if (!abs) throw new Error('無効なパス');
      if (!fs.existsSync(abs)) throw new Error('ファイルが見つかりません');
      const stat = fs.statSync(abs);
      if (!stat.isFile()) throw new Error('ファイルではありません');
      if (stat.size > MAX_FILE_SIZE) throw new Error('ファイルが大きすぎます');
      return { path: relPath, content: fs.readFileSync(abs, 'utf-8') };
    },
    // RAG (embedding ベクトル検索): uploads から登録された永続ドキュメントを検索
    searchDocumentsSimple: async (query) => {
      return await ragSearch(query, 5);
    },
    // ─── Google Drive ───
    // agent_proxy は gdrive.* をそのまま呼ぶ。取り込み/書き出しだけは
    // uploads の安全なパス解決が要るのでここでラップする。
    gdrive,
    gdriveImportToServer: async (fileId, savePath, preferOffice) => {
      const dl = await gdrive.downloadFile(fileId, { preferOffice: !!preferOffice });
      const rel = savePath || dl.name;
      const abs = safeUploadPath(rel);
      if (!abs) throw new Error('保存先パスが不正です');
      if (dl.buffer.length > MAX_FILE_SIZE) throw new Error(`ファイルが大きすぎます (${dl.buffer.length} bytes)`);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, dl.buffer);
      return { ok: true, path: rel, size: dl.buffer.length, mimeType: dl.mimeType, exported: dl.exported };
    },
    gdriveUploadFromServer: async (relPath, { name, folderId, overwrite, convertToGoogleDoc } = {}) => {
      const abs = safeUploadPath(relPath);
      if (!abs) throw new Error('パスが不正です');
      if (!fs.existsSync(abs)) throw new Error(`ファイルが見つかりません: ${relPath}`);
      const stat = fs.statSync(abs);
      if (!stat.isFile()) throw new Error('ファイルではありません');
      const fileName = name || path.basename(relPath);
      return await gdrive.uploadFile({
        name: fileName,
        buffer: fs.readFileSync(abs),
        mimeType: gdrive.guessMimeFromName(fileName),
        folderId,
        overwrite: overwrite !== false,
        convertToGoogleDoc: !!convertToGoogleDoc,
      });
    },
  };
}

// 外部APIサーバーを起動
async function startExternalServer({ modelName, host, port, apiKey, type, https, agentMode, tools }) {
  // 同じポートが既に使われていないかチェック
  for (const [, s] of externalServers) {
    if (s.port === port && ((s.proc && !s.proc.killed) || s.agentHandle)) {
      throw new Error(`ポート ${port} は既に外部APIサーバーで使用中です`);
    }
  }
  // メインのポートと衝突しないか
  const ls = appConfig.llamaServer;
  if (port === ls.chatPort || port === ls.embeddingPort) {
    throw new Error(`ポート ${port} は内部llama-serverで使用中です`);
  }
  if (https && !HTTPS_ENABLED) {
    throw new Error('HTTPSで起動するには cert.pem と key.pem が必要です（OpenGeekLLMChat本体と同じものを使用）');
  }

  // ─── ツール対応モード: agent_proxy を起動 (llama-server は内部の既存ものを使う) ───
  if (agentMode) {
    if (type === 'embedding') throw new Error('ツール対応モードは chat タイプのみ対応');
    const model = findModelByName(modelName);
    if (!model) throw new Error(`モデルが見つかりません: ${modelName}`);

    // 内部 llama-server に指定モデルがロードされているか確認
    // 別モデルが起動中、または未起動なら、このモデルに切り替えてロード
    if (chatProcModel !== modelName) {
      if (chatProcStarting) {
        throw new Error('別のモデルが起動中です。完了を待ってから再試行してください');
      }
      log('-', `[外部API] ツール対応モード用に内部モデルを ${chatProcModel || '(未ロード)'} → ${modelName} に切替`);
      await startChatModel(modelName);  // 完了まで待つ (waitForReady 内蔵)
    }

    const id = nextExternalServerId++;
    let enabledTools = Array.isArray(tools) && tools.length > 0 ? [...tools] : ['ml', 'web_search', 'file'];

    // RAGツールが指定されている場合、embedding が利用可能かチェック
    if (enabledTools.includes('rag')) {
      const emb = isEmbeddingAvailable();
      if (!emb.available) {
        log('-', `[外部API] RAGツール無効化: ${emb.reason}`);
        enabledTools = enabledTools.filter(t => t !== 'rag');
      }
      // RAG ツールは embedding サーバーも事前ロードしておく
      ensureEmbeddingLoaded().catch(e => log('-', `[外部API] embedding起動失敗: ${e.message}`));
    }

    // Google Drive ツールは「有効かつ接続済み」でなければ外す
    // (未接続のままツールを出すと、LLM が毎回エラーを踏んで無駄なターンを消費する)
    if (enabledTools.includes('gdrive')) {
      const st = gdrive.status();
      if (!st.enabled || !st.connected) {
        log('-', `[外部API] Google Driveツール無効化: ${st.reason || '未接続'}`);
        enabledTools = enabledTools.filter(t => t !== 'gdrive');
      }
    }

    const handle = await startAgentServer({
      port, host, apiKey, modelName,
      useHttps: !!https, certPath: CERT_PATH, keyPath: KEY_PATH,
      tools: enabledTools,
    }, buildAgentDeps());
    const serverInfo = {
      agentHandle: handle, proc: null, agentMode: true, tools: enabledTools,
      modelName, host, port, apiKey, type: 'chat', https: !!https,
      ctx: null, nParallel: null, startedAt: Date.now(),
    };
    externalServers.set(id, serverInfo);
    log('-', `[外部API ${id}] ツール対応モード起動: ${modelName} @ ${host}:${port} (tools: ${enabledTools.join(',')})`);
    saveExternalServersState();
    return id;
  }

  // llama-serverのHTTPSオプション
  const sslArgs = https && HTTPS_ENABLED
    ? ['--ssl-cert-file', CERT_PATH, '--ssl-key-file', KEY_PATH]
    : [];

  let args;
  if (type === 'embedding') {
    const em = appConfig.embeddingModel;
    if (!em || !em.path) throw new Error('Embeddingモデルが設定されていません');
    if (!fs.existsSync(em.path)) throw new Error(`Embeddingモデルファイルが存在しません: ${em.path}`);
    args = [
      '-m', em.path,
      '-c', String(em.ctx),
      '-ngl', String(em.ngl),
      '--port', String(port),
      '--host', host,
      '--embedding',
      ...(em.poolingType ? ['--pooling', em.poolingType] : []),
      ...(apiKey ? ['--api-key', apiKey] : []),
      ...sslArgs,
      ...(em.extraArgs || []),
    ];
  } else {
    const model = findModelByName(modelName);
    if (!model) throw new Error(`モデルが見つかりません: ${modelName}`);
    if (!fs.existsSync(model.path)) throw new Error(`モデルファイルが存在しません: ${model.path}`);
    const filterPairArgs = (arr, exclude) => {
      const out = [];
      for (let i = 0; i < arr.length; i++) {
        if (exclude.includes(arr[i])) { i++; continue; }
        out.push(arr[i]);
      }
      return out;
    };
    var ctxSize = model.ctx;
    var npSize = model.nParallel ?? appConfig.llamaServer.nParallel ?? 1;
    args = [
      '-m', model.path,
      '-c', String(ctxSize),
      '-ngl', String(model.ngl),
      '-np', String(npSize),
      '--port', String(port),
      '--host', host,
      ...filterPairArgs(ls.commonArgs || [], ['--port', '--host']),
      ...(model.chatTemplate ? ['--chat-template', model.chatTemplate] : []),
      ...(apiKey ? ['--api-key', apiKey] : []),
      ...sslArgs,
      ...(model.extraArgs || []),
    ];
  }

  const id = nextExternalServerId++;
  const label = `ext:${id}:${modelName}`;
  const proc = spawnLlamaServer(args, label);

  const serverInfo = {
    proc, modelName, host, port, apiKey, type, https: !!https,
    ctx: typeof ctxSize !== 'undefined' ? ctxSize : null,
    nParallel: typeof npSize !== 'undefined' ? npSize : null,
    startedAt: Date.now(),
  };
  externalServers.set(id, serverInfo);

  proc.on('exit', (code) => {
    log('-', `[外部API ${id}] 終了 (code=${code})`);
    serverInfo.proc = null;
  });

  // 起動完了を待つ（host=0.0.0.0の場合は127.0.0.1で確認）
  const checkHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  const ready = await waitForReady(checkHost, port, ls.readyTimeoutMs, https);
  if (!ready) {
    try { proc.kill('SIGTERM'); } catch {}
    externalServers.delete(id);
    throw new Error(`外部APIサーバー起動タイムアウト: ${modelName} on ${host}:${port}`);
  }

  log('-', `[外部API ${id}] 起動完了: ${modelName} @ ${host}:${port}`);
  saveExternalServersState();
  return id;
}

// 外部APIサーバーを停止
// プロセスのみ停止（設定は保持。後で再起動できる）
function stopExternalServerProcess(id) {
  const s = externalServers.get(id);
  if (!s) return false;
  if (s.agentMode && s.agentHandle) {
    try { s.agentHandle.close(); } catch {}
    s.agentHandle = null;
  }
  if (s.proc && !s.proc.killed) {
    try { s.proc.kill('SIGTERM'); } catch {}
    setTimeout(() => {
      if (s.proc && !s.proc.killed) {
        try { s.proc.kill('SIGKILL'); } catch {}
      }
    }, 5000);
  }
  s.proc = null;  // 設定は残す
  log('-', `[外部API ${id}] プロセス停止: ${s.modelName}`);
  return true;
}

// 停止中サーバーを再起動（既存設定でプロセスだけ起動し直す）
async function restartExternalServer(id) {
  const s = externalServers.get(id);
  if (!s) throw new Error('Not found');
  if ((s.proc && !s.proc.killed) || s.agentHandle) throw new Error('既に稼働中です');

  externalServers.delete(id);
  const newId = await startExternalServer({
    modelName: s.modelName,
    host: s.host,
    port: s.port,
    apiKey: s.apiKey,
    type: s.type,
    https: s.https,
    agentMode: s.agentMode,
    tools: s.tools,
  });
  return newId;
}

function stopExternalServer(id) {
  const s = externalServers.get(id);
  if (!s) return false;
  if (s.agentMode && s.agentHandle) {
    try { s.agentHandle.close(); } catch {}
    s.agentHandle = null;
  }
  if (s.proc && !s.proc.killed) {
    try { s.proc.kill('SIGTERM'); } catch {}
    setTimeout(() => {
      if (s.proc && !s.proc.killed) {
        try { s.proc.kill('SIGKILL'); } catch {}
      }
    }, 5000);
  }
  externalServers.delete(id);
  saveExternalServersState();
  log('-', `[外部API ${id}] 停止: ${s.modelName}`);
  return true;
}

// 全外部APIサーバーを停止（プロセス終了時のクリーンアップ用）
function stopAllExternalServers() {
  for (const [id] of externalServers) {
    stopExternalServer(id);
  }
}

// ════════════════════════════════════════════════
// マルチLLMオーケストレーション (llm_pool + orchestrator)
// ════════════════════════════════════════════════
// メインチャット (chatProc) は1モデルしか持てないため、複数モデルの協調実行用に
// 独立したワーカープールを用意する。ワーカーは llamaServer とは別ポート
// (orchestration.portRange) で起動し、使い終わるとアイドルアンロードされる。

const llmPool = createLlmPool({
  getConfig: () => appConfig,
  findModelByName,
  spawnLlamaServer,
  waitForReady,
  log,
  getGpuInfo: () => cachedGpuData,
  // 外部APIサーバーが使用中のポートは避ける
  isPortTaken: (port) => {
    for (const [, s] of externalServers) {
      if (s.port === port && ((s.proc && !s.proc.killed) || s.agentHandle)) return true;
    }
    return false;
  },
  mainChat: {
    getModel: () => chatProcModel,
    isStarting: () => chatProcStarting || !chatProc,
    getEndpoint: () => ({ host: appConfig.llamaServer.chatHost, port: appConfig.llamaServer.chatPort }),
    touch: () => { chatLastUsed = Date.now(); },
    // 一時アンロード。chatProcAutoUnloaded に控えておくことで、
    // 次のチャットリクエスト時に既存の自動再ロード機構が同じモデルを戻してくれる
    unload: async () => {
      if (!chatProc) return;
      chatProcAutoUnloaded = chatProcModel;
      await stopChatModel();
      chatLastUsed = 0;
    },
  },
});

const orchestrator = createOrchestrator({
  pool: llmPool,
  getConfig: () => appConfig,
  findModelByName,
  log,
});

// ワークフロー定義は config.json の orchestration.workflows に永続化する
function listWorkflows() {
  const o = appConfig.orchestration || {};
  return Array.isArray(o.workflows) ? o.workflows : [];
}

function saveWorkflows(workflows) {
  patchConfigFile(cfg => {
    if (!cfg.orchestration || typeof cfg.orchestration !== 'object') cfg.orchestration = {};
    cfg.orchestration.workflows = workflows;
  });
  // 再起動なしで即反映（ワークフローは実行時に参照されるだけなので安全）
  if (!appConfig.orchestration) appConfig.orchestration = {};
  appConfig.orchestration.workflows = workflows;
}

function generateWorkflowId() {
  return 'wf_' + crypto.randomBytes(6).toString('hex');
}

// ════════════════════════════════════════════════
// 画像生成 (stable-diffusion.cpp の sd-server を管理)
// ════════════════════════════════════════════════
// アーキテクチャ:
//   - sd-server (stable-diffusion.cpp の HTTPサーバー) を子プロセスで起動
//   - LLMが generate_image ツールを呼ぶ → /image-gen エンドポイント → sd-serverに転送
//   - 生成画像は public/uploads/ に PNG で保存し、Markdownでチャット欄に表示
//   - アイドルアンロード機能あり（チャットモデルと同じパターン）

let sdProc = null;            // 現在のsd-serverプロセス
let sdCurrentModel = null;    // 現在ロード中の画像生成モデル名
let sdProcStarting = false;
let sdLastActivity = Date.now();

function findImageModelByName(name) {
  if (!appConfig.imageModels || !Array.isArray(appConfig.imageModels)) return null;
  return appConfig.imageModels.find(m => m.name === name);
}

async function startImageModel(modelName) {
  if (sdProcStarting) throw new Error('既に画像生成モデル起動処理中です');
  const model = findImageModelByName(modelName);
  if (!model) throw new Error(`画像生成モデルが見つかりません: ${modelName}`);
  if (!fs.existsSync(model.path)) throw new Error(`モデルファイルが存在しません: ${model.path}`);

  sdProcStarting = true;
  // 重要: 起動開始時に sdLastActivity をリセット
  // これを忘れると、前回終了時から大きく時間が経過した場合に
  // 起動中のアイドルチェックで「アイドル時間が長い」と判定されて即終了してしまう
  sdLastActivity = Date.now();
  try {
    await stopImageModel();
    const sdConfig = appConfig.stableDiffusion || {};
    const binPath = sdConfig.binPath || 'sd-server';
    const port = sdConfig.port || 7860;

    const args = [
      '--model', model.path,
      '--listen-port', String(port),
      '--listen-ip', '127.0.0.1',
      ...(model.vae ? ['--vae', model.vae] : []),
      ...(model.taesd ? ['--taesd', model.taesd] : []),
      ...(model.controlNet ? ['--control-net', model.controlNet] : []),
      ...(model.extraArgs || []),
    ];

    log('-', `[sd-server] 起動: ${binPath} ${args.join(' ')}`);
    const proc = spawn(binPath, args, {
      cwd: __dirname,
      env: { ...process.env, ...(sdConfig.env || {}) },
    });
    sdProc = proc;

    proc.stdout.on('data', (d) => {
      // sd-serverは進捗ログが重要なので常に出力（logLevel=quietでも）
      process.stdout.write(`[sd-server] ${d}`);
    });
    proc.stderr.on('data', (d) => {
      process.stderr.write(`[sd-server] ${d}`);
    });
    // クロージャでこのプロセスを保持。新プロセスに切り替わった後で
    // 古いプロセスの exit イベントが来ても sdProc を誤って null にしないよう、
    // 現在の sdProc と一致する場合のみクリアする
    proc.on('exit', (code) => {
      log('-', `[sd-server] 終了 (code=${code}, pid=${proc.pid})`);
      if (sdProc === proc) {
        sdProc = null;
        sdCurrentModel = null;
      }
    });
    proc.on('error', (err) => {
      log('-', `[sd-server] プロセスエラー: ${err.message}`);
      if (sdProc === proc) {
        sdProc = null;
        sdCurrentModel = null;
      }
    });

    // 起動完了を待つ
    // sd-server には /health エンドポイントがないため、TCP接続だけで判定
    const ready = await waitForTcpReady('127.0.0.1', port, sdConfig.readyTimeoutMs || 300000);
    if (!ready) throw new Error(`sd-server が ${sdConfig.readyTimeoutMs || 300000}ms 以内に起動しませんでした`);

    sdCurrentModel = modelName;
    sdLastActivity = Date.now();
    log('-', `[sd-server] Ready (model=${modelName}, port=${port}, pid=${proc.pid})`);
  } finally {
    sdProcStarting = false;
  }
}

async function stopImageModel() {
  if (!sdProc || sdProc.killed) {
    sdCurrentModel = null;
    return;
  }
  try { sdProc.kill('SIGTERM'); } catch {}
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      if (sdProc && !sdProc.killed) {
        try { sdProc.kill('SIGKILL'); } catch {}
      }
      resolve();
    }, 5000);
    sdProc.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  sdProc = null;
  sdCurrentModel = null;
}

// アイドルアンロード（チャットモデルと同じパターン）
function checkSdIdle() {
  const idleMs = appConfig.stableDiffusion?.idleUnloadMs;
  if (!idleMs || !sdProc || sdProcStarting) return;
  const elapsed = Date.now() - sdLastActivity;
  if (elapsed >= idleMs) {
    log('-', `[sd-server] アイドル ${Math.round(elapsed / 1000)}s → アンロード`);
    stopImageModel();
  }
}
setInterval(checkSdIdle, 30000);

// ════════════════════════════════════════════════
// 音声合成 (Irodori-TTS の OpenAI互換サーバーを管理)
// ════════════════════════════════════════════════
// アーキテクチャ (画像生成 sd-server と同じ方式):
//   - Irodori-TTS-Server (OpenAI互換 /v1/audio/speech) を子プロセスで起動
//   - LLMが generate_speech ツールを呼ぶ → /tts エンドポイント → TTSサーバーに転送
//   - 生成音声は public/uploads/ に WAV で保存し、チャット欄で再生
//   - アイドルアンロード機能あり（チャットモデル・sd-serverと同じパターン）
//   - command/args 未設定なら「外部起動済み」とみなし転送のみ行う

let ttsProc = null;            // 現在のTTSサーバープロセス
let ttsProcStarting = false;
let ttsLastActivity = Date.now();

// Irodori-TTSサーバーを spawn して起動（オンデマンド）
async function startTtsServer() {
  if (ttsProcStarting) throw new Error('既にTTSサーバー起動処理中です');
  const cfg = appConfig.irodoriTts || {};
  // command 未設定なら自動起動しない（外部起動済みとみなす）
  if (!cfg.command) {
    throw new Error('irodoriTts.command が未設定です。外部でTTSサーバーを起動するか、command/args を設定してください。');
  }

  ttsProcStarting = true;
  // 起動開始時に ttsLastActivity をリセット（sd-serverと同じく即アイドル判定を防ぐ）
  ttsLastActivity = Date.now();
  try {
    await stopTtsServer();
    const host = cfg.host || '127.0.0.1';
    const port = cfg.port || 8088;
    const args = Array.isArray(cfg.args) ? cfg.args : [];

    log('-', `[irodori-tts] 起動: ${cfg.command} ${args.join(' ')}`);
    const proc = spawn(cfg.command, args, {
      cwd: cfg.cwd || __dirname,
      env: { ...process.env, ...(cfg.env || {}) },
    });
    ttsProc = proc;

    proc.stdout.on('data', (d) => process.stdout.write(`[irodori-tts] ${d}`));
    proc.stderr.on('data', (d) => process.stderr.write(`[irodori-tts] ${d}`));
    // 新プロセスに切り替わった後で古いプロセスの exit が来ても誤って null にしない
    proc.on('exit', (code) => {
      log('-', `[irodori-tts] 終了 (code=${code}, pid=${proc.pid})`);
      if (ttsProc === proc) ttsProc = null;
    });
    proc.on('error', (err) => {
      log('-', `[irodori-tts] プロセスエラー: ${err.message}`);
      if (ttsProc === proc) ttsProc = null;
    });

    // 起動完了を待つ（TCP接続で判定）
    const ready = await waitForTcpReady(host, port, cfg.readyTimeoutMs || 300000);
    if (!ready) throw new Error(`irodori-tts が ${cfg.readyTimeoutMs || 300000}ms 以内に起動しませんでした`);

    ttsLastActivity = Date.now();
    log('-', `[irodori-tts] Ready (host=${host}, port=${port}, pid=${proc.pid})`);
  } finally {
    ttsProcStarting = false;
  }
}

async function stopTtsServer() {
  if (!ttsProc || ttsProc.killed) {
    ttsProc = null;
    return;
  }
  try { ttsProc.kill('SIGTERM'); } catch {}
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      if (ttsProc && !ttsProc.killed) {
        try { ttsProc.kill('SIGKILL'); } catch {}
      }
      resolve();
    }, 5000);
    ttsProc.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  ttsProc = null;
}

// アイドルアンロード（sd-serverと同じパターン）
function checkTtsIdle() {
  const idleMs = appConfig.irodoriTts?.idleUnloadMs;
  if (!idleMs || !ttsProc || ttsProcStarting) return;
  const elapsed = Date.now() - ttsLastActivity;
  if (elapsed >= idleMs) {
    log('-', `[irodori-tts] アイドル ${Math.round(elapsed / 1000)}s → アンロード`);
    stopTtsServer();
  }
}
setInterval(checkTtsIdle, 30000);

async function startChatModel(modelName) {
  if (chatProcStarting) throw new Error('既にモデル起動処理中です');
  const model = findModelByName(modelName);
  if (!model) throw new Error(`モデルが見つかりません: ${modelName}`);
  if (!fs.existsSync(model.path)) throw new Error(`モデルファイルが存在しません: ${model.path}`);

  chatProcStarting = true;
  try {
    await stopChatModel();
    const ls = appConfig.llamaServer;
    // commonArgsから --port と --host （値とペア）を除外
    const filterPairArgs = (args, exclude) => {
      const out = [];
      for (let i = 0; i < args.length; i++) {
        if (exclude.includes(args[i])) {
          i++; // 値もスキップ
          continue;
        }
        out.push(args[i]);
      }
      return out;
    };

    const args = [
      '-m', model.path,
      '-c', String(model.ctx),
      '-ngl', String(model.ngl),
      '-np', String(model.nParallel ?? appConfig.llamaServer.nParallel ?? 1),
      '--port', String(ls.chatPort),
      '--host', ls.chatHost,
      ...filterPairArgs(ls.commonArgs || [], ['--port', '--host']),
      ...(model.chatTemplate ? ['--chat-template', model.chatTemplate] : []),
      ...(model.extraArgs || []),
    ];
    // オーケストレーションはメインチャットのモデルを間借りすることがある。
    // その最中にこのプロセスが落ちると、プール側には何の記録も残らず
    // 呼び出し側には生の "socket hang up" しか見えないため、出力を保持して
    // 異常終了をプールに通知できるようにしておく。
    const logTail = [];
    const startedModel = model.name;
    chatProc = spawnLlamaServer(args, `chat:${model.name}`, (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue;
        logTail.push(line);
        if (logTail.length > 40) logTail.shift();
      }
    });
    chatProcModel = model.name;
    const startedProc = chatProc;
    chatProc.on('exit', (code, signal) => {
      // stopChatModel() 由来なら chatProc は既に差し替わっているので通知しない
      if (chatProc !== startedProc) return;
      chatProc = null;
      try {
        llmPool.recordExternalCrash(startedModel, {
          code, signal,
          tail: logTail.slice(-12).join('\n'),
          gpu: (cachedGpuData || []).map(g => ({
            id: g.id || '', totalMB: g.vramTotalMB || 0, usedMB: g.vramUsedMB || 0,
          })),
        });
      } catch {}
    });

    const ready = await waitForReady(ls.chatHost, ls.chatPort, ls.readyTimeoutMs);
    if (!ready) {
      await stopChatModel();
      throw new Error(`チャットモデル起動タイムアウト: ${model.name}`);
    }
    chatLastUsed = Date.now();
    firstChatLoadDone = true;
    log('-', `チャットモデル起動完了: ${model.name}`);
  } finally {
    chatProcStarting = false;
  }
}

function stopChatModel() {
  return new Promise((resolve) => {
    if (!chatProc) return resolve();
    const p = chatProc;
    chatProc = null;
    chatProcModel = null;
    p.once('exit', () => resolve());
    try { p.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resolve(); }, 5000);
  });
}

// ─── アイドル時の自動アンロード ───
// idleUnloadMs > 0 のとき、最終使用時刻から指定msアイドルでチャットモデルをアンロード
let chatProcAutoUnloaded = null;  // 自動アンロード時のモデル名（再ロードに使用）

setInterval(async () => {
  const ls = appConfig.llamaServer;
  if (!ls.idleUnloadMs || ls.idleUnloadMs <= 0) return;
  // チャットモデルのアイドルチェック
  if (chatProc && !chatProcStarting && chatLastUsed) {
    const idleMs = Date.now() - chatLastUsed;
    if (idleMs >= ls.idleUnloadMs) {
      log('-', `アイドル ${Math.floor(idleMs/1000)}秒経過、モデル「${chatProcModel}」を自動アンロード`);
      chatProcAutoUnloaded = chatProcModel;
      await stopChatModel();
      chatLastUsed = 0;
    }
  }
  // Embeddingモデルのアイドルチェック（同じidleUnloadMsを使用）
  if (embedProc && !embedProcStarting && embedLastUsed) {
    const idleMs = Date.now() - embedLastUsed;
    if (idleMs >= ls.idleUnloadMs) {
      log('-', `アイドル ${Math.floor(idleMs/1000)}秒経過、Embeddingモデルを自動アンロード`);
      await stopEmbeddingModel();
      embedLastUsed = 0;
    }
  }
}, 30000);  // 30秒ごとにチェック

// 自動アンロード後のリクエスト時に再ロード
async function ensureChatModelLoaded() {
  if (chatProc) return true;  // 既にロード済み
  if (chatProcStarting) return false;  // 起動中（プロキシ側で待機）
  // 自動アンロードされたモデルがあればそれを優先、なければデフォルトを使う（初回ロード対応）
  const modelToReload = chatProcAutoUnloaded || appConfig.defaultModel;
  if (!modelToReload) return false;
  chatProcAutoUnloaded = null;
  log('-', `自動ロード: モデル「${modelToReload}」を起動`);
  startChatModel(modelToReload).catch(e => log('-', `自動ロードエラー: ${e.message}`));
  return false;  // 起動中なのでこのリクエストは待機（プロキシ側で待つ）
}

// Embedding未起動時に再ロード（Promise返却、完了を待てる）
async function ensureEmbeddingLoaded() {
  if (embedProc) {
    embedLastUsed = Date.now();
    return true;
  }
  if (embedProcStarting) {
    // 起動中: 完了を待つ
    const startWait = Date.now();
    while (embedProcStarting && Date.now() - startWait < 60000) {
      await new Promise(r => setTimeout(r, 500));
    }
    if (embedProc) {
      embedLastUsed = Date.now();
      return true;
    }
    return false;
  }
  // 未起動: 起動して待つ
  log('-', 'Embeddingアイドル復帰: 再起動');
  await startEmbeddingModel();
  if (embedProc) {
    embedLastUsed = Date.now();
    return true;
  }
  return false;
}

async function startEmbeddingModel() {
  const em = appConfig.embeddingModel;
  if (!em || !em.path) {
    log('-', 'Embeddingモデル未設定（RAGは無効化されます）');
    return;
  }
  if (!fs.existsSync(em.path)) {
    log('-', `Embeddingモデルファイルが存在しません: ${em.path}`);
    return;
  }
  if (embedProc || embedProcStarting) return;
  embedProcStarting = true;
  try {
    const ls = appConfig.llamaServer;
    const args = [
      '-m', em.path,
      '-c', String(em.ctx || 512),
      '-ngl', String(typeof em.ngl === 'number' ? em.ngl : 99),
      '--port', String(ls.embeddingPort),
      '--host', ls.embeddingHost,
      '--embedding',
      ...(em.poolingType ? ['--pooling', em.poolingType] : []),
      ...(em.extraArgs || []),
    ];
    embedProc = spawnLlamaServer(args, `embed`);
    const ready = await waitForReady(ls.embeddingHost, ls.embeddingPort, ls.readyTimeoutMs);
    if (!ready) {
      log('-', 'Embeddingサーバー起動タイムアウト（RAGが動作しない可能性があります）');
      try { embedProc.kill('SIGTERM'); } catch {}
      embedProc = null;
    } else {
      log('-', 'Embeddingサーバー起動完了');
      embedLastUsed = Date.now();
    }
  } finally {
    embedProcStarting = false;
  }
}

function stopEmbeddingModel() {
  return new Promise((resolve) => {
    if (!embedProc) return resolve();
    const p = embedProc;
    embedProc = null;
    p.once('exit', () => resolve());
    try { p.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resolve(); }, 5000);
  });
}

// プロセス終了時のクリーンアップ
function cleanup() {
  if (chatProc) try { chatProc.kill('SIGTERM'); } catch {}
  if (embedProc) try { embedProc.kill('SIGTERM'); } catch {}
  // オーケストレーション用ワーカー
  try { llmPool.killAll(); } catch {}
  // オンラインRLワーカー (SIGTERM で dirty なエージェントを自動 checkpoint)
  if (rlOnlineWorker && rlOnlineWorker.proc) try { rlOnlineWorker.proc.kill('SIGTERM'); } catch {}
  // 外部APIサーバーも全停止
  for (const [, s] of externalServers) {
    if (s.proc && !s.proc.killed) {
      try { s.proc.kill('SIGTERM'); } catch {}
    }
  }
}
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);

// ─── ログ ───
function timestamp() {
  return new Date().toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim()
    || req.socket?.remoteAddress?.replace('::ffff:', '')
    || '-';
}

function log(ip, message) {
  console.log(`${timestamp()}  ${ip}  ${message}`);
}

const app = express();
app.set('trust proxy', 'loopback'); // リバースプロキシからのX-Forwarded-*ヘッダーを信頼

// ─── 共通JSONパーサー（必要なエンドポイントのみで個別適用） ───
// /v1/* (LLMプロキシ) 等では使わない。bodyを再ストリームする必要があるため。
// 画像付きメッセージ、長いドキュメント、コードブロック等のため上限を大きめに設定
// config.jsonの maxRequestSize で変更可能（デフォルト 50mb）
const MAX_REQUEST_SIZE = appConfig.maxRequestSize || '50mb';
const jsonParser = express.json({ limit: MAX_REQUEST_SIZE });
log('-', `[起動] JSONリクエスト上限: ${MAX_REQUEST_SIZE}`);

// ─── HTTP/HTTPS サーバー初期化 ───
// cert.pem と key.pem がカレントディレクトリにあればHTTPS、なければHTTP
// 秘密鍵にパスフレーズが設定されている場合は SSL_PASSPHRASE 環境変数 or config.jsonのsslPassphraseに指定
const CERT_PATH = path.join(__dirname, 'cert.pem');
const KEY_PATH = path.join(__dirname, 'key.pem');
const HTTPS_ENABLED = fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH);
// ─── HTTPサーバーオプション ───
// maxHeaderSize: HTTPヘッダー上限（デフォルト16KB → 64KB に拡大）
//   tools配列が大きい場合のRST切断対策。Authorization, tools, system prompt が大きいケース。
// requestTimeout: リクエストタイムアウト（デフォルト5分 → 10分）
//   長いLLM応答に対応
// headersTimeout: ヘッダー受信タイムアウト（デフォルト1分 → 2分）
// keepAliveTimeout: Keep-Alive（デフォルト5秒 → 60秒）
//   接続再利用を効率化
const SERVER_OPTS = {
  maxHeaderSize: appConfig.maxHeaderSize || 64 * 1024,  // 64KB
};

let server;
if (HTTPS_ENABLED) {
  const https = require('https');
  const sslOptions = {
    cert: fs.readFileSync(CERT_PATH),
    key: fs.readFileSync(KEY_PATH),
    ...SERVER_OPTS,
  };
  const passphrase = process.env.SSL_PASSPHRASE || appConfig.sslPassphrase;
  if (passphrase) sslOptions.passphrase = passphrase;
  server = https.createServer(sslOptions, app);
} else {
  server = http.createServer(SERVER_OPTS, app);
}

// サーバーインスタンスのタイムアウト設定
server.requestTimeout = (appConfig.requestTimeoutSec || 600) * 1000;     // 10分
server.headersTimeout = (appConfig.headersTimeoutSec || 120) * 1000;     // 2分
server.keepAliveTimeout = (appConfig.keepAliveTimeoutSec || 60) * 1000;  // 60秒
server.timeout = 0;  // ソケットタイムアウト無効化（長いLLM応答に対応）
log('-', `[起動] HTTPサーバー設定: maxHeaderSize=${SERVER_OPTS.maxHeaderSize}, requestTimeout=${server.requestTimeout}ms, headersTimeout=${server.headersTimeout}ms`);

// ─── WebSocket: 対話的Python実行 ───
const wss = new WebSocketServer({ server, path: '/ws/python' });

wss.on('connection', (ws, req) => {
  const ip = getIP(req);
  // 認証チェック（パスワード設定時）
  if (appConfig.password) {
    const cookieToken = (req.headers.cookie || '').split(';')
      .map(c => c.trim())
      .find(c => c.startsWith('wz_session='))?.split('=')[1];
    if (!isValidSession(cookieToken)) {
      log(ip, 'WS AUTH failed');
      ws.close(1008, 'Unauthorized');
      return;
    }
  }
  let proc = null;
  let tmpFile = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'run' && msg.code) {
      tmpFile = path.join(os.tmpdir(), `opengeek_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`);
      // 作業ディレクトリ: public/uploads/（LLMのread_file/write_fileと統一）
      const pyCwd = path.join(__dirname, 'public', 'uploads');
      if (!fs.existsSync(pyCwd)) fs.mkdirSync(pyCwd, { recursive: true });
      // matplotlibで生成した画像は public/plots/ に保存（uploadsとは分離）
      const plotsDir = path.join(__dirname, 'public', 'plots');
      if (!fs.existsSync(plotsDir)) fs.mkdirSync(plotsDir, { recursive: true });

      // matplotlib自動対応のプレアンブル: show()と savefig() の両方をフック
      const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      // Windowsパス対応のため絶対パスをJSON形式でエスケープ
      const plotsDirEscaped = JSON.stringify(plotsDir);
      const preamble = `
import os as _os, sys as _sys
import warnings as _warnings
_warnings.filterwarnings('ignore', category=UserWarning, module='matplotlib')
_IMG_COUNTER = [0]
_RUN_ID = "${runId}"
_PLOTS_DIR = ${plotsDirEscaped}
try:
    import matplotlib
    matplotlib.use('Agg')
    # 日本語フォント自動選択（環境にインストールされているもの優先）
    from matplotlib import font_manager as _fm
    _JP_CANDIDATES = [
        'IPAexGothic', 'IPAGothic',
        'Noto Sans CJK JP', 'Noto Sans JP',
        'Hiragino Sans', 'Hiragino Kaku Gothic Pro',
        'Yu Gothic', 'Meiryo', 'MS Gothic',
        'TakaoPGothic', 'VL PGothic', 'DejaVu Sans',
    ]
    _available = set(f.name for f in _fm.fontManager.ttflist)
    _jp_font = next((f for f in _JP_CANDIDATES if f in _available), 'DejaVu Sans')
    matplotlib.rcParams['font.family'] = _jp_font
    matplotlib.rcParams['axes.unicode_minus'] = False  # マイナス記号豆腐化防止
    import matplotlib.pyplot as _plt
    _orig_show = _plt.show
    _orig_savefig = _plt.savefig
    def _auto_show(*a, **kw):
        _IMG_COUNTER[0] += 1
        fname = f"plot_{_RUN_ID}_{_IMG_COUNTER[0]}.png"
        full_path = _os.path.join(_PLOTS_DIR, fname)
        _orig_savefig(full_path, bbox_inches='tight', dpi=100)
        # フロント側では /plots/<fname> でアクセスされるので plots/ プレフィックス付きマーカー
        print(f"__OGC_IMAGE__:plots/{fname}", flush=True)
        _plt.close('all')
    def _auto_savefig(fname, *a, **kw):
        # ユーザーがsavefigに明示指定したパスはそのまま尊重（uploadsに保存される）
        _orig_savefig(fname, *a, **kw)
        base = _os.path.basename(str(fname))
        print(f"__OGC_IMAGE__:{base}", flush=True)
    _plt.show = _auto_show
    _plt.savefig = _auto_savefig
    # ユーザーコードが 'import matplotlib.pyplot as plt' だけして
    # その後 'matplotlib.use(Agg)' を呼ぶケースに備え、
    # matplotlib モジュール自体もグローバル名として露出させる
except ImportError:
    pass
# LLMが 'matplotlib.use(Agg)' を呼ぶケースに備え、user code が見るグローバル空間にも
# matplotlib をバインドしておく（既にプレアンブル内で Agg バックエンド設定済みなので
# 再呼び出しは no-op に近い、警告は出るが無害）
try:
    import matplotlib
except ImportError:
    pass
# ─── user code below ───
`;
      fs.writeFileSync(tmpFile, preamble + msg.code, 'utf-8');
      const pythonCmd = appConfig.pythonPath || 'python3';
      log(ip, `PYTHON RUN (${msg.code.length} chars) using ${pythonCmd} in ${pyCwd}`);

      proc = spawn(pythonCmd, ['-u', tmpFile], {
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          // matplotlib のキャッシュ先（~/.config が書けない環境向け）
          MPLCONFIGDIR: process.env.MPLCONFIGDIR || '/tmp/matplotlib',
          // 各種ライブラリの一時ディレクトリも /tmp に
          HOME: process.env.HOME || '/tmp',
        },
        cwd: pyCwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        if (proc) {
          proc.kill('SIGTERM');
          ws.send(JSON.stringify({ type: 'stderr', data: `\n[タイムアウト: ${PYTHON_TIMEOUT / 1000}秒で強制終了されました]\n` }));
        }
      }, PYTHON_TIMEOUT);

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        // __OGC_IMAGE__:filename.png マーカーを検出して画像メッセージに変換
        const lines = text.split('\n');
        const normal = [];
        for (const line of lines) {
          const m = line.match(/^__OGC_IMAGE__:(.+)$/);
          if (m) {
            ws.send(JSON.stringify({ type: 'image', filename: m[1].trim() }));
          } else {
            normal.push(line);
          }
        }
        const filtered = normal.join('\n');
        if (filtered) ws.send(JSON.stringify({ type: 'stdout', data: filtered }));
      });

      proc.stderr.on('data', (data) => {
        ws.send(JSON.stringify({ type: 'stderr', data: data.toString() }));
      });

      proc.on('close', (exitCode) => {
        clearTimeout(timer);
        if (tmpFile) fs.unlink(tmpFile, () => {});
        log(ip, `PYTHON EXIT ${exitCode}`);
        ws.send(JSON.stringify({ type: 'exit', exitCode: exitCode ?? -1 }));
        proc = null;
        tmpFile = null;
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        if (tmpFile) fs.unlink(tmpFile, () => {});
        log(ip, `PYTHON ERROR ${err.message}`);
        ws.send(JSON.stringify({ type: 'stderr', data: err.message }));
        ws.send(JSON.stringify({ type: 'exit', exitCode: -1 }));
        proc = null;
      });
    }

    if (msg.type === 'stdin' && proc && proc.stdin.writable) {
      proc.stdin.write(msg.data + '\n');
    }

    if (msg.type === 'kill' && proc) {
      proc.kill('SIGTERM');
    }
  });

  ws.on('close', () => {
    if (proc) proc.kill('SIGTERM');
    if (tmpFile) fs.unlink(tmpFile, () => {});
  });
});

// ─── Web検索 (DuckDuckGo) ───
function ddgSearch(query, maxResults = 5) {
  return new Promise((resolve) => {
    const postData = `q=${encodeURIComponent(query)}&kl=jp-jp`;
    const req = https.request({
      hostname: 'html.duckduckgo.com',
      path: '/html/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      },
      timeout: 15000,
    }, (res) => {
      let html = '';
      res.on('data', (d) => { html += d.toString(); });
      res.on('end', () => {
        try {
          const results = [];
          const decodeHtml = (s) => s
            .replace(/<[^>]*>/g, '')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
            .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

          // パターン1: class="result results_links..." ブロック
          const resultRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
          const snippetRegex = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div|span)/gi;

          const links = [...html.matchAll(resultRegex)];
          const snippets = [...html.matchAll(snippetRegex)];

          for (let i = 0; i < links.length && results.length < maxResults; i++) {
            let url = links[i][1];
            // DuckDuckGoリダイレクトURLをデコード
            const uddgMatch = url.match(/[?&]uddg=([^&]+)/);
            if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);
            // 広告リンクをスキップ
            if (url.includes('duckduckgo.com/y.js') || url.includes('ad_provider')) continue;
            const title = decodeHtml(links[i][2]);
            const snippet = snippets[i] ? decodeHtml(snippets[i][1]) : '';
            if (title && url && url.startsWith('http')) {
              results.push({ title, url, snippet });
            }
          }

          // パターン2: パターン1で取れなかった場合、aタグ+href全般で探す
          if (results.length === 0) {
            const altRegex = /<a[^>]+href="(\/\/duckduckgo\.com\/l\/\?[^"]*uddg=[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
            const altLinks = [...html.matchAll(altRegex)];
            for (let i = 0; i < altLinks.length && results.length < maxResults; i++) {
              let url = 'https:' + altLinks[i][1];
              const uddgMatch = url.match(/[?&]uddg=([^&]+)/);
              if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);
              const title = decodeHtml(altLinks[i][2]);
              if (title && url && !url.includes('duckduckgo.com')) {
                results.push({ title, url, snippet: '' });
              }
            }
          }

          if (results.length === 0) {
            console.log('  [DDG] No results parsed. Response length:', html.length,
              'Has result__a:', html.includes('result__a'),
              'Has uddg:', html.includes('uddg='));
          }
          resolve(results);
        } catch (e) {
          console.log('  [DDG] Parse error:', e.message);
          resolve([]);
        }
      });
    });
    req.on('error', (e) => { console.log('  [DDG] Request error:', e.message); resolve([]); });
    req.on('timeout', () => { console.log('  [DDG] Timeout'); req.destroy(); resolve([]); });
    req.write(postData);
    req.end();
  });
}

// ─── ページ本文取得 (URL → テキスト) ───
function fetchPageText(url, maxChars = 3000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'ja,en-US;q=0.9',
        },
        timeout: 8000,
      }, (res) => {
        // リダイレクト対応（3xx）
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : u.origin + res.headers.location;
          res.destroy();
          return resolve(fetchPageText(redirectUrl, maxChars));
        }
        const contentType = res.headers['content-type'] || '';
        if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
          res.destroy();
          return resolve('');
        }
        let html = '';
        res.on('data', (d) => {
          html += d.toString();
          // サイズ制限（巨大ページの無駄なDL防止）
          if (html.length > 500000) res.destroy();
        });
        res.on('end', () => resolve(extractMainText(html, maxChars)));
        res.on('close', () => resolve(extractMainText(html, maxChars)));
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
      req.end();
    } catch { resolve(''); }
  });
}

// HTMLから主要テキストを抽出
function extractMainText(html, maxChars = 3000) {
  if (!html) return '';
  // script, style, nav, header, footer を除去
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '');

  // main, article要素があれば優先
  const mainMatch = text.match(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)>/i);
  if (mainMatch) text = mainMatch[1];

  // タグ除去 + エンティティデコード + 空白整理
  text = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/\s+/g, ' ')
    .trim();

  return text.slice(0, maxChars);
}

app.get('/web-search', requireAuth, async (req, res) => {
  const ip = getIP(req);
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'q parameter required' });
  const maxResults = parseInt(req.query.n) || 5;
  const fetchBodies = req.query.fetch !== '0'; // デフォルト有効
  const bodyCount = parseInt(req.query.bodyCount) || 3; // 上位何件の本文を取るか
  log(ip, `WEB SEARCH: ${query}`);
  const results = await ddgSearch(query, maxResults);
  log(ip, `WEB SEARCH: ${results.length} results, fetching bodies: ${fetchBodies ? bodyCount : 0}`);

  // 上位N件のページ本文を並列取得
  if (fetchBodies && results.length > 0) {
    const targets = results.slice(0, bodyCount);
    await Promise.all(targets.map(async (r, i) => {
      try {
        const body = await fetchPageText(r.url, 2500);
        if (body) {
          r.body = body;
          log(ip, `  [${i+1}] ${r.url}  (${body.length} chars)`);
        }
      } catch {}
    }));
  }

  res.json({ results });
});

// ─── 音声認識プロキシ (Python Transcribe Server へ転送) ───
app.post('/transcribe', requireAuth, (req, res) => {
  const ip = getIP(req);
  if (!appConfig.transcribe || !appConfig.transcribe.enabled) {
    return res.status(503).json({ error: '音声認識が無効です。config.jsonでtranscribe.enabledをtrueにしてください。' });
  }
  const host = appConfig.transcribe.host || '127.0.0.1';
  const port = appConfig.transcribe.port || 11500;
  const contentLength = req.headers['content-length'];
  log(ip, `TRANSCRIBE POST ${contentLength || '?'} bytes → ${host}:${port}`);

  const proxyReq = http.request({
    hostname: host, port, path: '/transcribe', method: 'POST',
    headers: {
      'Content-Type': req.headers['content-type'] || 'application/octet-stream',
      ...(contentLength && { 'Content-Length': contentLength }),
    },
    timeout: 120000,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
    proxyRes.pipe(res, { end: true });
  });
  proxyReq.on('error', (err) => {
    log(ip, `TRANSCRIBE ERROR: ${err.message}`);
    if (!res.headersSent) res.status(502).json({ error: '音声認識サーバーに接続できません: ' + err.message });
  });
  proxyReq.on('timeout', () => {
    log(ip, `TRANSCRIBE TIMEOUT`);
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).json({ error: '音声認識タイムアウト' });
  });
  req.pipe(proxyReq, { end: true });
});

app.get('/transcribe/health', requireAuth, (req, res) => {
  if (!appConfig.transcribe || !appConfig.transcribe.enabled) {
    return res.json({ enabled: false });
  }
  const host = appConfig.transcribe.host || '127.0.0.1';
  const port = appConfig.transcribe.port || 11500;
  const r = http.get({ hostname: host, port, path: '/health', timeout: 3000 }, (proxyRes) => {
    let data = '';
    proxyRes.on('data', d => data += d);
    proxyRes.on('end', () => {
      try { res.json({ enabled: true, ...JSON.parse(data) }); }
      catch { res.json({ enabled: true, status: 'unknown' }); }
    });
  });
  r.on('error', () => res.json({ enabled: true, status: 'offline' }));
  r.on('timeout', () => { r.destroy(); res.json({ enabled: true, status: 'timeout' }); });
});

// ─── llama-server (OpenAI互換) へのリバースプロキシ ───
// /v1/* をlocalhost:chatPortへ転送（チャット推論用）
// /embed/v1/* をlocalhost:embeddingPortへ転送（Embedding用）
function proxyToLlama(targetHost, targetPort, pathPrefix, isChatProxy) {
  return async (req, res) => {
    const ip = getIP(req);
    const targetPath = pathPrefix + req.url;
    const isQuiet = appConfig.logLevel === 'quiet';

    // チャットプロキシの場合: モデル起動中・未ロード時は起動完了を待ってから処理を続行
    // （Embeddingプロキシと同様の挙動。クライアントは「初回送信で503」を見ずに済む）
    if (isChatProxy) {
      // 既に起動中の場合は完了を待つ
      if (chatProcStarting) {
        if (!isQuiet) log(ip, `${req.method} ${targetPath} → モデル起動中、完了を待機`);
        // 最大60秒待つ（モデルロードのタイムアウト）
        const startWait = Date.now();
        while (chatProcStarting && (Date.now() - startWait < 60000)) {
          await new Promise(r => setTimeout(r, 500));
        }
        if (chatProcStarting || !chatProc) {
          if (!isQuiet) log(ip, `503 ${req.method} ${targetPath} (起動タイムアウト)`);
          return res.status(503).json({
            error: 'モデル起動がタイムアウトしました。サーバーログを確認してください。',
            starting: false,
          });
        }
      }
      // プロセスが存在しない場合: アイドル復帰または初回ロードを行う
      if (!chatProc) {
        // 初回ロード（サーバー起動後の最初のチャット）または自動アンロードからの復帰
        if (chatProcAutoUnloaded || appConfig.defaultModel) {
          if (!isQuiet) log(ip, `${req.method} ${targetPath} → モデル自動ロード待機`);
          ensureChatModelLoaded();  // バックグラウンドで起動開始
          // 起動完了を待つ（最大60秒）
          const startWait = Date.now();
          while ((chatProcStarting || !chatProc) && (Date.now() - startWait < 60000)) {
            await new Promise(r => setTimeout(r, 500));
          }
          if (!chatProc) {
            if (!isQuiet) log(ip, `503 ${req.method} ${targetPath} (自動ロード失敗)`);
            return res.status(503).json({
              error: 'モデル自動ロードに失敗しました。サーバーログを確認してください。',
              starting: false,
            });
          }
        } else {
          if (!isQuiet) log(ip, `503 ${req.method} ${targetPath} (モデル未ロード)`);
          return res.status(503).json({
            error: 'チャットモデルがロードされていません。',
            starting: false,
          });
        }
      }
      chatLastUsed = Date.now();
    } else {
      // Embeddingプロキシ: アイドルアンロード後なら起動を待ってから処理を続行
      if (!embedProc) {
        if (!isQuiet) log(ip, `Embedding未起動、再ロードを待機 (${targetPath})`);
        const ready = await ensureEmbeddingLoaded();
        if (!ready) {
          if (!isQuiet) log(ip, `503 ${req.method} ${targetPath} (embed reload failed)`);
          return res.status(503).json({ error: 'Embeddingモデルの再ロードに失敗しました。' });
        }
      }
      embedLastUsed = Date.now();
    }

    if (!isQuiet) {
      log(ip, `${req.method} ${targetPath} -> ${targetHost}:${targetPort}`);
    }

    const options = {
      hostname: targetHost,
      port: targetPort,
      path: targetPath,
      method: req.method,
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        'accept': req.headers['accept'] || '*/*',
      },
      timeout: 600000,
    };
    if (req.headers['content-length']) {
      options.headers['content-length'] = req.headers['content-length'];
    }

    const proxyReq = http.request(options, (proxyRes) => {
      if (!isQuiet) {
        log(ip, `${proxyRes.statusCode} ${req.method} ${targetPath}`);
      }
      const headers = {
        'content-type': proxyRes.headers['content-type'] || 'application/json',
        'cache-control': 'no-cache',
      };
      if (proxyRes.headers['transfer-encoding']) {
        headers['transfer-encoding'] = proxyRes.headers['transfer-encoding'];
      }
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
      log(ip, `ERROR ${targetPath} ${err.message}`);
      if (!res.headersSent) {
        res.status(502).json({ error: 'llama-server に接続できません: ' + err.message });
      }
    });
    proxyReq.on('timeout', () => {
      log(ip, `TIMEOUT ${targetPath}`);
      proxyReq.destroy();
      if (!res.headersSent) {
        res.status(504).json({ error: 'llama-server タイムアウト' });
      }
    });

    req.pipe(proxyReq, { end: true });
  };
}

// チャット推論: /v1/chat/completions, /v1/completions, /v1/models 等
app.use('/v1', requireAuth, proxyToLlama(
  appConfig.llamaServer.chatHost,
  appConfig.llamaServer.chatPort,
  '/v1',
  true  // isChatProxy
));

// Embedding: /embed/v1/embeddings
app.use('/embed/v1', requireAuth, proxyToLlama(
  appConfig.llamaServer.embeddingHost,
  appConfig.llamaServer.embeddingPort,
  '/v1',
  false
));

// ─── モデル管理API ───
// 利用可能モデル一覧（config.jsonから）+ 現在のロード状態
app.get('/models', requireAuth, (req, res) => {
  res.json({
    models: chatModels.map(m => ({
      name: m.name,
      ctx: m.ctx,
      ngl: m.ngl,
      loaded: m.name === chatProcModel,
    })),
    current: chatProcModel,
    starting: chatProcStarting,
    embeddingReady: !!embedProc,
    autoUnloaded: chatProcAutoUnloaded,  // アイドルでアンロード済みのモデル名（次のリクエストで再ロードされる）
    idleUnloadMs: appConfig.llamaServer.idleUnloadMs || 0,
    firstLoadPending: !firstChatLoadDone,  // サーバー起動後、まだ一度もチャットモデルがロードされていない
  });
});

// モデル切替（再起動）
app.post('/models/load', requireAuth, jsonParser, async (req, res) => {
  const ip = getIP(req);
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  // 自動アンロード状態をクリア（手動切替が始まったので）
  chatProcAutoUnloaded = null;
  if (name === chatProcModel) return res.json({ ok: true, current: chatProcModel, message: 'すでにロード中' });
  if (chatProcStarting) return res.status(409).json({ error: '別のモデルが起動中です' });

  log(ip, `MODEL LOAD ${name}`);
  try {
    await startChatModel(name);
    res.json({ ok: true, current: chatProcModel });
  } catch (e) {
    log(ip, `MODEL LOAD ERROR ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// モデルアンロード
app.post('/models/unload', requireAuth, async (req, res) => {
  const ip = getIP(req);
  log(ip, `MODEL UNLOAD ${chatProcModel}`);
  await stopChatModel();
  res.json({ ok: true });
});

// ─── 外部API公開サーバー ───

app.get('/external-servers', requireAuth, (req, res) => {
  res.json({ servers: listExternalServers() });
});

app.post('/external-servers', requireAuth, jsonParser, async (req, res) => {
  const ip = getIP(req);
  try {
    const { modelName, host, port, apiKey, type, https, agentMode, tools } = req.body || {};
    if (!port || typeof port !== 'number' || port < 1 || port > 65535) {
      return res.status(400).json({ error: 'portは1-65535の数値で指定してください' });
    }
    const targetHost = (typeof host === 'string' && host) ? host : '0.0.0.0';
    const targetType = type === 'embedding' ? 'embedding' : 'chat';
    if (targetType === 'chat' && !modelName) {
      return res.status(400).json({ error: 'modelName を指定してください' });
    }
    if (agentMode && targetType === 'embedding') {
      return res.status(400).json({ error: 'ツール対応モードは chat タイプのみ対応' });
    }
    // APIキー: 指定がなければ自動生成
    const finalApiKey = (typeof apiKey === 'string' && apiKey.trim())
      ? apiKey.trim()
      : generateApiKey();

    log(ip, `EXTERNAL API START: ${modelName || 'embedding'} @ ${targetHost}:${port} (https=${!!https}, agent=${!!agentMode})`);
    const id = await startExternalServer({
      modelName: modelName || appConfig.embeddingModel?.path?.split('/').pop() || 'embedding',
      host: targetHost,
      port,
      apiKey: finalApiKey,
      type: targetType,
      https: !!https,
      agentMode: !!agentMode,
      tools: Array.isArray(tools) ? tools : undefined,
    });
    // 起動後のツール一覧を取得して、要求と差分があれば warnings に
    const s = externalServers.get(id);
    const actualTools = s?.tools || null;
    const warnings = [];
    if (agentMode && Array.isArray(tools) && actualTools) {
      const removed = tools.filter(t => !actualTools.includes(t));
      if (removed.includes('rag')) {
        const emb = isEmbeddingAvailable();
        warnings.push(`RAGツール (search_documents) はembeddingサーバーが利用できないため無効化されました: ${emb.reason}`);
      }
      if (removed.includes('gdrive')) {
        const st = gdrive.status();
        warnings.push(`Google Driveツール (gdrive_*) は利用できないため無効化されました: ${st.reason || '未接続'}`);
      }
    }
    res.json({ ok: true, id, apiKey: finalApiKey, tools: actualTools, warnings });
  } catch (e) {
    log(ip, `EXTERNAL API ERROR: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// HTTPS有効化されているか（フロント側で表示制御するため）
app.get('/external-servers/https-available', requireAuth, (req, res) => {
  res.json({ available: HTTPS_ENABLED });
});

// embedding (RAG用) が利用可能か (UIのRAGチェックボックス制御用)
app.get('/external-servers/embedding-available', requireAuth, (req, res) => {
  const r = isEmbeddingAvailable();
  res.json(r);
});

// Google Drive が利用可能か (UIのDriveチェックボックス制御用)
app.get('/external-servers/gdrive-available', requireAuth, (req, res) => {
  const st = gdrive.status();
  res.json({ available: st.enabled && st.connected, reason: st.reason, account: st.account });
});

app.delete('/external-servers/:id', requireAuth, (req, res) => {
  const ip = getIP(req);
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  log(ip, `EXTERNAL API STOP: ${id}`);
  const ok = stopExternalServer(id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// プロセスのみ停止（設定は保持）
app.post('/external-servers/:id/stop', requireAuth, (req, res) => {
  const ip = getIP(req);
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  log(ip, `EXTERNAL API PROC STOP: ${id}`);
  const ok = stopExternalServerProcess(id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// 停止中のサーバーを再起動
app.post('/external-servers/:id/start', requireAuth, async (req, res) => {
  const ip = getIP(req);
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  log(ip, `EXTERNAL API PROC START: ${id}`);
  try {
    const newId = await restartExternalServer(id);
    res.json({ ok: true, id: newId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════
// マルチLLMオーケストレーション API (/orchestra)
// ════════════════════════════════════════════════
// ワークフローの CRUD はすべて config.json (orchestration.workflows) に反映される。
// 実行 (/orchestra/run) は SSE でノード単位の進捗をストリーミングする。

// 機能情報とワークフロー一覧（フロントの初期化用）
app.get('/orchestra/info', requireAuth, (req, res) => {
  const o = appConfig.orchestration || {};
  res.json({
    enabled: !!o.enabled,
    poolMode: o.poolMode || 'auto',
    defaultWorkflow: o.defaultWorkflow || '',
    maxResident: o.maxResident ?? 3,
    workflows: listWorkflows(),
    models: chatModels.map(m => ({
      name: m.name,
      ctx: m.ctx,
      estimatedVramMB: llmPool.estimateModelVramMB(m),
      // --mmproj が指定されているモデルだけが画像を受け取れる
      vision: (m.extraArgs || []).includes('--mmproj'),
    })),
    // RAG(参照ドキュメント)が使えるか。embedding が無いと検索できない
    rag: isEmbeddingAvailable(),
  });
});

app.get('/orchestra/workflows', requireAuth, (req, res) => {
  res.json({ workflows: listWorkflows() });
});

// ワークフローの新規作成 / 更新（id があれば更新、なければ新規）
app.post('/orchestra/workflows', requireAuth, jsonParser, (req, res) => {
  const ip = getIP(req);
  const wf = req.body || {};
  const modelNames = chatModels.map(m => m.name);

  if (!wf.id) wf.id = generateWorkflowId();
  const v = validateWorkflow(wf, modelNames);
  if (!v.ok) return res.status(400).json({ error: v.errors.join(' / '), errors: v.errors });

  try {
    const workflows = [...listWorkflows()];
    const idx = workflows.findIndex(w => w.id === wf.id);
    if (idx >= 0) workflows[idx] = wf;
    else workflows.push(wf);
    saveWorkflows(workflows);
    log(ip, `ORCHESTRA WORKFLOW SAVE: ${wf.name} (${wf.id}, ${(wf.nodes || []).length}ノード)`);
    res.json({ ok: true, workflow: wf });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/orchestra/workflows/:id', requireAuth, (req, res) => {
  const ip = getIP(req);
  const id = req.params.id;
  try {
    const workflows = listWorkflows().filter(w => w.id !== id);
    if (workflows.length === listWorkflows().length) return res.status(404).json({ error: 'Not found' });
    saveWorkflows(workflows);
    log(ip, `ORCHESTRA WORKFLOW DELETE: ${id}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ワークフローの検証のみ（保存せずエディタ上でチェックする用）
app.post('/orchestra/validate', requireAuth, jsonParser, (req, res) => {
  const v = validateWorkflow(req.body || {}, chatModels.map(m => m.name));
  let plan = null;
  if (v.ok) {
    const models = [];
    for (const n of (req.body.nodes || [])) {
      if (n.model) models.push(n.model);
      for (const p of (n.participants || [])) if (p.model) models.push(p.model);
    }
    plan = llmPool.planMode(models);
  }
  res.json({ ok: v.ok, errors: v.errors, plan });
});

// ワーカープールの状態
app.get('/orchestra/pool', requireAuth, (req, res) => {
  res.json(llmPool.status());
});

// 全ワーカーをアンロード（VRAMを空けたいとき）
app.post('/orchestra/pool/unload', requireAuth, async (req, res) => {
  const ip = getIP(req);
  log(ip, 'ORCHESTRA POOL UNLOAD ALL');
  try {
    await llmPool.unloadAll();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ワークフロー実行（SSE ストリーミング）
// EventSource は POST に対応しないため、fetch + ReadableStream で読む前提の
// text/event-stream レスポンスを返す。
app.post('/orchestra/run', requireAuth, jsonParser, async (req, res) => {
  const ip = getIP(req);
  const {
    workflowId, workflow: inlineWorkflow, query, history, role,
    images,        // [{ name, base64 }] Vision対応ノードに渡す
    docChunks,     // フロント側でチャット添付ドキュメントを検索した結果
  } = req.body || {};

  const o = appConfig.orchestration || {};
  if (!o.enabled) return res.status(400).json({ error: 'オーケストレーション機能が無効です (config.orchestration.enabled)' });
  if (!query || typeof query !== 'string') return res.status(400).json({ error: 'query が必要です' });

  // 保存済みワークフロー、またはエディタからの一時実行(inline)
  const wf = inlineWorkflow || listWorkflows().find(w => w.id === workflowId);
  if (!wf) return res.status(404).json({ error: `ワークフローが見つかりません: ${workflowId}` });

  const v = validateWorkflow(wf, chatModels.map(m => m.name));
  if (!v.ok) return res.status(400).json({ error: v.errors.join(' / '), errors: v.errors });

  // ベースのシステムプロンプト（フロントの組み立てと揃える）
  const dateStr = new Date().toLocaleDateString('ja-JP', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });
  let baseSystem = (appConfig.systemPrompts?.base || '').replace(/\{date\}/g, dateStr);
  if (role && String(role).trim()) {
    baseSystem = '【最優先指示: ユーザー指定の役割】\n'
      + '以下の役割・指示に厳密に従って応答してください。これは以降のどの一般的なルールよりも優先されます。\n\n'
      + String(role).trim()
      + '\n\n────────────────────\n\n'
      + baseSystem;
  }

  // ─── 参照ドキュメント(RAG)の収集 ───
  // useRag のノードが1つでもあれば集める。2系統あるので統合する:
  //   1. チャット添付ドキュメント … 埋め込みがブラウザ側にあるためフロントで検索済み
  //   2. 永続RAGドキュメント (ml/rag) … サーバー側で検索する
  const wantsRag = (wf.nodes || []).some(n => n.useRag);
  const ragChunks = [];
  if (wantsRag) {
    for (const c of (Array.isArray(docChunks) ? docChunks : [])) {
      if (c && typeof c.text === 'string' && c.text.trim()) {
        ragChunks.push({ text: c.text, source: c.source || 'チャット添付', score: c.score });
      }
    }
    const emb = isEmbeddingAvailable();
    if (emb.available) {
      try {
        const r = await ragSearch(query, appConfig.ragTopK || 10);
        for (const hit of (r.results || [])) {
          ragChunks.push({ text: hit.text, source: hit.filename, score: hit.score });
        }
      } catch (e) {
        log(ip, `ORCHESTRA RAG検索エラー: ${e.message}`);
      }
    }
    // スコア順に整えて上位だけ渡す（多すぎるとコンテキストを圧迫する）
    ragChunks.sort((a, b) => (b.score || 0) - (a.score || 0));
    ragChunks.splice(appConfig.ragTopK || 10);
  }

  const validImages = (Array.isArray(images) ? images : [])
    .filter(im => im && typeof im.base64 === 'string' && im.base64)
    .map(im => ({ name: im.name || '', base64: im.base64 }));

  log(ip, `ORCHESTRA RUN: ${wf.name} (${(wf.nodes || []).length}ノード`
    + `${ragChunks.length ? `, 参照資料${ragChunks.length}件` : ''}`
    + `${validImages.length ? `, 画像${validImages.length}枚` : ''})`);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',   // nginx等のリバースプロキシでのバッファリング抑止
  });

  let clientGone = false;
  // 注意: req の 'close' は「ボディを読み終えた時」にも発火するため切断判定に使えない
  // （POSTボディをパースした直後に true になり、以降のイベントが全て捨てられてしまう）。
  // レスポンス側の 'close' なら、切断か res.end() のどちらかでしか発火しない。
  res.on('close', () => { clientGone = true; });

  const send = (ev) => {
    if (clientGone || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  try {
    await orchestrator.runWorkflow({
      workflow: wf,
      query,
      history: Array.isArray(history) ? history.filter(m => m && m.role && typeof m.content === 'string') : [],
      baseSystem,
      images: validImages,
      ragChunks,
      onEvent: (ev) => { if (!clientGone) send(ev); },
    });
  } catch (e) {
    log(ip, `ORCHESTRA RUN ERROR: ${e.message}`);
    send({ type: 'error', error: e.message });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

// ════════════════════════════════════════════════
// 画像生成 API (/image-gen)
// ════════════════════════════════════════════════
// LLMの generate_image ツールから呼ばれる。
// - sd-server が未起動なら自動起動（オンデマンドロード）
// - 生成画像は public/uploads/ に PNG 保存し、URLを返す
// - チャットUIは Markdown ![](...) で表示するだけ

app.get('/image-gen/info', requireAuth, (req, res) => {
  const sdConfig = appConfig.stableDiffusion || {};
  res.json({
    available: !!(appConfig.imageModels && appConfig.imageModels.length > 0),
    currentModel: sdCurrentModel,
    starting: sdProcStarting,
    running: !!(sdProc && !sdProc.killed),
    models: (appConfig.imageModels || []).map(m => ({ name: m.name, desc: m.desc })),
    defaultModel: sdConfig.defaultModel || appConfig.imageModels?.[0]?.name || null,
  });
});

app.post('/image-gen', requireAuth, jsonParser, async (req, res) => {
  const ip = getIP(req);
  const {
    prompt,
    negativePrompt = '',
    model = null,             // 省略時は defaultModel または現在ロード中
    width = 1024,
    height = 1024,
    steps = 20,
    cfgScale = 7.0,
    sampler = 'euler_a',      // sd-server のサンプラー名
    seed = -1,                // -1 = ランダム
    batchCount = 1,           // 同じ設定で何枚生成するか
  } = req.body || {};

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt が必要です' });
  }
  if (!appConfig.imageModels || appConfig.imageModels.length === 0) {
    return res.status(400).json({
      error: '画像生成モデルが設定されていません。config.json の imageModels に追加してください。',
    });
  }

  // モデル決定
  const sdConfig = appConfig.stableDiffusion || {};
  const targetModel = model || sdCurrentModel || sdConfig.defaultModel || appConfig.imageModels[0].name;

  // 既に別モデルがロードされていれば切り替え
  if (sdCurrentModel && sdCurrentModel !== targetModel) {
    log(ip, `[IMAGE-GEN] モデル切替: ${sdCurrentModel} → ${targetModel}`);
    await stopImageModel();
  }

  // モデルが起動していなければ起動（オンデマンド）
  if (!sdProc || sdProc.killed || sdProc.exitCode !== null) {
    try {
      log(ip, `[IMAGE-GEN] sd-server を起動: ${targetModel}`);
      await startImageModel(targetModel);
    } catch (e) {
      return res.status(500).json({ error: `sd-server起動失敗: ${e.message}` });
    }
  }

  sdLastActivity = Date.now();
  const port = sdConfig.port || 7860;

  // 一括生成 (batchCount 回ループ)
  const generatedUrls = [];
  const startTime = Date.now();
  for (let i = 0; i < Math.min(batchCount, 4); i++) {
    try {
      // sd-server プロセスが生きてるか確認（ループ中に死んだ場合の検知）
      if (!sdProc || sdProc.killed || sdProc.exitCode !== null) {
        throw new Error('sd-serverプロセスが終了しています。再試行してください。');
      }

      // タイムアウト付き fetch（hangを防ぐ）
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 180000);  // 3分

      // sd-server の HTTP API に転送
      // sd-server (stable-diffusion.cpp) は AUTOMATIC1111互換だが、
      // サポートされてるパラメータが限定的。
      // 検証: curlで {prompt, width, height, steps} のみで成功する
      // 追加パラメータは存在する場合だけ送る
      const sdBody = {
        prompt,
        width: Math.min(Math.max(width, 64), 2048),
        height: Math.min(Math.max(height, 64), 2048),
        steps: Math.min(Math.max(steps, 1), 100),
        batch_size: 1,
        n_iter: 1,
      };
      if (negativePrompt) sdBody.negative_prompt = negativePrompt;
      if (cfgScale != null && cfgScale > 0) sdBody.cfg_scale = cfgScale;
      if (seed !== -1) sdBody.seed = seed;
      // サンプラー名は省略するとデフォルト (SDXL用は euler_a が自動選択)
      // 明示指定しない方が互換性が高い

      const sdResp = await fetch(`http://127.0.0.1:${port}/sdapi/v1/txt2img`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sdBody),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
      if (!sdResp.ok) {
        const errText = await sdResp.text().catch(() => '');
        throw new Error(`sd-server エラー ${sdResp.status}: ${errText.slice(0, 200)}`);
      }
      const sdData = await sdResp.json();
      if (!sdData.images || sdData.images.length === 0) {
        throw new Error('sd-serverから画像が返されませんでした');
      }

      // base64 PNG をデコードして保存
      const ts = Date.now();
      const rand = Math.random().toString(36).slice(2, 8);
      const fileName = `sd_${ts}_${rand}_${i}.png`;
      const uploadsDir = path.join(__dirname, 'public', 'uploads');
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
      const filePath = path.join(uploadsDir, fileName);
      fs.writeFileSync(filePath, Buffer.from(sdData.images[0], 'base64'));
      generatedUrls.push(`/uploads/${fileName}`);
    } catch (e) {
      // 部分的に成功している場合もあるので、エラーでも続行
      log(ip, `[IMAGE-GEN] error: ${e.message}`);
      if (generatedUrls.length === 0) {
        return res.status(500).json({ error: e.message });
      }
      break;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(ip, `[IMAGE-GEN] 完了: ${generatedUrls.length}枚, ${elapsed}秒, prompt="${prompt.slice(0, 60)}"`);

  res.json({
    ok: true,
    images: generatedUrls,
    model: targetModel,
    prompt,
    negativePrompt,
    parameters: { width, height, steps, cfgScale, sampler },
    elapsed: Number(elapsed),
  });
});

// 手動でモデル停止
app.post('/image-gen/unload', requireAuth, async (req, res) => {
  const ip = getIP(req);
  log(ip, '[IMAGE-GEN] 手動アンロード');
  await stopImageModel();
  res.json({ ok: true });
});

// ════════════════════════════════════════════════
// 音声合成 API (/tts)
// ════════════════════════════════════════════════
// LLMの generate_speech ツールから呼ばれる。
// - Irodori-TTSサーバーが未起動かつ command 設定済みなら自動起動（オンデマンドロード）
// - 生成音声は public/uploads/ に WAV 保存し、URLを返す
// - チャットUIは [[gen_audio:URL|text]] マーカーで <audio> 再生

app.get('/tts/info', requireAuth, (req, res) => {
  const cfg = appConfig.irodoriTts || {};
  res.json({
    available: !!appConfig.ttsGen,
    starting: ttsProcStarting,
    running: !!(ttsProc && !ttsProc.killed),
    managed: !!cfg.command,          // server.js が子プロセス管理するか
    defaultVoice: cfg.defaultVoice || 'sample',
    defaultFormat: cfg.defaultFormat || 'wav',
    voices: (appConfig.ttsVoices || []).map(v => ({ name: v.name, desc: v.desc })),
  });
});

app.post('/tts', requireAuth, jsonParser, async (req, res) => {
  const ip = getIP(req);
  const cfg = appConfig.irodoriTts || {};
  let {
    text,                            // 読み上げるテキスト (必須)
    voice = null,                    // 声の指定: 登録名 / voice ID / フリーなテキスト記述
    instructions = '',               // 声のテキスト記述(VoiceDesign)。voiceが記述ならそちら優先
    format = null,                   // wav / mp3 / flac / opus / aac / pcm
    speed = null,                    // 0.25〜4.0
  } = req.body || {};

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text が必要です' });
  }
  if (!appConfig.ttsGen) {
    return res.status(400).json({ error: '音声合成が無効です。config.json の ttsGen を true にしてください。' });
  }

  // ── 声の解決 ──
  // 1. ttsVoices に name 一致するプリセットがあれば voiceId / instructions を採用
  // 2. 一致しなければ voice 文字列を「フリーなテキスト記述」とみなし caption に回す
  const presets = Array.isArray(appConfig.ttsVoices) ? appConfig.ttsVoices : [];
  let voiceId = cfg.defaultVoice || 'sample';
  let caption = (instructions || '').trim();

  if (voice && typeof voice === 'string') {
    const preset = presets.find(v => v.name === voice || v.voiceId === voice);
    if (preset) {
      if (preset.voiceId) voiceId = preset.voiceId;
      if (preset.instructions && !caption) caption = preset.instructions;
    } else {
      // 登録外 → テキスト記述（例: "30代男性、落ち着いた声"）として扱う
      caption = caption || voice;
    }
  }

  const responseFormat = (format || cfg.defaultFormat || 'wav').toLowerCase();
  const reqSpeed = Number(speed) || Number(cfg.defaultSpeed) || 1.0;

  // ── サーバーのオンデマンド起動（command 設定時のみ） ──
  if (cfg.command && (!ttsProc || ttsProc.killed)) {
    try {
      log(ip, `[TTS] irodori-tts を起動`);
      await startTtsServer();
    } catch (e) {
      return res.status(500).json({ error: `TTSサーバー起動失敗: ${e.message}` });
    }
  }

  ttsLastActivity = Date.now();
  const host = cfg.host || '127.0.0.1';
  const port = cfg.port || 8088;
  const endpoint = cfg.endpoint || '/v1/audio/speech';

  // ── OpenAI互換リクエストの組み立て ──
  const body = {
    model: cfg.model || 'irodori-tts',
    input: text,
    voice: voiceId,
    response_format: responseFormat,
    speed: Math.min(Math.max(reqSpeed, 0.25), 4.0),
  };
  // 声のテキスト記述(VoiceDesign): OpenAI標準の instructions と irodori.caption の両方へ
  if (caption) body.instructions = caption;
  const irodoriOpts = { ...(cfg.irodori || {}) };
  if (caption && cfg.captionField) irodoriOpts[cfg.captionField] = caption;
  if (Object.keys(irodoriOpts).length > 0) body.irodori = irodoriOpts;

  const startTime = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs || 180000);
    const ttsResp = await fetch(`http://${host}:${port}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));

    if (!ttsResp.ok) {
      const errText = await ttsResp.text().catch(() => '');
      throw new Error(`TTSサーバー エラー ${ttsResp.status}: ${errText.slice(0, 200)}`);
    }

    // 音声バイト列を取得して保存（画像生成と同じく public/uploads/ へ）
    const arrayBuf = await ttsResp.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    if (buf.length === 0) throw new Error('TTSサーバーから空の音声が返されました');

    const extMap = { wav: 'wav', mp3: 'mp3', flac: 'flac', opus: 'opus', aac: 'aac', pcm: 'pcm' };
    const ext = extMap[responseFormat] || 'wav';
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    const fileName = `tts_${ts}_${rand}.${ext}`;
    const uploadsDir = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(uploadsDir, fileName), buf);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(ip, `[TTS] 完了: ${fileName} (${(buf.length / 1024).toFixed(0)}KB, ${elapsed}秒, voice="${voiceId}", caption="${caption.slice(0, 40)}")`);

    res.json({
      ok: true,
      url: `/uploads/${fileName}`,
      format: ext,
      voice: voiceId,
      caption,
      text,
      elapsed: Number(elapsed),
    });
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'タイムアウト' : e.message;
    log(ip, `[TTS] error: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// 手動でTTSサーバー停止
app.post('/tts/unload', requireAuth, async (req, res) => {
  const ip = getIP(req);
  log(ip, '[TTS] 手動アンロード');
  await stopTtsServer();
  res.json({ ok: true });
});

// ════════════════════════════════════════════════
// ファインチューニング機能
// ════════════════════════════════════════════════

const TUNING_DIR = path.join(__dirname, 'tuning');
const TUNING_DATA_DIR = path.join(TUNING_DIR, 'datasets');
const TUNING_RUNS_DIR = path.join(TUNING_DIR, 'runs');
const TUNING_SAMPLES_FILE = path.join(TUNING_DIR, 'samples.jsonl');
const TUNING_JOBS_FILE = path.join(TUNING_DIR, 'jobs.json');
// HuggingFace モデルキャッシュ先 (ベースモデルのダウンロード保存先)。
// 本番では ~/.cache が systemd の ProtectHome 等で読み取り専用のことがあるため、
// アプリ内に明示する。tune_runner.py 起動時に HF_HOME 環境変数で渡す。
const TUNING_HF_CACHE_DIR = path.join(TUNING_DIR, 'hf_cache');

// ─── 機械学習(ML)機能の定数 ─────────────────────────────────────────
// 表データ用の DuckDB を1ファイルに集約。テーブル単位で管理。
// LLMからは読み取り専用(SELECT)で公開。
const ML_DIR = path.join(__dirname, 'ml');
const ML_DB_FILE = path.join(ML_DIR, 'datasets.duckdb');
const ML_META_FILE = path.join(ML_DIR, 'meta.json');  // テーブル説明等のメタ情報
const ML_MODELS_DIR = path.join(ML_DIR, 'models');     // 学習成果物の保存先（モデル毎にディレクトリ）
const ML_MODELS_FILE = path.join(ML_DIR, 'models.json'); // モデル定義一覧（メタ情報）
const ML_JOBS_FILE = path.join(ML_DIR, 'jobs.json');   // 学習ジョブ履歴

// 外部API(ツール対応モード)用の永続RAGストア
const RAG_DIR = path.join(__dirname, 'ml', 'rag');     // RAGドキュメント保存先
const RAG_INDEX_FILE = path.join(RAG_DIR, 'index.json'); // 登録ドキュメント一覧

// 画像検出 (torchvision) のモデルweightキャッシュ先
// 本番環境では ~/.cache が読み取り専用のことがあるため、アプリ内に明示
const TORCH_CACHE_DIR = path.join(ML_DIR, 'torch_cache');

// 画像物体検出のカスタム学習 (Phase 2)
const IMAGE_DATASETS_DIR = path.join(ML_DIR, 'image_datasets'); // データセット (画像+アノテーション)
const IMAGE_MODELS_DIR = path.join(ML_DIR, 'image_models');     // 学習済みカスタムモデル

// 画像キーポイント検出のカスタム学習 (手の関節など、対象+順序付きの点を学習)
const KEYPOINT_DATASETS_DIR = path.join(ML_DIR, 'keypoint_datasets'); // データセット (画像+キーポイントアノテーション)
const KEYPOINT_MODELS_DIR = path.join(ML_DIR, 'keypoint_models');     // 学習済みカスタムモデル

// 強化学習 (RL / DQN) — 組み込み環境でエージェントを学習
const RL_MODELS_DIR = path.join(ML_DIR, 'rl_models');  // 学習済みエージェント (名前毎にディレクトリ)
const RL_JOBS_FILE = path.join(ML_DIR, 'rl_jobs.json'); // RL 学習ジョブ履歴

// ディレクトリ作成
for (const d of [TUNING_DIR, TUNING_DATA_DIR, TUNING_RUNS_DIR, TUNING_HF_CACHE_DIR, ML_DIR, ML_MODELS_DIR, RAG_DIR, TORCH_CACHE_DIR, IMAGE_DATASETS_DIR, IMAGE_MODELS_DIR, KEYPOINT_DATASETS_DIR, KEYPOINT_MODELS_DIR, RL_MODELS_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

let currentTuningJob = null;  // 実行中ジョブ { id, proc, ... }

// ─── 学習サンプル管理 ───
// JSONLファイルで管理。1行 = 1サンプル
// {id, instruction, response, system?, createdAt, tags?}

function loadAllSamples() {
  if (!fs.existsSync(TUNING_SAMPLES_FILE)) return [];
  try {
    return fs.readFileSync(TUNING_SAMPLES_FILE, 'utf-8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
  } catch (e) {
    log('-', `[tuning] サンプル読み込みエラー: ${e.message}`);
    return [];
  }
}

function saveAllSamples(samples) {
  const data = samples.map(s => JSON.stringify(s)).join('\n') + (samples.length > 0 ? '\n' : '');
  fs.writeFileSync(TUNING_SAMPLES_FILE, data);
}

function generateSampleId() {
  return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 学習用のプリセット情報を返す（config.json の tuning.modelPresets から）
app.get('/tuning/presets', requireAuth, (req, res) => {
  const presets = appConfig.tuning?.modelPresets || [];
  res.json({ presets });
});

// 全サンプル取得
app.get('/tuning/samples', requireAuth, (req, res) => {
  const samples = loadAllSamples();
  res.json({ samples, count: samples.length });
});

// サンプル追加（1件）
app.post('/tuning/samples', requireAuth, jsonParser, (req, res) => {
  const { instruction, response, system, tags } = req.body || {};
  if (!instruction || !response) {
    return res.status(400).json({ error: 'instruction と response は必須です' });
  }
  const samples = loadAllSamples();
  const newSample = {
    id: generateSampleId(),
    instruction: String(instruction),
    response: String(response),
    system: system ? String(system) : '',
    tags: Array.isArray(tags) ? tags : [],
    createdAt: Date.now(),
  };
  samples.push(newSample);
  saveAllSamples(samples);
  res.json({ ok: true, sample: newSample, total: samples.length });
});

// サンプル更新
app.put('/tuning/samples/:id', requireAuth, jsonParser, (req, res) => {
  const samples = loadAllSamples();
  const idx = samples.findIndex(s => s.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  const { instruction, response, system, tags } = req.body || {};
  if (instruction !== undefined) samples[idx].instruction = String(instruction);
  if (response !== undefined) samples[idx].response = String(response);
  if (system !== undefined) samples[idx].system = String(system);
  if (tags !== undefined) samples[idx].tags = Array.isArray(tags) ? tags : [];
  samples[idx].updatedAt = Date.now();
  saveAllSamples(samples);
  res.json({ ok: true, sample: samples[idx] });
});

// サンプル削除
app.delete('/tuning/samples/:id', requireAuth, (req, res) => {
  const samples = loadAllSamples();
  const idx = samples.findIndex(s => s.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  const removed = samples.splice(idx, 1)[0];
  saveAllSamples(samples);
  res.json({ ok: true, removed });
});

// 全サンプル削除
app.delete('/tuning/samples', requireAuth, (req, res) => {
  saveAllSamples([]);
  res.json({ ok: true });
});

// CSV/JSONLインポート
app.post('/tuning/samples/import', requireAuth, jsonParser, (req, res) => {
  const { format, content } = req.body || {};
  if (!content) return res.status(400).json({ error: 'content が必要です' });
  const samples = loadAllSamples();
  let added = 0;
  try {
    if (format === 'jsonl') {
      const lines = content.split('\n').filter(l => l.trim() && !l.trim().startsWith('//'));
      for (const line of lines) {
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }

        // マルチターン形式: {"messages": [{"role": "user|assistant|system", "content": "..."}]}
        if (Array.isArray(obj.messages) && obj.messages.length >= 2) {
          // 検証: 各メッセージに role と content が必要
          const valid = obj.messages.every(m =>
            m && typeof m === 'object' &&
            ['system', 'user', 'assistant'].includes(m.role) &&
            typeof m.content === 'string'
          );
          if (!valid) continue;
          // 最後の assistant メッセージがないと学習対象がないのでスキップ
          const lastMsg = obj.messages[obj.messages.length - 1];
          if (lastMsg.role !== 'assistant') continue;
          samples.push({
            id: generateSampleId(),
            messages: obj.messages,  // マルチターン形式そのまま保存
            tags: Array.isArray(obj.tags) ? obj.tags : [],
            createdAt: Date.now(),
          });
          added++;
          continue;
        }

        // シングルターン形式: {"instruction": "...", "response": "...", "system": "..."}
        if (!obj.instruction || !obj.response) continue;
        samples.push({
          id: generateSampleId(),
          instruction: String(obj.instruction),
          response: String(obj.response),
          system: obj.system ? String(obj.system) : '',
          tags: Array.isArray(obj.tags) ? obj.tags : [],
          createdAt: Date.now(),
        });
        added++;
      }
    } else if (format === 'csv') {
      // 簡易CSVパーサー: 1行目をヘッダーとして使う
      const lines = content.split('\n').filter(l => l.trim());
      if (lines.length < 2) return res.status(400).json({ error: 'CSVが空です' });
      const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
      const instructionIdx = headers.indexOf('instruction');
      const responseIdx = headers.indexOf('response');
      const systemIdx = headers.indexOf('system');
      if (instructionIdx < 0 || responseIdx < 0) {
        return res.status(400).json({ error: 'CSVに instruction と response カラムが必要です' });
      }
      for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i]);
        if (cols.length <= Math.max(instructionIdx, responseIdx)) continue;
        const instruction = (cols[instructionIdx] || '').trim();
        const response = (cols[responseIdx] || '').trim();
        if (!instruction || !response) continue;
        samples.push({
          id: generateSampleId(),
          instruction,
          response,
          system: systemIdx >= 0 ? (cols[systemIdx] || '').trim() : '',
          tags: [],
          createdAt: Date.now(),
        });
        added++;
      }
    } else {
      return res.status(400).json({ error: 'format は "csv" または "jsonl"' });
    }
    saveAllSamples(samples);
    res.json({ ok: true, added, total: samples.length });
  } catch (e) {
    res.status(400).json({ error: `パースエラー: ${e.message}` });
  }
});

// シンプルなCSV行パーサー（クォート対応）
function parseCsvLine(line) {
  const result = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuote = false; }
      else { cur += c; }
    } else {
      if (c === '"') inQuote = true;
      else if (c === ',') { result.push(cur); cur = ''; }
      else cur += c;
    }
  }
  result.push(cur);
  return result;
}

// エクスポート (JSONL形式でダウンロード)
app.get('/tuning/samples/export', requireAuth, (req, res) => {
  const samples = loadAllSamples();
  const jsonl = samples.map(s => {
    // マルチターン形式のサンプルはそのまま出力
    if (Array.isArray(s.messages)) {
      return JSON.stringify({
        messages: s.messages,
        tags: s.tags && s.tags.length > 0 ? s.tags : undefined,
      });
    }
    // シングルターン形式
    return JSON.stringify({
      instruction: s.instruction,
      response: s.response,
      system: s.system || undefined,
      tags: s.tags && s.tags.length > 0 ? s.tags : undefined,
    });
  }).join('\n');
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Content-Disposition', 'attachment; filename="training_samples.jsonl"');
  res.send(jsonl);
});

// ─── ジョブ管理 ───

function loadJobs() {
  if (!fs.existsSync(TUNING_JOBS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(TUNING_JOBS_FILE, 'utf-8'));
  } catch { return []; }
}

function saveJobs(jobs) {
  fs.writeFileSync(TUNING_JOBS_FILE, JSON.stringify(jobs, null, 2));
}

// サーバー起動時に呼ぶ: 前回の実行中にサーバーが落ちた場合、jobs.json には
// status:'running' のジョブが残るが実プロセスは死んでいる。これを 'interrupted'
// に補正して、UIで永遠に「実行中」と表示され続けるのを防ぐ。
function reconcileStaleJobs() {
  try {
    const jobs = loadJobs();
    let changed = false;
    for (const j of jobs) {
      if (j.status === 'running') {
        j.status = 'interrupted';
        j.endedAt = j.endedAt || Date.now();
        changed = true;
      }
    }
    if (changed) { saveJobs(jobs); log('-', '[起動] 中断されたファインチューニングジョブを補正しました'); }
  } catch {}
  // 画像学習ジョブ側は実行中を履歴に入れない設計なので補正不要
}
reconcileStaleJobs();

function generateJobId() {
  return 'j_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ジョブ一覧
app.get('/tuning/jobs', requireAuth, (req, res) => {
  const jobs = loadJobs();
  res.json({ jobs, current: currentTuningJob ? currentTuningJob.id : null });
});

// ジョブ開始
app.post('/tuning/jobs', requireAuth, jsonParser, async (req, res) => {
  const ip = getIP(req);
  if (currentTuningJob) {
    return res.status(409).json({ error: '既にジョブが実行中です' });
  }
  const samples = loadAllSamples();
  if (samples.length === 0) {
    return res.status(400).json({ error: '学習サンプルがありません' });
  }
  const {
    baseModel,           // HuggingFace model ID (例: "Qwen/Qwen2.5-7B-Instruct")
    outputName,          // 出力モデル名 (任意)
    method = 'lora',     // 'lora' | 'qlora' | 'full'
    epochs = 3,
    learningRate = 0.0002,
    batchSize = 2,
    gradAccumSteps = 4,
    loraR = 16,
    loraAlpha = 32,
    loraDropout = 0.05,
    maxSeqLength = 2048,
    systemPrompt = '',   // 全サンプルに適用するデフォルトsystem
  } = req.body || {};

  if (!baseModel) return res.status(400).json({ error: 'baseModel を指定してください' });

  const jobId = generateJobId();
  const jobDir = path.join(TUNING_RUNS_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  // 学習データを JSONL で保存
  // - マルチターン形式 (s.messages あり) はそのまま messages を出力
  // - シングルターン形式 (s.instruction, s.response) は instruction/response/system 形式
  // tune_runner.py 側がどちらの形式も受け付ける (to_messages 関数)
  const dataPath = path.join(jobDir, 'train.jsonl');
  fs.writeFileSync(dataPath, samples.map(s => {
    if (Array.isArray(s.messages)) {
      return JSON.stringify({ messages: s.messages });
    }
    return JSON.stringify({
      instruction: s.instruction,
      response: s.response,
      system: s.system || '',
    });
  }).join('\n'));

  // 設定保存
  const config = {
    jobId,
    baseModel,
    outputName: outputName || `tuned-${jobId}`,
    method, epochs, learningRate, batchSize, gradAccumSteps,
    loraR, loraAlpha, loraDropout, maxSeqLength,
    systemPrompt,
    sampleCount: samples.length,
    startedAt: Date.now(),
  };
  fs.writeFileSync(path.join(jobDir, 'config.json'), JSON.stringify(config, null, 2));

  // Python実行
  const pythonPath = appConfig.tuning?.pythonPath || appConfig.pythonPath || 'python3';
  const tuneScript = path.join(__dirname, 'tune_runner.py');
  if (!fs.existsSync(tuneScript)) {
    return res.status(500).json({ error: `tune_runner.py が見つかりません: ${tuneScript}` });
  }

  log(ip, `TUNING START: ${jobId} baseModel=${baseModel} samples=${samples.length}`);
  const logPath = path.join(jobDir, 'training.log');
  const logStream = fs.createWriteStream(logPath);
  // ログstreamのエラー (ディスク不足・権限等) でクラッシュしないように
  logStream.on('error', (err) => { log('-', `[tuning ${jobId}] ログ書き込みエラー: ${err.message}`); });
  // 環境変数: AMD Radeon AI PRO R9700 (gfx1201) 安定化対策
  // config.json の tuning.env で上書き可能（旧 tuningEnv も互換維持）
  const tuningEnv = {
    HSA_OVERRIDE_GFX_VERSION: '12.0.1',
    PYTORCH_HIP_ALLOC_CONF: 'expandable_segments:True',
    HIP_VISIBLE_DEVICES: '0',  // 単一GPU限定（マルチGPU環境での暴走防止）
    // HuggingFace / Transformers のモデル・トークナイザのキャッシュ先を、
    // 書き込み可能なアプリ内ディレクトリに明示する。本番では ~/.cache が
    // systemd の ProtectHome 等で読み取り専用のことがあるため必須。
    HF_HOME: TUNING_HF_CACHE_DIR,
    HUGGINGFACE_HUB_CACHE: path.join(TUNING_HF_CACHE_DIR, 'hub'),
    TRANSFORMERS_CACHE: TUNING_HF_CACHE_DIR,  // 古いtransformers向けの互換
    XDG_CACHE_HOME: TUNING_HF_CACHE_DIR,      // 他キャッシュ系ライブラリも巻き込んで吸収
    ...(appConfig.tuning?.env || appConfig.tuningEnv || {}),
  };
  const proc = spawn(pythonPath, [tuneScript, jobDir], {
    cwd: __dirname,
    env: { ...process.env, ...tuningEnv, JOB_DIR: jobDir },
    detached: true,  // プロセスグループを作り、停止時に子プロセスごとkillできるように
  });
  // spawn 自体の失敗 (実行ファイルが無い等)。error を捕捉しないと
  // unhandled 'error' イベントで Node プロセス全体がクラッシュする。
  proc.on('error', (err) => {
    try { logStream.write(`\n[プロセス起動エラー] ${err.message}\n`); logStream.end(); } catch {}
    const jobs = loadJobs();
    const j = jobs.find(j => j.id === jobId);
    if (j) { j.status = 'failed'; j.error = err.message; j.endedAt = Date.now(); saveJobs(jobs); }
    log('-', `[tuning ${jobId}] プロセス起動失敗: ${err.message}`);
    currentTuningJob = null;
  });
  // tqdm 等の進捗バーは \r で同じ行を上書きする。そのままログに溜めると
  // \r が大量に連なって読めなくなるため、\r を改行に正規化して書き込む。
  // チャンク境界をまたぐ進捗行に備えて、未確定の末尾だけバッファに残す。
  let logTail = '';
  const writeNormalized = (chunk) => {
    let s = logTail + chunk.toString();
    // \r\n は \n に統一
    s = s.replace(/\r\n/g, '\n');
    // 行を確定する: \n または \r で分割
    // \r は「行の上書き」なので、直前の未確定行を捨てて新しい行にする
    const parts = s.split('\n');
    logTail = parts.pop();  // 最後の要素は未確定 (改行待ち)
    for (const line of parts) {
      // 行内に \r があれば最後のセグメントだけ採用 (進捗の最終状態)
      const finalSeg = line.includes('\r') ? line.split('\r').pop() : line;
      try { logStream.write(finalSeg + '\n'); } catch {}
    }
    // 未確定行に \r が含まれる (進捗更新中) なら最後のセグメントだけ保持
    if (logTail.includes('\r')) logTail = logTail.split('\r').pop();
  };
  proc.stdout.on('data', writeNormalized);
  proc.stderr.on('data', writeNormalized);
  proc.on('exit', (code) => {
    if (logTail) { try { logStream.write(logTail + '\n'); } catch {} logTail = ''; }
    logStream.end();
    const jobs = loadJobs();
    const j = jobs.find(j => j.id === jobId);
    if (j) {
      // ユーザーが停止した (cancelled) 場合は、kill による非0 exit で
      // 'failed' に上書きしない。意図的な中断と異常終了を区別する。
      if (j.status !== 'cancelled') {
        j.status = code === 0 ? 'completed' : 'failed';
      }
      j.exitCode = code;
      j.endedAt = Date.now();
      saveJobs(jobs);
    }
    log('-', `[tuning ${jobId}] 終了 code=${code} (status=${j ? j.status : '?'})`);
    currentTuningJob = null;
  });

  // ジョブ記録に追加
  const jobs = loadJobs();
  jobs.unshift({
    id: jobId, ...config,
    status: 'running',
    pid: proc.pid,
  });
  saveJobs(jobs);
  currentTuningJob = { id: jobId, proc, dir: jobDir };

  res.json({ ok: true, jobId });
});

// ジョブログ取得
app.get('/tuning/jobs/:id/log', requireAuth, (req, res) => {
  const jobId = req.params.id;
  // jobId のバリデーション (パストラバーサル防止)
  if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) return res.status(400).json({ error: '無効なジョブID' });
  const logPath = path.join(TUNING_RUNS_DIR, jobId, 'training.log');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  // ログファイルがまだ作られていない (学習開始直後等) は空文字を返す
  // 404にするとフロント側が「ログ読み込み中」のまま固まるため
  if (!fs.existsSync(logPath)) return res.status(200).send('');
  fs.createReadStream(logPath).pipe(res);
});

// ジョブ中断
app.post('/tuning/jobs/:id/stop', requireAuth, (req, res) => {
  if (!currentTuningJob || currentTuningJob.id !== req.params.id) {
    return res.status(404).json({ error: '実行中ジョブではありません' });
  }
  const proc = currentTuningJob.proc;
  const pid = proc && proc.pid;
  // detached で起動しているので、プロセスグループ全体 (-pid) に送ると
  // PyTorch が生成した子プロセスごと止められる。
  const killGroup = (sig) => {
    if (!pid) return;
    try { process.kill(-pid, sig); }      // プロセスグループ
    catch { try { proc.kill(sig); } catch {} }  // 失敗時は親だけ
  };
  killGroup('SIGTERM');
  setTimeout(() => {
    if (currentTuningJob && currentTuningJob.proc && currentTuningJob.proc.pid === pid) {
      killGroup('SIGKILL');
    }
  }, 5000);
  const jobs = loadJobs();
  const j = jobs.find(j => j.id === req.params.id);
  if (j) { j.status = 'cancelled'; j.endedAt = Date.now(); saveJobs(jobs); }
  res.json({ ok: true });
});

// ジョブ削除（履歴とアーティファクトを消す）
app.delete('/tuning/jobs/:id', requireAuth, (req, res) => {
  const jobId = req.params.id;
  if (currentTuningJob && currentTuningJob.id === jobId) {
    return res.status(409).json({ error: '実行中ジョブは削除できません。先に停止してください' });
  }
  const jobs = loadJobs();
  const idx = jobs.findIndex(j => j.id === jobId);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  jobs.splice(idx, 1);
  saveJobs(jobs);
  // ディレクトリ削除
  const jobDir = path.join(TUNING_RUNS_DIR, jobId);
  if (fs.existsSync(jobDir)) {
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
  }
  res.json({ ok: true });
});

// ─── 後工程: マージ + GGUF + 量子化 ───
// 学習完了後にアダプタをベースモデルにマージし、GGUF化、必要なら量子化する
//
// POST /tuning/jobs/:id/postprocess
// body: { quantize?: "Q4_K_M" | "Q5_K_M" | "Q8_0" | "f16" | null }
//
// 内部的に下記を順次実行（バックグラウンド）:
//   1. python merge_adapter.py <job_dir>             → <job_dir>/merged/
//   2. python convert_hf_to_gguf.py merged --outfile <out>.gguf --outtype f16
//   3. llama-quantize <out>.gguf <out>-Q4_K_M.gguf Q4_K_M  (任意)

let currentPostprocess = null;  // { jobId, proc, step }

app.post('/tuning/jobs/:id/postprocess', requireAuth, jsonParser, (req, res) => {
  const ip = getIP(req);
  if (currentPostprocess) {
    return res.status(409).json({ error: '別の後処理が実行中です' });
  }
  const jobId = req.params.id;
  const jobDir = path.join(TUNING_RUNS_DIR, jobId);
  if (!fs.existsSync(jobDir)) return res.status(404).json({ error: 'ジョブが見つかりません' });

  const adapterDir = path.join(jobDir, 'adapter');
  if (!fs.existsSync(adapterDir)) {
    return res.status(400).json({ error: '学習が完了していません（adapterがありません）' });
  }

  const { quantize = null, llamaCppDir = null } = req.body || {};
  const validQuants = ['Q2_K', 'Q3_K_M', 'Q4_K_S', 'Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0', 'f16', 'bf16', null];
  if (quantize !== null && !validQuants.includes(quantize)) {
    return res.status(400).json({ error: `quantize は次のいずれか: ${validQuants.join(', ')}` });
  }

  const jobConfig = JSON.parse(fs.readFileSync(path.join(jobDir, 'config.json'), 'utf-8'));
  const outputName = jobConfig.outputName || `tuned-${jobId}`;

  // llama.cpp ディレクトリ
  const llamaDir = llamaCppDir || appConfig.tuning?.llamaCppDir || appConfig.llamaCppDir || path.join(process.env.HOME || '', 'llama.cpp');
  if (!fs.existsSync(llamaDir)) {
    return res.status(400).json({
      error: `llama.cpp ディレクトリが見つかりません: ${llamaDir} (config.json で llamaCppDir を指定するか、~/llama.cpp に配置してください)`
    });
  }

  const postLogPath = path.join(jobDir, 'postprocess.log');
  const postLog = fs.createWriteStream(postLogPath);
  const pythonPath = appConfig.tuning?.pythonPath || appConfig.pythonPath || 'python3';

  function runStep(label, cmd, args, cwd, onDone) {
    postLog.write(`\n=== ${label} ===\n`);
    postLog.write(`$ ${cmd} ${args.join(' ')}\n`);
    // 後処理 (マージ・GGUF変換) も tokenizer をロードするため、
    // HuggingFace キャッシュ先をアプリ内に明示する (本番の ~/.cache 読み取り専用対策)
    const postEnv = {
      ...process.env,
      HF_HOME: TUNING_HF_CACHE_DIR,
      HUGGINGFACE_HUB_CACHE: path.join(TUNING_HF_CACHE_DIR, 'hub'),
      TRANSFORMERS_CACHE: TUNING_HF_CACHE_DIR,
      XDG_CACHE_HOME: TUNING_HF_CACHE_DIR,
    };
    const p = spawn(cmd, args, { cwd, env: postEnv });
    currentPostprocess = { jobId, proc: p, step: label };
    let errored = false;
    p.on('error', (err) => {
      // 実行ファイルが無い等。捕捉しないとサーバーがクラッシュする
      errored = true;
      postLog.write(`\n[${label}] プロセス起動エラー: ${err.message}\n`);
      onDone(-1);
    });
    p.stdout.on('data', d => postLog.write(d));
    p.stderr.on('data', d => postLog.write(d));
    p.on('exit', (code) => {
      if (errored) return;  // error後のexitは二重処理しない
      postLog.write(`\n[${label}] exit code=${code}\n`);
      onDone(code);
    });
  }

  function step1Merge() {
    const mergeScript = path.join(__dirname, 'merge_adapter.py');
    if (!fs.existsSync(mergeScript)) {
      postLog.end(`ERROR: merge_adapter.py が見つかりません: ${mergeScript}\n`);
      currentPostprocess = null;
      return;
    }
    runStep('Step 1: マージ', pythonPath, [mergeScript, jobDir], __dirname, (code) => {
      if (code !== 0) { postLog.end(`マージ失敗 code=${code}\n`); currentPostprocess = null; return; }
      step2Gguf();
    });
  }

  function step2Gguf() {
    const mergedDir = path.join(jobDir, 'merged');
    if (!fs.existsSync(mergedDir)) {
      postLog.end(`ERROR: マージ済みモデルがありません: ${mergedDir}\n`);
      currentPostprocess = null;
      return;
    }
    const convertScript = path.join(llamaDir, 'convert_hf_to_gguf.py');
    if (!fs.existsSync(convertScript)) {
      postLog.end(`ERROR: convert_hf_to_gguf.py が見つかりません: ${convertScript}\n`);
      currentPostprocess = null;
      return;
    }
    const ggufFile = path.join(jobDir, `${outputName}.gguf`);
    runStep('Step 2: GGUF変換',
      pythonPath, [convertScript, mergedDir, '--outfile', ggufFile, '--outtype', 'f16'],
      llamaDir,
      (code) => {
        if (code !== 0) { postLog.end(`GGUF変換失敗 code=${code}\n`); currentPostprocess = null; return; }
        if (quantize && quantize !== 'f16' && quantize !== 'bf16') step3Quantize(ggufFile);
        else finalize(ggufFile);
      });
  }

  function step3Quantize(ggufFile) {
    const quantBin = path.join(llamaDir, 'build', 'bin', 'llama-quantize');
    if (!fs.existsSync(quantBin)) {
      postLog.end(`ERROR: llama-quantize が見つかりません: ${quantBin}\n`);
      currentPostprocess = null;
      return;
    }
    const quantFile = path.join(jobDir, `${outputName}-${quantize}.gguf`);
    runStep(`Step 3: 量子化 (${quantize})`,
      quantBin, [ggufFile, quantFile, quantize],
      llamaDir,
      (code) => {
        if (code !== 0) { postLog.end(`量子化失敗 code=${code}\n`); currentPostprocess = null; return; }
        finalize(quantFile);
      });
  }

  function finalize(finalGgufFile) {
    // ファイルサイズ取得（人間に読める形式に変換）
    let fileSizeStr = '';
    if (finalGgufFile && fs.existsSync(finalGgufFile)) {
      const sizeBytes = fs.statSync(finalGgufFile).size;
      const sizeMB = sizeBytes / (1024 * 1024);
      const sizeGB = sizeMB / 1024;
      fileSizeStr = sizeGB >= 1 ? `${sizeGB.toFixed(2)} GB` : `${sizeMB.toFixed(1)} MB`;
    }

    postLog.write('\n');
    postLog.write('=====================================================\n');
    postLog.write('  ✅ 後処理完了\n');
    postLog.write('=====================================================\n');
    if (finalGgufFile) {
      postLog.write(`\n📦 生成されたGGUFファイル:\n`);
      postLog.write(`   ${finalGgufFile}\n`);
      if (fileSizeStr) postLog.write(`   (サイズ: ${fileSizeStr})\n`);
      postLog.write(`\n💡 使い方:\n`);
      postLog.write(`   1) config.json の models[] にこのパスを追加してチャットに組み込み\n`);
      postLog.write(`   2) または llama-server で直接起動:\n`);
      postLog.write(`      llama-server -m "${finalGgufFile}" --port 8080 -c 4096 -ngl 99 -fa on\n`);
    }
    postLog.write('\n');
    postLog.end();

    // ジョブ情報に postprocess 完了 + 最終GGUFパスを記録
    const jobs = loadJobs();
    const j = jobs.find(j => j.id === jobId);
    if (j) {
      j.postprocessStatus = 'completed';
      j.postprocessEndedAt = Date.now();
      if (finalGgufFile) {
        j.ggufPath = finalGgufFile;
        try {
          j.ggufSize = fs.statSync(finalGgufFile).size;
        } catch {}
      }
      saveJobs(jobs);
    }
    currentPostprocess = null;
    log('-', `[tuning ${jobId}] 後処理完了 → ${finalGgufFile || '(GGUF生成なし)'}`);
  }

  log(ip, `TUNING POSTPROCESS START: ${jobId} quantize=${quantize}`);
  step1Merge();
  res.json({ ok: true, message: '後処理を開始しました。/tuning/jobs/:id/postprocess-log でログを確認できます' });
});

// 後処理ログ取得
app.get('/tuning/jobs/:id/postprocess-log', requireAuth, (req, res) => {
  const jobId = req.params.id;
  const logPath = path.join(TUNING_RUNS_DIR, jobId, 'postprocess.log');
  if (!fs.existsSync(logPath)) return res.status(404).json({ error: 'ログがありません' });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  fs.createReadStream(logPath).pipe(res);
});

// 後処理停止
app.post('/tuning/jobs/:id/postprocess/stop', requireAuth, (req, res) => {
  if (!currentPostprocess || currentPostprocess.jobId !== req.params.id) {
    return res.status(404).json({ error: '後処理は実行中ではありません' });
  }
  try { currentPostprocess.proc.kill('SIGTERM'); } catch {}
  res.json({ ok: true });
});

// ジョブのアーティファクト一覧（gguf等）
app.get('/tuning/jobs/:id/artifacts', requireAuth, (req, res) => {
  const jobId = req.params.id;
  const jobDir = path.join(TUNING_RUNS_DIR, jobId);
  if (!fs.existsSync(jobDir)) return res.status(404).json({ error: 'ジョブが見つかりません' });
  const artifacts = [];
  for (const f of fs.readdirSync(jobDir)) {
    const fp = path.join(jobDir, f);
    const st = fs.statSync(fp);
    if (st.isFile()) {
      artifacts.push({
        name: f,
        size: st.size,
        sizeHuman: (st.size > 1024 * 1024) ? `${(st.size / 1024 / 1024).toFixed(1)} MB` : `${(st.size / 1024).toFixed(1)} KB`,
        downloadable: f.endsWith('.gguf') || f.endsWith('.log') || f.endsWith('.json'),
      });
    }
  }
  res.json({ artifacts, jobDir });
});

// アーティファクトダウンロード
app.get('/tuning/jobs/:id/artifacts/:name', requireAuth, (req, res) => {
  const jobId = req.params.id;
  const name = req.params.name;
  // ディレクトリトラバーサル防止
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    return res.status(400).json({ error: 'Invalid name' });
  }
  const fp = path.join(TUNING_RUNS_DIR, jobId, name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  fs.createReadStream(fp).pipe(res);
});

// ─── GPU ステータス (SSE) ───
const GPU_INTERVAL = parseInt(process.env.GPU_INTERVAL) || 1000;
let gpuBackend = null; // 'amd' | 'rocm' | 'nvidia' | 'none'

// 初回のみフィールド一覧をログに出力
let amdSmiFieldsLogged = false;
let rocmSmiFieldsLogged = false;

// amd-smi はROCm 6.x以降の新しい標準ツール
// 出力構造:
//   { "gpu_data": [ { gpu: 0, asic: {...}, vram: {...}, clock: {...}, ... }, ... ] }
// 注意: トップレベルは "gpu_data" でラップされている（配列ではない）

function execAmdSmi(args) {
  return new Promise((resolve) => {
    const proc = spawn('amd-smi', args, { timeout: 5000 });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('close', () => {
      try {
        const parsed = JSON.parse(out);
        // gpu_data でラップされている場合はその中身を返す、そうでなければそのまま
        if (parsed && Array.isArray(parsed.gpu_data)) return resolve(parsed.gpu_data);
        if (Array.isArray(parsed)) return resolve(parsed);
        resolve(null);
      } catch {
        resolve(null);
      }
    });
    proc.on('error', () => resolve(null));
  });
}

// 値ヘルパー
function amdVal(v) {
  if (v == null || v === 'N/A') return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && v.value != null && v.value !== 'N/A') return parseFloat(v.value) || 0;
  return parseFloat(v) || 0;
}

// 文字列から先頭の数値を抜き出す ("1040MHz" → 1040)
function amdParseClock(s) {
  if (!s || s === 'N/A') return 0;
  if (typeof s === 'object') {
    return amdParseClock(s.current_frequency ?? s.value ?? s.current);
  }
  const m = String(s).match(/(\d+(?:\.\d+)?)/);
  return m ? parseInt(m[1]) : 0;
}

async function parseAmdSmi() {
  const [staticData, metricData] = await Promise.all([
    execAmdSmi(['static', '--json']),
    execAmdSmi(['metric', '--json']),
  ]);

  // staticData だけでも基本情報は出せるよう、両方なくても落ちないように
  const staticArr = Array.isArray(staticData) ? staticData : [];
  const metricArr = Array.isArray(metricData) ? metricData : [];

  // gpu番号でstatic/metricをマップ化
  const staticByGpu = {};
  for (const item of staticArr) {
    const num = item.gpu ?? item.gpu_id;
    if (typeof num === 'number') staticByGpu[num] = item;
  }
  const metricByGpu = {};
  for (const item of metricArr) {
    const num = item.gpu ?? item.gpu_id;
    if (typeof num === 'number') metricByGpu[num] = item;
  }

  // staticとmetricのGPU番号を統合
  const allGpuNums = new Set([
    ...Object.keys(staticByGpu).map(Number),
    ...Object.keys(metricByGpu).map(Number),
  ]);

  const gpus = [];
  for (const gpuNum of [...allGpuNums].sort((a, b) => a - b)) {
    const st = staticByGpu[gpuNum] || {};
    const mt = metricByGpu[gpuNum] || {};

    if (!amdSmiFieldsLogged) {
      console.log(`[amd-smi gpu${gpuNum}] static キー:`, Object.keys(st).sort());
      console.log(`[amd-smi gpu${gpuNum}] metric キー:`, Object.keys(mt).sort());
      for (const k of ['power', 'temperature', 'usage', 'mem_usage', 'fb_usage']) {
        if (mt[k]) console.log(`  metric.${k}:`, JSON.stringify(mt[k]).slice(0, 200));
      }
    }

    const asic = st.asic || mt.asic || {};
    const vram = st.vram || {};
    const clock = st.clock || mt.clock || {};

    // ─── iGPU除外 ───
    // 1. target_graphics_version で gfx10[345]x はiGPU（Phoenix, Raphael, Rembrandt等）
    // 2. compute units が極端に少ない（R9700は64、iGPU Raphael は2）
    // 3. VRAMサイズが2GB以下
    const gfxVer = asic.target_graphics_version || '';
    const numCU = asic.num_compute_units || 0;
    const vramMB = amdVal(vram.size);
    const isIGPU =
      /^gfx10(3[3-9]|4[0-9])/.test(gfxVer) ||  // gfx103x/104x はAPU
      (numCU > 0 && numCU < 8) ||              // 8CU未満はiGPU
      (vramMB > 0 && vramMB <= 4096);          // VRAM 4GB以下はiGPU
    if (isIGPU) continue;

    const gpu = { id: `gpu${gpuNum}` };

    // ─── 製品名 (static.asic.market_name が確実) ───
    gpu.name = asic.market_name || asic.product_name ||
               (st.board?.product_name && st.board.product_name !== 'N/A' ? st.board.product_name : null) ||
               '';
    if (typeof gpu.name === 'object') gpu.name = '';
    gpu.name = String(gpu.name || '').trim();
    if (/^(n\/a|none|null|unknown)$/i.test(gpu.name)) gpu.name = '';

    // ─── 使用率 ───
    const usage = mt.usage || {};
    gpu.usage = parseInt(amdVal(usage.gfx_activity ?? usage.gpu_activity)) || 0;

    // ─── 温度 ───
    const temp = mt.temperature || {};
    gpu.temp = amdVal(temp.edge ?? temp.edge_temperature);
    gpu.tempHotspot = amdVal(temp.hotspot ?? temp.junction ?? temp.hotspot_temperature);
    gpu.tempMem = amdVal(temp.mem ?? temp.memory ?? temp.vram ?? temp.hbm);

    // ─── 電力 ───
    const power = mt.power || {};
    gpu.power = amdVal(power.current_socket_power ?? power.socket_power ??
                        power.average_socket_power ?? power.gfx);

    // ─── VRAM ───
    // amd-smi 26.x では mem_usage を使う (旧バージョンでは fb_usage / vram_usage)
    // static.vram.size.value = 30576 (MB) を総容量として優先
    const mem = mt.mem_usage || mt.fb_usage || mt.vram_usage || {};
    // 使用量フィールド候補: used_vram (amd-smi 26.x) / used / vram_used
    const totalMB = vramMB || amdVal(mem.total_vram ?? mem.total ?? mem.vram_total);
    const usedMB = amdVal(mem.used_vram ?? mem.used ?? mem.vram_used);
    gpu.vramTotalMB = totalMB;
    gpu.vramUsedMB = usedMB;
    gpu.vramPct = totalMB > 0 ? Math.round(usedMB / totalMB * 100) : 0;

    // ─── クロック ("1040MHz" 形式) ───
    // static.clock.sys.current_frequency や metric.clock.gfx を見る
    gpu.sclk = amdParseClock(clock.sys ?? clock.gfx ?? clock.gfxclk);
    gpu.mclk = amdParseClock(clock.mem ?? clock.memclk ?? clock.memory);

    gpus.push(gpu);
  }

  amdSmiFieldsLogged = true;
  return gpus;
}

function parseRocmSmi() {
  return new Promise((resolve) => {
    const proc = spawn('rocm-smi', ['--showuse', '-t', '-P', '--showmeminfo', 'vram', '-c', '--json'], {
      timeout: 5000,
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('close', () => {
      try {
        const data = JSON.parse(out);
        const gpus = [];
        for (const [key, val] of Object.entries(data)) {
          if (!key.startsWith('card')) continue;
          const gpu = { id: key };

          // 初回のみフィールド名を全部ログ出力（デバッグ用）
          if (!rocmSmiFieldsLogged) {
            console.log(`[rocm-smi ${key}] 利用可能なフィールド:`, Object.keys(val).sort());
          }

          // GPU使用率
          gpu.usage = parseInt(val['GPU use (%)']) || 0;

          // 温度
          gpu.temp = parseFloat(val['Temperature (Sensor edge) (C)']) || 0;
          gpu.tempHotspot = parseFloat(val['Temperature (Sensor junction) (C)']) || 0;
          gpu.tempMem = parseFloat(val['Temperature (Sensor memory) (C)']) || 0;

          // 電力 (キー名がカードによって異なる)
          const powerKey = Object.keys(val).find(k => /power/i.test(k) && /\(W\)/.test(k));
          gpu.power = powerKey ? parseFloat(val[powerKey]) || 0 : 0;

          // VRAM (バイト → MB)
          const vramTotal = parseInt(val['VRAM Total Memory (B)']) || 0;
          const vramUsed = parseInt(val['VRAM Total Used Memory (B)']) || 0;
          gpu.vramTotalMB = Math.round(vramTotal / 1048576);
          gpu.vramUsedMB = Math.round(vramUsed / 1048576);
          gpu.vramPct = vramTotal > 0 ? Math.round(vramUsed / vramTotal * 100) : 0;

          // クロック (値が "(3480Mhz)" 形式)
          const parseClock = (key) => {
            const v = val[key];
            if (!v) return 0;
            const m = v.match(/\((\d+)Mhz\)/i);
            return m ? parseInt(m[1]) : 0;
          };
          gpu.sclk = parseClock('sclk clock speed:');
          gpu.mclk = parseClock('mclk clock speed:');

          // GPU 製品名: rocm-smi のバージョンで大きく変動するので幅広く探す
          // 完全マッチで試したあと、見つからなければ部分マッチで探す
          const exactKeys = [
            'Card Series', 'Card Model', 'Card SKU',
            'GFX Version', 'Device Name', 'Product Name', 'Marketing Name',
          ];
          for (const k of exactKeys) {
            if (val[k] && typeof val[k] === 'string' && val[k].trim()) {
              gpu.name = val[k].trim();
              break;
            }
          }
          // 部分マッチ: "name", "series", "model", "product" を含むキー
          if (!gpu.name) {
            const fallbackKey = Object.keys(val).find(k =>
              /\b(name|series|model|product|marketing)\b/i.test(k) &&
              !/path|node|number|id|guid|uuid|firmware|driver|version|date|count|level/i.test(k)
            );
            if (fallbackKey && val[fallbackKey]) {
              gpu.name = String(val[fallbackKey]).trim();
            }
          }
          // "0x73a5" のような16進ID形式は捨てる
          if (gpu.name && /^0x[0-9a-f]+$/i.test(gpu.name)) gpu.name = '';
          // "N/A" や空文字も捨てる
          if (gpu.name && /^(n\/a|none|null|unknown)$/i.test(gpu.name)) gpu.name = '';

          gpus.push(gpu);
        }
        rocmSmiFieldsLogged = true;
        // card番号でソート
        gpus.sort((a, b) => {
          const na = parseInt(a.id.replace('card', ''));
          const nb = parseInt(b.id.replace('card', ''));
          return na - nb;
        });
        resolve(gpus);
      } catch {
        resolve([]);
      }
    });
    proc.on('error', () => resolve([]));
  });
}

function parseNvidiaSmi() {
  return new Promise((resolve) => {
    const proc = spawn('nvidia-smi', [
      '--query-gpu=index,name,utilization.gpu,temperature.gpu,power.draw,clocks.gr,clocks.mem,memory.total,memory.used',
      '--format=csv,noheader,nounits',
    ], { timeout: 5000 });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('close', () => {
      try {
        const gpus = [];
        for (const line of out.trim().split('\n')) {
          if (!line.trim()) continue;
          const cols = line.split(',').map(s => s.trim());
          if (cols.length < 9) continue;
          const vramTotal = parseFloat(cols[7]) || 0;
          const vramUsed = parseFloat(cols[8]) || 0;
          gpus.push({
            id: `GPU ${cols[0]}`,
            name: cols[1],
            usage: parseInt(cols[2]) || 0,
            temp: parseFloat(cols[3]) || 0,
            tempHotspot: 0,
            tempMem: 0,
            power: parseFloat(cols[4]) || 0,
            sclk: parseInt(cols[5]) || 0,
            mclk: parseInt(cols[6]) || 0,
            vramTotalMB: Math.round(vramTotal),
            vramUsedMB: Math.round(vramUsed),
            vramPct: vramTotal > 0 ? Math.round(vramUsed / vramTotal * 100) : 0,
          });
        }
        resolve(gpus);
      } catch {
        resolve([]);
      }
    });
    proc.on('error', () => resolve([]));
  });
}

async function queryGpu() {
  if (gpuBackend === 'none') return [];
  if (gpuBackend === 'amd') return parseAmdSmi();
  if (gpuBackend === 'nvidia') return parseNvidiaSmi();
  if (gpuBackend === 'rocm') return parseRocmSmi();

  // 初回: 自動検出（amd-smi → rocm-smi → nvidia-smi の順）
  // amd-smi はROCm 6.x以降の新標準。GPU名やセンサー値が正確に取れる
  const amd = await parseAmdSmi();
  if (amd.length > 0) { gpuBackend = 'amd'; console.log('  GPU backend: amd-smi'); return amd; }
  const rocm = await parseRocmSmi();
  if (rocm.length > 0) { gpuBackend = 'rocm'; console.log('  GPU backend: rocm-smi'); return rocm; }
  const nv = await parseNvidiaSmi();
  if (nv.length > 0) { gpuBackend = 'nvidia'; console.log('  GPU backend: nvidia-smi'); return nv; }
  gpuBackend = 'none';
  console.log('  GPU backend: none (amd-smi / rocm-smi / nvidia-smi not found)');
  return [];
}

// ─── VRAM強制解放 ───
// GPUモニターから、VRAMを掴んでいるプロセスをまとめて落とす。
// 学習を回したい・別のアプリにGPUを譲りたい、といった場面で使う。
// 何をどれだけ解放できたかを返す（押した結果が見えないと不安なため）。
app.post('/gpu/release', requireAuth, jsonParser, async (req, res) => {
  const ip = getIP(req);
  const opts = req.body || {};
  // 明示的に false を指定したものだけ除外する（既定は全部解放）
  const want = (key) => opts[key] !== false;

  await updateGpuData();
  const usedBefore = (cachedGpuData || []).reduce((s, g) => s + (g.vramUsedMB || 0), 0);

  const released = [];
  const errors = [];
  const tryRelease = async (label, condition, fn) => {
    if (!condition) return;
    try { await fn(); released.push(label); }
    catch (e) { errors.push(`${label}: ${e.message}`); }
  };

  // チャットモデル: 次のチャットで自動再ロードされるよう控えておく
  await tryRelease(`チャットモデル(${chatProcModel})`, want('chat') && chatProc, async () => {
    chatProcAutoUnloaded = chatProcModel;
    await stopChatModel();
    chatLastUsed = 0;
  });
  await tryRelease('Embedding', want('embedding') && embedProc, async () => {
    await stopEmbeddingModel();
    embedLastUsed = 0;
  });
  // マルチLLMワーカー
  const workerCount = (() => { try { return llmPool.status().workers.length; } catch { return 0; } })();
  await tryRelease(`マルチLLMワーカー(${workerCount}台)`, want('pool') && workerCount > 0,
    () => llmPool.unloadAll());
  await tryRelease(`画像生成(${sdCurrentModel})`, want('image') && sdProc, () => stopImageModel());
  await tryRelease('音声合成(TTS)', want('tts') && ttsProc, () => stopTtsServer());

  // 外部APIサーバーは意図して公開しているものなので、明示指定がある場合だけ止める
  if (opts.external === true) {
    const running = listExternalServers().filter(s => s.running);
    for (const s of running) {
      try { stopExternalServerProcess(s.id); } catch (e) { errors.push(`外部API ${s.id}: ${e.message}`); }
    }
    if (running.length > 0) released.push(`外部APIサーバー(${running.length}台)`);
  }

  // プロセスの終了とドライバのVRAM解放にはわずかに時間がかかる
  await new Promise(r => setTimeout(r, 1500));
  await updateGpuData();
  const usedAfter = (cachedGpuData || []).reduce((s, g) => s + (g.vramUsedMB || 0), 0);

  log(ip, `GPU RELEASE: ${released.length ? released.join(', ') : '対象なし'}`
    + ` (VRAM ${usedBefore}MB → ${usedAfter}MB)`);

  res.json({
    ok: true,
    released,
    errors,
    vramBeforeMB: usedBefore,
    vramAfterMB: usedAfter,
    freedMB: Math.max(0, usedBefore - usedAfter),
  });
});

// 解放できる対象の一覧（ボタンの有効/無効とラベル表示用）
app.get('/gpu/release/targets', requireAuth, (req, res) => {
  const workers = (() => { try { return llmPool.status().workers; } catch { return []; } })();
  res.json({
    chat: chatProc ? chatProcModel : null,
    embedding: !!embedProc,
    pool: workers.map(w => w.modelName),
    image: sdProc ? (sdCurrentModel || true) : null,
    tts: !!ttsProc,
    external: listExternalServers().filter(s => s.running).length,
  });
});

app.get('/sse/gpu', requireAuth, (req, res) => {
  const ip = getIP(req);
  log(ip, 'SSE GPU connected');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // 即座にキャッシュを送信（updateAllGpuDataはバックグラウンドタイマーが行う）
  const send = () => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(buildGpuSseData())}\n\n`);
    }
  };

  send();
  const timer = setInterval(send, GPU_INTERVAL);

  req.on('close', () => {
    clearInterval(timer);
    log(ip, 'SSE GPU disconnected');
  });
});

// ─── アプリ設定配信 ───

// ─── セッショントークン管理 ───
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24時間
const sessions = new Map(); // token → { ip, expiresAt }

function newSession(ip) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { ip, expiresAt: Date.now() + SESSION_TTL });
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (s.expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// 期限切れセッションを定期清掃
setInterval(() => {
  const now = Date.now();
  for (const [tok, s] of sessions.entries()) {
    if (s.expiresAt < now) sessions.delete(tok);
  }
}, 60 * 60 * 1000);

// ─── ログイン試行レートリミット ───
const loginAttempts = new Map(); // ip → { count, resetAt }
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW = 15 * 60 * 1000; // 15分

function checkLoginRate(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || rec.resetAt < now) {
    loginAttempts.set(ip, { count: 0, resetAt: now + LOGIN_WINDOW });
    return true;
  }
  return rec.count < MAX_LOGIN_ATTEMPTS;
}

function recordLoginFail(ip) {
  const rec = loginAttempts.get(ip);
  if (rec) rec.count++;
}

function resetLoginRate(ip) {
  loginAttempts.delete(ip);
}

// ─── パスワード照合（MD5 / SHA-256両対応）───
// MD5: 32文字hex / SHA-256: 64文字hex
function verifyPassword(input, stored) {
  if (!stored) return false;
  const isSha256 = stored.length === 64;
  const algo = isSha256 ? 'sha256' : 'md5';
  const hash = crypto.createHash(algo).update(input || '').digest('hex');
  // タイミング攻撃対策で定時間比較
  if (hash.length !== stored.length) return false;
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(stored));
}

// ─── 認証ミドルウェア ───
function requireAuth(req, res, next) {
  if (!appConfig.password) return next(); // パスワード未設定なら認証不要
  // 1. CookieまたはX-Auth-Tokenヘッダー (ブラウザ用セッション)
  const cookieToken = (req.headers.cookie || '').split(';')
    .map(c => c.trim())
    .find(c => c.startsWith('wz_session='))?.split('=')[1];
  const headerToken = req.headers['x-auth-token'];
  const token = cookieToken || headerToken;
  if (isValidSession(token)) return next();
  // 2. Authorization: Bearer <token> (API トークン、Python等の外部呼び出し用)
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const apiToken = authHeader.slice(7).trim();
    if (apiToken) {
      const tokens = appConfig.ml?.apiTokens || [];
      const tokenObj = tokens.find(t => t && t.token === apiToken);
      if (tokenObj) {
        req.apiToken = tokenObj;  // ルートで権限チェックできる (req.apiToken.permissions)
        return next();
      }
    }
  }
  res.status(401).json({ error: '認証が必要です' });
}

// API トークンの権限チェック (Cookie セッションは全権限あり)
// 使い方: app.post('/path', requireAuth, requirePermission('ml:write'), handler)
function requirePermission(perm) {
  return (req, res, next) => {
    // Cookie セッション (req.apiToken なし) は全権限とみなす
    if (!req.apiToken) return next();
    const perms = req.apiToken.permissions || [];
    if (perms.includes(perm) || perms.includes('*')) return next();
    return res.status(403).json({
      error: `権限 "${perm}" が必要です (現在のトークンの権限: ${perms.join(', ') || 'none'})`,
    });
  };
}

app.get('/config', (req, res) => {
  // 公開しない: password, llamaServer内のbinPath, embeddingModelの実体パス, ml.apiTokens(機密),
  //             googleDrive の clientId/clientSecret/サービスアカウント鍵(機密)
  const { password, llamaServer, embeddingModel, ml, irodoriTts, googleDrive, ...rest } = appConfig;
  const safeConfig = {
    ...rest,
    // llamaServer情報は最小限のみ
    llamaServer: { chatPort: llamaServer.chatPort, embeddingPort: llamaServer.embeddingPort },
    // ml は enabled のみ公開、apiTokens(機密)は出さない
    ml: { enabled: !!(ml?.enabled) },
  };
  // Google Drive は「使えるか / 書けるか」だけ公開。認証情報は一切出さない
  if (googleDrive) {
    safeConfig.googleDrive = {
      enabled: !!googleDrive.enabled,
      readOnly: !(googleDrive.allowWrite && googleDrive.readOnly === false),
      allowWrite: !!(googleDrive.allowWrite && googleDrive.readOnly === false),
      allowDelete: !!googleDrive.allowDelete,
      authMode: googleDrive.authMode === 'serviceAccount' ? 'serviceAccount' : 'oauth',
    };
  }
  // irodoriTts は機密(command/args/cwd/env/host/port)を伏せ、UI表示用の最小限のみ公開
  if (irodoriTts) {
    safeConfig.irodoriTts = {
      defaultVoice: irodoriTts.defaultVoice || 'sample',
      defaultFormat: irodoriTts.defaultFormat || 'wav',
    };
  }
  safeConfig.hasPassword = !!password;
  // 再起動の検知用。認証前でも取れる必要があるためここに載せる
  // （再起動でセッションが消えるので、認証が要るエンドポイントでは判定できない）
  safeConfig.startedAt = SERVER_STARTED_AT;

  // 既存セッションCookieが有効かどうかを判定
  if (password) {
    const cookieToken = (req.headers.cookie || '').split(';')
      .map(c => c.trim())
      .find(c => c.startsWith('wz_session='))?.split('=')[1];
    safeConfig.authenticated = !!(cookieToken && isValidSession(cookieToken));
  } else {
    safeConfig.authenticated = true;
  }

  res.json(safeConfig);
});

// ─── config.json 編集（認証必須・raw JSON） ───
// editconfig.html から呼ばれる。生のJSONファイル内容を返す/保存する。
// 注意:
// - 保存前に必ずバックアップを作成（config.json.bak.<timestamp>）
// - JSON構文チェックを行う
// - 必須トップレベルキー（chatModels, llamaServer等）の存在確認
// - 保存しても運用中の appConfig は再起動するまで反映されない（注意書きをUIに出す）

app.get('/config/raw', requireAuth, (req, res) => {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    res.type('application/json').send(raw);
  } catch (e) {
    res.status(500).json({ error: `読み込み失敗: ${e.message}` });
  }
});

app.post('/config/raw', requireAuth, express.text({ type: '*/*', limit: '5mb' }), (req, res) => {
  const ip = getIP(req);
  const newContent = req.body;
  if (!newContent || typeof newContent !== 'string') {
    return res.status(400).json({ error: '本文がありません' });
  }

  // JSON構文チェック
  let parsed;
  try {
    parsed = JSON.parse(newContent);
  } catch (e) {
    return res.status(400).json({ error: `JSON構文エラー: ${e.message}` });
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
    return res.status(400).json({ error: 'ルートはオブジェクトである必要があります' });
  }

  // 必須キーの簡易チェック（ある程度の暴発防止）
  const required = ['chatModels', 'llamaServer'];
  const missing = required.filter(k => !(k in parsed));
  if (missing.length > 0) {
    return res.status(400).json({ error: `必須キーが欠落しています: ${missing.join(', ')}` });
  }

  // バックアップ作成
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${CONFIG_FILE}.bak.${ts}`;
    if (fs.existsSync(CONFIG_FILE)) {
      fs.copyFileSync(CONFIG_FILE, backupPath);
    }
    // 古いバックアップを掃除（最新10件のみ保持）
    try {
      const dir = path.dirname(CONFIG_FILE);
      const base = path.basename(CONFIG_FILE);
      const backups = fs.readdirSync(dir)
        .filter(f => f.startsWith(`${base}.bak.`))
        .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      backups.slice(10).forEach(b => {
        try { fs.unlinkSync(path.join(dir, b.f)); } catch {}
      });
    } catch {}
    // pretty-print して保存
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(parsed, null, 2));
    log(ip, `CONFIG SAVED: backup=${path.basename(backupPath)}`);
    res.json({ ok: true, backup: path.basename(backupPath) });
  } catch (e) {
    res.status(500).json({ error: `保存失敗: ${e.message}` });
  }
});

// バックアップ一覧
app.get('/config/backups', requireAuth, (req, res) => {
  try {
    const dir = path.dirname(CONFIG_FILE);
    const base = path.basename(CONFIG_FILE);
    const backups = fs.readdirSync(dir)
      .filter(f => f.startsWith(`${base}.bak.`))
      .map(f => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f, mtime: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json({ backups });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// バックアップから復元
app.post('/config/restore', requireAuth, jsonParser, (req, res) => {
  const ip = getIP(req);
  const { name } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name が必要です' });
  // パストラバーサル対策: basename のみ受け付ける
  const safeName = path.basename(name);
  const base = path.basename(CONFIG_FILE);
  if (!safeName.startsWith(`${base}.bak.`)) {
    return res.status(400).json({ error: 'バックアップファイル名ではありません' });
  }
  const fullPath = path.join(path.dirname(CONFIG_FILE), safeName);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'バックアップが見つかりません' });

  try {
    // 現在のconfigを今のタイムスタンプでバックアップ
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(CONFIG_FILE, `${CONFIG_FILE}.bak.${ts}-before-restore`);
    fs.copyFileSync(fullPath, CONFIG_FILE);
    log(ip, `CONFIG RESTORED FROM ${safeName}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: `復元失敗: ${e.message}` });
  }
});

// ─── HuggingFace GGUF モデルのダウンロード & セットアップ ───
// huggingface.co の GGUF リンクを渡すと、モデルディレクトリにダウンロードして
// config.json の chatModels に自動登録する（1ボタンセットアップ）。
// 進捗は modelDownloadJob にキャッシュし、/config/model-download/status で取得。
let modelDownloadJob = null;
// { id, status:'downloading'|'done'|'error', phase, fileName, modelName,
//   downloadedBytes, totalBytes, percent, error, addedModel, startedAt, finishedAt }

// 新規モデルの保存先ディレクトリを決定（既存モデルと同じ場所を優先）
function getModelsDir() {
  const candidates = [];
  for (const m of (appConfig.chatModels || [])) {
    if (m && m.path) candidates.push(path.dirname(m.path));
  }
  if (appConfig.embeddingModel && appConfig.embeddingModel.path) {
    candidates.push(path.dirname(appConfig.embeddingModel.path));
  }
  for (const d of candidates) {
    try { if (fs.existsSync(d)) return d; } catch {}
  }
  const fallback = candidates[0] || path.join(__dirname, 'models');
  try { fs.mkdirSync(fallback, { recursive: true }); } catch {}
  return fallback;
}

// HuggingFace の blob URL を resolve（ダウンロード可能）URLに正規化
function normalizeHfUrl(u) {
  if (!u || typeof u !== 'string') return { error: 'URLが空です' };
  let url;
  try { url = new URL(u.trim()); } catch { return { error: 'URLの形式が不正です' }; }
  if (url.protocol !== 'https:') return { error: 'https のURLを指定してください' };
  if (url.hostname !== 'huggingface.co' && !url.hostname.endsWith('.huggingface.co')) {
    return { error: 'huggingface.co のURLのみ対応しています' };
  }
  // /blob/ → /resolve/ （ブラウザのプレビューURLでも動くように）
  url.pathname = url.pathname.replace('/blob/', '/resolve/');
  return { url: url.toString() };
}

// host に応じた HTTP ヘッダ（認証トークンは huggingface.co 宛のみ送る）
function hfRequestHeaders(urlStr, token) {
  const h = { 'User-Agent': 'OpenGeekLLMChat-Downloader' };
  try {
    const host = new URL(urlStr).hostname;
    if (token && host === 'huggingface.co') h['Authorization'] = `Bearer ${token}`;
  } catch {}
  return h;
}

// リダイレクト追従つきのファイルダウンロード（大容量GGUF対応・進捗コールバック）
function downloadToFile(urlStr, destPath, opts, redirectCount) {
  opts = opts || {};
  redirectCount = redirectCount || 0;
  return new Promise((resolve, reject) => {
    if (redirectCount > 8) return reject(new Error('リダイレクトが多すぎます'));
    const mod = urlStr.startsWith('https:') ? https : http;
    const req = mod.get(urlStr, { headers: hfRequestHeaders(urlStr, opts.token) }, (res) => {
      // リダイレクト（HF resolve → CDN署名URL等）
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, urlStr).toString(); }
        catch { return reject(new Error('リダイレクト先URLが不正です')); }
        return resolve(downloadToFile(next, destPath, opts, redirectCount + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}（ダウンロード先にアクセスできません。URL/権限を確認してください）`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;
      const tmpPath = destPath + '.part';
      const out = fs.createWriteStream(tmpPath);
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (opts.onProgress) opts.onProgress(downloaded, total);
      });
      res.on('error', (e) => { out.destroy(); try { fs.unlinkSync(tmpPath); } catch {} reject(e); });
      res.pipe(out);
      out.on('finish', () => {
        out.close(() => {
          try { fs.renameSync(tmpPath, destPath); resolve({ total: total || downloaded, downloaded }); }
          catch (e) { reject(e); }
        });
      });
      out.on('error', (e) => { try { fs.unlinkSync(tmpPath); } catch {} reject(e); });
    });
    req.on('error', reject);
    req.setTimeout(0); // 大容量ダウンロードのためソケットタイムアウト無効
  });
}

// config.json の chatModels にモデルを追記（同名/同パスは上書き）し、バックアップも作成
function addModelToConfig(info) {
  const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
  const cfg = JSON.parse(raw);
  if (!Array.isArray(cfg.chatModels)) cfg.chatModels = [];
  const ctx = Number.isFinite(info.ctx) && info.ctx > 0 ? info.ctx : 4096;
  const ngl = Number.isFinite(info.ngl) ? info.ngl : 99;
  const entry = {
    name: info.name,
    path: info.path,
    ctx,
    ngl,
    extraArgs: info.mmprojPath ? ['--mmproj', info.mmprojPath] : [],
  };
  const existing = cfg.chatModels.find(m => m.name === entry.name || m.path === entry.path);
  if (existing) {
    Object.assign(existing, entry);
  } else {
    cfg.chatModels.push(entry);
  }
  // バックアップ（最新10件保持）
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(CONFIG_FILE, `${CONFIG_FILE}.bak.${ts}`);
    const dir = path.dirname(CONFIG_FILE);
    const base = path.basename(CONFIG_FILE);
    fs.readdirSync(dir)
      .filter(f => f.startsWith(`${base}.bak.`))
      .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(10)
      .forEach(b => { try { fs.unlinkSync(path.join(dir, b.f)); } catch {} });
  } catch {}
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  return entry;
}

// ダウンロード進捗の取得
app.get('/config/model-download/status', requireAuth, (req, res) => {
  res.json(modelDownloadJob || { status: 'idle' });
});

// ダウンロード開始（即座にjobIdを返し、ダウンロードはバックグラウンド実行）
app.post('/config/model-download', requireAuth, jsonParser, (req, res) => {
  const ip = getIP(req);
  if (modelDownloadJob && modelDownloadJob.status === 'downloading') {
    return res.status(409).json({ error: '既にダウンロード中のモデルがあります。完了までお待ちください。' });
  }
  const body = req.body || {};
  const norm = normalizeHfUrl(body.url);
  if (norm.error) return res.status(400).json({ error: norm.error });
  const url = norm.url;
  let fileName;
  try { fileName = decodeURIComponent(path.basename(new URL(url).pathname)); }
  catch { return res.status(400).json({ error: 'ファイル名を特定できませんでした' }); }
  if (!/\.gguf$/i.test(fileName)) {
    return res.status(400).json({ error: 'GGUFファイル(.gguf)のURLを指定してください' });
  }

  // mmproj（Vision用、任意）
  let mmprojNorm = null, mmprojFile = null;
  if (body.mmprojUrl && String(body.mmprojUrl).trim()) {
    mmprojNorm = normalizeHfUrl(body.mmprojUrl);
    if (mmprojNorm.error) return res.status(400).json({ error: 'mmproj: ' + mmprojNorm.error });
    try { mmprojFile = decodeURIComponent(path.basename(new URL(mmprojNorm.url).pathname)); }
    catch { return res.status(400).json({ error: 'mmproj: ファイル名を特定できませんでした' }); }
  }

  const modelsDir = getModelsDir();
  const destPath = path.join(modelsDir, fileName);
  const mmprojPath = mmprojFile ? path.join(modelsDir, mmprojFile) : null;
  const modelName = (body.name && String(body.name).trim()) || fileName.replace(/\.gguf$/i, '');
  const ctx = parseInt(body.ctx, 10);
  const ngl = parseInt(body.ngl, 10);
  const token = (body.hfToken && String(body.hfToken).trim()) || appConfig.hfToken || process.env.HF_TOKEN || '';

  const job = {
    id: Date.now().toString(36),
    status: 'downloading',
    phase: 'model',
    fileName,
    modelName,
    modelsDir,
    downloadedBytes: 0,
    totalBytes: 0,
    percent: 0,
    error: null,
    addedModel: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  modelDownloadJob = job;
  log(ip, `MODEL DOWNLOAD START: ${modelName} <- ${url}`);
  res.json({ ok: true, jobId: job.id, fileName, modelName, modelsDir });

  // バックグラウンド実行
  (async () => {
    try {
      const onProgress = (d, t) => {
        job.downloadedBytes = d;
        job.totalBytes = t;
        job.percent = t ? Math.floor((d / t) * 100) : 0;
      };
      await downloadToFile(url, destPath, { token, onProgress });

      if (mmprojNorm) {
        job.phase = 'mmproj';
        job.downloadedBytes = 0; job.totalBytes = 0; job.percent = 0;
        await downloadToFile(mmprojNorm.url, mmprojPath, { token, onProgress });
      }

      job.phase = 'register';
      const added = addModelToConfig({
        name: modelName,
        path: destPath,
        ctx: Number.isFinite(ctx) ? ctx : undefined,
        ngl: Number.isFinite(ngl) ? ngl : undefined,
        mmprojPath,
      });
      job.addedModel = added;
      job.status = 'done';
      job.percent = 100;
      job.finishedAt = Date.now();
      log(ip, `MODEL DOWNLOAD DONE: ${modelName} (${fileName}) -> registered`);
    } catch (e) {
      job.status = 'error';
      job.error = e.message;
      job.finishedAt = Date.now();
      log(ip, `MODEL DOWNLOAD FAILED: ${e.message}`);
    }
  })();
});

// ─── サーバー再起動 ───
// systemd の Restart=always (または on-failure) に依存して、プロセスを終了 → 自動復活する方式。
// 起動方法に応じた挙動:
//   - systemd 起動: 数秒後に自動復活 ✓
//   - 直接 node server.js: 復活せず、手動で再起動が必要
// クライアントには「再起動可能か」のヒントを返すため /restart/info も用意
app.get('/restart/info', requireAuth, (req, res) => {
  // INVOCATION_ID は systemd 起動時のみ付与される環境変数
  const isSystemd = !!process.env.INVOCATION_ID;
  res.json({
    isSystemd,
    pid: process.pid,
    uptime: process.uptime(),
    nodeVersion: process.version,
  });
});

app.post('/restart', requireAuth, (req, res) => {
  const ip = getIP(req);
  const isSystemd = !!process.env.INVOCATION_ID;
  log(ip, `RESTART requested (systemd=${isSystemd})`);

  if (!isSystemd) {
    // systemd で動いていないなら警告を返すが、ユーザーの意思を尊重して終了は実行する
    // （nodemon や pm2 でも動く可能性があるため）
    log(ip, 'RESTART warning: not running under systemd, may not auto-restart');
  }

  // レスポンスを先に返してから、少し待ってプロセス終了
  res.json({
    ok: true,
    message: isSystemd
      ? 'systemd経由で自動再起動します（数秒以内）'
      : '警告: systemd下ではないため、自動再起動されない可能性があります',
    isSystemd,
  });

  // 進行中のリクエストへの配慮で少し待つ
  setTimeout(() => {
    console.log('[RESTART] Exiting now for systemd to restart...');
    // 外部APIサーバーも停止しておく（自動でやってくれるが念のため）
    try { stopAllExternalServers(); } catch {}
    // 注意: exit code は非ゼロ(1)にする。
    // systemd の Restart=on-failure 設定だと exit 0 (正常終了) では再起動されない。
    // 1 にしておけば Restart=always / on-failure のどちらでも確実に再起動する。
    process.exit(1);
  }, 1500);
});

app.post('/auth', jsonParser, (req, res) => {
  const ip = getIP(req);
  if (!appConfig.password) {
    return res.json({ ok: true, token: null });
  }
  if (!checkLoginRate(ip)) {
    log(ip, 'AUTH rate limited');
    return res.status(429).json({ ok: false, error: 'ログイン試行回数が多すぎます。しばらくしてから再度お試しください。' });
  }
  const { password } = req.body || {};
  if (verifyPassword(password, appConfig.password)) {
    const token = newSession(ip);
    resetLoginRate(ip);
    log(ip, 'AUTH success');
    // HTTPS時（直接or リバースプロキシ経由）は Secure 属性を付与
    const isSecure = HTTPS_ENABLED || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `wz_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL / 1000)}${isSecure ? '; Secure' : ''}`);
    return res.json({ ok: true, token });
  }
  recordLoginFail(ip);
  log(ip, 'AUTH failed');
  return res.status(401).json({ ok: false, error: 'パスワードが正しくありません' });
});

// ─── ユーザーファイルストレージ (public/uploads) ───
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
// アップロードファイル1個あたりの上限（config.jsonの maxFileSize で変更可能、デフォルト 50MB）
const MAX_FILE_SIZE = (appConfig.maxFileSize || 50) * 1024 * 1024;

// uploadsディレクトリ作成
try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch {}

// パス安全性チェック（ディレクトリトラバーサル対策）
function safeUploadPath(relativePath) {
  if (!relativePath || typeof relativePath !== 'string') return null;
  // 先頭の/を除去
  let clean = relativePath.replace(/^[\/\\]+/, '');
  // "uploads/" プレフィックスが付いていたら除去（LLMが付けてくることがある）
  clean = clean.replace(/^(public\/)?uploads[\/\\]/, '');
  // nullバイト拒否
  if (clean.includes('\0')) return null;
  // 隠しファイル・隠しディレクトリ (パス中のどこかのセグメントが . で始まる) を拒否
  // 一覧に出さないものは読み書きもさせない (整合性とセキュリティのため)
  if (clean.split(/[\/\\]/).some(seg => seg.startsWith('.'))) return null;
  // 絶対パスに解決
  const abs = path.resolve(UPLOADS_DIR, clean);
  // UPLOADS_DIR配下であることを確認
  if (!abs.startsWith(UPLOADS_DIR + path.sep) && abs !== UPLOADS_DIR) return null;
  return abs;
}

// ファイル一覧
app.get('/files', requireAuth, (req, res) => {
  try {
    const walk = (dir, base = '') => {
      const items = [];
      for (const name of fs.readdirSync(dir)) {
        // 隠しファイル・隠しディレクトリ (.で始まる) は除外
        if (name.startsWith('.')) continue;
        const full = path.join(dir, name);
        const rel = base ? `${base}/${name}` : name;
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            items.push(...walk(full, rel));
          } else if (stat.isFile()) {
            items.push({
              path: rel,
              size: stat.size,
              modified: stat.mtime.toISOString(),
            });
          }
        } catch {}
      }
      return items;
    };
    const files = walk(UPLOADS_DIR);
    files.sort((a, b) => b.modified.localeCompare(a.modified));
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ファイル読み込み
app.get('/files/*', requireAuth, (req, res) => {
  const ip = getIP(req);
  const relativePath = req.params[0];
  const abs = safeUploadPath(relativePath);
  if (!abs) return res.status(400).json({ error: 'Invalid path' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'Not found' });
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
    if (stat.size > MAX_FILE_SIZE) return res.status(413).json({ error: 'File too large' });

    // バイナリ拡張子の場合は直接配信（画像等）
    const ext = path.extname(abs).toLowerCase();
    const binaryExts = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp',
      '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
      '.pdf': 'application/pdf',
      '.mp4': 'video/mp4', '.webm': 'video/webm',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
      '.zip': 'application/zip',
    };
    if (binaryExts[ext] || req.query.raw === '1') {
      res.setHeader('Content-Type', binaryExts[ext] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, max-age=60');
      log(ip, `FILE READ ${relativePath} (${stat.size} bytes, binary)`);
      return fs.createReadStream(abs).pipe(res);
    }

    // テキストファイルはJSON形式で返す（従来互換）
    const content = fs.readFileSync(abs, 'utf-8');
    log(ip, `FILE READ ${relativePath} (${stat.size} bytes)`);
    res.json({ path: relativePath, size: stat.size, content, modified: stat.mtime.toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ファイル書き込み（新規 or 上書き）
// バイナリファイルのアップロード（multipart/form-data）パーサー
// 単一ファイル想定、依存を増やさない最小実装
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const ct = req.headers['content-type'] || '';
    const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!m) return reject(new Error('No boundary in Content-Type'));
    const boundary = m[1] || m[2];
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_FILE_SIZE + 4096) { // 余裕分のmultipartヘッダ用
        req.destroy();
        return reject(new Error('File too large'));
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        const boundaryBuf = Buffer.from('--' + boundary);
        const headerSepBuf = Buffer.from('\r\n\r\n');
        // 最初のboundaryを探す
        let start = buf.indexOf(boundaryBuf);
        if (start < 0) return reject(new Error('Boundary not found'));
        start += boundaryBuf.length + 2; // skip CRLF
        const headerEnd = buf.indexOf(headerSepBuf, start);
        if (headerEnd < 0) return reject(new Error('Headers not found'));
        const contentStart = headerEnd + headerSepBuf.length;
        // 終端: \r\n--boundary
        const endBoundary = buf.indexOf(Buffer.from('\r\n--' + boundary), contentStart);
        if (endBoundary < 0) return reject(new Error('End boundary not found'));
        const fileBuf = buf.slice(contentStart, endBoundary);
        resolve(fileBuf);
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

app.post('/files/*', requireAuth, async (req, res, next) => {
  const ip = getIP(req);
  const relativePath = req.params[0];
  const abs = safeUploadPath(relativePath);
  if (!abs) return res.status(400).json({ error: 'Invalid path' });
  const ct = req.headers['content-type'] || '';

  // multipart/form-data（バイナリファイル）
  if (ct.startsWith('multipart/form-data')) {
    try {
      const fileBuf = await parseMultipart(req);
      if (fileBuf.length > MAX_FILE_SIZE) {
        return res.status(413).json({ error: `File too large (${fileBuf.length} bytes)` });
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, fileBuf);
      log(ip, `FILE WRITE ${relativePath} (${fileBuf.length} bytes, binary)`);
      return res.json({ ok: true, path: relativePath, size: fileBuf.length });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // application/json（テキストファイル、従来動作）
  jsonParser(req, res, () => {
    const { content } = req.body || {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'content required (string)' });
    const size = Buffer.byteLength(content, 'utf-8');
    if (size > MAX_FILE_SIZE) return res.status(413).json({ error: `File too large (${size} bytes, max ${MAX_FILE_SIZE})` });
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf-8');
      log(ip, `FILE WRITE ${relativePath} (${size} bytes)`);
      res.json({ ok: true, path: relativePath, size });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// ファイル削除
app.delete('/files/*', requireAuth, (req, res) => {
  const ip = getIP(req);
  const relativePath = req.params[0];
  const abs = safeUploadPath(relativePath);
  if (!abs) return res.status(400).json({ error: 'Invalid path' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'Not found' });
  try {
    fs.unlinkSync(abs);
    log(ip, `FILE DELETE ${relativePath}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════
// Google Drive 連携 API
// ════════════════════════════════════════════════════════════════
// ブラウザUI (右パネルの「☁️ Drive」タブ) と、LLM のツール実行の両方から使う。
// 秘密情報 (clientSecret / refreshToken) はこのAPIからは一切返さない。
//
// 権限:
//   参照系 … requirePermission('gdrive:read')
//   更新系 … requirePermission('gdrive:write')
// Cookie セッション (ブラウザ) は全権限扱い。外部APIトークンは config.json の
// ml.apiTokens[].permissions で個別に絞れる。

// OAuth の state (CSRF対策)。発行から10分で失効
const gdriveOAuthStates = new Map();  // state -> { at, ip }
function issueGdriveState(ip) {
  const state = crypto.randomBytes(24).toString('hex');
  gdriveOAuthStates.set(state, { at: Date.now(), ip });
  // 古いものを掃除
  const now = Date.now();
  for (const [k, v] of gdriveOAuthStates) {
    if (now - v.at > 10 * 60 * 1000) gdriveOAuthStates.delete(k);
  }
  return state;
}
function consumeGdriveState(state) {
  const rec = gdriveOAuthStates.get(state);
  if (!rec) return false;
  gdriveOAuthStates.delete(state);
  return Date.now() - rec.at <= 10 * 60 * 1000;
}

// OAuth コールバックの中継ページ。
// URL から code / state を自分で読み取り、同一サイトの POST でトークン交換させる。
// サーバー側で値を埋め込まない (= XSS の入り込む余地を作らない) 作りにしている。
const GDRIVE_CALLBACK_HTML = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GDrive 連携</title><style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#0f1115;color:#e6e8eb;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}
.card{max-width:520px;padding:32px;border-radius:14px;background:#171a21;border:1px solid #262b36;text-align:center}
h1{font-size:18px;margin:0 0 12px}p{font-size:13px;line-height:1.7;color:#a6adbb;margin:0 0 8px;word-break:break-word}
.ic{font-size:40px;margin-bottom:8px}.ok{color:#34d399}.ng{color:#f87171}.wait{color:#60a5fa}
b{color:#e6e8eb}
</style></head><body>
<div class="card">
  <div class="ic wait" id="ic">⏳</div>
  <h1 id="title">連携を完了しています...</h1>
  <p id="msg">Google からの応答を処理しています。</p>
  <p id="hint"></p>
</div>
<script>
(function () {
  var ic = document.getElementById('ic');
  var title = document.getElementById('title');
  var msg = document.getElementById('msg');
  var hint = document.getElementById('hint');

  function finish(ok, titleText, msgText) {
    ic.textContent = ok ? '✅' : '⚠️';
    ic.className = 'ic ' + (ok ? 'ok' : 'ng');
    title.textContent = titleText;
    msg.textContent = msgText || '';
    hint.textContent = 'このタブは閉じて構いません。';
    try {
      if (window.opener) {
        window.opener.postMessage({ type: 'gdrive-auth', ok: ok, message: msgText || '' }, window.location.origin);
        if (ok) setTimeout(function () { window.close(); }, 1500);
      }
    } catch (e) {}
  }

  var p = new URLSearchParams(window.location.search);
  var err = p.get('error');
  var code = p.get('code');
  var state = p.get('state');

  if (err) return finish(false, '連携できませんでした', 'Google 側で拒否されました: ' + err);
  if (!code) return finish(false, '連携できませんでした', '認可コードがありません。');

  // ここは同一サイトの fetch なので、SameSite=Strict のセッションCookieも送信される
  fetch('/gdrive/auth/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ code: code, state: state }),
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, d: d }; });
  }).then(function (res) {
    if (res.ok) {
      finish(true, 'GDrive と連携しました', res.d.account ? '接続アカウント: ' + res.d.account : '');
    } else if (res.status === 401) {
      finish(false, '連携できませんでした', 'OpenGeekLLMChat にログインしていません。元のタブでログインし直してから、もう一度「接続」してください。');
    } else {
      finish(false, '連携できませんでした', (res.d && res.d.error) || ('HTTP ' + res.status));
    }
  }).catch(function (e) {
    finish(false, '連携できませんでした', String(e && e.message ? e.message : e));
  });
})();
</script>
</body></html>`;

// エラー応答の共通化 (Google API のメッセージをそのまま見せた方がデバッグしやすい)
function gdriveError(res, e, ip, label) {
  const msg = e?.message || String(e);
  log(ip, `[Drive] ${label} 失敗: ${msg}`);
  const status = /未接続|未設定|無効です|読み取り専用|許可されていません/.test(msg) ? 400
    : /認証|失効/.test(msg) ? 401
    : /見つかりません/.test(msg) ? 404
    : /範囲.*外/.test(msg) ? 403
    : 500;
  res.status(status).json({ error: msg });
}

// 接続状態
app.get('/gdrive/status', requireAuth, (req, res) => {
  try {
    res.json(gdrive.status());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 接続テスト (アカウント・空き容量)
app.get('/gdrive/about', requireAuth, requirePermission('gdrive:read'), async (req, res) => {
  const ip = getIP(req);
  try {
    const info = await gdrive.about();
    log(ip, `[Drive] 接続確認 OK (${info.user?.emailAddress || '-'})`);
    res.json(info);
  } catch (e) { gdriveError(res, e, ip, '接続確認'); }
});

// 認可URLの発行 (ブラウザはここで返るURLに遷移する)
app.get('/gdrive/auth/url', requireAuth, (req, res) => {
  const ip = getIP(req);
  try {
    if (appConfig.googleDrive?.authMode === 'serviceAccount') {
      return res.status(400).json({ error: 'サービスアカウント方式ではブラウザ認可は不要です' });
    }
    const state = issueGdriveState(ip);
    res.json({ url: gdrive.buildAuthUrl(state) });
  } catch (e) { gdriveError(res, e, ip, '認可URL発行'); }
});

// OAuth コールバック (Google からブラウザがリダイレクトされてくる)
//
// ⚠️ ここに requireAuth は掛けられない。
// Google からのリダイレクトは accounts.google.com → 当サーバー への
// 「クロスサイトのトップレベル遷移」なので、セッションCookie (wz_session) は
// SameSite=Strict によりブラウザから送信されない。requireAuth を掛けると
// 必ず {"error":"認証が必要です"} になってしまう。
//
// そこでこのエンドポイントは【何も特権的なことをしない中継ページ】を返すだけにする。
// ページ内の JavaScript から同一サイトの POST /gdrive/auth/exchange を叩くと、
// そのリクエストは same-site 扱いになるので Strict Cookie が正しく送られ、
// 認証つきでトークン交換ができる。
// (セッションCookieを SameSite=Lax に緩める手もあるが、アプリ全体のCSRF耐性を
//  この機能のために下げたくないので中継ページ方式にしている)
app.get('/gdrive/auth/callback', (req, res) => {
  res.type('html').send(GDRIVE_CALLBACK_HTML);
});

// 認可コード → リフレッシュトークンの交換 (中継ページから same-site で呼ばれる)
// ここは通常どおり認証必須。state も1回限りで消費する。
app.post('/gdrive/auth/exchange', requireAuth, jsonParser, async (req, res) => {
  const ip = getIP(req);
  const { code, state } = req.body || {};
  if (!code) return res.status(400).json({ error: '認可コードがありません' });
  if (!state || !consumeGdriveState(String(state))) {
    log(ip, '[Drive] state 不一致 (CSRFの疑い、有効期限切れ、または再読み込み)');
    return res.status(400).json({
      error: 'この認可リクエストを確認できませんでした。有効期限切れか、すでに使用済みです。もう一度「接続」からやり直してください',
    });
  }
  try {
    const r = await gdrive.exchangeCode(String(code));
    log(ip, `[Drive] 連携完了 (${r.account || 'アカウント不明'})`);
    res.json({ ok: true, account: r.account || '' });
  } catch (e) {
    log(ip, `[Drive] トークン交換失敗: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// 連携解除
app.post('/gdrive/disconnect', requireAuth, requirePermission('gdrive:write'), async (req, res) => {
  const ip = getIP(req);
  try {
    await gdrive.disconnect();
    log(ip, '[Drive] 連携を解除しました');
    res.json({ ok: true });
  } catch (e) { gdriveError(res, e, ip, '連携解除'); }
});

// ファイル一覧 (フォルダの中身)
app.get('/gdrive/files', requireAuth, requirePermission('gdrive:read'), async (req, res) => {
  const ip = getIP(req);
  try {
    const r = await gdrive.listFiles({
      folderId: req.query.folderId,
      query: req.query.q,
      pageSize: req.query.pageSize,
      pageToken: req.query.pageToken,
      orderBy: req.query.orderBy,
      onlyFolders: req.query.onlyFolders === '1',
    });
    log(ip, `[Drive] 一覧取得 folder=${r.folderId} (${r.files.length}件)`);
    res.json(r);
  } catch (e) { gdriveError(res, e, ip, '一覧取得'); }
});

// 検索 (ドライブ横断)
app.get('/gdrive/search', requireAuth, requirePermission('gdrive:read'), async (req, res) => {
  const ip = getIP(req);
  try {
    const r = await gdrive.searchFiles({
      query: req.query.q,
      folderId: req.query.folderId,
      mimeType: req.query.mimeType,
      pageSize: req.query.pageSize,
      pageToken: req.query.pageToken,
    });
    log(ip, `[Drive] 検索「${req.query.q}」 (${r.files.length}件)`);
    res.json(r);
  } catch (e) { gdriveError(res, e, ip, '検索'); }
});

// メタデータ
app.get('/gdrive/files/:id', requireAuth, requirePermission('gdrive:read'), async (req, res) => {
  const ip = getIP(req);
  try {
    res.json(await gdrive.getFile(req.params.id));
  } catch (e) { gdriveError(res, e, ip, 'メタデータ取得'); }
});

// 中身をテキストで取得 (?raw=1 でバイナリのまま配信)
app.get('/gdrive/files/:id/content', requireAuth, requirePermission('gdrive:read'), async (req, res) => {
  const ip = getIP(req);
  try {
    if (req.query.raw === '1') {
      const dl = await gdrive.downloadFile(req.params.id, { preferOffice: req.query.office === '1' });
      log(ip, `[Drive] ダウンロード ${dl.name} (${dl.buffer.length} bytes)`);
      res.setHeader('Content-Type', dl.mimeType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(dl.name)}`);
      return res.send(dl.buffer);
    }
    const r = await gdrive.readFileAsText(req.params.id, { maxChars: Number(req.query.maxChars) || undefined });
    log(ip, `[Drive] 読み込み ${r.name} (${r.content.length}文字${r.truncated ? '/切り詰めあり' : ''})`);
    res.json(r);
  } catch (e) { gdriveError(res, e, ip, 'ファイル読み込み'); }
});

// 作成/更新 (テキスト)
app.post('/gdrive/files', requireAuth, requirePermission('gdrive:write'), jsonParser, async (req, res) => {
  const ip = getIP(req);
  try {
    const { name, content, mimeType, folderId, fileId, overwrite, convertToGoogleDoc } = req.body || {};
    const r = await gdrive.uploadFile({ name, content, mimeType, folderId, fileId, overwrite, convertToGoogleDoc });
    log(ip, `[Drive] ${r.updated ? '更新' : '作成'} ${r.name} (${r.bytes} bytes)`);
    res.json(r);
  } catch (e) { gdriveError(res, e, ip, 'ファイル書き込み'); }
});

// フォルダ作成
app.post('/gdrive/folders', requireAuth, requirePermission('gdrive:write'), jsonParser, async (req, res) => {
  const ip = getIP(req);
  try {
    const r = await gdrive.createFolder({ name: req.body?.name, folderId: req.body?.folderId });
    log(ip, `[Drive] フォルダ作成 ${r.name}`);
    res.json(r);
  } catch (e) { gdriveError(res, e, ip, 'フォルダ作成'); }
});

// 削除 (既定はゴミ箱)
app.delete('/gdrive/files/:id', requireAuth, requirePermission('gdrive:write'), async (req, res) => {
  const ip = getIP(req);
  try {
    const r = await gdrive.deleteFile(req.params.id, { permanent: req.query.permanent === '1' });
    log(ip, `[Drive] 削除 ${req.params.id} (${r.permanent ? '完全削除' : 'ゴミ箱'})`);
    res.json(r);
  } catch (e) { gdriveError(res, e, ip, '削除'); }
});

// Drive → サーバー (public/uploads) に取り込む
// バイナリ・大きいファイル・Pythonで処理したいデータはこれを使う。
app.post('/gdrive/import', requireAuth, requirePermission('gdrive:write'), jsonParser, async (req, res) => {
  const ip = getIP(req);
  try {
    const { fileId, savePath, preferOffice } = req.body || {};
    if (!fileId) return res.status(400).json({ error: 'fileId が必要です' });
    const dl = await gdrive.downloadFile(fileId, { preferOffice: !!preferOffice });
    // 保存先: 指定がなければ Drive 上の名前をそのまま uploads 直下に
    const rel = savePath || dl.name;
    const abs = safeUploadPath(rel);
    if (!abs) return res.status(400).json({ error: '保存先パスが不正です' });
    if (dl.buffer.length > MAX_FILE_SIZE) {
      return res.status(413).json({ error: `ファイルが大きすぎます (${dl.buffer.length} bytes)` });
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, dl.buffer);
    log(ip, `[Drive] 取り込み ${dl.name} → uploads/${rel} (${dl.buffer.length} bytes)`);
    res.json({ ok: true, path: rel, size: dl.buffer.length, mimeType: dl.mimeType, exported: dl.exported, driveFile: dl.meta });
  } catch (e) { gdriveError(res, e, ip, '取り込み'); }
});

// サーバー (public/uploads) → Drive にアップロード
app.post('/gdrive/export', requireAuth, requirePermission('gdrive:write'), jsonParser, async (req, res) => {
  const ip = getIP(req);
  try {
    const { path: relPath, name, folderId, overwrite, convertToGoogleDoc } = req.body || {};
    if (!relPath) return res.status(400).json({ error: 'path (uploads配下の相対パス) が必要です' });
    const abs = safeUploadPath(relPath);
    if (!abs) return res.status(400).json({ error: 'パスが不正です' });
    if (!fs.existsSync(abs)) return res.status(404).json({ error: `ファイルが見つかりません: ${relPath}` });
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return res.status(400).json({ error: 'ファイルではありません' });

    const buffer = fs.readFileSync(abs);
    const fileName = name || path.basename(relPath);
    const r = await gdrive.uploadFile({
      name: fileName,
      buffer,
      mimeType: gdrive.guessMimeFromName(fileName),
      folderId,
      overwrite: overwrite !== false,
      convertToGoogleDoc: !!convertToGoogleDoc,
    });
    log(ip, `[Drive] アップロード uploads/${relPath} → ${r.name} (${r.bytes} bytes)`);
    res.json(r);
  } catch (e) { gdriveError(res, e, ip, 'アップロード'); }
});

// ─── ユーザーアイコン (config.userIcon にパス保存、画像は public/uploads へ) ───
const USER_ICON_EXT_ALLOW = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

// マジックバイトによる簡易画像判定（拡張子偽装・任意ファイル混入を防ぐ）
function isImageBuffer(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true; // PNG
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;                     // JPEG
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;                     // GIF
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true; // WEBP
  return false;
}

// config.json を1キーだけ安全に書き換える（バックアップ作成・最新10件保持）
function patchConfigFile(patchFn) {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  patchFn(cfg);
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(CONFIG_FILE, `${CONFIG_FILE}.bak.${ts}`);
    const dir = path.dirname(CONFIG_FILE);
    const base = path.basename(CONFIG_FILE);
    fs.readdirSync(dir)
      .filter(f => f.startsWith(`${base}.bak.`))
      .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(10)
      .forEach(b => { try { fs.unlinkSync(path.join(dir, b.f)); } catch {} });
  } catch {}
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  return cfg;
}

// アイコンのアップロード（multipart/form-data）。public/uploads に保存し config.userIcon を更新
app.post('/config/user-icon', requireAuth, async (req, res) => {
  const ip = getIP(req);
  const ct = req.headers['content-type'] || '';
  if (!ct.startsWith('multipart/form-data')) {
    return res.status(400).json({ error: 'multipart/form-data で画像を送信してください' });
  }
  let ext = String(req.query.ext || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (ext === 'jpeg') ext = 'jpg';
  if (!USER_ICON_EXT_ALLOW.includes(ext)) ext = 'png';
  try {
    const buf = await parseMultipart(req);
    if (!buf || buf.length === 0) return res.status(400).json({ error: 'ファイルが空です' });
    if (buf.length > MAX_FILE_SIZE) return res.status(413).json({ error: `ファイルが大きすぎます (${buf.length} bytes)` });
    if (!isImageBuffer(buf)) return res.status(400).json({ error: '画像ファイルではありません (PNG/JPEG/WebP/GIF のみ)' });

    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const fileName = `user-icon-${Date.now().toString(36)}.${ext}`;
    const abs = path.join(UPLOADS_DIR, fileName);
    fs.writeFileSync(abs, buf);
    const urlPath = `/uploads/${fileName}`;

    const old = appConfig.userIcon;
    patchConfigFile(cfg => { cfg.userIcon = urlPath; });
    appConfig.userIcon = urlPath;  // 表示用パスなので再起動なしで即反映

    // 旧アイコンが uploads 配下なら掃除
    if (old && typeof old === 'string' && old.startsWith('/uploads/')) {
      const oldAbs = path.join(UPLOADS_DIR, path.basename(old));
      if (oldAbs !== abs) { try { fs.unlinkSync(oldAbs); } catch {} }
    }
    log(ip, `USER ICON SET: ${urlPath} (${buf.length} bytes)`);
    res.json({ ok: true, userIcon: urlPath, size: buf.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// アイコンの解除（config.userIcon を削除し、uploads のファイルも掃除）
app.delete('/config/user-icon', requireAuth, (req, res) => {
  const ip = getIP(req);
  try {
    const old = appConfig.userIcon;
    patchConfigFile(cfg => { delete cfg.userIcon; });
    appConfig.userIcon = undefined;
    if (old && typeof old === 'string' && old.startsWith('/uploads/')) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, path.basename(old))); } catch {}
    }
    log(ip, 'USER ICON CLEARED');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── グローバル設定 ───
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

app.get('/settings', requireAuth, (req, res) => {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return res.json({});
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/settings', requireAuth, jsonParser, (req, res) => {
  const ip = getIP(req);
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(req.body, null, 2), 'utf-8');
    log(ip, `SETTINGS SAVE`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── チャット履歴保存 ───
const CHATS_DIR = process.env.CHATS_DIR || path.join(__dirname, 'chats');
if (!fs.existsSync(CHATS_DIR)) fs.mkdirSync(CHATS_DIR, { recursive: true });

// 一覧取得
// チャットIDのサニタイズ（パストラバーサル防止）
function sanitizeChatId(id) {
  if (!id || typeof id !== 'string') return null;
  // 英数字・ハイフン・アンダースコアのみ許可
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null;
  if (id.length > 64) return null;
  return id;
}

app.get('/chats', requireAuth, (req, res) => {
  try {
    const files = fs.readdirSync(CHATS_DIR).filter(f => f.endsWith('.json'));
    const list = files.map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(CHATS_DIR, f), 'utf-8'));
        return {
          id: f.replace('.json', ''),
          title: data.title || '無題',
          updatedAt: data.updatedAt || data.createdAt || '',
          messageCount: (data.messages || []).length,
          docCount: (data.documents || []).length,
        };
      } catch { return null; }
    }).filter(Boolean);
    list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 1件取得
app.get('/chats/:id', requireAuth, (req, res) => {
  const id = sanitizeChatId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid chat id' });
  const file = path.join(CHATS_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 保存（新規 or 上書き）
app.post('/chats/:id', requireAuth, jsonParser, (req, res) => {
  const ip = getIP(req);
  const id = sanitizeChatId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid chat id' });
  const file = path.join(CHATS_DIR, `${id}.json`);
  try {
    const payload = {
      ...req.body,
      id,
      updatedAt: new Date().toISOString(),
    };
    if (!payload.createdAt) payload.createdAt = payload.updatedAt;
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
    log(ip, `CHAT SAVE ${id} (${(payload.messages || []).length} msgs)`);
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 削除
app.delete('/chats/:id', requireAuth, (req, res) => {
  const ip = getIP(req);
  const id = sanitizeChatId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid chat id' });
  const file = path.join(CHATS_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
  try {
    fs.unlinkSync(file);
    log(ip, `CHAT DELETE ${id}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── matplotlib生成画像の配信（認証必須） ───
// uploadsとは別管理。LLMのファイル操作ツール（list_files/read_file/write_file）からは見えない。
app.get('/plots/*', requireAuth, (req, res) => {
  const relativePath = req.params[0];
  const PLOTS_DIR = path.join(__dirname, 'public', 'plots');
  // パストラバーサル防止
  const abs = path.resolve(PLOTS_DIR, relativePath);
  if (!abs.startsWith(PLOTS_DIR)) return res.status(400).json({ error: 'Invalid path' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'Not found' });
  const ext = path.extname(abs).toLowerCase();
  const mimes = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  };
  res.setHeader('Content-Type', mimes[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=300');
  fs.createReadStream(abs).pipe(res);
});

// ─── 静的ファイル配信 ───
// /plots/ は認証付きの専用ルート（上記）で処理するため、静的配信の対象外にする
app.use((req, res, next) => {
  if (req.path.startsWith('/plots/')) return next();
  express.static(path.join(__dirname, 'public'))(req, res, next);
});

// ═══════════════════════════════════════════════════════════════════
// 🤖 機械学習 (ML) - 表データ管理
// ═══════════════════════════════════════════════════════════════════
// DuckDB を用いてCSV/Web APIから取り込んだ表データを管理。
// LLMからは読み取り(SELECT)専用ツール経由でアクセス可能。
// 外部の Python スクリプト等からは Authorization: Bearer <token> で直接利用可能 (config.json の apiTokens[])。
// Phase 1: テーブルCRUD + CSVインポート + SELECT実行 + LLM読み取りツール
// Phase 2: WebAPIインポート、外部APIトークン、append エンドポイント
// Phase 3以降: モデル学習(PyTorch)、推論API

// CORS: ML系エンドポイントは別オリジン(ブラウザJS / curl等)からも叩けるように許可
// Pythonの requests からは関係ないが、Webダッシュボード等のクロスオリジン利用に対応
app.use('/ml', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Auth-Token');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

let _duckdb = null;        // duckdb モジュール (lazy load)
let _mlDb = null;           // データベース接続
let _mlDbConn = null;       // 接続オブジェクト
let _mlDbInitFailed = false; // duckdb モジュール初期化失敗フラグ
let _mlDbExternalHold = false; // 外部プロセス(オフラインRL等)が read_only でDBを掴んでいる間 true
let currentMlJob = null;    // 実行中の学習ジョブ { jobId, modelName, proc, log: [] }
                            // DuckDB は排他ロックなので学習中は Node 側で DB を開かない

function getDuckDB() {
  if (_duckdb) return _duckdb;
  if (_mlDbInitFailed) return null;
  try {
    _duckdb = require('duckdb');
    return _duckdb;
  } catch (e) {
    log('-', `[ML] duckdb モジュールがロードできません: ${e.message}。'npm install duckdb' で導入してください`);
    _mlDbInitFailed = true;
    return null;
  }
}

function getMlDb() {
  // 学習中(currentMlJob 実行中)は ML DB を絶対に開かない
  // Python(ml_runner)が排他ロックを取得しているため、Node側で開こうとすると失敗する
  if (currentMlJob || _mlDbExternalHold) {
    throw new Error('現在 ML 学習ジョブ実行中のため DuckDB は一時的にアクセスできません (ジョブ終了後に再試行してください)');
  }
  if (_mlDbConn) return _mlDbConn;
  const duckdb = getDuckDB();
  if (!duckdb) return null;
  _mlDb = new duckdb.Database(ML_DB_FILE);
  _mlDbConn = _mlDb.connect();
  return _mlDbConn;
}

// Promise化したクエリ実行
function mlQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    const conn = getMlDb();
    if (!conn) return reject(new Error('DuckDB が利用できません。npm install duckdb で導入してください'));
    conn.all(sql, ...params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}
function mlExec(sql) {
  return new Promise((resolve, reject) => {
    const conn = getMlDb();
    if (!conn) return reject(new Error('DuckDB が利用できません'));
    conn.exec(sql, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// 外部プロセス (オフラインRL の学習/評価) が DuckDB を read_only で開く前に、
// Node 側の接続を CHECKPOINT してから完全クローズし、排他ロック競合を避ける。
// 解放後は _mlDbExternalHold=true の間 Node 側からはアクセス不可。reacquireMlDb() で再開。
async function releaseMlDbForExternal(ip) {
  try {
    if (_mlDbConn) {
      await mlExec('CHECKPOINT');
      await new Promise((resolve) => _mlDbConn.close(resolve));
      _mlDbConn = null;
    }
    if (_mlDb) {
      await new Promise((resolve) => _mlDb.close(resolve));
      _mlDb = null;
    }
  } catch (e) {
    log(ip || '-', `[ML] DB一時クローズ警告: ${e.message} (続行します)`);
  }
  _mlDbExternalHold = true;
}
// 外部プロセス終了後に呼ぶ。次回 getMlDb() で遅延再接続される。
function reacquireMlDb() {
  _mlDbExternalHold = false;
}

// ─── メタ情報管理（テーブル説明文等） ───
function loadMlMeta() {
  if (!fs.existsSync(ML_META_FILE)) return { tables: {} };
  try { return JSON.parse(fs.readFileSync(ML_META_FILE, 'utf-8')); }
  catch { return { tables: {} }; }
}
function saveMlMeta(meta) {
  fs.writeFileSync(ML_META_FILE, JSON.stringify(meta, null, 2), 'utf-8');
}

// ─── テーブル名検証（SQLインジェクション対策） ───
// 英数字とアンダースコアのみ、最大64文字、先頭は文字
function isValidTableName(name) {
  return typeof name === 'string'
    && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name)
    && !RESERVED_SQL_KEYWORDS.includes(name.toLowerCase());
}
const RESERVED_SQL_KEYWORDS = [
  'select', 'from', 'where', 'insert', 'update', 'delete', 'drop',
  'create', 'alter', 'table', 'index', 'view', 'join', 'union',
];

// ─── SELECT専用判定（LLMアクセス制限用） ───
// シングルステートメント、SELECT/WITHのみ、危険キーワード禁止
function isSafeReadOnlySql(sql) {
  if (typeof sql !== 'string') return false;
  const s = sql.trim().toLowerCase();
  // セミコロンは末尾1つだけ許容
  const semiCount = (s.match(/;/g) || []).length;
  if (semiCount > 1) return false;
  if (semiCount === 1 && !s.endsWith(';')) return false;
  // 先頭が SELECT / WITH 以外は拒否
  if (!/^(select|with)\b/.test(s)) return false;
  // 書き込み・スキーマ変更系のキーワード禁止
  const forbidden = /\b(insert|update|delete|drop|create|alter|attach|copy|export|import|truncate|grant|revoke|pragma|set|call|execute|prepare)\b/;
  if (forbidden.test(s)) return false;
  return true;
}

// ─── テーブル一覧 ───
app.get('/ml/datasets', requireAuth, requirePermission('ml:read'), async (req, res) => {
  try {
    if (_mlDbInitFailed || !getDuckDB()) {
      return res.json({ tables: [], duckdbAvailable: false, hint: 'npm install duckdb を実行してください' });
    }
    const meta = loadMlMeta();
    const rows = await mlQuery(`
      SELECT table_name, estimated_size
      FROM duckdb_tables()
      WHERE schema_name = 'main'
      ORDER BY table_name
    `);
    const tables = await Promise.all(rows.map(async (r) => {
      const name = r.table_name;
      let rowCount = 0;
      try {
        const cnt = await mlQuery(`SELECT COUNT(*) AS c FROM "${name}"`);
        rowCount = Number(cnt[0].c) || 0;
      } catch {}
      return {
        name,
        rowCount,
        description: meta.tables?.[name]?.description || '',
        createdAt: meta.tables?.[name]?.createdAt || null,
        importedFrom: meta.tables?.[name]?.importedFrom || null,
      };
    }));
    res.json({ tables, duckdbAvailable: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── テーブルスキーマ ───
app.get('/ml/datasets/:name/schema', requireAuth, requirePermission('ml:read'), async (req, res) => {
  const name = req.params.name;
  if (!isValidTableName(name)) return res.status(400).json({ error: '無効なテーブル名' });
  try {
    const cols = await mlQuery(`
      SELECT column_name, data_type, is_nullable
      FROM duckdb_columns()
      WHERE schema_name = 'main' AND table_name = ?
      ORDER BY column_index
    `, [name]);
    if (cols.length === 0) return res.status(404).json({ error: 'テーブルが見つかりません' });
    const meta = loadMlMeta();
    const tableMeta = meta.tables?.[name] || {};
    res.json({
      name,
      columns: cols.map(c => ({
        name: c.column_name,
        type: c.data_type,
        nullable: c.is_nullable === true || c.is_nullable === 'YES',
      })),
      description: tableMeta.description || '',
      importedFrom: tableMeta.importedFrom || null,
      apiUrl: tableMeta.apiUrl || null,
      apiMethod: tableMeta.apiMethod || null,
      apiJsonPath: tableMeta.apiJsonPath || null,
      createdAt: tableMeta.createdAt || null,
      updatedAt: tableMeta.updatedAt || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── プレビュー (先頭N行) ───
app.get('/ml/datasets/:name/preview', requireAuth, requirePermission('ml:read'), async (req, res) => {
  const name = req.params.name;
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 1000);
  if (!isValidTableName(name)) return res.status(400).json({ error: '無効なテーブル名' });
  try {
    const rows = await mlQuery(`SELECT * FROM "${name}" LIMIT ${limit}`);
    res.json({ rows: rows.map(serializeRow), count: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DuckDB 戻り値の特殊型(BigInt等)をJSONシリアライズ可能にする
function serializeRow(row) {
  const out = {};
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (typeof v === 'bigint') out[k] = Number(v);
    else if (v instanceof Date) out[k] = v.toISOString();
    else if (v && typeof v === 'object' && v.constructor && v.constructor.name === 'Buffer') out[k] = `<binary ${v.length}B>`;
    else out[k] = v;
  }
  return out;
}

// ─── CSVインポート ───
// body: { tableName, csvContent, mode: 'replace'|'append', description? }
app.post('/ml/datasets/import/csv', requireAuth, requirePermission('ml:write'), jsonParser, async (req, res) => {
  const ip = getIP(req);
  const { tableName, csvContent, mode = 'replace', description = '' } = req.body || {};
  if (!isValidTableName(tableName)) {
    return res.status(400).json({ error: 'テーブル名は英数字とアンダースコアで先頭は文字、64文字以内' });
  }
  if (typeof csvContent !== 'string' || !csvContent.trim()) {
    return res.status(400).json({ error: 'csvContent が空です' });
  }
  // 一時CSVファイルに書き出し → DuckDBの read_csv_auto で取り込み
  const tmpFile = path.join(ML_DIR, `_import_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.csv`);
  try {
    fs.writeFileSync(tmpFile, csvContent, 'utf-8');
    if (mode === 'replace') {
      await mlExec(`DROP TABLE IF EXISTS "${tableName}"`);
    }
    const exists = (await mlQuery(`
      SELECT COUNT(*) AS c FROM duckdb_tables()
      WHERE schema_name = 'main' AND table_name = ?
    `, [tableName]))[0].c;
    if (Number(exists) === 0) {
      // 新規作成
      await mlExec(`CREATE TABLE "${tableName}" AS SELECT * FROM read_csv_auto('${tmpFile.replace(/'/g, "''")}')`);
    } else {
      // 追記 (列構造が一致している前提)
      await mlExec(`INSERT INTO "${tableName}" SELECT * FROM read_csv_auto('${tmpFile.replace(/'/g, "''")}')`);
    }
    const cnt = await mlQuery(`SELECT COUNT(*) AS c FROM "${tableName}"`);
    const rowCount = Number(cnt[0].c) || 0;

    // メタ情報更新
    const meta = loadMlMeta();
    if (!meta.tables) meta.tables = {};
    meta.tables[tableName] = {
      ...(meta.tables[tableName] || {}),
      description: description || meta.tables[tableName]?.description || '',
      createdAt: meta.tables[tableName]?.createdAt || Date.now(),
      updatedAt: Date.now(),
      importedFrom: 'csv',
    };
    saveMlMeta(meta);

    log(ip, `[ML] CSV import: ${tableName} (${mode}, ${rowCount} rows)`);
    res.json({ ok: true, tableName, rowCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

// ─── Web API インポート ───
// body: {
//   tableName, url,
//   method?: 'GET'|'POST' (default GET),
//   headers?: object (例: {"Authorization": "Bearer xxx"}),
//   body?: string|object (POST時のリクエストボディ、object なら JSON.stringify する),
//   jsonPath?: string (応答内の配列の位置、例: "data.items"。空なら応答自体を配列とみなす),
//   mode?: 'replace'|'append' (default replace),
//   description?: string,
//   allowPrivateNetwork?: boolean (SSRF対策をスキップ、デフォルト false)
// }
// 取得した JSON 配列の各要素をフラット化して DuckDB に取り込む。
// ネストオブジェクトはドット記法カラム名 (例: user.name)、配列はJSON文字列化。
app.post('/ml/datasets/import/api', requireAuth, requirePermission('ml:write'), jsonParser, async (req, res) => {
  const ip = getIP(req);
  const {
    tableName, url, method = 'GET', headers = {},
    body, jsonPath = '', mode = 'replace', description = '',
    allowPrivateNetwork = false,
  } = req.body || {};

  if (!isValidTableName(tableName)) {
    return res.status(400).json({ error: 'テーブル名は英数字とアンダースコアで先頭は文字、64文字以内' });
  }
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'url は http(s):// で始まる必要があります' });
  }
  if (!['GET', 'POST', 'PUT'].includes(String(method).toUpperCase())) {
    return res.status(400).json({ error: 'method は GET, POST, PUT のみ' });
  }

  // SSRF対策: localhost や内部IP帯への接続をデフォルト拒否
  let parsedUrl;
  try { parsedUrl = new URL(url); }
  catch { return res.status(400).json({ error: '不正なURL' }); }
  if (!allowPrivateNetwork && isPrivateHostname(parsedUrl.hostname)) {
    return res.status(403).json({
      error: 'localhost や内部IP宛のリクエストはデフォルト拒否されています。許可するには allowPrivateNetwork=true を指定してください。',
    });
  }

  // 一時CSVに書き出して DuckDB の read_csv_auto で取り込み… ではなく
  // 直接 JSON → 配列 → CREATE TABLE AS (SELECT * FROM read_json_auto(...))
  // で扱う。一時 JSON ファイル経由が安全。
  const tmpFile = path.join(ML_DIR, `_import_api_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);

  try {
    // ─── 1. HTTP 取得 ───
    const httpModule = parsedUrl.protocol === 'https:' ? require('https') : require('http');
    const reqOpts = {
      method: String(method).toUpperCase(),
      headers: {
        'User-Agent': 'OpenGeekLLMChat-ML/1.0',
        'Accept': 'application/json',
        ...headers,
      },
      timeout: 30000,
    };
    let reqBody = '';
    if (body !== undefined && body !== null) {
      reqBody = typeof body === 'string' ? body : JSON.stringify(body);
      if (typeof body !== 'string' && !reqOpts.headers['Content-Type']) {
        reqOpts.headers['Content-Type'] = 'application/json';
      }
      reqOpts.headers['Content-Length'] = Buffer.byteLength(reqBody);
    }

    const respText = await new Promise((resolve, reject) => {
      const r = httpModule.request(url, reqOpts, (resp) => {
        // リダイレクト対応（簡易、1段のみ）
        if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location) {
          return reject(new Error(`HTTP ${resp.statusCode}: リダイレクト先 ${resp.headers.location} を直接指定してください`));
        }
        if (resp.statusCode >= 400) {
          return reject(new Error(`HTTP ${resp.statusCode}: ${resp.statusMessage}`));
        }
        let total = 0;
        const MAX_SIZE = 10 * 1024 * 1024;  // 10MB
        const chunks = [];
        resp.on('data', (chunk) => {
          total += chunk.length;
          if (total > MAX_SIZE) {
            resp.destroy();
            return reject(new Error(`応答が大きすぎます (上限 10MB を超過)`));
          }
          chunks.push(chunk);
        });
        resp.on('end', () => {
          try { resolve(Buffer.concat(chunks).toString('utf-8')); }
          catch (e) { reject(e); }
        });
        resp.on('error', reject);
      });
      r.on('timeout', () => { r.destroy(); reject(new Error('タイムアウト (30秒)')); });
      r.on('error', reject);
      if (reqBody) r.write(reqBody);
      r.end();
    });

    // ─── 2. JSON パース + JSON Path 適用 ───
    let json;
    try { json = JSON.parse(respText); }
    catch (e) { throw new Error(`JSON パース失敗: ${e.message}`); }

    let arr = json;
    if (jsonPath && typeof jsonPath === 'string') {
      // "data.items" や "results[0].rows" のような単純ドット記法
      const parts = jsonPath.split('.').map(p => p.trim()).filter(Boolean);
      for (const p of parts) {
        // [N] 形式の配列インデックスにも対応
        const arrMatch = p.match(/^([^\[]+)?(?:\[(\d+)\])?$/);
        if (arrMatch[1]) arr = arr?.[arrMatch[1]];
        if (arrMatch[2] !== undefined) arr = arr?.[parseInt(arrMatch[2])];
        if (arr === undefined || arr === null) {
          throw new Error(`JSON Path "${jsonPath}" の解決失敗: "${p}" が見つかりません`);
        }
      }
    }
    if (!Array.isArray(arr)) {
      throw new Error(`JSON Path の指す値が配列ではありません (型: ${typeof arr})。jsonPath で配列の位置を指定してください。`);
    }
    if (arr.length === 0) {
      throw new Error('取得した配列が空です。jsonPath や URL を確認してください。');
    }

    // ─── 3. 各オブジェクトをフラット化 ───
    const flatRows = arr.map(item => flattenObject(item));

    // ─── 4. 一時 JSON ファイル (1行1オブジェクト = NDJSON) に書き出し → DuckDB が型推論 ───
    fs.writeFileSync(tmpFile, flatRows.map(r => JSON.stringify(r)).join('\n'), 'utf-8');

    if (mode === 'replace') {
      await mlExec(`DROP TABLE IF EXISTS "${tableName}"`);
    }
    const exists = (await mlQuery(`
      SELECT COUNT(*) AS c FROM duckdb_tables()
      WHERE schema_name = 'main' AND table_name = ?
    `, [tableName]))[0].c;
    if (Number(exists) === 0) {
      await mlExec(`CREATE TABLE "${tableName}" AS SELECT * FROM read_json_auto('${tmpFile.replace(/'/g, "''")}', format='newline_delimited')`);
    } else {
      await mlExec(`INSERT INTO "${tableName}" SELECT * FROM read_json_auto('${tmpFile.replace(/'/g, "''")}', format='newline_delimited')`);
    }
    const cnt = await mlQuery(`SELECT COUNT(*) AS c FROM "${tableName}"`);
    const rowCount = Number(cnt[0].c) || 0;

    // ─── 5. メタ情報更新 (取得URLを記録) ───
    const meta = loadMlMeta();
    if (!meta.tables) meta.tables = {};
    meta.tables[tableName] = {
      ...(meta.tables[tableName] || {}),
      description: description || meta.tables[tableName]?.description || '',
      createdAt: meta.tables[tableName]?.createdAt || Date.now(),
      updatedAt: Date.now(),
      importedFrom: 'api',
      apiUrl: url,
      apiMethod: String(method).toUpperCase(),
      apiJsonPath: jsonPath || '',
      // ヘッダー内の機密情報 (Bearer等) は保存しない
      apiHasAuth: !!(headers.Authorization || headers.authorization),
    };
    saveMlMeta(meta);

    log(ip, `[ML] API import: ${tableName} (${mode}, ${rowCount} rows from ${url})`);
    res.json({ ok: true, tableName, rowCount, sampleRow: flatRows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

// プライベートネットワーク判定 (SSRF対策)
function isPrivateHostname(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1') return true;
  // IPv4 アドレス判定
  const ipv4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    const [a, b] = [parseInt(ipv4[1]), parseInt(ipv4[2])];
    if (a === 10) return true;                              // 10.0.0.0/8
    if (a === 127) return true;                             // 127.0.0.0/8 (loopback)
    if (a === 169 && b === 254) return true;                // 169.254.0.0/16 (link-local)
    if (a === 172 && b >= 16 && b <= 31) return true;       // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                // 192.168.0.0/16
  }
  // IPv6 簡易判定
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}

// オブジェクトのフラット化 (ネストobject → ドット記法、配列はJSON文字列化)
// 例: {user: {name: "Alice", age: 30}, tags: ["x"]}
//  → {"user.name": "Alice", "user.age": 30, "tags": "[\"x\"]"}
function flattenObject(obj, prefix = '', out = {}) {
  if (obj === null || obj === undefined) return out;
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    // ルートが配列または primitive の場合は単一カラム 'value' として扱う
    out[prefix || 'value'] = Array.isArray(obj) ? JSON.stringify(obj) : obj;
    return out;
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const key = prefix ? `${prefix}.${k}` : k;
    if (v === null || v === undefined) {
      out[key] = null;
    } else if (Array.isArray(v)) {
      // 配列は JSON 文字列化 (DuckDB 側で json_extract 等が使える)
      out[key] = JSON.stringify(v);
    } else if (typeof v === 'object') {
      flattenObject(v, key, out);
    } else {
      out[key] = v;
    }
  }
  return out;
}

// ─── テーブル説明文の更新 ───
app.put('/ml/datasets/:name', requireAuth, requirePermission('ml:write'), jsonParser, (req, res) => {
  const name = req.params.name;
  if (!isValidTableName(name)) return res.status(400).json({ error: '無効なテーブル名' });
  const { description } = req.body || {};
  const meta = loadMlMeta();
  if (!meta.tables) meta.tables = {};
  if (!meta.tables[name]) meta.tables[name] = { createdAt: Date.now() };
  meta.tables[name].description = String(description || '');
  meta.tables[name].updatedAt = Date.now();
  saveMlMeta(meta);
  res.json({ ok: true });
});

// ─── テーブル削除 ───
app.delete('/ml/datasets/:name', requireAuth, requirePermission('ml:write'), async (req, res) => {
  const ip = getIP(req);
  const name = req.params.name;
  if (!isValidTableName(name)) return res.status(400).json({ error: '無効なテーブル名' });
  try {
    await mlExec(`DROP TABLE IF EXISTS "${name}"`);
    const meta = loadMlMeta();
    if (meta.tables && meta.tables[name]) {
      delete meta.tables[name];
      saveMlMeta(meta);
    }
    log(ip, `[ML] テーブル削除: ${name}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 読み取り専用SQL実行（UIから・LLMツールからも利用） ───
// body: { sql, limit?: number }
app.post('/ml/query', requireAuth, requirePermission('ml:read'), jsonParser, async (req, res) => {
  const ip = getIP(req);
  const { sql, limit = 1000 } = req.body || {};
  if (!isSafeReadOnlySql(sql)) {
    return res.status(400).json({
      error: '読み取り専用SQL(SELECT/WITH)のみ許可されています。書き込み・スキーマ変更は禁止です。',
    });
  }
  // LIMIT が含まれていない場合は強制付与（暴走防止）
  const maxLimit = Math.min(Math.max(parseInt(limit) || 1000, 1), 10000);
  let safeSql = sql.trim().replace(/;$/, '');
  if (!/\blimit\s+\d+/i.test(safeSql)) {
    safeSql = `${safeSql} LIMIT ${maxLimit}`;
  }
  try {
    const startMs = Date.now();
    const rows = await mlQuery(safeSql);
    const elapsedMs = Date.now() - startMs;
    log(ip, `[ML] query (${rows.length} rows, ${elapsedMs}ms)`);
    res.json({
      rows: rows.map(serializeRow),
      count: rows.length,
      elapsedMs,
      truncated: rows.length >= maxLimit,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── APIトークン管理 (補助エンドポイント) ───
// トークン文字列の生成補助 (実際の登録は config.json の apiTokens[] を editconfig.html で編集)
// 例: ogc_<43文字の URL-safe base64> (合計47文字)
app.get('/api-tokens/generate', requireAuth, (req, res) => {
  const token = 'ogc_' + crypto.randomBytes(32).toString('base64url');
  res.json({ token });
});

// 現在のAPIトークン一覧 (トークン文字列は伏せる、名前と権限のみ)
app.get('/api-tokens', requireAuth, (req, res) => {
  const tokens = (appConfig.ml?.apiTokens || []).map(t => ({
    name: t.name || '',
    permissions: t.permissions || [],
    tokenPreview: t.token ? `${t.token.slice(0, 12)}...${t.token.slice(-4)}` : '',
    // フルトークンはセキュリティ上返さない (config.json または editconfig.html で確認)
  }));
  res.json({ tokens });
});


// body: { tableName, rows: object[], createIfMissing?: boolean (default false), description?: string }
// - rows: 1個以上のフラットなオブジェクト配列。ネストはドット記法カラムに、配列はJSON文字列化される
// - createIfMissing: true なら、テーブルが無ければ最初の行からスキーマ推定して自動作成
// 既存テーブルへの追記時は列構造の一致が必須 (DuckDBの INSERT INTO ... SELECT で確認される)
app.post('/ml/datasets/append', requireAuth, requirePermission('ml:write'), jsonParser, async (req, res) => {
  const ip = getIP(req);
  const { tableName, rows, createIfMissing = false, description = '' } = req.body || {};
  if (!isValidTableName(tableName)) {
    return res.status(400).json({ error: 'テーブル名は英数字とアンダースコアで先頭は文字、64文字以内' });
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'rows は1個以上のオブジェクト配列が必要です' });
  }
  if (rows.length > 10000) {
    return res.status(400).json({ error: '1リクエストあたり最大 10000 行までです (大量データはCSV/APIインポート推奨)' });
  }
  // 各行をフラット化
  const flatRows = rows.map(r => {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      throw new Error(`rows[].要素はオブジェクトである必要があります (受信した型: ${Array.isArray(r) ? 'array' : typeof r})`);
    }
    return flattenObject(r);
  });

  const tmpFile = path.join(ML_DIR, `_append_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  try {
    fs.writeFileSync(tmpFile, flatRows.map(r => JSON.stringify(r)).join('\n'), 'utf-8');

    const exists = (await mlQuery(`
      SELECT COUNT(*) AS c FROM duckdb_tables()
      WHERE schema_name = 'main' AND table_name = ?
    `, [tableName]))[0].c;

    if (Number(exists) === 0) {
      if (!createIfMissing) {
        return res.status(404).json({
          error: `テーブル "${tableName}" が存在しません。createIfMissing: true を指定するか、先にテーブルを作成してください。`,
        });
      }
      // 新規作成 (最初の行からスキーマ推定)
      await mlExec(`CREATE TABLE "${tableName}" AS SELECT * FROM read_json_auto('${tmpFile.replace(/'/g, "''")}', format='newline_delimited')`);
    } else {
      // 既存テーブルに追記
      await mlExec(`INSERT INTO "${tableName}" SELECT * FROM read_json_auto('${tmpFile.replace(/'/g, "''")}', format='newline_delimited')`);
    }
    const cnt = await mlQuery(`SELECT COUNT(*) AS c FROM "${tableName}"`);
    const rowCount = Number(cnt[0].c) || 0;

    // メタ情報更新 (新規作成時のみ)
    if (Number(exists) === 0) {
      const meta = loadMlMeta();
      if (!meta.tables) meta.tables = {};
      meta.tables[tableName] = {
        description: description || '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        importedFrom: 'append',
      };
      saveMlMeta(meta);
    } else if (description) {
      // 既存テーブルでも description が指定されたら更新
      const meta = loadMlMeta();
      if (meta.tables && meta.tables[tableName]) {
        meta.tables[tableName].description = description;
        meta.tables[tableName].updatedAt = Date.now();
        saveMlMeta(meta);
      }
    }

    log(ip, `[ML] append: ${tableName} (+${flatRows.length} rows, total ${rowCount})`);
    res.json({
      ok: true,
      tableName,
      appended: flatRows.length,
      totalRows: rowCount,
      created: Number(exists) === 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

// ═══════════════════════════════════════════════════════════════════
// 🧠 ML: モデル & 学習ジョブ管理 (Phase 3)
// ═══════════════════════════════════════════════════════════════════
// ml_runner.py で PyTorch 学習を行う。
// モデル名 = 識別子 (英数字+_)。models/<name>/ ディレクトリに成果物を保存。
// 現在実行中のジョブは1個まで (GPU/CPU 競合回避)。
// currentMlJob は ML セクション先頭で宣言済み。

function loadMlModels() {
  if (!fs.existsSync(ML_MODELS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(ML_MODELS_FILE, 'utf-8')); }
  catch { return []; }
}
function saveMlModels(models) {
  fs.writeFileSync(ML_MODELS_FILE, JSON.stringify(models, null, 2), 'utf-8');
}
function loadMlJobs() {
  if (!fs.existsSync(ML_JOBS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(ML_JOBS_FILE, 'utf-8')); }
  catch { return []; }
}
function saveMlJobs(jobs) {
  fs.writeFileSync(ML_JOBS_FILE, JSON.stringify(jobs, null, 2), 'utf-8');
}

// モデル名検証 (テーブル名と同じルール)
const isValidModelName = isValidTableName;

// ─── モデル一覧 ───
app.get('/ml/models', requireAuth, requirePermission('ml:read'), (req, res) => {
  const models = loadMlModels();
  // 学習済みかどうか (model.pt の存在) も付与
  const enriched = models.map(m => {
    const modelDir = path.join(ML_MODELS_DIR, m.name);
    const trained = fs.existsSync(path.join(modelDir, 'model.pt'));
    let metrics = null;
    let predictHint = null;  // 推論時に必要な入力情報 (LLM/UI 向け)
    try {
      const mp = path.join(modelDir, 'metrics.json');
      if (fs.existsSync(mp)) {
        const j = JSON.parse(fs.readFileSync(mp, 'utf-8'));
        metrics = {
          finalTestLoss: j.finalTestLoss,
          finalAccuracy: j.finalAccuracy,
          finalMAE: j.finalMAE,
          finalRMSE: j.finalRMSE,
          trainSamples: j.trainSamples,
          testSamples: j.testSamples,
          elapsedSec: j.elapsedSec,
        };
      }
      // 推論用ヒント: ml_predict 呼び出し時に必要な特徴量 + サンプル
      const cfgPath = path.join(modelDir, 'config.json');
      if (fs.existsSync(cfgPath)) {
        const savedCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        const originalFeatures = savedCfg.originalFeatures || savedCfg.features || [];
        const datetimeSourceCols = savedCfg.datetimeSourceCols || [];
        // サンプル入力を生成
        const exampleInput = {};
        for (const f of originalFeatures) {
          if (datetimeSourceCols.includes(f)) {
            exampleInput[f] = '2027-04-15';
          } else {
            const lf = f.toLowerCase();
            if (/region|area|city|地域|都市/.test(lf)) exampleInput[f] = 'Tokyo';
            else if (/product|item|商品/.test(lf)) exampleInput[f] = 'ProductA';
            else if (/quantity|qty|count|数量|個数/.test(lf)) exampleInput[f] = 5;
            else exampleInput[f] = '(値)';
          }
        }
        predictHint = {
          requiredFeatures: originalFeatures,
          datetimeColumns: datetimeSourceCols,  // 自動分解される日時列
          exampleInput,
          note: datetimeSourceCols.length > 0
            ? `日時列 ${datetimeSourceCols.join(',')} は元の日付文字列 (例: "2027-04-15") を渡してください。内部で自動的に year/month/day/dayofweek/dayofyear/is_weekend に分解されます。date_year のような派生列名を直接渡さないでください。`
            : '各特徴量を学習時の元の値で渡してください。',
        };
      }
    } catch {}
    return { ...m, trained, metrics, predictHint };
  });
  res.json({ models: enriched, runningJob: currentMlJob ? { jobId: currentMlJob.jobId, modelName: currentMlJob.modelName } : null });
});

// ─── モデル定義の作成・更新 ───
// body: { name, task, tableName, features, target, timeCol?, windowSize?, epochs, learningRate, ... }
app.post('/ml/models', requireAuth, requirePermission('ml:write'), jsonParser, (req, res) => {
  const ip = getIP(req);
  const def = req.body || {};
  if (!isValidModelName(def.name)) return res.status(400).json({ error: 'モデル名は英数字とアンダースコアで先頭は文字、64文字以内' });
  if (!['regression', 'classification', 'timeseries'].includes(def.task)) {
    return res.status(400).json({ error: 'task は regression/classification/timeseries' });
  }
  if (!isValidTableName(def.tableName)) return res.status(400).json({ error: '無効なテーブル名' });
  if (!Array.isArray(def.features) || def.features.length === 0) {
    return res.status(400).json({ error: 'features は1個以上の配列必須' });
  }
  if (typeof def.target !== 'string' || !def.target) return res.status(400).json({ error: 'target 必須' });
  if (def.task === 'timeseries' && (!def.timeCol || typeof def.timeCol !== 'string')) {
    return res.status(400).json({ error: '時系列タスクには timeCol が必要' });
  }

  const models = loadMlModels();
  const idx = models.findIndex(m => m.name === def.name);
  const now = Date.now();
  const entry = {
    name: def.name,
    task: def.task,
    tableName: def.tableName,
    features: def.features,
    target: def.target,
    timeCol: def.timeCol || null,
    windowSize: def.windowSize || (def.task === 'timeseries' ? 7 : null),
    epochs: parseInt(def.epochs) || 300,
    learningRate: parseFloat(def.learningRate) || 0.001,
    batchSize: parseInt(def.batchSize) || 32,
    hiddenSize: parseInt(def.hiddenSize) || 64,
    numLayers: parseInt(def.numLayers) || 2,
    testRatio: parseFloat(def.testRatio) || 0.2,
    description: def.description || '',
    createdAt: idx >= 0 ? models[idx].createdAt : now,
    updatedAt: now,
  };
  if (idx >= 0) models[idx] = entry;
  else models.push(entry);
  saveMlModels(models);
  log(ip, `[ML] モデル定義 ${idx >= 0 ? '更新' : '作成'}: ${def.name}`);
  res.json({ ok: true, model: entry });
});

// ─── モデル削除 ───
app.delete('/ml/models/:name', requireAuth, requirePermission('ml:write'), (req, res) => {
  const ip = getIP(req);
  const name = req.params.name;
  if (!isValidModelName(name)) return res.status(400).json({ error: '無効なモデル名' });
  const models = loadMlModels();
  const idx = models.findIndex(m => m.name === name);
  if (idx < 0) return res.status(404).json({ error: 'モデルが見つかりません' });
  models.splice(idx, 1);
  saveMlModels(models);
  // モデルファイルも削除
  const modelDir = path.join(ML_MODELS_DIR, name);
  if (fs.existsSync(modelDir)) {
    try { fs.rmSync(modelDir, { recursive: true, force: true }); } catch {}
  }
  log(ip, `[ML] モデル削除: ${name}`);
  res.json({ ok: true });
});

// ─── ジョブ一覧 ───
app.get('/ml/jobs', requireAuth, requirePermission('ml:read'), (req, res) => {
  const jobs = loadMlJobs();
  // 新しい順
  jobs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  res.json({ jobs: jobs.slice(0, 50), running: currentMlJob ? currentMlJob.jobId : null });
});

// ─── ジョブのログ取得 (実行中) ───
app.get('/ml/jobs/:id/log', requireAuth, requirePermission('ml:read'), (req, res) => {
  const jobId = req.params.id;
  // 実行中のログはメモリ
  if (currentMlJob && currentMlJob.jobId === jobId) {
    return res.json({ running: true, log: currentMlJob.log.join('') });
  }
  // 完了済みはファイル
  const jobs = loadMlJobs();
  const job = jobs.find(j => j.id === jobId);
  if (!job) return res.status(404).json({ error: 'ジョブが見つかりません' });
  const logFile = path.join(ML_MODELS_DIR, job.modelName, 'train.log');
  if (fs.existsSync(logFile)) {
    res.json({ running: false, log: fs.readFileSync(logFile, 'utf-8') });
  } else {
    res.json({ running: false, log: '(ログがありません)' });
  }
});

// ─── 学習ジョブ開始 ───
// body: { modelName }
app.post('/ml/jobs/start', requireAuth, requirePermission('ml:write'), jsonParser, async (req, res) => {
  const ip = getIP(req);
  const { modelName } = req.body || {};
  if (currentMlJob) {
    return res.status(409).json({ error: `既に学習中: ${currentMlJob.modelName} (jobId: ${currentMlJob.jobId})` });
  }
  if (!isValidModelName(modelName)) return res.status(400).json({ error: '無効なモデル名' });
  const models = loadMlModels();
  const model = models.find(m => m.name === modelName);
  if (!model) return res.status(404).json({ error: 'モデル定義が見つかりません' });

  // 重要: DuckDB は排他ロック (https://duckdb.org/docs/stable/connect/concurrency)。
  // Node.js が DB を開いた状態だと Python が read_only でも開けない。
  // → 学習前に CHECKPOINT (WAL を本体にフラッシュ) してから Node 側の接続を完全クローズし、
  //   Python 側で開いて読み込む。Python 終了後に Node 側で再オープン。
  try {
    if (_mlDbConn) {
      log(ip, `[ML] CHECKPOINT 実行 + DB接続を学習用に一時クローズ`);
      await mlExec('CHECKPOINT');
      await new Promise((resolve) => _mlDbConn.close(resolve));
      _mlDbConn = null;
    }
    if (_mlDb) {
      await new Promise((resolve) => _mlDb.close(resolve));
      _mlDb = null;
    }
  } catch (e) {
    log(ip, `[ML] DB クローズ警告: ${e.message} (続行します)`);
  }

  const jobId = `mljob_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const modelDir = path.join(ML_MODELS_DIR, modelName);
  if (!fs.existsSync(modelDir)) fs.mkdirSync(modelDir, { recursive: true });
  const tmpCfg = path.join(modelDir, '_run_config.json');
  const runConfig = {
    ...model,
    modelName: model.name,
    outputDir: modelDir,
    dbPath: ML_DB_FILE,
  };
  fs.writeFileSync(tmpCfg, JSON.stringify(runConfig, null, 2));

  const pythonCmd = appConfig.pythonPath || 'python3';
  const scriptPath = path.join(__dirname, 'ml_runner.py');
  if (!fs.existsSync(scriptPath)) {
    return res.status(500).json({ error: `ml_runner.py が見つかりません: ${scriptPath}` });
  }

  log(ip, `[ML] ジョブ開始: ${modelName} (jobId: ${jobId})`);

  // ジョブ履歴に記録
  const jobs = loadMlJobs();
  const jobEntry = {
    id: jobId,
    modelName: model.name,
    task: model.task,
    tableName: model.tableName,
    epochs: model.epochs,
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
  };
  jobs.push(jobEntry);
  saveMlJobs(jobs);

  // 実行
  const { spawn } = require('child_process');
  const proc = spawn(pythonCmd, [scriptPath, tmpCfg], {
    cwd: __dirname,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });
  const logFile = path.join(modelDir, 'train.log');
  const logStream = fs.createWriteStream(logFile, { flags: 'w' });

  currentMlJob = {
    jobId,
    modelName: model.name,
    proc,
    log: [],
    startedAt: Date.now(),
  };

  const handleData = (data) => {
    const str = data.toString();
    currentMlJob && currentMlJob.log.push(str);
    // メモリ消費抑制: 1000行超で先頭から削除
    if (currentMlJob && currentMlJob.log.length > 1000) {
      currentMlJob.log = currentMlJob.log.slice(-800);
    }
    logStream.write(str);
  };
  proc.stdout.on('data', handleData);
  proc.stderr.on('data', handleData);
  proc.on('error', (err) => {
    // spawn失敗 (python不在等)。捕捉しないとサーバーがクラッシュする
    try { logStream.write(`\n[プロセス起動エラー] ${err.message}\n`); logStream.end(); } catch {}
    try { fs.unlinkSync(tmpCfg); } catch {}
    const allJobs = loadMlJobs();
    const j = allJobs.find(jj => jj.id === jobId);
    if (j) { j.status = 'failed'; j.error = err.message; j.endedAt = Date.now(); saveMlJobs(allJobs); }
    log('-', `[ML学習 ${jobId}] プロセス起動失敗: ${err.message}`);
    currentMlJob = null;
  });
  proc.on('close', (code) => {
    logStream.end();
    try { fs.unlinkSync(tmpCfg); } catch {}
    const allJobs = loadMlJobs();
    const j = allJobs.find(jj => jj.id === jobId);
    if (j) {
      j.status = code === 0 ? 'completed' : 'failed';
      j.endedAt = Date.now();
      j.exitCode = code;
      // metrics.json から最終値を取り込み (UI 表示用)
      try {
        const mp = path.join(modelDir, 'metrics.json');
        if (fs.existsSync(mp)) {
          const m = JSON.parse(fs.readFileSync(mp, 'utf-8'));
          j.finalTestLoss = m.finalTestLoss;
          j.finalAccuracy = m.finalAccuracy;
          j.finalMAE = m.finalMAE;
        }
      } catch {}
      saveMlJobs(allJobs);
    }
    log('-', `[ML] ジョブ終了: ${modelName} (jobId: ${jobId}, code: ${code})`);
    currentMlJob = null;
    // ジョブ完了したのでNode.js側のDB接続を遅延再オープン
    // (次のクエリで自動的に getMlDb() が呼ばれて新規接続される)
    // → 何もしなくてOK、_mlDb/_mlDbConn は null のままなので次回アクセス時に再接続
  });
  proc.on('error', (err) => {
    log('-', `[ML] ジョブ起動エラー: ${err.message}`);
    currentMlJob = null;
  });

  res.json({ ok: true, jobId, modelName: model.name });
});

// ─── ジョブ停止 ───
app.post('/ml/jobs/:id/stop', requireAuth, requirePermission('ml:write'), (req, res) => {
  const ip = getIP(req);
  const jobId = req.params.id;
  if (!currentMlJob || currentMlJob.jobId !== jobId) {
    return res.status(404).json({ error: '実行中のジョブが見つかりません' });
  }
  try {
    currentMlJob.proc.kill('SIGTERM');
    setTimeout(() => {
      if (currentMlJob && currentMlJob.proc && !currentMlJob.proc.killed) {
        try { currentMlJob.proc.kill('SIGKILL'); } catch {}
      }
    }, 3000);
    log(ip, `[ML] ジョブ停止要求: ${jobId}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── モデルメトリクス取得 (学習履歴グラフ用) ───
app.get('/ml/models/:name/metrics', requireAuth, requirePermission('ml:read'), (req, res) => {
  const name = req.params.name;
  if (!isValidModelName(name)) return res.status(400).json({ error: '無効なモデル名' });
  const mp = path.join(ML_MODELS_DIR, name, 'metrics.json');
  if (!fs.existsSync(mp)) return res.status(404).json({ error: 'メトリクスが見つかりません (未学習?)' });
  try {
    const m = JSON.parse(fs.readFileSync(mp, 'utf-8'));
    res.json(m);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── モデルの設定情報を取得 (特徴量カラム、カテゴリ候補値など) ───
// UIの「予測を試す」フォームや LLM の予測呼び出し前に必要な情報
app.get('/ml/models/:name/config', requireAuth, requirePermission('ml:read'), (req, res) => {
  const name = req.params.name;
  if (!isValidModelName(name)) return res.status(400).json({ error: '無効なモデル名' });
  const cfgPath = path.join(ML_MODELS_DIR, name, 'config.json');
  if (!fs.existsSync(cfgPath)) return res.status(404).json({ error: 'モデル設定が見つかりません (未学習?)' });
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    // label_encoders から各カテゴリ列のクラス一覧を取得して同梱
    // (UIで select の選択肢として使うため)
    // pickleはNode.jsで直接読めないので、Python で読むのが理想だが
    // 学習時に config.json にも書き込むようにしてもよい (今後)
    // 現状は config 単独で返す
    res.json(cfg);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 推論 ───
// body: { features: { col1: val, col2: val } | [{ ... }, { ... }] }
//   - 単一辞書 → 1件予測
//   - 辞書配列 → 複数件バッチ予測 (上限100件)
//   - 時系列: features は配列の配列 [[v1,v2,v3], ...]
// ─── ML推論 共通関数 (エンドポイントと agent_proxy から共用) ───
// modelName とfeatures (辞書 or 配列) を受けて ml_predict.py を実行、結果JSONを返す
// ════════════════════════════════════════════════
// 画像物体検出 (torchvision, COCO事前学習)
// ════════════════════════════════════════════════
// /ml.html の「画像」タブから利用。base64画像を受けて image_detect.py で検出。

// 外部コマンド (zip) に依存せず、Node標準の zlib だけで ZIP ファイルを生成する。
// files: [{ name: 'model.pt', data: Buffer }] を受け取り、ZIP の Buffer を返す。
// STORE (無圧縮) と DEFLATE (圧縮) を自動選択。本番に zip コマンドが無くても動く。
function buildZipBuffer(files) {
  const zlib = require('zlib');
  const chunks = [];           // ローカルファイルレコード
  const central = [];          // セントラルディレクトリ
  let offset = 0;

  // CRC32 計算 (テーブル方式)
  const crcTable = buildZipBuffer._crcTable || (buildZipBuffer._crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })());
  const crc32 = (buf) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };

  const dosTime = 0, dosDate = 0x21;  // 1980-01-01 固定 (zip仕様の最小値)

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf-8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf-8');
    const crc = crc32(raw);
    // 圧縮判定:
    //  - f.store === true が指定されていれば圧縮しない (model.pt 等、既に縮まないバイナリ)
    //  - 8MB超のファイルは圧縮スキップ (deflateRawSync が大きいファイルで重く、
    //    Node のメインスレッドをブロックして他リクエストが詰まる)
    //  - それ以外は圧縮してみて、縮まなければ STORE にフォールバック
    let comp, method;
    const STORE_THRESHOLD = 8 * 1024 * 1024;
    if (f.store === true || raw.length > STORE_THRESHOLD) {
      comp = raw; method = 0;  // STORE (無圧縮)
    } else {
      comp = zlib.deflateRawSync(raw);
      method = 8;  // DEFLATE
      if (comp.length >= raw.length) { comp = raw; method = 0; }  // STORE
    }

    // ローカルファイルヘッダ
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);   // signature
    lh.writeUInt16LE(20, 4);           // version needed
    lh.writeUInt16LE(0x0800, 6);       // flags (bit11: UTF-8 ファイル名)
    lh.writeUInt16LE(method, 8);       // 圧縮方式
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); // 圧縮後サイズ
    lh.writeUInt32LE(raw.length, 22);  // 元サイズ
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);           // extra field length
    chunks.push(lh, nameBuf, comp);

    // セントラルディレクトリレコード
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);   // signature
    ch.writeUInt16LE(20, 4);           // version made by
    ch.writeUInt16LE(20, 6);           // version needed
    ch.writeUInt16LE(0x0800, 8);       // flags
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);           // extra
    ch.writeUInt16LE(0, 32);           // comment
    ch.writeUInt16LE(0, 34);           // disk number
    ch.writeUInt16LE(0, 36);           // internal attrs
    ch.writeUInt32LE(0, 38);           // external attrs
    ch.writeUInt32LE(offset, 42);      // ローカルヘッダのオフセット
    central.push(Buffer.concat([ch, nameBuf]));

    offset += lh.length + nameBuf.length + comp.length;
  }

  const centralBuf = Buffer.concat(central);
  const centralOffset = offset;

  // End of Central Directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}


// 対応モデル (image_detect.py の SUPPORTED_MODELS と揃える)
const IMAGE_DETECT_MODELS = [
  { name: 'fasterrcnn_resnet50_fpn', label: 'Faster R-CNN (ResNet50)', note: '高精度・標準', speed: '中' },
  { name: 'fasterrcnn_mobilenet_v3_large_fpn', label: 'Faster R-CNN (MobileNetV3)', note: '軽量・高速', speed: '速' },
  { name: 'retinanet_resnet50_fpn', label: 'RetinaNet (ResNet50)', note: '1段検出', speed: '中' },
  { name: 'ssd300_vgg16', label: 'SSD300 (VGG16)', note: '軽量', speed: '速' },
  { name: 'ssdlite320_mobilenet_v3_large', label: 'SSDLite320 (MobileNetV3)', note: '最軽量', speed: '最速' },
];
const IMAGE_DETECT_MODEL_NAMES = IMAGE_DETECT_MODELS.map(m => m.name);

// 画像物体検出を実行 (base64画像 → 一時ファイル → image_detect.py)
function runImageDetect(imageBase64, modelName, threshold, customModelName, opts) {
  return new Promise((resolve, reject) => {
    const isCustom = !!customModelName;
    if (isCustom) {
      if (!isValidDatasetName(customModelName)) {
        return reject(new Error('無効なカスタムモデル名'));
      }
      const cfgPath = path.join(IMAGE_MODELS_DIR, customModelName, 'config.json');
      if (!fs.existsSync(cfgPath)) {
        return reject(new Error(`カスタムモデルが見つかりません: ${customModelName}`));
      }
    } else if (modelName && !IMAGE_DETECT_MODEL_NAMES.includes(modelName)) {
      return reject(new Error(`未対応のモデル: ${modelName}`));
    }
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return reject(new Error('image (base64) が必要です'));
    }
    // data URL プレフィックスを除去
    const b64 = imageBase64.replace(/^data:image\/[a-zA-Z+]+;base64,/, '');
    let buf;
    try {
      buf = Buffer.from(b64, 'base64');
    } catch {
      return reject(new Error('base64 のデコードに失敗しました'));
    }
    if (buf.length === 0) return reject(new Error('画像データが空です'));
    if (buf.length > MAX_FILE_SIZE) return reject(new Error('画像が大きすぎます'));

    // 一時ファイルに保存 (拡張子はpngで固定、torchvision read_image が判別)
    const tmpPath = path.join(os.tmpdir(), `imgdetect_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.img`);
    try {
      fs.writeFileSync(tmpPath, buf);
    } catch (e) {
      return reject(new Error(`一時ファイル書き込み失敗: ${e.message}`));
    }

    const pythonCmd = appConfig.pythonPath || 'python3';
    const scriptPath = path.join(__dirname, 'image_detect.py');
    if (!fs.existsSync(scriptPath)) {
      try { fs.unlinkSync(tmpPath); } catch {}
      return reject(new Error('image_detect.py が見つかりません'));
    }

    const argv = [
      scriptPath,
      '--image', tmpPath,
      '--threshold', String(threshold ?? 0.5),
      '--cache-dir', TORCH_CACHE_DIR,
    ];
    if (isCustom) {
      argv.push('--custom-model-dir', path.join(IMAGE_MODELS_DIR, customModelName));
    } else {
      argv.push('--model', modelName || 'fasterrcnn_resnet50_fpn');
    }
    const { spawn } = require('child_process');
    const proc = spawn(pythonCmd, argv, {
      cwd: __dirname,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    // 初回はモデルweightダウンロードがあるので長めの120秒
    const timeout = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 120000);

    const cleanup = () => { try { fs.unlinkSync(tmpPath); } catch {} };

    proc.on('close', (code) => {
      clearTimeout(timeout);
      cleanup();
      // stdout から JSON を抽出 (進捗バーが混ざる可能性に備え、最後の { から } までを試す)
      const tryParseJson = (s) => {
        if (!s) return null;
        try { return JSON.parse(s.trim()); } catch {}
        // 末尾の JSON オブジェクトを抽出 (前に余計な出力がある場合)
        const start = s.lastIndexOf('{');
        const end = s.lastIndexOf('}');
        if (start !== -1 && end > start) {
          try { return JSON.parse(s.slice(start, end + 1)); } catch {}
        }
        return null;
      };

      const parsed = tryParseJson(stdout);
      if (code !== 0) {
        // Python が吐いたエラーJSON を最優先
        if (parsed && parsed.error) {
          return reject(new Error(parsed.error));
        }
        // stderr から進捗バー (\r を含む行) を除去して本当のエラーだけ残す
        const cleanErr = stderr
          .split('\n')
          .map(line => line.split('\r').pop())  // \r で上書きされる進捗は最後だけ残る
          .filter(line => !/^\s*\d+%\|/.test(line) && line.trim())  // 進捗バー行を除外
          .join('\n')
          .trim();
        return reject(new Error(`検出失敗 (exit ${code}): ${cleanErr.slice(0, 400) || '詳細不明'}`));
      }
      // 成功時
      if (parsed) return resolve(parsed);
      reject(new Error(`検出結果のパース失敗: ${stdout.slice(0, 200)}`));
    });
    proc.on('error', (err) => { clearTimeout(timeout); cleanup(); reject(new Error(`検出プロセス起動失敗: ${err.message}`)); });
  });
}

// 画像検出: 対応モデル一覧
app.get('/ml/image/models', requireAuth, requirePermission('ml:read'), (req, res) => {
  res.json({ models: IMAGE_DETECT_MODELS });
});

// 画像検出: 推論実行
// body: { image: "<base64 or data URL>", model?: "fasterrcnn_resnet50_fpn", threshold?: 0.5 }
app.post('/ml/image/detect', requireAuth, requirePermission('ml:read'), jsonParser, async (req, res) => {
  const ip = getIP(req);
  const { image, model, threshold, customModel } = req.body || {};
  try {
    const th = typeof threshold === 'number' ? Math.min(Math.max(threshold, 0), 1) : 0.5;
    const result = await runImageDetect(image, model, th, customModel);
    log(ip, `[画像検出] ${result.model}: ${result.count}個検出 (${result.device})`);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════
// 画像物体検出 カスタム学習 (Phase 2)
// ════════════════════════════════════════════════
// データセット (画像+アノテーション) を管理し、torchvision fasterrcnn を
// ファインチューニングして独自クラスの検出モデルを作る。

// データセット名のバリデーション (英数字・ハイフン・アンダースコア)
function isValidDatasetName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(name);
}

// ─── CSV パーサ (アノテーションのCSVインポート用) ───
// ヘッダ行必須。ダブルクォート("...")で囲んだフィールド内のカンマ・改行・""(エスケープ)に対応。
// 返り値: ヘッダをキー(小文字・トリム)にした行オブジェクトの配列。
function parseCsv(text) {
  const s = String(text || '').replace(/^﻿/, '');  // BOM除去
  const rows = [];
  let field = '', row = [], inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); field = ''; row = []; }
      else if (c === '\r') { /* CRLF の CR は無視 */ }
      else field += c;
    }
  }
  // 末尾フィールド/行
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  // 完全な空行を除去
  const cleaned = rows.filter(r => r.some(v => String(v).trim() !== ''));
  if (cleaned.length === 0) return [];
  const headers = cleaned[0].map(h => String(h).trim().toLowerCase());
  const out = [];
  for (let r = 1; r < cleaned.length; r++) {
    const obj = {};
    for (let c = 0; c < headers.length; c++) obj[headers[c]] = (cleaned[r][c] !== undefined ? cleaned[r][c] : '').trim();
    out.push(obj);
  }
  return out;
}

// 行オブジェクトから、別名候補のいずれかに一致する値を返す (見つからなければ '')
function csvField(rowObj, aliases) {
  for (const a of aliases) {
    if (rowObj[a] !== undefined && rowObj[a] !== '') return rowObj[a];
  }
  return '';
}

// CSVのファイル名を、データセット内の画像エントリに対応づける索引を作る。
// originalName / 保存ファイル名 / それぞれの basename(パス・拡張子) で引けるようにする。
function buildImageFileIndex(images) {
  const index = {};
  const add = (key, entry) => {
    if (!key) return;
    const k = String(key).trim().toLowerCase();
    if (k && !(k in index)) index[k] = entry;
  };
  const variants = (nameStr) => {
    const base = String(nameStr).replace(/\\/g, '/').split('/').pop();  // パス除去
    const noext = base.replace(/\.[^.]+$/, '');
    return [nameStr, base, noext];
  };
  for (const im of images) {
    for (const v of variants(im.originalName || '')) add(v, im);
    for (const v of variants(im.file || '')) add(v, im);
  }
  return index;
}

// データセットのメタ情報をロード
function loadImageDataset(name) {
  const metaPath = path.join(IMAGE_DATASETS_DIR, name, 'dataset.json');
  if (!fs.existsSync(metaPath)) return null;
  try { return JSON.parse(fs.readFileSync(metaPath, 'utf-8')); }
  catch { return null; }
}

// データセットのメタ情報を保存
function saveImageDataset(name, meta) {
  const dir = path.join(IMAGE_DATASETS_DIR, name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, 'images'))) fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dataset.json'), JSON.stringify(meta, null, 2), 'utf-8');
}

// データセット一覧
app.get('/ml/image/datasets', requireAuth, requirePermission('ml:read'), (req, res) => {
  try {
    const datasets = [];
    for (const name of fs.readdirSync(IMAGE_DATASETS_DIR)) {
      const meta = loadImageDataset(name);
      if (meta) {
        datasets.push({
          name,
          classes: meta.classes || [],
          imageCount: (meta.images || []).length,
          annotatedCount: (meta.images || []).filter(im => (im.boxes || []).length > 0).length,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
        });
      }
    }
    datasets.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    res.json({ datasets });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// データセット作成
app.post('/ml/image/datasets', requireAuth, requirePermission('ml:write'), jsonParser, (req, res) => {
  const ip = getIP(req);
  const { name, classes } = req.body || {};
  if (!isValidDatasetName(name)) {
    return res.status(400).json({ error: 'データセット名は英数字・ハイフン・アンダースコア (1-64文字)' });
  }
  if (loadImageDataset(name)) {
    return res.status(409).json({ error: `データセット「${name}」は既に存在します` });
  }
  if (!Array.isArray(classes) || classes.length === 0) {
    return res.status(400).json({ error: '最低1つのクラス名が必要です' });
  }
  const cleanClasses = classes.map(c => String(c).trim()).filter(Boolean);
  if (cleanClasses.length === 0) {
    return res.status(400).json({ error: '有効なクラス名がありません' });
  }
  const meta = {
    name,
    classes: cleanClasses,
    images: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  saveImageDataset(name, meta);
  log(ip, `[画像学習] データセット作成: ${name} (クラス: ${cleanClasses.join(', ')})`);
  res.json({ ok: true, dataset: meta });
});

// データセット詳細 (画像一覧 + アノテーション)
app.get('/ml/image/datasets/:name', requireAuth, requirePermission('ml:read'), (req, res) => {
  const { name } = req.params;
  if (!isValidDatasetName(name)) return res.status(400).json({ error: '無効なデータセット名' });
  const meta = loadImageDataset(name);
  if (!meta) return res.status(404).json({ error: 'データセットが見つかりません' });
  res.json({ dataset: meta });
});

// データセット削除
app.delete('/ml/image/datasets/:name', requireAuth, requirePermission('ml:write'), (req, res) => {
  const ip = getIP(req);
  const { name } = req.params;
  if (!isValidDatasetName(name)) return res.status(400).json({ error: '無効なデータセット名' });
  const dir = path.join(IMAGE_DATASETS_DIR, name);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'データセットが見つかりません' });
  fs.rmSync(dir, { recursive: true, force: true });
  log(ip, `[画像学習] データセット削除: ${name}`);
  res.json({ ok: true });
});

// データセットに画像を追加 (base64)
// body: { images: [{ name, data }] }  data は base64 or data URL
app.post('/ml/image/datasets/:name/images', requireAuth, requirePermission('ml:write'), jsonParser, (req, res) => {
  const ip = getIP(req);
  const { name } = req.params;
  if (!isValidDatasetName(name)) return res.status(400).json({ error: '無効なデータセット名' });
  const meta = loadImageDataset(name);
  if (!meta) return res.status(404).json({ error: 'データセットが見つかりません' });

  const { images } = req.body || {};
  if (!Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: 'images が必要です' });
  }
  const imagesDir = path.join(IMAGE_DATASETS_DIR, name, 'images');
  if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
  const added = [];
  const errors = [];

  // ブラウザで表示でき、かつ torchvision でも安定して読める形式に限定する
  // (TIFF / RAW / HEIC 等はブラウザの <img> タグで表示できないため拒否)
  // 拡張子だけでなく、ファイル先頭バイナリ(マジックバイト)でも検証して
  // 拡張子を偽装したファイルも弾く。
  const SUPPORTED_EXTS = ['.jpg', '.jpeg', '.png', '.bmp', '.webp'];
  const detectImageType = (buf) => {
    if (!buf || buf.length < 12) return null;
    // JPEG: FF D8 FF
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
    // BMP: 42 4D
    if (buf[0] === 0x42 && buf[1] === 0x4D) return 'bmp';
    // WebP: "RIFF" + 4byte size + "WEBP"
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
    // TIFF (拒否対象): 49 49 2A 00 (little-endian) または 4D 4D 00 2A (big-endian)
    if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2A && buf[3] === 0x00) ||
        (buf[0] === 0x4D && buf[1] === 0x4D && buf[2] === 0x00 && buf[3] === 0x2A)) return 'tiff';
    // GIF: "GIF8"
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
    // HEIC: 4〜11バイト目に "ftypheic" 等
    if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'heic';
    return null;
  };

  for (const im of images) {
    try {
      const b64 = String(im.data || '').replace(/^data:image\/[a-zA-Z+]+;base64,/, '');
      const buf = Buffer.from(b64, 'base64');
      if (buf.length === 0) throw new Error('画像データが空');
      if (buf.length > MAX_FILE_SIZE) throw new Error('画像が大きすぎます');

      // マジックバイトで実際の形式を判定 (拡張子偽装の防止)
      const detected = detectImageType(buf);
      if (!detected) {
        throw new Error('画像として認識できません');
      }
      if (detected === 'tiff') {
        throw new Error('TIFF はブラウザで表示できないため非対応です (JPEG / PNG に変換してください)');
      }
      if (detected === 'heic') {
        throw new Error('HEIC はブラウザで表示できないため非対応です (JPEG / PNG に変換してください)');
      }
      if (detected === 'gif') {
        throw new Error('GIF は学習に向かないため非対応です (JPEG / PNG に変換してください)');
      }
      // 拡張子は実際の形式に合わせる (元ファイル名が偽装でも安全な拡張子で保存)
      const ext = detected === 'jpg' ? '.jpg' : `.${detected}`;
      const imgId = `img_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const fileName = `${imgId}${ext}`;
      fs.writeFileSync(path.join(imagesDir, fileName), buf);
      const imgEntry = { id: imgId, file: fileName, originalName: im.name || fileName, boxes: [], addedAt: Date.now() };
      meta.images.push(imgEntry);
      added.push(imgEntry);
    } catch (e) {
      errors.push({ name: im.name, error: e.message });
    }
  }
  meta.updatedAt = Date.now();
  saveImageDataset(name, meta);
  log(ip, `[画像学習] ${name} に画像追加: ${added.length}件 (失敗: ${errors.length})`);
  res.json({ ok: true, added, errors });
});

// データセットの画像ファイルを返す (アノテーション画面の表示用)
app.get('/ml/image/datasets/:name/images/:file', requireAuth, requirePermission('ml:read'), (req, res) => {
  const { name, file } = req.params;
  if (!isValidDatasetName(name)) return res.status(400).json({ error: '無効なデータセット名' });
  // ファイル名のトラバーサル防止
  if (!/^[a-zA-Z0-9_.-]+$/.test(file)) return res.status(400).json({ error: '無効なファイル名' });
  const filePath = path.join(IMAGE_DATASETS_DIR, name, 'images', file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '画像が見つかりません' });
  res.sendFile(filePath);
});

// 画像のアノテーション (矩形) を保存
// body: { imageId, boxes: [{ classIndex, x1, y1, x2, y2 }] }
app.put('/ml/image/datasets/:name/annotations/:imageId', requireAuth, requirePermission('ml:write'), jsonParser, (req, res) => {
  const { name, imageId } = req.params;
  if (!isValidDatasetName(name)) return res.status(400).json({ error: '無効なデータセット名' });
  const meta = loadImageDataset(name);
  if (!meta) return res.status(404).json({ error: 'データセットが見つかりません' });
  const img = (meta.images || []).find(im => im.id === imageId);
  if (!img) return res.status(404).json({ error: '画像が見つかりません' });

  const { boxes } = req.body || {};
  if (!Array.isArray(boxes)) return res.status(400).json({ error: 'boxes が必要です' });
  // バリデーション: classIndex が範囲内、座標が数値
  const clean = [];
  for (const b of boxes) {
    const ci = Number(b.classIndex);
    if (!Number.isInteger(ci) || ci < 0 || ci >= meta.classes.length) continue;
    const x1 = Number(b.x1), y1 = Number(b.y1), x2 = Number(b.x2), y2 = Number(b.y2);
    if ([x1, y1, x2, y2].some(v => !Number.isFinite(v))) continue;
    clean.push({
      classIndex: ci,
      x1: Math.min(x1, x2), y1: Math.min(y1, y2),
      x2: Math.max(x1, x2), y2: Math.max(y1, y2),
    });
  }
  img.boxes = clean;
  meta.updatedAt = Date.now();
  saveImageDataset(name, meta);
  res.json({ ok: true, boxCount: clean.length });
});

// データセットから画像を削除
app.delete('/ml/image/datasets/:name/images/:imageId', requireAuth, requirePermission('ml:write'), (req, res) => {
  const { name, imageId } = req.params;
  if (!isValidDatasetName(name)) return res.status(400).json({ error: '無効なデータセット名' });
  const meta = loadImageDataset(name);
  if (!meta) return res.status(404).json({ error: 'データセットが見つかりません' });
  const idx = (meta.images || []).findIndex(im => im.id === imageId);
  if (idx === -1) return res.status(404).json({ error: '画像が見つかりません' });
  const [removed] = meta.images.splice(idx, 1);
  // ファイル削除
  try { fs.unlinkSync(path.join(IMAGE_DATASETS_DIR, name, 'images', removed.file)); } catch {}
  meta.updatedAt = Date.now();
  saveImageDataset(name, meta);
  res.json({ ok: true });
});

// YOLO/COCO 形式のアノテーションをインポート
// body: { format: 'yolo'|'coco', data: <文字列 or オブジェクト>, imageId? }
// yolo: "classIndex cx cy w h" (正規化座標、1行1box) を imageId に適用
// coco: COCOフォーマットJSON (images/annotations/categories) を一括適用
app.post('/ml/image/datasets/:name/import', requireAuth, requirePermission('ml:write'), jsonParser, (req, res) => {
  const ip = getIP(req);
  const { name } = req.params;
  if (!isValidDatasetName(name)) return res.status(400).json({ error: '無効なデータセット名' });
  const meta = loadImageDataset(name);
  if (!meta) return res.status(404).json({ error: 'データセットが見つかりません' });

  const { format, data, imageId, imageWidth, imageHeight } = req.body || {};
  try {
    if (format === 'yolo') {
      // YOLO: imageId 指定の1画像に対して適用 (正規化座標 → ピクセル座標)
      const img = (meta.images || []).find(im => im.id === imageId);
      if (!img) return res.status(404).json({ error: 'imageId が必要 (YOLO形式は画像単位)' });
      if (!imageWidth || !imageHeight) return res.status(400).json({ error: 'imageWidth/imageHeight が必要' });
      const lines = String(data).trim().split('\n').filter(Boolean);
      const boxes = [];
      for (const line of lines) {
        const [ci, cx, cy, w, h] = line.trim().split(/\s+/).map(Number);
        if (!Number.isInteger(ci) || ci < 0 || ci >= meta.classes.length) continue;
        if ([cx, cy, w, h].some(v => !Number.isFinite(v))) continue;
        // 正規化(中心x,中心y,幅,高さ) → ピクセル(x1,y1,x2,y2)
        const px1 = (cx - w / 2) * imageWidth;
        const py1 = (cy - h / 2) * imageHeight;
        const px2 = (cx + w / 2) * imageWidth;
        const py2 = (cy + h / 2) * imageHeight;
        boxes.push({ classIndex: ci, x1: px1, y1: py1, x2: px2, y2: py2 });
      }
      img.boxes = boxes;
      meta.updatedAt = Date.now();
      saveImageDataset(name, meta);
      log(ip, `[画像学習] YOLOインポート: ${name}/${imageId} (${boxes.length} boxes)`);
      return res.json({ ok: true, boxCount: boxes.length });
    } else if (format === 'coco') {
      // COCO: ファイル名でマッチングして一括適用
      const coco = typeof data === 'string' ? JSON.parse(data) : data;
      const catIdToClassIndex = {};
      // COCO categories → データセットのクラスインデックスにマッピング (名前一致)
      for (const cat of coco.categories || []) {
        const idx = meta.classes.indexOf(cat.name);
        if (idx !== -1) catIdToClassIndex[cat.id] = idx;
      }
      // image_id → ファイル名
      const imgIdToFile = {};
      for (const cimg of coco.images || []) imgIdToFile[cimg.id] = cimg.file_name;
      // ファイル名 → データセットの画像エントリ (originalName で照合)
      const fileToEntry = {};
      for (const im of meta.images) fileToEntry[im.originalName] = im;

      let applied = 0;
      const grouped = {};
      for (const ann of coco.annotations || []) {
        const ci = catIdToClassIndex[ann.category_id];
        if (ci === undefined) continue;
        const file = imgIdToFile[ann.image_id];
        const entry = fileToEntry[file];
        if (!entry) continue;
        // COCO bbox = [x, y, width, height]
        const [x, y, w, h] = ann.bbox;
        if (!grouped[entry.id]) grouped[entry.id] = [];
        grouped[entry.id].push({ classIndex: ci, x1: x, y1: y, x2: x + w, y2: y + h });
      }
      for (const [eid, boxes] of Object.entries(grouped)) {
        const entry = meta.images.find(im => im.id === eid);
        if (entry) { entry.boxes = boxes; applied++; }
      }
      meta.updatedAt = Date.now();
      saveImageDataset(name, meta);
      log(ip, `[画像学習] COCOインポート: ${name} (${applied}画像に適用)`);
      return res.json({ ok: true, appliedImages: applied });
    } else if (format === 'csv') {
      // CSV (ロング形式): 1行=1矩形。ファイル名で既存画像に紐付け。
      //   列: filename, class, x1, y1, x2, y2  (別名: file/image/name, label/category, xmin..ymax)
      const rows = parseCsv(data);
      if (rows.length === 0) return res.status(400).json({ error: 'CSVに有効な行がありません (ヘッダ行が必要です)' });
      const index = buildImageFileIndex(meta.images || []);
      const grouped = {};   // imageId -> boxes[]
      const errors = [];
      let matched = 0, skipped = 0;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const fname = csvField(r, ['filename', 'file', 'image', 'name', 'img']);
        const entry = fname ? index[String(fname).trim().toLowerCase()] : null;
        if (!entry) { skipped++; if (errors.length < 10) errors.push(`行${i + 2}: 画像「${fname}」が見つかりません`); continue; }
        const cls = csvField(r, ['class', 'label', 'category', 'classname']);
        let ci = meta.classes.indexOf(cls);
        if (ci === -1 && /^\d+$/.test(cls)) ci = parseInt(cls, 10);  // クラス番号も許可
        if (!Number.isInteger(ci) || ci < 0 || ci >= meta.classes.length) {
          skipped++; if (errors.length < 10) errors.push(`行${i + 2}: クラス「${cls}」が不明`); continue;
        }
        const x1 = Number(csvField(r, ['x1', 'xmin', 'left']));
        const y1 = Number(csvField(r, ['y1', 'ymin', 'top']));
        const x2 = Number(csvField(r, ['x2', 'xmax', 'right']));
        const y2 = Number(csvField(r, ['y2', 'ymax', 'bottom']));
        if ([x1, y1, x2, y2].some(v => !Number.isFinite(v))) {
          skipped++; if (errors.length < 10) errors.push(`行${i + 2}: 座標が数値ではありません`); continue;
        }
        if (!grouped[entry.id]) grouped[entry.id] = [];
        grouped[entry.id].push({
          classIndex: ci,
          x1: Math.min(x1, x2), y1: Math.min(y1, y2),
          x2: Math.max(x1, x2), y2: Math.max(y1, y2),
        });
        matched++;
      }
      // CSVに出てきた画像だけ boxes を置き換える (出てこない画像は触らない)
      let appliedImages = 0;
      for (const [eid, boxes] of Object.entries(grouped)) {
        const entry = meta.images.find(im => im.id === eid);
        if (entry) { entry.boxes = boxes; appliedImages++; }
      }
      meta.updatedAt = Date.now();
      saveImageDataset(name, meta);
      log(ip, `[画像学習] CSVインポート: ${name} (${matched}矩形 / ${appliedImages}画像, スキップ${skipped})`);
      return res.json({ ok: true, appliedImages, boxCount: matched, skipped, errors });
    } else {
      return res.status(400).json({ error: 'format は yolo / coco / csv' });
    }
  } catch (e) {
    res.status(500).json({ error: `インポート失敗: ${e.message}` });
  }
});

// ─── 画像学習ジョブ (表データ学習とは別系統) ───
let currentImageJob = null;  // { jobId, datasetName, modelName, proc, log: [] }
let currentRlJob = null;     // 強化学習(RL)ジョブ { jobId, name, env, proc, log: [] }

const IMAGE_JOBS_FILE = path.join(ML_DIR, 'image_jobs.json');
function loadImageJobs() {
  if (!fs.existsSync(IMAGE_JOBS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(IMAGE_JOBS_FILE, 'utf-8')); }
  catch { return []; }
}
function saveImageJobs(jobs) {
  fs.writeFileSync(IMAGE_JOBS_FILE, JSON.stringify(jobs.slice(0, 50), null, 2), 'utf-8');
}

// 学習対応のベースモデル
const IMAGE_TRAIN_BASE_MODELS = [
  { name: 'fasterrcnn_resnet50_fpn', label: 'Faster R-CNN (ResNet50)', note: '高精度・やや重い' },
  { name: 'fasterrcnn_mobilenet_v3_large_fpn', label: 'Faster R-CNN (MobileNetV3)', note: '軽量・少量データ向き' },
  { name: 'scratch', label: '事前学習なし (ゼロから学習)', note: '⚠️ 大量データ・多エポックが必要、少量では精度が出ません' },
];

app.get('/ml/image/train/models', requireAuth, requirePermission('ml:read'), (req, res) => {
  res.json({ baseModels: IMAGE_TRAIN_BASE_MODELS });
});

// カスタムモデル学習を開始
// body: { datasetName, modelName, baseModel?, epochs?, batchSize?, lr? }
app.post('/ml/image/train', requireAuth, requirePermission('ml:write'), jsonParser, (req, res) => {
  const ip = getIP(req);
  if (currentImageJob) {
    return res.status(409).json({ error: `既に画像学習中: ${currentImageJob.modelName}` });
  }
  const { datasetName, modelName, baseModel, epochs, batchSize, lr } = req.body || {};
  if (!isValidDatasetName(datasetName)) return res.status(400).json({ error: '無効なデータセット名' });
  if (!isValidDatasetName(modelName)) return res.status(400).json({ error: 'モデル名は英数字・ハイフン・アンダースコア' });

  const meta = loadImageDataset(datasetName);
  if (!meta) return res.status(404).json({ error: 'データセットが見つかりません' });
  const annotated = (meta.images || []).filter(im => (im.boxes || []).length > 0);
  if (annotated.length === 0) {
    return res.status(400).json({ error: 'アノテーション済みの画像がありません。矩形を描画してから学習してください' });
  }
  const base = (baseModel && IMAGE_TRAIN_BASE_MODELS.some(m => m.name === baseModel))
    ? baseModel : 'fasterrcnn_resnet50_fpn';

  const datasetDir = path.join(IMAGE_DATASETS_DIR, datasetName);
  const outputDir = path.join(IMAGE_MODELS_DIR, modelName);
  const pythonCmd = appConfig.pythonPath || 'python3';
  const scriptPath = path.join(__dirname, 'image_train.py');
  if (!fs.existsSync(scriptPath)) return res.status(500).json({ error: 'image_train.py が見つかりません' });

  const jobId = `imgjob_${Date.now()}`;
  const argv = [
    scriptPath,
    '--dataset-dir', datasetDir,
    '--output-dir', outputDir,
    '--base-model', base,
    '--epochs', String(Math.min(Math.max(parseInt(epochs) || 10, 1), 200)),
    '--batch-size', String(Math.min(Math.max(parseInt(batchSize) || 2, 1), 16)),
    '--lr', String(typeof lr === 'number' ? lr : 0.005),
    '--cache-dir', TORCH_CACHE_DIR,
  ];

  const { spawn } = require('child_process');
  const proc = spawn(pythonCmd, argv, { cwd: __dirname, env: { ...process.env, PYTHONUNBUFFERED: '1' }, detached: true });

  currentImageJob = { jobId, datasetName, modelName, baseModel: base, proc, log: [], startedAt: Date.now() };
  log(ip, `[画像学習] 開始: ${modelName} (データセット: ${datasetName}, ${annotated.length}枚, ${base})`);

  proc.stdout.on('data', d => { currentImageJob.log.push(d.toString()); });
  proc.stderr.on('data', d => {
    // 進捗バー以外を記録
    const s = d.toString();
    if (!/^\s*\d+%\|/.test(s)) currentImageJob.log.push(s);
  });

  proc.on('close', (code) => {
    const fullLog = currentImageJob.log.join('');
    const wasCancelled = currentImageJob.cancelled;  // キャンセルされたか
    // RESULT_JSON: の行を探して結果を取り出す
    let result = null;
    const m = fullLog.match(/RESULT_JSON:(.+)/);
    if (m) { try { result = JSON.parse(m[1]); } catch {} }

    const jobs = loadImageJobs();
    jobs.unshift({
      jobId, datasetName, modelName, baseModel: base,
      status: wasCancelled ? 'cancelled' : ((code === 0 && result?.status === 'completed') ? 'completed' : 'failed'),
      finalLoss: result?.finalLoss ?? null,
      device: result?.device ?? null,
      note: result?.note ?? null,
      error: wasCancelled ? null : (result?.error ?? (code !== 0 ? `exit ${code}` : null)),
      startedAt: currentImageJob.startedAt,
      finishedAt: Date.now(),
      log: fullLog.slice(-5000),  // 末尾5000文字だけ保存
    });
    saveImageJobs(jobs);
    log('-', `[画像学習] 終了: ${modelName} (exit ${code}, ${wasCancelled ? 'cancelled' : (result?.status || 'failed')})`);
    currentImageJob = null;
  });
  proc.on('error', (err) => {
    log('-', `[画像学習] プロセスエラー: ${err.message}`);
    currentImageJob = null;
  });

  res.json({ ok: true, jobId });
});

// 学習ジョブの状態 + ログ
app.get('/ml/image/train/status', requireAuth, requirePermission('ml:read'), (req, res) => {
  if (currentImageJob) {
    return res.json({
      running: true,
      jobId: currentImageJob.jobId,
      modelName: currentImageJob.modelName,
      datasetName: currentImageJob.datasetName,
      log: currentImageJob.log.join(''),
    });
  }
  // 直近の完了ジョブ
  const jobs = loadImageJobs();
  res.json({ running: false, recentJobs: jobs.slice(0, 10) });
});

// 学習中ジョブのキャンセル
app.post('/ml/image/train/cancel', requireAuth, requirePermission('ml:write'), (req, res) => {
  if (!currentImageJob) return res.status(400).json({ error: '学習中のジョブがありません' });
  currentImageJob.cancelled = true;  // close ハンドラで cancelled として記録するため
  const pid = currentImageJob.proc && currentImageJob.proc.pid;
  // detached なのでプロセスグループ全体を kill (torchの子プロセスごと)
  if (pid) {
    try { process.kill(-pid, 'SIGKILL'); }
    catch { try { currentImageJob.proc.kill('SIGKILL'); } catch {} }
  }
  res.json({ ok: true });
});

// カスタム学習済みモデル一覧
app.get('/ml/image/custom-models', requireAuth, requirePermission('ml:read'), (req, res) => {
  try {
    const models = [];
    for (const name of fs.readdirSync(IMAGE_MODELS_DIR)) {
      const cfgPath = path.join(IMAGE_MODELS_DIR, name, 'config.json');
      const modelPath = path.join(IMAGE_MODELS_DIR, name, 'model.pt');
      if (fs.existsSync(cfgPath) && fs.existsSync(modelPath)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
          let metrics = null;
          const mpath = path.join(IMAGE_MODELS_DIR, name, 'metrics.json');
          if (fs.existsSync(mpath)) { try { metrics = JSON.parse(fs.readFileSync(mpath, 'utf-8')); } catch {} }
          models.push({
            name,
            classes: cfg.classes || [],
            baseModel: cfg.baseModel,
            datasetName: cfg.datasetName,
            trainedAt: cfg.trainedAt,
            finalLoss: metrics?.finalLoss ?? null,
          });
        } catch {}
      }
    }
    models.sort((a, b) => (b.trainedAt || 0) - (a.trainedAt || 0));
    res.json({ models });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// カスタムモデル削除
app.delete('/ml/image/custom-models/:name', requireAuth, requirePermission('ml:write'), (req, res) => {
  const { name } = req.params;
  if (!isValidDatasetName(name)) return res.status(400).json({ error: '無効なモデル名' });
  const dir = path.join(IMAGE_MODELS_DIR, name);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'モデルが見つかりません' });
  fs.rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true });
});

// カスタムモデルを zip でダウンロード
// model.pt + config.json + metrics.json + predict_example.py + README.txt を固める
app.get('/ml/image/custom-models/:name/download', requireAuth, requirePermission('ml:read'), (req, res) => {
  const { name } = req.params;
  if (!isValidDatasetName(name)) return res.status(400).json({ error: '無効なモデル名' });
  const dir = path.join(IMAGE_MODELS_DIR, name);
  const cfgPath = path.join(dir, 'config.json');
  if (!fs.existsSync(cfgPath)) return res.status(404).json({ error: 'モデルが見つかりません' });

  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); }
  catch { return res.status(500).json({ error: 'config.json の読み込みに失敗' }); }

  // 使い方サンプル (Python) を生成
  const classesPy = JSON.stringify(cfg.classes || []);
  const isScratch = cfg.baseModel === 'scratch';
  const exampleScript = `#!/usr/bin/env python3
"""
${name} - OpenGeekLLMChat カスタム物体検出モデルの推論サンプル

必要なパッケージ:
  pip install torch torchvision pillow

使い方:
  python predict_example.py <画像ファイル>
"""
import sys
import json
import torch
import torchvision
from torchvision.io import read_image
from torchvision.transforms.functional import convert_image_dtype

# このモデルの情報 (config.json と同じ)
CLASSES = ${classesPy}  # 0始まりのクラス名
BASE_MODEL = ${JSON.stringify(cfg.baseModel || 'fasterrcnn_resnet50_fpn')}
NUM_CLASSES = len(CLASSES) + 1  # +1 は背景クラス
THRESHOLD = 0.5

def build_model():
    from torchvision.models.detection.faster_rcnn import FastRCNNPredictor
    if BASE_MODEL == 'scratch':
        # 事前学習なしで学習したモデル
        model = torchvision.models.detection.fasterrcnn_resnet50_fpn(
            weights=None, weights_backbone=None, num_classes=NUM_CLASSES)
    else:
        model_fn = getattr(torchvision.models.detection, BASE_MODEL)
        model = model_fn(weights=None)
        in_features = model.roi_heads.box_predictor.cls_score.in_features
        model.roi_heads.box_predictor = FastRCNNPredictor(in_features, NUM_CLASSES)
    return model

def main():
    if len(sys.argv) < 2:
        print("使い方: python predict_example.py <画像ファイル>")
        sys.exit(1)
    image_path = sys.argv[1]

    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    model = build_model()
    model.load_state_dict(torch.load('model.pt', map_location='cpu'))
    model.eval().to(device)

    img = read_image(image_path)
    if img.shape[0] == 1:
        img = img.repeat(3, 1, 1)
    elif img.shape[0] == 4:
        img = img[:3, :, :]
    img_f = convert_image_dtype(img, dtype=torch.float).to(device)

    with torch.no_grad():
        out = model([img_f])[0]

    results = []
    for box, label, score in zip(out['boxes'].tolist(), out['labels'].tolist(), out['scores'].tolist()):
        if score < THRESHOLD:
            continue
        # labelId は 1始まり (背景0) → CLASSES は 0始まり
        cls_name = CLASSES[label - 1] if 0 <= label - 1 < len(CLASSES) else f"id_{label}"
        results.append({
            'label': cls_name,
            'score': round(score, 3),
            'box': [round(v, 1) for v in box],
        })
    print(json.dumps({'detections': results, 'count': len(results)}, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
`;

  const readme = `OpenGeekLLMChat カスタム物体検出モデル: ${name}
${'='.repeat(50)}

このモデルについて:
  ベースモデル : ${cfg.baseModel || '-'}${isScratch ? ' (事前学習なし)' : ''}
  クラス       : ${(cfg.classes || []).join(', ')}
  学習日時     : ${cfg.trainedAt ? new Date(cfg.trainedAt * 1000).toLocaleString('ja-JP') : '-'}

含まれるファイル:
  model.pt            学習済みの重み (PyTorch state_dict)
  config.json         モデル設定 (クラス名・ベースモデル等)
  metrics.json        学習指標 (loss推移)
  predict_example.py  推論サンプルスクリプト

使い方:
  1. pip install torch torchvision pillow
  2. python predict_example.py 画像.jpg

注意:
  - これは torchvision の Faster R-CNN 形式の state_dict です。
  - predict_example.py と同じディレクトリに model.pt を置いてください。
  - GPU(CUDA/ROCm)があれば自動で使われます。なければCPUで動作します。
`;

  // メモリ上で zip を生成 (外部コマンド・一時ファイル不要)
  try {
    const files = [];
    // model.pt は torch の state_dict で内部的に既に圧縮済み。DEFLATE しても縮まず
    // 圧縮処理だけが重いので store: true で無圧縮指定する。
    files.push({ name: `${name}/model.pt`, data: fs.readFileSync(path.join(dir, 'model.pt')), store: true });
    files.push({ name: `${name}/config.json`, data: fs.readFileSync(cfgPath) });
    const metricsPath = path.join(dir, 'metrics.json');
    if (fs.existsSync(metricsPath)) {
      files.push({ name: `${name}/metrics.json`, data: fs.readFileSync(metricsPath) });
    }
    files.push({ name: `${name}/predict_example.py`, data: Buffer.from(exampleScript, 'utf-8') });
    files.push({ name: `${name}/README.txt`, data: Buffer.from(readme, 'utf-8') });

    log(getIP(req), `[画像学習] モデルDL開始: ${name}`);
    const t0 = Date.now();
    const zipBuf = buildZipBuffer(files);
    log(getIP(req), `[画像学習] モデルDL zip生成: ${name} (${(zipBuf.length / 1024 / 1024).toFixed(1)}MB, ${Date.now() - t0}ms)`);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.zip"`);
    res.setHeader('Content-Length', zipBuf.length);
    res.end(zipBuf);
  } catch (e) {
    log(getIP(req), `[画像学習] モデルDL失敗: ${name} - ${e.message}`);
    if (!res.headersSent) res.status(500).json({ error: `zip生成に失敗: ${e.message}` });
  }
});

// ════════════════════════════════════════════════════════════════════════
// 画像キーポイント検出 (torchvision Keypoint R-CNN)
// ════════════════════════════════════════════════════════════════════════
// 手の関節など「対象(バウンディングボックス)+順序付きのキーポイント(点)」を
// 関連付けて学習・推論する。画像物体検出とは別系統のデータセット・モデルを使う。
// COCO事前学習 (人物17点) での推論と、カスタム学習の両方に対応。

// 画像のマジックバイトから形式を判定する (拡張子偽装の防止)。
// 物体検出の画像追加と同じ基準: ブラウザ表示でき torchvision でも読める形式に限定。
function detectImageMagic(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  if (buf[0] === 0x42 && buf[1] === 0x4D) return 'bmp';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2A && buf[3] === 0x00) ||
      (buf[0] === 0x4D && buf[1] === 0x4D && buf[2] === 0x00 && buf[3] === 0x2A)) return 'tiff';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'heic';
  return null;
}

// データセットのメタ情報をロード / 保存
function loadKeypointDataset(name) {
  const metaPath = path.join(KEYPOINT_DATASETS_DIR, name, 'dataset.json');
  if (!fs.existsSync(metaPath)) return null;
  try { return JSON.parse(fs.readFileSync(metaPath, 'utf-8')); }
  catch { return null; }
}
function saveKeypointDataset(name, meta) {
  const dir = path.join(KEYPOINT_DATASETS_DIR, name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, 'images'))) fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dataset.json'), JSON.stringify(meta, null, 2), 'utf-8');
}

// ─── 推論モデル (COCO事前学習) ───
const KEYPOINT_DETECT_MODELS = [
  { name: 'keypointrcnn_resnet50_fpn', label: 'Keypoint R-CNN (ResNet50)', note: 'COCO人物17点', speed: '中' },
];

// キーポイント検出を実行 (base64画像 → 一時ファイル → image_keypoint_detect.py)
function runKeypointDetect(imageBase64, threshold, customModelName, opts) {
  return new Promise((resolve, reject) => {
    const isCustom = !!customModelName;
    let is3dModel = false;  // カスタムモデルが3D回帰モデルか
    if (isCustom) {
      if (!isValidDatasetName(customModelName)) {
        return reject(new Error('無効なカスタムモデル名'));
      }
      const cfgPath = path.join(KEYPOINT_MODELS_DIR, customModelName, 'config.json');
      if (!fs.existsSync(cfgPath)) {
        return reject(new Error(`カスタムモデルが見つかりません: ${customModelName}`));
      }
      try { is3dModel = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).dim === '3d'; } catch {}
    }
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return reject(new Error('image (base64) が必要です'));
    }
    const b64 = imageBase64.replace(/^data:image\/[a-zA-Z+]+;base64,/, '');
    let buf;
    try { buf = Buffer.from(b64, 'base64'); }
    catch { return reject(new Error('base64 のデコードに失敗しました')); }
    if (buf.length === 0) return reject(new Error('画像データが空です'));
    if (buf.length > MAX_FILE_SIZE) return reject(new Error('画像が大きすぎます'));

    const tmpPath = path.join(os.tmpdir(), `kpdetect_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.img`);
    try { fs.writeFileSync(tmpPath, buf); }
    catch (e) { return reject(new Error(`一時ファイル書き込み失敗: ${e.message}`)); }

    const pythonCmd = appConfig.pythonPath || 'python3';
    // 3Dモデルは ResNet回帰スクリプト、それ以外(COCO/2Dカスタム)は Keypoint R-CNN スクリプト
    const scriptName = is3dModel ? 'image_keypoint3d_detect.py' : 'image_keypoint_detect.py';
    const scriptPath = path.join(__dirname, scriptName);
    if (!fs.existsSync(scriptPath)) {
      try { fs.unlinkSync(tmpPath); } catch {}
      return reject(new Error(`${scriptName} が見つかりません`));
    }

    const argv = [scriptPath, '--image', tmpPath, '--cache-dir', TORCH_CACHE_DIR];
    if (is3dModel) {
      // 3D回帰: しきい値/最大数の概念は無い。カスタムモデルディレクトリのみ。
      argv.push('--custom-model-dir', path.join(KEYPOINT_MODELS_DIR, customModelName));
    } else {
      argv.push('--threshold', String(threshold ?? 0.5));
      if (isCustom) {
        argv.push('--custom-model-dir', path.join(KEYPOINT_MODELS_DIR, customModelName));
      }
      if (opts && Number.isInteger(opts.maxInstances) && opts.maxInstances > 0) {
        argv.push('--max-instances', String(opts.maxInstances));
      }
    }

    const { spawn } = require('child_process');
    const proc = spawn(pythonCmd, argv, {
      cwd: __dirname,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    const timeout = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 120000);
    const cleanup = () => { try { fs.unlinkSync(tmpPath); } catch {} };

    proc.on('close', (code) => {
      clearTimeout(timeout);
      cleanup();
      const tryParseJson = (s) => {
        if (!s) return null;
        try { return JSON.parse(s.trim()); } catch {}
        const start = s.lastIndexOf('{');
        const end = s.lastIndexOf('}');
        if (start !== -1 && end > start) {
          try { return JSON.parse(s.slice(start, end + 1)); } catch {}
        }
        return null;
      };
      const parsed = tryParseJson(stdout);
      if (code !== 0) {
        if (parsed && parsed.error) return reject(new Error(parsed.error));
        const cleanErr = stderr
          .split('\n')
          .map(line => line.split('\r').pop())
          .filter(line => !/^\s*\d+%\|/.test(line) && line.trim())
          .join('\n')
          .trim();
        return reject(new Error(`検出失敗 (exit ${code}): ${cleanErr.slice(0, 400) || '詳細不明'}`));
      }
      if (parsed) return resolve(parsed);
      reject(new Error(`検出結果のパース失敗: ${stdout.slice(0, 200)}`));
    });
    proc.on('error', (err) => { clearTimeout(timeout); cleanup(); reject(new Error(`検出プロセス起動失敗: ${err.message}`)); });
  });
}

// 推論: 対応モデル一覧
app.get('/ml/image/keypoint/models', requireAuth, requirePermission('ml:read'), (req, res) => {
  res.json({ models: KEYPOINT_DETECT_MODELS });
});

// 推論: 実行
// body: { image: "<base64 or data URL>", threshold?: 0.5, customModel?: "name", maxInstances?: n }
app.post('/ml/image/keypoint/detect', requireAuth, requirePermission('ml:read'), jsonParser, async (req, res) => {
  const ip = getIP(req);
  const { image, threshold, customModel, maxInstances } = req.body || {};
  try {
    const th = typeof threshold === 'number' ? Math.min(Math.max(threshold, 0), 1) : 0.5;
    const opts = {};
    if (Number.isInteger(maxInstances)) opts.maxInstances = maxInstances;
    const result = await runKeypointDetect(image, th, customModel, opts);
    log(ip, `[キーポイント検出] ${result.model}: ${result.count}個検出 (${result.device})`);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── データセット管理 ───

// データセット一覧
app.get('/ml/image/keypoint/datasets', requireAuth, requirePermission('ml:read'), (req, res) => {
  try {
    const datasets = [];
    for (const name of fs.readdirSync(KEYPOINT_DATASETS_DIR)) {
      const meta = loadKeypointDataset(name);
      if (meta) {
        datasets.push({
          name,
          keypoints: meta.keypoints || [],
          dim: meta.dim === '3d' ? '3d' : '2d',
          imageCount: (meta.images || []).length,
          annotatedCount: (meta.images || []).filter(im => (im.instances || []).length > 0).length,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
        });
      }
    }
    datasets.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    res.json({ datasets });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// データセット作成
// body: { name, keypoints: ["wrist","thumb_tip",...], skeleton?: [[0,1],...], dim?: '2d'|'3d' }
//   dim='3d' は奥行き z も学習する3Dキーポイント (ResNet回帰、単一インスタンス)
app.post('/ml/image/keypoint/datasets', requireAuth, requirePermission('ml:write'), jsonParser, (req, res) => {
  const ip = getIP(req);
  const { name, keypoints, skeleton, dim } = req.body || {};
  if (!isValidDatasetName(name)) {
    return res.status(400).json({ error: 'データセット名は英数字・ハイフン・アンダースコア (1-64文字)' });
  }
  if (loadKeypointDataset(name)) {
    return res.status(409).json({ error: `データセット「${name}」は既に存在します` });
  }
  if (!Array.isArray(keypoints) || keypoints.length === 0) {
    return res.status(400).json({ error: '最低1つのキーポイント名が必要です' });
  }
  const cleanKp = keypoints.map(c => String(c).trim()).filter(Boolean);
  if (cleanKp.length === 0) {
    return res.status(400).json({ error: '有効なキーポイント名がありません' });
  }
  // 骨格エッジ (任意): [a,b] のペアで、各端点はキーポイント番号の範囲内
  let cleanSkeleton = [];
  if (Array.isArray(skeleton)) {
    for (const e of skeleton) {
      if (!Array.isArray(e) || e.length !== 2) continue;
      const a = Number(e[0]), b = Number(e[1]);
      if (!Number.isInteger(a) || !Number.isInteger(b)) continue;
      if (a < 0 || a >= cleanKp.length || b < 0 || b >= cleanKp.length) continue;
      cleanSkeleton.push([a, b]);
    }
  }
  const meta = {
    name,
    task: 'keypoint',
    dim: dim === '3d' ? '3d' : '2d',
    keypoints: cleanKp,
    skeleton: cleanSkeleton,
    images: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  saveKeypointDataset(name, meta);
  log(ip, `[キーポイント学習] データセット作成: ${name} (点: ${cleanKp.join(', ')})`);
  res.json({ ok: true, dataset: meta });
});

// データセット詳細
app.get('/ml/image/keypoint/datasets/:name', requireAuth, requirePermission('ml:read'), (req, res) => {
  const { name } = req.params;
  if (!isValidDatasetName(name)) return res.status(400).json({ error: '無効なデータセット名' });
  const meta = loadKeypointDataset(name);
  if (!meta) return res.status(404).json({ error: 'データセットが見つかりません' });
  res.json({ dataset: meta });
});

// データセット削除
app.delete('/ml/image/keypoint/datasets/:name', requireAuth, requirePermission('ml:write'), (req, res) => {
  const ip = getIP(req);
  const { name } = req.params;
  if (!isValidDatasetName(name)) return res.status(400).json({ error: '無効なデータセット名' });
  const dir = path.join(KEYPOINT_DATASETS_DIR, name);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'データセットが見つかりません' });
  fs.rmSync(dir, { recursive: true, force: true });
  log(ip, `[キーポイント学習] データセット削除: ${name}`);
  res.json({ ok: true });
});

// データセットに画像を追加 (base64)
// body: { images: [{ name, data }] }  data は base64 or data URL
app.post('/ml/image/keypoint/datasets/:name/images', requireAuth, requirePermission('ml:write'), jsonParser, (req, res) => {
  const ip = getIP(req);
  const { name } = req.params;
  if (!isValidDatasetName(name)) return res.status(400).json({ error: '無効なデータセット名' });
  const meta = loadKeypointDataset(name);
  if (!meta) return res.status(404).json({ error: 'データセットが見つかりません' });

  const { images } = req.body || {};
  if (!Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: 'images が必要です' });
  }
  const imagesDir = path.join(KEYPOINT_DATASETS_DIR, name, 'images');
  if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
  const added = [];
  const errors = [];

  for (const im of images) {
    try {
      const b64 = String(im.data || '').replace(/^data:image\/[a-zA-Z+]+;base64,/, '');
      const buf = Buffer.from(b64, 'base64');
      if (buf.length === 0) throw new Error('画像データが空');
      if (buf.length > MAX_FILE_SIZE) throw new Error('画像が大きすぎます');
      const detected = detectImageMagic(buf);
      if (!detected) throw new Error('画像として認識できません');
      if (detected === 'tiff') throw new Error('TIFF はブラウザで表示できないため非対応です (JPEG / PNG に変換してください)');
      if (detected === 'heic') throw new Error('HEIC はブラウザで表示できないため非対応です (JPEG / PNG に変換してください)');
      if (detected === 'gif') throw new Error('GIF は学習に向かないため非対応です (JPEG / PNG に変換してください)');
      const ext = detected === 'jpg' ? '.jpg' : `.${detected}`;
      const imgId = `img_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const fileName = `${imgId}${ext}`;
      fs.writeFileSync(path.join(imagesDir, fileName), buf);
      const imgEntry = { id: imgId, file: fileName, originalName: im.name || fileName, instances: [], addedAt: Date.now() };
      meta.images.push(imgEntry);
      added.push(imgEntry);
    } catch (e) {
      errors.push({ name: im.name, error: e.message });
    }
  }
  meta.updatedAt = Date.now();
  saveKeypointDataset(name, meta);
  log(ip, `[キーポイント学習] ${name} に画像追加: ${added.length}件 (失敗: ${errors.length})`);
  res.json({ ok: true, added, errors });
});

// データセットの画像ファイルを返す (アノテーション画面の表示用)
app.get('/ml/image/keypoint/datasets/:name/images/:file', requireAuth, requirePermission('ml:read'), (req, res) => {
  const { name, file } = req.params;
  if (!isValidDatasetName(name)) return res.status(400).json({ error: '無効なデータセット名' });
  if (!/^[a-zA-Z0-9_.-]+$/.test(file)) return res.status(400).json({ error: '無効なファイル名' });
  const filePath = path.join(KEYPOINT_DATASETS_DIR, name, 'images', file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '画像が見つかりません' });
  res.sendFile(filePath);
});

// 画像のアノテーション (インスタンス = 対象box + キーポイント) を保存
// body: { instances: [{ box:{x1,y1,x2,y2}, keypoints:[{x,y,v},...] }] }
//   keypoints はデータセットのキーポイント順。v: 0=未指定, 1=隠れ, 2=可視
app.put('/ml/image/keypoint/datasets/:name/annotations/:imageId', requireAuth, requirePermission('ml:write'), jsonParser, (req, res) => {
  const { name, imageId } = req.params;
  if (!isValidDatasetName(name)) return res.status(400).json({ error: '無効なデータセット名' });
  const meta = loadKeypointDataset(name);
  if (!meta) return res.status(404).json({ error: 'データセットが見つかりません' });
  const img = (meta.images || []).find(im => im.id === imageId);
  if (!img) return res.status(404).json({ error: '画像が見つかりません' });

  const { instances } = req.body || {};
  if (!Array.isArray(instances)) return res.status(400).json({ error: 'instances が必要です' });
  const K = (meta.keypoints || []).length;
  const is3d = meta.dim === '3d';

  const clean = [];
  for (const inst of instances) {
    const b = inst && inst.box;
    if (!b) continue;
    const x1 = Number(b.x1), y1 = Number(b.y1), x2 = Number(b.x2), y2 = Number(b.y2);
    if ([x1, y1, x2, y2].some(v => !Number.isFinite(v))) continue;
    // キーポイント配列を K 個に正規化 (足りなければ v=0 で埋める)
    const kpIn = Array.isArray(inst.keypoints) ? inst.keypoints : [];
    const kps = [];
    for (let i = 0; i < K; i++) {
      const kp = kpIn[i];
      if (!kp) { kps.push(is3d ? { x: 0, y: 0, z: 0, v: 0 } : { x: 0, y: 0, v: 0 }); continue; }
      let v = Number(kp.v);
      if (![0, 1, 2].includes(v)) v = 2;
      const kx = Number(kp.x), ky = Number(kp.y);
      if (v === 0 || !Number.isFinite(kx) || !Number.isFinite(ky)) {
        kps.push(is3d ? { x: 0, y: 0, z: 0, v: 0 } : { x: 0, y: 0, v: 0 });
      } else if (is3d) {
        // z(相対深度)は [-1,1] にクランプ。未指定は0。
        let z = Number(kp.z);
        if (!Number.isFinite(z)) z = 0;
        z = Math.min(1, Math.max(-1, z));
        kps.push({ x: kx, y: ky, z, v });
      } else {
        kps.push({ x: kx, y: ky, v });
      }
    }
    clean.push({
      box: {
        x1: Math.min(x1, x2), y1: Math.min(y1, y2),
        x2: Math.max(x1, x2), y2: Math.max(y1, y2),
      },
      keypoints: kps,
    });
  }
  img.instances = clean;
  meta.updatedAt = Date.now();
  saveKeypointDataset(name, meta);
  res.json({ ok: true, instanceCount: clean.length });
});

// データセットから画像を削除
app.delete('/ml/image/keypoint/datasets/:name/images/:imageId', requireAuth, requirePermission('ml:write'), (req, res) => {
  const { name, imageId } = req.params;
  if (!isValidDatasetName(name)) return res.status(400).json({ error: '無効なデータセット名' });
  const meta = loadKeypointDataset(name);
  if (!meta) return res.status(404).json({ error: 'データセットが見つかりません' });
  const idx = (meta.images || []).findIndex(im => im.id === imageId);
  if (idx === -1) return res.status(404).json({ error: '画像が見つかりません' });
  const [removed] = meta.images.splice(idx, 1);
  try { fs.unlinkSync(path.join(KEYPOINT_DATASETS_DIR, name, 'images', removed.file)); } catch {}
  meta.updatedAt = Date.now();
  saveKeypointDataset(name, meta);
  res.json({ ok: true });
});

// キーポイントのアノテーションを CSV (ロング形式) でインポート
// body: { format: 'csv', data: <CSV文字列> }
//   列: filename, keypoint, x, y, v[, z][, instance]
//     - filename : 既存画像のファイル名 (originalName / 保存名 / basename で照合)
//     - keypoint : キーポイント名 (データセットの定義名) または 0始まり番号
//     - x, y     : ピクセル座標
//     - v        : 可視性 0/1/2 (省略時2)
//     - z        : 3Dデータセットのみ。相対深度 -1..1 (省略時0)
//     - instance : 同一画像内の対象の区別 (省略時0)。任意で box 列(bx1,by1,bx2,by2)も可
//   各インスタンスの矩形は box 列が無ければキーポイントの外接矩形から自動生成。
app.post('/ml/image/keypoint/datasets/:name/import', requireAuth, requirePermission('ml:write'), jsonParser, (req, res) => {
  const ip = getIP(req);
  const { name } = req.params;
  if (!isValidDatasetName(name)) return res.status(400).json({ error: '無効なデータセット名' });
  const meta = loadKeypointDataset(name);
  if (!meta) return res.status(404).json({ error: 'データセットが見つかりません' });

  const { format, data } = req.body || {};
  if (format !== 'csv') return res.status(400).json({ error: 'format は csv のみ対応です' });
  const is3d = meta.dim === '3d';
  const keypoints = meta.keypoints || [];
  const K = keypoints.length;
  const kpNameToIndex = {};
  keypoints.forEach((nm, i) => { kpNameToIndex[String(nm).trim().toLowerCase()] = i; });

  try {
    const rows = parseCsv(data);
    if (rows.length === 0) return res.status(400).json({ error: 'CSVに有効な行がありません (ヘッダ行が必要です)' });
    const index = buildImageFileIndex(meta.images || []);

    // imageId -> (instanceKey -> { kps:[K], box? })
    const perImage = {};
    const errors = [];
    let matchedPts = 0, skipped = 0;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const fname = csvField(r, ['filename', 'file', 'image', 'name', 'img']);
      const entry = fname ? index[String(fname).trim().toLowerCase()] : null;
      if (!entry) { skipped++; if (errors.length < 10) errors.push(`行${i + 2}: 画像「${fname}」が見つかりません`); continue; }

      const kpRaw = csvField(r, ['keypoint', 'kp', 'point', 'name2', 'joint']);
      let ki = kpNameToIndex[String(kpRaw).trim().toLowerCase()];
      if (ki === undefined && /^\d+$/.test(kpRaw)) ki = parseInt(kpRaw, 10);
      if (!Number.isInteger(ki) || ki < 0 || ki >= K) {
        skipped++; if (errors.length < 10) errors.push(`行${i + 2}: キーポイント「${kpRaw}」が不明`); continue;
      }
      const x = Number(csvField(r, ['x', 'px', 'u']));
      const y = Number(csvField(r, ['y', 'py', 'vcoord']));
      if (![x, y].some(Number.isFinite) || !Number.isFinite(x) || !Number.isFinite(y)) {
        skipped++; if (errors.length < 10) errors.push(`行${i + 2}: x,y が数値ではありません`); continue;
      }
      let v = Number(csvField(r, ['v', 'visibility', 'vis']));
      if (![0, 1, 2].includes(v)) v = 2;  // 省略時は可視
      let z = 0;
      if (is3d) {
        const zr = csvField(r, ['z', 'depth']);
        z = Number(zr);
        if (!Number.isFinite(z)) z = 0;
        z = Math.min(1, Math.max(-1, z));
      }
      const instKey = String(csvField(r, ['instance', 'inst', 'id', 'object']) || '0');

      if (!perImage[entry.id]) perImage[entry.id] = {};
      if (!perImage[entry.id][instKey]) {
        perImage[entry.id][instKey] = {
          kps: Array.from({ length: K }, () => (is3d ? { x: 0, y: 0, z: 0, v: 0 } : { x: 0, y: 0, v: 0 })),
          box: null,
        };
      }
      const inst = perImage[entry.id][instKey];
      inst.kps[ki] = is3d ? { x, y, z, v } : { x, y, v };
      // box 列があれば採用 (任意)
      const bx1 = Number(csvField(r, ['bx1', 'box_x1', 'boxxmin']));
      const by1 = Number(csvField(r, ['by1', 'box_y1', 'boxymin']));
      const bx2 = Number(csvField(r, ['bx2', 'box_x2', 'boxxmax']));
      const by2 = Number(csvField(r, ['by2', 'box_y2', 'boxymax']));
      if ([bx1, by1, bx2, by2].every(Number.isFinite)) {
        inst.box = { x1: Math.min(bx1, bx2), y1: Math.min(by1, by2), x2: Math.max(bx1, bx2), y2: Math.max(by1, by2) };
      }
      matchedPts++;
    }

    // インスタンスを確定し、box が無ければ可視キーポイントの外接矩形から生成
    let appliedImages = 0, instanceCount = 0;
    for (const [imageId, instMap] of Object.entries(perImage)) {
      const entry = meta.images.find(im => im.id === imageId);
      if (!entry) continue;
      const instances = [];
      for (const inst of Object.values(instMap)) {
        const vis = inst.kps.filter(kp => kp.v > 0);
        if (vis.length === 0) continue;  // 可視点が無いインスタンスは捨てる
        let box = inst.box;
        if (!box) {
          // 外接矩形 + 余白 (キーポイントの広がりの10%、最低8px)
          const xs = vis.map(kp => kp.x), ys = vis.map(kp => kp.y);
          let minX = Math.min(...xs), maxX = Math.max(...xs);
          let minY = Math.min(...ys), maxY = Math.max(...ys);
          const padX = Math.max(8, (maxX - minX) * 0.1);
          const padY = Math.max(8, (maxY - minY) * 0.1);
          box = { x1: minX - padX, y1: minY - padY, x2: maxX + padX, y2: maxY + padY };
        }
        instances.push({ box, keypoints: inst.kps });
        instanceCount++;
      }
      if (instances.length > 0) { entry.instances = instances; appliedImages++; }
    }

    meta.updatedAt = Date.now();
    saveKeypointDataset(name, meta);
    log(ip, `[キーポイント学習] CSVインポート: ${name} (${matchedPts}点 / ${instanceCount}対象 / ${appliedImages}画像, スキップ${skipped})`);
    res.json({ ok: true, appliedImages, instanceCount, pointCount: matchedPts, skipped, errors });
  } catch (e) {
    res.status(500).json({ error: `インポート失敗: ${e.message}` });
  }
});

// ─── キーポイント学習ジョブ (物体検出・表データ学習とは別系統) ───
let currentKeypointJob = null;  // { jobId, datasetName, modelName, proc, log: [] }

const KEYPOINT_JOBS_FILE = path.join(ML_DIR, 'keypoint_jobs.json');
function loadKeypointJobs() {
  if (!fs.existsSync(KEYPOINT_JOBS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(KEYPOINT_JOBS_FILE, 'utf-8')); }
  catch { return []; }
}
function saveKeypointJobs(jobs) {
  fs.writeFileSync(KEYPOINT_JOBS_FILE, JSON.stringify(jobs.slice(0, 50), null, 2), 'utf-8');
}

const KEYPOINT_TRAIN_BASE_MODELS = [
  { name: 'keypointrcnn_resnet50_fpn', label: 'Keypoint R-CNN (ResNet50)', note: 'COCO事前学習・少量データ向き' },
  { name: 'scratch', label: '事前学習なし (ゼロから学習)', note: '⚠️ 大量データ・多エポックが必要、少量では精度が出ません' },
];

// 3Dキーポイント回帰 (ResNetバックボーン) のバックボーン候補
const KEYPOINT3D_BACKBONES = [
  { name: 'resnet18', label: 'ResNet18', note: '軽量・高速 (少量データ向き)' },
  { name: 'resnet34', label: 'ResNet34', note: '中庸' },
  { name: 'resnet50', label: 'ResNet50', note: '高精度・やや重い' },
];
const KEYPOINT3D_BACKBONE_NAMES = KEYPOINT3D_BACKBONES.map(b => b.name);

app.get('/ml/image/keypoint/train/models', requireAuth, requirePermission('ml:read'), (req, res) => {
  res.json({ baseModels: KEYPOINT_TRAIN_BASE_MODELS, backbones3d: KEYPOINT3D_BACKBONES });
});

// カスタムモデル学習を開始
// body: { datasetName, modelName, baseModel?, epochs?, batchSize?, lr? }
app.post('/ml/image/keypoint/train', requireAuth, requirePermission('ml:write'), jsonParser, (req, res) => {
  const ip = getIP(req);
  if (currentKeypointJob) {
    return res.status(409).json({ error: `既にキーポイント学習中: ${currentKeypointJob.modelName}` });
  }
  const { datasetName, modelName, baseModel, epochs, batchSize, lr } = req.body || {};
  if (!isValidDatasetName(datasetName)) return res.status(400).json({ error: '無効なデータセット名' });
  if (!isValidDatasetName(modelName)) return res.status(400).json({ error: 'モデル名は英数字・ハイフン・アンダースコア' });

  const meta = loadKeypointDataset(datasetName);
  if (!meta) return res.status(404).json({ error: 'データセットが見つかりません' });
  const annotated = (meta.images || []).filter(im => (im.instances || []).length > 0);
  if (annotated.length === 0) {
    return res.status(400).json({ error: 'アノテーション済みの画像がありません。対象を囲み、キーポイントを打ってから学習してください' });
  }
  const is3d = meta.dim === '3d';
  const datasetDir = path.join(KEYPOINT_DATASETS_DIR, datasetName);
  const outputDir = path.join(KEYPOINT_MODELS_DIR, modelName);
  const pythonCmd = appConfig.pythonPath || 'python3';

  // 2D (Keypoint R-CNN) と 3D (ResNet回帰) でスクリプト・引数が異なる
  let scriptName, base, argv;
  if (is3d) {
    base = (baseModel && KEYPOINT3D_BACKBONE_NAMES.includes(baseModel)) ? baseModel : 'resnet18';
    scriptName = 'image_keypoint3d_train.py';
    argv = [
      path.join(__dirname, scriptName),
      '--dataset-dir', datasetDir,
      '--output-dir', outputDir,
      '--backbone', base,
      '--epochs', String(Math.min(Math.max(parseInt(epochs) || 30, 1), 500)),
      '--batch-size', String(Math.min(Math.max(parseInt(batchSize) || 8, 1), 32)),
      '--lr', String(typeof lr === 'number' ? lr : 0.0005),
      '--cache-dir', TORCH_CACHE_DIR,
    ];
  } else {
    base = (baseModel && KEYPOINT_TRAIN_BASE_MODELS.some(m => m.name === baseModel))
      ? baseModel : 'keypointrcnn_resnet50_fpn';
    scriptName = 'image_keypoint_train.py';
    argv = [
      path.join(__dirname, scriptName),
      '--dataset-dir', datasetDir,
      '--output-dir', outputDir,
      '--base-model', base,
      '--epochs', String(Math.min(Math.max(parseInt(epochs) || 10, 1), 200)),
      '--batch-size', String(Math.min(Math.max(parseInt(batchSize) || 2, 1), 16)),
      '--lr', String(typeof lr === 'number' ? lr : 0.005),
      '--cache-dir', TORCH_CACHE_DIR,
    ];
  }
  const scriptPath = path.join(__dirname, scriptName);
  if (!fs.existsSync(scriptPath)) return res.status(500).json({ error: `${scriptName} が見つかりません` });

  const jobId = `kpjob_${Date.now()}`;

  const { spawn } = require('child_process');
  const proc = spawn(pythonCmd, argv, { cwd: __dirname, env: { ...process.env, PYTHONUNBUFFERED: '1' }, detached: true });

  currentKeypointJob = { jobId, datasetName, modelName, baseModel: base, proc, log: [], startedAt: Date.now() };
  log(ip, `[キーポイント学習] 開始: ${modelName} (データセット: ${datasetName}, ${annotated.length}枚, ${base})`);

  proc.stdout.on('data', d => { currentKeypointJob.log.push(d.toString()); });
  proc.stderr.on('data', d => {
    const s = d.toString();
    if (!/^\s*\d+%\|/.test(s)) currentKeypointJob.log.push(s);
  });

  proc.on('close', (code) => {
    const fullLog = currentKeypointJob.log.join('');
    const wasCancelled = currentKeypointJob.cancelled;
    let result = null;
    const m = fullLog.match(/RESULT_JSON:(.+)/);
    if (m) { try { result = JSON.parse(m[1]); } catch {} }

    const jobs = loadKeypointJobs();
    jobs.unshift({
      jobId, datasetName, modelName, baseModel: base,
      status: wasCancelled ? 'cancelled' : ((code === 0 && result?.status === 'completed') ? 'completed' : 'failed'),
      finalLoss: result?.finalLoss ?? null,
      device: result?.device ?? null,
      note: result?.note ?? null,
      error: wasCancelled ? null : (result?.error ?? (code !== 0 ? `exit ${code}` : null)),
      startedAt: currentKeypointJob.startedAt,
      finishedAt: Date.now(),
      log: fullLog.slice(-5000),
    });
    saveKeypointJobs(jobs);
    log('-', `[キーポイント学習] 終了: ${modelName} (exit ${code}, ${wasCancelled ? 'cancelled' : (result?.status || 'failed')})`);
    currentKeypointJob = null;
  });
  proc.on('error', (err) => {
    log('-', `[キーポイント学習] プロセスエラー: ${err.message}`);
    currentKeypointJob = null;
  });

  res.json({ ok: true, jobId });
});

// 学習ジョブの状態 + ログ
app.get('/ml/image/keypoint/train/status', requireAuth, requirePermission('ml:read'), (req, res) => {
  if (currentKeypointJob) {
    return res.json({
      running: true,
      jobId: currentKeypointJob.jobId,
      modelName: currentKeypointJob.modelName,
      datasetName: currentKeypointJob.datasetName,
      log: currentKeypointJob.log.join(''),
    });
  }
  const jobs = loadKeypointJobs();
  res.json({ running: false, recentJobs: jobs.slice(0, 10) });
});

// 学習中ジョブのキャンセル
app.post('/ml/image/keypoint/train/cancel', requireAuth, requirePermission('ml:write'), (req, res) => {
  if (!currentKeypointJob) return res.status(400).json({ error: '学習中のジョブがありません' });
  currentKeypointJob.cancelled = true;
  const pid = currentKeypointJob.proc && currentKeypointJob.proc.pid;
  if (pid) {
    try { process.kill(-pid, 'SIGKILL'); }
    catch { try { currentKeypointJob.proc.kill('SIGKILL'); } catch {} }
  }
  res.json({ ok: true });
});

// カスタム学習済みモデル一覧
app.get('/ml/image/keypoint/custom-models', requireAuth, requirePermission('ml:read'), (req, res) => {
  try {
    const models = [];
    for (const name of fs.readdirSync(KEYPOINT_MODELS_DIR)) {
      const cfgPath = path.join(KEYPOINT_MODELS_DIR, name, 'config.json');
      const modelPath = path.join(KEYPOINT_MODELS_DIR, name, 'model.pt');
      if (fs.existsSync(cfgPath) && fs.existsSync(modelPath)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
          let metrics = null;
          const mpath = path.join(KEYPOINT_MODELS_DIR, name, 'metrics.json');
          if (fs.existsSync(mpath)) { try { metrics = JSON.parse(fs.readFileSync(mpath, 'utf-8')); } catch {} }
          models.push({
            name,
            keypoints: cfg.keypoints || [],
            dim: cfg.dim === '3d' ? '3d' : '2d',
            baseModel: cfg.baseModel || cfg.backbone,
            datasetName: cfg.datasetName,
            trainedAt: cfg.trainedAt,
            finalLoss: metrics?.finalLoss ?? null,
          });
        } catch {}
      }
    }
    models.sort((a, b) => (b.trainedAt || 0) - (a.trainedAt || 0));
    res.json({ models });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// カスタムモデル削除
app.delete('/ml/image/keypoint/custom-models/:name', requireAuth, requirePermission('ml:write'), (req, res) => {
  const { name } = req.params;
  if (!isValidDatasetName(name)) return res.status(400).json({ error: '無効なモデル名' });
  const dir = path.join(KEYPOINT_MODELS_DIR, name);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'モデルが見つかりません' });
  fs.rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true });
});

// カスタムモデルを zip でダウンロード (model.pt + config.json + metrics.json + 推論サンプル)
app.get('/ml/image/keypoint/custom-models/:name/download', requireAuth, requirePermission('ml:read'), (req, res) => {
  const { name } = req.params;
  if (!isValidDatasetName(name)) return res.status(400).json({ error: '無効なモデル名' });
  const dir = path.join(KEYPOINT_MODELS_DIR, name);
  const cfgPath = path.join(dir, 'config.json');
  if (!fs.existsSync(cfgPath)) return res.status(404).json({ error: 'モデルが見つかりません' });

  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); }
  catch { return res.status(500).json({ error: 'config.json の読み込みに失敗' }); }

  const kpPy = JSON.stringify(cfg.keypoints || []);
  const isScratch = cfg.baseModel === 'scratch';
  const numClasses = cfg.numClasses || 2;
  let exampleScript = `#!/usr/bin/env python3
"""
${name} - OpenGeekLLMChat カスタムキーポイント検出モデルの推論サンプル

必要なパッケージ:
  pip install torch torchvision pillow

使い方:
  python predict_example.py <画像ファイル>
"""
import sys
import json
import torch
import torchvision
from torchvision.io import read_image
from torchvision.transforms.functional import convert_image_dtype

# このモデルの情報 (config.json と同じ)
KEYPOINTS = ${kpPy}  # 順序付きのキーポイント名
BASE_MODEL = ${JSON.stringify(cfg.baseModel || 'keypointrcnn_resnet50_fpn')}
NUM_KEYPOINTS = len(KEYPOINTS)
NUM_CLASSES = ${numClasses}  # 背景 + 対象
THRESHOLD = 0.5

def build_model():
    from torchvision.models.detection.faster_rcnn import FastRCNNPredictor
    from torchvision.models.detection.keypoint_rcnn import KeypointRCNNPredictor
    if BASE_MODEL == 'scratch':
        model = torchvision.models.detection.keypointrcnn_resnet50_fpn(
            weights=None, weights_backbone=None,
            num_classes=NUM_CLASSES, num_keypoints=NUM_KEYPOINTS)
    else:
        model = torchvision.models.detection.keypointrcnn_resnet50_fpn(weights=None)
        in_features = model.roi_heads.box_predictor.cls_score.in_features
        model.roi_heads.box_predictor = FastRCNNPredictor(in_features, NUM_CLASSES)
        kp_in = model.roi_heads.keypoint_predictor.kps_score_lowres.in_channels
        model.roi_heads.keypoint_predictor = KeypointRCNNPredictor(kp_in, num_keypoints=NUM_KEYPOINTS)
    return model

def main():
    if len(sys.argv) < 2:
        print("使い方: python predict_example.py <画像ファイル>")
        sys.exit(1)
    image_path = sys.argv[1]

    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    model = build_model()
    model.load_state_dict(torch.load('model.pt', map_location='cpu'))
    model.eval().to(device)

    img = read_image(image_path)
    if img.shape[0] == 1:
        img = img.repeat(3, 1, 1)
    elif img.shape[0] == 4:
        img = img[:3, :, :]
    img_f = convert_image_dtype(img, dtype=torch.float).to(device)

    with torch.no_grad():
        out = model([img_f])[0]

    results = []
    boxes = out['boxes'].tolist()
    scores = out['scores'].tolist()
    keypoints = out['keypoints'].tolist()
    for box, score, kps in zip(boxes, scores, keypoints):
        if score < THRESHOLD:
            continue
        named = [{'name': KEYPOINTS[i] if i < len(KEYPOINTS) else f'kp{i}',
                  'x': round(kps[i][0], 1), 'y': round(kps[i][1], 1)}
                 for i in range(len(kps))]
        results.append({'score': round(score, 3), 'box': [round(v, 1) for v in box], 'keypoints': named})
    print(json.dumps({'detections': results, 'count': len(results)}, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
`;

  let readme = `OpenGeekLLMChat カスタムキーポイント検出モデル: ${name}
${'='.repeat(50)}

このモデルについて:
  ベースモデル   : ${cfg.baseModel || '-'}${isScratch ? ' (事前学習なし)' : ''}
  キーポイント   : ${(cfg.keypoints || []).join(', ')}
  学習日時       : ${cfg.trainedAt ? new Date(cfg.trainedAt * 1000).toLocaleString('ja-JP') : '-'}

含まれるファイル:
  model.pt            学習済みの重み (PyTorch state_dict)
  config.json         モデル設定 (キーポイント名・ベースモデル等)
  metrics.json        学習指標 (loss推移)
  predict_example.py  推論サンプルスクリプト

使い方:
  1. pip install torch torchvision pillow
  2. python predict_example.py 画像.jpg

注意:
  - これは torchvision の Keypoint R-CNN 形式の state_dict です。
  - predict_example.py と同じディレクトリに model.pt を置いてください。
  - GPU(CUDA/ROCm)があれば自動で使われます。なければCPUで動作します。
`;

  // 3Dキーポイント回帰モデルは ResNet 回帰なので、サンプルとREADMEを差し替える
  if (cfg.dim === '3d') {
    const backbone = cfg.backbone || 'resnet18';
    const imageSize = cfg.imageSize || 256;
    exampleScript = `#!/usr/bin/env python3
"""
${name} - OpenGeekLLMChat カスタム3Dキーポイント回帰モデルの推論サンプル

必要なパッケージ:
  pip install torch torchvision pillow

使い方:
  python predict_example.py <画像ファイル>

出力: 各キーポイントの x, y (ピクセル) と z (相対深度 -1..1)。
"""
import sys
import json
import torch
import torchvision
from torchvision.io import read_image
from torchvision.transforms.functional import convert_image_dtype, resize

KEYPOINTS = ${kpPy}          # 順序付きのキーポイント名
BACKBONE = ${JSON.stringify(backbone)}
IMAGE_SIZE = ${imageSize}
IMAGENET_MEAN = [0.485, 0.456, 0.406]
IMAGENET_STD = [0.229, 0.224, 0.225]
K = len(KEYPOINTS)

def build_model():
    tvm = torchvision.models
    if BACKBONE == 'resnet18':
        m = tvm.resnet18(weights=None)
    elif BACKBONE == 'resnet34':
        m = tvm.resnet34(weights=None)
    else:
        m = tvm.resnet50(weights=None)
    m.fc = torch.nn.Linear(m.fc.in_features, K * 3)
    return m

def main():
    if len(sys.argv) < 2:
        print("使い方: python predict_example.py <画像ファイル>")
        sys.exit(1)
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    model = build_model()
    model.load_state_dict(torch.load('model.pt', map_location='cpu'))
    model.eval().to(device)

    img = read_image(sys.argv[1])
    if img.shape[0] == 1:
        img = img.repeat(3, 1, 1)
    elif img.shape[0] == 4:
        img = img[:3, :, :]
    _, H, W = img.shape
    f = convert_image_dtype(img, dtype=torch.float)
    f = resize(f, [IMAGE_SIZE, IMAGE_SIZE], antialias=True)
    mean = torch.tensor(IMAGENET_MEAN).view(3, 1, 1)
    std = torch.tensor(IMAGENET_STD).view(3, 1, 1)
    f = ((f - mean) / std).unsqueeze(0).to(device)

    with torch.no_grad():
        out = model(f).view(1, K, 3)
        xy = torch.sigmoid(out[..., :2])
        z = torch.tanh(out[..., 2:3])
        pred = torch.cat([xy, z], dim=-1)[0].cpu()

    kps = [{'name': KEYPOINTS[i],
            'x': round(float(pred[i, 0]) * W, 1),
            'y': round(float(pred[i, 1]) * H, 1),
            'z': round(float(pred[i, 2]), 4)} for i in range(K)]
    print(json.dumps({'keypoints': kps}, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
`;
    readme = `OpenGeekLLMChat カスタム3Dキーポイント回帰モデル: ${name}
${'='.repeat(50)}

このモデルについて:
  種別           : 3Dキーポイント回帰 (RGB1枚 → x,y,z)
  バックボーン   : ${cfg.backbone || '-'}
  入力サイズ     : ${cfg.imageSize || 256}
  キーポイント   : ${(cfg.keypoints || []).join(', ')}
  学習日時       : ${cfg.trainedAt ? new Date(cfg.trainedAt * 1000).toLocaleString('ja-JP') : '-'}

出力座標:
  x, y : 画像のピクセル座標
  z    : 相対深度 (-1..1)。学習時に手動で付けた奥行きの相対値。

含まれるファイル:
  model.pt            学習済みの重み (PyTorch state_dict, ResNet回帰)
  config.json         モデル設定 (キーポイント名・バックボーン・入力サイズ等)
  metrics.json        学習指標 (loss推移)
  predict_example.py  推論サンプルスクリプト

使い方:
  1. pip install torch torchvision pillow
  2. python predict_example.py 画像.jpg

注意:
  - 単一インスタンス (画像内に対象1つ) を前提としています。
  - z は単眼RGBからの相対深度です (絶対距離ではありません)。
  - GPU(CUDA/ROCm)があれば自動で使われます。なければCPUで動作します。
`;
  }

  try {
    const files = [];
    files.push({ name: `${name}/model.pt`, data: fs.readFileSync(path.join(dir, 'model.pt')), store: true });
    files.push({ name: `${name}/config.json`, data: fs.readFileSync(cfgPath) });
    const metricsPath = path.join(dir, 'metrics.json');
    if (fs.existsSync(metricsPath)) {
      files.push({ name: `${name}/metrics.json`, data: fs.readFileSync(metricsPath) });
    }
    files.push({ name: `${name}/predict_example.py`, data: Buffer.from(exampleScript, 'utf-8') });
    files.push({ name: `${name}/README.txt`, data: Buffer.from(readme, 'utf-8') });

    log(getIP(req), `[キーポイント学習] モデルDL開始: ${name}`);
    const zipBuf = buildZipBuffer(files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.zip"`);
    res.setHeader('Content-Length', zipBuf.length);
    res.end(zipBuf);
  } catch (e) {
    log(getIP(req), `[キーポイント学習] モデルDL失敗: ${name} - ${e.message}`);
    if (!res.headersSent) res.status(500).json({ error: `zip生成に失敗: ${e.message}` });
  }
});

// ════════════════════════════════════════════════════════════════════════
// 強化学習 (RL / DQN) — rl_runner.py でデータテーブルからオフラインRLを学習・評価
// 表データ学習・画像学習とは独立した別系統 (currentRlJob で1ジョブのみ実行)
// ════════════════════════════════════════════════════════════════════════

// 利用可能なアルゴリズム (UIのセレクタ用)
const RL_ALGOS = [
  { name: 'dqn', label: 'DQN', desc: '価値ベース off-policy の基本。ターゲットネットワーク + バッチ学習' },
  { name: 'ddqn', label: 'Double DQN', desc: '行動選択と評価を分離し、Q値の過大評価を抑える定番改良' },
  { name: 'cql', label: 'CQL (Conservative Q-Learning)', desc: 'オフラインRLの代表手法。ログ外行動のQ値を保守的に抑制' },
  { name: 'bc', label: 'Behavior Cloning (模倣)', desc: 'ログ済み行動を教師あり学習で模倣するベースライン (報酬不使用)' },
];

function loadRlJobs() {
  if (!fs.existsSync(RL_JOBS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(RL_JOBS_FILE, 'utf-8')); }
  catch { return []; }
}
function saveRlJobs(jobs) {
  fs.writeFileSync(RL_JOBS_FILE, JSON.stringify(jobs.slice(0, 50), null, 2), 'utf-8');
}
// エージェント名検証 (英数字・ハイフン・アンダースコア)
const isValidAgentName = isValidDatasetName;

// ─── アルゴリズム / 学習方式の情報 ───
app.get('/ml/rl/envs', requireAuth, requirePermission('ml:read'), (req, res) => {
  res.json({
    algos: RL_ALGOS,
    dataset: {
      supported: true,
      label: '📊 データテーブルから学習 (オフラインRL)',
      desc: 'DuckDB の表をログ済み経験データとみなして学習。next_state列を指定すれば遷移ベースのオフラインDQN、なければ文脈付きバンディット。',
    },
    online: {
      supported: true,
      label: '⚡ リアルタイム/オンライン学習 (外部API)',
      desc: '常駐ワーカーがモデルをメモリ保持し、act(推論)/learn(経験投入で即更新)をHTTPで提供。学習済みエージェントのウォームスタート、またはスキーマ指定でゼロから作成。',
    },
  });
});

// ─── 学習済みエージェント一覧 ───
app.get('/ml/rl/models', requireAuth, requirePermission('ml:read'), (req, res) => {
  const models = [];
  try {
    for (const name of fs.readdirSync(RL_MODELS_DIR)) {
      const cfgPath = path.join(RL_MODELS_DIR, name, 'config.json');
      const modelPath = path.join(RL_MODELS_DIR, name, 'model.pt');
      if (!fs.existsSync(cfgPath) || !fs.existsSync(modelPath)) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        let metrics = null;
        const mp = path.join(RL_MODELS_DIR, name, 'metrics.json');
        if (fs.existsSync(mp)) {
          try {
            const m = JSON.parse(fs.readFileSync(mp, 'utf-8'));
            metrics = {
              datasetMode: m.datasetMode,
              finalLoss: m.finalLoss,
              policyAgreement: m.policyAgreement,
              meanQ: m.meanQ,
              loggedMeanReward: m.loggedMeanReward,
              nTransitions: m.nTransitions,
              epochs: m.epochs,
              elapsedSec: m.elapsedSec,
              // オンライン学習の指標
              totalSteps: m.totalSteps,
              bufferSize: m.bufferSize,
              lossEMA: m.lossEMA,
              rewardEMA: m.rewardEMA,
            };
          } catch {}
        }
        models.push({
          name,
          env: cfg.env,
          online: cfg.online === true || cfg.env === 'online',
          algo: cfg.algo,
          episodes: cfg.episodes,
          datasetMode: cfg.datasetMode,
          tableName: cfg.tableName,
          stateColumns: cfg.meta?.stateColumns,
          actionColumn: cfg.meta?.actionColumn,
          actionLabels: cfg.actionLabels,
          trainedAt: cfg.trainedAt,
          metrics,
        });
      } catch {}
    }
  } catch {}
  models.sort((a, b) => (b.trainedAt || 0) - (a.trainedAt || 0));
  res.json({
    models,
    runningJob: currentRlJob ? { jobId: currentRlJob.jobId, name: currentRlJob.name, env: currentRlJob.env } : null,
  });
});

// ─── 学習開始 (データテーブルからのオフラインRL) ───
// body: { name, table, stateColumns[], actionColumn, rewardColumn,
//         nextStateColumns?[], doneColumn?, algo?, episodes?, gamma?, learningRate?, hiddenSize?, batchSize? }
// 列名の簡易検証 (SQLは python 側で二重引用符で囲むため、引用符・バックスラッシュ・; を禁止)
function isValidRlColumn(c) {
  return typeof c === 'string' && c.length > 0 && c.length <= 128 && !/["\\;]/.test(c);
}

// RL 学習の中核処理 (HTTPルートと agent_proxy ツールから共用)。
// 成功時 { jobId } を返し、失敗時は Error を throw する。
async function startRlTraining(b, ip) {
  if (currentRlJob) {
    const e = new Error(`既にRL学習中: ${currentRlJob.name}`); e.status = 409; throw e;
  }
  if (!isValidAgentName(b.name)) {
    const e = new Error('エージェント名は英数字・ハイフン・アンダースコア (1〜64文字)'); e.status = 400; throw e;
  }
  const algo = RL_ALGOS.some(a => a.name === b.algo) ? b.algo : 'dqn';
  const scriptPath = path.join(__dirname, 'rl_runner.py');
  if (!fs.existsSync(scriptPath)) {
    const e = new Error(`rl_runner.py が見つかりません: ${scriptPath}`); e.status = 500; throw e;
  }

  // データテーブル由来 (オフラインRL) の列マッピングを検証
  if (!isValidTableName(b.table)) { const e = new Error('無効なテーブル名'); e.status = 400; throw e; }
  const stateCols = Array.isArray(b.stateColumns) ? b.stateColumns : [];
  if (stateCols.length === 0 || !stateCols.every(isValidRlColumn)) {
    const e = new Error('stateColumns は1個以上の有効な列名が必要です'); e.status = 400; throw e;
  }
  if (!isValidRlColumn(b.actionColumn)) { const e = new Error('actionColumn が無効です'); e.status = 400; throw e; }
  if (!isValidRlColumn(b.rewardColumn)) { const e = new Error('rewardColumn が無効です'); e.status = 400; throw e; }
  const nextCols = Array.isArray(b.nextStateColumns) ? b.nextStateColumns.filter(c => c) : [];
  if (nextCols.length > 0 && (nextCols.length !== stateCols.length || !nextCols.every(isValidRlColumn))) {
    const e = new Error('nextStateColumns は stateColumns と同数・同順で指定してください'); e.status = 400; throw e;
  }
  const doneCol = (b.doneColumn && isValidRlColumn(b.doneColumn)) ? b.doneColumn : null;

  const clampInt = (v, def, lo, hi) => Math.min(Math.max(parseInt(v) || def, lo), hi);
  const clampNum = (v, def, lo, hi) => Math.min(Math.max(typeof v === 'number' ? v : (parseFloat(v) || def), lo), hi);
  const outputDir = path.join(RL_MODELS_DIR, b.name);
  const runConfig = {
    mode: 'train', name: b.name, env: 'dataset', algo,
    episodes: clampInt(b.episodes, 300, 10, 5000),
    gamma: clampNum(b.gamma, 0.99, 0.5, 0.999),
    learningRate: clampNum(b.learningRate, 0.001, 1e-5, 0.1),
    hiddenSize: clampInt(b.hiddenSize, 128, 16, 1024),
    batchSize: clampInt(b.batchSize, 64, 8, 512),
    cqlAlpha: clampNum(b.cqlAlpha, 0.5, 0.0, 10.0),
    tableName: b.table, stateColumns: stateCols, actionColumn: b.actionColumn,
    rewardColumn: b.rewardColumn, nextStateColumns: nextCols, doneColumn: doneCol,
    dbPath: ML_DB_FILE, outputDir,
  };

  // Python が DuckDB を read_only で開くため、Node 側接続を一旦解放
  log(ip, `[RL学習] DuckDB を学習用に一時クローズ (table=${b.table})`);
  await releaseMlDbForExternal(ip);

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const tmpCfg = path.join(outputDir, '_run_config.json');
  fs.writeFileSync(tmpCfg, JSON.stringify(runConfig, null, 2));

  const jobId = `rljob_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const pythonCmd = appConfig.pythonPath || 'python3';
  const { spawn } = require('child_process');
  const proc = spawn(pythonCmd, [scriptPath, tmpCfg], {
    cwd: __dirname, env: { ...process.env, PYTHONUNBUFFERED: '1' }, detached: true,
  });

  currentRlJob = { jobId, name: b.name, env: 'dataset', algo, isDataset: true, proc, log: [], startedAt: Date.now() };
  log(ip, `[RL学習] 開始: ${b.name} (table=${b.table}, algo=${algo}, epochs=${runConfig.episodes})`);

  const handleData = (d) => {
    if (!currentRlJob) return;
    currentRlJob.log.push(d.toString());
    if (currentRlJob.log.length > 1000) currentRlJob.log = currentRlJob.log.slice(-800);
  };
  proc.stdout.on('data', handleData);
  proc.stderr.on('data', handleData);

  const finalize = () => { reacquireMlDb(); };
  proc.on('close', (code) => {
    try { fs.unlinkSync(tmpCfg); } catch {}
    const fullLog = currentRlJob ? currentRlJob.log.join('') : '';
    const wasCancelled = currentRlJob && currentRlJob.cancelled;
    let result = null;
    const m = fullLog.match(/RESULT_JSON:(.+)/);
    if (m) { try { result = JSON.parse(m[1]); } catch {} }
    const jobs = loadRlJobs();
    jobs.unshift({
      jobId, name: b.name, env: 'dataset', algo,
      status: wasCancelled ? 'cancelled' : ((code === 0 && result?.status === 'completed') ? 'completed' : 'failed'),
      datasetMode: result?.datasetMode ?? null,
      finalLoss: result?.finalLoss ?? null,
      policyAgreement: result?.policyAgreement ?? null,
      meanQ: result?.meanQ ?? null,
      loggedMeanReward: result?.loggedMeanReward ?? null,
      device: result?.device ?? null,
      error: wasCancelled ? null : (result?.error ?? (code !== 0 ? `exit ${code}` : null)),
      startedAt: currentRlJob ? currentRlJob.startedAt : Date.now(),
      finishedAt: Date.now(),
      log: fullLog.slice(-5000),
    });
    saveRlJobs(jobs);
    log('-', `[RL学習] 終了: ${b.name} (exit ${code}, ${wasCancelled ? 'cancelled' : (result?.status || 'failed')})`);
    currentRlJob = null;
    finalize();
  });
  proc.on('error', (err) => {
    try { fs.unlinkSync(tmpCfg); } catch {}
    log('-', `[RL学習] プロセスエラー: ${err.message}`);
    currentRlJob = null;
    finalize();
  });

  return { jobId };
}

app.post('/ml/rl/train', requireAuth, requirePermission('ml:write'), jsonParser, async (req, res) => {
  try {
    const out = await startRlTraining(req.body || {}, getIP(req));
    res.json({ ok: true, jobId: out.jobId });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ─── 学習ジョブの状態 + ログ ───
app.get('/ml/rl/train/status', requireAuth, requirePermission('ml:read'), (req, res) => {
  if (currentRlJob) {
    return res.json({
      running: true,
      jobId: currentRlJob.jobId,
      name: currentRlJob.name,
      env: currentRlJob.env,
      log: currentRlJob.log.join(''),
    });
  }
  const jobs = loadRlJobs();
  res.json({ running: false, recentJobs: jobs.slice(0, 10) });
});

// ─── 学習中ジョブのキャンセル ───
app.post('/ml/rl/train/cancel', requireAuth, requirePermission('ml:write'), (req, res) => {
  if (!currentRlJob) return res.status(400).json({ error: '学習中のRLジョブがありません' });
  currentRlJob.cancelled = true;
  const pid = currentRlJob.proc && currentRlJob.proc.pid;
  if (pid) {
    try { process.kill(-pid, 'SIGKILL'); }
    catch { try { currentRlJob.proc.kill('SIGKILL'); } catch {} }
  }
  res.json({ ok: true });
});

// ─── 学習曲線 (報酬履歴) 取得 ───
app.get('/ml/rl/models/:name/metrics', requireAuth, requirePermission('ml:read'), (req, res) => {
  const name = req.params.name;
  if (!isValidAgentName(name)) return res.status(400).json({ error: '無効なエージェント名' });
  const mp = path.join(RL_MODELS_DIR, name, 'metrics.json');
  if (!fs.existsSync(mp)) return res.status(404).json({ error: 'メトリクスが見つかりません (未学習?)' });
  try { res.json(JSON.parse(fs.readFileSync(mp, 'utf-8'))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── エージェント削除 ───
app.delete('/ml/rl/models/:name', requireAuth, requirePermission('ml:write'), (req, res) => {
  const ip = getIP(req);
  const name = req.params.name;
  if (!isValidAgentName(name)) return res.status(400).json({ error: '無効なエージェント名' });
  if (currentRlJob && currentRlJob.name === name) {
    return res.status(409).json({ error: '学習中のエージェントは削除できません' });
  }
  const dir = path.join(RL_MODELS_DIR, name);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'エージェントが見つかりません' });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  log(ip, `[RL学習] エージェント削除: ${name}`);
  res.json({ ok: true });
});

// 学習済みエージェントの env (組み込み/dataset) を config.json から判定
function getRlAgentEnv(name) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(RL_MODELS_DIR, name, 'config.json'), 'utf-8'));
    return cfg.env || null;
  } catch { return null; }
}

// ─── リアルタイム/オンラインRL ワーカー管理 ───
// rl_online_server.py をメモリ常駐させ、act/learn を localhost HTTP でプロキシする。
// sd-server/llama-server と同じく遅延起動・identity-guard でハンドルを null 化。
// 注意: オンライン学習は DuckDB を一切使わない (経験はAPI経由、ウォームスタートは
//       model.pt/config.json の読み込みのみ) ため、ML DB の release/reacquire 調停は不要。
let rlOnlineWorker = { proc: null, port: null, starting: false, lastUsed: 0 };

async function ensureRlOnlineWorker() {
  const ml = appConfig.ml || {};
  const port = ml.onlinePort || 11600;
  if (rlOnlineWorker.proc && !rlOnlineWorker.proc.killed) {
    rlOnlineWorker.lastUsed = Date.now();
    return port;
  }
  // 既に起動処理中なら ready を待つ
  if (rlOnlineWorker.starting) {
    const ok = await waitForReady('127.0.0.1', port, ml.onlineReadyTimeoutMs || 60000, false);
    if (!ok) throw new Error('オンラインRLワーカーの起動待ちがタイムアウトしました');
    rlOnlineWorker.lastUsed = Date.now();
    return port;
  }
  rlOnlineWorker.starting = true;
  try {
    const scriptPath = path.join(__dirname, 'rl_online_server.py');
    if (!fs.existsSync(scriptPath)) throw new Error('rl_online_server.py が見つかりません');
    const pythonCmd = appConfig.pythonPath || 'python3';
    const { spawn } = require('child_process');
    const proc = spawn(pythonCmd, [scriptPath, String(port)], {
      cwd: __dirname,
      env: { ...process.env, PYTHONUNBUFFERED: '1', RL_MODELS_DIR },
    });
    const quiet = appConfig.logLevel === 'quiet';
    proc.stdout.on('data', d => { if (!quiet) process.stdout.write(`[rl-online] ${d}`); });
    proc.stderr.on('data', d => { if (!quiet) process.stderr.write(`[rl-online] ${d}`); });
    proc.on('exit', (code) => {
      if (rlOnlineWorker.proc === proc) rlOnlineWorker.proc = null;
      log('-', `[rl-online] ワーカー終了 (code=${code})`);
    });
    proc.on('error', (err) => {
      if (rlOnlineWorker.proc === proc) rlOnlineWorker.proc = null;
      log('-', `[rl-online] 起動エラー: ${err.message}`);
    });
    rlOnlineWorker.proc = proc;
    rlOnlineWorker.port = port;
    // readiness 待ちと、spawn 失敗(error/即時exit)を競合させて即座に失敗を検出する
    const failPromise = new Promise((resolve) => {
      proc.once('error', () => resolve('error'));
      proc.once('exit', () => resolve('exit'));
    });
    const ok = await Promise.race([
      waitForReady('127.0.0.1', port, ml.onlineReadyTimeoutMs || 60000, false),
      failPromise,
    ]);
    if (ok !== true) {
      try { proc.kill('SIGKILL'); } catch {}
      rlOnlineWorker.proc = null;
      throw new Error('オンラインRLワーカーが起動しませんでした (torch 未インストール、または pythonPath を確認してください)');
    }
    rlOnlineWorker.lastUsed = Date.now();
    log('-', `[rl-online] ワーカー起動 (:${port})`);
    return port;
  } finally {
    rlOnlineWorker.starting = false;
  }
}

// ワーカーへ JSON POST して JSON 応答を得る
function rlWorkerRequest(reqPath, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}), 'utf-8');
    const req = http.request({
      hostname: '127.0.0.1', port: rlOnlineWorker.port, path: reqPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      timeout: 30000,
    }, (resp) => {
      let b = '';
      resp.on('data', d => b += d);
      resp.on('end', () => {
        let j;
        try { j = JSON.parse(b); } catch { return reject(new Error('ワーカー応答の解析に失敗しました')); }
        if (resp.statusCode >= 400) {
          const e = new Error(j.error || `ワーカーエラー ${resp.statusCode}`);
          e.status = resp.statusCode;
          return reject(e);
        }
        resolve(j);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('ワーカーへのリクエストがタイムアウトしました')); });
    req.write(data); req.end();
  });
}

// アイドル停止チェック (既定 onlineIdleMs=0 で無効)
function checkRlOnlineIdle() {
  const idleMs = appConfig.ml?.onlineIdleMs;
  if (!idleMs || idleMs <= 0) return;
  if (!rlOnlineWorker.proc || rlOnlineWorker.starting) return;
  if (Date.now() - rlOnlineWorker.lastUsed >= idleMs) {
    log('-', '[rl-online] アイドルのためワーカーを停止 (dirty は自動保存)');
    try { rlOnlineWorker.proc.kill('SIGTERM'); } catch {}
  }
}
setInterval(checkRlOnlineIdle, 30000);

// 学習済みエージェント一覧 (HTTPルートと agent_proxy ツールから共用)
function loadRlAgents() {
  const models = [];
  try {
    for (const name of fs.readdirSync(RL_MODELS_DIR)) {
      const cfgPath = path.join(RL_MODELS_DIR, name, 'config.json');
      const modelPath = path.join(RL_MODELS_DIR, name, 'model.pt');
      if (!fs.existsSync(cfgPath) || !fs.existsSync(modelPath)) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        const info = {
          name, env: cfg.env, algo: cfg.algo, datasetMode: cfg.datasetMode,
          actionLabels: cfg.actionLabels, trainedAt: cfg.trainedAt,
          online: cfg.online === true || cfg.env === 'online',
        };
        if (cfg.env === 'dataset' || cfg.env === 'online') {
          info.tableName = cfg.tableName;
          info.stateColumns = cfg.meta?.stateColumns || [];
          info.actionColumn = cfg.meta?.actionColumn;
        }
        const mp = path.join(RL_MODELS_DIR, name, 'metrics.json');
        if (fs.existsSync(mp)) { try { info.metrics = JSON.parse(fs.readFileSync(mp, 'utf-8')); } catch {} }
        models.push(info);
      } catch {}
    }
  } catch {}
  models.sort((a, b) => (b.trainedAt || 0) - (a.trainedAt || 0));
  return models;
}

// RL エージェントの評価 (組み込み=ロールアウト軌跡 / dataset=オフライン方策評価)。
// dataset の場合は Python が DuckDB を read_only で開くため Node 側接続を一時解放する。
function runRlEval(name, episodes) {
  return new Promise((resolve, reject) => {
    if (!isValidAgentName(name)) return reject(new Error('無効なエージェント名'));
    if (currentRlJob) return reject(new Error(`学習中のため評価できません: ${currentRlJob.name}`));
    const modelDir = path.join(RL_MODELS_DIR, name);
    if (!fs.existsSync(path.join(modelDir, 'model.pt'))) return reject(new Error('エージェントが学習されていません'));
    const scriptPath = path.join(__dirname, 'rl_runner.py');
    if (!fs.existsSync(scriptPath)) return reject(new Error('rl_runner.py が見つかりません'));

    const isDataset = getRlAgentEnv(name) === 'dataset';
    const ep = Math.min(Math.max(parseInt(episodes) || 5, 1), 20);
    const evalCfg = path.join(modelDir, '_eval_config.json');
    const evalConfig = { mode: 'eval', modelDir, episodes: ep, outputDir: modelDir };
    if (isDataset) evalConfig.dbPath = ML_DB_FILE;

    const run = () => {
      fs.writeFileSync(evalCfg, JSON.stringify(evalConfig, null, 2));
      const pythonCmd = appConfig.pythonPath || 'python3';
      const { spawn } = require('child_process');
      const proc = spawn(pythonCmd, [scriptPath, evalCfg], { cwd: __dirname, env: { ...process.env, PYTHONUNBUFFERED: '1' } });
      let stdout = '', stderr = '';
      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });
      const timeout = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 120000);
      proc.on('close', (code) => {
        clearTimeout(timeout);
        try { fs.unlinkSync(evalCfg); } catch {}
        if (isDataset) reacquireMlDb();
        const m = (stdout + stderr).match(/RESULT_JSON:(.+)/);
        if (m) {
          try {
            const result = JSON.parse(m[1]);
            if (result.status === 'completed') return resolve(result);
            return reject(new Error(result.error || '評価に失敗しました'));
          } catch (e) { return reject(new Error(`結果のパース失敗: ${e.message}`)); }
        }
        reject(new Error(`評価失敗 (exit ${code}): ${stderr.slice(0, 300) || stdout.slice(0, 300)}`));
      });
      proc.on('error', (err) => { clearTimeout(timeout); if (isDataset) reacquireMlDb(); reject(new Error(`評価プロセス起動失敗: ${err.message}`)); });
    };

    if (isDataset) releaseMlDbForExternal('-').then(run).catch(run);
    else run();
  });
}

// RL エージェントの推論: 状態を1件与えて推奨行動とQ値を返す (DuckDB 不使用)。
function runRlPolicy(name, state) {
  return new Promise((resolve, reject) => {
    if (!isValidAgentName(name)) return reject(new Error('無効なエージェント名'));
    const modelDir = path.join(RL_MODELS_DIR, name);
    if (!fs.existsSync(path.join(modelDir, 'model.pt'))) return reject(new Error('エージェントが学習されていません'));
    const scriptPath = path.join(__dirname, 'rl_runner.py');
    if (!fs.existsSync(scriptPath)) return reject(new Error('rl_runner.py が見つかりません'));
    const polCfg = path.join(modelDir, `_policy_${Date.now()}.json`);
    fs.writeFileSync(polCfg, JSON.stringify({ mode: 'policy', modelDir, state: state || {} }, null, 2));
    const pythonCmd = appConfig.pythonPath || 'python3';
    const { spawn } = require('child_process');
    const proc = spawn(pythonCmd, [scriptPath, polCfg], { cwd: __dirname, env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    const timeout = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 30000);
    proc.on('close', (code) => {
      clearTimeout(timeout);
      try { fs.unlinkSync(polCfg); } catch {}
      const m = (stdout + stderr).match(/RESULT_JSON:(.+)/);
      if (m) {
        try {
          const result = JSON.parse(m[1]);
          if (result.status === 'completed') return resolve(result);
          return reject(new Error(result.error || '推論に失敗しました'));
        } catch (e) { return reject(new Error(`結果のパース失敗: ${e.message}`)); }
      }
      reject(new Error(`推論失敗 (exit ${code}): ${stderr.slice(0, 300) || stdout.slice(0, 300)}`));
    });
    proc.on('error', (err) => { clearTimeout(timeout); reject(new Error(`推論プロセス起動失敗: ${err.message}`)); });
  });
}

// ─── 評価 (組み込み=軌跡 / dataset=オフライン方策評価) ───
// body: { episodes? }
app.post('/ml/rl/models/:name/eval', requireAuth, requirePermission('ml:read'), jsonParser, async (req, res) => {
  try {
    const result = await runRlEval(req.params.name, (req.body || {}).episodes);
    res.json(result);
  } catch (e) {
    res.status(/学習中/.test(e.message) ? 409 : 500).json({ error: e.message });
  }
});

// ─── 推論 (推奨行動取得) ───
// body: { state: { 列名: 値, ... } }  (dataset) または { state: [v0, v1, ...] } (組み込み環境)
app.post('/ml/rl/models/:name/policy', requireAuth, requirePermission('ml:read'), jsonParser, async (req, res) => {
  try {
    const result = await runRlPolicy(req.params.name, (req.body || {}).state);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── リアルタイム/オンラインRL 外部API (常駐ワーカー経由) ───

// オンラインエージェントの作成: fromAgent でウォームスタート、または spec でゼロから新規
app.post('/ml/rl/online/create', requireAuth, requirePermission('ml:write'), jsonParser, async (req, res) => {
  try {
    const body = req.body || {};
    await ensureRlOnlineWorker();
    if (body.fromAgent) {
      if (!isValidAgentName(body.fromAgent)) return res.status(400).json({ error: '無効なエージェント名' });
      const dir = path.join(RL_MODELS_DIR, body.fromAgent);
      if (!fs.existsSync(path.join(dir, 'model.pt')) || !fs.existsSync(path.join(dir, 'config.json'))) {
        return res.status(404).json({ error: `学習済みエージェントが見つかりません: ${body.fromAgent}` });
      }
      // ウォームスタートは同一エージェント名でそのままオンライン継続学習する
      const result = await rlWorkerRequest('/load_offline', { name: body.fromAgent });
      return res.json(result);
    }
    if (body.spec && typeof body.spec === 'object') {
      const name = body.name;
      if (!isValidAgentName(name)) return res.status(400).json({ error: '無効なエージェント名 (英数_-、64文字以内)' });
      if (fs.existsSync(path.join(RL_MODELS_DIR, name, 'config.json'))) {
        return res.status(409).json({ error: `エージェント名が既に存在します: ${name}` });
      }
      const spec = body.spec;
      if (!Array.isArray(spec.stateColumns) || spec.stateColumns.length === 0) {
        return res.status(400).json({ error: 'spec.stateColumns を1つ以上指定してください' });
      }
      if (!Array.isArray(spec.actionLabels) || spec.actionLabels.length < 2) {
        return res.status(400).json({ error: 'spec.actionLabels は2つ以上指定してください' });
      }
      const result = await rlWorkerRequest('/create', { name, spec });
      return res.json(result);
    }
    res.status(400).json({ error: 'fromAgent か spec のいずれかを指定してください' });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 推論: 状態を与えて推奨行動を取得 (epsilon>0 で ε-greedy 探索)
app.post('/ml/rl/models/:name/act', requireAuth, requirePermission('ml:read'), jsonParser, async (req, res) => {
  try {
    const name = req.params.name;
    if (!isValidAgentName(name)) return res.status(400).json({ error: '無効なエージェント名' });
    const body = req.body || {};
    if (typeof body.state !== 'object' || body.state === null || Array.isArray(body.state)) {
      return res.status(400).json({ error: 'state は {列名: 値} のオブジェクトで指定してください' });
    }
    let epsilon = body.epsilon;
    if (epsilon != null && (typeof epsilon !== 'number' || epsilon < 0 || epsilon > 1)) {
      return res.status(400).json({ error: 'epsilon は 0〜1 の数値で指定してください' });
    }
    await ensureRlOnlineWorker();
    const result = await rlWorkerRequest('/act', { name, state: body.state, epsilon });
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 学習: 経験 (state, action, reward[, next_state, done]) を投入して即時更新
app.post('/ml/rl/models/:name/learn', requireAuth, requirePermission('ml:write'), jsonParser, async (req, res) => {
  try {
    const name = req.params.name;
    if (!isValidAgentName(name)) return res.status(400).json({ error: '無効なエージェント名' });
    const body = req.body || {};
    const payload = { name };
    if (Array.isArray(body.experiences)) {
      if (body.experiences.length === 0) return res.status(400).json({ error: 'experiences が空です' });
      if (body.experiences.length > 1000) return res.status(400).json({ error: 'experiences は1000件以下にしてください' });
      payload.experiences = body.experiences;
    } else {
      if (typeof body.state !== 'object' || body.state === null || Array.isArray(body.state)) {
        return res.status(400).json({ error: 'state は {列名: 値} のオブジェクトで指定してください' });
      }
      if (typeof body.reward !== 'number' || !isFinite(body.reward)) {
        return res.status(400).json({ error: 'reward は数値で指定してください' });
      }
      if (body.action == null) return res.status(400).json({ error: 'action を指定してください' });
      Object.assign(payload, {
        state: body.state, action: body.action, reward: body.reward,
        next_state: body.next_state, done: body.done,
      });
    }
    await ensureRlOnlineWorker();
    const result = await rlWorkerRequest('/learn', payload);
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// 明示的チェックポイント (model.pt / config.json / metrics.json を保存)
app.post('/ml/rl/models/:name/checkpoint', requireAuth, requirePermission('ml:write'), jsonParser, async (req, res) => {
  try {
    const name = req.params.name;
    if (!isValidAgentName(name)) return res.status(400).json({ error: '無効なエージェント名' });
    await ensureRlOnlineWorker();
    const result = await rlWorkerRequest('/checkpoint', { name });
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// オンライン学習状況
app.get('/ml/rl/models/:name/online/status', requireAuth, requirePermission('ml:read'), async (req, res) => {
  try {
    const name = req.params.name;
    if (!isValidAgentName(name)) return res.status(400).json({ error: '無効なエージェント名' });
    await ensureRlOnlineWorker();
    const result = await rlWorkerRequest('/status', { name });
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

function runMlPredict(modelName, features) {
  return new Promise((resolve, reject) => {
    if (!isValidModelName(modelName)) return reject(new Error('無効なモデル名'));
    if (currentMlJob) return reject(new Error(`現在学習中のため推論できません: ${currentMlJob.modelName}`));

    const modelDir = path.join(ML_MODELS_DIR, modelName);
    if (!fs.existsSync(path.join(modelDir, 'model.pt'))) {
      return reject(new Error(`モデルが学習されていません: ${modelName}`));
    }

    let feats = features;
    if (feats === undefined) return reject(new Error('features が必要です'));
    if (!Array.isArray(feats)) feats = [feats];
    if (feats.length === 0) return reject(new Error('features が空です'));
    if (feats.length > 100) return reject(new Error('features は100件以下にしてください'));

    const pythonCmd = appConfig.pythonPath || 'python3';
    const scriptPath = path.join(__dirname, 'ml_predict.py');
    if (!fs.existsSync(scriptPath)) return reject(new Error(`ml_predict.py が見つかりません`));

    const { spawn } = require('child_process');
    const proc = spawn(pythonCmd, [scriptPath, modelDir], {
      cwd: __dirname,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timeout = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 30000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        try { return reject(new Error(JSON.parse(stdout || stderr).error || `推論失敗 (exit ${code})`)); }
        catch { return reject(new Error(`推論失敗 (exit ${code}): ${stderr.slice(0, 300) || stdout.slice(0, 300)}`)); }
      }
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error(`推論結果のパース失敗: ${e.message}`)); }
    });
    proc.on('error', (err) => { clearTimeout(timeout); reject(new Error(`推論プロセス起動失敗: ${err.message}`)); });

    proc.stdin.write(JSON.stringify({ features: feats }));
    proc.stdin.end();
  });
}

app.post('/ml/models/:name/predict', requireAuth, requirePermission('ml:read'), jsonParser, async (req, res) => {
  const ip = getIP(req);
  const name = req.params.name;
  let { features } = req.body || {};
  try {
    const result = await runMlPredict(name, features);
    log(ip, `[ML] predict ${name}: ${result.count} 件`);
    res.json(result);
  } catch (e) {
    // 学習中/未学習などはステータス分岐
    const msg = e.message || String(e);
    const status = /学習中/.test(msg) ? 409 : /学習されていません|見つかりません/.test(msg) ? 404 : 500;
    res.status(status).json({ error: msg });
  }
});


// ════════════════════════════════════════════════
// 外部API(ツール対応モード)用 永続RAGストア
// ════════════════════════════════════════════════
// 既存 uploads フォルダのファイルを embedding 化して保存し、
// agent_proxy の search_documents ツールから検索できるようにする。

// テキストをチャンクに分割
// ブラウザ側 chunkText と完全に同じロジック (overlap >= chunkSize でも無限ループしない)
function ragChunkText(text, chunkSize = 500, overlap = 100) {
  const chunks = [];
  if (!text) return chunks;
  const safeOverlap = Math.min(overlap, Math.floor(chunkSize / 2));
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start += chunkSize - safeOverlap;
  }
  return chunks;
}

// cosine類似度
// ブラウザ側 cosineSim と完全に同じロジック
function ragCosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}

// 内部 embedding サーバーを呼んでベクトルを取得
async function ragGetEmbedding(text) {
  const ready = await ensureEmbeddingLoaded();
  if (!ready) throw new Error('Embeddingサーバーが起動できません (config.embeddingModel.path 未設定、またはモデルファイル不在)');
  const ls = appConfig.llamaServer;
  const url = `http://${ls.embeddingHost}:${ls.embeddingPort}/v1/embeddings`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'embedding', input: text }),
  });
  if (!resp.ok) throw new Error(`Embedding取得失敗 (${resp.status})`);
  const data = await resp.json();
  const vec = data.data?.[0]?.embedding;
  if (!vec) throw new Error('Embeddingレスポンスが不正');
  return vec;
}

// embedding 機能が利用可能かどうか (config + ファイル存在をチェック)
// プロセス起動はしないので軽量、UIや起動前バリデーションで使える
function isEmbeddingAvailable() {
  const em = appConfig.embeddingModel;
  if (!em || !em.path) return { available: false, reason: 'config.embeddingModel.path が未設定です' };
  if (!fs.existsSync(em.path)) return { available: false, reason: `モデルファイルが存在しません: ${em.path}` };
  return { available: true };
}

// RAGインデックス (登録ドキュメント一覧) のロード/保存
function loadRagIndex() {
  if (!fs.existsSync(RAG_INDEX_FILE)) return { documents: [] };
  try { return JSON.parse(fs.readFileSync(RAG_INDEX_FILE, 'utf-8')); }
  catch { return { documents: [] }; }
}
function saveRagIndex(idx) {
  fs.writeFileSync(RAG_INDEX_FILE, JSON.stringify(idx, null, 2), 'utf-8');
}

// docId 生成 (filename から安全な ID)
function ragDocId(filename) {
  return crypto.createHash('sha1').update(filename).digest('hex').slice(0, 16);
}

// uploads のファイルを RAG 化して保存
async function ragIngestFile(filename) {
  const abs = safeUploadPath(filename);
  if (!abs) throw new Error('無効なファイルパス');
  if (!fs.existsSync(abs)) throw new Error(`ファイルが見つかりません: ${filename}`);
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new Error('ファイルではありません');
  if (stat.size > MAX_FILE_SIZE) throw new Error('ファイルが大きすぎます');

  // テキスト読み込み (テキスト/Markdown想定。バイナリは弾く)
  const ext = path.extname(abs).toLowerCase();
  const textExts = ['.txt', '.md', '.markdown', '.csv', '.json', '.log', '.html', '.xml', '.yaml', '.yml', '.py', '.js', '.ts'];
  if (!textExts.includes(ext)) {
    throw new Error(`テキスト系ファイルのみ対応 (対応拡張子: ${textExts.join(', ')})。PDF/Word等は事前にテキスト化してください`);
  }
  const text = fs.readFileSync(abs, 'utf-8');
  if (!text.trim()) throw new Error('ファイルが空です');

  // チャンク分割 + embedding
  const chunks = ragChunkText(text);
  const embeddings = [];
  for (const chunk of chunks) {
    const vec = await ragGetEmbedding(chunk);
    embeddings.push(vec);
  }

  // 保存
  const docId = ragDocId(filename);
  const docData = {
    docId, filename, chunkCount: chunks.length,
    chunks, embeddings,
    ingestedAt: Date.now(),
  };
  fs.writeFileSync(path.join(RAG_DIR, `${docId}.json`), JSON.stringify(docData), 'utf-8');

  // インデックス更新
  const idx = loadRagIndex();
  idx.documents = idx.documents.filter(d => d.docId !== docId);  // 既存削除
  idx.documents.push({
    docId, filename, chunkCount: chunks.length, ingestedAt: docData.ingestedAt,
  });
  saveRagIndex(idx);

  return { docId, filename, chunkCount: chunks.length };
}

// RAG検索 (全ドキュメントのチャンクから cosine 類似度 top-k)
async function ragSearch(query, topK = 5) {
  const idx = loadRagIndex();
  if (idx.documents.length === 0) return { results: [], note: 'RAGドキュメントが登録されていません' };

  const qVec = await ragGetEmbedding(query);
  const scored = [];
  for (const doc of idx.documents) {
    const docPath = path.join(RAG_DIR, `${doc.docId}.json`);
    if (!fs.existsSync(docPath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(docPath, 'utf-8'));
      for (let i = 0; i < data.chunks.length; i++) {
        const sim = ragCosineSim(qVec, data.embeddings[i]);
        scored.push({ filename: data.filename, chunkIndex: i, text: data.chunks[i], score: sim });
      }
    } catch {}
  }
  scored.sort((a, b) => b.score - a.score);
  return { results: scored.slice(0, topK) };
}

// ─── RAG API エンドポイント (要 ml:read / ml:write 権限) ───

// 登録ドキュメント一覧
app.get('/rag/documents', requireAuth, requirePermission('ml:read'), (req, res) => {
  const idx = loadRagIndex();
  res.json({ documents: idx.documents });
});

// RAG系エンドポイント用: embedding が利用可能かチェックするミドルウェア
// 利用不可なら 503 を返して後続に進ませない (各ハンドラでの重複チェックを排除)
function requireEmbedding(req, res, next) {
  const emb = isEmbeddingAvailable();
  if (!emb.available) {
    return res.status(503).json({
      error: `RAG機能はembeddingサーバーが必要です。${emb.reason}`,
      embeddingAvailable: false,
    });
  }
  next();
}

// uploads のファイルを RAG 登録
// body: { filename: "manual.txt" }  または { filenames: ["a.txt", "b.md"] }
app.post('/rag/documents', requireAuth, requirePermission('ml:write'), requireEmbedding, jsonParser, async (req, res) => {
  const ip = getIP(req);
  const { filename, filenames } = req.body || {};
  const targets = filenames || (filename ? [filename] : []);
  if (targets.length === 0) {
    return res.status(400).json({ error: 'filename または filenames が必要です' });
  }
  const results = [];
  const errors = [];
  for (const f of targets) {
    try {
      const r = await ragIngestFile(f);
      results.push(r);
      log(ip, `[RAG] 登録: ${f} (${r.chunkCount} チャンク)`);
    } catch (e) {
      errors.push({ filename: f, error: e.message });
      log(ip, `[RAG] 登録失敗: ${f} - ${e.message}`);
    }
  }
  res.json({ ingested: results, errors, count: results.length });
});

// RAG ドキュメント削除 (embedding不要: ファイル削除のみ)
app.delete('/rag/documents/:docId', requireAuth, requirePermission('ml:write'), (req, res) => {
  const docId = req.params.docId;
  if (!/^[a-f0-9]{16}$/.test(docId)) return res.status(400).json({ error: '無効なdocId' });
  const docPath = path.join(RAG_DIR, `${docId}.json`);
  if (fs.existsSync(docPath)) fs.unlinkSync(docPath);
  const idx = loadRagIndex();
  idx.documents = idx.documents.filter(d => d.docId !== docId);
  saveRagIndex(idx);
  res.json({ ok: true });
});

// RAG 検索 (テスト用、agent_proxy も内部でこれと同じ ragSearch を使う)
app.post('/rag/search', requireAuth, requirePermission('ml:read'), requireEmbedding, jsonParser, async (req, res) => {
  const { query, topK } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query が必要です' });
  try {
    const result = await ragSearch(query, Math.min(topK || 5, 20));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── フォールバック ───
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── サーバー起動 ───
server.listen(PORT, '0.0.0.0', async () => {
  const name = `${appConfig.appName} Server`;
  const ls = appConfig.llamaServer;
  const lines = [];
  lines.push(`  URL    : ${HTTPS_ENABLED ? 'https' : 'http'}://localhost:${PORT}`);
  lines.push(`  Backend: llama.cpp (llama-server)`);
  lines.push(`  Bin    : ${ls.binPath}`);
  lines.push(`  Chat   : ${ls.chatHost}:${ls.chatPort}`);
  lines.push(`  Embed  : ${ls.embeddingHost}:${ls.embeddingPort}`);
  lines.push(`  Models : ${chatModels.length} chat model(s)`);
  chatModels.forEach((m, i) => {
    lines.push(`    [${i}] ${m.name} (ctx=${m.ctx}, ngl=${m.ngl})`);
  });
  lines.push(`  Python : ${appConfig.pythonPath || 'python3'}`);
  const w = Math.max(name.length + 6, ...lines.map(l => l.length + 2), 40);
  const pad = (s) => s + ' '.repeat(Math.max(0, w - s.length));
  console.log('');
  console.log(`  ╔${'═'.repeat(w)}╗`);
  console.log(`  ║${pad('   ' + name)}║`);
  console.log(`  ╠${'═'.repeat(w)}╣`);
  for (const l of lines) console.log(`  ║${pad(l)}║`);
  console.log(`  ╚${'═'.repeat(w)}╝`);
  console.log('');

  // 起動時にGPUデータ取得
  await updateGpuData();

  // 起動時に llama.cpp バージョンを1回取得（バックグラウンド、失敗しても起動は継続）
  updateLlamaVersion();

  // 初期モデル名のみ決定（実際のロードは最初のリクエスト時）
  // 優先順位: 1) settings.json の前回モデル, 2) defaultModel, 3) chatModels[0]
  if (chatModels.length > 0) {
    let initialModel = null;
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
        if (settings.chatModel && findModelByName(settings.chatModel)) {
          initialModel = settings.chatModel;
        }
      }
    } catch (e) {
      log('-', `settings.json読み込みエラー: ${e.message}`);
    }
    if (!initialModel) initialModel = appConfig.defaultModel || chatModels[0].name;
    // VRAM節約のため起動はせず、「自動アンロード状態」として記録 → 初回リクエスト時に自動ロード
    chatProcAutoUnloaded = initialModel;
    log('-', `初期モデル: ${initialModel}（最初のリクエスト時にロード）`);
  } else {
    log('-', 'chatModels が空です。config.json でモデルを設定してください。');
  }
  // Embeddingも同様に初回リクエスト時にロード
  log('-', 'Embeddingモデル: 最初のリクエスト時にロード');
});

// ─── バックグラウンドGPU監視（ローカル単体） ───
let cachedGpuData = [];
let gpuUpdating = false;

async function updateGpuData() {
  if (gpuUpdating) return;
  gpuUpdating = true;
  try { cachedGpuData = await queryGpu(); } finally { gpuUpdating = false; }
}

// ─── llama.cpp バージョン検出（起動時に1回だけ取得してキャッシュ） ───
// llama-server --version の出力（stderr）例:
//   version: 4589 (abc1234)
//   built with cc (GCC) ... for x86_64-linux-gnu
// バイナリは再起動まで変わらないので毎秒取る必要はなく、起動時に1回取得すれば十分。
let cachedLlamaVersion = null; // { build, commit, raw } または null

function detectLlamaVersion() {
  return new Promise((resolve) => {
    const ls = appConfig.llamaServer;
    const binPath = ls && ls.binPath;
    if (!binPath) { resolve(null); return; }
    let out = '';
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    try {
      const proc = spawn(binPath, ['--version'], { timeout: 5000 });
      // --version は stderr に出力されることが多いが、念のため両方を見る
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.stderr.on('data', (d) => { out += d.toString(); });
      proc.on('error', () => finish(null));
      proc.on('close', () => {
        const m = out.match(/version:\s*(\d+)\s*(?:\(([0-9a-f]+)\))?/i);
        if (m) {
          finish({ build: m[1], commit: m[2] || '', raw: m[0].trim() });
        } else {
          // 念のため最初の非空行を生で保持
          const line = out.split('\n').map(s => s.trim()).find(Boolean);
          finish(line ? { build: '', commit: '', raw: line } : null);
        }
      });
    } catch {
      finish(null);
    }
  });
}

async function updateLlamaVersion() {
  try {
    cachedLlamaVersion = await detectLlamaVersion();
    if (cachedLlamaVersion) {
      log('-', `llama.cpp version: ${cachedLlamaVersion.raw}`);
    }
  } catch { /* 取得失敗時は null のまま */ }
}

function buildGpuSseData() {
  return [{
    label: 'localhost',
    host: '127.0.0.1',
    port: appConfig.llamaServer.chatPort,
    gpus: cachedGpuData,
    llamaVersion: cachedLlamaVersion,
  }];
}
setInterval(updateGpuData, GPU_INTERVAL);
