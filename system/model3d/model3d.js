/**
 * model3d.js — ローカル3Dモデル生成 (画像→3D / テキスト→3D) のタスク管理と Meshy 互換 API
 *
 * 構成:
 *   ブラウザ / 外部プログラム
 *     → (Meshy 互換) POST /openapi/v2/text-to-3d, POST /openapi/v1/image-to-3d
 *     → (チャット用) POST /model3d/generate
 *   このモジュール: タスクを作ってキューに積み、1件ずつ実行する
 *     テキスト→3D: バックエンドがテキスト非対応なら stable-diffusion.cpp (generateImages) で
 *                  「コンセプト画像」を作ってから画像→3D にかける (2段階)
 *     画像→3D    : 画像をそのままワーカーへ
 *   model3d_server.py (Python ワーカー): 1件ずつ GLB を書き出す。子プロセスで起動し
 *     (sd-server / Irodori-TTS と同じ方式)、オンデマンド起動・アイドル停止する
 *
 * 方針:
 * - 既定は無効 (model3dGen=false)。外部への送信は一切しない (全部ローカル)
 * - 出力は public/uploads/model3d/<taskId>/model.glb。/uploads の他の生成物と同じく
 *   URL は認証なしで取れる (Meshy のモデルURLもそのまま GET できるため)。taskId は推測不能な UUID
 * - タスクは model3d_tasks.json に保存して再起動後も一覧・取得できる。実行中だったものは FAILED にする
 * - Meshy の API に合わせる: 作成は {result: id}、取得はタスクオブジェクト
 *   (status: PENDING / IN_PROGRESS / SUCCEEDED / FAILED / CANCELED、model_urls.glb 等)、
 *   エラーは {message}。Meshy SDK / サンプルコードの base URL を差し替えるだけで動くことが目標
 * - GPU は1枚を想定して直列実行。exclusiveGpu=true なら画像生成と3D生成の VRAM を交互に空ける
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const express = require('express');

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELED']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_NAME_RE = /^[A-Za-z0-9_.-]+$/;
const EXTRA_FORMATS = ['obj', 'stl', 'ply'];
const ART_STYLE_SUFFIX = {
  realistic: '',
  sculpture: ', clay sculpture, monochrome, unpainted',
};

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8093,
  backend: 'dummy',          // command 指定時に args 未設定なら model3d_server.py にこの --backend を渡す
  command: null,             // ワーカーを起動する python (例: Hunyuan3D の venv の python)。null なら外部起動済みとみなす
  args: null,                // 起動引数を丸ごと指定する場合 (省略時は model3d_server.py + backend + host/port)
  extraArgs: [],             // args 省略時に追加する引数 (例: ["--low-vram"])
  cwd: null,
  env: {},
  readyTimeoutMs: 120000,    // ワーカーの HTTP 待受開始まで (モデルは最初の生成時に読む)
  idleUnloadMs: 600000,      // アイドル時にワーカーを止めて VRAM を返す (0 で無効)
  timeoutMs: 1800000,        // 1件の生成の上限 (モデル初回ロード込み)
  textMode: 'auto',          // 'auto' | 'image' (常に画像生成を経由) | 'native' (常にワーカーへテキスト)
  conceptPromptSuffix: ', a single object, centered, full view, isolated on plain white background, soft studio lighting, 3d asset',
  conceptNegativePrompt: 'multiple objects, cropped, cut off, text, watermark, busy background, cluttered scene',
  conceptSize: 1024,
  conceptSteps: 20,
  exclusiveGpu: false,       // true: 画像生成の前に3Dワーカーのモデルを降ろし、3D生成の前に sd-server を止める
  maxQueue: 10,              // PENDING の上限 (超えたら 429)
  allowImageUrlFetch: true,  // image_url に http(s) URL を許すか
  allowPrivateNetwork: false,// image_url で LAN 内アドレスを許すか (SSRF 対策で既定は拒否)
  maxImageMB: 20,
  extraFormats: [],          // GLB に加えて書き出す形式: "obj" / "stl" / "ply" (ワーカー側に trimesh が必要)
  maxTasks: 1000,            // 保存するタスク記録の上限 (古い完了済みから記録を消す。ファイルは消さない)
};

function createModel3dManager(deps) {
  const {
    getConfig,                 // () => appConfig.model3d
    isEnabled,                 // () => !!appConfig.model3dGen
    baseDir,                   // リポジトリのルート (タスク記録の保存先)
    uploadsDir,                // public/uploads
    log,
    spawn,
    resolveUploadPath,         // (rel) => abs | null  (uploads 配下の安全なパス解決)
    isPrivateHostname,
    generateImages,            // stable-diffusion.cpp でのテキスト→画像
    isImageGenAvailable,       // () => boolean
    stopImageModel,            // () => Promise
  } = deps;

  const outRoot = path.join(uploadsDir, 'model3d');
  const tasksFile = path.join(baseDir, 'model3d_tasks.json');
  const workerScript = path.join(__dirname, 'model3d_server.py');

  const tasks = new Map();     // id -> task
  const queue = [];            // PENDING の id (先頭から実行)
  const listeners = new Map(); // id -> Set<fn(task)>  (SSE 用)
  let running = null;
  let proc = null;
  let starting = null;         // 起動中の Promise
  let caps = null;             // ワーカーの capabilities (/health)
  let backendName = null;
  let lastActivity = Date.now();
  let externalLoaded = false;  // 外部起動のワーカーにモデルが載っているか (アイドル時に /unload を送る)
  let saveTimer = null;

  const cfg = () => ({ ...DEFAULTS, ...(getConfig() || {}) });

  // ─── タスク記録の保存・読み込み ───
  function loadTasks() {
    try {
      if (!fs.existsSync(tasksFile)) return;
      const arr = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
      for (const t of Array.isArray(arr) ? arr : []) {
        if (!t || !UUID_RE.test(t.id || '')) continue;
        if (!TERMINAL.has(t.status)) {
          t.status = 'FAILED';
          t.error = 'サーバーの再起動で中断されました';
          t.finished_at = t.finished_at || Date.now();
        }
        tasks.set(t.id, t);
      }
    } catch (e) {
      log('-', `[model3d] タスク記録の読み込みに失敗: ${e.message}`);
    }
  }

  function saveTasksSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        const max = cfg().maxTasks;
        let arr = [...tasks.values()];
        if (arr.length > max) {
          // 古い完了済みから記録だけ落とす (ファイルはチャット履歴が参照しているので残す)
          const drop = arr.filter(t => TERMINAL.has(t.status))
            .sort((a, b) => a.created_at - b.created_at).slice(0, arr.length - max);
          for (const t of drop) tasks.delete(t.id);
          arr = [...tasks.values()];
        }
        fs.writeFileSync(tasksFile, JSON.stringify(arr, null, 1));
      } catch (e) {
        log('-', `[model3d] タスク記録の保存に失敗: ${e.message}`);
      }
    }, 500);
  }

  function emit(t) {
    saveTasksSoon();
    const set = listeners.get(t.id);
    if (set) for (const fn of [...set]) { try { fn(t); } catch {} }
  }

  function setStage(t, stage, progress) {
    if (stage != null) t.stage = stage;
    if (progress != null) t.progress = Math.max(t.progress || 0, Math.min(99, Math.round(progress)));
    emit(t);
  }

  const taskDir = (id) => path.join(outRoot, id);

  // ─── ワーカー (model3d_server.py) との通信 ───
  function workerRequest(method, pathname, body, timeoutMs) {
    const c = cfg();
    return new Promise((resolve, reject) => {
      const data = body ? Buffer.from(JSON.stringify(body)) : null;
      const req = http.request({
        host: c.host, port: c.port, path: pathname, method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
      }, (res) => {
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch {}
          if (res.statusCode >= 400) {
            return reject(Object.assign(new Error((json && json.error) || `ワーカーエラー (HTTP ${res.statusCode})`),
              { status: res.statusCode }));
          }
          resolve(json || {});
        });
      });
      req.setTimeout(timeoutMs || 10000, () => req.destroy(new Error('ワーカーの応答がタイムアウトしました')));
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  async function health() {
    try {
      const h = await workerRequest('GET', '/health', null, 3000);
      if (h && h.ok) {
        caps = h.capabilities || null;
        backendName = h.backend || null;
        return h;
      }
    } catch {}
    return null;
  }

  const procAlive = () => !!(proc && !proc.killed && proc.exitCode === null);

  async function ensureWorker() {
    lastActivity = Date.now();
    const c = cfg();
    if (procAlive() && caps) return;
    if (!c.command) {
      // 外部で起動済みのワーカーに繋ぐ
      if (await health()) return;
      throw new Error(`3D生成ワーカー (${c.host}:${c.port}) に接続できません。`
        + 'config.json の model3d.command を設定して自動起動させるか、model3d_server.py を外部で起動してください');
    }
    if (starting) return starting;
    starting = (async () => {
      // 既に誰かが同じポートで待ち受けているなら (前回の残り等) それを使う
      if (!procAlive() && await health()) return;
      if (!procAlive()) spawnWorker(c);
      const deadline = Date.now() + c.readyTimeoutMs;
      while (Date.now() < deadline) {
        if (!procAlive()) throw new Error('3D生成ワーカーが起動直後に終了しました (サーバーログを確認してください)');
        if (await health()) {
          log('-', `[model3d] ワーカー Ready (backend=${backendName}, pid=${proc.pid})`);
          return;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      throw new Error(`3D生成ワーカーが ${c.readyTimeoutMs}ms 以内に起動しませんでした`);
    })().finally(() => { starting = null; });
    return starting;
  }

  function spawnWorker(c) {
    const args = Array.isArray(c.args) && c.args.length > 0 ? c.args.map(String) : [
      workerScript,
      '--backend', String(c.backend || 'dummy'),
      '--host', String(c.host), '--port', String(c.port),
      '--output-root', outRoot,
      ...(Array.isArray(c.extraArgs) ? c.extraArgs.map(String) : []),
    ];
    log('-', `[model3d] ワーカー起動: ${c.command} ${args.join(' ')}`);
    const p = spawn(c.command, args, {
      cwd: c.cwd || baseDir,
      env: { ...process.env, PYTHONUNBUFFERED: '1', ...(c.env || {}) },
    });
    proc = p;
    p.stdout.on('data', d => process.stdout.write(`[model3d] ${d}`));
    p.stderr.on('data', d => process.stderr.write(`[model3d] ${d}`));
    p.on('exit', (code) => {
      log('-', `[model3d] ワーカー終了 (code=${code}, pid=${p.pid})`);
      if (proc === p) { proc = null; caps = null; }
    });
    p.on('error', (err) => {
      log('-', `[model3d] ワーカー起動エラー: ${err.message}`);
      if (proc === p) { proc = null; caps = null; }
    });
  }

  async function stopWorker() {
    const p = proc;
    if (!p || p.killed || p.exitCode !== null) { proc = null; caps = null; return; }
    try { p.kill('SIGTERM'); } catch {}
    await new Promise(resolve => {
      const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resolve(); }, 5000);
      p.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (proc === p) { proc = null; caps = null; }
  }

  // アイドル停止 (sd-server / TTS と同じパターン)。外部起動のワーカーには /unload だけ送る
  const idleTimer = setInterval(() => {
    const c = cfg();
    if (!c.idleUnloadMs || running || queue.length > 0 || starting) return;
    if (Date.now() - lastActivity < c.idleUnloadMs) return;
    if (procAlive()) {
      log('-', `[model3d] アイドル ${Math.round((Date.now() - lastActivity) / 1000)}s → ワーカー停止`);
      lastActivity = Date.now();
      stopWorker();
    } else if (!c.command && externalLoaded) {
      log('-', `[model3d] アイドル ${Math.round((Date.now() - lastActivity) / 1000)}s → 外部ワーカーのモデルを解放`);
      externalLoaded = false;
      workerRequest('POST', '/unload', {}, 60000).catch(() => {});
    }
  }, 30000);
  if (idleTimer.unref) idleTimer.unref();

  // ワーカーで1件実行。/status をポーリングして進捗を task に写す
  async function runWorkerJob(t, pathname, body, from, to) {
    const c = cfg();
    let stop = false;
    let wake = () => {};
    const poll = (async () => {
      while (!stop) {
        // 生成が終わったら待たずに抜けられるよう、wake() で起こせる sleep にする
        await new Promise(r => { wake = r; setTimeout(r, 1500); });
        if (stop) break;
        try {
          const s = await workerRequest('GET', '/status', null, 3000);
          if (s && s.busy) setStage(t, s.stage || null, from + (to - from) * (s.progress || 0) / 100);
        } catch {}
      }
    })();
    try {
      return await workerRequest('POST', pathname, body, c.timeoutMs);
    } catch (e) {
      // ワーカーが落ちると接続が切れるだけで理由が分からないので、よくある原因を添える
      if (!e.status && /socket hang up|ECONNRESET|ECONNREFUSED/i.test(e.message || '')) {
        throw new Error('3D生成ワーカーが処理中に終了しました (VRAM/メモリ不足の可能性があります。サーバーログを確認してください)');
      }
      throw e;
    } finally {
      stop = true;
      wake();
      await poll;
      lastActivity = Date.now();
      if (!c.command) externalLoaded = true;
    }
  }

  // ─── 入力画像の読み込み (data URL / uploads のパス / http(s) URL) ───
  async function loadImageInput(src) {
    const c = cfg();
    const maxBytes = c.maxImageMB * 1024 * 1024;
    if (!src || typeof src !== 'string') throw httpError(400, 'image_url が必要です');
    const s = src.trim();
    const dm = s.match(/^data:image\/(png|jpe?g|webp|gif|bmp);base64,(.+)$/is);
    if (dm) {
      const buf = Buffer.from(dm[2], 'base64');
      if (buf.length === 0) throw httpError(400, 'image_url の画像データが空です');
      if (buf.length > maxBytes) throw httpError(400, `画像が大きすぎます (上限 ${c.maxImageMB}MB)`);
      return { buffer: buf, ext: dm[1].toLowerCase().replace('jpeg', 'jpg') };
    }
    if (/^https?:\/\//i.test(s)) {
      let u;
      try { u = new URL(s); } catch { throw httpError(400, 'image_url が不正です'); }
      // 自分自身の /uploads を指す URL はファイルとして読む (チャットの生成画像を3D化する時など)
      if (u.pathname.startsWith('/uploads/') && isPrivateHostname(u.hostname)) {
        return readUpload(decodeURIComponent(u.pathname), maxBytes);
      }
      if (!c.allowImageUrlFetch) throw httpError(400, 'URL からの画像取得は無効です (data URI で送ってください)');
      if (!c.allowPrivateNetwork && isPrivateHostname(u.hostname)) {
        throw httpError(400, 'LAN 内アドレスからの画像取得は許可されていません (model3d.allowPrivateNetwork)');
      }
      return { buffer: await fetchBuffer(u, maxBytes), ext: (u.pathname.match(/\.(png|jpe?g|webp)$/i)?.[1] || 'png').toLowerCase() };
    }
    if (s.startsWith('/uploads/') || !/^[a-z]+:/i.test(s)) return readUpload(s, maxBytes);
    throw httpError(400, 'image_url は data URI・http(s) URL・/uploads のパスのいずれかで指定してください');
  }

  function readUpload(rel, maxBytes) {
    const abs = resolveUploadPath(rel);
    if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw httpError(400, `画像が見つかりません: ${rel}`);
    if (fs.statSync(abs).size > maxBytes) throw httpError(400, '画像が大きすぎます');
    const ext = (path.extname(abs).slice(1) || 'png').toLowerCase();
    if (!/^(png|jpe?g|webp|gif|bmp)$/.test(ext)) throw httpError(400, `画像ファイルではありません: ${rel}`);
    return { buffer: fs.readFileSync(abs), ext };
  }

  function fetchBuffer(u, maxBytes, redirects = 3) {
    return new Promise((resolve, reject) => {
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.get(u, { headers: { 'User-Agent': 'OpenGeekLLMChat-model3d' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          let next;
          try { next = new URL(res.headers.location, u); } catch { return reject(httpError(400, 'リダイレクト先が不正です')); }
          if (!cfg().allowPrivateNetwork && isPrivateHostname(next.hostname)) {
            return reject(httpError(400, 'LAN 内アドレスへのリダイレクトは許可されていません'));
          }
          return fetchBuffer(next, maxBytes, redirects - 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(httpError(400, `画像を取得できません (HTTP ${res.statusCode})`)); }
        const chunks = [];
        let size = 0;
        res.on('data', (d) => {
          size += d.length;
          if (size > maxBytes) { req.destroy(); reject(httpError(400, '画像が大きすぎます')); return; }
          chunks.push(d);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.setTimeout(30000, () => req.destroy(httpError(400, '画像の取得がタイムアウトしました')));
      req.on('error', (e) => reject(e.status ? e : httpError(400, `画像を取得できません: ${e.message}`)));
    });
  }

  // ─── タスク作成 ───
  function enqueue(t) {
    const c = cfg();
    if (queue.length >= c.maxQueue) throw httpError(429, `待ち行列がいっぱいです (上限 ${c.maxQueue} 件)`);
    tasks.set(t.id, t);
    queue.push(t.id);
    emit(t);
    log('-', `[model3d] タスク作成 ${t.id} (${publicType(t)}) queue=${queue.length}`);
    setImmediate(pump);
    return t;
  }

  function baseTask(fields, owner) {
    return {
      id: crypto.randomUUID(),
      owner: owner || 'session',
      status: 'PENDING', progress: 0, stage: '',
      created_at: Date.now(), started_at: 0, finished_at: 0,
      error: '', files: {}, thumbnail: null,
      ...fields,
    };
  }

  function saveInput(t, name, img) {
    fs.mkdirSync(taskDir(t.id), { recursive: true });
    const file = `${name}.${img.ext}`;
    fs.writeFileSync(path.join(taskDir(t.id), file), img.buffer);
    return file;
  }

  function normFormats(list) {
    const arr = Array.isArray(list) ? list : (typeof list === 'string' ? list.split(/[,\s]+/) : []);
    return [...new Set(arr.map(s => String(s).toLowerCase()).filter(f => EXTRA_FORMATS.includes(f)))];
  }

  function common(body) {
    const seed = Number.isInteger(Number(body.seed)) && body.seed !== null && body.seed !== '' ? Number(body.seed) : -1;
    let target = body.target_polycount != null ? parseInt(body.target_polycount, 10) : null;
    if (target != null && (!Number.isFinite(target) || target < 100 || target > 300000)) {
      throw httpError(400, 'target_polycount は 100〜300000 で指定してください');
    }
    return {
      seed,
      target_polycount: target,
      topology: body.topology === 'quad' ? 'quad' : 'triangle',
      ai_model: typeof body.ai_model === 'string' ? body.ai_model : 'latest',
      enable_pbr: !!body.enable_pbr,
      formats: normFormats(body.target_formats || cfg().extraFormats),
    };
  }

  // Meshy: POST /openapi/v2/text-to-3d
  async function createTextTask(body, owner) {
    const b = body || {};
    const mode = b.mode || 'preview';
    if (mode !== 'preview' && mode !== 'refine') throw httpError(400, 'mode は preview か refine です');
    if (mode === 'refine') {
      const prev = tasks.get(String(b.preview_task_id || ''));
      if (!prev || !canSee(prev, owner)) throw httpError(404, 'preview_task_id のタスクが見つかりません');
      if (prev.type !== 'text-to-3d' || prev.mode !== 'preview') throw httpError(400, 'preview_task_id はテキスト→3D の preview タスクを指定してください');
      if (prev.status !== 'SUCCEEDED') throw httpError(400, 'preview タスクがまだ完了していません (status が SUCCEEDED である必要があります)');
      const t = baseTask({
        type: 'text-to-3d', mode: 'refine', preview_task_id: prev.id,
        prompt: prev.prompt, art_style: prev.art_style, negative_prompt: prev.negative_prompt,
        texture_prompt: typeof b.texture_prompt === 'string' ? b.texture_prompt : '',
        texture: true, ...common({ ...b, seed: b.seed ?? prev.seed }),
      }, owner);
      if (b.texture_image_url) t.texture_image = saveInput(t, 'texture_ref', await loadImageInput(b.texture_image_url));
      return enqueue(t);
    }
    const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
    if (!prompt) throw httpError(400, 'prompt が必要です');
    if (prompt.length > 2000) throw httpError(400, 'prompt が長すぎます (2000文字まで)');
    return enqueue(baseTask({
      type: 'text-to-3d', mode: 'preview', prompt,
      art_style: ART_STYLE_SUFFIX[b.art_style] != null ? b.art_style : 'realistic',
      negative_prompt: typeof b.negative_prompt === 'string' ? b.negative_prompt : '',
      // Meshy の preview はテクスチャ無し。チャット (/model3d/generate) は一度でテクスチャまで付ける
      texture: b.should_texture === true,
      ...common(b),
    }, owner));
  }

  // Meshy: POST /openapi/v1/image-to-3d
  async function createImageTask(body, owner) {
    const b = body || {};
    const img = await loadImageInput(b.image_url);
    const t = baseTask({
      type: 'image-to-3d',
      image_url: /^data:/i.test(b.image_url) ? '' : String(b.image_url),
      prompt: typeof b.prompt === 'string' ? b.prompt.slice(0, 2000) : '',  // 独自拡張: 表示用のメモ
      texture: b.should_texture !== false,
      texture_prompt: typeof b.texture_prompt === 'string' ? b.texture_prompt : '',
      ...common(b),
    }, owner);
    t.input = saveInput(t, 'input', img);
    t.thumbnail = t.input;
    return enqueue(t);
  }

  // ─── 実行 ───
  function pump() {
    if (running) return;
    while (queue.length > 0) {
      const id = queue.shift();
      const t = tasks.get(id);
      if (!t || t.status !== 'PENDING') continue;
      running = t;
      runTask(t)
        .catch(e => log('-', `[model3d] 内部エラー: ${e.stack || e.message}`))
        .finally(() => {
          running = null;
          lastActivity = Date.now();
          // 実行中に削除されたタスクは、終わってからファイルごと消す
          if (t.deleted) removeTaskFiles(t);
          for (const id2 of queue) { const q = tasks.get(id2); if (q) emit(q); }  // preceding_tasks の更新
          setImmediate(pump);
        });
      return;
    }
  }

  async function runTask(t) {
    t.status = 'IN_PROGRESS';
    t.started_at = Date.now();
    setStage(t, '準備中', 1);
    const dir = taskDir(t.id);
    fs.mkdirSync(dir, { recursive: true });
    const t0 = Date.now();
    try {
      if (t.type === 'text-to-3d' && t.mode === 'refine') await runRefine(t, dir);
      else if (t.type === 'text-to-3d') await runText(t, dir);
      else await runImage(t, dir, fs.readFileSync(path.join(dir, t.input)), 0);
      t.status = 'SUCCEEDED';
      t.progress = 100;
      t.stage = '完了';
      log('-', `[model3d] 完了 ${t.id} (${((Date.now() - t0) / 1000).toFixed(1)}s, faces=${t.faces ?? '?'})`);
    } catch (e) {
      t.status = 'FAILED';
      t.error = e.message || String(e);
      log('-', `[model3d] 失敗 ${t.id}: ${t.error}`);
    }
    t.finished_at = Date.now();
    emit(t);
  }

  function workerBody(t, dir, extra) {
    return {
      seed: t.seed,
      texture: !!t.texture,
      target_faces: t.target_polycount || null,
      output_path: path.join(dir, 'model.glb'),
      formats: t.formats || [],
      ...extra,
    };
  }

  function applyResult(t, r) {
    t.files = r.files || { glb: 'model.glb' };
    t.vertices = r.vertices ?? null;
    t.faces = r.faces ?? null;
    t.textured = !!r.textured;
    t.warning = r.warning || '';
    t.backend = backendName;
  }

  async function runImage(t, dir, buffer, from) {
    if (cfg().exclusiveGpu) await stopImageModel().catch(() => {});
    setStage(t, '3D生成ワーカーを準備中', from + 1);
    await ensureWorker();
    if (caps && caps.image === false) throw new Error(`バックエンド ${backendName} は画像→3Dに対応していません`);
    const r = await runWorkerJob(t, '/generate',
      workerBody(t, dir, { mode: 'image', image: buffer.toString('base64') }), from + 2, 99);
    applyResult(t, r);
  }

  async function runText(t, dir) {
    const c = cfg();
    await ensureWorker();
    const native = c.textMode === 'native' || (c.textMode !== 'image' && !!(caps && caps.text));
    if (native) {
      setStage(t, '3Dモデルを生成中', 2);
      const prompt = t.prompt + (ART_STYLE_SUFFIX[t.art_style] || '');
      const r = await runWorkerJob(t, '/generate', workerBody(t, dir, { mode: 'text', prompt }), 2, 99);
      applyResult(t, r);
      return;
    }
    // 2段階: テキスト → コンセプト画像 (stable-diffusion.cpp) → 画像→3D
    if (!isImageGenAvailable()) {
      throw new Error(`バックエンド ${backendName} はテキスト→3Dに対応していないため、画像生成 (imageGen と imageModels) が必要です`);
    }
    if (c.exclusiveGpu) await workerRequest('POST', '/unload', {}, 60000).catch(() => {});
    setStage(t, 'コンセプト画像を生成中 (stable-diffusion)', 3);
    const negative = [c.conceptNegativePrompt, t.negative_prompt].filter(Boolean).join(', ');
    const img = await generateImages({
      prompt: t.prompt + (ART_STYLE_SUFFIX[t.art_style] || '') + (c.conceptPromptSuffix || ''),
      negativePrompt: negative,
      width: c.conceptSize, height: c.conceptSize, steps: c.conceptSteps,
      seed: t.seed, batchCount: 1,
    }, 'model3d');
    const first = img.images && img.images[0];
    if (!first) throw new Error('コンセプト画像が生成されませんでした');
    const buffer = first.b64 ? Buffer.from(first.b64, 'base64') : fs.readFileSync(path.join(uploadsDir, first.fileName));
    fs.writeFileSync(path.join(dir, 'concept.png'), buffer);
    t.concept = 'concept.png';
    t.thumbnail = 'concept.png';
    setStage(t, 'コンセプト画像を生成しました', 25);
    await runImage(t, dir, buffer, 25);
  }

  async function runRefine(t, dir) {
    const prev = tasks.get(t.preview_task_id);
    if (!prev || prev.status !== 'SUCCEEDED') throw new Error('preview タスクが見つからないか、完了していません');
    const prevDir = taskDir(prev.id);
    const prevGlb = path.join(prevDir, prev.files?.glb || 'model.glb');
    if (!fs.existsSync(prevGlb)) throw new Error('preview タスクの GLB が見つかりません');
    if (prev.thumbnail && fs.existsSync(path.join(prevDir, prev.thumbnail))) {
      fs.copyFileSync(path.join(prevDir, prev.thumbnail), path.join(dir, prev.thumbnail));
      t.thumbnail = prev.thumbnail;
    }
    const refPath = t.texture_image ? path.join(dir, t.texture_image)
      : prev.concept ? path.join(prevDir, prev.concept)
      : prev.input ? path.join(prevDir, prev.input) : null;
    if (cfg().exclusiveGpu) await stopImageModel().catch(() => {});
    setStage(t, '3D生成ワーカーを準備中', 2);
    await ensureWorker();
    if (caps && caps.retexture && refPath && fs.existsSync(refPath)) {
      const r = await runWorkerJob(t, '/texture', {
        mesh_path: prevGlb, image: fs.readFileSync(refPath).toString('base64'),
        seed: t.seed, output_path: path.join(dir, 'model.glb'), formats: t.formats || [],
      }, 3, 99);
      applyResult(t, r);
      return;
    }
    if (prev.textured) {
      // テクスチャ込みで形状を作るバックエンド (TRELLIS / SF3D) は preview の時点で色が付いている
      for (const f of Object.values(prev.files || {})) {
        if (fs.existsSync(path.join(prevDir, f))) fs.copyFileSync(path.join(prevDir, f), path.join(dir, f));
      }
      applyResult(t, { files: prev.files, vertices: prev.vertices, faces: prev.faces, textured: true });
      return;
    }
    throw new Error(refPath
      ? `バックエンド ${backendName} は既存メッシュへのテクスチャ生成に対応していません`
      : 'テクスチャの参照画像がありません (texture_image_url を指定してください)');
  }

  // ─── 取得・一覧・削除 ───
  const canSee = (t, owner) => !owner || owner === 'session' || t.owner === owner;

  function publicType(t) {
    return t.type === 'text-to-3d' ? `text-to-3d-${t.mode}` : 'image-to-3d';
  }

  // Meshy のタスクオブジェクトの形にする。fileUrl(id, name) で URL を作る
  function toPublic(t, fileUrl) {
    const model_urls = {};
    for (const [k, f] of Object.entries(t.files || {})) model_urls[k] = fileUrl(t.id, f);
    const o = {
      id: t.id,
      type: publicType(t),
      model_urls,
      thumbnail_url: t.thumbnail ? fileUrl(t.id, t.thumbnail) : '',
      texture_urls: [],
      progress: t.progress || 0,
      status: t.status,
      preceding_tasks: t.status === 'PENDING' ? Math.max(0, queue.indexOf(t.id)) + (running ? 1 : 0) : 0,
      task_error: { message: t.error || '' },
      created_at: t.created_at,
      started_at: t.started_at || 0,
      finished_at: t.finished_at || 0,
      expires_at: 0,  // ローカル保存なので期限なし
      seed: t.seed,
      // ─ 独自拡張 (Meshy には無い) ─
      stage: t.stage || '',
      mesh: { vertices: t.vertices ?? null, faces: t.faces ?? null, textured: !!t.textured, backend: t.backend || null, warning: t.warning || '' },
    };
    if (t.type === 'text-to-3d') {
      Object.assign(o, {
        mode: t.mode, prompt: t.prompt || '', art_style: t.art_style || 'realistic',
        negative_prompt: t.negative_prompt || '', texture_prompt: t.texture_prompt || '',
      });
      if (t.mode === 'refine') o.preview_task_id = t.preview_task_id;
      if (t.concept) o.concept_image_url = fileUrl(t.id, t.concept);
    } else {
      Object.assign(o, { image_url: t.image_url || '', texture_prompt: t.texture_prompt || '' });
      if (t.prompt) o.prompt = t.prompt;
    }
    return o;
  }

  function getTask(id, owner) {
    const t = tasks.get(String(id || ''));
    return t && !t.deleted && canSee(t, owner) ? t : null;
  }

  function listTasks(kind, owner, { page_num, page_size, sort_by } = {}) {
    const num = Math.max(1, parseInt(page_num, 10) || 1);
    const size = Math.min(50, Math.max(1, parseInt(page_size, 10) || 10));
    const asc = sort_by === '+created_at';
    return [...tasks.values()]
      .filter(t => !t.deleted && t.type === kind && canSee(t, owner))
      .sort((a, b) => asc ? a.created_at - b.created_at : b.created_at - a.created_at)
      .slice((num - 1) * size, num * size);
  }

  function removeTaskFiles(t) {
    try { fs.rmSync(taskDir(t.id), { recursive: true, force: true }); } catch {}
    tasks.delete(t.id);
    listeners.delete(t.id);
    saveTasksSoon();
  }

  function deleteTask(t) {
    const qi = queue.indexOf(t.id);
    if (qi >= 0) queue.splice(qi, 1);
    if (running === t) {
      t.deleted = true;  // 実行中は止められないので、終わってから消す
      emit(t);
      return;
    }
    if (!TERMINAL.has(t.status)) {
      t.status = 'CANCELED';
      t.finished_at = Date.now();
      emit(t);
    }
    removeTaskFiles(t);
  }

  function subscribe(id, fn) {
    if (!listeners.has(id)) listeners.set(id, new Set());
    listeners.get(id).add(fn);
    return () => {
      const set = listeners.get(id);
      if (set) { set.delete(fn); if (set.size === 0) listeners.delete(id); }
    };
  }

  // ─── Meshy 互換ルーター ───
  // opts.ownerOf(req)  : タスクの持ち主 (API トークン名など)。'session' は全件見える
  // opts.fileUrl(req, id, name) : モデル/サムネイルの URL
  // opts.jsonParser    : 省略時は express.json
  function createMeshyRouter(opts = {}) {
    const router = express.Router();
    const json = opts.jsonParser || express.json({ limit: '50mb' });
    const ownerOf = opts.ownerOf || (() => 'session');
    const send = (req, t) => toPublic(t, (id, name) => opts.fileUrl(req, id, name));
    const fail = (res, e) => res.status(e.status || 500).json({ message: e.message });

    router.use('/openapi', (req, res, next) => {
      if (!isEnabled()) return res.status(503).json({ message: '3Dモデル生成が無効です (config.json の model3dGen を true にしてください)' });
      next();
    });

    const kinds = [
      { route: '/openapi/:ver(v1|v2)/text-to-3d', kind: 'text-to-3d', create: createTextTask },
      { route: '/openapi/:ver(v1|v2)/image-to-3d', kind: 'image-to-3d', create: createImageTask },
    ];
    for (const { route, kind, create } of kinds) {
      router.post(route, json, async (req, res) => {
        try {
          const t = await create(req.body, ownerOf(req));
          res.json({ result: t.id });
        } catch (e) { fail(res, e); }
      });
      router.get(route, (req, res) => {
        res.json(listTasks(kind, ownerOf(req), req.query).map(t => send(req, t)));
      });
      router.get(route + '/:id', (req, res) => {
        const t = getTask(req.params.id, ownerOf(req));
        if (!t || t.type !== kind) return res.status(404).json({ message: 'Task not found' });
        res.json(send(req, t));
      });
      router.delete(route + '/:id', (req, res) => {
        const t = getTask(req.params.id, ownerOf(req));
        if (!t || t.type !== kind) return res.status(404).json({ message: 'Task not found' });
        deleteTask(t);
        res.json({});
      });
      // SSE: 状態が変わるたびに event: message でタスクオブジェクトを送り、終了状態で閉じる
      router.get(route + '/:id/stream', (req, res) => {
        const t = getTask(req.params.id, ownerOf(req));
        if (!t || t.type !== kind) return res.status(404).json({ message: 'Task not found' });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        let last = '';
        let unsub = () => {};
        const push = (task) => {
          const data = JSON.stringify(send(req, task));
          if (data !== last) { last = data; res.write(`event: message\ndata: ${data}\n\n`); }
          if (TERMINAL.has(task.status) || task.deleted) { unsub(); clearInterval(ka); res.end(); }
        };
        const ka = setInterval(() => res.write(': keep-alive\n\n'), 15000);
        unsub = subscribe(t.id, push);
        req.on('close', () => { unsub(); clearInterval(ka); });
        push(t);
      });
    }
    return router;
  }

  // 生成物の配信 (agent_proxy のように /uploads を持たないサーバー用)。認証なしで返す
  function sendFile(req, res) {
    const { id, name } = req.params;
    const t = UUID_RE.test(id || '') ? tasks.get(id) : null;
    if (!t || t.deleted || !FILE_NAME_RE.test(name || '')) return res.status(404).json({ message: 'Not found' });
    const abs = path.join(taskDir(id), name);
    if (!fs.existsSync(abs)) return res.status(404).json({ message: 'Not found' });
    res.sendFile(abs);
  }

  async function info() {
    const c = cfg();
    const up = procAlive() || !c.command ? await health() : null;
    return {
      enabled: !!isEnabled(),
      autoStart: !!c.command,
      running: !!up,
      starting: !!starting,
      backend: (up && up.backend) || backendName || (c.command ? c.backend : null),
      capabilities: (up && up.capabilities) || caps,
      loaded: !!(up && up.loaded),
      textMode: c.textMode,
      imageGenAvailable: !!isImageGenAvailable(),
      queue: queue.length,
      runningTask: running ? running.id : null,
    };
  }

  async function unload() {
    if (procAlive()) await stopWorker();
    else await workerRequest('POST', '/unload', {}, 60000).catch(() => {});
  }

  loadTasks();

  return {
    createTextTask, createImageTask, getTask, listTasks, deleteTask, toPublic, subscribe,
    createMeshyRouter, sendFile, info, unload, stopWorker,
    isWorkerRunning: procAlive,
    // プロセス終了時用 (同期)。ワーカーは保存すべき状態を持たない (途中のタスクはどのみち
    // 再起動で FAILED になる) ので、SIGKILL で即座に落とす。SIGTERM だと GPU 処理中に
    // 終了が遅れ、systemd の停止待ち (TimeoutStopSec) で再起動が長引くことがある
    kill: () => { if (procAlive()) { try { proc.kill('SIGKILL'); } catch {} } },
    outRoot,
  };
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

module.exports = { createModel3dManager, MODEL3D_DEFAULTS: DEFAULTS };
