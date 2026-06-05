# OpenGeekLLMChat - 設計ドキュメント

このドキュメントは、コード修正時にLLMが参照する設計書です。
アーキテクチャ、データフロー、主要な技術判断の理由が記載されています。

---

## 📐 全体アーキテクチャ

```
┌─────────────────────────────────────────────────────────┐
│                    Browser (Client)                     │
│  public/index.html (React SPA / 単一ファイル / ~4300行) │
│  - 認証画面                                             │
│  - チャットUI                                           │
│  - Python実行ターミナル                                 │
│  - GPU監視サイドバー                                    │
│  - Web Speech API (STT/TTS)                             │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTPS / WebSocket
                       │
┌──────────────────────▼──────────────────────────────────┐
│                  server.js (Node.js)                    │
│  - Express (HTTP/HTTPS切り替え自動)                     │
│  - WebSocket (ws) - Python実行                          │
│  - セッション管理                                       │
│  - llama-server プロセス管理 (起動/停止/再起動)          │
│  - /v1/* OpenAI互換API リバースプロキシ                 │
│  - DuckDuckGo検索 (+本文取得)                           │
│  - ファイル操作API                                      │
│  - GPU監視 SSE                                          │
└─────┬──────────┬──────────┬──────────┬─────────────────┘
      │          │          │          │
      ▼          ▼          ▼          ▼
  ┌───────┐ ┌───────┐ ┌───────┐ ┌─────────────┐
  │ chat  │ │ embed │ │Python │ │DuckDuckGo   │
  │:8080  │ │:8081  │ │subproc│ │HTTP         │
  │llama- │ │llama- │ └───────┘ └─────────────┘
  │server │ │server │
  └───────┘ └───────┘
  （子プロセスとして起動・管理）
```

---

## 📁 ファイル構成と役割

| ファイル | 役割 | 依存 |
|:--|:--|:--|
| `server.js` | メインサーバー（Express+WS、llama-server管理） | `express`, `ws` |
| `public/index.html` | React SPA単一ファイル | CDN経由（react, marked, highlight.js, katex, three.js） |
| `config.json` | 全設定 | - |
| `hashpass.py` | パスワードハッシュ生成 | Python標準 |
| `generate-cert.sh` | 自己署名SSL生成 | openssl |
| `transcribe-server.py` | Gemma4音声認識（参考実装） | transformers, torch |
| `opengeek-llm-chat.service` | systemdテンプレート | - |

---

## 🔐 認証フロー

```
[初回アクセス]
Browser              Server
   │                   │
   │── GET /config ───>│
   │<── { hasPassword:true, authenticated:false }
   │ ログイン画面表示  │
   │                   │
   │── POST /auth ────>│ (パスワード送信)
   │                   │ crypto.timingSafeEqual で照合
   │                   │ 失敗時: loginAttempts でレートリミット
   │<── Set-Cookie ────│ wz_session=<32byteHex> HttpOnly SameSite=Strict [Secure]
   │ チャット画面       │ sessions Map に格納 (TTL 24h)

[再アクセス (Cookie有効)]
   │── GET /config (Cookie付き) ──>│
   │                               │ isValidSession() 検証
   │<── { authenticated:true } ────│
   │ ログイン画面スキップ          │
```

### セキュリティ要素
- **セッションメモリ保持**: Map (サーバー再起動でリセット)
- **Cookie属性**: `HttpOnly; SameSite=Strict; Max-Age=86400` + HTTPS時 `Secure`
- **HTTPS自動判定**: `HTTPS_ENABLED || X-Forwarded-Proto === 'https'`
- **レートリミット**: 15分5回失敗で429
- **全認証必須ルートに `requireAuth` ミドルウェア適用**

### `isValidSession(token)`
```javascript
const s = sessions.get(token);
if (!s || s.expiresAt < Date.now()) { sessions.delete(token); return false; }
return true;
```

---

## 🤖 Agentic RAG / マルチターンツール実行

### 概要

LLMが応答生成前に「ツール判断フェーズ」と「最終応答フェーズ」の2段階で動作:

```
[1] ツール判断フェーズ (非ストリーミング)
    - 軽量max_tokens (smallPredict: 512)
    - tools パラメータでllama-serverに関数一覧を渡す
    - LLMが tool_calls を返すか、直接応答するか判断
    - 注: llama.cppではctxはサーバー起動時固定なので、ctxのリクエスト時調整は不可

[2] ツール実行フェーズ (最大3ターン)
    - tool_calls があれば実行
    - 結果を messages に追加（OpenAI互換: role=tool, tool_call_id 必須）
    - 再度ツール判断へ (tool_calls がなくなるまで繰り返し)

[3] 最終応答フェーズ (ストリーミング)
    - toolsなしで /v1/chat/completions 呼び出し
    - SSEストリームで content + reasoning_content を受信
```

### マルチターン実装のポイント

```javascript
const MAX_TOOL_TURNS = 3;
while (toolTurn < MAX_TOOL_TURNS) {
  toolTurn++;
  const turnMessages = toolTurn === 1
    ? judgeMessages
    : [judgeSystem, ...apiMessages.slice(1)];

  const res = await chat({ messages: turnMessages, tools, stream: false });
  if (!res.message.tool_calls?.length) break;  // ツール呼び出しなくなったら終了
  apiMessages.push(res.message);
  // 各 tool_call を実行して apiMessages に結果追加
}
// 最終応答はtoolsなしでストリーミング
```

### ツールセット

| 関数名 | 引数 | 説明 |
|:--|:--|:--|
| `search_documents` | `query` | アップロードドキュメントのベクター検索 |
| `web_search` | `query` | DuckDuckGo検索+上位3件の本文取得 |
| `list_files` | なし | `public/uploads/` 一覧 |
| `read_file` | `path` | ファイル読み込み |
| `write_file` | `path`, `content` | ファイル書き込み |

### 引数の揺れ対応

LLMが `path`/`filename`/`file`/`filepath` など揺らぎで呼ぶため、フロント側で吸収:

```javascript
const fpath = fnArgs.path || fnArgs.filename || fnArgs.file || fnArgs.filepath || '';
```

### ドキュメントとサーバーファイルの優先順位

LLMが「資料を見て」「ドキュメントを参照」と言われた時にうっかり `list_files`（uploads配下）を呼ぶ問題への対処。**ツール定義のdescriptionに利用可能なドキュメント名を埋め込み**、システムプロンプトで明示的に区別する:

```javascript
tools.push({
  function: {
    name: 'search_documents',
    description: `チャットに添付されたドキュメントから関連情報を検索する。検索対象のドキュメント: ${docNames}。これらのドキュメントについての質問は必ずこのツールを使用すること。テキストで関数呼び出しを書くのではなく、必ず実際のtool_callとして呼び出すこと。`,
    ...
  }
});
```

システムプロンプトでも「【参照可能なドキュメント】(チャットに添付されたファイル)」と「【サーバーファイル操作】(uploads配下)」をはっきり分けて説明する。

### テキストツール呼び出しのフォールバック

一部の小型モデル（Qwen 1.5B / Gemma 2B等）は、`tool_calls` を正しく出力せず、応答テキストに `search_documents(query='...')` と書いてしまうことがある。フロント側で正規表現検出して実ツール呼び出しに変換:

```javascript
const textCallMatch = assistantMsg.content.match(
  /(search_documents|web_search|read_file|list_files|write_file)\s*\(\s*([^)]*)\)/
);
if (textCallMatch) {
  const fname = textCallMatch[1];
  const argsStr = textCallMatch[2];
  // query='...' / path='...' を抽出して fakeCall を構築
  const fakeCall = { function: { name: fname, arguments: {...} } };
  assistantMsg.tool_calls = [fakeCall];
  assistantMsg.content = '';  // テキスト応答は破棄
}
```

### 動的コンテキスト調整

ユーザー入力に「ファイル書き出し系キーワード」があるかで `max_tokens`（OpenAI互換、Ollamaでの`num_predict`相当）を切り替え:

- **短文モード**: smallPredict=512（通常質問用、ツール判断時にも使用）
- **長文モード**: largePredict=8192（ファイル生成時）

`num_ctx`（コンテキスト長）はllama-serverの起動時に固定（`chatModels[].ctx`）されるため、リクエスト時には変えられません。

キーワードは `appConfig.agentContext.largeGenKeywords` で上書き可。

---

## 💾 RAG (Retrieval Augmented Generation)

### Embedding

- モデル: `config.embeddingModel.path`（デフォルト推奨: `mxbai-embed-large-v1`）
- 次元: モデル依存（mxbai=1024, nomic=768）
- 別ポート(`embeddingPort`、デフォルト8081)でllama-serverを起動、チャットと並列動作
- フロントから OpenAI互換 `/v1/embeddings` で取得（`/embed/v1/embeddings` プロキシ経由）

### チャンク化

```javascript
function chunkText(text, size = 500, overlap = 100) {
  // 500文字ずつ、100文字オーバーラップで分割
}
```

### 類似度検索

```javascript
cosineSimilarity(a, b) = dot(a,b) / (norm(a) * norm(b))
```

ragTopK 件（デフォルト10）を取得してプロンプトに注入、またはツール結果として返却。

### モデル選択から除外

Embeddingモデルはチャット用途で使えないので、以下パターンに該当するモデルをチャット選択ドロップダウンから自動除外:

```javascript
const embedPatterns = /embed|embedding|nomic-embed|mxbai-embed|bge-|e5-|gte-/i;
const names = allNames.filter(n =>
  n.toLowerCase() !== config.embedModel.toLowerCase() && !embedPatterns.test(n)
);
```

---

## 🔌 OpenAI互換 API プロキシ

llama-serverは OpenAI と同じ `/v1/chat/completions`, `/v1/embeddings` 等を提供する。OpenGeekLLMChatのフロントは認証を経由する必要があるため、Node.js側でリバースプロキシ:

```javascript
function proxyToLlama(targetHost, targetPort, pathPrefix) {
  return (req, res) => {
    const options = {
      hostname: targetHost,
      port: targetPort,
      path: pathPrefix + req.url,
      method: req.method,
      headers: { ... },
    };
    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res, { end: true });  // ストリームをそのまま転送
    });
    req.pipe(proxyReq, { end: true });    // bodyもストリーム転送
  };
}

app.use('/v1', requireAuth, proxyToLlama('127.0.0.1', 8080, '/v1'));
app.use('/embed/v1', requireAuth, proxyToLlama('127.0.0.1', 8081, '/v1'));
```

### Ollama → OpenAI互換 リクエスト変換

```javascript
// Before (Ollama)
fetch('/api/chat', {
  body: JSON.stringify({
    model, messages, tools, stream: true, think: false,
    options: { num_ctx, num_predict, temperature, top_k, top_p }
  })
});

// After (llama-server OpenAI互換)
fetch('/v1/chat/completions', {
  body: JSON.stringify({
    model, messages, tools, stream: true,
    stream_options: { include_usage: true },  // usage情報を流れに含める
    max_tokens: num_predict,
    temperature, top_k, top_p,
    cache_prompt: true,  // llama.cpp拡張: プロンプトキャッシュ
  })
});
```

### レスポンス形式の違い

```javascript
// Ollama (NDJSON, \n区切り)
{"message":{"content":"こんにちは"},"done":false}
{"message":{"content":"！"},"done":false}
{"done":true,"eval_count":5,"eval_duration":123456789,"prompt_eval_count":20}

// OpenAI互換 (SSE, data:プレフィックス + \n\n区切り)
data: {"choices":[{"delta":{"content":"こんにちは"}}]}

data: {"choices":[{"delta":{"content":"！"}}]}

data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":20,"completion_tokens":5}}

data: [DONE]
```

### thinking の扱い

Ollama: `delta.thinking` フィールド
OpenAI互換 (DeepSeek/QwQ系): `delta.reasoning_content` フィールド
Gemma3等: `<think>...</think>` タグでcontent内に埋め込まれる

フロント側で3パターンとも対応:

```javascript
if (delta.reasoning_content) assistantThinking += delta.reasoning_content;
if (delta.content) assistantContent += delta.content;

// <think>タグフォールバック
const thinkMatch = assistantContent.match(/^<think>([\s\S]*?)(<\/think>)?([\s\S]*)$/);
if (thinkMatch) {
  displayThinking = (assistantThinking + thinkMatch[1]).trim();
  displayContent = thinkMatch[2] ? thinkMatch[3].trim() : '';
}
```

---

## 🔧 llama-server プロセス管理

OpenGeekLLMChatは `llama-server` バイナリを **子プロセスとして起動・管理** する。Ollamaのような専用デーモンがいない構成。

### プロセス構造

```
opengeek-llm-chat (Node.js, port 3000)
  ├── llama-server (chat, port 8080) ← spawn
  └── llama-server (embedding, port 8081) ← spawn
```

両プロセスとも `spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })` で起動。stdout/stderrはNode.js経由で共通ログに統合される。

### 起動シーケンス

```javascript
// 1. server.listen() 後、起動時に2つを並列spawn
server.listen(PORT, async () => {
  await updateGpuData();
  startEmbeddingModel().catch(e => log('-', `Embedding起動エラー: ${e.message}`));
  if (chatModels.length > 0) {
    const initialModel = appConfig.defaultModel || chatModels[0].name;
    startChatModel(initialModel).catch(e => log('-', `初期モデル起動エラー: ${e.message}`));
  }
});
```

### ready判定

llama-serverは `/health` エンドポイントを提供する。1秒間隔でポーリングして `200 OK` が返ったらreadyとみなす:

```javascript
function waitForReady(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const req = http.request({ hostname: host, port, path: '/health' }, (res) => {
        if (res.statusCode === 200) return resolve(true);
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(check, 1000);
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(check, 1000);
      });
      req.end();
    };
    check();
  });
}
```

### モデル切替

`POST /models/load { name }` → 現在のチャットプロセスをkill → 新モデルでspawn → readyを待つ:

```javascript
async function startChatModel(modelName) {
  if (chatProcStarting) throw new Error('既にモデル起動処理中です');
  chatProcStarting = true;
  try {
    await stopChatModel();  // SIGTERM → 5秒タイムアウトでSIGKILL
    chatProc = spawnLlamaServer(args, `chat:${model.name}`);
    chatProcModel = model.name;
    const ready = await waitForReady(host, port, readyTimeoutMs);
    if (!ready) {
      await stopChatModel();
      throw new Error(`チャットモデル起動タイムアウト`);
    }
  } finally {
    chatProcStarting = false;
  }
}
```

### 引数フィルタリング

`commonArgs` に `--port` や `--host` がユーザー設定で含まれていても、llama-serverに渡す前に**ペアごと除外**する:

```javascript
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

// 使用例
const args = [
  '--port', String(ls.chatPort),
  '--host', ls.chatHost,
  ...filterPairArgs(ls.commonArgs || [], ['--port', '--host']),
];
```

理由: `args.filter(a => a !== '--port')` だと `--port` だけ消えて値だけが孤立し、`error: invalid argument: 8080` になる。

### クリーンアップ

```javascript
function cleanup() {
  if (chatProc) try { chatProc.kill('SIGTERM'); } catch {}
  if (embedProc) try { embedProc.kill('SIGTERM'); } catch {}
}
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);
```

systemd経由で `systemctl stop` した時もクリーンに終了する。

### モデル管理API

| Method | Path | 説明 |
|:--|:--|:--|
| GET | /models | `{ models: [{name, ctx, ngl, loaded}, ...], current, starting, embeddingReady, autoUnloaded, idleUnloadMs }` |
| POST | /models/load | `{ name }` で指定モデルをロード（再起動）。自動アンロード状態をクリア |
| POST | /models/unload | 現在のチャットモデルをアンロード（停止） |

UIはモデル選択ドロップダウン変更時に `/models` で current を確認し、変更が必要なときだけ `/models/load` を呼ぶ。各モデル名の横に `(8,192)` 形式でctxを併記表示。

### オンデマンドモデルロード（起動時はロードしない）

サーバー起動時にはチャットモデル/Embeddingモデルをロードしない設計。VRAM空き状態で起動し、初回リクエスト時に自動ロード。

```javascript
// server.js 起動時
if (chatModels.length > 0) {
  let initialModel = null;
  // settings.json から前回モデル取得
  if (fs.existsSync(SETTINGS_FILE)) {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    if (settings.chatModel && findModelByName(settings.chatModel)) {
      initialModel = settings.chatModel;
    }
  }
  if (!initialModel) initialModel = appConfig.defaultModel || chatModels[0].name;
  // 起動はせず、autoUnloaded として記録 → 初回リクエスト時に自動ロード
  chatProcAutoUnloaded = initialModel;
  log('-', `初期モデル: ${initialModel}（最初のリクエスト時にロード）`);
}
log('-', 'Embeddingモデル: 最初のリクエスト時にロード');
```

優先順位: settings.json (`chatModel`) → config.json (`defaultModel`) → `chatModels[0]`

`/models` レスポンスに `firstLoadPending: true` を追加し、フロントで「初回ロード待ち」と「アイドル復帰」を区別。

### モデル自動アンロード（idleUnloadMs）

`llamaServer.idleUnloadMs > 0` の場合、最終使用時刻から指定ms経過したチャットモデル/Embeddingモデルを自動的にアンロード（VRAM解放）。次回リクエスト時に自動再ロード。

```javascript
// 30秒間隔でチェック
setInterval(async () => {
  const ls = appConfig.llamaServer;
  if (!ls.idleUnloadMs || ls.idleUnloadMs <= 0) return;
  // チャットモデル
  if (chatProc && !chatProcStarting && chatLastUsed) {
    const idleMs = Date.now() - chatLastUsed;
    if (idleMs >= ls.idleUnloadMs) {
      chatProcAutoUnloaded = chatProcModel;
      await stopChatModel();
    }
  }
  // Embeddingモデル（同じidleUnloadMs使用）
  if (embedProc && !embedProcStarting && embedLastUsed) {
    const idleMs = Date.now() - embedLastUsed;
    if (idleMs >= ls.idleUnloadMs) {
      await stopEmbeddingModel();
    }
  }
}, 30000);
```

### アイドル復帰の自動継続（フロント側）

アイドルアンロード状態でユーザーがチャット送信した場合、フロント側でロード完了をポーリング待機してから送信処理を続行:

```javascript
// sendMessage() 内、送信直前
const mres = await fetch('/models');
const mdata = await mres.json();
if (!mdata.current || mdata.starting || mdata.autoUnloaded) {
  // ダミーpingで再ロード開始トリガー
  if (mdata.autoUnloaded) {
    fetch('/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: chatModel, messages: [{role:'user',content:'ping'}], max_tokens: 1, stream: false })
    }).catch(() => {});
  }
  // 最大2分まで2秒間隔でポーリング待機
  const startWait = Date.now();
  while (Date.now() - startWait < 120000) {
    await new Promise(r => setTimeout(r, 2000));
    const pres = await fetch('/models');
    const pdata = await pres.json();
    if (pdata.current && !pdata.starting && !pdata.autoUnloaded) break;
  }
  // ロード完了後、そのまま送信処理を続行
}
```

ユーザーは送信ボタンを再度押す必要なし（自動的に処理が続く）。

### Embeddingプロキシのアイドル復帰

`/embed/v1/*` プロキシでもEmbedding未起動を検知して自動ロードを待機:

```javascript
// proxyToLlama() 内
if (!isChatProxy) {
  // Embeddingプロキシ
  if (!embedProc) {
    const ready = await ensureEmbeddingLoaded();  // 起動完了まで待機
    if (!ready) return res.status(503).json({...});
  }
  embedLastUsed = Date.now();
}
```

ドキュメントD&D時、Embedding未起動なら数秒待機してから処理。

### 生成中のモデル切替防止

生成中（`isLoading === true`）はUI側でモデル選択ドロップダウンを `disabled={isLoading}` にし、🔒アイコンとツールチップを表示。useEffectの依存配列にも `isLoading` を含め、生成中のロード処理発火を防ぐ:

```javascript
useEffect(() => {
  if (!settingsLoadedRef.current) return;
  if (!chatModel) return;
  if (isLoading) return;  // 生成中はモデル切替しない
  // ...
}, [chatModel, isLoading]);
```

生成中に切替を試みても、UIで物理的にブロックされる + ロジックでも二重ガード。

### モデル状態のUI表示

フロント側のモデル状態管理:

| state | 意味 | UI |
|:--|:--|:--|
| `modelReady = true` | チャット可能 | 通常 |
| `modelStarting = true` | 実際にllama-server起動処理中 | 🟠トースト「再ロード中」 |
| `autoUnloadedName != null && !modelStarting` | アイドルアンロード状態（次回送信時にロード） | トースト無し、送信ボタン有効 |
| `firstLoadPending = true` | 起動後初回ロード待ち | トースト無し、送信ボタン有効 |

ポーリングは2系統:
- 高頻度(3秒): 接続不良 or `modelStarting=true` のとき
- 低頻度(15秒): 通常時の状態変化検出

---

## 🔇 ログレベル制御 (logLevel)

config.jsonの `logLevel` で運用ログを抑制:

| 設定 | spawn時のstdio | プロキシログ |
|:--|:--|:--|
| `"normal"` | `['ignore', 'pipe', 'pipe']` で全ログを表示 | 各リクエストで2行（in/out）出力 |
| `"quiet"` | `['ignore', 'ignore', 'ignore']` で完全破棄 | 抑制（503や502/504エラーのみ表示） |

```javascript
function spawnLlamaServer(args, label) {
  const isQuiet = appConfig.logLevel === 'quiet';
  const proc = spawn(ls.binPath, args, {
    stdio: isQuiet ? ['ignore', 'ignore', 'ignore'] : ['ignore', 'pipe', 'pipe'],
  });
  if (!isQuiet) {
    proc.stdout.on('data', (d) => process.stdout.write(`[${label}] ${d}`));
    proc.stderr.on('data', (d) => process.stderr.write(`[${label}] ${d}`));
  }
  // exit ログだけは常に出す
  proc.on('exit', (code) => log('-', `[${label}] exited with code ${code}`));
}
```

quietモードで残るログ:
- 起動バナー（ASCII art）
- `[label] spawn: ...`（コマンド確認用）
- プロセス終了通知
- 認証成功/失敗、Web検索、Python実行
- 502/503/504/タイムアウトなどのエラー

本番運用では `"quiet"` 推奨。デバッグ時は `"normal"` に戻して再起動。

---

## ⚡ マルチGPU構成（テンソル並列）

### llama.cpp の GPU割当

llama.cppはビルド時にCUDA / ROCm / Metal / Vulkanのバックエンドを選択し、起動時の `--device` オプションで使用するGPUを指定します。

```
config.json:
  "llamaServer": {
    "commonArgs": ["-fa", "on", "--device", "ROCm0,ROCm1"]
  }
```

### モデルとGPUの紐付け

- **`commonArgs`**: 全モデル共通（GPU指定、Flash Attention、量子化キャッシュ等）
- **`chatModels[].extraArgs`**: モデル毎に追加（大型モデルだけ複数GPU分散など）
- **`embeddingModel.extraArgs`**: 軽量Embeddingは1枚で十分

### モデル切替

`POST /models/load { name }` で別モデルに切替。サーバー側で:

1. 現在のチャットllama-serverプロセスをkill (`SIGTERM`)
2. 5秒待っても終了しなければ `SIGKILL`
3. 新しいモデルで再spawn
4. `/health` を1秒ポーリングして `ready` 待ち（最大120秒）
5. 完了後、フロントにレスポンス

切替中は `/v1/*` プロキシが502を返すため、フロントは10〜30秒待機UIを表示する。

### GPU監視

- `rocm-smi --json` または `nvidia-smi --query-gpu=...` を1秒間隔で実行
- 結果をキャッシュし、`/sse/gpu` で全クライアントにSSE配信
- 取得失敗時は前回キャッシュを保持してUIをちらつかせない

```javascript
let cachedGpuData = [];
async function updateGpuData() {
  if (gpuUpdating) return;
  gpuUpdating = true;
  try { cachedGpuData = await queryGpu(); } finally { gpuUpdating = false; }
}
setInterval(updateGpuData, GPU_INTERVAL);
```

---

## 🔊 音声入出力

### 音声入力 (Web Speech API)

```javascript
const recognition = new SpeechRecognition();
recognition.lang = 'ja-JP';
recognition.continuous = true;       // 止めるまで認識継続
recognition.interimResults = true;   // 中間結果取得

// 3秒無音で自動送信
const resetSilenceTimer = () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    recognition.abort();
    if (hasText) sendMessageRef.current();  // 自動送信
  }, 3000);
};
```

- HTTPSまたはlocalhostでのみ動作（Secure Context必須）
- Chrome/Edge対応（Firefoxは非対応）
- 送信時に `stopRecording()` 自動呼び出し

### 音声出力 (SpeechSynthesis)

```javascript
function toggleSpeak(content, idx) {
  if (speakingIndex === idx) { cancel(); return; }
  cancel();  // 別メッセージを読み上げ中なら止める
  const text = stripMarkdownForSpeech(content);  // Markdown記号除去
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'ja-JP';
  utter.voice = findJapaneseVoice();
  speak(utter);
}
```

#### 停止トリガー
- 別メッセージの読み上げボタン押下
- 新規チャット作成
- チャット履歴切替
- ページ離脱（cleanup）

---

## 🐍 Python 実行システム

### WebSocketプロトコル

```
Client → Server:
  { type: 'run', code: '...' }           // 実行開始
  { type: 'stdin', data: '...' }         // 標準入力
  { type: 'stop' }                       // 強制終了

Server → Client:
  { type: 'stdout', data: '...' }        // 標準出力
  { type: 'stderr', data: '...' }        // エラー出力
  { type: 'image', filename: '...' }     // 画像（matplotlib等）
  { type: 'exit', exitCode: N }          // 終了
```

### 作業ディレクトリ

`public/uploads/` をcwdに設定。LLMのファイル操作ツール（read_file/write_file）と統一。

### matplotlib 自動対応 Preamble

ユーザー/LLMコードの前に以下を自動注入:

```python
import matplotlib
matplotlib.use('Agg')  # GUIバックエンド無効

# 日本語フォント自動選択
candidates = ['IPAexGothic', 'Noto Sans CJK JP', 'Hiragino Sans', ...]
matplotlib.rcParams['font.family'] = first_available(candidates)

# plt.show() → public/plots/ に保存（uploadsとは分離）
def _auto_show():
    fname = f"plot_{run_id}_{n}.png"
    full_path = os.path.join(_PLOTS_DIR, fname)  # public/plots/
    _orig_savefig(full_path)
    print(f"__OGC_IMAGE__:plots/{fname}")  # server.js が検出
    plt.close('all')

# plt.savefig('myfile.png') → ユーザー指定パス（uploads配下）はそのまま尊重
def _auto_savefig(fname, *a, **kw):
    _orig_savefig(fname, *a, **kw)
    print(f"__OGC_IMAGE__:{os.path.basename(fname)}")

plt.show = _auto_show
plt.savefig = _auto_savefig
```

