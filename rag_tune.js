// ════════════════════════════════════════════════════════════════
// rag_tune.js — 永続RAG から ファインチューニング教師データを作る
// ════════════════════════════════════════════════════════════════
//
// 何をするモジュールか
//   ml/rag/ に登録済みのドキュメント (PDF OCR / HTML取り込み / 手動登録) を読み、
//   検索用のチャンクを「パッセージ」に束ね直して LLM に投げ、
//   「そのパッセージだけで答えられる Q&A」を作らせて JSONL に貯める。
//   貯めたものを tuning/samples.jsonl (学習サンプルDB) に取り込めば、
//   そのまま tune_runner.py の LoRA SFT 学習データになる。
//
// なぜ RAG を素材にするのか
//   - チャンクは既に「意味のまとまり」に割れていて、ページ番号も持っている
//     (OCRジョブが埋めた pages)。出典付きの教師データがタダで作れる。
//   - RAG に入っている = そのモデルに答えてほしい社内知識、という選別が済んでいる。
//   - 同じ素材から「知識注入型 (closed)」と「RAG運用型 (open)」の両方を出せる。
//
// 生成の流れ (1パッセージにつき最大3回のLLM呼び出し)
//   ① 生成   : パッセージ → Q&A を n 件 (JSON配列で出させる)
//   ② 拒否例 : パッセージ → 「近いけれど資料には書かれていない」質問を作らせ、
//              回答は定型の「記載がありません」に差し替える (範囲外の作文抑制)
//   ③ 検証   : ①の各Q&Aを別プロンプトで判定 (資料に書かれているか / 質問が自立しているか)
//   ①②の間に機械的なフィルタ (指示語・数値の裏取り・文字n-gramの被覆率・重複) を挟む。
//   LLMは平気で「資料に無い一般論」を足すので、機械チェックとLLM検証の二段構えにしてある。
//
// 出力 (ml/ragtune/out/<jobId>.jsonl) は1行1レコード:
//   { id, kind: 'qa'|'refusal', question, answer, context, source: {...},
//     status: 'accepted'|'rejected', reason, checks: {...}, createdAt }
//   context (パッセージ原文) を各行に持たせているのは、取り込み時に
//   closed / open のどちらの形にも展開できるようにするため。
//
// 依存は fs / path / グローバル fetch のみ (追加パッケージなし)。
// LLM の確保はサーバー側から注入する (llm.acquire)。OCR と同じく
// LLMプール管理なら生成中だけロードされ、終わればアイドルアンロードに任せる。

const fs = require('fs');
const path = require('path');

const MAX_JOBS = 200;                          // jobs.json に残す上限
const ACTIVE_STATUSES = ['pending', 'running'];

// ─── 既定プロンプト ────────────────────────────────────────────
// config.json の tuning.ragDataset に同名キーがあればそちらが優先される。
// ここに置いてあるのは「config が空でも動く」ための実体で、
// 文面の設計意図は DESIGN.md「RAGから教師データを作る設計」に書いてある。

const DEFAULT_GENERATE_PROMPT = `あなたは社内ドキュメントから、LLMのファインチューニング用の教師データ（質問と回答の組）を作る担当者です。

# 手順
1. 【資料】を読み、そこに**書かれている事実だけ**で答えられる質問を最大 {n} 件作る。
2. 質問は、資料を見ていない人が実際に尋ねそうな自然な日本語にする。
3. 回答は資料の記述だけを根拠に、固有名詞・数値・単位・型番・条件をそのまま使って書く。

# 必ず守るルール
- 資料に書かれていないことは、一般常識であっても書かない（推測で補わない）。
- 質問に「この資料」「本文書」「上記」などの指示語を使わない。資料が手元に無くても意味が通る、独立した質問にする。
  × 「この製品の重量は？」 ○ 「OG-100 の本体重量は？」
  対象を特定する固有名詞（製品名・型番・章のテーマ・制度名）を必ず質問文に入れる。
- 回答にも「資料によると」「本文書では」などのメタ表現を使わない。事実をそのまま述べる。
- 数値・単位・型番・日付・数式は資料の表記どおりに写す（丸めない、換算しない、一般形に書き直さない）。
- 回答は {minChars}〜{maxChars} 文字程度。手順や列挙は箇条書きにしてよい。
- 質問の種類を散らす: {styles}
- 同じ事実を複数回問うときは、言い回し・粒度・敬体/常体を変える（同じ文の言い換えを並べない）。
- 資料が目次・奥付・ページ番号の羅列など、事実として使える情報を含まない場合は空配列 [] を返す。

# 出力形式
JSON配列だけを出力する。前置き・解説・コードフェンスは書かない。
[{"q": "質問文", "a": "回答文"}]

【資料】{source}
----------------
{passage}
----------------`;

const DEFAULT_REFUSAL_PROMPT = `あなたは社内ドキュメントQAシステムの試験担当です。

【資料】を読み、**資料の話題には近いが、資料には答えが書かれていない**質問を最大 {n} 件作ってください。
これは「知らないことを知らないと言わせる」ための試験問題です。

# ルール
- 資料と同じ製品・制度・章を対象にした、いかにも聞かれそうな質問にする（無関係な雑談はダメ）。
- 資料を読めば答えが分かる質問は作らない（それは別で作ってある）。
- 「この資料」「上記」などの指示語を使わず、単体で意味が通る質問にする。
- 回答は作らない。質問だけを出す。

# 出力形式
JSON配列だけを出力する。前置き・解説・コードフェンスは書かない。
["質問文", "質問文"]

【資料】{source}
----------------
{passage}
----------------`;

const DEFAULT_VERIFY_PROMPT = `次の【資料】と、それを元に作られた【質問】【回答】を検査してください。

# 判定基準（すべて満たすときだけ ok = true）
1. 回答の内容がすべて資料に書かれている（資料に無い情報を足していない）。
2. 数値・単位・固有名詞・型番が資料と一致している。
3. 質問が資料を見なくても意味が通る（「この資料」等の指示語や、対象が特定できない曖昧さが無い）。
4. 回答が質問に正面から答えている。

# 出力形式
JSONだけを出力する。前置き・解説・コードフェンスは書かない。
{"ok": true, "reason": ""}
問題があるときは ok を false にし、reason に理由を20文字程度で書く。

【資料】
----------------
{passage}
----------------
【質問】
{question}
【回答】
{answer}`;

// 学習サンプルに載せる system プロンプト (取り込み時に使う)
const DEFAULT_CLOSED_SYSTEM = 'あなたは社内ドキュメントに詳しいアシスタントです。質問には、確認できている事実だけを簡潔な日本語で答えてください。知らないことは知らないと答えてください。';
const DEFAULT_OPEN_SYSTEM = 'あなたは社内ドキュメント検索の回答役です。与えられた資料に書かれていることだけを根拠に、日本語で簡潔に答えてください。資料に無いことは「登録資料には記載がありません」と答えてください。';

