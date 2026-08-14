/**
 * ocr.js — PDF OCR パイプライン (PDF → 画像 → Vision LLM → Markdown → RAG登録)
 *
 * 技術書などのスキャンPDFを、UIにドロップするだけで検索可能な知識にするための機構。
 *
 * 流れ:
 *   1. PDF を public/uploads/ に保存 (ジョブ登録)
 *   2. pdftoppm で 1ページずつ PNG 化 (300dpi、1枚ずつ作って消すのでディスクを食わない)
 *   3. Vision LLM (Qwen2.5-VL 等の OpenAI互換サーバー) に base64 画像を投げて Markdown を得る
 *   4. ページ単位で ml/ocr/cache/<jobId>/pXXXX.md にキャッシュ (中断しても続きから再開できる)
 *   5. 全ページ結合 → public/uploads/<basename>.md
 *   6. 既存の ragIngestFile() を内部呼び出しして RAG 登録 → チャットの search_documents から参照可能
 *
 * 方針:
 * - 依存を増やさない。PDF→画像は poppler-utils (pdftoppm / pdfinfo) を child_process で叩く。
 *   Node の PDF ライブラリはネイティブビルドや巨大な依存を持ち込むので使わない。
 * - 単一GPU前提で 1ジョブずつ順次処理 (maxConcurrentJobs で将来のマルチGPUに対応)。
 * - ジョブ状態は JSON 永続化。サーバー再起動で中断されたジョブは「待機中」に戻り、
 *   ページキャッシュがあるので再開すれば途中から続く。
 * - 1ページ失敗してもジョブは止めない (リトライ後スキップし、失敗ページを記録する)。
 *
 * 必要な外部コマンド:
 *   sudo apt install poppler-utils   # pdftoppm / pdfinfo
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/**
 * 「Vision LLM のプロセスが落ちた」可能性がある失敗かどうか。
 * fetch (undici) はプロセスが消えていても素っ気ない TypeError: fetch failed しか
 * 出さないので、原因はプール側の終了記録と突き合わせて初めて分かる。
 */
const CONN_LOST_RE = /socket hang up|ECONNRESET|ECONNREFUSED|EPIPE|fetch failed|terminated|other side closed/i;

/**
 * poppler-utils の入れ方の案内。OSごとに手順が違うので、エラーメッセージには
 * 実行中のプラットフォームに合ったものだけを出す。
 * (Windows は apt が無いので「sudo apt install」と言われても何もできない)
 */
function popplerInstallHint() {
  if (process.platform === 'win32') {
    return 'Windows: poppler-windows (https://github.com/oschwartz10612/poppler-windows/releases) の ZIP を展開し、'
      + 'Library\\bin を PATH に追加してください。PATH を通さない場合は config.json の '
      + 'ocr.pdfToImageCmd / ocr.pdfInfoCmd にフルパス (例: "C:/poppler/Library/bin/pdftoppm.exe") を指定します';
  }
  if (process.platform === 'darwin') return 'macOS: brew install poppler';
  return 'Ubuntu/Debian: sudo apt install poppler-utils';
}

// ジョブ状態
//   pending    … アップロード済み、開始待ち (再起動で中断されたジョブもここに戻る)
//   queued     … 開始要求済み、実行スロットの空き待ち
//   running    … 実行中 (phase で細かい段階を表す)
//   completed  … 完了
//   failed     … 失敗
//   cancelled  … ユーザーが中断
const ACTIVE_STATUSES = ['queued', 'running'];

// 保持するジョブ履歴の上限
const MAX_JOBS = 100;

// ページ番号 → キャッシュファイル名 (p0001.md)
function pageCacheName(pageNo) {
  return `p${String(pageNo).padStart(4, '0')}.md`;
}