**plotsとuploadsの使い分け:**
- `plt.show()` で自動生成された画像 → `public/plots/` 配下（list_filesから見えない）
- `plt.savefig('result.png')` で明示保存された画像 → `public/uploads/` 配下（LLMが認識可能）
- これによりLLMが list_files したときに大量のプロット画像が出てこない

### 画像マーカー検出

```javascript
// server.js: stdoutから __OGC_IMAGE__:filename.png を検出
const m = line.match(/^__OGC_IMAGE__:(.+)$/);
if (m) ws.send({ type: 'image', filename: m[1] });
```

クライアント側では `filename` のプレフィックスで配信パスを切り替え:
- `plots/xxx.png` → `/plots/xxx.png`（認証付き専用エンドポイント）
- `xxx.png` → `/files/xxx.png`（uploads配下）

### `/plots/*` エンドポイント

```javascript
// 認証付き、パストラバーサル対策済み
app.get('/plots/*', requireAuth, (req, res) => {
  const abs = path.resolve(PLOTS_DIR, req.params[0]);
  if (!abs.startsWith(PLOTS_DIR)) return res.status(400).json(...);
  res.setHeader('Content-Type', mimes[ext]);
  fs.createReadStream(abs).pipe(res);
});
// express.staticから /plots/ を除外する必要あり
app.use((req, res, next) => {
  if (req.path.startsWith('/plots/')) return next();
  express.static(...)(req, res, next);
});
```

### DuckDB によるSQL処理

LLMには以下の使い方を案内している:

```python
import duckdb
con = duckdb.connect()

# CSVを直接クエリ
df = con.execute("SELECT region, SUM(amount) FROM 'sales.csv' GROUP BY region").df()

# Parquetも同様
df = con.execute("SELECT * FROM 'logs.parquet' WHERE level='ERROR'").df()

# pandasのDataFrameもテーブル参照可能
con.execute("SELECT * FROM df WHERE value > 100").df()
```

pandasのread_csv→集計→matplotlibのフローよりも、数百万行のデータで明確に高速。メモリ使用量も少ない。LLMに対しては、データ量が多そうなときや複雑な集計時にDuckDBを推奨するよう案内している。

### 画像をチャットに添付するボタン

実行結果エリアの画像下に「📎 チャットに添付」ボタンを表示。

```javascript
window.attachImageToChat = async (filename) => {
  const url = filename.startsWith('plots/') ? '/' + filename : '/files/' + filename;
  const blob = await (await fetch(url)).blob();
  const dataUrl = await blobToDataUrl(blob);
  setChatImagesRef.current(prev => [...prev, { name, base64, preview: dataUrl }]);
};
```

vanilla JSのターミナルUIから React state にアクセスするため、`setChatImagesRef` で setState関数を保持。Vision対応モデル（gemma3, llava等）に画像を渡して分析させる用途。

### セキュリティ

- 実行タイムアウト: `PYTHON_TIMEOUT` (デフォルト60秒)
- SIGTERM による強制終了
- 一時ファイルは `/tmp/opengeek_<runId>.py`、終了後即削除

---

## 🌐 Web検索 (DuckDuckGo)

### エンドポイント

```
GET /web-search?q=<query>&n=5&fetch=1&bodyCount=2500
```

- `q`: クエリ
- `n`: 取得件数（デフォルト5）
- `fetch=1`: 上位3件の本文も取得
- `bodyCount`: 本文切り詰め文字数

### 処理フロー

```
1. https://html.duckduckgo.com/html/?q=<query>&kl=jp-jp にPOST
2. HTMLから .result__a / .result__snippet 等を2段階パーサーで抽出
3. 上位3件のURLを順次 web_fetch でHTML取得
4. main > article > bodyの順でメインコンテンツ抽出
5. HTMLタグ除去 → 2500文字で切り詰め
```

### なぜ`/v1/*` プロキシの外に置くか

`/v1/*` は llama-server用のリバースプロキシで、リクエストボディを `req.pipe(proxyReq)` でストリーム転送する都合上 `express.json()` 未使用。Web検索やファイル操作はllama-serverと無関係なので別パスにする必要がある。

---

## 🖼️ ファイル操作 API

### `safeUploadPath(path)`

パストラバーサル対策:

```javascript
function safeUploadPath(rel) {
  // uploads/ プレフィックスの除去
  rel = rel.replace(/^uploads\//, '');
  // 正規化 + uploads配下かチェック
  const abs = path.resolve(UPLOADS_DIR, rel);
  if (!abs.startsWith(UPLOADS_DIR)) return null;
  return abs;
}
```

### バイナリ配信

拡張子で判定し、画像/PDF/動画/音声は直接配信:

```javascript
const binaryExts = {
  '.png': 'image/png', '.jpg': 'image/jpeg', ...
};
if (binaryExts[ext]) {
  res.setHeader('Content-Type', binaryExts[ext]);
  fs.createReadStream(abs).pipe(res);
}
```

テキストファイルはJSON形式で返却（従来互換）:
```json
{ "path": "hello.py", "size": 123, "content": "...", "modified": "..." }
```

---

## 📜 自動スクロール

ストリーミング中、下端に追従しつつ、ユーザーが上にスクロールしたら自動追従停止:

### 検出方法（多重化）

```javascript
// 1. wheel イベント (document level)
onWheel: if (deltaY < 0) autoScrollRef = false;

// 2. touchmove (モバイル)
onTouchMove: if (fingerGoingDown) autoScrollRef = false;

// 3. keydown (ArrowUp, PageUp, Home)
onKeyDown: autoScrollRef = false;

// 4. rAF で差分チェック（フォールバック）
if (el.scrollTop < lastProgScroll - 30) autoScrollRef = false;
```

### 自動追従再開

- 下端まで戻ったら再開
- 新しいメッセージ送信時にリセット (`autoScrollRef = true`)

### プログラムスクロールの判別

`lastProgScrollRef` に自動スクロール位置を記録し、現在位置と比較することでユーザー操作を検出。

---

## 🔒 HTTPS

### 証明書配置の検出

```javascript
const HTTPS_ENABLED = fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH);
if (HTTPS_ENABLED) {
  server = https.createServer({ cert, key, passphrase }, app);
} else {
  server = http.createServer(app);
}
```

### パスフレーズ対応

```javascript
const passphrase = process.env.SSL_PASSPHRASE || appConfig.sslPassphrase;
if (passphrase) sslOptions.passphrase = passphrase;
```

### 自己署名証明書生成 (`generate-cert.sh`)

複数ホスト/IP対応:
```bash
./generate-cert.sh localhost 192.168.1.100 my-server.example.com
```

SAN (Subject Alternative Name) に全ホストを含めて生成。

### リバースプロキシ対応

nginx経由の場合、Node.js側はHTTPで動作。`X-Forwarded-Proto` ヘッダーでHTTPS判定:

```javascript
app.set('trust proxy', 'loopback');
const isSecure = HTTPS_ENABLED || req.headers['x-forwarded-proto'] === 'https';
```

---

## 🚀 起動と systemd

### `process.chdir(__dirname)`

systemd経由で起動するとデフォルトcwdが `/` になるため、server.js先頭で明示的に移動:

```javascript
const { WebSocketServer } = require('ws');
process.chdir(__dirname);  // cwd を server.js と同じ場所に固定
```

ただし、主要パスは既に `path.join(__dirname, ...)` で絶対パス化済み。このchdirは保険。

### systemd ユニットファイル

`opengeek-llm-chat.service` がテンプレートとして同梱。`WorkingDirectory` と `ExecStart` を環境に合わせて編集。

---

## 🔄 思考中断からの復旧 / ループ検出

### 思考ループ自動検出

ストリーミング中、思考+応答の末尾を **100文字ウィンドウ** でハッシュ化し、同じ内容が **3回以上出現** したらループとして自動検出:

```javascript
const seenChunks = new Map();
const LOOP_CHUNK_SIZE = 100;
const LOOP_THRESHOLD = 3;

// 100文字単位でカウント
const chunkText = fullText.slice(-LOOP_CHUNK_SIZE).replace(/\s+/g, ' ').trim();
const count = (seenChunks.get(chunkText) || 0) + 1;
seenChunks.set(chunkText, count);
if (count >= LOOP_THRESHOLD) {
  loopDetected = true;
  abortRef.current.abort();  // 即停止
}
```

検出時はメッセージに `loopDetected: true` フラグをセットし、UIに「⚠️ 思考ループを中断・回答を要求」ボタンを表示する。

### 「続きを生成」ボタン

Thinkingモデルが応答途中で停止・ループした場合の対策:

```javascript
function continueGeneration(idx) {
  // 履歴 + 途中までの思考/応答を assistant メッセージとして追加
  const partial = [thinking ? `<think>${thinking}</think>` : '', content].join('\n');
  const nudge = [
    { role: 'assistant', content: partial },
    { role: 'user', content: '思考が途中で止まっています。続きから応答を完成させてください。' }
  ];
  // 新規応答をストリーミングで取得し、既存メッセージに追記
}
```

### 表示条件

- メッセージが会話の最後
- かつ `thinking` があるか `content` が空
- ストリーミング中（isLoading）でない

`loopDetected: true` のメッセージでは、ボタンラベルが「⚠️ 思考ループを中断・回答を要求」に変わる。

### 生成停止

llama-serverは Ollamaの `keep_alive` のような概念を持たないが、HTTPストリーム切断で確実に生成を中断できる:

```javascript
function stopGeneration() {
  abortRef.current.abort();  // HTTPストリーム切断
  // llama-serverはストリーム切断を検知し、生成中のスロットを解放する
  setIsLoading(false);
}
```

llama-serverは内部的にスロット (`n_parallel`) で並列推論を管理しており、HTTP切断でそのスロットがアイドル状態に戻る。GPU使用率は次のサンプリングで反映され、即座にゼロ近くまで下がる。Ollama版のような「モデル再ロード時間」は発生しない。

### ThinkingBlock の isStreaming 判定

```javascript
// 続きを生成中も「思考中」ランプを点灯させるため、
// !msg.content の条件は外している
isStreaming={isLoading && i === messages.length - 1}
```

---

## ⚙️ 主要設定一覧

| キー | 型 | デフォルト | 説明 |
|:--|:--|:--|:--|
| `appName` | string | "OpenGeekLLMChat" | 表示名 |
| `defaultModel` | string | "" | 初期モデル名（chatModelsの`name`） |
| `password` | string | "" | MD5/SHA-256ハッシュ |
| `pythonPath` | string | "python3" | Python実行コマンド |
| `sslPassphrase` | string | "" | 秘密鍵パスフレーズ |
| `llamaServer.binPath` | string | "/usr/local/bin/llama-server" | llama-serverバイナリのパス |
| `llamaServer.chatPort` | number | 8080 | チャット推論用ポート |
| `llamaServer.embeddingPort` | number | 8081 | Embedding用ポート |
| `llamaServer.commonArgs` | array | ["-fa", "on"] | 全モデル共通の起動引数 |
| `llamaServer.readyTimeoutMs` | number | 120000 | 起動完了待ち上限 |
| `chatModels[]` | array | [] | チャットモデル一覧（必須） |
| `chatModels[].name` | string | - | UIに表示する名前 |
| `chatModels[].path` | string | - | GGUFファイルパス |
| `chatModels[].ctx` | number | 4096 | コンテキスト長（起動時固定） |
| `chatModels[].ngl` | number | 99 | GPUレイヤー数 |
| `chatModels[].extraArgs` | array | [] | このモデル専用追加引数（`--mmproj`によるVision等） |
| `embeddingModel.path` | string | - | Embedding用GGUF（任意） |
| `embeddingModel.poolingType` | string | - | mean/cls/last/none |
| `embeddingModel.extraArgs` | array | [] | Embedding用追加引数（GPU指定など） |
| `webSearch` | bool | true | Web検索 |
| `fileAccess` | bool | true | ファイル操作 |
| `ragTopK` | number | 10 | RAG検索件数 |
| `ragMode` | string | "agentic" | agentic / always |
| `agentContext.smallPredict` | number | 512 | ツール判断時のmax_tokens（短文モード） |
| `agentContext.largePredict` | number | 8192 | ツール判断時のmax_tokens（長文モード）+ continueGen時 |
| `agentContext.judgeHistoryCount` | number | 3 | ツール判断時の履歴件数 |
| `agentContext.largeGenKeywords` | array | null | 長文モードトリガーワード（null=デフォルト使用） |
| `logLevel` | string | "normal" | "normal"/"quiet"。quietでllama-server stdout/stderrとプロキシログを抑制 |
| `llamaServer.idleUnloadMs` | number | 0 | アイドル時の自動アンロード時間（ms、0で無効、推奨600000=10分） |
| `systemPrompts.base` | string | (デフォルトプロンプト) | ベース指示文（{date}展開） |
| `systemPrompts.documents` | string | (同上) | ドキュメント添付時追記（{docList}展開） |
| `systemPrompts.webSearch` | string | (同上) | Web検索案内 |
| `systemPrompts.fileAccess` | string | (同上) | サーバーファイル操作案内 |
| `systemPrompts.python` | string | (同上) | Python実行案内 |
| `systemPrompts.meta` | string | (同上) | メタ抑制指示 |
| `systemPrompts.judge` | string | (同上) | ツール判断用プロンプト（{toolList}展開） |

---

## 🎨 システムプロンプトのカスタマイズ

`config.json` の `systemPrompts` で全プロンプトを上書き可能。`loadConfig()` で **深いマージ** されるため、`systemPrompts` 内の特定キーだけを上書きしたい場合も部分的に書ける:

```javascript
function loadConfig() {
  const merged = { ...DEFAULT_CONFIG, ...userConfig };
  ['systemPrompts', 'agentContext', 'transcribe'].forEach(key => {
    if (DEFAULT_CONFIG[key] && typeof DEFAULT_CONFIG[key] === 'object') {
      merged[key] = { ...DEFAULT_CONFIG[key], ...(userConfig[key] || {}) };
    }
  });
  return merged;
}
```

### テンプレート変数

フロント側で `fillTemplate(str, vars)` を使って展開する `{varname}` 形式の変数:

| 変数 | 展開タイミング | 値 |
|:--|:--|:--|
| `{date}` | `base` プロンプト | "2026年4月25日" 形式 |
| `{docList}` | `documents` プロンプト | "file1.csv, file2.pdf" |
| `{toolList}` | `judge` プロンプト | 動的生成された箇条書きのツール一覧 |

### 組み立てロジック（フロント側）

```javascript
const sp = appConfig.systemPrompts || {};
const fillTemplate = (str, vars) =>
  (str || '').replace(/\{(\w+)\}/g, (_, k) => vars[k] != null ? vars[k] : '');

let agentSystem = fillTemplate(sp.base, { date: dateStr });
if (documents.length > 0 && sp.documents) {
  agentSystem += '\n\n' + fillTemplate(sp.documents, { docList });
}
if (appConfig.webSearch && sp.webSearch) agentSystem += '\n\n' + sp.webSearch;
if (appConfig.fileAccess && sp.fileAccess) agentSystem += '\n\n' + sp.fileAccess;
if (sp.python) agentSystem += '\n\n' + sp.python;
if (sp.meta) agentSystem += '\n\n' + sp.meta;
```

ドキュメントなし、Web検索OFF、ファイルアクセスOFFのときは、対応する追記がスキップされる。

### `judge` プロンプトの `{toolList}` 動的構築

```javascript
const toolListLines = [];
if (documents.length > 0) toolListLines.push('- search_documents: ...');
if (appConfig.webSearch) toolListLines.push('- web_search: ...');
if (appConfig.fileAccess) toolListLines.push('- list_files/read_file/write_file: ...');
const judgeSystem = fillTemplate(sp.judge, { toolList: toolListLines.join('\n') });
```

これにより、無効化された機能のツール案内を出さない（LLMが存在しないツールを呼ばないように）。

---

## 📐 履歴の重み付け（直近優先）

長い会話で「最新質問に集中させる」ためのプロンプト整形:

```
[system] あなたは親切なアシスタント...                  ← ベースsystem
[system] 【参考: 過去の会話履歴 (4件)】                  ← 古いメッセージは
        以下は背景情報です。最新の質問への回答に           圧縮要約として
        直接関連する場合のみ参照してください。              system扱い
        [ユーザー] こんにちは
        [アシスタント] こんにちは...
[user] CSVを処理したい                                   ← 直近6件は
[assistant] DuckDB を使うと...                            そのまま
[user] グラフにできる?
[assistant] matplotlibで...
[user] 【今この質問に回答してください】                   ← 最新質問は
       seabornでもできますか?                              強調マーカー
```

### 構築ロジック

```javascript
const RECENT_COUNT = appConfig.recentMessageCount || 6;
const recentSlice = allMessages.slice(-20);
const splitIdx = Math.max(0, recentSlice.length - RECENT_COUNT);
const oldMessages = recentSlice.slice(0, splitIdx);
const recentMessages = recentSlice.slice(splitIdx);

if (oldMessages.length > 0) {
  // 各500文字に圧縮、システムロールで「参考情報」として包む
  const summary = oldMessages.map(m => `[${role}] ${m.content.slice(0, 500)}`).join('\n\n');
  history.push({ role: 'system', content: `【参考: 過去の会話履歴】\n${summary}` });
}

recentMessages.forEach((m, i) => {
  const isLast = i === recentMessages.length - 1;
  const h = { role: m.role, content: m.content };
  if (isLast && m.role === 'user') {
    h.content = `【今この質問に回答してください】\n${m.content}`;
  }
  history.push(h);
});
```

### 効果

| 項目 | 効果 |
|:--|:--|
| 古い会話の引きずり防止 | 「参考情報」と明示することでLLMの注意度を下げる |
| 最新質問への集中 | マーカー追加で確実にフォーカス誘導 |
| コンテキスト圧迫軽減 | 古いメッセージは500文字に圧縮 |

`config.recentMessageCount` で調整可能（3〜20、デフォルト6）。

---

## 🌐 Web検索ON/OFFトグル

### 状態管理

`webSearchEnabled` Reactステートで管理。初期値は `appConfig.webSearch` を反映:

```javascript
const [webSearchEnabled, setWebSearchEnabled] = useState(true);

useEffect(() => {
  // /config 取得後、デフォルト値を反映
  setWebSearchEnabled(cfg.webSearch !== false);
}, []);
```

### 判定の二段構え

```javascript
const webSearchActive = appConfig.webSearch !== false && webSearchEnabled;
```

- `appConfig.webSearch === false` → トグル自体が表示されない（管理者が完全無効化）
- `appConfig.webSearch === true` + トグルON → 利用可能
- `appConfig.webSearch === true` + トグルOFF → 一時無効

### UI

`.toolbar-btn.web-search-toggle.active` でアクセントカラー強調、非active時は不透明度0.4。

---

## 🎭 LLMの役割設定（カスタムシステムプロンプト）

LLMに役割や指示を与えるカスタムプロンプト機能。`config.json` の固定プロンプトとは別に、ユーザーが各チャットごとに任意のプロンプトを追加できます。

### 設計思想

LLMは指示への追従性が高く訓練されているため、**システムプロンプトでの役割指定** は応答品質を最も大きく変える要素のひとつです。例えば：

| 役割 | 効果 |
|:--|:--|
| 「熟練のPythonエンジニア」 | コード品質UP、ベストプラクティス言及 |
| 「小学生向けに説明する先生」 | 専門用語回避、平易な例え話 |
| 「医療従事者向けの専門アドバイザー」 | 医学用語そのまま、根拠論文への言及 |
| 「JSON形式で回答」 | 構造化出力 |
| 「関西弁で答える」 | キャラクター付け |

特に Qwen3.6/Gemma4 等の instruct モデルは指示追従性が訓練されており、効果が顕著です。

### 状態管理

```javascript
const [chatRole, setChatRole] = useState('');           // 役割テキスト
const [showRoleEditor, setShowRoleEditor] = useState(false);  // 編集UI表示状態
```

### システムプロンプトへの組み込み

`agentSystem` の **最後** に追加することで最優先扱いに：

```javascript
// 構築順
agentSystem = sp.base + sp.documents + sp.webSearch + sp.fileAccess + sp.python + sp.meta;

// 最後にユーザー指定の役割を追加
if (chatRole && chatRole.trim()) {
  agentSystem += '\n\n【ユーザー指定の役割・指示】\n' + chatRole.trim();
}
```

LLMはシステムプロンプトの末尾を最もよく覚える傾向があるため、最後に置くのが正解です。

### UI設計の二段階

**新規チャット時（メッセージなし）**: ウェルカム画面内にインライン展開UI

```
[ウェルカム画面]
  タイトル
  説明
  ヒントチップ
  ─────────────────
  [🎭 LLMに役割を与える（任意）]  ← 折りたたみボタン
```

クリックで textarea 展開、確定すると設定済み表示に：

```
🎭 役割設定済み
あなたは熟練のPythonエンジニアです。コードレビューでは…
```

**メッセージ送信後**: ヘッダー右側の🎭アイコン + モーダル

```
[ヘッダー]
●Model | タイトル | 🎭

[🎭クリック → モーダル表示]
  ┌────────────────────┐
  │ 🎭 LLMの役割・指示  × │
  ├────────────────────┤
  │ [textarea]            │
  ├────────────────────┤
  │ [クリア]   [確定]      │
  └────────────────────┘
```

### モーダル背景の不透明化

モーダル背景は通常 `rgba(0,0,0,0.5)` だと裏が透けて読みにくいため、`backdrop-filter: blur(4px)` でぼかしを加え、モーダル本体は `var(--bg)` で完全不透明に:

```css
.role-modal-overlay {
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
.role-modal {
  background-color: var(--bg);
  opacity: 1;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}
```

`opacity: 1` を明示するのは、親要素の opacity を継承しないため。`backdrop-filter` は Safari 対応のため `-webkit-backdrop-filter` も併記。

### 永続化

```javascript
// 保存
saveChat() で role: chatRole も含めてJSONに

// 読み込み
loadChat() で setChatRole(data.role || '')

// クリア
newChat() で setChatRole('') / setShowRoleEditor(false)

// 継続チャット（RAG引き継ぎ）
chatRoleはリセットせず維持（役割は継続が自然）
```

### 動作フロー

```
[ユーザー]
  ↓ ウェルカム画面で「🎭 役割を与える」クリック
[役割エディタ展開]
  ↓ textareaに役割入力 → 確定
[chatRole stateにセット]
  ↓ メッセージ送信
[agentSystem構築]
  base + documents + webSearch + fileAccess + python + meta
  + 【ユーザー指定の役割・指示】← 末尾に追加
  ↓ LLMに送信
[役割に従った応答]
  ↓ saveChat() で role 含めて保存
[loadChat時]
  setChatRole(data.role) で復元
```

### 効果の例

```
[役割なし]
ユーザー: Pythonで素数を計算するコードを書いて
LLM: シンプルなエラトステネスの篩の実装...

[役割: "あなたは熟練のPythonエンジニアです。型ヒント・docstring・テストも含めてプロダクションレベルのコードを提示してください"]
ユーザー: Pythonで素数を計算するコードを書いて
LLM: 
```python
from typing import Iterator

def sieve_of_eratosthenes(limit: int) -> Iterator[int]:
    """エラトステネスの篩により素数を生成する。
    
    Args:
        limit: 上限値（含む）
    
    Yields:
        limit以下の素数
    """
    ...
```

### 留意点

- **chatRoleは長すぎないこと**: コンテキスト消費するため500文字以内推奨
- **モデルによる効果の差**: Qwen3.6 > Gemma4 > Gemma3 > Qwen2.5 0.5B（小さいモデルは指示追従性が低い）
- **継続チャットでの引き継ぎ**: RAGドキュメントとして要約された会話に加え、役割も維持されるため「過去の文脈+役割」を完全継続できる

---

## 🌐 外部APIサーバー公開（OpenAI互換）

OpenGeekLLMChat本体（Node.js）から、選択したモデルを **独立した llama-server プロセス** として外部公開する機能。

### アーキテクチャ

```
┌─ Node.js (OpenGeekLLMChat) ─────────────────┐
│                                              │
│ ┌─── 内部 llama-server (UI専用) ────────┐  │
│ │ 127.0.0.1:8080  (Chat)               │  │
│ │ 127.0.0.1:8081  (Embedding)          │  │
│ │ → アイドルアンロード対応              │  │
│ └────────────────────────────────────────┘  │
│                                              │
│ ┌─── 外部APIサーバー（複数起動可能）────┐  │
│ │ プロセス管理: Map<id, {proc, ...}>    │  │
│ │ - server 1: 0.0.0.0:11434 (Chat A)   │  │
│ │ - server 2: 0.0.0.0:11435 (Chat B)   │  │
│ │ → APIキー認証、HTTPS可、独立プロセス │  │
│ └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
     ↑              ↑
   UI(3000)     外部クライアント (curl, SDK等)
```

内部用と外部公開用を **別プロセス・別ポート** にすることで:
- UI側のチャットがアイドルアンロードしても外部APIは継続
- 外部APIの設定（モデル/ポート/HTTPS）を自由に変えられる
- 複数モデル同時公開可能

### サーバー側実装

#### プロセス管理データ構造

```javascript
const externalServers = new Map();  // id → { proc, modelName, host, port, apiKey, type, https, startedAt }
let nextExternalServerId = 1;
```

#### llama-server起動の差分

メイン用と違い、外部用は:
1. ポートが指定可能（衝突チェックあり）
2. `--api-key` 必須（自動生成 or 手動指定）
3. `--ssl-cert-file` `--ssl-key-file` を HTTPS有効時に追加
4. アイドルアンロード対象外

```javascript
const sslArgs = https && HTTPS_ENABLED
  ? ['--ssl-cert-file', CERT_PATH, '--ssl-key-file', KEY_PATH]
  : [];

