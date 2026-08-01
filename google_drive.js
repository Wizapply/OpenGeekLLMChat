/**
 * google_drive.js — Google Drive 連携モジュール
 *
 * LLM (チャット / 外部APIのツール対応モード) から Google Drive を
 * 「読む・探す・書く・持ってくる・置きに行く」ためのクライアント。
 *
 * 方針:
 * - 依存を増やさない。Node 標準の https / crypto だけで OAuth2 と Drive API v3 を実装する
 *   (googleapis パッケージは巨大なので使わない。プロジェクト全体の「依存は最小」に合わせる)
 * - 認証は2方式:
 *     oauth          … 個人の Google アカウントをブラウザで一度だけ認可 (リフレッシュトークン保存)
 *     serviceAccount … サービスアカウントJSONキーで JWT 署名 (ヘッドレス運用・共有ドライブ向け)
 * - 秘密情報 (clientSecret / refreshToken) はブラウザに絶対返さない。
 *   リフレッシュトークンは config.json ではなく別ファイル (既定 gdrive_token.json) に保存する。
 * - rootFolderId を設定すると、そのフォルダ配下だけにアクセスを限定する (サンドボックス)。
 * - readOnly / allowWrite / allowDelete で書き込み・削除を段階的に許可する。
 *
 * Drive API リファレンス: https://developers.google.com/drive/api/v3/reference
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── エンドポイント ───
const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

// ─── スコープ ───
const SCOPE_READONLY = 'https://www.googleapis.com/auth/drive.readonly';
const SCOPE_FULL = 'https://www.googleapis.com/auth/drive';

// Drive 上のフォルダを表す MIME
const FOLDER_MIME = 'application/vnd.google-apps.folder';

// 一覧・メタデータ取得で欲しいフィールド
const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,createdTime,parents,webViewLink,iconLink,owners(displayName,emailAddress),trashed,shortcutDetails(targetId,targetMimeType)';

/**
 * Google ネイティブ形式 (Docs/Sheets/Slides) は alt=media で落とせないので
 * export でテキスト系に変換する。LLM が読める形を優先。
 */
const GOOGLE_EXPORT_MAP = {
  'application/vnd.google-apps.document':     { mimeType: 'text/plain',                ext: 'txt' },
  'application/vnd.google-apps.spreadsheet':  { mimeType: 'text/csv',                  ext: 'csv' },
  'application/vnd.google-apps.presentation': { mimeType: 'text/plain',                ext: 'txt' },
  'application/vnd.google-apps.script':       { mimeType: 'application/vnd.google-apps.script+json', ext: 'json' },
  'application/vnd.google-apps.drawing':      { mimeType: 'image/png',                 ext: 'png' },
};

/** バイナリ相当としてダウンロード時に Office 形式で出したい場合のマップ (import 用) */
const GOOGLE_EXPORT_OFFICE_MAP = {
  'application/vnd.google-apps.document':     { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' },
  'application/vnd.google-apps.spreadsheet':  { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       ext: 'xlsx' },
  'application/vnd.google-apps.presentation': { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' },
};

/** テキストとしてそのまま読める MIME か */
function isTextualMime(mime) {
  if (!mime) return false;
  if (mime.startsWith('text/')) return true;
  return [
    'application/json', 'application/xml', 'application/javascript',
    'application/x-yaml', 'application/yaml', 'application/sql',
    'application/x-sh', 'application/x-python', 'application/csv',
  ].includes(mime);
}

/** 拡張子から MIME を推定 (アップロード時) */
function guessMimeFromName(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  const map = {
    '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
    '.json': 'application/json', '.xml': 'application/xml',
    '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
    '.js': 'application/javascript', '.jsx': 'text/plain', '.ts': 'text/plain',
    '.py': 'text/x-python', '.sh': 'application/x-sh',
    '.yaml': 'application/x-yaml', '.yml': 'application/x-yaml',
    '.pdf': 'application/pdf', '.zip': 'application/zip',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return map[ext] || 'application/octet-stream';
}

/**
 * Drive クエリ言語の文字列リテラルをエスケープする。
 * q= は `name contains 'foo'` のような DSL で、シングルクォートとバックスラッシュだけ
 * エスケープすればリテラルを閉じられない = クエリインジェクション防止。
 */
function escapeQueryLiteral(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** base64url エンコード (JWT 用) */
function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * https リクエスト (リダイレクト追従・サイズ上限つき)
 * @returns {Promise<{status:number, headers:object, body:Buffer}>}
 */
function httpRequest(url, { method = 'GET', headers = {}, body = null, maxBytes = 0, timeoutMs = 60000, redirectsLeft = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error(`不正なURL: ${url}`)); }

    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers,
      timeout: timeoutMs,
    }, (res) => {
      // 3xx リダイレクト (ダウンロードで発生することがある)
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();  // 本文を捨てる
        const next = new URL(res.headers.location, url).toString();
        // 303 / 302 は GET に落とす (Drive のダウンロードリダイレクトは GET)
        const nextMethod = (res.statusCode === 303) ? 'GET' : method;
        return resolve(httpRequest(next, {
          method: nextMethod, headers, body: nextMethod === 'GET' ? null : body,
          maxBytes, timeoutMs, redirectsLeft: redirectsLeft - 1,
        }));
      }

      const chunks = [];
      let total = 0;
      let aborted = false;
      res.on('data', (c) => {
        if (aborted) return;
        total += c.length;
        if (maxBytes && total > maxBytes) {
          aborted = true;
          req.destroy();
          reject(new Error(`応答サイズが上限を超えました (上限 ${(maxBytes / 1024 / 1024).toFixed(1)}MB)`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        if (aborted) return;
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
      res.on('error', (e) => { if (!aborted) reject(e); });
    });

    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error(`Google API がタイムアウトしました (${timeoutMs}ms)`)); });
    if (body) req.write(body);
    req.end();
  });
}

