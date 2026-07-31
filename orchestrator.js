/**
 * orchestrator.js — マルチLLMオーケストレーション実行エンジン
 *
 * ユーザーがワークフローエディタで組んだ「ノードのつながり(DAG)」を解釈し、
 * llm_pool.js が用意した複数の llama-server ワーカーに処理を割り振って実行する。
 *
 * ── ノード種別 ──
 *   llm       : 1モデルに投げる基本ノード。上流ノードの出力を受け取れる
 *   router    : モデルに分岐先を選ばせる。選ばれなかった枝は skip される
 *   aggregate : 複数の上流出力を1モデルに渡して統合させる（並列合議の集約役）
 *   debate    : 複数モデルが複数ラウンド議論する。1ノードで完結する
 *   output    : 最終回答マーカー。入力に指定したノードの出力がユーザーへの回答になる
 *
 * ── 実行方式 ──
 *   依存関係を解決して「同時に走れるノード群(レベル)」に分け、
 *   resident モードならレベル内を並列実行、swap モードなら逐次実行する。
 *   （swap は VRAM が足りずモデルを載せ替えながら走るため並列できない）
 *
 * 進捗は onEvent コールバックで逐次通知し、server.js が SSE でフロントへ流す。
 */

const http = require('http');

// llama-server のプロセスが落ちたときに出る接続断系のエラー。
// これらが出た場合だけ、子プロセスの終了記録が届くのを待つ。
const CONN_LOST_RE = /socket hang up|ECONNRESET|ECONNREFUSED|EPIPE|aborted/i;
const CONN_LOST_CODES = ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'];

// Node 19 以降 http.globalAgent は keepAlive: true が既定。
// ノード間で間隔が空くと、llama-server 側が先に閉じた接続をプールから掴んでしまい、
// リクエストを投げた瞬間に "socket hang up" になる（プロセスは生きている）。
// ワークフローは「討論 → 数十秒後に結論」のように間が空くのが普通なので、
// 専用エージェントで毎回新しい接続を張る。
const httpAgent = new http.Agent({ keepAlive: false, maxSockets: 64 });

// ─── 汎用ユーティリティ ───

/** <think>...</think> を除去する。下流ノードに渡す際に思考文で文脈を汚さないため */
function stripThink(text) {
  if (!text) return '';
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();
}

/** 長すぎる中間出力を下流に渡す前に切り詰める */
function truncate(text, maxChars) {
  if (!maxChars || maxChars <= 0) return text;
  const s = String(text || '');
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + `\n…(以下 ${s.length - maxChars} 文字を省略)`;
}

/**
 * llama-server の /v1/chat/completions をストリーミングで叩く。
 * @returns {Promise<string>} 生成された全文
 */
function chatCompletionStream({ host, port, messages, temperature, maxTokens, topP, topK, extra }, onDelta, registerReq) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      messages,
      stream: true,
      temperature,
      max_tokens: maxTokens,
      top_p: topP,
      top_k: topK,
      ...(extra || {}),
    });

    const req = http.request({
      hostname: host,
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      agent: httpAgent,           // keep-alive の使い回しを避ける（上のコメント参照）
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'connection': 'close',
      },
      timeout: 900000,
    }, (res) => {
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', d => { body += d.toString(); });
        res.on('end', () => reject(new Error(`llama-server ${res.statusCode}: ${body.slice(0, 500)}`)));
        return;
      }
      let full = '';
      let buf = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => {
        buf += chunk;
        // SSE: "data: {...}\n\n" 単位で処理する
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            const d = j.choices?.[0]?.delta?.content;
            if (d) {
              full += d;
              if (onDelta) onDelta(d);
            }
          } catch { /* 部分JSONは次チャンクで揃う */ }
        }
      });
      res.on('end', () => resolve(full));
      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('llama-server タイムアウト')); });
    if (registerReq) registerReq(req);
    req.write(payload);
    req.end();
  });
}

// ─── ワークフローの検証・解析 ───

const NODE_TYPES = ['llm', 'router', 'aggregate', 'debate', 'output'];