const args = [
  '-m', model.path,
  '-c', String(model.ctx),
  '-ngl', String(model.ngl),
  '--port', String(port),
  '--host', host,
  ...filterPairArgs(ls.commonArgs || [], ['--port', '--host']),
  ...(apiKey ? ['--api-key', apiKey] : []),
  ...sslArgs,
  ...(model.extraArgs || []),
];
```

#### waitForReady の HTTPS対応

llama-serverのHTTPSモードで起動した場合、ヘルスチェックも HTTPS で行う必要があります:

```javascript
function waitForReady(host, port, timeoutMs, useHttps) {
  const mod = useHttps ? require('https') : http;
  const req = mod.request({
    hostname: host, port, path: '/health', method: 'GET',
    rejectUnauthorized: false,  // 自己署名証明書も受け入れる
  }, ...);
}
```

### REST API

| メソッド | パス | 説明 |
|:--|:--|:--|
| GET | `/external-servers` | 起動中サーバー一覧 |
| POST | `/external-servers` | 起動 (modelName, host, port, apiKey, type, https) |
| DELETE | `/external-servers/:id` | 停止 |
| GET | `/external-servers/https-available` | HTTPS利用可否（cert.pemの存在チェック） |

### UI設計

右パネルに第3タブ「🌐 API」を追加（GPU・ファイル と同列）。

```
┌─────────────────────────────┐
│ [GPU] [📁 ファイル(1)] [🌐 API] │
├─────────────────────────────┤
│ 外部APIサーバー起動           │
├─────────────────────────────┤
│ モデル: [Qwen3.6 35B-A3B ▼]  │
│ 公開範囲: [外部公開 0.0.0.0 ▼]│
│ ポート: 11434                 │
│ APIキー: [空欄で自動生成]      │
│ ☑ HTTPS で起動する           │
│ [🚀 起動]                    │
├─────────────────────────────┤
│ 起動中のサーバー (1)          │
├─────────────────────────────┤
│ ● 稼働中                  ✕   │
│ Qwen3.6 35B-A3B               │
│ URL: https://example.com:...  │
│      📋 [コピー]              │
│ Local: https://127.0.0.1:...  │
│ Key:  sk-xxxxxx...            │
│ 例: curl ...                  │
└─────────────────────────────┘
```

### URL表示のスマート化

`host=0.0.0.0` で起動した場合、サーバーは全インターフェースで待ち受けるため「どのIPで接続するか」をクライアントが選ぶ必要があります。UIでは **現在ブラウザがアクセスしているhostname** を表示することで、コピペでそのまま接続できるようにしました:

```javascript
const displayHost = (s.host === '0.0.0.0' || s.host === '::')
  ? window.location.hostname  // ブラウザでアクセス中のドメイン名
  : s.host;
const proto = s.https ? 'https' : 'http';
const externalUrl = `${proto}://${displayHost}:${s.port}/v1`;
```

ブラウザで `https://llm.wizapply.com:3000` にアクセス中なら、外部API URLは `https://llm.wizapply.com:11434/v1` と表示されます。

### HTTPSデフォルト値

ページがHTTPSアクセス中なら、HTTPSチェックボックスのデフォルトをONに:

```javascript
const [apiFormHttps, setApiFormHttps] = useState(
  typeof window !== 'undefined' && window.location.protocol === 'https:'
);
```

OpenGeekLLMChat全体をHTTPSで運用しているなら、外部APIも同じ証明書でHTTPS化するのが自然。

### ポート設計

- デフォルト: `11434`（Ollamaの標準ポート、既存ツールがそのまま使える）
- 衝突チェック: 内部用ポート（8080, 8081）、外部用ポート間
- 推奨: `11434`, `9000-9999` 等のユーザーレベルポート

### 永続化

`external-servers.json` に状態をディスク保存。ただし **プロセス自体は復元しません**（再起動後は手動で再起動）。実装簡単化のため、ファイルは現状ほぼログ的な役割。

### Embedding公開

サーバー側は Embedding にも対応していますが、UIでは Chat のみに絞っています（理由: Embeddingは普通内部用で十分、外部公開ニーズが低い、UI複雑化を避ける）。必要なら REST API 直叩きで `type=embedding` を渡せます。

### セキュリティ考慮

- **APIキー必須**: llama-server レベルで認証強制
- **自己署名証明書のリスク**: クライアント側で検証スキップ必要 → 正規証明書（Let's Encrypt）推奨
- **ファイアウォール**: ポート開放は OS 側で制御。`ufw allow 11434/tcp` 等
- **同時セッション**: llama-server自体が並行リクエスト処理可（`-np`, `--cont-batching`）

### 留意点

- 外部APIサーバーには **アイドルアンロード機能なし**: 起動したら手動で停止するまでVRAMを保持
- メインUI用 llama-server とは **独立プロセス**: 同じモデルでも別途VRAM消費
- 起動状態の **自動復元なし**: プロセス再起動後は再度UIで起動が必要
- **HTTPS起動には llama.cpp の SSL対応ビルドが必須** (`-DLLAMA_SERVER_SSL=ON`)。非対応ビルドだと llama-server は起動せず stderr に `the server is built without SSL support` を出力する。 Node.js 側の `waitForReady` は HTTPS でヘルスチェックしようとするためタイムアウトする
- **HTTPS/HTTPバッジ表示**: 起動済みサーバーのカードに `🔒 HTTPS` または `🔓 HTTP` のバッジを表示することで、UI上で実プロトコルが一目で分かるようにしている（フォームのチェック状態と起動済みサーバーの状態の混同を防ぐ）

---

## 🔗 共有可能なURL（チャットID反映）

各チャットセッションを `/chat/<id>` のURLで直接アクセスできるようにする機能。SPAのHistory APIを使ったルーティング実装。

### URL構造

```
https://example.com:3000/             ← 通常アクセス（新規チャット）
https://example.com:3000/chat/abc123  ← 特定チャットに直接アクセス
```

### 設計のポイント

#### 1. サーバー側はフォールバックのみ

```javascript
// server.js: 既存の SPA フォールバックがそのまま機能
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
```

`/chat/abc123` のようなパスでもindex.htmlが返るため、特別な改修不要。

#### 2. クライアント側でURLパース

```javascript
function getChatIdFromUrl() {
  const m = window.location.pathname.match(/^\/chat\/([a-z0-9]+)$/i);
  return m ? m[1] : null;
}

const [chatId, setChatId] = useState(() => {
  const urlId = getChatIdFromUrl();
  return urlId || generateNewId();
});
```

#### 3. chatId変更時にURL更新（pushState）

```javascript
useEffect(() => {
  if (!authenticated) return;
  const desiredPath = `/chat/${chatId}`;
  if (window.location.pathname !== desiredPath) {
    window.history.pushState({ chatId }, '', desiredPath);
  }
}, [chatId, authenticated]);
```

`pushState` を使うことで履歴に追加され、ブラウザの戻る/進むが効く。

#### 4. popstate イベントで戻る/進む対応

```javascript
useEffect(() => {
  const onPopState = () => {
    const urlId = getChatIdFromUrl();
    if (urlId && urlId !== chatId) {
      loadChat(urlId).catch(() => {
        newChat();
        window.history.replaceState(null, '', '/');
      });
    } else if (!urlId) {
      newChat();
    }
  };
  window.addEventListener('popstate', onPopState);
  return () => window.removeEventListener('popstate', onPopState);
}, [authenticated, chatId]);
```

#### 5. URLコピーボタン

履歴アイテムにホバーすると🔗ボタン表示、`navigator.clipboard.writeText` でコピー:

```javascript
const url = `${window.location.origin}/chat/${c.id}`;
await navigator.clipboard.writeText(url);
setLoadingMessage(`✓ URLをコピーしました: ${url}`);
```

`navigator.clipboard` は **HTTPS必須**（HTTPでは `setError` でURL表示にフォールバック）。

### エッジケース対応

| ケース | 動作 |
|:--|:--|
| 存在しないIDでアクセス | 「指定されたチャットが見つかりません」表示後、新規チャット |
| ロード失敗（DB破損等） | エラーをthrow → catchで新規チャットへフォールバック |
| 現在開いているチャットを削除 | `newChat()` でID再生成、URLも自動更新 |
| 認証前のアクセス | ログイン画面表示後、認証成功で目的のチャットがロード |

### 利点

- **ブックマーク可能**: 重要なチャットをブックマーク登録して即座に復帰
- **共有可能**: チームメンバーにURLを送って同じ会話文脈を共有
- **戻る/進む**: ブラウザのネイティブUIでチャット切替
- **複数タブ**: 異なるチャットを別タブで同時に開ける

### 留意点

- `navigator.clipboard` はHTTPS環境必須（HTTPだとフォールバックでテキスト表示のみ）
- 認証セッションは共有されないため、URLを共有しても相手はログインが必要
- 削除されたチャットIDのURLは無効になる（自動的に新規チャットへ）

---

## 📱 モバイルサイドバー閉じる機能

スマホサイズ(≤768px)では、サイドバーを開いた状態で操作するとチャット画面が隠れて操作しづらいため、明示的な閉じる機能を実装。

### 設計

#### 1. ×ボタン（モバイル時のみ表示）

```css
.sidebar-close-btn {
  display: none;  /* PC幅では非表示 */
  position: absolute;
  top: 12px;
  right: 12px;
  /* ... */
}
@media (max-width: 768px) {
  .sidebar-close-btn {
    display: flex;
  }
  .sidebar-header {
    padding-right: 56px;  /* ロゴと×ボタンの被り防止 */
  }
}
```

#### 2. チャット選択時の自動閉じ

```javascript
// 履歴アイテム
onClick={() => {
  loadChat(c.id);
  if (window.innerWidth <= 768) setSidebarOpen(false);
}}

// 新規チャット
onClick={() => {
  newChat();
  if (window.innerWidth <= 768) setSidebarOpen(false);
}}
```

`window.innerWidth <= 768` でモバイル幅判定。PCではサイドバーを開いたまま維持。

### 動作フロー

```
[モバイル: 幅 ≤ 768px]
☰タップ → サイドバー開く
   ├─ チャット選択 → loadChat + サイドバー自動で閉じる ✓
   ├─ + 新規 → newChat + サイドバー自動で閉じる ✓
   ├─ ×ボタン → サイドバー閉じる ✓
   └─ オーバーレイタップ → サイドバー閉じる（既存）

[PC: 幅 > 768px]
× ボタンは非表示
チャット選択しても閉じない（PCではエリア固定）
```

### サイドバー内パネルのドラッグリサイズ

左サイドバーの **チャット履歴** と **ドキュメント** はそれぞれスクロール領域を持つが、固定の高さ配分（履歴 220px 固定）だと、履歴が多い/添付が多いユーザーで使い勝手が変わる。そこで境界に1本のリサイズハンドルを置き、ドラッグで配分を変えられるようにした。

- **1ハンドルで両方を調整**: チャット履歴パネルの高さを state（インライン `height`）で制御し、ドキュメントパネルは `flex: 1` で残りを埋める。履歴を伸ばせばドキュメントが縮む、という相対調整が1本のハンドルで成立する（個別に2本置く必要がない）
- **Pointer Events で実装**: `onPointerDown` → `window` に `pointermove`/`pointerup` を張る方式。`mouse`/`touch` を統一的に扱え、ハンドルには `touch-action: none` でスクロール干渉を防ぐ
- **クランプ**: 高さは `max(120, min(startH + delta, window.innerHeight - 260))` に制限し、枠が潰れたり画面外へ出たりしないようにする
- **永続化**: 確定値を `localStorage('chatHistoryHeight')` に保存。次回ロード時に復元するため、初期 state も localStorage から読む

```javascript
const onMove = (ev) => {
  const delta = ev.clientY - startY;
  const maxH = Math.max(160, window.innerHeight - 260);
  setChatHistoryHeight(Math.max(120, Math.min(startH + delta, maxH)));
};
```

---

## ⚙️ 大きなリクエスト・並列制御・HTTP設定

外部API公開で大きな tools 配列（19KB+）を受け取る、画像Base64を含む大きなボディを送る、長いLLM応答を待つ等の本番運用要件に応えるため、HTTPサーバーと llama-server の細かな設定を config 化しました。

### Express bodyparserの上限

```javascript
// server.js
const MAX_REQUEST_SIZE = appConfig.maxRequestSize || '50mb';
const jsonParser = express.json({ limit: MAX_REQUEST_SIZE });
```

config:
```json
"maxRequestSize": "100mb"   // "10mb" / "500mb" / "1gb" 等
```

Express の `body-parser` がデフォルト 100KB なので、画像付きメッセージなどでは必ず必要になります。

### ファイルアップロード上限

```javascript
const MAX_FILE_SIZE = (appConfig.maxFileSize || 50) * 1024 * 1024;
```

config:
```json
"maxFileSize": 50   // MB単位、数値
```

### Node.js HTTPサーバーの設定

```javascript
const SERVER_OPTS = {
  maxHeaderSize: appConfig.maxHeaderSize || 64 * 1024,  // 64KB
};
const server = http.createServer(SERVER_OPTS, app);

server.requestTimeout = (appConfig.requestTimeoutSec || 600) * 1000;
server.headersTimeout = (appConfig.headersTimeoutSec || 120) * 1000;
server.keepAliveTimeout = (appConfig.keepAliveTimeoutSec || 60) * 1000;
server.timeout = 0;  // ソケットタイムアウト無効化
```

| 設定 | デフォルト | 用途 |
|:--|:--|:--|
| `maxHeaderSize` | 64KB | Authorization + 大量toolsで膨らむヘッダー対策 |
| `requestTimeoutSec` | 600 | リクエスト全体タイムアウト（LLM応答は長い） |
| `headersTimeoutSec` | 120 | ヘッダー受信のみのタイムアウト |
| `keepAliveTimeoutSec` | 60 | Keep-Alive接続維持 |

### llama-server `-np` (並列スロット数) 制御

`-np N` は llama-server の **並列スロット数**。`ctx ÷ np` が1スロットあたりの実効コンテキストになるため、自動値（多くの場合4）だと長文・大きい tools 配列で詰まります。

```javascript
'-np', String(model.nParallel ?? appConfig.llamaServer.nParallel ?? 1),
```

優先順位:
1. モデル個別の `nParallel`
2. グローバル `llamaServer.nParallel`
3. デフォルト `1`

```json
"llamaServer": {
  ...,
  "nParallel": 1
},
"chatModels": [
  { "name": "Qwen3.6 35B", "ctx": 32768, "nParallel": 1, ... },
  { "name": "Qwen2.5 0.5B", "ctx": 8192, "nParallel": 4, ... }
]
```

| `nParallel` | 用途 | スロットあたりctx (ctx=32768時) |
|:--|:--|:--|
| 1 | 単一ユーザー、エージェント用途 | 32768（フル） |
| 2 | 少人数チーム | 16384 |
| 4 | 公開API | 8192 |
| 8 | スループット重視 | 4096 |

### CVE-2025-46728 対策（cpp-httplib）

llama.cpp が内部で使う cpp-httplib < 0.43.3 では、`Transfer-Encoding: chunked` の大きなリクエストでサーバー側がRSTで切断する問題があります（llama.cpp **b9030以降** で対応済み）。

それでも切られる場合の対処は3段階:

1. **クライアント側で `Content-Length` 明示** （多くのHTTPライブラリは自動で付ける）
2. **llama.cpp b9030 以降** に更新
3. **Nginx前段でリバースプロキシ**（`proxy_request_buffering on` で chunked → Content-Length 変換）

---

## 💬 継続チャット（過去会話のRAG化）

長期的な対話を継続する仕組み。LLMのコンテキストウィンドウは有限ですが、過去会話を要約してRAGドキュメントとして保存することで、次のチャットから検索的に参照できます。

### フロー

```
[現在のチャット]
  ↓ ヘッダー「💬 継続チャット」クリック
  ↓
[LLMで詳細要約]
  System: あなたは優秀なドキュメンテーションのプロです。
  User:   会話履歴をmarkdownで詳細に要約（検索しやすく）
  options: max_tokens=8192, temperature=0.3, thinking=false
  ↓
[markdown抽出]
  ```markdown ... ``` で囲まれていれば中身を取り出す
  ↓
[ヘッダー付与]
  # チャットタイトル
  _作成日時: 2026/05/01 16:42_
  _元チャットID: xyzabc_
  ---
  [本文]
  ↓
[ドキュメントとして自動アップロード]
  ファイル名: {title}_{YYYYMMDD-HHMM}.md
  既存ドキュメントは引き継がれる
  ↓
[新規チャット状態に切替]
  チャットIDリセット、メッセージクリア
  ドキュメントは前のものを保持＋新規追加
```

### 実装のポイント

```javascript
async function createRagDocument() {
  // メッセージなしなら単純に新規チャット
  if (userMsgs.length === 0 || assistantMsgs.length === 0) {
    newChat();
    return;
  }

  // 会話履歴を整形
  const conversationText = messages
    .filter(m => m.content && (m.role === 'user' || m.role === 'assistant'))
    .map(m => `## ${m.role === 'user' ? 'ユーザー' : 'アシスタント'}\n\n${m.content.trim()}\n`)
    .join('\n---\n\n');

  // LLMに要約を依頼（thinking無効化で高速）
  const res = await fetch('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: chatModel,
      messages: [{ role: 'system', content: 'ドキュメンテーションのプロ...' }, { role: 'user', content: prompt }],
      stream: false,
      max_tokens: 8192,
      temperature: 0.3,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  
  const summaryMd = res.choices[0].message.content;
  
  // 新規チャット切替（既存ドキュメントは引き継ぐ）
  const prevDocs = [...documents];
  setMessages([]);
  setDocuments(prevDocs);
  
  // 新ドキュメント追加
  await addDocument(docName, fullMd);
}
```

### 利点

- LLMのコンテキスト超過を回避できる
- 重要な情報を構造化したmarkdownとして保存
- 検索可能なため、後から「○○について何と言ったか」を探せる
- 複数のチャットを連結して長期プロジェクトを進められる

### 留意点

- 要約の品質は使用するモデルに依存（temperatureを0.3に下げて一貫性重視）
- `<think>...</think>` が入らないよう `enable_thinking: false` 必須
- 既存ドキュメントの引き継ぎロジックで `prevDocs = [...documents]` のスナップショットを忘れずに

---

## 🎯 ドラッグ&ドロップ統合

3つのドロップゾーンが用途で振り分け:

| ゾーン | クラス | ハンドラ | 動作 |
|:--|:--|:--|:--|
| ドキュメントリスト（左） | `.docs-list.drag-active` | `handleDrop` | 全ファイルをRAG用ドキュメントに取り込み |
| チャット入力欄 | `.input-area.drag-active` | `handleChatDrop` | 画像→Vision添付、その他→ドキュメント |
| サーバーファイル（右） | `.files-panel-body.drag-active` | `handleServerDrop` | 全ファイルを `public/uploads/` にアップロード |

### handleChatDrop の振り分けロジック

```javascript
async function handleChatDrop(e) {
  const files = Array.from(e.dataTransfer.files);
  const images = files.filter(f => f.type.startsWith('image/'));
  const others = files.filter(f => !f.type.startsWith('image/'));

  // 画像 → チャット添付（base64化）
  for (const file of images) {
    const dataUrl = await readAsDataURL(file);
    const base64 = dataUrl.split(',')[1];
    setChatImages(prev => [...prev, { name, base64, preview: dataUrl }]);
  }

  // その他 → RAG用ドキュメント
  if (others.length > 0) handleFiles(others);
}
```

### dragLeave の誤発火防止

```javascript
onDragLeave={e => {
  // 子要素に入ったときのdragLeaveは無視
  if (e.currentTarget.contains(e.relatedTarget)) return;
  setDragActive(false);
}}
```

子要素を跨ぐとイベントが発火するため、`relatedTarget` で判定。

---

## 📦 バイナリファイルのアップロード/ダウンロード

### 問題

旧実装は `file.text()` でUTF-8テキストとして読み込んで JSON送信していたため、PNG等のバイナリが破損（先頭バイト `\x89` が `\xef\xbf\xbd` U+FFFDに置換される）。

### 解決: クライアント側

拡張子・MIMEタイプで分岐し、バイナリは FormData送信:

```javascript
const binaryExts = ['png', 'jpg', 'pdf', 'zip', ...];
const isBinary = binaryExts.includes(ext) || !file.type.startsWith('text/');