// open (RAG運用型) の入力テンプレート。
// チャット側が検索結果をLLMへ渡すときの体裁 (── 資料 S1 ── / 出典キー: S1) に
// 合わせてある。学習時と推論時で入力の見た目が違うと、せっかく覚えた
// 「資料を読んで答える型」が推論時に発火しないため。
const DEFAULT_CONTEXT_TEMPLATE = `── 資料 {key} ──
出典キー: {key}   ({source})
{context}
── ここまでが {key} の内容 ──

上記の資料だけを根拠に、次の質問へ答えてください。使った記述の末尾には【{key}】と出典キーを書いてください。

【質問】
{question}`;

const DEFAULT_STYLES = [
  '事実確認（〜は何か / いくつか）',
  '定義・用語の説明',
  '手順・操作方法',
  '条件・制約（〜のときはどうなるか）',
  '数値・仕様の確認',
  '原因・理由（なぜそうなるか）',
  'トラブル対応',
];

const DEFAULT_REFUSAL_ANSWERS = [
  '登録されている資料には、その記載が見つかりませんでした。',
  '手元の資料にはその情報が含まれていません。原典を確認してください。',
  'その点については資料に記載がありません。分かる範囲では回答できません。',
];

// 質問に混ざると教師データとして使えなくなる指示語 (資料が手元にある前提の聞き方)
const DEICTIC_RE = /(この|その|本|上記|下記|以下|前述|添付|当該)\s*(資料|文書|文章|ドキュメント|マニュアル|ページ|章|節|項|表|図|コード|内容|記事|部分)|上記の|前掲|同資料/;
// 回答に混ざると学習後に「資料によると…」と言い出す原因になるメタ表現
const META_RE = /(資料|文書|本文|文脈|コンテキスト|テキスト|記事|ページ)(に|には|では|によ|上)|提示され(た|ている)|与えられた情報|添付され/;

// ─── 小物 ────────────────────────────────────────────────────

/** 思考タグ (Qwen3系などが吐く <think>…</think>) を落とす */
function stripThink(s) {
  return String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim();
}

/** 全体を包んでいるコードフェンスだけ剥がす */
function stripFence(s) {
  const m = String(s || '').trim().match(/^```(?:json|jsonl|javascript)?\s*\n([\s\S]*?)\n?```$/i);
  return m ? m[1].trim() : String(s || '').trim();
}

/** {key} 形式のプレースホルダを埋める (値が undefined のキーはそのまま残さず空にする) */
function renderTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (all, k) => (k in vars ? String(vars[k] ?? '') : all));
}

/**
 * LLM の出力から Q&A の配列を取り出す。
 * JSON配列が基本だが、モデルによっては JSONL・前置き付き・
 * 配列の途中で max_tokens 切れ、といった形で返ってくる。
 * 「きれいなJSONだけ受け付ける」と歩留まりが落ちるので、
 * 壊れた末尾は捨てて拾えるオブジェクトだけ拾う。
 */
function parseQaList(raw) {
  const text = stripFence(stripThink(raw));
  if (!text) return [];
  const out = [];

  // ① まず素直に JSON として読む (配列 / {items:[...]} / 単体オブジェクト)
  const direct = tryParseJson(text);
  if (direct) {
    for (const v of toArray(direct)) {
      const qa = toQa(v);
      if (qa) out.push(qa);
    }
    if (out.length) return out;
  }

  // ② 配列らしき範囲を切り出して読む (前置き・後書きを捨てる)
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    const sliced = tryParseJson(text.slice(start, end + 1));
    if (sliced) {
      for (const v of toArray(sliced)) {
        const qa = toQa(v);
        if (qa) out.push(qa);
      }
      if (out.length) return out;
    }
  }

  // ③ 最後の手段: {...} を1件ずつ拾う (途中で切れた配列や JSONL に効く)
  const objRe = /\{[^{}]*\}/g;
  let m;
  while ((m = objRe.exec(text)) !== null) {
    const v = tryParseJson(m[0]);
    const qa = v && toQa(v);
    if (qa) out.push(qa);
  }
  // ④ それでも駄目なら、素の文字列配列 (拒否例プロンプトの出力) を拾う
  if (out.length === 0) {
    const strRe = /"((?:[^"\\]|\\.){4,300})"/g;
    while ((m = strRe.exec(text)) !== null) {
      const s = m[1].replace(/\\"/g, '"').trim();
      if (s.length >= 4) out.push({ q: s, a: '' });
    }
  }
  return out;
}

function tryParseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    for (const key of ['items', 'data', 'qa', 'pairs', 'questions', 'result', 'results']) {
      if (Array.isArray(v[key])) return v[key];
    }
    return [v];
  }
  return [];
}

/** ゆるいキー名ゆれ (question/answer, instruction/response) を吸収する */
function toQa(v) {
  if (typeof v === 'string') {
    const s = v.trim();
    return s ? { q: s, a: '' } : null;
  }
  if (!v || typeof v !== 'object') return null;
  const q = v.q ?? v.question ?? v.instruction ?? v.input ?? v.prompt;
  const a = v.a ?? v.answer ?? v.response ?? v.output ?? '';
  if (typeof q !== 'string' || !q.trim()) return null;
  return { q: q.trim(), a: typeof a === 'string' ? a.trim() : '' };
}

/** 検証プロンプトの出力 ({"ok":true,...}) を読む。読めなければ null */
function parseVerdict(raw) {
  const text = stripFence(stripThink(raw));
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const v = (start >= 0 && end > start) ? tryParseJson(text.slice(start, end + 1)) : tryParseJson(text);
  if (v && typeof v === 'object' && 'ok' in v) {
    return { ok: v.ok === true || v.ok === 'true', reason: String(v.reason || v.why || '').slice(0, 120) };
  }
  // JSONで返せないモデル向けの保険 (「はい」「OK」「true」だけ返す個体がいる)
  if (/^(ok|true|はい|yes|良い|問題ありません)/i.test(text)) return { ok: true, reason: '' };
  if (/^(ng|false|いいえ|no|問題)/i.test(text)) return { ok: false, reason: text.slice(0, 120) };
  return null;
}