/** Google API のエラー本文を読みやすいメッセージにする */
function formatApiError(status, buf) {
  let detail = '';
  try {
    const j = JSON.parse(buf.toString('utf-8'));
    detail = j.error?.message || j.error_description || j.error || '';
    // よくある権限エラーは対処法を添える
    if (j.error?.errors?.[0]?.reason === 'insufficientFilePermissions') {
      detail += ' (このファイルへの権限がありません。共有設定を確認してください)';
    }
  } catch {
    detail = buf.toString('utf-8').slice(0, 300);
  }
  const hint =
    status === 401 ? ' — 認証が切れています。GDrive を再接続してください'
    : status === 403 ? ' — 権限不足、またはAPIが有効化されていない可能性があります (Google Cloud Console で Drive API を有効化)'
    : status === 404 ? ' — ファイル/フォルダが見つかりません (IDの誤り、または共有されていない)'
    : '';
  return new Error(`GDrive API エラー ${status}: ${detail}${hint}`);
}

// ════════════════════════════════════════════════════════════════
// クライアント本体
// ════════════════════════════════════════════════════════════════

/**
 * Google Drive クライアントを生成する。
 * config は再起動なしで差し替えられるよう、getConfig() で毎回読む形にしている。
 *
 * @param {object} opts
 * @param {() => object} opts.getConfig  appConfig.googleDrive を返す関数
 * @param {string} opts.baseDir          トークンファイルを置く基準ディレクトリ (通常 __dirname)
 * @param {(ip:string,msg:string)=>void} [opts.log]
 */