if (isBinary) {
  const fd = new FormData();
  fd.append('file', file);
  await fetch(`/files/${name}`, { method: 'POST', body: fd });
} else {
  const text = await file.text();
  await fetch(`/files/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text }),
  });
}
```

### 解決: サーバー側

依存追加なしの最小multipartパーサー:

```javascript
function parseMultipart(req) {
  // boundaryをContent-Typeから抽出
  // \r\n\r\n でヘッダーとファイル本体を分離
  // \r\n--boundary で末尾を切る
  // → fileBuf を返す
}

app.post('/files/*', requireAuth, async (req, res) => {
  if (req.headers['content-type'].startsWith('multipart/form-data')) {
    const fileBuf = await parseMultipart(req);
    fs.writeFileSync(abs, fileBuf);  // バイナリ書き込み
  } else {
    jsonParser(req, res, () => {
      fs.writeFileSync(abs, content, 'utf-8');  // テキスト書き込み
    });
  }
});
```

### ダウンロード側もContent-Type分岐

```javascript
const ct = res.headers.get('Content-Type');
let blob;
if (ct.startsWith('application/json')) {
  // テキスト: { content: "..." } をパース
  const data = await res.json();
  blob = new Blob([data.content], { type: 'text/plain' });
} else {
  // バイナリ: そのまま blob で取得
  blob = await res.blob();
}
```

---

## 📱 モバイル対応

### 100dvh + safe-area

`100vh` はモバイルブラウザのアドレスバー込みの高さで、下部が見切れる。`100dvh`（dynamic viewport height）に変更:

```css
body, .app-layout, .chat-area {
  height: 100vh;     /* フォールバック */
  height: 100dvh;    /* 動的高さ */
}

.input-area {
  padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 12px);
}
```

`<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">` でセーフエリア対応。

### 2行ヘッダー（≤768px）

```css
@media (max-width: 768px) {
  .chat-header {
    flex-direction: column;       /* 縦に並べる */
    align-items: stretch;
  }
  .chat-header-left {
    width: 100%;                  /* 上段: メニュー+ステータス+タイトル */
  }
  .chat-header-right {
    width: 100%;
    justify-content: flex-end;     /* 下段: アクションボタンを右寄せ */
    flex-wrap: wrap;
  }
}
```

### iOS自動ズーム抑制

```css
.input-box {
  font-size: 16px;  /* 16px未満だとフォーカス時に自動ズームする */
}
```

### サイドバー: ドロワー化

```css
.sidebar {
  position: fixed;
  transform: translateX(-100%);
  transition: transform 0.3s;
}
.sidebar.open {
  transform: translateX(0);
}
```

---

## 🧪 注意事項（実装時の罠）

1. **`express.json()` をグローバル適用しない**
   `/v1/*` プロキシのリクエストボディが消費されてしまうため、必要なエンドポイントのみに個別適用。`jsonParser` を定義してから後続のミドルウェアより先に呼ぶこと（`const jsonParser` の TDZ エラーに注意）。

2. **`/web-search`, `/files` は `/v1/*` の外に置く**
   同上、プロキシミドルウェアに吸収されないように。

3. **WebSocket認証はCookieから取得**
   `ws` パッケージは `req.headers.cookie` で標準送信されたCookieを参照可能。

4. **Three.js はr128固定**
   r142以降のAPI（CapsuleGeometry等）は使わない。CDN URL `https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js`。

5. **rocm-smiキー名はROCmバージョン依存**
   `GPU use (%)`, `GPU use (Mem) %`, `GPU use (VRAM) %` 等で揺れる。柔軟にパース。

6. **セッションは再起動でリセット**
   `sessions` はメモリMap。必要ならRedis等に差し替え可能。

7. **HTTPS環境では `Set-Cookie` に `Secure` 属性必須**
   `HTTPS_ENABLED` または `X-Forwarded-Proto` で判定して自動付与。

8. **LLMの英語独白対策**
   思考モデルが "I need to..." 等の英語独り言を出す場合、システムプロンプトに「内部的な推論・メタ説明を出力するな」と明示的に指示。

9. **Python preambleで UserWarning 抑制**
   matplotlibのフォント警告は非表示に。Errorは通常通り表示される。

10. **マルチターンツール実行の無限ループ防止**
    `MAX_TOOL_TURNS = 3` で必ず終了。それ以降は最終応答フェーズへ移行。

11. **LLMにはツールだけでなくPython実行機能も明示する**
    システムプロンプトに「グラフや計算はPythonコードブロックで返せば自動実行される」と書かないと、ツールしか選択肢がないと思い込んで思考ループに陥る。

12. **`file.text()` でバイナリを読まない**
    UTF-8として解釈不能なバイト（PNGの `\x89` 等）が U+FFFD（`\xef\xbf\xbd`）に置換され、ファイルが破損する。バイナリは必ず FormData / Blob 経由で扱う。

13. **`100vh` はモバイルで見切れる**
    アドレスバーの分が含まれて画面下が隠れるため、`100dvh` を使用。フォールバックで `100vh` も併記する。

14. **dragLeave は子要素遷移でも発火する**
    `e.currentTarget.contains(e.relatedTarget)` で子に入った場合を除外しないと、ドラッグ中にドロップゾーンのハイライトがチカチカする。

15. **`/files/*` の content-type 競合**
    multipart と JSON の両方を受けるため、`jsonParser` をミドルウェア配列ではなくハンドラ内で条件付きで呼ぶ必要がある。

16. **llama-server のモデル切替には数十秒かかる**
    `POST /models/load` 実行中はチャット推論ができない。フロントは `/models` で `current` を確認し、変更時のみリスタートを要求する（同じモデルなら何もしない）。

17. **`num_ctx` (コンテキスト長) はリクエスト時に変えられない**
    llama-server は起動時の `-c` で固定。動的に変えるには `chatModels[].ctx` を変えてサーバー再起動。

18. **OpenAI互換: `tool_calls.arguments` はJSON文字列**
    Ollamaは object で返すが、OpenAI互換 API（llama-server）は **stringified JSON**。フロント側で `JSON.parse` する必要がある。

19. **OpenAI互換: tool結果メッセージに `tool_call_id` が必須**
    `{ role: 'tool', content }` だけでは不可。`{ role: 'tool', tool_call_id: tc.id, content }` の形式で送る。

20. **AMD iGPU (gfx1036等) はLLM推論には使えない**
    メモリ計算でオーバーフローバグが発生し、ウォームアップ中にクラッシュする。`--device ROCm0,ROCm1` のように明示的に dGPU だけ指定する。

21. **トークン速度は実時間ベースで計算**
    Ollamaは `eval_duration` (nanoseconds) を返すが、llama-server (OpenAI互換) は `usage.completion_tokens` のみ。フロント側で `firstTokenTime` から `Date.now()` までの実測値で `tok/s` を計算する。

22. **llama-server ストリームは SSE 形式**
    Ollama: NDJSON（`\n` 区切り）、llama-server: SSE（`data: ...\n\n` 区切り）。バッファ管理して `\n\n` で分割し、`data: ` プレフィックスを剥がして JSON パースする。

23. **config.json で同じキーを2回定義すると後者で上書きされる**
    JSON仕様では同名キーが重複すると後者で上書きされ、エラーにならない。`chatModels` や `embeddingModel` を誤って2回書くと前者の `extraArgs` が消えて事故が発生する。`python3 -m json.tool` で確認できないため、目視か別ツールでチェック。

24. **mmproj未配置でVisionモデルが503**
    `chatModels[].extraArgs` に `--mmproj <path>` を指定したが、ファイルが存在しないと llama-server がspawn直後に死ぬ。`exit code null` が出ているか確認し、必ずモデル本体と一緒にmmprojもダウンロードする（unsloth版・bartowski版で名前が違うので注意）。

25. **生成中のモデル切替は二重ガードが必要**
    フロントの useEffect だけで防ぐと、ユーザーがドロップダウンを変更した瞬間に即座にロードリクエストが飛ぶ。`disabled={isLoading}` でUIを物理ブロックしつつ、`if (isLoading) return` でロジックも二重チェック。useEffect 依存配列にも `isLoading` を含める。

26. **idleUnloadMs の自動再ロードは「同じモデル」判定に注意**
    アイドルでアンロード→再リクエストで自動再ロード中、フロントの `chatModel` 変更useEffectは「同じモデルが消えた」と判定して `/models/load` を呼びたくなる。`/models` レスポンスに `autoUnloaded` フィールドを含め、フロント側で `sdata.autoUnloaded === chatModel` なら手を出さない（自動再ロード任せ）ロジックが必要。

27. **コンテキストサイズUIは混乱の元**
    Ollama時代は `num_ctx` をリクエスト毎に変えられたが、llama.cppでは起動時固定。ユーザーが選べるUIにすると「変えても動作が変わらない」と誤解される。`chatModels[].ctx` を読み取り専用で表示するか、モデル名横に `(8,192)` 形式で併記するのが親切。

28. **`autoUnloaded` ≠ `starting` で扱う**
    `chatProcAutoUnloaded` は「次回ロード予定のモデル名」を記録するだけで、実際のロードは始まっていない。フロントの `setModelStarting(!!data.starting || !!data.autoUnloaded)` のように両方TRUEにすると、ブラウザを開きっぱなしの間ずっと「再ロード中」トーストが表示されてしまう。`modelStarting` は `data.starting` のみ、`autoUnloadedName` は別state で管理する。

29. **Embeddingプロキシは async 化必須**
    Embeddingアイドルアンロード対応のため、`/embed/v1/*` プロキシで `await ensureEmbeddingLoaded()` する必要がある。`proxyToLlama()` を `return async (req, res) => {...}` 形式にすること。チャットプロキシ側は同期で503返却するので非同期化不要だが、Embeddingは数秒待ってでも処理を続けるべきなので非同期。

30. **Gemma系の独自トークン形式を吸収**
    Gemma3/4 はOpenAI互換のtool_callsではなく `<|tool_call|>call:web_search{query:<|"|>...<|"|>}<tool_call|>` のような独自形式でツール呼び出しを出力することがある。さらに非対称トークン（`<|tool_call>`, `<tool_call|>`, `<tool_call>` など）も混在する。正規表現は `<\|?tool_call\|?>` のように `|` を任意にして両方マッチさせる。

31. **Qwen3系の thinking モードでツール判断が遅延**
    Qwen3.6 などのthinking機能は `<think>...</think>` 内で推論する。ツール判断時にこれが入ると `max_tokens=512` で時間切れになり tool_calls が返らない。`chat_template_kwargs: { enable_thinking: false }` を渡してツール判断時のみthinking無効化する。最終応答時はそのまま使う。

32. **`<think>` タグが閉じないまま終わるケース**
    Qwen3系で `max_tokens` 切れにより `<think>...</think>` の閉じタグが出ない場合、フロント側で「全文がthinking、本文が空」と解釈されて表示が止まる。ストリーミング完了後の救済処理として、`!content && thinking` ならthinking内容を本文に昇格させる。

33. **Embedding処理中の並行リクエストでサーバー詰まり**
    ドキュメントD&D中はチャンクごとに大量の `/embed/v1/embeddings` が発生する。同時にチャット送信されるとllama-server側で詰まることがある。フロント側で `embeddingJobs.length > 0` の間は送信ボタンを無効化し、並行リクエストを防ぐ。

34. **`fakeFileList` でiteratorエラー**
    プレーンオブジェクト `{0: file, 1: file, length: 2}` を `for...of` で回すとTypeError。FileListはイテレーブルだが擬似オブジェクトには `[Symbol.iterator]` がない。`Array.from(files)` で配列化してから for...of するか、最初から配列を直接渡す。

35. **CommonMarkのIntraword Emphasis制約で日本語太字が動かない**
    `**強調**` は英語では正しく太字になるが、日本語では `気温は**24℃**程度` のように直接接続すると認識されない。これはCommonMark仕様で「単語境界」がアスタリスクの前後に必要なため。日本語/中国語/韓国語の文字に隣接する `**` の前後にゼロ幅空白 `\u200B` を挿入すると解決する。`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}` の正規表現で対応。

36. **write_file は明示的キーワード時のみtools提供**
    Qwen3.6やGemma系は「Pythonで〜を作って」のような単純なコード作成依頼で write_file を誤呼び出しすることがある。さらに引数 `path` を空のまま送ってきて 400 Bad Request → 詰まる。これはツール定義からの除外で根本対策する：「保存」「書き込み」「サーバーに」など明示的キーワードがある時のみ `write_file` を tools 配列に push する動的提供方式が確実。

37. **matplotlib のキャッシュ先（MPLCONFIGDIR）**
    systemd の `ProtectHome=read-only` 設定下では `/home/$USER/.config/matplotlib` が書けず警告が出る（動作はする）。`Environment=MPLCONFIGDIR=/tmp/matplotlib` をsystemdユニットに、または `spawn(python, { env: { MPLCONFIGDIR: ... } })` で渡す。venv環境でも同じ環境変数が継承されるので追加対応不要。

38. **モデル状態の3つのフラグを正しく区別する**
    `modelStarting`(実際にllama-server起動中) / `autoUnloadedName`(アイドル状態で次回ロード予定) / `firstLoadPending`(起動後初回ロード待ち) は別の意味を持つ。`autoUnloadedName` だけで「ロード中」と判定すると、ブラウザを開きっぱなしの間ずっと「再ロード中」トーストが出てしまう。実際にロード処理が走っている `modelStarting=true` の時のみトーストを出すこと。

39. **ツール判断503は自動リトライ**
    アイドル復帰直後など、まだllama-serverが完全に起動しきっていないタイミングでツール判断リクエストが503で返ることがある。エラーをそのまま投げるとUIが止まるため、503の場合は5秒待機して最大3回までリトライする。これでロード時間のブレを吸収できる。

40. **モーダルが透けて見える問題**
    `rgba(0,0,0,0.5)` のオーバーレイ + `var(--bg)` のモーダルだけでは、ダークテーマで背景が透けて見えることがある。これは `--bg` 自体が完全な不透明な黒ではなく、CSSの仕様で親opacityを継承する場合があるため。対策は3点：(a) overlayの透明度を `0.7` に強める、(b) `backdrop-filter: blur(4px)` でぼかす（Safari対応で `-webkit-backdrop-filter` も）、(c) モーダル本体に `opacity: 1` と `background-color: var(--bg)` を明示。

41. **カスタムシステムプロンプトは末尾に追加**
    LLMに役割を与えるユーザー指定プロンプトは、システムプロンプトの **末尾** に追加するのが鉄則。Transformer系モデルは attention の関係でプロンプトの末尾を最もよく "覚える" ため、固定プロンプト（base/documents/python/meta等）の前に置くと無視されがち。`agentSystem += '\n\n【ユーザー指定の役割・指示】\n' + chatRole` のように末尾結合し、見出しで明確に区別する。

42. **SPAルーティングはサーバー側のフォールバックが必須**
    `/chat/<id>` のようなURLでアクセスされた時、index.htmlが返らないと404になる。`app.get('*', (req, res) => res.sendFile('public/index.html'))` のフォールバックが必要。ただしこれを `app.use(express.static())` の **前に** 置くと、CSSや画像も index.html を返してしまう。順序は: 個別ルート → 静的配信 → `app.get('*')` フォールバック。

43. **navigator.clipboardはHTTPS必須**
    `navigator.clipboard.writeText()` は HTTPS（または localhost）でのみ動作する。HTTP環境ではpermission deniedで失敗する。フォールバックとして:
    ```javascript
    try { await navigator.clipboard.writeText(url); }
    catch { setError(`URL: ${url}`); }  // 失敗時はテキスト表示でユーザーが手動コピー
    ```
    本番運用ではHTTPS化を強く推奨。

44. **pushStateとpopstateの依存関係**
    `useEffect([chatId])` で pushState 更新、`useEffect([])` で popstate 監視を実装する場合、popstate の useEffect が古い chatId を closure で掴むため正しく比較できない。`useEffect([chatId])` で popstate も監視し、毎回 listener を再登録する必要がある。`return () => removeEventListener` でクリーンアップ忘れずに。

45. **CSS の相対パスは SPA で深い階層に対応しない**
    `url("aiicon.jpg")` のような相対パスは、ブラウザが **現在のページURLを基準** に解決する。`/chat/abc123` のような階層に直接アクセスすると、`/chat/aiicon.jpg` を要求して404になる。対策は CSS / HTML すべてのリソースを **絶対パス（`/aiicon.jpg`）** で記述すること。`<base href="/">` を使う方法もあるが、SPAでルーティング設計が複雑になる場合があるので絶対パスのほうが安全。SPAルーティング導入時に発覚しがちな盲点。

46. **CJK記号類も日本語太字対応に含める**
    日本語の `**強調**` 対策でゼロ幅空白を挿入する際、最初は漢字・ひらがな・カタカナだけ対象にしていたが、`**「文字列」**` のように **CJK記号（「」『』、。等）に隣接** すると太字にならない。CommonMarkは「単語境界」として記号を扱わないため。対象に `\u3000-\u303F`（CJK記号・句読点）と `\uFF00-\uFFEF`（全角形）を追加する。

47. **llama-server の HTTPSヘルスチェック**
    llama-serverを `--ssl-cert-file --ssl-key-file` でHTTPS起動した場合、`/health` エンドポイントもHTTPSになる。Node.js側でヘルスチェックする `waitForReady` は通常 `http` モジュールだが、HTTPS時は `https` モジュールに切替必須。自己署名証明書を考慮して `rejectUnauthorized: false` も忘れずに。これを忘れるとサーバーは起動しているのに「タイムアウト」エラーになる。

48. **window.location.replace() vs history.replaceState()**
    URL を変えるだけなら `history.replaceState` で十分だが、React state を完全リセットしたい場合は `window.location.replace()` を使う。前者はSPAのまま、後者はページ全体を再読み込み（履歴には残らない）。削除済みチャットIDのURLに更新でアクセスしたケースで、`replaceState` だけだと state が中途半端な状態で残るため、完全リロードで初期化したほうが安全。

49. **llama.cpp は `-DLLAMA_SERVER_SSL=ON` ビルド必須（HTTPS化時）**
    llama-server を `--ssl-cert-file --ssl-key-file` でHTTPS起動するには、CMake時に `-DLLAMA_SERVER_SSL=ON` (古い名前: `-DLLAMA_SERVER_ENABLE_SSL=ON`) と `libssl-dev` が必要。これが入っていないと起動時に stderr に `the server is built without SSL support` `failed to initialize HTTP server` と出てプロセスは即座に終了する。確認方法は `llama-server --help | grep -i ssl` で `--ssl-cert-file` が表示されるかどうか。

50. **cpp-httplib の chunked transfer + 大きいリクエストの問題（CVE-2025-46728）**
    cpp-httplib < 0.43.3 では `Transfer-Encoding: chunked` で `Content-Length` なしのリクエストでサイズ制限処理が正しく機能せず、超過時に接続を即座に終了する挙動がある。llama.cpp **b9030 以降** で 0.43.3 に更新されているが、それでも特定クライアント（chunked transferを多用するVSCode拡張やhttp-client）で 19KB+ のリクエストが切られることがある。対処は3段階: (1) クライアント側で `Content-Length` 明示、(2) llama.cpp 最新化、(3) Nginx前段で `proxy_request_buffering on` により chunked → Content-Length 変換。

51. **`-np` (parallel) で ctx が分割される**
    llama-server は `-np N` を指定すると（または自動で N=4 になると） KV キャッシュを N個のスロットに分割するため、**1スロットあたりの実効 ctx = ctx_size ÷ N** になる。`ctx=32768 -np 4` だと実質 8192 トークンしか1リクエストで使えない。エージェント用途や長文プロンプト・大きい tools 配列を扱う場合は `nParallel: 1` にしてフル ctx を使えるようにする。逆に多人数で並列アクセスするなら 2〜8 に増やしてスループットを稼ぐ。

52. **Express bodyparserのデフォルト上限はとても小さい**
    Express の `express.json()` のデフォルト上限は **100KB**。画像をBase64で含めるとあっという間に超える（4MB画像→約5.4MB Base64）。`{ limit: '100mb' }` のような明示が必須。`/v1/*` プロキシは body をストリーム転送するので bodyparser を通さないが、`/chats/:id` のJSONボディ保存などは通すため必要。

53. **Node.js の `maxHeaderSize` デフォルト16KB**
    Node.js HTTPサーバーの `maxHeaderSize` のデフォルトは 16KB。`Authorization: Bearer sk-...` に加えて `tools` 配列をボディじゃなくクエリ・ヘッダーに乗せるクライアントや、Cookieが大量に積まれているケースで 16KB を超えるとリクエストが弾かれる（接続切断）。`http.createServer({ maxHeaderSize: 64 * 1024 }, app)` で拡大可能。Node.jsコマンドラインオプション `--max-http-header-size=65536` でも変更可。

54. **HTTPSフォームのチェック状態 ≠ 起動済みサーバーのプロトコル**
    外部APIサーバーUIで「HTTPS で起動する」チェックボックスはあくまで「次に起動するときの設定」。既に起動済みのサーバーは前回起動時の状態を保持している。これが原因で「チェックON なのに URL が `http://` で表示される」混乱が起きる。対策として起動済みサーバーカードに `🔒 HTTPS` / `🔓 HTTP` バッジを表示し、実際のプロトコルが一目でわかるようにする。

55. **DNS解決とブラウザ・curl・Pythonの違い（hostsの罠）**
    Windowsの hosts ファイルは編集しても効かないことがある（DnsCacheサービスの挙動、行頭スペース、エンコーディング、行末コード CRLF/LF の差異）。ブラウザだけ動いて curl/Python が失敗する場合、`ipconfig /flushdns` + `net stop/start dnscache` を試す。SPA + 同一LAN内のサーバー運用では、クライアントから **直接IPアドレスを使ってテスト** することで切り分けが早い (`nslookup`/`ping`の結果を信用する)。

56. **PyTorch ROCm版とCPU版の上書き事故**
    llama.cpp の `requirements.txt` をそのまま `pip install -r` すると `torch+cpu` が入って ROCm版を上書きしてしまう。対策は2つ: (a) llama.cpp用に別venvを作る (`~/llama.cpp/.venv-llama`)、(b) `grep -v "^torch" requirements.txt > requirements-no-torch.txt` で除外してインストール。ファインチューニング用venv (`venv-tuning`) と GGUF変換用venv (`.venv-llama`) を明確に分離する。

57. **`torch_dtype` は deprecated**
    transformers 4.40 以降、`AutoModelForCausalLM.from_pretrained(model_id, torch_dtype=torch.bfloat16)` は警告が出る。`dtype=torch.bfloat16` に統一すべし。tune_runner.py ではこれを採用済み。

58. **ROCm環境では `attn_implementation="eager"` を明示**
    PyTorch ROCm版で `device_map="auto"` や SDPA (Scaled Dot Product Attention) を使うと `CUDA error: unspecified launch failure` が出ることがある。`attn_implementation="eager"` を明示し、`.to("cuda")` で単一GPU指定するのが安定。

59. **`HIP_VISIBLE_DEVICES=0` で複数GPU暴走防止**
    マルチGPU環境で DataParallel が自動起動して NCCL Error 1 を出すケースがある。学習スクリプト側で明示的に `HIP_VISIBLE_DEVICES=0` を設定するとシングルGPU動作に固定できる。OpenGeekLLMChat の `tuning.env` で自動設定される。

60. **小さいモデル（0.5B〜1.5B）のQ4_K_M量子化は知識劣化**
    Q4_K_M は 7B 以上を想定した量子化レベル。0.5B〜1.5B モデルにかけると知識が大幅に失われる。小型モデルは **F16 または Q8_0** で量子化すべし。tuning.html のPostProcessダイアログにはモデルサイズ別の推奨表記を載せた。

61. **Reactの条件分岐レンダリングは state を破棄する**
    `{tab === 'x' && <View />}` で false になると React は完全に unmount してコンポーネント state を破棄する。タブを行き来する画面では入力値・スクロール位置・モーダル開閉などが全て初期化されてしまう。`<div style={{display: tab === 'x' ? 'block' : 'none'}}>` でラップすれば DOM・state ともに保持される。useEffect の `[]` 依存も再実行されない。

62. **チャット履歴の自動保存タイミング = 並び順の更新タイミング**
    `useEffect([messages])` で自動保存すると、`loadChat` で履歴を開いた瞬間に setState → useEffect 発火 → POST → updatedAt 更新となり、開いただけのチャットが先頭に来てしまう。`messagesDirtyRef` で「実際にユーザー操作があったか」を追跡し、それが true のときだけ保存することで「開いただけでは並び順が変わらない」挙動を実現する。useState ではなく useRef を使うのはクロージャ問題と無駄な再レンダー回避のため。

63. **`amd-smi` の JSON 出力は `{gpu_data: [...]}` でラップされている**
    ROCm 6.x以降の新標準 `amd-smi static/metric --json` は、配列を直接返すのではなく `{ "gpu_data": [...] }` というオブジェクトでラップする。`JSON.parse(out)` の結果が配列だと思って `data.forEach()` するとエラー。`parsed.gpu_data || parsed` のような両対応が必要。また、GPU名は `board.product_name` が `"N/A"` のことが多いため `asic.market_name` を優先する。

64. **iGPU を LLM 用 GPU リストから除外する**
    AMD APU (Ryzen 9000/Phoenix等) は内蔵 GPU を持っており、`amd-smi` や `rocm-smi` ではこれも GPU としてリストされる。LLM 用途では使えないため自動除外が必要。判定条件は: (a) `target_graphics_version` が `gfx10[345]x` (Phoenix/Raphael/Rembrandt等のAPU)、(b) `num_compute_units < 8`、(c) VRAM ≤ 4GB のいずれか。OR で判定すれば確実に内蔵GPUだけが除外され、dGPU は残る。

65. **CSS変数 `var(--text)` のような未定義変数を使うとブラウザのデフォルト色になる**
    React/JSXで動的に書いたスタイルだとTypeScript的に分からない問題。CSS変数が未定義だとフォールバックなしで「初期値（黒に近い色）」になる。ダーク背景上では文字がほぼ見えなくなる。対策は `:root` で定義済みの変数名（`--text-primary`, `--text-secondary`, `--text-muted`）を厳格に使うこと。プロジェクト初期のリファクタで `--text` → `--text-primary` 等にリネームした際の取りこぼしに注意。

66. **`<select>` の `<option>` 要素の色はブラウザデフォルトで固定**
    `<select>` 自体のCSSは効くが、ドロップダウンが開いた時の `<option>` のスタイルはOSダイアログレベルで描画されるため、`color`/`background` を明示しないとブラウザの白背景で表示される。`select option { background: var(--bg-secondary); color: var(--text-primary); }` で明示する必要がある。

67. **外部APIサーバーの「プロセス停止」と「設定削除」を分ける**
    一つの「停止」ボタンだけだと、ユーザーは「一時的に止めて後で再起動したい」のか「完全に削除したい」のか区別がつかない。設計として `● 稼働中 ⇄ ○ 停止中` トグルでプロセスのみ操作（設定は保持）、`✕` で設定ごと削除、と機能を明確に分けることでUXが向上する。サーバー側も `stopExternalServerProcess()`（設定保持）と `stopExternalServer()`（設定削除）を分離する。

68. **`process.env.INVOCATION_ID` で systemd 起動を判定**
    systemd は子プロセスに `INVOCATION_ID` という UUID 形式の環境変数を必ず付与する。これがあれば systemd 管理下、なければ直接実行（または別のプロセスマネージャ）と判定できる。`/restart` エンドポイントで `process.exit(0)` する前に、この判定で「自動復帰されるか」をクライアントに伝えることで、ユーザーが「終了したまま戻ってこない」事故を防げる。

69. **再起動完了の検知はポーリングで「uptime が短い」を見る**
    `POST /restart` でプロセスを終了させると、systemd が新プロセスを起動する。クライアントは古いプロセス・新プロセスを区別できないので、`GET /restart/info` の `uptime` フィールドを確認する。`uptime < 30秒` なら新プロセスと判定。さらに連続2回成功で確定とすることで、たまたまDB接続が回復した古いプロセスに当たる可能性を排除できる。最初の2秒はポーリングしない（プロセス終了を待つ）のもポイント。

70. **`process.exit()` の前に少し待ってレスポンス返却**
    `res.json({ok: true}); process.exit(0);` だとレスポンスが TCP バッファに乗る前にプロセスが消えて、クライアント側が `ERR_EMPTY_RESPONSE` を受け取る。`setTimeout(() => process.exit(0), 1500)` のように 1〜2秒待つことで、レスポンスが届いてからプロセス終了できる。また子プロセス（外部APIサーバー等）の SIGTERM ハンドリングのためにも待ち時間は必要。

71. **未定義のCSS変数を使うと無効値ではなくブラウザデフォルト色になる罠（再発防止）**
    罠65 と同じだが、editconfig.html のような新規 HTML ファイルでも同じバグが起きやすい。新しいページを作る時は、既存の `styles.css` の `:root` 変数定義をコピーするか、独自定義する。`var(--text)` のような未定義変数を使うと CSS 全体が無効化されるわけではなく、その1プロパティだけブラウザの「初期値」になる（通常は黒）。ダーク背景上では「黒い文字 = ほぼ見えない」状態になるので発見が遅れやすい。

72. **stable-diffusion.cpp のPIEビルドエラー**
    ROCm ビルド時に `relocation R_X86_64_32 ... can not be used when making a PIE object` エラー。Ubuntu 24.04 の gcc がデフォルトでPIE有効、しかし `libggml-hip.a` 等の依存ライブラリがPIE非対応でコンパイルされているため衝突する。対処: `cmake -DCMAKE_POSITION_INDEPENDENT_CODE=OFF -DCMAKE_EXE_LINKER_FLAGS="-no-pie" -DCMAKE_C_FLAGS="-fno-pie" -DCMAKE_CXX_FLAGS="-fno-pie"` の全てを指定。llama.cpp の ROCm ビルドでも同じ問題が起きる。

73. **sd-server のオプション名は `--listen-port` / `--listen-ip`**
    stable-diffusion.cpp の `sd-server` は llama-server と異なり、`--port` / `--host` ではなく `--listen-port` / `--listen-ip` を使う。`-p` は `--prompt` の短縮形なので、`--port` と書くとパラメータ解析でエラーになる。Usage を読まずに llama-server と同じだろうと推測すると詰まる。

74. **sd-server の `--type` は重み型（f16/q4_0等）であり、モデルタイプではない**
    `--type sdxl` のように書きたくなるが、これは f32/f16/q4_0/q5_0/q8_0 等の **量子化フォーマット** を指定するオプション。SDXLかFluxかはモデルファイルから自動推測される。`--type sdxl` を渡すと「invalid argument」で起動失敗。指定しないか、量子化型を入れる（例: `--type f16`）のが正しい。

75. **sd-server は AUTOMATIC1111互換のAPI（`/sdapi/v1/txt2img`）を提供**
    名前は「sd-server」だが、独自APIではなく **AUTOMATIC1111 (a1111) 互換** の API を実装している。リクエストJSONは `{prompt, negative_prompt, width, height, steps, cfg_scale, sampler_name, seed, batch_size, n_iter}` のa1111フォーマット、レスポンスは `{images: [base64...]}`。ComfyUI互換ではないので注意。

76. **VRAM共有: チャットモデルと画像生成モデルの併存問題**
    35B-A3B MoE モデル（Q4_K_XL で約22GB）+ SDXL（約8GB）を 32GB のR9700一枚で同時稼働するとVRAMギリギリ。対処: (a) `idleUnloadMs` で画像生成モデルを自動アンロード、(b) `HIP_VISIBLE_DEVICES=0/1` で別GPUに分離、(c) `--offload-to-cpu` でモデルをRAMに退避。実体験では (a) と (b) の併用が最もスムーズ。

77. **LLMに画像URL付きの応答をさせる場合のMarkdown改変リスク**
    画像生成結果を `![alt](url)` のMarkdown形式でLLMに渡すと、LLMが「読みやすくしよう」として `![生成された美しい猫](url)` のようにalt textを書き換える程度ならまだ良いが、稀にURLパスを「相対パス化」して `./uploads/sd_xxx.png` に変えたりパスを「修正」したりする事故が起きる。対処: カスタムマーカー `[[gen_image:URL|prompt]]` を使い、ツール返信時に「このマーカーは画像表示用なので改変せずそのまま含めてください」と明示指示。React側でこのマーカーを検出して専用コンポーネントに置き換える。Markdownを通さないのでLLMの「親切な改変」を防げる。

78. **sd-server には `/health` エンドポイントが無い罠**
    llama-server には `/health` エンドポイントがあるが、stable-diffusion.cpp の sd-server には**存在しない**。`waitForReady('/health')` をそのまま使うと永遠に成功せず、タイムアウト失敗する。対策: TCP接続成功だけで判定する別関数 (`waitForTcpReady`) を用意する。ただし TCP 接続成功 ≠ モデルロード完了 なので、初回リクエストでエラーになる場合は数秒の遅延を入れるか、`/sdapi/v1/options` 等のAPIで実応答を待つ。

79. **sd-server のリクエストパラメータは最小限が安全**
    sd-server は AUTOMATIC1111互換 API を実装しているが、互換性は完全ではなく、`sampler_name` / `cfg_scale` / `seed` / `negative_prompt` 等を明示指定すると `{"error":"generate_image returned no results"}` で500エラーになることがある。**最小限のパラメータ `{prompt, width, height, steps, batch_size, n_iter}` で送る**のが安定。追加パラメータは必要なときだけ条件付きで追加する設計が良い。a1111のドキュメントを参考に書くと罠にハマる。

80. **プロセス再起動時の `lastActivity` 残留バグ**
    アイドルアンロード設計でプロセスを停止→再起動する場合、`lastActivity` 変数を新プロセス起動時に明示的にリセットしないと、前回終了時刻から大きく時間が経過した状態で起動した時に **起動中のアイドルチェックが「アイドル時間が長い」と誤判定して即座にプロセスを kill する** バグが発生する。例: 23:19 に最後利用 → 翌朝 09:23 に再起動 → 09:25 にチェックで「アイドル36351秒」判定 → 起動直前で kill → クライアント側 503。対策: `startXxxModel()` の最初で `lastActivity = Date.now()` を実行。

81. **amd-smi 26.x で VRAM フィールド名が変更（破壊的変更）**
    旧 amd-smi: `metric.fb_usage.used` / `fb_usage.total`、新 amd-smi 26.x: `metric.mem_usage.used_vram` / `mem_usage.total_vram`。フィールド名が変わっていて、旧コードのままだと VRAM 使用量が `N/A` 表示になる。修正: `mt.mem_usage || mt.fb_usage || mt.vram_usage` のように複数フォールバック対応する。デバッグログに `metric.mem_usage` を含めておくと早期発見できる。

82. **初回ロード時のクライアント側自動トリガー**
    クライアント側でモデル未ロード時にダミーリクエストを送ってサーバーにロード開始させる仕組みで、`mdata.autoUnloaded` だけをチェックすると **サーバー再起動直後の初回ロード状態 (`!mdata.current && !mdata.starting && !mdata.autoUnloaded`)** をスキップしてしまう。条件を `mdata.autoUnloaded || (!mdata.current && !mdata.starting)` に拡張する必要がある。サーバー側の `ensureChatModelLoaded()` も `appConfig.defaultModel` で起動できるようにする。

83. **React state 更新時の既存フィールド保持忘れ**
    メッセージオブジェクトに後から追加したフィールド (例: `generatedImages`、`searchQueries`、`tokenInfo`) は、その後の `streamResponse` などで `copy[i] = {role, content, ...}` のように完全置き換えすると消える。`copy[i] = {...copy[i], role, content, ...}` のように既存フィールドをスプレッドで保持する必要がある。特に「非同期で追加されるフィールド」がある場合は要注意。テストするときは、複数ツールを連続実行するシナリオで検証する。

84. **`useEffect` 内での `innerHTML` 直書き換えは React 管理外DOMを破壊する**
    `MarkdownContent` で `useEffect` 内で `ref.current.innerHTML = html` する実装は、複数のコンポーネントが並んだ時に他のコンポーネントの DOM を操作してしまう可能性がある。実体験: メッセージリストの中で、画像生成したメッセージのDOMと別のメッセージのDOMが混在表示されるバグが発生。原因は ref の参照ずれと、React 管理外で innerHTML を書き換えることによる Reconciliation との競合。解決策: `dangerouslySetInnerHTML` + `React.memo` の組み合わせを使う。React 標準パターンなので安全。

85. **`React.memo` でストリーミング中の過去メッセージを保護**
    ストリーミングで親 state が頻繁に更新される時、メッセージリストの全要素が再レンダリング対象になり、過去のメッセージも巻き込まれる。すると、ユーザーが過去のコードブロックで「▶ 実行」を押した直後でも、ストリーミングの更新で `dangerouslySetInnerHTML` が再実行されて `output-*` の中身が消える。`MarkdownContent` を `React.memo` でラップし、`content` が変わらない限り再レンダリングをスキップすれば、過去メッセージのコードブロック実行結果 (`output-*` の中身) が破壊されない。副次効果として、長いチャット履歴でも高速化される。

86. **`Math.random()` で生成した DOM ID は再レンダリングで変わる**
    marked の `renderer.code` で `Math.random()` で code id を生成すると、ストリーミング中の再レンダリングで毎回違う ID になる。ユーザーが「▶ 実行」を押した直後の再レンダリングで `output-<id>` 要素が消失して、結果が表示されない。コードテキストのハッシュから決定的に生成すれば、同じコード = 同じ ID で再生成されても DOM が同じ場所に維持される:
    ```javascript
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    const id = 'code-' + Math.abs(hash).toString(36) + '-' + text.length;
    ```
    `React.memo` と組み合わせれば二重に安全。

87. **DuckDB `read_json_auto` は `format='newline_delimited'` 必須**
    Web API インポート時、JSON配列を NDJSON 形式 (1行1オブジェクト) で書き出して `read_json_auto()` に渡すが、`format='newline_delimited'` を明示しないと「ファイル全体が1つのJSON」と解釈されてエラーになる。
    ```sql
    -- ❌ ダメ: ファイル全体を1つのJSONとして読もうとする
    SELECT * FROM read_json_auto('data.ndjson')
    -- ✅ 正しい: 1行1JSONとして読む
    SELECT * FROM read_json_auto('data.ndjson', format='newline_delimited')
    ```

88. **DuckDB Python と Node.js のバインディングは別パッケージ**
    Python の `pip install duckdb` と Node.js の `npm install duckdb` は別物。共通の DuckDB バイナリを使うが、それぞれの言語バインディングは独立。両方インストールする必要がある (Node 側はサーバー処理、Python 側は学習スクリプト用)。バージョン差異でファイルフォーマット非互換になることもあるので、極力同じメジャー版を使うこと。

89. **ml.html のクラス名は tuning.html と統一する**
    `.modal-overlay` / `.modal` / `.modal-header` / `.modal-body` / `.modal-footer` のクラス名は、tuning.html とログイン画面 (`.login-container`) で既存スタイルが定義されている。ml.html で独自命名 (`.dialog-overlay` 等) すると CSS 重複・スタイル不一致が発生する。新規ページを作るときは既存パターンを踏襲。

90. **DuckDB は1プロセス排他ロック (1.x)**
    Node が DB 接続を開いた状態で Python (ml_runner.py) が `duckdb.connect(read_only=True)` してもロック取得できず `Conflicting lock` エラー。学習開始時に Node 側で **CHECKPOINT 実行 → 接続 close** してから Python を spawn。学習中は Node 側の `getMlDb()` を throw でブロックして、UI/LLM がアクセスできないように調停する。終了後は次回アクセス時に自動再オープン。
    ```javascript
    if (currentMlJob) {
      throw new Error(`現在 ML 学習中: ${currentMlJob.modelName}`);
    }
    ```

91. **DuckDB Node バインディングからの string 型は `'str'` dtype**
    Pythonで DuckDB Node 経由のデータを `.df()` で受けると、文字列カラムは pandas 2.0+ で `'object'` ではなく `'str'` (StringDtype) として返る。`dtype == 'object'` だけで判定するとカテゴリ列を見逃し、無理に float 変換して全 NaN 化する。判定は複数対応する:
    ```python
    def classify_dtype(col_dtype):
        name = str(col_dtype).lower()
        if 'datetime' in name or 'timestamp' in name or 'date' in name:
            return 'datetime'
        if name in ('object', 'category', 'str', 'string', 'bool', 'boolean'):
            return 'category'
        return 'numeric'
    ```

92. **ターゲットスケーリングで MSE 数値安定化**
    回帰タスクで売上 (10000〜60000) のような大きな値域のターゲットを直接 MSE で学習すると、loss が 1e+08 オーダーになり Adam optimizer が動きづらく収束が極めて遅い (500エポック回しても MAE が下がりきらない)。ターゲットも StandardScaler で標準化して学習し、推論時に逆変換すると loss が 1.0 前後に安定、25エポックで収束。
    ```python
    target_scaler = StandardScaler()
    y = target_scaler.fit_transform(y_raw.reshape(-1, 1)).flatten()
    # 推論時:
    pred_raw = target_scaler.inverse_transform(pred_scaled.reshape(-1, 1)).flatten()
    ```

93. **LLM の派生列直接渡し問題と4層救済**
    LLM (特に Qwen3 系) は日時派生列をモデルが必要としていると誤解して `{"date_year": 2026, "date_month": 4, "date_day": 20}` のように渡してくることがある。これを防ぐため4層の救済を実装:
    1. **ツール description で明示**: 「✅ "date": "2027-04-15" / ❌ "date_year": 2027 ← 絶対やらない」を具体例で示す
    2. **predictHint をレスポンスに同梱**: ml_list_models 結果に exampleInput を含めて、LLM が正しい呼び方を見れるようにする
    3. **クライアント側サニタイズ**: ml_predict の正規 tool_call 時に派生列を検知 → 元の日付文字列に自動復元してサーバー送信
    4. **Python 側エラー**: それでも派生列が来たら明示エラーで返す (`required_features_to_provide` と `example_correct_input` を含める)

94. **LLM のテキスト形式ツール呼び出し救済**
    Qwen3 系で稀に `sales_yosoku{"date_year": 2026, ...}` のような「ツール呼び出しっぽいテキスト」を返すことがある (本来は `tool_calls` フィールドで返すべき)。3パターンを検出して正規の tool_call に変換:
    - パターンA: `<モデル名>{JSON}` (features キーが含まれていれば ml_predict と判断)
    - パターンB: `ml_predict(modelName='...', features={...})` Python関数風
    - パターンC: JSONコードブロック内に `modelName` と `features` がある
    検出時は派生列も自動復元してから tool_call に変換。

95. **空応答時の救済プロンプト設計**
    ツール呼び出し後の最終応答が空になることがある (Qwen3 系で MAX_TOOL_TURNS=3 に達した後等)。単に「日本語で回答して」と再生成しても運頼みなので、**「分からない時は分からないと言って」「データ不足なら何が足りないか具体的に説明して」「曖昧なら追加情報を質問して」「推測や憶測で答えを作らない」** と明示的に指示する。それでも空ならコード側で固定メッセージにフォールバックして、ユーザーに「データ不足/モデル制約/質問曖昧」の可能性を提示する。

96. **MLプリフィルタで誤発動を物理的に防ぐ**
    ツールの description で「テーブル名/モデル名が明示された時のみ呼べ」と書いても LLM は守らないことがある (特に発話と無関係な雑談時にも `ml_list_datasets` を呼ぶ)。description だけでなく、**クライアント側で ML系ツールを物理的に `tools` 配列から削除** することで、LLM が選択肢にすら持てない状態を作る:
    ```javascript
    if (!hasMetaKeyword && !hasSpecificName) {
      tools = tools.filter(t => !t.function.name.startsWith('ml_'));
    }
    ```
    既存のテーブル名/モデル名を非同期取得してユーザー発話に含まれるかチェック。これで「こんにちは」「Pythonコード書いて」では ML ツールが完全に隠蔽される。

97. **Qwen3.6 35B-A3B[MoE] の `<think>` タグ未閉鎖による独白リーク**
    Qwen3 系 MoE モデルは制御トークンが時々不安定で、`<think>...</think>` の閉じタグを出し忘れて思考 (AI の自己独白) が最終応答に混入することがある。例: `"I will write it now. I will not mention the date. 50mmの場合の答えは115です。"`。**2段階で対処**:
    - ストリーミング中: 11種類の独白パターン (`I (will|won't|need to)`, `The user`, `My (answer|response)`, `Let me think`, `This sounds good` 等) を行単位で検出し、thinking 領域に退避
    - ストリーミング完了後: content が空 + thinking ありの場合、thinking から独白行を除外して残った行 (実応答候補) を content に昇格。全部独白なら固定メッセージ「適切な応答を生成できませんでした」にフォールバック
    システムプロンプト (`systemPrompts.meta`) でも具体例 (❌ "I will..." / ❌ "私はこれから...") を列挙して予防。

98. **外部APIサーバーのツール対応モードはモデルロード保証が必要**
    通常モードでは llama-server を新規プロセスとして起動するため `waitForReady()` で起動完了を待つが、ツール対応モードでは **内部の llama-server を共用** する。起動時に指定モデルがロードされていない (or 別モデル) と、最初のリクエストで失敗する。対処:
    ```javascript
    if (agentMode && chatProcModel !== modelName) {
      log('-', `内部モデルを ${chatProcModel || '(未ロード)'} → ${modelName} に切替`);
      await startChatModel(modelName);  // 完了まで待つ
    }
    ```
    さらにアイドルアンロード後の再リクエスト対応として、agent_proxy 側でも `ensureChatModelLoaded` をポーリングで待つロジックが必要。

99. **`ensureChatModelLoaded` は非同期で起動して即 false を返す設計**
    関数名から「await すれば確実にロード完了する」と誤解しがちだが、実装は「未起動なら起動開始してすぐ `false` を返す」設計。**ロード完了を待つには呼び出し側で 1秒ポーリングが必要**:
    ```javascript
    let ready = await ensureChatModelLoaded();
    while (!ready && Date.now() - startedAt < timeoutMs) {
      await new Promise(r => setTimeout(r, 1000));
      ready = await ensureChatModelLoaded();
    }
    ```
    元設計はチャット用 (プロキシ層で待機) なので問題なかったが、agent_proxy のような同期的に応答するエンドポイントでは明示的にポーリングする必要がある。

100. **Express デフォルトのエラー応答は HTML**
     `express.json()` のパースエラー、未知のパス (404)、未捕捉エラーは、デフォルトハンドラーが HTML を返す。これは Web ブラウザ向けには良いが、**OpenAI 互換 API を提供する場合は JSON で返す必要** がある。3層のハンドラーを明示的に登録:
     ```javascript
     // 1. JSON parse エラー (entity.parse.failed, entity.too.large)
     app.use((err, req, res, next) => {
       if (err.type === 'entity.parse.failed') {
         return res.status(400).json({ error: { ... } });
       }
       next(err);
     });
     // 2. 404 (未知のパス)
     app.use((req, res) => res.status(404).json({ error: { ... } }));
     // 3. 汎用エラー
     app.use((err, req, res, next) => res.status(err.status || 500).json({ ... }));
     ```

101. **`/health` エンドポイントは認証スキップが標準**
     全エンドポイントに認証を適用すると、ロードバランサーや監視ツール (Kubernetes liveness probe 等) が `/health` を叩けない。**認証ミドルウェアの先頭でパススルー** する:
     ```javascript
     app.use((req, res, next) => {
       if (req.path === '/health') return next();  // 認証不要
       // ... Bearer 検証
     });
     ```
     通常モード (llama-server 直接) はそもそも `/health` が無いことに注意。ツール対応モードでは明示的に `/health` を実装。

102. **Windows cmd.exe はシングルクォートをエスケープしない**
     `curl -d '{"messages":[...]}'` が Linux/macOS では動くが、Windows cmd.exe では **シングルクォートが文字列リテラルとして JSON に混入** してパースエラー。**3つの代替手段**:
     - ダブルクォートで内部をエスケープ: `-d "{\"messages\":[...]}"`
     - ファイル化して `@file`: `-d @req.json`
     - PowerShell の `Invoke-RestMethod` または Python `requests` を使う
     curl サンプルを README に載せる時は **OS別に併記** すること。

103. **agent_proxy.js の循環参照を避ける deps オブジェクト**
     `agent_proxy.js` から server.js の関数 (`ddgSearch`, `runMlPredict` 等) を呼びたいが、`require('./server')` すると循環参照で起動失敗する。**deps オブジェクト経由で関数を注入**:
     ```javascript
     // server.js
     const { startAgentServer } = require('./agent_proxy');
     function buildAgentDeps() {
       return { ddgSearch, runMlPredict, getMlDb: () => ..., ... };
     }
     await startAgentServer(opts, buildAgentDeps());

     // agent_proxy.js (server.js は require しない)
     async function startAgentServer(opts, deps) {
       const result = await deps.ddgSearch(query);  // ← deps 経由で呼ぶ
     }
     ```
     これで agent_proxy.js は server.js の関数を「使える」が「依存しない」状態に。

104. **embedding 不在時のRAG機能は多層で自動 OFF**
     embedding サーバーが利用できない (config未設定 or モデルファイル不在) のに RAG ツール (`search_documents`) を有効にしてしまうと、毎回 search が失敗してユーザー体験を損なう。**4層で自動的に無効化**:
     1. **UI**: `GET /external-servers/embedding-available` で利用可否を取得 → 不可なら RAG チェックボックスを `disabled` + 「⚠️ embedding未設定」表示 + 既に ON だったら自動 OFF
     2. **サーバー起動時**: `startExternalServer` で `isEmbeddingAvailable()` をチェック、不可なら `enabledTools` から `rag` を自動除外し、レスポンスに warnings として通知
     3. **API**: `POST /rag/documents`、`POST /rag/search` で事前チェック、不可なら 503 + 理由
     4. **agent_proxy**: 起動時の `enabledTools` から既に除外されているのでツール一覧に出ない
     これで「設定ミスに気づかず外部 API でRAGを使い続けて毎回エラー」というハマりが起こらない。

105. **Python の前処理重複は ml_common.py で集約**
     `ml_runner.py` (学習) と `ml_predict.py` (推論) で同じ前処理ロジック (`classify_dtype`, `expand_datetime_features`, `encode_value`, `parse_datetime`) を実装していると、**学習と推論で挙動がズレるバグの温床** になる。例: 学習時は `bool` をカテゴリ扱い、推論時は数値扱いといった乖離。`ml_common.py` に集約することで一箇所メンテになる:
     ```python
     # ml_runner.py / ml_predict.py 両方で:
     from ml_common import classify_dtype, expand_datetime_features, encode_value, parse_datetime
     ```
     リファクタ後 ml_predict.py は 385行 → 290行 (95行削減)。

106. **`chunkText` の `overlap >= chunkSize` で無限ループ**
     RAG のチャンク分割で、誰かが `chunkText("...", 500, 600)` のように `overlap` を `chunkSize` より大きい値で呼ぶと、`start += chunkSize - overlap` が負になり**永久に進まずブラウザがハング**する。サーバー側も同じバグを持っていた。**ガード**:
     ```javascript
     const safeOverlap = Math.min(overlap, Math.floor(chunkSize / 2));
     ```
     ついでに `if (!text) return []` で null/空文字列ガードも入れる。ブラウザ側とサーバー側で完全に同じ実装にして挙動の乖離を防ぐ。

107. **torchvision の物体検出は追加パッケージ不要・COCO weight 付属**
     物体検出に YOLO (ultralytics) を使うと AGPL ライセンス + 追加依存になる。`torchvision.models.detection` (Faster R-CNN / RetinaNet / SSD) なら **torch/torchvision だけで動き、COCO事前学習 weight も付属**、ライセンスも BSD。少クラスのカスタム学習も `FastRCNNPredictor` でヘッドを付け替えるだけ。本プロジェクトの「依存最小」方針に合致する。

108. **torch のモデルキャッシュ・MIOpenキャッシュは `import torch` より前に環境変数で設定**
     本番が systemd の `ProtectHome` 等で `~/.cache` が読み取り専用だと、torch の weight ダウンロードや AMD ROCm の MIOpen カーネルキャッシュ書き込みが失敗する (`miopenStatusUnknownError`)。`TORCH_HOME` / `MIOPEN_USER_DB_PATH` / `MIOPEN_CUSTOM_CACHE_DIR` をアプリ内の書き込み可能ディレクトリ (`ml/torch_cache`) に、**必ず `import torch` より前**に設定する。gfx1201(RDNA4) でもこれで cuda 動作する。

109. **torch の `Downloading:` メッセージが stdout を汚染して JSON パース失敗**
     torch は weight 初回ダウンロード時に `Downloading: "https://..."` を **stdout に直接 print** する (バージョン依存)。これが検出結果 JSON と混ざり、Node 側のパースが失敗する。「最初だけ」失敗するのが特徴 (2回目以降はキャッシュ済み)。`progress=False` だけでは不足。対策は **処理中の stdout を stderr に退避し、最終結果だけ本物の stdout に書く**:
     ```python
     real_stdout = sys.stdout
     sys.stdout = sys.stderr
     def emit(obj): real_stdout.write(json.dumps(obj)); real_stdout.flush()
     ```
     学習側 (`image_train.py`) は `RESULT_JSON:` プレフィックスで結果行を識別する設計なので、この汚染の影響を受けない。

110. **学習プロセスの停止は `detached:true` + プロセスグループ kill**
     PyTorch 学習は内部でワーカー子プロセスを生成するため、`proc.kill()` で親だけ殺しても子が GPU を握ったまま残る。spawn 時に `detached: true` でプロセスグループを作り、停止時に `process.kill(-pid, signal)` (負の pid) で**グループ全体を kill** する。ファインチューニングと画像学習の両方に適用。

111. **停止時の status 上書き競合 (cancelled → failed)**
     ジョブ停止で `status='cancelled'` にした直後、SIGKILL されたプロセスの `proc.on('exit')` が非0 exit code で発火し、`cancelled` を `failed` に上書きしてしまう。意図的な中断が「失敗」と記録される。`if (j.status !== 'cancelled')` でガードする。画像学習側は `currentImageJob.cancelled` フラグで区別。

112. **サーバー再起動で running ジョブが幽霊化**
     学習中にサーバーが落ちる/再起動すると jobs.json に `status:'running'` が残り、実プロセスは死んでいるのに UI で永遠に「実行中」表示。起動時に `reconcileStaleJobs()` で `running` → `interrupted` に補正する。

113. **全 `spawn` に `proc.on('error')` が必須 (サーバークラッシュ防止)**
     Python のパスが間違っている等で spawn が失敗すると、Node は unhandled 'error' イベントで**プロセス全体をクラッシュ**させる (`ERR_CONNECTION_REFUSED` の原因)。学習・後処理・推論・ログstream のすべての `spawn` に `error` ハンドラを付け、ジョブを 'failed' 記録に留めてサーバーは生かす。

114. **tqdm の `\r` でログが読めなくなる**
     学習ログは tqdm 等が `\r` (キャリッジリターン) で同じ行を上書きするため、そのままファイルに溜めると `\r` が大量に連なって1行が異常に長くなる。書き込み時に `\r\n`→`\n` 統一 + `\r` 上書きは最終セグメントだけ採用、で正規化する。チャンク境界をまたぐ進捗行はバッファ (`logTail`) に残して次チャンクと連結。

115. **アノテーション画像送りで前の矩形が残る (React state)**
     画像切替の useEffect が `currentImage` オブジェクト参照を依存にし、`if (currentImage)` ガードで `setBoxes` をスキップすると、前の画像の矩形が残留する (別画像にアノテーションが混入する危険)。対策は **(1) `gotoImage` で移動先の boxes を即座にセット (useEffectを待たない)、(2) 依存を `currentImageId` (画像ID) にし無条件で setBoxes**。矩形は `{...b}` でコピーし参照共有も防ぐ。

116. **隠しファイル除外は `safeUploadPath` に集約**
     uploads の隠しファイル (`.env` 等) を一覧から消すだけでなく、読み書きも遮断する。一覧の `walk` で `name.startsWith('.')` をスキップし、**`safeUploadPath` でパスの各セグメントが `.` 始まりなら null を返す**。後者がread/write/RAG登録など全経路を一元的にカバーするので、ブラウザ・外部API・LLMツールすべてに自動適用される。

117. **自前 ZIP 生成 (外部 `zip` コマンド非依存)**
     モデルダウンロードで外部 `zip` コマンドに依存すると、本番に未インストールだと 500 エラー。Node 標準の `zlib.deflateRawSync` だけで ZIP を手書き生成する (`buildZipBuffer`)。CRC32 テーブル + ローカルファイルヘッダ + セントラルディレクトリ + EOCD を構築。DEFLATE/STORE 自動選択、UTF-8 ファイル名 (bit11)。一時ファイルも不要でメモリ上で完結するため `/tmp` 制限の影響も受けない。

---

## 🎮 GPU監視バックエンドの設計

LLM サーバー運用で GPU 状態（VRAM 使用量、温度、電力等）を把握することは重要。OpenGeekLLMChat は複数のバックエンドツールを自動検出して透過的に扱う。

### 検出順序と理由

```
1. amd-smi   ← ROCm 6.x以降の新標準 (最優先)
2. rocm-smi  ← レガシー (ROCm 5.x 互換用)
3. nvidia-smi ← NVIDIA 環境
```

`amd-smi` を最優先にする理由:
- 新しい ROCm では `amd-smi` 推奨、`rocm-smi` は将来非推奨
- JSON フォーマットがより構造化されている（型情報・単位明示）
- GPU 製品名・compute unit 数・gfx バージョン等の詳細情報が取れる

### amd-smi の出力構造

```json
{
  "gpu_data": [
    {
      "gpu": 0,
      "asic": {
        "market_name": "AMD Radeon AI PRO R9700",
        "num_compute_units": 64,
        "target_graphics_version": "gfx1201"
      },
      "vram": {
        "size": { "value": 30576, "unit": "MB" }
      },
      "clock": {
        "sys": { "current_frequency": "1040MHz" },
        "mem": { "current_frequency": "96MHz" }
      }
    },
    ...
  ]
}
```

- トップレベルが配列ではなく `gpu_data` でラップされる
- 値が `{ value: 30576, unit: "MB" }` 形式と直接スカラーの両方ある
- クロックは `"1040MHz"` の文字列で、数値抽出が必要

`amd-smi metric --json` で動的なセンサー値（温度・電力・使用率・VRAM使用量）、`amd-smi static --json` で静的情報（GPU名・compute unit 数・VRAM 総容量）を取得する。

### iGPU 自動除外ロジック

APU環境では iGPU（例: Ryzen 9950X 内蔵 Radeon Graphics）も `amd-smi` の出力に含まれるが、LLM 用途では使えない。以下の OR 条件で iGPU と判定して除外:

```javascript
const isIGPU =
  /^gfx10(3[3-9]|4[0-9])/.test(gfxVer) ||  // Phoenix/Raphael/Rembrandt等のAPU
  (numCU > 0 && numCU < 8) ||              // R9700は64CU、iGPUは2CU
  (vramMB > 0 && vramMB <= 4096);          // dGPU≥16GB、iGPU≤2GB
```

dGPU（Discrete GPU）と iGPU で値が明確に違うため、誤検出は起こらない。

### 値の正規化

`amd-smi` の値は型がバラバラなので、ヘルパー関数 `amdVal()` で統一:

```javascript
function amdVal(v) {
  if (v == null || v === 'N/A') return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && v.value != null && v.value !== 'N/A')
    return parseFloat(v.value) || 0;
  return parseFloat(v) || 0;
}
```

これで `temperature.edge: 52`（数値）も `power.current_socket_power: {value: 78, unit: "W"}`（オブジェクト）も同じように `amdVal()` で取得できる。

### フィールド名の差分吸収

`amd-smi` のフィールド名はバージョンによって変わるので、複数候補を `??` でフォールバック:

```javascript
gpu.temp = amdVal(temp.edge ?? temp.edge_temperature);
gpu.tempHotspot = amdVal(temp.hotspot ?? temp.junction ?? temp.hotspot_temperature);
gpu.power = amdVal(power.current_socket_power ?? power.socket_power ?? power.average_socket_power);
```

将来の `amd-smi` で名前が変わっても、新しい名前を `??` チェーンに追加するだけで対応可能。

### llama.cpp バージョンの表示

GPUモニタ上部に、稼働中の `llama-server` のビルド番号・コミットハッシュ（例: `b4589 (abc1234)`）をカード表示する。どのビルドで動いているかを UI から即確認できると、不具合報告・機能差分の切り分けに役立つ。

- **取得タイミング**: 起動時（`server.listen` のコールバック）に `detectLlamaVersion()` を1回だけ実行してキャッシュ。バイナリは本体再起動まで変わらないため、毎秒取得する必要はない
- **取得方法**: `spawn(binPath, ['--version'])` の出力（多くの環境で **stderr** に出る）を読み、`/version:\s*(\d+)\s*(?:\(([0-9a-f]+)\))?/` でビルド番号とコミットを抽出。マッチしなければ最初の非空行を生で保持するフォールバック
- **配信**: 既存の GPU SSE（`buildGpuSseData()`）の host グループに `llamaVersion` フィールドを同梱して配信。新規エンドポイントを増やさず、フロントは `gpuData[].llamaVersion` を読むだけ
- **失敗耐性**: 取得失敗時は `null` のままにし、フロントはカード自体を非表示（GPU未検出環境でも他の表示に影響しない）

---

## 🎨 CSS分離の設計

初期は `index.html` に `<style>` インラインで CSS をすべて持っていたが、ファイルサイズ 6,716 行（177KB）に達したため `styles.css` と `tuning-styles.css` に分離。

### 分離前後の差

| 項目 | Before | After |
|:--|:--|:--|
| `index.html` | 6,716 行 / 177KB | 3,945 行 / 119KB |
| `styles.css` | （なし） | 2,770 行 / 62KB |
| `tuning.html` | 1,295 行 / 49KB | 839 行 / 36KB |
| `tuning-styles.css` | （なし） | 455 行 / 13KB |

### メリット

1. **ブラウザキャッシュ効率**: HTML 更新時に CSS まで再ダウンロードしなくて済む。CSS だけ更新すれば HTML は304返却。
2. **並列ダウンロード**: HTML/CSS/JS がブラウザの並列接続で同時にダウンロードされ、初期表示が高速化
3. **エディタの動作**: 大きい単一HTMLよりシンタックスハイライト・補完が軽快
4. **責務の分離**: CSS編集時にHTML部分で迷子にならない、Git diff も明確
5. **DevTools の体験**: スタイルの行番号が `styles.css:123` のように明示される（以前は `index.html (style):500` のような表示で分かりにくかった）

### 注意点（SPAルーティング対応）

`<link rel="stylesheet" href="/styles.css" />` のように **絶対パス** で参照する。相対パス `styles.css` だと `/chat/<id>` のような深い URL でアクセスした際に `/chat/styles.css` を取りに行って 404 になる。

### Express で配信する

`server.js` には `app.use(express.static('public'))` があるため、`public/styles.css` は自動的に `/styles.css` で配信される。サーバー側のコード追加は不要。

---

## ⚙️ config.json 編集UI とブラウザ再起動の設計

`editconfig.html` は config.json をブラウザから直接編集し、本体プロセスを再起動できる管理画面。SSH で直接 vim する代わりに、認証付きでブラウザ完結で設定を変更できる。

### アーキテクチャ

```
[editconfig.html]
   │  GET  /config/raw          ← config.json 生テキスト
   │  POST /config/raw          ← 保存（バックアップ自動作成）
   │  GET  /config/backups      ← バックアップ一覧
   │  POST /config/restore      ← バックアップから復元
   │  GET  /restart/info        ← systemd下か、PID、uptime
   │  POST /restart             ← 本体プロセス終了
   ▼
[Express server]
   │  ・JSON構文検証
   │  ・必須キー検証 (chatModels, llamaServer)
   │  ・自動バックアップ (最新10件保持)
   │  ・パストラバーサル対策
   │  ・1.5秒待ってから process.exit(0)
   ▼
[systemd]
   │  ・Restart=always
   │  ・RestartSec=3
   ▼
[新プロセス起動 → クライアントがポーリング検知]
```

### 設計判断

#### なぜ raw text で扱うか（パースしたJSON ではなく）

クライアントとサーバー間で JSON をパース→再シリアライズすると、コメントやキー順序・空白が失われる。`config.json` は人間が編集することを前提としたファイルなので、フォーマットを保全するために生テキストで扱う。サーバー側では構文チェックだけして書き込み、保存後は `JSON.stringify(parsed, null, 2)` で正規化する（これは UI 側の「整形」ボタンと同等動作）。

#### なぜ JSON 構文チェックを2段階にするか

- **クライアント側**: 編集中にリアルタイムでパースして赤バナー表示。操作感が良い
- **サーバー側**: POST 時に再度パース・必須キー検証。クライアントを信用しないセキュリティの基本

#### なぜ自動バックアップを10件保持するか

設定ミスでサーバーが起動しなくなった時の「やり直し」が重要。1件だけだと続けて2回失敗すると元に戻せない。逆に無制限にすると徐々に肥大化するので、10件で打ち切り（最古から削除）。各バックアップは元のサイズと同程度（数KB〜10KB）なので、10件で100KB 程度に収まる。

#### なぜ復元時にも現在のconfigをバックアップするか

「やっぱり今のに戻したい」というケースに備える。復元実行時に `config.json.bak.<ts>-before-restore` の名前で現在を保存。これも10件保持に含まれるので最終的には消える。

### 再起動の仕組み

#### systemd 任せ方式の選択理由

ブラウザから本体を再起動する方法は3つあった:

| 方式 | 説明 | 採否 |
|:--|:--|:--:|
| A. `process.exit()` + systemd | systemd の `Restart=always` が自動復帰 | ✓ **採用** |
| B. `sudo systemctl restart` | 子プロセスから systemctl 実行 | ✗ |
| C. 子プロセスで自己再起動 | spawn で nodeを起動、親終了 | ✗ |

**A を採用した理由**:
- 追加権限不要（sudo 不要、sudoers 設定なし）
- セキュリティ的にシンプル（外部コマンド実行なし）
- 既存の systemd 管理下のままなのでログ・状態管理も従来通り
- 監査ログがクリーン（journalctl で「restart requested」が見える）

**B/C を不採用にした理由**:
- B: `NOPASSWD: systemctl restart` を sudoers に書く必要があり、web経由で sudo は監査グレー
- C: 親プロセスのファイルディスクリプタ・ポートを子に正しく渡すのが複雑、デタッチ失敗で2重起動の事故も起きやすい

#### systemd 下かどうかの判定

```javascript
const isSystemd = !!process.env.INVOCATION_ID;
```

`INVOCATION_ID` は systemd が必ず子プロセスに付与する UUID 環境変数。これがあれば systemd 下と確実に判定できる。`SYSTEMD_EXEC_PID` や `MANAGERPID` でも判定可能だが、`INVOCATION_ID` が最も広範囲のバージョンで動作する。

#### 再起動完了のクライアント検知

```javascript
async function pollUntilBack() {
  await sleep(2000);                 // プロセス終了を待つ
  let consecutiveOk = 0;
  while (timeLeft) {
    try {
      const r = await fetch('/restart/info');
      if (r.ok) {
        const data = await r.json();
        if (data.uptime < 30) {       // 新プロセスの目印
          consecutiveOk++;
          if (consecutiveOk >= 2) return done();  // 連続2回で確定
        }
      }
    } catch {
      consecutiveOk = 0;              // 接続エラー → まだ起動中
    }
    await sleep(1000);
  }
}
```

ポイント:
- 最初の2秒は何もしない（古いプロセスがまだ生きているため）
- 接続エラーは「再起動中」と解釈（カウンタをリセット）
- `uptime < 30秒` を新プロセスの目印に使う（systemd で再起動された後の typical な値）
- 連続2回成功で確定（一時的な復旧と確実な復活を区別）
- 60秒タイムアウト（万一 systemd が起動失敗した場合のエラー通知）

### サイドバー左下の設定アイコン

UX的に「設定」へのアクセスは目立ちすぎず・隠しすぎず難しい。OpenGeekLLMChatでは:

- **位置**: サイドバー左下（`margin-top: auto` で押し下げ）
- **サイズ**: 11px、padding 8px 12px、グレー文字
- **状態**: 通常時は薄く、ホバー時にアクセントカラー＋歯車アイコンがゆっくり回転
- **アイコン**: SVG をインラインで埋め込み（Feather Icons の歯車）

ホバー時の `animation: spin-slow 4s linear infinite;` で「クリック可能で何か起きそう」を視覚的に伝える。

なお `tuning.html` / `ml.html` も同じ歯車「⚙ 設定」ボタンを持ち、`editconfig.html` へ遷移できる（スタイルは共通の `tuning-styles.css` の `.sidebar-settings-btn`）。各管理画面間のナビゲーションを統一する狙い。

### HuggingFace GGUF モデルのワンボタン導入

設定画面から「HuggingFace の GGUF リンク → ダウンロード → `chatModels` 登録」までを1ボタンで完結させる。SSH でモデルを `wget` して config.json を手で書く手間を、ブラウザ操作に置き換える。

```
[editconfig.html]
   │  POST /config/model-download          ← { url, name?, ctx?, ngl?, mmprojUrl?, hfToken? }
   │     → 即 jobId を返し、ダウンロードはバックグラウンド実行
   │  GET  /config/model-download/status   ← 1秒間隔ポーリングで進捗取得
   ▼
[Express server: modelDownloadJob（単一ジョブ）]
   │  1. normalizeHfUrl(): /blob/ → /resolve/ 変換、huggingface.co 限定
   │  2. getModelsDir(): 既存モデルと同じフォルダを自動検出
   │  3. downloadToFile(): リダイレクト追従 + 進捗コールバック、.part に書いて完了時 rename
   │  4. (任意) mmproj も同様にダウンロード
   │  5. addModelToConfig(): config.json をバックアップ後、chatModels に追記/上書き
   ▼
[フロント: 完了検知 → loadConfig() でエディタ更新 → 「本体を再起動」で反映]
```

#### 設計判断

- **進捗はサーバー側 `modelDownloadJob` にキャッシュ、フロントはポーリング**: SSE でも実装できるが、GGUF は数GB単位で長時間かかるため「ページを再読込しても進捗を復帰できる」ことを優先。状態をサーバーに1つ持ち、`GET /status` で誰が見ても同じ進捗を返す方式にした。フロントは初期ロード時に `status` を見て `downloading` なら表示を復帰する
- **同時実行は1件に制限**: 帯域とディスクの観点から、`downloading` 中の再投入は 409 を返す
- **リダイレクト手動追従**: Node の `http/https.get` は 30x を自動追従しないため、`Location` を辿る再帰実装（最大8回）。HF の `resolve` は CDN（`cdn-lfs...`）の署名URLへリダイレクトする
- **認証トークンはホスト限定**: `Authorization: Bearer` を付けるのは `huggingface.co` 宛のみ。CDN 署名URLにトークンを送らない（署名はクエリに含まれるため不要、かつ情報漏洩防止）
- **`.part` → rename**: ダウンロード中は `xxx.gguf.part` に書き込み、`fs.renameSync` で確定。中断時に壊れた `.gguf` が残らない（同一FS内の rename はアトミック）
- **保存先の自動決定 `getModelsDir()`**: `chatModels[].path` の dirname（実在する最初のもの）→ `embeddingModel.path` の dirname → なければ `<__dirname>/models`。既存モデルと同じ場所に揃え、無ければ `mkdir -p`
- **登録は既存の保存ロジックを再利用**: `addModelToConfig()` も config.json バックアップ（最新10件保持）を行うため、`POST /config/raw` と一貫した安全性。同名/同パスのエントリは上書き（再ダウンロード時の重複を防ぐ）
- **反映はあえて即時にしない**: 書き込むのは config.json のみで、稼働中の `chatModels`（メモリ）は触らない。既存の「設定変更は本体再起動で反映」というモデルに合わせ、ユーザーが明示的に「🔄 本体を再起動」するまで現行プロセスに影響を与えない

#### 入力検証

- `huggingface.co`（およびサブドメイン）以外のホストは拒否（任意URLからの取得＝SSRF・任意ファイル取得を防ぐ）
- 拡張子 `.gguf` 必須。`https` 限定
- ファイル名は URL パスの `basename` のみ採用（保存先は常に `getModelsDir()` 配下なのでパストラバーサル不可）

### セキュリティ考慮

- **認証必須**: 全エンドポイント `requireAuth`、Cookie 共有
- **入力検証**: JSON構文 + 必須キー + パストラバーサル対策。モデルDLは huggingface.co + `.gguf` 限定
- **`password` ハッシュも表示される**: editconfig.html を見る = 実質admin。複数人運用時は別ロール検討
- **再起動権限の集中**: 設定編集者 = サーバー再起動権限を持つ。これは意図的なシンプル設計

---

## 🎨 画像生成機能の設計

LLMが `generate_image` ツールを呼ぶことで、チャット欄に画像を生成・表示する。stable-diffusion.cpp の `sd-server` を子プロセスとして管理し、内部HTTPで通信する。

### アーキテクチャ

```
[ブラウザ: チャット入力 "猫の絵を描いて"]
       │
       ▼
[LLM (llama-server)]
       │  tool_calls: [{ name: "generate_image", args: {...} }]
       ▼
[クライアント React]
       │  POST /image-gen
       ▼
[Express server]
       │  startImageModel() ── オンデマンドで sd-server を spawn
       │                       │
       │                       ▼
       │  POST http://127.0.0.1:7860/sdapi/v1/txt2img
       │                       │
       │  [sd-server プロセス] ◀┘ (stable-diffusion.cpp)
       │       │
       │       ▼
       │  ROCm/CUDA GPU で推論
       │       │
       │       ▼
       │  Base64 PNG をレスポンス
       ▼
[Express]
       │  Base64 デコード → public/uploads/sd_<ts>_<rand>.png に保存
       │  URLリストを返却
       ▼
[クライアント]
       │  apiMessages に tool結果として「[[gen_image:URL|prompt]]」マーカー入りで追加
       ▼
[LLM 最終応答ストリーミング]
       │  「ご依頼通り猫の絵を生成しました。[[gen_image:...]]」
       ▼
[MarkdownContent] → 正規表現でマーカーを検出 → <GeneratedImage> コンポーネントで描画
```

### なぜ Markdown `![]()` ではなくカスタムマーカー `[[gen_image:URL|prompt]]` か

ツール結果に画像URLを `![生成画像](/uploads/xxx.png)` のような Markdown 画像構文で渡すと、LLMが応答生成時に**親切に書き換えてしまう**ことがある:

- alt textを「美しい猫の絵」のように書き換え (まだ無害)
- URLを「正規化」して `./uploads/xxx.png` のような相対パスに変更 → 表示崩れ
- そもそも画像構文を文章中に混ぜず、別途リンクとして提示
- LLMの「修正癖」で `(uploads/xxx.png)` のように `/` を削る

これを防ぐため、**LLMにとって明らかに「触ってはいけない」形式**であるカスタムマーカーで返す:

```
[[gen_image:/uploads/sd_1234_abc_0.png|encoded_prompt]]
```

ツール返信に「このマーカーは画像表示用なので改変せずそのまま含めてください」と明示指示することで、LLMはマーカーをそのままコピペする。クライアント側の `MarkdownContent` は、Markdown レンダリング前に正規表現でマーカーを検出して、その部分だけ専用Reactコンポーネント `<GeneratedImage>` に置き換える。

### なぜオンデマンドロード + アイドルアンロード設計か

VRAM が限られる環境（特にチャット用 llama-server と GPU 共有する場合）では、画像生成モデル（SDXL: 約8GB）を常駐させると競合する。

設計判断:
- **オンデマンドロード**: 最初の `generate_image` 呼び出し時にのみ `sd-server` を起動。起動コストは ~10秒だが、使わない時は VRAM 0
- **アイドルアンロード** (`idleUnloadMs`): 一定時間（デフォルト10分）使われなければプロセス終了して VRAM 解放
- **モデル切替**: 別モデルが指定されたら現プロセスを kill して新モデルで再起動

llama-server の同じパターン (`chatProc`, `chatLastActivity`, `checkIdle`) を再利用。

### sd-server プロセス管理

```javascript
let sdProc = null;
let sdCurrentModel = null;
let sdProcStarting = false;
let sdLastActivity = Date.now();

async function startImageModel(modelName) {
  if (sdProcStarting) throw new Error('既に起動処理中');
  sdProcStarting = true;
  // 重要: 起動開始時に sdLastActivity をリセット
  // これを忘れると、前回終了から時間が経過した状態で起動した時に
  // 起動中のアイドルチェックで誤判定されて即 kill される (罠 80)
  sdLastActivity = Date.now();
  await stopImageModel();
  const proc = spawn(sdConfig.binPath, args, { env: { ...process.env, ...sdConfig.env } });
  sdProc = proc;
  // exit ハンドラはクロージャでこの proc を保持。新プロセスに切り替わった後に
  // 古いプロセスの exit イベントが来ても sdProc を誤って null にしない
  proc.on('exit', () => { if (sdProc === proc) sdProc = null; });
  // sd-server には /health がないので TCP 接続だけで判定 (罠 78)
  await waitForTcpReady('127.0.0.1', port, readyTimeoutMs);
  sdCurrentModel = modelName;
}
```

llama-server との違い:
- llama-server: `/health` エンドポイントで起動確認
- sd-server: **`/health` が存在しない** → TCPソケット接続できるかだけで判定する `waitForTcpReady()` を使う

### sd-server のオプションと罠

stable-diffusion.cpp の `sd-server` は llama-server とコマンドライン体系が違う:

| 用途 | llama-server | sd-server |
|:--|:--|:--|
| ホスト | `--host` | `--listen-ip` |
| ポート | `--port` | `--listen-port` |
| モデル | `-m` / `--model` | 同じ |
| 起動完了判定 | `GET /health` | TCP接続成功 |
| API | OpenAI互換 `/v1/...` | AUTOMATIC1111互換 `/sdapi/v1/...` |
| 進捗ログ | stderr経由 | stdout/stderr 両方（quietで抑制すると判別不能） |

特に `--port` は sd-server では `--prompt` の短縮形 `-p` と衝突するので、明示的に `--listen-port` を使う必要がある。

### AUTOMATIC1111 互換 API

`sd-server` は ComfyUI互換ではなく、AUTOMATIC1111互換 API を実装している。ただし**完全互換ではなく、互換性が低い**。実体験上、以下の最小限のパラメータが最も安定:

```javascript
POST http://127.0.0.1:7860/sdapi/v1/txt2img
Content-Type: application/json
{
  "prompt": "a cute cat",
  "width": 1024,
  "height": 1024,
  "steps": 20,
  "batch_size": 1,
  "n_iter": 1
}
```

`sampler_name` / `cfg_scale` / `seed` / `negative_prompt` を**明示指定すると 500 エラー (`generate_image returned no results`) で失敗することがある** (罠 79)。これらは必要に応じて条件付きで追加する設計が良い:

```javascript
const sdBody = { prompt, width, height, steps, batch_size: 1, n_iter: 1 };
if (negativePrompt) sdBody.negative_prompt = negativePrompt;
if (cfgScale > 0) sdBody.cfg_scale = cfgScale;
if (seed !== -1) sdBody.seed = seed;
// sampler_name は省略推奨（デフォルトに任せる）
```

レスポンス:
```json
{
  "images": ["<base64 PNG>"],
  "parameters": {...},
  "info": "..."
}
```

レスポンスの `images[0]` は Base64 エンコードされたPNG。`Buffer.from(b64, 'base64')` でデコードして `fs.writeFileSync()` で保存する。

### GeneratedImage コンポーネントの設計

```
┌───────────────────────────────┐
│ ┌─────────────────────────┐   │ ← サムネイル (256x256)
│ │   <img loading="lazy">  │   │   クリックでライトボックス
│ │   object-fit: contain   │   │
│ └─────────────────────────┘   │
│ 📝 a cute orange cat...        │ ← プロンプト (2行省略)
│ [🔍 拡大] [💾 保存] [📋 プロンプト] │
└───────────────────────────────┘
```

実装ポイント:
- **`loading="lazy"`**: 画面外の画像は遅延読み込み。長い会話で複数枚生成しても初期表示が軽い
- **ライトボックス**: `position: fixed; inset: 0` でビューポート全体を覆う。クリックで閉じる
- **ダウンロード**: `<a download>` 属性 + DOM挿入クリックで強制ダウンロード（同一オリジンなのでCORSなし）
- **プロンプトコピー**: `navigator.clipboard.writeText()` で1.5秒「✓ コピー済」表示

### 設定例 (config.json)

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
    "path": "/.../sd_xl_base_1.0.safetensors",
    "vae": "/.../sdxl_vae.safetensors",
    "extraArgs": []
  }
]
```

`HIP_VISIBLE_DEVICES=0` で 1枚目の R9700 だけを画像生成に使う設定。残りは llama-server に渡せる。

### セキュリティ・運用考慮

- **認証必須**: `/image-gen` 系は全て `requireAuth`
- **batch_count制限**: 1回のリクエストで最大4枚まで（DoS防止）
- **タイムアウト**: 3分（大きいモデルでも対応、それ以上はクラッシュとみなす）
- **生成画像の置き場**: `public/uploads/` （既存のファイル操作と共通、UIから一覧・削除可能）
- **ファイル名**: `sd_<timestamp>_<random>_<index>.png` でほぼ衝突しない

---

## 🧠 ファインチューニング機能の設計

OpenGeekLLMChat 内蔵のファインチューニング機能 (`tuning.html`) は、LoRA SFT による軽量ファインチューニングをUIから操作できる仕組み。実装上重要な設計判断と、ナレッジから学んだ実体験ベースの選択を記述。

### アーキテクチャ

```
[ブラウザ: tuning.html]
   │
   ├─ サンプル管理（CRUD, CSV/JSONLインポート/エクスポート）
   ├─ 学習開始（プリセット選択 + ハイパラ調整）
   └─ ジョブ管理（一覧・ログストリーミング・後処理）
        │
