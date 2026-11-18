/**
 * git_repo.js — Git 連携モジュール (GitHub / Gitea / GitLab / ローカル git)
 *
 * LLM (チャット / 外部APIのツール対応モード) と画面の「🐙 Git」パネルから、
 * Git リポジトリを「取ってくる・読む・探す・履歴を見る・書く・コミットする・push する」ためのクライアント。
 *
 * 方針:
 * - 依存を増やさない。サーバーに入っている git コマンド (2.31 以上推奨) を child_process.execFile で
 *   呼ぶだけ (シェルを経由しないので引数のインジェクションが起きない)。GitHub / Gitea / GitLab /
 *   Bitbucket / 自前の git サーバー / ローカルの bare リポジトリまで、git が話せる相手ならどれでも使える。
 * - リポジトリは2種類:
 *     url  … リモート (https / ssh / git / file) を workDir 配下に clone して使う (初回アクセス時に自動 clone)
 *     path … サーバー上の既存の作業コピーをそのまま使う (ローカル git)
 * - 認証:
 *     HTTPS … アクセストークン (GitHub の PAT / Gitea のアクセストークン / GitLab の PAT)。
 *             トークンは URL に埋め込まず、そのリポジトリのホストに限定した http.<url>.extraHeader として
 *             環境変数 (GIT_CONFIG_COUNT/KEY/VALUE) 経由で git に渡す。.git/config にもプロセス引数にも残らない
 *     SSH   … sshKeyFile (秘密鍵) を core.sshCommand で指定。BatchMode なのでパスフレーズ付き鍵は不可
 * - 秘密情報 (token) はブラウザにも LLM にも絶対返さない。エラーメッセージからも伏せる。
 *   画面から追加したリポジトリは config.json ではなく reposFile (既定 git_repos.json、chmod 600) に保存する。
 * - 段階的な許可: 既定は読み取り専用。allowWrite (作業コピーへの書き込み・コミット・ブランチ)、
 *   allowPush (リモートへの push) を明示的に true にした時だけ、その操作のツールが生える。
 *   force push は一切しない。protectedBranches に挙げたブランチへの push / コミットは拒否する。
 * - 安全側の git 設定を毎回付ける: フック無効 (core.hooksPath)、fsmonitor 無効、ext:: 等の危険な
 *   プロトコル禁止 (GIT_ALLOW_PROTOCOL)、対話プロンプト禁止 (GIT_TERMINAL_PROMPT=0)、サブモジュール再帰なし。
 * - パスは必ずリポジトリ内に閉じ込める (.. / 絶対パス / .git 配下 / リポジトリ外へのシンボリックリンクを拒否)。
 */

'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── 既定値 ───
const DEFAULTS = {
  enabled: false,
  workDir: 'git_repos',
  reposFile: 'git_repos.json',
  readOnly: true,
  allowWrite: false,
  allowPush: false,
  allowAddRepo: false,
  allowLocalPaths: [],
  allowHttp: false,
  allowFileProtocol: true,
  allowHooks: false,
  signCommits: false,
  protectedBranches: [],
  authorName: 'OpenGeekLLM',
  authorEmail: 'opengeekllm@localhost',
  sshKeyFile: '',
  sshStrictHostKeyChecking: 'accept-new',
  cloneDepth: 0,
  timeoutMs: 120000,
  maxTextChars: 20000,
  maxFileMB: 5,
  maxListEntries: 500,
  maxSearchResults: 100,
  repos: [],
};

const PROVIDERS = ['github', 'gitea', 'gitlab', 'bitbucket', 'local', 'generic'];

// トークン認証のユーザー名 (Basic 認証のユーザー部)。トークンが本体なので多くのサービスは何でも通るが、
// GitHub は x-access-token、GitLab は oauth2、Bitbucket は x-token-auth が正式
const DEFAULT_TOKEN_USER = {
  github: 'x-access-token',
  gitea: 'oauth2',
  gitlab: 'oauth2',
  bitbucket: 'x-token-auth',
  generic: 'git',
  local: 'git',
};

// リポジトリ名: 画面表示・ツール引数・clone 先ディレクトリ名を兼ねるので安全な文字だけ
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// ブランチ名・タグ名・コミットID・HEAD~1 等の ref。オプション誤認を防ぐため先頭の - は不可
const REF_RE = /^(?!-)[A-Za-z0-9._\/@{}~^+-]{1,200}$/;

/** 文字列の切り詰め (LLM に渡すテキストの上限) */
function truncate(text, max) {
  const s = String(text == null ? '' : text);
  if (!max || s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max), truncated: true };
}

/** URL の認証情報 (https://user:pass@host) を伏せる */
function redactUrl(url) {
  return String(url || '').replace(/^([a-z][a-z0-9+.-]*:\/\/)([^@\/]+)@/i, '$1***@');
}

/** バイナリっぽいか (先頭 8KB に NUL を含む) */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** URL のスキーム (https / http / ssh / git / file)。scp 形式 (git@host:owner/repo) は ssh、ローカルパスは file */
function urlScheme(url) {
  const s = String(url || '').trim();
  const m = s.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (m) return m[1].toLowerCase();
  if (/^[^\/\s]+@[^\/\s:]+:/.test(s)) return 'ssh';
  if (s.startsWith('/') || /^[A-Za-z]:[\\\/]/.test(s) || s.startsWith('./') || s.startsWith('../')) return 'file';
  return '';
}

/** トークンを効かせる範囲 (scheme://host[:port]/)。https/http の URL のときだけ */
function httpOriginPrefix(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.protocol}//${u.host}/`;
  } catch { return null; }
}

/** プロバイダの推定 (表示とトークンのユーザー名の既定値に使う) */
function guessProvider(url, explicit) {
  if (explicit && PROVIDERS.includes(explicit)) return explicit;
  const s = String(url || '').toLowerCase();
  if (!s) return 'local';
  if (s.includes('github.com')) return 'github';
  if (s.includes('gitlab')) return 'gitlab';
  if (s.includes('bitbucket.org')) return 'bitbucket';
  if (s.includes('gitea') || s.includes('codeberg.org') || s.includes('forgejo')) return 'gitea';
  if (urlScheme(s) === 'file') return 'local';
  return 'generic';
}

/** 簡易ミューテックス: 同じリポジトリへの操作を直列化する (index.lock の衝突防止) */
function createLocks() {
  const chains = new Map();
  return function withLock(key, fn) {
    const prev = chains.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    chains.set(key, tail);
    tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
    return run;
  };
}

/**
 * Git 連携クライアントを作る
 * @param {object} opts
 * @param {() => object} opts.getConfig  appConfig.git を返す関数 (毎回読む)
 * @param {string} opts.baseDir          相対パスの基準 (server.js のディレクトリ)
 * @param {(ip:string, msg:string)=>void} [opts.log]
 */
