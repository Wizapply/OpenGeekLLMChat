/**
 * llm_pool.js — マルチLLMワーカープール
 *
 * 複数の llama-server を「別ポートの子プロセス」として同時に立ち上げ、
 * オーケストレーション（複数モデルの協調実行）から使えるようにする。
 *
 * server.js のメインチャットは chatProc 1本しか持てない設計のため、
 * それとは独立したワーカー群をこのモジュールが管理する。
 *
 * ── 3つの動作モード ──
 *   resident : 必要なモデルを全て同時に常駐させる（VRAM に余裕がある構成向け・最速）
 *   swap     : 同時常駐は maxResident 台まで。溢れたらLRUでアンロードして載せ替える
 *   auto     : GPU の空きVRAMとモデルサイズ見積りから resident / swap を自動選択（既定）
 *
 * ── VRAM の節約 ──
 *   - メインチャットに既に同じモデルがロード済みならワーカーを立てずにそれを再利用する
 *   - swap 時は（設定により）メインチャットモデルを一旦アンロードして枠を空ける。
 *     アンロードした事実は server.js 側に伝え、次のチャット要求で自動再ロードさせる
 *
 * server.js から渡される deps 経由で内部関数を呼ぶ（循環参照回避）。
 */

const fs = require('fs');
const path = require('path');

// GGUF 以外の追加モデル(mmproj 等)も VRAM を食うので、extraArgs 中の
// ファイルパスらしき引数はサイズを加算する
const MODEL_FILE_RE = /\.(gguf|bin|safetensors)$/i;

// ─── GGUF ヘッダの読み取り ───
// KVキャッシュのサイズはモデルの層数・KVヘッド数・ヘッド次元で決まる。
// 「ctx 1024 あたり N MB」のような固定係数では実物と数倍ずれてしまい、
// 足りると誤判定して OOM するため、GGUF のメタデータから実際の値を読む。

const GGUF_TYPE = {
  UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5,
  FLOAT32: 6, BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12,
};
const GGUF_SCALAR_SIZE = {
  0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8,
};

/** ファイルを必要な分だけ読み進めるリーダー（メタデータは数MBになることがある） */
function createFileReader(filePath, maxBytes = 32 * 1024 * 1024) {
  const fd = fs.openSync(filePath, 'r');
  let buf = Buffer.alloc(0);
  let pos = 0;   // 読み取りカーソル
  const ensure = (need) => {
    while (buf.length < pos + need) {
      if (buf.length >= maxBytes) throw new Error('GGUFメタデータが想定より大きい');
      const chunk = Buffer.alloc(1024 * 1024);
      const n = fs.readSync(fd, chunk, 0, chunk.length, buf.length);
      if (n <= 0) throw new Error('GGUFヘッダが途中で終わっている');
      buf = Buffer.concat([buf, chunk.slice(0, n)]);
    }
  };
  return {
    close: () => { try { fs.closeSync(fd); } catch {} },
    skip: (n) => { ensure(n); pos += n; },
    u32: () => { ensure(4); const v = buf.readUInt32LE(pos); pos += 4; return v; },
    u64: () => { ensure(8); const v = Number(buf.readBigUInt64LE(pos)); pos += 8; return v; },
    str: () => {
      ensure(8); const n = Number(buf.readBigUInt64LE(pos)); pos += 8;
      ensure(n); const s = buf.slice(pos, pos + n).toString('utf-8'); pos += n; return s;
    },
    // 文字列を読み飛ばすだけ（トークナイザの巨大配列で文字列化しないため）
    skipStr: () => {
      ensure(8); const n = Number(buf.readBigUInt64LE(pos)); pos += 8;
      ensure(n); pos += n;
    },
    magic: () => { ensure(4); const s = buf.slice(pos, pos + 4).toString('ascii'); pos += 4; return s; },
  };
}

const ggufCache = new Map();   // path → { mtimeMs, meta }

/**
 * GGUF のメタデータから、VRAM見積りに必要な数値だけ抜き出す。
 * 読めなければ null（呼び出し側は従来の概算にフォールバックする）。
 *
 * @param {boolean} raw true にすると、採用値だけでなく接頭辞ごとの生の読み取り結果と
 *                      妥当性チェックの判定内訳も返す（診断用・キャッシュしない）
 */
