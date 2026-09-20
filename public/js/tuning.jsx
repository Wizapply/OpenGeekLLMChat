const { useState, useEffect, useRef } = React;

function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [tab, setTab] = useState('samples');
  const [samples, setSamples] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [currentJobId, setCurrentJobId] = useState(null);
  // 実行中の後処理 (マージ→GGUF→量子化) { jobId, step }
  const [postprocess, setPostprocess] = useState(null);
  const [toast, setToast] = useState(null);
  // サイドバー開閉（モバイル/狭画面でドロワー表示用）
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await (await fetch('/config')).json();
        if (cfg.hasPassword) {
          setAuthRequired(true);
          if (cfg.authenticated) setAuthenticated(true);
        } else {
          setAuthenticated(true);
        }
      } catch {}
    })();
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    loadSamples();
    loadJobs();
    const t = setInterval(() => { loadJobs(); }, 5000);
    return () => clearInterval(t);
  }, [authenticated]);

  function showToast(msg, type = 'info') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  async function loadSamples() {
    try {
      const r = await fetch('/tuning/samples');
      if (r.ok) {
        const data = await r.json();
        setSamples(data.samples || []);
      }
    } catch {}
  }

  async function loadJobs() {
    try {
      const r = await fetch('/tuning/jobs');
      if (r.ok) {
        const data = await r.json();
        setJobs(data.jobs || []);
        setCurrentJobId(data.current);
        setPostprocess(data.postprocess || null);
      }
    } catch {}
  }

  if (authRequired && !authenticated) {
    return <LoginView onSuccess={() => setAuthenticated(true)} />;
  }
  if (!authenticated) {
    return <div className="login-container"><div className="login-box">読み込み中...</div></div>;
  }

  return (
    <div className="app-layout">
      {/* サイドバー オーバーレイ (モバイル時、サイドバー開いている時にバックドロップとして表示) */}
      <div className={`sidebar-overlay ${sidebarOpen ? 'open' : ''}`} onClick={() => setSidebarOpen(false)} />

      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <button className="sidebar-close-btn" onClick={() => setSidebarOpen(false)} title="サイドバーを閉じる">×</button>
        <div className="sidebar-header">
          <div className="logo">
            <div className="logo-icon" />
            <div className="logo-text">
              <div className="logo-main">OpenGeekLLM</div>
              <div className="logo-sub">ファインチューニング</div>
            </div>
          </div>
        </div>
        <div className="nav-links">
          <a className="nav-link" href="/">💬 チャット</a>
          <a className="nav-link" href="/ml.html">🤖 機械学習</a>
          <a className="nav-link" href="/rag.html">📚 永続RAG(OCR、HTML登録)</a>
        </div>
        <div className="sidebar-section">
          <div className="section-title">統計</div>
          <div className="stats-card">
            <div className="stats-card-label">学習サンプル</div>
            <div className="stats-card-value accent">{samples.length}</div>
          </div>
          <div className="stats-card">
            <div className="stats-card-label">ジョブ履歴</div>
            <div className="stats-card-value">{jobs.length}</div>
          </div>
          {(currentJobId || postprocess) && (
            <div className="stats-card">
              <div className="stats-card-label">実行中</div>
              <div className="stats-card-value orange">
                {currentJobId ? '⚙️ 学習中' : '📦 マージ中'}
              </div>
            </div>
          )}
        </div>
        <a className="sidebar-settings-btn" href="/editconfig.html" title="config.json 編集">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
          <span>設定</span>
        </a>
      </aside>

      <main className="main">
        <header className="main-header">
          <button className="menu-btn" onClick={() => setSidebarOpen(!sidebarOpen)} title="メニュー">☰</button>
          <div className="main-title">🧠 ファインチューニング</div>
        </header>
        <div className="tab-bar">
          <button className={`tab ${tab === 'samples' ? 'active' : ''}`} onClick={() => setTab('samples')}>
            📚 学習データ
            {samples.length > 0 && <span className="tab-badge">{samples.length}</span>}
          </button>
          <button className={`tab ${tab === 'raggen' ? 'active' : ''}`} onClick={() => setTab('raggen')}>
            🧬 RAGから生成
          </button>
          <button className={`tab ${tab === 'training' ? 'active' : ''}`} onClick={() => setTab('training')}>
            🚀 学習開始
          </button>
          <button className={`tab ${tab === 'jobs' ? 'active' : ''}`} onClick={() => setTab('jobs')}>
            📊 ジョブ
            {jobs.length > 0 && <span className="tab-badge">{jobs.length}</span>}
          </button>
        </div>
        <div className="main-body">
          {/*
            各タブは常にマウントしておき CSS の display で切替する。
            こうすることでタブを切り替えても入力中の値・スクロール位置などのコンポーネント状態が保持される。
            （条件分岐レンダリングだと React がコンポーネントを unmount するため state が消える）
          */}
          <div style={{ display: tab === 'samples' ? 'block' : 'none' }}>
            <SamplesView samples={samples} reload={loadSamples} showToast={showToast} />
          </div>
          <div style={{ display: tab === 'raggen' ? 'block' : 'none' }}>
            <RagGenView showToast={showToast} reloadSamples={loadSamples} />
          </div>
          <div style={{ display: tab === 'training' ? 'block' : 'none' }}>
            <TrainingView samples={samples} currentJobId={currentJobId}
              onStarted={(jid) => { setTab('jobs'); loadJobs(); showToast(`学習ジョブ開始: ${jid}`, 'success'); }}
              showToast={showToast} />
          </div>
          <div style={{ display: tab === 'jobs' ? 'block' : 'none' }}>
            <JobsView jobs={jobs} currentJobId={currentJobId} postprocess={postprocess}
              reload={loadJobs} showToast={showToast} />
          </div>
        </div>
      </main>

      {toast && <div className={`toast ${toast.type}`}>{toast.msg}</div>}
    </div>
  );
}

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