/**
 * ワークフロー定義を検証する。
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateWorkflow(wf, availableModels) {
  const errors = [];
  if (!wf || typeof wf !== 'object') return { ok: false, errors: ['ワークフローがオブジェクトではありません'] };
  if (!wf.name) errors.push('name が必要です');
  const nodes = Array.isArray(wf.nodes) ? wf.nodes : [];
  if (nodes.length === 0) errors.push('ノードが1つもありません');

  const ids = new Set();
  for (const n of nodes) {
    if (!n.id) { errors.push('id のないノードがあります'); continue; }
    if (ids.has(n.id)) errors.push(`ノードIDが重複しています: ${n.id}`);
    ids.add(n.id);
    if (!NODE_TYPES.includes(n.type)) errors.push(`不明なノード種別: ${n.type} (${n.id})`);
    if (n.type !== 'output' && n.type !== 'debate' && !n.model) {
      errors.push(`モデルが未指定です: ${n.label || n.id}`);
    }
    if (n.model && availableModels && availableModels.length && !availableModels.includes(n.model)) {
      errors.push(`config.chatModels に存在しないモデルです: ${n.model} (${n.label || n.id})`);
    }
    if (n.type === 'debate') {
      const ps = Array.isArray(n.participants) ? n.participants : [];
      if (ps.length < 2) errors.push(`討論ノードには2名以上の参加者が必要です: ${n.label || n.id}`);
      for (const p of ps) {
        if (!p.model) errors.push(`討論参加者のモデルが未指定です: ${n.label || n.id}`);
        else if (availableModels && availableModels.length && !availableModels.includes(p.model)) {
          errors.push(`config.chatModels に存在しないモデルです: ${p.model} (${n.label || n.id})`);
        }
      }
    }
    if (n.type === 'router') {
      const rs = Array.isArray(n.routes) ? n.routes : [];
      if (rs.length < 2) errors.push(`ルーターには2つ以上の分岐が必要です: ${n.label || n.id}`);
    }
  }
  // 入力参照の健全性
  for (const n of nodes) {
    for (const inId of (n.inputs || [])) {
      if (!ids.has(inId)) errors.push(`存在しないノードを入力に指定しています: ${inId} → ${n.id}`);
    }
  }
  // ルーターの分岐先
  for (const n of nodes) {
    if (n.type !== 'router') continue;
    for (const r of (n.routes || [])) {
      if (r.target && !ids.has(r.target)) errors.push(`ルーターの分岐先が存在しません: ${r.target} (${n.id})`);
    }
  }
  // 循環参照チェック
  if (errors.length === 0) {
    try { topoLevels(nodes); } catch (e) { errors.push(e.message); }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 依存関係を「同時に実行できるノード群」の配列に分解する（レベル分け）。
 * 循環があれば例外を投げる。
 */
function topoLevels(nodes) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const remaining = new Set(nodes.map(n => n.id));
  const done = new Set();
  const levels = [];
  while (remaining.size > 0) {
    const level = [];
    for (const id of remaining) {
      const n = byId.get(id);
      const deps = depsOf(n, nodes);
      if (deps.every(d => done.has(d))) level.push(id);
    }
    if (level.length === 0) {
      throw new Error(`ワークフローに循環参照があります (${[...remaining].join(', ')})`);
    }
    for (const id of level) { remaining.delete(id); done.add(id); }
    levels.push(level);
  }
  return levels;
}

/**
 * ノードの実行前提となる上流ノードID一覧。
 * inputs に加え、ルーターの分岐先は「そのルーターの完了」を前提にする。
 */
function depsOf(node, nodes) {
  const deps = new Set(node.inputs || []);
  for (const n of nodes) {
    if (n.type !== 'router') continue;
    for (const r of (n.routes || [])) {
      if (r.target === node.id) deps.add(n.id);
    }
  }
  return [...deps];
}

/** 最終回答となるノードIDを決める */
function resolveFinalNodeId(nodes) {
  const out = nodes.find(n => n.type === 'output');
  if (out && (out.inputs || []).length > 0) return out.inputs[0];
  // output ノードがない場合: 誰にも参照されていない末端ノード（最後のもの）
  const referenced = new Set();
  for (const n of nodes) for (const i of (n.inputs || [])) referenced.add(i);
  const terminals = nodes.filter(n => n.type !== 'output' && !referenced.has(n.id));
  if (terminals.length > 0) return terminals[terminals.length - 1].id;
  return nodes.length ? nodes[nodes.length - 1].id : null;
}

// ─── オーケストレータ本体 ───