function readGgufMeta(filePath, raw = false) {
  try {
    const st = fs.statSync(filePath);
    const hit = ggufCache.get(filePath);
    if (!raw && hit && hit.mtimeMs === st.mtimeMs) return hit.meta;

    const r = createFileReader(filePath);
    try {
      if (r.magic() !== 'GGUF') return null;
      r.u32();                       // version
      r.u64();                       // tensor_count
      const kvCount = r.u64();

      // general.architecture はループ内で個別に扱うのでここには入れない
      const want = new Set([
        'block_count', 'attention.head_count', 'attention.head_count_kv',
        'attention.key_length', 'attention.value_length', 'embedding_length',
        'expert_count',
        // Gemma3 等はほとんどの層がスライディングウィンドウ注意で、
        // その層のKVは ctx 全体ではなく窓幅ぶんしか要らない
        'attention.sliding_window', 'attention.sliding_window_pattern',
      ]);

      const skipValue = (type) => {
        if (type === GGUF_TYPE.STRING) { r.skipStr(); return; }
        if (type === GGUF_TYPE.ARRAY) {
          const itemType = r.u32();
          const n = r.u64();
          if (itemType === GGUF_TYPE.STRING) { for (let i = 0; i < n; i++) r.skipStr(); }
          else if (itemType === GGUF_TYPE.ARRAY) { for (let i = 0; i < n; i++) skipValue(itemType); }
          else r.skip((GGUF_SCALAR_SIZE[itemType] || 1) * n);
          return;
        }
        r.skip(GGUF_SCALAR_SIZE[type] || 1);
      };
      const readScalar = (type) => {
        if (type === GGUF_TYPE.UINT32 || type === GGUF_TYPE.INT32) return r.u32();
        if (type === GGUF_TYPE.UINT64 || type === GGUF_TYPE.INT64) return r.u64();
        if (type === GGUF_TYPE.STRING) return r.str();
        skipValue(type); return null;
      };

      // 重要: マルチモーダルGGUFには言語モデル(gemma3.*)とビジョンタワー(clip.*)の
      // 両方のメタデータが入っている。接頭辞を無視して suffix だけで拾うと、
      // 層数は言語モデル・ヘッド数はビジョンタワー…と値が混ざって桁違いの
      // KVサイズを算出してしまう。接頭辞ごとに保持し、最後に general.architecture の
      // 接頭辞を持つものだけを採用する。
      let arch = '';
      const byPrefix = new Map();   // 接頭辞 → { suffix: 値 }
      const put = (prefix, suffix, value) => {
        if (!byPrefix.has(prefix)) byPrefix.set(prefix, {});
        byPrefix.get(prefix)[suffix] = value;
      };

      for (let i = 0; i < kvCount; i++) {
        const key = r.str();
        const type = r.u32();
        if (key === 'general.architecture') {
          arch = readScalar(type) || '';
          continue;
        }
        const dot = key.indexOf('.');
        const prefix = dot > 0 ? key.slice(0, dot) : '';
        const suffix = dot > 0 ? key.slice(dot + 1) : key;
        if (prefix && want.has(suffix)) {
          put(prefix, suffix, readScalar(type));
        } else {
          skipValue(type);
        }
        // 早期に打ち切ると sliding_window 等の後方のキーを取りこぼすので、
        // 最後まで読む。文字列は skipStr で読み飛ばすだけなので実測でも十分速い。
      }

      // 言語モデル側の接頭辞を選ぶ。general.architecture が取れなければ、
      // block_count と attention.head_count_kv が揃っている接頭辞を使う
      let found = byPrefix.get(arch);
      if (!found) {
        for (const [, vals] of byPrefix) {
          if (vals.block_count && (vals['attention.head_count_kv'] || vals['attention.head_count'])) {
            found = vals; break;
          }
        }
      }
      found = found || {};

      const nLayer = found.block_count || 0;
      const nHead = found['attention.head_count'] || 0;
      const nHeadKv = found['attention.head_count_kv'] || nHead;
      const nEmbd = found.embedding_length || 0;
      const kLen = found['attention.key_length'] || (nHead ? Math.round(nEmbd / nHead) : 0);
      const vLen = found['attention.value_length'] || kLen;

      // 値の妥当性チェック。パースがずれたり別コンポーネントの値が混ざると
      // ありえない数値になり、そのまま計算すると桁違いのKVサイズを出してしまう。
      // 範囲だけでなく、GQAの構造的な制約でも検証する。
      const sane = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
      const inRange = sane(nLayer, 1, 256) && sane(nHeadKv, 1, 256)
        && sane(kLen, 16, 1024) && sane(vLen, 16, 1024);
      // GQA: KVヘッド数はヘッド数以下で、かつヘッド数を割り切れる
      // （head_count=32 に対し head_count_kv=124 のような値はここで弾かれる）
      const gqaOk = !nHead || (nHeadKv <= nHead && nHead % nHeadKv === 0);
      // ヘッド次元 × ヘッド数 は埋め込み次元と同程度になる（通常はほぼ一致）。
      // 2倍を超えるならヘッド次元の読み違い（sliding_window の値を拾う等）を疑う
      const dimOk = !nEmbd || !nHead || (kLen * nHead <= nEmbd * 2);
      const plausible = inRange && gqaOk && dimOk;

      const meta = (nLayer && nHeadKv && kLen && plausible)
        ? {
            arch, nLayer, nHead, nHeadKv, nEmbd, kLen, vLen,
            swa: found['attention.sliding_window'] || 0,
            swaPattern: found['attention.sliding_window_pattern'] || 0,
          }
        : null;
      if (raw) {
        // 診断用: 何を読んで、どの判定で落ちたのかを全部返す
        return {
          meta, arch,
          byPrefix: Object.fromEntries([...byPrefix].map(([k, v]) => [k, v])),
          picked: found,
          derived: { nLayer, nHead, nHeadKv, nEmbd, kLen, vLen },
          checks: { inRange, gqaOk, dimOk, plausible },
        };
      }
      ggufCache.set(filePath, { mtimeMs: st.mtimeMs, meta });
      return meta;
    } finally { r.close(); }
  } catch {
    return null;
  }
}

/**
 * KVキャッシュのサイズ(MB)。GGUFが読めれば実構造から計算する。
 * KV = ctx × 層数 × KVヘッド数 × (K次元 + V次元) × 2バイト(f16)
 */
function kvCacheMB(meta, ctx) {
  if (!meta) return null;
  const perTokenPerLayer = meta.nHeadKv * (meta.kLen + meta.vLen) * 2;

  // スライディングウィンドウ注意の層は、ctx 全体ではなく窓幅ぶんのKVで済む。
  // pattern は「何層に1層が全体注意か」（Gemma3 なら 6）。
  // 窓幅は分かるが pattern が読めない場合は、安全側に全層を全体注意として扱う。
  let tokenLayers;
  if (meta.swa > 0 && meta.swa < ctx && meta.swaPattern > 1) {
    const fullLayers = Math.ceil(meta.nLayer / meta.swaPattern);
    tokenLayers = fullLayers * ctx + (meta.nLayer - fullLayers) * meta.swa;
  } else {
    tokenLayers = meta.nLayer * ctx;
  }
  return (tokenLayers * perTokenPerLayer) / (1024 * 1024);
}