/** 比較用に質問を正規化 (空白・記号・全角半角のゆれを潰す) */
function normalizeQuestion(s) {
  return String(s || '')
    .replace(/[\s　]+/g, '')
    .replace(/[？?。、,.!！「」『』（）()\[\]【】:：;；・\-—]/g, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .toLowerCase();
}

/** 文字 n-gram 集合 (日本語は分かち書きできないので文字単位で見る) */
function ngrams(s, n = 3) {
  const t = String(s || '').replace(/[\s　]+/g, '');
  const set = new Set();
  for (let i = 0; i + n <= t.length; i++) set.add(t.slice(i, i + n));
  if (set.size === 0 && t) set.add(t);
  return set;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 回答の n-gram のうち、何割がパッセージに存在するか (grounding の安い代用) */
function coverage(answer, passage) {
  const a = ngrams(answer, 3);
  if (a.size === 0) return 1;
  const p = ngrams(passage, 3);
  let hit = 0;
  for (const g of a) if (p.has(g)) hit++;
  return hit / a.size;
}

/** 数値トークンを拾う (全角→半角、桁区切りのカンマは除去) */
function numbersIn(s) {
  const t = String(s || '').replace(/[０-９．，]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  return (t.match(/\d+(?:[.,]\d+)*/g) || []).map(n => n.replace(/,/g, ''));
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}

function clampNum(v, min, max, dflt) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}

// ════════════════════════════════════════════════════════════════
// マネージャ本体
// ════════════════════════════════════════════════════════════════
/**
 * @param {object}   deps
 * @param {Function} deps.getConfig   () => config.json の tuning.ragDataset
 * @param {string}   deps.baseDir     アプリのルート (相対パス解決用)
 * @param {Function} deps.log         (ip, msg) => void
 * @param {Function} deps.listDocs    () => [{docId, filename, category, chunkCount}]
 * @param {Function} deps.loadDoc     (docId) => {docId, filename, chunks, pages, overlap, category} | null
 * @param {object}   deps.llm         { check(), acquire() } 生成用LLMの確保
 * @param {Function} deps.addSamples  (rows) => {added, total}  学習サンプルDBへの追記
 */
function createRagTuneManager({
  getConfig,
  baseDir,
  log = () => {},
  listDocs = () => [],
  loadDoc = () => null,
  llm = null,
  addSamples = null,
}) {
  const cfg = () => (getConfig() || {});

  const resolveDir = (v, dflt) => {
    const s = v || dflt;
    return path.isAbsolute(s) ? s : path.join(baseDir, s);
  };
  const jobsFile = () => resolveDir(cfg().jobsFile, 'ml/ragtune/jobs.json');
  const outDir = () => resolveDir(cfg().outputDir, 'ml/ragtune/out');
  const outPath = (jobId) => path.join(outDir(), `${jobId}.jsonl`);

  const running = new Map();    // jobId → { cancelled, abort }
  const listeners = new Map();  // jobId → Set<fn> (SSE配信)
  let jobs = [];
  let loaded = false;

  function isEnabled() {
    return cfg().enabled !== false;
  }

  // ─── 永続化 ──────────────────────────────────────────────

  function ensureDirs() {
    try { fs.mkdirSync(path.dirname(jobsFile()), { recursive: true }); } catch {}
    try { fs.mkdirSync(outDir(), { recursive: true }); } catch {}
  }

  function loadJobs() {
    if (loaded) return jobs;
    ensureDirs();
    try {
      if (fs.existsSync(jobsFile())) {
        const data = JSON.parse(fs.readFileSync(jobsFile(), 'utf-8'));
        jobs = Array.isArray(data) ? data : (data.jobs || []);
      }
    } catch (e) {
      log('-', `[RAG教師データ] jobs.json 読み込み失敗: ${e.message}`);
      jobs = [];
    }
    loaded = true;
    return jobs;
  }

  function saveJobs() {
    try {
      ensureDirs();
      fs.writeFileSync(jobsFile(), JSON.stringify(jobs.slice(0, MAX_JOBS), null, 2), 'utf-8');
    } catch (e) {
      log('-', `[RAG教師データ] jobs.json 保存失敗: ${e.message}`);
    }
  }

  function findJob(jobId) {
    return loadJobs().find(j => j.jobId === jobId) || null;
  }

  function requireJob(jobId) {
    const job = findJob(jobId);
    if (!job) { const e = new Error('ジョブが見つかりません'); e.status = 404; throw e; }
    return job;
  }

  // ─── SSE ────────────────────────────────────────────────

  function subscribe(jobId, fn) {
    if (!listeners.has(jobId)) listeners.set(jobId, new Set());
    listeners.get(jobId).add(fn);
    return () => {
      const set = listeners.get(jobId);
      if (!set) return;
      set.delete(fn);
      if (set.size === 0) listeners.delete(jobId);
    };
  }

  function emitEvent(jobId, event) {
    const set = listeners.get(jobId);
    if (!set) return;
    for (const fn of set) { try { fn(event); } catch {} }
  }

  function jobView(job) {
    if (!job) return null;
    const elapsedMs = job.startedAt
      ? ((job.status === 'running' ? Date.now() : (job.finishedAt || job.startedAt)) - job.startedAt)
      : 0;
    return {
      jobId: job.jobId,
      title: job.title,
      docs: job.docs || [],              // [{docId, filename, category}]
      status: job.status,
      phase: job.phase || null,
      params: job.params,
      passagesTotal: job.passagesTotal || 0,
      passagesDone: job.passagesDone || 0,
      generated: job.generated || 0,     // LLMが出した件数 (機械フィルタ前)
      accepted: job.accepted || 0,
      rejected: job.rejected || 0,
      refusals: job.refusals || 0,       // accepted のうち拒否サンプル
      imported: job.imported || 0,       // 学習サンプルDBへ取り込んだ件数
      llmCalls: job.llmCalls || 0,
      error: job.error || null,
      interrupted: !!job.interrupted,
      createdAt: job.createdAt,
      startedAt: job.startedAt || null,
      finishedAt: job.finishedAt || null,
      elapsedMs,
    };
  }

  function setStatus(job, status, extra = {}) {
    job.status = status;
    Object.assign(job, extra);
    saveJobs();
    emitEvent(job.jobId, { type: 'status', job: jobView(job) });
  }

  function touch(job) {
    saveJobs();
    emitEvent(job.jobId, { type: 'status', job: jobView(job) });
  }

  // ─── パラメータ解決 ───────────────────────────────────────
  // 既定値は config.json (tuning.ragDataset)、ジョブ作成時の指定が最優先。
  // プロンプトもジョブごとに上書きできる (UIのテキストエリアで編集して試せる)。

  function resolveParams(raw = {}) {
    const c = cfg();
    const pick = (key, dflt) => (raw[key] !== undefined && raw[key] !== null && raw[key] !== '' ? raw[key]
      : (c[key] !== undefined && c[key] !== null && c[key] !== '' ? c[key] : dflt));
    const mode = ['closed', 'open', 'both'].includes(String(pick('mode', 'closed'))) ? String(pick('mode', 'closed')) : 'closed';
    const styles = Array.isArray(pick('styles', null)) ? pick('styles', null) : DEFAULT_STYLES;
    const refusalAnswers = Array.isArray(pick('refusalAnswers', null)) ? pick('refusalAnswers', null) : DEFAULT_REFUSAL_ANSWERS;
    return {
      mode,
      passageChunks: clampInt(pick('passageChunks', 3), 1, 20, 3),
      maxPassageChars: clampInt(pick('maxPassageChars', 4000), 300, 20000, 4000),
      minPassageChars: clampInt(pick('minPassageChars', 200), 0, 5000, 200),
      maxPassages: clampInt(pick('maxPassages', 0), 0, 100000, 0),      // 0 = 制限なし
      questionsPerPassage: clampInt(pick('questionsPerPassage', 3), 1, 20, 3),
      refusalPerPassage: clampInt(pick('refusalPerPassage', 0), 0, 5, 0),
      refusalEveryNth: clampInt(pick('refusalEveryNth', 3), 1, 100, 3),  // 拒否例を作るパッセージ間隔
      temperature: clampNum(pick('temperature', 0.4), 0, 2, 0.4),
      verifyTemperature: clampNum(pick('verifyTemperature', 0), 0, 2, 0),
      maxTokens: clampInt(pick('maxTokens', 2048), 256, 32768, 2048),
      timeoutSec: clampInt(pick('timeoutSec', 300), 30, 3600, 300),
      verify: pick('verify', true) !== false,
      minAnswerChars: clampInt(pick('minAnswerChars', 10), 1, 2000, 10),
      maxAnswerChars: clampInt(pick('maxAnswerChars', 600), 20, 8000, 600),
      minQuestionChars: clampInt(pick('minQuestionChars', 6), 1, 200, 6),
      minCoverage: clampNum(pick('minCoverage', 0.35), 0, 1, 0.35),
      checkNumbers: pick('checkNumbers', true) !== false,
      dedupeThreshold: clampNum(pick('dedupeThreshold', 0.85), 0, 1, 0.85),
      styles,
      refusalAnswers,
      generatePrompt: String(pick('generatePrompt', DEFAULT_GENERATE_PROMPT)),
      refusalPrompt: String(pick('refusalPrompt', DEFAULT_REFUSAL_PROMPT)),
      verifyPrompt: String(pick('verifyPrompt', DEFAULT_VERIFY_PROMPT)),
      closedSystemPrompt: String(pick('closedSystemPrompt', DEFAULT_CLOSED_SYSTEM)),
      openSystemPrompt: String(pick('openSystemPrompt', DEFAULT_OPEN_SYSTEM)),
      contextTemplate: String(pick('contextTemplate', DEFAULT_CONTEXT_TEMPLATE)),
      citationKey: String(pick('citationKey', 'S1')),
      appendCitation: pick('appendCitation', true) !== false,
    };
  }

  /** UI が初期値として使う既定パラメータ (プロンプト本文も含む) */
  function defaults() {
    return resolveParams({});
  }

  // ─── パッセージ分割 ───────────────────────────────────────

  /** チャンク番号 → ページ番号 (OCR登録のみ pages が埋まっている) */
  function pageOf(doc, i) {
    const pages = Array.isArray(doc.pages) ? doc.pages : null;
    if (!pages || i < 0 || i >= pages.length) return null;
    const p = pages[i];
    return Number.isFinite(p) ? p : null;
  }

  /**
   * 検索用チャンクを教師データ生成用のパッセージに束ね直す。
   * 検索は 500文字チャンクで十分だが、Q&A を作るには文脈が足りない
   * (定義と条件が別チャンクに割れている)。ここで passageChunks 個ずつ
   * 連結し直す。連結時は overlap ぶんを削る (ragSearch の連結と同じ理屈で、
   * 削らないと同じ文が二重に入り、モデルが繰り返しを学習してしまう)。
   */
  function buildPassages(doc, p) {
    const chunks = Array.isArray(doc.chunks) ? doc.chunks : [];
    const ov = Number.isFinite(doc.overlap) ? doc.overlap : 100;
    const out = [];
    for (let i = 0; i < chunks.length; i += p.passageChunks) {
      const from = i;
      const to = Math.min(chunks.length - 1, i + p.passageChunks - 1);
      let text = String(chunks[from] || '');
      for (let j = from + 1; j <= to; j++) {
        const c = String(chunks[j] || '');
        text += ov > 0 && c.length > ov ? c.slice(ov) : c;
      }
      text = text.trim();
      if (text.length > p.maxPassageChars) text = text.slice(0, p.maxPassageChars);
      // 短すぎる断片 (目次の残り・空ページ) からは、まず良い設問が出ない
      if (text.replace(/[\s　]/g, '').length < p.minPassageChars) continue;
      out.push({
        key: `${doc.docId}:${from}-${to}`,
        docId: doc.docId,
        filename: doc.filename,
        category: doc.category || null,
        chunkRange: [from, to],
        page: pageOf(doc, from),
        pageTo: pageOf(doc, to),
        text,
      });
    }
    return out;
  }

  /** 出典の表示名 (資料名 + ページ)。プロンプトにも取り込み時のタグにも使う */
  function sourceLabel(ps) {
    const base = path.basename(String(ps.filename || ''));
    if (ps.page === null || ps.page === undefined) return base;
    const pageText = (ps.pageTo && ps.pageTo !== ps.page) ? `p.${ps.page}-${ps.pageTo}` : `p.${ps.page}`;
    return `${base} ${pageText}`;
  }

  // ─── LLM 呼び出し ────────────────────────────────────────

  /** 生成用LLMが使えるか (プール管理なら定義の検証、外部なら生存確認) */
  async function checkLlm() {
    if (!llm || typeof llm.check !== 'function') {
      return { ok: false, message: '生成用LLMが構成されていません' };
    }
    try { return await llm.check(); }
    catch (e) { return { ok: false, message: e.message }; }
  }

  /**
   * 1回の chat completion。ストリーミングは使わない
   * (JSONを丸ごと受け取って parse するだけなので、途中経過に意味が無い)。
   */
  /**
   * fetch の失敗理由を日本語にする。
   * Node の fetch は接続できないと一律 TypeError「fetch failed」しか返さず、
   * 実際の理由 (ECONNREFUSED 等) は e.cause に隠れている。そのまま画面に出すと
   * 「生成失敗: fetch failed」だけが並び、何を直せばいいのか分からない。
   */
  function describeFetchError(e, endpoint) {
    const cause = (e && e.cause) || null;
    const code = String((cause && (cause.code || cause.errno)) || e.code || '');
    const where = `接続先: ${endpoint}`;
    if (code === 'ECONNREFUSED') {
      return {
        kind: 'connection',
        message: `生成LLMに接続を拒否されました (${where})。llama-server が起動していないか、`
          + `モデルがアンロードされています。チャット画面でモデルを1つ読み込むか、`
          + `config.json の tuning.ragDataset.poolModel に chatModels の名前を設定してください`
          + ` (設定すると生成中だけ自動でロード/アンロードされます)`,
      };
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return { kind: 'connection', message: `生成LLMのホスト名を解決できません (${where})。tuning.ragDataset.endpoint を確認してください` };
    }
    if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
      return { kind: 'connection', message: `生成LLMへの接続がタイムアウトしました (${where})` };
    }
    if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || /socket hang up/i.test(e.message || '')) {
      return {
        kind: 'connection',
        message: `生成LLMとの接続が切れました (${where})。VRAM不足で llama-server が異常終了した可能性があります`
          + ` (モデルの ctx を下げる / 同時に載せるモデルを減らす)`,
      };
    }
    if (code === 'CERT_HAS_EXPIRED' || /certificate/i.test(e.message || '')) {
      return { kind: 'connection', message: `生成LLMのTLS証明書を検証できません (${where})` };
    }
    return { kind: 'other', message: `${e.message || String(e)}${code ? ` (${code})` : ''} — ${where}` };
  }

  /** 1回の chat completion (リトライなし)。呼び出しは callLlm から */
  async function callLlmOnce(handle, { system, user, temperature, maxTokens, timeoutSec }, ctl) {
    const controller = new AbortController();
    if (ctl) ctl.abort = controller;
    const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
    try {
      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: user });
      const resp = await fetch(handle.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: handle.model,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        const err = new Error(`生成LLMエラー (${resp.status}): ${t.slice(0, 200)}`);
        // 503 はモデル起動中のことがあるので、接続系と同じくリトライ対象にする
        err.kind = resp.status === 503 || resp.status === 502 ? 'connection' : 'http';
        throw err;
      }
      const data = await resp.json();
      let content = data?.choices?.[0]?.message?.content;
      if (Array.isArray(content)) {
        content = content.map(x => (typeof x === 'string' ? x : (x?.text || ''))).join('');
      }
      if (typeof content !== 'string') throw new Error('生成LLMのレスポンス形式が不正です');
      return content;
    } catch (e) {
      if (e.name === 'AbortError') {
        const err = new Error(ctl && ctl.cancelled ? 'キャンセルされました' : `生成タイムアウト (${timeoutSec}秒)`);
        err.kind = ctl && ctl.cancelled ? 'cancelled' : 'timeout';
        throw err;
      }
      if (e.kind) throw e;
      // TypeError: fetch failed 系はここで理由を判別する
      const d = describeFetchError(e, handle.endpoint);
      const err = new Error(d.message);
      err.kind = d.kind;
      throw err;
    } finally {
      clearTimeout(timer);
      if (ctl) ctl.abort = null;
    }
  }

  /**
   * chat completion (接続系の失敗は間を置いて数回だけ再試行)。
   * プール管理のワーカーは起動直後にポートが開くまでの隙があり、
   * 1回の失敗で数百パッセージのジョブを捨てるのは高くつく。
   * 逆に何度粘っても無駄な失敗 (HTTPエラー・パース失敗) は再試行しない。
   */
  async function callLlm(handle, opts, ctl, { retries = 2, retryDelayMs = 2000 } = {}) {
    let last = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (ctl && ctl.cancelled) { const e = new Error('キャンセルされました'); e.kind = 'cancelled'; throw e; }
      try {
        // 使う直前にモデルを「使用中」に印をつける (メインチャット併用時の
        // アイドルアンロードで、生成の途中に足元を抜かれないように)
        if (handle.keepAlive) { try { handle.keepAlive(); } catch {} }
        return await callLlmOnce(handle, opts, ctl);
      } catch (e) {
        last = e;
        if (e.kind !== 'connection' || attempt === retries) throw e;
        log('-', `[RAG教師データ] 接続に失敗したため再試行します (${attempt + 1}/${retries}): ${e.message}`);
        await new Promise(r => setTimeout(r, retryDelayMs * (attempt + 1)));
      }
    }
    throw last;
  }

  // ─── 機械フィルタ ────────────────────────────────────────

  /**
   * LLM に聞く前に落とせるものは落とす。
   * 検証プロンプト (1件1回のLLM呼び出し) は高いので、
   * 明らかな不良はここで捨てて呼び出し回数を減らす。
   */
  function mechanicalCheck(qa, passage, p) {
    const q = qa.q;
    const a = qa.a;
    const checks = {};
    if (q.length < p.minQuestionChars) return { ok: false, reason: '質問が短すぎます', checks };
    if (q.length > 300) return { ok: false, reason: '質問が長すぎます', checks };
    if (DEICTIC_RE.test(q)) return { ok: false, reason: '質問に指示語（この資料 等）が含まれます', checks };
    if (a.length < p.minAnswerChars) return { ok: false, reason: '回答が短すぎます', checks };
    if (a.length > p.maxAnswerChars) return { ok: false, reason: `回答が長すぎます (${a.length}文字)`, checks };
    if (META_RE.test(a)) return { ok: false, reason: '回答にメタ表現（資料によると 等）が含まれます', checks };

    // 数値の裏取り: 回答に出てくる数値がパッセージに無ければ、まず捏造か換算
    if (p.checkNumbers) {
      const src = numbersIn(passage);
      const bad = numbersIn(a).filter(n => !src.includes(n));
      checks.numbersMissing = bad;
      if (bad.length > 0) return { ok: false, reason: `資料に無い数値: ${bad.slice(0, 3).join(', ')}`, checks };
    }

    // 文字3-gramの被覆率: 一般論で埋めた回答はここで大きく下がる
    const cov = coverage(a, passage);
    checks.coverage = Math.round(cov * 100) / 100;
    if (cov < p.minCoverage) {
      return { ok: false, reason: `資料との重なりが低い (${checks.coverage})`, checks };
    }
    return { ok: true, reason: '', checks };
  }

  // ─── 生成本体 ────────────────────────────────────────────

  function readSamples(jobId) {
    const file = outPath(jobId);
    if (!fs.existsSync(file)) return [];
    try {
      return fs.readFileSync(file, 'utf-8').split('\n')
        .filter(l => l.trim())
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch (e) {
      log('-', `[RAG教師データ] 出力読み込み失敗 (${jobId}): ${e.message}`);
      return [];
    }
  }

  function appendSample(jobId, rec) {
    ensureDirs();
    fs.appendFileSync(outPath(jobId), JSON.stringify(rec) + '\n', 'utf-8');
  }

  function writeSamples(jobId, rows) {
    ensureDirs();
    fs.writeFileSync(outPath(jobId), rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf-8');
  }

  /** ジョブ1本の処理 (パッセージを順に回す)。例外は呼び出し元で status に落とす */
  async function processJob(job, ctl) {
    const p = job.params;
    const docs = [];
    for (const d of job.docs) {
      const doc = loadDoc(d.docId);
      if (!doc) {
        log('-', `[RAG教師データ] ドキュメントが見つかりません (削除済み?): ${d.filename}`);
        continue;
      }
      docs.push(doc);
    }
    if (docs.length === 0) throw new Error('対象のRAGドキュメントが1件も読めませんでした（削除された可能性があります）');

    // パッセージを作って全体量を確定させる (進捗バーのため先に数える)
    let passages = [];
    for (const doc of docs) passages = passages.concat(buildPassages(doc, p));
    if (p.maxPassages > 0) passages = passages.slice(0, p.maxPassages);
    if (passages.length === 0) throw new Error('生成対象のパッセージがありません（minPassageChars を下げてください）');

    // 再開: 既に書き出し済みのパッセージは飛ばす。
    // 長いドキュメントほど途中でキャンセル・再起動が起きるので、
    // 「やり直すと最初から」では実用にならない
    const existing = readSamples(job.jobId);
    const donePassages = new Set(existing.map(r => r?.source?.passageKey).filter(Boolean));
    const seenQuestions = existing
      .filter(r => r.status === 'accepted')
      .map(r => ({ norm: normalizeQuestion(r.question), grams: ngrams(r.question, 3) }));

    job.passagesTotal = passages.length;
    job.passagesDone = passages.filter(ps => donePassages.has(ps.key)).length;
    touch(job);

    let handle = null;
    try {
      try {
        handle = await llm.acquire();
      } catch (e) {
        // モデルの起動失敗 (VRAM不足・パス誤り・未設定) はここで出る。
        // 「fetch failed」になる前に、確保できなかった理由をそのまま見せる
        throw new Error(`生成LLMを確保できません: ${e.message}`);
      }
      log('-', `[RAG教師データ] 生成LLM確保: ${handle.modelName || handle.model} (${passages.length} パッセージ)`);

      for (let i = 0; i < passages.length; i++) {
        if (ctl.cancelled) throw new Error('キャンセルされました');
        const ps = passages[i];
        if (donePassages.has(ps.key)) continue;

        const label = sourceLabel(ps);
        setStatus(job, 'running', { phase: `生成中 (${i + 1}/${passages.length}) ${label}` });

        // ① Q&A 生成
        const genUser = renderTemplate(p.generatePrompt, {
          n: p.questionsPerPassage,
          minChars: p.minAnswerChars,
          maxChars: p.maxAnswerChars,
          styles: p.styles.join(' / '),
          source: label,
          passage: ps.text,
          filename: path.basename(String(ps.filename || '')),
          category: ps.category || '未分類',
        });
        let qaList = [];
        try {
          const raw = await callLlm(handle, {
            system: '', user: genUser,
            temperature: p.temperature, maxTokens: p.maxTokens, timeoutSec: p.timeoutSec,
          }, ctl);
          job.llmCalls = (job.llmCalls || 0) + 1;
          qaList = parseQaList(raw).filter(x => x.a);
        } catch (e) {
          if (ctl.cancelled) throw e;
          // 接続できないまま回し続けても全パッセージが同じ理由で失敗するだけなので、
          // ジョブごと止めて理由を1つ表示する (callLlm 側で数回リトライ済み)。
          // 出力JSONLは残るので、原因を直したあと「続きから」で再開できる
          if (e.kind === 'connection') throw e;
          // それ以外 (応答が壊れている等) は1パッセージの失敗でジョブ全体を落とさない
          log('-', `[RAG教師データ] パッセージ生成失敗 (${label}): ${e.message}`);
          appendSample(job.jobId, {
            id: uid('rs'), kind: 'error', question: '', answer: '',
            context: '', source: passageSource(ps, label),
            status: 'rejected', reason: `生成失敗: ${e.message}`.slice(0, 200),
            checks: {}, createdAt: Date.now(),
          });
          job.passagesDone++;
          donePassages.add(ps.key);
          touch(job);
          continue;
        }

        qaList = qaList.slice(0, p.questionsPerPassage);
        job.generated = (job.generated || 0) + qaList.length;

        for (const qa of qaList) {
          if (ctl.cancelled) throw new Error('キャンセルされました');
          const rec = {
            id: uid('rs'),
            kind: 'qa',
            question: qa.q,
            answer: qa.a,
            context: ps.text,
            source: passageSource(ps, label),
            status: 'accepted',
            reason: '',
            checks: {},
            createdAt: Date.now(),
          };

          // 機械フィルタ
          const mech = mechanicalCheck(qa, ps.text, p);
          rec.checks = mech.checks;
          if (!mech.ok) {
            rec.status = 'rejected';
            rec.reason = mech.reason;
          }

          // 重複チェック (同じ事実の言い換えは残したいので、閾値は高め)
          if (rec.status === 'accepted') {
            const norm = normalizeQuestion(qa.q);
            const grams = ngrams(qa.q, 3);
            const dup = seenQuestions.find(s => s.norm === norm || jaccard(s.grams, grams) >= p.dedupeThreshold);
            if (dup) {
              rec.status = 'rejected';
              rec.reason = '既存の質問と重複';
            } else {
              seenQuestions.push({ norm, grams });
            }
          }

          // ③ LLM検証 (機械フィルタを通ったものだけ。呼び出し回数を抑えるため)
          if (rec.status === 'accepted' && p.verify) {
            try {
              const vUser = renderTemplate(p.verifyPrompt, {
                passage: ps.text, question: qa.q, answer: qa.a, source: label,
              });
              const raw = await callLlm(handle, {
                system: '', user: vUser,
                temperature: p.verifyTemperature, maxTokens: 256, timeoutSec: p.timeoutSec,
              }, ctl);
              job.llmCalls = (job.llmCalls || 0) + 1;
              const verdict = parseVerdict(raw);
              // 判定不能 (JSONを返せないモデル) は通す。ここで落とすと
              // 小型モデルでは全滅するため、機械フィルタ側を信頼する
              rec.checks.verified = verdict ? verdict.ok : null;
              if (verdict && !verdict.ok) {
                rec.status = 'rejected';
                rec.reason = `検証NG: ${verdict.reason || '資料と一致しません'}`;
              }
            } catch (e) {
              if (ctl.cancelled) throw e;
              // 接続断は「検証できなかった」ではなく環境の問題。通過扱いにすると
              // 未検証のサンプルが採用として溜まっていくので、ジョブごと止める
              if (e.kind === 'connection') { appendSample(job.jobId, rec); throw e; }
              log('-', `[RAG教師データ] 検証失敗 (通過扱い): ${e.message}`);
              rec.checks.verified = null;
            }
          }

          appendSample(job.jobId, rec);
          if (rec.status === 'accepted') job.accepted = (job.accepted || 0) + 1;
          else job.rejected = (job.rejected || 0) + 1;
        }

        // ② 拒否例 (範囲外の質問 → 「記載がありません」)。
        // 毎パッセージ作ると拒否ばかりのデータセットになるので間引く
        const wantRefusal = p.refusalPerPassage > 0 && (i % p.refusalEveryNth === 0);
        if (wantRefusal) {
          try {
            const rUser = renderTemplate(p.refusalPrompt, {
              n: p.refusalPerPassage, source: label, passage: ps.text,
              filename: path.basename(String(ps.filename || '')),
              category: ps.category || '未分類',
            });
            const raw = await callLlm(handle, {
              system: '', user: rUser,
              temperature: Math.max(p.temperature, 0.5), maxTokens: Math.min(p.maxTokens, 1024), timeoutSec: p.timeoutSec,
            }, ctl);
            job.llmCalls = (job.llmCalls || 0) + 1;
            const qs = parseQaList(raw).map(x => x.q).slice(0, p.refusalPerPassage);
            for (const q of qs) {
              if (DEICTIC_RE.test(q) || q.length < p.minQuestionChars) continue;
              const norm = normalizeQuestion(q);
              const grams = ngrams(q, 3);
              if (seenQuestions.find(s => s.norm === norm || jaccard(s.grams, grams) >= p.dedupeThreshold)) continue;
              seenQuestions.push({ norm, grams });
              const answer = p.refusalAnswers[Math.floor(Math.random() * p.refusalAnswers.length)];
              appendSample(job.jobId, {
                id: uid('rs'), kind: 'refusal', question: q, answer,
                context: ps.text, source: passageSource(ps, label),
                status: 'accepted', reason: '', checks: {}, createdAt: Date.now(),
              });
              job.accepted = (job.accepted || 0) + 1;
              job.refusals = (job.refusals || 0) + 1;
              job.generated = (job.generated || 0) + 1;
            }
          } catch (e) {
            if (ctl.cancelled) throw e;
            if (e.kind === 'connection') throw e;
            log('-', `[RAG教師データ] 拒否例の生成失敗 (${label}): ${e.message}`);
          }
        }

        job.passagesDone++;
        donePassages.add(ps.key);
        touch(job);
      }
    } finally {
      if (handle) { try { handle.release(); } catch {} }
    }
  }

  function passageSource(ps, label) {
    return {
      docId: ps.docId,
      filename: ps.filename,
      category: ps.category || null,
      page: ps.page ?? null,
      pageTo: ps.pageTo ?? null,
      chunkRange: ps.chunkRange,
      passageKey: ps.key,
      label,
    };
  }

  // ─── ジョブ操作 ──────────────────────────────────────────

  /**
   * ジョブ作成。docIds か category のどちらかで対象を選ぶ
   * (category 指定は「そのカテゴリの登録ドキュメント全部」)。
   */
  function createJob({ docIds = null, category = undefined, params = {}, title = '' } = {}) {
    if (!isEnabled()) {
      const e = new Error('RAG教師データ生成が無効です (config.json の tuning.ragDataset.enabled を true にしてください)');
      e.status = 503; throw e;
    }
    const all = listDocs() || [];
    let targets;
    if (Array.isArray(docIds) && docIds.length > 0) {
      const set = new Set(docIds);
      targets = all.filter(d => set.has(d.docId));
      const missing = docIds.filter(id => !targets.find(d => d.docId === id));
      if (missing.length > 0) {
        const e = new Error(`登録されていない docId があります: ${missing.slice(0, 3).join(', ')}`);
        e.status = 400; throw e;
      }
    } else if (category !== undefined && category !== null) {
      targets = all.filter(d => (d.category || '') === String(category));
      if (targets.length === 0) {
        const e = new Error(`カテゴリ「${category || '未分類'}」に登録ドキュメントがありません`);
        e.status = 400; throw e;
      }
    } else {
      targets = all;
    }
    if (targets.length === 0) {
      const e = new Error('RAGドキュメントが登録されていません'); e.status = 400; throw e;
    }

    const job = {
      jobId: uid('rtune'),
      title: String(title || '').trim()
        || (targets.length === 1 ? path.basename(targets[0].filename) : `${path.basename(targets[0].filename)} 他${targets.length - 1}件`),
      docs: targets.map(d => ({ docId: d.docId, filename: d.filename, category: d.category || null })),
      params: resolveParams(params),
      status: 'pending',
      phase: null,
      passagesTotal: 0, passagesDone: 0,
      generated: 0, accepted: 0, rejected: 0, refusals: 0, imported: 0, llmCalls: 0,
      createdAt: Date.now(),
    };
    loadJobs().unshift(job);
    saveJobs();
    log('-', `[RAG教師データ] ジョブ作成: ${job.title} (${targets.length} 件, mode=${job.params.mode})`);
    return jobView(job);
  }

  /** ジョブ開始 (失敗・中断したジョブの再開もこれ。redo=true で最初から作り直す) */
  function startJob(jobId, { redo = false } = {}) {
    const job = requireJob(jobId);
    if (running.has(jobId)) { const e = new Error('既に実行中です'); e.status = 409; throw e; }
    const maxJobs = clampInt(cfg().maxConcurrentJobs, 1, 8, 1);
    if (running.size >= maxJobs) {
      const e = new Error(`同時実行数の上限です (${maxJobs})。実行中のジョブの完了を待ってください`);
      e.status = 409; throw e;
    }
    if (!llm || typeof llm.acquire !== 'function') {
      const e = new Error('生成用LLMが構成されていません'); e.status = 503; throw e;
    }

    if (redo) {
      try { fs.rmSync(outPath(jobId), { force: true }); } catch {}
      job.generated = 0; job.accepted = 0; job.rejected = 0; job.refusals = 0; job.llmCalls = 0; job.imported = 0;
      job.passagesDone = 0;
    }
    const ctl = { cancelled: false, abort: null };
    running.set(jobId, ctl);
    setStatus(job, 'running', {
      error: null, interrupted: false, phase: '準備中',
      startedAt: Date.now(), finishedAt: null,
    });

    // 非同期で走らせ、呼び出し元にはすぐ返す (UIはSSEで進捗を見る)
    (async () => {
      try {
        await processJob(job, ctl);
        setStatus(job, 'completed', { phase: null, finishedAt: Date.now() });
        log('-', `[RAG教師データ] 完了: ${job.title} (採用 ${job.accepted} / 不採用 ${job.rejected})`);
      } catch (e) {
        const cancelled = ctl.cancelled;
        setStatus(job, cancelled ? 'cancelled' : 'failed', {
          phase: null, finishedAt: Date.now(),
          error: cancelled ? null : (e.message || String(e)),
        });
        log('-', `[RAG教師データ] ${cancelled ? 'キャンセル' : '失敗'}: ${job.title}${cancelled ? '' : ` - ${e.message}`}`);
      } finally {
        running.delete(jobId);
      }
    })();

    return jobView(job);
  }

  function cancelJob(jobId) {
    const job = requireJob(jobId);
    const ctl = running.get(jobId);
    if (!ctl) {
      if (ACTIVE_STATUSES.includes(job.status)) {
        setStatus(job, 'cancelled', { phase: null, finishedAt: Date.now() });
        return jobView(job);
      }
      const e = new Error('実行中ではありません'); e.status = 409; throw e;
    }
    ctl.cancelled = true;
    if (ctl.abort) { try { ctl.abort.abort(); } catch {} }
    setStatus(job, 'running', { phase: 'キャンセル中...' });
    return jobView(job);
  }

  function deleteJob(jobId, { keepFile = false } = {}) {
    const job = requireJob(jobId);
    if (running.has(jobId)) {
      const e = new Error('実行中のジョブは削除できません。先にキャンセルしてください'); e.status = 409; throw e;
    }
    if (!keepFile) { try { fs.rmSync(outPath(jobId), { force: true }); } catch {} }
    jobs = loadJobs().filter(j => j.jobId !== jobId);
    saveJobs();
    emitEvent(jobId, { type: 'deleted', jobId });
    listeners.delete(jobId);
    return { ok: true };
  }

  function listJobs() {
    return loadJobs().map(jobView);
  }

  function getJob(jobId) {
    const job = findJob(jobId);
    return job ? jobView(job) : null;
  }

  /** 生成結果の閲覧 (status で絞り込み)。context は重いので既定では返さない */
  function listSamples(jobId, { status = 'all', offset = 0, limit = 50, withContext = false } = {}) {
    requireJob(jobId);
    const all = readSamples(jobId);
    const filtered = status === 'all' ? all : all.filter(r => r.status === status);
    const off = Math.max(0, parseInt(offset) || 0);
    const lim = clampInt(limit, 1, 500, 50);
    const rows = filtered.slice(off, off + lim).map(r => (withContext ? r : { ...r, context: undefined }));
    return {
      samples: rows,
      total: filtered.length,
      counts: {
        all: all.length,
        accepted: all.filter(r => r.status === 'accepted').length,
        rejected: all.filter(r => r.status === 'rejected').length,
      },
      offset: off,
      limit: lim,
    };
  }

  /** 採用・不採用の手動切り替え (レビュー用)。ids 省略で全件 */
  function setSampleStatus(jobId, { ids = null, status = 'accepted' } = {}) {
    const job = requireJob(jobId);
    if (!['accepted', 'rejected'].includes(status)) {
      const e = new Error('status は accepted / rejected'); e.status = 400; throw e;
    }
    const rows = readSamples(jobId);
    const set = Array.isArray(ids) && ids.length ? new Set(ids) : null;
    let changed = 0;
    for (const r of rows) {
      if (set && !set.has(r.id)) continue;
      if (r.kind === 'error') continue;        // 生成失敗の記録は対象外
      if (r.status === status) continue;
      r.status = status;
      if (status === 'accepted') r.reason = '手動で採用';
      else r.reason = '手動で除外';
      changed++;
    }
    if (changed) writeSamples(jobId, rows);
    job.accepted = rows.filter(r => r.status === 'accepted').length;
    job.rejected = rows.filter(r => r.status === 'rejected').length;
    job.refusals = rows.filter(r => r.status === 'accepted' && r.kind === 'refusal').length;
    touch(job);
    return { ok: true, changed, job: jobView(job) };
  }

  /**
   * 生成結果 → 学習サンプル (tuning/samples.jsonl) へ取り込む。
   * mode で「知識注入型 (closed)」「RAG運用型 (open)」を選ぶ。
   * both は同じ Q&A から2本作る (closed で覚えさせ、open で資料の読み方も教える)。
   */
  function toTrainingRows(records, p, mode) {
    const rows = [];
    for (const r of records) {
      const tags = ['rag', path.basename(String(r.source?.filename || '')).slice(0, 40)];
      if (r.kind === 'refusal') tags.push('refusal');
      if (mode === 'closed' || mode === 'both') {
        // 知識注入型: 資料を渡さず、質問だけで答えさせる
        rows.push({
          system: p.closedSystemPrompt,
          instruction: r.question,
          response: r.answer,
          tags: tags.concat('closed'),
        });
      }
      if (mode === 'open' || mode === 'both') {
        // RAG運用型: 検索結果と同じ体裁で資料を渡し、それを読んで答えさせる
        const key = p.citationKey || 'S1';
        let response = r.answer;
        if (p.appendCitation && r.kind !== 'refusal' && !/【[A-Za-z]\d+】/.test(response)) {
          response = `${response}【${key}】`;
        }
        rows.push({
          system: p.openSystemPrompt,
          instruction: renderTemplate(p.contextTemplate, {
            key,
            context: r.context || '',
            question: r.question,
            source: r.source?.label || path.basename(String(r.source?.filename || '')),
          }),
          response,
          tags: tags.concat('open'),
        });
      }
    }
    return rows;
  }

  function importSamples(jobId, { ids = null, mode = null } = {}) {
    const job = requireJob(jobId);
    if (!addSamples) { const e = new Error('学習サンプルDBが接続されていません'); e.status = 500; throw e; }
    const p = job.params;
    const useMode = ['closed', 'open', 'both'].includes(String(mode)) ? String(mode) : p.mode;
    const set = Array.isArray(ids) && ids.length ? new Set(ids) : null;
    const records = readSamples(jobId).filter(r =>
      r.status === 'accepted' && r.kind !== 'error' && (!set || set.has(r.id)));
    if (records.length === 0) {
      const e = new Error('取り込める採用済みサンプルがありません'); e.status = 400; throw e;
    }
    const rows = toTrainingRows(records, p, useMode);
    const result = addSamples(rows);
    job.imported = (job.imported || 0) + rows.length;
    touch(job);
    log('-', `[RAG教師データ] 学習サンプルへ取り込み: ${rows.length} 件 (mode=${useMode}, 元 ${records.length} 件)`);
    return { ok: true, added: rows.length, sourceCount: records.length, mode: useMode, total: result?.total ?? null };
  }

  /** JSONL ダウンロード用の文字列 (採用済みを学習サンプル形式で吐く) */
  function exportJsonl(jobId, { mode = null, status = 'accepted' } = {}) {
    const job = requireJob(jobId);
    const p = job.params;
    const useMode = ['closed', 'open', 'both'].includes(String(mode)) ? String(mode) : p.mode;
    const records = readSamples(jobId).filter(r => r.kind !== 'error' && (status === 'all' || r.status === status));
    return toTrainingRows(records, p, useMode)
      .map(r => JSON.stringify({ instruction: r.instruction, response: r.response, system: r.system || undefined, tags: r.tags }))
      .join('\n');
  }

  /** 起動時の復元。実行中のまま落ちたジョブは待機中に戻す (出力は残るので再開できる) */
  function restoreOnBoot() {
    ensureDirs();
    const list = loadJobs();
    let n = 0;
    for (const job of list) {
      if (ACTIVE_STATUSES.includes(job.status)) {
        job.status = 'pending';
        job.phase = null;
        job.interrupted = true;
        job.startedAt = null;
        job.finishedAt = null;
        n++;
      }
    }
    if (n > 0) {
      saveJobs();
      log('-', `[RAG教師データ] 再起動により中断された ${n} 件のジョブを待機中に戻しました`);
    }
    return n;
  }

  /** UI 用のステータス (機能ON/OFF・LLMの用意・登録ドキュメント数・既定パラメータ) */
  async function health() {
    const docs = listDocs() || [];
    return {
      enabled: isEnabled(),
      llm: await checkLlm(),
      docCount: docs.length,
      runningCount: running.size,
      maxConcurrentJobs: clampInt(cfg().maxConcurrentJobs, 1, 8, 1),
      defaults: defaults(),
    };
  }

  return {
    isEnabled,
    health,
    defaults,
    createJob,
    startJob,
    cancelJob,
    deleteJob,
    listJobs,
    getJob,
    listSamples,
    setSampleStatus,
    importSamples,
    exportJsonl,
    subscribe,
    restoreOnBoot,
  };
}

module.exports = {
  createRagTuneManager,
  // 以下はテスト用に公開 (パーサや判定だけ単体で確認できる)
  parseQaList,
  parseVerdict,
  normalizeQuestion,
  coverage,
  numbersIn,
  renderTemplate,
  DEFAULT_GENERATE_PROMPT,
  DEFAULT_REFUSAL_PROMPT,
  DEFAULT_VERIFY_PROMPT,
  DEFAULT_CONTEXT_TEMPLATE,
  DEFAULT_CLOSED_SYSTEM,
  DEFAULT_OPEN_SYSTEM,
  DEFAULT_STYLES,
  DEFAULT_REFUSAL_ANSWERS,
};
