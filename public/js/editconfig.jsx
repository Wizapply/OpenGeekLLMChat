const { useState, useEffect, useRef, useCallback } = React;

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
                        <tr key={m.name}>
                          <td>{m.name}</td>
                          <td className="num">ctx {Math.round(m.ctx / 1024)}k</td>
                          <td className="num">重み {(m.weightsMB / 1024).toFixed(1)}</td>
                          <td className="num">KV {(m.kvMB / 1024).toFixed(1)}</td>
                          <td className="num total">計 {(m.totalMB / 1024).toFixed(1)}GB</td>
                        </tr>
                      ))}
                      <tr className="sum">
                        <td colSpan={4}>
                          合計 {(plan.requiredMB / 1024).toFixed(1)}GB ＋ 余裕 {(plan.marginMB / 1024).toFixed(1)}GB
                          {' '}／ 空きVRAM {(plan.freeMB / 1024).toFixed(1)}GB
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
  const [view, setView] = useState('text'); // 'text' | 'tree' | 'orchestra'
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
  useEffect(() => {
    if (!content) { setParseError(''); setParsedTree(null); return; }
    try {
      const parsed = JSON.parse(content);
      setParseError('');
      setParsedTree(parsed);
    } catch (e) {
      setParseError(e.message);
      // パースエラー時は古いparsedTreeを残す
    }
  }, [content]);

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
      const r = await fetch('/restart', { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || '再起動失敗');
      setSuccess('再起動中... サーバーが復帰するまでお待ちください');
      // 再起動完了をポーリングで待つ
      pollUntilBack();
    } catch (e) {
      setError(`再起動失敗: ${e.message}`);
      setRestarting(false);
    }
  }

  async function pollUntilBack() {
    const startTime = Date.now();
    const maxWaitMs = 60000;  // 1分でタイムアウト
    let consecutiveOk = 0;
    // 最初の2秒は何もしない（プロセス終了を待つ）
    await new Promise(r => setTimeout(r, 2000));
    while (Date.now() - startTime < maxWaitMs) {
      try {
        const r = await fetch('/restart/info', { cache: 'no-cache' });
        if (r.ok) {
          const data = await r.json();
          // 新プロセスのアップタイムが短い = 確実に再起動した
          if (data.uptime != null && data.uptime < 30) {
            consecutiveOk++;
            if (consecutiveOk >= 2) {
              setSuccess(`✓ 再起動完了（PID: ${data.pid}）。最新の状態に更新するため3秒後にページを再読み込みします…`);
              setRestartInfo(data);
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
              <button className={`view-btn ${view === 'text' ? 'active' : ''}`} onClick={() => setView('text')}>📝 テキスト</button>
              <button className={`view-btn ${view === 'tree' ? 'active' : ''}`} onClick={() => setView('tree')}>🌳 ツリー</button>
              <button className={`view-btn ${view === 'orchestra' ? 'active' : ''}`} onClick={() => setView('orchestra')}>🎼 マルチLLM</button>
            </div>
            <button className="btn" onClick={formatJson} disabled={!!parseError} title="JSONを整形">✨ 整形</button>
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
        ) : (
          <div className="tree-container">
            {parsedTree ? <TreeView value={parsedTree} /> : <div className="empty-hint">構文エラーのためツリー表示できません</div>}
          </div>
        )}
      </main>
    </div>
  );
}

// ─── ツリービュー（読み取り専用、構造を確認しやすく） ───
function TreeView({ value, level = 0, label }) {
  const [collapsed, setCollapsed] = useState(level > 1);

  if (value === null) return <div className="tree-row" style={{ paddingLeft: level * 16 }}>{label && <span className="tree-key">{label}: </span>}<span className="tree-null">null</span></div>;
  if (typeof value === 'boolean') return <div className="tree-row" style={{ paddingLeft: level * 16 }}>{label && <span className="tree-key">{label}: </span>}<span className="tree-bool">{String(value)}</span></div>;
  if (typeof value === 'number') return <div className="tree-row" style={{ paddingLeft: level * 16 }}>{label && <span className="tree-key">{label}: </span>}<span className="tree-num">{value}</span></div>;
  if (typeof value === 'string') {
    const truncated = value.length > 200 ? value.slice(0, 200) + '…' : value;
    return <div className="tree-row" style={{ paddingLeft: level * 16 }}>{label && <span className="tree-key">{label}: </span>}<span className="tree-str">"{truncated}"</span></div>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <div className="tree-row" style={{ paddingLeft: level * 16 }}>{label && <span className="tree-key">{label}: </span>}<span className="tree-bracket">[]</span></div>;
    return (
      <div>
        <div className="tree-row" style={{ paddingLeft: level * 16, cursor: 'pointer' }} onClick={() => setCollapsed(!collapsed)}>
          <span className="tree-toggle">{collapsed ? '▶' : '▼'}</span>
          {label && <span className="tree-key">{label}: </span>}
          <span className="tree-bracket">[{value.length} 個]</span>
        </div>
        {!collapsed && value.map((v, i) => (
          <TreeView key={i} value={v} level={level + 1} label={`[${i}]`} />
        ))}
      </div>
    );
  }
  // object
  const keys = Object.keys(value);
  if (keys.length === 0) return <div className="tree-row" style={{ paddingLeft: level * 16 }}>{label && <span className="tree-key">{label}: </span>}<span className="tree-bracket">{'{}'}</span></div>;
  return (
    <div>
      <div className="tree-row" style={{ paddingLeft: level * 16, cursor: 'pointer' }} onClick={() => setCollapsed(!collapsed)}>
        <span className="tree-toggle">{collapsed ? '▶' : '▼'}</span>
        {label && <span className="tree-key">{label}: </span>}
        <span className="tree-bracket">{'{' + keys.length + ' キー}'}</span>
      </div>
      {!collapsed && keys.map(k => (
        <TreeView key={k} value={value[k]} level={level + 1} label={k} />
      ))}
    </div>
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