[Express: /tuning/* API]
   │
   ├─ tuning/samples.jsonl         ← 学習データDB（JSONLファイルベース）
   ├─ tuning/jobs.json             ← ジョブ履歴メタデータ
   └─ tuning/runs/<job_id>/        ← ジョブごとの作業ディレクトリ
        ├─ config.json             ← この学習の設定スナップショット
        ├─ train.jsonl             ← 学習データスナップショット
        ├─ training.log            ← Pythonの stdout/stderr
        ├─ postprocess.log         ← マージ・GGUF変換・量子化ログ
        ├─ adapter/                ← 学習済みLoRAアダプタ
        ├─ merged/                 ← マージ済みフルモデル
        └─ model-*.gguf            ← GGUF変換・量子化結果
        │
[child_process.spawn: Python]
   │
   ├─ tune_runner.py               ← TRL SFTTrainer (LoRA学習本体)
   ├─ merge_adapter.py             ← PeftModel.merge_and_unload()
   └─ convert_to_gguf.py           ← llama.cpp の convert_hf_to_gguf.py を呼ぶ
        │
[llama.cpp]
   │
   ├─ convert_hf_to_gguf.py        ← HF → GGUF (F16)
   └─ build/bin/llama-quantize     ← GGUF量子化 (Q4_K_M等)
```

### 設計判断の理由

#### なぜ JSONL ファイルで管理するか（SQLite ではなく）

- 依存ゼロ（追加パッケージ不要、`fs` だけで完結）
- 数千件規模なら全件読み込みでも十分速い
- ユーザーが直接 `samples.jsonl` を編集できる（Git管理しやすい）
- バックアップが `cp` だけで済む

#### なぜ tune_runner.py を別プロセスで spawn するか

- Node.js は GIL のない非同期I/O向き、CPU/GPU重い処理は子プロセスに分離
- 学習が落ちても本体サーバーに影響しない
- ログを `stdout` / `stderr` で取得して UI にストリーミング可能
- Python venv の分離（本体用とは別venv が必要）

#### なぜ tune_runner.py 内でマージまでやるか

- ベースモデルがメモリに乗っている間にマージすると VRAM 効率が良い
- ユーザーがUIから「📦 後処理」を別途実行する場合は merge_adapter.py で再マージできる（保険）

#### なぜ後処理を別エンドポイントにしたか

- マージ→GGUF→量子化は時間がかかる（数分〜数十分）
- 学習とは別タイミングで何度でも試せる（量子化レベルを変えて再生成など）
- Python venv が学習用と GGUF変換用で別 (`venv-tuning` vs `.venv-llama`) のため、別プロセスのほうが安全

### config.json の `tuning` セクション

```json
"tuning": {
  "pythonPath": "/path/to/venv-tuning/bin/python",
  "llamaCppDir": "/path/to/llama.cpp",
  "env": {
    "HSA_OVERRIDE_GFX_VERSION": "12.0.1",
    "PYTORCH_HIP_ALLOC_CONF": "expandable_segments:True",
    "HIP_VISIBLE_DEVICES": "0"
  },
  "modelPresets": [
    { "value": "Qwen/Qwen2.5-0.5B-Instruct", "size": "0.5B", "vramLora": "~4GB", "desc": "...",
      "epochs": 5, "lr": 0.0002, "batch": 2, "accum": 4, "r": 8, "alpha": 16, "maxLen": 2048 }
  ]
}
```

| キー | 役割 |
|:--|:--|
| `pythonPath` | tune_runner.py 用 Python（PyTorch ROCm版が入った venv 推奨） |
| `llamaCppDir` | llama.cpp のクローン先（GGUF変換・量子化に使用） |
| `env` | tune_runner.py 実行時に渡す環境変数。ROCm環境の安定化 |
| `modelPresets[]` | UI に表示されるプリセット。プリセットを選ぶとハイパラも自動入力 |

プリセットは **UIに固定で埋め込まず config 経由で配信** する。`GET /tuning/presets` でクライアントが取得し、必要に応じてカスタマイズや追加が可能。

### tune_runner.py の重要ポイント（ナレッジ反映）

```python
# 1. torch_dtype は deprecated、dtype= に統一
model = AutoModelForCausalLM.from_pretrained(
    base_model,
    dtype=torch.bfloat16,
    attn_implementation="eager",   # ROCmではsdpaが不安定
    trust_remote_code=True,
)
model = model.to("cuda")           # device_map="auto" は避ける

# 2. TRL SFTTrainer + SFTConfig (新しいAPI、processing_class=tokenizer)
training_args = SFTConfig(
    output_dir=output_dir,
    num_train_epochs=epochs,
    bf16=True,
    gradient_checkpointing=True,
    max_length=max_seq_length,
    dataset_text_field="text",
    packing=False,
)

trainer = SFTTrainer(
    model=model,
    args=training_args,
    train_dataset=dataset,
    peft_config=peft_config,
    processing_class=tokenizer,    # TRL 0.12+ では tokenizer= ではなく processing_class=
)

# 3. LoRA target_modules は 7種すべて指定（軽量モデルでも効果向上）
peft_config = LoraConfig(
    r=16, lora_alpha=32,
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                    "gate_proj", "up_proj", "down_proj"],
    task_type="CAUSAL_LM",
)
```

### マルチターン対応

サンプル形式を2系統サポート:

**シングルターン（簡易）:**
```json
{"instruction": "宮城県の県庁所在地は?", "response": "仙台市です。"}
```

**マルチターン（messages, OpenAI形式）:**
```json
{"messages": [
  {"role": "system", "content": "..."},
  {"role": "user", "content": "..."},
  {"role": "assistant", "content": "..."}
]}
```

`to_messages()` 関数で両形式を `messages` 形式に統一してから `tokenizer.apply_chat_template()` に通す。chat_template が無いモデルは Alpaca 形式にフォールバック。

### 後処理パイプライン

UIで「📦」ボタン → POST `/tuning/jobs/:id/postprocess`

```
1. (任意) tune_runner.py 終了時に既にマージ済みなら skip
   または merge_adapter.py で再実行

2. python convert_hf_to_gguf.py <merged_dir> --outfile model-F16.gguf --outtype f16
   → F16 中間GGUFを生成

3. llama-quantize model-F16.gguf model-Q4_K_M.gguf Q4_K_M
   → 量子化版を生成
```

各ステップのログは `postprocess.log` にリアルタイム書き込み、UIから取得可能。

### UIの工夫

#### タブ間状態保持（display切替）

React の条件分岐レンダリングは unmount で state を破棄するため、入力中の値が消える。

```jsx
// Bad: タブ切替でTrainingViewのstate全消去
{tab === 'training' && <TrainingView />}

// Good: 常にマウント、表示だけ切替
<div style={{display: tab === 'training' ? 'block' : 'none'}}>
  <TrainingView />
</div>
```

これでハイパラを設定中に「📚 学習データ」タブで内容確認しても、設定値が消えない。

#### モデルサイズ別の量子化推奨表示

PostProcessDialog で量子化レベル選択時、モデル名からサイズを推測して推奨を表示:
- 0.5B〜1.5B → **F16 / Q8_0 推奨**（強い量子化は知識劣化）
- 7B以上 → **Q4_K_M 推奨**

ナレッジに基づく実体験から、ユーザーが誤って小型モデルを Q4_K_M で破壊するのを防ぐ。

### サーバー設定要件

ファインチューニング機能を使うには、本体とは別の準備が必要:

1. **venv-tuning**: PyTorch ROCm/CUDA、transformers、peft、trl、datasets、accelerate
2. **llama.cpp ビルド済み**: convert_hf_to_gguf.py + build/bin/llama-quantize
3. **llama.cpp用 venv** (`.venv-llama`): convert スクリプトの依存（torch を除外して入れる）
4. **config.json の tuning セクション**: pythonPath, llamaCppDir, env, modelPresets
5. **systemd の Environment=**: 環境変数 HSA_OVERRIDE_GFX_VERSION 等を本体プロセスにも渡す
6. **HF_HOME**: モデルダウンロード先（容量に余裕のあるディスクに）
7. **HF_TOKEN**（任意）: Llama 等の gated model を使うとき

詳細手順は README.md の「🧠 ファインチューニング機能」セクションを参照。

---

## 🤖 機械学習 (ML) 機能の設計

`/ml.html` 配下で、データテーブル管理・SQL分析・PyTorch学習・推論を統合提供。LLM チャットからは5つのMLツール経由でも利用可能。

### サイドバーの統計表示

各タブの中身は別コンポーネント（`ModelTrainView` / `ImageTrainView` / `RLView`）が自分のデータを持つが、サイドバーには横断的な件数サマリを出したい。そこでトップの `App` が認証後に `loadStats()` を実行し、4エンドポイントを `Promise.all` で並列取得して件数だけを保持する。

- 🧠 モデル数 = `/ml/models` の `models[]`
- 🖼️ 画像データセット = `/ml/image/datasets` の `datasets[]` / 画像学習モデル = `/ml/image/custom-models` の `models[]`
- 🎮 強化学習エージェント = `/ml/rl/models` の `models[]`

各取得は `try/catch` で失敗を 0 に丸め、1つのエンドポイントが落ちても他の件数表示を止めない。重い処理ではないが、件数は概況把握用なので取得は画面表示時の1回（学習直後に即時更新したい場合はリロード）。

### 全体アーキテクチャ

```
┌─────────────────────────────────────────────────────────┐
│ Browser (React SPA)                                       │
│   /ml.html (4タブ): データテーブル / SQL / モデル / API     │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTP (Cookie or Bearer Token)
                       ▼
┌─────────────────────────────────────────────────────────┐
│ Node.js (server.js)                                       │
│  - /ml/datasets/* : テーブルCRUD、CSV/API インポート       │
│  - /ml/query : 読み取り専用 SQL 実行                       │
│  - /ml/models/* : モデル定義/学習/推論/メトリクス           │
│  - /ml/jobs/* : 学習ジョブ管理                            │
│  - /api-tokens/* : 外部API用トークン管理                   │
└──────┬────────────────────────────────────────┬─────────┘
       │                                        │
       ▼ npm duckdb (Node binding)              ▼ child_process spawn
┌────────────────────┐              ┌──────────────────────────────┐
│ DuckDB (file)      │              │ Python (ml_runner.py /        │
│ ml/datasets.duckdb │              │         ml_predict.py)        │
└────────────────────┘              │  - DuckDB (read-only)        │
       ▲                            │  - pandas / scikit-learn      │
       │ 学習時のみ排他ロック       │  - PyTorch (CUDA/ROCm)        │
       │ (Node が CHECKPOINT+close)│  - 学習時: model.pt 等を保存  │
       │                            │  - 推論時: state_dict ロード  │
       └────────────────────────────┘
```

### ファイル配置

```
ml_runner.py            # 学習スクリプト (subprocess、入力: config.json パス)
ml_predict.py           # 推論スクリプト (subprocess、入力: stdin JSON)

ml/                     # 自動生成ディレクトリ
├── datasets.duckdb     # DuckDB データ本体 (全テーブル統合)
├── meta.json           # テーブル説明・取得元URL・importedFrom等
├── models.json         # モデル定義一覧 (UI で編集可能)
├── jobs.json           # 学習ジョブ履歴
└── models/<name>/      # 学習成果物 (モデル単位のディレクトリ)
    ├── config.json     # 学習時の全設定 + 派生情報 (推論で必要)
    ├── model.pt        # PyTorch state_dict (weights_only=True で読む)
    ├── scaler.pkl      # StandardScaler: mean, scale, target_mean, target_scale
    ├── label_encoders.pkl  # カテゴリ列の classes_ マップ
    ├── metrics.json    # 学習指標 + 履歴 (UI でグラフ表示用)
    └── train.log       # 学習ログ (UIで参照)
```

### データテーブル設計

#### DuckDB 採用理由

- **高速な列指向 OLAP**: SQL 集計が SQLite より圧倒的に高速
- **CSV/JSON/Parquet 直接読み込み**: `read_csv_auto`, `read_json_auto` が型推論まで自動
- **DuckDB方言**: window 関数、CTE、`EXTRACT(month FROM date)` 等の便利機能
- **Python/Node.js 両対応**: 同じファイルを両言語から読み書き可能 (排他ロック調停は必要)
- **書き込みトランザクション**: ACID 準拠
- **メモリ効率**: 数百万行でも数十MB 程度に収まる (圧縮効果)

#### テーブル名検証

```javascript
// SQLインジェクション対策 + DuckDB の安全な識別子
function isValidTableName(name) {
  return /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name)
    && !RESERVED_SQL_KEYWORDS.includes(name.toLowerCase());
}
// 英字始まり + 英数字/_/ 64文字以内 + SQL予約語禁止
```

#### 読み取り専用 SQL 判定

`isSafeReadOnlySql()`:
1. セミコロンは末尾1つのみ許容 (複文禁止)
2. 先頭が `SELECT` または `WITH` のみ
3. 禁止キーワード正規表現: `insert|update|delete|drop|create|alter|attach|copy|export|import|truncate|grant|revoke|pragma|set|call|execute|prepare`
4. LIMIT 無しは自動で `LIMIT 1000` 付与

#### CSV インポート

```javascript
// 一時ファイルに書き出し → DuckDB の read_csv_auto で取り込み
fs.writeFileSync(tmpFile, csvContent);
await mlExec(`CREATE TABLE "${tableName}" AS SELECT * FROM read_csv_auto('${tmpFile}')`);
```

型は DuckDB が自動推論 (DATE, INTEGER, VARCHAR等)。

#### Web API インポート

```
POST /ml/datasets/import/api
body: {
  tableName, url, method, headers, body,
  jsonPath,  // ドット記法で配列の位置を指定 (例: "data.items")
  mode,      // "replace" or "append"
  allowPrivateNetwork  // SSRF対策バイパス
}
```

処理フロー:
1. URL から JSON 取得 (10MB 上限、30秒タイムアウト、リダイレクト追わない)
2. SSRF対策: localhost / 10.x / 192.168.x / 172.16-31.x / 169.254.x / IPv6 link-local を判定してデフォルト拒否
3. JSON パース → `jsonPath` で配列抽出
4. 各オブジェクトを `flattenObject()` でフラット化 (`{user: {name: "x"}}` → `{"user.name": "x"}`)
5. NDJSON 形式の一時ファイルに書き出し
6. `read_json_auto('file.json', format='newline_delimited')` で取り込み

注意: DuckDB の `read_json_auto` は `format='newline_delimited'` を明示しないと「ファイル全体が1つのJSON」と解釈されてエラーになる。

### 学習エンジン (ml_runner.py) の設計

#### 「機械学習」の呼称と実体 (深層学習)

本機能は UI・ドキュメントとも「機械学習 (ML)」と呼称しているが、学習エンジンの実体は **PyTorch によるニューラルネットワーク = 深層学習 (Deep Learning)** である。

```
機械学習 (Machine Learning) ← 本機能の呼称 (上位概念)
  ├─ 古典的ML (決定木、SVM、線形回帰、ランダムフォレスト...) ← 未実装
  └─ 深層学習 (Deep Learning) ← 本機能の実体
       ├─ MLP (多層パーセプトロン)  → 回帰・分類タスクで使用
       └─ LSTM (リカレントNN)        → 時系列タスクで使用
```

深層学習は機械学習の一分野なので「機械学習」という呼称は上位概念として正確。あえて広い呼称を選んだ理由:

1. **一般ユーザーへの分かりやすさ**: 「深層学習」は技術者向けの響きが強く、「機械学習」の方が広く通じる
2. **将来の拡張余地**: 古典的ML (scikit-learn の RandomForestRegressor 等、ニューラルネットを使わない手法) を追加しても名称を変えずに済む。小規模データ (数百行) では MLP より古典的MLが適することも多く、タスク種別に `random_forest` 等を足す余地を残している
3. **タスク抽象化**: ユーザーは「回帰/分類/時系列」というタスクで考え、内部アルゴリズム (MLP/LSTM/RF) は実装詳細として隠蔽できる

なお、現状の全タスク (回帰・分類・時系列) が深層学習で実装されている点は、データ規模が大きい場合 (数千〜数万行) には適切だが、極小データ (数十〜数百行) では過学習リスクがあるため、Dropout (0.1) と train/test 分割で対策している。

#### タスク別アーキテクチャ

```python
# Regression: MLP
class MLPReg(nn.Module):
    def __init__(self):
        layers = []
        for _ in range(num_layers):
            layers += [nn.Linear(in_d, hidden_size), nn.ReLU(), nn.Dropout(0.1)]
        layers.append(nn.Linear(hidden_size, 1))
        self.net = nn.Sequential(*layers)
    def forward(self, x):
        return self.net(x).squeeze(-1)

# Classification: MLP (出力次元 = num_classes)
class MLPCls(nn.Module):
    ...
    layers.append(nn.Linear(hidden_size, num_classes))

# Time Series: LSTM
class LSTMModel(nn.Module):
    def __init__(self):
        self.lstm = nn.LSTM(input_dim, hidden_size, num_layers, batch_first=True)
        self.fc = nn.Linear(hidden_size, 1)
    def forward(self, x):
        out, _ = self.lstm(x)
        return self.fc(out[:, -1, :]).squeeze(-1)
```

#### 自動前処理パイプライン

1. **dtype 判定**: `classify_dtype()` で `datetime` / `category` / `numeric` を判定
   - `'object'`, `'category'`, `'str'`, `'string'`, `'bool'`, `'boolean'` → カテゴリ
   - `'datetime'`, `'timestamp'`, `'date'` → 日時 (自動分解)
   - その他 → 数値

2. **日時列の自動分解**: 6特徴量に展開
   ```python
   DATETIME_FEATURES = ['year', 'month', 'day', 'dayofweek', 'dayofyear', 'is_weekend']
   df[f'{col}_year'] = df[col].dt.year
   df[f'{col}_month'] = df[col].dt.month
   # ...
   ```
   元の日時列は学習特徴量から除外。展開情報は config.json に保存 (推論時の再現用):
   ```json
   {
     "originalFeatures": ["date", "region", "product", "quantity"],
     "expandedFeatures": ["date_year", "date_month", ..., "region", "product", "quantity"],
     "datetimeSourceCols": ["date"]
   }
   ```

3. **カテゴリ列**: LabelEncoder で integer 化 → classes_ を pickle 保存

4. **数値列**: `astype('float64')` で強制変換 (DuckDB の Decimal 型対策)

5. **StandardScaler**: 特徴量に対して標準化

6. **ターゲットスケーリング** (回帰/時系列):
   ```python
   target_scaler = StandardScaler()
   y = target_scaler.fit_transform(y_raw.reshape(-1, 1)).flatten()
   ```
   学習時の MSE loss を 1e+08 オーダーから 1.0 オーダーに正規化、推論時は逆変換。

#### DuckDB ロック調停

DuckDB 1.x は1プロセス排他ロック方式。Node が DB を開いた状態で Python が `read_only=True` で開こうとしても `Conflicting lock` エラーになる。

調停の流れ:

```
1. ユーザーが「▶ 学習開始」クリック
   POST /ml/jobs/start
       ↓
2. Node 側:
   await mlExec('CHECKPOINT')         # WAL を本体に統合
   await _mlDbConn.close()             # 接続解放
   _mlDbConn = null; _mlDb = null;
       ↓
3. Python (ml_runner.py) を spawn
   con = duckdb.connect(path, read_only=True)  # ロック取得成功
   df = con.execute(sql).df()
   con.close()
       ↓
4. 学習中: Node 側の getMlDb() は throw でブロック
   if (currentMlJob) throw new Error('現在 ML 学習ジョブ実行中...')
   → UI/LLM がアクセスしようとしても安全にエラー
       ↓
5. Python 終了 → currentMlJob = null
       ↓
6. 次回 getMlDb() アクセス時に自動再オープン
```

### 推論エンジン (ml_predict.py) の設計

#### subprocess 単発実行

```javascript
// Node 側
const proc = spawn(pythonCmd, [scriptPath, modelDir]);
proc.stdin.write(JSON.stringify({ features }));  // 入力 JSON
proc.stdin.end();
proc.stdout.on('data', d => stdout += d);  // 結果 JSON 受信
```

利点:
- 学習中以外なら DuckDB ロック競合なし (推論は DuckDB 不要)
- 並列実行可能 (各推論が独立プロセス)
- 30秒タイムアウト + 100件バッチ制限

#### 推論時の入力検証

`ml_predict.py` で派生列の直接渡しを検知:

```python
# {"date_year": 2026, "date_month": 4, ...} を検知
misused_derived = []
for src in datetime_source_cols:
    for feat in datetime_features:
        if f'{src}_{feat}' in sample and src not in sample:
            misused_derived.append(f'{src}_{feat}')
if misused_derived:
    error_with_example_input()  # 正しい入力例を返す
```

しかしクライアント側 (JavaScript) でも事前にサニタイズ:

```javascript
const sanitizeFeatures = (f) => {
  const dateCols = new Set();
  for (const k of Object.keys(f)) {
    const m = k.match(/^([a-zA-Z][a-zA-Z0-9]*)_(year|month|day|...)$/);
    if (m) dateCols.add(m[1]);
  }
  for (const dc of dateCols) {
    const y = f[`${dc}_year`], mo = f[`${dc}_month`], d = f[`${dc}_day`];
    if (y && mo && d) {
      f[dc] = `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    }
    // 派生列削除
    for (const suf of ['year','month','day','dayofweek','dayofyear','is_weekend']) {
      delete f[`${dc}_${suf}`];
    }
  }
  return f;
};
```

LLM が派生列で呼んでも自動修正されるので、サーバーには元の日付文字列が届く。

### LLM ツール連携の設計

#### 5つのMLツール

| ツール | 役割 | 引数 |
|:--|:--|:--|
| `ml_list_datasets` | テーブル一覧 + 行数 + 説明 | (なし) |
| `ml_describe_dataset` | スキーマ取得 | `table` |
| `ml_query_dataset` | 読み取り専用 SQL | `sql, limit?` |
| `ml_list_models` | 学習済みモデル一覧 + predictHint | (なし) |
| `ml_predict` | 推論実行 | `modelName, features` |

#### MLプリフィルタ (誤発動防止)

クライアント側でツール判断LLM呼び出し前に判定:

```javascript
const mlMetaKeywords = ['ml', '機械学習', 'データテーブル', 'duckdb',
                        '予測して', '推論して', 'sql', ...];
const hasMetaKeyword = mlMetaKeywords.some(k => recentUserText.includes(k));

// 既存テーブル/モデル名がユーザー発話に含まれるか
const knownNames = [...tables, ...models].map(x => x.name.toLowerCase());
const hasSpecificName = knownNames.some(name => recentUserText.includes(name));

if (!hasMetaKeyword && !hasSpecificName) {
  // tools 配列から ml_* を全て削除
  tools = tools.filter(t => !t.function.name.startsWith('ml_'));
}
```

これで「こんにちは」「Pythonコード書いて」のような ML 無関係な発話では、ML系ツールが LLM の選択肢に出てこない。

#### ml_list_models の predictHint

LLM が正しい呼び方を学習できるよう、`/ml/models` レスポンスに各モデルの **正しい入力例** を含める:

```json
{
  "name": "sales_yosoku",
  "features": ["date", "region", "product", "quantity"],
  "predictHint": {
    "requiredFeatures": ["date", "region", "product", "quantity"],
    "datetimeColumns": ["date"],
    "exampleInput": {
      "date": "2027-04-15",
      "region": "Tokyo",
      "product": "ProductA",
      "quantity": 5
    },
    "note": "日時列 date は元の日付文字列を渡してください。内部で自動分解されます。"
  }
}
```

#### テキスト形式ツール呼び出しの救済

Qwen系で稀に発生する「ツール呼び出しではなくテキストで関数を書いてしまう」ケースを3パターンで検出:

1. `<モデル名>{JSON}` 形式: `sales_yosoku{"date_year": 2026, ...}`
2. `ml_predict(args)` Python風: `ml_predict(modelName='sales_yosoku', features={...})`
3. JSONコードブロック: ` ```json {"modelName": "...", "features": {...}} ``` `

検出されたら正規の `tool_call` に変換して再ループ。

#### 空応答救済

```
ツール実行後の最終応答が < 5 文字の場合:
  ↓
[ステップ1] 「分からない時は理由を率直に説明して」プロンプトで再生成
  - データ不足 → 何が足りないか説明
  - モデル制約 → なぜできないか説明
  - 曖昧 → 追加情報を質問
  ↓
それでも空 → [ステップ2] 固定メッセージで通知
```

### API トークン認証

#### 設計

```javascript
function requireAuth(req, res, next) {
  // 1. Cookie セッション (ブラウザ用)
  if (isValidSession(cookieToken)) return next();
  // 2. Bearer トークン (外部プログラム用)
  if (authHeader.startsWith('Bearer ')) {
    const tokenObj = appConfig.ml.apiTokens.find(t => t.token === apiToken);
    if (tokenObj) {
      req.apiToken = tokenObj;  // 後続で権限チェック
      return next();
    }
  }
  res.status(401).json({ error: '認証が必要です' });
}

function requirePermission(perm) {
  return (req, res, next) => {
    if (!req.apiToken) return next();  // Cookie は全権限
    if (req.apiToken.permissions.includes(perm)) return next();
    res.status(403).json({ error: `権限 "${perm}" が必要です` });
  };
}

// 使用例
app.post('/ml/datasets/append',
  requireAuth, requirePermission('ml:write'), jsonParser, handler);
```

#### トークン生成

```javascript
// GET /api-tokens/generate (Cookie認証)
const token = 'ogc_' + crypto.randomBytes(32).toString('base64url');
// → "ogc_aBc123...xyz" (43文字 URL-safe base64)
```

ml.html の「📡 API」タブからワンクリックで生成 → config.json に手動登録。トークン本体はサーバー側のみが保持、API レスポンスでは `tokenPreview` (先頭12 + 末尾4 文字) のみ返す。

#### CORS

```javascript
app.use('/ml', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Auth-Token');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
```

別オリジン (ブラウザ JS) からも利用可能。

詳細手順は README.md の「🤖 機械学習 (ML)」セクションを参照。

---

## 🎮 強化学習 (RL) 機能の設計

機械学習 (ML) が「教師あり学習 (回帰・分類・時系列)」だったのに対し、強化学習 (RL) は
**「状態 → 行動 → 報酬」の経験から方策 (policy) を学習**する。アルゴリズムは
価値ベース off-policy の **DQN / Double DQN (DDQN)**、オフラインRL の **CQL**、
模倣学習の **Behavior Cloning (BC)** をサポートする。行動空間は**離散**を前提とする
(連続制御を扱う場合は外部側で離散化する)。

### 全体構成

```
                    server.js (Node.js / Express)
                          │  /ml/rl/* エンドポイント (requireAuth + ml:read/ml:write)
        ┌─────────────────┴───────────────────┐
        │ オフライン (バッチ学習)               │ オンライン (リアルタイム)
        ▼                                     ▼
  rl_runner.py (subprocess)            rl_online_server.py (常駐ワーカー :11600)
   DuckDB テーブル → 経験再生            メモリ常駐 Agent (qnet/target/optimizer)
   → 学習 → model.pt / metrics.json     replay buffer + Welford 実行統計
        │                                HTTP: /act /learn /checkpoint /load_offline
        └──────────────┬──────────────────────┘
                       ▼
              rl_common.py (共通)
   build_qnet / encode_state_dict / compute_loss
   ※ オフラインとオンラインで前処理・損失の挙動を一致させる (乖離防止)
```

- **オフラインとオンラインで学習コードを共有**するため、Qネット構築・状態エンコード・
  損失計算は `rl_common.py` に集約している。これにより「バッチ学習した方策」と
  「オンラインで継続学習する方策」の挙動が乖離しない。

### 共通モジュール (`rl_common.py`)

| 関数 | 役割 |
|---|---|
| `build_qnet(torch, nn, state_dim, n_actions, hidden)` | 3層 MLP の Qネットワーク (Linear→ReLU→Linear→ReLU→Linear)。オフライン/オンライン同一構造 |
| `encode_state_dict(state, meta, np)` | 状態辞書 → 数値ベクトル。カテゴリ列は index 化 (未知値→0)、数値列は float 化し、`(vec - mean) / scale` で正規化 |
| `compute_loss(algo, mode, ...)` | 1ミニバッチの損失。DQN/DDQN は Bellman 誤差 (smooth L1)、CQL は + 保守正則化項、BC は cross entropy |

- **正規化の (mean, scale)** は 2 経路: オフラインは学習時の StandardScaler (`scalerMean/scalerScale`)、
  オンラインは Welford のオンライン実行統計 (`runningMean/runningM2/runningCount`) から算出。
  どちらも `_mean_scale_from_meta` が吸収する。
- **mode**: `transition` (γで先読み、next_state 使用) と `bandit` (1ステップ報酬のみ) の2系統。

### オフラインRL (`rl_runner.py`)

1. server.js が `POST /ml/rl/train` を受け、`ml/rl_models/<name>/_run_config.json` に設定を書き出し
   `rl_runner.py` を subprocess 起動。
2. DuckDB テーブルから 状態/行動/報酬/次状態/done 列を読み、経験再生バッファを構築。
3. N エピソード学習し、`RESULT_JSON:{...}` を stdout に出力 (Node 側がパース)。
4. 成果物: `model.pt` / `config.json` / `metrics.json` (`lossHistory`、方策一致率 `policyAgreement`、
   推定価値 `meanQ`、ログ平均報酬など)。
5. UI の `📈 学習曲線` は `metrics.lossHistory` を、`🔍 方策を評価` は `POST /ml/rl/models/<name>/eval`
   (ログ行動 vs 学習方策の一致率・行動分布) を表示。

### オンラインRL (`rl_online_server.py`)

llama-server / sd-server と同じく**遅延起動・常駐**するワーカー。`ml.onlinePort` (デフォルト 11600) で
localhost HTTP を待ち受け、server.js が `rlWorkerRequest()` でプロキシする。

- **メモリ常駐 Agent**: Qネット・ターゲットネット・optimizer・replay buffer (deque) ・
  Welford 実行統計を保持。`AGENTS[name]` レジストリで管理。
- **エンドポイント**: `/create` (spec から新規) / `/load_offline` (学習済みをウォームスタート) /
  `/act` (推論, ε-greedy) / `/learn` (経験投入 + 勾配更新) / `/checkpoint` / `/status` / `/unload`。
- **学習の流れ (`/learn`)**: 経験を buffer に追加し、`len(buffer) >= batch_size` になったら
  1 呼び出しあたり最大 `MAX_GRAD_STEPS_PER_CALL` (=16) 回の勾配ステップ。
  `total_steps % target_update == 0` でターゲットネットを同期。loss/reward は EMA で保持。
- **自動チェックポイント**: `dirty` かつ「500 ステップ経過 or 60 秒経過」で `model.pt` /
  `config.json` / `metrics.json` を保存。**ディスク上のモデルは常に“最新の重み”に上書きされる**点が重要。
- **自動再水和**: `get_agent(name, auto_load=True)` は、メモリに無ければ `model.pt` + `config.json`
  からエージェントを自動ロードする。よってサーバ再起動後の最初の `/act` でも復旧する。

> **設計上の含意**: 「常駐メモリ + 最新重みの自動上書き」のため、DQN が方策崩壊
> (catastrophic forgetting) を起こした状態まで学習を続けると、ディスク上の良いモデルも
> 上書きされてしまう。**ピークの方策を残したい場合は、早期終了して学習を止める**運用が要る
> (このトレードオフは意図的。履歴保存や best-model 保持は現状サーバ側に持たせていない)。

### HTTP エンドポイントと認証

`/ml/rl/*` はすべて `requireAuth` + `requirePermission('ml:read' | 'ml:write')`。
Cookie セッション (全権限) か `Authorization: Bearer <token>` (トークンの権限配列でチェック)。

| メソッド/パス | 用途 | 権限 |
|---|---|---|
| `GET /ml/rl/envs` | アルゴ/環境メタ | ml:read |
| `POST /ml/rl/train` `…/status` `…/cancel` | オフライン学習 | ml:write / ml:read |
| `GET /ml/rl/models` `…/:name/metrics` | 一覧・メトリクス | ml:read |
| `POST /ml/rl/online/create` | 作成 / ウォームスタート | ml:write |
| `POST /ml/rl/models/:name/act` | 推論 (state→action) | ml:read |
| `POST /ml/rl/models/:name/learn` | 経験投入 + 更新 | ml:write |
| `POST /ml/rl/models/:name/checkpoint` | 保存 | ml:write |
| `GET /ml/rl/models/:name/online/status` | オンライン状況 | ml:read |

### UI 設計 (`public/ml.html` 「🎮 強化学習」タブ)

- **ボタン構成の統一**: オフライン (📊) / オンライン (⚡) のエージェントカードは共通で
  `📈 学習曲線` `🔍 方策を評価` `⚡ オンライン操作/化` を持ち、クリックで右パネルが
  切り替わる (`chartFor` / `evalFor` / `onlineFor` の排他表示) 同一の遷移にしている。
- **オンラインの 📈 学習曲線**: サーバは損失履歴配列を持たないため、パネル表示中に
  3秒間隔で `online/status` を取得し `rewardEMA` / `lossEMA` をブラウザ側に蓄積 (`onlineHist`)、
  `OnlineSeriesChart` (canvas) で描画する**クライアント側セッション履歴**方式。
- **オンラインの 🔍 方策を評価**: データセットが無いため、状態を入力して `act(ε=0)` を呼び、
  各行動の Q値を `QValueBars` (横棒) で可視化し推奨行動 (★) を強調する。
- **📝 操作ログ**: act/learn/評価/チェックポイント/削除などの結果を、各APIの返り値から
  ログ行を組み立てて右パネル下部に時系列表示 (`opLog`)。サーバ側ログAPIは追加していない。

### 主要な設計判断

- **行動は離散のみ**: DQN 系は離散行動前提。連続制御 (例: MuJoCo の倒立振子の力) を扱うときは
  **外部クライアント側で力を離散ビンに変換**して `actionLabels` に対応づける。
- **オフライン/オンラインで `rl_common.py` を共有**: 前処理・損失の挙動差をなくし、
  ウォームスタート (オフライン→オンライン継続学習) を成立させる。
- **DuckDB はオンラインでは不使用**: オンラインは経験を API で受けるため、ML DB の
  release/reacquire 調停 (オフライン学習で必要) は不要。

---

## 🔧 外部API: ツール対応モード (agent_proxy.js)

通常の外部APIは llama-server を別ポートで直接公開する「素のLLM」モードだが、ツール対応モードでは **server.js 内に専用の Express サーバーを別ポートで立てて**、Webチャットと同じツール群を外部から使えるようにする。実装は `agent_proxy.js` に集約。

### 設計の動機

外部APIサーバーで「素のLLM」だけを公開していると、Webチャットで自然に使える機能 (Web検索、ML予測、ファイル参照、RAG文書検索) が外部プログラムから使えなかった。Webチャット側のツール実行ロジックは **ブラウザの JavaScript と server.js に分散** しているため、外部からは直接利用できない。

そこで:
- server.js 内に **ツール実行ロジックを集約した Express サーバー** を別ポートで起動
- OpenAI 互換の `/v1/chat/completions` を受けて、内部でエージェントループを回す
- 内部の llama-server を素直に呼び出してツール判断 → ツール実行 → 最終応答

```
従来 (通常モード):
  外部 → llama-server直結 (素のLLM、高速)

ツール対応モード (新規):
  外部 → agent_proxy.js (server.js 内、別ポート)
           ↓ ツール判断 (内部 llama-server に問い合わせ)
           ↓ tool_call が返れば実行 (ml/web/file/rag)
           ↓ 結果を履歴に追加して再問い合わせ
           ↓ 最終応答
         内部 llama-server (素のLLM)
```

### ファイル構成

```
agent_proxy.js (~600行)
├── startAgentServer(opts, deps)
│   - Express アプリ作成
│   - JSON parser + エラーハンドラー
│   - Bearer トークン認証 (/health は除外)
│   - エンドポイント定義
│   - HTTP/HTTPS サーバー起動
├── buildToolDefs(enabledTools, appConfig)
│   - 有効ツールに応じて OpenAI 互換の関数定義配列を生成
├── runAgentLoop({ messages, tools, ... })
│   - MAX_TURNS=5 のツール実行ループ
│   - tool_calls があれば executeTool で実行 → 履歴に追加 → 再問い合わせ
│   - tool_calls が無くなれば最終応答
├── executeTool(fnName, fnArgs, deps, ip)
│   - 各ツールの実行 (ml_*, web_search, list_files, read_file, search_documents)
│   - ml_predict は派生列を自動サニタイズ
└── callLlama({ ... })
    - 内部 llama-server の /v1/chat/completions を呼ぶラッパー
```

### deps オブジェクト経由の関数注入

`agent_proxy.js` は server.js 内の関数 (`ddgSearch`, `getMlDb`, `runMlPredict` 等) を直接 require しない。**循環参照を避けるため**、server.js 側で `buildAgentDeps()` を呼んで必要な関数を集めた `deps` オブジェクトを作り、`startAgentServer(opts, deps)` 経由で渡す。

```javascript
// server.js
function buildAgentDeps() {
  return {
    chatHost: appConfig.llamaServer.chatHost,
    chatPort: appConfig.llamaServer.chatPort,
    log, appConfig,
    ensureChatModelLoaded,  // モデルロード保証
    ddgSearch, fetchPageText,  // web検索
    getMlDb: () => ({ allAsync: (sql, ...args) => mlQuery(sql, args) }),
    loadMlModels, isValidTableName, isSafeReadOnlySql,
    ML_MODELS_DIR, runMlPredict,
    UPLOADS_DIR,
    listUploadFiles: async () => { /* uploads再帰列挙 */ },
    readUploadFile: async (path) => { /* safeUploadPath で安全に読む */ },
    searchDocumentsSimple: async (query) => await ragSearch(query, 5),
  };
}

