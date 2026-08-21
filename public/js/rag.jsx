const { useState, useEffect, useRef, useCallback } = React;

// ════════════════════════════════════════════════════════════
// 永続RAG登録 (統合画面)
//   📄 PDF OCR登録  … PDF → Vision LLM → Markdown → RAG (旧 /ocr.html)
//   🌐 HTML/Web登録 … HTML/URL → クリーニング → Markdown → RAG (旧 /htmlrag.html)
// 2つの取り込み経路を1つの画面のタブとして統一した。ジョブAPIは従来どおり
// /ocr/* と /htmlrag/* に分かれており、この画面が両方を束ねて表示する。
// タブは URLハッシュ (#ocr / #html) に対応していて、旧URLからのリダイレクトや
// ブックマークでタブを直接開ける。
// ════════════════════════════════════════════════════════════

// ─── 共通の表示ヘルパー ───────────────────────────────────

const STATUS_LABEL = {
  pending: '待機中',
  queued: '順番待ち',
  running: '処理中',
  completed: '完了',
  failed: '失敗',
  cancelled: '中断',
};

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '-';
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

// uploads/ragfiles 配下のファイルURL。カテゴリ付きジョブのファイルは
// "カテゴリ/名前.pdf" のような相対パスなので、区切りを保ったまま
// セグメント単位でエンコードする
function ragFileUrl(relName) {
  return '/uploads/ragfiles/' + String(relName || '').split('/').map(encodeURIComponent).join('/');
}

// ジョブの登録先カテゴリのバッジ (未分類は出さない)
function CategoryBadge({ category }) {
  if (!category) return null;
  return <span className="rag-cat-badge" title={`登録先カテゴリ: ${category}`}>📂 {category}</span>;
}

// ジョブのカテゴリ変更セレクト。RAG登録済みのジョブだけに出す
// (元PDF/HTML・生成Markdown・RAG登録・ジョブ記録をまとめて移動する)
function CategoryMoveSelect({ job, categories, onChangeCategory }) {
  if (!job.ragDocId) return null;
  return (
    <select
      className="rag-cat-move"
      value={job.category || ''}
      title="カテゴリを変更 (ファイルとRAG登録をまとめて移動します)"
      disabled={isActive(job)}
      onChange={e => { if ((job.category || '') !== e.target.value) onChangeCategory(e.target.value); }}
    >
      <option value="">📂 未分類</option>
      {(categories || []).map(c => <option key={c.name} value={c.name}>📂 {c.name}</option>)}
      {/* 登録簿から消えたカテゴリに居るジョブの受け皿 (選択肢に無い value だと表示が空になる) */}
      {job.category && !(categories || []).some(c => c.name === job.category) && (
        <option value={job.category}>📂 {job.category}</option>
      )}
    </select>
  );
}

// 同時に張るSSEの上限。ブラウザのHTTP/1.1同時接続上限(1オリジン6本)を
// SSEで使い切ると、アップロードやポーリングが接続待ちでハングするため絞る。
// この画面はOCRとHTMLの2系統を束ねるので、それぞれの上限をさらに小さくしてある
const MAX_SSE_PER_KIND = 2;

/** XHR を使うのは、fetch では取れないアップロード進捗を出すため */
function uploadFileXhr(endpoint, file, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', endpoint);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      // 202 = 登録できたが開始できなかった (Vision LLM停止等)
      if (xhr.status === 200 || xhr.status === 202) resolve(data);
      else reject(new Error(data.error || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('通信に失敗しました'));
    xhr.onabort = () => reject(new Error('アップロードを中断しました'));
    xhr.send(fd);
  });
}

// ─── タブ ─────────────────────────────────────────────────

const TABS = [
  { id: 'ocr', hash: '#ocr', label: '📄 PDF OCR登録' },
  { id: 'html', hash: '#html', label: '🌐 HTML / Web登録' },
];

function tabFromHash() {
  return location.hash === '#html' ? 'html' : 'ocr';
}

// ─── OCR側の表示ヘルパー (旧 ocr.jsx) ─────────────────────

const OCR_PHASE_LABEL = {
  analyze: 'PDF解析中',
  vlm: 'Vision LLM起動中',
  ocr: 'OCR中',
  merge: 'Markdown生成中',
  rag: 'RAG登録中',
};

function ocrStatusText(job) {
  if (job.status === 'running' && job.phase && OCR_PHASE_LABEL[job.phase]) return OCR_PHASE_LABEL[job.phase];
  if (job.status === 'pending' && job.interrupted) return '中断 (再開可)';
  return STATUS_LABEL[job.status] || job.status;
}

/** 進捗欄のテキスト。ページ数が判明していない時に状態を取り違えないようにする */
function ocrProgressText(job) {
  if (job.totalPages > 0) return `p${job.donePages}/${job.totalPages}`;
  if (job.status === 'running') return 'ページ数を確認中...';
  if (job.status === 'queued') return '順番待ち';
  return 'ページ数未取得';
}

// ─── HTML側の表示ヘルパー (旧 htmlrag.jsx) ────────────────