/**
 * モデル1体あたりの必要VRAMを見積もる（MB）。
 * 内訳は { weightsMB, kvMB, overheadMB, totalMB, exact }。
 * exact=false のときは GGUF を読めず概算に落ちている。
 *
 * 過小評価すると OOM して原因も分かりにくいので、迷ったら多めに出す。
 */
function estimateModelVram(model) {
  const ctx0 = model.ctx || 4096;

  // 実測値があれば推定を一切使わない（一度でもロードできたモデル）
  const measured = model.name ? getMeasured(model.name, ctx0) : null;
  if (measured) {
    const w = Math.round(measured.weightsMB || 0);
    const k = Math.round(measured.kvMB || 0);
    const o = Math.round(measured.overheadMB || 0);
    return {
      weightsMB: w, kvMB: k, overheadMB: o, totalMB: w + k + o,
      exact: true, source: 'measured',
      arch: null, layers: null, kvHeads: null, headDim: null, swa: 0,
    };
  }

  let weightsMB = 0;
  const addFile = (p) => {
    try {
      const st = fs.statSync(p);
      if (st.isFile()) weightsMB += st.size / (1024 * 1024);
    } catch { /* 存在しないファイルは無視 */ }
  };
  if (model.path) addFile(model.path);
  for (const a of (model.extraArgs || [])) {
    if (typeof a === 'string' && MODEL_FILE_RE.test(a)) addFile(a);
  }

  const ctx = ctx0;
  const meta = model.path ? readGgufMeta(model.path) : null;
  let kvMB = kvCacheMB(meta, ctx);
  const exact = kvMB != null;
  if (!exact) {
    // GGUFを読めない場合の保守的な概算。
    // 重みが大きいモデルほど層数・KVヘッドも多いので、重みに比例させる。
    kvMB = (ctx / 1024) * Math.max(64, weightsMB * 0.012);
  }

  // 計算バッファ + ランタイム。モデル規模に比例する分と下限を持たせる
  const overheadMB = Math.max(768, weightsMB * 0.05);

  return {
    weightsMB: Math.round(weightsMB),
    kvMB: Math.round(kvMB),
    overheadMB: Math.round(overheadMB),
    totalMB: Math.round(weightsMB + kvMB + overheadMB),
    exact,
    source: exact ? 'gguf' : 'approx',
    // 見積りの根拠。数値がおかしいときに何を読み違えたか分かるようUIにも出す
    arch: meta ? meta.arch : null,
    layers: meta ? meta.nLayer : null,
    kvHeads: meta ? meta.nHeadKv : null,
    headDim: meta ? meta.kLen : null,
    swa: meta ? meta.swa : 0,
  };
}

/** 後方互換: 合計値だけ返す */
function estimateModelVramMB(model) {
  return estimateModelVram(model).totalMB;
}

// ─── llama-server が報告する実測値の取り込み ───
// GGUFヘッダからの計算はアーキテクチャ固有の事情（unified KV、層ごとの
// 注意方式の違い等）を拾いきれず、どうしても誤差が残る。
// llama-server は起動時に確保したバッファサイズをログに出すので、
// 一度ロードできたモデルについてはその実測値を使う（推定より常に正確）。

const MEASURED_FILE = path.join(__dirname, 'vram-measured.json');

/** llama-server の出力から確保サイズ(MiB)を拾う正規表現 */
const MEASURE_PATTERNS = [
  // llama_kv_cache_unified: ROCm0 KV buffer size =  1344.00 MiB
  // llama_kv_cache_init:    CUDA0 KV buffer size =  1344.00 MiB
  { key: 'kvMB', re: /KV buffer size\s*=\s*([\d.]+)\s*MiB/i, sum: true },
  // llama_new_context_with_model: KV self size  = 1344.00 MiB, K (f16): 672.00 MiB, ...
  { key: 'kvMB', re: /KV self size\s*=\s*([\d.]+)\s*MiB/i, sum: false },
  // llm_load_tensors: ROCm0 buffer size = 17000.00 MiB   （重み）
  { key: 'weightsMB', re: /^\s*(?:llm_load_tensors|load_tensors):.*?buffer size\s*=\s*([\d.]+)\s*MiB/i, sum: true },
  // llama_new_context_with_model: ROCm0 compute buffer size = 1234.00 MiB
  { key: 'overheadMB', re: /compute buffer size\s*=\s*([\d.]+)\s*MiB/i, sum: true },
];

function loadMeasured() {
  try {
    if (fs.existsSync(MEASURED_FILE)) return JSON.parse(fs.readFileSync(MEASURED_FILE, 'utf-8'));
  } catch { /* 壊れていたら捨てて作り直す */ }
  return {};
}

let measuredCache = null;
function measuredStore() {
  if (!measuredCache) measuredCache = loadMeasured();
  return measuredCache;
}

function measuredKey(modelName, ctx) {
  return `${modelName}@${ctx}`;
}

/** 実測値があれば返す（{weightsMB, kvMB, overheadMB, at}） */
function getMeasured(modelName, ctx) {
  const m = measuredStore()[measuredKey(modelName, ctx)];
  return (m && m.kvMB > 0) ? m : null;
}

function saveMeasured(modelName, ctx, values) {
  const store = measuredStore();
  store[measuredKey(modelName, ctx)] = { ...values, at: Date.now() };
  try {
    fs.writeFileSync(MEASURED_FILE, JSON.stringify(store, null, 2));
  } catch { /* 書けなくても動作に影響はない */ }
}

