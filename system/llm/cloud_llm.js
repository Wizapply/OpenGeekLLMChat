/**
 * cloud_llm.js — 外部LLM (有料API) フォールバックモジュール
 *
 * ローカルLLM (llama.cpp) で限界に達した時 (コンテキスト不足・出力打ち切り・
 * 思考だけで終わった・「分かりません」で終わった・エラー) や、ユーザーが明示的に
 * 頼んだ時だけ、外部の大きなLLM (OpenAI / Anthropic / Gemini / OpenRouter 等) に
 * 同じ会話を投げて回答をもらうためのクライアント。
 *
 * 方針:
 * - 既定は無効 (cloudLlm.enabled=false)。有効にしない限り、外部への送信は一切起きない。
 *   このアプリの「データは手元に残す」原則の例外なので、ON にするのは管理者の明示的な操作だけ。
 * - 依存を増やさない。Node 標準の https だけで各プロバイダの API を叩く
 *   (google_drive.js と同じ流儀)。
 * - API キーはブラウザに絶対返さない。config.json の cloudLlm.apiKey か、環境変数
 *   (cloudLlm.apiKeyEnv、未指定ならプロバイダ既定の OPENAI_API_KEY 等) から読む。
 * - ブラウザ側 (index.jsx) は llama-server と同じ OpenAI 互換の SSE を期待しているので、
 *   どのプロバイダでも「OpenAI chat.completion.chunk 形式」に変換して返す。
 *   → フロントのストリーミング処理をプロバイダ毎に書き分けなくて済む。
 * - ツール (web_search / Python / RAG検索) はローカル側で実行済みの前提。外部LLMには
 *   tools を渡さず、ツール結果はテキストに畳んで渡す (tool ロールを持たないAPIでも通る)。
 * - 送信量と回数の上限 (maxInputChars / maxRequestsPerDay) で「うっかり高額課金」を防ぐ。
 *   利用回数とトークン数は cloud_llm_usage.json に日別で記録し、/cloud-llm/status で見える。
 * - RAG (登録資料・添付ドキュメント) は機密である前提。ragPolicy で扱いを選ぶ:
 *     redact   … 資料の検索結果 (privateTools の結果) と資料由来の system/user メッセージ
 *                (privateMarkers で始まるもの) を外部に送らない。既定
 *     abstract … ブラウザ側でローカルLLMに「機密を伏せた一般化質問」を作らせ、それだけを送る。
 *                外部の一般的な回答と資料の突き合わせはローカルLLMが行う。サーバー側でも redact を掛ける
 *     send     … 資料の検索結果もそのまま送る (公開資料など、外部に出してよい時だけ)
 *
 * 対応プロバイダ:
 *   openai / gemini / openrouter / groq / deepseek / mistral / xai / openai-compatible
 *     … OpenAI Chat Completions 互換 (baseUrl + /chat/completions)
 *   anthropic … Messages API (/v1/messages)。ストリームイベントを OpenAI 形式に変換する
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ─── プロバイダ既定値 ───
// baseUrl は config で上書き可 (自前のプロキシや、互換APIを持つ他社サービス向け)
const PROVIDER_PRESETS = {
  openai: {
    label: 'OpenAI', api: 'openai',
    baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY',
    // 新しい OpenAI モデル (o系/gpt-5系) は max_tokens を受け付けず max_completion_tokens を要求する
    maxTokensParam: 'max_completion_tokens',
  },
  anthropic: {
    label: 'Anthropic', api: 'anthropic',
    baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY',
  },
  gemini: {
    label: 'Google Gemini', api: 'openai',
    // Gemini の OpenAI 互換エンドポイント
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyEnv: 'GEMINI_API_KEY',
  },
  openrouter: {
    label: 'OpenRouter', api: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY',
  },
  groq: {
    label: 'Groq', api: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY',
  },
  deepseek: {
    label: 'DeepSeek', api: 'openai',
    baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY',
  },
  mistral: {
    label: 'Mistral', api: 'openai',
    baseUrl: 'https://api.mistral.ai/v1', apiKeyEnv: 'MISTRAL_API_KEY',
  },
  xai: {
    label: 'xAI', api: 'openai',
    baseUrl: 'https://api.x.ai/v1', apiKeyEnv: 'XAI_API_KEY',
  },
  'openai-compatible': {
    label: 'OpenAI互換', api: 'openai',
    baseUrl: '', apiKeyEnv: 'CLOUD_LLM_API_KEY',
  },
};

const ANTHROPIC_VERSION = '2023-06-01';

// 自動エスカレーションの引き金の既定値 (ブラウザ側が参照する)
const DEFAULT_AUTO_TRIGGERS = {
  ctxExhausted: true,   // コンテキスト不足で途中終了
  lengthCapped: true,   // max_tokens で打ち切り
  thinkingOnly: true,   // 思考だけで回答に到達しなかった
  emptyResponse: true,  // 応答が空
  loopDetected: true,   // 暴走ループを検出
  giveUp: true,         // 「分かりません」等で終わった
  error: true,          // ローカル推論がエラー (llama-server 停止など)
};

// 「分かりません」判定の既定パターン (JS 正規表現の文字列。ブラウザ側で評価する)
const DEFAULT_GIVE_UP_PATTERNS = [
  '(分かりません|わかりません|分かりかねます|お答えできません|回答できません|回答が困難|判断できません)',
  '(情報(が|は)(不足|ありません|見つかりません)|確認できませんでした|持ち合わせていません|知識(が|は)(不足|ありません))',
  '適切な応答を生成できませんでした',
  "\\b(I|we) (don't|do not|cannot|can't) (know|answer|help with)",
];

// ragPolicy が redact / abstract の時に外部へ送らないツールの結果 (関数名)。
// read_file / gdrive_read_file 等も伏せたい場合は config の privateTools に追加する
const DEFAULT_PRIVATE_TOOLS = ['search_documents', 'search_persistent_documents'];

// 資料由来の system/user メッセージの先頭マーカー (ブラウザ側が付ける)。これで始まるものは送らない
//   【前のターンで実際に読んだ資料】 … 出典台帳 (buildSourceLedger)
//   【参考資料                       … 聞き直し時の検索結果の抜粋 (buildCloudRequestMessages)
const DEFAULT_PRIVATE_MARKERS = ['【前のターンで実際に読んだ資料】', '【参考資料'];

const REDACTED_TOOL_TEXT = '[資料の検索結果は機密のため外部には送っていません]';

// abstract モードでブラウザがローカルLLMに渡すプロンプト。{question} {context} が展開される
const DEFAULT_ABSTRACT_PROMPT = 'あなたは機密情報の匿名化担当です。以下の「質問」と「手元の資料」をもとに、外部の汎用AIに聞いても差し支えない「一般化した質問」を1つ作ってください。\n'
  + '- 固有名詞（会社名・製品名・人名・プロジェクト名・型番）、具体的な数値・金額・日付、社内用語、資料の本文はすべて伏せ、一般的な言い換え（「ある製造業の企業」「ある部品」「ある値」など）にする\n'
  + '- 質問の意図（何を知りたいか、どんな考え方・手順・一般知識が必要か）は保つ。資料が無くても答えられる一般的な質問にする\n'
  + '- 出力は一般化した質問の本文のみ（日本語）。前置き・説明・元の情報は書かない\n\n'
  + '## 質問\n{question}\n\n## 手元の資料（外部には出さない。伏せるべき情報の把握用）\n{context}';

// abstract モードで、外部の一般的な回答と手元の資料を突き合わせて最終回答を作るプロンプト
const DEFAULT_COMPOSE_PROMPT = '以下の「ユーザーの質問」に、「手元の資料」と「一般的な知識（外部AIの回答）」を使って日本語で答えてください。\n'
  + '- 資料にある具体的な情報（数値・名称・手順）を優先し、一般的な知識は考え方や手順の補強に使う\n'
  + '- 一般的な知識が資料と食い違う場合は資料を優先し、その旨を一言添える\n'
  + '- 資料に無いことは推測であると明示する\n'
  + '- 回答本文のみを書く（前置きや「外部AIによると」のような出典の説明は不要）\n\n'
  + '## ユーザーの質問\n{question}\n\n## 手元の資料\n{context}\n\n## 一般的な知識（外部AIの回答。一般化した質問「{generalQuestion}」への回答）\n{generalAnswer}';

function createCloudLlm({ getConfig, baseDir, log }) {
  const usageFile = path.join(baseDir || path.join(__dirname, '..', '..'), 'cloud_llm_usage.json');
  const _log = typeof log === 'function' ? log : () => {};

  // ─── 設定の解決 ───
  function resolve() {
    const cfg = getConfig() || {};
    const providerName = String(cfg.provider || 'openai').toLowerCase();
    const preset = PROVIDER_PRESETS[providerName] || PROVIDER_PRESETS['openai-compatible'];
    const apiKeyEnv = cfg.apiKeyEnv || preset.apiKeyEnv;
    const apiKey = (typeof cfg.apiKey === 'string' && cfg.apiKey.trim())
      ? cfg.apiKey.trim()
      : (apiKeyEnv && process.env[apiKeyEnv] ? String(process.env[apiKeyEnv]).trim() : '');
    const baseUrl = String(cfg.baseUrl || preset.baseUrl || '').replace(/\/+$/, '');
    return {
      enabled: !!cfg.enabled,
      provider: providerName,
      api: cfg.api === 'anthropic' || cfg.api === 'openai' ? cfg.api : preset.api,
      label: cfg.label || preset.label,
      baseUrl,
      apiKey,
      apiKeyEnv,
      model: String(cfg.model || ''),
      maxTokens: parseInt(cfg.maxTokens) > 0 ? parseInt(cfg.maxTokens) : 8192,
      // null/undefined なら送らない (推論モデルは temperature を拒否することがある)
      temperature: (typeof cfg.temperature === 'number') ? cfg.temperature : null,
      timeoutMs: parseInt(cfg.timeoutMs) > 0 ? parseInt(cfg.timeoutMs) : 300000,
      maxInputChars: parseInt(cfg.maxInputChars) > 0 ? parseInt(cfg.maxInputChars) : 200000,
      maxRequestsPerDay: parseInt(cfg.maxRequestsPerDay) >= 0 ? parseInt(cfg.maxRequestsPerDay) : 0,
      sendImages: cfg.sendImages !== false,
      sendSystemPrompt: cfg.sendSystemPrompt !== false,
      systemPromptPrefix: typeof cfg.systemPromptPrefix === 'string' ? cfg.systemPromptPrefix : '',
      maxTokensParam: cfg.maxTokensParam || preset.maxTokensParam || 'max_tokens',
      extraBody: (cfg.extraBody && typeof cfg.extraBody === 'object') ? cfg.extraBody : {},
      extraHeaders: (cfg.extraHeaders && typeof cfg.extraHeaders === 'object') ? cfg.extraHeaders : {},
      autoEscalate: !!cfg.autoEscalate,
      autoTriggers: { ...DEFAULT_AUTO_TRIGGERS, ...((cfg.autoTriggers && typeof cfg.autoTriggers === 'object') ? cfg.autoTriggers : {}) },
      giveUpPatterns: Array.isArray(cfg.giveUpPatterns) && cfg.giveUpPatterns.length ? cfg.giveUpPatterns : DEFAULT_GIVE_UP_PATTERNS,
      giveUpMaxChars: parseInt(cfg.giveUpMaxChars) > 0 ? parseInt(cfg.giveUpMaxChars) : 400,
      confirmBeforeSend: cfg.confirmBeforeSend !== false,
      // ── RAG (機密資料) の扱い ──
      ragPolicy: ['redact', 'abstract', 'send'].includes(cfg.ragPolicy) ? cfg.ragPolicy : 'redact',
      privateTools: Array.isArray(cfg.privateTools) ? cfg.privateTools : DEFAULT_PRIVATE_TOOLS,
      privateMarkers: Array.isArray(cfg.privateMarkers) && cfg.privateMarkers.length ? cfg.privateMarkers : DEFAULT_PRIVATE_MARKERS,
      abstractPrompt: (typeof cfg.abstractPrompt === 'string' && cfg.abstractPrompt.trim()) ? cfg.abstractPrompt : DEFAULT_ABSTRACT_PROMPT,
      composePrompt: (typeof cfg.composePrompt === 'string' && cfg.composePrompt.trim()) ? cfg.composePrompt : DEFAULT_COMPOSE_PROMPT,
      abstractCompose: cfg.abstractCompose !== false,
    };
  }

  function isConfigured(r) {
    r = r || resolve();
    return !!(r.enabled && r.apiKey && r.model && r.baseUrl);
  }

  // ─── 利用記録 (日別) ───
  function loadUsage() {
    try {
      if (fs.existsSync(usageFile)) return JSON.parse(fs.readFileSync(usageFile, 'utf-8')) || {};
    } catch {}
    return {};
  }
  function saveUsage(u) {
    try { fs.writeFileSync(usageFile, JSON.stringify(u, null, 2), 'utf-8'); } catch {}
  }
  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function recordUsage({ inputTokens = 0, outputTokens = 0, ok = true, error = '' }) {
    const u = loadUsage();
    u.days = u.days || {};
    const k = todayKey();
    const d = u.days[k] || { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 };
    d.requests += 1;
    if (!ok) d.errors += 1;
    d.inputTokens += inputTokens || 0;
    d.outputTokens += outputTokens || 0;
    u.days[k] = d;
    // 90日より古い記録は捨てる
    const keys = Object.keys(u.days).sort();
    while (keys.length > 90) delete u.days[keys.shift()];
    u.lastAt = new Date().toISOString();
    if (!ok) u.lastError = error; else u.lastError = '';
    saveUsage(u);
    return d;
  }
  function usageSummary() {
    const u = loadUsage();
    const days = u.days || {};
    const today = days[todayKey()] || { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 };
    const monthPrefix = todayKey().slice(0, 7);
    const month = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 };
    for (const [k, d] of Object.entries(days)) {
      if (!k.startsWith(monthPrefix)) continue;
      month.requests += d.requests || 0;
      month.errors += d.errors || 0;
      month.inputTokens += d.inputTokens || 0;
      month.outputTokens += d.outputTokens || 0;
    }
    return { today, month, lastAt: u.lastAt || null, lastError: u.lastError || '' };
  }

  // ブラウザに返してよい状態 (キー・URL・ヘッダは出さない)
  function status() {
    const r = resolve();
    return {
      enabled: r.enabled,
      configured: isConfigured(r),
      provider: r.provider,
      label: r.label,
      model: r.model,
      hasApiKey: !!r.apiKey,
      apiKeySource: r.apiKey ? ((getConfig() || {}).apiKey ? 'config' : `env:${r.apiKeyEnv}`) : null,
      autoEscalate: r.autoEscalate,
      autoTriggers: r.autoTriggers,
      giveUpPatterns: r.giveUpPatterns,
      giveUpMaxChars: r.giveUpMaxChars,
      confirmBeforeSend: r.confirmBeforeSend,
      maxRequestsPerDay: r.maxRequestsPerDay,
      maxInputChars: r.maxInputChars,
      ragPolicy: r.ragPolicy,
      privateTools: r.privateTools,
      privateMarkers: r.privateMarkers,
      abstractPrompt: r.abstractPrompt,
      composePrompt: r.composePrompt,
      abstractCompose: r.abstractCompose,
      usage: usageSummary(),
    };
  }

  // ─── メッセージの正規化 ───
  // ローカル (llama.cpp) 向けに組んだ OpenAI 形式の messages を、外部LLMに渡せる形に畳む。
  //  - tool ロール / tool_calls はテキストに変換 (tool_call_id の整合性を要求するAPIでも通る)
  //  - 途中の system は user に (Anthropic は system を別枠でしか受けない)
  //  - 画像は sendImages=false なら落とす
  //  - 合計文字数が maxInputChars を超えたら、古いツール結果から順に切り詰める
  function partText(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n');
    }
    return String(content);
  }
  function contentLength(content) {
    if (typeof content === 'string') return content.length;
    if (Array.isArray(content)) {
      return content.reduce((s, p) => s + (p?.type === 'text' ? (p.text || '').length : 200), 0);
    }
    return 0;
  }

  // ragPolicy が send 以外なら、資料由来の内容を外部に出さない (ブラウザ側で既に伏せていても
  // ここで必ずもう一度掛ける。外部APIへの唯一の出口はこの関数なので、ここが最後の砦)
  function isPrivateText(text, r) {
    const t = String(text || '').trimStart();
    return r.privateMarkers.some(mk => mk && t.startsWith(mk));
  }

  function normalizeMessages(messages, r) {
    const out = [];
    const redactRag = r.ragPolicy !== 'send';
    let redacted = 0;
    // tool 結果には関数名が無い (tool_call_id だけ) ので、assistant の tool_calls から対応表を作る
    const callNames = new Map();
    for (const m of (Array.isArray(messages) ? messages : [])) {
      if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) if (tc?.id) callNames.set(tc.id, tc.function?.name || tc.name || '');
      }
    }
    for (const m of (Array.isArray(messages) ? messages : [])) {
      if (!m || !m.role) continue;
      if (m.role === 'tool') {
        const fnName = m.name || callNames.get(m.tool_call_id) || '';
        const name = fnName ? ` (${fnName})` : '';
        if (redactRag && (r.privateTools.includes(fnName) || isPrivateText(m.content, r))) {
          redacted++;
          out.push({ role: 'user', content: `[ツール実行結果${name}]\n${REDACTED_TOOL_TEXT}`, _tool: true });
          continue;
        }
        out.push({ role: 'user', content: `[ツール実行結果${name}]\n${partText(m.content)}`, _tool: true });
        continue;
      }
      if (redactRag && (m.role === 'system' || m.role === 'user') && isPrivateText(m.content, r)) {
        redacted++;
        continue;
      }
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        const calls = m.tool_calls
          .map(tc => `${tc.function?.name || tc.name || 'tool'}(${tc.function?.arguments || ''})`)
          .join('\n');
        const txt = [partText(m.content), `[ツール呼び出し]\n${calls}`].filter(Boolean).join('\n');
        out.push({ role: 'assistant', content: txt, _tool: true });
        continue;
      }
      if (m.role === 'system') {
        if (out.length === 0) {
          if (r.sendSystemPrompt) out.push({ role: 'system', content: partText(m.content) });
          continue;
        }
        // 途中の system (会話要約・出典台帳など) は user 扱い
        out.push({ role: 'user', content: partText(m.content) });
        continue;
      }
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      let content = m.content;
      if (Array.isArray(content)) {
        const parts = content.filter(p => p && (p.type === 'text' || (r.sendImages && p.type === 'image_url' && p.image_url?.url)));
        content = parts.every(p => p.type === 'text') ? parts.map(p => p.text || '').join('\n') : parts;
      } else {
        content = partText(content);
      }
      // 空の assistant (思考のみで終わった等) は落とす。空のテキストを拒否するAPIがある
      if (m.role === 'assistant' && contentLength(content) === 0) continue;
      out.push({ role: m.role, content });
    }
    if (r.systemPromptPrefix) {
      if (out[0]?.role === 'system') out[0].content = `${r.systemPromptPrefix}\n\n${out[0].content}`;
      else out.unshift({ role: 'system', content: r.systemPromptPrefix });
    }

    // 送信量の上限: 古いツール結果から切り詰め、それでも足りなければ古い会話を落とす
    const total = () => out.reduce((s, m) => s + contentLength(m.content), 0);
    let truncated = 0;
    if (total() > r.maxInputChars) {
      for (const m of out) {
        if (total() <= r.maxInputChars) break;
        if (!m._tool || typeof m.content !== 'string' || m.content.length <= 2000) continue;
        m.content = m.content.slice(0, 2000) + '\n…(送信量の上限のため省略)';
        truncated++;
      }
      // system と直近4件は残し、その間の古いものから落とす
      while (total() > r.maxInputChars && out.length > 5) {
        const idx = out[0]?.role === 'system' ? 1 : 0;
        if (idx >= out.length - 4) break;
        out.splice(idx, 1);
        truncated++;
      }
    }
    for (const m of out) delete m._tool;
    return { messages: out, truncated, redacted };
  }

  // OpenAI 形式 → Anthropic Messages 形式
  function toAnthropic(messages) {
    let system = '';
    const msgs = [];
    for (const m of messages) {
      if (m.role === 'system') { system = system ? `${system}\n\n${partText(m.content)}` : partText(m.content); continue; }
      let content;
      if (Array.isArray(m.content)) {
        content = [];
        for (const p of m.content) {
          if (p.type === 'text') { if (p.text) content.push({ type: 'text', text: p.text }); continue; }
          if (p.type === 'image_url') {
            const mm = /^data:([^;]+);base64,(.+)$/s.exec(p.image_url?.url || '');
            if (mm) content.push({ type: 'image', source: { type: 'base64', media_type: mm[1], data: mm[2] } });
            else if (p.image_url?.url) content.push({ type: 'image', source: { type: 'url', url: p.image_url.url } });
          }
        }
        if (content.length === 0) continue;
      } else {
        content = [{ type: 'text', text: String(m.content || '') }];
        if (!content[0].text) continue;
      }
      // 同じロールの連続は1つに結合 (Anthropic は user/assistant の交互を要求)
      const last = msgs[msgs.length - 1];
      if (last && last.role === m.role) {
        last.content.push(...content);
      } else {
        msgs.push({ role: m.role, content });
      }
    }
    if (msgs.length === 0 || msgs[0].role !== 'user') {
      msgs.unshift({ role: 'user', content: [{ type: 'text', text: '(会話の続き)' }] });
    }
    return { system, messages: msgs };
  }

  // ─── HTTP ───
  function requestJson(urlStr, { method = 'POST', headers = {}, body, timeoutMs }) {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(urlStr); } catch (e) { return reject(new Error(`baseUrl が不正です: ${urlStr}`)); }
      const mod = u.protocol === 'http:' ? http : https;
      const payload = body != null ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf-8') : null;
      const req = mod.request({
        hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search, method,
        headers: { ...headers, ...(payload ? { 'content-length': payload.length } : {}) },
        timeout: timeoutMs,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let json = null;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, json, text });
        });
      });
      req.on('timeout', () => { req.destroy(new Error(`外部LLM タイムアウト (${timeoutMs}ms)`)); });
      req.on('error', reject);
      if (payload) req.end(payload); else req.end();
    });
  }

  // ストリーミング要求。SSE の data 行ごとに onData(dataStr) を呼ぶ。
  // 戻り値の abort() で上流を切る (ブラウザが停止した時用)
  function requestStream(urlStr, { headers = {}, body, timeoutMs }, { onData, onEnd, onError }) {
    let u;
    try { u = new URL(urlStr); } catch (e) { onError(new Error(`baseUrl が不正です: ${urlStr}`)); return { abort() {} }; }
    const mod = u.protocol === 'http:' ? http : https;
    const payload = Buffer.from(JSON.stringify(body), 'utf-8');
    let ended = false;
    const finish = (fn, arg) => { if (ended) return; ended = true; fn(arg); };
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, method: 'POST',
      headers: { ...headers, 'content-length': payload.length, 'accept': 'text/event-stream' },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        // エラー本文は JSON で来る。まとめて読んでメッセージにする
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          finish(onError, new Error(formatApiError(res.statusCode, text)));
        });
        return;
      }
      let buffer = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          if (line.startsWith('data:')) {
            const d = line.slice(5).trim();
            if (d) { try { onData(d); } catch (e) { finish(onError, e); req.destroy(); return; } }
          }
          // "event:" 行は data の中の type で判別できるので読み飛ばす
        }
      });
      res.on('end', () => finish(onEnd));
      res.on('error', (e) => finish(onError, e));
    });
    req.on('timeout', () => { req.destroy(new Error(`外部LLM タイムアウト (${timeoutMs}ms)`)); });
    req.on('error', (e) => finish(onError, e));
    req.end(payload);
    return { abort() { try { req.destroy(); } catch {} } };
  }

  function formatApiError(status, text) {
    let msg = '';
    try {
      const j = JSON.parse(text);
      msg = j?.error?.message || j?.message || j?.error?.type || (typeof j?.error === 'string' ? j.error : '');
    } catch {}
    if (!msg) msg = String(text || '').slice(0, 300);
    const hint = status === 401 ? ' — APIキーが無効か未設定です'
      : status === 403 ? ' — このキーではアクセスが許可されていません'
      : status === 404 ? ' — model 名か baseUrl が違う可能性があります'
      : status === 429 ? ' — レート制限か残高不足です'
      : '';
    return `外部LLM API エラー ${status}${hint}: ${msg}`;
  }

  // ─── プロバイダ毎のリクエスト組み立て ───
  function buildOpenAiRequest(r, messages, { maxTokens, stream }) {
    const body = {
      model: r.model,
      messages,
      stream: !!stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      [r.maxTokensParam]: maxTokens,
      ...(r.temperature != null ? { temperature: r.temperature } : {}),
      ...r.extraBody,
    };
    const headers = {
      'content-type': 'application/json',
      'authorization': `Bearer ${r.apiKey}`,
      ...r.extraHeaders,
    };
    return { url: `${r.baseUrl}/chat/completions`, headers, body };
  }

  function buildAnthropicRequest(r, messages, { maxTokens, stream }) {
    const conv = toAnthropic(messages);
    const body = {
      model: r.model,
      max_tokens: maxTokens,
      messages: conv.messages,
      ...(conv.system ? { system: conv.system } : {}),
      stream: !!stream,
      ...(r.temperature != null ? { temperature: r.temperature } : {}),
      ...r.extraBody,
    };
    const headers = {
      'content-type': 'application/json',
      'x-api-key': r.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      ...r.extraHeaders,
    };
    return { url: `${r.baseUrl}/v1/messages`, headers, body };
  }

  // 上流のストリームイベント (プロバイダ形式) → 共通デルタ { content, reasoning, finish, usage }
  function parseOpenAiChunk(dataStr) {
    if (dataStr === '[DONE]') return { done: true };
    let j; try { j = JSON.parse(dataStr); } catch { return null; }
    if (j.error) throw new Error(`外部LLM API エラー: ${j.error.message || JSON.stringify(j.error)}`);
    const ch = j.choices?.[0];
    const delta = ch?.delta || {};
    const out = {};
    if (delta.content) out.content = delta.content;
    // OpenRouter/DeepSeek 等は reasoning / reasoning_content で思考を返す
    const reasoning = delta.reasoning_content || delta.reasoning;
    if (reasoning) out.reasoning = reasoning;
    if (ch?.finish_reason) out.finish = ch.finish_reason;
    if (j.usage) out.usage = { prompt_tokens: j.usage.prompt_tokens || 0, completion_tokens: j.usage.completion_tokens || 0 };
    return out;
  }

  function parseAnthropicEvent(dataStr, state) {
    let j; try { j = JSON.parse(dataStr); } catch { return null; }
    const out = {};
    switch (j.type) {
      case 'message_start':
        state.inputTokens = j.message?.usage?.input_tokens || 0;
        break;
      case 'content_block_delta':
        if (j.delta?.type === 'text_delta' && j.delta.text) out.content = j.delta.text;
        else if (j.delta?.type === 'thinking_delta' && j.delta.thinking) out.reasoning = j.delta.thinking;
        break;
      case 'message_delta':
        if (j.delta?.stop_reason) {
          out.finish = j.delta.stop_reason === 'max_tokens' ? 'length' : 'stop';
        }
        if (j.usage) {
          state.outputTokens = j.usage.output_tokens || 0;
          out.usage = { prompt_tokens: state.inputTokens || j.usage.input_tokens || 0, completion_tokens: state.outputTokens };
        }
        break;
      case 'message_stop':
        return { done: true };
      case 'error':
        throw new Error(`外部LLM API エラー: ${j.error?.message || JSON.stringify(j.error)}`);
      default:
        break;
    }
    return out;
  }

  // ─── 実行 (共通) ───
  // messages: OpenAI 形式。onDelta(delta) がストリーム毎に呼ばれ、最後に集計を返す
  function run({ messages, maxTokens, onDelta, onAbortHandle }) {
    const r = resolve();
    if (!r.enabled) return Promise.reject(Object.assign(new Error('外部LLM は無効です (config.json の cloudLlm.enabled)'), { status: 400 }));
    if (!r.apiKey) return Promise.reject(Object.assign(new Error(`外部LLM の API キーが設定されていません (cloudLlm.apiKey か環境変数 ${r.apiKeyEnv})`), { status: 400 }));
    if (!r.model) return Promise.reject(Object.assign(new Error('外部LLM の model が設定されていません (cloudLlm.model)'), { status: 400 }));
    if (!r.baseUrl) return Promise.reject(Object.assign(new Error('外部LLM の baseUrl が設定されていません (cloudLlm.baseUrl)'), { status: 400 }));
    if (r.maxRequestsPerDay > 0) {
      const today = usageSummary().today;
      if (today.requests >= r.maxRequestsPerDay) {
        return Promise.reject(Object.assign(new Error(`外部LLM の1日の上限 (${r.maxRequestsPerDay}回) に達しました。config.json の cloudLlm.maxRequestsPerDay で変更できます`), { status: 429 }));
      }
    }

    const norm = normalizeMessages(messages, r);
    const mt = Math.max(1, Math.min(parseInt(maxTokens) || r.maxTokens, r.maxTokens));
    const built = r.api === 'anthropic'
      ? buildAnthropicRequest(r, norm.messages, { maxTokens: mt, stream: true })
      : buildOpenAiRequest(r, norm.messages, { maxTokens: mt, stream: true });

    const chars = norm.messages.reduce((s, m) => s + contentLength(m.content), 0);
    return new Promise((resolvePromise, rejectPromise) => {
      const acc = { content: '', reasoning: '', finish: null, usage: null, truncated: norm.truncated, redacted: norm.redacted, ragPolicy: r.ragPolicy, chars, provider: r.provider, model: r.model, label: r.label };
      const state = {};
      const handle = requestStream(built.url, { headers: built.headers, body: built.body, timeoutMs: r.timeoutMs }, {
        onData: (d) => {
          const delta = r.api === 'anthropic' ? parseAnthropicEvent(d, state) : parseOpenAiChunk(d);
          if (!delta || delta.done) return;
          if (delta.content) acc.content += delta.content;
          if (delta.reasoning) acc.reasoning += delta.reasoning;
          if (delta.finish) acc.finish = delta.finish;
          if (delta.usage) acc.usage = delta.usage;
          if (onDelta) onDelta(delta);
        },
        onEnd: () => {
          recordUsage({ inputTokens: acc.usage?.prompt_tokens || 0, outputTokens: acc.usage?.completion_tokens || 0, ok: true });
          resolvePromise(acc);
        },
        onError: (e) => {
          recordUsage({ ok: false, error: e.message });
          rejectPromise(e);
        },
      });
      if (onAbortHandle) onAbortHandle(handle);
    });
  }

  // ─── Express ハンドラ: POST /cloud/v1/chat/completions (OpenAI 互換で返す) ───
  async function handleChatCompletions(req, res, ip) {
    const body = req.body || {};
    const stream = body.stream !== false;
    const r = resolve();
    const started = Date.now();
    const id = `cloud-${started.toString(36)}`;
    let upstream = null;
    let clientGone = false;
    // ブラウザが停止ボタンで切った時は上流も切る (課金を止める)。
    // req の 'close' は Node 16+ ではボディ読み込み完了で発火してしまう (jsonParser 経由だと
    // ハンドラ到達時点で既に完了) ので、res 側の 'close' を見て「書き終える前に閉じた」で判定する
    res.on('close', () => {
      if (res.writableFinished) return;
      clientGone = true;
      if (upstream) upstream.abort();
    });

    const chunk = (delta, extra) => JSON.stringify({
      id, object: 'chat.completion.chunk', created: Math.floor(started / 1000), model: `${r.provider}/${r.model}`,
      choices: [{ index: 0, delta, finish_reason: extra?.finish || null }],
      ...(extra?.usage ? { usage: extra.usage } : {}),
    });

    if (stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      });
      // 接続確立を先に知らせる (プロバイダの初回トークンまで無音だとブラウザが不安になる)
      res.write(': cloud-llm connected\n\n');
    }

    try {
      _log(ip, `CLOUD LLM → ${r.label} (${r.model}) messages=${(body.messages || []).length}${stream ? ' stream' : ''}`);
      const acc = await run({
        messages: body.messages,
        maxTokens: body.max_tokens || body.max_completion_tokens,
        onAbortHandle: (h) => { upstream = h; if (clientGone) h.abort(); },
        onDelta: stream ? (d) => {
          if (clientGone) return;
          const delta = {};
          if (d.content) delta.content = d.content;
          if (d.reasoning) delta.reasoning_content = d.reasoning;
          if (Object.keys(delta).length > 0) res.write(`data: ${chunk(delta)}\n\n`);
        } : null,
      });
      const usage = acc.usage || { prompt_tokens: 0, completion_tokens: 0 };
      usage.total_tokens = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
      _log(ip, `CLOUD LLM ← ${r.label} ${acc.finish || 'stop'} in=${usage.prompt_tokens} out=${usage.completion_tokens} (${Date.now() - started}ms)${acc.truncated ? ` truncated=${acc.truncated}` : ''}${acc.redacted ? ` redacted=${acc.redacted} (ragPolicy=${acc.ragPolicy})` : ''}`);
      if (stream) {
        if (!clientGone) {
          res.write(`data: ${chunk({}, { finish: acc.finish || 'stop', usage })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      } else {
        res.json({
          id, object: 'chat.completion', created: Math.floor(started / 1000), model: `${r.provider}/${r.model}`,
          choices: [{ index: 0, message: { role: 'assistant', content: acc.content, ...(acc.reasoning ? { reasoning_content: acc.reasoning } : {}) }, finish_reason: acc.finish || 'stop' }],
          usage,
          cloud_llm: { provider: r.provider, label: r.label, model: r.model, truncated: acc.truncated, redacted: acc.redacted, ragPolicy: acc.ragPolicy, inputChars: acc.chars },
        });
      }
    } catch (e) {
      _log(ip, `CLOUD LLM ERROR ${e.message}`);
      if (stream) {
        if (!clientGone) {
          // ブラウザ側は data 内の error を見て例外にする
          res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      } else if (!res.headersSent) {
        res.status(e.status || 502).json({ error: e.message });
      }
    }
  }

  // 設定確認用の疎通テスト (短い応答を1回もらう)
  async function test() {
    const started = Date.now();
    const acc = await run({
      messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
      maxTokens: 16,
    });
    return {
      ok: true,
      provider: acc.provider, label: acc.label, model: acc.model,
      reply: acc.content.trim().slice(0, 100),
      latencyMs: Date.now() - started,
      usage: acc.usage,
    };
  }

  return { resolve, isConfigured, status, run, handleChatCompletions, test, normalizeMessages, toAnthropic, PROVIDER_PRESETS, DEFAULT_AUTO_TRIGGERS, DEFAULT_GIVE_UP_PATTERNS, DEFAULT_PRIVATE_TOOLS, DEFAULT_PRIVATE_MARKERS };
}

module.exports = { createCloudLlm, PROVIDER_PRESETS, DEFAULT_AUTO_TRIGGERS, DEFAULT_GIVE_UP_PATTERNS, DEFAULT_PRIVATE_TOOLS, DEFAULT_PRIVATE_MARKERS, DEFAULT_ABSTRACT_PROMPT, DEFAULT_COMPOSE_PROMPT };