const HRAG_PHASE_LABEL = {
  fetch: 'ページ取得中',
  crawl: 'リンク先取得中',
  clean: 'クリーニング中',
  images: '画像解析中',
  merge: 'Markdown生成中',
  rag: 'RAG登録中',
};

function hragStatusText(job) {
  if (job.status === 'running' && job.phase && HRAG_PHASE_LABEL[job.phase]) return HRAG_PHASE_LABEL[job.phase];
  if (job.status === 'pending' && job.interrupted) return '中断 (再実行可)';
  return STATUS_LABEL[job.status] || job.status;
}

// ─── ルート ───────────────────────────────────────────────

function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [appConfig, setAppConfig] = useState({});
  const [tab, setTab] = useState(tabFromHash);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useState(null);

  // OCR側の状態
  const [ocrStatus, setOcrStatus] = useState(null);     // /ocr/status
  const [ocrJobs, setOcrJobs] = useState([]);
  const [ocrUploading, setOcrUploading] = useState([]); // [{uid, name, pct}]

  // HTML側の状態
  const [hragStatus, setHragStatus] = useState(null);   // /htmlrag/status
  const [hragJobs, setHragJobs] = useState([]);
  const [hragUploading, setHragUploading] = useState([]);

  // カテゴリ (uploads/ragfiles/<フォルダ> 単位の分類)
  const [categories, setCategories] = useState([]);      // [{name, docCount, createdAt}]
  const [uncatCount, setUncatCount] = useState(0);       // カテゴリ無しの登録ドキュメント数
  const [uploadCategory, setUploadCategory] = useState(''); // 新規登録の保存先 ('' = 未分類)
  const [newCatName, setNewCatName] = useState('');

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

  // 旧URLからのリダイレクト (#ocr / #html) やブラウザの戻るでタブを追従
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  function selectTab(id) {
    const t = TABS.find(x => x.id === id) || TABS[0];
    history.replaceState(null, '', t.hash);
    setTab(t.id);
  }

  // ─── 取得系 (両タブぶんを常に取り続ける。サイドバーの統計と
  //     非表示タブの実行中ジョブの追従に必要) ───
  const loadOcrJobs = useCallback(async () => {
    try {
      const r = await fetch('/ocr/jobs');
      if (r.ok) setOcrJobs((await r.json()).jobs || []);
    } catch {}
  }, []);
  const loadOcrStatus = useCallback(async () => {
    try {
      const r = await fetch('/ocr/status');
      if (r.ok) setOcrStatus(await r.json());
    } catch {}
  }, []);
  const loadHragJobs = useCallback(async () => {
    try {
      const r = await fetch('/htmlrag/jobs');
      if (r.ok) setHragJobs((await r.json()).jobs || []);
    } catch {}
  }, []);
  const loadHragStatus = useCallback(async () => {
    try {
      const r = await fetch('/htmlrag/status');
      if (r.ok) setHragStatus(await r.json());
    } catch {}
  }, []);
  const loadCategories = useCallback(async () => {
    try {
      const r = await fetch('/rag/categories');
      if (r.ok) {
        const data = await r.json();
        setCategories(data.categories || []);
        setUncatCount(data.uncategorizedCount || 0);
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    loadOcrJobs(); loadOcrStatus();
    loadHragJobs(); loadHragStatus();
    loadCategories();
    // SSE が主だが、取りこぼしと他タブからの操作に備えて定期的に取り直す
    const t = setInterval(() => { loadOcrJobs(); loadHragJobs(); }, 5000);
    const t2 = setInterval(() => { loadOcrStatus(); loadHragStatus(); loadCategories(); }, 30000);
    return () => { clearInterval(t); clearInterval(t2); };
  }, [authenticated, loadOcrJobs, loadOcrStatus, loadHragJobs, loadHragStatus, loadCategories]);

  // 選択中の登録先カテゴリが (他タブ等で) 削除されたら未分類へ戻す
  useEffect(() => {
    if (uploadCategory && !categories.some(c => c.name === uploadCategory)) {
      setUploadCategory('');
    }
  }, [categories, uploadCategory]);

  // ─── 実行中ジョブの進捗を SSE で受ける ───
  // 張るのは running のジョブだけ (queued は進捗が動かないのでポーリングで十分)。
  // アップロード中はSSEを畳んで接続枠をアップロードに回す (旧 ocr.jsx と同じ方針)
  const anyUploading = ocrUploading.length + hragUploading.length > 0;
  const ocrStreamIds = anyUploading ? '' : ocrJobs.filter(j => j.status === 'running')
    .map(j => j.jobId).sort().slice(0, MAX_SSE_PER_KIND).join(',');
  const hragStreamIds = anyUploading ? '' : hragJobs.filter(j => j.status === 'running')
    .map(j => j.jobId).sort().slice(0, MAX_SSE_PER_KIND).join(',');

  useEffect(() => {
    if (!authenticated || !ocrStreamIds) return;
    const sources = ocrStreamIds.split(',').map(id => {
      const es = new EventSource(`/ocr/jobs/${id}/stream`);
      es.onmessage = (ev) => {
        let data;
        try { data = JSON.parse(ev.data); } catch { return; }
        if (data.job) setOcrJobs(prev => prev.map(j => (j.jobId === data.job.jobId ? data.job : j)));
        if (data.type === 'done' || data.type === 'error') { loadOcrJobs(); loadCategories(); }
      };
      es.onerror = () => { /* ブラウザが自動再接続する。切断してもポーリングで追従できる */ };
      return es;
    });
    return () => sources.forEach(es => es.close());
  }, [authenticated, ocrStreamIds, loadOcrJobs, loadCategories]);

  useEffect(() => {
    if (!authenticated || !hragStreamIds) return;
    const sources = hragStreamIds.split(',').map(id => {
      const es = new EventSource(`/htmlrag/jobs/${id}/stream`);
      es.onmessage = (ev) => {
        let data;
        try { data = JSON.parse(ev.data); } catch { return; }
        if (data.job) setHragJobs(prev => prev.map(j => (j.jobId === data.job.jobId ? data.job : j)));
        if (data.type === 'done' || data.type === 'error') { loadHragJobs(); loadCategories(); }
      };
      es.onerror = () => {};
      return es;
    });
    return () => sources.forEach(es => es.close());
  }, [authenticated, hragStreamIds, loadHragJobs, loadCategories]);

  function showToast(msg, type = 'info') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  }

  // ─── カテゴリの作成/削除 ───
  async function createCategory() {
    const name = newCatName.trim();
    if (!name) return;
    try {
      const r = await fetch('/rag/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      showToast(`カテゴリ「${data.name}」を作成しました`, 'success');
      setNewCatName('');
      // 一覧の再取得を待たずに選択したいので、手元の一覧へ先に足しておく
      // (「一覧に無い選択はリセット」のガードに巻き込まれないように)
      setCategories(prev => (prev.some(c => c.name === data.name) ? prev : [...prev, { name: data.name, docCount: 0, createdAt: Date.now() }]));
      setUploadCategory(data.name);   // 作ったカテゴリをそのまま登録先にする
      loadCategories();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  async function deleteCategory(name) {
    if (!confirm(`カテゴリ「${name}」を削除しますか?\n(登録ドキュメントやファイルが残っている場合は削除できません)`)) return;
    try {
      const r = await fetch(`/rag/categories/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      showToast(`カテゴリ「${name}」を削除しました`, 'success');
      if (uploadCategory === name) setUploadCategory('');
      loadCategories();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  // アップロード/URL登録に付けるカテゴリのクエリ文字列
  const categoryQS = uploadCategory ? `?category=${encodeURIComponent(uploadCategory)}` : '';

  // 登録済みジョブのカテゴリ変更 (ファイル・RAG登録・ジョブ記録をまとめて移動)
  async function changeJobCategory(job, category) {
    if (!job.ragDocId) return;
    try {
      const r = await fetch(`/rag/documents/${encodeURIComponent(job.ragDocId)}/category`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      showToast(`「${job.title || job.filename}」を${category ? `カテゴリ「${category}」` : '未分類'}へ移動しました`, 'success');
      loadOcrJobs();
      loadHragJobs();
      loadCategories();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  // ─── OCR: PDFアップロード ───
  async function handlePdfFiles(fileList) {
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
      const uid = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      setOcrUploading(prev => [...prev, { uid, name: file.name, pct: 0 }]);
      try {
        const res = await uploadFileXhr(`/ocr/upload${categoryQS}`, file, (pct) => {
          setOcrUploading(prev => prev.map(u => (u.uid === uid ? { ...u, pct } : u)));
        });
        if (res.warning) showToast(`${file.name}: 登録しましたが開始できません — ${res.warning}`, 'error');
        else showToast(`${file.name}: OCRを開始しました`, 'success');
      } catch (e) {
        showToast(`${file.name}: ${e.message}`, 'error');
      } finally {
        setOcrUploading(prev => prev.filter(u => u.uid !== uid));
        loadOcrJobs();
        loadOcrStatus();
      }
    }
  }

  // ─── HTML: ファイルアップロード ───
  async function handleHtmlFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    const maxMB = appConfig.htmlRag?.maxUploadMB || 20;

    for (const file of files) {
      if (!/\.(html?|xhtml)$/i.test(file.name)) {
        showToast(`${file.name}: HTML ファイル (.html / .htm) のみ対応しています`, 'error');
        continue;
      }
      if (file.size > maxMB * 1024 * 1024) {
        showToast(`${file.name}: ファイルが大きすぎます (上限 ${maxMB} MB)`, 'error');
        continue;
      }
      const uid = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      setHragUploading(prev => [...prev, { uid, name: file.name, pct: 0 }]);
      try {
        const res = await uploadFileXhr(`/htmlrag/upload${categoryQS}`, file, (pct) => {
          setHragUploading(prev => prev.map(u => (u.uid === uid ? { ...u, pct } : u)));
        });
        if (res.warning) showToast(`${file.name}: 登録しましたが開始できません — ${res.warning}`, 'error');
        else showToast(`${file.name}: 取り込みを開始しました`, 'success');
      } catch (e) {
        showToast(`${file.name}: ${e.message}`, 'error');
      } finally {
        setHragUploading(prev => prev.filter(u => u.uid !== uid));
        loadHragJobs();
        loadHragStatus();
      }
    }
  }

  // ─── HTML: URL指定での取り込み ───
  async function handleUrl(url, title, crawl) {
    try {
      const r = await fetch('/htmlrag/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          title: title || undefined,
          crawl: crawl === true || undefined,
          category: uploadCategory || undefined,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok && r.status !== 202) throw new Error(data.error || `HTTP ${r.status}`);
      if (data.warning) showToast(`登録しましたが開始できません — ${data.warning}`, 'error');
      else showToast('ページの取り込みを開始しました', 'success');
      loadHragJobs();
      return true;
    } catch (e) {
      showToast(e.message, 'error');
      return false;
    }
  }

  // ─── ジョブ操作 (base = '/ocr' | '/htmlrag') ───
  async function jobAction(base, jobId, action, body = null) {
    try {
      const r = await fetch(`${base}/jobs/${jobId}/${action}`, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      if (base === '/ocr') loadOcrJobs(); else loadHragJobs();
      return true;
    } catch (e) {
      showToast(e.message, 'error');
      return false;
    }
  }

  // OCR: 完了済みジョブの引き直し。ページを指定するとそのページのキャッシュだけ捨てる
  async function redoOcrJob(job) {
    const spec = prompt(
      `「${job.filename}」を再OCRします。\n\n` +
      `ページ番号を入れると、そのページだけ引き直します (例: 240 / 133, 240 / 10-12)。\n` +
      `空欄のままOKを押すと全${job.totalPages || '?'}ページを最初からやり直します。`,
      ''
    );
    if (spec === null) return;
    const pages = spec.trim();
    if (!pages && !confirm(`全${job.totalPages || '?'}ページをOCRし直します。時間がかかりますがよろしいですか?`)) return;
    if (await jobAction('/ocr', job.jobId, 'start', { redo: true, pages: pages || null })) {
      showToast(pages ? `指定ページを再OCRします (${pages})` : '全ページを再OCRします', 'success');
    }
  }

  // HTML: 再取り込み (URLジョブはページを取得し直す)
  async function redoHragJob(job) {
    const what = job.source === 'url'
      ? `「${job.title}」のページを取得し直して、クリーニングとRAG登録をやり直します。${job.crawl ? '\nリンク先 (同一パス配下・1階層) も取得し直します。' : ''}\nページが更新されていれば新しい内容で登録されます。`
      : `「${job.title}」のクリーニングとRAG登録をやり直します。`;
    if (!confirm(what)) return;
    if (await jobAction('/htmlrag', job.jobId, 'start', { redo: true })) {
      showToast('再取り込みを開始しました', 'success');
    }
  }

  async function deleteJob(base, job, confirmText) {
    if (!confirm(confirmText)) return;
    try {
      const r = await fetch(`${base}/jobs/${job.jobId}`, { method: 'DELETE' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      showToast('削除しました', 'success');
      if (base === '/ocr') loadOcrJobs(); else loadHragJobs();
      loadCategories();   // ジョブ削除でカテゴリのドキュメント数が減る
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  function deleteOcrJob(job) {
    const parts = ['アップロードしたPDF', '生成したMarkdown', 'ページキャッシュ'];
    if (job.ragDocId) parts.push('RAG登録');
    deleteJob('/ocr', job, `「${job.filename}」を削除しますか?\n${parts.join('・')}もすべて削除されます。`);
  }

  function deleteHragJob(job) {
    const parts = [];
    if (job.filename) parts.push('保存した元HTML');
    if (job.mdFilename) parts.push('生成したMarkdown');
    if (job.ragDocId) parts.push('RAG登録');
    const detail = parts.length ? `\n${parts.join('・')}もすべて削除されます。` : '';
    deleteJob('/htmlrag', job, `「${job.title}」を削除しますか?${detail}`);
  }

  if (authRequired && !authenticated) return <LoginView onSuccess={() => setAuthenticated(true)} />;
  if (!authenticated) return <div className="login-container"><div className="login-box">読み込み中...</div></div>;

  // 統計 (両タブの合算)
  const runningCount = ocrJobs.filter(isActive).length + hragJobs.filter(isActive).length;
  const ragCount = ocrJobs.filter(j => j.ragDocId).length + hragJobs.filter(j => j.ragDocId).length;

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
              <div className="logo-sub">永続RAG登録</div>
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
            <div className="stats-card-label">OCRジョブ</div>
            <div className="stats-card-value">{ocrJobs.length}</div>
          </div>
          <div className="stats-card">
            <div className="stats-card-label">HTMLジョブ</div>
            <div className="stats-card-value">{hragJobs.length}</div>
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
          <div className="main-title">📚 永続RAG登録</div>
        </header>
        <div className="main-body">
          {/* カテゴリバー: 新規登録の保存先の選択と、カテゴリの作成/削除。
              カテゴリ = uploads/ragfiles/<フォルダ> で、チャットの📚プルダウンの選択肢になる */}
          <div className="rag-catbar">
            <div className="rag-catbar-row">
              <span className="rag-catbar-label">📂 登録先カテゴリ</span>
              <select
                className="rag-cat-select"
                value={uploadCategory}
                onChange={e => setUploadCategory(e.target.value)}
                title="これからアップロード/URL登録するファイルの保存先カテゴリ"
              >
                <option value="">未分類</option>
                {categories.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
              </select>
              <input
                className="rag-cat-input"
                placeholder="新しいカテゴリ名"
                value={newCatName}
                maxLength={40}
                onChange={e => setNewCatName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') createCategory(); }}
              />
              <button className="btn small" onClick={createCategory} disabled={!newCatName.trim()}>＋ 作成</button>
            </div>
            {(categories.length > 0 || uncatCount > 0) && (
              <div className="rag-catbar-chips">
                {uncatCount > 0 && (
                  <span className="rag-cat-chip" title="カテゴリ未指定の登録ドキュメント">未分類 ({uncatCount})</span>
                )}
                {categories.map(c => (
                  <span key={c.name} className="rag-cat-chip">
                    📂 {c.name} ({c.docCount})
                    <button
                      className="rag-cat-del"
                      title="カテゴリを削除 (ドキュメントとファイルが空のときだけ削除できます)"
                      onClick={() => deleteCategory(c.name)}
                    >×</button>
                  </span>
                ))}
              </div>
            )}
            <div className="rag-catbar-hint">
              アップロード/URL登録したファイルは選択中のカテゴリに保存され、チャット側の📚プルダウンでカテゴリ単位に検索できます。
            </div>
          </div>

          <div className="rag-tabs" role="tablist">
            {TABS.map(t => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={`rag-tab ${tab === t.id ? 'active' : ''}`}
                onClick={() => selectTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'ocr' ? (
            <OcrPanel
              status={ocrStatus}
              appConfig={appConfig}
              jobs={ocrJobs}
              uploading={ocrUploading}
              categories={categories}
              onFiles={handlePdfFiles}
              onStart={(job) => jobAction('/ocr', job.jobId, 'start')}
              onCancel={(job) => jobAction('/ocr', job.jobId, 'cancel')}
              onRedo={redoOcrJob}
              onDelete={deleteOcrJob}
              onChangeCategory={changeJobCategory}
            />
          ) : (
            <HragPanel
              status={hragStatus}
              appConfig={appConfig}
              jobs={hragJobs}
              uploading={hragUploading}
              categories={categories}
              onFiles={handleHtmlFiles}
              onUrl={handleUrl}
              onStart={(job) => jobAction('/htmlrag', job.jobId, 'start')}
              onCancel={(job) => jobAction('/htmlrag', job.jobId, 'cancel')}
              onRedo={redoHragJob}
              onDelete={deleteHragJob}
              onChangeCategory={changeJobCategory}
            />
          )}
        </div>
      </main>

      {toast && <div className={`toast ${toast.type}`}>{toast.msg}</div>}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// 📄 PDF OCR登録 タブ (旧 /ocr.html の本体)
// ════════════════════════════════════════════════════════════

function OcrPanel({ status, appConfig, jobs, uploading, categories, onFiles, onStart, onCancel, onRedo, onDelete, onChangeCategory }) {
  return (
    <>
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

      <OcrStatusAlerts status={status} />

      <DropZone
        disabled={!!(status && (!status.enabled || !status.deps.ok))}
        icon="📄"
        title="PDFをドロップ、またはクリックして選択"
        desc={<span>複数ファイル可 / 1ファイル最大 {appConfig.ocr?.maxUploadMB || 300} MB<br />アップロード後、自動でOCRが始まります</span>}
        accept="application/pdf,.pdf"
        onFiles={onFiles}
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
            <OcrJobCard
              key={job.jobId}
              job={job}
              categories={categories}
              onStart={() => onStart(job)}
              onCancel={() => onCancel(job)}
              onRedo={() => onRedo(job)}
              onDelete={() => onDelete(job)}
              onChangeCategory={(cat) => onChangeCategory(job, cat)}
            />
          ))}
        </div>
      )}
    </>
  );
}

/** 前提条件 (OCR有効 / poppler-utils / Vision LLM) の警告 */
function OcrStatusAlerts({ status }) {
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
      title: status.vlm.managed ? 'Vision LLM の設定に問題があります' : 'Vision LLM に接続できません',
      body: <span>{status.vlm.message}<br />アップロードはできますが、OCRの開始時にエラーになります。</span>,
    });
  }
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
  return <Alerts alerts={alerts} />;
}

function OcrJobCard({ job, categories, onStart, onCancel, onRedo, onDelete, onChangeCategory }) {
  // 実行中は経過時間を毎秒動かす (サーバーからのpushはページ完了時だけなので)
  const [, tick] = useState(0);
  useEffect(() => {
    if (!isActive(job)) return;
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [job.status]);

  const total = job.totalPages || 0;
  const pct = total > 0 ? Math.min(100, Math.round((job.donePages / total) * 100)) : 0;
  const elapsed = (job.status === 'running' && job.startedAt)
    ? Date.now() - job.startedAt
    : (job.elapsedMs || 0);

  let fillClass = 'idle';
  if (job.status === 'completed') fillClass = 'done';
  else if (job.status === 'failed') fillClass = 'failed';
  else if (job.status === 'running') fillClass = 'active';

  const canStart = ['pending', 'failed', 'cancelled'].includes(job.status);

  return (
    <div className={`ocr-job ${job.status}`}>
      <div className="ocr-job-head">
        <div className="ocr-job-name">{String(job.filename || '').split('/').pop()}</div>
        <CategoryBadge category={job.category} />
        <div className="ocr-job-size">{formatBytes(job.sizeBytes)}</div>
        <div className={`ocr-status ${job.status}`}>{ocrStatusText(job)}</div>
      </div>

      <div className="ocr-progress">
        <div className={`ocr-progress-fill ${fillClass}`} style={{ width: `${total > 0 ? pct : 0}%` }} />
      </div>
      <div className="ocr-progress-row">
        <span className="ocr-progress-pages">
          {ocrProgressText(job)}
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
            {/* ジョブファイルは uploads/ragfiles (永続RAGの管理フォルダ、認証付き配信) に置かれている */}
            <a className="btn small" href={ragFileUrl(job.mdFilename)} download={String(job.mdFilename).split('/').pop()}>
              ⬇ Markdown
            </a>
            <a className="btn small" href={ragFileUrl(job.filename)} target="_blank" rel="noreferrer">
              📕 元PDF
            </a>
          </>
        )}
        <CategoryMoveSelect job={job} categories={categories} onChangeCategory={onChangeCategory} />
        <button className="btn danger small spacer" onClick={onDelete} disabled={isActive(job)}>🗑 削除</button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// 🌐 HTML / Web登録 タブ (旧 /htmlrag.html の本体)
// ════════════════════════════════════════════════════════════

function HragPanel({ status, appConfig, jobs, uploading, categories, onFiles, onUrl, onStart, onCancel, onRedo, onDelete, onChangeCategory }) {
  const disabled = !!(status && !status.enabled);
  const urlEnabled = !status || status.allowUrlFetch !== false;

  return (
    <>
      <div className="info-box">
        💡 HTMLファイルのアップロード、またはURLの指定で、Webページを<strong>永続RAGに登録</strong>できます。
        HtmlRAG方式の<strong>HTMLクリーニング</strong>（script/style/ナビゲーション等のノイズ除去）で本文だけを抽出し、
        見出し・表・コードの<strong>構造を保った Markdown</strong> にして登録します。登録後はチャット画面でそのまま
        「この資料の〜について」と質問できます（<code>search_persistent_documents</code> が拾います）。
      </div>

      <HragStatusAlerts status={status} />

      {urlEnabled && !disabled && <UrlForm onSubmit={onUrl} crawlCfg={status?.crawl} />}

      {urlEnabled && !disabled && <div className="hrag-or">または</div>}

      <DropZone
        disabled={disabled}
        icon="📁"
        title="HTMLファイルをドロップ、またはクリックして選択"
        desc={<span>.html / .htm、複数ファイル可 / 1ファイル最大 {appConfig.htmlRag?.maxUploadMB || 20} MB<br />アップロード後、自動でクリーニングとRAG登録が始まります</span>}
        accept="text/html,.html,.htm,.xhtml"
        onFiles={onFiles}
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
          <div className="empty-icon">🌐</div>
          <div className="empty-title">取り込みジョブがありません</div>
          <div className="empty-desc">URLを入力するか、HTMLファイルをドロップしてください</div>
        </div>
      ) : (
        <div className="ocr-job-list">
          {jobs.map(job => (
            <HragJobCard
              key={job.jobId}
              job={job}
              categories={categories}
              onStart={() => onStart(job)}
              onCancel={() => onCancel(job)}
              onRedo={() => onRedo(job)}
              onDelete={() => onDelete(job)}
              onChangeCategory={(cat) => onChangeCategory(job, cat)}
            />
          ))}
        </div>
      )}
    </>
  );
}

/** URL入力フォーム */
function UrlForm({ onSubmit, crawlCfg }) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [crawl, setCrawl] = useState(false);
  const [busy, setBusy] = useState(false);
  const crawlAvailable = crawlCfg && crawlCfg.enabled !== false;

  async function submit() {
    const u = url.trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) {
      alert('http:// または https:// で始まるURLを入力してください');
      return;
    }
    setBusy(true);
    try {
      const ok = await onSubmit(u, title.trim(), crawlAvailable && crawl);
      if (ok) { setUrl(''); setTitle(''); setCrawl(false); }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="hrag-url-form">
      <input
        className="hrag-url-input"
        type="url"
        placeholder="https://example.com/article — 取り込みたいページのURL"
        value={url}
        onChange={e => setUrl(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && !busy && submit()}
      />
      <input
        className="hrag-title-input"
        type="text"
        placeholder="表示名 (省略可)"
        value={title}
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && !busy && submit()}
      />
      <button className="btn primary" onClick={submit} disabled={busy || !url.trim()}>
        {busy ? '登録中...' : '🌐 取り込む'}
      </button>
      {crawlAvailable && (
        <label
          className="hrag-crawl-opt"
          title={`起点ページと同じパス配下のリンクを1階層だけ辿って、まとめて登録します (取得間隔 ${((crawlCfg.delayMs ?? 1000) / 1000)}秒/ページ${crawlCfg.respectRobots !== false ? '、robots.txt 尊重' : ''})`}
        >
          <input type="checkbox" checked={crawl} onChange={e => setCrawl(e.target.checked)} />
          🔗 リンク先も取り込む（同一パス配下・1階層、最大 {crawlCfg.maxPages || 20} ページ）
        </label>
      )}
    </div>
  );
}

/** 前提条件 (機能有効 / embedding / URL取得可否) の警告 */
function HragStatusAlerts({ status }) {
  if (!status) return null;
  const alerts = [];
  if (!status.enabled) {
    alerts.push({
      type: 'error', icon: '⛔', title: 'HTML/RAG機能が無効です',
      body: <span><code>config.json</code> の <code>htmlRag.enabled</code> を <code>true</code> にしてサーバーを再起動してください。</span>,
    });
  }
  if (status.enabled && status.embedding && !status.embedding.available) {
    alerts.push({
      type: 'warn', icon: '⚠️', title: 'Embeddingモデルが使えません',
      body: <span>{status.embedding.reason}<br />取り込み自体はできますが、RAG登録の段階で失敗します。</span>,
    });
  }
  if (status.enabled && !status.allowUrlFetch) {
    alerts.push({
      type: 'warn', icon: 'ℹ️', title: 'URLからの取り込みが無効です',
      body: <span><code>htmlRag.allowUrlFetch</code> が false のため、ローカルHTMLのアップロードのみ利用できます。</span>,
    });
  }
  if (status.enabled && status.images?.enabled && status.images.vlm && !status.images.vlm.ok) {
    alerts.push({
      type: 'warn', icon: '🖼️', title: '画像の内容解析は実行されません',
      body: <span>{status.images.vlm.message}<br />
        取り込み自体は動作し、画像の説明なしで登録されます。画像解析には <code>ocr.vlmPoolModel</code> または <code>ocr.vlmEndpoint</code> の Vision LLM 設定が必要です
        （不要なら <code>htmlRag.describeImages</code> を false に）。</span>,
    });
  }
  if (status.enabled && !status.autoRegisterToRag) {
    alerts.push({
      type: 'warn', icon: 'ℹ️', title: 'RAGへの自動登録が無効です',
      body: <span><code>htmlRag.autoRegisterToRag</code> が false のため、Markdown は生成されますが RAG には登録されません。</span>,
    });
  }
  if (status.enabled && status.registerFormat === 'html') {
    alerts.push({
      type: 'warn', icon: '🧪', title: 'HTML登録モード (HtmlRAG論文準拠)',
      body: <span><code>htmlRag.registerFormat</code> が html のため、Markdown変換せずクリーニング済みHTMLのまま登録します。</span>,
    });
  }
  return <Alerts alerts={alerts} />;
}

function HragJobCard({ job, categories, onStart, onCancel, onRedo, onDelete, onChangeCategory }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!isActive(job)) return;
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [job.status]);

  const elapsed = (job.status === 'running' && job.startedAt)
    ? Date.now() - job.startedAt
    : (job.elapsedMs || 0);

  // クロール時はページ数で実進捗を出し、単一ページは状態表示のバーとして使う
  const multiPage = (job.pagesTotal || 0) > 1;
  let fillClass = 'idle';
  let fillPct = 0;
  if (job.status === 'completed') { fillClass = 'done'; fillPct = 100; }
  else if (job.status === 'failed') { fillClass = 'failed'; fillPct = 100; }
  else if (job.status === 'running') {
    fillClass = 'active';
    fillPct = multiPage ? Math.min(100, Math.round((job.pagesDone / job.pagesTotal) * 100)) : 100;
  }

  // 進捗欄のテキスト (クロールのページ数・画像解析の枚数を状態に添える)
  let progressLabel = hragStatusText(job);
  if (multiPage && (job.status === 'running' || job.status === 'completed')) {
    progressLabel = `ページ ${job.pagesDone}/${job.pagesTotal}　${progressLabel}`;
  }
  if (job.status === 'running' && job.phase === 'images' && job.imagesTotal > 0) {
    progressLabel += ` (${job.imagesDone + job.imagesFailed}/${job.imagesTotal}枚)`;
  }

  const canStart = ['pending', 'failed', 'cancelled'].includes(job.status);
  const compressPct = (job.originalChars > 0 && job.cleanedChars > 0)
    ? Math.round((job.cleanedChars / job.originalChars) * 100)
    : null;
  const ci = job.crawlInfo;

  return (
    <div className={`ocr-job ${job.status}`}>
      <div className="ocr-job-head">
        <div className="ocr-job-name">{job.title}</div>
        <CategoryBadge category={job.category} />
        <div className={`hrag-source ${job.source}`}>{job.source === 'url' ? '🌐 URL' : '📁 ローカル'}</div>
        {job.crawl && <div className="hrag-source url" title="同一パス配下のリンクを1階層取り込むジョブ">🔗 1階層</div>}
        <div className="ocr-job-size">{formatBytes(job.sizeBytes)}</div>
        <div className={`ocr-status ${job.status}`}>{hragStatusText(job)}</div>
      </div>

      {job.url && (
        <div className="hrag-job-url">
          <a href={job.url} target="_blank" rel="noreferrer" title="元ページを開く">{job.url}</a>
        </div>
      )}

      <div className="ocr-progress">
        <div className={`ocr-progress-fill ${fillClass}`} style={{ width: `${fillPct}%` }} />
      </div>
      <div className="ocr-progress-row">
        <span className="ocr-progress-pages">{progressLabel}</span>
        <span className="ocr-progress-time">
          {elapsed > 0 || job.status === 'running' ? `経過 ${formatDuration(elapsed)}` : '未開始'}
        </span>
      </div>

      <div className="ocr-meta">
        {job.status === 'completed' && (
          job.ragDocId
            ? <span className="ocr-badge">✅ RAG登録済み docId={job.ragDocId}{job.ragChunkCount ? ` (${job.ragChunkCount}チャンク)` : ''}</span>
            : <span className="ocr-badge warn">⚠️ RAG未登録{job.ragError ? `: ${job.ragError}` : ''}</span>
        )}
        {job.imageNote && <span className="ocr-badge warn">🖼️ {job.imageNote}</span>}
        {ci && (
          <span className="ocr-meta-item" title="1階層クロールの内訳 (リンク発見数、範囲外・robots.txt・上限・取得失敗による除外)">
            <span className="ocr-meta-key">リンク先</span>
            <span className="ocr-meta-val">
              取り込み{Math.max(0, (job.pagesTotal || 1) - 1 - (ci.errors?.length || 0))}
              {ci.robotsBlocked > 0 && `、robots除外${ci.robotsBlocked}`}
              {ci.outOfScope > 0 && `、範囲外${ci.outOfScope}`}
              {ci.limitSkipped > 0 && `、上限超過${ci.limitSkipped}`}
              {(ci.errors?.length || 0) > 0 && `、失敗${ci.errors.length}`}
            </span>
          </span>
        )}
        {job.imagesTotal > 0 && !job.imageNote && (
          <span className="ocr-meta-item" title="Vision LLM による画像の説明・文字起こし">
            <span className="ocr-meta-key">画像解析</span>
            <span className="ocr-meta-val">{job.imagesDone}/{job.imagesTotal}{job.imagesFailed > 0 ? ` (失敗${job.imagesFailed})` : ''}</span>
          </span>
        )}
        {compressPct !== null && (
          <span className="ocr-meta-item" title="HTMLクリーニングによる圧縮 (元HTML → クリーニング後)">
            <span className="ocr-meta-key">クリーニング</span>
            <span className="ocr-meta-val">
              {job.originalChars.toLocaleString()} → {job.cleanedChars.toLocaleString()}文字 ({compressPct}%)
            </span>
          </span>
        )}
        {job.charCount > 0 && (
          <span className="ocr-meta-item">
            <span className="ocr-meta-key">登録文字数</span>
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
          <button className="btn primary small" onClick={onStart}>▶ 取り込み開始</button>
        )}
        {isActive(job) && <button className="btn danger small" onClick={onCancel}>■ キャンセル</button>}
        {job.status === 'completed' && (
          <button className="btn small" onClick={onRedo} title={job.source === 'url' ? 'ページを取得し直して再登録します' : 'クリーニングと登録をやり直します'}>
            🔄 再取り込み
          </button>
        )}
        {job.status === 'completed' && job.mdFilename && (
          <a className="btn small" href={ragFileUrl(job.mdFilename)} download={String(job.mdFilename).split('/').pop()}>
            ⬇ {/\.html$/i.test(job.mdFilename) ? 'クリーンHTML' : 'Markdown'}
          </a>
        )}
        {job.filename && (
          <a className="btn small" href={ragFileUrl(job.filename)} target="_blank" rel="noreferrer">
            📄 元HTML
          </a>
        )}
        <CategoryMoveSelect job={job} categories={categories} onChangeCategory={onChangeCategory} />
        <button className="btn danger small spacer" onClick={onDelete} disabled={isActive(job)}>🗑 削除</button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// 共通コンポーネント
// ════════════════════════════════════════════════════════════

function Alerts({ alerts }) {
  if (!alerts || alerts.length === 0) return null;
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

function DropZone({ onFiles, disabled, icon, title, desc, accept }) {
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
      <div className="ocr-dropzone-icon">{dragover ? '📥' : icon}</div>
      <div className="ocr-dropzone-title">{title}</div>
      <div className="ocr-dropzone-desc">{desc}</div>
      <input
        ref={inputRef}
        className="ocr-file-input"
        type="file"
        accept={accept}
        multiple
        onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }}
      />
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