/**
 * llama-server の出力行から確保サイズを抽出する。
 * 複数デバイス（マルチGPU）に分かれて報告されるものは合算する。
 */
function parseMeasurements(lines) {
  const out = {};
  for (const line of lines) {
    for (const p of MEASURE_PATTERNS) {
      const m = line.match(p.re);
      if (!m) continue;
      const v = parseFloat(m[1]);
      if (!Number.isFinite(v) || v <= 0) continue;
      if (p.sum) out[p.key] = (out[p.key] || 0) + v;
      else if (out[p.key] == null) out[p.key] = v;
    }
  }
  return out;
}

/**
 * マルチLLMワーカープールを生成する
 *
 * @param {object} deps
 *   getConfig()          → appConfig
 *   findModelByName(n)   → chatModels の要素
 *   spawnLlamaServer(args, label, onOutput, env) → ChildProcess
 *   waitForReady(host, port, timeoutMs) → Promise<boolean>
 *   log(ip, msg)
 *   getGpuInfo()         → [{ vramTotalMB, vramUsedMB }, ...]
 *   getGpuBackend()      → 'amd' | 'rocm' | 'nvidia' | 'none' | null（GPU固定の環境変数を決めるのに使う）
 *   isPortTaken(port)    → boolean  （外部APIサーバー等との衝突回避）
 *   mainChat: {
 *     getModel(), isStarting(), getEndpoint() → {host, port},
 *     touch(), unload() → Promise<void>（次回チャットで自動再ロードされるようにする）
 *   }
 */
