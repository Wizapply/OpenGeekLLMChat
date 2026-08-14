const { useState, useEffect, useRef, useCallback } = React;

// ─── 表示用ヘルパー ───────────────────────────────────────

const STATUS_LABEL = {
  pending: '待機中',
  queued: '順番待ち',
  running: '処理中',
  completed: '完了',
  failed: '失敗',
  cancelled: '中断',
};

// running 中の細かい段階。ページ数の進捗とは別に「今なにをしているか」を出す
const PHASE_LABEL = {
  analyze: 'PDF解析中',
  vlm: 'Vision LLM起動中',
  ocr: 'OCR中',
  merge: 'Markdown生成中',
  rag: 'RAG登録中',
};

function statusText(job) {
  if (job.status === 'running' && job.phase && PHASE_LABEL[job.phase]) return PHASE_LABEL[job.phase];
  if (job.status === 'pending' && job.interrupted) return '中断 (再開可)';
  return STATUS_LABEL[job.status] || job.status;
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${String(s % 60).padStart(2, '0')}秒`;
  const h = Math.floor(m / 60);
  return `${h}時間${String(m % 60).padStart(2, '0')}分`;
}

const isActive = (job) => job.status === 'running' || job.status === 'queued';

// 同時に張るSSEの上限。ブラウザのHTTP/1.1同時接続上限(6本)を使い切ると、
// アップロードやポーリングが接続待ちでハングするため、余裕を持って絞る。
const MAX_SSE = 3;

/** 進捗欄のテキスト。ページ数が判明していない時に状態を取り違えないようにする */
function progressText(job) {
  if (job.totalPages > 0) return `p${job.donePages}/${job.totalPages}`;
  if (job.status === 'running') return 'ページ数を確認中...';
  if (job.status === 'queued') return '順番待ち';
  return 'ページ数未取得';
}

// ─── ルート ───────────────────────────────────────────────

function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [appConfig, setAppConfig] = useState({});
  const [status, setStatus] = useState(null);   // /ocr/status
  const [jobs, setJobs] = useState([]);
  const [uploading, setUploading] = useState([]); // [{name, pct}]
  const [toast, setToast] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await (await fetch('/config')).json();
        setAppConfig(cfg);
        if (cfg.hasPassword) {
          setAuthRequired(true);
          if (cfg.authenticated) setAuthenticated(true);
        } else {
          setAuthenticated(true);
        }
      } catch {}
    })();
  }, []);

  const loadJobs = useCallback(async () => {
    try {
      const r = await fetch('/ocr/jobs');
      if (r.ok) {
        const data = await r.json();
        setJobs(data.jobs || []);
      }
    } catch {}
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch('/ocr/status');
      if (r.ok) setStatus(await r.json());
    } catch {}
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    loadJobs();
    loadStatus();
    // SSE が主だが、取りこぼしと他タブからの操作に備えて定期的に取り直す
    const t = setInterval(loadJobs, 5000);
    const t2 = setInterval(loadStatus, 30000);
    return () => { clearInterval(t); clearInterval(t2); };
  }, [authenticated, loadJobs, loadStatus]);

  // ─── 実行中ジョブの進捗を SSE で受ける ───
  // 張るのは status === 'running' のジョブだけ。順番待ち(queued)にも張ると、
  // HTTP/1.1 のブラウザ同時接続上限(1オリジン6本)をSSEが食い潰し、
  // アップロードのXHRやポーリングが接続を取れずハングする。
  // 順番待ちのジョブは進捗が動かないので5秒ポーリングで十分。
  // MAX_SSE は maxConcurrentJobs を上げた構成でも枠を残すための安全弁。
  // アップロード中はSSEを一旦畳む。大量のPDFをまとめて投入する時に、
  // 接続枠をアップロードへ優先的に回すため (その間もポーリングで一覧は更新される)
  const streamIds = uploading.length > 0 ? '' : jobs.filter(j => j.status === 'running')
    .map(j => j.jobId).sort().slice(0, MAX_SSE).join(',');
  useEffect(() => {
    if (!authenticated || !streamIds) return;
    const sources = streamIds.split(',').map(id => {
      const es = new EventSource(`/ocr/jobs/${id}/stream`);
      es.onmessage = (ev) => {
        let data;
        try { data = JSON.parse(ev.data); } catch { return; }
        if (data.job) {
          setJobs(prev => prev.map(j => (j.jobId === data.job.jobId ? data.job : j)));
        }
        // 完了・失敗で一覧の並びやRAG情報が変わるので取り直す
        if (data.type === 'done' || data.type === 'error') loadJobs();
      };
      es.onerror = () => { /* ブラウザが自動再接続する。切断してもポーリングで追従できる */ };
      return es;
    });
    return () => sources.forEach(es => es.close());
  }, [authenticated, streamIds, loadJobs]);

  function showToast(msg, type = 'info') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  }

  // ─── アップロード ───
  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    const maxMB = appConfig.ocr?.maxUploadMB || 300;

    for (const file of files) {
      if (!/\.pdf$/i.test(file.name)) {
        showToast(`${file.name}: PDF ファイルのみ対応しています`, 'error');
        continue;
      }
      if (file.size > maxMB * 1024 * 1024) {
        showToast(`${file.name}: ファイルが大きすぎます (上限 ${maxMB} MB)`, 'error');
        continue;
      }
      // 進捗更新でオブジェクトを作り直すので、識別は参照ではなく id で行う
      const uid = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      setUploading(prev => [...prev, { uid, name: file.name, pct: 0 }]);
      try {
        const res = await uploadPdf(file, (pct) => {
          setUploading(prev => prev.map(u => (u.uid === uid ? { ...u, pct } : u)));
        });
        if (res.warning) showToast(`${file.name}: 登録しましたが開始できません — ${res.warning}`, 'error');
        else showToast(`${file.name}: OCRを開始しました`, 'success');
      } catch (e) {
        showToast(`${file.name}: ${e.message}`, 'error');
      } finally {
        setUploading(prev => prev.filter(u => u.uid !== uid));
        loadJobs();
        loadStatus();
      }
    }
  }

  // ─── ジョブ操作 ───
  async function jobAction(jobId, action) {
    try {
      const r = await fetch(`/ocr/jobs/${jobId}/${action}`, { method: 'POST' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      loadJobs();
      return true;
    } catch (e) {
      showToast(e.message, 'error');
      return false;
    }
  }

  // 完了済みジョブの引き直し。ページを指定するとそのページのキャッシュだけ捨てる
  async function redoJob(job) {
    const spec = prompt(
      `「${job.filename}」を再OCRします。\n\n` +
      `ページ番号を入れると、そのページだけ引き直します (例: 240 / 133, 240 / 10-12)。\n` +
      `空欄のままOKを押すと全${job.totalPages || '?'}ページを最初からやり直します。`,
      ''
    );
    if (spec === null) return;                       // プロンプトのキャンセル
    const pages = spec.trim();
    if (!pages && !confirm(`全${job.totalPages || '?'}ページをOCRし直します。時間がかかりますがよろしいですか?`)) return;
    try {
      const r = await fetch(`/ocr/jobs/${job.jobId}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redo: true, pages: pages || null }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      showToast(pages ? `指定ページを再OCRします (${pages})` : '全ページを再OCRします', 'success');
      loadJobs();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  async function deleteJob(job) {
    const parts = ['アップロードしたPDF', '生成したMarkdown', 'ページキャッシュ'];
    if (job.ragDocId) parts.push('RAG登録');
    if (!confirm(`「${job.filename}」を削除しますか?\n${parts.join('・')}もすべて削除されます。`)) return;
    try {
      const r = await fetch(`/ocr/jobs/${job.jobId}`, { method: 'DELETE' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      showToast('削除しました', 'success');
      loadJobs();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  if (authRequired && !authenticated) return <LoginView onSuccess={() => setAuthenticated(true)} />;
  if (!authenticated) return <div className="login-container"><div className="login-box">読み込み中...</div></div>;

  const runningCount = jobs.filter(isActive).length;
  const doneCount = jobs.filter(j => j.status === 'completed').length;
  const ragCount = jobs.filter(j => j.ragDocId).length;

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
              <div className="logo-sub">OCR / RAG登録</div>
            </div>
          </div>
        </div>
        <div className="nav-links">
          <a className="nav-link" href="/">💬 チャット</a>
          <a className="nav-link" href="/tuning.html">🧠 ファインチューニング</a>
          <a className="nav-link" href="/ml.html">🤖 機械学習</a>
        </div>
        <div className="sidebar-section">
          <div className="section-title">統計</div>
          <div className="stats-card">
            <div className="stats-card-label">ジョブ</div>
            <div className="stats-card-value">{jobs.length}</div>
          </div>
          <div className="stats-card">
            <div className="stats-card-label">RAG登録済み</div>
            <div className="stats-card-value accent">{ragCount}</div>
          </div>
          {runningCount > 0 && (
            <div className="stats-card">
              <div className="stats-card-label">実行中</div>
              <div className="stats-card-value orange">⚙️ {runningCount}件</div>
            </div>
          )}
          {doneCount > 0 && (
            <div className="stats-card">
              <div className="stats-card-label">完了</div>
              <div className="stats-card-value">{doneCount}</div>
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
          <div className="main-title">📄 OCR / RAG登録</div>
        </header>
        <div className="main-body">
          <div className="info-box">
            💡 PDFをアップロードすると、<strong>Vision LLM が1ページずつ Markdown 化</strong>し、完了後は
            自動で <strong>RAG に登録</strong>されます。登録後はチャット画面でそのまま
            「この資料の〜について」と質問できます（<code>search_persistent_documents</code> が拾います）。
            中断しても<strong>ページ単位でキャッシュ</strong>されるので、開始し直せば続きから再開します。
          </div>

          {status?.vlm?.ok && status.vlm.managed && (
            <div className="info-box">
              🧠 Vision LLM「<strong>{status.vlm.modelName}</strong>」は<strong>LLMプール管理</strong>です。
              OCRの実行中だけロードされ、終わればアイドル時間の経過後に自動でアンロードされます
              （VRAMを掴んだままになりません）。VRAMが足りなければチャットのモデルを一時的に降ろして確保します。
            </div>
          )}

          <StatusAlerts status={status} config={appConfig} />

          <DropZone
            disabled={!!(status && (!status.enabled || !status.deps.ok))}
            maxMB={appConfig.ocr?.maxUploadMB || 300}
            onFiles={handleFiles}
          />

          {uploading.map(u => (
            <div className="ocr-uploading" key={u.uid}>
              <div className="ocr-spinner" />
              <span>アップロード中: {u.name}</span>
              <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>{Math.round(u.pct * 100)}%</span>
            </div>
          ))}

          {jobs.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">📄</div>
              <div className="empty-title">OCRジョブがありません</div>
              <div className="empty-desc">上の領域にPDFをドロップするか、クリックして選択してください</div>
            </div>
          ) : (
            <div className="ocr-job-list">
              {jobs.map(job => (
                <JobCard
                  key={job.jobId}
                  job={job}
                  onStart={() => jobAction(job.jobId, 'start')}
                  onCancel={() => jobAction(job.jobId, 'cancel')}
                  onRedo={() => redoJob(job)}
                  onDelete={() => deleteJob(job)}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      {toast && <div className={`toast ${toast.type}`}>{toast.msg}</div>}
    </div>
  );
}

/** XHR を使うのは、fetch では取れないアップロード進捗を出すため */
function uploadPdf(file, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/ocr/upload');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      // 202 = 登録できたが Vision LLM 停止等で開始できなかった
      if (xhr.status === 200 || xhr.status === 202) resolve(data);
      else reject(new Error(data.error || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('通信に失敗しました'));
    xhr.onabort = () => reject(new Error('アップロードを中断しました'));
    xhr.send(fd);
  });
}

/** 前提条件 (OCR有効 / poppler-utils / Vision LLM) の警告 */
function StatusAlerts({ status, config }) {
  if (!status) return null;
  const alerts = [];
  if (!status.enabled) {
    alerts.push({
      type: 'error', icon: '⛔', title: 'OCR機能が無効です',
      body: <span><code>config.json</code> の <code>ocr.enabled</code> を <code>true</code> にしてサーバーを再起動してください。</span>,
    });
  }
  if (!status.deps.ok) {
    alerts.push({
      type: 'error', icon: '📦', title: '必要なコマンドが見つかりません',
      body: <span>{status.deps.message}<br />不足: <code>{(status.deps.missing || []).join(', ')}</code></span>,
    });
  }
  if (status.enabled && status.deps.ok && !status.vlm.ok) {
    alerts.push({
      type: 'warn', icon: '⚠️',
      // プール管理なら「繋がらない」ではなく設定の問題 (プロセスはまだ起動していなくて当然)
      title: status.vlm.managed ? 'Vision LLM の設定に問題があります' : 'Vision LLM に接続できません',
      body: <span>{status.vlm.message}<br />アップロードはできますが、OCRの開始時にエラーになります。</span>,
    });
  }
  // 開始はできるが結果が壊れる設定 (--mmproj の無いモデルを指している等)
  if (status.enabled && status.deps.ok && status.vlm.ok && status.vlm.warn) {
    alerts.push({
      type: 'warn', icon: '⚠️', title: 'Vision LLM の設定を確認してください',
      body: <span>{status.vlm.warn}</span>,
    });
  }
  if (status.enabled && !status.autoRegisterToRag) {
    alerts.push({
      type: 'warn', icon: 'ℹ️', title: 'RAGへの自動登録が無効です',
      body: <span><code>ocr.autoRegisterToRag</code> が false のため、Markdown は生成されますが RAG には登録されません。</span>,
    });
  }
  if (alerts.length === 0) return null;
  return (
    <>
      {alerts.map((a, i) => (
        <div className={`ocr-alert ${a.type}`} key={i}>
          <div className="ocr-alert-icon">{a.icon}</div>
          <div className="ocr-alert-body">
            <div className="ocr-alert-title">{a.title}</div>
            <div>{a.body}</div>
          </div>
        </div>
      ))}
    </>
  );
}

function DropZone({ onFiles, disabled, maxMB }) {
  const [dragover, setDragover] = useState(false);
  const inputRef = useRef(null);

  return (
    <div
      className={`ocr-dropzone ${dragover ? 'dragover' : ''} ${disabled ? 'disabled' : ''}`}
      onClick={() => { if (!disabled) inputRef.current?.click(); }}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragover(true); }}
      onDragLeave={() => setDragover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragover(false);
        if (!disabled) onFiles(e.dataTransfer.files);
      }}
    >
      <div className="ocr-dropzone-icon">{dragover ? '📥' : '📄'}</div>
      <div className="ocr-dropzone-title">PDFをドロップ、またはクリックして選択</div>
      <div className="ocr-dropzone-desc">
        複数ファイル可 / 1ファイル最大 {maxMB} MB<br />
        アップロード後、自動でOCRが始まります
      </div>
      <input
        ref={inputRef}
        className="ocr-file-input"
        type="file"
        accept="application/pdf,.pdf"
        multiple
        onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }}
      />
    </div>
  );
}

function JobCard({ job, onStart, onCancel, onRedo, onDelete }) {
  // 実行中は経過時間を毎秒動かす (サーバーからのpushはページ完了時だけなので)
  const [, tick] = useState(0);
  useEffect(() => {
    if (!isActive(job)) return;
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [job.status]);

  const total = job.totalPages || 0;
  const pct = total > 0 ? Math.min(100, Math.round((job.donePages / total) * 100)) : 0;
  // 実行中だけ毎秒進める。終了後はサーバーが確定させた値をそのまま使う
  const elapsed = (job.status === 'running' && job.startedAt)
    ? Date.now() - job.startedAt
    : (job.elapsedMs || 0);

  let fillClass = 'idle';
  if (job.status === 'completed') fillClass = job.failedPages.length ? 'done' : 'done';
  else if (job.status === 'failed') fillClass = 'failed';
  else if (job.status === 'running') fillClass = 'active';

  const canStart = ['pending', 'failed', 'cancelled'].includes(job.status);

  return (
    <div className={`ocr-job ${job.status}`}>
      <div className="ocr-job-head">
        <div className="ocr-job-name">{job.filename}</div>
        <div className="ocr-job-size">{formatBytes(job.sizeBytes)}</div>
        <div className={`ocr-status ${job.status}`}>{statusText(job)}</div>
      </div>

      <div className="ocr-progress">
        <div className={`ocr-progress-fill ${fillClass}`} style={{ width: `${total > 0 ? pct : 0}%` }} />
      </div>
      <div className="ocr-progress-row">
        <span className="ocr-progress-pages">
          {progressText(job)}
          {total > 0 && <span className="ocr-progress-pct">　{pct}%</span>}
        </span>
        <span className="ocr-progress-time">
          {elapsed > 0 || job.status === 'running' ? `経過 ${formatDuration(elapsed)}` : '未開始'}
          {job.status === 'running' && job.etaMs != null && ` / 残り約 ${formatDuration(job.etaMs)}`}
        </span>
      </div>

      <div className="ocr-meta">
        {job.status === 'completed' && (
          job.ragDocId
            ? <span className="ocr-badge">✅ RAG登録済み docId={job.ragDocId}{job.ragChunkCount ? ` (${job.ragChunkCount}チャンク)` : ''}</span>
            : <span className="ocr-badge warn">⚠️ RAG未登録{job.ragError ? `: ${job.ragError}` : ''}</span>
        )}
        {job.failedPages.length > 0 && (
          <span className="ocr-meta-item">
            <span className="ocr-meta-key">失敗ページ</span>
            <span className="ocr-meta-val">{job.failedPages.slice(0, 12).join(', ')}{job.failedPages.length > 12 ? ` 他${job.failedPages.length - 12}件` : ''}</span>
          </span>
        )}
        {job.charCount > 0 && (
          <span className="ocr-meta-item">
            <span className="ocr-meta-key">文字数</span>
            <span className="ocr-meta-val">{job.charCount.toLocaleString()}</span>
          </span>
        )}
        <span className="ocr-meta-item">
          <span className="ocr-meta-key">登録</span>
          <span className="ocr-meta-val">{new Date(job.createdAt).toLocaleString('ja-JP')}</span>
        </span>
      </div>

      {job.error && <div className="ocr-error">{job.error}</div>}

      <div className="ocr-actions">
        {canStart && (
          <button className="btn primary small" onClick={onStart}>
            {job.donePages > 0 ? '▶ 再開' : '▶ OCR開始'}
          </button>
        )}
        {isActive(job) && <button className="btn danger small" onClick={onCancel}>■ キャンセル</button>}
        {job.status === 'completed' && (
          <button className="btn small" onClick={onRedo} title="ページを指定して引き直せます">
            🔄 再OCR
          </button>
        )}
        {job.status === 'completed' && job.mdFilename && (
          <>
            <a className="btn small" href={`/files/${encodeURIComponent(job.mdFilename)}?raw=1`} download={job.mdFilename}>
              ⬇ Markdown
            </a>
            <a className="btn small" href={`/uploads/${encodeURIComponent(job.filename)}`} target="_blank" rel="noreferrer">
              📕 元PDF
            </a>
          </>
        )}
        <button className="btn danger small spacer" onClick={onDelete} disabled={isActive(job)}>🗑 削除</button>
      </div>
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

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