function createGitRepos({ getConfig, baseDir, log = () => {} }) {
  const withLock = createLocks();
  let gitVersionCache = null;   // { ok, version, error }

  const cfg = () => ({ ...DEFAULTS, ...(getConfig() || {}) });
  const resolveBase = (p) => (path.isAbsolute(p) ? p : path.join(baseDir, p));
  const workDir = () => resolveBase(cfg().workDir || DEFAULTS.workDir);
  const reposFilePath = () => resolveBase(cfg().reposFile || DEFAULTS.reposFile);

  // ─── 許可フラグ ───
  // 全体設定 (readOnly:false かつ allowWrite:true) と、リポジトリ個別の readOnly / allowPush:false の両方を見る。
  // 個別設定は「さらに絞る」方向にしか効かない (個別で true にしても全体が false なら不可)
  const globalWrite = () => { const c = cfg(); return !!(c.allowWrite && c.readOnly === false); };
  const globalPush = () => { const c = cfg(); return !!(globalWrite() && c.allowPush); };
  const repoCanWrite = (r) => globalWrite() && r.readOnly !== true && r.allowWrite !== false;
  const repoCanPush = (r) => globalPush() && repoCanWrite(r) && r.allowPush !== false && !!r.url;

  // ─── リポジトリ定義の読み込み ───
  function loadUserRepos() {
    try {
      const f = reposFilePath();
      if (!fs.existsSync(f)) return [];
      const data = JSON.parse(fs.readFileSync(f, 'utf-8'));
      return Array.isArray(data?.repos) ? data.repos : [];
    } catch (e) {
      log('-', `[Git] ${path.basename(reposFilePath())} の読み込みに失敗: ${e.message}`);
      return [];
    }
  }
  function saveUserRepos(repos) {
    const f = reposFilePath();
    fs.writeFileSync(f, JSON.stringify({ repos }, null, 2), { encoding: 'utf-8', mode: 0o600 });
    try { fs.chmodSync(f, 0o600); } catch {}
  }

  /** 正規化したリポジトリ定義の一覧 (config.json の repos + 画面から追加した repos) */
  function allRepos() {
    const out = [];
    const seen = new Set();
    const add = (raw, source) => {
      if (!raw || typeof raw !== 'object') return;
      const name = String(raw.name || '').trim();
      if (!REPO_NAME_RE.test(name) || seen.has(name.toLowerCase())) return;
      const url = String(raw.url || '').trim();
      const localPath = String(raw.path || '').trim();
      if (!url && !localPath) return;
      seen.add(name.toLowerCase());
      const provider = guessProvider(url || localPath, raw.provider);
      out.push({
        name,
        source,                       // 'config' | 'user'
        provider,
        url,
        path: localPath,
        kind: localPath ? 'path' : 'url',
        branch: String(raw.branch || '').trim(),
        description: String(raw.description || '').trim(),
        username: String(raw.username || '').trim(),
        token: String(raw.token || ''),
        tokenEnv: String(raw.tokenEnv || '').trim(),
        sshKeyFile: String(raw.sshKeyFile || '').trim(),
        readOnly: raw.readOnly === true,
        allowWrite: raw.allowWrite,
        allowPush: raw.allowPush,
        authorName: raw.authorName,
        authorEmail: raw.authorEmail,
      });
    };
    (Array.isArray(cfg().repos) ? cfg().repos : []).forEach(r => add(r, 'config'));
    loadUserRepos().forEach(r => add(r, 'user'));
    return out;
  }

  /** リポジトリ名 (大文字小文字ゆれ・番号指定も許す) から定義を引く */
  function findRepo(nameOrIndex) {
    const repos = allRepos();
    if (nameOrIndex === undefined || nameOrIndex === null || nameOrIndex === '') {
      if (repos.length === 1) return repos[0];
      throw new Error(`repo を指定してください (候補: ${repos.map(r => r.name).join(', ') || 'なし'})`);
    }
    const key = String(nameOrIndex).trim();
    let r = repos.find(x => x.name === key) || repos.find(x => x.name.toLowerCase() === key.toLowerCase());
    if (!r && /^\d+$/.test(key)) r = repos[parseInt(key, 10) - 1];
    // owner/repo や URL で指定された場合も拾う
    if (!r) r = repos.find(x => x.url && (x.url.replace(/\.git$/, '').toLowerCase().endsWith('/' + key.replace(/\.git$/, '').toLowerCase())));
    if (!r) throw new Error(`リポジトリ「${key}」は登録されていません (候補: ${repos.map(x => x.name).join(', ') || 'なし'})`);
    return r;
  }

  /** 作業コピーの絶対パス */
  function repoDir(r) {
    if (r.kind === 'path') return path.resolve(resolveBase(r.path));
    return path.join(workDir(), r.name);
  }

  function tokenOf(r) {
    if (r.token) return r.token;
    if (r.tokenEnv && process.env[r.tokenEnv]) return process.env[r.tokenEnv];
    return '';
  }

  /** エラーメッセージ等からトークン・URL の認証情報を伏せる */
  function scrub(text, r) {
    let s = String(text == null ? '' : text);
    const t = r ? tokenOf(r) : '';
    if (t && t.length >= 4) {
      s = s.split(t).join('***');
      const b64 = Buffer.from(`${r.username || DEFAULT_TOKEN_USER[r.provider] || 'git'}:${t}`).toString('base64');
      s = s.split(b64).join('***');
    }
    return s.replace(/([a-z][a-z0-9+.-]*:\/\/)([^@\s\/]+)@/gi, '$1***@');
  }

  // ─── git 実行 ───
  function buildEnv(r) {
    const c = cfg();
    const env = { ...process.env };
    // 対話的な入力を一切させない (サーバーの中で止まらないように)
    delete env.GIT_ASKPASS;
    delete env.SSH_ASKPASS;
    env.GIT_TERMINAL_PROMPT = '0';
    env.GCM_INTERACTIVE = 'never';
    env.LANG = 'C.UTF-8';
    env.LC_ALL = 'C.UTF-8';
    // 使ってよいプロトコルのホワイトリスト (ext:: 等の任意コマンド実行を塞ぐ)
    const protos = ['https', 'ssh', 'git'];
    if (c.allowHttp) protos.push('http');
    if (c.allowFileProtocol !== false) protos.push('file');
    env.GIT_ALLOW_PROTOCOL = protos.join(':');

    const extra = [];
    if (r) {
      const token = tokenOf(r);
      const prefix = r.url ? httpOriginPrefix(r.url) : null;
      if (token && prefix) {
        const user = r.username || DEFAULT_TOKEN_USER[r.provider] || 'git';
        const basic = Buffer.from(`${user}:${token}`).toString('base64');
        // そのホスト宛ての通信にだけ付ける (別ホストへのリダイレクトやサブモジュールには漏れない)
        extra.push([`http.${prefix}.extraHeader`, `Authorization: Basic ${basic}`]);
      }
      const key = r.sshKeyFile || c.sshKeyFile;
      if (key && ['ssh'].includes(urlScheme(r.url))) {
        const keyAbs = resolveBase(key);
        if (/['"\\\s]/.test(keyAbs)) throw new Error('sshKeyFile のパスに空白や引用符は使えません');
        const strict = ['yes', 'no', 'accept-new'].includes(c.sshStrictHostKeyChecking) ? c.sshStrictHostKeyChecking : 'accept-new';
        extra.push(['core.sshCommand', `ssh -i ${keyAbs} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=${strict}`]);
      } else if (['ssh'].includes(urlScheme(r.url))) {
        const strict = ['yes', 'no', 'accept-new'].includes(c.sshStrictHostKeyChecking) ? c.sshStrictHostKeyChecking : 'accept-new';
        extra.push(['core.sshCommand', `ssh -o BatchMode=yes -o StrictHostKeyChecking=${strict}`]);
      }
    }
    // 環境変数経由の config (git 2.31+)。プロセス引数 (ps で見える) に秘密を載せないため
    const base = parseInt(env.GIT_CONFIG_COUNT || '0', 10) || 0;
    extra.forEach(([k, v], i) => {
      env[`GIT_CONFIG_KEY_${base + i}`] = k;
      env[`GIT_CONFIG_VALUE_${base + i}`] = v;
    });
    if (extra.length) env.GIT_CONFIG_COUNT = String(base + extra.length);
    return env;
  }

  /** 毎回付ける安全側の -c 設定 */
  function safetyArgs() {
    const c = cfg();
    const a = ['-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', '-c', 'protocol.ext.allow=never',
      '-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'core.pager=cat', '-c', 'credential.helper='];
    if (!c.allowHooks) a.push('-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`);
    return a;
  }

  /**
   * git を実行する
   * @returns {Promise<{stdout: string|Buffer, stderr: string}>}
   */
  function runGit(args, { cwd, r, input, encoding = 'utf8', timeoutMs, allowFail = false } = {}) {
    const c = cfg();
    return new Promise((resolve, reject) => {
      let env;
      try { env = buildEnv(r); } catch (e) { return reject(e); }
      const child = execFile('git', [...safetyArgs(), ...args], {
        cwd: cwd || baseDir,
        env,
        encoding: encoding === 'buffer' ? 'buffer' : 'utf8',
        timeout: timeoutMs || c.timeoutMs || DEFAULTS.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      }, (err, stdout, stderr) => {
        const errText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || '');
        if (err && !allowFail) {
          if (err.code === 'ENOENT') return reject(new Error('git コマンドが見つかりません (サーバーに git をインストールしてください)'));
          if (err.killed) return reject(new Error(`git ${args[0]} がタイムアウトしました (${Math.round((timeoutMs || c.timeoutMs) / 1000)}秒)`));
          const msg = scrub((errText || err.message || '').trim().split('\n').filter(Boolean).slice(-6).join('\n'), r);
          const e = new Error(msg || `git ${args[0]} に失敗しました (code ${err.code})`);
          e.gitCode = err.code;
          return reject(e);
        }
        resolve({ stdout, stderr: errText, code: err ? err.code : 0 });
      });
      if (input !== undefined) { child.stdin.end(input); }
    });
  }

  async function gitVersion() {
    if (gitVersionCache) return gitVersionCache;
    try {
      const { stdout } = await runGit(['--version'], { timeoutMs: 10000 });
      const m = String(stdout).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
      const ver = m ? [parseInt(m[1]), parseInt(m[2]), parseInt(m[3] || '0')] : null;
      gitVersionCache = {
        ok: true,
        version: String(stdout).trim(),
        // 2.31 未満は GIT_CONFIG_COUNT を解釈しない (= トークン認証が効かない)
        envConfig: !!ver && (ver[0] > 2 || (ver[0] === 2 && ver[1] >= 31)),
      };
    } catch (e) {
      gitVersionCache = { ok: false, error: e.message };
    }
    return gitVersionCache;
  }

  // ─── 状態 ───
  function isCloned(r) {
    const d = repoDir(r);
    return fs.existsSync(path.join(d, '.git'));
  }

  /** ブラウザ / LLM に見せてよいリポジトリ情報 (token は出さない) */
  function publicRepo(r) {
    return {
      name: r.name,
      provider: r.provider,
      kind: r.kind,
      url: r.url ? redactUrl(r.url) : '',
      path: r.kind === 'path' ? r.path : '',
      branch: r.branch || '',
      description: r.description || '',
      source: r.source,
      hasToken: !!tokenOf(r),
      cloned: isCloned(r),
      canWrite: repoCanWrite(r),
      canPush: repoCanPush(r),
    };
  }

  function status() {
    const c = cfg();
    const v = gitVersionCache;
    const repos = c.enabled ? allRepos().map(publicRepo) : [];
    let reason = '';
    if (!c.enabled) reason = 'config.json の git.enabled が false です';
    else if (v && !v.ok) reason = v.error;
    else if (repos.length === 0) reason = 'リポジトリが登録されていません (config.json の git.repos、または画面の「＋ リポジトリを追加」)';
    return {
      enabled: !!c.enabled,
      available: !!c.enabled && (!v || v.ok) && repos.length > 0,
      gitVersion: v?.version || '',
      reason,
      readOnly: !globalWrite(),
      allowWrite: globalWrite(),
      allowPush: globalPush(),
      allowAddRepo: !!c.allowAddRepo,
      protectedBranches: Array.isArray(c.protectedBranches) ? c.protectedBranches : [],
      repos,
    };
  }

  // ─── パスの安全確認 ───
  function normalizeRelPath(p) {
    let s = String(p == null ? '' : p).replace(/\\/g, '/').trim();
    s = s.replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (s === '.' ) s = '';
    if (s.split('/').some(seg => seg === '..')) throw new Error('パスに .. は使えません');
    if (s.split('/').some(seg => seg.toLowerCase() === '.git')) throw new Error('.git 配下にはアクセスできません');
    if (s.includes('\0')) throw new Error('パスが不正です');
    return s;
  }

  /** 作業コピー内の絶対パス (シンボリックリンクでリポジトリ外に出ないことも確認) */
  function safeWorkPath(r, rel, { mustExist = false } = {}) {
    const root = fs.realpathSync(repoDir(r));
    const relN = normalizeRelPath(rel);
    const abs = path.resolve(root, relN);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('リポジトリ外のパスです');
    // 既存の最も深い祖先の実体パスがリポジトリ内か (symlink 経由の脱出を防ぐ)
    let probe = abs;
    while (!fs.existsSync(probe) && probe !== root) probe = path.dirname(probe);
    const real = fs.realpathSync(probe);
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error('リポジトリ外を指すシンボリックリンクです');
    if (mustExist && !fs.existsSync(abs)) throw new Error(`ファイルが見つかりません: ${relN}`);
    return { abs, rel: relN, root };
  }

  function checkRef(ref, label = 'ref') {
    if (ref === undefined || ref === null || ref === '') return '';
    const s = String(ref).trim();
    if (!REF_RE.test(s) || s.includes('..')) throw new Error(`${label} の形式が不正です: ${s}`);
    return s;
  }

  function checkBranchName(name) {
    const s = String(name || '').trim();
    if (!s) throw new Error('ブランチ名を指定してください');
    if (!/^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._\/-]{1,200}$/.test(s) || s.endsWith('/') || s.endsWith('.lock') || s.endsWith('.')) {
      throw new Error(`ブランチ名が不正です: ${s}`);
    }
    return s;
  }

  function isProtected(branch) {
    const list = cfg().protectedBranches;
    if (!Array.isArray(list) || !branch) return false;
    return list.some(p => {
      if (p === branch) return true;
      if (typeof p === 'string' && p.includes('*')) {
        const re = new RegExp('^' + p.split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
        return re.test(branch);
      }
      return false;
    });
  }

  // ─── clone / 同期 ───
  async function ensureCloned(r, ip = '-') {
    if (isCloned(r)) return { cloned: false };
    if (r.kind === 'path') {
      const d = repoDir(r);
      if (!fs.existsSync(d)) throw new Error(`ローカルリポジトリのパスが存在しません: ${r.path}`);
      throw new Error(`git リポジトリではありません: ${r.path} (git init 済みの作業コピーを指定してください)`);
    }
    const scheme = urlScheme(r.url);
    const c = cfg();
    const allowed = ['https', 'ssh', 'git'];
    if (c.allowHttp) allowed.push('http');
    if (c.allowFileProtocol !== false) allowed.push('file');
    if (!allowed.includes(scheme)) throw new Error(`この URL のプロトコル (${scheme || '不明'}) は許可されていません`);
    fs.mkdirSync(workDir(), { recursive: true });
    const dest = repoDir(r);
    // 前回の clone が中断した残骸があれば消す (workDir 配下に限る)
    if (fs.existsSync(dest)) {
      if (!dest.startsWith(workDir() + path.sep)) throw new Error('clone 先が workDir 外です');
      fs.rmSync(dest, { recursive: true, force: true });
    }
    const args = ['clone', '--origin', 'origin', '--no-recurse-submodules'];
    const depth = parseInt(c.cloneDepth, 10);
    if (depth > 0) args.push('--depth', String(depth), '--no-single-branch');
    if (r.branch) args.push('--branch', checkBranchName(r.branch));
    args.push('--', r.url, dest);
    log(ip, `[Git] clone: ${r.name} ← ${redactUrl(r.url)}`);
    try {
      await runGit(args, { r, timeoutMs: Math.max(c.timeoutMs || 0, 600000) });
    } catch (e) {
      try { if (dest.startsWith(workDir() + path.sep)) fs.rmSync(dest, { recursive: true, force: true }); } catch {}
      throw new Error(`clone に失敗しました: ${e.message.split('\n').filter(l => !/^Cloning into /.test(l)).join('\n')}`);
    }
    return { cloned: true };
  }

  async function currentBranch(r) {
    // symbolic-ref はコミット0件の新規リポジトリでも現在のブランチ名を返せる (detached なら空)
    const { stdout } = await runGit(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: repoDir(r), r, allowFail: true });
    return String(stdout || '').trim();
  }

  async function hasRemote(r) {
    const { stdout } = await runGit(['remote'], { cwd: repoDir(r), r, allowFail: true });
    return String(stdout || '').split('\n').map(s => s.trim()).includes('origin');
  }

  /** リモートから取得して fast-forward で追従する (clone していなければ clone) */
  async function pull(name, { ip = '-' } = {}) {
    const r = findRepo(name);
    return withLock(r.name, async () => {
      const cl = await ensureCloned(r, ip);
      if (cl.cloned) {
        const st = await repoStatusInner(r);
        return { repo: r.name, action: 'clone', message: `clone しました (ブランチ ${st.branch || '不明'})`, ...st };
      }
      const cwd = repoDir(r);
      if (!(await hasRemote(r))) {
        return { repo: r.name, action: 'none', message: 'リモート (origin) が無いローカルリポジトリなので、取得するものはありません' };
      }
      await runGit(['fetch', '--prune', '--no-recurse-submodules', 'origin'], { cwd, r });
      const branch = await currentBranch(r);
      const up = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd, r, allowFail: true });
      const upstream = String(up.stdout || '').trim();
      if (!branch || up.code || !upstream) {
        log(ip, `[Git] fetch: ${r.name} (追跡ブランチなし)`);
        return { repo: r.name, action: 'fetch', message: 'fetch しました (現在のブランチに追跡ブランチが無いため、作業コピーは更新していません)', branch };
      }
      const before = String((await runGit(['rev-parse', 'HEAD'], { cwd, r })).stdout).trim();
      try {
        await runGit(['merge', '--ff-only', '--no-edit', upstream], { cwd, r });
      } catch (e) {
        const ab = await aheadBehind(r);
        throw new Error(`fast-forward できません (ローカル ${ab.ahead} 件先行 / リモート ${ab.behind} 件遅れ、または未コミットの変更と衝突)。手元の変更をコミットまたは破棄してから、必要なら手動でマージしてください: ${e.message}`);
      }
      const after = String((await runGit(['rev-parse', 'HEAD'], { cwd, r })).stdout).trim();
      log(ip, `[Git] pull: ${r.name} ${before.slice(0, 8)} → ${after.slice(0, 8)}`);
      let changed = [];
      if (before !== after) {
        const { stdout } = await runGit(['diff', '--name-status', before, after], { cwd, r });
        changed = String(stdout).trim().split('\n').filter(Boolean).slice(0, 200);
      }
      return {
        repo: r.name, action: 'pull', branch, upstream,
        updated: before !== after, from: before.slice(0, 12), to: after.slice(0, 12), changed,
        message: before === after ? '最新です (変更なし)' : `${changed.length} ファイルが更新されました`,
      };
    });
  }

  async function aheadBehind(r) {
    const { stdout, code } = await runGit(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], { cwd: repoDir(r), r, allowFail: true });
    if (code) return { ahead: 0, behind: 0, upstream: false };
    const [a, b] = String(stdout).trim().split(/\s+/).map(n => parseInt(n, 10) || 0);
    return { ahead: a, behind: b, upstream: true };
  }

  async function repoStatusInner(r) {
    const cwd = repoDir(r);
    const branch = await currentBranch(r);
    const head = await runGit(['log', '-1', '--format=%H%x1f%an%x1f%aI%x1f%s'], { cwd, r, allowFail: true });
    const [hash, author, date, subject] = String(head.stdout || '').trim().split('\x1f');
    const ab = await aheadBehind(r);
    const st = await runGit(['status', '--porcelain=v1', '--untracked-files=all'], { cwd, r });
    const changes = String(st.stdout).split('\n').filter(Boolean).map(line => ({
      status: line.slice(0, 2).trim() || '?', path: line.slice(3),
    }));
    return {
      branch,
      head: hash ? { hash: hash.slice(0, 12), author, date, subject } : null,
      ahead: ab.ahead, behind: ab.behind, hasUpstream: ab.upstream,
      clean: changes.length === 0,
      changes: changes.slice(0, 200),
      changeCount: changes.length,
    };
  }

  async function repoStatus(name, { ip } = {}) {
    const r = findRepo(name);
    await withLock(r.name, () => ensureCloned(r, ip));
    return { repo: r.name, ...publicRepo(r), ...(await repoStatusInner(r)) };
  }

  // ─── 参照系 ───
  /** ファイル一覧。ref なし = 作業コピー (未コミット含む・.gitignore 尊重)、ref あり = そのコミットのツリー */
  async function listFiles(name, { path: dir = '', ref = '', recursive = true, ip } = {}) {
    const r = findRepo(name);
    await withLock(r.name, () => ensureCloned(r, ip));
    const cwd = repoDir(r);
    const rel = normalizeRelPath(dir);
    const refS = checkRef(ref);
    const max = parseInt(cfg().maxListEntries, 10) || DEFAULTS.maxListEntries;
    let entries = [];
    if (refS) {
      const args = ['ls-tree', '-l', '--full-tree'];
      if (recursive) args.push('-r');
      args.push(refS, '--');
      if (rel) args.push(recursive ? rel : rel + '/');
      const { stdout } = await runGit(args, { cwd, r });
      entries = String(stdout).split('\n').filter(Boolean).map(line => {
        const m = line.match(/^\d+\s+(\w+)\s+[0-9a-f]+\s+(\S+)\t(.*)$/);
        if (!m) return null;
        return { path: m[3], type: m[1] === 'tree' ? 'dir' : 'file', size: m[2] === '-' ? null : parseInt(m[2], 10) };
      }).filter(Boolean);
    } else {
      const args = ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--'];
      if (rel) args.push(rel);
      const { stdout } = await runGit(args, { cwd, r });
      const files = [...new Set(String(stdout).split('\0').filter(Boolean))].sort();
      if (recursive) {
        entries = files.map(f => {
          let size = null;
          try { size = fs.statSync(path.join(cwd, f)).size; } catch {}
          return { path: f, type: 'file', size };
        });
      } else {
        // 直下だけ: ファイルとサブディレクトリにまとめる
        const base = rel ? rel + '/' : '';
        const dirs = new Set();
        for (const f of files) {
          if (!f.startsWith(base)) continue;
          const rest = f.slice(base.length);
          const i = rest.indexOf('/');
          if (i >= 0) dirs.add(base + rest.slice(0, i));
          else {
            let size = null;
            try { size = fs.statSync(path.join(cwd, f)).size; } catch {}
            entries.push({ path: f, type: 'file', size });
          }
        }
        entries = [...[...dirs].sort().map(d => ({ path: d, type: 'dir', size: null })), ...entries];
      }
    }
    const total = entries.length;
    return { repo: r.name, ref: refS || '(作業コピー)', path: rel, total, truncated: total > max, entries: entries.slice(0, max) };
  }

  /** ファイルを読む。ref なし = 作業コピー、ref あり = そのコミット時点の内容 (git show) */
  async function readFile(name, filePath, { ref = '', maxChars, ip, asBuffer = false } = {}) {
    const r = findRepo(name);
    await withLock(r.name, () => ensureCloned(r, ip));
    const c = cfg();
    const maxBytes = (parseFloat(c.maxFileMB) || DEFAULTS.maxFileMB) * 1024 * 1024;
    const rel = normalizeRelPath(filePath);
    if (!rel) throw new Error('path を指定してください');
    const refS = checkRef(ref);
    let buf;
    if (refS) {
      const sizeRes = await runGit(['cat-file', '-s', `${refS}:${rel}`], { cwd: repoDir(r), r, allowFail: true });
      if (sizeRes.code) throw new Error(`${refS} に ${rel} はありません`);
      const size = parseInt(String(sizeRes.stdout).trim(), 10) || 0;
      if (size > maxBytes) throw new Error(`ファイルが大きすぎます (${size} bytes > ${maxBytes})`);
      buf = (await runGit(['show', `${refS}:${rel}`], { cwd: repoDir(r), r, encoding: 'buffer' })).stdout;
    } else {
      const { abs } = safeWorkPath(r, rel, { mustExist: true });
      const st = fs.statSync(abs);
      if (st.isDirectory()) throw new Error(`${rel} はディレクトリです (git_list_files で中身を一覧してください)`);
      if (st.size > maxBytes) throw new Error(`ファイルが大きすぎます (${st.size} bytes > ${maxBytes})`);
      buf = fs.readFileSync(abs);
    }
    if (asBuffer) return { repo: r.name, path: rel, ref: refS, buffer: buf };
    if (looksBinary(buf)) {
      return { repo: r.name, path: rel, ref: refS || '(作業コピー)', binary: true, size: buf.length, content: '' };
    }
    const lim = parseInt(maxChars, 10) || parseInt(c.maxTextChars, 10) || DEFAULTS.maxTextChars;
    const t = truncate(buf.toString('utf8'), Math.min(lim, parseInt(c.maxTextChars, 10) || lim));
    return { repo: r.name, path: rel, ref: refS || '(作業コピー)', binary: false, size: buf.length, content: t.text, truncated: t.truncated };
  }

  /** 全文検索 (git grep)。固定文字列・大文字小文字無視 */
  async function search(name, query, { path: dir = '', ref = '', regex = false, ip } = {}) {
    const r = findRepo(name);
    await withLock(r.name, () => ensureCloned(r, ip));
    const q = String(query || '');
    if (!q.trim()) throw new Error('query を指定してください');
    if (q.length > 500) throw new Error('query が長すぎます');
    const rel = normalizeRelPath(dir);
    const refS = checkRef(ref);
    const max = parseInt(cfg().maxSearchResults, 10) || DEFAULTS.maxSearchResults;
    const args = ['grep', '-n', '-I', '-i', '--no-color', '--full-name'];
    if (!refS) args.push('--untracked', '--exclude-standard');
    args.push(regex ? '-E' : '-F', '-e', q);
    if (refS) args.push(refS);
    args.push('--');
    if (rel) args.push(rel);
    const { stdout, code } = await runGit(args, { cwd: repoDir(r), r, allowFail: true });
    if (code && code !== 1) throw new Error('検索に失敗しました (正規表現の誤りの可能性)');
    const lines = String(stdout || '').split('\n').filter(Boolean);
    const hits = lines.slice(0, max).map(line => {
      let s = line;
      if (refS && s.startsWith(refS + ':')) s = s.slice(refS.length + 1);
      const m = s.match(/^(.*?):(\d+):(.*)$/);
      if (!m) return { path: s, line: null, text: '' };
      return { path: m[1], line: parseInt(m[2], 10), text: m[3].slice(0, 300) };
    });
    // ファイル名にも当たるものを足す (中身に無くても名前で探したいことが多い)
    let nameHits = [];
    try {
      const lf = await listFiles(r.name, { path: rel, ref: refS, recursive: true });
      const ql = q.toLowerCase();
      nameHits = lf.entries.filter(e => e.type === 'file' && e.path.toLowerCase().includes(ql)).slice(0, 30).map(e => e.path);
    } catch {}
    return { repo: r.name, query: q, ref: refS || '(作業コピー)', total: lines.length, truncated: lines.length > max, hits, fileNameHits: nameHits };
  }

  /** コミット履歴 */
  async function logCommits(name, { ref = '', path: p = '', limit = 20, ip } = {}) {
    const r = findRepo(name);
    await withLock(r.name, () => ensureCloned(r, ip));
    const refS = checkRef(ref);
    const rel = normalizeRelPath(p);
    const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
    const args = ['log', `-n${n}`, '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e'];
    if (refS) args.push(refS);
    args.push('--');
    if (rel) args.push(rel);
    const { stdout, code, stderr } = await runGit(args, { cwd: repoDir(r), r, allowFail: true });
    if (code) {
      if (/does not have any commits/.test(stderr)) return { repo: r.name, commits: [] };
      throw new Error(scrub(stderr.trim(), r) || 'git log に失敗しました');
    }
    const commits = String(stdout).split('\x1e').map(s => s.trim()).filter(Boolean).map(rec => {
      const [hash, short, author, email, date, subject] = rec.split('\x1f');
      return { hash, short, author, email, date, subject };
    });
    return { repo: r.name, ref: refS || 'HEAD', path: rel, commits };
  }

  /** 1コミットの内容 (メッセージ・変更ファイル・差分) */
  async function showCommit(name, commit, { maxChars, ip } = {}) {
    const r = findRepo(name);
    await withLock(r.name, () => ensureCloned(r, ip));
    const refS = checkRef(commit || 'HEAD', 'commit');
    const { stdout } = await runGit(['show', '--stat', '--patch', '--format=commit %H%nAuthor: %an <%ae>%nDate:   %aI%n%n%B', refS, '--'], { cwd: repoDir(r), r });
    const lim = parseInt(maxChars, 10) || parseInt(cfg().maxTextChars, 10) || DEFAULTS.maxTextChars;
    const t = truncate(stdout, lim);
    return { repo: r.name, commit: refS, content: t.text, truncated: t.truncated };
  }

  /** 差分。from/to 省略 = 作業コピーの未コミット変更 (staged 含む HEAD との差分) */
  async function diff(name, { from = '', to = '', path: p = '', maxChars, ip } = {}) {
    const r = findRepo(name);
    await withLock(r.name, () => ensureCloned(r, ip));
    const fromS = checkRef(from, 'from');
    const toS = checkRef(to, 'to');
    const rel = normalizeRelPath(p);
    const args = ['diff', '--stat', '--patch', '--no-ext-diff', '--no-textconv'];
    if (fromS && toS) args.push(fromS, toS);
    else if (fromS) args.push(fromS);
    else {
      // HEAD が無い (コミット0件) リポジトリでは HEAD 指定が失敗するので素の diff
      const h = await runGit(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: repoDir(r), r, allowFail: true });
      if (!h.code) args.push('HEAD');
    }
    args.push('--');
    if (rel) args.push(rel);
    const { stdout } = await runGit(args, { cwd: repoDir(r), r });
    const lim = parseInt(maxChars, 10) || parseInt(cfg().maxTextChars, 10) || DEFAULTS.maxTextChars;
    const t = truncate(stdout, lim);
    // 未追跡ファイルは git diff に出ないので一覧を添える
    let untracked = [];
    if (!fromS && !toS) {
      const u = await runGit(['ls-files', '--others', '--exclude-standard', '--', ...(rel ? [rel] : [])], { cwd: repoDir(r), r, allowFail: true });
      untracked = String(u.stdout || '').split('\n').filter(Boolean).slice(0, 100);
    }
    return { repo: r.name, from: fromS || (toS ? '' : 'HEAD'), to: toS || '(作業コピー)', content: t.text, truncated: t.truncated, untracked };
  }

  /** ブランチ・タグ一覧 */
  async function branches(name, { ip } = {}) {
    const r = findRepo(name);
    await withLock(r.name, () => ensureCloned(r, ip));
    const cwd = repoDir(r);
    const cur = await currentBranch(r);
    const { stdout } = await runGit(['for-each-ref', '--format=%(refname)%1f%(objectname:short)%1f%(committerdate:iso8601)%1f%(subject)', 'refs/heads', 'refs/remotes', 'refs/tags'], { cwd, r });
    const local = [], remote = [], tags = [];
    for (const line of String(stdout).split('\n').filter(Boolean)) {
      const [ref, hash, date, subject] = line.split('\x1f');
      if (ref.endsWith('/HEAD')) continue;
      const item = { name: ref.replace(/^refs\/(heads|remotes|tags)\//, ''), hash, date, subject };
      if (ref.startsWith('refs/heads/')) local.push({ ...item, current: item.name === cur, protected: isProtected(item.name) });
      else if (ref.startsWith('refs/remotes/')) remote.push(item);
      else tags.push(item);
    }
    return { repo: r.name, current: cur, local, remote, tags: tags.slice(-100) };
  }

  // ─── 更新系 ───
  function needWrite(r) {
    if (!repoCanWrite(r)) throw new Error(`リポジトリ「${r.name}」への書き込みは許可されていません (config.json の git.readOnly:false と git.allowWrite:true が必要)`);
  }

  /** 作業コピーにファイルを書く (コミットはしない) */
  async function writeFile(name, filePath, { content, buffer, ip } = {}) {
    const r = findRepo(name);
    needWrite(r);
    return withLock(r.name, async () => {
      await ensureCloned(r, ip);
      const data = buffer || Buffer.from(String(content == null ? '' : content), 'utf8');
      const maxBytes = (parseFloat(cfg().maxFileMB) || DEFAULTS.maxFileMB) * 1024 * 1024;
      if (data.length > maxBytes) throw new Error(`ファイルが大きすぎます (${data.length} bytes > ${maxBytes})`);
      const { abs, rel } = safeWorkPath(r, filePath);
      if (!rel) throw new Error('path を指定してください');
      if (fs.existsSync(abs) && fs.lstatSync(abs).isSymbolicLink()) throw new Error('シンボリックリンクには書き込めません');
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) throw new Error(`${rel} はディレクトリです`);
      const existed = fs.existsSync(abs);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, data);
      log(ip || '-', `[Git] write: ${r.name}:${rel} (${data.length} bytes)`);
      return { repo: r.name, path: rel, size: data.length, created: !existed, note: 'まだコミットしていません。git_commit でコミットしてください' };
    });
  }

  /** ファイルを削除 (git rm 相当。未追跡ファイルは単に消す) */
  async function deleteFile(name, filePath, { ip } = {}) {
    const r = findRepo(name);
    needWrite(r);
    return withLock(r.name, async () => {
      await ensureCloned(r, ip);
      const { abs, rel } = safeWorkPath(r, filePath, { mustExist: true });
      if (!rel) throw new Error('path を指定してください');
      if (fs.lstatSync(abs).isDirectory()) throw new Error('ディレクトリは削除できません (ファイルを1つずつ指定してください)');
      const tracked = await runGit(['ls-files', '--error-unmatch', '--', rel], { cwd: repoDir(r), r, allowFail: true });
      if (!tracked.code) await runGit(['rm', '-q', '--', rel], { cwd: repoDir(r), r });
      else fs.unlinkSync(abs);
      log(ip || '-', `[Git] delete: ${r.name}:${rel}`);
      return { repo: r.name, path: rel, deleted: true, note: 'まだコミットしていません。git_commit でコミットしてください' };
    });
  }

  /** 変更をステージしてコミット。paths 省略時は作業コピーの全変更 (git add -A) */
  async function commit(name, message, { paths, authorName, authorEmail, ip } = {}) {
    const r = findRepo(name);
    needWrite(r);
    const msg = String(message || '').trim();
    if (!msg) throw new Error('コミットメッセージ (message) を指定してください');
    if (msg.length > 5000) throw new Error('コミットメッセージが長すぎます');
    return withLock(r.name, async () => {
      await ensureCloned(r, ip);
      const cwd = repoDir(r);
      const branch = await currentBranch(r);
      if (branch && isProtected(branch)) throw new Error(`ブランチ「${branch}」は保護されているためコミットできません (git_checkout で作業用ブランチを作ってください)`);
      const list = Array.isArray(paths) ? paths : (typeof paths === 'string' && paths.trim() ? paths.split(',') : []);
      const rels = list.map(p => normalizeRelPath(p)).filter(Boolean);
      if (rels.length) await runGit(['add', '-A', '--', ...rels], { cwd, r });
      else await runGit(['add', '-A'], { cwd, r });
      const staged = await runGit(['diff', '--cached', '--name-status'], { cwd, r });
      const files = String(staged.stdout).trim().split('\n').filter(Boolean);
      if (files.length === 0) return { repo: r.name, committed: false, message: 'コミットする変更がありません' };
      const c = cfg();
      const an = String(authorName || r.authorName || c.authorName || DEFAULTS.authorName).replace(/[<>\n]/g, '').slice(0, 100);
      const ae = String(authorEmail || r.authorEmail || c.authorEmail || DEFAULTS.authorEmail).replace(/[<>\s]/g, '').slice(0, 200);
      // 署名はサーバーの無人実行で鍵のパスフレーズ入力 (pinentry) を待って止まりうるので、
      // signCommits:true の時だけ git の設定 (commit.gpgsign 等) に任せる
      const signArgs = c.signCommits ? [] : ['-c', 'commit.gpgsign=false'];
      await runGit([...signArgs, '-c', `user.name=${an}`, '-c', `user.email=${ae}`, 'commit', '-q', '--no-verify', '-F', '-'], { cwd, r, input: msg + '\n' });
      const head = String((await runGit(['rev-parse', 'HEAD'], { cwd, r })).stdout).trim();
      log(ip || '-', `[Git] commit: ${r.name} ${head.slice(0, 8)} (${files.length} files) "${msg.split('\n')[0].slice(0, 60)}"`);
      return { repo: r.name, committed: true, branch, commit: head.slice(0, 12), files: files.slice(0, 200), author: `${an} <${ae}>` };
    });
  }

  /** ブランチの切り替え / 作成 */
  async function checkout(name, branch, { create = false, from = '', ip } = {}) {
    const r = findRepo(name);
    needWrite(r);
    const b = checkBranchName(branch);
    const fromS = checkRef(from, 'from');
    return withLock(r.name, async () => {
      await ensureCloned(r, ip);
      const cwd = repoDir(r);
      const exists = !(await runGit(['rev-parse', '--verify', '-q', `refs/heads/${b}`], { cwd, r, allowFail: true })).code;
      if (exists) {
        if (create && fromS) throw new Error(`ブランチ「${b}」は既にあります`);
        await runGit(['switch', b], { cwd, r });
      } else {
        const remoteExists = !(await runGit(['rev-parse', '--verify', '-q', `refs/remotes/origin/${b}`], { cwd, r, allowFail: true })).code;
        if (remoteExists && !fromS) {
          await runGit(['switch', '--track', '-c', b, `origin/${b}`], { cwd, r });
        } else if (create || fromS) {
          await runGit(['switch', '-c', b, ...(fromS ? [fromS] : [])], { cwd, r });
        } else {
          throw new Error(`ブランチ「${b}」はありません (新しく作るなら create: true を指定してください)`);
        }
      }
      log(ip || '-', `[Git] checkout: ${r.name} → ${b}`);
      return { repo: r.name, branch: b, created: !exists, ...(await repoStatusInner(r)) };
    });
  }

  /** リモートへ push (force はしない)。上流が無ければ origin/<branch> を作って追跡する */
  async function push(name, { branch = '', ip } = {}) {
    const r = findRepo(name);
    if (!repoCanPush(r)) throw new Error(`リポジトリ「${r.name}」への push は許可されていません (config.json の git.allowPush:true が必要${r.url ? '' : '。リモートの無いローカルリポジトリには push できません'})`);
    return withLock(r.name, async () => {
      await ensureCloned(r, ip);
      const cwd = repoDir(r);
      const cur = await currentBranch(r);
      const b = branch ? checkBranchName(branch) : cur;
      if (!b) throw new Error('detached HEAD のため push できません (ブランチを指定してください)');
      if (isProtected(b)) throw new Error(`ブランチ「${b}」は保護されているため push できません (protectedBranches)`);
      const exists = !(await runGit(['rev-parse', '--verify', '-q', `refs/heads/${b}`], { cwd, r, allowFail: true })).code;
      if (!exists) throw new Error(`ローカルにブランチ「${b}」がありません`);
      const { stderr } = await runGit(['push', '--porcelain', '--set-upstream', 'origin', `refs/heads/${b}:refs/heads/${b}`], { cwd, r, timeoutMs: Math.max(cfg().timeoutMs || 0, 300000) });
      log(ip || '-', `[Git] push: ${r.name} ${b} → ${redactUrl(r.url)}`);
      return { repo: r.name, branch: b, remote: redactUrl(r.url), pushed: true, detail: scrub(String(stderr || '').trim().split('\n').slice(-3).join('\n'), r) };
    });
  }

  // ─── リポジトリの登録 (画面から) ───
  function validateNewRepo(input) {
    const c = cfg();
    const name = String(input?.name || '').trim();
    if (!REPO_NAME_RE.test(name)) throw new Error('名前は英数字と . _ - (64文字以内、先頭は英数字) にしてください');
    if (allRepos().some(r => r.name.toLowerCase() === name.toLowerCase())) throw new Error(`「${name}」は既に登録されています`);
    const url = String(input?.url || '').trim();
    const localPath = String(input?.path || '').trim();
    if (!url && !localPath) throw new Error('url (リモート) か path (サーバー上のローカルリポジトリ) を指定してください');
    if (url && localPath) throw new Error('url と path はどちらか一方だけ指定してください');
    const rec = { name };
    if (url) {
      if (/^[a-z][a-z0-9+.-]*:\/\/[^\/@]+@/i.test(url) && /^https?:/i.test(url)) {
        throw new Error('URL に認証情報を含めないでください (トークン欄に入力してください)');
      }
      const scheme = urlScheme(url);
      const allowed = ['https', 'ssh', 'git'];
      if (c.allowHttp) allowed.push('http');
      if (c.allowFileProtocol !== false) allowed.push('file');
      if (!allowed.includes(scheme)) throw new Error(`この URL のプロトコル (${scheme || '不明'}) は許可されていません (${allowed.join(' / ')})`);
      if (scheme === 'file') {
        // ローカルの bare リポジトリ等を clone 元にする場合も allowLocalPaths で範囲を限定する
        checkLocalPathAllowed(url.replace(/^file:\/\//i, ''));
      }
      rec.url = url;
    } else {
      checkLocalPathAllowed(localPath);
      if (!fs.existsSync(path.join(path.resolve(localPath), '.git'))) throw new Error(`git の作業コピーではありません: ${localPath}`);
      rec.path = path.resolve(localPath);
    }
    if (input.provider && PROVIDERS.includes(input.provider)) rec.provider = input.provider;
    if (input.branch) rec.branch = checkBranchName(input.branch);
    if (input.description) rec.description = String(input.description).slice(0, 200);
    if (input.username) rec.username = String(input.username).slice(0, 100);
    if (input.token) rec.token = String(input.token).slice(0, 500);
    if (input.tokenEnv) {
      if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(input.tokenEnv)) throw new Error('tokenEnv は環境変数名 (英大文字・数字・_) で指定してください');
      rec.tokenEnv = input.tokenEnv;
    }
    if (input.readOnly === true) rec.readOnly = true;
    if (input.allowPush === false) rec.allowPush = false;
    return rec;
  }

  function checkLocalPathAllowed(p) {
    const list = Array.isArray(cfg().allowLocalPaths) ? cfg().allowLocalPaths : [];
    if (list.length === 0) throw new Error('サーバー上のパスを画面から登録するには、config.json の git.allowLocalPaths に許可するディレクトリを書いてください');
    let abs;
    try { abs = fs.realpathSync(path.resolve(p)); } catch { throw new Error(`パスが存在しません: ${p}`); }
    const ok = list.some(base => {
      let b;
      try { b = fs.realpathSync(resolveBase(base)); } catch { return false; }
      return abs === b || abs.startsWith(b + path.sep);
    });
    if (!ok) throw new Error(`このパスは git.allowLocalPaths の範囲外です: ${p}`);
  }

  function addRepo(input, { ip = '-' } = {}) {
    if (!cfg().allowAddRepo) throw new Error('画面からのリポジトリ追加は許可されていません (config.json の git.allowAddRepo:true が必要)');
    const rec = validateNewRepo(input);
    const list = loadUserRepos();
    list.push(rec);
    saveUserRepos(list);
    log(ip, `[Git] リポジトリ追加: ${rec.name} (${rec.url ? redactUrl(rec.url) : rec.path})`);
    return publicRepo(allRepos().find(r => r.name === rec.name));
  }

  /** 画面から追加したリポジトリの登録解除。deleteClone=true なら workDir の clone も消す */
  function removeRepo(name, { deleteClone = false, ip = '-' } = {}) {
    if (!cfg().allowAddRepo) throw new Error('画面からのリポジトリ削除は許可されていません (config.json の git.allowAddRepo:true が必要)');
    const r = findRepo(name);
    if (r.source !== 'user') throw new Error('config.json に書かれたリポジトリは画面から削除できません (config.json を編集してください)');
    const list = loadUserRepos().filter(x => String(x.name).toLowerCase() !== r.name.toLowerCase());
    saveUserRepos(list);
    let removedDir = false;
    if (deleteClone && r.kind === 'url') {
      const d = repoDir(r);
      if (d.startsWith(workDir() + path.sep) && fs.existsSync(d)) {
        fs.rmSync(d, { recursive: true, force: true });
        removedDir = true;
      }
    }
    log(ip, `[Git] リポジトリ削除: ${r.name}${removedDir ? ' (clone も削除)' : ''}`);
    return { removed: true, name: r.name, removedClone: removedDir };
  }

  // ─── LLM ツール ───
  /**
   * 今の設定で使えるツール定義 (OpenAI 形式) を返す。
   * 通常チャット (ブラウザ) と外部APIのツール対応モード (agent_proxy) の両方がこれを使う
   */
  function buildToolDefs() {
    const st = status();
    if (!st.available) return [];
    const repoNames = st.repos.map(r => r.name);
    const repoDesc = `リポジトリ名 (登録済み: ${repoNames.slice(0, 20).join(', ')}${repoNames.length > 20 ? ' 他' : ''})`;
    const repoProp = { type: 'string', description: repoDesc };
    const refProp = { type: 'string', description: '任意: ブランチ名・タグ・コミットID (省略時は作業コピーの現在の内容)' };
    const fn = (name, description, properties, required = []) => ({
      type: 'function', function: { name, description, parameters: { type: 'object', properties, required } },
    });
    const defs = [
      fn('git_list_repos', '登録済みの Git リポジトリ (GitHub / Gitea / GitLab / ローカル git) の一覧と、現在のブランチ・書き込み可否を返す。どのリポジトリがあるか分からない時に最初に使う。', {}),
      fn('git_status', 'リポジトリの現在のブランチ・最新コミット・リモートとの差 (ahead/behind)・未コミットの変更ファイルを返す。', { repo: repoProp }, ['repo']),
      fn('git_pull', 'リモート (GitHub/Gitea 等) から最新を取得して作業コピーを fast-forward で更新する。未 clone なら clone する。「最新にして」「pull して」の依頼や、リモートの最新内容を読む前に使う。', { repo: repoProp }, ['repo']),
      fn('git_list_files', 'リポジトリ内のファイル一覧を返す。path でディレクトリを絞り込める。ref を指定すると、そのブランチ/コミット時点の一覧。', {
        repo: repoProp,
        path: { type: 'string', description: '任意: ディレクトリ (例: "src/utils")。省略でリポジトリ全体' },
        ref: refProp,
        recursive: { type: 'boolean', description: '任意: false で直下のみ (既定 true)' },
      }, ['repo']),
      fn('git_read_file', 'リポジトリのファイルの中身をテキストで読む。ref を指定すると、そのブランチ/タグ/コミット時点の内容を読む。', {
        repo: repoProp,
        path: { type: 'string', description: 'リポジトリ内の相対パス (例: "README.md", "src/main.py")' },
        ref: refProp,
        maxChars: { type: 'number', description: '任意: 取得する最大文字数' },
      }, ['repo', 'path']),
      fn('git_search', 'リポジトリ内のファイルの中身を全文検索する (git grep。大文字小文字は区別しない)。関数名・設定キー・エラーメッセージ等の所在を探すのに使う。ファイル名に一致したものも返す。', {
        repo: repoProp,
        query: { type: 'string', description: '検索する文字列' },
        path: { type: 'string', description: '任意: 検索範囲のディレクトリ' },
        ref: refProp,
        regex: { type: 'boolean', description: '任意: true で拡張正規表現として扱う (既定は固定文字列)' },
      }, ['repo', 'query']),
      fn('git_log', 'コミット履歴を返す。path を指定するとそのファイル/ディレクトリを変更したコミットだけ。', {
        repo: repoProp,
        ref: { type: 'string', description: '任意: ブランチ名など (省略時は現在のブランチ)' },
        path: { type: 'string', description: '任意: 対象ファイル/ディレクトリ' },
        limit: { type: 'number', description: '任意: 件数 (既定20、最大200)' },
      }, ['repo']),
      fn('git_show_commit', '1つのコミットの詳細 (メッセージ・変更ファイル・差分) を返す。', {
        repo: repoProp,
        commit: { type: 'string', description: 'コミットID (git_log の short/hash)、ブランチ名、HEAD~1 等' },
      }, ['repo', 'commit']),
      fn('git_diff', '差分を返す。from/to を省略すると作業コピーの未コミットの変更。from だけなら from と作業コピーの差分、両方ならブランチ/コミット間の差分。', {
        repo: repoProp,
        from: { type: 'string', description: '任意: 比較元 (ブランチ/コミット)' },
        to: { type: 'string', description: '任意: 比較先 (ブランチ/コミット)' },
        path: { type: 'string', description: '任意: 対象ファイル/ディレクトリ' },
      }, ['repo']),
      fn('git_list_branches', 'ローカル/リモートのブランチとタグの一覧を返す。', { repo: repoProp }, ['repo']),
      fn('git_import_to_server', 'リポジトリのファイルをサーバーの uploads フォルダにコピーする。画像・Excel・CSV 等を Python で処理したい時や、バイナリファイルを扱いたい時に使う。', {
        repo: repoProp,
        path: { type: 'string', description: 'リポジトリ内の相対パス' },
        savePath: { type: 'string', description: '任意: uploads 配下の保存先 (省略時はファイル名)' },
        ref: refProp,
      }, ['repo', 'path']),
    ];
    if (st.allowWrite && st.repos.some(r => r.canWrite)) {
      defs.push(
        fn('git_write_file', 'リポジトリの作業コピーにテキストファイルを作成/上書きする (まだコミットはしない)。既存ファイルを直す時は git_read_file で全文を読み、修正後の全文を content に渡すこと。書き終えたら git_commit でコミットする。', {
          repo: repoProp,
          path: { type: 'string', description: 'リポジトリ内の相対パス' },
          content: { type: 'string', description: 'ファイルの内容 (全文)' },
        }, ['repo', 'path', 'content']),
        fn('git_export_from_server', 'サーバーの uploads フォルダにあるファイル (バイナリ可) をリポジトリの作業コピーにコピーする (まだコミットはしない)。', {
          repo: repoProp,
          path: { type: 'string', description: 'uploads 配下の相対パス (例: "result.csv")' },
          dest: { type: 'string', description: '任意: リポジトリ内の保存先 (省略時はファイル名のまま直下)' },
        }, ['repo', 'path']),
        fn('git_delete_file', 'リポジトリのファイルを削除する (git rm。まだコミットはしない)。ユーザーが明確に削除を依頼した時だけ使うこと。', {
          repo: repoProp,
          path: { type: 'string', description: 'リポジトリ内の相対パス' },
        }, ['repo', 'path']),
        fn('git_commit', '作業コピーの変更をコミットする。paths を省略すると全ての変更 (新規・変更・削除) をコミットする。', {
          repo: repoProp,
          message: { type: 'string', description: 'コミットメッセージ (1行目に要約)' },
          paths: { type: 'array', items: { type: 'string' }, description: '任意: コミットするファイルだけを指定' },
        }, ['repo', 'message']),
        fn('git_checkout', 'ブランチを切り替える。create: true で新しいブランチを作って切り替える (from で起点を指定可)。', {
          repo: repoProp,
          branch: { type: 'string', description: 'ブランチ名' },
          create: { type: 'boolean', description: '任意: 無ければ作成する' },
          from: { type: 'string', description: '任意: 新しいブランチの起点 (ブランチ/コミット)' },
        }, ['repo', 'branch']),
      );
    }
    if (st.allowPush && st.repos.some(r => r.canPush)) {
      defs.push(fn('git_push', 'コミット済みの変更をリモート (GitHub / Gitea 等) に push する。force push はしない。ユーザーが push・反映・アップロードを依頼した時だけ使うこと。', {
        repo: repoProp,
        branch: { type: 'string', description: '任意: push するブランチ (省略時は現在のブランチ)' },
      }, ['repo']));
    }
    return defs;
  }

  /** 結果オブジェクトを LLM が読みやすいテキストにする */
  function formatResult(fnName, r) {
    switch (fnName) {
      case 'git_list_repos': {
        if (!r.repos.length) return 'Git リポジトリは登録されていません。';
        return `登録済みの Git リポジトリ (${r.repos.length}件):\n` + r.repos.map((x, i) =>
          `${i + 1}. ${x.name} [${x.provider}] ${x.url || x.path}` +
          `${x.branch ? ` (既定ブランチ: ${x.branch})` : ''}` +
          `${x.currentBranch ? ` 現在: ${x.currentBranch}` : ''}` +
          `${x.cloned ? '' : ' ※未取得 (初回アクセス時に clone)'}` +
          ` / ${x.canPush ? '読み書き・push 可' : x.canWrite ? '読み書き可 (push 不可)' : '読み取り専用'}` +
          `${x.description ? `\n   ${x.description}` : ''}`).join('\n');
      }
      case 'git_status': {
        const lines = [`リポジトリ: ${r.repo} (${r.provider}) ${r.url || r.path}`,
          `ブランチ: ${r.branch || '(detached)'}${r.hasUpstream ? ` / リモートより ${r.ahead} 件先行・${r.behind} 件遅れ` : ' / 追跡ブランチなし'}`];
        if (r.head) lines.push(`最新コミット: ${r.head.hash} ${r.head.date} ${r.head.author}: ${r.head.subject}`);
        lines.push(r.clean ? '未コミットの変更: なし' : `未コミットの変更 (${r.changeCount}件):\n` + r.changes.map(c => `  ${c.status} ${c.path}`).join('\n'));
        lines.push(r.canWrite ? (r.canPush ? '権限: 書き込み・コミット・push 可' : '権限: 書き込み・コミット可 (push 不可)') : '権限: 読み取り専用');
        return lines.join('\n');
      }
      case 'git_pull':
        return `${r.repo}: ${r.message}` + (r.changed?.length ? `\n変更ファイル:\n${r.changed.map(s => '  ' + s.replace('\t', ' ')).join('\n')}` : '');
      case 'git_list_files': {
        if (!r.entries.length) return `${r.repo}${r.path ? `/${r.path}` : ''} にファイルはありません (ref: ${r.ref})。`;
        return `${r.repo}${r.path ? `/${r.path}` : ''} のファイル一覧 (ref: ${r.ref}, ${r.total}件${r.truncated ? `、先頭 ${r.entries.length}件のみ表示` : ''}):\n` +
          r.entries.map(e => e.type === 'dir' ? `${e.path}/` : `${e.path}${e.size != null ? ` (${e.size}B)` : ''}`).join('\n');
      }
      case 'git_read_file': {
        if (r.binary) return `「${r.path}」はバイナリファイルです (${r.size} bytes)。git_import_to_server で uploads に取り込めば Python 等で処理できます。`;
        const fence = '`'.repeat(Math.max(3, ...(r.content.match(/`+/g) || ['']).map(s => s.length + 1)));
        return `${r.repo}:${r.path} (ref: ${r.ref}, ${r.size} bytes)${r.truncated ? ' ※長いので途中まで' : ''}\n${fence}\n${r.content}\n${fence}`;
      }
      case 'git_search': {
        const parts = [];
        if (r.hits.length) parts.push(`「${r.query}」の検索結果 (${r.total}件${r.truncated ? `、先頭 ${r.hits.length}件のみ表示` : ''}, ref: ${r.ref}):\n` + r.hits.map(h => `${h.path}:${h.line}: ${h.text}`).join('\n'));
        if (r.fileNameHits.length) parts.push(`ファイル名に「${r.query}」を含むファイル:\n` + r.fileNameHits.join('\n'));
        return parts.length ? parts.join('\n\n') : `${r.repo} に「${r.query}」は見つかりませんでした。`;
      }
      case 'git_log':
        return r.commits.length
          ? `${r.repo} のコミット履歴 (${r.ref}${r.path ? `, ${r.path}` : ''}, ${r.commits.length}件):\n` + r.commits.map(c => `${c.short} ${c.date.slice(0, 16).replace('T', ' ')} ${c.author}: ${c.subject}`).join('\n')
          : 'コミットはありません。';
      case 'git_show_commit':
        return `${r.content}${r.truncated ? '\n... (長いので省略)' : ''}`;
      case 'git_diff': {
        const body = r.content.trim() ? r.content : '(差分なし)';
        return `${r.repo} の差分 (${r.from || ''} → ${r.to}):\n${body}${r.truncated ? '\n... (長いので省略)' : ''}` +
          (r.untracked?.length ? `\n\n未追跡の新規ファイル:\n${r.untracked.join('\n')}` : '');
      }
      case 'git_list_branches':
        return `${r.repo} の現在のブランチ: ${r.current || '(detached)'}\n` +
          `ローカル: ${r.local.map(b => b.name + (b.current ? '*' : '') + (b.protected ? '(保護)' : '')).join(', ') || 'なし'}\n` +
          `リモート: ${r.remote.map(b => b.name).join(', ') || 'なし'}\n` +
          `タグ: ${r.tags.map(t => t.name).join(', ') || 'なし'}`;
      case 'git_write_file':
        return `${r.repo}:${r.path} を${r.created ? '作成' : '更新'}しました (${r.size} bytes)。${r.note}`;
      case 'git_export_from_server':
        return `uploads/${r.from} を ${r.repo}:${r.path} にコピーしました (${r.size} bytes)。${r.note}`;
      case 'git_delete_file':
        return `${r.repo}:${r.path} を削除しました。${r.note}`;
      case 'git_commit':
        return r.committed
          ? `${r.repo} のブランチ ${r.branch} にコミットしました: ${r.commit} (${r.files.length} ファイル, 作成者 ${r.author})\n${r.files.map(f => '  ' + f.replace('\t', ' ')).join('\n')}\nリモートに反映するには git_push が必要です。`
          : `${r.repo}: ${r.message}`;
      case 'git_checkout':
        return `${r.repo}: ブランチ ${r.branch} に${r.created ? '新規作成して' : ''}切り替えました。` + (r.clean ? '' : ` (未コミットの変更 ${r.changeCount}件はそのまま持ち越し)`);
      case 'git_push':
        return `${r.repo}: ブランチ ${r.branch} を ${r.remote} に push しました。${r.detail ? `\n${r.detail}` : ''}`;
      case 'git_import_to_server':
        return `${r.repo}:${r.from} をサーバーの uploads/${r.path} に取り込みました (${r.size} bytes)。read_file や Python で参照できます。`;
      default:
        return typeof r === 'string' ? r : JSON.stringify(r, null, 2);
    }
  }

  /**
   * ツールを実行して LLM 向けテキストを返す
   * @param {string} fnName
   * @param {object} args
   * @param {object} ctx  { ip, importToServer(buffer, savePath, srcName), readUploadBuffer(relPath) }
   */
  async function executeTool(fnName, args = {}, ctx = {}) {
    const a = args && typeof args === 'object' ? args : {};
    const ip = ctx.ip || '-';
    const repo = a.repo ?? a.repository ?? a.name ?? a.repo_name;
    const p = a.path ?? a.file ?? a.filePath ?? a.filename;
    let result;
    switch (fnName) {
      case 'git_list_repos': {
        const st = status();
        const repos = [];
        for (const x of st.repos) {
          let currentBranchName = '';
          if (x.cloned) { try { currentBranchName = await currentBranch(findRepo(x.name)); } catch {} }
          repos.push({ ...x, currentBranch: currentBranchName });
        }
        result = { repos };
        break;
      }
      case 'git_status': result = await repoStatus(repo, { ip }); break;
      case 'git_pull': result = await pull(repo, { ip }); break;
      case 'git_list_files': result = await listFiles(repo, { path: p || a.dir || '', ref: a.ref, recursive: a.recursive !== false, ip }); break;
      case 'git_read_file': result = await readFile(repo, p, { ref: a.ref, maxChars: a.maxChars, ip }); break;
      case 'git_search': result = await search(repo, a.query ?? a.q, { path: p || '', ref: a.ref, regex: !!a.regex, ip }); break;
      case 'git_log': result = await logCommits(repo, { ref: a.ref || a.branch, path: p || '', limit: a.limit, ip }); break;
      case 'git_show_commit': result = await showCommit(repo, a.commit || a.ref || a.hash, { ip }); break;
      case 'git_diff': result = await diff(repo, { from: a.from, to: a.to, path: p || '', ip }); break;
      case 'git_list_branches': result = await branches(repo, { ip }); break;
      case 'git_write_file': result = await writeFile(repo, p, { content: a.content ?? a.text ?? '', ip }); break;
      case 'git_delete_file': result = await deleteFile(repo, p, { ip }); break;
      case 'git_commit': result = await commit(repo, a.message ?? a.msg, { paths: a.paths ?? a.files, ip }); break;
      case 'git_checkout': result = await checkout(repo, a.branch, { create: !!a.create, from: a.from, ip }); break;
      case 'git_push': result = await push(repo, { branch: a.branch, ip }); break;
      case 'git_import_to_server': {
        if (typeof ctx.importToServer !== 'function') throw new Error('uploads への取り込みは利用できません');
        const f = await readFile(repo, p, { ref: a.ref, ip, asBuffer: true });
        const saved = await ctx.importToServer(f.buffer, a.savePath || path.posix.basename(f.path), f.path);
        result = { repo: f.repo, from: f.path, path: saved.path, size: f.buffer.length };
        log(ip, `[Git] import: ${f.repo}:${f.path} → uploads/${saved.path}`);
        break;
      }
      case 'git_export_from_server': {
        if (typeof ctx.readUploadBuffer !== 'function') throw new Error('uploads からのコピーは利用できません');
        const src = String(p || '').trim();
        if (!src) throw new Error('path (uploads 配下のファイル) を指定してください');
        const buf = await ctx.readUploadBuffer(src);
        const dest = a.dest || a.destPath || path.posix.basename(src.replace(/\\/g, '/'));
        const w = await writeFile(repo, dest, { buffer: buf, ip });
        result = { ...w, from: src };
        break;
      }
      default:
        throw new Error(`未知の Git ツール: ${fnName}`);
    }
    return formatResult(fnName, result);
  }

  return {
    // 状態・設定
    status, gitVersion, allRepos: () => allRepos().map(publicRepo),
    // 参照系
    repoStatus, pull, listFiles, readFile, search, logCommits, showCommit, diff, branches,
    // 更新系
    writeFile, deleteFile, commit, checkout, push,
    // 登録
    addRepo, removeRepo,
    // LLM ツール
    buildToolDefs, executeTool, formatResult,
  };
}

/** ツールのハーネス用メタデータ (agent_proxy.js の TOOL_META / harness_client.js と揃える) */
const GIT_TOOL_META = {
  git_list_repos:         { readOnly: true },
  git_status:             { readOnly: true },
  git_list_files:         { readOnly: true },
  git_read_file:          { readOnly: true, untrustedOutput: true },
  git_search:             { readOnly: true, untrustedOutput: true },
  git_log:                { readOnly: true, untrustedOutput: true },
  git_show_commit:        { readOnly: true, untrustedOutput: true },
  git_diff:               { readOnly: true, untrustedOutput: true },
  git_list_branches:      { readOnly: true },
  git_pull:               { readOnly: false },  // 作業コピーを更新する
  git_import_to_server:   { readOnly: false },  // uploads にファイルを書く
  git_write_file:         { readOnly: false },
  git_export_from_server: { readOnly: false },
  git_checkout:           { readOnly: false },
  git_commit:             { readOnly: false },
  git_delete_file:        { readOnly: false, dangerous: true },
  git_push:               { readOnly: false, dangerous: true },  // 外部に公開される
};

module.exports = { createGitRepos, GIT_TOOL_META, redactUrl, guessProvider };