function createOrchestrator(deps) {
  const { pool, getConfig, findModelByName, log } = deps;

  const cfg = () => (getConfig().orchestration || {});

  /** 中間結果を下流に渡すときの最大文字数 */
  const relayMaxChars = () => cfg().relayMaxChars || 6000;

  /** ノードのシステムプロンプトを組み立てる */
  function buildSystemPrompt(node, baseSystem) {
    const parts = [];
    if (cfg().includeBaseSystemPrompt !== false && baseSystem) parts.push(baseSystem);
    if (node.role) parts.push(node.role);
    return parts.join('\n\n');
  }

  /**
   * ノードに渡す messages を組み立てる。
   * 上流の出力がある場合は「元の質問 + 各担当の回答」を1つのユーザーメッセージにまとめる。
   */
  function buildMessages(node, ctx) {
    const system = buildSystemPrompt(node, ctx.baseSystem);
    const msgs = [];
    if (system) msgs.push({ role: 'system', content: system });

    const inputs = (node.inputs || [])
      .map(id => ctx.results.get(id))
      .filter(r => r && r.status === 'done');

    if (inputs.length === 0) {
      // 上流なし: 通常のチャットとして履歴＋質問を渡す
      for (const m of ctx.history) msgs.push(m);
      msgs.push({ role: 'user', content: ctx.query });
      return msgs;
    }

    // 上流あり: 直近履歴は短めに添え、上流出力を構造化して渡す
    for (const m of ctx.history.slice(-2)) msgs.push(m);

    const sections = inputs.map((r, i) => {
      const head = `### ${i + 1}. ${r.label}${r.model ? ` (${r.model})` : ''}`;
      return `${head}\n${truncate(stripThink(r.text), relayMaxChars())}`;
    }).join('\n\n');

    const instruction = node.type === 'aggregate'
      ? (node.instruction || '上記の各回答を突き合わせ、矛盾があれば取捨選択したうえで、ユーザーへの最終回答を1つにまとめてください。どの担当が何を言ったかの説明は不要で、完成した回答本文だけを書いてください。')
      : (node.instruction || '上記を踏まえて回答してください。');

    msgs.push({
      role: 'user',
      content: `【ユーザーの質問】\n${ctx.query}\n\n【担当モデルからの入力】\n${sections}\n\n【あなたへの指示】\n${instruction}`,
    });
    return msgs;
  }

  /** サンプラー設定をノード＞configの順で解決 */
  function samplerFor(node) {
    const c = getConfig();
    return {
      temperature: typeof node.temperature === 'number' ? node.temperature : c.temperature,
      topP: typeof node.topP === 'number' ? node.topP : c.topP,
      topK: typeof node.topK === 'number' ? node.topK : c.topK,
      maxTokens: node.maxTokens || c.agentContext?.largePredict || c.chatMaxTokens || 4096,
    };
  }

  /**
   * 1つのモデル呼び出しを実行する（プールからワーカーを確保 → 生成 → 返却）
   */
  async function callModel({ modelName, messages, node, mode, onDelta, run }) {
    const handle = await pool.acquire(modelName, { mode });
    try {
      const s = samplerFor(node);
      const opts = {
        host: handle.host, port: handle.port,
        messages,
        temperature: s.temperature, maxTokens: s.maxTokens,
        topP: s.topP, topK: s.topK,
      };
      const register = (req) => run.activeReqs.add(req);

      let received = 0;
      const countingOnDelta = (d) => { received++; if (onDelta) onDelta(d); };

      try {
        return await chatCompletionStream(opts, countingOnDelta, register);
      } catch (e) {
        // まだ1トークンも受け取っていない接続断は、接続そのものの問題である可能性が高い。
        // ワーカーが生きているなら一度だけ張り直す（部分出力が二重にならないよう
        // 受信済みの場合はやり直さない）。
        const connLost = CONN_LOST_RE.test(e.message || '') || CONN_LOST_CODES.includes(e.code);
        if (!connLost || received > 0 || pool.getCrash(modelName)) throw e;
        log('-', `[オーケストレーション] 接続断のため再接続して再試行: ${modelName} (${e.message})`);
        return await chatCompletionStream(opts, countingOnDelta, register);
      }
    } catch (e) {
      // llama-server が落ちると呼び出し側には "socket hang up" しか見えない。
      // プールが記録した終了コードと最終出力を添えて、原因を追えるようにする。
      //
      // 接続断系のエラーはソケット側が先に上がり、子プロセスの 'exit' が
      // 届くのはその後になるため、少し待ってから記録を確認する。
      const connLost = CONN_LOST_RE.test(e.message || '') || CONN_LOST_CODES.includes(e.code);
      const crash = connLost
        ? await pool.awaitCrash(modelName)
        : pool.getCrash(modelName);
      if (crash) {
        const gpuLine = (crash.gpu && crash.gpu.length)
          ? '\n異常終了時のGPU: ' + crash.gpu
              .map(g => `${g.id || 'GPU'} ${(g.usedMB / 1024).toFixed(1)}/${(g.totalMB / 1024).toFixed(1)}GB使用`)
              .join(' , ')
          : '';
        const where = crash.external ? 'メインチャットの' : 'ワーカーの';
        const err = new Error(
          `VRAM不足の可能性: モデル「${modelName}」の${where}llama-serverが異常終了しました`
          + ` (exit=${crash.code}${crash.signal ? `, signal=${crash.signal}` : ''})`
          + gpuLine
          + `\n対処: モデルの ctx を下げる（KVキャッシュが比例して減ります）/ 使うモデルを減らす /`
          + ` 小さいモデルに変える / config.json の orchestration.maxResident を 1 にする`
          + (crash.tail ? `\n--- llama-server の最終出力 ---\n${crash.tail}` : '')
        );
        err.workerCrashed = true;
        throw err;
      }
      throw e;
    } finally {
      handle.release();
    }
  }

  // ─── 各ノード種別の実行 ───

  async function runLlmNode(node, ctx, run) {
    const messages = buildMessages(node, ctx);
    return await callModel({
      modelName: node.model, messages, node, mode: ctx.mode, run,
      onDelta: (d) => ctx.emit({ type: 'node_delta', id: node.id, delta: d }),
    });
  }

  async function runRouterNode(node, ctx, run) {
    const routes = node.routes || [];
    const list = routes.map((r, i) => `${i + 1}. ${r.label}${r.description ? ` — ${r.description}` : ''}`).join('\n');
    const system = buildSystemPrompt(
      { role: node.role || 'あなたは質問を適切な担当に振り分けるルーターです。' },
      ctx.baseSystem,
    );
    const messages = [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `次のユーザーの質問を、下記の選択肢のうち最も適した1つに振り分けてください。\n\n`
          + `【質問】\n${ctx.query}\n\n【選択肢】\n${list}\n\n`
          + `番号だけを1つ出力してください。説明・前置きは一切不要です。`,
      },
    ];
    const text = await callModel({
      modelName: node.model, messages, node: { ...node, maxTokens: 64 }, mode: ctx.mode, run,
      onDelta: (d) => ctx.emit({ type: 'node_delta', id: node.id, delta: d }),
    });

    // 番号 → ラベル名 → 先頭一致 の順で拾う
    const clean = stripThink(text);
    let picked = -1;
    const numMatch = clean.match(/\d+/);
    if (numMatch) {
      const n = parseInt(numMatch[0]) - 1;
      if (n >= 0 && n < routes.length) picked = n;
    }
    if (picked < 0) {
      picked = routes.findIndex(r => r.label && clean.includes(r.label));
    }
    if (picked < 0) picked = 0;  // 判定不能ならデフォルト（先頭）

    const chosen = routes[picked];
    ctx.routerChoice.set(node.id, chosen.target || null);
    log('-', `[オーケストレーション] ルーター「${node.label || node.id}」→ ${chosen.label}`);
    ctx.emit({ type: 'node_route', id: node.id, label: chosen.label, target: chosen.target || null });
    return `振り分け先: ${chosen.label}`;
  }

  async function runDebateNode(node, ctx, run) {
    const participants = (node.participants || []).map((p, i) => ({
      model: p.model,
      label: p.label || `参加者${i + 1}`,
      role: p.role || '',
    }));
    const rounds = Math.max(1, Math.min(parseInt(node.rounds) || 2, 5));
    const transcript = [];  // { label, model, round, text }

    for (let r = 0; r < rounds; r++) {
      for (const p of participants) {
        const prior = transcript.length === 0
          ? '（まだ誰も発言していません。最初の意見を述べてください）'
          : transcript.map(t => `【${t.label}・${t.round + 1}巡目】\n${truncate(stripThink(t.text), relayMaxChars())}`).join('\n\n');

        const system = buildSystemPrompt(
          { role: [p.role, node.role].filter(Boolean).join('\n\n') },
          ctx.baseSystem,
        );
        const messages = [
          ...(system ? [{ role: 'system', content: system }] : []),
          {
            role: 'user',
            content: `以下のテーマについて議論しています。あなたは「${p.label}」です。\n\n`
              + `【テーマ】\n${ctx.query}\n\n【これまでの発言】\n${prior}\n\n`
              + `【指示】\n${r === 0
                ? 'あなたの立場から意見を述べてください。'
                : '他の参加者の発言を踏まえ、同意できる点・異論がある点を明示しつつ、あなたの意見を更新してください。'}\n`
              + `簡潔に、要点を絞って書いてください。`,
          },
        ];

        ctx.emit({ type: 'node_speaker', id: node.id, label: p.label, model: p.model, round: r + 1 });
        const text = await callModel({
          modelName: p.model, messages, node, mode: ctx.mode, run,
          onDelta: (d) => ctx.emit({ type: 'node_delta', id: node.id, delta: d, speaker: p.label }),
        });
        transcript.push({ label: p.label, model: p.model, round: r, text });
      }
    }

    return transcript
      .map(t => `【${t.label}（${t.model}）・${t.round + 1}巡目】\n${stripThink(t.text)}`)
      .join('\n\n');
  }

  /**
   * ワークフローを実行する。
   *
   * @param {object} opts
   *   workflow  ワークフロー定義
   *   query     ユーザーの質問
   *   history   直近のチャット履歴 [{role, content}]
   *   baseSystem ベースのシステムプロンプト
   *   onEvent   進捗コールバック
   * @returns {Promise<{finalText: string, results: object[]}>}
   */
  async function runWorkflow({ workflow, query, history = [], baseSystem = '', onEvent }) {
    const nodes = (workflow.nodes || []).filter(n => n && n.id);
    const emit = (ev) => { try { onEvent && onEvent(ev); } catch { /* 送信失敗は無視 */ } };
    const run = { activeReqs: new Set(), cancelled: false };

    // 使用モデルを集めて resident / swap を決める
    const usedModels = [];
    for (const n of nodes) {
      if (n.model) usedModels.push(n.model);
      for (const p of (n.participants || [])) if (p.model) usedModels.push(p.model);
    }
    const plan = pool.planMode(usedModels);
    log('-', `[オーケストレーション] 「${workflow.name}」開始 / モード=${plan.mode} (${plan.reason})`);

    const levels = topoLevels(nodes);
    const finalNodeId = resolveFinalNodeId(nodes);

    emit({
      type: 'plan',
      workflow: { id: workflow.id, name: workflow.name },
      mode: plan.mode, reason: plan.reason,
      freeVramMB: plan.freeMB, requiredVramMB: plan.requiredMB,
      marginVramMB: plan.marginMB, shortageVramMB: plan.shortageMB,
      footprintVramMB: plan.footprintMB, loadedVramMB: plan.loadedMB,
      vramBreakdown: plan.breakdown, vramApprox: plan.approx,
      finalNodeId,
      nodes: nodes.map(n => ({
        id: n.id, type: n.type, label: n.label || n.id, model: n.model || null,
        inputs: n.inputs || [],
        participants: (n.participants || []).map(p => ({ model: p.model, label: p.label })),
      })),
      levels,
    });

    const ctx = {
      query, history, baseSystem, emit,
      mode: plan.mode,
      results: new Map(),        // nodeId → { status, text, label, model, ms }
      routerChoice: new Map(),   // routerNodeId → 選ばれた target
      skipped: new Set(),
    };

    /** ルーターで選ばれなかった枝かどうか */
    function isSkipped(node) {
      if (ctx.skipped.has(node.id)) return true;
      // ルーターの分岐先で、自分が選ばれていないなら skip
      for (const r of nodes) {
        if (r.type !== 'router') continue;
        const targets = (r.routes || []).map(x => x.target).filter(Boolean);
        if (!targets.includes(node.id)) continue;
        if (!ctx.routerChoice.has(r.id)) continue;       // ルーター未実行なら判断しない
        if (ctx.routerChoice.get(r.id) !== node.id) return true;
      }
      // 入力が全て skip されているなら自分も skip（output は除く）
      const ins = node.inputs || [];
      if (ins.length > 0 && ins.every(i => ctx.skipped.has(i))) return true;
      return false;
    }

    async function execNode(nodeId) {
      const node = nodes.find(n => n.id === nodeId);
      if (!node) return;
      if (node.type === 'output') {
        ctx.results.set(node.id, { status: 'done', text: '', label: node.label || '最終出力', model: null });
        return;
      }
      if (isSkipped(node)) {
        ctx.skipped.add(node.id);
        ctx.results.set(node.id, { status: 'skipped', text: '', label: node.label || node.id, model: node.model || null });
        emit({ type: 'node_skipped', id: node.id, label: node.label || node.id });
        return;
      }

      const label = node.label || node.id;
      const startedAt = Date.now();
      emit({ type: 'node_start', id: node.id, label, model: node.model || null, nodeType: node.type });
      try {
        let text;
        if (node.type === 'router') text = await runRouterNode(node, ctx, run);
        else if (node.type === 'debate') text = await runDebateNode(node, ctx, run);
        else text = await runLlmNode(node, ctx, run);   // llm / aggregate は同じ経路

        const ms = Date.now() - startedAt;
        ctx.results.set(node.id, { status: 'done', text, label, model: node.model || null, ms });
        emit({ type: 'node_done', id: node.id, label, ms, text, chars: text.length });
      } catch (e) {
        const ms = Date.now() - startedAt;
        ctx.results.set(node.id, {
          status: 'error', text: '', label, model: node.model || null, ms,
          error: e.message, workerCrashed: !!e.workerCrashed,
        });
        emit({ type: 'node_error', id: node.id, label, error: e.message, workerCrashed: !!e.workerCrashed });
        log('-', `[オーケストレーション] ノード「${label}」でエラー: ${e.message}`);
        if (cfg().stopOnNodeError) throw e;
      }
    }

    async function runLevel(ids, serial) {
      if (!serial && ids.length > 1) {
        await Promise.all(ids.map(id => execNode(id)));
      } else {
        for (const id of ids) {
          if (run.cancelled) break;
          await execNode(id);
        }
      }
    }

    // 常駐並列で走らせたがワーカーが落ちた場合、原因はほぼVRAM不足なので、
    // 一度だけ逐次スワップに落として落ちたノードをやり直す。
    // 見積りを外して resident と判定してしまったときの保険。
    let degraded = false;

    try {
      for (const level of levels) {
        if (run.cancelled) break;
        // 逐次スワップはモデル載せ替えが挟まるため並列にできない
        await runLevel(level, ctx.mode !== 'resident');

        if (run.cancelled) break;
        const crashed = level.filter(id => ctx.results.get(id)?.workerCrashed);
        if (crashed.length > 0 && !degraded && ctx.mode === 'resident') {
          degraded = true;
          ctx.mode = 'swap';
          log('-', `[オーケストレーション] ワーカー異常終了を検知。逐次スワップに切り替えて ${crashed.length}ノードを再実行`);
          emit({
            type: 'degraded', mode: 'swap',
            reason: 'ワーカーが異常終了したため（VRAM不足の可能性）、逐次スワップに切り替えて再実行します',
            retrying: crashed.length,
          });
          await pool.unloadAll();
          await runLevel(crashed, true);
        }
      }
    } finally {
      for (const req of run.activeReqs) { try { req.destroy(); } catch {} }
      run.activeReqs.clear();
    }

    const finalResult = ctx.results.get(finalNodeId);
    // 最終ノードが skip/エラーなら、成功している中で最後のノードを代わりに使う
    let finalText = finalResult && finalResult.status === 'done' ? finalResult.text : '';
    let usedNodeId = finalNodeId;
    if (!finalText) {
      for (const n of [...nodes].reverse()) {
        const r = ctx.results.get(n.id);
        if (r && r.status === 'done' && r.text) { finalText = r.text; usedNodeId = n.id; break; }
      }
    }

    emit({ type: 'final', id: usedNodeId, text: finalText });
    emit({ type: 'done' });

    return {
      finalText,
      finalNodeId: usedNodeId,
      mode: plan.mode,
      results: nodes.map(n => {
        const r = ctx.results.get(n.id) || { status: 'pending' };
        return { id: n.id, label: n.label || n.id, model: n.model || null, status: r.status, ms: r.ms || 0, error: r.error };
      }),
    };
  }

  return { runWorkflow, validateWorkflow, topoLevels, resolveFinalNodeId, stripThink };
}

module.exports = { createOrchestrator, validateWorkflow, topoLevels, resolveFinalNodeId, stripThink, NODE_TYPES };
