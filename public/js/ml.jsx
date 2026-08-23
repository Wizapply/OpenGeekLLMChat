const { useState, useEffect, useRef } = React;

function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [tables, setTables] = useState([]);
  const [duckdbAvailable, setDuckdbAvailable] = useState(true);
  const [duckdbHint, setDuckdbHint] = useState('');
  // サイドバー統計（モデル数・画像学習・強化学習などの件数）
  const [stats, setStats] = useState({ models: 0, imageDatasets: 0, imageModels: 0, keypointDatasets: 0, keypointModels: 0, rlModels: 0 });
  const [activeTab, setActiveTab] = useState('tables');
  const [selectedTable, setSelectedTable] = useState(null);
  const [tableSchema, setTableSchema] = useState(null);
  const [previewRows, setPreviewRows] = useState([]);
  const [queryText, setQueryText] = useState('SELECT * FROM ');
  const [queryResult, setQueryResult] = useState(null);
  const [queryError, setQueryError] = useState('');
  const [toast, setToast] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showApiImport, setShowApiImport] = useState(false);

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
    loadTables();
    loadStats();
  }, [authenticated]);

  // サイドバーの件数統計をまとめて取得（失敗してもUIは継続）
  async function loadStats() {
    const count = async (url, key) => {
      try {
        const d = await (await fetch(url)).json();
        return Array.isArray(d[key]) ? d[key].length : 0;
      } catch { return 0; }
    };
    const [models, imageDatasets, imageModels, keypointDatasets, keypointModels, rlModels] = await Promise.all([
      count('/ml/models', 'models'),
      count('/ml/image/datasets', 'datasets'),
      count('/ml/image/custom-models', 'models'),
      count('/ml/image/keypoint/datasets', 'datasets'),
      count('/ml/image/keypoint/custom-models', 'models'),
      count('/ml/rl/models', 'models'),
    ]);
    setStats({ models, imageDatasets, imageModels, keypointDatasets, keypointModels, rlModels });
  }

  async function loadTables() {
    try {
      const data = await (await fetch('/ml/datasets')).json();
      setTables(data.tables || []);
      if (data.duckdbAvailable === false) {
        setDuckdbAvailable(false);
        setDuckdbHint(data.hint || '');
      } else {
        setDuckdbAvailable(true);
      }
    } catch (e) { showToast(`一覧取得失敗: ${e.message}`, 'error'); }
  }

  async function loadTableDetails(name) {
    setSelectedTable(name);
    setTableSchema(null);
    setPreviewRows([]);
    try {
      const [schemaRes, previewRes] = await Promise.all([
        fetch(`/ml/datasets/${encodeURIComponent(name)}/schema`).then(r => r.json()),
        fetch(`/ml/datasets/${encodeURIComponent(name)}/preview?limit=50`).then(r => r.json()),
      ]);
      setTableSchema(schemaRes);
      setPreviewRows(previewRes.rows || []);
    } catch (e) { showToast(`詳細取得失敗: ${e.message}`, 'error'); }
  }

  async function runQuery() {
    setQueryError('');
    setQueryResult(null);
    try {
      const r = await fetch('/ml/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: queryText, limit: 1000 }),
      });
      const data = await r.json();
      if (!r.ok) {
        setQueryError(data.error || `HTTP ${r.status}`);
        return;
      }
      setQueryResult(data);
    } catch (e) { setQueryError(e.message); }
  }

  async function deleteTable(name) {
    if (!confirm(`テーブル「${name}」を完全に削除します。本当によろしいですか？`)) return;
    try {
      const r = await fetch(`/ml/datasets/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      showToast(`テーブル「${name}」を削除しました`, 'success');
      if (selectedTable === name) {
        setSelectedTable(null);
        setTableSchema(null);
        setPreviewRows([]);
      }
      loadTables();
    } catch (e) { showToast(`削除失敗: ${e.message}`, 'error'); }
  }

  function showToast(msg, type = 'info') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  if (!authenticated) {
    return <AuthGate authRequired={authRequired} onAuth={() => setAuthenticated(true)} />;
  }

  return (
    <div className="app-layout">
      <div className={`sidebar-overlay ${sidebarOpen ? 'open' : ''}`} onClick={() => setSidebarOpen(false)} />
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <button className="sidebar-close-btn" onClick={() => setSidebarOpen(false)} title="サイドバーを閉じる">×</button>
        <div className="sidebar-header">
          <div className="logo">
            <div className="logo-icon" />
            <div className="logo-text">
              <div className="logo-main">OpenGeekLLM</div>
              <div className="logo-sub">機械学習 (ML)</div>
            </div>
          </div>
        </div>
        <div className="nav-links">
          <a className="nav-link" href="/">💬 チャット</a>
          <a className="nav-link" href="/tuning.html">🧠 ファインチューニング</a>
          <a className="nav-link" href="/rag.html">📚 永続RAG(OCR、HTML登録)</a>
        </div>
        <div className="sidebar-section">
          <div className="section-title">統計</div>
          <div className="stats-card">
            <div className="stats-card-label">テーブル数</div>
            <div className="stats-card-value accent">{tables.length}</div>
          </div>
          <div className="stats-card">
            <div className="stats-card-label">合計行数</div>
            <div className="stats-card-value">{tables.reduce((s, t) => s + (t.rowCount || 0), 0).toLocaleString()}</div>
          </div>
          <div className="stats-card">
            <div className="stats-card-label">🧠 モデル数</div>
            <div className="stats-card-value">{stats.models}</div>
          </div>
          <div className="stats-card">
            <div className="stats-card-label">🖼️ 画像データセット</div>
            <div className="stats-card-value">{stats.imageDatasets}</div>
          </div>
          <div className="stats-card">
            <div className="stats-card-label">🖼️ 画像学習モデル</div>
            <div className="stats-card-value">{stats.imageModels}</div>
          </div>
          <div className="stats-card">
            <div className="stats-card-label">🖐️ キーポイントデータセット</div>
            <div className="stats-card-value">{stats.keypointDatasets}</div>
          </div>
          <div className="stats-card">
            <div className="stats-card-label">🖐️ キーポイントモデル</div>
            <div className="stats-card-value">{stats.keypointModels}</div>
          </div>
          <div className="stats-card">
            <div className="stats-card-label">🎮 強化学習エージェント</div>
            <div className="stats-card-value">{stats.rlModels}</div>
          </div>
          {!duckdbAvailable && (
            <div className="stats-card">
              <div className="stats-card-label">⚠️ DuckDB 未導入</div>
              <div className="stats-card-value orange" style={{fontSize: 11, lineHeight: 1.4}}>{duckdbHint}</div>
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
          <div className="main-title">🤖 機械学習</div>
        </header>
        <div className="tab-bar">
          <button className={`tab ${activeTab === 'tables' ? 'active' : ''}`} onClick={() => setActiveTab('tables')}>🗂️ データテーブル</button>
          <button className={`tab ${activeTab === 'models' ? 'active' : ''}`} onClick={() => setActiveTab('models')}>🧠 モデル学習</button>
          <button className={`tab ${activeTab === 'imagetrain' ? 'active' : ''}`} onClick={() => setActiveTab('imagetrain')}>🖼️ 画像学習</button>
          <button className={`tab ${activeTab === 'rl' ? 'active' : ''}`} onClick={() => setActiveTab('rl')}>🎮 強化学習</button>
          <button className={`tab ${activeTab === 'api' ? 'active' : ''}`} onClick={() => setActiveTab('api')}>📡 API(外部連携)</button>
          <button className={`tab ${activeTab === 'query' ? 'active' : ''}`} onClick={() => setActiveTab('query')}>🔍 SQLクエリ</button>
        </div>
        <div className="main-body">
          {!duckdbAvailable && (
            <div className="warn-banner">
              <strong>⚠️ DuckDB がインストールされていません</strong><br />
              サーバー側で <code>npm install duckdb</code> を実行し、サービスを再起動してください。
            </div>
          )}

          {activeTab === 'tables' && (
            <>
              <div className="toolbar">
                <button className="btn primary" onClick={() => setShowImport(true)} disabled={!duckdbAvailable}>
                  📥 CSVをインポート
                </button>
                <button className="btn" onClick={() => setShowApiImport(true)} disabled={!duckdbAvailable}>
                  🌐 Web API をインポート
                </button>
                <button className="btn" onClick={loadTables}>🔄 更新</button>
              </div>

              <div className="ml-layout">
                <div className="ml-table-list">
                  {tables.length === 0 ? (
                    <div className="empty-state">テーブルがありません。<br />「📥 CSVをインポート」から開始してください。</div>
                  ) : tables.map(t => (
                    <div
                      key={t.name}
                      className={`ml-table-item ${selectedTable === t.name ? 'selected' : ''}`}
                      onClick={() => loadTableDetails(t.name)}
                    >
                      <div className="ml-table-name">🗂️ {t.name}</div>
                      <div className="ml-table-meta">{t.rowCount.toLocaleString()} 行</div>
                      {t.description && <div className="ml-table-desc">{t.description}</div>}
                    </div>
                  ))}
                </div>

                <div className="ml-table-detail">
                  {selectedTable ? (
                    <TableDetailView
                      name={selectedTable}
                      schema={tableSchema}
                      preview={previewRows}
                      onDelete={() => deleteTable(selectedTable)}
                      onQueryHere={() => {
                        setQueryText(`SELECT * FROM ${selectedTable} LIMIT 100`);
                        setActiveTab('query');
                      }}
                    />
                  ) : (
                    <div className="empty-state">← 左のテーブルを選択してください</div>
                  )}
                </div>
              </div>
            </>
          )}

          {activeTab === 'query' && (
            <QueryView
              sql={queryText}
              setSql={setQueryText}
              result={queryResult}
              error={queryError}
              onRun={runQuery}
              tables={tables}
            />
          )}
          {activeTab === 'models' && (
            <ModelsView tables={tables} showToast={showToast} />
          )}
          {activeTab === 'imagetrain' && (
            <ImageTrainView showToast={showToast} />
          )}
          {activeTab === 'rl' && (
            <RLView showToast={showToast} />
          )}
          {activeTab === 'api' && (
            <ApiUsageView showToast={showToast} />
          )}
        </div>
      </main>

      {showImport && <ImportDialog onClose={() => setShowImport(false)} onDone={() => { setShowImport(false); loadTables(); }} showToast={showToast} />}
      {showApiImport && <ApiImportDialog onClose={() => setShowApiImport(false)} onDone={() => { setShowApiImport(false); loadTables(); }} showToast={showToast} />}
      {toast && <div className={`toast ${toast.type}`}>{toast.msg}</div>}
    </div>
  );
}

// ─── テーブル詳細 ───
function TableDetailView({ name, schema, preview, onDelete, onQueryHere }) {
  if (!schema) return <div className="empty-state">読み込み中...</div>;
  return (
    <div className="ml-detail">
      <div className="ml-detail-header">
        <h2>🗂️ {name}</h2>
        <div className="ml-detail-actions">
          <button className="btn small" onClick={onQueryHere}>🔍 SQLで開く</button>
          <button className="btn small danger" onClick={onDelete}>🗑️ 削除</button>
        </div>
      </div>

      {schema.description && (
        <div className="ml-section" style={{color: 'var(--text-secondary)', fontSize: 13}}>
          📝 {schema.description}
        </div>
      )}

      {schema.importedFrom === 'api' && schema.apiUrl && (
        <div className="ml-section" style={{
          background: 'var(--bg-tertiary)',
          padding: 10,
          borderRadius: 4,
          fontSize: 12,
          color: 'var(--text-secondary)',
        }}>
          <div style={{marginBottom: 4}}>
            <strong style={{color: 'var(--accent)'}}>🌐 Web API インポート元</strong>
          </div>
          <div style={{fontFamily: 'var(--font-mono)', fontSize: 11, wordBreak: 'break-all'}}>
            <span style={{color: 'var(--text-muted)'}}>{schema.apiMethod || 'GET'}</span> {schema.apiUrl}
            {schema.apiJsonPath && <div>
              <span style={{color: 'var(--text-muted)'}}>jsonPath:</span> {schema.apiJsonPath}
            </div>}
          </div>
        </div>
      )}

      {schema.importedFrom === 'csv' && (
        <div className="ml-section" style={{color: 'var(--text-muted)', fontSize: 11}}>
          📥 CSVから取り込み
        </div>
      )}

      <div className="ml-section">
        <h3>スキーマ</h3>
        <table className="ml-schema-table">
          <thead>
            <tr><th>カラム名</th><th>型</th><th>NULL許可</th></tr>
          </thead>
          <tbody>
            {schema.columns.map(c => (
              <tr key={c.name}>
                <td className="mono">{c.name}</td>
                <td>{c.type}</td>
                <td>{c.nullable ? '◯' : '✕'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="ml-section">
        <h3>プレビュー (先頭50行)</h3>
        <ResultTable rows={preview} columns={schema.columns.map(c => c.name)} />
      </div>
    </div>
  );
}

// ─── 結果テーブル ───
function ResultTable({ rows, columns }) {
  if (!rows || rows.length === 0) return <div className="empty-state">データがありません</div>;
  const cols = columns || Object.keys(rows[0]);
  return (
    <div className="ml-result-wrap">
      <table className="ml-result-table">
        <thead>
          <tr>{cols.map(c => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map(c => <td key={c} className={typeof r[c] === 'number' ? 'num' : ''}>{formatCell(r[c])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatCell(v) {
  if (v === null || v === undefined) return <span className="null">NULL</span>;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return v.toLocaleString();
  return String(v);
}

// ─── 画像物体検出ビュー (torchvision COCO事前学習) ───
// ─── 画像学習ビュー (Phase 2: データセット + アノテーション + 学習) ───
function ImageTrainView({ showToast }) {
  const [task, setTask] = useState('detect');      // 'detect'=物体検出 | 'keypoint'=キーポイント
  const [subTab, setSubTab] = useState('detect');  // detect | datasets | annotate(ボタンからのみ) | train
  const [datasets, setDatasets] = useState([]);
  const [selectedDataset, setSelectedDataset] = useState(null);  // データセット名
  const [datasetDetail, setDatasetDetail] = useState(null);      // 詳細 (画像一覧含む)

  function loadDatasets() {
    fetch('/ml/image/datasets')
      .then(r => r.ok ? r.json() : { datasets: [] })
      .then(d => setDatasets(d.datasets || []))
      .catch(() => {});
  }
  useEffect(() => { loadDatasets(); }, []);

  function loadDatasetDetail(name) {
    return fetch(`/ml/image/datasets/${name}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) { setDatasetDetail(d.dataset); setSelectedDataset(name); } })
      .catch(() => {});
  }

  // データセット一覧と、選択中データセットの詳細を両方リロード
  // (画像追加・削除の後に呼ぶ。アノテーション画面が古い情報を表示しないように)
  function reloadAll(name) {
    loadDatasets();
    const target = name || selectedDataset;
    if (target) loadDatasetDetail(target);
  }

  return (
    <div className="image-train-view">
      {/* タスク選択: 物体検出 (矩形) と キーポイント (関節など) を同じ「画像学習」内で切替 */}
      <div className="image-train-tasktabs">
        <button className={`tasktab ${task === 'detect' ? 'active' : ''}`} onClick={() => setTask('detect')}>📦 物体検出</button>
        <button className={`tasktab ${task === 'keypoint' ? 'active' : ''}`} onClick={() => setTask('keypoint')}>🖐️ キーポイント</button>
      </div>

      {task === 'keypoint' ? (
        <KeypointView showToast={showToast} />
      ) : (
        <>
          <div className="image-train-subtabs">
            <button className={`subtab ${subTab === 'detect' ? 'active' : ''}`} onClick={() => setSubTab('detect')}>🔍 検出</button>
            <button className={`subtab ${subTab === 'datasets' ? 'active' : ''}`} onClick={() => setSubTab('datasets')}>📊 データセット</button>
            <button className={`subtab ${subTab === 'train' ? 'active' : ''}`} onClick={() => setSubTab('train')}>🚀 学習</button>
          </div>

          {subTab === 'detect' && (
            <ImageDetectView showToast={showToast} />
          )}
          {subTab === 'datasets' && (
            <DatasetManager
              datasets={datasets}
              onReload={loadDatasets}
              onReloadDataset={(name) => reloadAll(name)}
              onSelect={(name) => { loadDatasetDetail(name); setSubTab('annotate'); }}
              showToast={showToast}
            />
          )}
          {subTab === 'annotate' && selectedDataset && datasetDetail && (
            <AnnotateView
              datasetName={selectedDataset}
              dataset={datasetDetail}
              onReload={() => reloadAll(selectedDataset)}
              onBack={() => setSubTab('datasets')}
              showToast={showToast}
            />
          )}
          {subTab === 'train' && (
            <ImageTrainRunner datasets={datasets} onReload={loadDatasets} showToast={showToast} />
          )}
        </>
      )}
    </div>
  );
}

