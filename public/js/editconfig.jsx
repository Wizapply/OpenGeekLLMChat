const { useState, useEffect, useRef, useCallback, useMemo } = React;

// 秒数を "1h 23m" 形式に変換
function formatUptime(seconds) {
  if (seconds == null) return '';
  const s = Math.floor(seconds);
  if (s < 60) return `${s}秒`;
  if (s < 3600) return `${Math.floor(s / 60)}分${s % 60}秒`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間${Math.floor((s % 3600) / 60)}分`;
  return `${Math.floor(s / 86400)}日${Math.floor((s % 86400) / 3600)}時間`;
}

// ════════════════════════════════════════════════
// マルチLLM ワークフローエディタ
// ════════════════════════════════════════════════
// config.json の orchestration.workflows を GUI で編集する。
// ここで保存したワークフローは、チャット画面の「チャットモデル」選択肢に並ぶ。

const ORCH_NODE_TYPES = [
  { value: 'llm', icon: '🤖', label: 'LLM', desc: '1つのモデルに処理させる基本ノード' },
  { value: 'aggregate', icon: '🧩', label: '統合', desc: '複数の上流ノードの出力を1つにまとめる' },
  { value: 'router', icon: '🔀', label: 'ルーター', desc: 'モデルに分岐先を選ばせる。選ばれなかった枝は実行されない' },
  { value: 'debate', icon: '💬', label: '討論', desc: '複数モデルが複数ラウンド議論する' },
  { value: 'output', icon: '🎯', label: '最終出力', desc: 'ユーザーへの回答にするノードを指定する' },
];

function orchNodeMeta(type) {
  return ORCH_NODE_TYPES.find(t => t.value === type) || ORCH_NODE_TYPES[0];
}

function orchNewId(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 8);
}

// ─── プリセットテンプレート ───
function orchTemplates(models) {
  const m = (i) => models[Math.min(i, Math.max(0, models.length - 1))] || '';
  return [
    {
      key: 'parallel', icon: '🧠', name: '並列合議（アンサンブル）',
      desc: '同じ質問を複数モデルに同時に投げ、統合役が1つの回答にまとめます。品質重視。',
      build: () => ({
        name: '並列合議', description: '複数モデルの回答を統合して精度を上げる',
        nodes: [
          { id: 'expert1', type: 'llm', label: '専門家A', model: m(0), inputs: [],
            role: 'あなたは論理的で厳密な専門家です。事実関係を重視して回答してください。' },
          { id: 'expert2', type: 'llm', label: '専門家B', model: m(1), inputs: [],
            role: 'あなたは発想力のある専門家です。多角的な視点や見落としがちな観点を挙げてください。' },
          { id: 'merge', type: 'aggregate', label: '統合', model: m(1), inputs: ['expert1', 'expert2'],
            role: 'あなたは複数の意見を統合する編集者です。',
            instruction: '2つの回答を突き合わせ、矛盾があれば妥当な方を採用し、抜けを補って1つの完成した回答にまとめてください。誰が何を言ったかの説明は不要です。' },
          { id: 'out', type: 'output', label: '最終回答', inputs: ['merge'] },
        ],
      }),
    },
    {
      key: 'router', icon: '🔀', name: 'ルーター振り分け',
      desc: '小型モデルが質問を判定し、最適な1モデルにだけ処理させます。速度・VRAM効率重視。',
      build: () => ({
        name: 'ルーター振り分け', description: '質問の種類に応じて担当モデルを切り替える',
        nodes: [
          { id: 'router', type: 'router', label: '振り分け', model: m(0), inputs: [],
            routes: [
              { label: 'コード・技術', description: 'プログラミング、エラー解析、技術的な質問', target: 'coder' },
              { label: '一般・文章', description: '雑談、要約、文章作成、その他一般的な質問', target: 'general' },
            ] },
          { id: 'coder', type: 'llm', label: 'コード担当', model: m(2), inputs: [],
            role: 'あなたは熟練のソフトウェアエンジニアです。コードは動作する完全な形で提示してください。' },
          { id: 'general', type: 'llm', label: '一般担当', model: m(1), inputs: [],
            role: 'あなたは親切で分かりやすい説明が得意なアシスタントです。' },
        ],
      }),
    },
    {
      key: 'pipeline', icon: '🔗', name: '逐次パイプライン（下書き→推敲）',
      desc: '高速モデルが下書きし、高品質モデルが批評・推敲して仕上げます。',
      build: () => ({
        name: '下書き→推敲', description: '高速モデルの下書きを高品質モデルが仕上げる',
        nodes: [
          { id: 'draft', type: 'llm', label: '下書き', model: m(0), inputs: [],
            role: 'あなたは素早く要点を押さえた下書きを作る担当です。細部より網羅性を優先してください。' },
          { id: 'refine', type: 'llm', label: '推敲', model: m(2), inputs: ['draft'],
            role: 'あなたは厳しい編集者です。',
            instruction: '下書きの誤り・不足・冗長な部分を直し、完成した回答として書き直してください。「下書きを修正しました」等の前置きは不要で、完成版の本文だけを出力してください。' },
          { id: 'out', type: 'output', label: '最終回答', inputs: ['refine'] },
        ],
      }),
    },
    {
      key: 'codegen', icon: '💻', name: '通常回答＋コード生成',
      desc: 'いつもの回答に加えて、コードが必要なときだけコード特化モデルを走らせます。',
      build: () => ({
        name: '通常回答＋コード生成',
        description: 'コードが必要な質問のときだけコード専用モデルを追加で動かす',
        nodes: [
          { id: 'answer', type: 'llm', label: '通常回答', model: m(1), inputs: [],
            role: 'あなたは親切で分かりやすい説明が得意なアシスタントです。' },
          { id: 'coder', type: 'llm', label: 'コード生成（条件付き）', model: m(2), inputs: [],
            role: 'あなたは熟練のソフトウェアエンジニアです。'
              + '説明は最小限にして、そのまま動作する完全なコードを提示してください。',
            when: {
              mode: 'llm', model: m(0),
              question: 'この質問はプログラムのコードを書くことを求めていますか？',
            } },
          { id: 'merge', type: 'aggregate', label: '統合', model: m(1), inputs: ['answer', 'coder'],
            role: 'あなたは複数の担当の出力をまとめる編集者です。',
            instruction: 'コードが提供されている場合は、説明の適切な位置にコードブロックとして組み込んでください。'
              + 'コードが無い場合は説明だけを整えて出力してください。誰が書いたかの説明は不要です。' },
          { id: 'out', type: 'output', label: '最終回答', inputs: ['merge'] },
        ],
      }),
    },
    {
      key: 'debate', icon: '⚖️', name: '討論→結論',
      desc: '2モデルが賛否に分かれて議論し、司会役が結論をまとめます。判断が割れる問いに有効。',
      build: () => ({
        name: '討論→結論', description: '複数の立場で議論させてから結論を出す',
        nodes: [
          { id: 'debate', type: 'debate', label: '討論', rounds: 2,
            participants: [
              { model: m(0), label: '賛成派', role: 'あなたは提案に賛成する立場です。利点と実現性を具体的に主張してください。' },
              { model: m(1), label: '反対派', role: 'あなたは提案に慎重な立場です。リスクと見落としを具体的に指摘してください。' },
            ] },
          { id: 'conclude', type: 'aggregate', label: '結論', model: m(1), inputs: ['debate'],
            role: 'あなたは中立な司会者です。',
            instruction: '討論を踏まえ、双方の妥当な指摘を取り入れたうえで、ユーザーへの最終的な結論と理由を簡潔にまとめてください。' },
          { id: 'out', type: 'output', label: '最終回答', inputs: ['conclude'] },
        ],
      }),
    },
  ];
}

/**
 * ワークフローエディタ本体
 * @param hasUnsavedText テキストエディタ側に未保存の変更があるか（あると保存でそれを消してしまうため止める）
 * @param onSaved        保存/削除後に config.json を再読み込みさせるコールバック
 */
function OrchestraEditor({ hasUnsavedText, onSaved }) {
  const [info, setInfo] = useState({ enabled: false, workflows: [], models: [] });
  const [list, setList] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState(null);
  const [errors, setErrors] = useState([]);
  const [plan, setPlan] = useState(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [loadError, setLoadError] = useState('');

  const models = info.models || [];
  const templates = orchTemplates(models.map(m => m.name));

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/orchestra/info');
        if (!r.ok) throw new Error(`取得失敗: ${r.status}`);
        const d = await r.json();
        setInfo(d);
        setList(d.workflows || []);
        if ((d.workflows || []).length > 0) setSelectedId(d.workflows[0].id);
      } catch (e) { setLoadError(e.message); }
    })();
  }, []);

  // 選択が変わったら編集用のコピーを作る。selectedId が空なら保存前の新規ドラフトなので触らない
  useEffect(() => {
    if (!selectedId) return;
    const wf = list.find(w => w.id === selectedId);
    setDraft(wf ? JSON.parse(JSON.stringify(wf)) : null);
    setErrors([]);
    setPlan(null);
  }, [selectedId, list]);

  // 編集のたびにサーバー側で検証（循環参照・未知モデル等）＋実行モードの見込みを取得
  useEffect(() => {
    if (!draft) return;
    const t = setTimeout(async () => {
      try {
        const res = await fetch('/orchestra/validate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft),
        });
        const d = await res.json();
        setErrors(d.errors || []);
        setPlan(d.plan || null);
      } catch { /* 検証が失敗しても編集は続けられる */ }
    }, 400);
    return () => clearTimeout(t);
  }, [draft]);

  function updateDraft(fn) {
    setDraft(prev => { const next = JSON.parse(JSON.stringify(prev)); fn(next); return next; });
  }
  function updateNode(nodeId, fn) {
    updateDraft(d => { const n = d.nodes.find(x => x.id === nodeId); if (n) fn(n); });
  }

  function addNode(type) {
    updateDraft(d => {
      const meta = orchNodeMeta(type);
      const node = {
        id: orchNewId(type), type,
        label: `${meta.label}${d.nodes.filter(n => n.type === type).length + 1}`,
        inputs: [],
      };
      if (type !== 'output' && type !== 'debate') node.model = models[0]?.name || '';
      if (type === 'router') {
        node.routes = [
          { label: '分岐A', description: '', target: '' },
          { label: '分岐B', description: '', target: '' },
        ];
      }
      if (type === 'debate') {
        node.rounds = 2;
        node.participants = [
          { model: models[0]?.name || '', label: '参加者1', role: '' },
          { model: models[1]?.name || models[0]?.name || '', label: '参加者2', role: '' },
        ];
      }
      d.nodes.push(node);
    });
  }

  // 種別を変えたとき、その種別に必要なフィールドが無ければ用意する
  function changeNodeType(nodeId, type) {
    updateNode(nodeId, n => {
      n.type = type;
      if (type !== 'output' && type !== 'debate' && !n.model) n.model = models[0]?.name || '';
      if (type === 'router' && (!n.routes || n.routes.length < 2)) {
        n.routes = [
          { label: '分岐A', description: '', target: '' },
          { label: '分岐B', description: '', target: '' },
        ];
      }
      if (type === 'debate' && (!n.participants || n.participants.length < 2)) {
        n.rounds = n.rounds || 2;
        n.participants = [
          { model: models[0]?.name || '', label: '参加者1', role: '' },
          { model: models[1]?.name || models[0]?.name || '', label: '参加者2', role: '' },
        ];
      }
    });
  }

  function removeNode(nodeId) {
    updateDraft(d => {
      d.nodes = d.nodes.filter(n => n.id !== nodeId);
      // 消したノードへの参照も掃除する
      for (const n of d.nodes) {
        if (n.inputs) n.inputs = n.inputs.filter(i => i !== nodeId);
        if (n.routes) n.routes.forEach(r => { if (r.target === nodeId) r.target = ''; });
      }
    });
  }

  function moveNode(nodeId, dir) {
    updateDraft(d => {
      const i = d.nodes.findIndex(n => n.id === nodeId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= d.nodes.length) return;
      const tmp = d.nodes[i]; d.nodes[i] = d.nodes[j]; d.nodes[j] = tmp;
    });
  }

  function createFromTemplate(tpl) {
    const wf = tpl.build();
    wf.id = '';   // 保存時にサーバーが採番する
    setDraft(wf);
    setSelectedId('');
    setNotice(`テンプレート「${tpl.name}」から作成しました。保存すると config.json に書き込まれます。`);
  }

  function createEmpty() {
    setDraft({
      id: '', name: '新しいワークフロー', description: '',
      nodes: [{ id: orchNewId('llm'), type: 'llm', label: 'LLM1', model: models[0]?.name || '', inputs: [] }],
    });
    setSelectedId('');
    setNotice('');
  }

  async function save() {
    if (!draft) return;
    setSaving(true); setNotice('');
    try {
      const res = await fetch('/orchestra/workflows', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const d = await res.json();
      if (!res.ok) { setErrors(d.errors || [d.error || '保存に失敗しました']); return; }
      setList(prev => {
        const next = prev.filter(w => w.id !== d.workflow.id);
        next.push(d.workflow);
        return next;
      });
      setSelectedId(d.workflow.id);
      setNotice('config.json に保存しました。チャット画面のモデル選択にすぐ反映されます（再起動不要）。');
      onSaved && onSaved();
    } catch (e) {
      setErrors([e.message]);
    } finally { setSaving(false); }
  }

  async function remove(id) {
    if (!confirm('このワークフローを削除しますか？（config.json から消えます）')) return;
    try {
      const res = await fetch(`/orchestra/workflows/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error);
      const next = list.filter(w => w.id !== id);
      setList(next);
      if (selectedId === id) {
        setSelectedId(next[0]?.id || '');
        if (next.length === 0) setDraft(null);
      }
      setNotice('削除しました。');
      onSaved && onSaved();
    } catch (e) { setErrors([e.message]); }
  }

  if (loadError) {
    return <div className="orch-editor-empty">ワークフロー情報を取得できませんでした: {loadError}</div>;
  }

  // 画像を渡す設定なのに Vision 非対応(--mmproj 未指定)のモデルを使っている場合に知らせる
  function visionWarning(node) {
    const check = (name) => {
      const m = models.find(x => x.name === name);
      return m && m.vision === false ? name : null;
    };
    const bad = node.type === 'debate'
      ? (node.participants || []).map(p => check(p.model)).filter(Boolean)
      : [check(node.model)].filter(Boolean);
    if (bad.length === 0) return '';
    return `${[...new Set(bad)].join(', ')} は画像に対応していません`
      + `（config.json の extraArgs に --mmproj の指定が必要です）`;
  }

  const otherNodes = draft ? draft.nodes : [];

  return (
    <div className="orch-layout">
      {/* 左: ワークフロー一覧とテンプレート */}
      <div className="orch-list-pane">
        {!info.enabled && (
          <div className="orch-disabled-note">
            ⚠️ <code>orchestration.enabled</code> が <code>false</code> です。
            テキスト編集で <code>true</code> にして保存・再起動するとチャット画面で選べるようになります。
          </div>
        )}
        <div className="section-title">保存済みワークフロー</div>
        {list.length === 0 && <div className="empty-hint">まだありません</div>}
        {list.map(w => (
          <div key={w.id} className={`orch-wf-item ${w.id === selectedId ? 'active' : ''}`}
            onClick={() => { setSelectedId(w.id); setNotice(''); }}>
            <div className="orch-wf-name">{w.name}</div>
            <div className="orch-wf-sub">{(w.nodes || []).filter(n => n.type !== 'output').length}モデル</div>
            <button className="orch-wf-del" onClick={e => { e.stopPropagation(); remove(w.id); }} title="削除">🗑</button>
          </div>
        ))}
        <div className="section-title" style={{ marginTop: 16 }}>新規作成</div>
        <button className="orch-tpl-btn" onClick={createEmpty}>＋ 空のワークフロー</button>
        {templates.map(t => (
          <button key={t.key} className="orch-tpl-btn" onClick={() => createFromTemplate(t)} title={t.desc}>
            {t.icon} {t.name}
          </button>
        ))}
        <div className="empty-hint" style={{ marginTop: 12 }}>
          保存したワークフローは、チャット画面の「チャットモデル」選択肢に <strong>🎼 マルチLLM</strong> として並びます。
        </div>
      </div>

      {/* 右: ノード編集 */}
      <div className="orch-edit-pane">
        {!draft ? (
          <div className="orch-editor-empty">
            左からワークフローを選ぶか、テンプレートで新規作成してください。
          </div>
        ) : (
          <React.Fragment>
            <div className="orch-field-row">
              <label className="orch-field">
                <span className="orch-field-label">名前（チャットのモデル選択に表示されます）</span>
                <input className="orch-input" value={draft.name || ''}
                  onChange={e => updateDraft(d => { d.name = e.target.value; })} />
              </label>
              <label className="orch-field" style={{ flex: 2 }}>
                <span className="orch-field-label">説明</span>
                <input className="orch-input" value={draft.description || ''}
                  onChange={e => updateDraft(d => { d.description = e.target.value; })} />
              </label>
            </div>

            {plan && (
              <div className={`orch-plan-hint ${plan.mode}`}>
                <div>
                  実行モード見込み: <strong>{plan.mode === 'resident' ? '常駐並列（同時起動）' : '逐次スワップ（1つずつ入れ替え）'}</strong>
                  {' '}— {plan.reason}
                </div>
                {plan.breakdown && plan.breakdown.length > 0 && (
                  <table className="orch-vram-table">
                    <tbody>
                      {plan.breakdown.map(m => (
                        <React.Fragment key={m.name}>
                          <tr>
                            <td>{m.name}</td>
                            <td className="num">ctx {Math.round(m.ctx / 1024)}k</td>
                            <td className="num">重み {(m.weightsMB / 1024).toFixed(1)}</td>
                            <td className="num">KV {(m.kvMB / 1024).toFixed(1)}</td>
                            <td className="num total">計 {(m.totalMB / 1024).toFixed(1)}GB</td>
                          </tr>
                          {/* KVの算出根拠。値がおかしいときに何を読んだか分かるように出す */}
                          <tr className="meta">
                            <td colSpan={5}>
                              {m.source === 'measured'
                                ? 'KV算出: llama-server が報告した実測値'
                                : m.layers
                                  ? `KV算出: ${m.arch || 'unknown'} / ${m.layers}層 × KV${m.kvHeads}ヘッド × ${m.headDim}次元`
                                    + (m.swa > 0 ? ` / 窓${m.swa}` : '')
                                  : 'KV算出: GGUFを読めず概算（初回ロード後に実測値へ置き換わります）'}
                            </td>
                          </tr>
                        </React.Fragment>
                      ))}
                      <tr className="sum">
                        <td colSpan={4}>
                          ワークフロー全体 {((plan.footprintMB ?? plan.requiredMB) / 1024).toFixed(1)}GB
                          {plan.loadedMB > 0 && `（うち ${(plan.loadedMB / 1024).toFixed(1)}GB はロード済み）`}
                          {' '}／ 追加で必要 {(plan.requiredMB / 1024).toFixed(1)}GB
                          ＋ 余裕 {(plan.marginMB / 1024).toFixed(1)}GB
                          ／ 空きVRAM {(plan.freeMB / 1024).toFixed(1)}GB
                        </td>
                        <td className="num total">
                          {plan.shortageMB > 0
                            ? `${(plan.shortageMB / 1024).toFixed(1)}GB 不足`
                            : '収まります'}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                )}
                {plan.shortageMB > 0 && (
                  <div className="orch-plan-tip">
                    💡 KVキャッシュは ctx に比例します。config.json で該当モデルの <code>ctx</code> を下げると大きく減らせます。
                  </div>
                )}
              </div>
            )}
            {errors.length > 0 && (
              <div className="orch-errors">{errors.map((e, i) => <div key={i}>⚠️ {e}</div>)}</div>
            )}
            {notice && <div className="orch-notice">{notice}</div>}
            {hasUnsavedText && (
              <div className="orch-errors">
                ⚠️ テキストエディタに未保存の変更があります。ワークフローを保存すると config.json が再読み込みされ、
                その変更は失われます。先に「💾 保存」または「↺ 破棄」を行ってください。
              </div>
            )}

            <div className="orch-nodes">
              {draft.nodes.map((node, ni) => {
                const meta = orchNodeMeta(node.type);
                return (
                  <div key={node.id} className="orch-node-card">
                    <div className="orch-node-card-head">
                      <span className="orch-node-icon">{meta.icon}</span>
                      <input className="orch-input orch-input-label" value={node.label || ''}
                        placeholder="ノード名"
                        onChange={e => updateNode(node.id, n => { n.label = e.target.value; })} />
                      <select className="orch-select" value={node.type} title={meta.desc}
                        onChange={e => changeNodeType(node.id, e.target.value)}>
                        {ORCH_NODE_TYPES.map(t => (
                          <option key={t.value} value={t.value}>{t.icon} {t.label}</option>
                        ))}
                      </select>
                      <div className="orch-node-card-actions">
                        <button className="orch-mini-btn" onClick={() => moveNode(node.id, -1)} disabled={ni === 0} title="上へ">↑</button>
                        <button className="orch-mini-btn" onClick={() => moveNode(node.id, 1)} disabled={ni === draft.nodes.length - 1} title="下へ">↓</button>
                        <button className="orch-mini-btn danger" onClick={() => removeNode(node.id)} title="削除">🗑</button>
                      </div>
                    </div>

                    <div className="orch-node-card-body">
                      {node.type !== 'output' && node.type !== 'debate' && (
                        <label className="orch-field">
                          <span className="orch-field-label">モデル</span>
                          <select className="orch-select" value={node.model || ''}
                            onChange={e => updateNode(node.id, n => { n.model = e.target.value; })}>
                            <option value="">（選択してください）</option>
                            {models.map(m => (
                              <option key={m.name} value={m.name}>
                                {m.name}{m.estimatedVramMB ? ` — 約${(m.estimatedVramMB / 1024).toFixed(1)}GB` : ''}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}

                      {node.type !== 'router' && (
                        <div className="orch-field">
                          <span className="orch-field-label">入力（このノードが出力を受け取る相手）</span>
                          <div className="orch-input-picker">
                            {otherNodes.filter(o => o.id !== node.id && o.type !== 'output').length === 0 && (
                              <span className="empty-hint">他にノードがありません</span>
                            )}
                            {otherNodes.filter(o => o.id !== node.id && o.type !== 'output').map(o => (
                              <label key={o.id} className="orch-chip">
                                <input type="checkbox" checked={(node.inputs || []).includes(o.id)}
                                  onChange={e => updateNode(node.id, n => {
                                    n.inputs = n.inputs || [];
                                    if (e.target.checked) n.inputs.push(o.id);
                                    else n.inputs = n.inputs.filter(x => x !== o.id);
                                  })} />
                                {orchNodeMeta(o.type).icon} {o.label}
                              </label>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* 参照ドキュメント(RAG)と画像。ノード単位で有効化する */}
                      {node.type !== 'output' && node.type !== 'router' && (
                        <div className="orch-field">
                          <span className="orch-field-label">このノードに渡すもの</span>
                          <div className="orch-input-picker">
                            <label className="orch-chip" title="チャット添付ドキュメントと永続RAGを検索し、抜粋をこのノードに渡します">
                              <input type="checkbox" checked={!!node.useRag}
                                onChange={e => updateNode(node.id, n => { n.useRag = e.target.checked; })} />
                              📚 参照ドキュメント(RAG)
                            </label>
                            <label className="orch-chip" title="チャットに添付された画像をこのノードに渡します（モデルがVision対応である必要があります）">
                              <input type="checkbox" checked={!!node.useImages}
                                onChange={e => updateNode(node.id, n => { n.useImages = e.target.checked; })} />
                              🖼️ 画像
                            </label>
                          </div>
                          {node.useRag && info.rag && info.rag.available === false && (
                            <div className="orch-node-warn">
                              ⚠️ embedding が利用できないため検索できません: {info.rag.reason}
                            </div>
                          )}
                          {node.useImages && visionWarning(node) && (
                            <div className="orch-node-warn">⚠️ {visionWarning(node)}</div>
                          )}
                        </div>
                      )}

                      {/* 実行条件: 満たさないノードは飛ばす（ルーターと違い排他ではない） */}
                      {node.type !== 'output' && (
                        <div className="orch-field">
                          <span className="orch-field-label">
                            実行条件
                            <select className="orch-select orch-select-inline"
                              value={node.when?.mode || 'always'}
                              onChange={e => updateNode(node.id, n => {
                                const mode = e.target.value;
                                if (mode === 'always') { delete n.when; return; }
                                n.when = n.when || {};
                                n.when.mode = mode;
                                if (mode === 'keyword' && !n.when.keywords) n.when.keywords = [];
                                if (mode === 'llm') {
                                  if (!n.when.model) n.when.model = models[0]?.name || '';
                                  if (!n.when.question) n.when.question = 'この質問はプログラムのコードを書くことを求めていますか？';
                                }
                              })}>
                              <option value="always">常に実行</option>
                              <option value="keyword">キーワードを含むとき</option>
                              <option value="llm">LLMが「はい」と判定したとき</option>
                            </select>
                          </span>
                          {node.when?.mode === 'keyword' && (
                            <input className="orch-input"
                              value={(node.when.keywords || []).join(', ')}
                              placeholder="コード, プログラム, python, 実装（カンマ区切り・大文字小文字は区別しません）"
                              onChange={e => updateNode(node.id, n => {
                                n.when.keywords = e.target.value.split(',').map(x => x.trim()).filter(Boolean);
                              })} />
                          )}
                          {node.when?.mode === 'llm' && (
                            <div className="orch-route-row">
                              <select className="orch-select" value={node.when.model || ''}
                                onChange={e => updateNode(node.id, n => { n.when.model = e.target.value; })}>
                                <option value="">（判定モデル）</option>
                                {models.map(mm => <option key={mm.name} value={mm.name}>{mm.name}</option>)}
                              </select>
                              <input className="orch-input" value={node.when.question || ''}
                                placeholder="判定してほしいこと（はい/いいえで答えられる形）"
                                onChange={e => updateNode(node.id, n => { n.when.question = e.target.value; })} />
                            </div>
                          )}
                          {node.when?.mode && node.when.mode !== 'always' && (
                            <div className="orch-hint">
                              条件を満たさない場合このノードは実行されず、下流には他のノードの出力だけが渡ります。
                              {node.when.mode === 'llm' && ' 判定は小型モデルが速くて安上がりです。'}
                            </div>
                          )}
                        </div>
                      )}

                      {node.type !== 'output' && (
                        <label className="orch-field">
                          <span className="orch-field-label">役割・指示（システムプロンプトに追加）</span>
                          <textarea className="orch-textarea" rows={2} value={node.role || ''}
                            placeholder="例: あなたは厳密な事実確認を行う校閲者です。"
                            onChange={e => updateNode(node.id, n => { n.role = e.target.value; })} />
                        </label>
                      )}

                      {node.type !== 'output' && node.type !== 'router' && (node.inputs || []).length > 0 && (
                        <label className="orch-field">
                          <span className="orch-field-label">上流の出力に対する指示</span>
                          <textarea className="orch-textarea" rows={2} value={node.instruction || ''}
                            placeholder="例: 2つの回答を統合して1つの完成した回答にまとめてください。"
                            onChange={e => updateNode(node.id, n => { n.instruction = e.target.value; })} />
                        </label>
                      )}

                      {node.type === 'router' && (
                        <div className="orch-field">
                          <span className="orch-field-label">分岐（モデルがこの中から1つ選ぶ）</span>
                          {(node.routes || []).map((r, ri) => (
                            <div key={ri} className="orch-route-row">
                              <input className="orch-input" value={r.label || ''} placeholder="分岐名"
                                onChange={e => updateNode(node.id, n => { n.routes[ri].label = e.target.value; })} />
                              <input className="orch-input" value={r.description || ''} placeholder="どんな時にこの分岐か"
                                onChange={e => updateNode(node.id, n => { n.routes[ri].description = e.target.value; })} />
                              <select className="orch-select" value={r.target || ''}
                                onChange={e => updateNode(node.id, n => { n.routes[ri].target = e.target.value; })}>
                                <option value="">（分岐先ノード）</option>
                                {otherNodes.filter(o => o.id !== node.id && o.type !== 'output').map(o => (
                                  <option key={o.id} value={o.id}>{o.label}</option>
                                ))}
                              </select>
                              <button className="orch-mini-btn danger"
                                onClick={() => updateNode(node.id, n => { n.routes.splice(ri, 1); })}>🗑</button>
                            </div>
                          ))}
                          <button className="orch-mini-btn"
                            onClick={() => updateNode(node.id, n => { (n.routes = n.routes || []).push({ label: '', description: '', target: '' }); })}>
                            ＋ 分岐を追加
                          </button>
                        </div>
                      )}

                      {node.type === 'debate' && (
                        <div className="orch-field">
                          <span className="orch-field-label">
                            参加者とラウンド数
                            <input className="orch-input orch-input-num" type="number" min="1" max="5"
                              value={node.rounds || 2}
                              onChange={e => updateNode(node.id, n => { n.rounds = parseInt(e.target.value) || 1; })} />
                            巡
                          </span>
                          {(node.participants || []).map((p, pi) => (
                            <div key={pi} className="orch-route-row">
                              <input className="orch-input" value={p.label || ''} placeholder="立場・呼び名"
                                onChange={e => updateNode(node.id, n => { n.participants[pi].label = e.target.value; })} />
                              <select className="orch-select" value={p.model || ''}
                                onChange={e => updateNode(node.id, n => { n.participants[pi].model = e.target.value; })}>
                                <option value="">（モデル）</option>
                                {models.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
                              </select>
                              <input className="orch-input" value={p.role || ''} placeholder="この参加者の立場・指示"
                                onChange={e => updateNode(node.id, n => { n.participants[pi].role = e.target.value; })} />
                              <button className="orch-mini-btn danger"
                                onClick={() => updateNode(node.id, n => { n.participants.splice(pi, 1); })}>🗑</button>
                            </div>
                          ))}
                          <button className="orch-mini-btn"
                            onClick={() => updateNode(node.id, n => { (n.participants = n.participants || []).push({ label: '', model: models[0]?.name || '', role: '' }); })}>
                            ＋ 参加者を追加
                          </button>
                        </div>
                      )}

                      {node.type === 'output' && (
                        <div className="empty-hint">
                          入力に指定したノードの出力が、そのままユーザーへの最終回答になります。
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="orch-add-bar">
              <span className="orch-field-label">ノードを追加:</span>
              {ORCH_NODE_TYPES.map(t => (
                <button key={t.value} className="orch-mini-btn" title={t.desc} onClick={() => addNode(t.value)}>
                  {t.icon} {t.label}
                </button>
              ))}
              <button className="btn primary orch-save-btn" onClick={save}
                disabled={saving || errors.length > 0 || hasUnsavedText}>
                {saving ? '保存中...' : '💾 ワークフローを保存'}
              </button>
            </div>
          </React.Fragment>
        )}
      </div>
    </div>
  );
}

function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [parseError, setParseError] = useState('');
  const [backups, setBackups] = useState([]);
  const [showBackups, setShowBackups] = useState(false);
  const [parsedTree, setParsedTree] = useState(null);
  // 既定はツリー編集。生JSONを直接いじるより事故りにくいので、そちらを入口にする
  const [view, setView] = useState('tree'); // 'tree' | 'text' | 'orchestra'
  const [restartInfo, setRestartInfo] = useState(null);  // {isSystemd, pid, uptime}
  const [restarting, setRestarting] = useState(false);   // 再起動中フラグ
  const [restartDone, setRestartDone] = useState(false); // 再起動完了(手動リロードボタン表示用)
  // ─── HuggingFace GGUF モデルダウンロード ───
  const [dlUrl, setDlUrl] = useState('');
  const [dlName, setDlName] = useState('');
  const [dlCtx, setDlCtx] = useState('');
  const [dlNgl, setDlNgl] = useState('');
  const [dlMmproj, setDlMmproj] = useState('');
  const [dlToken, setDlToken] = useState('');
  const [dlAdvanced, setDlAdvanced] = useState(false);
  const [dlJob, setDlJob] = useState(null); // サーバーの進捗ジョブ
  const dlPollRef = useRef(null);
  // ─── ユーザーアイコン ───
  const [userIcon, setUserIcon] = useState('');
  const [iconUploading, setIconUploading] = useState(false);
  const iconInputRef = useRef(null);
  const textareaRef = useRef(null);

  // 認証チェック
  useEffect(() => {
    (async () => {
      try {
        const cfg = await (await fetch('/config')).json();
        if (cfg.userIcon) setUserIcon(cfg.userIcon);
        if (cfg.hasPassword) {
          setAuthRequired(true);
          if (cfg.authenticated) setAuthenticated(true);
        } else {
          setAuthenticated(true);
        }
      } catch {}
    })();
  }, []);

  // config 読み込み
  useEffect(() => {
    if (!authenticated) return;
    loadConfig();
    loadBackups();
    loadRestartInfo();
    // リロード時に進行中のダウンロードがあれば表示を復帰
    (async () => {
      try {
        const data = await (await fetch('/config/model-download/status')).json();
        if (data && data.status === 'downloading') {
          setDlJob(data);
          pollModelDownload();
        }
      } catch {}
    })();
  }, [authenticated]);

  // テキスト変更時にJSON構文チェック
  // 構文エラー時は parsedTree を null にする。古いツリーを残したまま編集させると、
  // テキスト側の変更を巻き戻して上書きしてしまうため（ツリーは常に現在の content の像）。
  useEffect(() => {
    if (!content) { setParseError(''); setParsedTree(null); return; }
    try {
      const parsed = JSON.parse(content);
      setParseError('');
      setParsedTree(parsed);
    } catch (e) {
      setParseError(e.message);
      setParsedTree(null);
    }
  }, [content]);

  /**
   * ツリーで編集された結果を content（生テキスト）に書き戻す。
   * content が唯一の正なので、保存・未保存判定・テキスト表示はこれまで通り動く。
   */
  const applyTreeChange = useCallback((nextRoot) => {
    setError('');
    setContent(JSON.stringify(nextRoot, null, 2));
  }, []);

  async function loadConfig() {
    setLoading(true); setError('');
    try {
      const r = await fetch('/config/raw');
      if (!r.ok) throw new Error(`読み込み失敗: ${r.status}`);
      const text = await r.text();
      setContent(text);
      setOriginal(text);
    } catch (e) {
      setError(e.message);
    } finally { setLoading(false); }
  }

  async function loadBackups() {
    try {
      const r = await fetch('/config/backups');
      if (r.ok) {
        const data = await r.json();
        setBackups(data.backups || []);
      }
    } catch {}
  }

  async function loadRestartInfo() {
    try {
      const r = await fetch('/restart/info');
      if (r.ok) {
        const data = await r.json();
        setRestartInfo(data);
      }
    } catch {}
  }

  async function restartServer() {
    if (hasChanges) {
      if (!confirm('未保存の変更があります。先に保存しますか？\n\n「OK」: 保存せず再起動\n「キャンセル」: 何もしない')) return;
    }
    if (!restartInfo?.isSystemd) {
      if (!confirm('⚠️ サーバーが systemd 下で動いていません。\nプロセスを終了しても自動再起動されない可能性があります。\n手動で起動し直す必要があるかもしれません。\n\n続行しますか？')) return;
    } else {
      if (!confirm('OpenGeekLLMChat 本体を再起動します。\n\n- 進行中のチャット・ストリーミングは中断されます\n- 外部APIサーバーも全て一時停止します\n- 数秒以内に自動復活します\n\n続行しますか？')) return;
    }
    setRestarting(true); setError(''); setSuccess(''); setRestartDone(false);
    try {
      // 再起動前のプロセス起動時刻を控える。これが変わったら復帰したと判定する
      const before = await fetchStartedAt();
      const r = await fetch('/restart', { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || '再起動失敗');
      setSuccess('再起動中... サーバーが復帰するまでお待ちください');
      // 再起動完了をポーリングで待つ
      pollUntilBack(before);
    } catch (e) {
      setError(`再起動失敗: ${e.message}`);
      setRestarting(false);
    }
  }

  /** サーバーの起動時刻を取得（/config は認証不要なので再起動後でも取れる） */
  async function fetchStartedAt() {
    try {
      const r = await fetch('/config', { cache: 'no-cache' });
      if (!r.ok) return null;
      const d = await r.json();
      return d.startedAt ?? null;
    } catch { return null; }
  }

  async function pollUntilBack(beforeStartedAt) {
    const startTime = Date.now();
    const maxWaitMs = 60000;  // 1分でタイムアウト
    let consecutiveOk = 0;
    // 最初の2秒は何もしない（プロセス終了を待つ）
    await new Promise(r => setTimeout(r, 2000));
    while (Date.now() - startTime < maxWaitMs) {
      try {
        // 注意: 認証が要るエンドポイントは使えない。
        // セッションはメモリ上にしかなく再起動で消えるため、復帰後は401になり
        // 「サーバーは生きているのに永遠に待つ」ことになる。/config は認証不要。
        const r = await fetch('/config', { cache: 'no-cache' });
        if (r.ok) {
          const data = await r.json();
          // 起動時刻が変わっている = 新しいプロセスに入れ替わった
          const restarted = data.startedAt != null && beforeStartedAt != null
            ? data.startedAt !== beforeStartedAt
            : true;   // startedAt を返さない旧サーバー相手なら応答できた時点で復帰とみなす
          if (restarted) {
            consecutiveOk++;
            if (consecutiveOk >= 2) {
              // PID等の詳細は認証が要るので、取れたら表示する程度に留める
              let detail = '';
              try {
                const ir = await fetch('/restart/info', { cache: 'no-cache' });
                if (ir.ok) {
                  const info = await ir.json();
                  setRestartInfo(info);
                  detail = `（PID: ${info.pid}）`;
                }
              } catch {}
              const needLogin = data.hasPassword && !data.authenticated;
              setSuccess(`✓ 再起動完了${detail}。`
                + (needLogin ? 'セッションが切れたため再ログインが必要です。' : '')
                + '最新の状態に更新するため3秒後にページを再読み込みします…');
              setRestarting(false);
              setRestartDone(true);  // 手動リロードボタンを表示
              // 自動リロード (新しいJS/HTMLを確実に読み込むため)
              setTimeout(() => { window.location.reload(); }, 3000);
              return;
            }
          }
        }
      } catch {
        // 接続エラー = まだ起動中
        consecutiveOk = 0;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    // タイムアウト
    setError('再起動の確認がタイムアウトしました。手動で確認してください。');
    setRestarting(false);
  }

  async function saveConfig() {
    if (parseError) { setError(`構文エラーがあるため保存できません: ${parseError}`); return; }
    if (content === original) { setError('変更がありません'); return; }
    if (!confirm('config.json を上書き保存します。\n\n⚠️ 注意:\n- バックアップが自動作成されます (最新10件保持)\n- 設定変更は OpenGeekLLMChat の再起動まで反映されません\n- モデルパスやポート番号を間違えるとサーバーが起動しなくなる可能性があります\n\n続行しますか？')) return;
    setSaving(true); setError(''); setSuccess('');
    try {
      const r = await fetch('/config/raw', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: content,
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || '保存失敗');
      setOriginal(content);
      setSuccess(`保存しました（バックアップ: ${data.backup}）。設定変更は本体再起動後に反映されます。`);
      setTimeout(() => setSuccess(''), 8000);
      loadBackups();
    } catch (e) {
      setError(e.message);
    } finally { setSaving(false); }
  }

  async function restoreBackup(name) {
    if (!confirm(`バックアップ「${name}」を復元しますか？\n現在のconfig.jsonは別バックアップとして保存されます。`)) return;
    setSaving(true); setError(''); setSuccess('');
    try {
      const r = await fetch('/config/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || '復元失敗');
      setSuccess(`復元しました: ${name}。本体再起動後に反映されます。`);
      setTimeout(() => setSuccess(''), 8000);
      await loadConfig();
      await loadBackups();
    } catch (e) {
      setError(e.message);
    } finally { setSaving(false); }
  }

  // ─── HuggingFace GGUF モデルのダウンロード & セットアップ ───
  function formatBytes(n) {
    if (!n || n <= 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(n) / Math.log(1024));
    return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
  }

  function pollModelDownload() {
    if (dlPollRef.current) clearInterval(dlPollRef.current);
    dlPollRef.current = setInterval(async () => {
      try {
        const r = await fetch('/config/model-download/status');
        const data = await r.json();
        setDlJob(data);
        if (data.status === 'done' || data.status === 'error' || data.status === 'idle') {
          clearInterval(dlPollRef.current);
          dlPollRef.current = null;
          if (data.status === 'done') {
            setSuccess(`✓ モデル「${data.modelName}」をダウンロードして config.json に登録しました。本体を再起動すると使用できます。`);
            setDlUrl(''); setDlName(''); setDlCtx(''); setDlNgl(''); setDlMmproj('');
            await loadConfig();   // エディタに最新のconfig.jsonを反映
            await loadBackups();
          } else if (data.status === 'error') {
            setError(`モデルのダウンロードに失敗しました: ${data.error || '不明なエラー'}`);
          }
        }
      } catch (e) {
        // ネットワーク一時エラーは無視して次のポーリングを待つ
      }
    }, 1000);
  }

  async function startModelDownload() {
    if (!dlUrl.trim()) { setError('HuggingFace の GGUF URL を入力してください'); return; }
    setError(''); setSuccess('');
    try {
      const r = await fetch('/config/model-download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: dlUrl.trim(),
          name: dlName.trim() || undefined,
          ctx: dlCtx ? parseInt(dlCtx, 10) : undefined,
          ngl: dlNgl ? parseInt(dlNgl, 10) : undefined,
          mmprojUrl: dlMmproj.trim() || undefined,
          hfToken: dlToken.trim() || undefined,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'ダウンロード開始に失敗しました');
      setDlJob({ status: 'downloading', phase: 'model', percent: 0, modelName: data.modelName, fileName: data.fileName });
      pollModelDownload();
    } catch (e) {
      setError(e.message);
    }
  }

  // アンマウント時にポーリング停止
  useEffect(() => () => { if (dlPollRef.current) clearInterval(dlPollRef.current); }, []);

  // ─── ユーザーアイコンのアップロード / 解除 ───
  async function uploadUserIcon(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) { setError('画像ファイルを選択してください'); return; }
    setIconUploading(true); setError(''); setSuccess('');
    try {
      // 拡張子を MIME から決定（サーバー側でも検証される）
      const extMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
      const ext = extMap[file.type] || (file.name.split('.').pop() || 'png').toLowerCase();
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch(`/config/user-icon?ext=${encodeURIComponent(ext)}`, { method: 'POST', body: fd });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'アップロードに失敗しました');
      // キャッシュ回避のため ?t= を付けて即時反映
      setUserIcon(`${data.userIcon}?t=${Date.now()}`);
      setSuccess('ユーザーアイコンを設定しました。チャット画面に反映されます。');
      setTimeout(() => setSuccess(''), 6000);
      // config.json が更新されたのでエディタも最新化（誤って上書き消去するのを防ぐ）
      await loadConfig();
      await loadBackups();
    } catch (e) {
      setError(e.message);
    } finally { setIconUploading(false); }
  }

  async function removeUserIcon() {
    if (!confirm('ユーザーアイコンを解除しますか？')) return;
    setError(''); setSuccess('');
    try {
      const r = await fetch('/config/user-icon', { method: 'DELETE' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || '解除に失敗しました');
      setUserIcon('');
      setSuccess('ユーザーアイコンを解除しました（デフォルトに戻ります）。');
      setTimeout(() => setSuccess(''), 6000);
      await loadConfig();
      await loadBackups();
    } catch (e) {
      setError(e.message);
    }
  }

  function formatJson() {
    if (parseError) { setError('構文エラーがあるためフォーマットできません'); return; }
    try {
      const parsed = JSON.parse(content);
      setContent(JSON.stringify(parsed, null, 2));
    } catch {}
  }

  function discardChanges() {
    if (content === original) return;
    if (!confirm('変更を破棄しますか？')) return;
    setContent(original);
  }

  function handleTextareaKeydown(e) {
    // タブキーで2スペース挿入
    if (e.key === 'Tab') {
      e.preventDefault();
      const t = e.target;
      const start = t.selectionStart;
      const end = t.selectionEnd;
      const before = t.value.substring(0, start);
      const after = t.value.substring(end);
      const indent = '  ';
      const newValue = before + indent + after;
      setContent(newValue);
      // カーソル位置を維持
      setTimeout(() => {
        t.selectionStart = t.selectionEnd = start + indent.length;
      }, 0);
    }
    // Ctrl+S or Cmd+S で保存
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveConfig();
    }
  }

  const hasChanges = content !== original;
  const lineCount = content.split('\n').length;
  const sizeKB = (new Blob([content]).size / 1024).toFixed(1);

  if (authRequired && !authenticated) {
    return <LoginView onSuccess={() => setAuthenticated(true)} />;
  }
  if (loading) {
    return <div className="loading-screen">読み込み中...</div>;
  }

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="logo">
            <div className="logo-icon" />
            <div className="logo-text">
              <div className="logo-main">OpenGeekLLM</div>
              <div className="logo-sub">設定エディタ</div>
            </div>
          </div>
        </div>
        <div className="nav-links">
          <a className="nav-link" href="/">💬 チャット</a>
          <a className="nav-link" href="/tuning.html">🧠 ファインチューニング</a>
          <a className="nav-link" href="/ml.html">🤖 機械学習</a>
        </div>
        <div className="sidebar-section">
          <div className="section-title">ファイル</div>
          <div className="stats-card">
            <div className="stats-card-label">サイズ</div>
            <div className="stats-card-value">{sizeKB} KB</div>
          </div>
          <div className="stats-card">
            <div className="stats-card-label">状態</div>
            <div className={`stats-card-value ${hasChanges ? 'orange' : 'accent'}`}>
              {hasChanges ? '● 未保存' : '○ 保存済'}
            </div>
          </div>

          {/* ── ユーザーアイコン ── */}
          <div className="section-title" style={{ marginTop: 16 }}>ユーザーアイコン</div>
          <div className="user-icon-row">
            <div className="user-icon-preview">
              {userIcon ? <img src={userIcon} alt="user icon" /> : <span className="user-icon-fallback">U</span>}
            </div>
            <div className="user-icon-actions">
              <input
                ref={iconInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                style={{ display: 'none' }}
                onChange={e => { if (e.target.files[0]) uploadUserIcon(e.target.files[0]); e.target.value = ''; }}
              />
              <button className="btn" onClick={() => iconInputRef.current?.click()} disabled={iconUploading}>
                {iconUploading ? 'アップロード中...' : '📷 画像を選択'}
              </button>
              {userIcon && (
                <button className="link-btn" style={{ fontSize: 11 }} onClick={removeUserIcon} disabled={iconUploading}>
                  解除
                </button>
              )}
            </div>
          </div>
          <div className="empty-hint" style={{ marginTop: 4, textAlign: 'left' }}>
            PNG / JPEG / WebP / GIF。チャットのユーザー側アイコンに反映されます。
          </div>

          {/* ── HuggingFace GGUF モデル追加 ── */}
          <div className="section-title" style={{ marginTop: 16 }}>モデル追加 (HuggingFace GGUF)</div>
          <div className="model-dl">
            <input
              className="input model-dl-input"
              type="text"
              placeholder="https://huggingface.co/.../model.gguf"
              value={dlUrl}
              onChange={e => setDlUrl(e.target.value)}
              disabled={dlJob && dlJob.status === 'downloading'}
            />
            <button
              className="link-btn"
              style={{ fontSize: 10, marginBottom: 8, alignSelf: 'flex-start' }}
              onClick={() => setDlAdvanced(!dlAdvanced)}
            >
              {dlAdvanced ? '詳細を隠す' : '詳細オプション'}
            </button>
            {dlAdvanced && (
              <div className="model-dl-advanced">
                <input className="input model-dl-input" type="text" placeholder="表示名 (省略時はファイル名)"
                  value={dlName} onChange={e => setDlName(e.target.value)} disabled={dlJob && dlJob.status === 'downloading'} />
                <div style={{ display: 'flex', gap: 6 }}>
                  <input className="input model-dl-input" type="number" placeholder="ctx (例 8192)"
                    value={dlCtx} onChange={e => setDlCtx(e.target.value)} disabled={dlJob && dlJob.status === 'downloading'} />
                  <input className="input model-dl-input" type="number" placeholder="ngl (例 99)"
                    value={dlNgl} onChange={e => setDlNgl(e.target.value)} disabled={dlJob && dlJob.status === 'downloading'} />
                </div>
                <input className="input model-dl-input" type="text" placeholder="mmproj URL (Vision用・任意)"
                  value={dlMmproj} onChange={e => setDlMmproj(e.target.value)} disabled={dlJob && dlJob.status === 'downloading'} />
                <input className="input model-dl-input" type="password" placeholder="HF トークン (非公開モデル用・任意)"
                  value={dlToken} onChange={e => setDlToken(e.target.value)} disabled={dlJob && dlJob.status === 'downloading'} />
              </div>
            )}
            <button
              className="btn primary"
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={startModelDownload}
              disabled={(dlJob && dlJob.status === 'downloading') || !dlUrl.trim()}
            >
              {dlJob && dlJob.status === 'downloading' ? '⬇ ダウンロード中...' : '⬇ ダウンロード & 追加'}
            </button>

            {dlJob && dlJob.status === 'downloading' && (
              <div className="model-dl-progress">
                <div className="model-dl-progress-label">
                  {dlJob.phase === 'mmproj' ? 'mmproj ダウンロード中' : dlJob.phase === 'register' ? 'config.json に登録中' : 'モデルダウンロード中'}
                  {' '}{dlJob.percent || 0}%
                </div>
                <div className="model-dl-bar">
                  <div className="model-dl-bar-fill" style={{ width: `${dlJob.percent || 0}%` }} />
                </div>
                {dlJob.totalBytes > 0 && (
                  <div className="model-dl-progress-meta">
                    {formatBytes(dlJob.downloadedBytes)} / {formatBytes(dlJob.totalBytes)}
                  </div>
                )}
              </div>
            )}
            <div className="empty-hint" style={{ marginTop: 8 }}>
              GGUF の「resolve」または「blob」URL に対応。登録後は本体を再起動すると選択できます。
            </div>
          </div>

          {/* ── バックアップ（一番下） ── */}
          <div className="section-title" style={{ marginTop: 16 }}>
            バックアップ
            <button className="link-btn" onClick={() => setShowBackups(!showBackups)} style={{ marginLeft: 6, fontSize: 10 }}>
              {showBackups ? '隠す' : `${backups.length}件`}
            </button>
          </div>
          {showBackups && (
            <div className="backup-list">
              {backups.length === 0 ? (
                <div className="empty-hint">バックアップなし</div>
              ) : (
                backups.map(b => (
                  <div key={b.name} className="backup-item" onClick={() => restoreBackup(b.name)}>
                    <div className="backup-name">{b.name.replace(/^config\.json\.bak\./, '')}</div>
                    <div className="backup-meta">{(b.size / 1024).toFixed(1)} KB</div>
                  </div>
                ))
              )}
              <div className="empty-hint" style={{ marginTop: 8 }}>クリックで復元</div>
            </div>
          )}
        </div>
      </aside>

      <main className="main">
        <header className="main-header">
          <div className="main-title">⚙️ config.json エディタ</div>
          <div className="main-actions">
            <div className="view-switch">
              <button className={`view-btn ${view === 'tree' ? 'active' : ''}`} onClick={() => setView('tree')}>🌳 ツリー編集</button>
              <button className={`view-btn ${view === 'text' ? 'active' : ''}`} onClick={() => setView('text')}>
                📝 テキスト{parseError ? ' ⚠️' : ''}
              </button>
              <button className={`view-btn ${view === 'orchestra' ? 'active' : ''}`} onClick={() => setView('orchestra')}>🎼 マルチLLM</button>
            </div>
            {view === 'text' && (
              <button className="btn" onClick={formatJson} disabled={!!parseError} title="JSONを整形">✨ 整形</button>
            )}
            <button className="btn" onClick={discardChanges} disabled={!hasChanges}>↺ 破棄</button>
            <button className="btn primary" onClick={saveConfig} disabled={saving || !hasChanges || !!parseError}>
              {saving ? '保存中...' : '💾 保存 (Ctrl+S)'}
            </button>
            <button
              className="btn restart-btn"
              onClick={restartServer}
              disabled={restarting}
              title={restartInfo?.isSystemd
                ? 'systemd経由で本体を再起動します（数秒以内に復帰）'
                : 'systemd下ではないため、再起動後に手動起動が必要かもしれません'}
            >
              {restarting ? '🔄 再起動中...' : '🔄 本体を再起動'}
            </button>
          </div>
        </header>

        {view === 'orchestra' ? (
          <div className="notice-bar">
            🎼 ここで保存したワークフローは <strong>再起動なしで即座に反映</strong> され、
            チャット画面の「チャットモデル」選択肢に並びます。
            <span className="server-info"> ・ 保存先: config.json の <code>orchestration.workflows</code></span>
          </div>
        ) : (
        <div className="notice-bar">
          ⚠️ 設定変更は <strong>本体の再起動後</strong> に反映されます。
          {restartInfo?.isSystemd
            ? '右上の「🔄 本体を再起動」ボタンで再起動可能（systemd管理下）'
            : <span> <code>sudo systemctl restart opengeek-llm-chat</code> または再起動ボタンから可能（要systemd）</span>}
          {restartInfo && (
            <span className="server-info">
              {' '}・ PID: {restartInfo.pid} ・ 起動から {formatUptime(restartInfo.uptime)}
            </span>
          )}
        </div>
        )}

        {error && <div className="message error">⚠ {error}</div>}
        {success && (
          <div className="message success">
            ✓ {success}
            {restartDone && (
              <button className="btn" style={{ marginLeft: 12 }} onClick={() => window.location.reload()}>
                🔄 今すぐ再読み込み
              </button>
            )}
          </div>
        )}
        {parseError && view === 'text' && (
          <div className="message warning">JSON構文エラー: {parseError}</div>
        )}

        {view === 'text' ? (
          <div className="editor-container">
            <div className="line-numbers">
              {content.split('\n').map((_, i) => (
                <div key={i} className="line-number">{i + 1}</div>
              ))}
            </div>
            <textarea
              ref={textareaRef}
              className="editor-textarea"
              value={content}
              onChange={e => setContent(e.target.value)}
              onKeyDown={handleTextareaKeydown}
              spellCheck={false}
              wrap="off"
            />
          </div>
        ) : view === 'orchestra' ? (
          <OrchestraEditor
            hasUnsavedText={hasChanges}
            onSaved={async () => { await loadConfig(); await loadBackups(); }}
          />
        ) : parsedTree !== null && typeof parsedTree === 'object' ? (
          <JsonTreeEditor
            root={parsedTree}
            onChange={applyTreeChange}
            onError={setError}
          />
        ) : (
          <div className="tree-container">
            <div className="tree-broken">
              <div className="tree-broken-icon">⚠️</div>
              <div className="tree-broken-title">JSONの構文エラーのため、ツリー編集できません</div>
              {parseError && <div className="tree-broken-msg">{parseError}</div>}
              <div className="tree-broken-hint">
                テキスト表示で該当箇所を直すか、変更を破棄して読み込み直してください。
              </div>
              <div className="tree-broken-actions">
                <button className="btn" onClick={() => setView('text')}>📝 テキストで修正する</button>
                <button className="btn" onClick={discardChanges} disabled={!hasChanges}>↺ 変更を破棄</button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// ════════════════════════════════════════════════
// JSON ツリーエディタ（編集可能）
// ════════════════════════════════════════════════
// config.json を「テキストとして」直すと、括弧・カンマ・エスケープの対応を
// 人間が追う必要があり事故りやすい。ツリー編集では
//   - 値を型ごとの入力UIで編集（文字列/数値/真偽/null/オブジェクト/配列）
//   - キーの追加・リネーム・削除
//   - 配列要素の並べ替え・複製・削除
//   - 部分ツリーだけをJSONテキストで編集（複雑な箇所の逃げ道）
// を GUI で行い、結果を JSON.stringify(root, null, 2) で content に書き戻す。
//
// content（生テキスト）が唯一の正 (single source of truth) なので、
// テキスト表示・保存・未保存判定・バックアップはこれまで通り動く。

// ─── JSON の型判定 ───
function jsonType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  return (t === 'string' || t === 'number' || t === 'boolean') ? t : 'object';
}

const TYPE_OPTIONS = [
  { value: 'string', label: '文字列' },
  { value: 'number', label: '数値' },
  { value: 'boolean', label: '真偽' },
  { value: 'null', label: 'null' },
  { value: 'object', label: 'オブジェクト' },
  { value: 'array', label: '配列' },
];

/** 型を変えた時に、できるだけ値を保つように変換する */
function coerceToType(value, type) {
  switch (type) {
    case 'string':
      if (value === null || value === undefined) return '';
      return (typeof value === 'object') ? JSON.stringify(value) : String(value);
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    }
    case 'boolean':
      if (typeof value === 'string') return !(value === '' || value === 'false' || value === '0');
      return !!value;
    case 'null': return null;
    case 'object':
      return (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
    case 'array':
      if (Array.isArray(value)) return value;
      return (value === null || value === undefined || value === '') ? [] : [value];
    default: return value;
  }
}

/** 型ごとの初期値（キー追加時） */
function emptyValueOfType(type) {
  return { string: '', number: 0, boolean: false, null: null, object: {}, array: [] }[type];
}

// ─── パス操作（すべてイミュータブル） ───
// path は ['chatModels', 0, 'name'] のような配列。数値は配列インデックス。

function pathToKey(path) {
  // キーに '/' や '.' が入りうるので、JSON文字列には現れない NUL を区切りに使う
  return path.map(String).join(' ');
}

function getAtPath(root, path) {
  let cur = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

function shallowCopy(v) {
  return Array.isArray(v) ? v.slice() : { ...v };
}

function setAtPath(root, path, value) {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  const copy = shallowCopy(root);
  copy[head] = rest.length === 0 ? value : setAtPath(root[head], rest, value);
  return copy;
}

function deleteAtPath(root, path) {
  if (path.length === 0) return root;
  const parentPath = path.slice(0, -1);
  const last = path[path.length - 1];
  const parent = getAtPath(root, parentPath);
  if (parent === null || typeof parent !== 'object') return root;
  let nextParent;
  if (Array.isArray(parent)) {
    nextParent = parent.slice();
    nextParent.splice(Number(last), 1);
  } else {
    nextParent = { ...parent };
    delete nextParent[last];
  }
  return setAtPath(root, parentPath, nextParent);
}

/** キー名を変更する。オブジェクトのキー順を保つため作り直す */
function renameKeyAtPath(root, objPath, oldKey, newKey) {
  const obj = getAtPath(root, objPath);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return root;
  const next = {};
  for (const k of Object.keys(obj)) {
    if (k === oldKey) next[newKey] = obj[oldKey];
    else next[k] = obj[k];
  }
  return setAtPath(root, objPath, next);
}

/** 配列要素を from → to に動かす */
function moveArrayItem(root, arrPath, from, to) {
  const arr = getAtPath(root, arrPath);
  if (!Array.isArray(arr)) return root;
  if (to < 0 || to >= arr.length) return root;
  const next = arr.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return setAtPath(root, arrPath, next);
}

/** 配列の index の直後に値を差し込む */
function insertIntoArray(root, arrPath, index, value) {
  const arr = getAtPath(root, arrPath);
  if (!Array.isArray(arr)) return root;
  const next = arr.slice();
  next.splice(index, 0, value);
  return setAtPath(root, arrPath, next);
}

/** 深いコピー（複製ボタン用。JSONなので structuredClone 相当で十分） */
function deepCopy(v) {
  return (v === null || typeof v !== 'object') ? v : JSON.parse(JSON.stringify(v));
}

// ─── 検索マッチ判定 ───
function nodeMatches(value, label, q) {
  if (String(label ?? '').toLowerCase().includes(q)) return true;
  const t = jsonType(value);
  if (t === 'string') return value.toLowerCase().includes(q);
  if (t === 'number' || t === 'boolean') return String(value).includes(q);
  return false;
}

function subtreeMatches(value, label, q) {
  if (nodeMatches(value, label, q)) return true;
  const t = jsonType(value);
  if (t === 'object') return Object.keys(value).some(k => subtreeMatches(value[k], k, q));
  if (t === 'array') return value.some((v, i) => subtreeMatches(v, String(i), q));
  return false;
}

// ─── キーの説明（ツリー上に薄く表示して、何の設定かわかるようにする） ───
// パスは配列インデックスを [] に正規化した形で引く（例: chatModels[].name）
const CONFIG_HINTS = {
  'appName': 'ブラウザのタイトル・表示名',
  'logoMain': 'ロゴの主テキスト',
  'logoSub': 'ロゴの副テキスト',
  'welcomeMessage': '新規チャットの説明文',
  'welcomeHints': '新規チャットに並ぶ質問例',
  'accentColor': 'テーマカラー（HEX）',
  'defaultModel': '初期選択モデル名（chatModels[].name、空なら先頭）',
  'password': 'ログインパスワードのMD5/SHA-256ハッシュ（空で認証なし）',
  'pythonPath': 'Python実行コマンド（venvのパス推奨）',
  'logLevel': 'normal / quiet（quietでllama-serverのログを抑制）',
  'llamaCppDir': 'llama.cpp のディレクトリ（GGUF変換等で使用）',
  'maxRequestSize': 'JSONボディ上限（例 "100mb"）',
  'maxFileSize': 'アップロード上限（MB）',
  'maxHeaderSize': 'HTTPヘッダー上限（バイト）',
  'requestTimeoutSec': 'リクエストタイムアウト（秒）',
  'llamaServer': 'llama-server（推論エンジン）の接続設定',
  'llamaServer.binPath': 'llama-server バイナリの絶対パス',
  'llamaServer.chatHost': 'チャット推論サーバーのホスト',
  'llamaServer.chatPort': 'チャット推論サーバーのポート',
  'llamaServer.embeddingHost': 'Embeddingサーバーのホスト',
  'llamaServer.embeddingPort': 'Embeddingサーバーのポート',
  'llamaServer.commonArgs': '全モデル共通の起動引数',
  'llamaServer.readyTimeoutMs': 'モデル起動完了を待つ上限（ms）',
  'llamaServer.idleUnloadMs': '無操作時に自動アンロードするまで（ms、0で無効）',
  'llamaServer.nParallel': 'llama-server の並列スロット数 -np',
  'chatModels': 'チャットに使うGGUFモデル一覧',
  'chatModels[].name': 'UIに表示する名前',
  'chatModels[].path': 'GGUFファイルの絶対パス',
  'chatModels[].ctx': 'コンテキスト長（起動時に固定）',
  'chatModels[].ngl': 'GPUに載せるレイヤー数（99で全部）',
  'chatModels[].chatTemplate': 'チャットテンプレート（空でGGUFのメタデータ）',
  'chatModels[].extraArgs': 'このモデル専用の追加引数（--mmproj 等）',
  'embeddingModel': 'RAG用Embeddingモデル',
  'embeddingModel.path': 'Embedding用GGUFの絶対パス',
  'embeddingModel.ctx': 'Embeddingのコンテキスト長',
  'embeddingModel.poolingType': 'mean / cls / last / none',
  'webSearch': 'Web検索（DuckDuckGo）を使えるようにする',
  'fileAccess': 'サーバーファイル（uploads配下）の読み書きを許可',
  'imageGen': '画像生成（stable-diffusion.cpp連携）',
  'ttsGen': '音声合成（Irodori-TTS連携）',
  'googleDrive': 'GDrive (Google Drive) 連携',
  'googleDrive.enabled': 'GDrive連携のON/OFF',
  'googleDrive.authMode': 'oauth（個人アカウント）/ serviceAccount（ヘッドレス）',
  'googleDrive.clientId': 'OAuthクライアントID（Google Cloud Consoleで発行）',
  'googleDrive.clientSecret': 'OAuthクライアントシークレット（外部には公開されない）',
  'googleDrive.redirectUri': 'Cloud Consoleの承認済みリダイレクトURIと完全一致させる',
  'googleDrive.serviceAccountKeyFile': 'サービスアカウントJSONキーのパス',
  'googleDrive.impersonateUser': 'ドメイン全体の委任で代理するユーザー',
  'googleDrive.rootFolderId': '指定するとこのフォルダ配下だけに限定',
  'googleDrive.readOnly': 'true で読み取り専用（書き込みツールを出さない）',
  'googleDrive.allowWrite': 'readOnly:false と両方 true で書き込み許可',
  'googleDrive.allowDelete': 'ゴミ箱への移動を許可',
  'googleDrive.maxDownloadMB': '1ファイルのダウンロード上限（MB）',
  'googleDrive.maxUploadMB': '1ファイルのアップロード上限（MB）',
  'googleDrive.maxTextChars': 'LLMに渡すテキストの最大文字数',
  'googleDrive.sharedDrives': '共有ドライブも対象に含める',
  'googleDrive.tokenFile': 'リフレッシュトークンの保存先',
  'ml': '機械学習（ML）機能',
  'ml.enabled': 'ML機能のON/OFF（要 npm install duckdb）',
  'ml.apiTokens': '外部API用トークン（name / token / permissions）',
  'ocr': 'PDF OCR（Vision LLMでMarkdown化 → RAG自動登録）',
  'ocr.enabled': 'OCR機能のON/OFF（要 poppler-utils）',
  'ocr.vlmPoolModel': 'chatModels の名前を入れるとLLMプール管理になり、OCR中だけロード→終われば自動アンロード。空なら vlmEndpoint を使う',
  'ocr.vlmEndpoint': 'Vision LLM のOpenAI互換エンドポイント（Qwen2.5-VL等）。vlmPoolModel 設定時は無視',
  'ocr.vlmModel': 'リクエストの model フィールド（vlmEndpoint 使用時のみ）',
  'ocr.dpi': 'ページ画像化の解像度（300推奨、上げると精度↑・速度↓）',
  'ocr.maxTokens': '1ページあたりの生成上限',
  'ocr.temperature': 'OCRの生成ランダム性（低いほど忠実）',
  'ocr.pageTimeoutSec': '1ページのOCRタイムアウト（秒）',
  'ocr.pageRetries': '失敗時のリトライ回数（使い切ったらそのページはスキップ）',
  'ocr.maxConcurrentJobs': '同時実行ジョブ数（単一GPUなら1）',
  'ocr.maxUploadMB': 'PDF1ファイルのアップロード上限（MB）',
  'ocr.cacheDir': 'ページ単位のMarkdownキャッシュ先（中断ジョブの再開に使う）',
  'ocr.jobsFile': 'ジョブ状態の永続化先（再起動しても残る）',
  'ocr.pdfToImageCmd': 'PDF→PNG変換コマンド（poppler-utils の pdftoppm）。Windowsでフルパス指定なら "C:/poppler/Library/bin/pdftoppm.exe"',
  'ocr.pdfInfoCmd': 'ページ数取得コマンド（poppler-utils の pdfinfo）。Windowsでフルパス指定なら "C:/poppler/Library/bin/pdfinfo.exe"',
  'ocr.autoRegisterToRag': '完了後に自動でRAG登録するか',
  'ocr.keepPdf': '完了後もアップロードしたPDFを uploads に残すか',
  'ocr.prompt': 'Vision LLM に渡すOCR指示プロンプト',
  'inlineFileMaxChars': 'この文字数以下のテキストファイルはRAG登録せず、メッセージ本文へ全文を直接添付する（数KBのconfig・ソースコード向け。0で常にRAG登録）',
  'inlineFileTotalMaxChars': '1メッセージに直接添付できる合計文字数。超えたファイルはRAG登録に回る',
  'ragTopK': 'RAGで取得するチャンク数',
  'ragMode': 'agentic（LLMが検索要否を判断）/ always',
  'ragChunkSize': '1チャンクの文字数。embeddingModel.ctx（BERT系は512トークン上限）を超えないこと。日本語は約1文字=1トークン',
  'ragChunkOverlap': 'チャンク間の重なり文字数。変更したらドキュメントの再登録が必要',
  'ragNeighborChunks': 'ヒットの前後何チャンクを一緒にLLMへ渡すか。数式と記号定義が分断されるのを防ぐ（0で無効）',
  'ragRelaxSamplers': '検索結果を渡して回答させる時、繰り返しペナルティ(DRY等)を外す。原文どおりに引用させるのに書き写しを罰しては噛み合わないため。既定 true',
  'relaxSamplersAlways': 'ユーザーに見せる最終応答では常に繰り返しペナルティ(DRY等)を外す（既定 true）。同じコマンドを2回書くと後半が1文字ずつ欠ける症状の対策。falseで検索結果があるターンだけ緩和',
  'systemMessageCompat': '会話途中の system メッセージを直後の user へ連結してから送信（既定 true）。GPT-OSS等の「system は先頭のみ」テンプレートで 400 になるのを防ぐ',
  'ragAlwaysSearch': '毎ターン必ず永続RAGを検索する。判断モデルが web_search を選んでしまう・検索を省いてしまう場合に true にする。雑談では検索1回ぶん遅くなる',
  'ragLedgerTurns': '直近いくつの回答ぶんの出典（資料名・ページ・抜粋）を次のターンへ持ち越すか。0で無効にすると、出典を問われた時にモデルが中身を作文しやすくなる',
  'ragLedgerChars': '持ち越す1出典あたりの抜粋文字数。0ならページ対応表だけ持ち越す。増やすほど正確になるがコンテキストを消費する',
  'systemPrompts': 'LLMに渡すシステムプロンプト群',
  'systemPrompts.base': '全フェーズ共通の土台（{date} が展開される）',
  'systemPrompts.documents': 'ドキュメント添付時の追記（{docList}）',
  'systemPrompts.webSearch': 'Web検索が有効な時の追記',
  'systemPrompts.fileAccess': 'サーバーファイル操作が有効な時の追記',
  'systemPrompts.googleDrive': 'Google Drive が有効かつ接続済みの時の追記',
  'systemPrompts.rag': '永続RAGが使える時の追記。原文の数式・記号をそのまま引用させ、出典ページを添えさせる',
  'systemPrompts.python': 'Python実行の案内',
  'systemPrompts.meta': 'メタ的な独り言を抑制する指示',
  'systemPrompts.judge': 'ツール判断専用の軽量プロンプト（{toolList}）',
  'agentContext': 'ツール判断フェーズの生成量チューニング',
  'agentContext.smallPredict': '通常質問時の max_tokens',
  'agentContext.largePredict': 'ファイル生成など長文時の max_tokens',
  'agentContext.judgeHistoryCount': 'ツール判断に渡す直近メッセージ数',
  'agentContext.judgeHistoryChars': 'ツール判断に渡す過去メッセージ1件あたりの最大文字数',
  'agentContext.judgeLastMessageChars': 'ツール判断に渡す最新メッセージの最大文字数。インライン添付で肥大した時だけ効く（質問文は添付より前にあるので切れない）',
  'agentContext.fastToolRouting': 'キーワードで明白なケースは判断LLMを省略して即決する（雑談・コード作成が速くなる）。誤スキップが気になるなら false',
  'agentContext.largeGenKeywords': '長文モードに切り替えるキーワード（nullで既定）',
  'recentMessageCount': 'そのまま送る直近メッセージ数（それ以前は圧縮）',
  'topK': 'サンプリング top-k',
  'topP': 'サンプリング top-p',
  'temperature': '生成のランダム性（低いほど堅い）',
  'repeatPenalty': '繰り返しペナルティ（1.0で無効）',
  'repeatLastN': 'ペナルティを見る直近トークン数',
  'presencePenalty': 'OpenAI互換 presence_penalty',
  'frequencyPenalty': 'OpenAI互換 frequency_penalty',
  'dryMultiplier': 'DRYサンプラー強度（0で無効、ループ対策に有効）',
  'dryBase': 'DRYサンプラーの基数',
  'dryAllowedLength': 'DRYが許容する繰り返し長',
  'dryPenaltyLastN': 'DRYの対象範囲（-1で全体）',
  'chatMaxTokens': '1応答あたりの最大生成トークン',
  'orchestration': 'マルチLLMオーケストレーション（🎼タブで編集推奨）',
  'orchestration.enabled': 'マルチLLM機能のON/OFF',
  'orchestration.poolMode': 'auto / resident（全常駐）/ swap（逐次載せ替え）',
  'orchestration.gpuPlacement': 'spread（全GPUに分散、既定）/ auto（丸ごと載るGPUが1枚あればそこに固定）。GPU2枚以上で有効',
  'orchestration.maxResident': '同時常駐させるワーカー数の上限',
  'orchestration.workflows': 'ワークフロー定義（🎼 マルチLLM タブで編集）',
  'stableDiffusion': '画像生成サーバー（sd-server）の設定',
  'imageModels': '画像生成モデル一覧',
  'irodoriTts': '音声合成サーバー（Irodori-TTS）の設定',
  'ttsVoices': '声のプリセット一覧',
  'transcribe': '音声認識サーバーの設定',
  'tuning': 'ファインチューニングの実行環境設定',
};

function hintForPath(path) {
  if (path.length === 0) return '';
  const norm = path
    .map(seg => (typeof seg === 'number' ? '[]' : seg))
    .reduce((acc, seg) => (seg === '[]' ? acc + '[]' : (acc ? acc + '.' + seg : seg)), '');
  return CONFIG_HINTS[norm] || '';
}

// ════════════════════════════════════════════════
// ツリーエディタ本体
// ════════════════════════════════════════════════
function JsonTreeEditor({ root, onChange, onError }) {
  const [query, setQuery] = useState('');
  // pathKey -> true/false の明示指定。無ければ defaultOpen / 深さで決める
  const [openOverride, setOpenOverride] = useState({});
  // null = 深さ基準（浅い階層だけ開く）、true/false = 全展開/全折りたたみ
  const [defaultOpen, setDefaultOpen] = useState(null);

  const q = query.trim().toLowerCase();

  const isOpen = useCallback((pathKey, depth) => {
    if (q) return true;                                   // 検索中は絞り込み結果を全部見せる
    if (pathKey in openOverride) return openOverride[pathKey];
    if (defaultOpen !== null) return defaultOpen;
    return depth < 1;                                     // 既定はトップレベルの一覧まで
  }, [openOverride, defaultOpen, q]);

  const toggle = useCallback((pathKey, depth) => {
    setOpenOverride(prev => {
      const cur = (pathKey in prev) ? prev[pathKey]
        : (defaultOpen !== null ? defaultOpen : depth < 1);
      return { ...prev, [pathKey]: !cur };
    });
  }, [defaultOpen]);

  // ─── 編集操作（すべて新しい root を作って onChange に渡す） ───
  const ctx = useMemo(() => ({
    q,
    isOpen,
    toggle,
    update: (path, value) => onChange(setAtPath(root, path, value)),
    remove: (path, label) => {
      if (!confirm(`「${label}」を削除しますか？`)) return;
      onChange(deleteAtPath(root, path));
    },
    rename: (objPath, oldKey, newKey) => {
      if (!newKey || newKey === oldKey) return;
      const obj = getAtPath(root, objPath);
      if (obj && Object.prototype.hasOwnProperty.call(obj, newKey)) {
        onError(`キー「${newKey}」は既に存在します`);
        return;
      }
      onChange(renameKeyAtPath(root, objPath, oldKey, newKey));
    },
    addKey: (objPath, key, type) => {
      const obj = getAtPath(root, objPath);
      if (!key) { onError('キー名を入力してください'); return false; }
      if (obj && Object.prototype.hasOwnProperty.call(obj, key)) {
        onError(`キー「${key}」は既に存在します`);
        return false;
      }
      onChange(setAtPath(root, [...objPath, key], emptyValueOfType(type)));
      return true;
    },
    addItem: (arrPath, type) => {
      const arr = getAtPath(root, arrPath) || [];
      onChange(insertIntoArray(root, arrPath, arr.length, emptyValueOfType(type)));
    },
    duplicateItem: (arrPath, index) => {
      const arr = getAtPath(root, arrPath);
      if (!Array.isArray(arr)) return;
      onChange(insertIntoArray(root, arrPath, index + 1, deepCopy(arr[index])));
    },
    moveItem: (arrPath, from, to) => onChange(moveArrayItem(root, arrPath, from, to)),
    changeType: (path, value, type) => {
      const cur = jsonType(value);
      if (cur === type) return;
      const isFilledContainer = (cur === 'object' && Object.keys(value).length > 0)
        || (cur === 'array' && value.length > 0);
      if (isFilledContainer && type !== 'object' && type !== 'array') {
        if (!confirm('中身のある構造を単純な値に変換します。元の内容は失われます。続行しますか？')) return;
      }
      onChange(setAtPath(root, path, coerceToType(value, type)));
    },
  }), [root, onChange, onError, q, isOpen, toggle]);

  const rootType = jsonType(root);
  const rootKeys = rootType === 'object' ? Object.keys(root) : [];

  return (
    <div className="tree-editor">
      <div className="tree-toolbar">
        <div className="tree-search-wrap">
          <span className="tree-search-icon">🔍</span>
          <input
            className="tree-search"
            placeholder="キー名・値で絞り込み（例: googleDrive, ポート, 8080）"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {query && <button className="tree-search-clear" onClick={() => setQuery('')} title="クリア">✕</button>}
        </div>
        <button className="tree-tool-btn" onClick={() => { setOpenOverride({}); setDefaultOpen(true); }}>⊞ 全展開</button>
        <button className="tree-tool-btn" onClick={() => { setOpenOverride({}); setDefaultOpen(false); }}>⊟ 全折りたたみ</button>
        <button className="tree-tool-btn" onClick={() => { setOpenOverride({}); setDefaultOpen(null); }}>↺ 表示リセット</button>
      </div>
      <div className="tree-usage-hint">
        {rootKeys.length} 個のトップレベル設定 ・
        値はクリックして編集（確定は Enter / フォーカスを外す、取り消しは Esc）・
        キー名クリックで改名 ・ <code>{'{ }'}</code> でそのまとまりをJSONのまま編集 ・
        編集内容は「💾 保存」を押すまで config.json には書き込まれません
      </div>

      <div className="tree-container">
        <TreeNode
          ctx={ctx}
          path={[]}
          label="config.json"
          value={root}
          depth={0}
          parentType={null}
        />
        {q && rootType === 'object' && !rootKeys.some(k => subtreeMatches(root[k], k, q)) && (
          <div className="empty-hint">「{query}」に一致する設定はありません</div>
        )}
      </div>
    </div>
  );
}

// ─── ツリーの1ノード ───
// ancestorMatched: 祖先のキー/値が検索語に一致している。この場合は配下を丸ごと見せる
// （「googleDrive」で検索したら googleDrive の中身は全部見たい、という当たり前の期待に合わせる）
function TreeNode({ ctx, path, label, value, depth, parentType, index, siblingCount, ancestorMatched }) {
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [addKey, setAddKey] = useState('');
  const [addType, setAddType] = useState('string');
  const [jsonEditing, setJsonEditing] = useState(false);
  const [jsonDraft, setJsonDraft] = useState('');
  const [jsonErr, setJsonErr] = useState('');

  const q = ctx.q;
  const type = jsonType(value);
  const isContainer = type === 'object' || type === 'array';
  const pathKey = pathToKey(path);
  const isRoot = path.length === 0;

  // 検索中の表示判定
  //   selfMatch      … このノード自身（キー名 or 単純値）が一致
  //   visible        … 自分・祖先・子孫のいずれかが一致していれば描画する
  const selfMatch = useMemo(() => !!q && nodeMatches(value, label, q), [q, value, label]);
  const visible = useMemo(
    () => !q || isRoot || ancestorMatched || selfMatch || subtreeMatches(value, label, q),
    [q, isRoot, ancestorMatched, selfMatch, value, label]
  );
  // 子に伝える「祖先が一致しているか」。自分の子孫が一致しただけの場合は伝えない
  // （その場合は一致した枝だけを見せたいため）
  const childAncestorMatched = !!q && (ancestorMatched || selfMatch);
  if (!visible) return null;

  const open = isContainer ? ctx.isOpen(pathKey, depth) : true;
  const hint = hintForPath(path);
  const inArray = parentType === 'array';
  // インデント幅は CSS 変数にしておき、モバイルでは詰める
  const indent = { paddingLeft: `calc(var(--tree-indent, 15px) * ${depth})` };

  const keys = type === 'object' ? Object.keys(value) : [];
  const childEntries = type === 'object'
    ? keys.map(k => ({ key: k, label: k, value: value[k] }))
    : type === 'array'
      ? value.map((v, i) => ({ key: i, label: `[${i}]`, value: v }))
      : [];

  function startRename() {
    setRenameDraft(String(label));
    setRenaming(true);
  }
  function commitRename() {
    setRenaming(false);
    const next = renameDraft.trim();
    if (next && next !== label) ctx.rename(path.slice(0, -1), label, next);
  }

  function openJsonEdit() {
    setJsonDraft(JSON.stringify(value, null, 2));
    setJsonErr('');
    setJsonEditing(true);
  }
  function applyJsonEdit() {
    try {
      const parsed = JSON.parse(jsonDraft);
      ctx.update(path, parsed);
      setJsonEditing(false);
      setJsonErr('');
    } catch (e) {
      setJsonErr(e.message);
    }
  }

  // ─── 行の共通パーツ ───
  const keyLabel = label === null ? null : (
    renaming ? (
      <input
        className="tree-rename-input"
        value={renameDraft}
        autoFocus
        onChange={e => setRenameDraft(e.target.value)}
        onBlur={commitRename}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
          if (e.key === 'Escape') { setRenaming(false); }
        }}
      />
    ) : (
      <span
        className={`tree-key ${(inArray || isRoot) ? 'idx' : 'renamable'}`}
        onClick={() => { if (!inArray && !isRoot) startRename(); }}
        title={(inArray || isRoot) ? '' : 'クリックでキー名を変更'}
      >{label}</span>
    )
  );

  const actions = (
    <span className="tree-actions">
      {!isRoot && (
        <select
          className="tree-type-select"
          value={type}
          onChange={e => ctx.changeType(path, value, e.target.value)}
          title="値の型を変更"
        >
          {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
      {isContainer && (
        <button className="tree-act" title="このまとまりをJSONテキストで直接編集" onClick={openJsonEdit}>{'{ }'}</button>
      )}
      {inArray && (
        <>
          <button className="tree-act" title="上へ" disabled={index === 0}
            onClick={() => ctx.moveItem(path.slice(0, -1), index, index - 1)}>↑</button>
          <button className="tree-act" title="下へ" disabled={index === siblingCount - 1}
            onClick={() => ctx.moveItem(path.slice(0, -1), index, index + 1)}>↓</button>
          <button className="tree-act" title="複製"
            onClick={() => ctx.duplicateItem(path.slice(0, -1), index)}>⧉</button>
        </>
      )}
      {!isRoot && (
        <button className="tree-act danger" title="削除"
          onClick={() => ctx.remove(path, inArray ? `${path[path.length - 2] ?? ''}${label}` : label)}>✕</button>
      )}
    </span>
  );

  // ─── コンテナ（オブジェクト / 配列） ───
  if (isContainer) {
    const doAdd = () => {
      if (type === 'object') {
        if (ctx.addKey(path, addKey.trim(), addType)) { setAdding(false); setAddKey(''); }
      } else {
        ctx.addItem(path, addType);
        setAdding(false);
      }
    };
    const summary = type === 'array'
      ? `[ ${value.length} 個 ]`
      : `{ ${keys.length} キー }`;
    return (
      <div className={`tree-node ${isRoot ? 'root' : ''}`}>
        <div className="tree-row container" style={indent}>
          <span className="tree-toggle" onClick={() => ctx.toggle(pathKey, depth)}>
            {open ? '▼' : '▶'}
          </span>
          {keyLabel}
          {label !== null && <span className="tree-colon">:</span>}
          <span className="tree-bracket" onClick={() => ctx.toggle(pathKey, depth)}>{summary}</span>
          {hint && <span className="tree-hint">{hint}</span>}
          {actions}
        </div>

        {jsonEditing && (
          <div className="tree-json-edit" style={{ marginLeft: `calc(var(--tree-indent, 15px) * ${depth + 1})` }}>
            <textarea
              className="tree-json-area"
              value={jsonDraft}
              onChange={e => setJsonDraft(e.target.value)}
              spellCheck={false}
              rows={Math.min(24, Math.max(4, jsonDraft.split('\n').length + 1))}
            />
            {jsonErr && <div className="tree-json-err">構文エラー: {jsonErr}</div>}
            <div className="tree-json-actions">
              <button className="tree-tool-btn primary" onClick={applyJsonEdit}>適用</button>
              <button className="tree-tool-btn" onClick={() => setJsonEditing(false)}>キャンセル</button>
            </div>
          </div>
        )}

        {open && (
          <>
            {childEntries.map(ent => (
              <TreeNode
                key={String(ent.key)}
                ctx={ctx}
                path={[...path, ent.key]}
                label={ent.label}
                value={ent.value}
                depth={depth + 1}
                parentType={type}
                index={type === 'array' ? ent.key : undefined}
                siblingCount={type === 'array' ? value.length : undefined}
                ancestorMatched={childAncestorMatched}
              />
            ))}

            {/* 追加フォーム。検索で一部だけ表示している場所では隠す
                （絞り込み中に「どこへ追加されるのか」が分かりにくいため）*/}
            {(!q || ancestorMatched) && (
              adding ? (
                <div className="tree-add-form" style={{ paddingLeft: `calc(var(--tree-indent, 15px) * ${depth + 1})` }}>
                  {type === 'object' && (
                    <input
                      className="tree-add-key"
                      placeholder="キー名"
                      value={addKey}
                      autoFocus
                      onChange={e => setAddKey(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') doAdd(); if (e.key === 'Escape') setAdding(false); }}
                    />
                  )}
                  <select className="tree-type-select" value={addType} onChange={e => setAddType(e.target.value)}>
                    {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <button className="tree-tool-btn primary" onClick={doAdd}>追加</button>
                  <button className="tree-tool-btn" onClick={() => { setAdding(false); setAddKey(''); }}>キャンセル</button>
                </div>
              ) : (
                <div className="tree-add-row" style={{ paddingLeft: `calc(var(--tree-indent, 15px) * ${depth + 1})` }}>
                  <button className="tree-add-btn" onClick={() => { setAdding(true); setAddKey(''); }}>
                    ＋ {type === 'array' ? '要素を追加' : 'キーを追加'}
                  </button>
                  {type === 'array' && value.length > 0 && (
                    <button className="tree-add-btn" title="末尾の要素をコピーして追加"
                      onClick={() => ctx.duplicateItem(path, value.length - 1)}>
                      ⧉ 末尾を複製
                    </button>
                  )}
                </div>
              )
            )}
          </>
        )}
      </div>
    );
  }

  // ─── リーフ（文字列 / 数値 / 真偽 / null） ───
  return (
    <div className="tree-node">
      <div className="tree-row leaf" style={indent}>
        <span className="tree-toggle" />
        {keyLabel}
        {label !== null && <span className="tree-colon">:</span>}
        <LeafEditor
          value={value}
          type={type}
          onCommit={v => ctx.update(path, v)}
        />
        {hint && <span className="tree-hint">{hint}</span>}
        {actions}
      </div>
    </div>
  );
}

// ─── リーフ値の入力UI ───
// 入力中は draft(ローカル state) を編集し、blur / Enter で確定する。
// 1打鍵ごとに全体を再シリアライズすると重いうえ、再描画でカーソルが飛ぶため。
function LeafEditor({ value, type, onCommit }) {
  const toText = (v) => (v === null || v === undefined) ? '' : String(v);
  const [draft, setDraft] = useState(() => toText(value));
  const [invalid, setInvalid] = useState(false);

  // 外部から値が変わったら（読み込み・破棄・復元・型変更）追従する
  useEffect(() => { setDraft(toText(value)); setInvalid(false); }, [value, type]);

  if (type === 'boolean') {
    return (
      <button
        className={`tree-bool-toggle ${value ? 'on' : 'off'}`}
        onClick={() => onCommit(!value)}
        title="クリックで切り替え"
      >{String(value)}</button>
    );
  }

  if (type === 'null') {
    return <span className="tree-null" title="型を変更すると値を入力できます">null</span>;
  }

  function commit() {
    if (type === 'number') {
      const t = draft.trim();
      const n = Number(t);
      if (t === '' || !Number.isFinite(n)) { setInvalid(true); return; }
      setInvalid(false);
      if (n !== value) onCommit(n);
      return;
    }
    if (draft !== value) onCommit(draft);
  }

  const commonProps = {
    value: draft,
    onChange: e => { setDraft(e.target.value); if (invalid) setInvalid(false); },
    onBlur: commit,
    spellCheck: false,
  };

  if (type === 'number') {
    return (
      <input
        {...commonProps}
        className={`tree-input num ${invalid ? 'invalid' : ''}`}
        inputMode="decimal"
        title={invalid ? '数値として解釈できません' : ''}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
          if (e.key === 'Escape') { setDraft(toText(value)); setInvalid(false); }
        }}
      />
    );
  }

  // 文字列: 改行を含むか、かなり長い場合は textarea（systemPrompts など）。
  // モデルのフルパス程度（〜100文字）は1行入力のままの方が見やすいので閾値は高めにする。
  const multiline = typeof value === 'string' && (value.includes('\n') || value.length > 100);
  if (multiline) {
    return (
      <textarea
        {...commonProps}
        className="tree-input str multiline"
        rows={Math.min(14, Math.max(2, draft.split('\n').length))}
        onKeyDown={e => { if (e.key === 'Escape') setDraft(toText(value)); }}
      />
    );
  }
  return (
    <input
      {...commonProps}
      className="tree-input str"
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
        if (e.key === 'Escape') { setDraft(toText(value)); }
      }}
    />
  );
}

// ─── ログイン ───
function LoginView({ onSuccess }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function handleLogin() {
    setBusy(true); setError('');
    try {
      const r = await fetch('/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!r.ok) throw new Error('パスワードが違います');
      onSuccess();
    } catch (e) {
      setError(e.message);
    } finally { setBusy(false); }
  }
  return (
    <div className="login-container">
      <div className="login-box">
        <div className="login-title">🔐 認証</div>
        <div className="field">
          <input className="input" type="password" placeholder="パスワード"
            value={password} onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleLogin()} autoFocus />
        </div>
        {error && <div style={{ color: 'var(--red)', fontSize: 12, marginBottom: 12 }}>{error}</div>}
        <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }}
          onClick={handleLogin} disabled={busy || !password}>
          {busy ? '認証中...' : 'ログイン'}
        </button>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
