const { useState, useRef, useEffect, useCallback } = React;

// ─── Utility: ユーザー指定の役割をシステムプロンプト先頭に差し込む ───
// LLM はシステムプロンプト先頭の指示を最優先しやすいため、末尾追加ではなく
// 先頭に「最優先指示」として配置し、汎用ルール(meta 等)より役割を優先させる。
function applyRolePrompt(basePrompt, chatRole) {
  if (!chatRole || !chatRole.trim()) return basePrompt;
  const roleBlock =
    '【最優先指示: ユーザー指定の役割】\n' +
    '以下の役割・指示に厳密に従って応答してください。これは以降のどの一般的なルールよりも優先されます。\n\n' +
    chatRole.trim() +
    '\n\n────────────────────\n\n';
  return roleBlock + (basePrompt || '');
}

// ─── Utility: バイト数フォーマット ───
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

// ─── Utility: 暴走ループ検出（末尾の周期性チェック） ───
// 末尾が「同じ文字列の連続した繰り返し」でできているかを調べ、
// 見つかったらその周期(文字数)を、無ければ 0 を返す。
//
// 【なぜこの方式にしたか】
// 以前は「正規化した100文字の塊が応答全体のどこかで3回現れたら打ち切り」だった。
// しかしファイル内容の引用 (CSV・ログ・設定ファイル・コード) では、同じ100文字が
// 離れた場所に何度も現れるのが普通で、GDrive やサーバーのファイルを読ませると
// 本文の途中で生成が中断される誤検出が多発していた。
// 本物の暴走ループは「直前に出したものをそのまま繰り返す」ので、
// 末尾が【連続して】周期的かどうかだけを見る方が精度が高い。
// 少し変化しながら繰り返すループは取り逃がすが、その場合も max_tokens で
// 頭打ちになるだけで、正しい回答を途中で切るより害が小さい。
function findTailRepetition(text, opts = {}) {
  const minPeriod = opts.minPeriod ?? 16;    // これ未満の短い繰り返しは見ない（箇条書き記号等の誤検出防止）
  const maxPeriod = opts.maxPeriod ?? 400;   // 段落まるごとのループまで拾えるように広めに取る
  const minRepeats = opts.minRepeats ?? 4;   // 4回以上ぴったり繰り返していたら異常とみなす
  const minSpan = opts.minSpan ?? 90;        // 繰り返し部分の合計文字数の下限（短い周期ほど回数を要求する）
  const minDistinct = opts.minDistinct ?? 8; // 記号の羅列 (====== や ,,,,,) は繰り返しでも正常
  const n = text.length;
  for (let p = minPeriod; p <= maxPeriod; p++) {
    const repeats = Math.max(minRepeats, Math.ceil(minSpan / p));
    const span = repeats * p;
    if (span > n) break;                     // これ以上長い周期は末尾に収まらない
    const limit = n - span;
    let periodic = true;
    for (let i = n - 1; i >= limit + p; i--) {
      if (text[i] !== text[i - p]) { periodic = false; break; }
    }
    if (!periodic) continue;
    if (new Set(text.slice(n - p)).size < minDistinct) continue;
    return p;
  }
  return 0;
}

// ─── Utility: GDrive のファイル参照を実IDに解決する ───
// Google Drive の ID は 33文字前後のランダム文字列で、LLM はこれを正確に書き写すのが
// 非常に苦手。1〜2文字変えたり途中で切ったりして「IDが違ったのでやり直す」を繰り返し、
// ツールのターン上限に当たって回答にたどり着けなくなる
// (「Let me try reading with the exact original ID...」と言ったまま止まる現象)。
//
// そこで直前の検索/一覧の結果を覚えておき、
//   ・通し番号 (1, 2, 3...)   ・ファイル名   ・多少崩れたID
// のどれからでも正しい ID に解決できるようにする。
function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}
function commonSuffixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/**
 * @param {string} ref     LLM が渡してきた値 (ID / 番号 / ファイル名)
 * @param {{list: Array<{id:string,name:string}>, seen: Map<string,string>}} recent
 * @returns {{id: string, note: string}} note は補正した場合の説明 (LLMに返して学習させる)
 */
function resolveGdriveFileRef(ref, recent) {
  const raw = String(ref ?? '').trim();
  if (!raw) return { id: '', note: '' };
  const list = recent?.list || [];
  const seen = recent?.seen || new Map();
  if (list.length === 0 && seen.size === 0) return { id: raw, note: '' };

  // 1. 既知のIDと完全一致 → そのまま
  if (seen.has(raw)) return { id: raw, note: '' };

  // 2. 通し番号 ("2" や "[2]") → 直前の一覧の n 番目
  const num = raw.match(/^\[?(\d{1,3})\]?$/);
  if (num) {
    const hit = list[Number(num[1]) - 1];
    if (hit) return { id: hit.id, note: `(番号 ${num[1]} = 「${hit.name}」として解決)` };
  }

  // 3. ファイル名 (完全一致 → 前方一致 → 部分一致)
  const lower = raw.toLowerCase();
  const entries = [...seen.entries()].map(([id, name]) => ({ id, name: name || '' }));
  const byName = entries.find(f => f.name.toLowerCase() === lower)
    || entries.find(f => f.name.toLowerCase().startsWith(lower))
    || (raw.length >= 3 ? entries.find(f => f.name.toLowerCase().includes(lower)) : null);
  if (byName) return { id: byName.id, note: `(ファイル名 "${raw}" = 「${byName.name}」として解決)` };

  // 4. 崩れたID: 前後の一致長が十分なら同じものとみなす。
  //    IDはランダムなので十数文字一致すれば別ファイルと衝突しない。
  if (raw.length >= 8) {
    let best = null, bestScore = 0;
    for (const f of entries) {
      const score = commonPrefixLen(f.id, raw) + commonSuffixLen(f.id, raw);
      if (score > bestScore) { bestScore = score; best = f; }
    }
    if (best && bestScore >= 12) {
      return { id: best.id, note: `(ID の写し間違いを補正して「${best.name}」を読みました)` };
    }
  }
  return { id: raw, note: '' };
}

// ─── Utility: テキストをチャンクに分割 ───
// (サーバー側 ragChunkText と挙動を揃える: 末尾チャンク到達で break、overlap 不正値もガード)
function chunkText(text, chunkSize = 500, overlap = 100) {
  const chunks = [];
  if (!text) return chunks;
  // overlap >= chunkSize だと進まなくなる → 強制的に半分まで抑える
  const safeOverlap = Math.min(overlap, Math.floor(chunkSize / 2));
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start += chunkSize - safeOverlap;
  }
  return chunks;
}

// ─── Utility: コサイン類似度 ───
// サーバー側 ragCosineSim と挙動を揃える
function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}

// ─── PDFテキスト抽出 (PDF.js, OCR済みPDFのテキストレイヤーから抽出) ───
// 大きいPDFでもページ単位で逐次処理するためメモリ効率が良い
// onProgress(currentPage, totalPages) で進捗を通知
async function extractPdfText(file, onProgress) {
  if (typeof pdfjsLib === 'undefined') {
    throw new Error('PDF.jsの読み込みに失敗しました (CDN https://cdnjs.cloudflare.com にアクセスできない可能性があります)');
  }
  // PDF.js の worker を指定 (同じバージョンのCDNを使う)
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const parts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    if (onProgress) onProgress(i, pdf.numPages);
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // テキストアイテムを順番に連結 (PDF構造上の自然な順序)
    const pageText = content.items.map(it => it.str).join(' ');
    if (pageText.trim()) {
      parts.push(`[Page ${i}]\n${pageText}`);
    }
    // メモリ解放
    page.cleanup();
  }
  await pdf.destroy();
  const fullText = parts.join('\n\n');
  if (!fullText.trim()) {
    throw new Error('PDFからテキストを抽出できませんでした。スキャン画像のみで OCR されていない可能性があります');
  }
  return fullText;
}

// ─── Marked.js 設定 ───
marked.setOptions({
  breaks: true,
  gfm: true,
});

// ─── カスタムRenderer: コードブロックにヘッダー追加 ───
const renderer = new marked.Renderer();
renderer.code = function(arg1, arg2) {
  // marked v12+: arg1 = { text, lang } / older: arg1 = code, arg2 = lang
  const text = (typeof arg1 === 'object' && arg1 !== null) ? (arg1.text || arg1.code || '') : (arg1 || '');
  const language = (typeof arg1 === 'object' && arg1 !== null) ? (arg1.lang || arg1.language || '') : (arg2 || '');
  let highlighted;
  if (language && hljs.getLanguage(language)) {
    try { highlighted = hljs.highlight(text, { language }).value; } catch { highlighted = text; }
  } else {
    try { highlighted = hljs.highlightAuto(text).value; } catch { highlighted = text; }
  }
  // 重要: ID は code テキストのハッシュから決定的に生成する
  // Math.random() を使うと再レンダリングのたびに ID が変わり、
  // ユーザーが「▶ 実行」を押した直後の再レンダリングで output-<id> が消滅する
  // → runPython() の document.getElementById() が失敗して結果が表示されない
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  const id = 'code-' + Math.abs(hash).toString(36) + '-' + text.length;
  const isPython = /^py(thon[23]?)?$/.test(language);
  const isPreviewable = /^(html|threejs|three\.js|3d|webgl|canvas)$/.test(language);
  let actionBtns = '';
  if (isPython) {
    actionBtns += '<button class="run-btn" onclick="runPython(\'' + id + '\', this)">▶ 実行</button>';
  }
  if (isPreviewable) {
    actionBtns += '<button class="run-btn preview-btn" onclick="runPreview(\'' + id + '\', this)">▶ プレビュー</button>';
  }
  return '<div class="code-block-wrapper"><div class="code-header"><span>' + (language || 'code') + '</span><div class="code-header-actions">' + actionBtns + '<button class="copy-btn" onclick="copyCode(this, \'' + id + '\')">コピー</button></div></div><pre><code id="' + id + '" class="hljs language-' + language + '">' + highlighted + '</code></pre><div id="output-' + id + '"></div></div>';
};
// ─── カスタムRenderer: 飛べないリンクは素のテキストに落とす ───
// RAG の出典をモデルが Markdown のリンク記法で書き出すことがある。
// 例: 「[219](テラメカニックス-走行力学-.md)」
// これは相対パスなので現在のURL (/chat/xxx) に連結され、存在しないページへの
// リンクになる。しかもファイル名はモデルが書き崩していて手掛かりにもならない。
// http(s)/mailto/アンカー/絶対パス以外はリンクにせず、文字として表示する。
renderer.link = function (arg1, title, text) {
  // marked v12 は (href, title, text)。将来版のオブジェクト形式にも備える
  const isObj = typeof arg1 === 'object' && arg1 !== null;
  const href = String(isObj ? (arg1.href || '') : (arg1 || ''));
  const ttl = String(isObj ? (arg1.title || '') : (title || ''));
  const label = String(isObj ? (arg1.text || '') : (text || ''));
  // /chat/<何か>.md は存在しない。モデルがフルURLで出典を捏造した時の形なので弾く
  const bogusDoc = /\/chat\/[^?#]*\.md$/i.test(href);
  const navigable = /^(https?:\/\/|mailto:|#|\/)/i.test(href) && !bogusDoc;
  if (!navigable) return label || href;
  const q = (s) => s.replace(/"/g, '&quot;');
  return '<a href="' + q(href) + '"' + (ttl ? ' title="' + q(ttl) + '"' : '')
    + ' target="_blank" rel="noreferrer noopener">' + label + '</a>';
};
marked.use({ renderer });

// ─── コピー関数（グローバル）───
window.copyCode = function(btn, id) {
  const el = document.getElementById(id);
  if (!el) return;
  const text = el.textContent;
  const onSuccess = () => {
    btn.textContent = 'コピー済';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'コピー'; btn.classList.remove('copied'); }, 2000);
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(onSuccess).catch(() => fallbackCopy(text, onSuccess));
  } else {
    fallbackCopy(text, onSuccess);
  }
};
function fallbackCopy(text, cb) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); cb(); } catch {}
  document.body.removeChild(ta);
}

// ─── Python 実行関数（グローバル）───
window.runPython = function(codeId, btn) {
  const codeEl = document.getElementById(codeId);
  const outputEl = document.getElementById('output-' + codeId);
  if (!codeEl || !outputEl) return;

  const code = codeEl.textContent;
  btn.textContent = '⏳ 実行中...';
  btn.classList.add('running');
  btn.disabled = true;

  // WebSocket接続
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(protocol + '//' + location.host + '/ws/python');
  const outputId = 'term-body-' + codeId;
  const inputId = 'term-input-' + codeId;
  const inputRowId = 'term-input-row-' + codeId;

  // 初期UI
  outputEl.innerHTML =
    '<div class="code-output">' +
      '<div class="code-output-header" style="color:var(--orange)"><span>⏳ 実行中...</span><button class="terminal-kill-btn" onclick="killPython(\'' + codeId + '\')">■ 停止</button></div>' +
      '<div class="code-output-body" id="' + outputId + '"></div>' +
      '<div class="terminal-input-row" id="' + inputRowId + '">' +
        '<span class="terminal-prompt">›</span>' +
        '<input class="terminal-stdin" id="' + inputId + '" placeholder="入力してEnter..." />' +
        '<button class="terminal-send-btn" onclick="sendStdin(\'' + codeId + '\')">送信</button>' +
      '</div>' +
    '</div>';

  // stdin入力のEnterキー対応
  setTimeout(() => {
    const inp = document.getElementById(inputId);
    if (inp) {
      inp.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); sendStdin(codeId); }
      });
      inp.focus();
    }
  }, 50);

  // WebSocketを要素に紐付け
  outputEl._ws = ws;

  ws.onopen = function() {
    ws.send(JSON.stringify({ type: 'run', code: code }));
  };

  ws.onmessage = function(event) {
    const msg = JSON.parse(event.data);
    const body = document.getElementById(outputId);
    if (!body) return;

    if (msg.type === 'stdout') {
      body.innerHTML += escapeHtml(msg.data);
      body.scrollTop = body.scrollHeight;
    }
    if (msg.type === 'stderr') {
      body.innerHTML += '<span style="color:var(--red)">' + escapeHtml(msg.data) + '</span>';
      body.scrollTop = body.scrollHeight;
    }
    if (msg.type === 'image') {
      // Python matplotlib で生成された画像を表示
      // filename が "plots/xxx.png" なら /plots/xxx.png（自動生成画像）
      // それ以外は /files/xxx.png（ユーザーが明示的にsavefigしたuploads配下）
      const url = (msg.filename.startsWith('plots/')
        ? '/' + msg.filename
        : '/files/' + encodeURIComponent(msg.filename)) + '?t=' + Date.now();
      const displayName = msg.filename.replace(/^plots\//, '');
      const imgHtml = '<div style="margin:8px 0;padding:8px;background:var(--bg-primary);border-radius:6px;">'
        + '<img src="' + url + '" style="max-width:100%;height:auto;display:block;cursor:zoom-in;border-radius:4px;" '
        + 'onclick="window.open(this.src, \'_blank\')" alt="' + escapeHtml(displayName) + '">'
        + '<div style="display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-top:6px;gap:8px;">'
        + '<span>📊 ' + escapeHtml(displayName) + '</span>'
        + '<button onclick="window.attachImageToChat(\'' + escapeHtml(msg.filename) + '\')" '
        + 'style="background:var(--accent-dim);border:1px solid var(--accent);color:var(--accent);padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:600;">'
        + '📎 チャットに添付</button>'
        + '</div>'
        + '</div>';
      body.innerHTML += imgHtml;
      body.scrollTop = body.scrollHeight;
    }
    if (msg.type === 'exit') {
      const isError = msg.exitCode !== 0;
      // ヘッダーを完了に更新
      const header = outputEl.querySelector('.code-output-header');
      if (header) {
        header.className = 'code-output-header ' + (isError ? 'error' : 'success');
        header.innerHTML = '<span>' + (isError ? '❌ エラー' : '✅ 実行完了') + '</span><span class="exit-code">exit: ' + msg.exitCode + '</span>';
      }
      // 入力欄を非表示
      const inputRow = document.getElementById(inputRowId);
      if (inputRow) inputRow.style.display = 'none';
      // ボタン復帰
      btn.textContent = '▶ 実行';
      btn.classList.remove('running');
      btn.disabled = false;
      ws.close();
    }
  };

  ws.onerror = function() {
    outputEl.innerHTML = '<div class="code-output"><div class="code-output-header error">❌ WebSocket接続エラー</div></div>';
    btn.textContent = '▶ 実行';
    btn.classList.remove('running');
    btn.disabled = false;
  };

  ws.onclose = function() {
    outputEl._ws = null;
  };
};