// データセット管理 (一覧・作成・削除・画像追加)
function DatasetManager({ datasets, onReload, onReloadDataset, onSelect, showToast }) {
  const [newName, setNewName] = useState('');
  const [newClasses, setNewClasses] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  async function createDataset() {
    const classes = newClasses.split(',').map(c => c.trim()).filter(Boolean);
    if (!newName.trim()) { setError('データセット名を入力してください'); return; }
    if (classes.length === 0) { setError('クラス名を最低1つ (カンマ区切り)'); return; }
    setCreating(true);
    setError('');
    try {
      const res = await fetch('/ml/image/datasets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), classes }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      showToast(`データセット「${newName}」を作成しました`);
      setNewName(''); setNewClasses('');
      onReload();
    } catch (e) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  }

  async function deleteDataset(name) {
    if (!confirm(`データセット「${name}」を削除しますか? (画像・アノテーションも全て削除されます)`)) return;
    try {
      const res = await fetch(`/ml/image/datasets/${name}`, { method: 'DELETE' });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
      showToast('削除しました');
      onReload();
    } catch (e) {
      showToast(`削除失敗: ${e.message}`);
    }
  }

  // クライアント側で対応外形式を事前判定する (TIFF/HEIC等はブラウザで表示できないため拒否)
  // 拡張子 + MIMEタイプの両方をチェック (ブラウザによっては MIME が空のことがある)
  const SUPPORTED_EXTS_RE = /\.(jpg|jpeg|png|bmp|webp)$/i;
  const UNSUPPORTED_EXTS_RE = /\.(tif|tiff|heic|heif|raw|cr2|nef|arw|dng|gif)$/i;
  function checkImageFile(file) {
    const name = file.name || '';
    if (UNSUPPORTED_EXTS_RE.test(name)) {
      return `${name}: ${name.match(/\.([^.]+)$/)?.[1]?.toUpperCase() || 'この形式'} はブラウザで表示できないため非対応 (JPEG/PNGに変換してください)`;
    }
    if (!SUPPORTED_EXTS_RE.test(name)) {
      // 拡張子が分からない場合も MIME で許可されたもののみ受ける
      if (!file.type || !/image\/(jpeg|png|bmp|webp)/.test(file.type)) {
        return `${name}: 対応していない形式です (JPEG / PNG / BMP / WebP のみ)`;
      }
    }
    return null;  // OK
  }

  async function addImages(name, files) {
    if (!files || files.length === 0) return;
    const images = [];
    const skipped = [];
    for (const file of files) {
      if (!file.type.startsWith('image/') && !SUPPORTED_EXTS_RE.test(file.name)) {
        skipped.push(`${file.name}: 画像ファイルではありません`);
        continue;
      }
      const err = checkImageFile(file);
      if (err) { skipped.push(err); continue; }
      const data = await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
      });
      images.push({ name: file.name, data });
    }
    if (skipped.length > 0) {
      // 最初の理由だけトーストで通知 (件数も)
      showToast(`${skipped.length}件スキップ: ${skipped[0]}`);
    }
    if (images.length === 0) {
      if (skipped.length === 0) showToast('画像ファイルがありません');
      return;
    }
    try {
      const res = await fetch(`/ml/image/datasets/${name}/images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      const addedCount = (d.added || []).length;
      const errCount = (d.errors || []).length;
      if (addedCount > 0) {
        showToast(`${addedCount}枚の画像を追加しました${errCount ? ` (${errCount}件失敗)` : ''}`);
      } else {
        showToast(`画像追加に失敗しました${errCount ? `: ${d.errors[0].error}` : ''}`);
      }
      // 一覧 + 選択中データセットの詳細を両方更新
      if (onReloadDataset) onReloadDataset(name);
      else onReload();
    } catch (e) {
      showToast(`画像追加失敗: ${e.message}`);
    }
  }

  // CSV (ロング形式) から矩形アノテーションをインポート (ファイル名で既存画像に紐付け)
  async function importCsv(name, file) {
    if (!file) return;
    try {
      const text = await file.text();
      const res = await fetch(`/ml/image/datasets/${name}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'csv', data: text }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      let msg = `CSVインポート: ${d.boxCount}矩形 / ${d.appliedImages}画像`;
      if (d.skipped) msg += ` (スキップ${d.skipped})`;
      showToast(msg);
      if (d.errors && d.errors.length) showToast(`注意: ${d.errors[0]}`);
      if (onReloadDataset) onReloadDataset(name); else onReload();
    } catch (e) {
      showToast(`CSVインポート失敗: ${e.message}`);
    }
  }

  return (
    <div className="dataset-manager">
      <div className="dataset-create">
        <h3>新規データセット作成</h3>
        <div className="dataset-create-row">
          <input className="ml-input" placeholder="データセット名 (英数字)" value={newName} onChange={e => setNewName(e.target.value)} />
          <input className="ml-input" placeholder="クラス名 (カンマ区切り: cat, dog, bird)" value={newClasses} onChange={e => setNewClasses(e.target.value)} style={{ flex: 2 }} />
          <button className="btn primary" onClick={createDataset} disabled={creating}>作成</button>
        </div>
        {error && <div className="warn-banner">{error}</div>}
      </div>

      <div className="dataset-list">
        <h3>データセット一覧 ({datasets.length})</h3>
        {datasets.length === 0 && <div className="empty-state">データセットがありません。上で作成してください。</div>}
        {datasets.map(ds => (
          <div key={ds.name} className="dataset-card">
            <div className="dataset-card-info">
              <div className="dataset-card-name">{ds.name}</div>
              <div className="dataset-card-meta">
                クラス: {ds.classes.join(', ')} · 画像 {ds.imageCount}枚 · アノテーション済 {ds.annotatedCount}枚
              </div>
            </div>
            <div className="dataset-card-actions">
              <label className="btn small">
                画像追加
                <input type="file" accept="image/jpeg,image/png,image/bmp,image/webp,.jpg,.jpeg,.png,.bmp,.webp" multiple style={{ display: 'none' }}
                  onChange={e => addImages(ds.name, Array.from(e.target.files))} />
              </label>
              <label className="btn small" title="ロング形式CSV: filename,class,x1,y1,x2,y2 (先に画像を追加しておき、ファイル名で紐付け)">
                📄 CSV取込
                <input type="file" accept=".csv,text/csv" style={{ display: 'none' }}
                  onChange={e => { if (e.target.files[0]) importCsv(ds.name, e.target.files[0]); e.target.value = ''; }} />
              </label>
              <button className="btn small primary" onClick={() => onSelect(ds.name)}>✏️ アノテーション</button>
              <button className="btn small danger" onClick={() => deleteDataset(ds.name)}>削除</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// アノテーションビュー (矩形ドラッグ描画 + ラベル付け + インポート)
function AnnotateView({ datasetName, dataset, onReload, onBack, showToast }) {
  const [currentIdx, setCurrentIdx] = useState(0);
  const [boxes, setBoxes] = useState([]);       // 現在の画像の矩形 [{classIndex,x1,y1,x2,y2}]
  const [activeClass, setActiveClass] = useState(0);
  const [drawing, setDrawing] = useState(null);  // ドラッグ中 {x1,y1,x2,y2}
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 });
  const [saving, setSaving] = useState(false);
  const [drawMode, setDrawMode] = useState('drag');  // 'drag' | 'point'
  const [pointSize, setPointSize] = useState(60);    // 点モードで生成する矩形の一辺(px)
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const wrapRef = useRef(null);

  const COLORS = ['#ff3b30', '#34c759', '#007aff', '#ff9500', '#af52de', '#ff2d55', '#5ac8fa', '#ffcc00'];
  const images = dataset.images || [];
  const currentImage = images[currentIdx];

  // 画像が変わったら既存のboxを読み込む (前の画像の矩形が残らないよう必ずリセット)
  // 依存は currentIdx と画像ID。currentImage オブジェクトの参照変化ではなく
  // 「実際に別の画像になったか」で判定し、未保存の編集が混入しないようにする。
  const currentImageId = currentImage ? currentImage.id : null;
  useEffect(() => {
    if (currentImage) {
      setBoxes(currentImage.boxes ? currentImage.boxes.map(b => ({ ...b })) : []);
    } else {
      setBoxes([]);
    }
    setDrawing(null);  // 描きかけも破棄
  }, [currentIdx, currentImageId]);

  // canvas 描画 (画像 + 矩形 + ドラッグ中の矩形)
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const draw = () => {
      const naturalW = img.naturalWidth, naturalH = img.naturalHeight;
      if (!naturalW) return;
      // 表示幅は最大800px
      const dispW = Math.min(naturalW, 800);
      const scale = dispW / naturalW;
      canvas.width = naturalW;
      canvas.height = naturalH;
      canvas.style.width = dispW + 'px';
      canvas.style.height = (naturalH * scale) + 'px';
      setImgSize({ w: naturalW, h: naturalH });
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      // 確定した矩形
      boxes.forEach(b => {
        const color = COLORS[b.classIndex % COLORS.length];
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(2, naturalW / 300);
        ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
        const label = dataset.classes[b.classIndex] || `class${b.classIndex}`;
        const fs2 = Math.max(14, naturalW / 45);
        ctx.font = `bold ${fs2}px sans-serif`;
        ctx.fillStyle = color;
        const tw = ctx.measureText(label).width;
        ctx.fillRect(b.x1, Math.max(0, b.y1 - fs2 - 4), tw + 8, fs2 + 4);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, b.x1 + 4, Math.max(fs2, b.y1 - 3));
      });
      // ドラッグ中の矩形
      if (drawing) {
        ctx.strokeStyle = COLORS[activeClass % COLORS.length];
        ctx.lineWidth = Math.max(2, naturalW / 300);
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(drawing.x1, drawing.y1, drawing.x2 - drawing.x1, drawing.y2 - drawing.y1);
        ctx.setLineDash([]);
      }
    };
    if (img.complete) draw();
    else img.onload = draw;
  }, [boxes, drawing, currentIdx, activeClass, dataset.classes]);

  // canvas 座標をnatural座標に変換
  function toCanvasCoord(e) {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  // クリック位置を中心に、pointSize 四方の矩形を生成 (画像範囲内にクランプ)
  function addPointBox(cx, cy) {
    const half = pointSize / 2;
    const W = imgSize.w || (canvasRef.current ? canvasRef.current.width : 0);
    const H = imgSize.h || (canvasRef.current ? canvasRef.current.height : 0);
    let x1 = cx - half, y1 = cy - half, x2 = cx + half, y2 = cy + half;
    // 画像範囲内に収める
    if (W) { x1 = Math.max(0, x1); x2 = Math.min(W, x2); }
    if (H) { y1 = Math.max(0, y1); y2 = Math.min(H, y2); }
    setBoxes(prev => [...prev, { classIndex: activeClass, x1, y1, x2, y2 }]);
  }

  function onMouseDown(e) {
    const { x, y } = toCanvasCoord(e);
    if (drawMode === 'point') {
      // 点モード: クリックした位置に固定サイズの矩形を即生成
      addPointBox(x, y);
      return;
    }
    setDrawing({ x1: x, y1: y, x2: x, y2: y });
  }
  function onMouseMove(e) {
    if (drawMode === 'point') return;  // 点モードはドラッグしない
    if (!drawing) return;
    const { x, y } = toCanvasCoord(e);
    setDrawing(prev => ({ ...prev, x2: x, y2: y }));
  }
  function onMouseUp() {
    if (drawMode === 'point') return;
    if (!drawing) return;
    const b = drawing;
    // 最小サイズチェック
    if (Math.abs(b.x2 - b.x1) > 5 && Math.abs(b.y2 - b.y1) > 5) {
      setBoxes(prev => [...prev, {
        classIndex: activeClass,
        x1: Math.min(b.x1, b.x2), y1: Math.min(b.y1, b.y2),
        x2: Math.max(b.x1, b.x2), y2: Math.max(b.y1, b.y2),
      }]);
    }
    setDrawing(null);
  }

  function removeBox(i) {
    setBoxes(prev => prev.filter((_, j) => j !== i));
  }

  async function saveBoxes() {
    if (!currentImage) return;
    setSaving(true);
    try {
      const res = await fetch(`/ml/image/datasets/${datasetName}/annotations/${currentImage.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boxes }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      showToast(`保存しました (${d.boxCount}個の矩形)`);
      onReload();
    } catch (e) {
      showToast(`保存失敗: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  function gotoImage(idx) {
    if (idx < 0 || idx >= images.length) return;
    // 移動先の画像の矩形を即座にセット (useEffect を待たず確実に切り替える)
    const next = images[idx];
    setBoxes(next && next.boxes ? next.boxes.map(b => ({ ...b })) : []);
    setCurrentIdx(idx);
    setDrawing(null);
  }

  // キーボードショートカット: ← → で画像送り、S で保存
  // テキスト入力中やドラッグ中は無効。依存する値が変わるたびにリスナーを貼り直す
  useEffect(() => {
    function onKeyDown(e) {
      // input/textarea/select にフォーカスがある時は無視 (誤発火防止)
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
      // 修飾キー併用は無視 (ブラウザのショートカットを邪魔しない)
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // 矩形ドラッグ中は無視
      if (drawing) return;

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        gotoImage(currentIdx + 1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        gotoImage(currentIdx - 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!saving) saveBoxes();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [currentIdx, images.length, drawing, saving, boxes]);

  // 画像を1枚削除 (アノテーションも一緒に削除される)
  async function deleteImage(im, idx) {
    const imName = im.originalName || im.file;
    const hasBoxes = (im.boxes || []).length > 0 || (idx === currentIdx && boxes.length > 0);
    const msg = hasBoxes
      ? `画像「${imName}」を削除しますか?\nアノテーションも一緒に削除されます。`
      : `画像「${imName}」を削除しますか?`;
    if (!confirm(msg)) return;
    try {
      const res = await fetch(`/ml/image/datasets/${datasetName}/images/${im.id}`, { method: 'DELETE' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      showToast(`画像を削除しました`);
      // 削除した画像が現在表示中なら、安全な位置にカーソル移動
      if (idx === currentIdx) {
        const newLen = images.length - 1;
        const nextIdx = idx >= newLen ? Math.max(0, newLen - 1) : idx;
        setCurrentIdx(nextIdx);
        setBoxes([]);  // 一旦空に (reloadで上書きされる)
        setDrawing(null);
      } else if (idx < currentIdx) {
        // 削除した位置が現在より前なら、インデックスを1つ戻す (同じ画像を見続けるため)
        setCurrentIdx(currentIdx - 1);
      }
      onReload();
    } catch (e) {
      showToast(`削除失敗: ${e.message}`);
    }
  }

  // アノテーション画面から直接画像を追加 (空データセットでもここで足せる)
  async function addImagesHere(files) {
    if (!files || files.length === 0) return;
    // 対応外形式 (TIFF/HEIC等) は事前に拒否
    const SUPPORTED = /\.(jpg|jpeg|png|bmp|webp)$/i;
    const UNSUPPORTED = /\.(tif|tiff|heic|heif|raw|cr2|nef|arw|dng|gif)$/i;
    const imgs = [];
    const skipped = [];
    for (const file of files) {
      const name = file.name || '';
      if (UNSUPPORTED.test(name)) {
        skipped.push(`${name}: 非対応形式`); continue;
      }
      if (!SUPPORTED.test(name) && !/image\/(jpeg|png|bmp|webp)/.test(file.type || '')) {
        skipped.push(`${name}: 画像ファイルではありません`); continue;
      }
      const data = await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
      });
      imgs.push({ name: file.name, data });
    }
    if (skipped.length > 0) showToast(`${skipped.length}件スキップ: ${skipped[0]}`);
    if (imgs.length === 0) {
      if (skipped.length === 0) showToast('画像ファイルがありません');
      return;
    }
    try {
      const res = await fetch(`/ml/image/datasets/${datasetName}/images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: imgs }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      showToast(`${(d.added || []).length}枚の画像を追加しました`);
      onReload();  // datasetDetail を再取得 → images が増える
    } catch (e) {
      showToast(`画像追加失敗: ${e.message}`);
    }
  }

  if (images.length === 0) {
    return (
      <div className="annotate-view">
        <div className="annotate-back-bar">
          <button className="btn small" onClick={onBack}>← データセット一覧へ</button>
          <span className="annotate-dataset-name">{datasetName}</span>
        </div>
        <div className="empty-state" style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
          <div>このデータセットには画像がありません。</div>
          <label className="btn primary">
            📁 画像を追加
            <input type="file" accept="image/jpeg,image/png,image/bmp,image/webp,.jpg,.jpeg,.png,.bmp,.webp" multiple style={{ display: 'none' }}
              onChange={e => addImagesHere(Array.from(e.target.files))} />
          </label>
        </div>
      </div>
    );
  }

  return (
    <div className="annotate-view">
      <div className="annotate-back-bar">
        <button className="btn small" onClick={onBack}>← データセット一覧へ</button>
        <span className="annotate-dataset-name">{datasetName} ({dataset.classes.length}クラス)</span>
      </div>
      <div className="annotate-toolbar">
        <div className="annotate-classes">
          <span className="annotate-label">ラベル:</span>
          {dataset.classes.map((cls, i) => (
            <button key={i}
              className={`annotate-class-btn ${activeClass === i ? 'active' : ''}`}
              style={{ borderColor: COLORS[i % COLORS.length], ...(activeClass === i ? { background: COLORS[i % COLORS.length], color: '#fff' } : {}) }}
              onClick={() => setActiveClass(i)}>
              {cls}
            </button>
          ))}
        </div>
        <div className="annotate-nav">
          <button className="btn small" onClick={() => gotoImage(currentIdx - 1)} disabled={currentIdx === 0}>◀ 前</button>
          <span className="annotate-counter">{currentIdx + 1} / {images.length}</span>
          <button className="btn small" onClick={() => gotoImage(currentIdx + 1)} disabled={currentIdx === images.length - 1}>次 ▶</button>
          <label className="btn small">
            ＋画像
            <input type="file" accept="image/jpeg,image/png,image/bmp,image/webp,.jpg,.jpeg,.png,.bmp,.webp" multiple style={{ display: 'none' }}
              onChange={e => addImagesHere(Array.from(e.target.files))} />
          </label>
        </div>
      </div>

      <div className="annotate-modebar">
        <span className="annotate-label">入力方式:</span>
        <button className={`annotate-mode-btn ${drawMode === 'drag' ? 'active' : ''}`} onClick={() => setDrawMode('drag')}>
          ⬚ ドラッグで矩形
        </button>
        <button className={`annotate-mode-btn ${drawMode === 'point' ? 'active' : ''}`} onClick={() => setDrawMode('point')}>
          ⊙ 点で矩形
        </button>
        {drawMode === 'point' && (
          <span className="annotate-pointsize">
            サイズ:
            <input type="number" min="4" max="300" value={pointSize}
              onChange={e => {
                const v = parseInt(e.target.value);
                if (Number.isFinite(v)) setPointSize(Math.min(300, Math.max(4, v)));
              }}
              style={{ width: 56, margin: '0 4px', padding: '2px 4px' }} className="ml-input" />
            px
            <input type="range" min="4" max="300" step="1" value={pointSize}
              onChange={e => setPointSize(parseInt(e.target.value))} style={{ verticalAlign: 'middle', marginLeft: 6 }} />
          </span>
        )}
      </div>

      <div className="annotate-hint">
        {drawMode === 'drag'
          ? <>画像上でドラッグして矩形を描画 → 選択中のラベル「{dataset.classes[activeClass]}」が付きます。</>
          : <>画像上をクリックすると、その位置に {pointSize}px 四方の矩形 (ラベル「{dataset.classes[activeClass]}」) を生成します。サイズは下のリストから後で調整も可能。</>
        }
        <strong> ショートカット: ← → 画像送り / ↑ で保存</strong>
      </div>

      <div className="annotate-canvas-wrap" ref={wrapRef}>
        <img ref={imgRef} src={`/ml/image/datasets/${datasetName}/images/${currentImage.file}`} style={{ display: 'none' }} alt="annotate" crossOrigin="anonymous" />
        <canvas ref={canvasRef} className="annotate-canvas"
          style={{ cursor: drawMode === 'point' ? 'cell' : 'crosshair' }}
          onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp} />
      </div>

      <div className="annotate-boxes">
        <div className="annotate-boxes-header">
          <span>矩形 ({boxes.length}個)</span>
          <button className="btn small primary" onClick={saveBoxes} disabled={saving}>{saving ? '保存中...' : '💾 保存'}</button>
        </div>
        {boxes.map((b, i) => (
          <div key={i} className="annotate-box-item">
            <span className="annotate-box-class" style={{ color: COLORS[b.classIndex % COLORS.length] }}>
              {dataset.classes[b.classIndex]}
            </span>
            <span className="annotate-box-coord">[{Math.round(b.x1)},{Math.round(b.y1)}]-[{Math.round(b.x2)},{Math.round(b.y2)}]</span>
            <button className="annotate-box-remove" onClick={() => removeBox(i)}>×</button>
          </div>
        ))}
      </div>

      <div className="annotate-gallery">
        <div className="annotate-gallery-header">
          画像一覧 ({images.length}枚 · アノテーション済 {images.filter((im, i) => i === currentIdx ? boxes.length > 0 : (im.boxes || []).length > 0).length}枚)
        </div>
        <div className="annotate-gallery-grid">
          {images.map((im, i) => {
            // 現在編集中の画像は未保存の boxes を反映、それ以外は保存済みの boxes
            const boxCount = i === currentIdx ? boxes.length : (im.boxes || []).length;
            return (
              <div key={im.id}
                className={`annotate-thumb ${i === currentIdx ? 'active' : ''}`}
                onClick={() => gotoImage(i)}
                title={`${im.originalName || im.file} (矩形 ${boxCount}個)`}>
                <img src={`/ml/image/datasets/${datasetName}/images/${im.file}`} alt={`img${i}`} loading="lazy" />
                <span className={`annotate-thumb-badge ${boxCount > 0 ? 'has-box' : ''}`}>{boxCount}</span>
                <span className="annotate-thumb-idx">{i + 1}</span>
                <button className="annotate-thumb-delete"
                  onClick={(e) => { e.stopPropagation(); deleteImage(im, i); }}
                  title="この画像を削除">×</button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// 学習実行ビュー
// カスタムモデルを外部APIで使う方法を表示 (APIタブで使用)
function CustomModelApiHelp({ host, token }) {
  const origin = host || window.location.origin;
  const tk = token || '<APIトークン>';
  const pyExample = `import requests, base64

# 画像を base64 に変換
with open("test.jpg", "rb") as f:
    img_b64 = base64.b64encode(f.read()).decode()

resp = requests.post(
    "${origin}/ml/image/detect",
    headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer ${tk}",  # ml:read 権限
    },
    verify=False,  # 自己署名証明書の場合
    json={
        "image": img_b64,
        "customModel": "my_detector",  # カスタムモデル名 (COCOなら "model" を使う)
        "threshold": 0.5,
    },
)
print(resp.json())
# → {"detections": [{"label": "...", "score": 0.9, "box": {...}}], "count": N, "device": "cuda"}`;

  return (
    <div className="api-help-box">
      <div className="api-help-title">📡 Python から画像検出を呼ぶ</div>
      <pre className="api-help-code">{pyExample}</pre>
    </div>
  );
}

function ImageTrainRunner({ datasets, onReload, showToast }) {
  const [baseModels, setBaseModels] = useState([]);
  const [datasetName, setDatasetName] = useState('');
  const [modelName, setModelName] = useState('');
  const [baseModel, setBaseModel] = useState('fasterrcnn_resnet50_fpn');
  const [epochs, setEpochs] = useState(10);
  const [batchSize, setBatchSize] = useState(2);
  const [running, setRunning] = useState(false);
  const [trainLog, setTrainLog] = useState('');
  const [recentJobs, setRecentJobs] = useState([]);
  const [customModels, setCustomModels] = useState([]);
  const [downloading, setDownloading] = useState(null);  // ダウンロード中のモデル名
  const pollRef = useRef(null);

  useEffect(() => {
    fetch('/ml/image/train/models').then(r => r.json()).then(d => setBaseModels(d.baseModels || [])).catch(() => {});
    loadStatus();
    loadCustomModels();
    if (onReload) onReload();  // 学習タブを開いたら最新のデータセット一覧 (annotatedCount) を取得
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  function loadCustomModels() {
    fetch('/ml/image/custom-models').then(r => r.json()).then(d => setCustomModels(d.models || [])).catch(() => {});
  }

  function loadStatus() {
    fetch('/ml/image/train/status').then(r => r.json()).then(d => {
      if (d.running) {
        setRunning(true);
        setTrainLog(d.log || '');
        startPolling();
      } else {
        setRunning(false);
        setRecentJobs(d.recentJobs || []);
      }
    }).catch(() => {});
  }

  function startPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const d = await fetch('/ml/image/train/status').then(r => r.json()).catch(() => null);
      if (!d) return;
      if (d.running) {
        setTrainLog(d.log || '');
      } else {
        clearInterval(pollRef.current);
        pollRef.current = null;
        setRunning(false);
        setRecentJobs(d.recentJobs || []);
        loadCustomModels();
        onReload();
        showToast('学習が完了しました');
      }
    }, 2000);
  }

  async function startTrain() {
    if (!datasetName) { showToast('データセットを選択してください'); return; }
    if (!modelName.trim()) { showToast('モデル名を入力してください'); return; }
    try {
      const res = await fetch('/ml/image/train', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetName, modelName: modelName.trim(), baseModel, epochs, batchSize }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      setRunning(true);
      setTrainLog('学習を開始しました...\n');
      startPolling();
    } catch (e) {
      showToast(`学習開始失敗: ${e.message}`);
    }
  }

  async function cancelTrain() {
    if (!confirm('学習を中止しますか?')) return;
    await fetch('/ml/image/train/cancel', { method: 'POST' }).catch(() => {});
  }

  async function deleteModel(name) {
    if (!confirm(`モデル「${name}」を削除しますか?`)) return;
    await fetch(`/ml/image/custom-models/${name}`, { method: 'DELETE' }).catch(() => {});
    loadCustomModels();
    showToast('削除しました');
  }

  // モデルを zip でダウンロード (認証付き fetch → blob → 保存)
  async function downloadModel(name) {
    setDownloading(name);
    showToast('ダウンロードを準備中... (モデルサイズによっては数十秒かかります)');
    try {
      const res = await fetch(`/ml/image/custom-models/${name}/download`);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      // Content-Length があれば進捗表示の参考に
      const len = res.headers.get('Content-Length');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      const sizeMb = (blob.size / 1024 / 1024).toFixed(1);
      showToast(`ダウンロードしました (${sizeMb} MB)`);
    } catch (e) {
      showToast(`ダウンロード失敗: ${e.message}`);
    } finally {
      setDownloading(null);
    }
  }

  const annotatedReady = datasets.filter(d => d.annotatedCount > 0);

  return (
    <div className="image-train-runner">
      {!running && (
        <div className="train-config">
          <h3>カスタムモデルを学習</h3>
          <div className="train-row">
            <label className="image-detect-label">データセット:</label>
            <select className="image-detect-select" value={datasetName} onChange={e => setDatasetName(e.target.value)}>
              <option value="">選択してください</option>
              {annotatedReady.map(d => (
                <option key={d.name} value={d.name}>{d.name} (アノテーション済 {d.annotatedCount}枚, クラス: {d.classes.join('/')})</option>
              ))}
            </select>
          </div>
          {annotatedReady.length === 0 && (
            <div className="warn-banner">アノテーション済みのデータセットがありません。先にデータセットを作成し、画像に矩形を描画してください。</div>
          )}
          <div className="train-row">
            <label className="image-detect-label">モデル名:</label>
            <input className="ml-input" placeholder="my_detector (英数字)" value={modelName} onChange={e => setModelName(e.target.value)} />
          </div>
          <div className="train-row">
            <label className="image-detect-label">ベースモデル:</label>
            <select className="image-detect-select" value={baseModel} onChange={e => setBaseModel(e.target.value)}>
              {baseModels.map(m => <option key={m.name} value={m.name}>{m.label} ({m.note})</option>)}
            </select>
          </div>
          {baseModel === 'scratch' && (
            <div className="warn-banner" style={{ marginTop: -4 }}>
              ⚠️ <strong>事前学習なし (ゼロから学習)</strong> を選択中です。
              転移学習を使わないため、少量データ (数十枚) ではほとんど精度が出ません。
              数千枚以上の画像と、多数のエポック (数十〜数百) が必要になります。
              まず試す場合は「Faster R-CNN (MobileNetV3)」など事前学習ありを推奨します。
            </div>
          )}
          <div className="train-row">
            <label className="image-detect-label">エポック: {epochs}</label>
            <input type="range" min="1" max="50" value={epochs} onChange={e => setEpochs(parseInt(e.target.value))} className="image-detect-slider" />
            <label className="image-detect-label">バッチ: {batchSize}</label>
            <input type="range" min="1" max="8" value={batchSize} onChange={e => setBatchSize(parseInt(e.target.value))} className="image-detect-slider" />
          </div>
          <button className="btn primary" onClick={startTrain} disabled={annotatedReady.length === 0}>🚀 学習開始</button>
        </div>
      )}

      {running && (
        <div className="train-running">
          <div className="train-running-header">
            <span className="train-spinner">⏳ 学習中...</span>
            <button className="btn small danger" onClick={cancelTrain}>中止</button>
          </div>
          <pre className="train-log">{trainLog}</pre>
        </div>
      )}

      {!running && customModels.length > 0 && (
        <div className="train-models">
          <h3>学習済みカスタムモデル ({customModels.length})</h3>
          {customModels.map(m => (
            <div key={m.name} className="dataset-card">
              <div className="dataset-card-info">
                <div className="dataset-card-name">🎓 {m.name}</div>
                <div className="dataset-card-meta">
                  クラス: {(m.classes || []).join(', ')} · ベース: {m.baseModel} · loss: {m.finalLoss ?? '-'}
                </div>
              </div>
              <div className="dataset-card-actions">
                <button className="btn small" onClick={() => downloadModel(m.name)} disabled={downloading === m.name}>
                  {downloading === m.name ? '⏳ 準備中…' : '⬇ ダウンロード'}
                </button>
                <button className="btn small danger" onClick={() => deleteModel(m.name)}>削除</button>
              </div>
            </div>
          ))}
          <div className="train-hint">学習済みモデルは「🔍 検出」サブタブから選んで使えます。ダウンロードすればPythonで単体利用も、「📡 API (外部連携)」タブの方法で外部から呼び出すこともできます。</div>
        </div>
      )}

      {!running && recentJobs.length > 0 && (
        <div className="train-jobs">
          <h3>学習履歴</h3>
          {recentJobs.slice(0, 5).map(j => (
            <div key={j.jobId} className={`train-job-item ${j.status}`}>
              <span>{j.status === 'completed' ? '✅' : '❌'} {j.modelName}</span>
              <span className="train-job-meta">
                {j.status === 'completed' ? `loss: ${j.finalLoss}, ${j.device}` : `エラー: ${j.error || '不明'}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ImageDetectView({ showToast }) {
  const [models, setModels] = useState([]);
  const [customModels, setCustomModels] = useState([]);
  // selectedModel は "coco:<name>" または "custom:<name>" の形式
  const [selectedModel, setSelectedModel] = useState('coco:fasterrcnn_resnet50_fpn');
  const [threshold, setThreshold] = useState(0.5);
  const [imageDataUrl, setImageDataUrl] = useState(null);
  const [detecting, setDetecting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const canvasRef = useRef(null);
  const imgRef = useRef(null);

  // 検出結果のクラスごとに色を割り当て
  const COLORS = ['#ff3b30', '#34c759', '#007aff', '#ff9500', '#af52de', '#ff2d55', '#5ac8fa', '#ffcc00'];

  useEffect(() => {
    fetch('/ml/image/models')
      .then(r => r.ok ? r.json() : { models: [] })
      .then(d => setModels(d.models || []))
      .catch(() => {});
    // カスタム学習済みモデルも取得
    fetch('/ml/image/custom-models')
      .then(r => r.ok ? r.json() : { models: [] })
      .then(d => setCustomModels(d.models || []))
      .catch(() => {});
  }, []);

  function onFileSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('画像ファイルを選択してください');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setImageDataUrl(reader.result);
      setResult(null);
      setError('');
    };
    reader.readAsDataURL(file);
  }

  // 検出結果を canvas に矩形描画
  useEffect(() => {
    if (!result || !imageDataUrl || !canvasRef.current || !imgRef.current) return;
    const img = imgRef.current;
    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      // 画像の実サイズで canvas を設定
      canvas.width = result.imageWidth;
      canvas.height = result.imageHeight;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const classColors = {};
      let colorIdx = 0;
      result.detections.forEach(det => {
        if (!(det.label in classColors)) {
          classColors[det.label] = COLORS[colorIdx % COLORS.length];
          colorIdx++;
        }
        const color = classColors[det.label];
        const { x1, y1, x2, y2 } = det.box;
        const w = x2 - x1, h = y2 - y1;
        // 矩形
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(2, canvas.width / 400);
        ctx.strokeRect(x1, y1, w, h);
        // ラベル背景
        const label = `${det.label} ${(det.score * 100).toFixed(0)}%`;
        const fontSize = Math.max(14, canvas.width / 50);
        ctx.font = `bold ${fontSize}px sans-serif`;
        const textW = ctx.measureText(label).width;
        ctx.fillStyle = color;
        ctx.fillRect(x1, Math.max(0, y1 - fontSize - 6), textW + 10, fontSize + 6);
        // ラベル文字
        ctx.fillStyle = '#fff';
        ctx.fillText(label, x1 + 5, Math.max(fontSize, y1 - 4));
      });
    };
    if (img.complete) draw();
    else img.onload = draw;
  }, [result, imageDataUrl]);

  async function runDetect() {
    if (!imageDataUrl) {
      setError('画像を選択してください');
      return;
    }
    setDetecting(true);
    setError('');
    setResult(null);
    try {
      // selectedModel は "coco:<name>" または "custom:<name>"
      const [kind, mname] = selectedModel.split(':');
      const body = kind === 'custom'
        ? { image: imageDataUrl, customModel: mname, threshold }
        : { image: imageDataUrl, model: mname, threshold };
      const res = await fetch('/ml/image/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResult(data);
      if (data.count === 0) showToast('物体が検出されませんでした (しきい値を下げてみてください)');
      else showToast(`${data.count}個の物体を検出しました`);
    } catch (e) {
      setError(`検出失敗: ${e.message}`);
    } finally {
      setDetecting(false);
    }
  }

  // 検出サマリー (クラスごとの個数)
  const classSummary = {};
  if (result) {
    result.detections.forEach(d => { classSummary[d.label] = (classSummary[d.label] || 0) + 1; });
  }

  return (
    <div className="image-detect-view">
      <div className="image-detect-controls">
        <div className="image-detect-row">
          <label className="image-detect-label">モデル:</label>
          <select value={selectedModel} onChange={e => setSelectedModel(e.target.value)} className="image-detect-select">
            <optgroup label="COCO 事前学習 (80クラス)">
              {models.map(m => (
                <option key={m.name} value={`coco:${m.name}`}>{m.label} ({m.note}, 速度:{m.speed})</option>
              ))}
            </optgroup>
            {customModels.length > 0 && (
              <optgroup label="カスタム学習済みモデル">
                {customModels.map(m => (
                  <option key={m.name} value={`custom:${m.name}`}>
                    🎓 {m.name} ({(m.classes || []).join(', ')})
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        <div className="image-detect-row">
          <label className="image-detect-label">信頼度しきい値: {threshold.toFixed(2)}</label>
          <input type="range" min="0.05" max="0.95" step="0.05" value={threshold}
            onChange={e => setThreshold(parseFloat(e.target.value))} className="image-detect-slider" />
        </div>
        <div className="image-detect-row">
          <input type="file" accept="image/jpeg,image/png,image/bmp,image/webp,.jpg,.jpeg,.png,.bmp,.webp" onChange={onFileSelect} className="image-detect-file" />
          <button className="btn primary" onClick={runDetect} disabled={!imageDataUrl || detecting}>
            {detecting ? '🔍 検出中...' : '🔍 物体検出を実行'}
          </button>
        </div>
        <div className="image-detect-hint">
          torchvision の COCO 事前学習モデル (80クラス: 人・車・犬・椅子・ボトル等) で物体を検出します。
          初回はモデルのダウンロードに時間がかかることがあります。
        </div>
      </div>

      {error && <div className="warn-banner">{error}</div>}

      <div className="image-detect-canvas-wrap">
        {imageDataUrl && (
          <>
            {/* 元画像 (canvasへの描画ソース、非表示) */}
            <img ref={imgRef} src={imageDataUrl} style={{ display: 'none' }} alt="source" />
            <canvas ref={canvasRef} className="image-detect-canvas" />
          </>
        )}
        {!imageDataUrl && (
          <div className="empty-state">画像ファイルを選択してください</div>
        )}
      </div>

      {result && (
        <div className="image-detect-result">
          <div className="image-detect-summary">
            <strong>{result.count}個</strong> 検出 ·
            モデル: {result.model} ·
            デバイス: {result.device} ·
            画像: {result.imageWidth}×{result.imageHeight}
          </div>
          {result.note && (
            <div className="image-detect-summary" style={{ color: 'var(--orange, #ff9500)' }}>
              ⚠️ {result.note}
            </div>
          )}
          {result.count > 0 && (
            <div className="image-detect-classes">
              {Object.entries(classSummary).map(([cls, n]) => (
                <span key={cls} className="image-detect-class-badge">{cls}: {n}</span>
              ))}
            </div>
          )}
          <details className="image-detect-details">
            <summary>検出の詳細 ({result.count}件)</summary>
            <table className="image-detect-table">
              <thead><tr><th>#</th><th>ラベル</th><th>信頼度</th><th>位置 (x1,y1,x2,y2)</th></tr></thead>
              <tbody>
                {result.detections.map((d, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>{d.label}</td>
                    <td>{(d.score * 100).toFixed(1)}%</td>
                    <td>{d.box.x1}, {d.box.y1}, {d.box.x2}, {d.box.y2}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// 🖐️ キーポイント検出ビュー (torchvision Keypoint R-CNN)
// 対象(バウンディングボックス)+順序付きのキーポイント(関節など)を関連付けて
// 学習・推論する。画像物体検出と同じ構成 (検出 / データセット / 学習)。
// ════════════════════════════════════════════════════════════════════════

// よく使うキーポイント構成のプリセット (データセット作成時の入力補助)
const KEYPOINT_PRESETS = {
  hand: {
    label: '✋ 手 (21点)',
    keypoints: [
      'wrist',
      'thumb_cmc', 'thumb_mcp', 'thumb_ip', 'thumb_tip',
      'index_mcp', 'index_pip', 'index_dip', 'index_tip',
      'middle_mcp', 'middle_pip', 'middle_dip', 'middle_tip',
      'ring_mcp', 'ring_pip', 'ring_dip', 'ring_tip',
      'pinky_mcp', 'pinky_pip', 'pinky_dip', 'pinky_tip',
    ],
    skeleton: [
      [0, 1], [1, 2], [2, 3], [3, 4],
      [0, 5], [5, 6], [6, 7], [7, 8],
      [5, 9], [9, 10], [10, 11], [11, 12],
      [9, 13], [13, 14], [14, 15], [15, 16],
      [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
    ],
  },
  person: {
    label: '🧍 人物 (17点 / COCO)',
    keypoints: [
      'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
      'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
      'left_wrist', 'right_wrist', 'left_hip', 'right_hip',
      'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
    ],
    skeleton: [
      [0, 1], [0, 2], [1, 3], [2, 4], [5, 6], [5, 7], [7, 9], [6, 8], [8, 10],
      [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
    ],
  },
  face5: {
    label: '🙂 顔 (5点)',
    keypoints: ['left_eye', 'right_eye', 'nose', 'left_mouth', 'right_mouth'],
    skeleton: [[0, 2], [1, 2], [2, 3], [2, 4], [3, 4]],
  },
};

const KP_COLORS = ['#ff3b30', '#34c759', '#007aff', '#ff9500', '#af52de', '#ff2d55', '#5ac8fa', '#ffcc00'];

function KeypointView({ showToast }) {
  const [subTab, setSubTab] = useState('detect');  // detect | datasets | annotate | train
  const [datasets, setDatasets] = useState([]);
  const [selectedDataset, setSelectedDataset] = useState(null);
  const [datasetDetail, setDatasetDetail] = useState(null);

  function loadDatasets() {
    fetch('/ml/image/keypoint/datasets')
      .then(r => r.ok ? r.json() : { datasets: [] })
      .then(d => setDatasets(d.datasets || []))
      .catch(() => {});
  }
  useEffect(() => { loadDatasets(); }, []);

  function loadDatasetDetail(name) {
    return fetch(`/ml/image/keypoint/datasets/${name}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) { setDatasetDetail(d.dataset); setSelectedDataset(name); } })
      .catch(() => {});
  }

  function reloadAll(name) {
    loadDatasets();
    const target = name || selectedDataset;
    if (target) loadDatasetDetail(target);
  }

  return (
    <>
      <div className="image-train-subtabs">
        <button className={`subtab ${subTab === 'detect' ? 'active' : ''}`} onClick={() => setSubTab('detect')}>🔍 検出</button>
        <button className={`subtab ${subTab === 'datasets' ? 'active' : ''}`} onClick={() => setSubTab('datasets')}>📊 データセット</button>
        <button className={`subtab ${subTab === 'train' ? 'active' : ''}`} onClick={() => setSubTab('train')}>🚀 学習</button>
      </div>

      {subTab === 'detect' && (
        <KeypointDetectView showToast={showToast} />
      )}
      {subTab === 'datasets' && (
        <KeypointDatasetManager
          datasets={datasets}
          onReload={loadDatasets}
          onReloadDataset={(name) => reloadAll(name)}
          onSelect={(name) => { loadDatasetDetail(name); setSubTab('annotate'); }}
          showToast={showToast}
        />
      )}
      {subTab === 'annotate' && selectedDataset && datasetDetail && (
        <KeypointAnnotateView
          datasetName={selectedDataset}
          dataset={datasetDetail}
          onReload={() => reloadAll(selectedDataset)}
          onBack={() => setSubTab('datasets')}
          showToast={showToast}
        />
      )}
      {subTab === 'train' && (
        <KeypointTrainRunner datasets={datasets} onReload={loadDatasets} showToast={showToast} />
      )}
    </>
  );
}

// データセット管理 (一覧・作成・削除・画像追加)
function KeypointDatasetManager({ datasets, onReload, onReloadDataset, onSelect, showToast }) {
  const [newName, setNewName] = useState('');
  const [newKeypoints, setNewKeypoints] = useState('');
  const [newSkeleton, setNewSkeleton] = useState('');
  const [is3d, setIs3d] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  function applyPreset(key) {
    const p = KEYPOINT_PRESETS[key];
    if (!p) return;
    setNewKeypoints(p.keypoints.join(', '));
    setNewSkeleton(p.skeleton.map(e => `${e[0]}-${e[1]}`).join(', '));
  }

  function parseSkeleton(text, kpCount) {
    const out = [];
    for (const part of text.split(',').map(s => s.trim()).filter(Boolean)) {
      const m = part.split('-').map(s => parseInt(s.trim(), 10));
      if (m.length !== 2 || m.some(n => !Number.isInteger(n))) continue;
      if (m[0] < 0 || m[0] >= kpCount || m[1] < 0 || m[1] >= kpCount) continue;
      out.push([m[0], m[1]]);
    }
    return out;
  }

  async function createDataset() {
    const keypoints = newKeypoints.split(',').map(c => c.trim()).filter(Boolean);
    if (!newName.trim()) { setError('データセット名を入力してください'); return; }
    if (keypoints.length === 0) { setError('キーポイント名を最低1つ (カンマ区切り)'); return; }
    const skeleton = parseSkeleton(newSkeleton, keypoints.length);
    setCreating(true);
    setError('');
    try {
      const res = await fetch('/ml/image/keypoint/datasets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), keypoints, skeleton, dim: is3d ? '3d' : '2d' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      showToast(`データセット「${newName}」を作成しました`);
      setNewName(''); setNewKeypoints(''); setNewSkeleton(''); setIs3d(false);
      onReload();
    } catch (e) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  }

  async function deleteDataset(name) {
    if (!confirm(`データセット「${name}」を削除しますか? (画像・アノテーションも全て削除されます)`)) return;
    try {
      const res = await fetch(`/ml/image/keypoint/datasets/${name}`, { method: 'DELETE' });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
      showToast('削除しました');
      onReload();
    } catch (e) {
      showToast(`削除失敗: ${e.message}`);
    }
  }

  const SUPPORTED_EXTS_RE = /\.(jpg|jpeg|png|bmp|webp)$/i;
  const UNSUPPORTED_EXTS_RE = /\.(tif|tiff|heic|heif|raw|cr2|nef|arw|dng|gif)$/i;
  async function addImages(name, files) {
    if (!files || files.length === 0) return;
    const images = [];
    const skipped = [];
    for (const file of files) {
      const fname = file.name || '';
      if (UNSUPPORTED_EXTS_RE.test(fname)) { skipped.push(`${fname}: 非対応形式`); continue; }
      if (!SUPPORTED_EXTS_RE.test(fname) && !/image\/(jpeg|png|bmp|webp)/.test(file.type || '')) {
        skipped.push(`${fname}: 画像ファイルではありません`); continue;
      }
      const data = await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
      });
      images.push({ name: file.name, data });
    }
    if (skipped.length > 0) showToast(`${skipped.length}件スキップ: ${skipped[0]}`);
    if (images.length === 0) {
      if (skipped.length === 0) showToast('画像ファイルがありません');
      return;
    }
    try {
      const res = await fetch(`/ml/image/keypoint/datasets/${name}/images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      const addedCount = (d.added || []).length;
      const errCount = (d.errors || []).length;
      if (addedCount > 0) showToast(`${addedCount}枚の画像を追加しました${errCount ? ` (${errCount}件失敗)` : ''}`);
      else showToast(`画像追加に失敗しました${errCount ? `: ${d.errors[0].error}` : ''}`);
      if (onReloadDataset) onReloadDataset(name); else onReload();
    } catch (e) {
      showToast(`画像追加失敗: ${e.message}`);
    }
  }

  // CSV (ロング形式) からキーポイントのアノテーションをインポート
  async function importCsv(name, file) {
    if (!file) return;
    try {
      const text = await file.text();
      const res = await fetch(`/ml/image/keypoint/datasets/${name}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'csv', data: text }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      let msg = `CSVインポート: ${d.pointCount}点 / ${d.instanceCount}対象 / ${d.appliedImages}画像`;
      if (d.skipped) msg += ` (スキップ${d.skipped})`;
      showToast(msg);
      if (d.errors && d.errors.length) showToast(`注意: ${d.errors[0]}`);
      if (onReloadDataset) onReloadDataset(name); else onReload();
    } catch (e) {
      showToast(`CSVインポート失敗: ${e.message}`);
    }
  }

  return (
    <div className="dataset-manager">
      <div className="dataset-create">
        <h3>新規キーポイントデータセット作成</h3>
        <div className="dataset-create-row" style={{ marginBottom: 8 }}>
          <span className="image-detect-label">プリセット:</span>
          {Object.entries(KEYPOINT_PRESETS).map(([k, p]) => (
            <button key={k} type="button" className="btn small" onClick={() => applyPreset(k)}>{p.label}</button>
          ))}
        </div>
        <div className="dataset-create-row">
          <input className="ml-input" placeholder="データセット名 (英数字)" value={newName} onChange={e => setNewName(e.target.value)} />
        </div>
        <div className="dataset-create-row">
          <input className="ml-input" placeholder="キーポイント名 (カンマ区切り、順番が重要: wrist, thumb_tip, ...)" value={newKeypoints} onChange={e => setNewKeypoints(e.target.value)} style={{ flex: 3 }} />
        </div>
        <div className="dataset-create-row">
          <input className="ml-input" placeholder="骨格エッジ (任意、0始まり番号: 0-1, 1-2, ...)" value={newSkeleton} onChange={e => setNewSkeleton(e.target.value)} style={{ flex: 3 }} />
          <button className="btn primary" onClick={createDataset} disabled={creating}>作成</button>
        </div>
        <div className="dataset-create-row">
          <label className="kp-3d-toggle">
            <input type="checkbox" checked={is3d} onChange={e => setIs3d(e.target.checked)} />
            <span><strong>3D (奥行き z を学習)</strong> — RGB1枚から x,y,z を回帰 (ResNet・単一インスタンス)</span>
          </label>
        </div>
        <div className="image-detect-hint">
          キーポイントは「順番」が学習に使われます。全ての画像で同じ順番(番号)で打ってください。
          骨格エッジは表示用で、キーポイント番号のペアをつなぎます (任意)。
          {is3d && <><br />🧊 <strong>3Dモード</strong>: アノテーション時に各点の z(相対深度 -1〜1) をスライダーで設定します。z は単眼RGBからの相対値です。</>}
        </div>
        {error && <div className="warn-banner">{error}</div>}
      </div>

      <div className="dataset-list">
        <h3>データセット一覧 ({datasets.length})</h3>
        {datasets.length === 0 && <div className="empty-state">データセットがありません。上で作成してください。</div>}
        {datasets.map(ds => (
          <div key={ds.name} className="dataset-card">
            <div className="dataset-card-info">
              <div className="dataset-card-name">{ds.name} {ds.dim === '3d' && <span className="kp-3d-badge">3D</span>}</div>
              <div className="dataset-card-meta">
                キーポイント {ds.keypoints.length}点 · 画像 {ds.imageCount}枚 · アノテーション済 {ds.annotatedCount}枚
              </div>
              <div className="dataset-card-meta" style={{ opacity: 0.7 }}>{ds.keypoints.join(', ')}</div>
            </div>
            <div className="dataset-card-actions">
              <label className="btn small">
                画像追加
                <input type="file" accept="image/jpeg,image/png,image/bmp,image/webp,.jpg,.jpeg,.png,.bmp,.webp" multiple style={{ display: 'none' }}
                  onChange={e => addImages(ds.name, Array.from(e.target.files))} />
              </label>
              <label className="btn small" title={ds.dim === '3d'
                ? 'ロング形式CSV: filename,keypoint,x,y,z,v[,instance] (先に画像を追加。ファイル名で紐付け)'
                : 'ロング形式CSV: filename,keypoint,x,y,v[,instance] (先に画像を追加。ファイル名で紐付け)'}>
                📄 CSV取込
                <input type="file" accept=".csv,text/csv" style={{ display: 'none' }}
                  onChange={e => { if (e.target.files[0]) importCsv(ds.name, e.target.files[0]); e.target.value = ''; }} />
              </label>
              <button className="btn small primary" onClick={() => onSelect(ds.name)}>✏️ アノテーション</button>
              <button className="btn small danger" onClick={() => deleteDataset(ds.name)}>削除</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// アノテーションビュー (対象boxドラッグ + キーポイント点打ち)
function KeypointAnnotateView({ datasetName, dataset, onReload, onBack, showToast }) {
  const keypointNames = dataset.keypoints || [];
  const skeleton = dataset.skeleton || [];
  const K = keypointNames.length;
  const is3d = dataset.dim === '3d';

  const [currentIdx, setCurrentIdx] = useState(0);
  const [instances, setInstances] = useState([]);   // [{box:{x1,y1,x2,y2}, keypoints:[{x,y,v}]}]
  const [activeInst, setActiveInst] = useState(-1);  // 編集中インスタンス
  const [activeKp, setActiveKp] = useState(0);       // 次に打つキーポイント番号
  const [mode, setMode] = useState('box');           // 'box' | 'point'
  const [drawing, setDrawing] = useState(null);
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 });
  const [saving, setSaving] = useState(false);
  const canvasRef = useRef(null);
  const imgRef = useRef(null);

  const images = dataset.images || [];
  const currentImage = images[currentIdx];
  const currentImageId = currentImage ? currentImage.id : null;

  // K個のキーポイント配列を生成 (足りない分は v=0 で埋める)。3Dなら z も保持。
  function normalizeKps(kps) {
    const out = [];
    for (let i = 0; i < K; i++) {
      const kp = (kps && kps[i]) || null;
      if (kp && Number(kp.v) > 0) {
        const o = { x: Number(kp.x) || 0, y: Number(kp.y) || 0, v: Number(kp.v) };
        if (is3d) o.z = Number.isFinite(Number(kp.z)) ? Number(kp.z) : 0;
        out.push(o);
      } else {
        out.push(is3d ? { x: 0, y: 0, z: 0, v: 0 } : { x: 0, y: 0, v: 0 });
      }
    }
    return out;
  }

  function loadInstancesFrom(im) {
    if (!im || !Array.isArray(im.instances)) return [];
    return im.instances.map(inst => ({
      box: { ...(inst.box || { x1: 0, y1: 0, x2: 0, y2: 0 }) },
      keypoints: normalizeKps(inst.keypoints),
    }));
  }

  useEffect(() => {
    setInstances(loadInstancesFrom(currentImage));
    setActiveInst(-1);
    setActiveKp(0);
    setMode('box');
    setDrawing(null);
  }, [currentIdx, currentImageId]);

  // canvas 描画
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const draw = () => {
      const naturalW = img.naturalWidth, naturalH = img.naturalHeight;
      if (!naturalW) return;
      const dispW = Math.min(naturalW, 800);
      const scale = dispW / naturalW;
      canvas.width = naturalW;
      canvas.height = naturalH;
      canvas.style.width = dispW + 'px';
      canvas.style.height = (naturalH * scale) + 'px';
      setImgSize({ w: naturalW, h: naturalH });
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);

      const r = Math.max(4, naturalW / 150);  // キーポイント半径
      const lw = Math.max(2, naturalW / 350);

      instances.forEach((inst, ii) => {
        const color = KP_COLORS[ii % KP_COLORS.length];
        const isActive = ii === activeInst;
        // バウンディングボックス
        ctx.strokeStyle = color;
        ctx.lineWidth = isActive ? lw * 1.8 : lw;
        const b = inst.box;
        ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
        // 骨格エッジ
        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        skeleton.forEach(([a, c]) => {
          const ka = inst.keypoints[a], kc = inst.keypoints[c];
          if (ka && kc && ka.v > 0 && kc.v > 0) {
            ctx.beginPath();
            ctx.moveTo(ka.x, ka.y);
            ctx.lineTo(kc.x, kc.y);
            ctx.stroke();
          }
        });
        // キーポイント
        inst.keypoints.forEach((kp, ki) => {
          if (kp.v <= 0) return;
          ctx.beginPath();
          ctx.arc(kp.x, kp.y, r, 0, Math.PI * 2);
          ctx.fillStyle = kp.v === 1 ? '#888' : color;  // v=1(隠れ)はグレー
          ctx.fill();
          ctx.lineWidth = Math.max(1, lw / 2);
          ctx.strokeStyle = '#fff';
          ctx.stroke();
          // アクティブインスタンスでは番号を表示
          if (isActive) {
            const fs2 = Math.max(10, naturalW / 70);
            ctx.font = `bold ${fs2}px sans-serif`;
            ctx.fillStyle = '#fff';
            ctx.fillText(String(ki), kp.x - fs2 / 3, kp.y - r - 2);
          }
        });
      });

      if (drawing) {
        ctx.strokeStyle = '#00c2ff';
        ctx.lineWidth = lw;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(drawing.x1, drawing.y1, drawing.x2 - drawing.x1, drawing.y2 - drawing.y1);
        ctx.setLineDash([]);
      }
    };
    if (img.complete) draw();
    else img.onload = draw;
  }, [instances, drawing, activeInst, currentIdx, skeleton]);

  function toCanvasCoord(e) {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  function placeKeypoint(x, y) {
    if (activeInst < 0 || activeInst >= instances.length) {
      showToast('先に対象を四角で囲んでください'); return;
    }
    if (activeKp < 0 || activeKp >= K) return;
    setInstances(prev => prev.map((inst, ii) => {
      if (ii !== activeInst) return inst;
      const kps = inst.keypoints.map((kp, ki) => {
        if (ki !== activeKp) return kp;
        // 3D は z を保持 (既存があれば引き継ぎ、無ければ0)
        return is3d ? { x, y, v: 2, z: Number.isFinite(Number(kp.z)) ? Number(kp.z) : 0 } : { x, y, v: 2 };
      });
      return { ...inst, keypoints: kps };
    }));
    // 次の未設定キーポイントへ自動で進む
    setActiveKp(prev => {
      let next = prev + 1;
      while (next < K && instances[activeInst] && instances[activeInst].keypoints[next] && instances[activeInst].keypoints[next].v > 0) next++;
      return Math.min(next, K);
    });
  }

  function onMouseDown(e) {
    const { x, y } = toCanvasCoord(e);
    if (mode === 'point') { placeKeypoint(x, y); return; }
    setDrawing({ x1: x, y1: y, x2: x, y2: y });
  }
  function onMouseMove(e) {
    if (mode === 'point' || !drawing) return;
    const { x, y } = toCanvasCoord(e);
    setDrawing(prev => ({ ...prev, x2: x, y2: y }));
  }
  function onMouseUp() {
    if (mode === 'point' || !drawing) return;
    const b = drawing;
    if (Math.abs(b.x2 - b.x1) > 5 && Math.abs(b.y2 - b.y1) > 5) {
      const newInst = {
        box: {
          x1: Math.min(b.x1, b.x2), y1: Math.min(b.y1, b.y2),
          x2: Math.max(b.x1, b.x2), y2: Math.max(b.y1, b.y2),
        },
        keypoints: normalizeKps([]),
      };
      setInstances(prev => {
        const next = [...prev, newInst];
        setActiveInst(next.length - 1);
        return next;
      });
      setActiveKp(0);
      setMode('point');  // box を引いたら自動で点打ちモードへ
      showToast('対象を追加しました。キーポイントを順番にクリックしてください');
    }
    setDrawing(null);
  }

  function removeInstance(i) {
    setInstances(prev => prev.filter((_, j) => j !== i));
    if (activeInst === i) { setActiveInst(-1); setMode('box'); }
    else if (activeInst > i) setActiveInst(activeInst - 1);
  }

  // アクティブインスタンスの特定キーポイントの可視性を切り替え/クリア
  function setKpVisibility(ki, v) {
    if (activeInst < 0) return;
    setInstances(prev => prev.map((inst, ii) => {
      if (ii !== activeInst) return inst;
      const kps = inst.keypoints.map((kp, idx) => {
        if (idx !== ki) return kp;
        if (v === 0) return is3d ? { x: 0, y: 0, z: 0, v: 0 } : { x: 0, y: 0, v: 0 };
        return { ...kp, v };
      });
      return { ...inst, keypoints: kps };
    }));
  }

  // 3D: アクティブインスタンスの特定キーポイントの z(相対深度) を設定
  function setKpZ(ki, z) {
    if (activeInst < 0) return;
    setInstances(prev => prev.map((inst, ii) => {
      if (ii !== activeInst) return inst;
      const kps = inst.keypoints.map((kp, idx) => idx === ki ? { ...kp, z } : kp);
      return { ...inst, keypoints: kps };
    }));
  }

  async function saveInstances() {
    if (!currentImage) return;
    setSaving(true);
    try {
      const res = await fetch(`/ml/image/keypoint/datasets/${datasetName}/annotations/${currentImage.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instances }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      showToast(`保存しました (${d.instanceCount}個の対象)`);
      onReload();
    } catch (e) {
      showToast(`保存失敗: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  function gotoImage(idx) {
    if (idx < 0 || idx >= images.length) return;
    setInstances(loadInstancesFrom(images[idx]));
    setActiveInst(-1);
    setActiveKp(0);
    setMode('box');
    setCurrentIdx(idx);
    setDrawing(null);
  }

  async function deleteImage(im, idx) {
    if (!confirm(`画像「${im.originalName || im.file}」を削除しますか? (アノテーションも削除されます)`)) return;
    try {
      const res = await fetch(`/ml/image/keypoint/datasets/${datasetName}/images/${im.id}`, { method: 'DELETE' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      showToast('画像を削除しました');
      if (idx === currentIdx) {
        const newLen = images.length - 1;
        setCurrentIdx(idx >= newLen ? Math.max(0, newLen - 1) : idx);
        setInstances([]);
      } else if (idx < currentIdx) {
        setCurrentIdx(currentIdx - 1);
      }
      onReload();
    } catch (e) {
      showToast(`削除失敗: ${e.message}`);
    }
  }

  if (images.length === 0) {
    return (
      <div className="annotate-view">
        <button className="btn small" onClick={onBack}>← データセット一覧へ</button>
        <div className="empty-state">画像がありません。「📊 データセット」タブから画像を追加してください。</div>
      </div>
    );
  }

  const activeKps = activeInst >= 0 && instances[activeInst] ? instances[activeInst].keypoints : null;
  const placedCount = activeKps ? activeKps.filter(k => k.v > 0).length : 0;

  return (
    <div className="annotate-view">
      <div className="annotate-toolbar">
        <button className="btn small" onClick={onBack}>← 一覧へ</button>
        <span className="annotate-counter">{currentIdx + 1} / {images.length}</span>
        <button className="btn small" onClick={() => gotoImage(currentIdx - 1)} disabled={currentIdx === 0}>← 前</button>
        <button className="btn small" onClick={() => gotoImage(currentIdx + 1)} disabled={currentIdx >= images.length - 1}>次 →</button>
        <span style={{ flex: 1 }} />
        <button className={`btn small ${mode === 'box' ? 'primary' : ''}`} onClick={() => { setMode('box'); }}>⬚ 対象を囲む</button>
        <button className={`btn small ${mode === 'point' ? 'primary' : ''}`} onClick={() => { if (activeInst < 0 && instances.length > 0) setActiveInst(instances.length - 1); setMode('point'); }}>📍 点を打つ</button>
        <button className="btn small primary" onClick={saveInstances} disabled={saving}>{saving ? '保存中…' : '💾 保存'}</button>
      </div>

      <div className="annotate-layout">
        <div className="annotate-canvas-wrap">
          <img ref={imgRef} src={`/ml/image/keypoint/datasets/${datasetName}/images/${currentImage.file}`} style={{ display: 'none' }} alt="source" crossOrigin="anonymous" />
          <canvas
            ref={canvasRef}
            className="annotate-canvas"
            style={{ cursor: mode === 'point' ? 'crosshair' : 'default' }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
          />
        </div>

        <div className="annotate-sidebar">
          <div className="annotate-hint">
            {mode === 'box'
              ? '① 「⬚ 対象を囲む」で手などをドラッグして囲みます。'
              : '② キーポイントを下のリストの順番にクリックして打ちます。'}
          </div>

          <h4>対象 (インスタンス) {instances.length}個</h4>
          <div className="kp-instance-list">
            {instances.length === 0 && <div className="empty-state" style={{ padding: 8 }}>まだありません</div>}
            {instances.map((inst, ii) => {
              const n = inst.keypoints.filter(k => k.v > 0).length;
              return (
                <div key={ii} className={`kp-instance-item ${ii === activeInst ? 'active' : ''}`}>
                  <span className="kp-instance-color" style={{ background: KP_COLORS[ii % KP_COLORS.length] }} />
                  <button className="kp-instance-select" onClick={() => { setActiveInst(ii); setMode('point'); }}>
                    対象#{ii + 1} ({n}/{K}点)
                  </button>
                  <button className="btn small danger" onClick={() => removeInstance(ii)}>×</button>
                </div>
              );
            })}
          </div>

          {activeKps && (
            <div className="kp-list">
              <h4>キーポイント ({placedCount}/{K})</h4>
              <div className="image-detect-hint" style={{ marginBottom: 6 }}>
                次に打つ点: <strong>{activeKp < K ? `${activeKp}: ${keypointNames[activeKp]}` : '完了'}</strong>
              </div>
              {keypointNames.map((kpName, ki) => {
                const kp = activeKps[ki];
                return (
                  <div key={ki} className={`kp-row ${ki === activeKp ? 'next' : ''}`}>
                    <div className="kp-row-main">
                      <button className="kp-row-name" onClick={() => setActiveKp(ki)} title="この点を次に打つ">
                        <span className={`kp-dot ${kp.v > 0 ? (kp.v === 1 ? 'hidden' : 'set') : 'unset'}`} />
                        {ki}: {kpName}
                      </button>
                      <span className="kp-row-actions">
                        {kp.v === 2 && <button className="btn tiny" title="隠れている(occluded)" onClick={() => setKpVisibility(ki, 1)}>👁</button>}
                        {kp.v === 1 && <button className="btn tiny" title="可視に戻す" onClick={() => setKpVisibility(ki, 2)}>🚫</button>}
                        {kp.v > 0 && <button className="btn tiny danger" title="クリア" onClick={() => setKpVisibility(ki, 0)}>×</button>}
                      </span>
                    </div>
                    {is3d && kp.v > 0 && (
                      <div className="kp-z-row" title="奥行き z (相対深度): 手前 -1 〜 奥 +1">
                        <span className="kp-z-label">z</span>
                        <input type="range" min="-1" max="1" step="0.05"
                          value={Number.isFinite(Number(kp.z)) ? kp.z : 0}
                          onChange={e => setKpZ(ki, parseFloat(e.target.value))}
                          className="kp-z-slider" />
                        <span className="kp-z-val">{(Number.isFinite(Number(kp.z)) ? kp.z : 0).toFixed(2)}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="annotate-gallery">
        <div className="annotate-gallery-header">画像一覧 ({images.length}) — クリックで切り替え</div>
        <div className="annotate-gallery-grid">
          {images.map((im, idx) => (
            <div key={im.id} className={`annotate-thumb ${idx === currentIdx ? 'active' : ''}`}>
              <img src={`/ml/image/keypoint/datasets/${datasetName}/images/${im.file}`} onClick={() => gotoImage(idx)} alt={im.originalName} />
              {(im.instances || []).length > 0 && <span className="annotate-thumb-badge has-box">{(im.instances || []).length}</span>}
              <button className="annotate-thumb-delete" onClick={() => deleteImage(im, idx)}>×</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// 学習ランナー
function KeypointTrainRunner({ datasets, onReload, showToast }) {
  const [baseModels, setBaseModels] = useState([]);
  const [backbones3d, setBackbones3d] = useState([]);
  const [datasetName, setDatasetName] = useState('');
  const [modelName, setModelName] = useState('');
  const [baseModel, setBaseModel] = useState('keypointrcnn_resnet50_fpn');
  const [epochs, setEpochs] = useState(10);
  const [batchSize, setBatchSize] = useState(2);
  const [running, setRunning] = useState(false);
  const [trainLog, setTrainLog] = useState('');
  const [recentJobs, setRecentJobs] = useState([]);
  const [customModels, setCustomModels] = useState([]);
  const [downloading, setDownloading] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => {
    fetch('/ml/image/keypoint/train/models').then(r => r.json()).then(d => {
      setBaseModels(d.baseModels || []);
      setBackbones3d(d.backbones3d || []);
    }).catch(() => {});
    loadStatus();
    loadCustomModels();
    if (onReload) onReload();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  function loadCustomModels() {
    fetch('/ml/image/keypoint/custom-models').then(r => r.json()).then(d => setCustomModels(d.models || [])).catch(() => {});
  }
  function loadStatus() {
    fetch('/ml/image/keypoint/train/status').then(r => r.json()).then(d => {
      if (d.running) { setRunning(true); setTrainLog(d.log || ''); startPolling(); }
      else { setRunning(false); setRecentJobs(d.recentJobs || []); }
    }).catch(() => {});
  }
  function startPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const d = await fetch('/ml/image/keypoint/train/status').then(r => r.json()).catch(() => null);
      if (!d) return;
      if (d.running) { setTrainLog(d.log || ''); }
      else {
        clearInterval(pollRef.current); pollRef.current = null;
        setRunning(false); setRecentJobs(d.recentJobs || []);
        loadCustomModels(); onReload(); showToast('学習が完了しました');
      }
    }, 2000);
  }
  async function startTrain() {
    if (!datasetName) { showToast('データセットを選択してください'); return; }
    if (!modelName.trim()) { showToast('モデル名を入力してください'); return; }
    try {
      const res = await fetch('/ml/image/keypoint/train', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetName, modelName: modelName.trim(), baseModel, epochs, batchSize }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      setRunning(true); setTrainLog('学習を開始しました...\n'); startPolling();
    } catch (e) {
      showToast(`学習開始失敗: ${e.message}`);
    }
  }
  async function cancelTrain() {
    if (!confirm('学習を中止しますか?')) return;
    await fetch('/ml/image/keypoint/train/cancel', { method: 'POST' }).catch(() => {});
  }
  async function deleteModel(name) {
    if (!confirm(`モデル「${name}」を削除しますか?`)) return;
    await fetch(`/ml/image/keypoint/custom-models/${name}`, { method: 'DELETE' }).catch(() => {});
    loadCustomModels(); showToast('削除しました');
  }
  async function downloadModel(name) {
    setDownloading(name);
    showToast('ダウンロードを準備中... (モデルサイズによっては数十秒かかります)');
    try {
      const res = await fetch(`/ml/image/keypoint/custom-models/${name}/download`);
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `HTTP ${res.status}`); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${name}.zip`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast(`ダウンロードしました (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
    } catch (e) {
      showToast(`ダウンロード失敗: ${e.message}`);
    } finally {
      setDownloading(null);
    }
  }

  const annotatedReady = datasets.filter(d => d.annotatedCount > 0);
  // 選択中データセットが3Dか (バックボーン選択に切替)
  const selectedDataset = datasets.find(d => d.name === datasetName);
  const selected3d = selectedDataset && selectedDataset.dim === '3d';

  // データセット選択に応じて baseModel を妥当な既定値へ
  useEffect(() => {
    if (!selectedDataset) return;
    if (selected3d) {
      if (!backbones3d.some(b => b.name === baseModel)) setBaseModel('resnet18');
    } else {
      if (!baseModels.some(m => m.name === baseModel)) setBaseModel('keypointrcnn_resnet50_fpn');
    }
  }, [datasetName, selected3d, baseModels, backbones3d]);

  return (
    <div className="image-train-runner">
      {!running && (
        <div className="train-config">
          <h3>カスタムキーポイントモデルを学習</h3>
          <div className="train-row">
            <label className="image-detect-label">データセット:</label>
            <select className="image-detect-select" value={datasetName} onChange={e => setDatasetName(e.target.value)}>
              <option value="">選択してください</option>
              {annotatedReady.map(d => (
                <option key={d.name} value={d.name}>{d.name}{d.dim === '3d' ? ' [3D]' : ''} (アノテーション済 {d.annotatedCount}枚, {d.keypoints.length}点)</option>
              ))}
            </select>
          </div>
          {annotatedReady.length === 0 && (
            <div className="warn-banner">アノテーション済みのデータセットがありません。先にデータセットを作成し、対象を囲んでキーポイントを打ってください。</div>
          )}
          <div className="train-row">
            <label className="image-detect-label">モデル名:</label>
            <input className="ml-input" placeholder={selected3d ? 'my_hand_3d (英数字)' : 'my_hand_pose (英数字)'} value={modelName} onChange={e => setModelName(e.target.value)} />
          </div>
          <div className="train-row">
            <label className="image-detect-label">{selected3d ? 'バックボーン:' : 'ベースモデル:'}</label>
            {selected3d ? (
              <select className="image-detect-select" value={baseModel} onChange={e => setBaseModel(e.target.value)}>
                {backbones3d.map(m => <option key={m.name} value={m.name}>{m.label} ({m.note})</option>)}
              </select>
            ) : (
              <select className="image-detect-select" value={baseModel} onChange={e => setBaseModel(e.target.value)}>
                {baseModels.map(m => <option key={m.name} value={m.name}>{m.label} ({m.note})</option>)}
              </select>
            )}
          </div>
          {selected3d && (
            <div className="image-detect-hint" style={{ marginTop: -4 }}>
              🧊 <strong>3Dモード</strong>: RGB1枚から各点の x,y,z(相対深度) を回帰します (ResNet・単一インスタンス前提)。
              z は手動で付けた相対値を学習します。3Dはエポック多め(30〜)が目安です。
            </div>
          )}
          {!selected3d && baseModel === 'scratch' && (
            <div className="warn-banner" style={{ marginTop: -4 }}>
              ⚠️ <strong>事前学習なし (ゼロから学習)</strong> を選択中です。少量データではほとんど精度が出ません。
              まずは「Keypoint R-CNN (ResNet50) COCO事前学習」を推奨します。
            </div>
          )}
          <div className="train-row">
            <label className="image-detect-label">エポック: {epochs}</label>
            <input type="range" min="1" max={selected3d ? 200 : 50} value={epochs} onChange={e => setEpochs(parseInt(e.target.value))} className="image-detect-slider" />
            <label className="image-detect-label">バッチ: {batchSize}</label>
            <input type="range" min="1" max={selected3d ? 32 : 8} value={batchSize} onChange={e => setBatchSize(parseInt(e.target.value))} className="image-detect-slider" />
          </div>
          <button className="btn primary" onClick={startTrain} disabled={annotatedReady.length === 0}>🚀 学習開始</button>
        </div>
      )}

      {running && (
        <div className="train-running">
          <div className="train-running-header">
            <span className="train-spinner">⏳ 学習中...</span>
            <button className="btn small danger" onClick={cancelTrain}>中止</button>
          </div>
          <pre className="train-log">{trainLog}</pre>
        </div>
      )}

      {!running && customModels.length > 0 && (
        <div className="train-models">
          <h3>学習済みカスタムモデル ({customModels.length})</h3>
          {customModels.map(m => (
            <div key={m.name} className="dataset-card">
              <div className="dataset-card-info">
                <div className="dataset-card-name">🎓 {m.name} {m.dim === '3d' && <span className="kp-3d-badge">3D</span>}</div>
                <div className="dataset-card-meta">
                  キーポイント: {(m.keypoints || []).length}点 · ベース: {m.baseModel} · loss: {m.finalLoss ?? '-'}
                </div>
              </div>
              <div className="dataset-card-actions">
                <button className="btn small" onClick={() => downloadModel(m.name)} disabled={downloading === m.name}>
                  {downloading === m.name ? '⏳ 準備中…' : '⬇ ダウンロード'}
                </button>
                <button className="btn small danger" onClick={() => deleteModel(m.name)}>削除</button>
              </div>
            </div>
          ))}
          <div className="train-hint">学習済みモデルは「🔍 検出」サブタブから選んで使えます。</div>
        </div>
      )}

      {!running && recentJobs.length > 0 && (
        <div className="train-jobs">
          <h3>学習履歴</h3>
          {recentJobs.slice(0, 5).map(j => (
            <div key={j.jobId} className={`train-job-item ${j.status}`}>
              <span>{j.status === 'completed' ? '✅' : '❌'} {j.modelName}</span>
              <span className="train-job-meta">
                {j.status === 'completed' ? `loss: ${j.finalLoss}, ${j.device}` : `エラー: ${j.error || '不明'}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// 検出ビュー (COCO人物17点 / カスタムモデル)
function KeypointDetectView({ showToast }) {
  const [customModels, setCustomModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('coco:keypointrcnn_resnet50_fpn');
  const [threshold, setThreshold] = useState(0.5);
  const [imageDataUrl, setImageDataUrl] = useState(null);
  const [detecting, setDetecting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const canvasRef = useRef(null);
  const imgRef = useRef(null);

  useEffect(() => {
    fetch('/ml/image/keypoint/custom-models')
      .then(r => r.ok ? r.json() : { models: [] })
      .then(d => setCustomModels(d.models || []))
      .catch(() => {});
  }, []);

  function onFileSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { setError('画像ファイルを選択してください'); return; }
    const reader = new FileReader();
    reader.onload = () => { setImageDataUrl(reader.result); setResult(null); setError(''); };
    reader.readAsDataURL(file);
  }

  useEffect(() => {
    if (!result || !imageDataUrl || !canvasRef.current || !imgRef.current) return;
    const img = imgRef.current;
    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = result.imageWidth;
      canvas.height = result.imageHeight;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const skeleton = result.skeleton || [];
      const r = Math.max(3, canvas.width / 200);
      const lw = Math.max(2, canvas.width / 400);
      (result.detections || []).forEach((det, di) => {
        const color = KP_COLORS[di % KP_COLORS.length];
        const { x1, y1, x2, y2 } = det.box;
        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        const kps = det.keypoints || [];
        ctx.lineWidth = lw;
        skeleton.forEach(([a, c]) => {
          if (kps[a] && kps[c]) {
            ctx.beginPath();
            ctx.moveTo(kps[a].x, kps[a].y);
            ctx.lineTo(kps[c].x, kps[c].y);
            ctx.stroke();
          }
        });
        kps.forEach(kp => {
          // 3D: z(相対深度)で点の大きさを変える (手前ほど大きく)。-1..1 → 半径 ×0.5..1.5
          const rr = result.is3d && typeof kp.z === 'number' ? r * (1 - kp.z * 0.5) : r;
          ctx.beginPath();
          ctx.arc(kp.x, kp.y, Math.max(2, rr), 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.lineWidth = Math.max(1, lw / 2);
          ctx.strokeStyle = '#fff';
          ctx.stroke();
        });
      });
    };
    if (img.complete) draw();
    else img.onload = draw;
  }, [result, imageDataUrl]);

  async function runDetect() {
    if (!imageDataUrl) { setError('画像を選択してください'); return; }
    setDetecting(true); setError(''); setResult(null);
    try {
      const [kind, mname] = selectedModel.split(':');
      const body = kind === 'custom'
        ? { image: imageDataUrl, customModel: mname, threshold }
        : { image: imageDataUrl, threshold };
      const res = await fetch('/ml/image/keypoint/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResult(data);
      if (data.count === 0) showToast('対象が検出されませんでした (しきい値を下げてみてください)');
      else showToast(`${data.count}個を検出しました`);
    } catch (e) {
      setError(`検出失敗: ${e.message}`);
    } finally {
      setDetecting(false);
    }
  }

  return (
    <div className="image-detect-view">
      <div className="image-detect-controls">
        <div className="image-detect-row">
          <label className="image-detect-label">モデル:</label>
          <select value={selectedModel} onChange={e => setSelectedModel(e.target.value)} className="image-detect-select">
            <optgroup label="COCO 事前学習 (人物17点)">
              <option value="coco:keypointrcnn_resnet50_fpn">Keypoint R-CNN (ResNet50) — 人物の姿勢17点</option>
            </optgroup>
            {customModels.length > 0 && (
              <optgroup label="カスタム学習済みモデル">
                {customModels.map(m => (
                  <option key={m.name} value={`custom:${m.name}`}>🎓 {m.name}{m.dim === '3d' ? ' [3D]' : ''} ({(m.keypoints || []).length}点)</option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        <div className="image-detect-row">
          <label className="image-detect-label">信頼度しきい値: {threshold.toFixed(2)}</label>
          <input type="range" min="0.05" max="0.95" step="0.05" value={threshold}
            onChange={e => setThreshold(parseFloat(e.target.value))} className="image-detect-slider" />
        </div>
        <div className="image-detect-row">
          <input type="file" accept="image/jpeg,image/png,image/bmp,image/webp,.jpg,.jpeg,.png,.bmp,.webp" onChange={onFileSelect} className="image-detect-file" />
          <button className="btn primary" onClick={runDetect} disabled={!imageDataUrl || detecting}>
            {detecting ? '🔍 検出中...' : '🔍 キーポイント検出を実行'}
          </button>
        </div>
        <div className="image-detect-hint">
          COCO事前学習モデルは人物の姿勢 (17点) を検出します。手など独自のキーポイントは
          「📊 データセット」で作成し「🚀 学習」したカスタムモデルを使ってください。
        </div>
      </div>

      {error && <div className="warn-banner">{error}</div>}

      <div className="image-detect-canvas-wrap">
        {imageDataUrl && (
          <>
            <img ref={imgRef} src={imageDataUrl} style={{ display: 'none' }} alt="source" />
            <canvas ref={canvasRef} className="image-detect-canvas" />
          </>
        )}
        {!imageDataUrl && <div className="empty-state">画像ファイルを選択してください</div>}
      </div>

      {result && (
        <div className="image-detect-result">
          <div className="image-detect-summary">
            <strong>{result.count}個</strong> 検出 ·
            モデル: {result.model} ·
            デバイス: {result.device} ·
            画像: {result.imageWidth}×{result.imageHeight}
          </div>
          {result.note && (
            <div className="image-detect-summary" style={{ color: 'var(--orange, #ff9500)' }}>⚠️ {result.note}</div>
          )}
          <details className="image-detect-details">
            <summary>検出の詳細 ({result.count}件)</summary>
            {(result.detections || []).map((d, i) => (
              <div key={i} style={{ marginBottom: 8 }}>
                <div><strong>対象#{i + 1}</strong>{!result.is3d && ` 信頼度 ${(d.score * 100).toFixed(1)}%`}</div>
                <table className="image-detect-table">
                  <thead><tr><th>#</th><th>名前</th><th>x</th><th>y</th>{result.is3d ? <th>z(深度)</th> : <th>信頼度</th>}</tr></thead>
                  <tbody>
                    {(d.keypoints || []).map((kp, ki) => (
                      <tr key={ki}>
                        <td>{ki}</td><td>{kp.name}</td><td>{kp.x}</td><td>{kp.y}</td>
                        {result.is3d
                          ? <td>{kp.z != null ? kp.z.toFixed(3) : '-'}</td>
                          : <td>{kp.score != null ? kp.score.toFixed(2) : '-'}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </details>
        </div>
      )}
    </div>
  );
}

// ─── クエリビュー ───
function QueryView({ sql, setSql, result, error, onRun, tables }) {
  function insertTableName(name) {
    setSql(prev => prev + name);
  }
  return (
    <div className="ml-query-view">
      <div className="toolbar">
        <button className="btn primary" onClick={onRun}>▶ 実行 (Ctrl+Enter)</button>
        <span className="hint">読み取り専用 (SELECT / WITH のみ、LIMIT無しは自動で1000行に制限)</span>
      </div>
      <textarea
        className="ml-sql-input"
        value={sql}
        onChange={e => setSql(e.target.value)}
        onKeyDown={e => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); onRun(); }
        }}
        placeholder="SELECT * FROM your_table WHERE ..."
        spellCheck="false"
        rows={8}
      />
      {tables.length > 0 && (
        <div className="ml-table-pills">
          <span style={{color: 'var(--text-muted)', fontSize: 11}}>テーブル挿入:</span>
          {tables.map(t => (
            <button key={t.name} className="pill" onClick={() => insertTableName(t.name)}>{t.name}</button>
          ))}
        </div>
      )}
      {error && <div className="error-box">❌ {error}</div>}
      {result && (
        <div className="ml-section">
          <h3>
            結果: {result.count.toLocaleString()} 行 ({result.elapsedMs}ms)
            {result.truncated && <span style={{color: 'var(--orange)', fontSize: 12, marginLeft: 8}}>※ LIMIT で制限されています</span>}
          </h3>
          <ResultTable rows={result.rows} />
        </div>
      )}
    </div>
  );
}

// ─── 🧠 モデル管理ビュー ───
function ModelsView({ tables, showToast }) {
  const [models, setModels] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [runningJobId, setRunningJobId] = useState(null);
  const [editing, setEditing] = useState(null);  // 編集中のモデル定義
  const [showCreate, setShowCreate] = useState(false);
  const [selectedJob, setSelectedJob] = useState(null);
  const [jobLog, setJobLog] = useState('');
  const [predictModel, setPredictModel] = useState(null);  // 予測ダイアログ対象

  useEffect(() => {
    loadModels();
    loadJobs();
    const t = setInterval(() => { loadModels(); loadJobs(); }, 3000);
    return () => clearInterval(t);
  }, []);

  // 選択中のジョブのログを定期取得
  useEffect(() => {
    if (!selectedJob) { setJobLog(''); return; }
    const fetchLog = async () => {
      try {
        const r = await fetch(`/ml/jobs/${selectedJob}/log`);
        const data = await r.json();
        setJobLog(data.log || '');
        // 実行中でなければポーリング停止のフラグを立てるため、コンポーネント側で判断
      } catch {}
    };
    fetchLog();
    const t = setInterval(fetchLog, 2000);
    return () => clearInterval(t);
  }, [selectedJob]);

  async function loadModels() {
    try {
      const r = await fetch('/ml/models');
      const data = await r.json();
      setModels(data.models || []);
      setRunningJobId(data.runningJob?.jobId || null);
    } catch {}
  }
  async function loadJobs() {
    try {
      const r = await fetch('/ml/jobs');
      const data = await r.json();
      setJobs(data.jobs || []);
    } catch {}
  }

  async function startJob(modelName) {
    if (runningJobId) {
      showToast('既に学習中のジョブがあります', 'error');
      return;
    }
    try {
      const r = await fetch('/ml/jobs/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelName }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      showToast(`学習開始: ${modelName} (${data.jobId})`, 'success');
      setSelectedJob(data.jobId);
      loadJobs();
    } catch (e) { showToast(`開始失敗: ${e.message}`, 'error'); }
  }

  async function stopJob(jobId) {
    if (!confirm(`ジョブ ${jobId} を停止しますか?`)) return;
    try {
      const r = await fetch(`/ml/jobs/${jobId}/stop`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      showToast('停止要求しました', 'success');
    } catch (e) { showToast(`停止失敗: ${e.message}`, 'error'); }
  }

  async function deleteModel(name) {
    if (!confirm(`モデル「${name}」と学習成果物を完全に削除します。よろしいですか?`)) return;
    try {
      const r = await fetch(`/ml/models/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      showToast('削除しました', 'success');
      loadModels();
    } catch (e) { showToast(`削除失敗: ${e.message}`, 'error'); }
  }

  return (
    <div className="ml-models-view">
      <div className="toolbar">
        <button className="btn primary" onClick={() => { setEditing(null); setShowCreate(true); }}>
          ➕ モデルを新規作成
        </button>
        {runningJobId && (
          <span style={{
            background: 'var(--orange-dim)', color: 'var(--orange)',
            padding: '4px 10px', borderRadius: 10, fontSize: 12,
            fontFamily: 'var(--font-mono)',
          }}>⚙️ 学習中: {runningJobId}</span>
        )}
      </div>

      <div className="ml-layout">
        {/* 左: モデル一覧 */}
        <div className="ml-table-list">
          {models.length === 0 ? (
            <div className="empty-state">
              モデルがありません。<br />「➕ モデルを新規作成」から開始してください。
            </div>
          ) : models.map(m => (
            <div key={m.name} className="ml-table-item" style={{position: 'relative'}}>
              <button
                className="ml-model-delete-btn"
                onClick={(e) => { e.stopPropagation(); deleteModel(m.name); }}
                title={`モデル「${m.name}」を削除`}
                aria-label="削除"
              >×</button>
              <div className="ml-table-name" style={{paddingRight: 24}}>
                {m.task === 'regression' ? '📈' : m.task === 'classification' ? '🏷️' : '⏱️'} {m.name}
                {m.trained && <span style={{
                  marginLeft: 6, fontSize: 10,
                  background: 'var(--accent-dim)', color: 'var(--accent)',
                  padding: '1px 6px', borderRadius: 8,
                }}>✓ 学習済</span>}
              </div>
              <div className="ml-table-meta">
                {m.task} | テーブル: {m.tableName}
              </div>
              {m.description && <div className="ml-table-desc">{m.description}</div>}
              {m.metrics && (
                <div style={{fontSize: 10, color: 'var(--text-muted)', marginTop: 4, fontFamily: 'var(--font-mono)'}}>
                  {m.metrics.finalAccuracy !== undefined && m.metrics.finalAccuracy !== null
                    ? `acc: ${(m.metrics.finalAccuracy * 100).toFixed(1)}%`
                    : m.metrics.finalMAE !== undefined && m.metrics.finalMAE !== null
                    ? `MAE: ${m.metrics.finalMAE.toFixed(3)}`
                    : `loss: ${m.metrics.finalTestLoss?.toFixed(4)}`}
                  {' '}({m.metrics.trainSamples}/{m.metrics.testSamples} samples)
                </div>
              )}
              <div style={{display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap'}}>
                <button className="btn small primary"
                  onClick={() => startJob(m.name)}
                  disabled={!!runningJobId}>
                  ▶ 学習開始
                </button>
                {m.trained && (
                  <button className="btn small"
                    onClick={() => setPredictModel(m)}
                    disabled={!!runningJobId}
                    title="学習済みモデルで予測を実行">
                    🎯 予測
                  </button>
                )}
                <button className="btn small" onClick={() => { setEditing(m); setShowCreate(true); }}>✏️ 編集</button>
              </div>
            </div>
          ))}
        </div>

        {/* 右: ジョブ履歴 + ログ */}
        <div className="ml-table-detail">
          <h3 style={{marginTop: 0}}>学習ジョブ履歴</h3>
          {jobs.length === 0 ? (
            <div className="empty-state">ジョブがまだありません</div>
          ) : (
            <div style={{maxHeight: 250, overflowY: 'auto', marginBottom: 16}}>
              {jobs.map(j => (
                <div
                  key={j.id}
                  className={`ml-table-item ${selectedJob === j.id ? 'selected' : ''}`}
                  onClick={() => setSelectedJob(j.id)}
                  style={{marginBottom: 6}}
                >
                  <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                    <span className="ml-table-name">
                      {j.status === 'running' ? '⚙️' : j.status === 'completed' ? '✅' : '❌'} {j.modelName}
                    </span>
                    {j.status === 'running' && j.id === runningJobId && (
                      <button className="btn small danger" onClick={(e) => { e.stopPropagation(); stopJob(j.id); }}>⏹ 停止</button>
                    )}
                  </div>
                  <div className="ml-table-meta">
                    {new Date(j.startedAt).toLocaleString('ja-JP')}
                    {j.endedAt && ` • ${Math.round((j.endedAt - j.startedAt) / 1000)}秒`}
                    {j.finalAccuracy !== undefined && j.finalAccuracy !== null && ` • acc=${(j.finalAccuracy * 100).toFixed(1)}%`}
                    {j.finalMAE !== undefined && j.finalMAE !== null && ` • MAE=${j.finalMAE.toFixed(3)}`}
                  </div>
                </div>
              ))}
            </div>
          )}

          {selectedJob && (
            <div>
              <h3>ジョブログ: {selectedJob}</h3>
              <pre style={{
                background: 'var(--bg-tertiary)',
                color: 'var(--text-primary)',
                padding: 10,
                borderRadius: 4,
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                maxHeight: 400,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                margin: 0,
              }}>{jobLog || '(ログを取得中...)'}</pre>
            </div>
          )}
        </div>
      </div>

      {showCreate && (
        <ModelEditDialog
          tables={tables}
          initial={editing}
          onClose={() => setShowCreate(false)}
          onDone={() => { setShowCreate(false); loadModels(); }}
          showToast={showToast}
        />
      )}
      {predictModel && (
        <PredictDialog
          model={predictModel}
          onClose={() => setPredictModel(null)}
          showToast={showToast}
        />
      )}
    </div>
  );
}

// ─── 🎯 予測ダイアログ ───
function PredictDialog({ model, onClose, showToast }) {
  // model.features: ["region", "product", "quantity"] 等
  // 学習済みのため、テーブルからカテゴリ列の値候補を取得して select 化
  const [values, setValues] = useState({});
  const [columnInfo, setColumnInfo] = useState(null);  // {colName: {type, options?}}
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  // 学習時の元テーブルから列情報を取得して、カテゴリ列なら DISTINCT 値を select 候補に
  useEffect(() => {
    if (!model) return;
    (async () => {
      try {
        // テーブルのスキーマ
        const schemaRes = await fetch(`/ml/datasets/${encodeURIComponent(model.tableName)}/schema`);
        const schema = await schemaRes.json();
        if (!schemaRes.ok) {
          setError(`スキーマ取得失敗: ${schema.error || schemaRes.status}`);
          return;
        }
        const info = {};
        for (const col of model.features) {
          const colSchema = schema.columns?.find(c => c.name === col);
          if (!colSchema) {
            info[col] = { type: 'unknown' };
            continue;
          }
          const t = (colSchema.type || '').toUpperCase();
          if (t.includes('DATE') || t.includes('TIME') || t.includes('TIMESTAMP')) {
            info[col] = { type: 'datetime', rawType: colSchema.type };
          } else if (t.includes('VARCHAR') || t.includes('TEXT') || t.includes('STRING') || t === 'BOOLEAN') {
            // DISTINCT 値を取得 (上限 100件)
            try {
              const qRes = await fetch('/ml/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  sql: `SELECT DISTINCT "${col}" AS v FROM "${model.tableName}" WHERE "${col}" IS NOT NULL ORDER BY 1 LIMIT 100`,
                }),
              });
              const qData = await qRes.json();
              info[col] = {
                type: 'category',
                options: (qData.rows || []).map(r => r.v),
                rawType: colSchema.type,
              };
            } catch {
              info[col] = { type: 'category', options: [], rawType: colSchema.type };
            }
          } else {
            info[col] = { type: 'numeric', rawType: colSchema.type };
          }
        }
        setColumnInfo(info);
      } catch (e) {
        setError(`列情報取得失敗: ${e.message}`);
      }
    })();
  }, [model]);

  async function runPredict() {
    // 入力検証
    for (const col of model.features) {
      if (values[col] === undefined || values[col] === '') {
        showToast(`特徴量 "${col}" を入力してください`, 'error');
        return;
      }
    }
    setBusy(true);
    setError('');
    setResult(null);
    try {
      // 数値型は数値に変換、日時/カテゴリ/その他は文字列のまま
      const features = {};
      for (const col of model.features) {
        const v = values[col];
        if (columnInfo?.[col]?.type === 'numeric') {
          const n = parseFloat(v);
          if (isNaN(n)) throw new Error(`"${col}" は数値である必要があります: ${v}`);
          features[col] = n;
        } else {
          // datetime / category / unknown はそのまま渡す (Python側で適切にパース)
          features[col] = v;
        }
      }
      const r = await fetch(`/ml/models/${encodeURIComponent(model.name)}/predict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ features }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setResult(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{maxWidth: 600}}>
        <div className="modal-header">
          <div className="modal-title">🎯 予測: {model.name}</div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div style={{
            background: 'var(--bg-tertiary)',
            padding: 8, borderRadius: 4, marginBottom: 12, fontSize: 11,
            color: 'var(--text-secondary)',
          }}>
            <div>{model.task === 'regression' ? '📈 回帰' : model.task === 'classification' ? '🏷️ 分類' : '⏱️ 時系列'}</div>
            <div>テーブル: <code>{model.tableName}</code> / ターゲット: <code>{model.target}</code></div>
          </div>

          {!columnInfo ? (
            <div className="empty-state">列情報を読み込み中...</div>
          ) : (
            <>
              {model.features.map(col => {
                const info = columnInfo[col] || {};
                return (
                  <div key={col} className="field">
                    <label className="field-label">
                      {col} <span style={{color: 'var(--text-muted)', fontWeight: 'normal', fontSize: 11}}>({info.rawType || info.type})</span>
                    </label>
                    {info.type === 'category' && info.options?.length > 0 ? (
                      <select className="select" value={values[col] ?? ''} onChange={e => setValues({...values, [col]: e.target.value})}>
                        <option value="">-- 選択 --</option>
                        {info.options.map(o => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : info.type === 'datetime' ? (
                      <input className="input" type="date"
                        value={values[col] ?? ''}
                        onChange={e => setValues({...values, [col]: e.target.value})} />
                    ) : info.type === 'numeric' ? (
                      <input className="input" type="number" step="any"
                        value={values[col] ?? ''}
                        onChange={e => setValues({...values, [col]: e.target.value})}
                        placeholder="数値" />
                    ) : (
                      <input className="input"
                        value={values[col] ?? ''}
                        onChange={e => setValues({...values, [col]: e.target.value})} />
                    )}
                  </div>
                );
              })}
            </>
          )}

          {error && <div className="error-box" style={{marginTop: 10}}>❌ {error}</div>}

          {result && (
            <div style={{
              marginTop: 14, padding: 12,
              background: 'linear-gradient(135deg, rgba(46, 204, 113, 0.08), rgba(46, 204, 113, 0.03))',
              border: '1px solid rgba(46, 204, 113, 0.3)',
              borderRadius: 4,
            }}>
              <div style={{fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6}}>📊 予測結果</div>
              {model.task === 'classification' ? (
                <div>
                  <div style={{fontSize: 24, color: 'var(--accent)', fontWeight: 600, marginBottom: 8}}>
                    {result.predictions[0]}
                  </div>
                  <div style={{fontSize: 11, color: 'var(--text-muted)'}}>確率:</div>
                  {result.classes.map((cls, i) => (
                    <div key={cls} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      fontSize: 12, marginTop: 4, fontFamily: 'var(--font-mono)',
                    }}>
                      <span>{cls}</span>
                      <span>
                        {(result.probabilities[0][i] * 100).toFixed(1)}%
                        <span style={{
                          display: 'inline-block', width: 100, height: 6, marginLeft: 8,
                          background: 'var(--bg-tertiary)', borderRadius: 3, overflow: 'hidden',
                          verticalAlign: 'middle',
                        }}>
                          <span style={{
                            display: 'block', height: '100%',
                            width: `${result.probabilities[0][i] * 100}%`,
                            background: cls === result.predictions[0] ? 'var(--accent)' : 'var(--text-muted)',
                          }} />
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{fontSize: 28, color: 'var(--accent)', fontWeight: 600, fontFamily: 'var(--font-mono)'}}>
                  {result.predictions[0].toLocaleString(undefined, {maximumFractionDigits: 2})}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>閉じる</button>
          <button className="btn primary" onClick={runPredict} disabled={busy || !columnInfo}>
            {busy ? '推論中...' : '🎯 予測実行'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── モデル定義 編集/作成ダイアログ ───
function ModelEditDialog({ tables, initial, onClose, onDone, showToast }) {
  const [name, setName] = useState(initial?.name || '');
  const [task, setTask] = useState(initial?.task || 'regression');
  const [tableName, setTableName] = useState(initial?.tableName || '');
  const [tableSchema, setTableSchema] = useState(null);
  const [features, setFeatures] = useState(initial?.features || []);
  const [target, setTarget] = useState(initial?.target || '');
  const [timeCol, setTimeCol] = useState(initial?.timeCol || '');
  const [windowSize, setWindowSize] = useState(initial?.windowSize || 7);
  const [epochs, setEpochs] = useState(initial?.epochs || 300);
  const [learningRate, setLearningRate] = useState(initial?.learningRate || 0.001);
  const [batchSize, setBatchSize] = useState(initial?.batchSize || 32);
  const [hiddenSize, setHiddenSize] = useState(initial?.hiddenSize || 64);
  const [numLayers, setNumLayers] = useState(initial?.numLayers || 2);
  const [testRatio, setTestRatio] = useState(initial?.testRatio || 0.2);
  const [description, setDescription] = useState(initial?.description || '');
  const [busy, setBusy] = useState(false);

  // 選択されたテーブルのスキーマを取得
  useEffect(() => {
    if (!tableName) { setTableSchema(null); return; }
    (async () => {
      try {
        const r = await fetch(`/ml/datasets/${encodeURIComponent(tableName)}/schema`);
        const data = await r.json();
        if (r.ok) setTableSchema(data);
      } catch {}
    })();
  }, [tableName]);

  function toggleFeature(col) {
    setFeatures(prev => prev.includes(col) ? prev.filter(c => c !== col) : [...prev, col]);
  }

  async function submit() {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name)) {
      showToast('モデル名は英字で始まり英数字とアンダースコアのみ', 'error');
      return;
    }
    if (!tableName) { showToast('テーブルを選択してください', 'error'); return; }
    if (features.length === 0) { showToast('特徴量を1つ以上選択', 'error'); return; }
    if (!target) { showToast('ターゲットを選択', 'error'); return; }
    if (task === 'timeseries' && !timeCol) { showToast('時系列タスクには時間カラムを選択', 'error'); return; }
    if (features.includes(target)) { showToast('ターゲットは特徴量と重複できません', 'error'); return; }

    setBusy(true);
    try {
      const r = await fetch('/ml/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name, task, tableName, features, target,
          timeCol: task === 'timeseries' ? timeCol : null,
          windowSize: task === 'timeseries' ? parseInt(windowSize) : null,
          epochs: parseInt(epochs),
          learningRate: parseFloat(learningRate),
          batchSize: parseInt(batchSize),
          hiddenSize: parseInt(hiddenSize),
          numLayers: parseInt(numLayers),
          testRatio: parseFloat(testRatio),
          description,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      showToast(initial ? 'モデル定義を更新しました' : 'モデル定義を作成しました', 'success');
      onDone();
    } catch (e) { showToast(`失敗: ${e.message}`, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{maxWidth: 720}}>
        <div className="modal-header">
          <div className="modal-title">{initial ? '✏️ モデル定義を編集' : '➕ モデルを新規作成'}</div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12}}>
            <div className="field">
              <label className="field-label">モデル名</label>
              <input className="input" value={name} onChange={e => setName(e.target.value)}
                placeholder="例: sales_predictor" disabled={!!initial} />
              <span className="field-hint">英字+英数字+アンダースコア、最大64文字。作成後は変更不可。</span>
            </div>
            <div className="field">
              <label className="field-label">タスク種別</label>
              <select className="select" value={task} onChange={e => setTask(e.target.value)}>
                <option value="regression">📈 回帰 (数値予測, MLP)</option>
                <option value="classification">🏷️ 分類 (カテゴリ予測, MLP)</option>
                <option value="timeseries">⏱️ 時系列 (LSTM)</option>
              </select>
            </div>
          </div>

          <div className="field">
            <label className="field-label">データテーブル</label>
            <select className="select" value={tableName} onChange={e => setTableName(e.target.value)}>
              <option value="">-- 選択 --</option>
              {tables.map(t => (
                <option key={t.name} value={t.name}>{t.name} ({t.rowCount.toLocaleString()} 行)</option>
              ))}
            </select>
          </div>

          {tableSchema && (
            <>
              <div className="field">
                <label className="field-label">特徴量カラム (複数選択)</label>
                <div style={{
                  border: '1px solid var(--border)', borderRadius: 4, padding: 8,
                  background: 'var(--bg-tertiary)', maxHeight: 150, overflowY: 'auto',
                }}>
                  {tableSchema.columns.map(c => {
                    const isDatetime = /date|time|timestamp/i.test(c.type);
                    const isDisabled = c.name === target;
                    return (
                      <label key={c.name} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        marginRight: 12, marginBottom: 4, fontSize: 12,
                        cursor: isDisabled ? 'not-allowed' : 'pointer',
                      }}
                      title={isDatetime
                        ? '日時列は自動で年/月/日/曜日/曜日種別の6特徴量に分解されます (推論時も日付文字列を渡せばOK)'
                        : ''}>
                        <input type="checkbox"
                          checked={features.includes(c.name)}
                          onChange={() => toggleFeature(c.name)}
                          disabled={isDisabled}
                        />
                        <code style={{
                          color: c.name === target ? 'var(--text-muted)'
                              : isDatetime ? 'var(--accent)' : 'var(--accent)'
                        }}>{c.name}</code>
                        <span style={{color: 'var(--text-muted)', fontSize: 10}}>({c.type})</span>
                        {isDatetime && (
                          <span style={{color: 'var(--accent)', fontSize: 9}} title="自動分解">📅 自動分解</span>
                        )}
                      </label>
                    );
                  })}
                </div>
                <span className="field-hint">
                  数値列は自動 StandardScale、文字列列は自動 LabelEncoder されます。<br />
                  <span style={{color: 'var(--accent)'}}>📅 日時列を選ぶと自動で year/month/day/dayofweek/dayofyear/is_weekend の6特徴に分解されます (季節性や曜日効果を学習)。</span>
                </span>
              </div>

              <div style={{display: 'grid', gridTemplateColumns: task === 'timeseries' ? '1fr 1fr' : '1fr', gap: 12}}>
                <div className="field">
                  <label className="field-label">ターゲット (予測対象)</label>
                  <select className="select" value={target} onChange={e => setTarget(e.target.value)}>
                    <option value="">-- 選択 --</option>
                    {tableSchema.columns.filter(c => !features.includes(c.name)).map(c => (
                      <option key={c.name} value={c.name}>{c.name} ({c.type})</option>
                    ))}
                  </select>
                </div>
                {task === 'timeseries' && (
                  <div className="field">
                    <label className="field-label">時間カラム (ソート用)</label>
                    <select className="select" value={timeCol} onChange={e => setTimeCol(e.target.value)}>
                      <option value="">-- 選択 --</option>
                      {tableSchema.columns.map(c => (
                        <option key={c.name} value={c.name}>{c.name}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {task === 'timeseries' && (
                <div className="field">
                  <label className="field-label">ウィンドウサイズ (過去N点を入力)</label>
                  <input className="input" type="number" min="2" max="200" value={windowSize}
                    onChange={e => setWindowSize(e.target.value)} />
                </div>
              )}
            </>
          )}

          <div className="field">
            <label className="field-label">説明 (任意)</label>
            <input className="input" value={description} onChange={e => setDescription(e.target.value)}
              placeholder="例: 月別売上から翌月を予測するモデル" />
          </div>

          <details style={{marginTop: 8}}>
            <summary style={{cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)', userSelect: 'none'}}>
              ⚙️ 学習ハイパーパラメータ (詳細)
            </summary>
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginTop: 12,
            }}>
              <div className="field">
                <label className="field-label">エポック数</label>
                <input className="input" type="number" min="1" max="10000" value={epochs}
                  onChange={e => setEpochs(e.target.value)} />
              </div>
              <div className="field">
                <label className="field-label">学習率</label>
                <input className="input" type="number" step="0.0001" min="0.00001" max="1" value={learningRate}
                  onChange={e => setLearningRate(e.target.value)} />
              </div>
              <div className="field">
                <label className="field-label">バッチサイズ</label>
                <input className="input" type="number" min="1" max="2048" value={batchSize}
                  onChange={e => setBatchSize(e.target.value)} />
              </div>
              <div className="field">
                <label className="field-label">隠れ層サイズ</label>
                <input className="input" type="number" min="2" max="1024" value={hiddenSize}
                  onChange={e => setHiddenSize(e.target.value)} />
              </div>
              <div className="field">
                <label className="field-label">層数</label>
                <input className="input" type="number" min="1" max="10" value={numLayers}
                  onChange={e => setNumLayers(e.target.value)} />
              </div>
              <div className="field">
                <label className="field-label">テスト分割比</label>
                <input className="input" type="number" step="0.05" min="0.05" max="0.5" value={testRatio}
                  onChange={e => setTestRatio(e.target.value)} />
              </div>
            </div>
          </details>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>キャンセル</button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? '保存中...' : (initial ? '更新' : '作成')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 🎮 強化学習 (RL) ビュー ───
// データテーブルのログ済み経験データからオフラインRL (DQN / Double DQN / CQL / BC) で
// エージェントを学習し、損失曲線・オフライン方策評価・推論(推奨行動)までを行う。
const RL_ALGO_SHORT = { dqn: 'DQN', ddqn: 'Double DQN', cql: 'CQL', bc: 'BC' };

// オフラインRL の学習損失曲線を canvas に描画
function LossChart({ metrics, height = 200 }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current;
    const loss = (metrics && metrics.lossHistory) || [];
    if (!cv || loss.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = height;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H);
    const pad = { l: 56, r: 10, t: 12, b: 24 };
    const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
    let yMin = Math.min(...loss), yMax = Math.max(...loss);
    if (yMin === yMax) { yMin = 0; yMax = yMax || 1; } else { yMin = Math.min(yMin, 0); }
    const n = loss.length;
    const x = i => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
    const y = v => pad.t + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;
    const css = getComputedStyle(document.documentElement);
    const cBorder = (css.getPropertyValue('--border') || '#2a2a3e').trim();
    const cAccent = (css.getPropertyValue('--accent') || '#7c4dff').trim();
    const cMuted = (css.getPropertyValue('--text-muted') || '#888').trim();
    ctx.strokeStyle = cBorder; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, pad.t + plotH); ctx.lineTo(pad.l + plotW, pad.t + plotH); ctx.stroke();
    ctx.fillStyle = cMuted; ctx.font = '10px monospace'; ctx.textAlign = 'right';
    for (let k = 0; k <= 4; k++) {
      const v = yMin + (yMax - yMin) * k / 4, yy = y(v);
      ctx.fillText(v.toFixed(3), pad.l - 5, yy + 3);
      ctx.strokeStyle = 'rgba(128,128,128,0.12)';
      ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(pad.l + plotW, yy); ctx.stroke();
    }
    ctx.textAlign = 'center'; ctx.fillStyle = cMuted;
    ctx.fillText('エポック', pad.l + plotW / 2, pad.t + plotH + 14);
    ctx.strokeStyle = cAccent; ctx.lineWidth = 2; ctx.beginPath();
    loss.forEach((v, i) => { i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v)); });
    ctx.stroke();
  }, [metrics, height]);
  return <canvas ref={ref} style={{ width: '100%', height, display: 'block' }} />;
}

// ─── オンラインRL 用: 単系列のライブ折れ線グラフ (reward EMA / loss EMA の推移) ───
function OnlineSeriesChart({ data, color = '#7c4dff', height = 110 }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current;
    const arr = (data || []).filter(v => v != null && isFinite(v));
    if (!cv || arr.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = height;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H);
    const pad = { l: 56, r: 10, t: 10, b: 18 };
    const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
    let yMin = Math.min(...arr), yMax = Math.max(...arr);
    if (yMin === yMax) { yMax = yMax + 1; yMin = yMin - 1; }
    const n = arr.length;
    const x = i => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
    const y = v => pad.t + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;
    const css = getComputedStyle(document.documentElement);
    const cBorder = (css.getPropertyValue('--border') || '#2a2a3e').trim();
    const cMuted = (css.getPropertyValue('--text-muted') || '#888').trim();
    ctx.strokeStyle = cBorder; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, pad.t + plotH); ctx.lineTo(pad.l + plotW, pad.t + plotH); ctx.stroke();
    ctx.fillStyle = cMuted; ctx.font = '10px monospace'; ctx.textAlign = 'right';
    for (let k = 0; k <= 3; k++) {
      const v = yMin + (yMax - yMin) * k / 3, yy = y(v);
      ctx.fillText(v.toFixed(2), pad.l - 5, yy + 3);
      ctx.strokeStyle = 'rgba(128,128,128,0.12)';
      ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(pad.l + plotW, yy); ctx.stroke();
    }
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    arr.forEach((v, i) => { i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v)); });
    ctx.stroke();
  }, [data, color, height]);
  return <canvas ref={ref} style={{ width: '100%', height, display: 'block' }} />;
}

// ─── オンラインRL 用: act の Q値を行動ごとの横棒で可視化 (方策の評価) ───
function QValueBars({ qValues, chosen }) {
  const entries = Object.entries(qValues || {});
  if (entries.length === 0) return null;
  const vals = entries.map(([, v]) => v);
  const min = Math.min(...vals), max = Math.max(...vals);
  return (
    <div style={{ marginTop: 8 }}>
      <div className="rl-panel-title" style={{ fontSize: 12 }}>Q値（各行動の推定価値・★が推奨）</div>
      {entries.map(([k, v]) => {
        const w = max === min ? 100 : ((v - min) / (max - min)) * 100;
        const isChosen = String(k) === String(chosen);
        return (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '3px 0', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
            <span style={{ width: 72, textAlign: 'right', color: isChosen ? 'var(--accent)' : 'var(--text-secondary)', fontWeight: isChosen ? 700 : 400 }}>{k}{isChosen ? ' ★' : ''}</span>
            <div style={{ flex: 1, background: 'var(--border)', borderRadius: 6, height: 14 }}>
              <div style={{ width: `${Math.max(2, w)}%`, height: '100%', borderRadius: 6, background: isChosen ? 'var(--accent)' : 'rgba(124,77,255,0.4)' }} />
            </div>
            <span style={{ width: 64, color: 'var(--text-muted)' }}>{v}</span>
          </div>
        );
      })}
    </div>
  );
}

// オフラインRL のオフライン評価結果 (方策一致率・行動分布・推薦サンプル) を表示
function DatasetEvalResult({ result }) {
  const labels = result.actionLabels || [];
  const maxCount = Math.max(1, ...labels.map(l => Math.max(result.loggedActionDist?.[l] || 0, result.policyActionDist?.[l] || 0)));
  return (
    <div>
      <div className="rl-eval-stats">
        <div className="rl-stat"><div className="rl-stat-v">{Math.round((result.policyAgreement || 0) * 100)}%</div><div className="rl-stat-l">方策一致率<br />(ログ行動と)</div></div>
        <div className="rl-stat"><div className="rl-stat-v">{result.meanQ}</div><div className="rl-stat-l">推定価値<br />(平均maxQ)</div></div>
        <div className="rl-stat"><div className="rl-stat-v">{result.loggedMeanReward}</div><div className="rl-stat-l">ログ<br />平均報酬</div></div>
        <div className="rl-stat"><div className="rl-stat-v" style={{ color: 'var(--accent)' }}>{result.rewardWhenFollowed ?? '—'}</div><div className="rl-stat-l">推奨一致時<br />平均報酬</div></div>
      </div>
      <div className="rl-agent-meta" style={{ margin: '4px 0 10px' }}>
        {result.datasetMode === 'transition' ? '遷移ベース' : 'バンディット'} · {result.nRows}行で評価。
        「推奨一致時平均報酬」が「ログ平均報酬」より高ければ、学習した方策の方が良い選択をしています。
      </div>
      <div className="rl-panel-title" style={{ fontSize: 12 }}>行動の分布 (ログ vs 学習方策)</div>
      <div className="rl-dist">
        {labels.map(l => (
          <div key={l} className="rl-dist-row">
            <div className="rl-dist-label">{l}</div>
            <div className="rl-dist-bars">
              <div className="rl-dist-bar"><div className="rl-bar logged" style={{ width: `${(result.loggedActionDist?.[l] || 0) / maxCount * 100}%` }}></div><span>{result.loggedActionDist?.[l] || 0}</span></div>
              <div className="rl-dist-bar"><div className="rl-bar policy" style={{ width: `${(result.policyActionDist?.[l] || 0) / maxCount * 100}%` }}></div><span>{result.policyActionDist?.[l] || 0}</span></div>
            </div>
          </div>
        ))}
      </div>
      <div className="rl-chart-legend" style={{ marginTop: 4 }}>
        <span><span className="lg-line" style={{ background: 'rgba(124,77,255,0.4)' }}></span>ログ(実績)</span>
        <span><span className="lg-line" style={{ background: 'var(--accent)' }}></span>学習方策(推奨)</span>
      </div>
      <div className="rl-panel-title" style={{ fontSize: 12, marginTop: 12 }}>推薦サンプル (先頭{(result.samples || []).length}件)</div>
      <div className="rl-sample-wrap">
        <table className="rl-sample-table">
          <thead><tr><th>状態</th><th>実績</th><th>推奨</th><th>報酬</th></tr></thead>
          <tbody>
            {(result.samples || []).map((s, i) => {
              const changed = s.loggedAction !== s.recommendedAction;
              return (
                <tr key={i}>
                  <td>{Object.entries(s.state).map(([k, v]) => `${k}=${v}`).join(', ')}</td>
                  <td>{s.loggedAction}</td>
                  <td style={{ color: changed ? 'var(--accent)' : 'inherit', fontWeight: changed ? 600 : 400 }}>
                    {s.recommendedAction}{changed ? ' ↗' : ''}
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)' }}>{s.reward}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RLView({ showToast }) {
  const [algos, setAlgos] = useState([]);
  const [models, setModels] = useState([]);
  const [running, setRunning] = useState(null);   // { jobId, name }
  const [liveLog, setLiveLog] = useState('');
  const [recentJobs, setRecentJobs] = useState([]);
  const [showTrain, setShowTrain] = useState(false);  // 学習ダイアログ表示
  // テーブル一覧 (学習ダイアログへ渡す)
  const [tables, setTables] = useState([]);
  // 学習曲線 / 評価
  const [chartFor, setChartFor] = useState(null);   // { name, metrics }
  const [evalResult, setEvalResult] = useState(null); // eval API 結果
  const [evalFor, setEvalFor] = useState(null);     // 評価対象エージェント名
  const [evaluating, setEvaluating] = useState(false);
  // ⚡ オンライン学習
  const [onlineFor, setOnlineFor] = useState(null);     // オンラインパネル対象
  const [onlineStatus, setOnlineStatus] = useState(null);
  const [onlineHist, setOnlineHist] = useState([]);     // [{step, loss, reward}] パネル表示中のEMA推移
  const [evalOnline, setEvalOnline] = useState(false);  // 評価パネルがオンライン用か
  const [onlineEvalResult, setOnlineEvalResult] = useState(null); // オンライン評価(act, ε=0)の結果
  const [actInput, setActInput] = useState('{}');       // act/learn 用 state(JSON)
  const [actResult, setActResult] = useState(null);
  const [learnInput, setLearnInput] = useState({ action: '', reward: '' });
  const [onlineBusy, setOnlineBusy] = useState(false);
  const logRef = useRef(null);
  // ─── 操作ログ (act/learn/評価/削除/オンライン化 などの結果を時系列で表示) ───
  const [opLog, setOpLog] = useState([]);
  const opLogRef = useRef(null);
  const appendLog = (msg) => {
    const t = new Date().toLocaleTimeString();
    setOpLog(prev => [...prev.slice(-300), `[${t}] ${msg}`]);
  };

  useEffect(() => {
    loadAlgos();
    loadModels();
    loadStatus();
    loadTables();
    const t = setInterval(() => { loadModels(); loadStatus(); }, 3000);
    return () => clearInterval(t);
  }, []);

  async function loadTables() {
    try {
      const r = await fetch('/ml/datasets');
      const d = await r.json();
      setTables(d.datasets || d.tables || []);
    } catch {}
  }

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [liveLog]);

  useEffect(() => {
    if (opLogRef.current) opLogRef.current.scrollTop = opLogRef.current.scrollHeight;
  }, [opLog]);

  // オンライン操作 or オンライン学習曲線パネル表示中は状態を定期取得して EMA 推移をサンプリング
  useEffect(() => {
    const liveName = onlineFor || (chartFor && chartFor.online ? chartFor.name : null);
    if (!liveName) return;
    const t = setInterval(() => refreshOnlineStatus(liveName), 3000);
    return () => clearInterval(t);
  }, [onlineFor, chartFor]);

  async function loadAlgos() {
    try {
      const r = await fetch('/ml/rl/envs');
      const d = await r.json();
      setAlgos(d.algos || []);
    } catch {}
  }
  async function loadModels() {
    try {
      const r = await fetch('/ml/rl/models');
      const d = await r.json();
      setModels(d.models || []);
      setRunning(d.runningJob || null);
    } catch {}
  }
  async function loadStatus() {
    try {
      const r = await fetch('/ml/rl/train/status');
      const d = await r.json();
      if (d.running) { setRunning({ jobId: d.jobId, name: d.name, env: d.env }); setLiveLog(d.log || ''); }
      else { setRecentJobs(d.recentJobs || []); }
    } catch {}
  }

  async function cancelTrain() {
    if (!confirm('学習中のRLジョブをキャンセルしますか?')) return;
    try {
      const r = await fetch('/ml/rl/train/cancel', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      showToast('キャンセルしました', 'success');
      appendLog('⏹ 学習をキャンセルしました');
    } catch (e) { showToast(`失敗: ${e.message}`, 'error'); appendLog(`❌ キャンセル失敗: ${e.message}`); }
  }

  async function showChart(name, online) {
    setEvalResult(null); setEvalFor(null); setOnlineFor(null); setOnlineEvalResult(null);
    if (online) {
      // オンライン: サーバに損失履歴が無いため、このセッションで取得した EMA 推移を表示
      setOnlineHist([]);
      setChartFor({ name, online: true });
      appendLog(`📈 学習推移を表示(オンライン): ${name}`);
      refreshOnlineStatus(name);
      return;
    }
    try {
      const r = await fetch(`/ml/rl/models/${encodeURIComponent(name)}/metrics`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setChartFor({ name, metrics: d, online: false });
      appendLog(`📈 学習曲線を表示: ${name} (最終損失 ${d.finalLoss ?? '-'})`);
    } catch (e) { showToast(`取得失敗: ${e.message}`, 'error'); appendLog(`❌ 学習曲線取得失敗: ${name} (${e.message})`); }
  }

  async function runEval(name, online) {
    setChartFor(null); setEvalResult(null); setOnlineFor(null); setOnlineEvalResult(null);
    if (online) {
      // オンライン: データセットが無いので、状態を与えて act(ε=0) のQ値で方策を確認する
      setEvalOnline(true); setEvalFor(name);
      appendLog(`🔍 方策を評価(オンライン)を開く: ${name}`);
      return;
    }
    if (running) { showToast('学習中は評価できません', 'error'); return; }
    setEvalOnline(false); setEvalFor(name); setEvaluating(true);
    appendLog(`🔍 評価開始: ${name} (5エピソード)`);
    try {
      const r = await fetch(`/ml/rl/models/${encodeURIComponent(name)}/eval`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episodes: 5 }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setEvalResult(d);
      appendLog(`🔍 評価完了: ${name} · 方策一致率 ${Math.round((d.policyAgreement || 0) * 100)}% · ログ平均報酬 ${d.loggedMeanReward ?? '-'}`);
    } catch (e) { showToast(`評価失敗: ${e.message}`, 'error'); appendLog(`❌ 評価失敗: ${name} (${e.message})`); setEvalFor(null); }
    finally { setEvaluating(false); }
  }

  // オンライン方策評価: 状態を1件与えて act(ε=0) のQ値・推奨行動を取得
  async function doEvalAct() {
    const state = parseActState(); if (state === null) return;
    setOnlineBusy(true);
    try {
      const r = await fetch(`/ml/rl/models/${encodeURIComponent(evalFor)}/act`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, epsilon: 0 }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setOnlineEvalResult(d);
      appendLog(`🔍 act評価 ${evalFor}: action=${d.action} · Q={${Object.entries(d.qValues || {}).map(([k, v]) => `${k}:${v}`).join(', ')}}`);
    } catch (e) { showToast(`評価失敗: ${e.message}`, 'error'); appendLog(`❌ act評価失敗: ${evalFor} (${e.message})`); }
    finally { setOnlineBusy(false); }
  }

  async function deleteAgent(name) {
    if (!confirm(`エージェント「${name}」を削除しますか?`)) return;
    try {
      const r = await fetch(`/ml/rl/models/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      showToast('削除しました', 'success');
      appendLog(`🗑 エージェント削除: ${name}`);
      if (chartFor && chartFor.name === name) setChartFor(null);
      if (evalFor === name) { setEvalResult(null); setEvalFor(null); }
      if (onlineFor === name) setOnlineFor(null);
      loadModels();
    } catch (e) { showToast(`削除失敗: ${e.message}`, 'error'); }
  }

  // ⚡ オンライン学習: 既存エージェントをウォームスタートでメモリへロード
  async function enableOnline(name) {
    if (!confirm(`「${name}」をオンライン学習用にロードします (ウォームスタート)。\nよろしいですか?`)) return;
    setOnlineBusy(true);
    try {
      const r = await fetch('/ml/rl/online/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromAgent: name }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      showToast('オンライン化しました', 'success');
      appendLog(`⚡ オンライン化(ウォームスタート読み込み): ${name}`);
      openOnline(name);
    } catch (e) { showToast(`オンライン化失敗: ${e.message}`, 'error'); appendLog(`❌ オンライン化失敗: ${name} (${e.message})`); }
    finally { setOnlineBusy(false); }
  }
  function openOnline(name) {
    setChartFor(null); setEvalFor(null); setActResult(null);
    setOnlineHist([]);
    setOnlineFor(name);
    appendLog(`⚡ オンライン操作パネルを開く: ${name}`);
    refreshOnlineStatus(name);
  }
  async function refreshOnlineStatus(name) {
    try {
      const r = await fetch(`/ml/rl/models/${encodeURIComponent(name)}/online/status`);
      const d = await r.json();
      setOnlineStatus(d);
      // EMA 推移をサンプリング (totalSteps が進んだときだけ追加)
      if (d && !d.error && d.totalSteps != null) {
        setOnlineHist(prev => {
          const last = prev[prev.length - 1];
          if (last && last.step === d.totalSteps) return prev;
          return [...prev.slice(-300), { step: d.totalSteps, loss: d.lossEMA, reward: d.rewardEMA }];
        });
      }
    } catch (e) { setOnlineStatus({ error: e.message }); }
  }
  function parseActState() {
    try { return JSON.parse(actInput); }
    catch { showToast('state は有効なJSON ({"列":値}) で入力してください', 'error'); return null; }
  }
  async function doAct() {
    const state = parseActState(); if (state === null) return;
    setOnlineBusy(true);
    try {
      const r = await fetch(`/ml/rl/models/${encodeURIComponent(onlineFor)}/act`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, epsilon: 0 }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setActResult(d);
      setLearnInput(li => ({ ...li, action: d.action }));
      appendLog(`🎯 act ${onlineFor}: action=${d.action}${d.explored ? ' (探索)' : ''} · Q={${Object.entries(d.qValues || {}).map(([k, v]) => `${k}:${v}`).join(', ')}}`);
    } catch (e) { showToast(`act失敗: ${e.message}`, 'error'); appendLog(`❌ act失敗: ${onlineFor} (${e.message})`); }
    finally { setOnlineBusy(false); }
  }
  async function doLearn() {
    const state = parseActState(); if (state === null) return;
    const reward = parseFloat(learnInput.reward);
    if (!learnInput.action) { showToast('action を入力してください', 'error'); return; }
    if (!isFinite(reward)) { showToast('reward は数値で入力してください', 'error'); return; }
    setOnlineBusy(true);
    try {
      const r = await fetch(`/ml/rl/models/${encodeURIComponent(onlineFor)}/learn`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, action: learnInput.action, reward }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      showToast(`学習しました (totalSteps=${d.totalSteps})`, 'success');
      appendLog(`📥 learn ${onlineFor}: action=${learnInput.action}, reward=${reward} → loss=${d.loss ?? '-'}, totalSteps=${d.totalSteps ?? '-'}, buffer=${d.bufferSize ?? '-'}`);
      refreshOnlineStatus(onlineFor);
    } catch (e) { showToast(`learn失敗: ${e.message}`, 'error'); appendLog(`❌ learn失敗: ${onlineFor} (${e.message})`); }
    finally { setOnlineBusy(false); }
  }
  async function checkpointOnline() {
    setOnlineBusy(true);
    try {
      const r = await fetch(`/ml/rl/models/${encodeURIComponent(onlineFor)}/checkpoint`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      showToast('チェックポイントを保存しました', 'success');
      appendLog(`💾 チェックポイント保存: ${onlineFor} (totalSteps=${d.totalSteps ?? '-'})`);
    } catch (e) { showToast(`保存失敗: ${e.message}`, 'error'); appendLog(`❌ チェックポイント保存失敗: ${onlineFor} (${e.message})`); }
    finally { setOnlineBusy(false); }
  }

  return (
    <div className="ml-models-view">
      <div className="toolbar">
        <button className="btn primary" onClick={() => setShowTrain(true)} disabled={!!running}>
          ➕ エージェントを新規作成 (学習)
        </button>
        {running && (
          <span style={{
            background: 'var(--orange-dim)', color: 'var(--orange)',
            padding: '4px 10px', borderRadius: 10, fontSize: 12,
            fontFamily: 'var(--font-mono)',
          }}>⚙️ 学習中: {running.name}</span>
        )}
      </div>

      <div className="ml-layout">
        {/* 左: エージェント一覧 (モデルカード調) */}
        <div className="ml-table-list">

          {models.length === 0 ? (
            <div className="empty-state">
              エージェントがありません。<br />「➕ エージェントを新規作成 (学習)」から開始してください。
            </div>
          ) : models.map(m => (
            <div key={m.name} className="ml-table-item" style={{ position: 'relative' }}>
              <button
                className="ml-model-delete-btn"
                onClick={(e) => { e.stopPropagation(); deleteAgent(m.name); }}
                title={`エージェント「${m.name}」を削除`}
                aria-label="削除"
                disabled={!!running}
              >×</button>
              <div className="ml-table-name" style={{ paddingRight: 24 }}>
                {m.online ? '⚡' : '📊'} {m.name}
                <span style={{
                  marginLeft: 6, fontSize: 10,
                  background: m.online ? 'var(--orange-dim)' : 'var(--accent-dim)',
                  color: m.online ? 'var(--orange)' : 'var(--accent)',
                  padding: '1px 6px', borderRadius: 8,
                }}>{m.online ? '⚡ オンライン' : '✓ 学習済'}</span>
              </div>
              <div className="ml-table-meta">
                <b>{RL_ALGO_SHORT[m.algo] || m.algo || 'DQN'}</b> | {m.datasetMode === 'transition' ? '遷移ベース' : 'バンディット'} | {(m.actionLabels || []).length}行動
                {!m.online && m.tableName ? ` | ${m.tableName}` : ''}
              </div>
              {m.metrics && (
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
                  {m.online
                    ? `steps: ${m.metrics.totalSteps ?? '-'}${m.metrics.rewardEMA != null ? ` · rewardEMA: ${m.metrics.rewardEMA}` : ''}${m.metrics.bufferSize != null ? ` · buffer: ${m.metrics.bufferSize}` : ''}`
                    : `一致率: ${Math.round((m.metrics.policyAgreement || 0) * 100)}% · 推定価値: ${m.metrics.meanQ}`}
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                <button className="btn small" onClick={() => showChart(m.name, m.online)}>📈 学習曲線</button>
                <button className="btn small primary" onClick={() => runEval(m.name, m.online)} disabled={!m.online && (!!running || evaluating)}>🔍 方策を評価</button>
                {m.online
                  ? <button className="btn small primary" onClick={() => openOnline(m.name)}>⚡ オンライン操作</button>
                  : <button className="btn small" onClick={() => enableOnline(m.name)} disabled={onlineBusy}>⚡ オンライン化</button>}
              </div>
            </div>
          ))}
        </div>

        {/* 右: 詳細 (学習ログ / 学習曲線 / 評価 / オンライン / 履歴) */}
        <div className="ml-table-detail">
          {running && (
            <div className="rl-panel">
              <div className="rl-panel-title">📜 学習ログ（ライブ）: {running.name}
                <button className="btn small danger" style={{ float: 'right' }} onClick={cancelTrain}>⏹ キャンセル</button>
              </div>
              <pre ref={logRef} className="train-log rl-log">{liveLog || '(出力待ち...)'}</pre>
            </div>
          )}

          {!running && chartFor && (
            <div className="rl-panel">
              <div className="rl-panel-title">
                📈 {chartFor.online ? '学習推移（オンライン）' : '学習曲線'}: {chartFor.name}
                <button className="btn small" style={{ float: 'right' }} onClick={() => setChartFor(null)}>✕ 閉じる</button>
              </div>
              {chartFor.online ? (
                onlineHist.length < 2 ? (
                  <div className="empty-state" style={{ padding: 20, fontSize: 13 }}>
                    学習が進むと reward / loss の推移が表示されます。<br />
                    外部API（act/learn ループ）で学習中、または「⚡ オンライン操作」で learn を実行すると、totalSteps の増加に合わせて伸びていきます。
                  </div>
                ) : (
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '2px 0' }}>報酬EMA (reward EMA)</div>
                    <OnlineSeriesChart data={onlineHist.map(h => h.reward)} color="#7c4dff" />
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '6px 0 2px' }}>損失EMA (loss EMA)</div>
                    <OnlineSeriesChart data={onlineHist.map(h => h.loss)} color="#ff9800" />
                    <div className="rl-agent-meta" style={{ marginTop: 8 }}>
                      totalSteps <b>{onlineStatus?.totalSteps ?? '-'}</b> · buffer <b>{onlineStatus?.bufferSize ?? '-'}</b> ·
                      reward(EMA) <b>{onlineStatus?.rewardEMA ?? '-'}</b> · loss(EMA) <b>{onlineStatus?.lossEMA ?? '-'}</b>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
                      ※ サーバは履歴を保存しないため、パネル表示中に取得した値の推移です（{onlineHist.length}点・3秒間隔）。
                    </div>
                  </div>
                )
              ) : (
                <div>
                  <LossChart metrics={chartFor.metrics} />
                  <div className="rl-chart-legend">
                    <span><span className="lg-line" style={{ background: 'var(--accent)' }}></span>{chartFor.metrics.lossName || '学習損失'} (エポック毎)</span>
                  </div>
                  <div className="rl-agent-meta" style={{ marginTop: 8 }}>
                    {RL_ALGO_SHORT[chartFor.metrics.algo] || chartFor.metrics.algo || 'DQN'} ·
                    方式 <b>{chartFor.metrics.datasetMode === 'transition' ? '遷移' : 'バンディット'}</b> ·
                    最終損失 <b>{chartFor.metrics.finalLoss}</b> ·
                    方策一致率 <b>{Math.round((chartFor.metrics.policyAgreement || 0) * 100)}%</b> ·
                    推定価値(平均maxQ) <b>{chartFor.metrics.meanQ}</b> ·
                    ログ平均報酬 {chartFor.metrics.loggedMeanReward} ·
                    {chartFor.metrics.nTransitions}件 · {chartFor.metrics.elapsedSec}秒
                  </div>
                </div>
              )}
            </div>
          )}

          {!running && evalFor && (
            <div className="rl-panel">
              <div className="rl-panel-title">
                🔍 方策評価: {evalFor}{evalOnline ? '（オンライン）' : ''}
                <button className="btn small" style={{ float: 'right' }} onClick={() => { setEvalResult(null); setOnlineEvalResult(null); setEvalFor(null); }}>✕ 閉じる</button>
              </div>
              {evalOnline ? (
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>状態 (JSON, 例: {`{"hour":22,"segment":"C"}`})</div>
                  <textarea className="textarea" value={actInput} onChange={e => setActInput(e.target.value)} rows={2}
                    spellCheck="false" style={{ width: '100%', minHeight: 52 }} />
                  <div className="toolbar" style={{ marginTop: 6 }}>
                    <button className="btn small primary" onClick={doEvalAct} disabled={onlineBusy}>🔍 この状態を評価 (act ε=0)</button>
                  </div>
                  {onlineEvalResult ? (
                    <div className="rl-agent-meta" style={{ marginTop: 8 }}>
                      推奨行動: <b>{onlineEvalResult.action}</b>{onlineEvalResult.explored ? ' (探索)' : ''}
                      <QValueBars qValues={onlineEvalResult.qValues} chosen={onlineEvalResult.action} />
                    </div>
                  ) : (
                    <div className="empty-state" style={{ padding: 16, fontSize: 12 }}>
                      状態を入力して「この状態を評価」を押すと、各行動のQ値（推定価値）と推奨行動が表示されます。
                    </div>
                  )}
                </div>
              ) : evaluating ? (
                <div className="empty-state" style={{ padding: 24 }}>⏳ 評価を実行中...</div>
              ) : evalResult ? (
                <DatasetEvalResult result={evalResult} />
              ) : null}
            </div>
          )}

          {!running && onlineFor && (
            <div className="rl-panel">
              <div className="rl-panel-title">
                ⚡ オンライン学習: {onlineFor}
                <button className="btn small" style={{ float: 'right' }} onClick={() => setOnlineFor(null)}>✕ 閉じる</button>
              </div>
              {onlineStatus && onlineStatus.error ? (
                <div className="empty-state" style={{ padding: 16, color: 'var(--orange)' }}>⚠️ {onlineStatus.error}</div>
              ) : onlineStatus ? (
                <div className="rl-agent-meta" style={{ marginBottom: 10 }}>
                  状態 <b>{onlineStatus.loaded ? 'ロード済' : '未ロード'}</b> ·
                  方式 <b>{onlineStatus.mode === 'transition' ? '遷移' : 'バンディット'}</b> ·
                  行動 <b>{(onlineStatus.actionLabels || []).join(', ')}</b><br />
                  totalSteps <b>{onlineStatus.totalSteps ?? '-'}</b> ·
                  buffer <b>{onlineStatus.bufferSize ?? '-'}</b> ·
                  loss(EMA) <b>{onlineStatus.lossEMA ?? '-'}</b> ·
                  reward(EMA) <b>{onlineStatus.rewardEMA ?? '-'}</b>
                  <button className="btn small" style={{ marginLeft: 8 }} onClick={() => refreshOnlineStatus(onlineFor)}>🔄 更新</button>
                </div>
              ) : <div className="empty-state" style={{ padding: 16 }}>⏳ 取得中...</div>}

              <div style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 8px' }}>
                📈 学習推移グラフ・🔍 Q値の評価は、上の「📈 学習曲線」「🔍 方策を評価」ボタンから開けます。
              </div>

              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>状態 (JSON, 例: {`{"hour":22,"segment":"C"}`})</div>
              <textarea className="textarea" value={actInput} onChange={e => setActInput(e.target.value)} rows={2}
                spellCheck="false" style={{ width: '100%', minHeight: 52 }} />
              <div className="toolbar" style={{ marginTop: 6 }}>
                <button className="btn small primary" onClick={doAct} disabled={onlineBusy}>🎯 act (推奨行動)</button>
                <button className="btn small" onClick={checkpointOnline} disabled={onlineBusy}>💾 チェックポイント</button>
              </div>
              {actResult && (
                <div className="rl-agent-meta" style={{ marginTop: 6 }}>
                  推奨行動: <b>{actResult.action}</b>{actResult.explored ? ' (探索)' : ''}
                  <QValueBars qValues={actResult.qValues} chosen={actResult.action} />
                </div>
              )}
              <div style={{ borderTop: '1px solid var(--border)', margin: '10px 0 8px' }}></div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>経験を投入して即時学習 (上の状態に対して)</div>
              <div className="toolbar">
                <input className="input" type="text" placeholder="action" value={learnInput.action}
                  onChange={e => setLearnInput(li => ({ ...li, action: e.target.value }))}
                  style={{ width: 130 }} />
                <input className="input" type="number" step="any" placeholder="reward" value={learnInput.reward}
                  onChange={e => setLearnInput(li => ({ ...li, reward: e.target.value }))}
                  style={{ width: 110 }} />
                <button className="btn small primary" onClick={doLearn} disabled={onlineBusy}>📥 learn</button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 8, lineHeight: 1.6 }}>
                💡 外部から回す場合は <code>POST /ml/rl/models/{onlineFor}/act</code> と <code>/learn</code> をループしてください (APIタブ参照)。
              </div>
            </div>
          )}

          {!running && !chartFor && !evalFor && !onlineFor && (
            <div>
              <h3 style={{ marginTop: 0 }}>学習ジョブ履歴</h3>
              {recentJobs.length === 0 ? (
                <div className="empty-state">ジョブがまだありません</div>
              ) : (
                <div style={{ maxHeight: 250, overflowY: 'auto', marginBottom: 16 }}>
                  {recentJobs.slice(0, 10).map((j, i) => (
                    <div key={i} className="ml-table-item" style={{ marginBottom: 6 }}>
                      <span className="ml-table-name">
                        {j.status === 'completed' ? '✅' : j.status === 'cancelled' ? '⏹' : '❌'} {j.name}
                      </span>
                      <div className="ml-table-meta">
                        {j.policyAgreement != null ? `一致率 ${Math.round(j.policyAgreement * 100)}%` : '—'}
                        {j.error && <span style={{ color: 'var(--red)' }}> · {j.error}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="rl-panel rl-help">
                <div className="rl-panel-title">💡 使い方</div>
                <ol style={{ margin: '4px 0 0', paddingLeft: 20, lineHeight: 1.9 }}>
                  <li><b>「➕ エージェントを新規作成 (学習)」</b>でテーブルと列(状態/行動/報酬)を選んで学習を開始</li>
                  <li>各エージェントの <b>「📈 学習曲線」「🔍 方策を評価」</b> で結果を確認</li>
                  <li><b>「⚡ オンライン化」</b>でリアルタイム学習 (act/learn) を有効化できます</li>
                </ol>
              </div>
            </div>
          )}

          {/* ─── 📝 操作ログ (常時表示・操作の結果を時系列で記録) ─── */}
          <div className="rl-panel" style={{ marginTop: 12 }}>
            <div className="rl-panel-title">📝 操作ログ
              <button className="btn small" style={{ float: 'right' }} onClick={() => setOpLog([])}>クリア</button>
            </div>
            <pre ref={opLogRef} className="train-log rl-log" style={{ maxHeight: 200 }}>
              {opLog.length ? opLog.join('\n') : '(ここに act / learn / 評価 / 学習曲線 / オンライン化 / 削除 などの操作結果が時系列で表示されます)'}
            </pre>
          </div>
        </div>
      </div>

      {showTrain && (
        <RLTrainDialog
          tables={tables}
          algos={algos}
          onClose={() => setShowTrain(false)}
          onStarted={() => { setShowTrain(false); setLiveLog(''); setChartFor(null); setEvalResult(null); setEvalFor(null); setOnlineFor(null); loadStatus(); loadModels(); }}
          showToast={showToast}
        />
      )}
    </div>
  );
}

// ─── 🎮 RL 学習ダイアログ (データテーブルからのオフラインRL) ───
function RLTrainDialog({ tables, algos, onClose, onStarted, showToast }) {
  const [form, setForm] = useState({
    name: 'offer_agent', algo: 'dqn',
    episodes: 300, hiddenSize: 128, learningRate: 0.001, gamma: 0.99, batchSize: 64, cqlAlpha: 0.5,
  });
  const [tableCols, setTableCols] = useState([]);
  const [dsForm, setDsForm] = useState({
    table: '', stateColumns: [], actionColumn: '', rewardColumn: '', nextStateColumns: [], doneColumn: '',
  });
  const [busy, setBusy] = useState(false);

  function upd(k, v) { setForm(f => ({ ...f, [k]: v })); }
  function dsUpd(k, v) { setDsForm(f => ({ ...f, [k]: v })); }
  function toggleCol(key, col) {
    setDsForm(f => {
      const arr = f[key].includes(col) ? f[key].filter(c => c !== col) : [...f[key], col];
      return { ...f, [key]: arr };
    });
  }
  async function loadTableCols(name) {
    setTableCols([]);
    if (!name) return;
    try {
      const r = await fetch(`/ml/datasets/${encodeURIComponent(name)}/schema`);
      const d = await r.json();
      const cols = (d.columns || d.schema || []).map(c => c.name || c.column_name || c).filter(Boolean);
      setTableCols(cols);
    } catch {}
  }

  async function startTrain() {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(form.name)) {
      showToast('エージェント名は英数字・ハイフン・アンダースコア (1〜64文字)', 'error'); return;
    }
    if (!dsForm.table) { showToast('テーブルを選択してください', 'error'); return; }
    if (dsForm.stateColumns.length === 0) { showToast('状態(特徴量)カラムを1つ以上選んでください', 'error'); return; }
    if (!dsForm.actionColumn) { showToast('行動カラムを選んでください', 'error'); return; }
    if (!dsForm.rewardColumn) { showToast('報酬カラムを選んでください', 'error'); return; }
    if (dsForm.nextStateColumns.length > 0 && dsForm.nextStateColumns.length !== dsForm.stateColumns.length) {
      showToast('次状態カラムは状態カラムと同数で選んでください (遷移ベース)', 'error'); return;
    }
    const payload = {
      name: form.name, algo: form.algo,
      episodes: form.episodes, hiddenSize: form.hiddenSize, learningRate: form.learningRate,
      gamma: form.gamma, batchSize: form.batchSize, cqlAlpha: form.cqlAlpha,
      table: dsForm.table, stateColumns: dsForm.stateColumns,
      actionColumn: dsForm.actionColumn, rewardColumn: dsForm.rewardColumn,
      nextStateColumns: dsForm.nextStateColumns, doneColumn: dsForm.doneColumn || undefined,
    };
    setBusy(true);
    try {
      const r = await fetch('/ml/rl/train', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      showToast(`学習開始: ${form.name}`, 'success');
      onStarted();
    } catch (e) { showToast(`開始失敗: ${e.message}`, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 720 }}>
        <div className="modal-header">
          <div className="modal-title">➕ エージェントを新規作成 (データテーブルから学習)</div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="field">
              <label className="field-label">エージェント名</label>
              <input className="input" value={form.name} onChange={e => upd('name', e.target.value)} placeholder="例: offer_agent" />
              <span className="field-hint">英数字・ハイフン・アンダースコア、最大64文字。</span>
            </div>
            <div className="field">
              <label className="field-label">データテーブル</label>
              <select className="select" value={dsForm.table}
                onChange={e => { loadTableCols(e.target.value);
                  setDsForm({ table: e.target.value, stateColumns: [], actionColumn: '', rewardColumn: '', nextStateColumns: [], doneColumn: '' }); }}>
                <option value="">— 選択 —</option>
                {tables.map(t => <option key={t.name} value={t.name}>{t.name} ({(t.rowCount || 0).toLocaleString()}行)</option>)}
              </select>
            </div>
          </div>

          {dsForm.table && tableCols.length > 0 && (
            <>
              <div className="field">
                <label className="field-label">状態カラム (特徴量・複数可)</label>
                <div className="rl-colpick">
                  {tableCols.map(c => (
                    <label key={c} className={`rl-col-chip ${dsForm.stateColumns.includes(c) ? 'on' : ''}`}>
                      <input type="checkbox" checked={dsForm.stateColumns.includes(c)}
                        onChange={() => toggleCol('stateColumns', c)} />{c}
                    </label>
                  ))}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="field"><label className="field-label">行動カラム</label>
                  <select className="select" value={dsForm.actionColumn} onChange={e => dsUpd('actionColumn', e.target.value)}>
                    <option value="">— 選択 —</option>
                    {tableCols.map(c => <option key={c} value={c}>{c}</option>)}
                  </select></div>
                <div className="field"><label className="field-label">報酬カラム</label>
                  <select className="select" value={dsForm.rewardColumn} onChange={e => dsUpd('rewardColumn', e.target.value)}>
                    <option value="">— 選択 —</option>
                    {tableCols.map(c => <option key={c} value={c}>{c}</option>)}
                  </select></div>
              </div>
              <div className="field">
                <label className="field-label">次状態カラム (任意・遷移ベースにする場合。状態と同数同順)</label>
                <div className="rl-colpick">
                  {tableCols.map(c => (
                    <label key={c} className={`rl-col-chip ${dsForm.nextStateColumns.includes(c) ? 'on' : ''}`}>
                      <input type="checkbox" checked={dsForm.nextStateColumns.includes(c)}
                        onChange={() => toggleCol('nextStateColumns', c)} />{c}
                    </label>
                  ))}
                </div>
              </div>
              <div className="field">
                <label className="field-label">終了フラグカラム (任意)</label>
                <select className="select" value={dsForm.doneColumn} onChange={e => dsUpd('doneColumn', e.target.value)}>
                  <option value="">— なし —</option>
                  {tableCols.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="field-hint" style={{ marginBottom: 8 }}>
                方式: <b>{dsForm.nextStateColumns.length > 0 ? '遷移ベース オフラインDQN' : '文脈付きバンディット'}</b>
              </div>
            </>
          )}

          <div className="field">
            <label className="field-label">アルゴリズム</label>
            <select className="select" value={form.algo} onChange={e => upd('algo', e.target.value)}>
              {algos.map(a => <option key={a.name} value={a.name}>{a.label}</option>)}
            </select>
            {(() => { const a = algos.find(x => x.name === form.algo); return a && a.desc
              ? <span className="field-hint">{a.desc}</span> : null; })()}
          </div>
          {form.algo === 'cql' && (
            <div className="field">
              <label className="field-label">CQL の保守度 α (大きいほどログ外行動を強く抑制)</label>
              <input className="input" type="number" step="0.1" min="0" max="10" value={form.cqlAlpha}
                onChange={e => upd('cqlAlpha', parseFloat(e.target.value) || 0)} />
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <div className="field"><label className="field-label">エポック数</label>
              <input className="input" type="number" min="10" max="5000" value={form.episodes}
                onChange={e => upd('episodes', parseInt(e.target.value) || 0)} /></div>
            <div className="field"><label className="field-label">隠れ層サイズ</label>
              <input className="input" type="number" min="16" max="1024" value={form.hiddenSize}
                onChange={e => upd('hiddenSize', parseInt(e.target.value) || 0)} /></div>
            <div className="field"><label className="field-label">学習率</label>
              <input className="input" type="number" step="0.0001" min="0.00001" max="0.1" value={form.learningRate}
                onChange={e => upd('learningRate', parseFloat(e.target.value) || 0)} /></div>
            <div className="field"><label className="field-label">割引率 γ (遷移ベース用)</label>
              <input className="input" type="number" step="0.01" min="0.5" max="0.999" value={form.gamma}
                onChange={e => upd('gamma', parseFloat(e.target.value) || 0)} /></div>
            <div className="field"><label className="field-label">バッチサイズ</label>
              <input className="input" type="number" min="8" max="512" value={form.batchSize}
                onChange={e => upd('batchSize', parseInt(e.target.value) || 0)} /></div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose} disabled={busy}>キャンセル</button>
          <button className="btn primary" onClick={startTrain} disabled={busy}>▶ 学習を開始</button>
        </div>
      </div>
    </div>
  );
}

// ─── API 使い方ビュー (外部連携) ───
function ApiUsageView({ showToast }) {
  const [tokens, setTokens] = useState([]);
  const [generatedToken, setGeneratedToken] = useState('');
  const [exampleHost, setExampleHost] = useState(window.location.origin);

  useEffect(() => {
    loadTokens();
  }, []);

  async function loadTokens() {
    try {
      const r = await fetch('/api-tokens');
      const data = await r.json();
      setTokens(data.tokens || []);
    } catch (e) { showToast(`トークン一覧取得失敗: ${e.message}`, 'error'); }
  }

  async function generateNewToken() {
    try {
      const r = await fetch('/api-tokens/generate');
      const data = await r.json();
      setGeneratedToken(data.token);
    } catch (e) { showToast(`生成失敗: ${e.message}`, 'error'); }
  }

  function copyText(text) {
    navigator.clipboard.writeText(text).then(() => showToast('クリップボードにコピーしました', 'success')).catch(() => {});
  }

  // サンプルコードで使うトークン: 生成済みなら新規、なければプレースホルダー
  const sampleToken = generatedToken || (tokens[0]?.tokenPreview ? `<token-from-config>` : `<your-token-here>`);

  const pythonExample = `import requests

BASE = "${exampleHost}"
TOKEN = "${sampleToken}"
HEADERS = {"Authorization": f"Bearer {TOKEN}"}

# 1. テーブル一覧
r = requests.get(f"{BASE}/ml/datasets", headers=HEADERS, verify=False)
print(r.json())

# 2. SQLクエリ (読み取り専用)
r = requests.post(f"{BASE}/ml/query", headers=HEADERS, verify=False, json={
    "sql": "SELECT region, SUM(sales) FROM sales_test GROUP BY region"
})
print(r.json())

# 3. センサーデータを1行追記 (テーブルが無ければ自動作成)
r = requests.post(f"{BASE}/ml/datasets/append", headers=HEADERS, verify=False, json={
    "tableName": "sensor_data",
    "rows": [{"timestamp": "2026-05-26 14:00:00", "temp": 23.5, "humidity": 60}],
    "createIfMissing": True
})
print(r.json())

# 4. 複数行を一気に追記 (バッチ)
r = requests.post(f"{BASE}/ml/datasets/append", headers=HEADERS, verify=False, json={
    "tableName": "sensor_data",
    "rows": [
        {"timestamp": "2026-05-26 14:01:00", "temp": 23.6, "humidity": 61},
        {"timestamp": "2026-05-26 14:02:00", "temp": 23.7, "humidity": 60},
    ]
})

# 5. CSVを丸ごとアップロード
with open("data.csv") as f:
    r = requests.post(f"{BASE}/ml/datasets/import/csv", headers=HEADERS, verify=False, json={
        "tableName": "my_data",
        "csvContent": f.read(),
        "mode": "replace",
        "description": "Pythonスクリプトからアップロード"
    })

# 6. 学習済みモデルで推論
r = requests.post(f"{BASE}/ml/models/sales_yosoku/predict", headers=HEADERS, verify=False, json={
    "features": {"region": "Tokyo", "product": "ProductA", "quantity": 5}
})
print(r.json())  # → {"predictions": [15234.56], "task": "regression", ...}

# 7. バッチ推論 (複数件まとめて)
r = requests.post(f"{BASE}/ml/models/sales_yosoku/predict", headers=HEADERS, verify=False, json={
    "features": [
        {"region": "Tokyo", "product": "ProductA", "quantity": 5},
        {"region": "Osaka", "product": "ProductB", "quantity": 3},
        {"region": "Nagoya", "product": "ProductC", "quantity": 10},
    ]
})
print(r.json())  # → {"predictions": [15234.56, 8765.43, 23456.78], "count": 3, ...}

# 8. 画像の物体検出 (COCO事前学習モデル)
import base64
with open("photo.jpg", "rb") as f:
    img_b64 = base64.b64encode(f.read()).decode()
r = requests.post(f"{BASE}/ml/image/detect", headers=HEADERS, verify=False, json={
    "image": img_b64,
    "model": "fasterrcnn_resnet50_fpn",  # 省略可
    "threshold": 0.5
})
print(r.json())  # → {"detections": [{"label": "person", "score": 0.99, "box": {...}}], "count": N}

# 9. カスタム学習済みモデルで物体検出
r = requests.post(f"{BASE}/ml/image/detect", headers=HEADERS, verify=False, json={
    "image": img_b64,
    "customModel": "my_detector",  # 学習タブで作ったモデル名
    "threshold": 0.5
})
print(r.json())

# 10. 利用可能なモデル一覧 (COCO + カスタム)
print(requests.get(f"{BASE}/ml/image/models", headers=HEADERS, verify=False).json())       # COCO事前学習
print(requests.get(f"{BASE}/ml/image/custom-models", headers=HEADERS, verify=False).json()) # カスタム学習済み`;

  const curlExample = `# テーブル一覧
curl -H "Authorization: Bearer ${sampleToken}" \\
  "${exampleHost}/ml/datasets"

# SQL実行
curl -H "Authorization: Bearer ${sampleToken}" \\
  -H "Content-Type: application/json" \\
  -d '{"sql":"SELECT * FROM sales_test LIMIT 5"}' \\
  "${exampleHost}/ml/query"

# センサーデータ追記
curl -H "Authorization: Bearer ${sampleToken}" \\
  -H "Content-Type: application/json" \\
  -d '{"tableName":"sensor_data","rows":[{"ts":"2026-05-26T14:00","temp":23.5}],"createIfMissing":true}' \\
  "${exampleHost}/ml/datasets/append"`;

  const rlPyExample = `import requests, time

BASE = "${exampleHost}"
H = {"Authorization": "Bearer ${sampleToken}", "Content-Type": "application/json"}

# 1) データテーブルからオフラインRLを学習
#    next_state列を付ければ遷移ベースDQN、無ければ文脈付きバンディット
r = requests.post(f"{BASE}/ml/rl/train", headers=H, json={
    "name": "offer_agent",
    "table": "logs",                       # 経験データのテーブル
    "stateColumns": ["hour", "segment"],   # 状態(文脈)
    "actionColumn": "offer",               # 取った行動
    "rewardColumn": "reward",              # 得られた報酬
    # "nextStateColumns": ["hour2","segment2"],  # 任意: 遷移ベースにする場合
    # "doneColumn": "done",                       # 任意: 終了フラグ
    "episodes": 200,
})
print(r.json())   # {"ok": true, "jobId": "..."}

# 2) 学習完了を待つ
while True:
    s = requests.get(f"{BASE}/ml/rl/train/status", headers=H).json()
    if not s.get("running"):
        break
    time.sleep(2)

# 3) 任意の状態に対する推奨行動を取得 (推論)
r = requests.post(f"{BASE}/ml/rl/models/offer_agent/policy", headers=H,
                  json={"state": {"hour": 22, "segment": "C"}})
print(r.json())   # {"recommendedAction": "Z", "qValues": {"X":..,"Y":..,"Z":..}}

# 4) オフライン方策評価 (ログ行動との一致率・推定価値)
r = requests.post(f"{BASE}/ml/rl/models/offer_agent/eval", headers=H, json={})
ev = r.json()
print("policyAgreement:", ev["policyAgreement"], "meanQ:", ev["meanQ"])

# ─────────────────────────────────────────────
# ⚡ リアルタイム/オンライン学習 (act → 報酬観測 → learn)
# ─────────────────────────────────────────────

# A) スキーマ指定でゼロから新規オンラインエージェント
requests.post(f"{BASE}/ml/rl/online/create", headers=H, json={
    "name": "promo", "spec": {
        "stateColumns": [{"name": "hour", "type": "numeric"},
                         {"name": "segment", "type": "categorical", "values": ["A","B","C"]}],
        "actionLabels": ["email", "sms", "push", "none"],
        "algo": "dqn", "mode": "bandit"}})
#   (既存エージェントをオンライン継続学習する場合は {"fromAgent": "offer_agent"})

# B) act(推論) → 報酬を観測 → learn(即時学習) を繰り返す
for state, reward_fn in your_stream:               # あなたのデータストリーム
    r = requests.post(f"{BASE}/ml/rl/models/promo/act", headers=H,
                      json={"state": state, "epsilon": 0.1}).json()  # ε=0で貪欲
    action = r["action"]
    reward = reward_fn(action)                      # 実際の結果(クリック/CV 等)
    requests.post(f"{BASE}/ml/rl/models/promo/learn", headers=H,
                  json={"state": state, "action": action, "reward": reward})

# C) 状況確認 & 明示保存 (一定間隔で自動保存もされる)
print(requests.get(f"{BASE}/ml/rl/models/promo/online/status", headers=H).json())
requests.post(f"{BASE}/ml/rl/models/promo/checkpoint", headers=H)`;

  return (
    <div className="api-usage-view">
      <div className="ml-section">
        <h3>📡 外部APIとして使う</h3>
        <p style={{color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6}}>
          Python スクリプトや他のアプリから ML データテーブル・学習済みモデル・画像物体検出に直接アクセスできます。<br />
          認証は <code>Authorization: Bearer &lt;token&gt;</code> ヘッダー方式。
          センサーログ、IoTデータ収集、定期的なETL処理、画像の自動検出などに活用してください。
        </p>
      </div>

      <div className="ml-section">
        <h3>🔑 APIトークンを生成</h3>
        <div className="toolbar">
          <button className="btn primary" onClick={generateNewToken}>🎲 新規トークン生成</button>
        </div>
        {generatedToken && (
          <div style={{
            background: 'var(--bg-tertiary)',
            padding: 12,
            borderRadius: 4,
            marginTop: 8,
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            wordBreak: 'break-all',
          }}>
            <div style={{color: 'var(--accent)', marginBottom: 6, fontFamily: 'inherit', fontSize: 11}}>
              ✓ 生成されました。下記サンプルにもこのトークンが反映されています:
            </div>
            <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
              <code style={{flex: 1}}>{generatedToken}</code>
              <button className="btn small" onClick={() => copyText(generatedToken)}>📋 コピー</button>
            </div>
            <div style={{color: 'var(--orange)', fontSize: 11, marginTop: 8, fontFamily: 'inherit', lineHeight: 1.5}}>
              ⚠️ このトークンを実際に使うには、<code>config.json</code> の <code>ml.apiTokens[]</code> に登録する必要があります:<br />
              <pre style={{margin: '6px 0 0', padding: 8, background: 'var(--bg-secondary)', borderRadius: 3, fontSize: 11, color: 'var(--text-primary)'}}>
{`"ml": {
  "enabled": true,
  "apiTokens": [
    {
      "name": "python-scripts",
      "token": "${generatedToken}",
      "permissions": ["ml:read", "ml:write"]
    }
  ]
}`}
              </pre>
              <div style={{marginTop: 6}}>
                <a href="/editconfig.html" target="_blank" rel="noopener noreferrer" style={{color: 'var(--accent)'}}>
                  ⚙️ editconfig.html を開いて編集する
                </a>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="ml-section">
        <h3>📋 登録済みトークン</h3>
        {tokens.length === 0 ? (
          <div className="empty-state" style={{padding: 20}}>
            トークンが登録されていません。<br />
            上で「新規トークン生成」してから config.json に登録してください。
          </div>
        ) : (
          <table className="ml-schema-table">
            <thead><tr><th>名前</th><th>権限</th><th>トークン (一部)</th></tr></thead>
            <tbody>
              {tokens.map((t, i) => (
                <tr key={i}>
                  <td>{t.name || <span style={{color: 'var(--text-muted)'}}>(無名)</span>}</td>
                  <td style={{fontFamily: 'var(--font-mono)', fontSize: 11}}>
                    {/* permissions は配列が正だが、古いサーバーや手書きconfigだと
                        "*" 等の文字列で届くことがあるので、どの形でも配列に揃えて描く */}
                    {(Array.isArray(t.permissions)
                      ? t.permissions
                      : String(t.permissions || '').split(/[,\s]+/).filter(Boolean)
                    ).map(p => (
                      <span key={p} style={{
                        background: p.includes('write') ? 'var(--orange-dim)' : 'var(--accent-dim)',
                        color: p.includes('write') ? 'var(--orange)' : 'var(--accent)',
                        padding: '2px 6px',
                        borderRadius: 3,
                        marginRight: 4,
                        fontSize: 10,
                      }}>{p}</span>
                    ))}
                  </td>
                  <td className="mono">{t.tokenPreview}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="ml-section">
        <h3>🐍 Python サンプルコード</h3>
        <div style={{position: 'relative'}}>
          <button
            className="btn small"
            style={{position: 'absolute', top: 6, right: 6, zIndex: 1}}
            onClick={() => copyText(pythonExample)}
          >📋 コピー</button>
          <pre style={{
            background: 'var(--bg-tertiary)',
            padding: 12,
            paddingTop: 36,
            borderRadius: 4,
            fontSize: 11,
            overflow: 'auto',
            margin: 0,
            maxHeight: 400,
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono)',
          }}>{pythonExample}</pre>
        </div>
        <div className="field-hint" style={{marginTop: 6}}>
          ※ HTTPS自己署名証明書を使っている場合は <code>verify=False</code> 必須 (本番では正規証明書推奨)。
        </div>
      </div>

      <div className="ml-section">
        <h3>🖥️ curl サンプル</h3>
        <div style={{position: 'relative'}}>
          <button
            className="btn small"
            style={{position: 'absolute', top: 6, right: 6, zIndex: 1}}
            onClick={() => copyText(curlExample)}
          >📋 コピー</button>
          <pre style={{
            background: 'var(--bg-tertiary)',
            padding: 12,
            paddingTop: 36,
            borderRadius: 4,
            fontSize: 11,
            overflow: 'auto',
            margin: 0,
            maxHeight: 300,
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono)',
          }}>{curlExample}</pre>
        </div>
      </div>

      <div className="ml-section">
        <h3>📖 エンドポイント一覧</h3>
        <table className="ml-schema-table">
          <thead><tr><th>メソッド</th><th>パス</th><th>権限</th><th>説明</th></tr></thead>
          <tbody>
            <tr><td className="mono">GET</td><td className="mono">/ml/datasets</td><td><span style={{color: 'var(--accent)'}}>ml:read</span></td><td>テーブル一覧</td></tr>
            <tr><td className="mono">GET</td><td className="mono">/ml/datasets/:name/schema</td><td><span style={{color: 'var(--accent)'}}>ml:read</span></td><td>カラム情報</td></tr>
            <tr><td className="mono">GET</td><td className="mono">/ml/datasets/:name/preview</td><td><span style={{color: 'var(--accent)'}}>ml:read</span></td><td>先頭N行</td></tr>
            <tr><td className="mono">POST</td><td className="mono">/ml/query</td><td><span style={{color: 'var(--accent)'}}>ml:read</span></td><td>SELECT/WITH 実行</td></tr>
            <tr><td className="mono">POST</td><td className="mono">/ml/datasets/append</td><td><span style={{color: 'var(--orange)'}}>ml:write</span></td><td>1行〜複数行追記、新規作成可</td></tr>
            <tr><td className="mono">POST</td><td className="mono">/ml/datasets/import/csv</td><td><span style={{color: 'var(--orange)'}}>ml:write</span></td><td>CSVデータ取り込み</td></tr>
            <tr><td className="mono">POST</td><td className="mono">/ml/datasets/import/api</td><td><span style={{color: 'var(--orange)'}}>ml:write</span></td><td>Web APIから取り込み</td></tr>
            <tr><td className="mono">PUT</td><td className="mono">/ml/datasets/:name</td><td><span style={{color: 'var(--orange)'}}>ml:write</span></td><td>説明文更新</td></tr>
            <tr><td className="mono">DELETE</td><td className="mono">/ml/datasets/:name</td><td><span style={{color: 'var(--orange)'}}>ml:write</span></td><td>テーブル削除</td></tr>
            <tr><td colSpan={4} style={{textAlign: 'center', background: 'var(--bg-tertiary)', padding: '4px', fontSize: 11}}>— 🧠 モデル学習 (Phase 3) —</td></tr>
            <tr><td className="mono">GET</td><td className="mono">/ml/models</td><td><span style={{color: 'var(--accent)'}}>ml:read</span></td><td>モデル一覧</td></tr>
            <tr><td className="mono">POST</td><td className="mono">/ml/models</td><td><span style={{color: 'var(--orange)'}}>ml:write</span></td><td>モデル定義作成/更新</td></tr>
            <tr><td className="mono">DELETE</td><td className="mono">/ml/models/:name</td><td><span style={{color: 'var(--orange)'}}>ml:write</span></td><td>モデル削除</td></tr>
            <tr><td className="mono">GET</td><td className="mono">/ml/models/:name/metrics</td><td><span style={{color: 'var(--accent)'}}>ml:read</span></td><td>学習メトリクス取得</td></tr>
            <tr><td className="mono">GET</td><td className="mono">/ml/jobs</td><td><span style={{color: 'var(--accent)'}}>ml:read</span></td><td>学習ジョブ履歴</td></tr>
            <tr><td className="mono">POST</td><td className="mono">/ml/jobs/start</td><td><span style={{color: 'var(--orange)'}}>ml:write</span></td><td>学習ジョブ開始</td></tr>
            <tr><td className="mono">POST</td><td className="mono">/ml/jobs/:id/stop</td><td><span style={{color: 'var(--orange)'}}>ml:write</span></td><td>学習ジョブ停止</td></tr>
            <tr><td className="mono">GET</td><td className="mono">/ml/jobs/:id/log</td><td><span style={{color: 'var(--accent)'}}>ml:read</span></td><td>学習ログ取得</td></tr>
            <tr><td colSpan={4} style={{textAlign: 'center', background: 'var(--bg-tertiary)', padding: '4px', fontSize: 11}}>— 🎯 推論 (Phase 4) —</td></tr>
            <tr><td className="mono">GET</td><td className="mono">/ml/models/:name/config</td><td><span style={{color: 'var(--accent)'}}>ml:read</span></td><td>モデル設定取得</td></tr>
            <tr><td className="mono">POST</td><td className="mono">/ml/models/:name/predict</td><td><span style={{color: 'var(--accent)'}}>ml:read</span></td><td>推論実行 (単発/バッチ)</td></tr>
            <tr><td colSpan={4} style={{textAlign: 'center', background: 'var(--bg-tertiary)', padding: '4px', fontSize: 11}}>— 🖼️ 画像物体検出 —</td></tr>
            <tr><td className="mono">GET</td><td className="mono">/ml/image/models</td><td><span style={{color: 'var(--accent)'}}>ml:read</span></td><td>COCO事前学習モデル一覧</td></tr>
            <tr><td className="mono">GET</td><td className="mono">/ml/image/custom-models</td><td><span style={{color: 'var(--accent)'}}>ml:read</span></td><td>カスタム学習済みモデル一覧</td></tr>
            <tr><td className="mono">POST</td><td className="mono">/ml/image/detect</td><td><span style={{color: 'var(--accent)'}}>ml:read</span></td><td>物体検出 (COCO/カスタム)</td></tr>
            <tr><td colSpan={4} style={{textAlign: 'center', background: 'var(--bg-tertiary)', padding: '4px', fontSize: 11}}>— 🎮 強化学習 (RL) —</td></tr>
            <tr><td className="mono">GET</td><td className="mono">/ml/rl/envs</td><td><span style={{color: 'var(--accent)'}}>ml:read</span></td><td>環境・アルゴリズム一覧</td></tr>
            <tr><td className="mono">GET</td><td className="mono">/ml/rl/models</td><td><span style={{color: 'var(--accent)'}}>ml:read</span></td><td>学習済みエージェント一覧</td></tr>
            <tr><td className="mono">POST</td><td className="mono">/ml/rl/train</td><td><span style={{color: 'var(--orange)'}}>ml:write</span></td><td>学習開始 (データテーブル)</td></tr>
            <tr><td className="mono">GET</td><td className="mono">/ml/rl/train/status</td><td><span style={{color: 'var(--accent)'}}>ml:read</span></td><td>学習状態+ログ</td></tr>
            <tr><td className="mono">POST</td><td className="mono">/ml/rl/train/cancel</td><td><span style={{color: 'var(--orange)'}}>ml:write</span></td><td>学習キャンセル</td></tr>
            <tr><td className="mono">GET</td><td className="mono">/ml/rl/models/:name/metrics</td><td><span style={{color: 'var(--accent)'}}>ml:read</span></td><td>学習曲線取得</td></tr>
            <tr><td className="mono">POST</td><td className="mono">/ml/rl/models/:name/eval</td><td><span style={{color: 'var(--accent)'}}>ml:read</span></td><td>オフライン方策評価</td></tr>
            <tr><td className="mono">POST</td><td className="mono">/ml/rl/models/:name/policy</td><td><span style={{color: 'var(--accent)'}}>ml:read</span></td><td>推奨行動の取得 (推論)</td></tr>
            <tr><td className="mono">DELETE</td><td className="mono">/ml/rl/models/:name</td><td><span style={{color: 'var(--orange)'}}>ml:write</span></td><td>エージェント削除</td></tr>
            <tr><td colSpan={4} style={{textAlign: 'center', background: 'var(--bg-tertiary)', padding: '4px', fontSize: 11}}>— ⚡ リアルタイム/オンライン学習 —</td></tr>
            <tr><td className="mono">POST</td><td className="mono">/ml/rl/online/create</td><td><span style={{color: 'var(--orange)'}}>ml:write</span></td><td>オンライン化 (fromAgent でウォームスタート / spec でゼロ作成)</td></tr>
            <tr><td className="mono">POST</td><td className="mono">/ml/rl/models/:name/act</td><td><span style={{color: 'var(--accent)'}}>ml:read</span></td><td>推奨行動 (epsilon で探索)</td></tr>
            <tr><td className="mono">POST</td><td className="mono">/ml/rl/models/:name/learn</td><td><span style={{color: 'var(--orange)'}}>ml:write</span></td><td>経験投入で即時1ステップ学習</td></tr>
            <tr><td className="mono">POST</td><td className="mono">/ml/rl/models/:name/checkpoint</td><td><span style={{color: 'var(--orange)'}}>ml:write</span></td><td>明示チェックポイント</td></tr>
            <tr><td className="mono">GET</td><td className="mono">/ml/rl/models/:name/online/status</td><td><span style={{color: 'var(--accent)'}}>ml:read</span></td><td>オンライン学習状況</td></tr>
          </tbody>
        </table>
      </div>

      <div className="ml-section">
        <h3>🖼️ 画像物体検出 API の詳細</h3>
        <p style={{color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6}}>
          画像を base64 で <code>POST /ml/image/detect</code> に送ると、検出された物体 (ラベル・位置・信頼度) が JSON で返ります。
          COCO事前学習モデル (80クラス) と、学習タブで作ったカスタムモデルの両方が使えます。
        </p>
        <table className="ml-schema-table">
          <thead><tr><th>パラメータ</th><th>必須</th><th>説明</th></tr></thead>
          <tbody>
            <tr><td className="mono">image</td><td>必須</td><td>base64文字列 (data URL可)</td></tr>
            <tr><td className="mono">model</td><td>任意</td><td>COCOモデル名 (既定: fasterrcnn_resnet50_fpn)</td></tr>
            <tr><td className="mono">customModel</td><td>任意</td><td>カスタムモデル名 (指定時は model より優先)</td></tr>
            <tr><td className="mono">threshold</td><td>任意</td><td>信頼度しきい値 0〜1 (既定: 0.5)</td></tr>
          </tbody>
        </table>
        <CustomModelApiHelp host={exampleHost} token={sampleToken} />
      </div>

      <div className="ml-section">
        <h3>🎮 強化学習 (RL) API の詳細</h3>
        <p style={{color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6}}>
          データテーブルのログ済み経験データから<strong>オフラインRL</strong>でエージェントを学習し、
          任意の状態に対する<strong>推奨行動</strong>を取得できます。学習は非同期で、<code>/ml/rl/train/status</code> で進捗を確認します。
          <code>next_state</code> 列を指定すれば遷移ベースのオフラインDQN、指定しなければ文脈付きバンディットになります。<br /><br />
          さらに <strong>⚡ リアルタイム/オンライン学習</strong> では、常駐ワーカーがモデルをメモリ保持し、
          <code>act</code>(推論) と <code>learn</code>(経験投入で即時更新) を分離して提供します。
          学習済みエージェントの<strong>ウォームスタート</strong>、または<strong>スキーマ指定でゼロから作成</strong>でき、
          <code>epsilon</code> で ε-greedy 探索を制御します (下のサンプル後半)。
        </p>
        <pre className="api-help-code">{rlPyExample}</pre>
      </div>
    </div>
  );
}

// ─── インポートダイアログ ───
function ImportDialog({ onClose, onDone, showToast }) {
  const [tableName, setTableName] = useState('');
  const [csvContent, setCsvContent] = useState('');
  const [mode, setMode] = useState('replace');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  function handleFile(e) {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setCsvContent(String(reader.result));
    reader.readAsText(f, 'utf-8');
    // ファイル名から拡張子を除去してテーブル名候補に
    if (!tableName) {
      const base = f.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_');
      setTableName(base.match(/^[a-zA-Z]/) ? base : 'tbl_' + base);
    }
  }

  async function submit() {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tableName)) {
      showToast('テーブル名は英字で始まり、英数字とアンダースコアのみ', 'error');
      return;
    }
    if (!csvContent.trim()) {
      showToast('CSVデータが空です', 'error');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/ml/datasets/import/csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tableName, csvContent, mode, description }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      showToast(`インポート完了: ${data.rowCount.toLocaleString()} 行`, 'success');
      onDone();
    } catch (e) {
      showToast(`インポート失敗: ${e.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">📥 CSVをインポート</div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label className="field-label">テーブル名</label>
            <input className="input" value={tableName} onChange={e => setTableName(e.target.value)} placeholder="例: sales_2024" />
            <span className="field-hint">英字で始まり、英数字とアンダースコアのみ。最大64文字。</span>
          </div>
          <div className="field">
            <label className="field-label">CSVファイル</label>
            <input className="file-input" type="file" accept=".csv,.tsv,.txt" onChange={handleFile} />
          </div>
          <div className="field">
            <label className="field-label">または直接貼り付け</label>
            <textarea className="textarea" rows={8} value={csvContent} onChange={e => setCsvContent(e.target.value)}
              placeholder="date,sales,region&#10;2024-01-01,12345,Tokyo&#10;..." />
            <span className="field-hint">1行目をヘッダー、列の型はDuckDBが自動推定します。</span>
          </div>
          <div className="field">
            <label className="field-label">テーブル説明 (任意)</label>
            <input className="input" value={description} onChange={e => setDescription(e.target.value)} placeholder="例: 2024年の店舗別売上データ" />
            <span className="field-hint">LLMがこの説明を参考に適切なクエリを組み立てます。</span>
          </div>
          <div className="field">
            <label className="field-label">モード</label>
            <select className="select" value={mode} onChange={e => setMode(e.target.value)}>
              <option value="replace">置換 (既存テーブルを削除して再作成)</option>
              <option value="append">追加 (既存テーブルに追記、列構造が一致必須)</option>
            </select>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>キャンセル</button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? 'インポート中...' : 'インポート実行'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Web API インポートダイアログ ───
function ApiImportDialog({ onClose, onDone, showToast }) {
  const [tableName, setTableName] = useState('');
  const [url, setUrl] = useState('');
  const [method, setMethod] = useState('GET');
  const [headersText, setHeadersText] = useState('');  // 1行=Key: Value 形式
  const [reqBody, setReqBody] = useState('');           // POST/PUT時
  const [jsonPath, setJsonPath] = useState('');         // 配列の位置
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState('replace');
  const [allowPrivate, setAllowPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);          // インポート後にプレビュー表示
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Key: Value 形式のヘッダーテキストを object に変換
  function parseHeaders(text) {
    const out = {};
    for (const line of (text || '').split('\n')) {
      const m = line.match(/^\s*([^:]+):\s*(.+?)\s*$/);
      if (m) out[m[1].trim()] = m[2].trim();
    }
    return out;
  }

  async function submit() {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tableName)) {
      showToast('テーブル名は英字で始まり、英数字とアンダースコアのみ', 'error');
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      showToast('URL は http:// または https:// で始める必要があります', 'error');
      return;
    }
    setBusy(true);
    setPreview(null);
    try {
      const payload = {
        tableName, url, method,
        headers: parseHeaders(headersText),
        jsonPath: jsonPath.trim(),
        mode,
        description,
        allowPrivateNetwork: allowPrivate,
      };
      if (method !== 'GET' && reqBody.trim()) {
        // JSON として送信を試みる
        try { payload.body = JSON.parse(reqBody); }
        catch { payload.body = reqBody; }  // 文字列のまま
      }
      const r = await fetch('/ml/datasets/import/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      showToast(`インポート完了: ${data.rowCount.toLocaleString()} 行`, 'success');
      setPreview(data.sampleRow);
      // 自動で閉じずに、サンプル行を見せてからユーザーが閉じる
      setTimeout(() => onDone(), 800);
    } catch (e) {
      showToast(`インポート失敗: ${e.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{maxWidth: 720}}>
        <div className="modal-header">
          <div className="modal-title">🌐 Web API をインポート</div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label className="field-label">テーブル名</label>
            <input className="input" value={tableName} onChange={e => setTableName(e.target.value)} placeholder="例: jpy_rates" />
            <span className="field-hint">英字で始まり、英数字とアンダースコアのみ。最大64文字。</span>
          </div>
          <div className="field">
            <label className="field-label">URL</label>
            <input className="input" value={url} onChange={e => setUrl(e.target.value)}
              placeholder="https://api.example.com/data" />
            <span className="field-hint">
              http:// または https:// で始まる URL。応答が JSON である必要があります。<br />
              ローカル/内部IP宛は SSRF 対策で拒否されます (許可するには下の「内部ネットワーク許可」をON)。
            </span>
          </div>
          <div className="field">
            <label className="field-label">JSON Path (任意)</label>
            <input className="input" value={jsonPath} onChange={e => setJsonPath(e.target.value)}
              placeholder="例: data.items / results / leave empty" />
            <span className="field-hint">
              応答内のどこから配列を取り出すかをドット記法で指定。<br />
              空欄なら応答ルート自体を配列とみなします。<br />
              例: <code>data.items</code>、<code>results[0].rows</code>、<code>response.body.list</code>
            </span>
          </div>
          <div className="field">
            <label className="field-label">テーブル説明 (任意)</label>
            <input className="input" value={description} onChange={e => setDescription(e.target.value)}
              placeholder="例: JPY為替レート (日次)" />
          </div>
          <div className="field">
            <label className="field-label">モード</label>
            <select className="select" value={mode} onChange={e => setMode(e.target.value)}>
              <option value="replace">置換 (既存テーブルを削除して再作成)</option>
              <option value="append">追加 (既存テーブルに追記、列構造が一致必須)</option>
            </select>
          </div>

          <div style={{marginTop: 12, marginBottom: 12}}>
            <button className="btn small" onClick={() => setShowAdvanced(!showAdvanced)}>
              {showAdvanced ? '▼' : '▶'} 詳細オプション (HTTPメソッド、ヘッダー、リクエストボディ)
            </button>
          </div>

          {showAdvanced && (
            <>
              <div className="field">
                <label className="field-label">HTTPメソッド</label>
                <select className="select" value={method} onChange={e => setMethod(e.target.value)}>
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                </select>
              </div>
              <div className="field">
                <label className="field-label">ヘッダー (1行1個、Key: Value 形式)</label>
                <textarea className="textarea" rows={4} value={headersText} onChange={e => setHeadersText(e.target.value)}
                  placeholder={'Authorization: Bearer xxxxxx\nX-API-Key: xxxxxx'} />
                <span className="field-hint">機密情報を含むヘッダーはサーバーログにも meta.json にも保存されません。</span>
              </div>
              {method !== 'GET' && (
                <div className="field">
                  <label className="field-label">リクエストボディ (POST/PUT)</label>
                  <textarea className="textarea" rows={6} value={reqBody} onChange={e => setReqBody(e.target.value)}
                    placeholder='{"query": "...", "limit": 100}' />
                  <span className="field-hint">JSON として送信されます。Content-Type は自動で application/json になります。</span>
                </div>
              )}
              <div className="field">
                <label style={{display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer'}}>
                  <input type="checkbox" checked={allowPrivate} onChange={e => setAllowPrivate(e.target.checked)} />
                  <span style={{fontSize: 13}}>内部ネットワーク許可 (localhost / 10.x / 192.168.x 等への接続を許可)</span>
                </label>
                <span className="field-hint" style={{color: 'var(--orange)'}}>
                  ⚠️ 社内 API などで必要な時のみ有効化してください (SSRF 対策が無効化されます)。
                </span>
              </div>
            </>
          )}

          {preview && (
            <div className="field">
              <label className="field-label">サンプル行 (取り込まれたデータの1行目)</label>
              <pre style={{
                background: 'var(--bg-tertiary)',
                padding: 10,
                borderRadius: 4,
                fontSize: 11,
                overflow: 'auto',
                maxHeight: 200,
                margin: 0,
              }}>{JSON.stringify(preview, null, 2)}</pre>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>キャンセル</button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? '取得中...' : 'インポート実行'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 認証ゲート (tuning.html と同じ構造・クラス名) ───
function AuthGate({ authRequired, onAuth }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function handleLogin() {
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setError(d.error || '認証失敗');
        return;
      }
      onAuth();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  if (!authRequired) return <div>認証不要、リダイレクト中...</div>;
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

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