function SamplesView({ samples, reload, showToast }) {
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editing, setEditing] = useState(null);

  async function handleDelete(id) {
    if (!confirm('このサンプルを削除しますか?')) return;
    const r = await fetch(`/tuning/samples/${id}`, { method: 'DELETE' });
    if (r.ok) { reload(); showToast('削除しました', 'success'); }
  }

  async function handleDeleteAll() {
    if (!confirm(`全 ${samples.length} 件のサンプルを削除しますか?この操作は取り消せません。`)) return;
    const r = await fetch('/tuning/samples', { method: 'DELETE' });
    if (r.ok) { reload(); showToast('全削除しました', 'success'); }
  }

  function handleExport() {
    window.location.href = '/tuning/samples/export';
  }

  return (
    <div>
      <div className="info-box">
        💡 <strong>学習データの設計鉄則</strong>: ① 同じ事実を多様な聞き方で繰り返す ② 重要事項は分散して何度も登場 ③ 範囲外の質問への適切な拒否例も含める ④ 文体を統一 ⑤ <strong>量より質</strong>（500件の高品質 &gt; 5000件のノイズ）
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <button className="btn primary" onClick={() => setShowAdd(true)}>＋ 追加</button>
        <button className="btn" onClick={() => setShowImport(true)}>📥 CSV/JSONL インポート</button>
        <button className="btn" onClick={handleExport} disabled={samples.length === 0}>📤 JSONL エクスポート</button>
        <button className="btn danger" onClick={handleDeleteAll} disabled={samples.length === 0}
          style={{ marginLeft: 'auto' }}>🗑 全削除</button>
      </div>

      {samples.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📝</div>
          <div className="empty-title">学習サンプルがありません</div>
          <div className="empty-desc">「＋ 追加」または「CSV/JSONL インポート」から追加してください</div>
        </div>
      ) : (
        <div className="sample-list">
          {samples.map(s => (
            <div key={s.id} className="sample-item">
              {Array.isArray(s.messages) ? (
                /* マルチターン形式: messages配列を順に表示 */
                <>
                  <div className="sample-multiturn-badge">🔁 マルチターン ({s.messages.length}件)</div>
                  {s.messages.map((m, mi) => (
                    <div key={mi} className="sample-row">
                      <div className={`sample-label ${m.role}`}>{m.role === 'system' ? 'System' : m.role === 'user' ? 'User' : 'Assistant'}</div>
                      <div className="sample-text">{m.content}</div>
                      {mi === 0 && (
                        <div className="sample-actions">
                          <button className="sample-icon-btn delete" onClick={() => handleDelete(s.id)} title="削除">×</button>
                        </div>
                      )}
                    </div>
                  ))}
                </>
              ) : (
                /* シングルターン形式 */
                <>
                  {s.system && (
                    <div className="sample-row">
                      <div className="sample-label">System</div>
                      <div className="sample-text">{s.system}</div>
                    </div>
                  )}
                  <div className="sample-row">
                    <div className="sample-label user">User</div>
                    <div className="sample-text">{s.instruction}</div>
                    <div className="sample-actions">
                      <button className="sample-icon-btn" onClick={() => setEditing(s)} title="編集">✏️</button>
                      <button className="sample-icon-btn delete" onClick={() => handleDelete(s.id)} title="削除">×</button>
                    </div>
                  </div>
                  <div className="sample-row">
                    <div className="sample-label assistant">Assistant</div>
                    <div className="sample-text">{s.response}</div>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {showAdd && <SampleEditor onClose={() => setShowAdd(false)} onSave={() => { setShowAdd(false); reload(); showToast('追加しました', 'success'); }} />}
      {editing && <SampleEditor sample={editing} onClose={() => setEditing(null)} onSave={() => { setEditing(null); reload(); showToast('更新しました', 'success'); }} />}
      {showImport && <ImportDialog onClose={() => setShowImport(false)} onImport={(n) => { setShowImport(false); reload(); showToast(`${n} 件追加しました`, 'success'); }} />}
    </div>
  );
}

function SampleEditor({ sample, onClose, onSave }) {
  const [system, setSystem] = useState(sample?.system || '');
  const [instruction, setInstruction] = useState(sample?.instruction || '');
  const [response, setResponse] = useState(sample?.response || '');
  const [busy, setBusy] = useState(false);

  async function handleSave() {
    if (!instruction.trim() || !response.trim()) {
      alert('User入力とAssistant応答は必須です');
      return;
    }
    setBusy(true);
    try {
      const body = { instruction, response, system };
      if (sample) {
        await fetch(`/tuning/samples/${sample.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        await fetch('/tuning/samples', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
      onSave();
    } finally { setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">{sample ? '✏️ サンプル編集' : '＋ サンプル追加'}</div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label className="field-label">System (オプション)</label>
            <textarea className="textarea" rows="2" value={system} onChange={e => setSystem(e.target.value)}
              placeholder="あなたは○○の専門家です。" />
            <span className="field-hint">サンプル個別のsystem。空欄なら学習開始時のグローバルsystemPromptが使われます</span>
          </div>
          <div className="field">
            <label className="field-label">User (質問・指示) ※必須</label>
            <textarea className="textarea" rows="3" value={instruction} onChange={e => setInstruction(e.target.value)} required />
          </div>
          <div className="field">
            <label className="field-label">Assistant (理想的な応答) ※必須</label>
            <textarea className="textarea" rows="6" value={response} onChange={e => setResponse(e.target.value)} required />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>キャンセル</button>
          <button className="btn primary" onClick={handleSave} disabled={busy}>
            {busy ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ImportDialog({ onClose, onImport }) {
  const [format, setFormat] = useState('csv');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);

  function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.name.endsWith('.jsonl') || file.name.endsWith('.ndjson')) setFormat('jsonl');
    else if (file.name.endsWith('.csv')) setFormat('csv');
    const reader = new FileReader();
    reader.onload = () => setContent(reader.result);
    reader.readAsText(file);
  }

  async function handleImport() {
    if (!content.trim()) { alert('内容が空です'); return; }
    setBusy(true);
    try {
      const r = await fetch('/tuning/samples/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format, content }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'インポート失敗');
      onImport(data.added);
    } catch (e) {
      alert(e.message);
    } finally { setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">📥 学習データインポート</div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label className="field-label">形式</label>
            <select className="select" value={format} onChange={e => setFormat(e.target.value)}>
              <option value="csv">CSV (instruction, response, system)</option>
              <option value="jsonl">JSONL (1行1サンプル)</option>
            </select>
            <span className="field-hint">
              <strong>CSV</strong>: 1行目をヘッダー。<code>instruction</code> と <code>response</code> 必須、<code>system</code> 任意<br />
              <strong>JSONL (シングルターン)</strong>: <code>{`{"instruction":"...","response":"...","system":"..."}`}</code><br />
              <strong>JSONL (マルチターン)</strong>: <code>{`{"messages":[{"role":"system","content":"..."},{"role":"user","content":"..."},{"role":"assistant","content":"..."},{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}`}</code><br />
              <span style={{color: 'var(--accent)'}}>※ マルチターン形式は <code>messages</code> キーで判定。<code>system</code>/<code>user</code>/<code>assistant</code> ロールが交互に並ぶ会話形式。学習時に <code>apply_chat_template()</code> でモデルのチャットテンプレートに変換される。</span>
            </span>
          </div>
          <div className="field">
            <label className="field-label">ファイル選択</label>
            <input className="input" type="file" accept=".csv,.jsonl,.ndjson,.txt" onChange={handleFile} />
          </div>
          <div className="field">
            <label className="field-label">内容 (直接貼り付けも可)</label>
            <textarea className="textarea" rows="10" value={content} onChange={e => setContent(e.target.value)}
              placeholder={format === 'csv'
                ? 'instruction,response,system\n"宮城県の県庁所在地は?","仙台市です。",""'
                : '// シングルターン:\n{"instruction":"宮城県の県庁所在地は?","response":"仙台市です。"}\n// マルチターン:\n{"messages":[{"role":"user","content":"こんにちは"},{"role":"assistant","content":"こんにちは!何かお手伝いできることはありますか?"},{"role":"user","content":"宮城県の県庁所在地は?"},{"role":"assistant","content":"仙台市です。"}]}'} />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>キャンセル</button>
          <button className="btn primary" onClick={handleImport} disabled={busy || !content.trim()}>
            {busy ? 'インポート中...' : 'インポート'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 学習開始タブ ───
// プリセットは config.json の tuning.modelPresets から取得（/tuning/presets API）
// フォールバック用デフォルト
const DEFAULT_PRESETS = [
  { value: 'Qwen/Qwen2.5-0.5B-Instruct', size: '0.5B', vramLora: '~4GB', desc: '個人検証・実験用', epochs: 5, lr: 0.0002, batch: 2, accum: 4, r: 8, alpha: 16, maxLen: 2048 },
  { value: 'Qwen/Qwen2.5-1.5B-Instruct', size: '1.5B', vramLora: '~6GB', desc: '軽量タスク',       epochs: 5, lr: 0.0002, batch: 2, accum: 4, r: 16, alpha: 32, maxLen: 2048 },
  { value: 'Qwen/Qwen2.5-7B-Instruct',   size: '7B',   vramLora: '~22GB', desc: '本命・推奨',       epochs: 3, lr: 0.0002, batch: 1, accum: 16, r: 32, alpha: 64, maxLen: 2048 },
];

function TrainingView({ samples, currentJobId, onStarted, showToast }) {
  const [presets, setPresets] = useState(DEFAULT_PRESETS);
  const [baseModel, setBaseModel] = useState('');
  const [outputName, setOutputName] = useState('');
  const [method, setMethod] = useState('lora');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [epochs, setEpochs] = useState(3);
  const [learningRate, setLearningRate] = useState(0.0002);
  const [batchSize, setBatchSize] = useState(2);
  const [gradAccumSteps, setGradAccumSteps] = useState(4);
  const [loraR, setLoraR] = useState(16);
  const [loraAlpha, setLoraAlpha] = useState(32);
  const [loraDropout, setLoraDropout] = useState(0.05);
  const [maxSeqLength, setMaxSeqLength] = useState(2048);
  const [busy, setBusy] = useState(false);

  // 起動時にプリセット取得
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/tuning/presets');
        if (r.ok) {
          const data = await r.json();
          if (data.presets && data.presets.length > 0) {
            setPresets(data.presets);
            // 最初のプリセットを自動適用（baseModelが未設定なら）
            setBaseModel(prev => prev || data.presets[0].value);
            const first = data.presets[0];
            setEpochs(first.epochs ?? 3);
            setLearningRate(first.lr ?? 0.0002);
            setBatchSize(first.batch ?? 2);
            setGradAccumSteps(first.accum ?? 4);
            setLoraR(first.r ?? 16);
            setLoraAlpha(first.alpha ?? 32);
            setMaxSeqLength(first.maxLen ?? 2048);
          }
        }
      } catch (e) {
        console.warn('プリセット取得失敗:', e);
      }
    })();
  }, []);

  // プリセット適用
  function applyPreset(model) {
    setBaseModel(model.value);
    setEpochs(model.epochs ?? 3);
    setLearningRate(model.lr ?? 0.0002);
    setBatchSize(model.batch ?? 2);
    setGradAccumSteps(model.accum ?? 4);
    setLoraR(model.r ?? 16);
    setLoraAlpha(model.alpha ?? 32);
    setMaxSeqLength(model.maxLen ?? 2048);
  }

  async function handleStart() {
    if (currentJobId) { alert('既にジョブが実行中です'); return; }
    if (samples.length === 0) { alert('学習サンプルを追加してください'); return; }
    if (!baseModel.trim()) { alert('ベースモデルを指定してください'); return; }
    if (!confirm(`学習を開始します:\nベースモデル: ${baseModel}\nサンプル数: ${samples.length}\n手法: ${method.toUpperCase()}\nエポック: ${epochs}\n\n時間がかかります。続行しますか?`)) return;
    setBusy(true);
    try {
      const r = await fetch('/tuning/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseModel, outputName: outputName || undefined,
          method, systemPrompt: systemPrompt || undefined,
          epochs: Number(epochs), learningRate: Number(learningRate),
          batchSize: Number(batchSize), gradAccumSteps: Number(gradAccumSteps),
          loraR: Number(loraR), loraAlpha: Number(loraAlpha),
          loraDropout: Number(loraDropout),
          maxSeqLength: Number(maxSeqLength),
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || '起動失敗');
      onStarted(data.jobId);
    } catch (e) {
      showToast(`起動失敗: ${e.message}`, 'error');
    } finally { setBusy(false); }
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <div className="info-box">
        🎯 <strong>パイプライン</strong>: 学習 → アダプタ生成 → マージ → GGUF化 → 量子化 → llama.cppで使用可能。<br />
        ⚙️ <strong>環境変数</strong>: AMD R9700用に <code>HSA_OVERRIDE_GFX_VERSION=12.0.1</code> / <code>HIP_VISIBLE_DEVICES=0</code> が自動設定されます。
      </div>

      <div className="field">
        <label className="field-label">ベースモデル (プリセット)</label>
        <div className="quant-pills">
          {presets.map(m => (
            <div key={m.value} className={`quant-pill ${baseModel === m.value ? 'active' : ''}`}
              onClick={() => applyPreset(m)}
              title={`${m.size} / LoRA時VRAM ${m.vramLora} / ${m.desc}`}>
              {m.size} {baseModel === m.value && '✓'}
            </div>
          ))}
        </div>
      </div>

      <div className="field">
        <label className="field-label">HuggingFace Model ID</label>
        <input className="input" value={baseModel} onChange={e => setBaseModel(e.target.value)}
          placeholder="例: Qwen/Qwen2.5-7B-Instruct" />
        <span className="field-hint">
          初回実行時にHuggingFaceからダウンロードされます（数GB〜数十GB）。
          gated model（Llama等）は事前に <code>hf auth login</code>（旧 <code>huggingface-cli login</code>）が必要
        </span>
      </div>

      <div className="field">
        <label className="field-label">出力モデル名 (オプション)</label>
        <input className="input" value={outputName} onChange={e => setOutputName(e.target.value)}
          placeholder="my-tuned-model (空欄で自動命名)" />
      </div>

      <div className="field">
        <label className="field-label">グローバル System プロンプト (オプション)</label>
        <textarea className="textarea" rows="2" value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)}
          placeholder="あなたは○○の専門家です。" style={{ minHeight: 60 }} />
        <span className="field-hint">サンプル個別の system が無い場合、これが使われます</span>
      </div>

      <div className="field">
        <label className="field-label">学習手法</label>
        <select className="select" value={method} onChange={e => setMethod(e.target.value)}>
          <option value="lora">LoRA (推奨、軽量、AMD ROCm安定)</option>
          <option value="qlora">QLoRA (4bit量子化、AMDでは制限あり)</option>
          <option value="full">フルファインチューニング (要大量VRAM)</option>
        </select>
        {method === 'qlora' && (
          <span className="field-hint" style={{ color: 'var(--orange)' }}>
            ⚠️ QLoRA は bitsandbytes が必要。AMD ROCm では動作が制限される場合あり。LoRA推奨
          </span>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <div className="field">
          <label className="field-label">エポック数</label>
          <input className="input" type="number" min="1" max="100" value={epochs}
            onChange={e => setEpochs(e.target.value)} />
        </div>
        <div className="field">
          <label className="field-label">学習率 (LR)</label>
          <input className="input" type="number" step="0.00001" value={learningRate}
            onChange={e => setLearningRate(e.target.value)} />
        </div>
        <div className="field">
          <label className="field-label">バッチサイズ</label>
          <input className="input" type="number" min="1" value={batchSize}
            onChange={e => setBatchSize(e.target.value)} />
        </div>
        <div className="field">
          <label className="field-label">勾配累積ステップ</label>
          <input className="input" type="number" min="1" value={gradAccumSteps}
            onChange={e => setGradAccumSteps(e.target.value)} />
        </div>
        <div className="field">
          <label className="field-label">最大シーケンス長</label>
          <input className="input" type="number" min="256" step="256" value={maxSeqLength}
            onChange={e => setMaxSeqLength(e.target.value)} />
        </div>
        {(method === 'lora' || method === 'qlora') && (
          <>
            <div className="field">
              <label className="field-label">LoRA r (rank)</label>
              <input className="input" type="number" min="1" value={loraR}
                onChange={e => setLoraR(e.target.value)} />
            </div>
            <div className="field">
              <label className="field-label">LoRA alpha</label>
              <input className="input" type="number" min="1" value={loraAlpha}
                onChange={e => setLoraAlpha(e.target.value)} />
            </div>
            <div className="field">
              <label className="field-label">LoRA dropout</label>
              <input className="input" type="number" min="0" max="0.5" step="0.01" value={loraDropout}
                onChange={e => setLoraDropout(e.target.value)} />
            </div>
          </>
        )}
      </div>

      <div className="info-box" style={{ marginTop: 20 }}>
        <strong>📋 サマリー</strong>: サンプル数 <strong>{samples.length}</strong>
        / 実効バッチ <strong>{batchSize * gradAccumSteps}</strong> (batch×accum)
        / 推定ステップ数 <strong>{Math.ceil(samples.length * epochs / (batchSize * gradAccumSteps))}</strong>
      </div>

      <div style={{ marginTop: 20, display: 'flex', gap: 8 }}>
        <button className="btn primary" style={{ padding: '10px 24px', fontSize: 14 }}
          onClick={handleStart} disabled={busy || currentJobId || samples.length === 0}>
          {busy ? '起動中...' : currentJobId ? '⚙️ 別ジョブ実行中' : '🚀 学習開始'}
        </button>
      </div>
    </div>
  );
}

// ─── ジョブタブ ───
// 後処理の経過時間表示 (3分12秒 / 1時間5分)
function fmtElapsed(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s2 = sec % 60;
  if (h > 0) return `${h}時間${m}分`;
  if (m > 0) return `${m}分${s2}秒`;
  return `${s2}秒`;
}

function JobsView({ jobs, currentJobId, postprocess, reload, showToast }) {
  const [expandedJobs, setExpandedJobs] = useState({});
  const [jobLogs, setJobLogs] = useState({});
  const [postLogs, setPostLogs] = useState({});
  const [postProcessing, setPostProcessing] = useState(null);
  const [artifacts, setArtifacts] = useState({});

  // このジョブの後処理が動いているか。
  // サーバーの実行中情報 (postprocess) を優先し、ジョブ記録は保険として見る
  // (jobs.json への書き込みは各ステップの切れ目でしか起きないため)
  const ppRunning = (j) =>
    (postprocess && postprocess.jobId === j.id) || j.postprocessStatus === 'running';
  const ppStep = (j) =>
    (postprocess && postprocess.jobId === j.id && postprocess.step) || j.postprocessStep || null;

  async function toggleLog(jobId) {
    const isOpen = expandedJobs[jobId];
    if (isOpen) {
      setExpandedJobs(p => ({ ...p, [jobId]: false }));
      return;
    }
    setExpandedJobs(p => ({ ...p, [jobId]: true }));
    try {
      const r = await fetch(`/tuning/jobs/${jobId}/log`);
      if (r.status === 404) {
        // ログファイルがまだ作られていない (学習開始直後等)
        setJobLogs(p => ({ ...p, [jobId]: '' }));
      } else if (r.ok) {
        const text = await r.text();
        setJobLogs(p => ({ ...p, [jobId]: text }));
      } else {
        setJobLogs(p => ({ ...p, [jobId]: `ログ取得エラー: HTTP ${r.status}` }));
      }
    } catch (e) {
      setJobLogs(p => ({ ...p, [jobId]: `ログ取得エラー: ${e.message}` }));
    }
    // 後処理ログ (無ければ 404。まだ実行していないだけなので無視する)
    try {
      const r = await fetch(`/tuning/jobs/${jobId}/postprocess-log`);
      const text = r.ok ? await r.text() : '';
      setPostLogs(p => ({ ...p, [jobId]: text }));
    } catch {}
    // アーティファクトも取得
    try {
      const r = await fetch(`/tuning/jobs/${jobId}/artifacts`);
      if (r.ok) {
        const data = await r.json();
        setArtifacts(p => ({ ...p, [jobId]: data.artifacts || [] }));
      }
    } catch {}
  }

  useEffect(() => {
    if (!currentJobId || !expandedJobs[currentJobId]) return;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`/tuning/jobs/${currentJobId}/log`);
        if (r.status === 404) {
          setJobLogs(p => ({ ...p, [currentJobId]: '' }));
        } else if (r.ok) {
          const text = await r.text();
          setJobLogs(p => ({ ...p, [currentJobId]: text }));
        }
      } catch {}
    }, 3000);
    return () => clearInterval(t);
  }, [currentJobId, expandedJobs]);

  // 後処理中はログを追いかける。マージは数分無言なので、
  // 進んでいるのかどうかが分かるようにしておく
  useEffect(() => {
    const target = postprocess && postprocess.jobId;
    if (!target || !expandedJobs[target]) return;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`/tuning/jobs/${target}/postprocess-log`);
        if (!r.ok) return;
        const text = await r.text();
        setPostLogs(p => ({ ...p, [target]: text }));
      } catch {}
    }, 3000);
    return () => clearInterval(t);
  }, [postprocess, expandedJobs]);

  async function handlePostStop(id) {
    if (!confirm('後処理 (マージ/GGUF化) を停止しますか?')) return;
    try {
      const r = await fetch(`/tuning/jobs/${id}/postprocess/stop`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      showToast('停止しました', 'success');
      reload();
    } catch (e) { showToast(e.message, 'error'); }
  }

  async function handleStop(id) {
    if (!confirm('このジョブを停止しますか?')) return;
    await fetch(`/tuning/jobs/${id}/stop`, { method: 'POST' });
    reload();
    showToast('停止しました', 'success');
  }
  async function handleDelete(id) {
    if (!confirm('このジョブと出力ファイルを削除しますか?')) return;
    const r = await fetch(`/tuning/jobs/${id}`, { method: 'DELETE' });
    if (r.ok) { reload(); showToast('削除しました', 'success'); }
  }

  if (jobs.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-icon">📊</div>
        <div className="empty-title">ジョブはありません</div>
        <div className="empty-desc">「🚀 学習開始」タブから学習を開始してください</div>
      </div>
    );
  }

  return (
    <div>
      {jobs.map(j => (
        <div key={j.id} className="job-item">
          <div className="job-header">
            <span className={`job-status ${j.status}`}>
              {j.status === 'running' && '⚙️ 学習中'}
              {j.status === 'completed' && '✓ 学習完了'}
              {j.status === 'failed' && '✗ 失敗'}
              {j.status === 'cancelled' && '○ 中止'}
            </span>
            {/* 後処理 (マージ→GGUF→量子化) の状態。マージは数分〜十数分かかるうえ
                無言なので、実行中とステップをここに出す */}
            {ppRunning(j) ? (
              <span className="post-status running">
                📦 マージ実行中{ppStep(j) ? `（${ppStep(j)}）` : ''}
                {j.postprocessStartedAt ? ` ${fmtElapsed(Date.now() - j.postprocessStartedAt)}` : ''}
              </span>
            ) : j.postprocessStatus === 'completed' ? (
              <span className="post-status">📦 後処理完了</span>
            ) : j.postprocessStatus === 'failed' ? (
              <span className="post-status failed">📦 後処理失敗</span>
            ) : j.postprocessStatus === 'cancelled' ? (
              <span className="post-status">📦 後処理中断</span>
            ) : j.postprocessStatus === 'interrupted' ? (
              <span className="post-status failed">📦 後処理が中断されました (サーバー再起動)</span>
            ) : null}
            <span className="job-id">{j.id}</span>
            <div className="job-actions">
              <button className="btn small" onClick={() => toggleLog(j.id)}>
                {expandedJobs[j.id] ? '閉じる' : 'ログを見る'}
              </button>
              {j.status === 'completed' && !ppRunning(j) && (
                <button className="btn small primary" onClick={() => setPostProcessing(j)}
                  disabled={!!postprocess}
                  title={postprocess ? '別のジョブの後処理が実行中です' : ''}>
                  📦 {j.postprocessStatus === 'completed' ? 'マージ/GGUF化 (再実行)' : 'マージ/GGUF化'}
                </button>
              )}
              {ppRunning(j) && (
                <button className="btn small danger" onClick={() => handlePostStop(j.id)}>
                  後処理を停止
                </button>
              )}
              {j.status === 'running' && (
                <button className="btn small danger" onClick={() => handleStop(j.id)}>停止</button>
              )}
              {j.status !== 'running' && (
                <button className="btn small danger" onClick={() => handleDelete(j.id)}>削除</button>
              )}
            </div>
          </div>
          <div className="job-meta">
            <div className="job-meta-row"><span className="job-meta-key">モデル:</span><span className="job-meta-val">{j.baseModel}</span></div>
            <div className="job-meta-row"><span className="job-meta-key">手法:</span><span className="job-meta-val">{j.method}</span></div>
            <div className="job-meta-row"><span className="job-meta-key">エポック:</span><span className="job-meta-val">{j.epochs}</span></div>
            <div className="job-meta-row"><span className="job-meta-key">LR:</span><span className="job-meta-val">{j.learningRate}</span></div>
            <div className="job-meta-row"><span className="job-meta-key">サンプル数:</span><span className="job-meta-val">{j.sampleCount}</span></div>
            <div className="job-meta-row"><span className="job-meta-key">開始:</span><span className="job-meta-val">{new Date(j.startedAt).toLocaleString('ja-JP')}</span></div>
          </div>
          {ppRunning(j) && (
            <div className="post-progress">
              <div className="post-progress-bar"><div className="post-progress-fill" /></div>
              <div className="post-progress-text">
                {ppStep(j) || 'マージ'} を実行中です。7Bモデルでマージに5〜15分、GGUF変換に数分かかります
                {expandedJobs[j.id] ? '（下の後処理ログが3秒ごとに更新されます）' : '（「ログを見る」で進行状況を確認できます）'}
              </div>
            </div>
          )}
          {j.postprocessStatus === 'failed' && j.postprocessError && (
            <div className="field-hint" style={{ color: 'var(--red)' }}>後処理エラー: {j.postprocessError}</div>
          )}
          {j.postprocessStatus === 'completed' && j.ggufPath && (
            <GgufPathDisplay path={j.ggufPath} size={j.ggufSize} />
          )}
          {expandedJobs[j.id] && (
            <>
              <div className="job-log">{
                jobLogs[j.id] === undefined
                  ? 'ログ読み込み中...'
                  : (jobLogs[j.id] || '(ログはまだ空です。学習の出力が始まるまでお待ちください)')
              }</div>
              {postLogs[j.id] ? (
                <>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', margin: '8px 0 4px' }}>
                    後処理ログ (マージ / GGUF変換 / 量子化)
                  </div>
                  <div className="job-log">{postLogs[j.id]}</div>
                </>
              ) : null}
              {artifacts[j.id] && artifacts[j.id].length > 0 && (
                <div className="artifact-list">
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>出力ファイル:</div>
                  {artifacts[j.id].map(a => (
                    <div key={a.name} className="artifact-item">
                      <span className="artifact-name">{a.name}</span>
                      <span className="artifact-size">{a.sizeHuman}</span>
                      {a.downloadable && (
                        <a className="btn small" href={`/tuning/jobs/${j.id}/artifacts/${a.name}`} target="_blank" rel="noopener" download>📥</a>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      ))}

      {postProcessing && <PostProcessDialog job={postProcessing} onClose={() => setPostProcessing(null)} onStarted={() => { setPostProcessing(null); reload(); showToast('後処理を開始しました', 'success'); }} />}
    </div>
  );
}

// ─── GGUFパス表示（後処理完了時）───
function GgufPathDisplay({ path, size }) {
  const [copied, setCopied] = useState(false);
  const filename = path ? path.split('/').pop() : '';
  const sizeStr = size ? (size >= 1024 * 1024 * 1024
    ? `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
    : `${(size / 1024 / 1024).toFixed(1)} MB`) : '';

  function copyPath() {
    navigator.clipboard.writeText(path).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  return (
    <div className="gguf-path-box">
      <div className="gguf-path-header">
        <span className="gguf-path-icon">📦</span>
        <span className="gguf-path-title">生成されたGGUFファイル</span>
        {sizeStr && <span className="gguf-path-size">{sizeStr}</span>}
      </div>
      <div className="gguf-path-content">
        <code className="gguf-path-code" title={path}>{filename}</code>
        <button className="btn small" onClick={copyPath} title="フルパスをコピー">
          {copied ? '✓ コピー済' : '📋 パスをコピー'}
        </button>
      </div>
      <div className="gguf-path-full" title={path}>
        <span className="gguf-path-label">フルパス:</span> <code>{path}</code>
      </div>
      <div className="gguf-path-hint">
        💡 <code>config.json</code> の <code>models[]</code> にこのパスを追加してチャットで使えます
        <a className="gguf-path-edit-btn" href="/editconfig.html" target="_blank" rel="noopener noreferrer" title="config.json を編集">
          ⚙️ config.json を編集
        </a>
      </div>
    </div>
  );
}

// ─── 後処理ダイアログ ───
function PostProcessDialog({ job, onClose, onStarted }) {
  const [quantize, setQuantize] = useState('Q4_K_M');
  const [busy, setBusy] = useState(false);

  // モデルサイズ別の推奨量子化
  const quantOptions = [
    { value: 'f16',     label: 'F16',     desc: '量子化なし。ファイル大、最高精度（小型モデル推奨）' },
    { value: 'Q8_0',    label: 'Q8_0',    desc: '8bit。0.5B〜1.5B モデル推奨' },
    { value: 'Q6_K',    label: 'Q6_K',    desc: '6bit。1.5B〜3B モデル推奨' },
    { value: 'Q5_K_M',  label: 'Q5_K_M',  desc: '5bit。3B〜7B モデル推奨' },
    { value: 'Q4_K_M',  label: 'Q4_K_M',  desc: '4bit。7B以上推奨（小型モデルには厳しい）' },
    { value: 'Q4_K_S',  label: 'Q4_K_S',  desc: '4bit (小)。13B以上向け' },
    { value: 'Q3_K_M',  label: 'Q3_K_M',  desc: '3bit。30B以上向け、品質低下大' },
  ];

  async function handleStart() {
    setBusy(true);
    try {
      const r = await fetch(`/tuning/jobs/${job.id}/postprocess`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantize }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || '起動失敗');
      onStarted();
    } catch (e) {
      alert(`後処理失敗: ${e.message}`);
    } finally { setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">📦 マージ・GGUF化・量子化</div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="info-box">
            🔄 <strong>処理フロー</strong>:
            ① アダプタをベースにマージ → ② GGUF (F16) に変換 → ③ 量子化（任意）<br />
            完了後、<code>llama-server</code> で使えるGGUFファイルが作成されます。
          </div>

          <div className="field">
            <label className="field-label">ジョブ</label>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {job.id} | {job.baseModel}
            </div>
          </div>

          <div className="field">
            <label className="field-label">量子化レベル</label>
            <div className="quant-pills">
              {quantOptions.map(o => (
                <div key={o.value} className={`quant-pill ${quantize === o.value ? 'active' : ''}`}
                  onClick={() => setQuantize(o.value)}>{o.label}</div>
              ))}
            </div>
            <span className="field-hint">
              {quantOptions.find(o => o.value === quantize)?.desc}
              <br />
              <strong style={{ color: 'var(--orange)' }}>注意</strong>: 小さいモデル(0.5B〜1.5B)に強い量子化(Q4_K_M)をかけると知識が失われます。F16 or Q8_0 推奨。
            </span>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>キャンセル</button>
          <button className="btn primary" onClick={handleStart} disabled={busy}>
            {busy ? '起動中...' : '🚀 開始'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════
// 永続RAG → 教師データ生成タブ
// ════════════════════════════════════════════════
// 登録済みRAG資料を選び、LLMにQ&Aを作らせて、レビューしてから
// 「学習データ」タブ (tuning/samples.jsonl) へ取り込む。
// プロンプトはここで編集して試せる (config.json の tuning.ragDataset が初期値)。
// 不採用理由コード → 画面表示
const RT_REASON_LABEL = {
  deictic: '質問が指示語',
  meta: '回答がメタ表現',
  numbers: '資料に無い数値',
  coverage: '資料との重なり不足',
  duplicate: '質問の重複',
  length: '長さ超過/不足',
  verify: '検証NG',
};

function RagGenView({ showToast, reloadSamples }) {
  const [status, setStatus] = useState(null);      // /tuning/rag/status
  const [docs, setDocs] = useState([]);
  const [categories, setCategories] = useState([]);
  const [catFilter, setCatFilter] = useState('all');
  const [selected, setSelected] = useState({});    // docId → true
  const [params, setParams] = useState(null);      // 既定値はサーバーの defaults
  const [showPrompts, setShowPrompts] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [openJobId, setOpenJobId] = useState(null);
  const [samples, setSamples] = useState(null);    // { samples, counts, total }
  const [sampleFilter, setSampleFilter] = useState('accepted');
  const [importMode, setImportMode] = useState('');

  const loadStatus = async () => {
    try {
      const r = await fetch('/tuning/rag/status');
      if (!r.ok) return;
      const data = await r.json();
      setStatus(data);
      // 既定パラメータ (プロンプト本文込み) をフォームの初期値にする。
      // 一度触った後は上書きしない (入力中の値が消えないように)
      setParams(prev => prev || data.defaults || null);
    } catch {}
  };

  const loadDocs = async () => {
    try {
      const [rd, rc] = await Promise.all([fetch('/rag/documents'), fetch('/rag/categories')]);
      if (rd.ok) setDocs((await rd.json()).documents || []);
      if (rc.ok) setCategories((await rc.json()).categories || []);
    } catch {}
  };

  const loadJobs = async () => {
    try {
      const r = await fetch('/tuning/rag/jobs');
      if (r.ok) setJobs((await r.json()).jobs || []);
    } catch {}
  };

  useEffect(() => {
    loadStatus(); loadDocs(); loadJobs();
    const t = setInterval(loadJobs, 15000);   // 取りこぼし対策 (進捗の主役はSSE)
    return () => clearInterval(t);
  }, []);

  // 実行中ジョブの進捗はSSEで受ける (OCR/HTML登録画面と同じ方式)
  const streamIds = jobs.filter(j => j.status === 'running' || j.status === 'pending')
    .map(j => j.jobId).join(',');
  useEffect(() => {
    if (!streamIds) return;
    const sources = streamIds.split(',').map(id => {
      const es = new EventSource(`/tuning/rag/jobs/${id}/stream`);
      es.onmessage = (ev) => {
        let data;
        try { data = JSON.parse(ev.data); } catch { return; }
        if (data.job) setJobs(prev => prev.map(j => (j.jobId === data.job.jobId ? data.job : j)));
        if (data.type === 'deleted') loadJobs();
      };
      es.onerror = () => { /* ブラウザが自動再接続する。落ちてもポーリングで追従できる */ };
      return es;
    });
    return () => sources.forEach(es => es.close());
  }, [streamIds]);

  const visibleDocs = docs.filter(d => catFilter === 'all' || (d.category || '') === catFilter);
  const selectedIds = Object.keys(selected).filter(id => selected[id] && docs.find(d => d.docId === id));

  function toggleDoc(docId) {
    setSelected(p => ({ ...p, [docId]: !p[docId] }));
  }
  function selectAllVisible(on) {
    setSelected(p => {
      const next = { ...p };
      for (const d of visibleDocs) next[d.docId] = on;
      return next;
    });
  }
  function setParam(key, value) {
    setParams(p => ({ ...(p || {}), [key]: value }));
  }

  // 生成にかかるLLM呼び出し回数のざっくり見積り。
  // 「何十分かかるのか分からないまま数百パッセージ回し始める」のを防ぐ
  const estimate = (() => {
    if (!params) return null;
    const chunkTotal = docs.filter(d => selectedIds.includes(d.docId))
      .reduce((n, d) => n + (d.chunkCount || 0), 0);
    if (!chunkTotal) return null;
    // ページ単位ではパッセージ数 = ページ数だが、ページ数は登録情報に無いので
    // チャンク数からの概算にする (1ページ ≒ 2チャンク)。実数は開始後に出る
    const chunksPerPassage = (params.passageMode === 'chunks')
      ? Math.max(1, Number(params.passageChunks) || 3)
      : Math.max(1, 2 * (Number(params.pagesPerPassage) || 1));
    let passages = Math.ceil(chunkTotal / chunksPerPassage);
    if (Number(params.maxPassages) > 0) passages = Math.min(passages, Number(params.maxPassages));
    const perPassage = 1
      + (params.verify ? Number(params.questionsPerPassage) || 0 : 0)
      + (Number(params.refusalPerPassage) > 0 ? 1 / Math.max(1, Number(params.refusalEveryNth) || 3) : 0);
    return {
      passages,
      calls: Math.round(passages * perPassage),
      samples: passages * (Number(params.questionsPerPassage) || 0),
    };
  })();

  async function handleStart() {
    if (selectedIds.length === 0) { alert('資料を1つ以上選んでください'); return; }
    if (estimate && !confirm(
      `教師データ生成を開始します。\n\n対象資料: ${selectedIds.length} 件\n`
      + `パッセージ: 約 ${estimate.passages} 個\nLLM呼び出し: 約 ${estimate.calls} 回\n`
      + `生成見込み: 最大 ${estimate.samples} 件\n\n`
      + `GPUを占有します。続行しますか?`)) return;
    setBusy(true);
    try {
      const r = await fetch('/tuning/rag/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docIds: selectedIds, params }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || '起動失敗');
      showToast('生成ジョブを開始しました', 'success');
      loadJobs();
    } catch (e) {
      showToast(`起動失敗: ${e.message}`, 'error');
    } finally { setBusy(false); }
  }

  async function jobAction(jobId, action) {
    try {
      let r;
      if (action === 'cancel') r = await fetch(`/tuning/rag/jobs/${jobId}/cancel`, { method: 'POST' });
      else if (action === 'resume') r = await fetch(`/tuning/rag/jobs/${jobId}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      else if (action === 'redo') r = await fetch(`/tuning/rag/jobs/${jobId}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redo: true }) });
      else if (action === 'delete') r = await fetch(`/tuning/rag/jobs/${jobId}`, { method: 'DELETE' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      if (action === 'delete' && openJobId === jobId) { setOpenJobId(null); setSamples(null); }
      loadJobs();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  async function openSamples(jobId, filter = sampleFilter) {
    if (openJobId === jobId && filter === sampleFilter && samples) { setOpenJobId(null); setSamples(null); return; }
    setOpenJobId(jobId); setSampleFilter(filter); setSamples(null);
    try {
      const r = await fetch(`/tuning/rag/jobs/${jobId}/samples?status=${filter}&limit=100`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setSamples(data);
    } catch (e) {
      showToast(e.message, 'error');
      setSamples({ samples: [], counts: {}, total: 0 });
    }
  }

  async function toggleSampleStatus(jobId, id, current) {
    try {
      const r = await fetch(`/tuning/rag/jobs/${jobId}/samples/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id], status: current === 'accepted' ? 'rejected' : 'accepted' }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setJobs(prev => prev.map(j => (j.jobId === jobId ? data.job : j)));
      openSamples(jobId, sampleFilter);
    } catch (e) { showToast(e.message, 'error'); }
  }

  async function handleImport(job) {
    const mode = importMode || job.params?.mode || 'closed';
    const modeLabel = mode === 'closed' ? '知識注入型 (資料を渡さない)'
      : mode === 'open' ? 'RAG運用型 (資料を添える)' : '両方';
    if (!confirm(`採用済み ${job.accepted} 件を「学習データ」へ取り込みます。\n形式: ${modeLabel}\n\nよろしいですか?`)) return;
    try {
      const r = await fetch(`/tuning/rag/jobs/${job.jobId}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      showToast(`${data.added} 件を学習データに追加しました`, 'success');
      loadJobs();
      if (reloadSamples) reloadSamples();
    } catch (e) { showToast(e.message, 'error'); }
  }

  if (!params) {
    return <div className="empty-state"><div className="empty-desc">読み込み中...</div></div>;
  }

  const llmNg = status && status.llm && !status.llm.ok;

  return (
    <div>
      <div className="info-box">
        🧬 <strong>RAGから教師データを作る</strong>: 登録済みの資料をパッセージに束ね、LLMに「その資料だけで答えられるQ&amp;A」を作らせます。
        機械チェック（指示語・数値の裏取り・資料との重なり・重複）とLLM検証を通ったものだけが「採用」になります。<br />
        📌 <strong>取り込み形式</strong>: <strong>知識注入型(closed)</strong> は資料を渡さず質問だけで答えさせる形（社内知識をモデルに埋め込む）。
        <strong>RAG運用型(open)</strong> は検索結果と同じ体裁で資料を添える形（資料を読んで答える型と、無い時に断る型を教える）。
        RAGを運用しながら精度を上げたいなら open、RAGなしで答えさせたいなら closed です。
      </div>

      {status && !status.enabled && (
        <div className="info-box" style={{ borderColor: 'var(--red)' }}>
          ⚠️ この機能は無効です。<code>config.json</code> の <code>tuning.ragDataset.enabled</code> を true にしてください。
        </div>
      )}
      {llmNg && (
        <div className="info-box" style={{ borderColor: 'var(--orange)' }}>
          ⚠️ 生成用LLMが使えません: {status.llm.message}
        </div>
      )}
      {/* 未ロードでも開始時に自動起動する構成では、何が起きるかを先に知らせる
          (「生成失敗: fetch failed」で止まるより、待たされる理由が分かる方がよい) */}
      {status && status.llm && status.llm.ok && status.llm.note && (
        <div className="info-box">ℹ️ {status.llm.note}</div>
      )}
      {status && status.llm && status.llm.ok && !status.llm.note && status.llm.modelName && (
        <div className="field-hint" style={{ marginBottom: 12 }}>
          生成に使うモデル: <code>{status.llm.modelName}</code>
          {status.llm.managed ? '（LLMプール管理: 生成中だけロードされます）' : ''}
        </div>
      )}

      {/* ── 対象資料の選択 ── */}
      <div className="field">
        <label className="field-label">
          対象資料 ({selectedIds.length} / {docs.length} 件選択)
        </label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
          <select className="select" value={catFilter} onChange={e => setCatFilter(e.target.value)} style={{ maxWidth: 240 }}>
            <option value="all">すべてのカテゴリ</option>
            <option value="">未分類</option>
            {categories.map(c => <option key={c.name} value={c.name}>{c.name} ({c.docCount})</option>)}
          </select>
          <button className="btn small" onClick={() => selectAllVisible(true)}>表示中を全選択</button>
          <button className="btn small" onClick={() => selectAllVisible(false)}>選択解除</button>
          <button className="btn small" onClick={loadDocs}>🔄 更新</button>
        </div>
        {visibleDocs.length === 0 ? (
          <div className="field-hint">
            登録資料がありません。<a href="/rag.html" style={{ color: 'var(--accent)' }}>📚 永続RAG</a> でPDFやWebページを登録してください。
          </div>
        ) : (
          <div className="ragdoc-list">
            {visibleDocs.map(d => (
              <label key={d.docId} className={`ragdoc-item ${selected[d.docId] ? 'selected' : ''}`}>
                <input type="checkbox" checked={!!selected[d.docId]} onChange={() => toggleDoc(d.docId)} />
                <span className="ragdoc-name">{d.filename}</span>
                {d.category && <span className="ragdoc-cat">{d.category}</span>}
                <span className="ragdoc-chunks">{d.chunkCount} チャンク</span>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* ── 生成パラメータ ── */}
      <div className="field">
        <label className="field-label">取り込み形式 (mode)</label>
        <div className="quant-pills">
          {[
            { v: 'closed', label: '知識注入型 (closed)', desc: '資料を渡さず質問だけで答えさせる。RAGなしで答えられるようにする' },
            { v: 'open', label: 'RAG運用型 (open)', desc: '検索結果と同じ体裁で資料を添える。読んで答える型・断る型を教える' },
            { v: 'both', label: '両方 (both)', desc: '同じQ&Aから2本作る。件数は倍になる' },
          ].map(o => (
            <div key={o.v} className={`quant-pill ${params.mode === o.v ? 'active' : ''}`}
              onClick={() => setParam('mode', o.v)} title={o.desc}>{o.label}</div>
          ))}
        </div>
      </div>

      <div className="rt-grid">
        <div className="field">
          <label className="field-label">パッセージの作り方</label>
          <select className="select" value={params.passageMode || 'auto'}
            onChange={e => setParam('passageMode', e.target.value)}>
            <option value="auto">自動（ページ情報があればページ単位）</option>
            <option value="page">ページ単位（1ページ = 1パッセージ）</option>
            <option value="chunks">チャンク単位（従来）</option>
          </select>
          <span className="field-hint">
            PDF OCR で登録した資料はページ番号を持っています。ページ単位にすると
            「1ページにつき{params.questionsPerPassage}問」になり、300ページなら最大 {300 * (Number(params.questionsPerPassage) || 0)} 問
          </span>
        </div>
        <div className="field">
          <label className="field-label">1パッセージのページ数</label>
          <input className="input" type="number" min="1" max="20" value={params.pagesPerPassage ?? 1}
            onChange={e => setParam('pagesPerPassage', Number(e.target.value))}
            disabled={params.passageMode === 'chunks'} />
          <span className="field-hint">ページ単位のときだけ有効。1ページが薄い資料は2〜3にまとめると設問が作りやすい</span>
        </div>
        <div className="field">
          <label className="field-label">1パッセージのチャンク数</label>
          <input className="input" type="number" min="1" max="20" value={params.passageChunks}
            onChange={e => setParam('passageChunks', Number(e.target.value))}
            disabled={params.passageMode === 'page'} />
          <span className="field-hint">チャンク単位のときだけ有効。検索用チャンク(既定500文字)を何個つなぐか</span>
        </div>
        <div className="field">
          <label className="field-label">1パッセージあたりのQ&amp;A数</label>
          <input className="input" type="number" min="1" max="20" value={params.questionsPerPassage}
            onChange={e => setParam('questionsPerPassage', Number(e.target.value))} />
          <span className="field-hint">欲張ると内容の薄い質問が増える。3前後が無難</span>
        </div>
        <div className="field">
          <label className="field-label">拒否サンプル数 / 回</label>
          <input className="input" type="number" min="0" max="5" value={params.refusalPerPassage}
            onChange={e => setParam('refusalPerPassage', Number(e.target.value))} />
          <span className="field-hint">「資料に無いこと」を聞く質問。0で無効。範囲外の作文を抑える効果がある</span>
        </div>
        <div className="field">
          <label className="field-label">拒否サンプルの間隔</label>
          <input className="input" type="number" min="1" max="100" value={params.refusalEveryNth}
            onChange={e => setParam('refusalEveryNth', Number(e.target.value))} />
          <span className="field-hint">何パッセージに1回作るか。全体の1割程度が目安</span>
        </div>
        <div className="field">
          <label className="field-label">temperature</label>
          <input className="input" type="number" step="0.05" min="0" max="2" value={params.temperature}
            onChange={e => setParam('temperature', Number(e.target.value))} />
          <span className="field-hint">低すぎると同じ聞き方ばかりになる。0.3〜0.6 推奨</span>
        </div>
        <div className="field">
          <label className="field-label">パッセージ数の上限 (0で無制限)</label>
          <input className="input" type="number" min="0" value={params.maxPassages}
            onChange={e => setParam('maxPassages', Number(e.target.value))} />
          <span className="field-hint">まず 5〜10 で試運転し、出来を見てから全件回すと失敗が安い</span>
        </div>
        <div className="field">
          <label className="field-label">回答の文字数 (最小 / 最大)</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="input" type="number" min="1" value={params.minAnswerChars}
              onChange={e => setParam('minAnswerChars', Number(e.target.value))} />
            <input className="input" type="number" min="20" value={params.maxAnswerChars}
              onChange={e => setParam('maxAnswerChars', Number(e.target.value))} />
          </div>
          <span className="field-hint">
            範囲外は不採用。日本語の事実回答は「DC12Vです。」のように短いので、最小を大きくすると正答まで落ちます（既定6）
          </span>
        </div>
        <div className="field">
          <label className="field-label">資料との重なり下限 (0〜1)</label>
          <input className="input" type="number" step="0.05" min="0" max="1" value={params.minCoverage}
            onChange={e => setParam('minCoverage', Number(e.target.value))} />
          <span className="field-hint">回答の文字3-gramが資料にどれだけ含まれるか。一般論で埋めた回答を落とす</span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
        <label className="rt-check">
          <input type="checkbox" checked={params.verify !== false}
            onChange={e => setParam('verify', e.target.checked)} />
          LLMで検証する (資料に書かれているか・質問が自立しているか)
        </label>
        <label className="rt-check">
          <input type="checkbox" checked={params.checkNumbers !== false}
            onChange={e => setParam('checkNumbers', e.target.checked)} />
          数値の裏取りをする (資料に無い数値を含む回答を落とす)
        </label>
        <label className="rt-check">
          <input type="checkbox" checked={params.topUp !== false}
            onChange={e => setParam('topUp', e.target.checked)} />
          不足分を追い生成する (指定数に届かなければ既出を見せて作り直させる)
        </label>
      </div>

      {/* ── プロンプト編集 ── */}
      <div className="field">
        <button className="btn small" onClick={() => setShowPrompts(v => !v)}>
          {showPrompts ? '▼' : '▶'} プロンプトを編集する ({showPrompts ? '閉じる' : '生成 / 拒否例 / 検証 / 取り込み形式'})
        </button>
      </div>
      {showPrompts && (
        <div className="rt-prompts">
          <div className="field-hint" style={{ marginBottom: 10 }}>
            初期値は <code>config.json</code> の <code>tuning.ragDataset</code>。ここでの編集はこのジョブにだけ効きます
            (恒久的に変えるなら <a href="/editconfig.html" style={{ color: 'var(--accent)' }}>⚙️ 設定</a> で編集)。
          </div>
          <div className="field">
            <label className="field-label">① Q&amp;A生成プロンプト <span className="rt-vars">{'{passage} {source} {n} {styles} {minChars} {maxChars}'}</span></label>
            <textarea className="textarea" rows="14" value={params.generatePrompt}
              onChange={e => setParam('generatePrompt', e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label">② 拒否サンプルの質問生成プロンプト <span className="rt-vars">{'{passage} {source} {n}'}</span></label>
            <textarea className="textarea" rows="8" value={params.refusalPrompt}
              onChange={e => setParam('refusalPrompt', e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label">③ 検証プロンプト <span className="rt-vars">{'{passage} {question} {answer}'}</span></label>
            <textarea className="textarea" rows="10" value={params.verifyPrompt}
              onChange={e => setParam('verifyPrompt', e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label">学習サンプルの system (closed / 知識注入型)</label>
            <textarea className="textarea" rows="3" value={params.closedSystemPrompt}
              onChange={e => setParam('closedSystemPrompt', e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label">学習サンプルの system (open / RAG運用型)</label>
            <textarea className="textarea" rows="3" value={params.openSystemPrompt}
              onChange={e => setParam('openSystemPrompt', e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label">open形式の入力テンプレート <span className="rt-vars">{'{key} {source} {context} {question}'}</span></label>
            <textarea className="textarea" rows="8" value={params.contextTemplate}
              onChange={e => setParam('contextTemplate', e.target.value)} />
            <span className="field-hint">
              チャットが検索結果をLLMへ渡す体裁 (── 資料 S1 ── / 出典キー) に合わせてあります。
              学習時と推論時で入力の形が違うと、覚えた型が本番で発火しません
            </span>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 20 }}>
        <button className="btn primary" onClick={handleStart}
          disabled={busy || selectedIds.length === 0 || (status && !status.enabled)}>
          {busy ? '開始中...' : '🧬 教師データを生成'}
        </button>
        {estimate && (
          <span className="field-hint">
            約 {estimate.passages} パッセージ{params.passageMode !== 'chunks' ? '（ページ単位なら実際のページ数）' : ''}
            {' / '}LLM呼び出し 約 {estimate.calls} 回 / 生成見込み 最大 {estimate.samples} 件
          </span>
        )}
      </div>

      {/* ── ジョブ一覧 ── */}
      {jobs.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🧬</div>
          <div className="empty-title">生成ジョブはありません</div>
          <div className="empty-desc">資料を選んで「教師データを生成」を押してください</div>
        </div>
      ) : jobs.map(j => {
        const pct = j.passagesTotal ? Math.round((j.passagesDone / j.passagesTotal) * 100) : 0;
        return (
          <div key={j.jobId} className="job-item">
            <div className="job-header">
              <span className={`job-status ${j.status}`}>
                {j.status === 'running' && '⚙️ 生成中'}
                {j.status === 'pending' && '⏳ 待機中'}
                {j.status === 'completed' && '✓ 完了'}
                {j.status === 'failed' && '✗ 失敗'}
                {j.status === 'cancelled' && '○ 中止'}
              </span>
              <span className="job-id">{j.title}</span>
              <div className="job-actions">
                <button className="btn small" onClick={() => openSamples(j.jobId)}>
                  {openJobId === j.jobId ? '閉じる' : '🔍 結果を見る'}
                </button>
                {j.status === 'running' && (
                  <button className="btn small danger" onClick={() => jobAction(j.jobId, 'cancel')}>停止</button>
                )}
                {['pending', 'cancelled', 'failed'].includes(j.status) && (
                  <button className="btn small primary" onClick={() => jobAction(j.jobId, 'resume')}>▶ 続きから</button>
                )}
                {j.status !== 'running' && (
                  <>
                    <button className="btn small" onClick={() => jobAction(j.jobId, 'redo')} title="出力を捨てて最初から作り直す">⟳ やり直す</button>
                    <button className="btn small danger" onClick={() => { if (confirm('このジョブと生成結果を削除しますか? (取り込み済みの学習データは残ります)')) jobAction(j.jobId, 'delete'); }}>削除</button>
                  </>
                )}
              </div>
            </div>

            {(j.status === 'running' || j.passagesDone > 0) && (
              <>
                <div className="rt-progress"><div className="rt-progress-fill" style={{ width: `${pct}%` }} /></div>
                <div className="field-hint" style={{ marginBottom: 6 }}>
                  {j.phase || `${j.passagesDone} / ${j.passagesTotal} パッセージ`} ({pct}%)
                </div>
              </>
            )}

            <div className="job-meta">
              <div className="job-meta-row"><span className="job-meta-key">資料:</span><span className="job-meta-val">{j.docs.length} 件</span></div>
              <div className="job-meta-row"><span className="job-meta-key">形式:</span><span className="job-meta-val">{j.params?.mode}</span></div>
              <div className="job-meta-row"><span className="job-meta-key">採用:</span><span className="job-meta-val" style={{ color: 'var(--accent)' }}>{j.accepted}</span></div>
              <div className="job-meta-row"><span className="job-meta-key">不採用:</span><span className="job-meta-val">{j.rejected}</span></div>
              <div className="job-meta-row"><span className="job-meta-key">拒否例:</span><span className="job-meta-val">{j.refusals}</span></div>
              <div className="job-meta-row"><span className="job-meta-key">LLM呼出:</span><span className="job-meta-val">{j.llmCalls}{j.topUpCalls ? ` (追い ${j.topUpCalls})` : ''}</span></div>
              {j.passagesDone > 0 && (
                <div className="job-meta-row"><span className="job-meta-key">1パッセージ:</span>
                  <span className="job-meta-val">{(j.accepted / j.passagesDone).toFixed(1)} 件</span></div>
              )}
              {j.imported > 0 && (
                <div className="job-meta-row"><span className="job-meta-key">取込済:</span><span className="job-meta-val">{j.imported}</span></div>
              )}
            </div>
            {/* 「思ったより採れない」ときに何が落としているかを見せる。
                これが無いと、プロンプトが悪いのか閾値が厳しいのか切り分けられない */}
            {j.rejected > 0 && j.rejectReasons && Object.keys(j.rejectReasons).length > 0 && (
              <div className="field-hint" style={{ marginTop: 4 }}>
                不採用の内訳: {Object.entries(j.rejectReasons).map(([k, v]) => `${RT_REASON_LABEL[k] || k} ${v}`).join(' / ')}
                {j.truncated > 0 && ` ／ 応答が max_tokens で切れた回数 ${j.truncated}（maxTokens を上げるか1パッセージの設問数を減らすと増えます）`}
              </div>
            )}
            {j.error && <div className="field-hint" style={{ color: 'var(--red)' }}>エラー: {j.error}</div>}

            {j.accepted > 0 && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                <select className="select" value={importMode} onChange={e => setImportMode(e.target.value)} style={{ maxWidth: 220 }}>
                  <option value="">形式: ジョブ設定のまま ({j.params?.mode})</option>
                  <option value="closed">知識注入型 (closed)</option>
                  <option value="open">RAG運用型 (open)</option>
                  <option value="both">両方 (both)</option>
                </select>
                <button className="btn small primary" onClick={() => handleImport(j)}>
                  📥 学習データへ取り込む ({j.accepted} 件)
                </button>
                <a className="btn small" href={`/tuning/rag/jobs/${j.jobId}/export?mode=${importMode || (j.params?.mode || 'closed')}`}
                  target="_blank" rel="noopener" download>📤 JSONL</a>
              </div>
            )}

            {openJobId === j.jobId && (
              <div className="rt-samples">
                <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
                  {['accepted', 'rejected', 'all'].map(f => (
                    <button key={f} className={`btn small ${sampleFilter === f ? 'primary' : ''}`}
                      onClick={() => openSamples(j.jobId, f)}>
                      {f === 'accepted' ? '採用' : f === 'rejected' ? '不採用' : 'すべて'}
                      {samples && samples.counts && ` (${samples.counts[f === 'all' ? 'all' : f] ?? 0})`}
                    </button>
                  ))}
                </div>
                {!samples ? <div className="field-hint">読み込み中...</div>
                  : samples.samples.length === 0 ? <div className="field-hint">該当するサンプルはありません</div>
                    : samples.samples.map(s => (
                      <div key={s.id} className={`rt-sample ${s.status}`}>
                        <div className="rt-sample-head">
                          <span className={`rt-badge ${s.status}`}>{s.status === 'accepted' ? '採用' : '不採用'}</span>
                          {s.kind === 'refusal' && <span className="rt-badge refusal">拒否例</span>}
                          <span className="rt-sample-src">{s.source?.label}</span>
                          {s.checks && s.checks.coverage !== undefined && (
                            <span className="rt-sample-src">重なり {s.checks.coverage}</span>
                          )}
                          {s.reason && <span className="rt-sample-reason">{s.reason}</span>}
                          {s.kind !== 'error' && (
                            <button className="btn small" style={{ marginLeft: 'auto' }}
                              onClick={() => toggleSampleStatus(j.jobId, s.id, s.status)}>
                              {s.status === 'accepted' ? '除外する' : '採用する'}
                            </button>
                          )}
                        </div>
                        {s.question && <div className="sample-row"><div className="sample-label user">Q</div><div className="sample-text">{s.question}</div></div>}
                        {s.answer && <div className="sample-row"><div className="sample-label assistant">A</div><div className="sample-text">{s.answer}</div></div>}
                      </div>
                    ))}
                {samples && samples.total > samples.samples.length && (
                  <div className="field-hint">先頭 {samples.samples.length} 件を表示 (全 {samples.total} 件)。全件は JSONL でダウンロードできます</div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