function createLlmPool(deps) {
  const {
    getConfig, findModelByName, spawnLlamaServer, waitForReady,
    log, getGpuInfo, getGpuBackend = () => null, isPortTaken, mainChat,
  } = deps;

  /** @type {Map<string, object>} modelName → worker */
  const workers = new Map();
  /** @type {Map<string, Promise>} 起動中のモデル（同時 acquire の二重起動防止） */
  const starting = new Map();
  /**
   * acquire がワーカーの起動完了を待っている数。
   * refCount++ は await の後になるため、その隙にワーカーが evict されないよう
   * 「これから使う予約」としてカウントしておく。
   * @type {Map<string, number>}
   */
  const reservations = new Map();
  /**
   * 直近の異常終了の記録。VRAM不足等でワーカーが落ちると呼び出し側には
   * "socket hang up" しか見えないため、終了コードと出力の末尾を残して原因を伝える。
   * @type {Map<string, {code: number, signal: string, tail: string, at: number}>}
   */
  const crashes = new Map();
  // メインチャットを一時アンロードしたか（ワークフロー終了後のログ用）
  let mainChatReleased = false;

  const LOG_TAIL_LINES = 40;

  function reserve(modelName) {
    reservations.set(modelName, (reservations.get(modelName) || 0) + 1);
  }
  function unreserve(modelName) {
    const n = (reservations.get(modelName) || 0) - 1;
    if (n > 0) reservations.set(modelName, n);
    else reservations.delete(modelName);
  }
  function isReserved(modelName) {
    return (reservations.get(modelName) || 0) > 0;
  }

  const cfg = () => (getConfig().orchestration || {});

  function poolHost() {
    return cfg().workerHost || getConfig().llamaServer?.chatHost || '127.0.0.1';
  }

  function maxResident() {
    const n = parseInt(cfg().maxResident);
    return Number.isFinite(n) && n > 0 ? n : 3;
  }

  // ─── VRAM 判定 ───

  function freeVramMB() {
    const gpus = getGpuInfo() || [];
    let free = 0;
    for (const g of gpus) {
      const total = g.vramTotalMB || 0;
      const used = g.vramUsedMB || 0;
      if (total > 0) free += Math.max(0, total - used);
    }
    return Math.round(free);
  }

  // ─── GPU配置 ───
  //
  // llama.cpp は複数デバイスが見えていると既定でレイヤーを全GPUに分散する
  // (--split-mode layer)。1枚に収まるモデルまで分散されると、トークンごとに
  // PCIe をまたぐぶん遅くなり、2GBしかない内蔵GPUのような枠にも配られてしまう。
  // 丸ごと載るGPUが1枚あるならそこに固定する。
  //
  // 固定は llama.cpp のフラグ (--split-mode / --main-gpu) ではなく可視デバイスの
  // 絞り込みで行う。フラグの解釈はビルドによって変わるが、可視デバイスは
  // ランタイム層の話なのでバージョン差の影響を受けず、1枚しか見せなければ
  // 「llama.cpp が何番をどう解釈するか」という曖昧さ自体が消える。

  function gpuPlacementMode() {
    return cfg().gpuPlacement || 'spread';
  }

  // 配置を決めてから実測VRAMに現れるまでのラグ。GPU情報は1秒間隔で更新されるが、
  // llama-server は起動中に少しずつ確保するので、readyになった直後もまだ足りない
  const GPU_SETTLE_MS = 15000;

  /** そのGPUに載せたばかりで、まだ実測に反映されていないぶん(MB) */
  function reservedOnGpu(idx) {
    let mb = 0;
    for (const [, w] of workers) {
      if (w.gpuIndex !== idx) continue;
      // 起動中のあいだと、ready 直後のしばらくは実測を信用しない。
      // これが無いと、ほぼ同時に走った2本が同じGPUを「空いている」と見て二重に載る
      if (!w.ready || !w.readyAt || Date.now() - w.readyAt < GPU_SETTLE_MS) mb += w.estMB || 0;
    }
    return mb;
  }

  /**
   * モデルを丸ごと載せられるGPUを1枚選ぶ。空きが最も多いものを選ぶ。
   * 選べなければ null を返し、呼び出し側は従来どおり llama.cpp の分散に任せる。
   */
  function pickGpu(requiredMB) {
    if (gpuPlacementMode() !== 'auto') return null;
    const backend = getGpuBackend();
    if (!backend || backend === 'none') return null;   // 環境変数の名前が決められない
    const gpus = getGpuInfo() || [];
    if (gpus.length < 2) return null;                  // 1枚しかないなら固定する意味がない
    if (!(requiredMB > 0)) return null;                // 見積れないモデルは分散のまま

    const margin = Number.isFinite(cfg().vramSafetyMarginMB) ? cfg().vramSafetyMarginMB : 2048;
    let best = null;
    for (let i = 0; i < gpus.length; i++) {
      const total = gpus[i].vramTotalMB || 0;
      const used = gpus[i].vramUsedMB || 0;
      if (total <= 0) continue;
      const free = Math.max(0, total - used) - reservedOnGpu(i);
      if (free < requiredMB + margin) continue;
      if (!best || free > best.freeMB) best = { index: i, freeMB: free };
    }
    return best;
  }

  /** 指定GPUだけを見せる環境変数 */
  function gpuEnv(index) {
    if (getGpuBackend() === 'nvidia') {
      return {
        // nvidia-smi は既定でPCIバス順、CUDA は性能順に並べる。揃えないと
        // 「監視で見ている0番」と「CUDAの0番」がずれて、別のGPUに載る
        CUDA_DEVICE_ORDER: 'PCI_BUS_ID',
        CUDA_VISIBLE_DEVICES: String(index),
      };
    }
    // AMD。HIP_VISIBLE_DEVICES と併用してはいけない:
    // ROCR_ で絞った後のリストに対して HIP_ がさらに添字を取るため、
    // 両方に同じ番号を入れると 1番以降で「そんなデバイスは無い」になる
    return { ROCR_VISIBLE_DEVICES: String(index) };
  }

  /**
   * ワークフローで使うモデル群に対して resident / swap のどちらで走らせるか決める。
   * poolMode が 'resident' / 'swap' 固定ならそれを返す。
   *
   * @param {string[]} modelNames 使用モデル名（重複可）
   * @returns {{mode: 'resident'|'swap', reason: string, freeMB: number, requiredMB: number}}
   */
  function planMode(modelNames) {
    const mode = cfg().poolMode || 'auto';
    const uniq = [...new Set(modelNames.filter(Boolean))];

    // 既にワーカー or メインチャットに載っているモデルは追加VRAMを消費しない
    const resident = new Set();
    for (const [name, w] of workers) if (w.ready) resident.add(name);
    const mainModel = mainChat.getModel();
    if (mainModel && cfg().reuseMainChat !== false) resident.add(mainModel);

    // モデルごとの内訳。UIに出して「何にどれだけ要るか」を見えるようにする
    const breakdown = [];
    let requiredMB = 0;      // 今から追加で確保が要る量（ロード済みは除く）
    let footprintMB = 0;     // ワークフロー全体がVRAMを占める量（ロード済みも含む）
    let anyApprox = false;
    for (const name of uniq) {
      const m = findModelByName(name);
      if (!m) continue;
      const est = estimateModelVram(m);
      const alreadyLoaded = resident.has(name);
      footprintMB += est.totalMB;
      if (!alreadyLoaded) requiredMB += est.totalMB;
      if (!est.exact) anyApprox = true;
      breakdown.push({
        name, alreadyLoaded, ctx: m.ctx || 4096,
        weightsMB: est.weightsMB, kvMB: est.kvMB, overheadMB: est.overheadMB,
        totalMB: est.totalMB, exact: est.exact, source: est.source,
        arch: est.arch, layers: est.layers, kvHeads: est.kvHeads, headDim: est.headDim, swa: est.swa,
      });
    }
    const freeMB = freeVramMB();
    const margin = Number.isFinite(cfg().vramSafetyMarginMB) ? cfg().vramSafetyMarginMB : 2048;
    // GPU情報が取れないときの「不足量」は意味を持たないので null にする
    // （0 や適当な数字を出すと、足りているように見えたり嘘の不足量を表示してしまう）
    const shortageMB = freeMB > 0 ? Math.max(0, requiredMB + margin - freeMB) : null;
    const loadedMB = footprintMB - requiredMB;   // 既にVRAM上にある分
    const base = {
      freeMB, requiredMB, footprintMB, loadedMB,
      marginMB: margin, shortageMB, breakdown, approx: anyApprox,
    };

    if (mode === 'resident') {
      return { ...base, mode: 'resident', reason: '設定で常駐並列モード固定' };
    }
    if (mode === 'swap') {
      return { ...base, mode: 'swap', reason: '設定で逐次スワップモード固定' };
    }

    // auto: GPU情報が取れないときは安全側（swap）に倒す
    if (freeMB <= 0) {
      return {
        ...base,
        mode: uniq.length <= 1 ? 'resident' : 'swap',
        reason: 'GPU使用状況を取得できないため安全側に判定しました',
      };
    }
    const gb = (mb) => (mb / 1024).toFixed(1);
    // ロード済みのぶんは追加確保が不要なので、そのことを明示する
    // （でないと「必要 0.0GB」とだけ出て何が起きているか分からない）
    const loadedNote = loadedMB > 0 ? `${gb(loadedMB)}GBはロード済みのため追加確保は不要。` : '';
    if (shortageMB === 0) {
      return {
        ...base, mode: 'resident',
        reason: `全モデルを同時に載せられます。${loadedNote}`
          + `追加で必要 ${gb(requiredMB)}GB + 余裕 ${gb(margin)}GB ≦ 空き ${gb(freeMB)}GB`,
      };
    }
    return {
      ...base, mode: 'swap',
      reason: `VRAMが ${gb(shortageMB)}GB 足りないため1モデルずつ入れ替えて実行します。${loadedNote}`
        + `追加で必要 ${gb(requiredMB)}GB + 余裕 ${gb(margin)}GB > 空き ${gb(freeMB)}GB`,
    };
  }

  // ─── ポート割当 ───

  // 直前に使っていたポートを即座に再利用すると、前のプロセスが完全に終了する前に
  // 新しい llama-server が bind して EADDRINUSE になることがある。
  // カーソルを進めながら範囲内を巡回することで、解放直後のポートを避ける。
  let portCursor = 0;

  function allocatePort() {
    const range = cfg().portRange || [8100, 8149];
    const start = parseInt(range[0]) || 8100;
    const end = parseInt(range[1]) || (start + 49);
    const span = Math.max(1, end - start + 1);
    const ls = getConfig().llamaServer || {};
    const inUse = new Set();
    for (const [, w] of workers) inUse.add(w.port);
    for (let i = 0; i < span; i++) {
      const p = start + ((portCursor + i) % span);
      if (inUse.has(p)) continue;
      if (p === ls.chatPort || p === ls.embeddingPort) continue;
      if (isPortTaken && isPortTaken(p)) continue;
      portCursor = (portCursor + i + 1) % span;
      return p;
    }
    throw new Error(`ワーカー用の空きポートがありません (範囲: ${start}-${end})`);
  }

  // ─── ワーカーの起動 / 停止 ───

  function startWorker(modelName) {
    // 起動処理が既に走っていれば相乗りする
    if (starting.has(modelName)) return starting.get(modelName);

    const p = (async () => {
      const model = findModelByName(modelName);
      if (!model) throw new Error(`モデルが見つかりません: ${modelName}`);
      if (!fs.existsSync(model.path)) throw new Error(`モデルファイルが存在しません: ${model.path}`);

      const ls = getConfig().llamaServer || {};
      const host = poolHost();
      const port = allocatePort();

      // commonArgs から --port / --host を（値ごと）除外する
      const filterPairArgs = (args, exclude) => {
        const out = [];
        for (let i = 0; i < args.length; i++) {
          if (exclude.includes(args[i])) { i++; continue; }
          out.push(args[i]);
        }
        return out;
      };
      // 既定は1スロット。llama.cpp は -c をスロット数で割るため、増やすと
      // 1リクエストあたりの文脈が狭くなる（同一モデルへの並列が要るときだけ上げる）
      const np = model.nParallel ?? cfg().workerParallel ?? 1;

      const args = [
        '-m', model.path,
        '-c', String(model.ctx),
        '-ngl', String(model.ngl),
        '-np', String(np),
        '--port', String(port),
        '--host', host,
        ...filterPairArgs(ls.commonArgs || [], ['--port', '--host']),
        ...(model.chatTemplate ? ['--chat-template', model.chatTemplate] : []),
        ...(model.extraArgs || []),
      ];

      // 丸ごと載るGPUが1枚あればそこに固定する。無ければ null で従来どおり分散。
      // 予約 (reservedOnGpu) が効くよう、workers に入れる前に決めておく
      const est = estimateModelVram(model);
      const placement = pickGpu(est.totalMB);
      const env = placement ? gpuEnv(placement.index) : null;

      const worker = {
        modelName, host, port,
        proc: null, ready: false, refCount: 0, stopping: false,
        logTail: [],   // 直近の出力（異常終了時の原因表示用）
        lastUsed: Date.now(), startedAt: Date.now(),
        // GPU固定の記録。readyAt は「実測VRAMに現れるまでの猶予」の起点
        gpuIndex: placement ? placement.index : null,
        estMB: est.totalMB,
        readyAt: null,
      };
      workers.set(modelName, worker);

      log('-', `[LLMプール] ワーカー起動: ${modelName} @ ${host}:${port} (-np ${np})`
        + (placement
          ? ` / GPU${placement.index} に固定 (必要 ${(est.totalMB / 1024).toFixed(1)}GB ≦ 空き ${(placement.freeMB / 1024).toFixed(1)}GB)`
          : (gpuPlacementMode() === 'auto' ? ' / 1枚に収まらないため全GPUに分散' : '')));
      // logLevel が quiet でも出力は捨てず、末尾数十行だけ保持しておく
      worker.proc = spawnLlamaServer(args, `pool:${modelName}`, (chunk) => {
        for (const line of String(chunk).split('\n')) {
          if (!line.trim()) continue;
          worker.logTail.push(line);
          if (worker.logTail.length > LOG_TAIL_LINES) worker.logTail.shift();
        }
      }, env);
      worker.proc.on('exit', (code, signal) => {
        // 異常終了しても Map に残っていると死んだポートを掴み続けるので掃除する
        if (workers.get(modelName) === worker) workers.delete(modelName);
        worker.ready = false;
        // 自分で止めたのでなければ「落ちた」として記録する
        if (!worker.stopping) {
          // 落ちた瞬間のGPU状況を残す。見積りではなく実測値なので原因判断に直結する
          let gpuSnapshot = null;
          try {
            gpuSnapshot = (getGpuInfo() || []).map(g => ({
              id: g.id || '', totalMB: g.vramTotalMB || 0, usedMB: g.vramUsedMB || 0,
            }));
          } catch {}
          crashes.set(modelName, {
            code, signal,
            tail: worker.logTail.slice(-12).join('\n'),
            gpu: gpuSnapshot,
            at: Date.now(),
          });
          log('-', `[LLMプール] ワーカー異常終了: ${modelName} (code=${code}${signal ? `, signal=${signal}` : ''})`);
          if (gpuSnapshot && gpuSnapshot.length) {
            log('-', `[LLMプール] 異常終了時のGPU: ` + gpuSnapshot
              .map(g => `${g.id} ${(g.usedMB / 1024).toFixed(1)}/${(g.totalMB / 1024).toFixed(1)}GB`).join(' , '));
          }
          if (worker.logTail.length) {
            log('-', `[LLMプール] ${modelName} の最終出力:\n${worker.logTail.slice(-12).join('\n')}`);
          }
        }
      });

      const ready = await waitForReady(host, port, ls.readyTimeoutMs || 120000);
      if (!ready) {
        worker.stopping = true;
        try { worker.proc.kill('SIGTERM'); } catch {}
        workers.delete(modelName);
        const tail = worker.logTail.slice(-12).join('\n');
        throw new Error(
          `ワーカー起動タイムアウト: ${modelName} (${host}:${port})`
          + (tail ? `\n--- llama-server の出力 ---\n${tail}` : '')
        );
      }
      // 起動できたので過去の異常終了記録は消す
      crashes.delete(modelName);

      // llama-server が報告した実際の確保サイズを取り込む。
      // 以降この (モデル, ctx) の見積りは推定ではなく実測値を使う。
      const measured = parseMeasurements(worker.logTail);
      if (measured.kvMB > 0) {
        saveMeasured(modelName, model.ctx || 4096, measured);
        log('-', `[LLMプール] ${modelName} の実測VRAM: 重み ${(measured.weightsMB / 1024 || 0).toFixed(1)}GB`
          + ` / KV ${(measured.kvMB / 1024).toFixed(2)}GB`
          + ` / 計算バッファ ${((measured.overheadMB || 0) / 1024).toFixed(2)}GB`);
      }
      worker.ready = true;
      worker.lastUsed = Date.now();
      worker.readyAt = Date.now();
      log('-', `[LLMプール] ワーカー準備完了: ${modelName} @ ${host}:${port}`
        + (worker.gpuIndex != null ? ` (GPU${worker.gpuIndex})` : ''));
      return worker;
    })();

    starting.set(modelName, p);
    p.finally(() => { starting.delete(modelName); }).catch(() => {});
    return p;
  }

  function stopWorker(modelName) {
    return new Promise((resolve) => {
      const w = workers.get(modelName);
      if (!w) return resolve();
      workers.delete(modelName);
      w.ready = false;
      w.stopping = true;   // 意図的な停止なので「異常終了」として記録しない
      const proc = w.proc;
      w.proc = null;
      if (!proc || proc.killed) return resolve();
      log('-', `[LLMプール] ワーカー停止: ${modelName} (:${w.port})`);
      proc.once('exit', () => resolve());
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(); }, 5000);
    });
  }

  /** 落としてよいワーカーか（使用中・起動途中・これから使う予約済みは対象外） */
  function isEvictable(w) {
    // refCount は acquire の await 後に増えるため、その隙を突かないよう
    // 予約(reservations)も見る。ready でないもの＝起動途中も落とさない。
    return w.refCount === 0 && w.ready && !isReserved(w.modelName);
  }

  /** 使用中でない最も古いワーカーを1台落として枠を空ける */
  async function evictOne() {
    let victim = null;
    for (const [, w] of workers) {
      if (!isEvictable(w)) continue;
      if (!victim || w.lastUsed < victim.lastUsed) victim = w;
    }
    if (!victim) return false;
    await stopWorker(victim.modelName);
    return true;
  }

  // ─── 取得 / 返却 ───

  /**
   * 指定モデルのエンドポイントを確保する。
   * 使い終わったら必ず release() を呼ぶこと（呼ばないとアンロードされなくなる）。
   *
   * @param {string} modelName
   * @param {{mode?: 'resident'|'swap'}} opts 実行中ワークフローが決めたモード
   * @returns {Promise<{host, port, modelName, viaMainChat: boolean, release: Function}>}
   */
  async function acquire(modelName, opts = {}) {
    const mode = opts.mode || cfg().poolMode || 'auto';

    // (1) メインチャットに同じモデルが載っていればそれを使う（VRAM二重消費を避ける）
    if (cfg().reuseMainChat !== false && mainChat.getModel() === modelName && !mainChat.isStarting()) {
      const ep = mainChat.getEndpoint();
      mainChat.touch();
      return {
        host: ep.host, port: ep.port, modelName, viaMainChat: true,
        release() { mainChat.touch(); },
      };
    }

    // (2) 既に起動済みのワーカーがあれば使う
    const existing = workers.get(modelName);
    if (existing && existing.ready) {
      existing.refCount++;
      existing.lastUsed = Date.now();
      return makeHandle(existing);
    }

    // (3) 起動中なら完了を待つ
    if (starting.has(modelName)) {
      reserve(modelName);
      try {
        const w = await starting.get(modelName);
        w.refCount++;
        w.lastUsed = Date.now();
        return makeHandle(w);
      } finally { unreserve(modelName); }
    }

    // (4) 新規起動。await を挟むので、この時点から予約を立てておく
    reserve(modelName);
    try {
      const limit = mode === 'swap' ? 1 : maxResident();
      if (workers.size >= limit) {
        const timeoutMs = cfg().acquireTimeoutMs || 600000;
        const deadline = Date.now() + timeoutMs;
        while (workers.size >= limit) {
          const evicted = await evictOne();
          if (evicted) break;
          // 全ワーカーが使用中: 誰かが release するまで待つ
          if (Date.now() > deadline) {
            throw new Error(`ワーカーの空き待ちがタイムアウトしました (${modelName})`);
          }
          await new Promise(r => setTimeout(r, 500));
        }
      }

      // swap モードではメインチャットのモデルも VRAM を占有しているので、
      // 設定が有効なら一旦アンロードして枠を空ける（次のチャット要求で自動再ロードされる）
      if (mode === 'swap' && cfg().swapUnloadsMainChat !== false && mainChat.getModel()) {
        log('-', `[LLMプール] スワップモード: メインチャットモデル「${mainChat.getModel()}」を一時アンロード`);
        await mainChat.unload();
        mainChatReleased = true;
      }

      const w = await startWorker(modelName);
      w.refCount++;
      w.lastUsed = Date.now();
      return makeHandle(w);
    } finally { unreserve(modelName); }
  }

  /**
   * プール外のプロセス（メインチャットの llama-server）が落ちたことを記録する。
   * reuseMainChat でメインチャットを間借りしている間にそれが落ちると、
   * プールには何の記録も残らず、呼び出し側には生の "socket hang up" しか見えない。
   * server.js から通知してもらうことでこの穴を塞ぐ。
   */
  function recordExternalCrash(modelName, info) {
    if (!modelName) return;
    crashes.set(modelName, {
      code: info?.code ?? null,
      signal: info?.signal ?? null,
      tail: info?.tail || '',
      gpu: info?.gpu || null,
      external: true,     // プール管理外（メインチャット）で落ちた
      at: Date.now(),
    });
    log('-', `[LLMプール] メインチャットの llama-server が異常終了: ${modelName}`
      + ` (code=${info?.code}${info?.signal ? `, signal=${info.signal}` : ''})`);
  }

  /** 直近にそのモデルのワーカーが異常終了していれば、その記録を返す */
  function getCrash(modelName) {
    const c = crashes.get(modelName);
    if (!c) return null;
    // 古い記録は無関係な失敗に巻き込まれるので捨てる
    if (Date.now() - c.at > 120000) { crashes.delete(modelName); return null; }
    return c;
  }

  /**
   * 異常終了の記録を少しだけ待ってから返す。
   * ソケットのエラーは子プロセスの 'exit' イベントより先に届くことがあり、
   * 呼び出し直後に getCrash() を見ても間に合わないため。
   */
  async function awaitCrash(modelName, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const c = getCrash(modelName);
      if (c) return c;
      if (Date.now() >= deadline) return null;
      await new Promise(r => setTimeout(r, 100));
    }
  }

  function makeHandle(w) {
    let released = false;
    return {
      host: w.host, port: w.port, modelName: w.modelName, viaMainChat: false,
      release() {
        if (released) return;
        released = true;
        w.refCount = Math.max(0, w.refCount - 1);
        w.lastUsed = Date.now();
      },
    };
  }

  // ─── アイドルアンロード ───

  let idleTimer = null;
  function startIdleTimer() {
    if (idleTimer) return;
    idleTimer = setInterval(async () => {
      const idleMs = cfg().idleUnloadMs;
      if (!idleMs || idleMs <= 0) return;
      const now = Date.now();
      for (const [name, w] of [...workers]) {
        if (!isEvictable(w)) continue;
        if (now - w.lastUsed >= idleMs) {
          log('-', `[LLMプール] アイドル ${Math.floor((now - w.lastUsed) / 1000)}秒、ワーカー「${name}」を自動アンロード`);
          await stopWorker(name);
        }
      }
    }, 30000);
    if (idleTimer.unref) idleTimer.unref();
  }

  // ─── 状態取得・後始末 ───

  function status() {
    const list = [];
    for (const [name, w] of workers) {
      list.push({
        modelName: name, host: w.host, port: w.port,
        ready: w.ready, refCount: w.refCount,
        startedAt: w.startedAt, lastUsed: w.lastUsed,
        // null なら全GPUに分散（1枚に収まらなかった / gpuPlacement が spread）
        gpuIndex: w.gpuIndex ?? null,
        estimatedVramMB: (() => {
          const m = findModelByName(name);
          return m ? estimateModelVramMB(m) : null;
        })(),
        vram: (() => {
          const m = findModelByName(name);
          return m ? estimateModelVram(m) : null;
        })(),
      });
    }
    for (const name of starting.keys()) {
      if (!workers.has(name)) list.push({ modelName: name, ready: false, starting: true, refCount: 0 });
    }
    return {
      mode: cfg().poolMode || 'auto',
      gpuPlacement: gpuPlacementMode(),
      maxResident: maxResident(),
      freeVramMB: freeVramMB(),
      mainChatModel: mainChat.getModel(),
      mainChatReleased,
      workers: list.sort((a, b) => String(a.modelName).localeCompare(String(b.modelName))),
    };
  }

  async function unloadAll() {
    for (const name of [...workers.keys()]) await stopWorker(name);
    mainChatReleased = false;
  }

  /** プロセス終了時用（await しない同期キル） */
  function killAll() {
    for (const [, w] of workers) {
      if (w.proc && !w.proc.killed) { try { w.proc.kill('SIGTERM'); } catch {} }
    }
    workers.clear();
  }

  startIdleTimer();

  return {
    acquire, planMode, status, unloadAll, killAll, getCrash, awaitCrash,
    estimateModelVram, estimateModelVramMB, freeVramMB, getMeasured, recordExternalCrash,
  };
}

module.exports = {
  createLlmPool, estimateModelVram, estimateModelVramMB, readGgufMeta,
  parseMeasurements, getMeasured,
};