// agent_proxy.js は deps.ddgSearch() のように使う
```

これにより agent_proxy.js は server.js を require せずに済む。

### 対応ツール定義

`buildToolDefs(enabledTools, appConfig)` で有効ツールに応じて関数定義を生成:

| カテゴリ | ツール名 | 引数 | 用途 |
|:--|:--|:--|:--|
| ML | `ml_list_datasets` | (なし) | テーブル一覧 |
| ML | `ml_describe_dataset` | `table` | スキーマ |
| ML | `ml_query_dataset` | `sql, limit?` | 読み取り専用SQL |
| ML | `ml_list_models` | (なし) | モデル一覧 + predictHint |
| ML | `ml_predict` | `modelName, features` | 推論 |
| Web | `web_search` | `query` | 検索 + 上位3件の本文取得 |
| File | `list_files` | (なし) | uploads 一覧 |
| File | `read_file` | `path` | uploads ファイル読み |
| RAG | `search_documents` | `query` | 永続RAG検索 |

### モデルロード保証の仕組み

通常モードでは llama-server を新規プロセスとして起動するが、ツール対応モードでは **内部の llama-server を共用** する。そのため起動時に以下のチェックが必要:

```javascript
// startExternalServer の agentMode ブロック
if (chatProcModel !== modelName) {
  // 別モデルがロード中 or 未ロード → 切替
  if (chatProcStarting) {
    throw new Error('別のモデルが起動中');
  }
  await startChatModel(modelName);  // 完了まで待つ
}
```

さらにアイドルアンロード後の再リクエスト対応として、agent_proxy の各リクエスト処理で `ensureChatModelLoaded` を呼ぶ:

```javascript
// agent_proxy.js: 各 /v1/chat/completions リクエスト
let ready = await deps.ensureChatModelLoaded();
if (!ready) {
  // ensureChatModelLoaded は「未起動なら起動開始してすぐ false 返す」設計
  // → ポーリングで完了まで待つ
  const startedAt = Date.now();
  while (!ready && Date.now() - startedAt < timeoutMs) {
    await new Promise(r => setTimeout(r, 1000));
    ready = await deps.ensureChatModelLoaded();
  }
}
```

### エラーハンドリング (OpenAI 互換)

Express のデフォルトハンドラーは HTML を返すが、OpenAI 互換 API を目指すには JSON で返す必要がある。**3層のハンドラー** を仕込んで HTML 応答を完全排除:

1. **JSON parser エラー**: `express.json()` の直後に `entity.parse.failed` / `entity.too.large` を捕捉
   ```javascript
   app.use((err, req, res, next) => {
     if (err.type === 'entity.parse.failed') {
       return res.status(400).json({
         error: { message: '...', type: 'invalid_request_error',
           hint: 'Content-Type: application/json を指定してください' }
       });
     }
     next(err);
   });
   ```
2. **404 ハンドラー**: 未知のパスも JSON で返す + 正規パスのヒント付き
3. **汎用エラーハンドラー**: 予期しないエラーも JSON で返す

### 認証 (`/health` は例外)

Bearer トークン認証ミドルウェアで全エンドポイントを保護するが、`/health` だけは認証スキップ (ロードバランサーや監視ツール対応):

```javascript
app.use((req, res, next) => {
  if (req.path === '/health') return next();  // ヘルスチェックは認証不要
  // ... Bearer 検証
});
```

### 派生列の自動復元 (ml_predict)

Webチャット同様、LLM が `date_year, date_month, date_day` を直接渡してきた場合に元の日付文字列に復元するロジックを agent_proxy.js 側にも実装:

```javascript
const sanitize = (f) => {
  const dateCols = new Set();
  for (const k of Object.keys(f)) {
    const m = k.match(/^([a-zA-Z][a-zA-Z0-9]*)_(year|month|day|...)$/);
    if (m) dateCols.add(m[1]);
  }
  for (const dc of dateCols) {
    if (f[dc] === undefined) {
      const y = f[`${dc}_year`], mo = f[`${dc}_month`], d = f[`${dc}_day`];
      if (y && mo && d) f[dc] = `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    }
    for (const suf of ['year','month','day','dayofweek','dayofyear','is_weekend']) {
      delete f[`${dc}_${suf}`];
    }
  }
  return f;
};
```

### 制約・設計上の割り切り

- **chat タイプのみ対応**: embedding タイプは別 (RAG では内部 embedding を使う)
- **ストリーミングは最終応答を一括返却**: 途中のツール実行はストリームに乗らない (実装複雑性のため)
- **MAX_TURNS=5**: ツール実行ループの上限
- **Python実行・画像生成は除外**: 任意コード実行や画像生成は外部公開のリスクが大きい
- **ツール判断はモデル任せ**: Webチャット側にあるプリフィルタ (会話に該当キーワードが無ければ ML系ツールを除外) はシンプルさ優先で省略

---

## 📚 永続RAGドキュメント (外部API専用)

ブラウザ側のチャット添付RAG (メモリ保持、セッション終了で消滅) とは独立した、**サーバー側の永続RAGストア**。`agent_proxy.js` の `search_documents` ツールから検索される。

### 設計の選択

- **uploads フォルダのファイルを流用**: 新しいアップロード機構を作らず、既存の `public/uploads/` を再利用
- **API管理のみ**: ブラウザ UI は不要、`POST /rag/documents` で Python から登録
- **embedding ベクトル検索**: キーワード検索ではなく、内部 embedding サーバー (mxbai-embed-large 等) で cosine 類似度検索

### ストレージ

```
ml/rag/
├── index.json          # { documents: [{ docId, filename, chunkCount, ingestedAt }] }
└── <docId>.json        # { docId, filename, chunkCount,
                        #   chunks: [string, ...],
                        #   embeddings: [[float], ...],
                        #   ingestedAt }
```

`docId` は `sha1(filename).slice(0,16)` で生成。同じファイル名を再登録すると同じ docId になるので**上書き更新**になる。

### 登録フロー (POST /rag/documents)

```javascript
async function ragIngestFile(filename) {
  // 1. uploads 内の安全なパスに変換
  const abs = safeUploadPath(filename);
  if (!abs) throw new Error('無効なパス');

  // 2. テキスト系拡張子チェック (PDF/Word は弾く)
  const textExts = ['.txt', '.md', '.csv', '.json', '.log', '.html', '.xml',
                    '.yaml', '.yml', '.py', '.js', '.ts'];
  if (!textExts.includes(path.extname(abs).toLowerCase())) {
    throw new Error('テキスト系ファイルのみ対応');
  }

  // 3. 読み込み → チャンク分割
  const text = fs.readFileSync(abs, 'utf-8');
  const chunks = ragChunkText(text);  // 500文字, overlap 100

  // 4. 各チャンクを embedding 化 (内部 embedding サーバーを呼ぶ)
  const embeddings = [];
  for (const chunk of chunks) {
    embeddings.push(await ragGetEmbedding(chunk));
  }

  // 5. ml/rag/<docId>.json に保存 + index.json 更新
  const docId = ragDocId(filename);
  fs.writeFileSync(path.join(RAG_DIR, `${docId}.json`), JSON.stringify({
    docId, filename, chunkCount: chunks.length, chunks, embeddings,
  }));
  // index 更新...
}
```

### 検索フロー (search_documents ツール)

```javascript
async function ragSearch(query, topK = 5) {
  // 1. クエリを embedding 化
  const qVec = await ragGetEmbedding(query);

  // 2. 全ドキュメントの全チャンクと cosine 類似度を計算
  const scored = [];
  for (const doc of loadRagIndex().documents) {
    const data = JSON.parse(fs.readFileSync(`ml/rag/${doc.docId}.json`));
    for (let i = 0; i < data.chunks.length; i++) {
      const sim = ragCosineSim(qVec, data.embeddings[i]);
      scored.push({ filename: data.filename, chunkIndex: i,
                    text: data.chunks[i], score: sim });
    }
  }

  // 3. スコアで降順ソート → top-K を返す
  scored.sort((a, b) => b.score - a.score);
  return { results: scored.slice(0, topK) };
}
```

### embedding 未設定時の自動 OFF (4層防御)

embedding サーバーが利用できない場合、RAG 関連機能は **4層で自動的に無効化** される:

```javascript
// 共通の判定関数 (config + ファイル存在チェック)
function isEmbeddingAvailable() {
  const em = appConfig.embeddingModel;
  if (!em || !em.path) return { available: false, reason: 'config.embeddingModel.path が未設定' };
  if (!fs.existsSync(em.path)) return { available: false, reason: `モデルファイル不在: ${em.path}` };
  return { available: true };
}
```

| 層 | チェックポイント | 動作 |
|:--|:--|:--|
| 1 | UI (チャット画面) | `GET /external-servers/embedding-available` をロード時に呼ぶ → RAG チェックボックスを disabled + 「⚠️ embedding未設定のため利用不可」表示 |
| 2 | サーバー起動時 | `startExternalServer` の agentMode で `enabledTools` から `rag` を自動除外 + 警告ログ |
| 3 | API直叩き | `POST /rag/documents`、`POST /rag/search` が 503 + 理由を返す |
| 4 | agent_proxy 内 | ツール一覧から `search_documents` が除外される (層2の結果) |

これにより、ユーザーが UI を経由しても、Python API直叩きでも、設定ミスの状態で「毎回 search_documents が失敗する」事故を防ぐ。

### RAG ロジックの統一 (ブラウザ ⟷ サーバー)

ブラウザ側 `chunkText` / `cosineSim` (添付ドキュメント用) とサーバー側 `ragChunkText` / `ragCosineSim` (永続RAG用) は **挙動を完全に揃える** ことで保守性を高めた:

| 項目 | 統一前 | 統一後 |
|:--|:--|:--|
| 無限ループ | `overlap >= chunkSize` でハング | `safeOverlap = min(overlap, floor(chunkSize/2))` でガード |
| 末尾チャンク | `chunkSize - overlap` で進む | `if (end >= text.length) break;` で確実に終了 |
| 空入力 | `null.length` で例外 | `if (!text) return [];` でガード |
| cosine epsilon | サーバー側 `1e-8`, ブラウザ `1e-10` | 両方 `1e-10` に統一 |

### embedding サーバーの再利用

新たな embedding サーバーは立てず、**既存の `ensureEmbeddingLoaded()`** をそのまま使う。これにより:

- メモリ効率 (1プロセスで済む)
- Webチャットの添付RAG と同じ embedding モデルを使えるので、後でブラウザRAGをサーバーRAGに統合する余地がある
- アイドルアンロードも自動的に効く

---

## 🖼️ 画像物体検出 (torchvision)

`/ml.html` の「画像」タブで、COCO事前学習モデルでの検出と、独自クラスのカスタムモデル学習を行う。

### なぜ torchvision か (YOLO を避けた理由)

- **依存最小**: `torch` / `torchvision` だけで動く。ultralytics(YOLO) は追加依存 + **AGPL ライセンス** (商用で注意)
- **weight 付属**: COCO 事前学習済み weight が torchvision に付属。初回だけ自動ダウンロード
- **ライセンス**: torchvision は BSD で本プロジェクトの方針に合う
- 採用モデル: `fasterrcnn_resnet50_fpn` / `fasterrcnn_mobilenet_v3_large_fpn` / `retinanet_resnet50_fpn` / `ssd300_vgg16` / `ssdlite320_mobilenet_v3_large`

### ファイル構成

```
image_detect.py   推論 (COCO + カスタムモデル両対応)
image_train.py    カスタム学習 (Faster R-CNN ファインチューニング)
ml/torch_cache/   torch weight + MIOpen カーネルキャッシュ (書き込み可能な場所)
ml/image_datasets/<name>/   データセット (dataset.json + images/)
ml/image_models/<name>/     学習済みモデル (model.pt + config.json + metrics.json)
ml/image_jobs.json          画像学習ジョブ履歴
```

### データ構造とアノテーション

- アノテーションは **natural 座標 (絶対ピクセル) で保存**。表示スケールに依存しないので、学習時もそのまま使える
- 入力方式は2つ: ドラッグで矩形、クリックで固定サイズ矩形 (点モード、4〜300px)
- torchvision の物体検出は **背景 = label 0**。学習時は `classIndex + 1`、推論時は `labelId - 1` で変換する
- YOLO (正規化 cx,cy,w,h → ピクセル) と COCO ([x,y,w,h] → [x1,y1,x2,y2]) のインポートに対応

### 学習 (転移学習)

- 事前学習済みの特徴抽出器を活かし、分類ヘッド (`FastRCNNPredictor`) だけを `クラス数 + 1` に付け替える → 少量データで実用的
- `scratch` (事前学習なし) も選択可能。`weights=None, weights_backbone=None, num_classes=N` でゼロから。ただし大量データ・多エポックが必要
- 学習ジョブは表データ学習 (`currentMlJob`) とは**別系統 (`currentImageJob`)**。DuckDB を使わないので排他制御の干渉がない
- `config.json` に `baseModel` を保存し、推論時に同じ構造を復元して `model.pt` をロードする

### LLM チャット連携 (detect_objects)

画像を添付かつ ML 有効時のみ `detect_objects` ツールを LLM に提供。LLM がツールを呼ぶ → ブラウザが添付画像の base64 を `/ml/image/detect` に送る → クラス別集計を LLM に返す → LLM が自然言語で回答。Vision 対応モデルなら検出結果と画像の両方を見て誤認識を訂正することもある。

### 外部API・ダウンロード

- `POST /ml/image/detect` (Bearer, `ml:read`): COCO は `model`、カスタムは `customModel` を指定
- `GET /ml/image/custom-models/:name/download`: model.pt + config.json + 推論サンプル + README を zip 化。自前 ZIP 生成 (罠117) で外部コマンド不要

### 主な罠

罠 107〜117 を参照 (キャッシュパス、stdout汚染、プロセスグループkill、status競合、幽霊ジョブ、`\r`正規化、矩形残留、隠しファイル、自前zip)。

---

## 🌐 GPUクラスタ化（複数PC接続）

llama.cppの **RPCモード** で複数PCのGPUを連結できます。OpenGeekLLMChat側は特別な改修不要、`extraArgs`で `--rpc` を渡すだけで対応します。

### アーキテクチャ

```
[Master PC: llama-server]
   │ TCP/IP (gRPC over TCP)
   ├── [Worker 1: rpc-server] → ROCm0, ROCm1
   ├── [Worker 2: rpc-server] → ROCm0, ROCm1
   └── [Worker 3: rpc-server] → ROCm0, ROCm1
```

Master側がモデルロードのコーディネーターとなり、Worker側はGPU計算リソースを提供する分散構成。テンソル並列で各レイヤーを複数PC間で分散計算します。

### Worker起動スクリプト例

```bash
#!/bin/bash
# /usr/local/bin/llama-rpc-worker.sh

llama-server \
  --rpc-server \
  --host 0.0.0.0 \
  --port 50052 \
  --device ROCm0,ROCm1 \
  -ngl 99 \
  --log-disable
```

Worker用の systemd ユニット例:

```ini
[Unit]
Description=llama-server RPC worker
After=network.target

[Service]
Type=simple
User=wizapply-ai
ExecStart=/usr/local/bin/llama-rpc-worker.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### Master側 config.json

```json
"chatModels": [
  {
    "name": "Qwen3.6 235B (4ノードクラスタ)",
    "path": "/path/to/Qwen3-235B-Q4_K_M.gguf",
    "ctx": 32768,
    "ngl": 99,
    "extraArgs": [
      "--rpc", "192.168.100.11:50052,192.168.100.12:50052,192.168.100.13:50052",
      "--tensor-split", "0.25,0.25,0.25,0.25"
    ]
  }
]
```

`--tensor-split` の値は (Master, Worker1, Worker2, Worker3) の順で各ノードへの分配比率。合計1.0になるよう調整。

### ネットワーク要件

LLM推論時、各レイヤーで GPU 間の Allreduce 通信が発生します。トークン生成は逐次的なので、通信レイテンシが推論速度に直結します。

| 接続 | 帯域 | レイテンシ | 推論への影響 |
|:--|:--|:--|:--|
| 1GbE | 0.125 GB/s | 0.1ms | ❌ 致命的に遅い |
| 10GbE | 1.25 GB/s | 0.05ms | ⚠️ 単機の半分以下 |
| 25GbE | 3.1 GB/s | 0.02ms | △ 何とか実用 |
| 100GbE (ConnectX-5) | 12.5 GB/s | 0.005ms | ◯ 実用的 |
| 200GbE (ConnectX-6) | 25 GB/s | 0.003ms | ◎ 快適 |
| 400GbE (ConnectX-7) | 50 GB/s | 0.002ms | ◎◎ PCIe同等 |
| InfiniBand HDR | 25 GB/s + RDMA | 0.001ms | ★ 最速 |

**結論**: 100GbE以上必須。ConnectXシリーズなら理想的。

### スケーリング特性

```
70Bモデル(Q4) tokens/sec の目安:

R9700×2 単機       : 30〜40 tok/s   (基準)
R9700×4 (RPC, 100G): 50〜60 tok/s   (1.5x)
R9700×8 (RPC, 200G): 80〜100 tok/s  (2.5x)
```

完全な線形スケールはしません（通信オーバーヘッドのため）。が:

```
405Bモデル(Q4, 約220GB):
  単機R9700×2: 動かない（CPUオフロード必須、超低速）
  RPC×4ノード: 動く（240GB > 220GB）、10〜20 tok/s
```

**「動かないモデルが動く」** = ∞倍効果。クラスタ化の真価はここ。

### 実装上の注意点

1. **モデルファイルの配置**: Master側のみで OK。初回ロード時にネットワーク経由で各Workerに転送される（70BモデルでもConnectX-6なら30秒程度）。

2. **同時起動の同期**: 全Workerが起動してからMasterを起動する。Workerが落ちると即座にMaster側で503が発生する。

3. **異種GPU構成**: 各ノードのGPU性能が違う場合、`--tensor-split` で配分を調整（速いノードに多く割り当てる）。

4. **NICのオフロード機能**: ConnectXのRDMA/RoCEはllama.cppのRPCがネイティブ対応していないため、現時点ではTCPで使う。それでも100GbE Ethernetなら十分速い。

5. **バッチサイズ**: `-b 1`（チャット）なら通信量最小。並行リクエスト時は通信量増加するので帯域に余裕を持たせる。

6. **故障耐性**: 現状は冗長性なし。Worker 1台でも落ちると全体が止まる。本番運用では監視と自動復旧の仕組みが必要。

### 切り分け用コマンド

```bash
# Worker側でlistenしているか
ss -tlnp | grep 50052

# Master側からの疎通
nc -zv 192.168.100.11 50052

# 帯域実測
# Worker: iperf3 -s
# Master: iperf3 -c 192.168.100.11 -t 10

# 各WorkerのGPU状態
for w in 192.168.100.11 192.168.100.12; do
  ssh $w "rocm-smi --showmemuse"
done
```

### 将来の改善（公開済みPRや予定）

- **RDMA直接対応**: 現在はTCP経由のみ。ConnectXのRDMA/RoCEv2をネイティブ利用すればさらに高速化
- **Pipeline並列**: 現在はテンソル並列のみ。レイヤー単位で分割するパイプライン並列が実装されればより大型のモデルが動く
- **動的Worker追加**: 起動時に固定。実行中のWorker追加/削除は未対応

---