/** ファイル名のサニタイズ (パストラバーサル・隠しファイル対策)。必ず .pdf で終わる名前を返す */
function sanitizePdfName(name) {
  // ディレクトリ成分を捨てて basename だけにする (Windows の \ 区切りも考慮)
  let base = path.basename(String(name || '').replace(/\\/g, '/'));
  base = base.replace(/\0/g, '').trim();
  // ファイルシステム・URLで問題になる文字を潰す
  base = base.replace(/[\/\\:*?"<>|]/g, '_');
  // 先頭のドットは除去 (uploads の safeUploadPath が隠しファイルを拒否するため)
  base = base.replace(/^\.+/, '');
  if (!base) base = 'document.pdf';
  let stem = base.replace(/\.pdf$/i, '');
  if (!stem) stem = 'document';
  // 長すぎる名前はキャッシュディレクトリ名等で扱いにくいので切る
  if (stem.length > 100) stem = stem.slice(0, 100);
  return `${stem}.pdf`;
}

/** uploads 内で衝突しないファイル名にする (foo.pdf → foo_2.pdf) */
function uniqueName(dir, filename) {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  let candidate = filename;
  let n = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem}_${n}${ext}`;
    n++;
  }
  return candidate;
}

/** バイト数を人間可読に */
function humanBytes(n) {
  if (!Number.isFinite(n)) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * multipart/form-data を「ファイル部分はディスクへ直接ストリーム」しながら受信する。
 * 300MB のPDFをメモリに載せないための実装 (server.js の parseMultipart はメモリ展開なので使わない)。
 * バウンダリがチャンク境界をまたぐケースに対応するため、末尾 boundary 長分だけ手元に残す。
 *
 * @returns Promise<{ file: {filename, contentType, bytes}, fields: object }>
 */
function receiveMultipartToFile(req, { maxBytes, destPath }) {
  return new Promise((resolve, reject) => {
    const ct = req.headers['content-type'] || '';
    const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!m) return reject(new Error('Content-Type に multipart の boundary がありません'));
    const boundary = (m[1] || m[2]).trim();
    const dashBoundary = Buffer.from(`--${boundary}`);
    const crlfDashBoundary = Buffer.from(`\r\n--${boundary}`);
    const HEADER_SEP = Buffer.from('\r\n\r\n');
    const MAX_HEADER = 16 * 1024;
    const MAX_FIELDS = 64 * 1024;

    let buf = Buffer.alloc(0);
    let state = 'preamble';   // preamble → headers → (file|field) → ... → done
    let ws = null;
    let fileInfo = null;
    let fieldName = '';
    let fieldChunks = [];
    let fieldBytes = 0;
    const fields = {};
    let finished = false;

    function cleanupAndReject(err) {
      if (finished) return;
      finished = true;
      try { req.destroy(); } catch {}
      if (ws) { try { ws.destroy(); } catch {} }
      try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
      reject(err);
    }

    function done() {
      if (finished) return;
      if (!fileInfo) return cleanupAndReject(new Error('ファイルパートが見つかりません (name="file" で PDF を送ってください)'));
      finished = true;
      if (ws) ws.end(() => resolve({ file: fileInfo, fields }));
      else resolve({ file: fileInfo, fields });
    }

    // パート本文の書き出し。ファイルは背圧を見ながらディスクへ流す
    function emit(chunk) {
      if (!chunk.length) return;
      if (state === 'file') {
        fileInfo.bytes += chunk.length;
        if (fileInfo.bytes > maxBytes) {
          throw new Error(`ファイルが大きすぎます (上限 ${Math.round(maxBytes / 1024 / 1024)} MB)`);
        }
        if (!ws.write(chunk)) {
          req.pause();
          ws.once('drain', () => { if (!finished) req.resume(); });
        }
      } else if (state === 'field') {
        fieldBytes += chunk.length;
        if (fieldBytes > MAX_FIELDS) throw new Error('フォームフィールドが大きすぎます');
        fieldChunks.push(chunk);
      }
    }

    function endPart() {
      if (state === 'field') {
        fields[fieldName] = Buffer.concat(fieldChunks).toString('utf-8');
        fieldChunks = [];
      }
      // ファイルパートは done() でまとめて end する (次のパートは読み飛ばすだけ)
    }

    function parseHeaders(raw) {
      const h = {};
      for (const line of raw.split('\r\n')) {
        const i = line.indexOf(':');
        if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      return h;
    }

    function decodeFilename(cd) {
      // RFC5987 形式 (filename*=UTF-8''...) を優先、なければ通常の filename="..."
      const star = cd.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
      if (star) { try { return decodeURIComponent(star[1].trim()); } catch { return star[1].trim(); } }
      const plain = cd.match(/filename\s*=\s*"([^"]*)"/i) || cd.match(/filename\s*=\s*([^;]+)/i);
      return plain ? plain[1].trim() : null;
    }

    function parse() {
      for (;;) {
        if (state === 'preamble') {
          const i = buf.indexOf(dashBoundary);
          if (i < 0) {
            // バウンダリがまたがる可能性があるぶんだけ残す
            if (buf.length > dashBoundary.length) buf = buf.slice(buf.length - dashBoundary.length);
            return;
          }
          const after = i + dashBoundary.length;
          if (buf.length < after + 2) return;
          if (buf[after] === 0x2d && buf[after + 1] === 0x2d) { state = 'done'; return done(); }
          buf = buf.slice(after + 2);  // CRLF を飛ばす
          state = 'headers';
          continue;
        }

        if (state === 'headers') {
          const i = buf.indexOf(HEADER_SEP);
          if (i < 0) {
            if (buf.length > MAX_HEADER) throw new Error('multipart のパートヘッダが大きすぎます');
            return;
          }
          const headers = parseHeaders(buf.slice(0, i).toString('utf-8'));
          buf = buf.slice(i + HEADER_SEP.length);
          const cd = headers['content-disposition'] || '';
          const nameM = cd.match(/\bname\s*=\s*"([^"]*)"/i);
          const fname = decodeFilename(cd);
          if (fname !== null && !fileInfo) {
            fileInfo = { filename: fname, contentType: headers['content-type'] || '', bytes: 0 };
            ws = fs.createWriteStream(destPath);
            ws.on('error', (e) => cleanupAndReject(e));
            state = 'file';
          } else if (fname !== null) {
            // 2つ目以降のファイルは読み捨てる (1リクエスト1PDF)
            state = 'skip';
          } else {
            fieldName = nameM ? nameM[1] : '';
            fieldChunks = [];
            state = 'field';
          }
          continue;
        }

        if (state === 'file' || state === 'field' || state === 'skip') {
          const i = buf.indexOf(crlfDashBoundary);
          if (i >= 0) {
            // 終端が "--"(最終) か CRLF(次パート) か判別できるまで待つ
            if (buf.length < i + crlfDashBoundary.length + 2) return;
            emit(buf.slice(0, i));
            endPart();
            const after = i + crlfDashBoundary.length;
            if (buf[after] === 0x2d && buf[after + 1] === 0x2d) {
              buf = Buffer.alloc(0);
              state = 'done';
              return done();
            }
            buf = buf.slice(after + 2);
            state = 'headers';
            continue;
          }
          // バウンダリ未検出: またぎ対策で末尾を残して残りを吐く
          const keep = crlfDashBoundary.length + 2;
          if (buf.length > keep) {
            emit(buf.slice(0, buf.length - keep));
            buf = buf.slice(buf.length - keep);
          }
          return;
        }

        return;  // done
      }
    }

    req.on('data', (c) => {
      if (finished) return;
      buf = Buffer.concat([buf, c]);
      try { parse(); } catch (e) { cleanupAndReject(e); }
    });
    req.on('end', () => {
      if (!finished && state !== 'done') cleanupAndReject(new Error('multipart のデータが途中で終了しました'));
    });
    req.on('aborted', () => cleanupAndReject(new Error('アップロードが中断されました')));
    req.on('error', (e) => cleanupAndReject(e));
  });
}

/**
 * OCR マネージャを作る。
 *
 * @param {object}   deps
 * @param {function} deps.getConfig         () => appConfig.ocr
 * @param {string}   deps.baseDir           サーバーのルート (相対パス解決の基準)
 * @param {string}   deps.uploadsDir        public/uploads の絶対パス
 * @param {function} deps.log               (ip, message) => void
 * @param {function} [deps.ragIngestFile]   (filename) => Promise<{docId, chunkCount}>
 * @param {function} [deps.ragDeleteDoc]    (docId) => void
 * @param {function} [deps.ensureEmbedding] () => Promise<boolean>
 * @param {object}   [deps.vlmPool]         LLMプール (ocr.vlmPoolModel 使用時のみ)
 *   info(name)            → {ok, message?, vision}   モデル定義の検証
 *   plan(name)            → {mode, reason}           VRAMから resident/swap を判定
 *   acquire(name, opts)   → Promise<{host, port, release()}>
 *   crash(name)           → Promise<crash|null>      直近の異常終了 (原因表示用)
 */
function createOcrManager({
  getConfig,
  baseDir,
  uploadsDir,
  log = () => {},
  ragIngestFile = null,
  ragDeleteDoc = null,
  ensureEmbedding = null,
  vlmPool = null,
}) {
  const cfg = () => (getConfig() || {});

  const resolvePath = (p, fallback) => {
    const v = p || fallback;
    return path.isAbsolute(v) ? v : path.join(baseDir, v);
  };
  const cacheRoot = () => resolvePath(cfg().cacheDir, 'ml/ocr/cache');
  const jobsFile = () => resolvePath(cfg().jobsFile, 'ml/ocr/jobs.json');

  // jobId → 実行中の制御情報 (プロセス/AbortController)。永続化はしない
  const running = new Map();
  // jobId → Set<listener>  SSE 配信用
  const listeners = new Map();

  let jobs = [];        // 新しい順
  let loaded = false;

  // ─── 永続化 ───────────────────────────────────────────────

  function ensureDirs() {
    for (const d of [cacheRoot(), path.dirname(jobsFile())]) {
      try { fs.mkdirSync(d, { recursive: true }); } catch {}
    }
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
      log('-', `[OCR] jobs.json 読み込み失敗: ${e.message}`);
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
      log('-', `[OCR] jobs.json 保存失敗: ${e.message}`);
    }
  }

  function findJob(jobId) {
    return loadJobs().find(j => j.jobId === jobId) || null;
  }

  // ─── SSE 配信 ────────────────────────────────────────────

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
    for (const fn of set) {
      try { fn(event); } catch {}
    }
  }

  // ─── ジョブの外向き表現 ───────────────────────────────────

  function jobView(job) {
    if (!job) return null;
    const ctl = running.get(job.jobId);
    // 経過時間は「今の実行ぶん」。中断→再開したジョブで、止まっていた時間まで
    // 積み上がって見えないよう、startedAt は実行開始のたびにリセットしている
    const elapsedMs = job.startedAt
      ? ((job.status === 'running' ? Date.now() : (job.finishedAt || job.startedAt)) - job.startedAt)
      : 0;
    // 残り時間は「今回の実行で実際にOCRしたページ」の平均から出す
    // (キャッシュヒットしたページを混ぜると極端に短く見積もってしまう)
    let etaMs = null;
    if (ctl && ctl.pagesThisRun > 0 && job.totalPages) {
      const avg = (Date.now() - ctl.runStartedAt) / ctl.pagesThisRun;
      const remain = Math.max(0, job.totalPages - job.donePages);
      etaMs = Math.round(avg * remain);
    }
    return {
      jobId: job.jobId,
      filename: job.filename,
      mdFilename: job.mdFilename || null,
      title: job.title,
      sizeBytes: job.sizeBytes,
      status: job.status,
      phase: job.phase || null,
      totalPages: job.totalPages || 0,
      donePages: job.donePages || 0,
      currentPage: job.currentPage || 0,
      failedPages: job.failedPages || [],
      charCount: job.charCount || 0,
      ragDocId: job.ragDocId || null,
      ragChunkCount: job.ragChunkCount || null,
      ragError: job.ragError || null,
      error: job.error || null,
      interrupted: !!job.interrupted,
      createdAt: job.createdAt,
      startedAt: job.startedAt || null,
      finishedAt: job.finishedAt || null,
      elapsedMs,
      etaMs,
    };
  }

  function setStatus(job, status, extra = {}) {
    job.status = status;
    Object.assign(job, extra);
    saveJobs();
    emitEvent(job.jobId, { type: 'status', job: jobView(job) });
  }

  // ─── 外部コマンド ────────────────────────────────────────

  function runCmd(cmd, args, { timeoutMs = 120000, onProc = null } = {}) {
    return new Promise((resolve) => {
      let proc;
      try {
        proc = spawn(cmd, args, { cwd: baseDir });
      } catch (e) {
        return resolve({ ok: false, code: -1, stdout: '', stderr: '', spawnError: e.message });
      }
      if (onProc) onProc(proc);
      let stdout = '', stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { proc.kill('SIGKILL'); } catch {} }, timeoutMs);
      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, code: -1, stdout, stderr, spawnError: e.message });
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut });
      });
    });
  }

  /** poppler-utils (pdftoppm / pdfinfo) が使えるか。UIに分かりやすいメッセージを返す */
  async function checkDeps() {
    const c = cfg();
    const missing = [];
    for (const [cmd, label] of [[c.pdfToImageCmd || 'pdftoppm', 'pdftoppm'], [c.pdfInfoCmd || 'pdfinfo', 'pdfinfo']]) {
      const r = await runCmd(cmd, ['-v'], { timeoutMs: 8000 });
      // pdftoppm -v は終了コード 99 を返す実装もあるので「起動できたか」で判定する
      if (r.spawnError) missing.push(label);
    }
    if (missing.length) {
      return {
        ok: false,
        missing,
        message: `OCR に必要なコマンドが見つかりません: ${missing.join(', ')}。`
          + ` poppler-utils をインストールしてください。${popplerInstallHint()}`,
      };
    }
    return { ok: true, missing: [] };
  }

  /**
   * VLM をLLMプールに任せる設定か。
   * ocr.vlmPoolModel が指すのは config.json の chatModels の名前で、
   * プール管理にすると OCR中だけロードされ、終われば
   * orchestration.idleUnloadMs でアンロードされる。
   * 空なら従来どおり ocr.vlmEndpoint の外部 llama-server を叩く。
   */
  function poolModelName() {
    return vlmPool ? String(cfg().vlmPoolModel || '').trim() : '';
  }

  /** Vision LLM が使えるか。プール管理なら定義の検証、外部なら生存確認 */
  async function checkVlm() {
    const c = cfg();

    // プール管理: プロセスはジョブ開始時に起動するので、ここでは定義だけ見る。
    // 「今は起動していない」のは正常な状態であって、警告を出す理由にはならない
    const poolModel = poolModelName();
    if (poolModel) {
      const info = vlmPool.info(poolModel);
      if (!info.ok) {
        return { ok: false, managed: true, modelName: poolModel, message: info.message };
      }
      return {
        ok: true, managed: true, modelName: poolModel,
        endpoint: `LLMプール管理 (${poolModel})`,
        // --mmproj が無いモデルは画像を受け取れない。ジョブは通すが、
        // 白紙のような出力になるので理由が分かるようにしておく
        warn: info.vision ? null
          : `モデル「${poolModel}」の extraArgs に --mmproj がありません。`
            + `画像を読めないモデルではOCRできません`,
      };
    }

    // 従来: 別プロセスで起動済みの llama-server を叩く
    const endpoint = c.vlmEndpoint || 'http://localhost:8090/v1/chat/completions';
    let origin;
    try { origin = new URL(endpoint).origin; }
    catch { return { ok: false, managed: false, message: `ocr.vlmEndpoint が不正なURLです: ${endpoint}` }; }
    for (const p of ['/health', '/v1/models']) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 4000);
        const r = await fetch(origin + p, { signal: ctl.signal });
        clearTimeout(t);
        if (r.ok) return { ok: true, managed: false, endpoint };
      } catch {}
    }
    return {
      ok: false,
      managed: false,
      endpoint,
      message: `Vision LLM に接続できません (${endpoint})。Qwen2.5-VL の llama-server が起動しているか確認してください`
        + `。OCR中だけ自動でロード/アンロードさせたい場合は ocr.vlmPoolModel に chatModels の名前を設定してください`,
    };
  }

  /**
   * ジョブ1本ぶんの VLM エンドポイントを確保する。
   * プール管理なら refCount を握るので、握っている間はアイドルアンロードも
   * 他ワークフローによる退避も起きない。使い終わったら必ず release() する。
   *
   * @returns {Promise<{endpoint: string, model: string, modelName: string|null, release: Function}>}
   */
  async function acquireVlm() {
    const c = cfg();
    const poolModel = poolModelName();
    if (!poolModel) {
      return {
        endpoint: c.vlmEndpoint || 'http://localhost:8090/v1/chat/completions',
        model: c.vlmModel || 'qwen2.5vl',
        modelName: null,
        release: () => {},
      };
    }

    // 単一GPUだとチャットモデルと同居できないことがある。プールの VRAM 判定に
    // 委ねて、載らないなら swap (メインチャットを一時アンロード) で確保する
    const plan = vlmPool.plan(poolModel);
    log('-', `[OCR] Vision LLM「${poolModel}」を${plan.mode === 'swap' ? '逐次スワップ' : '常駐'}で確保します: ${plan.reason}`);
    const handle = await vlmPool.acquire(poolModel, { mode: plan.mode });
    return {
      endpoint: `http://${handle.host}:${handle.port}/v1/chat/completions`,
      model: poolModel,
      modelName: poolModel,
      release: () => handle.release(),
    };
  }

  /** PDF のページ数を取得 */
  async function getPageCount(pdfPath) {
    const c = cfg();
    const r = await runCmd(c.pdfInfoCmd || 'pdfinfo', [pdfPath], { timeoutMs: 30000 });
    if (r.spawnError) {
      throw new Error(`pdfinfo を実行できません (${r.spawnError})。${popplerInstallHint()}`);
    }
    if (!r.ok) {
      const detail = (r.stderr || r.stdout || '').trim().slice(0, 200);
      if (/password|encrypt/i.test(detail)) throw new Error('パスワード保護されたPDFは処理できません');
      throw new Error(`PDFの情報を取得できません: ${detail || `exit ${r.code}`}`);
    }
    const m = r.stdout.match(/^Pages:\s+(\d+)/m);
    if (!m) throw new Error('PDFのページ数を判別できませんでした');
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n) || n < 1) throw new Error('PDFのページ数が不正です');
    return n;
  }

  /** 指定1ページだけを PNG 化して、そのパスを返す */
  async function renderPage(pdfPath, pageNo, outPrefix, ctl) {
    const c = cfg();
    const dpi = Math.min(Math.max(parseInt(c.dpi) || 300, 72), 600);
    const args = ['-png', '-r', String(dpi), '-f', String(pageNo), '-l', String(pageNo), '-singlefile', pdfPath, outPrefix];
    const r = await runCmd(c.pdfToImageCmd || 'pdftoppm', args, {
      timeoutMs: 180000,
      onProc: (p) => { if (ctl) ctl.proc = p; },
    });
    if (ctl) ctl.proc = null;
    if (r.spawnError) {
      throw new Error(`pdftoppm を実行できません (${r.spawnError})。${popplerInstallHint()}`);
    }
    const out = `${outPrefix}.png`;
    if (!r.ok || !fs.existsSync(out)) {
      const detail = (r.stderr || '').trim().slice(0, 200);
      throw new Error(`ページ${pageNo}の画像化に失敗: ${detail || `exit ${r.code}`}`);
    }
    return out;
  }

  /** Vision LLM に1ページ投げて Markdown を得る (vlm は acquireVlm() の戻り値) */
  async function ocrImage(pngPath, ctl, vlm) {
    const c = cfg();
    // processJob は未処理ページがある時しか確保しないので、ここに来て null は
    // 呼び出し順の壊れ。TypeError で潰れるより何が起きたか分かる形で落とす
    if (!vlm) throw new Error('Vision LLM が確保されていません (内部エラー)');
    const endpoint = vlm.endpoint;
    const b64 = fs.readFileSync(pngPath).toString('base64');
    const payload = {
      model: vlm.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: c.prompt || '' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
        ],
      }],
      max_tokens: parseInt(c.maxTokens) || 6144,
      temperature: typeof c.temperature === 'number' ? c.temperature : 0.1,
    };

    const controller = new AbortController();
    if (ctl) ctl.abort = controller;
    const timeoutMs = (parseInt(c.pageTimeoutSec) || 600) * 1000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        throw new Error(`Vision LLM エラー (${resp.status}): ${t.slice(0, 200)}`);
      }
      const data = await resp.json();
      let content = data?.choices?.[0]?.message?.content;
      // content が配列 (マルチモーダル形式) で返るサーバーもある
      if (Array.isArray(content)) {
        content = content.map(p => (typeof p === 'string' ? p : (p?.text || ''))).join('');
      }
      if (typeof content !== 'string') throw new Error('Vision LLM のレスポンス形式が不正です');
      return cleanupMarkdown(content);
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new Error(ctl && ctl.cancelled ? 'キャンセルされました' : `OCRタイムアウト (${timeoutMs / 1000}秒)`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
      if (ctl) ctl.abort = null;
    }
  }

  /** VLM出力の後始末 (全体を ```markdown で包む・thinkタグを出す個体への対処) */
  function cleanupMarkdown(text) {
    let s = String(text || '');
    s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
    s = s.trim();
    // 全体が1つのコードフェンスで包まれている場合だけ剥がす (本文中のコードブロックは残す)
    const fence = s.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
    if (fence) s = fence[1].trim();
    return s;
  }

  // ─── ジョブ実行 ──────────────────────────────────────────

  function jobCacheDir(jobId) {
    return path.join(cacheRoot(), jobId);
  }

  /** キャッシュ済みページ数 (再開時の進捗復元用) */
  function countCachedPages(jobId, totalPages) {
    const dir = jobCacheDir(jobId);
    if (!fs.existsSync(dir)) return 0;
    let n = 0;
    for (let p = 1; p <= (totalPages || 0); p++) {
      const f = path.join(dir, pageCacheName(p));
      try { if (fs.existsSync(f)) n++; } catch {}
    }
    return n;
  }

  async function processJob(job) {
    const c = cfg();
    const ctl = { cancelled: false, abort: null, proc: null, runStartedAt: Date.now(), pagesThisRun: 0 };
    running.set(job.jobId, ctl);

    const pdfPath = path.join(uploadsDir, job.filename);
    const cacheDir = jobCacheDir(job.jobId);
    const imgPrefix = path.join(cacheDir, 'page');
    // プール管理時はジョブが握っている間だけ VLM が載る。finally で必ず返す
    let vlm = null;

    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      if (!fs.existsSync(pdfPath)) throw new Error(`PDFが見つかりません: ${job.filename}`);

      // 前回実行の終了時刻が残っていると経過時間の計算が壊れるので必ず消す
      job.startedAt = Date.now();
      job.finishedAt = null;
      job.interrupted = false;
      job.error = null;
      setStatus(job, 'running', { phase: 'analyze' });

      // ページ数 (再開時は保存済みの値を使い回す)
      if (!job.totalPages) {
        job.totalPages = await getPageCount(pdfPath);
        saveJobs();
      }
      if (ctl.cancelled) throw new Error('__CANCELLED__');

      job.donePages = countCachedPages(job.jobId, job.totalPages);
      job.failedPages = job.failedPages || [];
      setStatus(job, 'running', { phase: 'ocr' });
      log('-', `[OCR] 開始: ${job.filename} (${job.totalPages}ページ${job.donePages ? `、${job.donePages}ページはキャッシュから再開` : ''})`);

      // parseInt(undefined) は NaN で、NaN は ?? をすり抜ける。素通しすると
      // attempt <= NaN が常に false になり、1ページも読まずに全滅する
      const rt = parseInt(c.pageRetries);
      const retries = Number.isFinite(rt) ? Math.max(0, rt) : 1;

      // 引くページが1枚もない再実行 (結合し直すだけ) で 9GB のモデルを
      // 載せても意味がないので、実際に処理が要る時だけ確保する
      if (job.totalPages - job.donePages > 0) {
        setStatus(job, 'running', { phase: 'vlm' });
        vlm = await acquireVlm();
        setStatus(job, 'running', { phase: 'ocr' });
      }

      for (let page = 1; page <= job.totalPages; page++) {
        if (ctl.cancelled) throw new Error('__CANCELLED__');

        const cacheFile = path.join(cacheDir, pageCacheName(page));
        if (fs.existsSync(cacheFile)) continue;  // 再開: 済んだページは飛ばす

        job.currentPage = page;
        let md = null;
        let lastErr = null;

        for (let attempt = 0; attempt <= retries; attempt++) {
          if (ctl.cancelled) throw new Error('__CANCELLED__');
          try {
            const png = await renderPage(pdfPath, page, imgPrefix, ctl);
            md = await ocrImage(png, ctl, vlm);
            try { fs.unlinkSync(png); } catch {}
            break;
          } catch (e) {
            if (ctl.cancelled) throw new Error('__CANCELLED__');
            lastErr = e;
            if (attempt < retries) {
              log('-', `[OCR] p${page} 失敗 (${e.message})。リトライします`);
              await new Promise(r => setTimeout(r, 1000));
            }
          }
        }

        if (md === null) {
          // ワーカーが落ちているなら残りページも同じように失敗する。
          // 「[OCR失敗]」を300ページ書き込んでから気づくのでは遅いので、ここで止める。
          //
          // 接続断のときだけ待って確認する。ソケットのエラーは子プロセスの 'exit' より
          // 先に届くため即座に見ても間に合わない。逆に、ページのタイムアウトのような
          // プロセスが生きている失敗でいちいち待つと、失敗ページ数ぶん待ち時間が積み上がる
          const connLost = CONN_LOST_RE.test(lastErr ? lastErr.message : '');
          const crash = vlm && vlm.modelName && vlmPool
            ? await vlmPool.crash(vlm.modelName, connLost)
            : null;
          if (crash) {
            throw new Error(
              `Vision LLM「${vlm.modelName}」の llama-server が異常終了しました`
              + ` (exit=${crash.code}${crash.signal ? `, signal=${crash.signal}` : ''})`
              + `\n対処: モデルの ctx を下げる / config.json の orchestration.maxResident を 1 にする /`
              + ` 小さい Vision モデルに変える`
              + (crash.tail ? `\n--- llama-server の最終出力 ---\n${crash.tail}` : '')
            );
          }
          // リトライしても駄目ならスキップして次ページへ (ジョブ全体は止めない)
          job.failedPages.push(page);
          fs.writeFileSync(cacheFile, `[OCR失敗: ${lastErr ? lastErr.message : '不明なエラー'}]`, 'utf-8');
          log('-', `[OCR] p${page} をスキップ: ${lastErr ? lastErr.message : '不明なエラー'}`);
        } else {
          fs.writeFileSync(cacheFile, md, 'utf-8');
          ctl.pagesThisRun++;
        }

        job.donePages++;
        saveJobs();
        emitEvent(job.jobId, {
          type: 'progress',
          jobId: job.jobId,
          pageNo: page,
          total: job.totalPages,
          done: job.donePages,
          failed: job.failedPages.length,
          chunkChars: md ? md.length : 0,
          elapsed: Date.now() - job.startedAt,
          job: jobView(job),
        });
        // ページ単位のログは冗長なので10ページごとに集約する
        if (page % 10 === 0 || page === job.totalPages) {
          const pct = Math.round((job.donePages / job.totalPages) * 100);
          log('-', `[OCR] ${job.filename}: p${job.donePages}/${job.totalPages} (${pct}%)`);
        }
      }

      if (ctl.cancelled) throw new Error('__CANCELLED__');

      // ページを引き終わったので VLM は返す。結合とRAG登録では使わないので、
      // ここで手放せば長いRAG登録の間ずっと9GB占有し続けずに済む
      if (vlm) { vlm.release(); vlm = null; }

      // ─── 結合して uploads に書き出す ───
      setStatus(job, 'running', { phase: 'merge', currentPage: 0 });
      const merged = mergePages(job, cacheDir);
      const mdName = job.mdFilename || `${job.title}.md`;
      fs.writeFileSync(path.join(uploadsDir, mdName), merged, 'utf-8');
      job.mdFilename = mdName;
      job.charCount = merged.length;
      saveJobs();
      log('-', `[OCR] Markdown生成: uploads/${mdName} (${humanBytes(Buffer.byteLength(merged, 'utf-8'))}, ${job.failedPages.length}ページ失敗)`);

      // ─── RAG 自動登録 ───
      if (c.autoRegisterToRag !== false && ragIngestFile) {
        setStatus(job, 'running', { phase: 'rag' });
        try {
          if (ensureEmbedding) await ensureEmbedding();
          const r = await ragIngestFile(mdName);
          job.ragDocId = r.docId;
          job.ragChunkCount = r.chunkCount;
          job.ragError = null;
          log('-', `[OCR] RAG登録: ${mdName} (docId=${r.docId}, ${r.chunkCount}チャンク)`);
        } catch (e) {
          // RAG登録に失敗しても Markdown は残っているのでジョブ自体は成功扱いにする
          job.ragError = e.message;
          log('-', `[OCR] RAG登録失敗: ${mdName} - ${e.message}`);
        }
      }

      // 元PDFを残さない設定なら片付ける
      if (c.keepPdf === false) {
        try { fs.unlinkSync(pdfPath); } catch {}
      }

      setStatus(job, 'completed', { phase: null, finishedAt: Date.now(), currentPage: 0 });
      log('-', `[OCR] 完了: ${job.filename} (${job.totalPages}ページ, ${Math.round((job.finishedAt - job.startedAt) / 1000)}秒)`);
      emitEvent(job.jobId, { type: 'done', job: jobView(job) });
    } catch (e) {
      if (e.message === '__CANCELLED__' || ctl.cancelled) {
        setStatus(job, 'cancelled', { phase: null, finishedAt: Date.now(), currentPage: 0 });
        log('-', `[OCR] キャンセル: ${job.filename} (${job.donePages}/${job.totalPages || '?'}ページまで処理済み)`);
        emitEvent(job.jobId, { type: 'done', job: jobView(job) });
      } else {
        setStatus(job, 'failed', { phase: null, finishedAt: Date.now(), currentPage: 0, error: e.message });
        log('-', `[OCR] 失敗: ${job.filename} - ${e.message}`);
        emitEvent(job.jobId, { type: 'error', message: e.message, job: jobView(job) });
      }
    } finally {
      // 失敗・キャンセルで抜けた場合もここで必ず返す (握ったままだと
      // アイドルアンロードの対象から永久に外れてVRAMが空かない)
      if (vlm) { vlm.release(); vlm = null; }
      running.delete(job.jobId);
      // 使い終わった一時PNGを掃除
      try { fs.unlinkSync(`${imgPrefix}.png`); } catch {}
      pump();
    }
  }

  /** ページキャッシュを指示書のフォーマットで1つの Markdown に結合する */
  function mergePages(job, cacheDir) {
    const parts = [`# ${job.title}\n`];
    for (let page = 1; page <= job.totalPages; page++) {
      let body = '';
      try { body = fs.readFileSync(path.join(cacheDir, pageCacheName(page)), 'utf-8'); } catch {}
      const failed = (job.failedPages || []).includes(page);
      parts.push(`\n\n\n---\n<!-- page=${page}${failed ? ' failed=1' : ''} -->\n\n${body.trim()}\n`);
    }
    return parts.join('');
  }

  /** 空きスロットぶんだけ queued ジョブを走らせる */
  function pump() {
    const max = Math.max(1, parseInt(cfg().maxConcurrentJobs) || 1);
    if (running.size >= max) return;
    const next = loadJobs().filter(j => j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
    for (const job of next) {
      if (running.size >= max) break;
      if (running.has(job.jobId)) continue;
      // processJob は自前で例外を握るので await 不要 (バックグラウンド実行)
      processJob(job);
    }
  }

  // ─── 公開 API ────────────────────────────────────────────

  function isEnabled() {
    return cfg().enabled !== false;
  }

  /**
   * アップロード受信 → ジョブ登録。
   * multipart/form-data でも、Content-Type: application/pdf の生ボディでも受ける
   * (後者は curl から叩きやすくするため。?name= か X-Filename でファイル名を渡す)
   */
  async function receiveUpload(req, { ip = '-' } = {}) {
    ensureDirs();
    const c = cfg();
    const maxBytes = (parseInt(c.maxUploadMB) || 300) * 1024 * 1024;

    // 事前に Content-Length で弾けるものは弾く (無駄な転送をさせない)
    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (declared && declared > maxBytes + 65536) {
      const err = new Error(`ファイルが大きすぎます (${humanBytes(declared)} / 上限 ${c.maxUploadMB || 300} MB)`);
      err.status = 413;
      throw err;
    }

    // ディスク残量チェック: PDF本体 + ページ画像 + Markdown ぶんの余裕を見る
    const need = (declared || 0) + 512 * 1024 * 1024;
    const disk = checkDiskSpace(uploadsDir);
    if (disk.ok && disk.free < need) {
      const err = new Error(`ディスク残量が不足しています (空き ${humanBytes(disk.free)}、必要 ${humanBytes(need)} 程度)`);
      err.status = 507;
      throw err;
    }

    const tmpPath = path.join(uploadsDir, `.ocr_upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.part`);
    let originalName = '';
    let contentType = '';
    let bytes = 0;

    const ct = req.headers['content-type'] || '';
    if (ct.startsWith('multipart/form-data')) {
      const r = await receiveMultipartToFile(req, { maxBytes, destPath: tmpPath });
      originalName = r.file.filename;
      contentType = r.file.contentType;
      bytes = r.file.bytes;
    } else {
      originalName = String(req.query?.name || req.headers['x-filename'] || 'document.pdf');
      contentType = ct;
      bytes = await receiveRawToFile(req, { maxBytes, destPath: tmpPath });
    }

    const cleanup = () => { try { fs.unlinkSync(tmpPath); } catch {} };

    try {
      if (bytes === 0) { const e = new Error('ファイルが空です'); e.status = 400; throw e; }

      // 拡張子チェック
      if (!/\.pdf$/i.test(originalName)) {
        const e = new Error('PDF ファイル (.pdf) のみアップロードできます');
        e.status = 400; throw e;
      }
      // MIME チェック (ブラウザによっては application/octet-stream で来るので許容する)
      const mimeOk = !contentType
        || /^application\/(pdf|x-pdf|octet-stream)$/i.test(contentType.split(';')[0].trim());
      if (!mimeOk) {
        const e = new Error(`PDF 以外の形式は受け付けません (Content-Type: ${contentType})`);
        e.status = 400; throw e;
      }
      // 中身が本当に PDF か (拡張子・MIMEは詐称できるのでマジックナンバーで確認)
      const head = Buffer.alloc(5);
      const fd = fs.openSync(tmpPath, 'r');
      try { fs.readSync(fd, head, 0, 5, 0); } finally { fs.closeSync(fd); }
      if (head.toString('latin1') !== '%PDF-') {
        const e = new Error('PDF ファイルではありません (ファイル先頭が %PDF- ではない)');
        e.status = 400; throw e;
      }

      const filename = uniqueName(uploadsDir, sanitizePdfName(originalName));
      fs.renameSync(tmpPath, path.join(uploadsDir, filename));

      const title = filename.replace(/\.pdf$/i, '');
      const job = {
        jobId: `ocr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        filename,
        title,
        mdFilename: uniqueMdName(title),
        sizeBytes: bytes,
        status: 'pending',
        phase: null,
        totalPages: 0,
        donePages: 0,
        currentPage: 0,
        failedPages: [],
        charCount: 0,
        ragDocId: null,
        ragChunkCount: null,
        ragError: null,
        error: null,
        interrupted: false,
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
      };
      loadJobs().unshift(job);
      if (jobs.length > MAX_JOBS) jobs = jobs.slice(0, MAX_JOBS);
      saveJobs();
      log(ip, `[OCR] アップロード: ${filename} (${humanBytes(bytes)})`);
      return jobView(job);
    } catch (e) {
      cleanup();
      throw e;
    }
  }

  /** 生ボディをファイルに落とす (multipart 以外のアップロード経路) */
  function receiveRawToFile(req, { maxBytes, destPath }) {
    return new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(destPath);
      let bytes = 0;
      let failed = false;
      const fail = (err) => {
        if (failed) return;
        failed = true;
        try { req.destroy(); } catch {}
        try { ws.destroy(); } catch {}
        try { fs.unlinkSync(destPath); } catch {}
        reject(err);
      };
      req.on('data', (c) => {
        bytes += c.length;
        if (bytes > maxBytes) return fail(new Error(`ファイルが大きすぎます (上限 ${Math.round(maxBytes / 1024 / 1024)} MB)`));
        if (!ws.write(c)) { req.pause(); ws.once('drain', () => { if (!failed) req.resume(); }); }
      });
      req.on('end', () => { if (!failed) ws.end(() => resolve(bytes)); });
      req.on('error', fail);
      ws.on('error', fail);
    });
  }

  /** 生成する Markdown 名が uploads で衝突しないようにする */
  function uniqueMdName(title) {
    return uniqueName(uploadsDir, `${title}.md`);
  }

  function listJobs() {
    return loadJobs().map(jobView);
  }

  function getJob(jobId) {
    return jobView(findJob(jobId));
  }

  /**
   * "12, 30-33, 240" のようなページ指定をページ番号の配列にする。
   * 空文字・null は「全ページ」を意味する null を返す。
   */
  function parsePageSpec(spec, totalPages) {
    if (spec == null || String(spec).trim() === '') return null;
    const bad = (s) => { const e = new Error(`ページ指定が不正です: ${s}`); e.status = 400; throw e; };
    const out = new Set();
    for (const part of String(spec).split(',')) {
      const s = part.trim();
      if (!s) continue;
      const m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(s);
      if (!m) bad(s);
      const from = parseInt(m[1], 10);
      const to = m[2] ? parseInt(m[2], 10) : from;
      if (from < 1 || to < from) bad(s);
      if (totalPages && to > totalPages) {
        const e = new Error(`ページ番号が範囲外です: ${to} (全${totalPages}ページ)`); e.status = 400; throw e;
      }
      for (let p = from; p <= to; p++) out.add(p);
    }
    return out.size ? [...out].sort((a, b) => a - b) : null;
  }

  /**
   * ジョブを実行キューに載せる。
   * redo=true なら完了済みジョブでも走らせる (OCR結果を作り直したい時)。
   * pages を渡すとそのページのキャッシュだけ捨てるので、指定ページだけ引き直せる。
   */
  async function startJob(jobId, { redo = false, pages = null } = {}) {
    const job = findJob(jobId);
    if (!job) { const e = new Error('ジョブが見つかりません'); e.status = 404; throw e; }
    if (ACTIVE_STATUSES.includes(job.status)) {
      const e = new Error('このジョブは既に実行中です'); e.status = 409; throw e;
    }
    if (job.status === 'completed' && !redo) {
      const e = new Error('このジョブは完了済みです。作り直す場合は「再OCR」を使ってください'); e.status = 409; throw e;
    }
    // ページ指定の検証は依存チェックより先に (打ち間違いは即座に返したい)
    const redoPages = redo ? parsePageSpec(pages, job.totalPages) : null;

    // 依存と Vision LLM の生存確認は「開始時」に行う (アップロード自体は通しておく)
    const deps = await checkDeps();
    if (!deps.ok) { const e = new Error(deps.message); e.status = 503; throw e; }
    const vlm = await checkVlm();
    if (!vlm.ok) { const e = new Error(vlm.message); e.status = 503; throw e; }

    if (redo) {
      // キャッシュを捨てた分だけ processJob が引き直す。失敗マークも一緒に外す
      const dir = jobCacheDir(jobId);
      if (redoPages) {
        for (const p of redoPages) { try { fs.unlinkSync(path.join(dir, pageCacheName(p))); } catch {} }
        job.failedPages = (job.failedPages || []).filter(p => !redoPages.includes(p));
      } else {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        job.failedPages = [];
      }
      job.donePages = countCachedPages(jobId, job.totalPages);
      log('-', `[OCR] 再OCR: ${job.filename} (${redoPages ? redoPages.map(p => `p${p}`).join(', ') : '全ページ'})`);
    }

    setStatus(job, 'queued', { error: null, interrupted: false });
    pump();
    return jobView(job);
  }

  /** 実行中ジョブの中断 (ページキャッシュは残すので再開できる) */
  function cancelJob(jobId) {
    const job = findJob(jobId);
    if (!job) { const e = new Error('ジョブが見つかりません'); e.status = 404; throw e; }
    if (!ACTIVE_STATUSES.includes(job.status)) {
      const e = new Error('実行中のジョブではありません'); e.status = 400; throw e;
    }
    const ctl = running.get(jobId);
    if (ctl) {
      ctl.cancelled = true;
      if (ctl.abort) { try { ctl.abort.abort(); } catch {} }
      if (ctl.proc) { try { ctl.proc.kill('SIGKILL'); } catch {} }
    } else {
      // まだ queued (実行前) ならその場で確定
      setStatus(job, 'cancelled', { phase: null, finishedAt: Date.now() });
    }
    return jobView(job);
  }

  /** ジョブ削除 (キャッシュ・PDF・生成Markdown・RAG登録をまとめて片付ける) */
  function deleteJob(jobId, { keepFiles = false } = {}) {
    const job = findJob(jobId);
    if (!job) { const e = new Error('ジョブが見つかりません'); e.status = 404; throw e; }
    if (ACTIVE_STATUSES.includes(job.status)) {
      const e = new Error('実行中のジョブは削除できません。先にキャンセルしてください'); e.status = 409; throw e;
    }
    if (!keepFiles) {
      try { fs.rmSync(jobCacheDir(jobId), { recursive: true, force: true }); } catch {}
      try { fs.unlinkSync(path.join(uploadsDir, job.filename)); } catch {}
      if (job.mdFilename) { try { fs.unlinkSync(path.join(uploadsDir, job.mdFilename)); } catch {} }
      if (job.ragDocId && ragDeleteDoc) { try { ragDeleteDoc(job.ragDocId); } catch {} }
    }
    jobs = loadJobs().filter(j => j.jobId !== jobId);
    saveJobs();
    emitEvent(jobId, { type: 'deleted', jobId });
    listeners.delete(jobId);
    return { ok: true };
  }

  /**
   * 起動時の復元。実行中のまま落ちたジョブは「待機中」に戻す。
   * ページキャッシュが残っているので、開始し直せば途中から再開される。
   */
  function restoreOnBoot() {
    ensureDirs();
    const list = loadJobs();
    let n = 0;
    for (const job of list) {
      if (ACTIVE_STATUSES.includes(job.status)) {
        job.status = 'pending';
        job.phase = null;
        job.interrupted = true;
        job.currentPage = 0;
        // 中断された実行の計測は捨てる (次の開始時に測り直す)
        job.startedAt = null;
        job.finishedAt = null;
        job.donePages = countCachedPages(job.jobId, job.totalPages);
        n++;
      }
    }
    if (n > 0) {
      saveJobs();
      log('-', `[OCR] 再起動により中断された ${n} 件のジョブを待機中に戻しました (開始すると途中から再開されます)`);
    }
    return n;
  }

  /** ディスク残量 (statfs が無い環境では ok:false を返して判定をスキップする) */
  function checkDiskSpace(dir) {
    try {
      if (typeof fs.statfsSync !== 'function') return { ok: false, free: 0 };
      const st = fs.statfsSync(dir);
      return { ok: true, free: st.bavail * st.bsize };
    } catch {
      return { ok: false, free: 0 };
    }
  }

  /** UI 用のステータス (依存コマンド・Vision LLM の生死) */
  async function health() {
    const deps = await checkDeps();
    const vlm = isEnabled() ? await checkVlm() : { ok: false, message: 'OCR機能が無効です (config.ocr.enabled)' };
    const c = cfg();
    return {
      enabled: isEnabled(),
      deps,
      vlm,
      maxUploadMB: parseInt(c.maxUploadMB) || 300,
      dpi: parseInt(c.dpi) || 300,
      maxConcurrentJobs: Math.max(1, parseInt(c.maxConcurrentJobs) || 1),
      autoRegisterToRag: c.autoRegisterToRag !== false,
      runningCount: running.size,
    };
  }

  return {
    isEnabled,
    health,
    checkDeps,
    checkVlm,
    receiveUpload,
    listJobs,
    getJob,
    startJob,
    cancelJob,
    deleteJob,
    subscribe,
    restoreOnBoot,
  };
}

module.exports = {
  createOcrManager,
  sanitizePdfName,
  humanBytes,
};