function createGoogleDrive({ getConfig, baseDir, log = () => {} }) {
  // アクセストークンのメモリキャッシュ
  let accessToken = null;
  let accessTokenExpiresAt = 0;
  let refreshInFlight = null;     // 同時リフレッシュの重複防止
  // 親フォルダ探索のキャッシュ (rootFolderId サンドボックス判定を軽くする)
  const parentCache = new Map();  // fileId -> { parents: string[], at: number }
  const PARENT_CACHE_TTL = 5 * 60 * 1000;

  const cfg = () => (getConfig() || {});

  const tokenFilePath = () => {
    const f = cfg().tokenFile || 'gdrive_token.json';
    return path.isAbsolute(f) ? f : path.join(baseDir, f);
  };

  // ─── トークンストア (リフレッシュトークンをディスクに保存) ───
  function readTokenStore() {
    try {
      const p = tokenFilePath();
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (e) {
      log('-', `[Drive] トークンファイル読み込み失敗: ${e.message}`);
      return null;
    }
  }

  function writeTokenStore(data) {
    const p = tokenFilePath();
    fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
    try { fs.chmodSync(p, 0o600); } catch {}
  }

  function clearTokenStore() {
    try { fs.unlinkSync(tokenFilePath()); } catch {}
    accessToken = null;
    accessTokenExpiresAt = 0;
    parentCache.clear();
  }

  /** 現在の設定から使うスコープを決める */
  function currentScope() {
    const c = cfg();
    if (c.scope) return c.scope;  // 明示指定があれば尊重
    return (c.readOnly !== false && !c.allowWrite) ? SCOPE_READONLY : SCOPE_FULL;
  }

  // ─── 認証: OAuth (ユーザーアカウント) ───

  /** 認可URLを組み立てる。ブラウザでここに飛ばして同意 → redirectUri に code が返る */
  function buildAuthUrl(state) {
    const c = cfg();
    if (!c.clientId) throw new Error('googleDrive.clientId が未設定です');
    if (!c.redirectUri) throw new Error('googleDrive.redirectUri が未設定です');
    const p = new URLSearchParams({
      client_id: c.clientId,
      redirect_uri: c.redirectUri,
      response_type: 'code',
      scope: currentScope(),
      access_type: 'offline',       // リフレッシュトークンをもらう
      prompt: 'consent',            // 毎回 refresh_token を確実に発行させる
      include_granted_scopes: 'true',
    });
    if (state) p.set('state', state);
    return `${OAUTH_AUTH_URL}?${p.toString()}`;
  }

  /** 認可コード → リフレッシュトークン。成功したらトークンファイルに保存する */
  async function exchangeCode(code) {
    const c = cfg();
    if (!c.clientId || !c.clientSecret) throw new Error('googleDrive.clientId / clientSecret が未設定です');
    const body = new URLSearchParams({
      code,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: c.redirectUri,
      grant_type: 'authorization_code',
    }).toString();

    const res = await httpRequest(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      body,
      timeoutMs: 30000,
    });
    if (res.status !== 200) throw formatApiError(res.status, res.body);
    const json = JSON.parse(res.body.toString('utf-8'));
    if (!json.refresh_token) {
      throw new Error('リフレッシュトークンが返りませんでした。Google の同意画面で「オフラインアクセス」が許可されているか、既存の連携を取り消してから再試行してください');
    }

    accessToken = json.access_token;
    accessTokenExpiresAt = Date.now() + (json.expires_in || 3600) * 1000 - 60000;

    // 接続したアカウントを控えておく (UI 表示用)
    let account = '';
    try {
      const about = await apiGet('/about', { fields: 'user(displayName,emailAddress)' });
      account = about.user?.emailAddress || '';
    } catch {}

    writeTokenStore({
      authMode: 'oauth',
      refreshToken: json.refresh_token,
      scope: json.scope || currentScope(),
      account,
      obtainedAt: new Date().toISOString(),
    });
    log('-', `[Drive] OAuth 接続完了${account ? ` (${account})` : ''}`);
    return { account, scope: json.scope || currentScope() };
  }

  /** リフレッシュトークン → アクセストークン */
  async function refreshAccessTokenOAuth() {
    const c = cfg();
    const store = readTokenStore();
    if (!store?.refreshToken) throw new Error('GDrive が未接続です (先に「接続」してください)');
    if (!c.clientId || !c.clientSecret) throw new Error('googleDrive.clientId / clientSecret が未設定です');

    const body = new URLSearchParams({
      refresh_token: store.refreshToken,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      grant_type: 'refresh_token',
    }).toString();

    const res = await httpRequest(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      body,
      timeoutMs: 30000,
    });
    if (res.status !== 200) {
      // invalid_grant = 取り消された/失効した → 保存済みトークンを捨てて再接続を促す
      const txt = res.body.toString('utf-8');
      if (txt.includes('invalid_grant')) {
        clearTokenStore();
        throw new Error('Google の認可が失効しています。GDrive を再接続してください');
      }
      throw formatApiError(res.status, res.body);
    }
    const json = JSON.parse(res.body.toString('utf-8'));
    accessToken = json.access_token;
    accessTokenExpiresAt = Date.now() + (json.expires_in || 3600) * 1000 - 60000;
    return accessToken;
  }

  // ─── 認証: サービスアカウント (JWT Bearer) ───

  function loadServiceAccountKey() {
    const c = cfg();
    // インライン JSON / ファイルパスの両対応
    if (c.serviceAccountKey && typeof c.serviceAccountKey === 'object') return c.serviceAccountKey;
    const f = c.serviceAccountKeyFile;
    if (!f) throw new Error('googleDrive.serviceAccountKeyFile が未設定です');
    const abs = path.isAbsolute(f) ? f : path.join(baseDir, f);
    if (!fs.existsSync(abs)) throw new Error(`サービスアカウントキーが見つかりません: ${abs}`);
    const key = JSON.parse(fs.readFileSync(abs, 'utf-8'));
    if (!key.client_email || !key.private_key) throw new Error('サービスアカウントキーの形式が不正です (client_email / private_key がありません)');
    return key;
  }

  async function refreshAccessTokenServiceAccount() {
    const c = cfg();
    const key = loadServiceAccountKey();
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claim = {
      iss: key.client_email,
      scope: currentScope(),
      aud: OAUTH_TOKEN_URL,
      exp: now + 3600,
      iat: now,
    };
    // ドメイン全体の委任 (Google Workspace) を使う場合は sub にユーザーを指定
    if (c.impersonateUser) claim.sub = c.impersonateUser;

    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    const signature = b64url(signer.sign(key.private_key));
    const assertion = `${signingInput}.${signature}`;

    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString();

    const res = await httpRequest(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      body,
      timeoutMs: 30000,
    });
    if (res.status !== 200) throw formatApiError(res.status, res.body);
    const json = JSON.parse(res.body.toString('utf-8'));
    accessToken = json.access_token;
    accessTokenExpiresAt = Date.now() + (json.expires_in || 3600) * 1000 - 60000;
    return accessToken;
  }

  /** 有効なアクセストークンを返す (必要ならリフレッシュ、同時実行は1本に束ねる) */
  async function getAccessToken(force = false) {
    if (!force && accessToken && Date.now() < accessTokenExpiresAt) return accessToken;
    if (refreshInFlight) return refreshInFlight;
    const mode = cfg().authMode === 'serviceAccount' ? 'serviceAccount' : 'oauth';
    refreshInFlight = (mode === 'serviceAccount'
      ? refreshAccessTokenServiceAccount()
      : refreshAccessTokenOAuth()
    ).finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  }

  // ─── API 呼び出しの共通処理 ───

  /**
   * Drive API を叩く。401 は1度だけトークンを取り直して再試行する。
   */
  async function apiRequest(url, { method = 'GET', headers = {}, body = null, maxBytes = 0, raw = false, timeoutMs = 60000 } = {}) {
    let token = await getAccessToken();
    const doCall = async (tok) => httpRequest(url, {
      method,
      headers: { Authorization: `Bearer ${tok}`, ...headers },
      body,
      maxBytes,
      timeoutMs,
    });

    let res = await doCall(token);
    if (res.status === 401) {
      token = await getAccessToken(true);
      res = await doCall(token);
    }
    if (res.status < 200 || res.status >= 300) throw formatApiError(res.status, res.body);
    if (raw) return res;
    const text = res.body.toString('utf-8');
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }

  /** 共有ドライブ対応のクエリパラメータを付けて GET */
  function apiGet(pathname, params = {}, opts = {}) {
    const c = cfg();
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      p.set(k, String(v));
    }
    if (c.sharedDrives !== false) {
      p.set('supportsAllDrives', 'true');
      if (pathname === '/files') p.set('includeItemsFromAllDrives', 'true');
    }
    const qs = p.toString();
    return apiRequest(`${DRIVE_API}${pathname}${qs ? '?' + qs : ''}`, opts);
  }

  // ─── 権限ガード ───

  function assertEnabled() {
    if (!cfg().enabled) throw new Error('GDrive 連携が無効です (config.json の googleDrive.enabled を true にしてください)');
  }

  function assertWritable() {
    const c = cfg();
    if (c.readOnly !== false && !c.allowWrite) {
      throw new Error('GDrive は読み取り専用モードです (config.json の googleDrive.readOnly を false、allowWrite を true にすると書き込めます)');
    }
  }

  function assertDeletable() {
    if (!cfg().allowDelete) {
      throw new Error('GDrive の削除は許可されていません (config.json の googleDrive.allowDelete を true にすると削除できます)');
    }
  }

  // ─── rootFolderId サンドボックス ───

  async function getParents(fileId) {
    const cached = parentCache.get(fileId);
    if (cached && Date.now() - cached.at < PARENT_CACHE_TTL) return cached.parents;
    const meta = await apiGet(`/files/${encodeURIComponent(fileId)}`, { fields: 'id,parents' });
    const parents = meta.parents || [];
    parentCache.set(fileId, { parents, at: Date.now() });
    return parents;
  }

  /**
   * rootFolderId が設定されている場合、fileId がその配下かを確認する。
   * 親を最大 depth 階層まで遡る。未設定なら常に true。
   */
  async function assertWithinRoot(fileId, depth = 10) {
    const root = cfg().rootFolderId;
    if (!root) return true;
    if (!fileId) return true;
    if (fileId === root) return true;

    const seen = new Set();
    let frontier = [fileId];
    for (let i = 0; i < depth && frontier.length > 0; i++) {
      const next = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        let parents = [];
        try { parents = await getParents(id); } catch { continue; }
        if (parents.includes(root)) return true;
        next.push(...parents);
      }
      frontier = next;
    }
    throw new Error(`指定されたファイル/フォルダは許可された範囲 (rootFolderId=${root}) の外にあります`);
  }

  /** 一覧・検索の基準フォルダ。rootFolderId があればそれを既定にする */
  function defaultParent(folderId) {
    if (folderId) return folderId;
    return cfg().rootFolderId || 'root';
  }

  // ─── フォルダ解決 (LLM が「フォルダ名」で指定してくる想定) ───

  /** ID っぽい文字列か (Drive のIDは28文字以上の英数字/-/_ が多い) */
  function looksLikeId(s) {
    return typeof s === 'string' && /^[A-Za-z0-9_-]{15,}$/.test(s) && !s.includes(' ');
  }

  /**
   * "資料/2026年度" のようなパス、あるいはフォルダ名、あるいはIDからフォルダIDを解決する。
   * 見つからなければ null。
   */
  async function resolveFolderId(spec) {
    if (!spec) return defaultParent(null);
    const s = String(spec).trim();
    if (s === '/' || s.toLowerCase() === 'root' || s === 'マイドライブ') return defaultParent(null);
    if (looksLikeId(s)) return s;

    const segments = s.split('/').map(x => x.trim()).filter(Boolean);
    let current = defaultParent(null);
    for (const seg of segments) {
      const q = `'${escapeQueryLiteral(current)}' in parents and name = '${escapeQueryLiteral(seg)}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
      const r = await apiGet('/files', { q, fields: 'files(id,name)', pageSize: 5 });
      const hit = (r.files || [])[0];
      if (!hit) return null;
      current = hit.id;
    }
    return current;
  }

  /** 名前でファイルを1件探す (LLM がファイル名で指定してきた時のフォールバック) */
  async function findFileByName(name, folderId) {
    const parts = [`name = '${escapeQueryLiteral(name)}'`, 'trashed = false'];
    const parent = folderId ? await resolveFolderId(folderId) : (cfg().rootFolderId || null);
    if (parent) parts.push(`'${escapeQueryLiteral(parent)}' in parents`);
    const r = await apiGet('/files', {
      q: parts.join(' and '),
      fields: `files(${FILE_FIELDS})`,
      pageSize: 5,
      orderBy: 'modifiedTime desc',
    });
    return (r.files || [])[0] || null;
  }

  /** ファイル指定 (ID or 名前) を実IDに解決する */
  async function resolveFileId(spec, folderId) {
    if (!spec) throw new Error('ファイルIDまたはファイル名を指定してください');
    const s = String(spec).trim();
    if (looksLikeId(s)) return s;
    const hit = await findFileByName(s, folderId);
    if (!hit) throw new Error(`ファイルが見つかりません: ${s}`);
    return hit.id;
  }

  // ════════════════════════════════════════════════
  // 公開 API
  // ════════════════════════════════════════════════

  /** 接続状態 (UI / ツールの可否判定用)。秘密情報は返さない */
  function status() {
    const c = cfg();
    const store = readTokenStore();
    const mode = c.authMode === 'serviceAccount' ? 'serviceAccount' : 'oauth';
    let connected = false;
    let reason = '';

    if (!c.enabled) {
      reason = 'googleDrive.enabled が false です';
    } else if (mode === 'serviceAccount') {
      const f = c.serviceAccountKeyFile;
      const abs = f ? (path.isAbsolute(f) ? f : path.join(baseDir, f)) : '';
      connected = !!(c.serviceAccountKey || (abs && fs.existsSync(abs)));
      if (!connected) reason = 'サービスアカウントキー (serviceAccountKeyFile) が見つかりません';
    } else {
      if (!c.clientId || !c.clientSecret) {
        reason = 'clientId / clientSecret が未設定です';
      } else if (!store?.refreshToken) {
        reason = '未接続です (「GDrive に接続」から認可してください)';
      } else {
        connected = true;
      }
    }

    return {
      enabled: !!c.enabled,
      connected,
      reason,
      authMode: mode,
      account: store?.account || (mode === 'serviceAccount' ? (c.impersonateUser || '') : ''),
      scope: store?.scope || currentScope(),
      readOnly: !(c.allowWrite && c.readOnly === false),
      allowWrite: !!(c.allowWrite && c.readOnly === false),
      allowDelete: !!c.allowDelete,
      rootFolderId: c.rootFolderId || '',
      hasClientId: !!c.clientId,
      hasClientSecret: !!c.clientSecret,
      redirectUri: c.redirectUri || '',
      connectedAt: store?.obtainedAt || null,
    };
  }

  /** 接続テスト: アカウント情報と空き容量を取る */
  async function about() {
    assertEnabled();
    const r = await apiGet('/about', { fields: 'user(displayName,emailAddress,photoLink),storageQuota(limit,usage,usageInDrive)' });
    return r;
  }

  /**
   * ファイル一覧
   * @param {object} o { folderId, query, pageSize, pageToken, orderBy, includeTrashed, onlyFolders }
   */
  async function listFiles(o = {}) {
    assertEnabled();
    const c = cfg();
    const folderId = await resolveFolderId(o.folderId);
    if (folderId === null) throw new Error(`フォルダが見つかりません: ${o.folderId}`);
    if (o.folderId) await assertWithinRoot(folderId);

    const clauses = [];
    if (!o.searchAll) clauses.push(`'${escapeQueryLiteral(folderId)}' in parents`);
    if (!o.includeTrashed) clauses.push('trashed = false');
    if (o.onlyFolders) clauses.push(`mimeType = '${FOLDER_MIME}'`);
    if (o.query) {
      // 素のキーワードは name/全文検索に展開する (LLM が生の単語を渡してくる前提)
      const kw = escapeQueryLiteral(o.query);
      clauses.push(`(name contains '${kw}' or fullText contains '${kw}')`);
    }
    if (o.mimeType) clauses.push(`mimeType = '${escapeQueryLiteral(o.mimeType)}'`);

    const pageSize = Math.min(Math.max(Number(o.pageSize) || c.defaultPageSize || 30, 1), 200);
    const r = await apiGet('/files', {
      q: clauses.join(' and '),
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      pageSize,
      orderBy: o.orderBy || 'folder,modifiedTime desc',
      pageToken: o.pageToken,
    });
    return {
      folderId,
      files: (r.files || []).map(simplify),
      nextPageToken: r.nextPageToken || null,
    };
  }

  /**
   * 全体検索 (フォルダ横断)。name と本文 (fullText) の両方を見る。
   */
  async function searchFiles(o = {}) {
    assertEnabled();
    const c = cfg();
    const kw = escapeQueryLiteral(o.query || '');
    if (!kw) throw new Error('検索キーワードを指定してください');
    const clauses = [`(name contains '${kw}' or fullText contains '${kw}')`, 'trashed = false'];
    if (o.mimeType) clauses.push(`mimeType = '${escapeQueryLiteral(o.mimeType)}'`);
    // rootFolderId が設定されていれば、その直下に限定 (Drive の q は再帰検索できないため
    // 直下 + 明示フォルダ指定でカバーする)
    const root = c.rootFolderId;
    if (o.folderId) {
      const fid = await resolveFolderId(o.folderId);
      if (fid) clauses.push(`'${escapeQueryLiteral(fid)}' in parents`);
    }

    const pageSize = Math.min(Math.max(Number(o.pageSize) || c.defaultPageSize || 20, 1), 200);
    const r = await apiGet('/files', {
      q: clauses.join(' and '),
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      pageSize,
      orderBy: 'modifiedTime desc',
      pageToken: o.pageToken,
    });

    let files = (r.files || []).map(simplify);
    // サンドボックス指定時は配下のものだけ残す (件数が少ないので直列チェックで十分)
    if (root && !o.folderId) {
      const kept = [];
      for (const f of files) {
        try { await assertWithinRoot(f.id); kept.push(f); } catch {}
      }
      files = kept;
    }
    return { files, nextPageToken: r.nextPageToken || null };
  }

  /** メタデータ取得 */
  async function getFile(fileIdOrName, folderId) {
    assertEnabled();
    const fileId = await resolveFileId(fileIdOrName, folderId);
    await assertWithinRoot(fileId);
    const r = await apiGet(`/files/${encodeURIComponent(fileId)}`, { fields: FILE_FIELDS });
    return simplify(r);
  }

  /**
   * ファイル本体をダウンロードする。
   * Google ネイティブ形式は export で変換する (既定はテキスト系)。
   * @returns {Promise<{buffer:Buffer, mimeType:string, name:string, exported:boolean, meta:object}>}
   */
  async function downloadFile(fileIdOrName, { folderId, preferOffice = false, exportMimeType = null } = {}) {
    assertEnabled();
    const c = cfg();
    const maxBytes = Math.max(1, Number(c.maxDownloadMB) || 20) * 1024 * 1024;

    let fileId = await resolveFileId(fileIdOrName, folderId);
    await assertWithinRoot(fileId);
    let meta = await apiGet(`/files/${encodeURIComponent(fileId)}`, { fields: FILE_FIELDS });

    // ショートカットは実体へ辿る
    if (meta.mimeType === 'application/vnd.google-apps.shortcut' && meta.shortcutDetails?.targetId) {
      fileId = meta.shortcutDetails.targetId;
      meta = await apiGet(`/files/${encodeURIComponent(fileId)}`, { fields: FILE_FIELDS });
    }

    if (meta.mimeType === FOLDER_MIME) {
      throw new Error(`「${meta.name}」はフォルダです。ファイルを指定してください`);
    }

    const nativeMap = preferOffice ? { ...GOOGLE_EXPORT_MAP, ...GOOGLE_EXPORT_OFFICE_MAP } : GOOGLE_EXPORT_MAP;
    const exportSpec = nativeMap[meta.mimeType];

    if (exportSpec || exportMimeType) {
      const mime = exportMimeType || exportSpec.mimeType;
      const res = await apiRequest(
        `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(mime)}`,
        { raw: true, maxBytes }
      );
      const ext = exportSpec?.ext || 'txt';
      const name = /\.[a-z0-9]{1,5}$/i.test(meta.name) ? meta.name : `${meta.name}.${ext}`;
      return { buffer: res.body, mimeType: mime, name, exported: true, meta: simplify(meta) };
    }

    if (meta.mimeType?.startsWith('application/vnd.google-apps.')) {
      throw new Error(`この Google ネイティブ形式はダウンロードできません: ${meta.mimeType}`);
    }

    const sizeNum = Number(meta.size || 0);
    if (sizeNum && sizeNum > maxBytes) {
      throw new Error(`ファイルが大きすぎます (${(sizeNum / 1024 / 1024).toFixed(1)}MB > 上限 ${(maxBytes / 1024 / 1024).toFixed(0)}MB)`);
    }

    const params = new URLSearchParams({ alt: 'media' });
    if (c.sharedDrives !== false) params.set('supportsAllDrives', 'true');
    const res = await apiRequest(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params.toString()}`,
      { raw: true, maxBytes }
    );
    return { buffer: res.body, mimeType: meta.mimeType, name: meta.name, exported: false, meta: simplify(meta) };
  }

  /**
   * テキストとして読む (LLM のツール用)。
   * バイナリは読めないので、その旨をエラーで返す。
   */
  async function readFileAsText(fileIdOrName, { folderId, maxChars } = {}) {
    const c = cfg();
    const limit = Math.max(500, Number(maxChars) || Number(c.maxTextChars) || 20000);
    const dl = await downloadFile(fileIdOrName, { folderId });

    if (!dl.exported && !isTextualMime(dl.mimeType)) {
      // UTF-8 として妥当ならテキスト扱いする (拡張子なしのソースコード等)
      const sample = dl.buffer.slice(0, 4096);
      const hasNull = sample.includes(0);
      if (hasNull) {
        throw new Error(`「${dl.name}」はバイナリファイル (${dl.mimeType}) のためテキストとして読めません。gdrive_import_to_server でサーバーに取り込んでから Python 等で処理してください`);
      }
    }

    let text = dl.buffer.toString('utf-8');
    const truncated = text.length > limit;
    if (truncated) text = text.slice(0, limit);
    return {
      id: dl.meta.id,
      name: dl.name,
      mimeType: dl.mimeType,
      exported: dl.exported,
      truncated,
      totalChars: dl.buffer.toString('utf-8').length,
      content: text,
      webViewLink: dl.meta.webViewLink || null,
    };
  }

  /**
   * ファイルを作成 or 更新 (テキスト or Buffer)。
   * fileId を渡せば更新、なければ name + folderId で新規作成。
   * 同名ファイルがあれば overwrite=true で上書き。
   */
  async function uploadFile({ name, content, buffer, mimeType, folderId, fileId, overwrite = false, convertToGoogleDoc = false }) {
    assertEnabled();
    assertWritable();

    const data = buffer instanceof Buffer ? buffer : Buffer.from(String(content ?? ''), 'utf-8');
    const c = cfg();
    const maxBytes = Math.max(1, Number(c.maxUploadMB) || Number(c.maxDownloadMB) || 20) * 1024 * 1024;
    if (data.length > maxBytes) {
      throw new Error(`アップロードサイズが上限を超えています (${(data.length / 1024 / 1024).toFixed(1)}MB > ${(maxBytes / 1024 / 1024).toFixed(0)}MB)`);
    }

    let targetId = fileId || null;
    let parentId = null;

    if (targetId) {
      targetId = await resolveFileId(targetId);
      await assertWithinRoot(targetId);
    } else {
      if (!name) throw new Error('ファイル名 (name) を指定してください');
      parentId = await resolveFolderId(folderId);
      if (parentId === null) throw new Error(`フォルダが見つかりません: ${folderId}`);
      if (folderId) await assertWithinRoot(parentId);
      if (overwrite) {
        const existing = await findFileByName(name, parentId);
        if (existing) targetId = existing.id;
      }
    }

    const contentType = mimeType || guessMimeFromName(name || 'file.txt');
    const metadata = {};
    if (name) metadata.name = name;
    if (!targetId && parentId && parentId !== 'root') metadata.parents = [parentId];
    if (convertToGoogleDoc) metadata.mimeType = 'application/vnd.google-apps.document';

    // multipart/related で メタデータ + 本体 を一度に送る
    const boundary = '----ogllm' + crypto.randomBytes(12).toString('hex');
    const head = Buffer.from(
      `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) + '\r\n' +
      `--${boundary}\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`, 'utf-8');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
    const body = Buffer.concat([head, data, tail]);

    const params = new URLSearchParams({ uploadType: 'multipart', fields: FILE_FIELDS });
    if (c.sharedDrives !== false) params.set('supportsAllDrives', 'true');

    const url = targetId
      ? `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(targetId)}?${params.toString()}`
      : `${DRIVE_UPLOAD_API}/files?${params.toString()}`;

    const r = await apiRequest(url, {
      method: targetId ? 'PATCH' : 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      body,
      timeoutMs: 180000,
    });
    parentCache.delete(r.id);
    return { ...simplify(r), updated: !!targetId, bytes: data.length };
  }

  /** フォルダ作成 */
  async function createFolder({ name, folderId }) {
    assertEnabled();
    assertWritable();
    if (!name) throw new Error('フォルダ名 (name) を指定してください');
    const parentId = await resolveFolderId(folderId);
    if (parentId === null) throw new Error(`親フォルダが見つかりません: ${folderId}`);
    if (folderId) await assertWithinRoot(parentId);

    const metadata = { name, mimeType: FOLDER_MIME };
    if (parentId && parentId !== 'root') metadata.parents = [parentId];

    const c = cfg();
    const params = new URLSearchParams({ fields: FILE_FIELDS });
    if (c.sharedDrives !== false) params.set('supportsAllDrives', 'true');
    const body = Buffer.from(JSON.stringify(metadata), 'utf-8');
    const r = await apiRequest(`${DRIVE_API}/files?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      body,
    });
    return simplify(r);
  }

  /**
   * 削除。既定はゴミ箱に入れるだけ (permanent=true で完全削除)。
   */
  async function deleteFile(fileIdOrName, { permanent = false, folderId } = {}) {
    assertEnabled();
    assertWritable();
    assertDeletable();
    const fileId = await resolveFileId(fileIdOrName, folderId);
    await assertWithinRoot(fileId);

    const c = cfg();
    const params = new URLSearchParams();
    if (c.sharedDrives !== false) params.set('supportsAllDrives', 'true');

    if (permanent) {
      await apiRequest(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params.toString()}`, { method: 'DELETE' });
      parentCache.delete(fileId);
      return { id: fileId, deleted: true, permanent: true };
    }
    params.set('fields', FILE_FIELDS);
    const body = Buffer.from(JSON.stringify({ trashed: true }), 'utf-8');
    const r = await apiRequest(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params.toString()}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      body,
    });
    parentCache.delete(fileId);
    return { ...simplify(r), deleted: true, permanent: false };
  }

  /** 認可を切る (トークンを失効させてローカルからも消す) */
  async function disconnect() {
    const store = readTokenStore();
    if (store?.refreshToken) {
      try {
        const body = new URLSearchParams({ token: store.refreshToken }).toString();
        await httpRequest(OAUTH_REVOKE_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
          },
          body,
          timeoutMs: 15000,
        });
      } catch (e) {
        log('-', `[Drive] トークン失効リクエスト失敗 (ローカルからは削除します): ${e.message}`);
      }
    }
    clearTokenStore();
    return { ok: true };
  }

  /** API 応答を UI / LLM に渡しやすい形に整える */
  function simplify(f) {
    if (!f) return f;
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      isFolder: f.mimeType === FOLDER_MIME,
      size: f.size ? Number(f.size) : null,
      modifiedTime: f.modifiedTime || null,
      createdTime: f.createdTime || null,
      parents: f.parents || [],
      webViewLink: f.webViewLink || null,
      owner: f.owners?.[0]?.displayName || null,
      trashed: !!f.trashed,
      // LLM 向けヒント: このファイルはテキストとして読めるか
      readableAsText: f.mimeType === FOLDER_MIME ? false
        : (!!GOOGLE_EXPORT_MAP[f.mimeType] || isTextualMime(f.mimeType)),
    };
  }

  return {
    // 認証
    status, buildAuthUrl, exchangeCode, disconnect, about,
    // 参照
    listFiles, searchFiles, getFile, downloadFile, readFileAsText,
    // 書き込み
    uploadFile, createFolder, deleteFile,
    // ユーティリティ (server.js から使う)
    resolveFolderId, resolveFileId, guessMimeFromName, isTextualMime,
    assertEnabled, assertWritable, assertDeletable,
    GOOGLE_EXPORT_MAP, FOLDER_MIME,
  };
}

module.exports = {
  createGoogleDrive,
  escapeQueryLiteral,
  guessMimeFromName,
  isTextualMime,
  SCOPE_READONLY,
  SCOPE_FULL,
  FOLDER_MIME,
};