// ─── stdin 送信 ───
window.sendStdin = function(codeId) {
  const outputEl = document.getElementById('output-' + codeId);
  const inputEl = document.getElementById('term-input-' + codeId);
  const bodyEl = document.getElementById('term-body-' + codeId);
  if (!outputEl || !inputEl || !outputEl._ws) return;

  const value = inputEl.value;
  inputEl.value = '';

  // 入力をターミナルに表示
  if (bodyEl) {
    bodyEl.innerHTML += '<span style="color:var(--accent)">' + escapeHtml(value) + '</span>\n';
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  outputEl._ws.send(JSON.stringify({ type: 'stdin', data: value }));
  inputEl.focus();
};

// ─── プロセス停止 ───
window.killPython = function(codeId) {
  const outputEl = document.getElementById('output-' + codeId);
  if (outputEl && outputEl._ws) {
    outputEl._ws.send(JSON.stringify({ type: 'kill' }));
  }
};

// ─── コードプレビュー（Three.js / HTML）───
window.runPreview = function(codeId, btn) {
  const codeEl = document.getElementById(codeId);
  const outputEl = document.getElementById('output-' + codeId);
  if (!codeEl || !outputEl) return;

  // 既にプレビュー中なら閉じる
  if (outputEl.querySelector('.code-preview-container')) {
    outputEl.innerHTML = '';
    btn.textContent = '▶ プレビュー';
    return;
  }

  const code = codeEl.textContent;
  btn.textContent = '✕ 閉じる';

  // Three.js CDN（正規URL）
  const THREE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  const ORBIT_CDN = 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js';
  const threeScriptTags = '<script src="' + THREE_CDN + '"><\/script>'
    + '<script src="' + ORBIT_CDN + '"><\/script>'
    + '<script>window.OrbitControls=THREE.OrbitControls;<\/script>';

  const needsThree = /THREE[\.\(]/i.test(code);

  // LLMが生成した壊れたThree.js読み込みタグを除去する正規表現
  const badThreeRe = /<script[^>]*src=["'][^"']*(?:three|THREE)[^"']*["'][^>]*><\/script>/gi;

  let htmlContent = code;

  // コードが完全なHTMLでない場合、ラッピング
  if (!/<html[\s>]/i.test(code)) {
    const hasScript = /<script/i.test(code);
    let body = code;

    // LLMが生成した壊れたThree.js scriptタグを除去
    if (needsThree) {
      body = body.replace(badThreeRe, '');
    }

    // スクリプトタグなし = JSコードそのもの
    if (!hasScript && !/<body/i.test(body)) {
      body = '<script>' + body + '<\/script>';
    }

    htmlContent = '<!DOCTYPE html><html><head><meta charset="utf-8">'
      + '<style>body{margin:0;overflow:hidden;background:#000;}canvas{display:block;}</style>'
      + (needsThree ? threeScriptTags : '')
      + '</head><body>' + body + '</body></html>';
  } else {
    // 完全なHTML — LLMのThree.jsタグを正規CDNに強制置換
    if (needsThree) {
      // 既存のThree.js読み込みタグを全て除去
      htmlContent = htmlContent.replace(badThreeRe, '');
      // head内に正規CDNを注入
      if (/<head[^>]*>/i.test(htmlContent)) {
        htmlContent = htmlContent.replace(/<head[^>]*>/i, '$&' + threeScriptTags);
      } else {
        htmlContent = htmlContent.replace(/<html[^>]*>/i, '$&<head>' + threeScriptTags + '</head>');
      }
    }
  }

  // import文をグローバルTHREEに書き換え（ESM → UMD対応）
  htmlContent = htmlContent.replace(/import\s+\*\s+as\s+THREE\s+from\s+['"][^'"]*['"]\s*;?/g, '// THREE is loaded globally');
  htmlContent = htmlContent.replace(/import\s+THREE\s+from\s+['"][^'"]*['"]\s*;?/g, '// THREE is loaded globally');
  // three/examples, three/addons 等のimportはコメント化（シムで定義済み）— from 'three' より先に処理
  htmlContent = htmlContent.replace(/import\s+\{[^}]*\}\s+from\s+['"][^'"]*(?:examples|addons|jsm?|controls)[^'"]*['"]\s*;?/g,
    '// import removed (loaded globally)');
  htmlContent = htmlContent.replace(/import\s+\{\s*([^}]+)\}\s+from\s+['"]three['"]\s*;?/g, 'const { $1 } = THREE;');
  // type="module" を除去（UMDで読み込むため）
  htmlContent = htmlContent.replace(/<script\s+type=["']module["']/gi, '<script');
  const errorHelper = '<script>'
    + 'window.onerror=function(m,s,l,c,e){'
    + 'var d=document.createElement("div");'
    + 'd.style.cssText="position:fixed;bottom:0;left:0;right:0;background:rgba(220,40,40,0.9);color:#fff;padding:8px 12px;font:12px monospace;z-index:9999;white-space:pre-wrap;";'
    + 'd.textContent="Error: "+m+"\\n  at line "+l;'
    + 'document.body.appendChild(d);'
    + 'setTimeout(function(){d.remove()},8000);'
    + '};'
    + '<\/script>';
  htmlContent = htmlContent.replace(/<\/body>/i, errorHelper + '</body>');

  outputEl.innerHTML =
    '<div class="code-preview-container">'
    + '<div class="code-preview-header">'
    + '<span>プレビュー</span>'
    + '<div style="display:flex;gap:6px;align-items:center;">'
    + '<div class="code-preview-resize">'
    + '<button onclick="resizePreview(\'' + codeId + '\',300)" title="小">S</button>'
    + '<button class="active" onclick="resizePreview(\'' + codeId + '\',400)" title="中">M</button>'
    + '<button onclick="resizePreview(\'' + codeId + '\',600)" title="大">L</button>'
    + '<button onclick="resizePreview(\'' + codeId + '\',800)" title="特大">XL</button>'
    + '</div>'
    + '<button class="code-preview-close" onclick="closePreview(\'' + codeId + '\')">✕</button>'
    + '</div>'
    + '</div>'
    + '<iframe class="code-preview-iframe" id="preview-' + codeId + '" sandbox="allow-scripts"></iframe>'
    + '</div>';

  const iframe = document.getElementById('preview-' + codeId);
  iframe.srcdoc = htmlContent;
};

window.closePreview = function(codeId) {
  const outputEl = document.getElementById('output-' + codeId);
  if (outputEl) outputEl.innerHTML = '';
  // ボタンを元に戻す
  const wrapper = document.getElementById(codeId)?.closest('.code-block-wrapper');
  if (wrapper) {
    const btn = wrapper.querySelector('.preview-btn');
    if (btn) btn.textContent = '▶ プレビュー';
  }
};

window.resizePreview = function(codeId, height) {
  const iframe = document.getElementById('preview-' + codeId);
  if (iframe) iframe.style.height = height + 'px';
  // ボタンのactive状態更新
  const container = iframe?.closest('.code-preview-container');
  if (container) {
    container.querySelectorAll('.code-preview-resize button').forEach(b => {
      b.classList.toggle('active', parseInt(b.getAttribute('onclick').match(/\d+/)?.[0]) === height);
    });
  }
};

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── LaTeX レンダリング ───
function renderLatex(text) {
  if (!text || typeof katex === 'undefined') return text;

  const placeholders = [];
  let idx = 0;

  function placeholder(html) {
    const key = '\x00MATH' + (idx++) + '\x00';
    placeholders.push({ key, html });
    return key;
  }

  function renderKatex(expr, displayMode) {
    try {
      return katex.renderToString(expr, { displayMode, throwOnError: false, trust: true });
    } catch {
      return '<code>' + escapeHtml(expr) + '</code>';
    }
  }

  // コードブロック保護: ```...``` をプレースホルダーに退避
  const codeBlocks = [];
  let cbIdx = 0;
  text = text.replace(/```[\s\S]*?```/g, (m) => {
    const k = '\x00CODE' + (cbIdx++) + '\x00';
    codeBlocks.push({ key: k, text: m });
    return k;
  });

  // インラインコード保護: `...` をプレースホルダーに退避
  const inlineCodes = [];
  let icIdx = 0;
  text = text.replace(/`[^`\n]+`/g, (m) => {
    const k = '\x00IC' + (icIdx++) + '\x00';
    inlineCodes.push({ key: k, text: m });
    return k;
  });

  // ブロック数式: $$ ... $$ or \[ ... \]
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => placeholder(renderKatex(expr.trim(), true)));
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, expr) => placeholder(renderKatex(expr.trim(), true)));

  // インライン数式: $ ... $ or \( ... \)（ただし $5 や $10 のような通貨表記は除外）
  text = text.replace(/(?<!\$)\$(?!\$)(?!\d+\s)(.+?)(?<!\$)\$(?!\$)/g, (_, expr) => placeholder(renderKatex(expr.trim(), false)));
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_, expr) => placeholder(renderKatex(expr.trim(), false)));

  // コードブロック・インラインコードを復元
  inlineCodes.forEach(({ key, text: t }) => { text = text.replace(key, t); });
  codeBlocks.forEach(({ key, text: t }) => { text = text.replace(key, t); });

  // 日本語/中国語/韓国語に隣接する **...** の周囲にゼロ幅空白を挿入してMarkdownの太字を有効化
  // CommonMark仕様の "Intraword Emphasis" 制約への対策
  // 例: 気温は**24℃**程度  →  気温は​**24℃**​程度
  // 例: **「Matrix Core」**と呼ばれる  →  **​「Matrix Core」​**​と呼ばれる
  // 対象: 漢字/ひらがな/カタカナ/ハングル + CJK記号・句読点（「」『』、。…など）+ 全角英数記号
  // \uFF00-\uFFEF: 半角・全角形（全角英数、句読点）
  // \u3000-\u303F: CJK記号・句読点（、。「」『』〈〉…）
  // \u30FB: ・ (中黒)
  const CJK_CHAR = '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\u3000-\\u303F\\u30FB\\uFF00-\\uFFEF]';
  text = text.replace(new RegExp(`(${CJK_CHAR})\\*\\*(?=\\S)`, 'gu'), '$1\u200B**');
  text = text.replace(new RegExp(`(?<=\\S)\\*\\*(${CJK_CHAR})`, 'gu'), '**\u200B$1');

  // Markdown変換
  let html;
  try { html = marked.parse(text); } catch { html = text; }

  // 数式プレースホルダーを復元
  placeholders.forEach(({ key, html: h }) => { html = html.replace(key, h); });

  return html;
}

// ─── MarkdownContent コンポーネント ───
// MarkdownContent: メッセージのcontentをMarkdownレンダリング
// React.memo でラップして、contentが変わらなければ再レンダリングしない（出力DOMの保持のため重要）
const MarkdownContent = React.memo(function MarkdownContent({ content }) {
  const ref = useRef(null);

  // [[gen_image:URL|encodedPrompt]] / [[gen_audio:URL|encodedText]] マーカーを
  // パースしてセグメントに分割。
  // 高速パス: マーカーが含まれていなければ分割せず単純レンダリング
  const segments = React.useMemo(() => {
    if (!content) return [];
    if (!content.includes('[[gen_image:') && !content.includes('[[gen_audio:')) {
      return [{ type: 'text', value: content }];
    }
    const result = [];
    const regex = /\[\[gen_(image|audio):([^|\]]+)(?:\|([^\]]*))?\]\]/g;
    let lastIndex = 0;
    let match;
    while ((match = regex.exec(content)) !== null) {
      if (match.index > lastIndex) {
        result.push({ type: 'text', value: content.slice(lastIndex, match.index) });
      }
      let metaText = '';
      try { metaText = decodeURIComponent(match[3] || ''); } catch { metaText = match[3] || ''; }
      if (match[1] === 'audio') {
        result.push({ type: 'gen_audio', url: match[2], text: metaText });
      } else {
        result.push({ type: 'gen_image', url: match[2], prompt: metaText });
      }
      lastIndex = regex.lastIndex;
    }
    if (lastIndex < content.length) {
      result.push({ type: 'text', value: content.slice(lastIndex) });
    }
    return result;
  }, [content]);

  const hasMarkers = segments.some(s => s.type === 'gen_image' || s.type === 'gen_audio');

  // マーカー無し: dangerouslySetInnerHTML でシンプルにレンダリング
  // React.memo で contentが変わらない限りこの関数自体が呼ばれないので、
  // 既に書き込まれた output-* の中身は再レンダリングで消えない
  if (!hasMarkers) {
    const html = renderLatex(content || '');
    return React.createElement('div', {
      ref,
      dangerouslySetInnerHTML: { __html: html },
    });
  }

  // マーカーがある場合: セグメント毎に描画
  return (
    <div ref={ref}>
      {segments.map((seg, i) => {
        if (seg.type === 'text') {
          if (!seg.value.trim()) return null;
          const html = renderLatex(seg.value);
          return <div key={i} dangerouslySetInnerHTML={{ __html: html }} />;
        }
        if (seg.type === 'gen_image') {
          return <GeneratedImage key={i} url={seg.url} prompt={seg.prompt} />;
        }
        if (seg.type === 'gen_audio') {
          return <GeneratedAudio key={i} url={seg.url} text={seg.text} />;
        }
        return null;
      })}
    </div>
  );
});

// ─── 生成画像コンポーネント ───
// チャット欄に小さなサムネイルで表示し、クリックでフルサイズプレビュー、
// ダウンロードボタンとプロンプトコピーボタンを提供する
function GeneratedImage({ url, prompt }) {
  const [showLightbox, setShowLightbox] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  function downloadImage() {
    // Blob経由でダウンロード（同一オリジンなのでCORSなし）
    const a = document.createElement('a');
    a.href = url;
    // ファイル名は URL のbasename or デフォルト
    const filename = url.split('/').pop() || `generated_${Date.now()}.png`;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  return (
    <>
      <div className="gen-image-card">
        <img
          src={url}
          alt={prompt || '生成画像'}
          className="gen-image-thumb"
          onClick={() => setShowLightbox(true)}
          loading="lazy"
        />
        <div className="gen-image-actions">
          {prompt && (
            <div className="gen-image-prompt" title={prompt}>
              <span className="gen-image-prompt-label">📝</span>
              <span className="gen-image-prompt-text">{prompt}</span>
            </div>
          )}
          <div className="gen-image-buttons">
            <button className="gen-image-btn" onClick={() => setShowLightbox(true)} title="拡大表示">
              🔍 拡大
            </button>
            <button className="gen-image-btn" onClick={downloadImage} title="画像をダウンロード">
              💾 保存
            </button>
            {prompt && (
              <button className="gen-image-btn" onClick={copyPrompt} title="プロンプトをコピー">
                {copied ? '✓ コピー済' : '📋 プロンプト'}
              </button>
            )}
          </div>
        </div>
      </div>
      {showLightbox && (
        <div className="gen-image-lightbox" onClick={() => setShowLightbox(false)}>
          <img src={url} alt={prompt || '生成画像'} onClick={e => e.stopPropagation()} />
          <button className="gen-image-lightbox-close" onClick={() => setShowLightbox(false)}>✕</button>
          <button className="gen-image-lightbox-download" onClick={(e) => { e.stopPropagation(); downloadImage(); }}>
            💾 ダウンロード
          </button>
        </div>
      )}
    </>
  );
}

// ─── 生成音声コンポーネント ───
// チャット欄に <audio controls> プレーヤーを表示し、再生とダウンロードを提供する。
//
// 重要: <audio src="/uploads/..."> に直接URLを渡すと、応答ストリーミング中の
// 再レンダリングでネットワーク読み込みが繰り返し中断され、ロードが完了せず
// 再生ボタンが押せない(HAVE_NOTHING, 0:00/0:00)状態になることがある。
// そこで一度 fetch でファイル全体を取得して Blob URL 化し、それを src に使う。
// Blobはメモリ上の完結リソースなので、再レンダリングの影響を受けず、長さも
// 即座に確定してシーク・再生が安定する。
function GeneratedAudio({ url, text }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let objUrl = null;
    setBlobUrl(null);
    setErr(null);
    fetch(url, { credentials: 'same-origin' })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then(b => {
        if (cancelled) return;
        objUrl = URL.createObjectURL(b);
        setBlobUrl(objUrl);
      })
      .catch(e => { if (!cancelled) setErr(e.message); });
    return () => {
      cancelled = true;
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
  }, [url]);

  function downloadAudio() {
    const a = document.createElement('a');
    a.href = url;
    const filename = url.split('/').pop() || `speech_${Date.now()}.wav`;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  return (
    <div className="gen-audio-card">
      <div className="gen-audio-header">
        <span className="gen-audio-icon">🔊</span>
        {text && <span className="gen-audio-text" title={text}>{text}</span>}
      </div>
      {blobUrl ? (
        <audio key={blobUrl} className="gen-audio-player" src={blobUrl} controls preload="auto" />
      ) : (
        <div className="gen-audio-loading">{err ? `読み込み失敗: ${err}` : '音声を読み込み中…'}</div>
      )}
      <div className="gen-audio-actions">
        <button className="gen-image-btn" onClick={downloadAudio} title="音声をダウンロード">
          💾 保存
        </button>
      </div>
    </div>
  );
}

// ─── ThinkingBlock: 折りたたみ表示 ───
function ThinkingBlock({ thinking, isStreaming }) {
  const [open, setOpen] = useState(false);
  const contentRef = useRef(null);

  useEffect(() => {
    if (open && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [thinking, open]);

  if (!thinking) return null;

  return (
    <div className="thinking-block">
      <button className="thinking-toggle" onClick={() => setOpen(!open)}>
        <span className={`thinking-toggle-icon ${open ? 'open' : ''}`}>▶</span>
        <span className={`thinking-label-dot ${isStreaming ? '' : 'done'}`} />
        {isStreaming ? '思考中...' : '思考プロセス'}
      </button>
      {open && (
        <div className="thinking-content" ref={contentRef}>{thinking}</div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════
// マルチLLMオーケストレーション
// ════════════════════════════════════════════════

// ノード種別のメタ情報（ラベル・アイコン・説明）
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

// ─── 実行中の進捗パネル（チャット内に表示） ───
function OrchestraPanel({ orch }) {
  const [openNodes, setOpenNodes] = useState({});
  const [showVram, setShowVram] = useState(false);
  if (!orch) return null;

  const modeLabel = orch.mode === 'resident' ? '常駐並列'
    : orch.mode === 'swap' ? '逐次スワップ' : '判定中';
  const gb = (mb) => (mb / 1024).toFixed(1);
  const doneCount = (orch.nodes || []).filter(n => n.status === 'done' || n.status === 'skipped').length;
  const total = (orch.nodes || []).filter(n => n.type !== 'output').length || (orch.nodes || []).length;

  return (
    <div className="orch-panel">
      <div className="orch-panel-header">
        <span className={`orch-panel-dot ${orch.status === 'running' ? '' : 'done'}`} />
        <span className="orch-panel-title">🎼 {orch.workflowName || 'オーケストレーション'}</span>
        <span className={`orch-mode-badge ${orch.mode || ''}`} title={orch.reason || ''}>{modeLabel}</span>
        {orch.ragChunkCount > 0 && (
          <span className="orch-mode-badge" title="参照ドキュメント(RAG)を渡しています">📚 {orch.ragChunkCount}件</span>
        )}
        {orch.imageCount > 0 && (
          <span className="orch-mode-badge" title="画像を渡しています">🖼️ {orch.imageCount}枚</span>
        )}
        <span className="orch-panel-count">{doneCount}/{total}</span>
      </div>
      {orch.reason && (
        <div className={`orch-panel-reason ${orch.shortageVramMB > 0 ? 'short' : ''}`}>
          {orch.shortageVramMB > 0 && <span className="orch-short-badge">VRAM不足</span>}
          {orch.reason}
        </div>
      )}
      {/* VRAMの内訳。「なぜ足りないのか」をモデル単位で示す */}
      {orch.vramBreakdown && orch.vramBreakdown.length > 0 && (
        <div className="orch-vram-box">
          <button className="orch-vram-toggle" onClick={() => setShowVram(v => !v)}>
            <span className={`orch-node-caret ${showVram ? 'open' : ''}`}>▶</span>
            VRAM内訳（必要 {gb(orch.requiredVramMB)}GB ／ 空き {gb(orch.freeVramMB)}GB）
          </button>
          {showVram && (
            <div className="orch-vram-list">
              {orch.vramBreakdown.map(m => (
                <div key={m.name} className={`orch-vram-row ${m.alreadyLoaded ? 'loaded' : ''}`}>
                  <div className="orch-vram-name">
                    {m.name}
                    <span className="orch-vram-ctx">ctx {Math.round(m.ctx / 1024)}k</span>
                    {m.alreadyLoaded && <span className="orch-vram-tag">ロード済み・追加消費なし</span>}
                    {m.source === 'measured' && <span className="orch-vram-tag measured">実測値</span>}
                    {!m.exact && <span className="orch-vram-tag approx">概算</span>}
                  </div>
                  <div className="orch-vram-detail">
                    重み {gb(m.weightsMB)} ＋ KVキャッシュ {gb(m.kvMB)} ＋ 予備 {gb(m.overheadMB)}
                    <strong className="orch-vram-total">= {gb(m.totalMB)}GB</strong>
                  </div>
                  {/* KVの算出根拠。数値がおかしいときに何を読んだか分かるように出す */}
                  <div className="orch-vram-meta">
                    {m.source === 'measured'
                      ? 'KV算出: llama-server が報告した実測値'
                      : m.layers
                        ? `KV算出: ${m.arch || 'unknown'} / ${m.layers}層 × KV${m.kvHeads}ヘッド × ${m.headDim}次元`
                          + (m.swa > 0 ? ` / 窓${m.swa}` : '')
                        : 'KV算出: GGUFを読めず概算（初回ロード後に実測値へ置き換わります）'}
                  </div>
                </div>
              ))}
              <div className="orch-vram-sum">
                ワークフロー全体 {gb(orch.footprintVramMB ?? orch.requiredVramMB)}GB
                {orch.loadedVramMB > 0 && `（うち ${gb(orch.loadedVramMB)}GB はロード済み）`}
                <br />
                追加で必要 {gb(orch.requiredVramMB)}GB ＋ 安全余裕 {gb(orch.marginVramMB)}GB
                {' '}{orch.shortageVramMB > 0 ? '＞' : '≦'} 空きVRAM {gb(orch.freeVramMB)}GB
                {orch.shortageVramMB > 0 && (
                  <span className="orch-vram-short">（{gb(orch.shortageVramMB)}GB 不足）</span>
                )}
              </div>
              {orch.shortageVramMB > 0 && (
                <div className="orch-vram-tips">
                  VRAMを減らすには: モデルの <code>ctx</code> を小さくする（KVキャッシュが比例して減ります）／
                  ワークフローで使うモデルを減らす／小さいモデルに置き換える
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {orch.degradedReason && (
        <div className="orch-panel-degraded">⚠️ {orch.degradedReason}</div>
      )}
      <div className="orch-node-list">
        {(orch.nodes || []).filter(n => n.type !== 'output').map(n => {
          const meta = orchNodeMeta(n.type);
          const isOpen = !!openNodes[n.id];
          const statusIcon = n.status === 'done' ? '✅'
            : n.status === 'error' ? '❌'
            : n.status === 'skipped' ? '⏭️'
            : n.status === 'running' ? '⏳' : '⚪';
          return (
            <div key={n.id} className={`orch-node ${n.status || 'pending'}`}>
              <div className="orch-node-head" onClick={() => setOpenNodes(p => ({ ...p, [n.id]: !p[n.id] }))}>
                <span className="orch-node-status">{statusIcon}</span>
                <span className="orch-node-icon">{meta.icon}</span>
                <span className="orch-node-label">{n.label}</span>
                {n.model && <span className="orch-node-model">{n.model}</span>}
                {n.speaker && n.status === 'running' && (
                  <span className="orch-node-speaker">{n.speaker}（{n.round}巡目）</span>
                )}
                {n.ms > 0 && <span className="orch-node-ms">{(n.ms / 1000).toFixed(1)}s</span>}
                {(n.text || n.error) && (
                  <span className={`orch-node-caret ${isOpen ? 'open' : ''}`}>▶</span>
                )}
              </div>
              {n.status === 'skipped' && n.skipReason && (
                <div className="orch-node-skip">スキップ: {n.skipReason}</div>
              )}
              {n.error && <div className="orch-node-error">{n.error}</div>}
              {isOpen && n.text && (
                <div className="orch-node-body">{n.text}</div>
              )}
            </div>
          );
        })}
      </div>
      {orch.error && <div className="orch-panel-error">⚠️ {orch.error}</div>}
    </div>
  );
}

function App() {
  // ─── 認証 ───
  const [authenticated, setAuthenticated] = useState(false);
  const [hasPassword, setHasPassword] = useState(null); // null=確認中, true/false

  // ─── アプリ設定 (config.json) ───
  const [appConfig, setAppConfig] = useState({
    appName: 'OpenGeekLLMChat',
    logoMain: 'OpenGeekLLM',
    logoSub: 'Chat',
    welcomeMessage: 'ドキュメントをアップロードしてRAGベースの質問応答を行うか、自由にチャットを開始できます。',
    welcomeHints: ['ドキュメントを要約して', 'この資料の要点は？', '〇〇について教えて'],
    accentColor: '#34d399',
    defaultModel: '',
    webSearch: true,
    ragTopK: 10,
    ragMode: 'agentic',
    agentContext: {
      smallPredict: 512,
      largePredict: 8192,
      judgeHistoryCount: 3,
    },
    tokenAvgWindow: 2000,
    topK: 40,
    topP: 0.9,
    temperature: 0.7,
    // 繰り返し/思考ループ対策 (サーバーの /config 値で上書きされる)
    repeatPenalty: 1.1,
    repeatLastN: 320,
    presencePenalty: 0,
    frequencyPenalty: 0,
    dryMultiplier: 0.8,
    dryBase: 1.75,
    dryAllowedLength: 2,
    dryPenaltyLastN: -1,
    chatMaxTokens: 8192,
    transcribe: { enabled: false },
  });

  // チャット用モデル選択（chatModelsから選ぶ）
  const [chatModel, setChatModel] = useState('');
  const [availableModels, setAvailableModels] = useState([]);
  const [availableModelsInfo, setAvailableModelsInfo] = useState([]); // [{name, ctx, ngl, loaded}]
  const [connected, setConnected] = useState(false);
  const [modelReady, setModelReady] = useState(false);  // チャットモデルが利用可能か（current && !starting）
  const [modelStarting, setModelStarting] = useState(false);  // モデル起動中
  const [autoUnloadedName, setAutoUnloadedName] = useState(null);  // アイドルアンロード中のモデル名
  const [firstLoadPending, setFirstLoadPending] = useState(false);  // 起動後の初回ロード待ち

  const [documents, setDocuments] = useState([]); // { name, text, chunks, embeddings }
  const ragEnabled = true; // RAGはドキュメントがあれば常に有効
  // 現在ロード中のチャットモデルのコンテキストサイズ（config.json由来、読み取り専用）
  const [currentModelCtx, setCurrentModelCtx] = useState(0);
  // numCtxはトークン使用率(◯/32K)の表示用。currentModelCtxと連動する
  const numCtx = currentModelCtx || 32768;

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [loadingMessage, setLoadingMessage] = useState('');  // モデルロード等の進行表示（オレンジ）
  const [dragActive, setDragActive] = useState(false);  // ドキュメントリストD&D
  const [chatDragActive, setChatDragActive] = useState(false);  // チャット欄D&D
  const [serverDragActive, setServerDragActive] = useState(false);  // サーバーファイルD&D
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // チャット履歴パネルの高さ（ドラッグでリサイズ可能、localStorageに永続化）
  const [chatHistoryHeight, setChatHistoryHeight] = useState(() => {
    if (typeof window === 'undefined') return 220;
    const saved = parseInt(window.localStorage.getItem('chatHistoryHeight'), 10);
    return Number.isFinite(saved) && saved > 0 ? saved : 220;
  });
  const [embeddingJobs, setEmbeddingJobs] = useState([]); // { name, current, total }
  const [gpuData, setGpuData] = useState([]);
  const [gpuPanelOpen, setGpuPanelOpen] = useState(false);
  const [rightPanelTab, setRightPanelTab] = useState('gpu'); // 'gpu' | 'files' | 'api'
  // 外部APIサーバー管理（Chat Completionsのみ対応）
  const [externalServers, setExternalServers] = useState([]);
  const [apiFormModel, setApiFormModel] = useState('');
  const [apiFormHost, setApiFormHost] = useState('0.0.0.0');
  const [apiFormPort, setApiFormPort] = useState(11434);
  const [apiFormKey, setApiFormKey] = useState('');
  // ツール対応モード (agent_proxy 経由でツール群を使えるようにする)
  const [apiFormAgentMode, setApiFormAgentMode] = useState(false);
  const [apiFormTools, setApiFormTools] = useState(['ml', 'web_search', 'file']);
  // HTTPSデフォルト: 現在ブラウザでHTTPSアクセス中ならtrue（同じ証明書を使う想定）
  const [apiFormHttps, setApiFormHttps] = useState(typeof window !== 'undefined' && window.location.protocol === 'https:');
  const [apiHttpsAvailable, setApiHttpsAvailable] = useState(false);
  // embedding (RAG用) が利用可能か
  const [apiEmbeddingAvailable, setApiEmbeddingAvailable] = useState(true);
  const [apiEmbeddingReason, setApiEmbeddingReason] = useState('');
  // 永続RAG (サーバー側 ml/rag/) の状態
  // embedding 利用可能 + 登録ドキュメント数 > 0 のとき、通常チャットでも自動的に
  // search_persistent_documents ツールが追加される
  const [persistentRagAvailable, setPersistentRagAvailable] = useState(false);
  const [persistentRagDocCount, setPersistentRagDocCount] = useState(0);
  const [persistentRagDocNames, setPersistentRagDocNames] = useState([]);
  // Google Drive が外部APIのツール対応モードで使えるか
  const [apiGdriveAvailable, setApiGdriveAvailable] = useState(false);
  const [apiGdriveReason, setApiGdriveReason] = useState('');
  const [apiBusy, setApiBusy] = useState(false);
  const [tokenSpeed, setTokenSpeed] = useState(null); // { tokPerSec, totalTokens }
  const tokenHistoryRef = useRef([]); // [{ tokens, durationNs }]

  // 永続RAGの登録ドキュメント名を「a, b, c など N件」形式に要約する共通ヘルパー
  // ツール定義の description と、ツール判断プロンプトの toolList で共用
  function summarizePersistentRagDocs(maxShow = 10) {
    const shown = persistentRagDocNames.slice(0, maxShow).join(', ');
    return persistentRagDocNames.length > maxShow
      ? `${shown} など${persistentRagDocCount}件`
      : shown;
  }

  // 永続RAGの出典に使う「短い呼び名」を作る。
  // 長い日本語ファイル名 (テラメカニックス-走行力学-.md) をモデルに何度も
  // 書き写させると毎回違う形に崩れる (テラメカニクックス / テラメカノックス 等) ため、
  // 拡張子を落とし、最初の区切り記号までを呼び名として使う。
  //   テラメカニックス-走行力学-.md            → テラメカニックス
  //   入門シリーズ32 斜面の安定・変形…-.md      → 入門シリーズ32
  //   S.P.Cウォール工法.md                     → S.P.Cウォール工法
  function shortSourceLabel(filename) {
    let s = String(filename || '').replace(/\.[^.]+$/, '');
    const cut = s.split(/[-–—―~〜_\s　]/).filter(Boolean)[0];
    if (cut) s = cut;
    if (s.length > 14) s = s.slice(0, 14);
    return s.trim() || String(filename || '資料');
  }

  // URLパスからチャットIDを取得（例: /chat/abc123 → "abc123"）
  function getChatIdFromUrl() {
    const m = window.location.pathname.match(/^\/chat\/([a-z0-9]+)$/i);
    return m ? m[1] : null;
  }
  const [chatId, setChatId] = useState(() => {
    const urlId = getChatIdFromUrl();
    return urlId || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  });
  const [chatList, setChatList] = useState([]);
  const [fileList, setFileList] = useState([]);
  const [chatTitle, setChatTitle] = useState('');
  const [chatRole, setChatRole] = useState('');  // ユーザーがチャット開始時に設定したLLMの役割

  // ─── マルチLLMオーケストレーション ───
  const [orchInfo, setOrchInfo] = useState({ enabled: false, workflows: [], models: [] });
  const [orchWorkflowId, setOrchWorkflowId] = useState('');   // '' = OFF（通常チャット）
  // ─── VRAM強制解放（GPUモニター） ───
  const [releaseTargets, setReleaseTargets] = useState(null);  // 解放できる対象
  const [releasing, setReleasing] = useState(false);
  const [releaseResult, setReleaseResult] = useState(null);
  const [showRoleEditor, setShowRoleEditor] = useState(false);  // 役割エディタの表示状態
  const [chatLoading, setChatLoading] = useState(false);
  const saveTimerRef = useRef(null);
  // チャット内でユーザー操作（メッセージ送信・ドキュメント追加等）があったかを追跡
  // 単に履歴を「開いた」だけでは true にならない。これにより updatedAt が無駄に更新されて
  // 順序が変わってしまうのを防ぐ
  const messagesDirtyRef = useRef(false);

  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const serverFileInputRef = useRef(null);
  const [isRecording, setIsRecording] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);  // チャット欄でのON/OFFトグル（初期値はconfigを後で反映）
  // ─── Google Drive ───
  // gdriveStatus は /gdrive/status の結果 (enabled / connected / allowWrite 等)。
  // gdriveEnabled はチャット欄のトグル。接続済みでもユーザーがOFFにすればツールを出さない。
  const [gdriveStatus, setGdriveStatus] = useState(null);
  const [gdriveEnabled, setGdriveEnabled] = useState(true);
  const [gdriveFiles, setGdriveFiles] = useState([]);
  const [gdriveFolderId, setGdriveFolderId] = useState('');
  // パンくず: [{ id, name }]。先頭は常にルート
  const [gdriveBreadcrumb, setGdriveBreadcrumb] = useState([{ id: '', name: 'マイドライブ' }]);
  const [gdriveQuery, setGdriveQuery] = useState('');
  const [gdriveLoading, setGdriveLoading] = useState(false);
  const [gdriveError, setGdriveError] = useState('');
  const [gdriveBusy, setGdriveBusy] = useState(false);
  // 直近の GDrive 検索/一覧の結果。LLM が渡してくる「番号・ファイル名・崩れたID」を
  // 実IDに解決するために使う (resolveGdriveFileRef)。チャットをまたいで保持する。
  const gdriveRecentRef = useRef({ list: [], seen: new Map() });
  const [speakingIndex, setSpeakingIndex] = useState(-1);
  const abortRef = useRef(null);
  const sendMessageRef = useRef(null);
  const setChatImagesRef = useRef(null);
  const [chatImages, setChatImages] = useState([]); // [{ name, base64, preview }]
  const [lightboxSrc, setLightboxSrc] = useState(null);

  // ─── モデル一覧取得 ───
  const fetchModels = useCallback(async () => {
    try {
      // llama.cppバックエンド: 独自エンドポイント /models から取得
      const res = await fetch('/models');
      if (!res.ok) throw new Error();
      const data = await res.json();
      const names = (data.models || []).map(m => m.name);
      setAvailableModels(names);
      setAvailableModelsInfo(data.models || []);
      setConnected(true);
      // モデル起動状態を更新
      // modelStarting: 実際にllama-server起動中（chatProcStarting=true）
      // modelReady: ロード完了（current あり、起動中でない、アンロード状態でない）
      setModelStarting(!!data.starting);
      setModelReady(!!data.current && !data.starting && !data.autoUnloaded);
      setAutoUnloadedName(data.autoUnloaded || null);
      setFirstLoadPending(!!data.firstLoadPending);
      // 現在ロード中モデルのctxを反映（読み取り専用）
      const loaded = (data.models || []).find(m => m.loaded);
      if (loaded && loaded.ctx) {
        setCurrentModelCtx(loaded.ctx);
      } else if (data.current) {
        // currentがあるがloadedフラグが立っていないケース
        const m = (data.models || []).find(mm => mm.name === data.current);
        if (m && m.ctx) setCurrentModelCtx(m.ctx);
      }
      // 現在ロード中モデルを自動選択（指定がなければ）
      // 優先: 1) ロード中(current), 2) 自動アンロード状態(autoUnloaded=前回モデル), 3) 一覧先頭
      if (!chatModel) {
        if (data.current) setChatModel(data.current);
        else if (data.autoUnloaded) setChatModel(data.autoUnloaded);
        else if (names.length > 0) setChatModel(names[0]);
      }
    } catch {
      setConnected(false);
      setAvailableModels([]);
      setModelReady(false);
      setModelStarting(false);
    }
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    fetchModels();
    // 高頻度ポーリング: 接続不良 or 実際のモデル起動中なら3秒ごと
    // 低頻度ポーリング: 通常時も状態変化検出のため15秒ごと
    const intervalId = setInterval(() => {
      if (!connected || modelStarting) fetchModels();
    }, 3000);
    const slowIntervalId = setInterval(() => {
      if (connected && !modelStarting) fetchModels();
    }, 15000);
    return () => {
      clearInterval(intervalId);
      clearInterval(slowIntervalId);
    };
  }, [authenticated, fetchModels, connected, modelStarting]);

  // ─── オーケストレーション情報の取得 ───
  const fetchOrchInfo = useCallback(async () => {
    try {
      const res = await fetch('/orchestra/info');
      if (!res.ok) return;
      const d = await res.json();
      setOrchInfo(d);
      setOrchWorkflowId(prev => {
        // 機能が無効化された / editconfig でワークフローが消された場合は選択を解除し、
        // 通常のモデル選択に戻す（存在しないIDのまま送信できてしまうのを防ぐ）
        if (!d.enabled) return '';
        if (prev) return (d.workflows || []).some(w => w.id === prev) ? prev : '';
        // 既定ワークフローが設定されていれば初期選択する
        if (d.defaultWorkflow && (d.workflows || []).some(w => w.id === d.defaultWorkflow)) {
          return d.defaultWorkflow;
        }
        return prev;
      });
    } catch { /* 未対応サーバーでは無視 */ }
  }, []);

  // 起動時に加え、editconfig 側でワークフローを編集した場合に追従するため定期取得する
  useEffect(() => {
    if (!authenticated) return;
    fetchOrchInfo();
    const id = setInterval(fetchOrchInfo, 30000);
    return () => clearInterval(id);
  }, [authenticated, fetchOrchInfo]);

  // ─── VRAM強制解放 ───
  // GPUパネルを開いている間だけ、解放できる対象を定期取得する
  const fetchReleaseTargets = useCallback(async () => {
    try {
      const r = await fetch('/gpu/release/targets');
      if (r.ok) setReleaseTargets(await r.json());
    } catch { /* 取得できなくてもボタンは押せる */ }
  }, []);

  useEffect(() => {
    if (!authenticated || !gpuPanelOpen || rightPanelTab !== 'gpu') return;
    fetchReleaseTargets();
    const id = setInterval(fetchReleaseTargets, 5000);
    return () => clearInterval(id);
  }, [authenticated, gpuPanelOpen, rightPanelTab, fetchReleaseTargets]);

  async function releaseVram() {
    const t = releaseTargets || {};
    const items = [];
    if (t.chat) items.push(`チャットモデル「${t.chat}」`);
    if (t.embedding) items.push('Embedding');
    if ((t.pool || []).length) items.push(`マルチLLMワーカー ${t.pool.length}台（${t.pool.join(', ')}）`);
    if (t.image) items.push(`画像生成${typeof t.image === 'string' ? `「${t.image}」` : ''}`);
    if (t.tts) items.push('音声合成(TTS)');
    if (items.length === 0) {
      setError('解放できるモデルがありません（すでに全てアンロード済みです）');
      return;
    }
    const extNote = t.external > 0
      ? `\n\n※ 外部APIサーバー ${t.external}台は停止しません（意図して公開しているため）`
      : '';
    if (!confirm(`以下をアンロードしてVRAMを解放します。\n\n・${items.join('\n・')}\n\n`
      + `- 進行中の生成があれば中断されます\n`
      + `- チャットモデルは次回の送信時に自動で再ロードされます${extNote}\n\n続行しますか？`)) return;

    setReleasing(true); setError(''); setReleaseResult(null);
    try {
      const r = await fetch('/gpu/release', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),   // 既定: 外部APIサーバー以外を全て解放
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setReleaseResult(d);
      await fetchReleaseTargets();
      fetchModels();   // モデルのロード状態表示を更新する
    } catch (e) {
      setError(`VRAM解放に失敗しました: ${e.message}`);
    } finally {
      setReleasing(false);
    }
  }

  // ─── GPU 監視 (SSE) ───
  useEffect(() => {
    if (!authenticated) return;
    const evtSource = new EventSource('/sse/gpu');
    evtSource.onmessage = (e) => {
      try { setGpuData(JSON.parse(e.data)); } catch {}
    };
    evtSource.onerror = () => { setGpuData([]); };
    return () => evtSource.close();
  }, [authenticated]);

  // ─── Embedding取得（llama-server OpenAI互換 /v1/embeddings） ───
  async function getEmbedding(text) {
    const res = await fetch('/embed/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'embedding', input: text }),
    });
    if (!res.ok) throw new Error('Embedding取得に失敗しました（embeddingサーバー未起動の可能性）');
    const data = await res.json();
    // OpenAI互換: { data: [{ embedding: [...] }] }
    return data.data?.[0]?.embedding;
  }

  // ─── Embeddingサーバー起動を待つ（ロード中・未起動時に対応） ───
  async function waitForEmbedding() {
    // /models APIで状態確認
    let embedReady = false;
    try {
      const mres = await fetch('/models');
      if (mres.ok) {
        const mdata = await mres.json();
        embedReady = !!mdata.embeddingReady;
      }
    } catch {}
    if (embedReady) return true;

    // 未起動: ダミーEmbeddingリクエストで起動トリガー
    setLoadingMessage('Embeddingモデルをロード中');
    try {
      // 起動を待機しつつトリガー（プロキシ側で自動ロード処理）
      await fetch('/embed/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'embedding', input: 'ping' }),
      });
    } catch {}

    // 起動完了をポーリング(最大1分、2秒間隔)
    const startWait = Date.now();
    while (Date.now() - startWait < 60000) {
      try {
        const pres = await fetch('/models');
        if (pres.ok) {
          const pdata = await pres.json();
          if (pdata.embeddingReady) {
            setLoadingMessage('');
            return true;
          }
        }
      } catch {}
      await new Promise(r => setTimeout(r, 2000));
    }
    setLoadingMessage('');
    return false;
  }

  // ─── ドキュメント追加 ───
  async function addDocument(name, text) {
    const chunks = chunkText(text);
    const jobId = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    setError('');

    // Embeddingサーバーが起動していない場合は待機
    const embReady = await waitForEmbedding();
    if (!embReady) {
      setError(`Embeddingモデルの起動に失敗しました。「${name}」をアップロードできません。`);
      return;
    }

    setEmbeddingJobs(prev => [...prev, { id: jobId, name, current: 0, total: chunks.length }]);
    try {
      const embeddings = [];
      for (let i = 0; i < chunks.length; i++) {
        const emb = await getEmbedding(chunks[i]);
        embeddings.push(emb);
        setEmbeddingJobs(prev => prev.map(j => j.id === jobId ? { ...j, current: i + 1 } : j));
      }
      setDocuments(prev => [...prev, { name, text, chunks, embeddings }]);
      messagesDirtyRef.current = true;
    } catch (e) {
      setError(`ドキュメント「${name}」のEmbedding生成に失敗: ${e.message}`);
    } finally {
      setEmbeddingJobs(prev => prev.filter(j => j.id !== jobId));
    }
  }

  // ─── RAG検索 ───
  async function retrieveContext(query) {
    if (!ragEnabled || documents.length === 0) return [];
    // Embedding未起動なら起動を待つ
    const embReady = await waitForEmbedding();
    if (!embReady) return [];
    try {
      const qEmb = await getEmbedding(query);
      const scored = [];
      for (const doc of documents) {
        for (let i = 0; i < doc.chunks.length; i++) {
          scored.push({
            chunk: doc.chunks[i],
            docName: doc.name,
            score: cosineSim(qEmb, doc.embeddings[i]),
          });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, appConfig.ragTopK);
    } catch {
      return [];
    }
  }

  // ─── 生成停止 ───
  function stopGeneration() {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    // llama-server: HTTPストリーム切断でリクエストはキャンセルされる。
    // GPU使用率は生成中だったスロット分は次のサンプリング後に解放される。
    setIsLoading(false);
  }

  // ─── チャット送信 ───
  // 503 等のリトライ付き fetch ヘルパー
  // チャットモデルがロード中の場合、サーバーは503を返す前に待機するが
  // それでも初回ロード遅延等で503が来ることがある。最大5回リトライ。
  // 500/502/504 などサーバー側の一時的エラーも対象（一時的なクラッシュやプロキシ問題の自動復帰）
  async function fetchWithRetry(url, options, maxRetries = 5) {
    let lastError = null;
    for (let i = 0; i <= maxRetries; i++) {
      const res = await fetch(url, options);
      if (res.ok) return res;
      // リトライ対象のステータスコード
      const isRetryable = res.status === 503 || res.status === 500 || res.status === 502 || res.status === 504;
      if (!isRetryable) return res;  // 4xx 等は即エラー扱い（呼び出し側で処理）
      if (i === maxRetries) return res;  // 最後の試行
      // 一時的エラー: 少し待ってリトライ
      let info = '';
      try {
        const errData = await res.clone().json();
        info = errData.error || '';
      } catch {}
      console.log(`[fetch ${res.status}] ${info} → 5秒後にリトライ (${i + 1}/${maxRetries})`);
      await new Promise(r => setTimeout(r, 5000));
      // AbortController がトリガーされてたら中断
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    }
    return null;
  }

  // ─── マルチLLMオーケストレーション実行 ───
  // 通常チャット（フロント側でツール判断→llama-serverへ）とは別経路で、
  // サーバーの /orchestra/run にワークフロー実行を委譲し、SSEで進捗を受け取る。
  async function runOrchestration(text) {
    const wf = (orchInfo.workflows || []).find(w => w.id === orchWorkflowId);
    if (!wf) {
      setError('選択中のワークフローが見つかりません。設定を確認してください。');
      return;
    }

    // 進捗はミュータブルに更新し、一定間隔でだけ state に反映する（描画負荷対策）
    const orch = {
      workflowName: wf.name, status: 'running', mode: null, reason: '',
      nodes: [], freeVramMB: null, requiredVramMB: null, error: '',
    };

    const pendingImages = [...chatImages];
    setMessages(prev => [...prev,
      {
        role: 'user', content: text,
        images: pendingImages.length
          ? pendingImages.map(img => ({ name: img.name, base64: img.base64, preview: img.preview }))
          : undefined,
      },
      { role: 'assistant', content: '', orchestra: orch },
    ]);
    messagesDirtyRef.current = true;
    setInput('');
    setChatImages([]);
    if (inputRef.current) inputRef.current.style.height = 'auto';
    setIsLoading(true);
    setError('');
    autoScrollRef.current = true;
    lastProgScrollRef.current = 0;

    const controller = new AbortController();
    abortRef.current = controller;

    // 直近履歴（履歴中の画像までは送らない。テキストのみ）
    const RECENT = appConfig.recentMessageCount || 6;
    const history = messages.slice(-RECENT)
      .filter(m => typeof m.content === 'string' && m.content)
      .map(m => ({ role: m.role, content: m.content }));

    // 参照ドキュメント: チャット添付分はブラウザ側に埋め込みがあるのでここで検索する。
    // サーバー側の永続RAGは /orchestra/run 内で検索され、両者が統合される。
    let docChunks = [];
    if ((wf.nodes || []).some(n => n.useRag) && documents.length > 0) {
      setLoadingMessage('ドキュメントを検索中');
      try {
        const hits = await retrieveContext(text);
        docChunks = hits.map(h => ({ text: h.chunk, source: h.docName, score: h.score }));
      } catch { /* 検索できなくても実行は続ける */ }
      setLoadingMessage('');
    }

    let finalText = '';
    let flushTimer = null;
    const flush = () => {
      flushTimer = null;
      // <think> は ThinkingBlock に分離して表示する（通常チャットと揃える）
      const thinkMatch = finalText.match(/<think>([\s\S]*?)(?:<\/think>|$)/i);
      const thinking = thinkMatch ? thinkMatch[1].trim() : '';
      const content = finalText.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
      setMessages(prev => {
        const next = [...prev];
        const idx = next.length - 1;
        if (idx >= 0 && next[idx].role === 'assistant') {
          next[idx] = {
            ...next[idx],
            content,
            thinking: thinking || undefined,
            orchestra: { ...orch, nodes: orch.nodes.map(n => ({ ...n })) },
          };
        }
        return next;
      });
    };
    const scheduleFlush = () => { if (!flushTimer) flushTimer = setTimeout(flush, 80); };
    const findNode = (id) => orch.nodes.find(n => n.id === id);

    try {
      const res = await fetch('/orchestra/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowId: wf.id, query: text, history, role: chatRole,
          docChunks,
          images: pendingImages.map(img => ({ name: img.name, base64: img.base64 })),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).error || msg; } catch {}
        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const line = chunk.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }

          if (ev.type === 'plan') {
            orch.mode = ev.mode;
            orch.reason = ev.reason;
            orch.freeVramMB = ev.freeVramMB;
            orch.requiredVramMB = ev.requiredVramMB;
            orch.marginVramMB = ev.marginVramMB;
            orch.shortageVramMB = ev.shortageVramMB;
            orch.footprintVramMB = ev.footprintVramMB;
            orch.loadedVramMB = ev.loadedVramMB;
            orch.ragChunkCount = ev.ragChunkCount;
            orch.imageCount = ev.imageCount;
            orch.vramBreakdown = ev.vramBreakdown;
            orch.nodes = (ev.nodes || []).map(n => ({
              id: n.id, label: n.label, model: n.model, type: n.type,
              status: 'pending', text: '', ms: 0,
            }));
          } else if (ev.type === 'degraded') {
            // ワーカーが落ちて逐次スワップに切り替わった
            orch.mode = ev.mode;
            orch.degradedReason = ev.reason;
          } else if (ev.type === 'node_start') {
            const n = findNode(ev.id);
            if (n) { n.status = 'running'; n.text = ''; n.error = null; }
          } else if (ev.type === 'node_delta') {
            const n = findNode(ev.id);
            if (n) n.text += ev.delta;
          } else if (ev.type === 'node_speaker') {
            const n = findNode(ev.id);
            if (n) {
              n.speaker = ev.label;
              n.round = ev.round;
              n.text += `${n.text ? '\n\n' : ''}【${ev.label}・${ev.round}巡目】\n`;
            }
          } else if (ev.type === 'node_route') {
            const n = findNode(ev.id);
            if (n) { n.text = `→ ${ev.label}`; n.route = ev.label; }
          } else if (ev.type === 'node_done') {
            const n = findNode(ev.id);
            if (n) { n.status = 'done'; n.ms = ev.ms; if (ev.text) n.text = ev.text; n.speaker = null; }
          } else if (ev.type === 'node_condition') {
            const n = findNode(ev.id);
            if (n) n.condition = ev.reason;
          } else if (ev.type === 'node_skipped') {
            const n = findNode(ev.id);
            if (n) { n.status = 'skipped'; if (ev.reason) n.skipReason = ev.reason; }
          } else if (ev.type === 'node_error') {
            const n = findNode(ev.id);
            if (n) { n.status = 'error'; n.error = ev.error; }
          } else if (ev.type === 'final') {
            finalText = ev.text || '';
          } else if (ev.type === 'done') {
            orch.status = 'done';
          } else if (ev.type === 'error') {
            orch.status = 'error';
            orch.error = ev.error;
          }
          scheduleFlush();
        }
      }
      if (!finalText && orch.status !== 'error') {
        orch.error = '最終出力が得られませんでした。各ノードの結果を確認してください。';
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        orch.status = 'done';
        orch.error = '生成を停止しました。';
      } else {
        orch.status = 'error';
        orch.error = e.message;
        setError(`オーケストレーション実行エラー: ${e.message}`);
      }
    } finally {
      if (flushTimer) clearTimeout(flushTimer);
      if (orch.status === 'running') orch.status = 'done';
      flush();
      setIsLoading(false);
      abortRef.current = null;
    }
  }

  async function sendMessage() {
    const text = input.trim();
    const hasImages = chatImages.length > 0;
    if ((!text && !hasImages) || isLoading) return;

    // モデル選択でマルチLLMワークフローが選ばれている場合は、
    // 通常のツール判断・RAG経路ではなくサーバー側のオーケストレータに委譲する。
    // ワークフローは自前でワーカーを起動するため chatModel のロード状態は問わない
    if (orchInfo.enabled && orchWorkflowId) {
      const wf = (orchInfo.workflows || []).find(w => w.id === orchWorkflowId);
      // 画像を受け取るノードが1つも無いワークフローに画像を送っても無視されるだけなので知らせる
      if (hasImages && !(wf?.nodes || []).some(n => n.useImages)) {
        setError('このワークフローには画像を受け取るノードがありません。'
          + '設定 → 🎼 マルチLLM でノードの「画像を渡す」を有効にしてください。');
        return;
      }
      return runOrchestration(text);
    }

    if (!chatModel) return;

    // モデル未ロード時は送信できない（ただし firstLoadPending = 初回ロード待ち、または autoUnloadedName = アイドルアンロード状態 は送信時にロードするのでOK）
    if (!modelReady && !firstLoadPending && !autoUnloadedName) {
      setError(modelStarting
        ? 'モデルを起動中です。完了までお待ちください...'
        : 'モデルがロードされていません。しばらくお待ちください...');
      return;
    }

    // Embedding処理中（ドキュメントの埋め込み生成中）は送信を待たせる
    // 並行リクエストでllama-serverが詰まるのを防ぐ
    if (embeddingJobs.length > 0) {
      setError('ドキュメントのEmbedding生成中です。完了までお待ちください...');
      return;
    }

    // 送信直前に /models で最新状態を確認（アイドルアンロード後の競合回避）
    try {
      const mres = await fetch('/models');
      if (mres.ok) {
        const mdata = await mres.json();
        // アンロード状態 or 起動中なら、ロード完了を待ってから送信続行
        if (!mdata.current || mdata.starting || mdata.autoUnloaded) {
          setModelReady(false);

          // 自動アンロードからの復帰 or 初回ロード: ダミーリクエストで再ロード開始
          // (mdata.autoUnloaded がない場合でも、!mdata.current ならまだ一度もロードされていない初回状態)
          if (mdata.autoUnloaded || (!mdata.current && !mdata.starting)) {
            const targetModel = mdata.autoUnloaded || chatModel;
            const isFirst = mdata.firstLoadPending;
            console.log(`[${isFirst ? '初回ロード' : 'アイドル復帰'}] モデル「${targetModel}」のロードを開始`);
            setLoadingMessage(isFirst
              ? `モデル「${targetModel}」をロード中`
              : `モデル「${targetModel}」を再ロード中`);
            // 503を期待しつつヘルスチェック的に叩いて再ロードトリガー
            fetch('/v1/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: chatModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
            }).catch(() => {});
          } else if (mdata.starting) {
            setLoadingMessage(`モデルを起動中`);
          } else {
            setLoadingMessage(`モデルをロード中`);
          }

          // ロード完了をポーリングで待機（最大2分）
          const maxWaitMs = 120000;
          const startWait = Date.now();
          let ready = false;
          while (Date.now() - startWait < maxWaitMs) {
            await new Promise(r => setTimeout(r, 2000));
            try {
              const pres = await fetch('/models');
              if (!pres.ok) continue;
              const pdata = await pres.json();
              if (pdata.current && !pdata.starting && !pdata.autoUnloaded) {
                ready = true;
                setModelReady(true);
                setModelStarting(false);
                setAutoUnloadedName(null);
                setLoadingMessage('');
                break;
              }
            } catch {}
          }
          if (!ready) {
            setError('モデルのロードがタイムアウトしました。しばらくしてから再度送信してください。');
            setLoadingMessage('');
            return;
          }
          // ロード完了 → 続けて送信処理を実行
          console.log('[アイドル復帰] ロード完了、送信処理を続行');
        }
      }
    } catch (e) {
      console.warn('モデル状態確認エラー:', e);
    }

    // 録音中なら停止（送信テキストが確定したので）
    if (isRecording) stopRecording();

    const pendingImages = [...chatImages];
    const userMsg = {
      role: 'user',
      content: text || '(画像を送信)',
      images: hasImages ? pendingImages.map(img => ({ name: img.name, base64: img.base64, preview: img.preview })) : undefined,
    };
    setMessages(prev => [...prev, userMsg]);
    messagesDirtyRef.current = true;  // ユーザー送信があったので並び替え対象
    setInput('');
    setChatImages([]);
    // textareaの高さを初期サイズにリセット（onInputで広がったままにならないように）
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
    setIsLoading(true);
    setError('');
    autoScrollRef.current = true;
    lastProgScrollRef.current = 0;  // 差分チェックをリセット

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const today = new Date();
      const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
      // システムプロンプトを config.systemPrompts から組み立て（テンプレート変数 {date} を展開）
      const sp = appConfig.systemPrompts || {};
      const fillTemplate = (str, vars) => (str || '').replace(/\{(\w+)\}/g, (_, k) => vars[k] != null ? vars[k] : '');
      const systemPrompt = fillTemplate(sp.base || '', { date: dateStr });
      // ─── 履歴の重み付き構築 ───
      // 最新ユーザー質問を「今これに答えて」と強調、古いメッセージを「参考」と明示
      const allMessages = [...messages, userMsg];
      const RECENT_COUNT = appConfig.recentMessageCount || 6;  // 直近N件はそのまま送信
      const MAX_TOTAL = 20;
      const recentSlice = allMessages.slice(-Math.min(MAX_TOTAL, allMessages.length));
      // recentSliceを「古い参考」と「直近そのまま」に分割
      const splitIdx = Math.max(0, recentSlice.length - RECENT_COUNT);
      const oldMessages = recentSlice.slice(0, splitIdx);    // 古い: 参考情報扱い
      const recentMessages = recentSlice.slice(splitIdx);    // 直近: 通常 + 最後を強調

      const history = [];

      // 古いメッセージは参考情報として包む（複数まとめて1つのassistantメモに）
      if (oldMessages.length > 0) {
        const summary = oldMessages.map(m => {
          const role = m.role === 'user' ? 'ユーザー' : 'アシスタント';
          const content = (m.content || '').slice(0, 500);  // 各500文字に圧縮
          return `[${role}] ${content}`;
        }).join('\n\n');
        history.push({
          role: 'system',
          content: `【参考: 過去の会話履歴（${oldMessages.length}件）】\n以下は背景情報です。最新の質問への回答に直接関連する場合のみ参照してください。\n\n${summary}`,
        });
      }

      // 直近メッセージはそのまま、ただし最後のユーザー質問は強調
      recentMessages.forEach((m, i) => {
        const isLast = i === recentMessages.length - 1;
        const hasImages = m.images && m.images.length > 0;
        let textContent = m.content || '';
        if (isLast && m.role === 'user' && textContent) {
          textContent = `【今この質問に回答してください】\n${textContent}`;
        }

        const h = { role: m.role };
        if (hasImages) {
          // OpenAI互換 (llama-server): content配列で text + image_url を送る
          h.content = [];
          if (textContent) h.content.push({ type: 'text', text: textContent });
          for (const img of m.images) {
            // base64がdata URI形式(data:image/png;base64,...)を含むかチェックして整形
            const dataUrl = img.base64.startsWith('data:')
              ? img.base64
              : `data:image/png;base64,${img.base64}`;
            h.content.push({ type: 'image_url', image_url: { url: dataUrl } });
          }
        } else {
          h.content = textContent;
        }
        history.push(h);
      });
      // OpenAI互換パラメータ（llama-server）
      // num_ctxはサーバー起動時に固定されるためリクエスト時は不要
      const llamaCommonOptions = {
        top_k: appConfig.topK,
        top_p: appConfig.topP,
        temperature: appConfig.temperature,
        // 繰り返し/思考ループ対策 (Qwen3 等の thinking ループ防止)
        repeat_penalty: appConfig.repeatPenalty,
        repeat_last_n: appConfig.repeatLastN,
        presence_penalty: appConfig.presencePenalty,
        frequency_penalty: appConfig.frequencyPenalty,
        dry_multiplier: appConfig.dryMultiplier,
        dry_base: appConfig.dryBase,
        dry_allowed_length: appConfig.dryAllowedLength,
        dry_penalty_last_n: appConfig.dryPenaltyLastN,
        // 暴走ループの安全網: 1応答あたりの最大トークン
        max_tokens: appConfig.agentContext?.largePredict || appConfig.chatMaxTokens || 8192,
        // llama.cpp拡張: cache_promptで高速化
        cache_prompt: true,
      };

      // Web検索が利用可能か: configで許可されており、かつチャット欄でONになっている
      const webSearchActive = appConfig.webSearch !== false && webSearchEnabled;

      // Google Drive が使えるか: configで有効 + 認可済み + チャット欄でON
      const gdriveActive = !!(appConfig.googleDrive?.enabled
        && gdriveStatus?.connected
        && gdriveEnabled);
      // 書き込み/削除は config 側で明示的に許可されている場合のみツールを出す
      const gdriveCanWrite = gdriveActive && !!gdriveStatus?.allowWrite;
      const gdriveCanDelete = gdriveActive && !!gdriveStatus?.allowDelete;

      // ツール判断ループ(agentic)に入る条件。
      // ドキュメント添付 or Web検索ON に加え、画像生成/音声合成/Google Drive が有効なら
      // 「描いて」「音声にして」「ドライブの資料見て」等を検出できるよう常にツール判断を通す。
      const useAgentic = appConfig.ragMode === 'agentic'
        && (documents.length > 0 || webSearchActive || appConfig.imageGen || appConfig.ttsGen || gdriveActive);

      if (useAgentic) {
        // ─── Agentic RAG + Web検索: LLMがツールで検索を判断 ───
        const tools = [];

        if (documents.length > 0) {
          const docNames = documents.map(d => d.name).join(', ');
          tools.push({
            type: 'function',
            function: {
              name: 'search_documents',
              description: `チャットに添付されたドキュメントから関連情報を検索する。検索対象のドキュメント: ${docNames}。これらのドキュメントについての質問は必ずこのツールを使用すること。テキストで関数呼び出しを書くのではなく、必ず実際のtool_callとして呼び出すこと。`,
              parameters: {
                type: 'object',
                properties: {
                  query: { type: 'string', description: '検索クエリ(質問の核心を簡潔に。ファイル名そのものではなく、内容に関するキーワード)' }
                },
                required: ['query']
              }
            }
          });
        }

        // 永続RAG (サーバー側 ml/rag/ に登録済みのドキュメント)
        // チャット添付ドキュメントとは独立した恒久的な知識ベース
        // embedding 利用可能 + 登録ドキュメント数 > 0 のとき自動的にツールを追加
        if (persistentRagAvailable && persistentRagDocCount > 0) {
          const docSummary = summarizePersistentRagDocs(10);
          tools.push({
            type: 'function',
            function: {
              name: 'search_persistent_documents',
              description: `サーバーに恒久的に登録済みのRAGドキュメント (${docSummary}) から、embedding ベクトル類似度で関連箇所を検索する。社内文書・マニュアル・ポリシー・FAQ・ナレッジベース等、チャット添付ではなくサーバー側に保管された資料を参照するためのツール。テキストで関数呼び出しを書くのではなく、必ず実際のtool_callとして呼び出すこと。`,
              parameters: {
                type: 'object',
                properties: {
                  query: { type: 'string', description: '検索したい内容・キーワード (質問の核心を簡潔に)' }
                },
                required: ['query']
              }
            }
          });
        }

        if (webSearchActive) {
          tools.push({
            type: 'function',
            function: {
              name: 'web_search',
              description: 'インターネットでWebページを検索する。最新情報、知らないこと、事実確認が必要な場合に使用する。',
              parameters: {
                type: 'object',
                properties: {
                  query: { type: 'string', description: '検索クエリ（簡潔で具体的に）' }
                },
                required: ['query']
              }
            }
          });
        }

        // ─── Google Drive ツール ───
        // 参照系 (検索/一覧/読み込み/サーバー取り込み) は接続済みなら常に提供する。
        // 「ドライブの資料を見て」のような依頼はキーワード事前判定が効きにくいため、
        // web_search と同じくトグルON = 常時提供の方針にしている。
        if (gdriveActive) {
          tools.push({
            type: 'function',
            function: {
              name: 'gdrive_search_files',
              description: 'Google Drive 上のファイルを、ファイル名と本文の全文検索で探す。ユーザーが「ドライブ」「Google Drive」「グーグルドライブ」「クラウド上のファイル」等に言及したら最初にこれを使う。返り値の id を gdrive_read_file に渡して中身を読むこと。テキストで関数呼び出しを書くのではなく、必ず実際のtool_callとして呼び出すこと。',
              parameters: {
                type: 'object',
                properties: {
                  query: { type: 'string', description: '検索キーワード（ファイル名の一部、または本文に含まれる語。簡潔に）' },
                  folderId: { type: 'string', description: '任意: 絞り込むフォルダのIDまたはフォルダ名' },
                },
                required: ['query'],
              },
            },
          });
          tools.push({
            type: 'function',
            function: {
              name: 'gdrive_list_files',
              description: 'Google Drive のフォルダの中身を一覧する。folderId 省略でマイドライブ直下。folderId にはIDのほか "資料/2026年度" のようなフォルダパスも指定できる。「ドライブに何がある?」のような質問で使う。',
              parameters: {
                type: 'object',
                properties: {
                  folderId: { type: 'string', description: '任意: フォルダIDまたはフォルダ名/パス' },
                  query: { type: 'string', description: '任意: このフォルダ内での絞り込みキーワード' },
                },
              },
            },
          });
          tools.push({
            type: 'function',
            function: {
              name: 'gdrive_read_file',
              description: 'Google Drive のファイルの中身をテキストで読む。Google ドキュメントはテキストに、スプレッドシートはCSVに自動変換される。fileId には gdrive_search_files / gdrive_list_files の結果から、id をそのままコピーして渡すこと。長いIDを正確に写す自信が無い場合は、代わりに一覧の【通し番号（1, 2, 3...）】か【ファイル名】を渡してもよい（自動で解決される）。PDF・画像・Excel などのバイナリは読めないので、その場合は gdrive_import_to_server を使う。',
              parameters: {
                type: 'object',
                properties: {
                  fileId: { type: 'string', description: 'ファイルID、または直前の一覧の通し番号("2"など)、またはファイル名' },
                },
                required: ['fileId'],
              },
            },
          });
          tools.push({
            type: 'function',
            function: {
              name: 'gdrive_import_to_server',
              description: 'Google Drive のファイルをサーバーの uploads フォルダにダウンロードして取り込む。PDF・画像・Excel等そのままでは読めないファイルや、Pythonで処理したいデータに使う。取り込み後は read_file やPythonコードから参照できる。',
              parameters: {
                type: 'object',
                properties: {
                  fileId: { type: 'string', description: 'ファイルID、または直前の一覧の通し番号("2"など)、またはファイル名' },
                  savePath: { type: 'string', description: '任意: uploads配下の保存先相対パス（省略時はDrive上の名前）' },
                },
                required: ['fileId'],
              },
            },
          });

          if (gdriveCanWrite) {
            tools.push({
              type: 'function',
              function: {
                name: 'gdrive_write_file',
                description: 'Google Drive にテキストファイルを作成または更新する。ユーザーが「ドライブに保存して」「Google Driveに書き出して」等を依頼した時のみ使う。fileId を指定すると更新、無ければ folderId の中に name で新規作成。',
                parameters: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'ファイル名（新規作成時は必須。拡張子を付けるとMIMEが決まる）' },
                    content: { type: 'string', description: 'ファイルの内容（文字列）' },
                    folderId: { type: 'string', description: '任意: 作成先フォルダIDまたはフォルダ名/パス' },
                    fileId: { type: 'string', description: '任意: 更新する既存ファイルのID' },
                    overwrite: { type: 'boolean', description: '任意: 同名ファイルがあれば上書きする' },
                  },
                  required: ['content'],
                },
              },
            });
            tools.push({
              type: 'function',
              function: {
                name: 'gdrive_upload_from_server',
                description: 'サーバーの uploads フォルダにあるファイルを Google Drive にアップロードする。バイナリも可。「このファイルをドライブに上げて」等で使う。',
                parameters: {
                  type: 'object',
                  properties: {
                    path: { type: 'string', description: 'uploads配下の相対パス（例: "report.csv"）' },
                    name: { type: 'string', description: '任意: Drive上でのファイル名' },
                    folderId: { type: 'string', description: '任意: アップロード先フォルダIDまたはフォルダ名/パス' },
                  },
                  required: ['path'],
                },
              },
            });
            tools.push({
              type: 'function',
              function: {
                name: 'gdrive_create_folder',
                description: 'Google Drive にフォルダを作成する。',
                parameters: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'フォルダ名' },
                    folderId: { type: 'string', description: '任意: 親フォルダIDまたはフォルダ名/パス' },
                  },
                  required: ['name'],
                },
              },
            });
          }

          if (gdriveCanDelete) {
            tools.push({
              type: 'function',
              function: {
                name: 'gdrive_delete_file',
                description: 'Google Drive のファイルをゴミ箱に移動する。ユーザーが明確に削除を依頼した時だけ使うこと。推測で削除しないこと。',
                parameters: {
                  type: 'object',
                  properties: {
                    fileId: { type: 'string', description: 'ファイルID（推奨）またはファイル名' },
                  },
                  required: ['fileId'],
                },
              },
            });
          }
        }

        // 物体検出ツール: 画像が添付されていて、かつ ML 機能が有効な時のみ提供
        // 「何が写ってる」「物体検出」「画像を分析」等の質問で LLM が呼ぶ
        if (hasImages && appConfig.ml?.enabled) {
          tools.push({
            type: 'function',
            function: {
              name: 'detect_objects',
              description: '添付された画像に対して物体検出を実行し、写っている物体 (人・車・動物・家具・食べ物など80種類) とその位置・個数を取得する。「何が写っているか」「物体を検出」「画像を分析」のような質問で使う。torchvision の COCO 事前学習モデルを使用。',
              parameters: {
                type: 'object',
                properties: {
                  threshold: { type: 'number', description: '信頼度しきい値 (0〜1、デフォルト0.5)。低くすると多く検出、高くすると確実なものだけ' }
                }
              }
            }
          });
        }

        // サーバーファイル系ツール: 明示的なサーバー操作キーワードがある時のみ提供
        // （単純なコード作成依頼などで誤呼び出しを防ぐため）
        const serverFileKeywords = [
          'サーバーファイル', 'サーバーに', 'サーバー側', 'サーバー上',
          'uploadsフォルダ', 'uploadsに', 'uploads/',
          'ファイルとして保存', 'ファイルに保存', 'ファイルに書き込',
          'として保存して', 'に保存して', 'に書き出して',
          'ファイル一覧', 'ファイルリスト',
          'list_files', 'read_file', 'write_file',
        ];
        const lowerTextForFile = text.toLowerCase();
        const wantsServerFileOps = serverFileKeywords.some(k => lowerTextForFile.includes(k.toLowerCase()));
        // write_file 専用の意図検出（より強いキーワード）
        const writeIntentKeywords = [
          'サーバーに保存', 'ファイルに保存', 'ファイルとして保存',
          'として保存して', 'に書き込んで', 'に書き出して', 'ファイルに書き',
          'save as', 'save to', 'write to file',
        ];
        const wantsFileWrite = writeIntentKeywords.some(k => lowerTextForFile.includes(k.toLowerCase()));

        if (appConfig.fileAccess !== false && wantsServerFileOps) {
          tools.push({
            type: 'function',
            function: {
              name: 'list_files',
              description: 'サーバーのuploadsフォルダに保存されているファイル一覧を取得する。',
              parameters: { type: 'object', properties: {} }
            }
          });
          tools.push({
            type: 'function',
            function: {
              name: 'read_file',
              description: 'uploadsフォルダ内のファイルを読み込む。引数 path は必ず "path" という名前で、uploadsフォルダからの相対パス（例: "data.json", "scripts/hello.py"）を指定する。',
              parameters: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'uploadsフォルダからの相対パス' }
                },
                required: ['path']
              }
            }
          });
          // write_file は明確な保存依頼がある時のみ
          if (wantsFileWrite) {
            tools.push({
              type: 'function',
              function: {
                name: 'write_file',
                description: 'uploadsフォルダ内のファイルに書き込む（新規作成または上書き）。引数は必ず "path"（相対パス）と "content"（ファイル内容の文字列）の2つ。10MBまで。',
                parameters: {
                  type: 'object',
                  properties: {
                    path: { type: 'string', description: 'uploadsフォルダからの相対パス（例: "hello.py"）' },
                    content: { type: 'string', description: 'ファイルに書き込む内容（文字列）' }
                  },
                  required: ['path', 'content']
                }
              }
            });
          }
        }

        // 画像生成ツール: imageGen が有効ならツール提供
        // 「絵を描いて」「画像生成」「イラスト」等を検出して自動使用
        if (appConfig.imageGen) {
          tools.push({
            type: 'function',
            function: {
              name: 'generate_image',
              description: '画像（イラスト、写真、絵）をAIで生成する。ユーザーが「描いて」「画像にして」「絵を作って」「イラストを生成」等を依頼した場合に使用する。プロンプトは英語が高品質。',
              parameters: {
                type: 'object',
                properties: {
                  prompt: {
                    type: 'string',
                    description: '画像の内容を表す詳細なプロンプト。英語推奨。例: "a cute orange cat sitting on a windowsill, soft sunlight, photorealistic, high quality"'
                  },
                  negative_prompt: {
                    type: 'string',
                    description: '画像に含めたくない要素。例: "blurry, low quality, distorted, extra limbs"'
                  },
                  width: { type: 'number', description: '画像の幅 (px, デフォルト 1024、64-2048)' },
                  height: { type: 'number', description: '画像の高さ (px, デフォルト 1024、64-2048)' },
                  steps: { type: 'number', description: '生成ステップ数 (デフォルト 20、多いほど高品質だが遅い)' },
                  count: { type: 'number', description: '生成枚数 (デフォルト 1、最大 4)' },
                },
                required: ['prompt']
              }
            }
          });
        }

        // 音声合成ツール: ttsGen が有効ならツール提供
        // 「音声にして」「しゃべって」「読み上げて」「〇〇の声で作って」等を検出して使用
        if (appConfig.ttsGen) {
          const voicePresets = Array.isArray(appConfig.ttsVoices) ? appConfig.ttsVoices : [];
          const voiceHint = voicePresets.length > 0
            ? ` 登録済みの声: ${voicePresets.map(v => `"${v.name}"${v.desc ? `(${v.desc})` : ''}`).join('、')}。`
            : '';
          tools.push({
            type: 'function',
            function: {
              name: 'generate_speech',
              description: 'テキストを音声(WAV)に合成する。ユーザーが「音声にして」「しゃべって」「読み上げて」「声で作って」「ボイスを生成」等を依頼した場合に使用する。日本語のテキストをそのまま渡せる。' + voiceHint,
              parameters: {
                type: 'object',
                properties: {
                  text: {
                    type: 'string',
                    description: '読み上げる(音声化する)テキスト。例: "こんにちは"'
                  },
                  voice: {
                    type: 'string',
                    description: '声の指定。登録済みの声の名前か、または声の特徴をテキストで記述する。例: "30代男性、落ち着いた低めの声"、"明るい女性の声"。省略可。'
                  },
                  speed: { type: 'number', description: '話す速さ (0.25〜4.0、デフォルト 1.0)' },
                },
                required: ['text']
              }
            }
          });
        }

        // ML データテーブルツール: mlEnabled が有効ならツール提供（読み取り専用）
        // 重要: これらのツールは、ユーザーが【明示的にテーブル名・モデル名・または
        // 「データテーブル」「ML」「機械学習」というメタ的なキーワード】を発話した時のみ呼ぶ。
        // 雑談、一般質問、コード生成、Web検索系では絶対に呼ばないこと。
        if (appConfig.ml?.enabled) {
          tools.push({
            type: 'function',
            function: {
              name: 'ml_list_datasets',
              description: '【発動条件: ユーザーが「データテーブル」「ml の一覧」「どんなテーブルがあるか」等のメタ的な質問をした時のみ】機械学習用データテーブル(DuckDB)の一覧を取得する。\n\n❌ 呼ばないケース: ユーザーが具体的なテーブル名を既に指定している (その場合は ml_describe_dataset を直接呼ぶ)、ML と無関係な雑談、コード生成、Web検索が必要な質問。\n✅ 呼ぶケース: 「どんなデータがある?」「テーブル一覧見せて」「MLで何が登録されてる?」のような探索的な質問のみ。',
              parameters: { type: 'object', properties: {} }
            }
          });
          tools.push({
            type: 'function',
            function: {
              name: 'ml_describe_dataset',
              description: '【発動条件: ユーザーが具体的なテーブル名を明示した時のみ】指定されたテーブルのスキーマ(カラム名・型)を取得する。\n\n❌ 呼ばないケース: ユーザーがテーブル名を一切言ってない、雑談、一般質問、テーブル名が曖昧 (「データを見せて」だけ等)。曖昧な場合はユーザーに「どのテーブル?」と聞き返すこと。\n✅ 呼ぶケース: 「data テーブルのカラム教えて」「sales_test の構造は?」のように、テーブル名が明確な質問。',
              parameters: {
                type: 'object',
                properties: {
                  table: { type: 'string', description: 'ユーザーが明示したテーブル名 (英数字とアンダースコアのみ)。推測で勝手にテーブル名を作らないこと。' }
                },
                required: ['table']
              }
            }
          });
          tools.push({
            type: 'function',
            function: {
              name: 'ml_query_dataset',
              description: '【発動条件: ユーザーが具体的なテーブル名 + データに対する分析/集計/閲覧の意図を明示した時のみ】SQLを実行する (SELECT/WITH のみ、書き込み・スキーマ変更禁止)。LIMIT が無ければ自動で1000行制限。\n\n❌ 呼ばないケース: テーブル名が分からない (まずユーザーに聞く)、雑談、一般質問、テーブル名を勝手に推測してSQL組み立て。\n✅ 呼ぶケース: 「data テーブルの東京の売上合計は?」「sales_test の月別集計を出して」のように、テーブル名が明確で集計/分析意図がある質問。必要なら先に ml_describe_dataset でスキーマ確認。DuckDB方言が使える(window関数、CTE、集約等)。',
              parameters: {
                type: 'object',
                properties: {
                  sql: {
                    type: 'string',
                    description: '実行するSQL文 (SELECTまたはWITHで始まる、書き込み禁止)。例: "SELECT region, SUM(sales) FROM data GROUP BY region"'
                  },
                  limit: { type: 'number', description: '結果の最大行数 (デフォルト 1000、最大 10000)' }
                },
                required: ['sql']
              }
            }
          });
          tools.push({
            type: 'function',
            function: {
              name: 'ml_list_models',
              description: '【発動条件: ユーザーが「どんなモデルがある?」「学習済みモデル一覧」のような探索的な質問をした時のみ】学習済みMLモデルの一覧と性能指標を取得する。\n\n❌ 呼ばないケース: ユーザーが具体的なモデル名を既に指定している (その場合は ml_predict を直接呼ぶ)、雑談、ML と無関係な質問。\n✅ 呼ぶケース: 「使えるモデル教えて」「予測モデル一覧」のようなメタ的な質問。',
              parameters: { type: 'object', properties: {} }
            }
          });
          tools.push({
            type: 'function',
            function: {
              name: 'ml_predict',
              description:
                '【発動条件: ユーザーが具体的なモデル名 + 予測に必要な情報を明示した時のみ】学習済みモデルで予測を実行する。\n\n' +
                '❌ 呼ばないケース: モデル名が不明、必要情報が不足、モデル名を勝手に推測。\n' +
                '✅ 呼ぶケース: 「sales_yosoku で東京・ProductA・5個・2027-04-15 を予測」のように、モデル名と入力値が明確。\n\n' +
                '⚠️ 重要な使い方ルール:\n' +
                '1. features には【元の特徴量名のみ】を使う (例: "date", "region", "product", "quantity")。\n' +
                '   ml_list_models で返ってくる features フィールドが「使うべき列名」です。\n' +
                '2. 日時列は元の日付文字列で渡す: ✅ "date": "2027-04-15"\n' +
                '   ❌ "date_year": 2027, "date_month": 4, "date_day": 15 ← これは絶対にやらない\n' +
                '   日時列は内部で自動的に year/month/day/dayofweek/dayofyear/is_weekend に分解されます。\n' +
                '3. カテゴリ列は学習時の値 (例: "Tokyo")、数値列は数値で渡す。\n' +
                '4. 不明な点があれば、まず ml_list_models で predictHint を確認すること (exampleInput が見られる)。\n\n' +
                '正しい呼び出し例:\n' +
                '  ml_predict("sales_yosoku", {"date": "2027-04-15", "region": "Tokyo", "product": "ProductA", "quantity": 5})\n\n' +
                '間違った呼び出し例 (絶対にしない):\n' +
                '  ❌ ml_predict("sales_yosoku", {"date_year": 2027, "date_month": 4, ...}) ← 派生列を直接渡してる\n' +
                '  ❌ ml_predict("sales_yosoku", {"quantity": 5}) ← 必要な特徴量が欠けている',
              parameters: {
                type: 'object',
                properties: {
                  modelName: { type: 'string', description: 'ユーザーが明示したモデル名。推測で勝手にモデル名を作らないこと。' },
                  features: {
                    description: '特徴量。単一予測なら {col1: val1, ...} 形式の辞書、複数件なら辞書の配列。モデルの features に記載された「元の」列名のみ使う。日時列は元の日付文字列で渡す (例: "2027-04-15")。'
                  }
                },
                required: ['modelName', 'features']
              }
            }
          });
        }

        // ─── ML系ツールのプリフィルタ ───
        // ユーザー発話に「具体的なテーブル名/モデル名」or「MLメタキーワード」が無い場合は
        // ML系ツールを tools 配列から除外して、LLM が物理的に呼べないようにする。
        // (description の指示だけだと LLM が独断で呼んでしまうことがあるため)
        if (appConfig.ml?.enabled) {
          // 直近のユーザー発話を結合 (今回入力 + 直前数ターンの履歴) して判定
          const recentUserText = [
            text,
            ...history.slice(-4).filter(m => m.role === 'user').map(m =>
              typeof m.content === 'string' ? m.content : ''
            )
          ].join(' ').toLowerCase();

          // MLメタキーワード (これらを発話していたら ML 系ツール全部 OK)
          const mlMetaKeywords = [
            'ml', '機械学習', 'データテーブル', 'データ テーブル',
            'duckdb', '予測モデル', '学習済みモデル',
            'どんなテーブル', 'どんなモデル', 'テーブル一覧', 'モデル一覧',
            'スキーマ', 'カラム', 'sql', 'select',
            // 予測関連のキーワード
            '予測して', '推論して', '予測する', '推論する', '予測でき',
            'predict', 'forecast',
          ];
          const hasMetaKeyword = mlMetaKeywords.some(k => recentUserText.includes(k));

          // 既存のテーブル名/モデル名がユーザー発話に含まれているか確認 (非同期で取得)
          let hasSpecificName = false;
          if (!hasMetaKeyword) {
            try {
              // テーブル一覧とモデル一覧を取得して、名前がユーザー発話に含まれるかチェック
              const [tablesRes, modelsRes] = await Promise.all([
                fetch('/ml/datasets').catch(() => null),
                fetch('/ml/models').catch(() => null),
              ]);
              const knownNames = [];
              if (tablesRes?.ok) {
                const d = await tablesRes.json();
                (d.tables || []).forEach(t => knownNames.push(t.name.toLowerCase()));
              }
              if (modelsRes?.ok) {
                const d = await modelsRes.json();
                (d.models || []).forEach(m => knownNames.push(m.name.toLowerCase()));
              }
              // 各名前についてユーザー発話に含まれるかチェック (単語境界も意識)
              hasSpecificName = knownNames.some(name => {
                if (!name) return false;
                // 短すぎる名前 (3文字以下) は偶然マッチを避けるため単語境界チェック
                if (name.length <= 3) {
                  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                  return re.test(recentUserText);
                }
                return recentUserText.includes(name);
              });
            } catch (e) {
              console.log('[ML プリフィルタ] テーブル/モデル名取得失敗、ツール除外を見送り:', e.message);
              // 取得失敗時は安全側 = ML ツールを残す
              hasSpecificName = true;
            }
          }

          if (!hasMetaKeyword && !hasSpecificName) {
            // ML 系ツールを tools 配列から除外
            const mlToolNames = new Set([
              'ml_list_datasets', 'ml_describe_dataset', 'ml_query_dataset',
              'ml_list_models', 'ml_predict',
            ]);
            const before = tools.length;
            for (let i = tools.length - 1; i >= 0; i--) {
              if (mlToolNames.has(tools[i]?.function?.name)) {
                tools.splice(i, 1);
              }
            }
            const removed = before - tools.length;
            if (removed > 0) {
              console.log(`[ML プリフィルタ] テーブル名/モデル名/MLキーワードがユーザー発話に無いため、ML系ツール ${removed}個を除外`);
            }
          } else {
            console.log(`[ML プリフィルタ] ML系ツール有効 (hasMetaKeyword=${hasMetaKeyword}, hasSpecificName=${hasSpecificName})`);
          }
        }

        let agentSystem = systemPrompt;
        if (documents.length > 0 && sp.documents) {
          const docListText = documents.map(d => d.name).join(', ');
          agentSystem += '\n\n' + fillTemplate(sp.documents, { docList: docListText });
        }
        if (webSearchActive && sp.webSearch) {
          agentSystem += '\n\n' + sp.webSearch;
        }
        if (appConfig.fileAccess !== false && sp.fileAccess) {
          agentSystem += '\n\n' + sp.fileAccess;
        }
        if (gdriveActive && sp.googleDrive) {
          agentSystem += '\n\n' + sp.googleDrive;
        }
        // 永続RAGが使える時だけ、引用の忠実性に関する指示を足す
        // (原文の数式・記号を一般形に書き換えるのを抑え、出典ページを添えさせる)
        if (persistentRagAvailable && persistentRagDocCount > 0 && sp.rag) {
          agentSystem += '\n\n' + sp.rag;
        }
        if (sp.python) {
          agentSystem += '\n\n' + sp.python;
        }
        if (sp.meta) {
          agentSystem += '\n\n' + sp.meta;
        }
        // ユーザー設定の役割（システムプロンプト先頭に置き、汎用ルールより優先させる）
        agentSystem = applyRolePrompt(agentSystem, chatRole);

        let apiMessages = [{ role: 'system', content: agentSystem }, ...history];
        let allContexts = [];
        // 実行済みツール呼び出し (fnName + 引数) の記録。同じ呼び出しの繰り返しを防ぐ
        const executedToolCalls = new Set();
        let searchQueries = [];
        // 永続RAGの出典レジストリ。ターン内で S1, S2, … の通し番号を維持する。
        // モデルには ASCII の短いキーだけを書かせ、実際のファイル名は
        // 画面側がこのデータから描く。日本語の資料名を転写させると
        // 「テラメカニックス」が毎回違う形に崩れるため (Qwen3.6 で確認)。
        const ragSourceRegistry = [];   // [{ key, filename, label, page, pageRange }]
        const ragSourceKey = (r) => {
          const pg = r.pageRange ? `${r.pageRange[0]}-${r.pageRange[1]}`
            : (r.page != null ? String(r.page) : '');
          const found = ragSourceRegistry.find(s => s.filename === r.filename && s.pageText === pg);
          if (found) return found;
          const entry = {
            key: `S${ragSourceRegistry.length + 1}`,
            filename: r.filename,
            label: shortSourceLabel(r.filename),
            pageText: pg,
          };
          ragSourceRegistry.push(entry);
          return entry;
        };
        // ツールが実際に生成したメディアの本物URL。
        // LLMが [[gen_audio:...]]/[[gen_image:...]] のファイル名を改変して出力する
        // ことがあるため、最終応答でこの実URLでマーカーを確定させる。
        const generatedAudios = [];   // { url, text }
        const generatedImages = [];   // { url, prompt }

        // アシスタントメッセージを先に追加
        setMessages(prev => [...prev, { role: 'assistant', content: '', thinking: '', contexts: null, agentStatus: 'ツール判断中...', searchQueries: [] }]);

        // ─── 入力内容からツール判断時のnum_ctx/num_predictを動的決定 ───
        const agentCtx = appConfig.agentContext || {};
        const fileWriteKeywords = agentCtx.largeGenKeywords || [
          // 日本語
          '書き込', '書き出', '保存', '作成して', 'ファイル作', 'サーバーファイルに',
          // 拡張子
          '.py', '.js', '.ts', '.html', '.css',
          '.xml', '.json', '.yaml', '.yml', '.md', '.txt', '.csv', '.sh', '.cpp', '.c ', '.h ',
          // 英語
          'write ', 'save ', 'create file', 'generate ', 'write_file', 'write to',
        ];
        // llama.cppではctxはサーバー起動時固定なので、predictのみ動的調整
        const smallPredict = agentCtx.smallPredict ?? 512;
        const largePredict = agentCtx.largePredict ?? 8192;
        const judgeHistoryCount = agentCtx.judgeHistoryCount ?? 3; // ツール判断時の履歴件数

        const lowerText = text.toLowerCase();
        const needsLargeGen = fileWriteKeywords.some(k => lowerText.includes(k.toLowerCase()));

        // ツール判断用の簡潔なシステムプロンプト（config駆動、{toolList}を動的構築）
        const docList = documents.length > 0 ? documents.map(d => d.name).join(', ') : '';
        const toolListLines = [];
        if (documents.length > 0) {
          toolListLines.push(`- search_documents: チャット添付済みドキュメント (${docList}) から検索 ★「資料」「ドキュメント」「添付」関連の質問では最優先`);
        }
        if (persistentRagAvailable && persistentRagDocCount > 0) {
          const persistentSummary = summarizePersistentRagDocs(5);
          toolListLines.push(`- search_persistent_documents: サーバー登録済みドキュメント (${persistentSummary}) から検索 ★社内文書・マニュアル・FAQ等の参照に使う`);
        }
        if (webSearchActive) {
          toolListLines.push('- web_search: インターネット検索（最新情報が必要な場合）');
        }
        if (gdriveActive) {
          const gdWrite = gdriveCanWrite ? '／gdrive_write_file・gdrive_upload_from_server・gdrive_create_folder: Drive への書き込み' : '';
          const gdDelete = gdriveCanDelete ? '／gdrive_delete_file: Drive のファイルをゴミ箱へ' : '';
          toolListLines.push(
            '- gdrive_search_files / gdrive_list_files / gdrive_read_file / gdrive_import_to_server: Google Drive の検索・一覧・読み込み・サーバー取り込み ' +
            '★「ドライブ」「Google Drive」「グーグルドライブ」「クラウドのファイル」等の言及があれば最優先。' +
            'まず検索か一覧でIDを特定してから読むこと' + gdWrite + gdDelete
          );
        }
        if (hasImages && appConfig.ml?.enabled) {
          toolListLines.push('- detect_objects: 添付画像の物体検出（「何が写ってる」「物体を検出」「画像を分析」等で使う）');
        }
        if (appConfig.ttsGen) {
          toolListLines.push('- generate_speech: テキストを音声(WAV)に合成（「音声にして」「しゃべって」「読み上げて」「〇〇の声で作って」等で使う。声の特徴はテキストで指定可）');
        }
        if (appConfig.fileAccess !== false && wantsServerFileOps) {
          if (wantsFileWrite) {
            toolListLines.push('- list_files/read_file/write_file: サーバーuploadsフォルダの操作');
          } else {
            toolListLines.push('- list_files/read_file: サーバーuploadsフォルダの参照');
          }
        }
        if (appConfig.ml?.enabled) {
          // ML系ツールは「ユーザーがテーブル名/モデル名/メタキーワードを明示した時のみ」発動
          toolListLines.push(
            '- ml_*: 機械学習データテーブル/モデル系。【発動条件: ユーザーが「具体的なテーブル名」「具体的なモデル名」または「データテーブル」「ML」「機械学習」等のメタキーワードを発話した時のみ】呼ぶ。' +
            '雑談・一般質問・コード生成では絶対に呼ばない。' +
            'テーブル名/モデル名が不明なら、推測で勝手に名前を作らず、ユーザーに「どのテーブル/モデル?」と聞き返すこと。'
          );
        }
        const judgeSystem = fillTemplate(sp.judge || '', { toolList: toolListLines.join('\n') });

        // 判断用のapiMessages（短縮版）— 直近の履歴だけ使う
        const judgeHistory = history.slice(-judgeHistoryCount);
        // 初回ツール判断用プロンプト
        let judgeMessages = [{ role: 'system', content: judgeSystem }, ...judgeHistory];

        const judgeNumPredict = needsLargeGen ? largePredict : smallPredict;
        console.log(`[ツール判断] max_tokens=${judgeNumPredict}, history=${judgeHistory.length}件 (needsLargeGen=${needsLargeGen})`);

        // ─── ツール実行ループ ───
        // Gemma系モデルはマルチターンのツール呼び出しが不安定（テキスト形式の<|tool_call|>を出力することがある）
        // → 1ターンのみに制限。Qwen系等は3ターンまで
        const isGemmaModel = /gemma/i.test(chatModel);
        // ターン数の目安: 「探す → 読む → 答える」で最低2ターン必要。
        // ID を間違えて読み直すと3ターン目に入り、以前の上限(3)では回答に
        // たどり着く前に打ち切られていた (「Let me try reading with the exact
        // original ID...」と言ったまま止まる)。余裕を見て4にする。
        // Gemma はマルチターンのツール呼び出しでテキスト形式の tool_call を
        // 出すことがあるため以前は1にしていたが、1では「探して読む」が
        // 物理的にできない。テキスト形式は下のフォールバックで拾えるので2にする。
        const MAX_TOOL_TURNS = isGemmaModel ? 2 : 4;
        let toolTurn = 0;
        let lastAssistantMsg = null;

        while (toolTurn < MAX_TOOL_TURNS) {
          toolTurn++;
          // 2周目以降は、最新のapiMessagesを使う（ツール結果を含んだ会話）
          const turnMessages = toolTurn === 1 ? judgeMessages : [{ role: 'system', content: judgeSystem }, ...apiMessages.slice(1)];

          // 2周目以降のステータス更新
          if (toolTurn > 1) {
            setMessages(prev => {
              const copy = [...prev];
              copy[copy.length - 1] = { ...copy[copy.length - 1], agentStatus: `🔄 追加ツール判断中 (${toolTurn}/${MAX_TOOL_TURNS})...`, searchQueries: [...searchQueries] };
              return copy;
            });
          }

          // ツール呼び出し判断（非ストリーミング、thinkingオフで高速化）
          // Qwen3/Qwen3.6 系の thinking モードは tool_calls 判断時に時間を浪費するため明示的に無効化
          let toolRes;
          let retryCount = 0;
          const MAX_RETRIES = 3;
          while (retryCount <= MAX_RETRIES) {
            toolRes = await fetch('/v1/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: chatModel,
                messages: turnMessages,
                tools,
                stream: false,
                max_tokens: judgeNumPredict,
                chat_template_kwargs: { enable_thinking: false },
                ...llamaCommonOptions,
              }),
              signal: controller.signal,
            });
            // 503 = モデル起動中、500/502/504 = サーバー側一時エラー の場合はリトライ
            const isRetryable = toolRes.status === 503 || toolRes.status === 500 || toolRes.status === 502 || toolRes.status === 504;
            if (isRetryable && retryCount < MAX_RETRIES) {
              const errData = await toolRes.json().catch(() => ({}));
              console.log(`[ツール判断 ${toolRes.status}] ${errData.error || ''} - 5秒後にリトライ (${retryCount + 1}/${MAX_RETRIES})`);
              await new Promise(r => setTimeout(r, 5000));
              retryCount++;
              continue;
            }
            break;
          }

          if (!toolRes.ok) {
            // エラー詳細をできるだけ取得してメッセージに含める
            let errBody = '';
            try {
              const errData = await toolRes.json();
              errBody = errData.error?.message || errData.error || JSON.stringify(errData).slice(0, 200);
            } catch {
              try { errBody = (await toolRes.text()).slice(0, 200); } catch {}
            }
            throw new Error(`API Error ${toolRes.status}${errBody ? ': ' + errBody : ''}`);
          }
          const toolData = await toolRes.json();
          // OpenAI互換: { choices: [{ message: { role, content, tool_calls } }] }
          const choice = toolData.choices?.[0];
          // OllamaのassistantMsg形式に正規化（既存のロジックを再利用するため）
          const assistantMsg = {
            role: 'assistant',
            content: choice?.message?.content || '',
            tool_calls: choice?.message?.tool_calls || null,
          };
          lastAssistantMsg = assistantMsg;

          // LLMがテキストで「search_documents(query='...')」と書いてしまった場合、
          // 実際のtool_callに変換するフォールバック
          if ((!assistantMsg?.tool_calls || assistantMsg.tool_calls.length === 0) && assistantMsg?.content) {
            // パターン1: Gemma独自トークン形式（非対称対応）
            // <|tool_call|>, <|tool_call>, <tool_call|>, <tool_call> 全て対応
            // 例: <|tool_call|>call:web_search{query:<|"|>今日のニュース<|"|>}<tool_call|>
            const gemmaCallMatch = assistantMsg.content.match(/<\|?tool_call\|?>\s*call:\s*(\w+)\s*\{([\s\S]*?)\}\s*<\/?\|?tool_call\|?>/i);
            if (gemmaCallMatch) {
              const fname = gemmaCallMatch[1];
              const argsBody = gemmaCallMatch[2];
              const args = {};
              // key:<|"|>value<|"|> の囲みも非対称対応
              const argRe = /(\w+)\s*:\s*<\|?"?\|?>\s*([\s\S]*?)\s*<\|?"?\|?>/g;
              let m;
              while ((m = argRe.exec(argsBody)) !== null) {
                args[m[1]] = m[2];
              }
              // フォールバック: シンプルな key: value 形式
              if (Object.keys(args).length === 0) {
                const simpleMatch = argsBody.match(/(\w+)\s*:\s*"?([^",}]+)"?/);
                if (simpleMatch) args[simpleMatch[1]] = simpleMatch[2].trim();
              }
              if (Object.keys(args).length > 0 || fname === 'list_files') {
                console.log(`[Gemmaトークン検出] ${fname}(${JSON.stringify(args)}) を実ツール呼び出しに変換`);
                assistantMsg.tool_calls = [{
                  id: 'call_' + Date.now(),
                  type: 'function',
                  function: { name: fname, arguments: JSON.stringify(args) }
                }];
                assistantMsg.content = '';
              }
            }
          }
          // パターン2: Python関数呼び出し形式 funcname(query='...')
          if ((!assistantMsg?.tool_calls || assistantMsg.tool_calls.length === 0) && assistantMsg?.content) {
            const textCallMatch = assistantMsg.content.match(/(search_documents|search_persistent_documents|web_search|read_file|list_files|write_file|gdrive_search_files|gdrive_list_files|gdrive_read_file|gdrive_import_to_server)\s*\(\s*([^)]*)\)/);
            if (textCallMatch) {
              const fname = textCallMatch[1];
              const argsStr = textCallMatch[2];
              // OpenAI互換のtool_call形式
              const fakeCall = {
                id: 'call_' + Date.now(),
                type: 'function',
                function: { name: fname, arguments: '{}' }
              };
              const args = {};
              const queryMatch = argsStr.match(/query\s*=\s*['"]([^'"]+)['"]/);
              const pathMatch = argsStr.match(/(?:path|filename|file)\s*=\s*['"]([^'"]+)['"]/);
              const fileIdMatch = argsStr.match(/(?:fileId|file_id|id)\s*=\s*['"]([^'"]+)['"]/);
              const folderIdMatch = argsStr.match(/(?:folderId|folder_id|folder)\s*=\s*['"]([^'"]+)['"]/);
              if (queryMatch) args.query = queryMatch[1];
              if (pathMatch) args.path = pathMatch[1];
              if (fileIdMatch) args.fileId = fileIdMatch[1];
              if (folderIdMatch) args.folderId = folderIdMatch[1];
              // 引数名なしの位置引数 gdrive_read_file('abc123') 形式も拾う
              if (fname.startsWith('gdrive_') && Object.keys(args).length === 0) {
                const bare = argsStr.match(/^\s*['"]([^'"]+)['"]\s*$/);
                if (bare) {
                  if (fname === 'gdrive_search_files' || fname === 'gdrive_list_files') args.query = bare[1];
                  else args.fileId = bare[1];
                }
              }
              // queryもpathもないがlist_files系なら引数なし
              if (fname === 'list_files' || fname === 'gdrive_list_files' || Object.keys(args).length > 0) {
                console.log(`[ツールテキスト検出] ${fname} を実ツール呼び出しに変換`);
                fakeCall.function.arguments = JSON.stringify(args);
                assistantMsg.tool_calls = [fakeCall];
                // contentは上書きで空にする（テキスト応答を破棄）
                assistantMsg.content = '';
              }
            }
          }

          // パターン3: ML系のテキスト形式呼び出し検出
          // 例1: "sales_yosoku{"date_year": 2026, ...}" (Qwenで稀に発生)
          // 例2: "ml_predict(modelName='sales_yosoku', features={...})"
          // 例3: コードブロック内 ```json {"modelName": "...", "features": {...}} ```
          if (appConfig.ml?.enabled && (!assistantMsg?.tool_calls || assistantMsg.tool_calls.length === 0) && assistantMsg?.content) {
            const content = assistantMsg.content;
            let mlCall = null;

            // パターンA: <モデル名>{JSON} 形式
            // モデル名は単語境界 + {JSON} のパターン
            const directCallMatch = content.match(/(\b[a-zA-Z_][a-zA-Z0-9_]*\b)\s*(\{[\s\S]*?\})\s*$/m);
            if (directCallMatch) {
              const possibleModelName = directCallMatch[1];
              const jsonStr = directCallMatch[2];
              // ml_ で始まる関数名 or 既存のモデル名のいずれかなら採用
              const isMlTool = ['ml_predict', 'ml_query_dataset', 'ml_describe_dataset'].includes(possibleModelName);
              if (!isMlTool) {
                // モデル名チェック (cachedModels が無いので、JSON にfeatures があれば ml_predict と判断)
                try {
                  const argsObj = JSON.parse(jsonStr);
                  if (argsObj.date_year !== undefined || argsObj.date_month !== undefined ||
                      argsObj.region !== undefined || argsObj.product !== undefined ||
                      argsObj.quantity !== undefined || argsObj.features !== undefined) {
                    mlCall = { name: 'ml_predict', args: { modelName: possibleModelName, features: argsObj.features || argsObj } };
                  }
                } catch {}
              } else {
                try {
                  const argsObj = JSON.parse(jsonStr);
                  mlCall = { name: possibleModelName, args: argsObj };
                } catch {}
              }
            }

            // パターンB: ml_predict(...) 形式
            if (!mlCall) {
              const mlFuncMatch = content.match(/ml_(predict|query_dataset|describe_dataset|list_models|list_datasets)\s*\(\s*([^)]*?)\s*\)/);
              if (mlFuncMatch) {
                const fname = 'ml_' + mlFuncMatch[1];
                const argsStr = mlFuncMatch[2];
                try {
                  // JSON 形式の引数を試す
                  const argsObj = JSON.parse('{' + argsStr.replace(/'/g, '"') + '}');
                  mlCall = { name: fname, args: argsObj };
                } catch {
                  // key=value 形式: modelName='sales_yosoku', features={...}
                  const args = {};
                  const modelMatch = argsStr.match(/modelName\s*=\s*['"]([^'"]+)['"]/);
                  if (modelMatch) args.modelName = modelMatch[1];
                  const featuresMatch = argsStr.match(/features\s*=\s*(\{[\s\S]*\})/);
                  if (featuresMatch) {
                    try { args.features = JSON.parse(featuresMatch[1]); } catch {}
                  }
                  if (Object.keys(args).length > 0) {
                    mlCall = { name: fname, args };
                  }
                }
              }
            }

            // パターンC: JSON コードブロック内 (modelName と features を含む)
            if (!mlCall) {
              const jsonBlockMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
              if (jsonBlockMatch) {
                try {
                  const obj = JSON.parse(jsonBlockMatch[1]);
                  if (obj.modelName && obj.features) {
                    mlCall = { name: 'ml_predict', args: obj };
                  }
                } catch {}
              }
            }

            if (mlCall) {
              // ⚠️ 派生列が含まれている場合は警告 (Pythonがエラーにするのでそのまま流す)
              if (mlCall.name === 'ml_predict' && mlCall.args.features) {
                const f = mlCall.args.features;
                const hasDerived = Object.keys(f).some(k =>
                  /^date_(year|month|day|dayofweek|dayofyear|is_weekend)$/i.test(k) ||
                  /^[a-zA-Z]+_(year|month|day|dayofweek|dayofyear|is_weekend)$/i.test(k)
                );
                if (hasDerived) {
                  console.warn('[ML テキスト形式検出] 派生列が含まれています、Python 側でエラー → 自動修正試行');
                  // 派生列から元の日付を復元する試み
                  const dateCols = new Set();
                  for (const k of Object.keys(f)) {
                    const m = k.match(/^([a-zA-Z]+)_(year|month|day|dayofweek|dayofyear|is_weekend)$/i);
                    if (m) dateCols.add(m[1]);
                  }
                  for (const dc of dateCols) {
                    const y = f[`${dc}_year`];
                    const mo = f[`${dc}_month`];
                    const d = f[`${dc}_day`];
                    if (y && mo && d) {
                      const dateStr = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                      f[dc] = dateStr;
                      console.log(`[ML テキスト形式検出] 派生列 ${dc}_year/month/day から ${dc}="${dateStr}" を復元`);
                    }
                    // 派生列を削除
                    for (const suf of ['year', 'month', 'day', 'dayofweek', 'dayofyear', 'is_weekend']) {
                      delete f[`${dc}_${suf}`];
                    }
                  }
                }
              }

              const fakeCall = {
                id: 'call_' + Date.now(),
                type: 'function',
                function: {
                  name: mlCall.name,
                  arguments: JSON.stringify(mlCall.args),
                },
              };
              console.log(`[ML テキスト形式検出] ${mlCall.name}(${JSON.stringify(mlCall.args).slice(0, 200)}) を実ツール呼び出しに変換`);
              assistantMsg.tool_calls = [fakeCall];
              assistantMsg.content = '';
            }
          }

          // ツール呼び出しがなければループ終了
          if (!assistantMsg?.tool_calls || assistantMsg.tool_calls.length === 0) break;

          console.log(`[ツール実行 ${toolTurn}周目] ${assistantMsg.tool_calls.length}件のツール呼び出し`);
          apiMessages.push(assistantMsg);

          for (const tc of assistantMsg.tool_calls) {
            const fnName = tc.function?.name;
            // OpenAI互換: argumentsはJSON文字列で来る。Ollama互換コードのため両対応
            let fnArgs = tc.function?.arguments || {};
            if (typeof fnArgs === 'string') {
              try { fnArgs = JSON.parse(fnArgs); } catch { fnArgs = {}; }
            }

            // ─── 同一ツール呼び出しの重複実行を防ぐ ───
            // モデルが同じ引数で同じツールを繰り返し呼ぶことがある。特にファイル読み込みは
            // 結果が大きいため、2回3回と積むとコンテキストを食い潰し、最終応答が空になったり
            // 途中で止まったりする。既に実行済みなら結果を積まずにその旨だけ返す。
            const callKey = `${fnName}:${JSON.stringify(fnArgs)}`;
            if (executedToolCalls.has(callKey)) {
              console.log(`[ツール重複] ${fnName} は同じ引数で実行済み → スキップ`);
              apiMessages.push({
                role: 'tool', tool_call_id: tc.id,
                content: '同じ引数でのこの呼び出しは既に実行済みです。上の実行結果をそのまま使って回答してください。',
              });
              continue;
            }
            executedToolCalls.add(callKey);

            if (fnName === 'search_documents') {
              const query = fnArgs.query || text;
              searchQueries.push({ query: `ドキュメント検索: ${query}`, resultCount: null, type: 'doc' });

              setMessages(prev => {
                const copy = [...prev];
                copy[copy.length - 1] = {
                  ...copy[copy.length - 1],
                  agentStatus: `📄 ドキュメント検索「${query}」中...`,
                  searchQueries: [...searchQueries],
                };
                return copy;
              });

              const results = await retrieveContext(query);
              allContexts.push(...results);
              searchQueries[searchQueries.length - 1].resultCount = results.length;

              setMessages(prev => {
                const copy = [...prev];
                copy[copy.length - 1] = {
                  ...copy[copy.length - 1],
                  agentStatus: null,
                  searchQueries: [...searchQueries],
                };
                return copy;
              });

              const resultText = results.length > 0
                ? results.map((c, i) => `[資料${i + 1}: ${c.docName}]\n${c.chunk}`).join('\n\n')
                : '関連する資料が見つかりませんでした。';
              apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });

            } else if (fnName === 'search_persistent_documents') {
              // 永続RAG: サーバー側 ml/rag/ に登録済みのドキュメントから embedding 検索
              const query = fnArgs.query || text;
              searchQueries.push({ query: `永続RAG検索: ${query}`, resultCount: null, type: 'rag' });

              setMessages(prev => {
                const copy = [...prev];
                copy[copy.length - 1] = {
                  ...copy[copy.length - 1],
                  agentStatus: `📚 永続RAG検索「${query}」中...`,
                  searchQueries: [...searchQueries],
                };
                return copy;
              });

              let ragResults = [];
              let ragError = null;
              try {
                const res = await fetch('/rag/search', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  // topK は config.ragTopK を尊重する (以前は 5 固定で設定が効いていなかった)。
                  // neighbors は省略してサーバー側の config.ragNeighborChunks に委ねる。
                  body: JSON.stringify({ query, topK: appConfig.ragTopK || 10 }),
                });
                if (res.ok) {
                  const data = await res.json();
                  ragResults = data.results || [];
                } else {
                  const data = await res.json().catch(() => ({}));
                  ragError = data.error || `HTTP ${res.status}`;
                }
              } catch (e) {
                ragError = e.message;
              }
              searchQueries[searchQueries.length - 1].resultCount = ragResults.length;

              setMessages(prev => {
                const copy = [...prev];
                copy[copy.length - 1] = {
                  ...copy[copy.length - 1],
                  agentStatus: null,
                  searchQueries: [...searchQueries],
                };
                return copy;
              });

              let ragResultText;
              if (ragError) {
                ragResultText = `永続RAG検索エラー: ${ragError}`;
              } else if (ragResults.length === 0) {
                ragResultText = 'サーバー登録ドキュメントから関連する情報は見つかりませんでした。';
              } else {
                // 出典は ASCII の短いキー (S1, S2, …) で書かせる。
                // 日本語の資料名を転写させると「テラメカニックス」が
                // 「テラメカニンクス」「テラメカロニク ス」等に毎回崩れるため
                // (Qwen3.6 で確認)。実際のファイル名とページは画面側が
                // ragSources から描くので、モデルを経由しない。
                const citations = [];
                ragResultText = ragResults.map((r, i) => {
                  const s = ragSourceKey(r);
                  const cite = `【${s.key}】`;
                  citations.push(cite);
                  return `── 資料 ${s.key} ──\n`
                    + `出典キー: ${s.key}   (${s.label}${s.pageText ? ' p.' + s.pageText : ''})   類似度: ${r.score.toFixed(3)}\n`
                    + `${r.text}\n`
                    + `── ここまでが ${s.key} の内容 ──`;
                }).join('\n\n');
                ragResultText += '\n\n════\n'
                  + '上記を回答に使うときは、各記述の末尾に出典キーを書いてください。\n'
                  + '使用できる出典キー: ' + citations.join(' / ') + '\n'
                  + '【S1】のように、キーだけを【】で囲んで書いてください。'
                  + '資料名やページ番号を自分で書き足さないでください（画面側が対応表を表示します）。\n'
                  + '角括弧と丸括弧を並べたリンク記法（[...](...)）で書いてはいけません。\n'
                  + 'ここに無いキーを書いてはいけません。章や節の番号を推測で書くことも禁止です。';
              }
              // 出典の対応表をメッセージに持たせる。表示はモデルの出力ではなく
              // このデータから描くので、資料名が書き崩されることがない
              if (ragSourceRegistry.length > 0) {
                setMessages(prev => {
                  const copy = [...prev];
                  copy[copy.length - 1] = {
                    ...copy[copy.length - 1],
                    ragSources: ragSourceRegistry.map(s => ({ ...s })),
                  };
                  return copy;
                });
              }
              apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: ragResultText });

            } else if (fnName === 'detect_objects') {
              // 添付画像の物体検出 (Phase 1 の /ml/image/detect を再利用)
              const th = typeof fnArgs.threshold === 'number' ? fnArgs.threshold : 0.5;
              searchQueries.push({ query: '画像の物体検出', resultCount: null, type: 'image' });
              setMessages(prev => {
                const copy = [...prev];
                copy[copy.length - 1] = { ...copy[copy.length - 1], agentStatus: '🖼️ 画像の物体検出中...', searchQueries: [...searchQueries] };
                return copy;
              });

              let detectText;
              try {
                if (!pendingImages || pendingImages.length === 0) {
                  detectText = '画像が添付されていません。物体検出には画像の添付が必要です。';
                } else {
                  // 最初の画像を検出対象にする
                  const img0 = pendingImages[0];
                  const dataUrl = img0.base64.startsWith('data:')
                    ? img0.base64
                    : `data:image/png;base64,${img0.base64}`;
                  const res = await fetch('/ml/image/detect', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image: dataUrl, threshold: th }),
                  });
                  const data = await res.json();
                  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

                  if (data.count === 0) {
                    detectText = `物体は検出されませんでした (しきい値 ${th})。画像サイズ: ${data.imageWidth}×${data.imageHeight}`;
                  } else {
                    // クラス別に集計
                    const summary = {};
                    data.detections.forEach(d => { summary[d.label] = (summary[d.label] || 0) + 1; });
                    const summaryText = Object.entries(summary)
                      .map(([cls, n]) => `${cls} × ${n}`).join('、');
                    // 詳細 (上位10件)
                    const detailText = data.detections.slice(0, 10).map((d, i) =>
                      `${i + 1}. ${d.label} (信頼度 ${(d.score * 100).toFixed(0)}%, 位置 [${Math.round(d.box.x1)},${Math.round(d.box.y1)}]-[${Math.round(d.box.x2)},${Math.round(d.box.y2)}])`
                    ).join('\n');
                    detectText = `検出結果 (${data.count}個): ${summaryText}\n\n詳細:\n${detailText}\n\n画像サイズ: ${data.imageWidth}×${data.imageHeight}、使用デバイス: ${data.device}`;
                  }
                  searchQueries[searchQueries.length - 1].resultCount = data.count;
                }
              } catch (e) {
                detectText = `物体検出エラー: ${e.message}`;
              }

              setMessages(prev => {
                const copy = [...prev];
                copy[copy.length - 1] = { ...copy[copy.length - 1], agentStatus: null, searchQueries: [...searchQueries] };
                return copy;
              });
              apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: detectText });

            } else if (fnName === 'web_search') {
              const query = fnArgs.query || text;
              searchQueries.push({ query: `Web検索: ${query}`, resultCount: null, type: 'web' });

              setMessages(prev => {
                const copy = [...prev];
                copy[copy.length - 1] = {
                  ...copy[copy.length - 1],
                  agentStatus: `🌐 Web検索「${query}」中...`,
                  searchQueries: [...searchQueries],
                };
                return copy;
              });

              let webResults = [];
              try {
                const res = await fetch(`/web-search?q=${encodeURIComponent(query)}&n=5`);
                if (res.ok) {
                  const data = await res.json();
                  webResults = data.results || [];
                }
              } catch {}
              searchQueries[searchQueries.length - 1].resultCount = webResults.length;

              setMessages(prev => {
                const copy = [...prev];
                copy[copy.length - 1] = {
                  ...copy[copy.length - 1],
                  agentStatus: null,
                  searchQueries: [...searchQueries],
                };
                return copy;
              });

              const resultText = webResults.length > 0
                ? webResults.map((r, i) => {
                    let entry = `[Web${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`;
                    if (r.body) entry += `\n--- 本文抜粋 ---\n${r.body}`;
                    return entry;
                  }).join('\n\n===\n\n')
                : 'Web検索結果が見つかりませんでした。';
              apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });

            } else if (fnName && fnName.startsWith('gdrive_')) {
              // ─── Google Drive 系ツール ───
              // 進捗表示・エラー整形・結果の圧縮を1か所にまとめる。
              // LLM には「次に何ができるか」が伝わる形 (id を含む一覧) で返す。
              const gdLabel = {
                gdrive_search_files: '🔍 GDrive を検索',
                gdrive_list_files: '📂 GDrive を一覧',
                gdrive_read_file: '📄 GDrive のファイルを読み込み',
                gdrive_import_to_server: '⬇️ GDrive からサーバーへ取り込み',
                gdrive_write_file: '✍️ GDrive に書き込み',
                gdrive_upload_from_server: '⬆️ サーバーから GDrive へアップロード',
                gdrive_create_folder: '📁 GDrive にフォルダ作成',
                gdrive_delete_file: '🗑️ GDrive のファイルを削除',
              }[fnName] || 'GDrive 操作';

              const gdArgLabel = fnArgs.query || fnArgs.name || fnArgs.fileId || fnArgs.path || fnArgs.folderId || '';
              searchQueries.push({
                query: `GDrive: ${gdLabel.replace(/^\S+\s/, '')}${gdArgLabel ? `「${String(gdArgLabel).slice(0, 40)}」` : ''}`,
                resultCount: null, type: 'gdrive',
              });
              setMessages(prev => {
                const copy = [...prev];
                copy[copy.length - 1] = {
                  ...copy[copy.length - 1],
                  agentStatus: `${gdLabel}${gdArgLabel ? `「${String(gdArgLabel).slice(0, 30)}」` : ''}中...`,
                  searchQueries: [...searchQueries],
                };
                return copy;
              });

              let gdResultText = '';
              let gdCount = 0;
              let gdReadName = '';   // 「参照した資料」に出すファイル名
              let gdReadLink = '';   // GDrive で開くリンク
              try {
                // ファイルIDの引数名ゆれを吸収 (モデルによって fileId / id / file / name)
                const rawFileRef = fnArgs.fileId || fnArgs.id || fnArgs.file || fnArgs.name || '';
                // 直近の検索/一覧の結果を使って、番号・ファイル名・崩れたIDを実IDに直す
                const resolved = resolveGdriveFileRef(rawFileRef, gdriveRecentRef.current);
                const fileId = resolved.id;
                const idNote = resolved.note;
                if (idNote) console.log(`[gdrive] ファイル参照を解決: "${rawFileRef}" ${idNote}`);
                const folderId = fnArgs.folderId || fnArgs.folder || fnArgs.folder_id || '';

                // 一覧結果を LLM 向けの行に整形するヘルパー。
                // ID の写し間違いが多いので通し番号を振り、番号でも指定できるようにする。
                const rememberFiles = (files) => {
                  const seen = gdriveRecentRef.current.seen;
                  files.forEach(f => seen.set(f.id, f.name));
                  // 覚えすぎないよう古いものから捨てる
                  if (seen.size > 300) {
                    const keys = [...seen.keys()].slice(0, seen.size - 300);
                    keys.forEach(k => seen.delete(k));
                  }
                  gdriveRecentRef.current.list = files.map(f => ({ id: f.id, name: f.name }));
                };
                const fmtFiles = (files) => files.map((f, i) =>
                  `${i + 1}. ${f.isFolder ? '[フォルダ] ' : ''}${f.name}\n   id: ${f.id}\n   種類: ${f.mimeType}` +
                  `${f.size ? ` / ${formatBytes(f.size)}` : ''}` +
                  `${f.modifiedTime ? ` / 更新: ${new Date(f.modifiedTime).toLocaleString('ja-JP')}` : ''}` +
                  `${f.readableAsText ? ' / テキストとして読める' : ''}`
                ).join('\n');
                const PICK_HINT = '\n\n次にこの中のファイルを読むときは、gdrive_read_file の fileId に'
                  + '【上の id をそのまま】渡してください。IDを写し間違えやすい場合は、'
                  + '代わりに【通し番号 (1, 2, 3...)】や【ファイル名】を渡しても構いません。';

                if (fnName === 'gdrive_search_files') {
                  const p = new URLSearchParams({ q: fnArgs.query || text });
                  if (folderId) p.set('folderId', folderId);
                  const res = await fetch(`/gdrive/search?${p.toString()}`);
                  const data = await res.json().catch(() => ({}));
                  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
                  const files = data.files || [];
                  gdCount = files.length;
                  rememberFiles(files);
                  gdResultText = files.length > 0
                    ? `Google Drive の検索結果 (${files.length}件):\n${fmtFiles(files)}${PICK_HINT}`
                    : 'Google Drive に該当するファイルは見つかりませんでした。別のキーワードを試すか、gdrive_list_files でフォルダを確認してください。';

                } else if (fnName === 'gdrive_list_files') {
                  const p = new URLSearchParams();
                  if (folderId) p.set('folderId', folderId);
                  if (fnArgs.query) p.set('q', fnArgs.query);
                  const res = await fetch(`/gdrive/files?${p.toString()}`);
                  const data = await res.json().catch(() => ({}));
                  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
                  const files = data.files || [];
                  gdCount = files.length;
                  rememberFiles(files);
                  gdResultText = files.length > 0
                    ? `Google Drive フォルダ (id: ${data.folderId}) の内容 (${files.length}件):\n${fmtFiles(files)}${PICK_HINT}`
                    : 'このフォルダは空です。';

                } else if (fnName === 'gdrive_read_file') {
                  if (!fileId) throw new Error('fileId が指定されていません。先に gdrive_search_files でファイルを特定してください');
                  const res = await fetch(`/gdrive/files/${encodeURIComponent(fileId)}/content`);
                  const data = await res.json().catch(() => ({}));
                  if (!res.ok) {
                    // ID が違った場合、モデルが自力で立て直せるよう選択肢を添える。
                    // ここで候補を出さないと「IDが違ったのでもう一度…」を繰り返して
                    // ツールのターンを使い切り、回答にたどり着けなくなる。
                    const known = gdriveRecentRef.current.list;
                    const choices = known.length > 0
                      ? '\n\n直前の検索/一覧で見つかっているファイルは次のとおりです。'
                        + '【この中から選び、通し番号かファイル名で指定してください】(IDを写し直す必要はありません):\n'
                        + known.map((f, i) => `${i + 1}. ${f.name}`).join('\n')
                      : '\n\nまず gdrive_search_files でファイルを探してください。';
                    throw new Error((data.error || `HTTP ${res.status}`) + choices);
                  }
                  gdCount = 1;
                  gdReadName = data.name || '';
                  gdReadLink = data.webViewLink || '';
                  gdResultText = `Google Drive のファイル「${data.name}」の内容`
                    + `${idNote ? ' ' + idNote : ''}`
                    + `${data.exported ? ' (Google形式から自動変換)' : ''}`
                    + `${data.truncated ? ` (全${data.totalChars}文字のうち先頭${data.content.length}文字)` : ''}`
                    + `:\n\`\`\`\n${data.content}\n\`\`\``;

                } else if (fnName === 'gdrive_import_to_server') {
                  if (!fileId) throw new Error('fileId が指定されていません');
                  const res = await fetch('/gdrive/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fileId, savePath: fnArgs.savePath }),
                  });
                  const data = await res.json().catch(() => ({}));
                  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
                  gdCount = 1;
                  gdResultText = `Google Drive から uploads/${data.path} に取り込みました (${data.size}バイト, ${data.mimeType})。`
                    + ' このファイルは read_file や Python コードから参照できます。';
                  loadFileList();

                } else if (fnName === 'gdrive_write_file') {
                  let gcontent = fnArgs.content ?? fnArgs.data ?? fnArgs.text ?? '';
                  if (typeof gcontent === 'object') gcontent = JSON.stringify(gcontent, null, 2);
                  const res = await fetch('/gdrive/files', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      name: fnArgs.name, content: String(gcontent),
                      folderId: folderId || undefined,
                      fileId: fnArgs.fileId || undefined,
                      overwrite: !!fnArgs.overwrite,
                    }),
                  });
                  const data = await res.json().catch(() => ({}));
                  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
                  gdCount = 1;
                  gdResultText = `Google Drive に「${data.name}」を${data.updated ? '更新' : '作成'}しました (${data.bytes}バイト)。`
                    + `${data.webViewLink ? `\nURL: ${data.webViewLink}` : ''}`;

                } else if (fnName === 'gdrive_upload_from_server') {
                  const res = await fetch('/gdrive/export', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      path: fnArgs.path, name: fnArgs.name,
                      folderId: folderId || undefined, overwrite: true,
                    }),
                  });
                  const data = await res.json().catch(() => ({}));
                  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
                  gdCount = 1;
                  gdResultText = `uploads/${fnArgs.path} を Google Drive に「${data.name}」としてアップロードしました。`
                    + `${data.webViewLink ? `\nURL: ${data.webViewLink}` : ''}`;

                } else if (fnName === 'gdrive_create_folder') {
                  const res = await fetch('/gdrive/folders', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: fnArgs.name, folderId: folderId || undefined }),
                  });
                  const data = await res.json().catch(() => ({}));
                  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
                  gdCount = 1;
                  gdResultText = `Google Drive にフォルダ「${data.name}」を作成しました (id: ${data.id})。`;

                } else if (fnName === 'gdrive_delete_file') {
                  if (!fileId) throw new Error('fileId が指定されていません');
                  const res = await fetch(`/gdrive/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
                  const data = await res.json().catch(() => ({}));
                  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
                  gdCount = 1;
                  gdResultText = `Google Drive のファイル「${data.name || fileId}」をゴミ箱に移動しました。`;

                } else {
                  gdResultText = `未対応の Google Drive ツールです: ${fnName}`;
                }
              } catch (e) {
                console.error(`[${fnName}] エラー:`, e);
                gdResultText = `Google Drive の操作に失敗しました: ${e.message}`;
                gdCount = 0;
              }

              searchQueries[searchQueries.length - 1].resultCount = gdCount;
              setMessages(prev => {
                const copy = [...prev];
                copy[copy.length - 1] = { ...copy[copy.length - 1], agentStatus: null, searchQueries: [...searchQueries] };
                return copy;
              });
              // Drive の一覧結果はコンテキストを食うので上限を設ける
              const GDRIVE_RESULT_MAX = 24000;
              if (gdResultText.length > GDRIVE_RESULT_MAX) {
                gdResultText = gdResultText.slice(0, GDRIVE_RESULT_MAX) + '\n... (以降省略)';
              }
              // 一覧・検索の結果は「資料」としても保持し、最終応答で参照できるようにする
              if (fnName === 'gdrive_read_file' && gdCount > 0) {
                // 「参照した資料」には ID ではなくファイル名を出す。
                // 類似度スコアは無い (ベクトル検索ではなく直接読み込んでいる) ので付けない。
                allContexts.push({
                  docName: gdReadName || 'GDrive のファイル',
                  source: 'GDrive',
                  url: gdReadLink || null,
                  chunk: gdResultText.slice(0, 8000),
                });
              }
              apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: gdResultText });

            } else if (fnName === 'list_files') {
              searchQueries.push({ query: 'サーバーファイル一覧', resultCount: null, type: 'file' });
              setMessages(prev => {
                const copy = [...prev];
                copy[copy.length - 1] = { ...copy[copy.length - 1], agentStatus: '📁 サーバーファイル一覧を取得中...', searchQueries: [...searchQueries] };
                return copy;
              });
              let files = [];
              try {
                const res = await fetch('/files');
                if (res.ok) files = (await res.json()).files || [];
              } catch {}
              searchQueries[searchQueries.length - 1].resultCount = files.length;
              setMessages(prev => {
                const copy = [...prev];
                copy[copy.length - 1] = { ...copy[copy.length - 1], agentStatus: null, searchQueries: [...searchQueries] };
                return copy;
              });
              const resultText = files.length > 0
                ? files.map(f => `${f.path} (${f.size}バイト, ${f.modified})`).join('\n')
                : 'uploadsフォルダは空です。';
              apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });

            } else if (fnName === 'read_file') {
              const fpath = fnArgs.path || fnArgs.filename || fnArgs.file || fnArgs.filepath || '';
              searchQueries.push({ query: `サーバーファイル読込: ${fpath}`, resultCount: null, type: 'file' });
              setMessages(prev => {
                const copy = [...prev];
                copy[copy.length - 1] = { ...copy[copy.length - 1], agentStatus: `📖 サーバーファイル「${fpath}」を読み込み中...`, searchQueries: [...searchQueries] };
                return copy;
              });
              let content = null, error = null;
              try {
                const res = await fetch(`/files/${encodeURI(fpath)}`);
                if (res.ok) {
                  const data = await res.json();
                  content = data.content;
                } else {
                  const data = await res.json().catch(() => ({}));
                  error = data.error || `HTTP ${res.status}`;
                }
              } catch (e) { error = e.message; }
              searchQueries[searchQueries.length - 1].resultCount = content != null ? 1 : 0;
              setMessages(prev => {
                const copy = [...prev];
                copy[copy.length - 1] = { ...copy[copy.length - 1], agentStatus: null, searchQueries: [...searchQueries] };
                return copy;
              });
              const resultText = content != null
                ? `ファイル「${fpath}」の内容:\n\`\`\`\n${content}\n\`\`\``
                : `ファイル「${fpath}」の読み込みに失敗: ${error}`;
              apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });

            } else if (fnName === 'write_file') {
              const fpath = fnArgs.path || fnArgs.filename || fnArgs.file || fnArgs.filepath || '';
              let fcontent = fnArgs.content ?? fnArgs.data ?? fnArgs.text ?? fnArgs.body ?? '';
              // オブジェクトで渡された場合はJSON文字列化
              if (typeof fcontent === 'object') fcontent = JSON.stringify(fcontent, null, 2);
              if (typeof fcontent !== 'string') fcontent = String(fcontent);

              // デバッグログ
              console.log(`[write_file] path="${fpath}", content size=${fcontent.length}, args keys=`, Object.keys(fnArgs));

              // パスが空の場合は早期エラー
              if (!fpath || fpath.trim() === '') {
                console.error('[write_file] パスが空のためスキップ');
                searchQueries.push({ query: `サーバーファイル書込: (パスなし)`, resultCount: 0, type: 'file' });
                apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: '書き込みエラー: ファイルパスが指定されていません。' });
                continue;
              }

              // コンテンツサイズ上限チェック (10MB)
              const MAX_CONTENT_SIZE = 10 * 1024 * 1024;
              if (fcontent.length > MAX_CONTENT_SIZE) {
                console.error(`[write_file] コンテンツが大きすぎます: ${fcontent.length} bytes`);
                searchQueries.push({ query: `サーバーファイル書込: ${fpath}`, resultCount: 0, type: 'file' });
                apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: `書き込みエラー: コンテンツが大きすぎます (${fcontent.length} bytes、上限10MB)` });
                continue;
              }

              searchQueries.push({ query: `サーバーファイル書込: ${fpath}`, resultCount: null, type: 'file' });
              setMessages(prev => {
                const copy = [...prev];
                copy[copy.length - 1] = { ...copy[copy.length - 1], agentStatus: `✍️ サーバーファイル「${fpath}」に書き込み中...`, searchQueries: [...searchQueries] };
                return copy;
              });
              let ok = false, error = null, size = 0;
              try {
                // 30秒タイムアウト付きfetch
                const writeCtrl = new AbortController();
                const writeTimer = setTimeout(() => writeCtrl.abort(), 30000);
                console.log(`[write_file] fetch開始: /files/${fpath}`);
                const res = await fetch(`/files/${encodeURI(fpath)}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ content: fcontent }),
                  signal: writeCtrl.signal,
                });
                clearTimeout(writeTimer);
                console.log(`[write_file] fetch完了: status=${res.status}`);
                const data = await res.json().catch(() => ({}));
                if (res.ok) { ok = true; size = data.size || 0; }
                else error = data.error || `HTTP ${res.status}`;
              } catch (e) {
                console.error('[write_file] エラー:', e);
                error = e.name === 'AbortError' ? 'タイムアウト(30秒)' : e.message;
              }
              searchQueries[searchQueries.length - 1].resultCount = ok ? 1 : 0;
              setMessages(prev => {
                const copy = [...prev];
                copy[copy.length - 1] = { ...copy[copy.length - 1], agentStatus: null, searchQueries: [...searchQueries] };
                return copy;
              });
              const resultText = ok
                ? `ファイル「${fpath}」に${size}バイト書き込みました。`
                : `書き込みに失敗: ${error}`;
              apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });
              // ファイル一覧を再読み込み
              loadFileList();
            } else if (fnName === 'generate_image') {
              const prompt = fnArgs.prompt || '';
              const negativePrompt = fnArgs.negative_prompt || fnArgs.negativePrompt || '';
              const width = Number(fnArgs.width) || 1024;
              const height = Number(fnArgs.height) || 1024;
              const steps = Number(fnArgs.steps) || 20;
              const count = Math.min(Math.max(Number(fnArgs.count) || 1, 1), 4);

              if (!prompt.trim()) {
                apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: 'プロンプトが指定されていません。' });
                continue;
              }

              searchQueries.push({ query: `画像生成: ${prompt.slice(0, 50)}`, resultCount: null, type: 'image' });
              setMessages(prev => {
                const copy = [...prev];
                copy[copy.length - 1] = {
                  ...copy[copy.length - 1],
                  agentStatus: `🎨 画像生成中: "${prompt.slice(0, 40)}..."（数十秒かかります）`,
                  searchQueries: [...searchQueries],
                };
                return copy;
              });

              try {
                // 画像生成は時間がかかるので長めのタイムアウト (5分)
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 300000);
                console.log(`[generate_image] リクエスト送信: prompt="${prompt}", w=${width}, h=${height}, steps=${steps}, count=${count}`);
                const res = await fetch('/image-gen', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    prompt, negativePrompt, width, height, steps, batchCount: count,
                  }),
                  signal: ctrl.signal,
                });
                clearTimeout(timer);
                const data = await res.json();
                console.log(`[generate_image] レスポンス: status=${res.status}`, data);
                if (!res.ok) throw new Error(data.error || `生成失敗 (HTTP ${res.status})`);
                if (!data.images || data.images.length === 0) {
                  throw new Error('画像が返されませんでした (images=空)');
                }

                searchQueries[searchQueries.length - 1].resultCount = data.images.length;

                // 実URLを記録（最終応答でマーカーを確定させるため）
                data.images.forEach((url) => generatedImages.push({ url, prompt }));

                // 生成画像はカスタムマーカー [[gen_image:URL|prompt]] で返す
                // LLMがそのまま応答に含めて出力 → MarkdownContent側でパースして <GeneratedImage> 描画
                const imageMarkers = data.images.map((url) => {
                  const encoded = encodeURIComponent(prompt);
                  return `[[gen_image:${url}|${encoded}]]`;
                }).join('\n\n');
                const summary = `画像を ${data.images.length} 枚生成しました（${data.elapsed}秒、モデル: ${data.model}）。\n\n${imageMarkers}\n\n` +
                                `重要: 上記の [[gen_image:...]] マーカーを、必ずそのまま改変せずに最終応答にコピーして含めてください。これは画像を表示するための重要なタグです。あなたは「ご依頼の通り、〇〇の画像を生成しました。」のような1〜2文のコメントを添えるだけで結構です。マーカーを忘れずに含めてください。`;
                apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: summary });
              } catch (e) {
                const errMsg = e.name === 'AbortError' ? 'タイムアウト（5分超過）' : e.message;
                console.error(`[generate_image] エラー:`, e);
                searchQueries[searchQueries.length - 1].resultCount = 0;
                apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: `画像生成失敗: ${errMsg}\n\nユーザーに「画像生成サーバーがまだ起動中の可能性があります。1〜2分待ってからもう一度お試しください」と伝えてください。` });
              } finally {
                setMessages(prev => {
                  const copy = [...prev];
                  copy[copy.length - 1] = { ...copy[copy.length - 1], agentStatus: null, searchQueries: [...searchQueries] };
                  return copy;
                });
              }
            } else if (fnName === 'generate_speech') {
              const ttsText = (fnArgs.text || '').trim();
              const ttsVoice = fnArgs.voice || fnArgs.instructions || '';
              const ttsSpeed = Number(fnArgs.speed) || undefined;

              if (!ttsText) {
                apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: '音声化するテキストが指定されていません。' });
                continue;
              }

              searchQueries.push({ query: `音声合成: ${ttsText.slice(0, 40)}`, resultCount: null, type: 'audio' });
              setMessages(prev => {
                const copy = [...prev];
                copy[copy.length - 1] = {
                  ...copy[copy.length - 1],
                  agentStatus: `🔊 音声生成中: "${ttsText.slice(0, 30)}..."`,
                  searchQueries: [...searchQueries],
                };
                return copy;
              });

              try {
                // 音声合成は時間がかかるので長めのタイムアウト (5分)
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 300000);
                console.log(`[generate_speech] リクエスト送信: text="${ttsText}", voice="${ttsVoice}", speed=${ttsSpeed}`);
                const res = await fetch('/tts', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ text: ttsText, voice: ttsVoice, speed: ttsSpeed }),
                  signal: ctrl.signal,
                });
                clearTimeout(timer);
                const data = await res.json();
                console.log(`[generate_speech] レスポンス: status=${res.status}`, data);
                if (!res.ok) throw new Error(data.error || `生成失敗 (HTTP ${res.status})`);
                if (!data.url) throw new Error('音声が返されませんでした');

                searchQueries[searchQueries.length - 1].resultCount = 1;

                // 実URLを記録（最終応答でマーカーを確定させるため）
                generatedAudios.push({ url: data.url, text: ttsText });

                // 生成音声はカスタムマーカー [[gen_audio:URL|encodedText]] で返す
                // LLMがそのまま応答に含めて出力 → MarkdownContent側でパースして <GeneratedAudio> 描画
                const encoded = encodeURIComponent(ttsText);
                const marker = `[[gen_audio:${data.url}|${encoded}]]`;
                const summary = `音声を生成しました（${data.elapsed}秒、声: ${data.voice}${data.caption ? `, 指定: ${data.caption}` : ''}）。\n\n${marker}\n\n` +
                                `重要: 上記の [[gen_audio:...]] マーカーを、必ずそのまま改変せずに最終応答にコピーして含めてください。これは音声プレーヤーを表示するための重要なタグです。「ご依頼の音声を生成しました。」のような1〜2文のコメントを添えるだけで結構です。マーカーを忘れずに含めてください。`;
                apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: summary });
              } catch (e) {
                const errMsg = e.name === 'AbortError' ? 'タイムアウト（5分超過）' : e.message;
                console.error(`[generate_speech] エラー:`, e);
                searchQueries[searchQueries.length - 1].resultCount = 0;
                apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: `音声生成失敗: ${errMsg}\n\nユーザーに「音声合成サーバーがまだ起動中の可能性があります。1〜2分待ってからもう一度お試しください」と伝えてください。` });
              } finally {
                setMessages(prev => {
                  const copy = [...prev];
                  copy[copy.length - 1] = { ...copy[copy.length - 1], agentStatus: null, searchQueries: [...searchQueries] };
                  return copy;
                });
              }
            } else if (fnName === 'ml_list_datasets' || fnName === 'ml_describe_dataset' || fnName === 'ml_query_dataset'
                       || fnName === 'ml_list_models' || fnName === 'ml_predict') {
              // 機械学習用データテーブルへの読み取り専用アクセス + モデル推論
              const label =
                  fnName === 'ml_list_datasets' ? 'データテーブル一覧'
                : fnName === 'ml_describe_dataset' ? `スキーマ: ${fnArgs.table || ''}`
                : fnName === 'ml_query_dataset' ? `SQL: ${(fnArgs.sql || '').slice(0, 80)}`
                : fnName === 'ml_list_models' ? 'モデル一覧'
                : `予測: ${fnArgs.modelName || ''}`;
              searchQueries.push({ type: 'data', query: label, resultCount: 0 });
              setMessages(prev => {
                const copy = [...prev];
                copy[copy.length - 1] = { ...copy[copy.length - 1], agentStatus: `🗂️ ${label}`, searchQueries: [...searchQueries] };
                return copy;
              });

              try {
                let result;
                if (fnName === 'ml_list_datasets') {
                  const r = await fetch('/ml/datasets', { signal: controller.signal });
                  const data = await r.json();
                  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
                  result = data;
                  searchQueries[searchQueries.length - 1].resultCount = data.tables?.length || 0;
                } else if (fnName === 'ml_describe_dataset') {
                  const table = fnArgs.table;
                  if (!table) throw new Error('table パラメータが必要です');
                  const r = await fetch(`/ml/datasets/${encodeURIComponent(table)}/schema`, { signal: controller.signal });
                  const data = await r.json();
                  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
                  result = data;
                  searchQueries[searchQueries.length - 1].resultCount = data.columns?.length || 0;
                } else if (fnName === 'ml_query_dataset') {
                  if (!fnArgs.sql) throw new Error('sql パラメータが必要です');
                  const r = await fetch('/ml/query', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sql: fnArgs.sql, limit: fnArgs.limit }),
                    signal: controller.signal,
                  });
                  const data = await r.json();
                  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
                  result = data;
                  searchQueries[searchQueries.length - 1].resultCount = data.count || 0;
                } else if (fnName === 'ml_list_models') {
                  const r = await fetch('/ml/models', { signal: controller.signal });
                  const data = await r.json();
                  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
                  // 学習済みのみを返却 + 重要情報のみ抜き出し (LLMに渡す情報量を減らす)
                  const trainedModels = (data.models || []).filter(m => m.trained).map(m => ({
                    name: m.name,
                    task: m.task,
                    tableName: m.tableName,
                    features: m.features,
                    target: m.target,
                    description: m.description,
                    metrics: m.metrics ? {
                      mae: m.metrics.finalMAE,
                      accuracy: m.metrics.finalAccuracy,
                      testLoss: m.metrics.finalTestLoss,
                      trainSamples: m.metrics.trainSamples,
                      testSamples: m.metrics.testSamples,
                    } : null,
                    // 推論時の正しい呼び方をLLMが分かるように
                    predictHint: m.predictHint || null,
                  }));
                  result = { models: trainedModels, count: trainedModels.length };
                  searchQueries[searchQueries.length - 1].resultCount = trainedModels.length;
                } else {
                  // ml_predict
                  const modelName = fnArgs.modelName;
                  if (!modelName) throw new Error('modelName が必要です');
                  if (fnArgs.features === undefined) throw new Error('features が必要です');

                  // ⚠️ LLM が派生列 (date_year, date_month, ...) を直接渡してしまう問題への対処
                  // → 派生列を検知して元の日付文字列に自動復元
                  // features が配列の場合も対応
                  const sanitizeFeatures = (f) => {
                    if (!f || typeof f !== 'object') return f;
                    if (Array.isArray(f)) return f.map(sanitizeFeatures);
                    const out = { ...f };
                    // 派生列のグループを検出 (例: date_year, date_month, date_day → date)
                    const dateCols = new Set();
                    for (const k of Object.keys(out)) {
                      const m = k.match(/^([a-zA-Z][a-zA-Z0-9]*)_(year|month|day|dayofweek|dayofyear|is_weekend)$/);
                      if (m) dateCols.add(m[1]);
                    }
                    for (const dc of dateCols) {
                      // 元の日時列が既にあるなら派生列削除のみ
                      if (out[dc] !== undefined && out[dc] !== null && out[dc] !== '') {
                        for (const suf of ['year', 'month', 'day', 'dayofweek', 'dayofyear', 'is_weekend']) {
                          delete out[`${dc}_${suf}`];
                        }
                        continue;
                      }
                      // 派生列から日付を復元 (year + month + day が必須)
                      const y = out[`${dc}_year`];
                      const mo = out[`${dc}_month`];
                      const d = out[`${dc}_day`];
                      if (y !== undefined && mo !== undefined && d !== undefined) {
                        const dateStr = `${parseInt(y)}-${String(parseInt(mo)).padStart(2, '0')}-${String(parseInt(d)).padStart(2, '0')}`;
                        out[dc] = dateStr;
                        console.log(`[ml_predict 入力修正] 派生列 ${dc}_year/${dc}_month/${dc}_day から ${dc}="${dateStr}" を復元`);
                      }
                      for (const suf of ['year', 'month', 'day', 'dayofweek', 'dayofyear', 'is_weekend']) {
                        delete out[`${dc}_${suf}`];
                      }
                    }
                    return out;
                  };
                  const sanitizedFeatures = sanitizeFeatures(fnArgs.features);

                  const r = await fetch(`/ml/models/${encodeURIComponent(modelName)}/predict`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ features: sanitizedFeatures }),
                    signal: controller.signal,
                  });
                  const data = await r.json();
                  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
                  result = data;
                  searchQueries[searchQueries.length - 1].resultCount = data.count || (data.predictions?.length || 0);
                }
                // ツール結果を LLM に返す。大きすぎる場合は先頭部分のみ
                let content = JSON.stringify(result, null, 2);
                if (content.length > 50000) {
                  content = content.slice(0, 50000) + '\n... (結果が大きいため省略。LIMIT句で絞り込んでください)';
                }
                apiMessages.push({ role: 'tool', tool_call_id: tc.id, content });
              } catch (e) {
                console.error(`[${fnName}] エラー:`, e);
                apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: `エラー: ${e.message}` });
              } finally {
                setMessages(prev => {
                  const copy = [...prev];
                  copy[copy.length - 1] = { ...copy[copy.length - 1], agentStatus: null, searchQueries: [...searchQueries] };
                  return copy;
                });
              }
            }
          }
          // ループ先頭に戻って次のツール判断を試みる
        } // end while tool turn

        if (toolTurn >= MAX_TOOL_TURNS && lastAssistantMsg?.tool_calls?.length > 0) {
          console.log(`[ツール実行] 最大${MAX_TOOL_TURNS}ターンに到達。最終応答へ移行。`);
        }

        // コンテキスト重複除去
        const seen = new Set();
        const uniqueContexts = allContexts.filter(c => {
          const key = c.docName + '::' + c.chunk.slice(0, 50);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        const contextInfo = uniqueContexts.length > 0 ? uniqueContexts : null;

        // ステップ3: 最終ストリーミング応答（toolsなしで即座にストリーム）
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = {
            role: 'assistant', content: '', thinking: '',
            contexts: contextInfo,
            agentStatus: searchQueries.length > 0 ? '回答生成中...' : null,
            searchQueries: searchQueries,
          };
          return copy;
        });

        const finalRes = await fetchWithRetry('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: chatModel,
            messages: apiMessages,
            stream: true,
            stream_options: { include_usage: true },
            ...llamaCommonOptions,
          }),
          signal: controller.signal,
        });

        if (!finalRes.ok) throw new Error(`API Error: ${finalRes.status}`);
        await streamResponse(finalRes, contextInfo, searchQueries, { audios: generatedAudios, images: generatedImages });

        // ─── 空応答の救済処理 ───
        // ツール呼び出し後の最終応答が空になることがある (Qwen3 系で稀に発生)
        // → 「分からない場合は理由を説明してほしい」と明示プロンプト追加して再生成
        // (LLMが回答を作れなかった = データ不足/モデル限界/質問の曖昧さ等 を率直に伝えてもらう)
        {
          const lastMsg = await new Promise(resolve => {
            setMessages(prev => { resolve(prev[prev.length - 1]); return prev; });
          });
          const lastContent = (lastMsg?.content || '').trim();
          const hasToolResultInHistory = apiMessages.some(m => m.role === 'tool');
          if (hasToolResultInHistory && lastContent.length < 5) {
            console.log('[空応答救済] ツール実行後の応答が空 → 理由説明モードで再生成');
            // 「分からない時は分からないと言って」「データ不足なら何が必要か説明して」と明示
            const retryMessages = [
              ...apiMessages,
              {
                role: 'user',
                content:
                  '上記のツール実行結果をもとに回答してください。\n' +
                  'もし以下のような状況であれば、その旨を率直にユーザーに伝えてください:\n' +
                  '・必要なデータや情報が不足している → 何が足りないかを具体的に説明\n' +
                  '・モデルや機能の制約で予測/回答が困難 → なぜできないかを説明\n' +
                  '・ユーザーの質問が曖昧で複数の解釈ができる → どんな追加情報があれば答えられるかを質問\n' +
                  '・ツール結果が予想外/エラーだった → その内容を要約して説明\n' +
                  '推測や憶測で答えを作らず、分からないことは「分かりません」と正直に伝えてください。'
              }
            ];
            const retryRes = await fetchWithRetry('/v1/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: chatModel,
                messages: retryMessages,
                stream: true,
                stream_options: { include_usage: true },
                ...llamaCommonOptions,
              }),
              signal: controller.signal,
            });
            if (retryRes.ok) {
              // 既存の応答をクリアしてから再ストリーム
              setMessages(prev => {
                const copy = [...prev];
                copy[copy.length - 1] = {
                  ...copy[copy.length - 1],
                  content: '',
                  thinking: '',
                };
                return copy;
              });
              await streamResponse(retryRes, contextInfo, searchQueries, { audios: generatedAudios, images: generatedImages });

              // それでも空なら、固定メッセージにフォールバック
              const afterMsg = await new Promise(resolve => {
                setMessages(prev => { resolve(prev[prev.length - 1]); return prev; });
              });
              const afterContent = (afterMsg?.content || '').trim();
              if (afterContent.length < 5) {
                console.log('[空応答救済] 再生成後も空 → 固定メッセージで通知');
                setMessages(prev => {
                  const copy = [...prev];
                  copy[copy.length - 1] = {
                    ...copy[copy.length - 1],
                    content:
                      '申し訳ありません、適切な回答を生成できませんでした。\n\n' +
                      'ツールの実行は完了しましたが、結果から確定的な回答を導き出せませんでした。\n' +
                      '考えられる原因:\n' +
                      '・必要なデータが不足している (該当する学習モデルやテーブルが無い等)\n' +
                      '・ご質問内容に対してモデルや機能の制約がある\n' +
                      '・ご質問が曖昧で、追加情報が必要\n\n' +
                      'もし具体的な目的をお聞かせいただければ、別のアプローチをご提案できるかもしれません。',
                  };
                  return copy;
                });
              }
            }
          }
        }

        // ─── ストリーミング最終応答後の救済処理 ───
        // Gemma系などが最終応答中に <|tool_call|> を出すケース
        // → 内容を抽出して手動でツール実行 → 再度ストリーミング応答
        const MAX_RECOVERY_TURNS = 2;
        for (let recoveryTurn = 0; recoveryTurn < MAX_RECOVERY_TURNS; recoveryTurn++) {
          // 最終応答に <|tool_call|> が残っているか確認
          const lastMsg = await new Promise(resolve => {
            setMessages(prev => { resolve(prev[prev.length - 1]); return prev; });
          });
          if (!lastMsg || lastMsg.role !== 'assistant') break;
          const lastContent = lastMsg.content || '';
          // Gemma4の非対称トークン対応: <|tool_call> や <tool_call|> など、|の数がまちまちでもマッチ
          // パターン: <[|]?tool_call[|]?> ... <[/]?[|]?tool_call[|]?>
          const gemmaMatch = lastContent.match(/<\|?tool_call\|?>\s*call:\s*(\w+)\s*\{([\s\S]*?)\}\s*<\/?\|?tool_call\|?>/i);
          if (!gemmaMatch) {
            console.log('[救済処理] <|tool_call|>パターン未検出、ループ終了');
            break;
          }

          const fname = gemmaMatch[1];
          const argsBody = gemmaMatch[2];
          const args = {};
          // 引数値の囲み記号も非対称対応: <|"> や <"> でもOK
          const argRe = /(\w+)\s*:\s*<\|?"?\|?>\s*([\s\S]*?)\s*<\|?"?\|?>/g;
          let m;
          while ((m = argRe.exec(argsBody)) !== null) {
            args[m[1]] = m[2];
          }
          // 万一 <|"|> パターンが取れなかった場合のフォールバック: " で囲まれた値、生の値
          if (!args.query) {
            const simpleMatch = argsBody.match(/(\w+)\s*:\s*"?([^",}]+)"?/);
            if (simpleMatch) args[simpleMatch[1]] = simpleMatch[2].trim();
          }
          if (fname !== 'web_search' || !args.query) {
            console.log(`[救済処理] パース失敗: fname=${fname}, args=`, args);
            break;
          }

          console.log(`[最終応答中の<|tool_call|>検出] web_search("${args.query}") を実行`);

          // 検索を実行
          const query = args.query;
          searchQueries.push({ query: `Web検索: ${query}`, resultCount: null, type: 'web' });
          setMessages(prev => {
            const copy = [...prev];
            copy[copy.length - 1] = {
              ...copy[copy.length - 1],
              agentStatus: `🌐 追加Web検索「${query}」中...`,
              searchQueries: [...searchQueries],
            };
            return copy;
          });

          let webResults = [];
          try {
            const wsRes = await fetch(`/web-search?q=${encodeURIComponent(query)}&n=5`);
            if (wsRes.ok) {
              const wsData = await wsRes.json();
              webResults = wsData.results || [];
            }
          } catch (e) { console.warn('web-search error', e); }

          // 結果を会話履歴に追加
          const resultText = webResults.length > 0
            ? webResults.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.body || r.snippet || ''}`).join('\n\n')
            : '検索結果が見つかりませんでした。';

          // 前の不完全な応答を会話履歴から削除して、tool結果を追加
          // 注: assistantメッセージにtool_calls形式で追加するのではなく、systemの追記として渡す
          // (既にmaxTurns済みのため、追加検索結果を含めて再生成)
          apiMessages.push({
            role: 'system',
            content: `追加のWeb検索を実行しました（クエリ: ${query}）。以下の結果を参考に最終的な回答を作成してください:\n\n${resultText}\n\n重要: <|tool_call|>のような書式は使わず、自然な日本語で回答してください。`
          });

          searchQueries[searchQueries.length - 1].resultCount = webResults.length;

          // 既存の最終応答メッセージをクリアして再ストリーミング
          setMessages(prev => {
            const copy = [...prev];
            copy[copy.length - 1] = {
              role: 'assistant', content: '', thinking: '',
              contexts: contextInfo,
              agentStatus: '回答生成中...',
              searchQueries: [...searchQueries],
            };
            return copy;
          });

          const retryRes = await fetchWithRetry('/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: chatModel,
              messages: apiMessages,
              stream: true,
              stream_options: { include_usage: true },
              ...llamaCommonOptions,
            }),
            signal: controller.signal,
          });

          if (!retryRes.ok) break;
          await streamResponse(retryRes, contextInfo, searchQueries, { audios: generatedAudios, images: generatedImages });
          // 次のループで再度<|tool_call|>が出ていないかチェック
        }

      } else {
        // ─── 従来モード（always）: 常にRAG検索してプロンプト注入 ───
        const contexts = await retrieveContext(text);
        let fullSystemPrompt = systemPrompt;
        if (contexts.length > 0) {
          const ctxText = contexts.map((c, i) => `[資料${i + 1}: ${c.docName}]\n${c.chunk}`).join('\n\n');
          fullSystemPrompt += `\n\n以下の参考資料に基づいて回答してください。資料に無い情報は推測であることを明示してください。\n\n${ctxText}`;
        }
        // ユーザー設定の役割（システムプロンプト先頭に置き、汎用ルールより優先させる）
        fullSystemPrompt = applyRolePrompt(fullSystemPrompt, chatRole);

        const res = await fetchWithRetry('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: chatModel,
            messages: [{ role: 'system', content: fullSystemPrompt }, ...history],
            stream: true,
            stream_options: { include_usage: true },
            ...llamaCommonOptions,
          }),
          signal: controller.signal,
        });

        if (!res.ok) throw new Error(`API Error: ${res.status}`);

        const contextInfo = contexts.length > 0 ? contexts : null;
        setMessages(prev => [...prev, { role: 'assistant', content: '', thinking: '', contexts: contextInfo }]);
        await streamResponse(res, contextInfo, null);
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        // 停止ボタンで中断
        // 最後のメッセージの agentStatus をクリア（途中で止めた場合）
        setMessages(prev => {
          if (prev.length === 0) return prev;
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last.role === 'assistant') {
            copy[copy.length - 1] = { ...last, agentStatus: null };
          }
          return copy;
        });
      } else {
        // ツール判断中・ストリーミング中などにエラーが起きた場合、
        // agentStatus が残ってしまうとUIが「ツール判断中...」のまま固まる。
        // エラーメッセージをチャットに表示し、agentStatus は解除する。
        setMessages(prev => {
          if (prev.length === 0) return prev;
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last.role === 'assistant') {
            copy[copy.length - 1] = {
              ...last,
              agentStatus: null,
              // content が空ならエラー内容を入れる、既に何か出力されてれば追記
              content: last.content
                ? last.content + `\n\n⚠️ エラー: ${e.message}`
                : `⚠️ エラーが発生しました: ${e.message}\n\nもう一度お試しいただくか、サーバーログを確認してください。`,
            };
          }
          return copy;
        });
        setError(e.message);
      }
    } finally {
      abortRef.current = null;
      setIsLoading(false);
    }
  }

  // ─── ストリーミング応答の共通処理 ───
  async function streamResponse(res, contextInfo, searchQueries, genMedia) {
    // genMedia = { audios: [{url,text}], images: [{url,prompt}] } | undefined
    // ツールが実際に生成したメディアの本物URL。LLMがマーカーのファイル名を
    // 改変して出力しても、最終応答でこの実URLに上書き・補完して正しく描画する。
    function fixGenMarkers(content) {
      if (!genMedia) return content;
      const audios = genMedia.audios || [];
      const images = genMedia.images || [];
      if (audios.length === 0 && images.length === 0) return content;
      let out = content || '';
      // 1) 既存マーカーのURLを実URLで順番に上書き（余分な捏造マーカーは削除）
      let ai = 0;
      out = out.replace(/\[\[gen_audio:[^\]]*\]\]/g, () => {
        if (ai >= audios.length) return '';
        const a = audios[ai++];
        return `[[gen_audio:${a.url}|${encodeURIComponent(a.text || '')}]]`;
      });
      let ii = 0;
      out = out.replace(/\[\[gen_image:[^\]]*\]\]/g, () => {
        if (ii >= images.length) return '';
        const im = images[ii++];
        return `[[gen_image:${im.url}|${encodeURIComponent(im.prompt || '')}]]`;
      });
      // 2) LLMがマーカーを出さなかった分を末尾に補完
      for (; ai < audios.length; ai++) {
        out += `\n\n[[gen_audio:${audios[ai].url}|${encodeURIComponent(audios[ai].text || '')}]]`;
      }
      for (; ii < images.length; ii++) {
        out += `\n\n[[gen_image:${images[ii].url}|${encodeURIComponent(images[ii].prompt || '')}]]`;
      }
      return out;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let assistantContent = '';
    let assistantThinking = '';
    let tokenInfo = null;
    let buffer = '';  // SSE分割行のバッファ
    let firstTokenTime = 0;
    const startTime = Date.now();
    // ループ検出用（詳細は findTailRepetition のコメント参照）
    let loopDetected = false;
    const LOOP_CHECK_STRIDE = 100;   // 何文字進むごとに調べるか
    const LOOP_TAIL_SIZE = 1600;     // 末尾何文字を対象にするか（段落単位のループも入る長さ）
    let lastCheckedLen = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE: 各イベントは "\n\n" で区切られる、各行は "data: ..." または ": comment"
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';  // 最後の不完全なイベントは次のループで処理

      for (const event of events) {
        const dataLines = event.split('\n')
          .filter(l => l.startsWith('data: '))
          .map(l => l.slice(6));
        if (dataLines.length === 0) continue;
        const dataStr = dataLines.join('\n');
        if (dataStr === '[DONE]') continue;

        try {
          const json = JSON.parse(dataStr);

          // OpenAI互換: { choices: [{ delta: { content, reasoning_content, tool_calls } }] }
          const delta = json.choices?.[0]?.delta || {};
          // llama.cppは reasoning_content (DeepSeek/QwQ系) をthinking扱い
          if (delta.reasoning_content) assistantThinking += delta.reasoning_content;
          if (delta.content) {
            if (!firstTokenTime) firstTokenTime = Date.now();
            assistantContent += delta.content;
          }

          // usageは最終チャンクで来る（stream_options.include_usage: trueの時）
          if (json.usage) {
            tokenInfo = {
              promptTokens: json.usage.prompt_tokens || 0,
              completionTokens: json.usage.completion_tokens || 0,
            };
            // トークン速度の計算（最初のトークンから最終までの実時間ベース）
            const evalMs = Date.now() - (firstTokenTime || startTime);
            if (json.usage.completion_tokens > 0 && evalMs > 0) {
              const hist = tokenHistoryRef.current;
              hist.push({ tokens: json.usage.completion_tokens, durationNs: evalMs * 1e6 });
              const win = appConfig.tokenAvgWindow || 2000;
              let totalTok = hist.reduce((s, h) => s + h.tokens, 0);
              while (hist.length > 1 && totalTok > win) {
                totalTok -= hist[0].tokens;
                hist.shift();
              }
              const totalNs = hist.reduce((s, h) => s + h.durationNs, 0);
              setTokenSpeed({
                tokPerSec: totalNs > 0 ? (totalTok / (totalNs / 1e9)) : 0,
                totalTokens: totalTok,
                samples: hist.length,
              });
            }
          }

          // ─── 暴走ループ検出 ───
          // コードブロック (```) の中は判定しない。ファイルの内容やログを引用している
          // 最中は同じ行が並ぶのが当たり前で、そこで打ち切ると
          // 「ファイルを読み込んだのに内容が表示される前に止まる」ことになる。
          const fullText = assistantThinking + assistantContent;
          if (fullText.length - lastCheckedLen >= LOOP_CHECK_STRIDE) {
            lastCheckedLen = fullText.length;
            const insideCodeBlock = ((fullText.match(/```/g) || []).length % 2) === 1;
            if (!insideCodeBlock) {
              const tail = fullText.slice(-LOOP_TAIL_SIZE).replace(/[ \t]+/g, ' ');
              const period = findTailRepetition(tail);
              if (period > 0) {
                console.log(`[ループ検出] 末尾が周期${period}文字で繰り返し:`,
                  JSON.stringify(tail.slice(-period)).slice(0, 80));
                loopDetected = true;
                if (abortRef.current) abortRef.current.abort();
                break;
              }
            }
          }

          // <think>タグでthinkingが入る場合のフォールバック処理（プロンプトテンプレ依存）
          let displayContent = assistantContent;
          let displayThinking = assistantThinking;
          const thinkMatch = assistantContent.match(/^<think>([\s\S]*?)(<\/think>)?([\s\S]*)$/);
          if (thinkMatch) {
            const tagThinking = thinkMatch[1] || '';
            const closed = !!thinkMatch[2];
            const afterThink = thinkMatch[3] || '';
            displayThinking = (assistantThinking + tagThinking).trim();
            displayContent = closed ? afterThink.trim() : '';
          }

          // ─── 英語独白パターンの検出 & 退避 ───
          // Qwen3.6 35B-A3B[MoE] 等で <think> タグなしで AI の自己独白が
          // 最終応答に混入する現象への対処
          // 例: "I will write it now. I will not mention the date. ..."
          //     "The user's query is short. I will keep the answer short."
          // 検出した独白パターンの行を thinking 領域に移動
          if (displayContent && /\bI (will|need to|should|am going to|must|won't|don't|'ll|'m|tried|used)\b|\bThe user('s| is| wants| needs| asked)\b|\bMy (answer|response|reply|task)\b|\bLet me\b|\bThe (first|second|third|next|last|previous|original|exact) (ID|id|call|result|attempt|query|search|one)\b/.test(displayContent)) {
            const lines = displayContent.split(/\n+/);
            const reasoningLines = [];
            const cleanLines = [];
            // 既知の自己独白パターン (英語、AI の内省)
            const reasoningPatterns = [
              /^\s*I (will|won't|'ll|need to|should|am going to|must|don't|do not|'m going|'m not)/i,
              /^\s*The user('s| is| wants| needs| asked| said)/i,
              /^\s*My (answer|response|reply|task|goal|plan) (is|will|should|must)/i,
              /^\s*This (sounds|looks|seems|is) (good|fine|correct|right|nice|okay|ok)/i,
              /^\s*I'?ll? (just |now |proceed|make sure|keep|write|output|respond|answer)/i,
              /^\s*(Okay|OK|Alright|So|Now|Let me)\s*,?\s+I\b/i,
              /^\s*(Okay|OK|Alright)\s*,?\s+(the|so|let|now)\b/i,
              /^\s*Let me\b/i,
              /^\s*The response will be /i,
              /^\s*I (need|want|have) to /i,
              // ツール呼び出しをやり直そうとする独白 (ID の写し間違い等で発生)
              // 「The first ID might be...」のようなツール呼び出しに関する独白のみ。
              // 「The first point is...」のような普通の回答を消さないよう名詞を限定する
              /^\s*The (first|second|third|next|last|previous|original|exact) (ID|id|call|result|attempt|query|search|one)\b/i,
              /^\s*(Maybe|Perhaps) (I|the|that|it|this)\b/i,
              /^\s*I (tried|used|got|see that|think the|believe the|notice|found that)\b/i,
              /^\s*(That|It) (didn't|did not|doesn't|does not) (work|match|exist)/i,
            ];
            for (const line of lines) {
              const isReasoning = reasoningPatterns.some(p => p.test(line));
              if (isReasoning) {
                reasoningLines.push(line);
              } else {
                cleanLines.push(line);
              }
            }
            if (reasoningLines.length > 0) {
              displayThinking = (displayThinking ? displayThinking + '\n' : '') + reasoningLines.join('\n');
              displayContent = cleanLines.join('\n').trim();
            }
          }

          setMessages(prev => {
            const copy = [...prev];
            copy[copy.length - 1] = {
              ...copy[copy.length - 1],  // 既存フィールド (generatedImages 等) を保持
              role: 'assistant',
              content: displayContent,
              thinking: displayThinking,
              contexts: contextInfo,
              searchQueries: searchQueries,
              agentStatus: loopDetected ? '⚠️ 思考ループを検出しました。「続きを生成」ボタンで回答を要求できます。' : null,
              tokenInfo: tokenInfo,
              loopDetected: loopDetected,
            };
            return copy;
          });
        } catch (e) {
          console.warn('SSE parse error:', e, dataStr.slice(0, 100));
        }
      }
      if (loopDetected) break;
    }

    // ─── ストリーミング完了後の救済処理 ───
    // <think>タグが閉じられないまま終わった場合、または reasoning_content だけで content が空の場合
    // → thinking内容を解析:
    //   1. 独白行と通常テキスト行を分離
    //   2. 通常テキスト行があれば、それを本文に昇格
    //   3. 全部独白なら、固定メッセージにフォールバック
    setMessages(prev => {
      const copy = [...prev];
      const last = copy[copy.length - 1];
      if (last && last.role === 'assistant' && !last.content && last.thinking) {
        const thinkingLines = last.thinking.split(/\n+/);
        const reasoningPatterns = [
          /^\s*I (will|won't|'ll|need to|should|am going to|must|don't|do not|'m going|'m not)/i,
          /^\s*The user('s| is| wants| needs| asked| said)/i,
          /^\s*My (answer|response|reply|task|goal|plan) /i,
          /^\s*This (sounds|looks|seems|is) (good|fine|correct|right|nice|okay|ok)/i,
          /^\s*I'?ll? (just |now |proceed|make sure|keep|write|output|respond|answer)/i,
          /^\s*(Okay|OK|Alright|So|Now|Let me)\s*,?\s+I\b/i,
          /^\s*Let me (think|consider|check|analyze|see|write|now|just)/i,
          /^\s*The response (will|is) /i,
          /^\s*I (need|want|have) to /i,
        ];
        // 独白でない行 (実応答候補) を抽出
        const realAnswerLines = thinkingLines.filter(l => {
          const trimmed = l.trim();
          if (!trimmed) return false;
          return !reasoningPatterns.some(p => p.test(trimmed));
        });
        const reasoningLines = thinkingLines.filter(l => {
          const trimmed = l.trim();
          if (!trimmed) return false;
          return reasoningPatterns.some(p => p.test(trimmed));
        });

        if (realAnswerLines.length > 0) {
          // 実応答候補がある → それを本文に昇格、独白は thinking 領域に残す
          console.warn(`[救済] thinking から実応答 ${realAnswerLines.length}行 を抽出して昇格 (独白 ${reasoningLines.length}行 は thinking 領域へ)`);
          copy[copy.length - 1] = {
            ...last,
            content: realAnswerLines.join('\n').trim(),
            thinking: reasoningLines.join('\n').trim(),
          };
        } else {
          // 全部独白 → 固定メッセージ
          console.warn(`[救済] thinkingが完全に独白 (${reasoningLines.length}行)、固定メッセージで応答`);
          copy[copy.length - 1] = {
            ...last,
            content: '申し訳ありません、適切な応答を生成できませんでした。もう一度質問していただけますか?',
            // thinking は残しておく (デバッグ用、ユーザーが展開すれば見える)
          };
        }
      }
      return copy;
    });

    // ─── 生成メディアのマーカーを実URLで確定 ───
    // LLMが [[gen_audio:...]]/[[gen_image:...]] のファイル名を改変・捏造して
    // 出力することがあるため、ツールが実際に返したURLでマーカーを上書き・補完する。
    if (genMedia && ((genMedia.audios && genMedia.audios.length) || (genMedia.images && genMedia.images.length))) {
      setMessages(prev => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last && last.role === 'assistant') {
          copy[copy.length - 1] = { ...last, content: fixGenMarkers(last.content || '') };
        }
        return copy;
      });
    }
  }

  // ─── ファイルハンドリング ───
  function handleFiles(files) {
    // FileList / Array / 配列風オブジェクト どれでも受け付ける
    const fileArray = Array.from(files || []);
    for (const file of fileArray) {
      if (!file || typeof file.type !== 'string') continue;
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (e) => {
          const dataUrl = e.target.result;
          const base64 = dataUrl.split(',')[1];
          setChatImages(prev => [...prev, { name: file.name, base64, preview: dataUrl }]);
        };
        reader.readAsDataURL(file);
      } else if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        // PDF: PDF.js でテキスト抽出してから RAG に登録
        // OCR済みのPDF (テキストレイヤー付き) なら正しく抽出できる。
        // 大きいPDFはページ単位で処理されるのでメモリ効率も良い。
        (async () => {
          try {
            setLoadingMessage(`PDFを解析中: ${file.name}`);
            const text = await extractPdfText(file, (cur, total) => {
              setLoadingMessage(`PDFを解析中: ${file.name} (${cur}/${total}ページ)`);
            });
            setLoadingMessage('');
            addDocument(file.name, text);
          } catch (e) {
            setLoadingMessage('');
            setError(`PDF解析失敗 (${file.name}): ${e.message}`);
          }
        })();
      } else {
        const reader = new FileReader();
        reader.onload = (e) => {
          addDocument(file.name, e.target.result);
        };
        reader.readAsText(file);
      }
    }
  }

  function handleImageFiles(files) {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target.result;
        const base64 = dataUrl.split(',')[1];
        setChatImages(prev => [...prev, { name: file.name, base64, preview: dataUrl }]);
      };
      reader.readAsDataURL(file);
    }
  }

  function handlePaste(e) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) handleImageFiles([file]);
        return;
      }
    }
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragActive(false);
    handleFiles(e.dataTransfer.files);
  }

  // ─── チャット入力欄へのD&D ───
  // 画像はチャット添付（Vision用）、その他はドキュメントとして取り込む
  async function handleChatDrop(e) {
    e.preventDefault();
    setChatDragActive(false);
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 0) return;
    const images = files.filter(f => f.type.startsWith('image/'));
    const others = files.filter(f => !f.type.startsWith('image/'));
    // 画像 → チャット添付（base64化）
    for (const file of images) {
      const reader = new FileReader();
      const dataUrl = await new Promise((resolve, reject) => {
        reader.onload = e => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const base64 = dataUrl.split(',')[1];
      setChatImages(prev => [...prev, { name: file.name, base64, preview: dataUrl }]);
    }
    // その他 → ドキュメントに取り込む（配列を直接渡す）
    if (others.length > 0) {
      handleFiles(others);
    }
  }

  // ─── サーバーファイルパネルへのD&D ───
  async function handleServerDrop(e) {
    e.preventDefault();
    setServerDragActive(false);
    const files = Array.from(e.dataTransfer.files || []);
    for (const file of files) {
      await uploadServerFile(file);
    }
  }

  // ─── 応答をMarkdownとしてダウンロード ───
  function downloadMarkdown(content, index) {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `response_${index + 1}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── 応答をドキュメントに追加 ───
  function addResponseToDocuments(content, index) {
    const name = `AI応答_${index + 1}.md`;
    addDocument(name, content);
  }

  // ─── 自動スクロール ───
  const containerRef = useRef(null);
  const autoScrollRef = useRef(true);    // 自動スクロール有効フラグ
  const lastProgScrollRef = useRef(0);   // 直近のプログラムスクロール位置

  // documentレベルでwheelを捕捉（最も確実）
  useEffect(() => {
    const onWheel = (e) => {
      const el = containerRef.current;
      if (!el) return;
      if (!el.contains(e.target)) return; // チャット領域外は無視

      if (e.deltaY < 0) {
        autoScrollRef.current = false;
      } else if (e.deltaY > 0) {
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        if (atBottom) autoScrollRef.current = true;
      }
    };

    const onKeyDown = (e) => {
      const el = containerRef.current;
      if (!el) return;
      if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) {
        autoScrollRef.current = false;
      } else if (e.key === 'End') {
        autoScrollRef.current = true;
      }
    };

    let touchStartY = 0;
    const onTouchStart = (e) => {
      touchStartY = e.touches[0]?.clientY || 0;
    };
    const onTouchMove = (e) => {
      const el = containerRef.current;
      if (!el || !el.contains(e.target)) return;
      const cur = e.touches[0]?.clientY || 0;
      if (cur > touchStartY + 5) {
        autoScrollRef.current = false;
      }
    };

    document.addEventListener('wheel', onWheel, { passive: true });
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => {
      document.removeEventListener('wheel', onWheel);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
    };
  }, []);

  // ストリーミング中は rAF で追従（ユーザースクロール検出付き）
  useEffect(() => {
    if (!isLoading) return;
    let raf;
    const tick = () => {
      const el = containerRef.current;
      if (el) {
        // ユーザーが上方向にスクロールした場合のみ停止
        // （下方向の変化は新コンテンツ追加によるものなので無視）
        if (lastProgScrollRef.current > 0 && el.scrollTop < lastProgScrollRef.current - 30) {
          autoScrollRef.current = false;
        }
        if (autoScrollRef.current) {
          el.scrollTop = el.scrollHeight;
          lastProgScrollRef.current = el.scrollTop;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isLoading]);

  // 新メッセージ追加時（非ストリーミング時）のスクロール
  useEffect(() => {
    if (isLoading) return;
    if (!autoScrollRef.current) return;
    requestAnimationFrame(() => {
      const el = containerRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
        lastProgScrollRef.current = el.scrollTop;
      }
    });
  }, [messages]);

  // ─── サイドバー パネルのリサイズ ───
  // チャット履歴パネルとドキュメントパネルの境界をドラッグして高さを調整。
  // チャット履歴の高さを変えると、残りをドキュメントパネル(flex:1)が埋める。
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('chatHistoryHeight', String(chatHistoryHeight));
    }
  }, [chatHistoryHeight]);

  const startHistoryResize = useCallback((e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = chatHistoryHeight;
    const onMove = (ev) => {
      const delta = ev.clientY - startY;
      // 上限はウィンドウ高からドキュメント枠等の最小確保分を引いた値
      const maxH = Math.max(160, window.innerHeight - 260);
      const h = Math.max(120, Math.min(startH + delta, maxH));
      setChatHistoryHeight(h);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'row-resize';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [chatHistoryHeight]);

  // ─── チャット履歴管理 ───
  async function loadChatList() {
    try {
      const res = await fetch('/chats');
      if (res.ok) setChatList(await res.json());
    } catch {}
  }

  // ─── サーバーファイル管理 ───
  async function loadFileList() {
    try {
      const res = await fetch('/files');
      if (res.ok) setFileList((await res.json()).files || []);
    } catch {}
  }

  // ─── Google Drive ───
  // 接続状態を取得。ツール提供の可否判定にも使うのでチャット画面の初期化でも呼ぶ。
  async function loadGdriveStatus() {
    try {
      const res = await fetch('/gdrive/status');
      if (!res.ok) { setGdriveStatus(null); return null; }
      const st = await res.json();
      setGdriveStatus(st);
      return st;
    } catch {
      setGdriveStatus(null);
      return null;
    }
  }

  // フォルダの中身 or 検索結果を読み込む
  async function loadGdriveFiles(folderId = gdriveFolderId, query = '') {
    setGdriveLoading(true);
    setGdriveError('');
    try {
      const url = query
        ? `/gdrive/search?q=${encodeURIComponent(query)}`
        : `/gdrive/files?folderId=${encodeURIComponent(folderId || '')}`;
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setGdriveError(data.error || `HTTP ${res.status}`);
        setGdriveFiles([]);
        return;
      }
      setGdriveFiles(data.files || []);
    } catch (e) {
      setGdriveError(e.message);
      setGdriveFiles([]);
    } finally {
      setGdriveLoading(false);
    }
  }

  // フォルダを開く（パンくずを積む）
  function openGdriveFolder(file) {
    const id = file?.id || '';
    const name = file?.name || 'マイドライブ';
    setGdriveFolderId(id);
    setGdriveBreadcrumb(prev => [...prev, { id, name }]);
    setGdriveQuery('');
    loadGdriveFiles(id, '');
  }

  // パンくずの任意の階層へ戻る
  function gdriveNavigateTo(index) {
    const crumb = gdriveBreadcrumb[index];
    if (!crumb) return;
    setGdriveBreadcrumb(gdriveBreadcrumb.slice(0, index + 1));
    setGdriveFolderId(crumb.id);
    setGdriveQuery('');
    loadGdriveFiles(crumb.id, '');
  }

  // OAuth 認可フローを開始（別ウィンドウで同意 → postMessage で戻ってくる）
  async function connectGdrive() {
    setGdriveBusy(true);
    setGdriveError('');
    try {
      const res = await fetch('/gdrive/auth/url');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setGdriveError(data.error || `HTTP ${res.status}`); return; }
      const win = window.open(data.url, 'gdrive-auth', 'width=520,height=680');
      if (!win) {
        setGdriveError('ポップアップがブロックされました。ブラウザの設定で許可してください。');
        return;
      }
      // 認可完了は callback ページからの postMessage で受ける。
      // ポップアップを手動で閉じられた場合に備えてポーリングでも拾う。
      const timer = setInterval(async () => {
        if (win.closed) {
          clearInterval(timer);
          const st = await loadGdriveStatus();
          if (st?.connected) loadGdriveFiles('', '');
        }
      }, 800);
    } catch (e) {
      setGdriveError(e.message);
    } finally {
      setGdriveBusy(false);
    }
  }

  async function disconnectGdrive() {
    if (!confirm('GDrive の連携を解除しますか？\n（保存されているアクセス許可を取り消します）')) return;
    setGdriveBusy(true);
    try {
      const res = await fetch('/gdrive/disconnect', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setGdriveError(data.error || `HTTP ${res.status}`);
      setGdriveFiles([]);
      setGdriveBreadcrumb([{ id: '', name: 'マイドライブ' }]);
      setGdriveFolderId('');
      await loadGdriveStatus();
    } catch (e) {
      setGdriveError(e.message);
    } finally {
      setGdriveBusy(false);
    }
  }

  // Drive のファイルをサーバー (uploads) に取り込む
  async function importGdriveFile(file) {
    setGdriveBusy(true);
    setGdriveError('');
    try {
      const res = await fetch('/gdrive/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId: file.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setGdriveError(data.error || `HTTP ${res.status}`); return; }
      loadFileList();
      alert(`サーバーに取り込みました: uploads/${data.path} (${formatBytes(data.size)})`);
    } catch (e) {
      setGdriveError(e.message);
    } finally {
      setGdriveBusy(false);
    }
  }

  // Drive のファイルをそのままブラウザにダウンロード
  function downloadGdriveFile(file) {
    window.open(`/gdrive/files/${encodeURIComponent(file.id)}/content?raw=1`, '_blank');
  }

  // uploads のファイルを Drive にアップロード
  async function uploadToGdrive(relPath) {
    setGdriveBusy(true);
    setGdriveError('');
    try {
      const res = await fetch('/gdrive/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: relPath, folderId: gdriveFolderId || undefined, overwrite: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setGdriveError(data.error || `HTTP ${res.status}`); return; }
      alert(`GDrive にアップロードしました: ${data.name}`);
      if (!gdriveQuery) loadGdriveFiles(gdriveFolderId, '');
    } catch (e) {
      setGdriveError(e.message);
    } finally {
      setGdriveBusy(false);
    }
  }

  // ─── 外部APIサーバー管理 ───
  async function loadExternalServers() {
    try {
      const [r1, r2, r3, r4] = await Promise.all([
        fetch('/external-servers'),
        fetch('/external-servers/https-available'),
        fetch('/external-servers/embedding-available'),
        fetch('/external-servers/gdrive-available'),
      ]);
      if (r1.ok) {
        const data = await r1.json();
        setExternalServers(data.servers || []);
      }
      if (r2.ok) {
        const data = await r2.json();
        setApiHttpsAvailable(!!data.available);
      }
      let embeddingAvailable = false;
      if (r3.ok) {
        const data = await r3.json();
        embeddingAvailable = !!data.available;
        setApiEmbeddingAvailable(embeddingAvailable);
        setApiEmbeddingReason(data.reason || '');
        // 利用不可ならツール選択から rag を自動的に外す
        if (!embeddingAvailable) {
          setApiFormTools(prev => prev.filter(t => t !== 'rag'));
        }
      }
      if (r4.ok) {
        const data = await r4.json();
        setApiGdriveAvailable(!!data.available);
        setApiGdriveReason(data.reason || '');
        // 利用不可ならツール選択から gdrive を自動的に外す
        if (!data.available) setApiFormTools(prev => prev.filter(t => t !== 'gdrive'));
      }
      return { embeddingAvailable };
    } catch {
      return { embeddingAvailable: false };
    }
  }

  // 永続RAG (サーバー側 ml/rag/) の利用可否と登録ドキュメント数を確認
  // embedding が利用可能 + 登録ドキュメント > 0 のとき、通常チャットでも
  // search_persistent_documents ツールが自動的にLLMに提供される
  // embeddingAvailable は loadExternalServers から渡される (重複fetch回避)
  async function loadPersistentRagInfo(embeddingAvailable) {
    try {
      // embedding が使えないなら RAG ドキュメントの取得自体スキップ
      if (!embeddingAvailable) {
        setPersistentRagAvailable(false);
        setPersistentRagDocCount(0);
        setPersistentRagDocNames([]);
        return;
      }
      const docRes = await fetch('/rag/documents');
      const docs = docRes.ok ? await docRes.json() : { documents: [] };
      const list = docs.documents || [];
      const available = list.length > 0;
      setPersistentRagAvailable(available);
      setPersistentRagDocCount(list.length);
      setPersistentRagDocNames(list.map(d => d.filename));
      if (available) {
        console.log(`[永続RAG] 利用可能: ${list.length}件 (${list.map(d => d.filename).join(', ')})`);
      }
    } catch {}
  }

  async function startApiServer() {
    if (apiBusy) return;
    setError('');
    if (!apiFormModel) {
      setError('モデルを選択してください');
      return;
    }
    if (!apiFormPort || apiFormPort < 1 || apiFormPort > 65535) {
      setError('ポートは1-65535で指定してください');
      return;
    }
    setApiBusy(true);
    setLoadingMessage(`外部APIサーバーを起動中... (${apiFormHost}:${apiFormPort})`);
    try {
      const res = await fetch('/external-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelName: apiFormModel,
          host: apiFormHost,
          port: apiFormPort,
          apiKey: apiFormKey || undefined,
          type: 'chat',
          https: apiFormHttps,
          agentMode: apiFormAgentMode,
          tools: apiFormAgentMode ? apiFormTools : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setApiFormKey(''); // 入力フォームのAPIキーをクリア（自動生成されたものは一覧に表示される）
      // サーバー側で一部ツールが無効化された場合は警告表示
      if (data.warnings && data.warnings.length > 0) {
        setError(`⚠️ ${data.warnings.join('\n')}`);
      }
      await loadExternalServers();
    } catch (e) {
      setError(`外部APIサーバー起動失敗: ${e.message}`);
    } finally {
      setApiBusy(false);
      setLoadingMessage('');
    }
  }

  async function stopApiServer(id) {
    if (!confirm('この外部APIサーバーを削除しますか？\n（設定もすべて削除されます）')) return;
    setApiBusy(true);
    try {
      await fetch(`/external-servers/${id}`, { method: 'DELETE' });
      await loadExternalServers();
    } catch (e) {
      setError(`削除失敗: ${e.message}`);
    } finally {
      setApiBusy(false);
    }
  }

  // プロセスのみ停止（設定は保持。再起動可能）
  async function toggleApiServerProcess(id, running) {
    setApiBusy(true);
    try {
      const url = running ? `/external-servers/${id}/stop` : `/external-servers/${id}/start`;
      const r = await fetch(url, { method: 'POST' });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error || 'failed');
      }
      await loadExternalServers();
    } catch (e) {
      setError(`${running ? '停止' : '起動'}失敗: ${e.message}`);
    } finally {
      setApiBusy(false);
    }
  }

  async function deleteServerFile(path) {
    if (!confirm(`ファイル「${path}」を削除しますか？`)) return;
    try {
      await fetch(`/files/${encodeURI(path)}`, { method: 'DELETE' });
      loadFileList();
    } catch {}
  }

  async function downloadServerFile(path) {
    try {
      const res = await fetch(`/files/${encodeURI(path)}`);
      if (!res.ok) return;
      const ct = res.headers.get('Content-Type') || '';
      let blob;
      if (ct.startsWith('application/json')) {
        // テキストファイル: { content: "..." } 形式
        const data = await res.json();
        blob = new Blob([data.content || ''], { type: 'text/plain' });
      } else {
        // バイナリファイル: 直接ストリーム配信
        blob = await res.blob();
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = path.split('/').pop();
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError('ダウンロードに失敗: ' + e.message);
    }
  }

  async function uploadServerFile(file) {
    if (file.size > 10 * 1024 * 1024) {
      setError('ファイルサイズが10MBを超えています');
      return;
    }
    try {
      // バイナリファイル（画像・PDF・zip等）はFormDataで送信、テキストはJSONで
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const binaryExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'pdf',
                          'zip', 'tar', 'gz', '7z', 'rar', 'mp3', 'mp4', 'wav', 'webm',
                          'mov', 'avi', 'parquet', 'xlsx', 'xls', 'docx', 'pptx', 'odt',
                          'sqlite', 'db', 'wasm', 'so', 'dll', 'exe', 'bin'];
      const isBinary = binaryExts.includes(ext) || !file.type.startsWith('text/');

      let res;
      if (isBinary) {
        // FormDataでバイナリ送信
        const fd = new FormData();
        fd.append('file', file);
        res = await fetch(`/files/${encodeURI(file.name)}`, {
          method: 'POST',
          body: fd,
        });
      } else {
        // テキストはJSON送信（従来通り）
        const text = await file.text();
        res = await fetch(`/files/${encodeURI(file.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text }),
        });
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'アップロードに失敗しました');
        return;
      }
      loadFileList();
    } catch (e) {
      setError(e.message);
    }
  }

  // ─── マイク音声認識 (Web Speech API) ───
  const speechRecognitionRef = useRef(null);

  function startRecording() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setError('このブラウザは音声認識に対応していません（Chrome/Edge推奨）');
      return;
    }
    try {
      const recognition = new SR();
      recognition.lang = 'ja-JP';
      recognition.continuous = true;         // 止めるまで認識継続
      recognition.interimResults = true;     // 確定前の中間結果も取得
      recognition.maxAlternatives = 1;
      recognition._stopped = false;          // 停止フラグ
      recognition._silenceTimer = null;      // 無音検出タイマー

      // 認識開始時点の入力欄内容を保持（追記モード）
      let baseText = '';
      setInput(prev => { baseText = prev; return prev; });
      let finalText = '';

      // 無音タイマーをリセット（3秒無音で自動送信）
      const resetSilenceTimer = () => {
        if (recognition._silenceTimer) clearTimeout(recognition._silenceTimer);
        recognition._silenceTimer = setTimeout(() => {
          // 無音3秒 → 入力内容で判断
          const combined = (finalText || '').trim();
          const hasContent = (baseText + ' ' + combined).trim().length > 0;
          recognition._stopped = true;
          try { recognition.abort(); } catch {}
          try { recognition.stop(); } catch {}
          setIsRecording(false);
          if (hasContent) {
            // 自動送信（次のtickでinputが確定してから）
            setTimeout(() => sendMessageRef.current?.(), 50);
          }
        }, 3000);
      };

      recognition.onresult = (event) => {
        if (recognition._stopped) return;
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalText += transcript;
          } else {
            interim += transcript;
          }
        }
        const combined = (finalText + interim).trim();
        setInput(baseText ? `${baseText} ${combined}` : combined);

        // 発話があった → 無音タイマーをリセット
        if (combined) resetSilenceTimer();
      };

      recognition.onerror = (event) => {
        if (event.error === 'no-speech') return;
        if (event.error === 'aborted') return;
        if (event.error === 'not-allowed') {
          setError('マイクの使用が許可されていません');
        } else if (event.error === 'network') {
          setError('音声認識サーバーに接続できません（Google依存）');
        } else {
          setError('音声認識エラー: ' + event.error);
        }
        if (recognition._silenceTimer) clearTimeout(recognition._silenceTimer);
        setIsRecording(false);
      };

      recognition.onend = () => {
        if (recognition._silenceTimer) clearTimeout(recognition._silenceTimer);
        setIsRecording(false);
        speechRecognitionRef.current = null;
      };

      recognition.start();
      speechRecognitionRef.current = recognition;
      setIsRecording(true);
      // 開始直後にタイマー発動（無発話時は3秒後に停止）
      resetSilenceTimer();
    } catch (e) {
      setError('音声認識の開始に失敗: ' + e.message);
    }
  }

  function stopRecording() {
    if (speechRecognitionRef.current) {
      speechRecognitionRef.current._stopped = true;
      if (speechRecognitionRef.current._silenceTimer) clearTimeout(speechRecognitionRef.current._silenceTimer);
      try { speechRecognitionRef.current.abort(); } catch {}
      try { speechRecognitionRef.current.stop(); } catch {}
    }
    setIsRecording(false);
  }

  function toggleRecording() {
    if (isRecording) stopRecording();
    else startRecording();
  }

  // ─── 音声合成 (Web Speech API) ───
  function stripMarkdownForSpeech(text) {
    if (!text) return '';
    return text
      // コードブロックを「コード省略」に置換
      .replace(/```[\s\S]*?```/g, '（コード省略）')
      .replace(/`[^`]+`/g, '')
      // 画像・リンクは alt/文字部分だけ
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // 見出し記号・箇条書き記号・強調記号を除去
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      // HTMLタグ除去
      .replace(/<[^>]+>/g, '')
      // 連続空白を1つに
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function toggleSpeak(content, idx) {
    if (!window.speechSynthesis) return;
    // 現在読み上げ中なら停止
    if (speakingIndex === idx) {
      window.speechSynthesis.cancel();
      setSpeakingIndex(-1);
      return;
    }
    // 他のメッセージを読み上げ中なら一旦止める
    window.speechSynthesis.cancel();

    const text = stripMarkdownForSpeech(content);
    if (!text) return;

    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'ja-JP';
    utter.rate = 1.1;   // やや速め
    utter.pitch = 1.0;
    utter.volume = 1.0;

    // 日本語ボイスがあれば優先選択
    const voices = window.speechSynthesis.getVoices();
    const jaVoice = voices.find(v => v.lang === 'ja-JP') || voices.find(v => v.lang.startsWith('ja'));
    if (jaVoice) utter.voice = jaVoice;

    utter.onend = () => setSpeakingIndex(-1);
    utter.onerror = () => setSpeakingIndex(-1);

    setSpeakingIndex(idx);
    window.speechSynthesis.speak(utter);
  }

  // sendMessageを常に最新状態で音声認識から呼び出せるようにref保持
  useEffect(() => { sendMessageRef.current = sendMessage; });
  useEffect(() => { setChatImagesRef.current = setChatImages; });

  // Python実行結果の画像をチャット入力欄に添付するグローバル関数
  // （vanilla JSのターミナルUIから呼び出す）
  useEffect(() => {
    window.attachImageToChat = async (filename) => {
      try {
        // filename が "plots/xxx.png" なら /plots/xxx.png、それ以外は /files/xxx.png
        const url = filename.startsWith('plots/')
          ? '/' + filename
          : '/files/' + encodeURIComponent(filename);
        const res = await fetch(url);
        if (!res.ok) {
          setError('画像取得失敗: ' + filename);
          return;
        }
        const blob = await res.blob();
        // BlobをbaseDataURLに変換
        const reader = new FileReader();
        reader.onload = (e) => {
          const dataUrl = e.target.result;
          const base64 = dataUrl.split(',')[1];
          const displayName = filename.replace(/^plots\//, '');
          setChatImagesRef.current?.(prev => [
            ...prev,
            { name: displayName, base64, preview: dataUrl }
          ]);
          // 入力欄付近にスクロール
          const inputEl = document.querySelector('.input-area, textarea');
          if (inputEl) inputEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        };
        reader.readAsDataURL(blob);
      } catch (e) {
        setError('画像添付エラー: ' + e.message);
      }
    };
    return () => { delete window.attachImageToChat; };
  }, []);

  // 新規チャット/ページ離脱時に音声停止
  useEffect(() => {
    return () => {
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    };
  }, []);

  // ─── 思考停止からの続き生成 ───
  async function continueGeneration(idx) {
    const target = messages[idx];
    if (!target || target.role !== 'assistant') return;

    setIsLoading(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const now = new Date();
      const dateStr = now.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
      // システムプロンプトは config.systemPrompts.base を使用（{date}を展開）
      const sp = appConfig.systemPrompts || {};
      const fillTemplate = (str, vars) => (str || '').replace(/\{(\w+)\}/g, (_, k) => vars[k] != null ? vars[k] : '');
      const systemPrompt = fillTemplate(sp.base || '', { date: dateStr });

      // idxまでの会話履歴 + thinking情報を引き継ぎ、続きを促す
      const history = messages.slice(0, idx).map(m => {
        const hasImages = m.images && m.images.length > 0;
        if (!hasImages) return { role: m.role, content: m.content };
        // OpenAI互換: content配列形式
        const content = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const img of m.images) {
          const dataUrl = img.base64.startsWith('data:')
            ? img.base64
            : `data:image/png;base64,${img.base64}`;
          content.push({ type: 'image_url', image_url: { url: dataUrl } });
        }
        return { role: m.role, content };
      });

      // 途中までの思考+応答を「部分応答」として追加し、続きを書くよう促す
      const partial = [target.thinking ? `<think>${target.thinking}</think>` : '', target.content || ''].filter(Boolean).join('\n').trim();
      // 中断応答の続きでも、ユーザー設定の役割を維持する
      const nudgeMessages = [
        { role: 'system', content: applyRolePrompt(systemPrompt, chatRole) },
        ...history,
      ];
      if (partial) {
        nudgeMessages.push({ role: 'assistant', content: partial });
        nudgeMessages.push({ role: 'user', content: '思考が途中で止まっています。続きから応答を完成させてください。必要な思考は手短に済ませ、ユーザーへの回答を必ず出力してください。' });
      } else {
        nudgeMessages.push({ role: 'user', content: '先ほどの質問への回答をお願いします。簡潔に答えてください。' });
      }

      const llamaOptions = {
        max_tokens: appConfig.agentContext?.largePredict || appConfig.chatMaxTokens || 8192,
        top_k: appConfig.topK,
        top_p: appConfig.topP,
        temperature: appConfig.temperature,
        // 繰り返し/思考ループ対策
        repeat_penalty: appConfig.repeatPenalty,
        repeat_last_n: appConfig.repeatLastN,
        presence_penalty: appConfig.presencePenalty,
        frequency_penalty: appConfig.frequencyPenalty,
        dry_multiplier: appConfig.dryMultiplier,
        dry_base: appConfig.dryBase,
        dry_allowed_length: appConfig.dryAllowedLength,
        dry_penalty_last_n: appConfig.dryPenaltyLastN,
        cache_prompt: true,
      };

      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: chatModel,
          messages: nudgeMessages,
          stream: true,
          stream_options: { include_usage: true },
          ...llamaOptions,
        }),
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`API Error: ${res.status}`);

      // 既存メッセージに追記するため、いったん読み込みしながら直接更新
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let addedContent = '';
      let addedThinking = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';
        for (const event of events) {
          const dataLines = event.split('\n')
            .filter(l => l.startsWith('data: '))
            .map(l => l.slice(6));
          if (dataLines.length === 0) continue;
          const dataStr = dataLines.join('\n');
          if (dataStr === '[DONE]') continue;
          try {
            const json = JSON.parse(dataStr);
            const delta = json.choices?.[0]?.delta || {};
            if (delta.reasoning_content) addedThinking += delta.reasoning_content;
            if (delta.content) addedContent += delta.content;

            // <think>タグ形式も処理
            let displayAddedContent = addedContent;
            let displayAddedThinking = addedThinking;
            const thinkMatch = addedContent.match(/^<think>([\s\S]*?)(<\/think>)?([\s\S]*)$/);
            if (thinkMatch) {
              const tagThinking = thinkMatch[1] || '';
              const closed = !!thinkMatch[2];
              const afterThink = thinkMatch[3] || '';
              displayAddedThinking = (addedThinking + tagThinking).trim();
              displayAddedContent = closed ? afterThink.trim() : '';
            }

            // 既存メッセージに追記
            setMessages(prev => {
              const copy = [...prev];
              const orig = copy[idx];
              copy[idx] = {
                ...orig,
                content: (target.content || '') + displayAddedContent,
                thinking: (target.thinking || '') + (displayAddedThinking ? '\n\n[続き]\n' + displayAddedThinking : ''),
              };
              return copy;
            });
          } catch {}
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message);
    } finally {
      abortRef.current = null;
      setIsLoading(false);
    }
  }

  async function saveChat(id, msgs, title) {
    if ((!msgs || msgs.length === 0) && documents.length === 0) return;
    const autoTitle = title || msgs.find(m => m.role === 'user')?.content?.slice(0, 40) || '無題';
    try {
      await fetch(`/chats/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: autoTitle,
          messages: msgs,
          role: chatRole || '',
          documents: documents.map(d => ({ name: d.name, text: d.text, chunks: d.chunks, embeddings: d.embeddings })),
        }),
      });
      loadChatList();
    } catch {}
  }

  async function loadChat(id) {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setSpeakingIndex(-1);
    setChatLoading(true);
    try {
      const res = await fetch(`/chats/${id}`);
      if (!res.ok) throw new Error(`Chat not found: ${id}`);
      const data = await res.json();
      setChatId(id);
      setChatTitle(data.title || '');
      setChatRole(data.role || '');
      setShowRoleEditor(false);
      setMessages(data.messages || []);
      setDocuments(data.documents || []);
      messagesDirtyRef.current = false;  // ロードしただけでは dirty にしない
    } finally {
      setChatLoading(false);
    }
  }

  function newChat() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setSpeakingIndex(-1);
    setChatId(Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    setChatTitle('');
    setChatRole('');
    setShowRoleEditor(false);
    setMessages([]);
    setDocuments([]);
    messagesDirtyRef.current = false;  // 新規チャット時もクリア
  }

  // ─── RAG作成: 現在のチャットをLLMで要約してmdドキュメントとしてアップロード→新規チャット ───
  async function createRagDocument() {
    // メッセージが少ない場合は単純に新規チャットに切替
    const userMsgs = messages.filter(m => m.role === 'user');
    const assistantMsgs = messages.filter(m => m.role === 'assistant' && m.content);
    if (userMsgs.length === 0 || assistantMsgs.length === 0) {
      newChat();
      return;
    }

    // モデル準備確認
    if (!modelReady && !firstLoadPending && !autoUnloadedName) {
      setError('モデルがロードされていません。少し待ってから再度お試しください。');
      return;
    }
    if (isLoading) {
      setError('現在の応答を待ってから実行してください。');
      return;
    }

    // 会話履歴をテキストに整形
    const conversationText = messages
      .filter(m => m.content && (m.role === 'user' || m.role === 'assistant'))
      .map(m => {
        const speaker = m.role === 'user' ? 'ユーザー' : 'アシスタント';
        return `## ${speaker}\n\n${m.content.trim()}\n`;
      })
      .join('\n---\n\n');

    setLoadingMessage('継続チャット準備中（過去の会話を要約中）...');
    setIsLoading(true);

    // モデル状態確認・必要ならロード待機（sendMessageと同じロジックの簡略版）
    try {
      const mres = await fetch('/models');
      if (mres.ok) {
        const mdata = await mres.json();
        if (!mdata.current || mdata.starting || mdata.autoUnloaded) {
          if (mdata.autoUnloaded) {
            // pingで再ロード起動
            fetch('/v1/chat/completions', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: chatModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
            }).catch(() => {});
          }
          // ロード完了をポーリング
          const startWait = Date.now();
          let ready = false;
          while (Date.now() - startWait < 120000) {
            await new Promise(r => setTimeout(r, 2000));
            try {
              const pres = await fetch('/models');
              if (!pres.ok) continue;
              const pdata = await pres.json();
              if (pdata.current && !pdata.starting && !pdata.autoUnloaded) { ready = true; break; }
            } catch {}
          }
          if (!ready) {
            setError('モデルのロードがタイムアウトしました。');
            setIsLoading(false);
            setLoadingMessage('');
            return;
          }
        }
      }
    } catch {}

    // LLMに要約を依頼
    const summaryPrompt = `以下は私とアシスタントの会話履歴です。これを後でRAG（検索拡張生成）で参照できるよう、詳細な要約のmarkdownドキュメントを作成してください。

要件:
- 会話のトピック・テーマを整理し、見出し構造で整理してください
- 重要な事実、数値、コード、決定事項、結論はそのまま残してください
- 検索しやすいよう、キーワードを豊富に含めてください
- 単なる要約ではなく、後から「○○について何と言ったか」を検索したときに見つかるよう詳細に記述してください
- markdown形式で、コードブロック・表・箇条書きを適切に使ってください
- 余計な前置き・後書きは不要、本文のmarkdownだけを出力してください

会話履歴:

${conversationText}

上記の会話を詳細に要約したmarkdownドキュメントを作成してください。`;

    let summaryMd = '';
    try {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: chatModel,
          messages: [
            { role: 'system', content: 'あなたは優秀なドキュメンテーションのプロです。会話履歴から後で検索しやすいmarkdownドキュメントを作成します。' },
            { role: 'user', content: summaryPrompt },
          ],
          stream: false,
          max_tokens: 8192,
          temperature: 0.3,
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`API Error: ${res.status}`);
      const data = await res.json();
      summaryMd = data?.choices?.[0]?.message?.content || '';
      // ```markdown ... ``` で囲まれている場合は中身を取り出す
      const mdMatch = summaryMd.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
      if (mdMatch) summaryMd = mdMatch[1];
      summaryMd = summaryMd.trim();
    } catch (e) {
      setError(`RAGドキュメント作成に失敗: ${e.message}`);
      setIsLoading(false);
      setLoadingMessage('');
      return;
    } finally {
      abortRef.current = null;
    }

    if (!summaryMd) {
      setError('要約結果が空でした。RAGドキュメントを作成できません。');
      setIsLoading(false);
      setLoadingMessage('');
      return;
    }

    // ヘッダー情報を付与
    const now = new Date();
    const dateStr = now.toLocaleString('ja-JP');
    const titleForDoc = chatTitle || '無題のチャット';
    const fullMd = `# ${titleForDoc}\n\n_作成日時: ${dateStr}_\n_元チャットID: ${chatId}_\n\n---\n\n${summaryMd}\n`;

    // ファイル名: タイトル + 日付
    const safeTitle = titleForDoc.replace(/[\\/:*?"<>|]/g, '').slice(0, 30);
    const tsStr = now.getFullYear()
      + String(now.getMonth() + 1).padStart(2, '0')
      + String(now.getDate()).padStart(2, '0')
      + '-'
      + String(now.getHours()).padStart(2, '0')
      + String(now.getMinutes()).padStart(2, '0');
    const docName = `${safeTitle}_${tsStr}.md`;

    setLoadingMessage('Embedding生成中...');

    // 既存のドキュメントを保持して新規チャットに切替
    const prevDocs = [...documents];
    setIsLoading(false);

    // 新規チャット状態にして、ドキュメントを引き継ぐ
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setSpeakingIndex(-1);
    setChatId(Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    setChatTitle('');
    setMessages([]);
    setDocuments(prevDocs);  // 既存ドキュメントは引き継ぐ
    // 注: chatRoleは引き継ぎ（継続チャットなので役割設定は維持）

    // 新ドキュメントを追加（addDocument 内で waitForEmbedding が呼ばれる）
    try {
      await addDocument(docName, fullMd);
    } catch (e) {
      setError(`ドキュメント追加に失敗: ${e.message}`);
    }
    setLoadingMessage('');
  }

  async function deleteChat(id) {
    try {
      await fetch(`/chats/${id}`, { method: 'DELETE' });
      if (chatId === id) newChat();
      loadChatList();
    } catch {}
  }

  // 初回読み込み（コンフィグ確認 → 認証判定）
  useEffect(() => {
    (async () => {
      try {
        const cfgRes = await fetch('/config');
        if (cfgRes.ok) {
          const cfg = await cfgRes.json();
          setAppConfig(prev => ({ ...prev, ...cfg }));
          // Web検索ON/OFFのデフォルト値はconfig.webSearchを反映
          setWebSearchEnabled(cfg.webSearch !== false);
          document.title = cfg.appName || 'OpenGeekLLMChat';
          if (cfg.accentColor) {
            const hex = cfg.accentColor;
            const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
            document.documentElement.style.setProperty('--accent', hex);
            document.documentElement.style.setProperty('--accent-dim', `rgba(${r},${g},${b},0.12)`);
            document.documentElement.style.setProperty('--accent-glow', `rgba(${r},${g},${b},0.25)`);
          }
          if (cfg.hasPassword) {
            setHasPassword(true);
            // 既存のセッションCookieが有効なら自動ログイン
            if (cfg.authenticated) setAuthenticated(true);
          } else {
            setHasPassword(false);
            setAuthenticated(true);
          }
        }
      } catch {}
    })();
  }, []);

  // 認証後にデータ読み込み
  const settingsLoadedRef = useRef(false);
  useEffect(() => {
    if (!authenticated) return;
    // 並行: チャット履歴・ファイル一覧・外部APIサーバー一覧・設定・永続RAG情報
    loadChatList();
    loadFileList();
    // Google Drive の接続状態 (ツール提供の可否判定に使う)
    loadGdriveStatus();
    // 外部APIサーバー情報を取得 → embedding 可否を永続RAG判定に渡す (fetch重複回避)
    loadExternalServers().then(({ embeddingAvailable }) => {
      loadPersistentRagInfo(embeddingAvailable);
    });
    // URLに chat ID があればそのチャットを読み込み（失敗したらルートへリダイレクト）
    const urlId = getChatIdFromUrl();
    if (urlId) {
      // chatLoading=true で表示を待たせる
      setChatLoading(true);
      loadChat(urlId)
        .catch(() => {
          // チャットが存在しない → ルートへリダイレクト（完全リロード）
          window.location.replace('/');
        });
    }
    (async () => {
      try {
        const [cfgRes, setRes] = await Promise.all([fetch('/config'), fetch('/settings')]);
        let cfg = null;
        if (cfgRes.ok) cfg = await cfgRes.json();
        if (setRes.ok) {
          const s = await setRes.json();
          if (s.chatModel) setChatModel(s.chatModel);
          else if (cfg?.defaultModel) setChatModel(cfg.defaultModel);
          // 前回マルチLLMワークフローを選んでいたら復元する
          // （存在しないIDだった場合は fetchOrchInfo 側で解除される）
          if (s.orchWorkflow) setOrchWorkflowId(s.orchWorkflow);
        } else if (cfg?.defaultModel) {
          setChatModel(cfg.defaultModel);
        }
      } catch {}
      // 設定読み込み完了後にフラグを立てる（自動保存を有効にする）
      setTimeout(() => { settingsLoadedRef.current = true; }, 1000);
    })();
  }, [authenticated]);

  // Google Drive の認可ポップアップからの完了通知を受ける
  // (callback ページが window.opener.postMessage({type:'gdrive-auth'}) を投げてくる)
  useEffect(() => {
    const onMessage = async (e) => {
      if (e.origin !== window.location.origin) return;   // 別オリジンからのメッセージは無視
      if (e.data?.type !== 'gdrive-auth') return;
      if (e.data.ok === false) {
        // 認可ポップアップ側で失敗（拒否・state切れ・ログイン切れ等）。パネルにも理由を出す
        setGdriveError(e.data.message || 'GDrive の連携に失敗しました');
        setRightPanelTab('gdrive');
        setGpuPanelOpen(true);
        await loadGdriveStatus();
        return;
      }
      setGdriveError('');
      const st = await loadGdriveStatus();
      if (st?.connected) {
        setGdriveEnabled(true);
        loadGdriveFiles('', '');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // chatId変更時にURLを更新（pushState）
  // - 新規/既存チャット切替で /chat/<id> に書き換え
  // - ブラウザの戻る・進むに対応するため popstate も監視
  useEffect(() => {
    if (!authenticated) return;
    const desiredPath = `/chat/${chatId}`;
    if (window.location.pathname !== desiredPath) {
      window.history.pushState({ chatId }, '', desiredPath);
    }
  }, [chatId, authenticated]);

  // ブラウザの戻る・進むボタン対応
  useEffect(() => {
    if (!authenticated) return;
    const onPopState = () => {
      const urlId = getChatIdFromUrl();
      if (urlId && urlId !== chatId) {
        loadChat(urlId).catch(() => {
          // ロード失敗（存在しないIDなど）→ ルートへリダイレクト
          window.location.replace('/');
        });
      } else if (!urlId) {
        // URLが / になったら新規チャット
        newChat();
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [authenticated, chatId]);

  // グローバル設定の自動保存（変更時、設定読み込み完了後のみ）
  useEffect(() => {
    if (!settingsLoadedRef.current) return;
    const t = setTimeout(async () => {
      try {
        await fetch('/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatModel, orchWorkflow: orchWorkflowId }),
        });
      } catch {}
    }, 500);
    return () => clearTimeout(t);
  }, [chatModel, orchWorkflowId]);

  // chatModel変更時、llama-serverのチャットモデルをロード（リスタート）
  useEffect(() => {
    if (!settingsLoadedRef.current) return;
    if (!chatModel) return;
    if (isLoading) return;  // 生成中はモデル切替しない
    let aborted = false;
    (async () => {
      try {
        // 現在ロード中モデルを確認、同じならスキップ
        const sres = await fetch('/models');
        if (!sres.ok) return;
        const sdata = await sres.json();
        // 既にロード中、または自動アンロードされた同じモデルなら何もしない
        // （リクエスト時に自動再ロードされるため）
        if (sdata.current === chatModel) return;
        if (sdata.autoUnloaded === chatModel) return;
        if (aborted) return;
        // モデル切替を要求
        setLoadingMessage(`モデル「${chatModel}」をロード中`);
        setError('');
        const res = await fetch('/models/load', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: chatModel }),
        });
        if (aborted) return;
        setLoadingMessage('');
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(`モデル切替失敗: ${data.error || res.status}`);
        } else {
          setError('');
        }
      } catch (e) {
        if (!aborted) {
          setLoadingMessage('');
          setError(`モデル切替エラー: ${e.message}`);
        }
      }
    })();
    return () => { aborted = true; };
  }, [chatModel, isLoading]);

  // モデル未ロード/起動中の状態をオレンジトーストで自動表示
  useEffect(() => {
    if (!authenticated || !connected) return;
    // ユーザーが手動でモデル切替中（既にloadingMessage設定済み）は上書きしない
    if (loadingMessage && loadingMessage.includes('をロード中') && !loadingMessage.includes('再ロード中')) return;
    // 初回ロード待ち or アイドルアンロード状態（実際に起動中ではない）→ トースト不要
    // 実際に起動中(modelStarting=true)になってからトーストを出す
    if (firstLoadPending || (autoUnloadedName && !modelStarting)) {
      // 古い表示は消す
      if (loadingMessage && (loadingMessage.includes('を再ロード中') || loadingMessage.includes('をロードします'))) {
        setLoadingMessage('');
      }
      return;
    }
    if (modelStarting) {
      // ロード中: autoUnloadedName が分かれば「再ロード中」、なければ「起動中」
      if (autoUnloadedName) {
        setLoadingMessage(`モデル「${autoUnloadedName}」を再ロード中`);
      } else {
        setLoadingMessage(`モデルを起動中`);
      }
    } else if (!modelReady && availableModels.length > 0) {
      setLoadingMessage(`モデルをロード中`);
    } else {
      // ロード完了したら自動表示はクリア（ユーザー操作のloadingMessageは別経路）
      if (loadingMessage === 'モデルを起動中'
          || loadingMessage === 'モデルをロード中'
          || (loadingMessage && (loadingMessage.includes('を再ロード中') || loadingMessage.includes('をロードします')))) {
        setLoadingMessage('');
      }
    }
  }, [modelReady, modelStarting, autoUnloadedName, firstLoadPending, authenticated, connected, availableModels.length]);

  // 新規チャットで最初のユーザーメッセージから自動タイトル生成
  useEffect(() => {
    if (chatTitle) return;  // 既にタイトルがあれば何もしない
    if (isLoading) return;  // 生成中は待つ
    if (messages.length === 0) return;
    // 最初のユーザーメッセージを探す
    const firstUser = messages.find(m => m.role === 'user');
    if (!firstUser) return;
    // 内容から30文字程度のタイトルを抽出
    const raw = (firstUser.content || '').trim();
    if (!raw || raw === '(画像を送信)') return;
    // 先頭30文字、改行は空白に、複数空白は1つに
    let title = raw.replace(/\s+/g, ' ').slice(0, 30);
    // 文末が中途半端なら省略記号
    if (raw.length > 30) title += '…';
    setChatTitle(title);
  }, [messages, isLoading, chatTitle]);

  // メッセージ・ドキュメント変更時に自動保存（1.5秒デバウンス）
  // ただし「履歴を開いただけ」では保存しない（並び順を維持するため）
  // messagesDirtyRef が true のときだけ保存する
  useEffect(() => {
    if (messages.length === 0 && documents.length === 0) return;
    if (isLoading) return;
    if (!messagesDirtyRef.current) return;  // dirty でなければ保存しない
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveChat(chatId, messages, chatTitle);
      messagesDirtyRef.current = false;  // 保存したらクリア
    }, 1500);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [messages, documents, isLoading]);

  // ─── エラー自動消去 ───
  useEffect(() => {
    if (error) {
      const t = setTimeout(() => setError(''), 5000);
      return () => clearTimeout(t);
    }
  }, [error]);

  const totalChunks = documents.reduce((s, d) => s + d.chunks.length, 0);

  // ─── ログイン処理 ───
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  async function handleLogin(e) {
    if (e) e.preventDefault();
    setLoginLoading(true);
    setLoginError('');
    try {
      const res = await fetch('/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: loginPassword }),
      });
      const data = await res.json();
      if (data.ok) {
        setAuthenticated(true);
      } else {
        setLoginError(data.error || 'パスワードが正しくありません');
      }
    } catch {
      setLoginError('接続に失敗しました');
    } finally {
      setLoginLoading(false);
    }
  }

  // ─── ログイン画面 ───
  if (hasPassword === null) {
    // 読み込み中
    return (
      <div className="login-screen">
        <div className="login-card">
          <div className="login-icon" />
          <div className="login-sub">読み込み中...</div>
        </div>
      </div>
    );
  }

  if (hasPassword && !authenticated) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <div className="login-icon" />
          <div className="login-title">{appConfig.appName}</div>
          <div className="login-sub">続行するにはパスワードを入力してください</div>
          <form onSubmit={handleLogin}>
            <input
              className="login-input"
              type="password"
              placeholder="パスワード"
              value={loginPassword}
              onChange={e => setLoginPassword(e.target.value)}
              autoFocus
            />
            <button className="login-btn" type="submit" disabled={loginLoading}>
              {loginLoading ? '認証中...' : 'ログイン'}
            </button>
          </form>
          {loginError && <div className="login-error">{loginError}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="app-layout">
      {/* ── Sidebar Overlay ── */}
      <div className={`sidebar-overlay ${sidebarOpen ? 'open' : ''}`} onClick={() => setSidebarOpen(false)} />

      {/* ── Sidebar ── */}
      <div className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <button className="sidebar-close-btn" onClick={() => setSidebarOpen(false)} title="サイドバーを閉じる">×</button>
        <div className="sidebar-header">
          <div className="logo">
            <div className="logo-icon"></div>
            <div className="logo-text">{appConfig.logoMain} <span>{appConfig.logoSub}</span></div>
          </div>
          <div className="settings-group">
            <div className="setting-row">
              <span className="setting-label">
                チャットモデル
                {isLoading && <span className="setting-locked-hint" title="生成中はモデルを切り替えられません">🔒</span>}
              </span>
              {/* 単一モデルと、マルチLLMワークフロー(config.jsonで定義)を同じ場所から選ぶ。
                  ワークフローは値を "wf:<id>" にして通常のモデル名と区別する */}
              <select
                className="setting-input"
                value={orchWorkflowId ? `wf:${orchWorkflowId}` : chatModel}
                onChange={e => {
                  const v = e.target.value;
                  if (v.startsWith('wf:')) setOrchWorkflowId(v.slice(3));
                  else { setOrchWorkflowId(''); setChatModel(v); }
                }}
                disabled={isLoading}
                title={isLoading ? '生成中はモデルを切り替えられません。停止してからやり直してください。' : ''}
              >
                {availableModels.length === 0 && <option value="">未接続</option>}
                {availableModels.map(m => {
                  const info = availableModelsInfo.find(x => x.name === m);
                  const label = info && info.ctx
                    ? `${m} (${info.ctx.toLocaleString()})`
                    : m;
                  return <option key={m} value={m}>{label}</option>;
                })}
                {orchInfo.enabled && (orchInfo.workflows || []).length > 0 && (
                  <optgroup label="🎼 マルチLLM（ワークフロー）">
                    {orchInfo.workflows.map(w => (
                      <option key={w.id} value={`wf:${w.id}`} title={w.description || ''}>
                        {w.name}（{(w.nodes || []).filter(n => n.type !== 'output').length}モデル）
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              {orchWorkflowId && (
                <div className="orch-selected-hint">
                  {(orchInfo.workflows.find(w => w.id === orchWorkflowId) || {}).description
                    || '複数モデルが連携して回答します'}
                  <span className="orch-selected-note">ツール実行・画像添付は使えません</span>
                </div>
              )}
            </div>
            <div className="nav-link-row">
              <a className="tuning-link" href="/tuning.html" title="ファインチューニング管理画面を開く">
                🧠 ファインチューニング
              </a>
              {appConfig.ml?.enabled && (
                <a className="tuning-link" href="/ml.html" title="機械学習データテーブル管理を開く">
                  🤖 機械学習
                </a>
              )}
              {appConfig.ocr?.enabled && (
                <a className="tuning-link" href="/ocr.html" title="PDFをOCRしてRAGに登録する画面を開く">
                  📄 OCR
                </a>
              )}
            </div>
          </div>
        </div>

        {/* ── Chat History ── */}
        <div className="chat-history-panel" style={{ height: chatHistoryHeight }}>
          <div className="chat-history-header">
            <span className="chat-history-title">チャット履歴</span>
            <button className="new-chat-btn" onClick={() => { newChat(); if (window.innerWidth <= 768) setSidebarOpen(false); }}>+ 新規</button>
          </div>
          <div className="chat-history-list">
            {chatList.length === 0 ? (
              <div className="chat-history-empty">履歴なし</div>
            ) : (
              chatList.map(c => (
                <div
                  key={c.id}
                  className={`chat-history-item ${c.id === chatId ? 'active' : ''}`}
                  onClick={() => { loadChat(c.id); if (window.innerWidth <= 768) setSidebarOpen(false); }}
                >
                  <div className="chat-history-item-info">
                    <div className="chat-history-item-title">{c.title}</div>
                    <div className="chat-history-item-meta">
                      {c.messageCount}件{c.docCount > 0 ? ` · ${c.docCount}文書` : ''} · {c.updatedAt ? new Date(c.updatedAt).toLocaleDateString('ja-JP') : ''}
                    </div>
                  </div>
                  <button
                    className="chat-history-item-copy"
                    onClick={async e => {
                      e.stopPropagation();
                      const url = `${window.location.origin}/chat/${c.id}`;
                      try {
                        await navigator.clipboard.writeText(url);
                        setError('');
                        setLoadingMessage(`✓ URLをコピーしました: ${url}`);
                        setTimeout(() => setLoadingMessage(''), 2000);
                      } catch {
                        setError(`URL: ${url}`);
                      }
                    }}
                    title="このチャットのURLをコピー"
                  >🔗</button>
                  <button
                    className="chat-history-item-delete"
                    onClick={e => { e.stopPropagation(); deleteChat(c.id); }}
                  >×</button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* ── リサイズハンドル（チャット履歴 / ドキュメントの境界） ── */}
        <div
          className="sidebar-resize-handle"
          onPointerDown={startHistoryResize}
          title="ドラッグして高さを調整"
          role="separator"
          aria-orientation="horizontal"
        />

        {/* Server Files input (hidden, used by right sidebar button) */}
        <input
          type="file"
          ref={serverFileInputRef}
          style={{ display: 'none' }}
          onChange={e => { if (e.target.files[0]) uploadServerFile(e.target.files[0]); e.target.value = ''; }}
        />

        {/* ── Documents ── */}
        <div className="docs-panel">
          <div className="docs-header">
            <div className="docs-header-top">
              <div className="docs-title">
                ドキュメント
                {documents.length > 0 && <span className="docs-count">{documents.length}件 / {totalChunks}チャンク</span>}
              </div>
            </div>
            <div className="docs-actions">
              <button className="upload-btn" onClick={() => fileInputRef.current?.click()}>
                + アップロード
              </button>
              {documents.length > 0 && (
                <button className="upload-btn" style={{ background: 'var(--red-dim)', color: 'var(--red)' }} onClick={() => setDocuments([])}>
                  すべて削除
                </button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={e => { handleFiles(e.target.files); e.target.value = ''; }}
            />
          </div>

          <div
            className={`docs-list ${dragActive ? 'drag-active' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragActive(true); }}
            onDragLeave={e => {
              // 子要素間の遷移ではdragLeaveが発火するため、子に入った場合は無視
              if (e.currentTarget.contains(e.relatedTarget)) return;
              setDragActive(false);
            }}
            onDrop={handleDrop}
          >
            {documents.length === 0 && embeddingJobs.length === 0 && (
              <div className="docs-empty">
                <div className="docs-empty-icon">📂</div>
                <div className="docs-empty-text">
                  ファイルをここにドロップ
                </div>
                <div className="docs-empty-sub">txt, md, csv, json, コードファイル, PDF, 画像 対応</div>
              </div>
            )}
            {embeddingJobs.map((job) => (
              <div key={job.id} className="doc-item loading">
                <div className="doc-info">
                  <div className="doc-icon loading-icon"></div>
                  <div className="doc-meta">
                    <div className="doc-name">{job.name}</div>
                    <div className="doc-progress">
                      <div className="doc-progress-bar" style={{ width: `${(job.current / job.total) * 100}%` }} />
                    </div>
                    <div className="doc-progress-text">
                      Embedding生成中... {job.current}/{job.total} チャンク
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {documents.map((doc, i) => (
              <div key={i} className="doc-item">
                <div className="doc-info">
                  <div className="doc-icon">📄</div>
                  <div className="doc-meta">
                    <div className="doc-name">{doc.name}</div>
                    <div className="doc-stats">{doc.chunks.length}チャンク · {(doc.text.length / 1000).toFixed(1)}K文字</div>
                  </div>
                </div>
                <button className="doc-remove" onClick={() => { setDocuments(prev => prev.filter((_, j) => j !== i)); messagesDirtyRef.current = true; }}>×</button>
              </div>
            ))}
            {persistentRagAvailable && persistentRagDocCount > 0 && (
              <div
                className="doc-item"
                style={{ background: 'var(--accent-dim, rgba(124,77,255,0.08))', cursor: 'help' }}
                title={`サーバーに登録済みのRAGドキュメント (${persistentRagDocCount}件): ${persistentRagDocNames.join(', ')}\nLLMが自動的にこれらを検索します`}
              >
                <div className="doc-info">
                  <div className="doc-icon">📚</div>
                  <div className="doc-meta">
                    <div className="doc-name">永続RAG (サーバー登録)</div>
                    <div className="doc-stats">{persistentRagDocCount}件のドキュメントを自動検索</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
        <a
          className="sidebar-settings-btn"
          href="/editconfig.html"
          title="config.json 編集"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
          <span>設定</span>
        </a>
      </div>

      {/* ── Chat Area ── */}
      <div className="chat-area">
        {chatLoading && (
          <div className="chat-loading-overlay">
            <div className="chat-loading-spinner" />
            <div className="chat-loading-text">チャットを読み込み中…</div>
          </div>
        )}
        <div className="chat-header">
          <div className="chat-header-left">
            <button className="menu-btn" onClick={() => setSidebarOpen(!sidebarOpen)}>☰</button>
            <div className={`status-dot ${connected ? 'connected' : ''}`} />
            <span className="chat-header-title">
              {!connected ? 'llama.cpp未接続'
                : orchWorkflowId
                  ? `🎼 ${(orchInfo.workflows.find(w => w.id === orchWorkflowId) || {}).name || 'マルチLLM'}`
                  : chatModel || 'モデル未選択'}
            </span>
            {messages.length > 0 && (
              <>
                <div className="chat-header-divider" />
                <input
                  className="chat-title-editable"
                  type="text"
                  value={chatTitle}
                  onChange={e => setChatTitle(e.target.value)}
                  onBlur={() => {
                    if (chatId && messages.length > 0) saveChat(chatId, messages, chatTitle || '無題');
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') e.target.blur();
                    if (e.key === 'Escape') e.target.blur();
                  }}
                  placeholder="タイトル未設定"
                  title="クリックで編集"
                />
                {chatRole && (
                  <button
                    className="role-indicator-btn"
                    onClick={() => setShowRoleEditor(v => !v)}
                    title={`役割設定済み:\n${chatRole}\n\nクリックで表示/編集`}
                  >
                    🎭
                  </button>
                )}
              </>
            )}
          </div>
          <div className="chat-header-right">
            <button
              className="clear-btn"
              onClick={createRagDocument}
              disabled={isLoading}
              title={messages.length > 0
                ? '現在のチャットを要約してRAGドキュメントとして保存し、新規チャットを開始（過去の文脈を継続）'
                : '新規チャットを開始'}
            >
              💬 継続チャット
            </button>
            <button className={`clear-btn ${gpuPanelOpen && rightPanelTab === 'files' ? 'gpu-btn-active' : ''}`} onClick={() => { setRightPanelTab('files'); setGpuPanelOpen(rightPanelTab !== 'files' || !gpuPanelOpen); loadFileList(); }}>
              📁 ファイル{fileList.length > 0 && ` (${fileList.length})`}
            </button>
            <button className={`clear-btn ${gpuPanelOpen && rightPanelTab === 'gpu' ? 'gpu-btn-active' : ''}`} onClick={() => { setRightPanelTab('gpu'); setGpuPanelOpen(rightPanelTab !== 'gpu' || !gpuPanelOpen); }}>
              {gpuData.some(g => g.gpus?.length > 0) && <span className="gpu-header-dot" />}
              GPU
            </button>
          </div>
        </div>

        <div className="messages-container" ref={containerRef}>
          {/* メッセージ送信後の役割編集モーダル */}
          {messages.length > 0 && showRoleEditor && (
            <div className="role-modal-overlay" onClick={() => setShowRoleEditor(false)}>
              <div className="role-modal" onClick={e => e.stopPropagation()}>
                <div className="role-modal-header">
                  <span>🎭 LLMの役割・指示</span>
                  <button className="role-modal-close" onClick={() => setShowRoleEditor(false)}>×</button>
                </div>
                <textarea
                  className="role-editor-textarea"
                  value={chatRole}
                  onChange={e => setChatRole(e.target.value)}
                  placeholder="例: あなたは熟練のPythonエンジニアです。"
                  rows={8}
                  autoFocus
                />
                <div className="role-editor-actions">
                  <button className="role-btn-cancel" onClick={() => { setChatRole(''); setShowRoleEditor(false); }}>クリア</button>
                  <button className="role-btn-save" onClick={() => setShowRoleEditor(false)}>確定</button>
                </div>
                <div className="role-editor-hint">
                  💡 役割は次のメッセージから反映されます。チャット履歴に保存されます。
                </div>
              </div>
            </div>
          )}
          {messages.length === 0 ? (
            <div className="welcome-screen">
              <div className="welcome-icon"></div>
              <div className="welcome-title">{appConfig.appName}</div>
              <div className="welcome-sub">
                {appConfig.welcomeMessage}
              </div>
              <div className="welcome-hints">
                {appConfig.welcomeHints.map(h => (
                  <div key={h} className="hint-chip" onClick={() => { setInput(h); inputRef.current?.focus(); }}>{h}</div>
                ))}
              </div>
              {/* 役割設定UI */}
              <div className="role-editor-section">
                {!showRoleEditor && !chatRole && (
                  <button className="role-editor-toggle" onClick={() => setShowRoleEditor(true)}>
                    🎭 LLMに役割を与える（任意）
                  </button>
                )}
                {!showRoleEditor && chatRole && (
                  <div className="role-display" onClick={() => setShowRoleEditor(true)} title="クリックして編集">
                    <span className="role-badge">🎭 役割設定済み</span>
                    <div className="role-preview">{chatRole.length > 100 ? chatRole.slice(0, 100) + '…' : chatRole}</div>
                  </div>
                )}
                {showRoleEditor && (
                  <div className="role-editor">
                    <div className="role-editor-label">
                      🎭 LLMの役割・指示（システムプロンプトに追加されます）
                    </div>
                    <textarea
                      className="role-editor-textarea"
                      value={chatRole}
                      onChange={e => setChatRole(e.target.value)}
                      placeholder="例:&#10;・あなたは熟練のPythonエンジニアです。コードレビューで具体的な改善案を提示してください。&#10;・あなたは小学生向けに優しく説明する先生です。専門用語は避けて例え話を使ってください。&#10;・回答は必ず3行以内、関西弁で。"
                      rows={6}
                    />
                    <div className="role-editor-actions">
                      <button className="role-btn-cancel" onClick={() => { setChatRole(''); setShowRoleEditor(false); }}>クリア</button>
                      <button className="role-btn-save" onClick={() => setShowRoleEditor(false)}>確定</button>
                    </div>
                    <div className="role-editor-hint">
                      💡 役割を与えると応答スタイルが大きく変わります。チャット中はヘッダー左の「役割」表示から再編集できます。
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            messages.map((msg, i) => (
              <div key={i} className={`message ${msg.role}`}>
                <div
                  className={`msg-avatar ${msg.role === 'assistant' ? 'assistant-av' : 'user-av'}`}
                  style={msg.role !== 'assistant' && appConfig.userIcon
                    ? { backgroundImage: `url("${appConfig.userIcon}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
                    : undefined}
                >
                  {msg.role === 'assistant' ? '' : (appConfig.userIcon ? '' : 'U')}
                </div>
                <div className="msg-content">
                  {msg.thinking && (
                    <ThinkingBlock
                      thinking={msg.thinking}
                      isStreaming={isLoading && i === messages.length - 1}
                    />
                  )}
                  {(msg.searchQueries?.length > 0 || msg.agentStatus) && (
                    <div className="agent-activity">
                      <div className="agent-activity-header">
                        <span className={`agent-activity-dot ${msg.agentStatus ? '' : 'done'}`} />
                        {msg.agentStatus || `${msg.searchQueries.length}回検索完了`}
                      </div>
                      {msg.searchQueries?.map((sq, si) => (
                        <div key={si} className="agent-search-item">
                          {/* 画像/音声生成はクエリ文に説明があるため、2行目のアイコンは省略（重複防止） */}
                          {sq.type !== 'image' && sq.type !== 'audio' && (
                            <span className="agent-search-icon">{sq.type === 'web' ? '🌐' : sq.type === 'file' ? '📁' : sq.type === 'data' ? '🗂️' : sq.type === 'gdrive' ? '☁️' : '🔍'}</span>
                          )}
                          <span className="agent-search-query">{sq.query}</span>
                          {sq.resultCount != null && (
                            <span className="agent-search-result">{sq.resultCount}件</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {/* 永続RAGの出典対応表。回答中の【S1】がどの資料の何ページかを示す。
                      モデルの出力ではなく検索結果のデータから描くので、
                      資料名が書き崩されることがない */}
                  {msg.ragSources?.length > 0 && (
                    <div className="rag-sources">
                      <div className="rag-sources-title">📚 出典</div>
                      {msg.ragSources.map(s => (
                        <div key={s.key} className="rag-source-item">
                          <span className="rag-source-key">{s.key}</span>
                          <span className="rag-source-name" title={s.filename}>{s.filename.replace(/\.md$/, '')}</span>
                          {s.pageText && <span className="rag-source-page">p.{s.pageText}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                  {msg.orchestra && <OrchestraPanel orch={msg.orchestra} />}
                  {msg.role === 'assistant' ? (
                    <div className="msg-bubble">
                      <MarkdownContent content={msg.content} />
                    </div>
                  ) : (
                    <React.Fragment>
                      {msg.images && msg.images.length > 0 && (
                        <div className="msg-images">
                          {msg.images.map((img, imgIdx) => (
                            <img
                              key={imgIdx}
                              src={img.preview || `data:image/jpeg;base64,${img.base64}`}
                              alt={img.name}
                              className="msg-image-thumb"
                              onClick={() => setLightboxSrc(img.preview || `data:image/jpeg;base64,${img.base64}`)}
                            />
                          ))}
                        </div>
                      )}
                      <div className="msg-bubble user-bubble">{msg.content}</div>
                    </React.Fragment>
                  )}
                  {msg.role === 'assistant' && !(isLoading && i === messages.length - 1) && (msg.content || msg.thinking) && (
                    <div className="msg-actions">
                      {msg.content && (
                        <>
                          <button className="msg-action-btn" onClick={() => downloadMarkdown(msg.content, i)}>
                            📥 ダウンロード
                          </button>
                          <button className="msg-action-btn" onClick={() => addResponseToDocuments(msg.content, i)}>
                            📄 ドキュメントに追加
                          </button>
                          {(typeof window !== 'undefined' && window.speechSynthesis) && (
                            <button className="msg-action-btn" onClick={() => toggleSpeak(msg.content, i)}>
                              {speakingIndex === i ? '⏹️ 停止' : '🔊 読み上げ'}
                            </button>
                          )}
                        </>
                      )}
                      {/* 思考のみで本応答が空 or 応答が途中で切れた場合に「続ける」ボタン */}
                      {i === messages.length - 1 && (!msg.content || msg.thinking) && (
                        <button className="msg-action-btn continue-btn" onClick={() => continueGeneration(i)}>
                          {msg.loopDetected ? '⚠️ 思考ループを中断・回答を要求' : '🔄 続きを生成'}
                        </button>
                      )}
                    </div>
                  )}
                  {msg.contexts && (() => {
                    // 資料の出どころによって出せる情報が違う:
                    //   ・RAG検索  → 類似度スコアあり
                    //   ・GDrive   → 直接読み込みなのでスコアなし。代わりにファイル名とリンク
                    // スコアが無いものに「類似度: NaN%」と出さないよう、数値がある時だけ表示する。
                    const grouped = {};
                    msg.contexts.forEach(c => {
                      const key = c.docName;
                      const score = typeof c.score === 'number' && isFinite(c.score) ? c.score : null;
                      if (!grouped[key]) {
                        grouped[key] = { bestScore: score, count: 1, source: c.source || null, url: c.url || null };
                      } else {
                        grouped[key].count++;
                        if (score !== null && (grouped[key].bestScore === null || score > grouped[key].bestScore)) {
                          grouped[key].bestScore = score;
                        }
                        if (!grouped[key].url && c.url) grouped[key].url = c.url;
                      }
                    });
                    const entries = Object.entries(grouped);
                    return (
                      <div className="msg-context">
                        <div className="msg-context-label">参照した資料</div>
                        {entries.map(([name, info], j) => (
                          <div key={j} style={{ marginTop: j > 0 ? 6 : 0 }}>
                            {info.source && <span className="msg-context-source">{info.source}</span>}
                            {info.url
                              ? <a className="msg-context-link" href={info.url} target="_blank" rel="noreferrer" title="GDrive で開く">{name}</a>
                              : <strong>{name}</strong>}
                            {info.bestScore !== null && ` (類似度: ${(info.bestScore * 100).toFixed(1)}%)`}
                            {info.count > 1 && ` — ${info.count}チャンク参照`}
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                  {msg.tokenInfo && !(isLoading && i === messages.length - 1) && (() => {
                    const total = msg.tokenInfo.promptTokens + msg.tokenInfo.completionTokens;
                    const pct = numCtx > 0 ? Math.round(total / numCtx * 100) : 0;
                    const barColor = pct >= 90 ? 'var(--red)' : pct >= 70 ? 'var(--orange)' : 'var(--green)';
                    return (
                      <div className="token-info">
                        <div className="token-info-items">
                          <div className="token-info-item">
                            <span className="token-info-label">入力:</span>
                            <span className="token-info-value">{msg.tokenInfo.promptTokens.toLocaleString()}</span>
                          </div>
                          <div className="token-info-item">
                            <span className="token-info-label">出力:</span>
                            <span className="token-info-value">{msg.tokenInfo.completionTokens.toLocaleString()}</span>
                          </div>
                          <div className="token-info-item">
                            <span className="token-info-label">計:</span>
                            <span className="token-info-value">{total.toLocaleString()}</span>
                          </div>
                        </div>
                        <div className="token-info-item">
                          <span className="token-info-label">{pct}%</span>
                          <div className="ctx-bar-wrap">
                            <div className="ctx-bar-fill" style={{ width: `${Math.min(pct, 100)}%`, background: barColor }} />
                          </div>
                          <span className="token-info-label">{(numCtx / 1024).toFixed(0)}K</span>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>
            ))
          )}
          {isLoading && messages[messages.length - 1]?.role !== 'assistant' && (
            <div className="message assistant">
              <div className="msg-avatar assistant-av"></div>
              <div className="thinking-indicator">
                <div className="thinking-dots"><span /><span /><span /></div>
                考え中...
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div
          className={`input-area ${chatDragActive ? 'drag-active' : ''}`}
          onDragOver={e => {
            // ファイルがドラッグされている場合のみ反応
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              setChatDragActive(true);
            }
          }}
          onDragLeave={e => {
            if (e.currentTarget.contains(e.relatedTarget)) return;
            setChatDragActive(false);
          }}
          onDrop={handleChatDrop}
        >
          <div className="input-card">
            {chatImages.length > 0 && (
              <div className="image-preview-bar">
                {chatImages.map((img, idx) => (
                  <div key={idx} className="image-preview-item">
                    <img src={img.preview} alt={img.name} />
                    <button className="image-preview-remove" onClick={() => setChatImages(prev => prev.filter((_, j) => j !== idx))}>×</button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={inputRef}
              className="input-box"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
              onPaste={handlePaste}
              placeholder={connected ? 'メッセージを入力...（画像も貼り付け可）' : 'llama.cppサーバーに接続してください...'}
              rows={1}
              disabled={!connected}
              onInput={e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px'; }}
            />
            <div className="input-toolbar">
              <div className="input-toolbar-left">
                <button className="toolbar-btn" title="ドキュメントを追加" onClick={() => fileInputRef.current?.click()}>
                  📎
                </button>
                <button className="toolbar-btn" title="画像を追加" onClick={() => imageInputRef.current?.click()}>
                  🖼️
                </button>
                {(typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)) && (
                  <button
                    className={`toolbar-btn ${isRecording ? 'mic-recording' : ''}`}
                    title={isRecording ? '録音停止' : 'マイク録音（Web Speech API・日本語）'}
                    onClick={toggleRecording}
                  >
                    {isRecording ? '🔴' : '🎤'}
                  </button>
                )}
                {appConfig.webSearch !== false && (
                  <button
                    className={`toolbar-btn web-search-toggle ${webSearchEnabled ? 'active' : ''}`}
                    title={webSearchEnabled ? 'Web検索: ON（クリックでOFF）' : 'Web検索: OFF（クリックでON）'}
                    onClick={() => setWebSearchEnabled(v => !v)}
                  >
                    🌐
                  </button>
                )}
                {/* Google Drive: 設定で有効な時だけ出す。未接続ならクリックで接続パネルへ誘導 */}
                {appConfig.googleDrive?.enabled && (
                  <button
                    className={`toolbar-btn gdrive-toggle ${gdriveStatus?.connected && gdriveEnabled ? 'active' : ''}`}
                    title={
                      !gdriveStatus?.connected
                        ? 'GDrive: 未接続（クリックで接続パネルを開く）'
                        : gdriveEnabled
                          ? `GDrive: ON（クリックでOFF）${gdriveStatus.account ? ` / ${gdriveStatus.account}` : ''}`
                          : 'GDrive: OFF（クリックでON）'
                    }
                    onClick={() => {
                      if (!gdriveStatus?.connected) {
                        setRightPanelTab('gdrive');
                        setGpuPanelOpen(true);
                        loadGdriveStatus();
                        return;
                      }
                      setGdriveEnabled(v => !v);
                    }}
                  >
                    ☁️
                  </button>
                )}
              </div>
              {isLoading ? (
                <button className="stop-btn" onClick={stopGeneration} title="生成を停止">
                  <div className="stop-icon" />
                </button>
              ) : (
                <button
                  className="send-btn"
                  onClick={sendMessage}
                  disabled={(!input.trim() && chatImages.length === 0) || !connected || embeddingJobs.length > 0
                    || (!orchWorkflowId && !modelReady && !firstLoadPending && !autoUnloadedName)}
                  title={
                    orchWorkflowId ? '送信時に必要なモデルを順次ロードします'
                    : firstLoadPending ? '送信時にモデルをロードします'
                    : autoUnloadedName && !modelReady ? '送信時にモデルを再ロードします'
                    : !modelReady ? (modelStarting ? 'モデル起動中です' : 'モデルがロードされていません')
                    : embeddingJobs.length > 0 ? 'ドキュメントのEmbedding生成中です。完了までお待ちください'
                    : ''
                  }
                >
                  ➤
                </button>
              )}
            </div>
          </div>
          <input
            ref={imageInputRef}
            type="file"
            multiple
            accept="image/*"
            style={{ display: 'none' }}
            onChange={e => { handleImageFiles(e.target.files); e.target.value = ''; }}
          />
          <div className="input-hint">Shift + Enter で改行</div>
        </div>
      </div>

      {/* ── Right Sidebar: GPU Monitor / Server Files ── */}
      <div className={`right-sidebar-overlay ${gpuPanelOpen ? 'open' : ''}`} onClick={() => setGpuPanelOpen(false)} />
      <div className={`right-sidebar ${gpuPanelOpen ? 'open' : ''}`}>
        <div className="right-sidebar-header">
          <div className="gpu-panel-title" style={{ margin: 0 }}>
            {rightPanelTab === 'gpu' && <>{gpuData.some(g => g.gpus?.length > 0) && <span className="gpu-live-dot" />} GPU モニター</>}
            {rightPanelTab === 'files' && <>📁 サーバーファイル</>}
            {rightPanelTab === 'gdrive' && <>☁️ GDrive</>}
            {rightPanelTab === 'api' && <>🌐 外部APIサーバー</>}
          </div>
          <button className="clear-btn" onClick={() => setGpuPanelOpen(false)}>✕</button>
        </div>
        <div className="gpu-panel-body">
          <div className="right-panel-tabs">
            <button className={`right-panel-tab ${rightPanelTab === 'gpu' ? 'active' : ''}`} onClick={() => setRightPanelTab('gpu')}>
              {gpuData.some(g => g.gpus?.length > 0) && <span className="gpu-header-dot" />}
              GPU
            </button>
            <button className={`right-panel-tab wide ${rightPanelTab === 'files' ? 'active' : ''}`} onClick={() => { setRightPanelTab('files'); loadFileList(); }}>
              📁 ファイル{fileList.length > 0 && ` (${fileList.length})`}
            </button>
            {appConfig.googleDrive?.enabled && (
              <button
                className={`right-panel-tab ${rightPanelTab === 'gdrive' ? 'active' : ''}`}
                onClick={async () => {
                  setRightPanelTab('gdrive');
                  const st = await loadGdriveStatus();
                  if (st?.connected && gdriveFiles.length === 0) loadGdriveFiles(gdriveFolderId, gdriveQuery);
                }}
              >
                ☁️ GDrive
              </button>
            )}
            <button className={`right-panel-tab ${rightPanelTab === 'api' ? 'active' : ''}`} onClick={() => { setRightPanelTab('api'); loadExternalServers(); }}>
              🌐 API{externalServers.length > 0 && ` (${externalServers.length})`}
            </button>
          </div>

          {rightPanelTab === 'gpu' && (
            <>
              {(() => {
                const lv = gpuData.find(g => g.llamaVersion)?.llamaVersion;
                if (!lv) return null;
                const label = lv.build
                  ? `b${lv.build}${lv.commit ? ` (${lv.commit})` : ''}`
                  : lv.raw;
                return (
                  <div className="llama-version-card" title={lv.raw}>
                    <span className="llama-version-icon">🦙</span>
                    <span className="llama-version-label">llama.cpp</span>
                    <span className="llama-version-value">{label}</span>
                  </div>
                );
              })()}
              {tokenSpeed && (
                <div className="inference-speed-card">
                  <div className="inference-speed-label">推論速度（直近平均）</div>
                  <div>
                    <span className="inference-speed-value">{tokenSpeed.tokPerSec.toFixed(1)}</span>
                    <span className="inference-speed-unit">tok/s</span>
                  </div>
                  <div className="inference-speed-meta">
                    直近 {tokenSpeed.totalTokens.toLocaleString()} トークン / {tokenSpeed.samples} 回
                  </div>
                </div>
              )}
              {/* VRAM強制解放: 学習を回したい・他アプリにGPUを譲りたいときに使う */}
              {(() => {
                const t = releaseTargets;
                const loaded = [];
                if (t?.chat) loaded.push({ icon: '💬', text: t.chat });
                if (t?.embedding) loaded.push({ icon: '📐', text: 'Embedding' });
                for (const w of (t?.pool || [])) loaded.push({ icon: '🎼', text: w });
                if (t?.image) loaded.push({ icon: '🖼️', text: typeof t.image === 'string' ? t.image : '画像生成' });
                if (t?.tts) loaded.push({ icon: '🔊', text: '音声合成' });
                return (
                  <div className="vram-release-card">
                    <div className="vram-release-head">
                      <span className="vram-release-title">VRAM使用中のモデル</span>
                      <span className="vram-release-count">{loaded.length}</span>
                    </div>
                    {loaded.length === 0 ? (
                      <div className="vram-release-empty">なし（すべてアンロード済み）</div>
                    ) : (
                      <div className="vram-release-list">
                        {loaded.map((x, i) => (
                          <div key={i} className="vram-release-item">
                            <span>{x.icon}</span>
                            <span className="vram-release-name">{x.text}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {t?.external > 0 && (
                      <div className="vram-release-note">
                        外部APIサーバー {t.external}台は対象外（🌐 API タブから個別に停止できます）
                      </div>
                    )}
                    <button className="vram-release-btn"
                      onClick={releaseVram}
                      disabled={releasing || loaded.length === 0}
                      title={loaded.length === 0
                        ? '解放できるモデルがありません'
                        : 'ロード中のモデルを全てアンロードしてVRAMを空けます'}>
                      {releasing ? '解放中...' : '🧹 強制的にVRAMを解放'}
                    </button>
                    {releaseResult && (
                      <div className="vram-release-result">
                        ✓ {releaseResult.released.length > 0
                          ? releaseResult.released.join(' / ')
                          : '対象なし'}
                        {releaseResult.freedMB > 0 && (
                          <div className="vram-release-freed">
                            {(releaseResult.vramBeforeMB / 1024).toFixed(1)}GB →
                            {' '}{(releaseResult.vramAfterMB / 1024).toFixed(1)}GB
                            （{(releaseResult.freedMB / 1024).toFixed(1)}GB 解放）
                          </div>
                        )}
                        {releaseResult.errors.length > 0 && (
                          <div className="vram-release-err">⚠️ {releaseResult.errors.join(' / ')}</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}
              {(() => {
                const allGpus = gpuData.reduce((s, g) => s + (g.gpus?.length || 0), 0);
                if (allGpus === 0) return <div className="gpu-offline">GPU 未検出</div>;
                return gpuData.map((group, bi) => (
                  <div key={bi} className="gpu-host-group">
                    {gpuData.length > 1 && (
                      <div className="gpu-host-label">
                        <span className={`gpu-host-dot ${group.gpus?.length > 0 ? 'online' : 'offline'}`} />
                        {group.label} ({group.host})
                      </div>
                    )}
                    {(group.gpus || []).map((gpu, gi) => {
                      const vramPct = gpu.vramPct || 0;
                      const tempClass = gpu.temp >= 90 ? 'hot' : gpu.temp >= 70 ? 'warn' : 'normal';
                      const hotspotClass = gpu.tempHotspot >= 100 ? 'hot' : gpu.tempHotspot >= 80 ? 'warn' : 'normal';
                      const usageClass = gpu.usage >= 90 ? 'hot' : gpu.usage >= 60 ? 'warn' : 'normal';
                      const vramColor = vramPct >= 90 ? 'var(--red)' : vramPct >= 70 ? 'var(--orange)' : 'var(--green)';
                      return (
                        <div key={gi} className="gpu-card">
                          <div className="gpu-card-label">
                            <span className="gpu-card-id">{gpu.id}</span>
                            {gpu.name && <span className="gpu-card-name">{gpu.name}</span>}
                          </div>
                          <div className="gpu-stats-grid">
                            <div className="gpu-stat">
                              <div className="gpu-stat-label">使用率</div>
                              <div className={`gpu-stat-value ${usageClass}`}>{gpu.usage}%</div>
                            </div>
                            <div className="gpu-stat">
                              <div className="gpu-stat-label">温度 (Edge)</div>
                              <div className={`gpu-stat-value ${tempClass}`}>{gpu.temp}°C</div>
                            </div>
                            <div className="gpu-stat">
                              <div className="gpu-stat-label">電力</div>
                              <div className="gpu-stat-value normal">{gpu.power}W</div>
                            </div>
                            {gpu.tempHotspot > 0 && (
                              <div className="gpu-stat">
                                <div className="gpu-stat-label">温度 (Hotspot)</div>
                                <div className={`gpu-stat-value ${hotspotClass}`}>{gpu.tempHotspot}°C</div>
                              </div>
                            )}
                            <div className="gpu-stat">
                              <div className="gpu-stat-label">SCLK</div>
                              <div className="gpu-stat-value normal">{gpu.sclk || 'N/A'}{gpu.sclk ? 'MHz' : ''}</div>
                            </div>
                            <div className="gpu-stat">
                              <div className="gpu-stat-label">MCLK</div>
                              <div className="gpu-stat-value normal">{gpu.mclk || 'N/A'}{gpu.mclk ? 'MHz' : ''}</div>
                            </div>
                          </div>
                          <div className="gpu-stat" style={{ marginTop: 8 }}>
                            <div className="gpu-stat-label">VRAM {gpu.vramUsedMB || 0}MB / {gpu.vramTotalMB || 0}MB ({vramPct}%)</div>
                            <div className="gpu-vram-bar">
                              <div className="gpu-vram-fill" style={{ width: `${vramPct}%`, background: vramColor }} />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ));
              })()}
            </>
          )}

          {rightPanelTab === 'files' && (
            <div
              className={`files-panel-body ${serverDragActive ? 'drag-active' : ''}`}
              onDragOver={e => {
                if (e.dataTransfer.types.includes('Files')) {
                  e.preventDefault();
                  setServerDragActive(true);
                }
              }}
              onDragLeave={e => {
                if (e.currentTarget.contains(e.relatedTarget)) return;
                setServerDragActive(false);
              }}
              onDrop={handleServerDrop}
            >
              <button className="files-upload-btn" onClick={() => serverFileInputRef.current?.click()}>
                + ファイルをアップロード
              </button>
              {fileList.length === 0 ? (
                <div className="files-empty">
                  <div className="docs-empty-icon">📂</div>
                  <div>ファイルがありません</div>
                  <div className="docs-empty-sub">ここにファイルをドロップ</div>
                </div>
              ) : (
                fileList.map(f => (
                  <div key={f.path} className="server-file-item" onClick={() => downloadServerFile(f.path)} title="クリックでダウンロード">
                    <div className="server-file-info">
                      <div className="server-file-name">{f.path}</div>
                      <div className="server-file-meta">
                        {formatBytes(f.size)} · {f.modified ? new Date(f.modified).toLocaleDateString('ja-JP') + ' ' + new Date(f.modified).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : ''}
                      </div>
                    </div>
                    <button
                      className="server-file-delete"
                      onClick={e => { e.stopPropagation(); deleteServerFile(f.path); }}
                      title="削除"
                    >×</button>
                  </div>
                ))
              )}
            </div>
          )}

          {rightPanelTab === 'gdrive' && (
            <div className="gdrive-panel-body">
              {/* ── 接続状態 ── */}
              <div className="gdrive-status-card">
                <div className="gdrive-status-row">
                  <span className={`gdrive-status-dot ${gdriveStatus?.connected ? 'ok' : 'ng'}`} />
                  <span className="gdrive-status-text">
                    {gdriveStatus?.connected
                      ? `接続中${gdriveStatus.account ? `: ${gdriveStatus.account}` : ''}`
                      : '未接続'}
                  </span>
                  {gdriveStatus?.connected && (
                    <span className={`gdrive-mode-badge ${gdriveStatus.allowWrite ? 'rw' : 'ro'}`}>
                      {gdriveStatus.allowWrite ? '読み書き可' : '読み取り専用'}
                    </span>
                  )}
                </div>
                {!gdriveStatus?.connected && gdriveStatus?.reason && (
                  <div className="gdrive-status-hint">{gdriveStatus.reason}</div>
                )}
                {gdriveStatus?.rootFolderId && (
                  <div className="gdrive-status-hint">
                    アクセス範囲を限定中 (rootFolderId: {gdriveStatus.rootFolderId})
                  </div>
                )}
                <div className="gdrive-status-actions">
                  {gdriveStatus?.connected ? (
                    <>
                      <button className="gdrive-btn" disabled={gdriveBusy} onClick={() => loadGdriveFiles(gdriveFolderId, gdriveQuery)}>
                        🔄 更新
                      </button>
                      {gdriveStatus.authMode === 'oauth' && (
                        <button className="gdrive-btn danger" disabled={gdriveBusy} onClick={disconnectGdrive}>
                          連携解除
                        </button>
                      )}
                    </>
                  ) : gdriveStatus?.authMode === 'serviceAccount' ? (
                    <span className="gdrive-status-hint">
                      サービスアカウント方式です。config.json の googleDrive.serviceAccountKeyFile を設定して再起動してください。
                    </span>
                  ) : (
                    <button
                      className="gdrive-btn primary"
                      disabled={gdriveBusy || !gdriveStatus?.hasClientId}
                      onClick={connectGdrive}
                      title={gdriveStatus?.hasClientId ? '' : 'config.json の googleDrive.clientId / clientSecret を設定してください'}
                    >
                      🔗 GDrive に接続
                    </button>
                  )}
                </div>
              </div>

              {gdriveError && <div className="gdrive-error">{gdriveError}</div>}

              {gdriveStatus?.connected && (
                <>
                  {/* ── 検索 ── */}
                  <div className="gdrive-search-row">
                    <input
                      className="gdrive-search-input"
                      placeholder="GDrive 内を検索（ファイル名・本文）"
                      value={gdriveQuery}
                      onChange={e => setGdriveQuery(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') loadGdriveFiles(gdriveFolderId, gdriveQuery); }}
                    />
                    <button className="gdrive-btn" onClick={() => loadGdriveFiles(gdriveFolderId, gdriveQuery)}>🔍</button>
                    {gdriveQuery && (
                      <button className="gdrive-btn" onClick={() => { setGdriveQuery(''); loadGdriveFiles(gdriveFolderId, ''); }}>✕</button>
                    )}
                  </div>

                  {/* ── パンくず ── */}
                  {!gdriveQuery && (
                    <div className="gdrive-breadcrumb">
                      {gdriveBreadcrumb.map((c, i) => (
                        <React.Fragment key={`${c.id}-${i}`}>
                          {i > 0 && <span className="gdrive-breadcrumb-sep">/</span>}
                          <button
                            className={`gdrive-breadcrumb-item ${i === gdriveBreadcrumb.length - 1 ? 'current' : ''}`}
                            onClick={() => gdriveNavigateTo(i)}
                          >
                            {c.name}
                          </button>
                        </React.Fragment>
                      ))}
                    </div>
                  )}

                  {/* ── ファイル一覧 ── */}
                  {gdriveLoading ? (
                    <div className="gdrive-loading">読み込み中...</div>
                  ) : gdriveFiles.length === 0 ? (
                    <div className="files-empty">
                      <div className="docs-empty-icon">☁️</div>
                      <div>{gdriveQuery ? '該当するファイルがありません' : 'このフォルダは空です'}</div>
                    </div>
                  ) : (
                    gdriveFiles.map(f => (
                      <div key={f.id} className="gdrive-file-item">
                        <div
                          className="gdrive-file-main"
                          onClick={() => { if (f.isFolder) openGdriveFolder(f); }}
                          title={f.isFolder ? 'クリックで開く' : f.name}
                          style={{ cursor: f.isFolder ? 'pointer' : 'default' }}
                        >
                          <span className="gdrive-file-icon">
                            {f.isFolder ? '📁'
                              : f.mimeType?.includes('spreadsheet') ? '📊'
                              : f.mimeType?.includes('presentation') ? '📽️'
                              : f.mimeType?.includes('document') ? '📝'
                              : f.mimeType?.startsWith('image/') ? '🖼️'
                              : f.mimeType === 'application/pdf' ? '📕'
                              : '📄'}
                          </span>
                          <div className="gdrive-file-info">
                            <div className="gdrive-file-name">{f.name}</div>
                            <div className="gdrive-file-meta">
                              {f.size ? formatBytes(f.size) : (f.isFolder ? 'フォルダ' : '—')}
                              {f.modifiedTime && ` · ${new Date(f.modifiedTime).toLocaleDateString('ja-JP')}`}
                            </div>
                          </div>
                        </div>
                        {!f.isFolder && (
                          <div className="gdrive-file-actions">
                            <button
                              className="gdrive-icon-btn"
                              disabled={gdriveBusy}
                              title="サーバー (uploads) に取り込む"
                              onClick={() => importGdriveFile(f)}
                            >⬇️</button>
                            <button
                              className="gdrive-icon-btn"
                              title="ダウンロード"
                              onClick={() => downloadGdriveFile(f)}
                            >💾</button>
                            {f.webViewLink && (
                              <a
                                className="gdrive-icon-btn"
                                href={f.webViewLink}
                                target="_blank"
                                rel="noreferrer"
                                title="GDrive で開く"
                              >↗️</a>
                            )}
                          </div>
                        )}
                      </div>
                    ))
                  )}

                  {/* ── uploads → GDrive アップロード ── */}
                  {gdriveStatus.allowWrite && fileList.length > 0 && (
                    <div className="gdrive-upload-section">
                      <div className="gdrive-section-title">サーバーのファイルをこのフォルダにアップロード</div>
                      <select
                        className="gdrive-upload-select"
                        defaultValue=""
                        disabled={gdriveBusy}
                        onChange={e => {
                          const v = e.target.value;
                          e.target.value = '';
                          if (v) uploadToGdrive(v);
                        }}
                      >
                        <option value="">-- uploads からファイルを選択 --</option>
                        {fileList.map(f => (
                          <option key={f.path} value={f.path}>{f.path} ({formatBytes(f.size)})</option>
                        ))}
                      </select>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {rightPanelTab === 'api' && (
            <div className="api-panel-body">
              <div className="api-section">
                <div className="api-section-title">外部APIサーバー起動</div>
                <div className="api-form">
                  <label className="api-form-label">
                    <span>モデル</span>
                    <select className="api-form-select" value={apiFormModel} onChange={e => setApiFormModel(e.target.value)}>
                      <option value="">選択してください</option>
                      {appConfig.chatModels?.map(m => (
                        <option key={m.name} value={m.name}>{m.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="api-form-label">
                    <span>公開範囲（リッスンするインターフェース）</span>
                    <select className="api-form-select" value={apiFormHost} onChange={e => setApiFormHost(e.target.value)}>
                      <option value="0.0.0.0">外部公開（0.0.0.0 - 全インターフェース）</option>
                      <option value="127.0.0.1">ローカルのみ（127.0.0.1）</option>
                    </select>
                    <span className="api-form-hint">
                      ※ 外部公開を選ぶと、サーバーのドメイン/IPからアクセス可能（DNSが解決すれば <code>llm.example.com</code> でもOK）。<br />
                      ファイアウォール・ポート開放も必要。
                    </span>
                  </label>
                  <label className="api-form-label">
                    <span>ポート</span>
                    <input className="api-form-input" type="number" min="1" max="65535" value={apiFormPort} onChange={e => setApiFormPort(parseInt(e.target.value) || 0)} placeholder="11434" />
                    <span className="api-form-hint">デフォルトは <code>11434</code>（Ollama互換のため）。既存のポート（3000, 8080, 8081）と被らないように。</span>
                  </label>
                  <label className="api-form-label">
                    <span>APIキー (空欄で自動生成)</span>
                    <input className="api-form-input" type="text" value={apiFormKey} onChange={e => setApiFormKey(e.target.value)} placeholder="sk-..." />
                  </label>
                  <label className="api-form-checkbox-label">
                    <input
                      type="checkbox"
                      checked={apiFormHttps}
                      onChange={e => setApiFormHttps(e.target.checked)}
                      disabled={!apiHttpsAvailable}
                    />
                    <span>HTTPS で起動する</span>
                  </label>
                  <span className="api-form-hint" style={{ marginTop: -4 }}>
                    {apiHttpsAvailable
                      ? 'OpenGeekLLMChat本体と同じ cert.pem/key.pem を使用します。'
                      : '⚠️ cert.pem / key.pem が見つからないためHTTPSは利用できません。`./generate-cert.sh` で生成するか、正規証明書を配置してください。'}
                  </span>

                  <label className="api-form-checkbox-label" style={{ marginTop: 4 }}>
                    <input
                      type="checkbox"
                      checked={apiFormAgentMode}
                      onChange={e => setApiFormAgentMode(e.target.checked)}
                    />
                    <span>🔧 ツール対応モード</span>
                  </label>
                  <span className="api-form-hint" style={{ marginTop: -4 }}>
                    Webチャットと同様に、LLMがツール (ML予測/Web検索/ファイル参照) を自律的に呼び出せるようになります。
                    OFFの場合は素のLLM推論のみ (高速)。
                  </span>
                  {apiFormAgentMode && (
                    <div style={{ paddingLeft: 12, display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 }}>
                      {[
                        { id: 'ml', label: '🤖 機械学習 (ml_predict 等5ツール)' },
                        { id: 'web_search', label: '🌐 Web検索 (web_search)' },
                        { id: 'file', label: '📁 ファイル参照 (list_files / read_file)' },
                        {
                          id: 'rag',
                          label: '📚 RAG文書検索 (search_documents)',
                          disabled: !apiEmbeddingAvailable,
                          disabledReason: apiEmbeddingReason,
                        },
                        {
                          id: 'gdrive',
                          label: '☁️ GDrive (gdrive_* ツール)',
                          disabled: !apiGdriveAvailable,
                          disabledReason: apiGdriveReason,
                          warnLabel: 'GDrive未接続のため利用不可',
                        },
                      ].map(t => (
                        <label key={t.id} className="api-form-checkbox-label" style={{
                          fontSize: 12,
                          opacity: t.disabled ? 0.5 : 1,
                          cursor: t.disabled ? 'not-allowed' : 'pointer',
                        }}
                          title={t.disabled ? `利用不可: ${t.disabledReason || ''}` : ''}>
                          <input
                            type="checkbox"
                            checked={apiFormTools.includes(t.id)}
                            disabled={t.disabled}
                            onChange={e => {
                              if (e.target.checked) setApiFormTools([...apiFormTools, t.id]);
                              else setApiFormTools(apiFormTools.filter(x => x !== t.id));
                            }}
                          />
                          <span>
                            {t.label}
                            {t.disabled && <span style={{ color: 'var(--orange)', marginLeft: 6, fontSize: 10 }}>
                              ⚠️ {t.warnLabel || 'embedding未設定のため利用不可'}
                            </span>}
                          </span>
                        </label>
                      ))}
                      <span className="api-form-hint">
                        ※ ツール対応モードは llama.cpp の関数呼び出し対応モデル (Qwen, Gemma等) が必要です。
                        ストリーミングは最終応答を一括返却します。
                      </span>
                    </div>
                  )}

                  <button className="api-form-submit" onClick={startApiServer} disabled={apiBusy}>
                    {apiBusy ? '処理中...' : '🚀 起動'}
                  </button>
                </div>
              </div>

              <div className="api-section">
                <div className="api-section-title">起動中のサーバー ({externalServers.length})</div>
                {externalServers.length === 0 ? (
                  <div className="api-empty">
                    <div className="docs-empty-icon">🌐</div>
                    <div>起動中のサーバーはありません</div>
                    <div className="docs-empty-sub">上のフォームから起動できます</div>
                  </div>
                ) : (
                  externalServers.map(s => (
                    <div key={s.id} className="api-server-item">
                      <div className="api-server-header">
                        <button
                          className={`api-server-status-btn ${s.running ? 'running' : 'stopped'}`}
                          onClick={() => toggleApiServerProcess(s.id, s.running)}
                          disabled={apiBusy}
                          title={s.running ? 'クリックして停止' : 'クリックして起動'}
                        >
                          {s.running ? '● 稼働中' : '○ 停止中'}
                        </button>
                        <span className={`api-server-proto ${s.https ? 'https' : 'http'}`}>
                          {s.https ? '🔒 HTTPS' : '🔓 HTTP'}
                        </span>
                        {s.agentMode && (
                          <span className="api-server-proto" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}
                            title={`ツール対応モード: ${(s.tools || []).join(', ')}`}>
                            🔧 ツール対応
                          </span>
                        )}
                        <button
                          className="api-server-stop"
                          onClick={() => stopApiServer(s.id)}
                          title="サーバー設定ごと削除"
                        >✕</button>
                      </div>
                      <div className="api-server-model">
                        {s.modelName}
                        {(s.ctx || s.nParallel) && (
                          <span className="api-server-specs">
                            {s.ctx && <span title="コンテキストサイズ">ctx: {s.ctx.toLocaleString()}</span>}
                            {s.nParallel && <span title="並列スロット数 (-np)">np: {s.nParallel}</span>}
                          </span>
                        )}
                      </div>
                      {(() => {
                        // 表示用URL: host=0.0.0.0 ならブラウザのhostnameを使う、そうでなければそのまま
                        const displayHost = (s.host === '0.0.0.0' || s.host === '::')
                          ? window.location.hostname
                          : s.host;
                        const proto = s.https ? 'https' : 'http';
                        const externalUrl = `${proto}://${displayHost}:${s.port}/v1`;
                        const localUrl = `${proto}://127.0.0.1:${s.port}/v1`;
                        return (
                          <div className="api-server-endpoint">
                            <div className="api-server-row">
                              <span className="api-server-label">URL:</span>
                              <code className="api-server-value">{externalUrl}</code>
                              <button className="api-server-copy" onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(externalUrl);
                                  setLoadingMessage('✓ URLをコピーしました');
                                  setTimeout(() => setLoadingMessage(''), 1500);
                                } catch {}
                              }}>📋</button>
                            </div>
                            {(s.host === '0.0.0.0' || s.host === '::') && (
                              <div className="api-server-row">
                                <span className="api-server-label">Local:</span>
                                <code className="api-server-value">{localUrl}</code>
                                <button className="api-server-copy" onClick={async () => {
                                  try {
                                    await navigator.clipboard.writeText(localUrl);
                                    setLoadingMessage('✓ ローカルURLをコピーしました');
                                    setTimeout(() => setLoadingMessage(''), 1500);
                                  } catch {}
                                }}>📋</button>
                              </div>
                            )}
                            <div className="api-server-row">
                              <span className="api-server-label">Key:</span>
                              <code className="api-server-value" style={{ wordBreak: 'break-all' }}>{s.apiKey}</code>
                              <button className="api-server-copy" onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(s.apiKey);
                                  setLoadingMessage('✓ APIキーをコピーしました');
                                  setTimeout(() => setLoadingMessage(''), 1500);
                                } catch {}
                              }}>📋</button>
                            </div>
                            <div className="api-server-usage">
                              例: <code>curl {externalUrl}/chat/completions -H "Authorization: Bearer {s.apiKey.slice(0, 12)}..." -H "Content-Type: application/json" -d '{`{"model":"x","messages":[{"role":"user","content":"hi"}]}`}'</code>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {loadingMessage && <div className="loading-toast">{loadingMessage}</div>}
      {error && <div className="error-toast">{error}</div>}
      {lightboxSrc && (
        <div className="image-lightbox" onClick={() => setLightboxSrc(null)}>
          <img src={lightboxSrc} alt="拡大表示" />
        </div>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
