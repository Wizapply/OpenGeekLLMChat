/**
 * html_rag.js — HTML / RAG登録パイプライン (HTML → クリーニング → Markdown → RAG登録)
 *
 * Webページやローカルの HTML ファイルを、UIに放り込むだけで検索可能な知識にするための機構。
 * 「HtmlRAG: HTML is Better Than Plain Text for Modeling Retrieved Knowledge in RAG
 * Systems」(WWW 2025) の知見を取り込んでいる。
 * 解説: https://zenn.dev/knowledgesense/articles/e35011933152e2
 *
 * 論文の要点:
 *   - RAG で HTML をプレーンテキストへ潰すと、見出し・表・コード・強調などの
 *     構造情報 (=意味) が失われ、回答品質が落ちる
 *   - かといって生の HTML は CSS/JS/属性などのノイズが本文の何十倍もある。
 *     そこで「HTMLクリーニング」で意味を保ったまま数%のサイズまで圧縮する
 *       1. <script>/<style>/コメントなど、本文と無関係なノードの除去
 *       2. 属性の除去 (href/alt など最小限だけ残す)
 *       3. 空タグの除去と、単一子の冗長な入れ子 (<div><div><p>) の統合
 *
 * このアプリでの実装方針:
 *   - クリーニングは論文の手順をそのまま実装する (上記1〜3)。
 *   - 既定ではクリーン済み HTML をさらに「構造を保った Markdown」へ変換して登録する。
 *     このアプリの永続RAGはテキストチャンク + BERT系 embedding (ctx 512) なので、
 *     タグ文字列を埋め込みに混ぜるより、見出し→#、表→Markdownテーブル、コード→フェンス
 *     として構造を記法で保存する方が検索・引用と相性が良い (OCRパイプラインと同じ出口)。
 *     htmlRag.registerFormat を 'html' にすると、クリーン済み HTML のまま登録する
 *     論文に忠実なモードになる (textExts が .html を受けるのでそのまま通る)。
 *   - 論文の「ブロックツリー剪定」は検索時に文書をコンテキストへ詰める段の話で、
 *     このアプリではチャンク単位の embedding 検索 (ragSearch) が同じ役割を担うため
 *     実装しない (登録時に潰すと後からの質問で使えなくなる)。
 *
 * 入力は2系統:
 *   - ローカルの .html/.htm ファイルのアップロード
 *   - URL 指定 (サーバーが Web ページを取得する)
 * どちらも元 HTML を public/uploads/ に保存し、生成物を ragIngestFile() で
 * 永続RAGへ登録する。チャットは追加実装なしで search_persistent_documents から参照できる。
 *
 * 方針:
 * - 依存を増やさない。HTML のパースも自前の軽量トークナイザで行う
 *   (jsdom/cheerio はネイティブ依存や巨大な依存ツリーを持ち込むので使わない)。
 * - GPU を使わないのでジョブは速いが、履歴・再実行・RAG連動削除のために
 *   ocr.js と同じジョブモデル (JSON永続化 + SSE配信) を踏襲する。
 */

const fs = require('fs');
const path = require('path');
const { receiveMultipartToFile, uniqueName, humanBytes } = require('./ocr');

// ジョブ状態 (ocr.js と同じ遷移)
//   pending → queued → running → completed / failed / cancelled
const ACTIVE_STATUSES = ['queued', 'running'];
const MAX_JOBS = 100;

// 既定の User-Agent。素の undici UA は bot として弾くサイトが多いので、
// Web検索機能 (server.js の fetchPageText) と同じブラウザUAを名乗る
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 画像の内容解析の既定プロンプト (htmlRag.imagePrompt で変更可)
const DEFAULT_IMAGE_PROMPT = 'この画像はWebページに掲載された図・写真・スクリーンショットです。内容を日本語で簡潔に説明してください:\n'
  + '1. 画像内に文字がある場合は、できるだけ正確に書き起こす (OCR)\n'
  + '2. 表は Markdown テーブルで出力\n'
  + '3. グラフ・図解は、何を示しているか (軸・項目・傾向) を説明\n'
  + '4. 写真は写っているものを客観的に説明\n'
  + '余計な前置きや推測は不要で、説明だけを出力してください。';

// ════════════════════════════════════════════════════════════
// HTML パーサ (軽量トークナイザ → 素朴なDOMツリー)
// ════════════════════════════════════════════════════════════

// 閉じタグを持たない要素
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// 中身をマークアップとして解釈しない要素 (対応する閉じタグまで生テキスト)
const RAWTEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'xmp']);

// タグ X が開いたら暗黙に閉じる要素 (キー: スタック上の要素, 値: 閉じさせるタグ)
// 実ページは </p> や </li> を省略していることが多く、これが無いと入れ子が壊れる
const BLOCKISH = ['address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
  'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul'];
const IMPLICIT_CLOSE = {
  li: new Set(['li']),
  p: new Set(BLOCKISH),
  dt: new Set(['dt', 'dd']),
  dd: new Set(['dt', 'dd']),
  td: new Set(['td', 'th', 'tr']),
  th: new Set(['td', 'th', 'tr']),
  tr: new Set(['tr']),
  thead: new Set(['tbody', 'tfoot']),
  tbody: new Set(['tbody', 'tfoot']),
  option: new Set(['option', 'optgroup']),
  a: new Set(['a']),
};

// よく出る文字実体参照 (数値参照は正規表現で別途処理)
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', times: '×', divide: '÷', deg: '°', plusmn: '±',
  middot: '·', bull: '•', dagger: '†', sect: '§', para: '¶',
  yen: '¥', euro: '€', pound: '£', cent: '¢',
  larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔',
};

function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const v = NAMED_ENTITIES[body] !== undefined ? NAMED_ENTITIES[body] : NAMED_ENTITIES[body.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

/** 引用符の中の > を無視してタグの終わりを探す。壊れた属性で全文を飲み込まないよう長さを制限 */
function findTagEnd(html, from) {
  const limit = Math.min(html.length, from + 65536);
  let q = null;
  for (let i = from; i < limit; i++) {
    const c = html[i];
    if (q) { if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === '>') return i;
  }
  return -1;
}

/** タグ内文字列 ("div class=..." 等) から属性を取り出す */
function parseAttrs(s) {
  const attrs = {};
  const re = /([^\s=/"'<>]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|[^\s"'>]+))?/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const name = m[1].toLowerCase();
    let value = '';
    if (m[2] !== undefined) {
      value = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : m[2]);
    }
    if (!(name in attrs)) attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/**
 * HTML文字列 → { root, title }
 * root は { type:'element', tag:'#root', attrs:{}, children:[...] }。
 * 実ページの雑なマークアップ (閉じ忘れ・過剰な閉じタグ) に耐えることを優先した
 * 寛容なパーサで、仕様完全準拠は目指さない (クリーニングして捨てる用途なので十分)。
 */
function parseHtml(html) {
  const root = { type: 'element', tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const lower = html.toLowerCase();   // RAWTEXT の閉じタグ検索用 (毎回 slice しない)
  let title = '';
  let i = 0;
  const n = html.length;

  const top = () => stack[stack.length - 1];
  const pushText = (raw) => {
    if (!raw) return;
    top().children.push({ type: 'text', text: decodeEntities(raw) });
  };

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { pushText(html.slice(i)); break; }
    if (lt > i) pushText(html.slice(i, lt));

    const next = html[lt + 1];
    // "a < b" のような地の文の < はテキストとして扱う
    if (!next || !/[a-zA-Z!/?]/.test(next)) {
      pushText('<');
      i = lt + 1;
      continue;
    }
    // コメント
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    // DOCTYPE / CDATA / 処理命令
    if (next === '!' || next === '?') {
      const end = html.indexOf('>', lt + 1);
      i = end < 0 ? n : end + 1;
      continue;
    }
    // 閉じタグ
    if (next === '/') {
      const end = html.indexOf('>', lt);
      if (end < 0) break;
      const name = html.slice(lt + 2, end).trim().toLowerCase().split(/[\s/]/)[0];
      // 対応する開きタグをスタックから探して、あればそこまで閉じる (無ければ無視)
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k].tag === name) { stack.length = k; break; }
      }
      i = end + 1;
      continue;
    }

    // 開きタグ
    const gt = findTagEnd(html, lt + 1);
    if (gt < 0) { pushText('<'); i = lt + 1; continue; }   // 壊れたタグはテキスト扱い
    const body = html.slice(lt + 1, gt);
    const nameMatch = /^([a-zA-Z][^\s/>]*)/.exec(body);
    if (!nameMatch) { i = gt + 1; continue; }
    const tag = nameMatch[1].toLowerCase();
    const selfClosing = /\/\s*$/.test(body);
    const attrs = parseAttrs(body.slice(nameMatch[1].length).replace(/\/\s*$/, ''));
    i = gt + 1;

    // 暗黙の閉じタグ (<li> の次の <li> 等)
    while (stack.length > 1) {
      const closers = IMPLICIT_CLOSE[top().tag];
      if (closers && closers.has(tag)) stack.pop();
      else break;
    }

    // 生テキスト要素: 対応する閉じタグまで丸ごとテキストとして取り込む
    if (RAWTEXT_TAGS.has(tag) && !selfClosing) {
      const closeAt = lower.indexOf(`</${tag}`, i);
      const raw = html.slice(i, closeAt < 0 ? n : closeAt);
      const node = { type: 'element', tag, attrs, children: [] };
      if (raw) node.children.push({ type: 'text', text: decodeEntities(raw) });
      top().children.push(node);
      if (tag === 'title' && !title) title = decodeEntities(raw).replace(/\s+/g, ' ').trim();
      if (closeAt < 0) break;
      const closeEnd = html.indexOf('>', closeAt);
      i = closeEnd < 0 ? n : closeEnd + 1;
      continue;
    }

    const node = { type: 'element', tag, attrs, children: [] };
    top().children.push(node);
    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(node);
  }

  return { root, title };
}

// ════════════════════════════════════════════════════════════
// HTMLクリーニング (HtmlRAG 論文の手法)
// ════════════════════════════════════════════════════════════

// 本文と無関係なので丸ごと捨てる要素 (論文のいう CSS / JS / 無意味ノード)
const DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset',
  'object', 'embed', 'applet', 'param', 'svg', 'canvas', 'video', 'audio',
  'source', 'track', 'map', 'area', 'link', 'meta', 'base', 'head', 'title',
  'button', 'input', 'select', 'optgroup', 'option', 'textarea', 'datalist',
  'progress', 'meter', 'dialog', 'col', 'colgroup',
]);

// サイトの枠 (ナビゲーション・フッター等)。dropBoilerplate 時に捨てる
const BOILERPLATE_TAGS = new Set(['nav', 'header', 'footer', 'aside']);
const BOILERPLATE_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'menu', 'menubar', 'search']);

// タグごとに残す属性。それ以外の属性 (class/style/data-* 等) はすべて捨てる。
// class を code/pre にだけ残すのは Markdown 変換で言語名 (language-js) を拾うため
const KEEP_ATTRS = {
  a: ['href'],
  img: ['src', 'alt'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
  ol: ['start'],
  code: ['class'],
  pre: ['class'],
};

// 中身が空でも意味を持つ要素 (td/th は表の形を保つために残す)
const KEEP_EMPTY = new Set(['img', 'br', 'hr', 'td', 'th']);

// 属性を剥がしたら何の意味も残らないインライン要素 → 常に子で置き換える
const ALWAYS_UNWRAP = new Set(['span', 'font']);

// 子が1つしか無いとき冗長な入れ子として統合する汎用コンテナ。
// main/article は「本文の目印」として preferMainContent の選択に使うので統合しない
const GENERIC_CONTAINERS = new Set(['html', 'body', 'div', 'section', 'center', 'hgroup']);

/** ノード配下に「意味のある内容」(空白以外のテキスト or 画像) があるか */
function hasContent(node) {
  if (node.type === 'text') return /\S/.test(node.text);
  if (node.tag === 'img') return true;
  return (node.children || []).some(hasContent);
}

/** ノード配下のテキスト量 (本文選択のスコア用) */
function textLength(node) {
  if (node.type === 'text') return node.text.trim().length;
  return (node.children || []).reduce((s, c) => s + textLength(c), 0);
}

/** 指定タグの要素を再帰的に集める */
function findElements(node, tags, out = []) {
  if (node.type === 'element') {
    if (tags.includes(node.tag)) out.push(node);
    for (const c of node.children) findElements(c, tags, out);
  }
  return out;
}

/**
 * クリーニング本体。1ノードを受けて「残すノードの配列」を返す
 * (捨てる → []、unwrap → 子の配列、通常 → [自分])
 */
function cleanNode(node, opts, inPre) {
  if (node.type === 'text') {
    if (inPre) return [{ type: 'text', text: node.text }];   // コードは空白も情報
    const text = node.text.replace(/\s+/g, ' ');
    if (text === '') return [];
    // 空白だけのノードも1個は残す (<b>a</b> <i>b</i> の語間が消えないように)
    return [{ type: 'text', text }];
  }

  const tag = node.tag;
  if (DROP_TAGS.has(tag)) return [];
  if (opts.dropBoilerplate && BOILERPLATE_TAGS.has(tag)) return [];

  const attrs = node.attrs || {};
  // 画面に見えていない要素はノイズ (メニューの折りたたみ・SEO用の隠しテキスト等)
  if (attrs['aria-hidden'] === 'true' || 'hidden' in attrs) return [];
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(attrs.style || '')) return [];
  if (opts.dropBoilerplate && BOILERPLATE_ROLES.has((attrs.role || '').toLowerCase())) return [];

  // 属性の除去 (残すのは KEEP_ATTRS の分だけ)
  const keep = {};
  for (const k of KEEP_ATTRS[tag] || []) {
    if (attrs[k] !== undefined && attrs[k] !== '') keep[k] = attrs[k];
  }
  // data:URI (インライン画像) は数百KBのノイズになるだけなので残さない
  if (tag === 'img' && /^data:/i.test(keep.src || '')) delete keep.src;

  const children = [];
  for (const c of node.children) {
    children.push(...cleanNode(c, opts, inPre || tag === 'pre'));
  }
  const out = { type: 'element', tag, attrs: keep, children };

  // 空タグの除去
  if (!KEEP_EMPTY.has(tag) && !hasContent(out)) return [];
  // 冗長な入れ子の統合 (<div><div><p>x → <p>x)
  if (ALWAYS_UNWRAP.has(tag)) return children;
  if (GENERIC_CONTAINERS.has(tag) && children.length === 1 && children[0].type === 'element') {
    return children;
  }
  return [out];
}

/** クリーン済みツリーを HTML 文字列へ (registerFormat:'html' の登録内容・削減率の計測用) */
function serializeHtml(node) {
  if (node.type === 'text') {
    return node.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  const inner = node.children.map(serializeHtml).join('');
  if (node.tag === '#root') return inner;
  const attrs = Object.entries(node.attrs || {})
    .map(([k, v]) => ` ${k}="${String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)
    .join('');
  if (VOID_TAGS.has(node.tag)) return `<${node.tag}${attrs}>`;
  return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}

// ════════════════════════════════════════════════════════════
// Markdown 変換 (構造を記法として保存する)
// ════════════════════════════════════════════════════════════

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'center', 'details', 'dd',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1',
  'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'html', 'li', 'main',
  'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'ul',
]);

/** 配下のテキストを無加工で連結 (pre 用) */
function rawText(node) {
  if (node.type === 'text') return node.text;
  return (node.children || []).map(rawText).join('');
}

/** a の href を絶対URLへ。ページ内リンクや javascript: はテキストだけ残す */
function resolveHref(href, baseUrl) {
  if (!href) return null;
  if (/^(javascript|data|vbscript):/i.test(href)) return null;
  if (href.startsWith('#')) return null;
  try {
    if (baseUrl) return new URL(href, baseUrl).href;
    return /^https?:\/\//i.test(href) ? href : null;
  } catch { return null; }
}

function renderInline(nodes, ctx) {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') { out += node.text; continue; }
    const tag = node.tag;
    const inner = () => renderInline(node.children, ctx).trim();
    switch (tag) {
      case 'br': out += '\n'; break;
      case 'strong': case 'b': { const s = inner(); if (s) out += `**${s}**`; break; }
      case 'em': case 'i': { const s = inner(); if (s) out += `*${s}*`; break; }
      case 'del': case 's': case 'strike': { const s = inner(); if (s) out += `~~${s}~~`; break; }
      case 'code': case 'kbd': case 'samp': case 'var': {
        const s = rawText(node).replace(/\s+/g, ' ').trim();
        if (s) out += s.includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``;
        break;
      }
      case 'a': {
        const text = inner() || node.attrs.href || '';
        const href = resolveHref(node.attrs.href, ctx.baseUrl);
        out += href && text ? `[${text}](${href})` : text;
        break;
      }
      case 'img': {
        const alt = (node.attrs.alt || '').trim();
        // data-description は画像解析 (Vision LLM) が後から書き込む内部属性
        const desc = (node.attrs['data-description'] || '').trim();
        if (desc) {
          // 説明を引用ブロックで直後に置く (RAGの検索チャンクに載る)
          const q = `画像の内容: ${desc}`.split('\n')
            .map(l => (l.trim() ? `> ${l}` : '>')).join('\n');
          out += `\n[図: ${alt || '画像'}]\n${q}\n`;
        } else if (alt) {
          out += `[図: ${alt}]`;   // OCR の「[図: 説明]」と同じ表記に揃える
        }
        break;
      }
      case 'ruby': {
        // ルビは「漢字(かんじ)」の形へ。rp (フォールバック括弧) は捨てる
        let base = '', rt = '';
        for (const c of node.children) {
          if (c.type === 'element' && c.tag === 'rt') rt += rawText(c).trim();
          else if (c.type === 'element' && c.tag === 'rp') continue;
          else base += c.type === 'text' ? c.text : renderInline([c], ctx);
        }
        out += rt ? `${base.trim()}(${rt})` : base.trim();
        break;
      }
      case 'rt': case 'rp': break;
      default:
        // ブロック要素がインライン文脈に紛れた場合も中身は落とさない
        out += renderInline(node.children, ctx);
    }
  }
  return out.replace(/[ \t]{2,}/g, ' ');
}

/** 子ノード列を「連続するインラインを段落にまとめつつ」ブロックとして描画 */
function renderChildren(children, ctx) {
  const blocks = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const s = renderInline(run, ctx).replace(/\n{2,}/g, '\n').trim();
    if (s) blocks.push(s);
    run = [];
  };
  for (const c of children) {
    if (c.type === 'element' && BLOCK_TAGS.has(c.tag)) {
      flush();
      const b = renderBlock(c, ctx);
      if (b) blocks.push(b);
    } else {
      run.push(c);
    }
  }
  flush();
  return blocks.join('\n\n');
}

function renderList(node, ctx) {
  const ordered = node.tag === 'ol';
  let idx = parseInt(node.attrs.start, 10);
  if (!Number.isFinite(idx)) idx = 1;
  const lines = [];
  for (const li of node.children) {
    if (!(li.type === 'element' && li.tag === 'li')) continue;
    const marker = ordered ? `${idx++}. ` : '- ';
    const pad = ' '.repeat(marker.length);
    const inner = renderChildren(li.children, ctx).split('\n');
    lines.push(marker + (inner[0] || ''));
    for (let i = 1; i < inner.length; i++) lines.push(inner[i] ? pad + inner[i] : '');
  }
  return lines.join('\n');
}

function renderTable(node, ctx) {
  const esc = (nodes) => renderInline(nodes, ctx).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  let caption = '';
  const rows = [];
  const collectRows = (el) => {
    for (const c of el.children) {
      if (c.type !== 'element') continue;
      if (c.tag === 'caption') caption = esc(c.children);
      else if (c.tag === 'tr') {
        const cells = [];
        for (const cell of c.children) {
          if (cell.type === 'element' && (cell.tag === 'td' || cell.tag === 'th')) {
            cells.push(esc(cell.children));
            // colspan の分だけ空セルを足して列位置を保つ
            const span = parseInt(cell.attrs.colspan, 10);
            for (let s = 1; s < (Number.isFinite(span) ? span : 1) && s < 20; s++) cells.push('');
          }
        }
        if (cells.length) rows.push(cells);
      } else if (['thead', 'tbody', 'tfoot'].includes(c.tag)) collectRows(c);
    }
  };
  collectRows(node);
  if (!rows.length) return caption ? `**${caption}**` : '';

  const cols = Math.max(...rows.map(r => r.length));
  const padRow = (r) => { while (r.length < cols) r.push(''); return r; };
  const line = (r) => `| ${padRow(r).join(' | ')} |`;
  const out = [];
  if (caption) out.push(`**${caption}**`, '');
  out.push(line(rows[0]));
  out.push(`|${' --- |'.repeat(cols)}`);
  for (const r of rows.slice(1)) out.push(line(r));
  return out.join('\n');
}

function renderBlock(node, ctx) {
  const tag = node.tag;
  const h = /^h([1-6])$/.exec(tag);
  if (h) {
    const text = renderInline(node.children, ctx).replace(/\s+/g, ' ').trim();
    return text ? `${'#'.repeat(parseInt(h[1], 10))} ${text}` : '';
  }
  switch (tag) {
    case 'p': case 'summary': case 'figcaption': case 'address': case 'dt':
      return renderInline(node.children, ctx).trim();
    case 'hr':
      return '---';
    case 'pre': {
      const code = node.children.find(c => c.type === 'element' && c.tag === 'code');
      const cls = (code ? code.attrs.class : node.attrs.class) || '';
      const langM = /(?:language|lang)-([\w#+-]+)/i.exec(cls);
      const body = rawText(node).replace(/^\n+|\s+$/g, '');
      if (!body) return '';
      // 本文に ``` が含まれていてもフェンスが壊れないよう長さを合わせる
      const runs = body.match(/`{3,}/g) || [];
      const fence = '`'.repeat(Math.max(3, ...runs.map(r => r.length + 1)));
      return `${fence}${langM ? langM[1].toLowerCase() : ''}\n${body}\n${fence}`;
    }
    case 'blockquote':
      return renderChildren(node.children, ctx)
        .split('\n').map(l => (l ? `> ${l}` : '>')).join('\n');
    case 'ul': case 'ol':
      return renderList(node, ctx);
    case 'table':
      return renderTable(node, ctx);
    case 'dl': {
      const parts = [];
      for (const c of node.children) {
        if (c.type !== 'element') continue;
        if (c.tag === 'dt') {
          const s = renderInline(c.children, ctx).trim();
          if (s) parts.push(`**${s}**`);
        } else if (c.tag === 'dd') {
          const s = renderChildren(c.children, ctx);
          if (s) parts.push(s.split('\n').map(l => (l ? `  ${l}` : '')).join('\n'));
        }
      }
      return parts.join('\n');
    }
    case 'li':   // リスト外に漏れた li (壊れたマークアップ)
      return `- ${renderChildren(node.children, ctx)}`;
    default:
      // div / section / article / figure / details 等の透過コンテナ
      return renderChildren(node.children, ctx);
  }
}

function toMarkdown(root, ctx) {
  return renderChildren(root.children, ctx).replace(/\n{3,}/g, '\n\n').trim();
}

// ════════════════════════════════════════════════════════════
// 変換パイプライン (パース → クリーニング → 本文選択 → Markdown)
// ════════════════════════════════════════════════════════════

/**
 * パース + クリーニング + 本文選択。ツリーを返す
 * (クロール時のリンク抽出や画像解析はこのツリーに対して行い、
 *  Markdown/HTML への描画は renderOutputs で最後にまとめて行う)
 */
function analyzeHtml(html, { dropBoilerplate = true, preferMainContent = true } = {}) {
  const { root, title } = parseHtml(html);

  const cleanedChildren = [];
  for (const c of root.children) cleanedChildren.push(...cleanNode(c, { dropBoilerplate }, false));
  let cleaned = { type: 'element', tag: '#root', attrs: {}, children: cleanedChildren };

  // 本文の選択: <main> / <article> があればそこだけを取り込む
  // (記事ページの「関連記事」「コメント欄」等が RAG を汚すのを防ぐ)。
  // 短すぎる main は「実は本文がその外にある」ページなので採用しない
  if (preferMainContent) {
    let candidates = findElements(cleaned, ['main']);
    if (!candidates.length) candidates = findElements(cleaned, ['article']);
    if (candidates.length) {
      const best = candidates.reduce((a, b) => (textLength(b) > textLength(a) ? b : a));
      if (textLength(best) >= 200) {
        cleaned = { type: 'element', tag: '#root', attrs: {}, children: [best] };
      }
    }
  }

  const h1 = findElements(cleaned, ['h1'])[0];
  const fallbackTitle = h1 ? rawText(h1).replace(/\s+/g, ' ').trim() : '';
  return { tree: cleaned, title: (title || fallbackTitle).slice(0, 200) };
}

/** クリーン済みツリー → 登録用の成果物 (クリーンHTML と Markdown) */
function renderOutputs(tree, { baseUrl = null } = {}) {
  return {
    cleanedHtml: serializeHtml(tree),
    markdown: toMarkdown(tree, { baseUrl }),
  };
}

/**
 * HTML文字列を処理して登録用の成果物を返す (analyzeHtml + renderOutputs の一括版)。
 * @returns {{ title, markdown, cleanedHtml, stats: {originalChars, cleanedChars, markdownChars} }}
 */
function processHtml(html, opts = {}) {
  const { tree, title } = analyzeHtml(html, opts);
  const { cleanedHtml, markdown } = renderOutputs(tree, opts);
  return {
    title,
    markdown,
    cleanedHtml,
    stats: {
      originalChars: html.length,
      cleanedChars: cleanedHtml.length,
      markdownChars: markdown.length,
    },
  };
}

// ════════════════════════════════════════════════════════════
// 1階層クロール (リンク収集・robots.txt) と 画像収集
// ════════════════════════════════════════════════════════════

/**
 * robots.txt の User-agent: * グループの Allow/Disallow を集める簡易パーサ。
 * ワイルドカード * と末尾アンカー $ (Google拡張) に対応。
 * 特定UA向けグループの解釈はしない (未知のクローラは * グループに従うのが慣例)
 */
function parseRobots(text) {
  const rules = [];
  let agents = [];
  let collecting = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      // ルールの後に来た User-agent は新しいグループの始まり
      if (!collecting) agents = [];
      collecting = true;
      agents.push(value.toLowerCase());
    } else if (key === 'allow' || key === 'disallow') {
      collecting = false;
      // 「Disallow: (空)」は全許可の意味なのでルールにしない
      if (agents.includes('*') && value) {
        rules.push({ allow: key === 'allow', path: value, re: robotsPathRe(value) });
      }
    } else {
      collecting = false;   // Crawl-delay / Sitemap 等はグループの区切りとして扱う
    }
  }
  return rules;
}

function robotsPathRe(pattern) {
  let p = pattern;
  const anchored = p.endsWith('$');
  if (anchored) p = p.slice(0, -1);
  const body = p.split('*')
    .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\S]*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/** パスがクロール可能か (最長一致。同長なら Allow 優先、ルール無し・不一致は許可) */
function robotsAllows(rules, path) {
  let best = null;
  for (const r of rules) {
    if (!r.re.test(path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow && !best.allow)) {
      best = r;
    }
  }
  return best ? best.allow : true;
}

/**
 * 起点ページのクリーン済みツリーから「同一オリジン・同一パス配下」のリンクを
 * 文書順で集める (1階層クロールの対象)。ページでないリソースは除外する。
 * @returns {{ links: string[], outOfScope: number }}
 */
function collectCrawlLinks(tree, startUrl) {
  const start = new URL(startUrl);
  // 「同一パス配下」= 起点URLのディレクトリ以下。/docs/guide/intro.html → /docs/guide/
  const basePath = start.pathname.endsWith('/')
    ? start.pathname
    : start.pathname.replace(/[^/]*$/, '');
  const startNorm = start.origin + start.pathname + start.search;
  const seen = new Set();
  const links = [];
  let outOfScope = 0;
  for (const a of findElements(tree, ['a'])) {
    const href = resolveHref(a.attrs.href, startUrl);
    if (!href) continue;
    let u;
    try { u = new URL(href); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    u.hash = '';
    // HTMLページでないものはクロール対象にしない (PDFはOCR画面の領分)
    if (/\.(png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|json|xml|rss|atom|zip|gz|tgz|7z|rar|pdf|docx?|xlsx?|pptx?|mp[34]|m4a|wav|webm|mov|wasm|woff2?|ttf|eot|exe|dmg|apk)$/i.test(u.pathname)) continue;
    const norm = u.origin + u.pathname + u.search;
    if (norm === startNorm || seen.has(norm)) continue;
    seen.add(norm);
    if (u.origin !== start.origin || !u.pathname.startsWith(basePath)) { outOfScope++; continue; }
    links.push(norm);
  }
  return { links, outOfScope };
}

/** ツリーから取得可能な (絶対URLに解決できる) 画像を文書順で集める */
function collectImages(tree, baseUrl) {
  const seen = new Set();
  const out = [];
  for (const img of findElements(tree, ['img'])) {
    const src = img.attrs.src;
    if (!src) continue;
    let abs = null;
    try {
      abs = baseUrl ? new URL(src, baseUrl).href : (/^https?:\/\//i.test(src) ? src : null);
    } catch {}
    if (!abs || !/^https?:\/\//i.test(abs)) continue;   // ローカルHTMLの相対srcは取得できない
    if (seen.has(abs)) continue;   // 同じ画像の再掲は最初の1回だけ解析すれば十分
    seen.add(abs);
    out.push({ node: img, url: abs, alt: (img.attrs.alt || '').trim() });
  }
  return out;
}

/** 先頭バイトから画像形式を判定 (Vision LLM 側の llama.cpp/stb_image が読める形式だけ通す) */
function sniffImageMime(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 6 && /^GIF8[79]a/.test(buf.toString('latin1', 0, 6))) return 'image/gif';
  if (buf.length > 2 && buf.toString('latin1', 0, 2) === 'BM') return 'image/bmp';
  return null;   // webp / avif / svg 等は Vision LLM が受け取れないのでスキップ
}

// ════════════════════════════════════════════════════════════
// URL 取得
// ════════════════════════════════════════════════════════════

/** ループバック・プライベート帯のIPリテラルか (blockPrivateHosts 用の簡易判定) */
function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [parseInt(v4[1], 10), parseInt(v4[2], 10)];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (h === '::1' || h === '::') return true;
  if (/^(fc|fd|fe8|fe9|fea|feb)/i.test(h) && h.includes(':')) return true;
  return false;
}

/** レスポンスボディをサイズ上限を守りながら読む (Content-Length は信用しない) */
async function readBodyCapped(resp, maxBytes, label) {
  const chunks = [];
  let bytes = 0;
  const reader = resp.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      try { reader.cancel(); } catch {}
      throw new Error(`${label}が大きすぎます (上限 ${Math.round(maxBytes / 1024 / 1024)} MB)`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Content-Type ヘッダ → 無ければ <meta charset> → 無ければ UTF-8 でデコード */
function decodeHtmlBuffer(buf, contentType) {
  let charset = (/charset\s*=\s*"?([\w.-]+)/i.exec(contentType || '') || [])[1] || '';
  if (!charset) {
    // メタタグは先頭付近にあるはずなので 4KB だけ ASCII として覗く
    const head = buf.toString('latin1', 0, Math.min(buf.length, 4096));
    charset = (/<meta[^>]+charset\s*=\s*["']?\s*([\w.-]+)/i.exec(head) || [])[1] || '';
  }
  charset = charset.toLowerCase().replace(/^x-/, '');
  if (/^(sjis|shift-jis|shift_jis|ms932|windows-31j)$/.test(charset)) charset = 'shift_jis';
  if (!charset || charset === 'utf8') charset = 'utf-8';
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return buf.toString('utf-8');   // 未知のcharsetは UTF-8 として読む
  }
}

// ════════════════════════════════════════════════════════════
// マネージャ (ジョブキュー + API)
// ════════════════════════════════════════════════════════════

/** ファイル名のサニタイズ。必ず .html で終わる名前を返す (ocr.js の sanitizePdfName と同型) */
function sanitizeHtmlName(name) {
  let base = path.basename(String(name || '').replace(/\\/g, '/'));
  base = base.replace(/\0/g, '').replace(/[\/\\:*?"<>|]/g, '_').replace(/[\r\n\t]/g, ' ').trim();
  base = base.replace(/^\.+/, '');
  if (!base) base = 'page.html';
  let stem = base.replace(/\.(html?|xhtml)$/i, '');
  if (!stem) stem = 'page';
  if (stem.length > 100) stem = stem.slice(0, 100);
  return `${stem}.html`;
}

/** URL から仮のジョブ名を作る (ページの <title> が取れたら差し替わる) */
function titleFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const tail = decodeURIComponent(u.pathname).replace(/\/+$/, '').split('/').pop() || '';
    const s = tail ? `${u.hostname} ${tail}` : u.hostname;
    return s.slice(0, 100);
  } catch {
    return String(rawUrl).slice(0, 100);
  }
}

/**
 * HTML/RAG マネージャを作る。
 *
 * @param {object}   deps
 * @param {function} deps.getConfig         () => appConfig.htmlRag
 * @param {string}   deps.baseDir           サーバーのルート (相対パス解決の基準)
 * @param {string}   deps.uploadsDir        public/uploads の絶対パス
 * @param {function} deps.log               (ip, message) => void
 * @param {function} [deps.ragIngestFile]   (filename) => Promise<{docId, chunkCount}>
 * @param {function} [deps.ragDeleteDoc]    (docId) => void
 * @param {function} [deps.ensureEmbedding] () => Promise<boolean>
 * @param {function} [deps.checkEmbedding]  () => {available, reason?}  UI警告用 (プロセス起動なし)
 * @param {object}   [deps.vlm]             画像の内容解析に使う Vision LLM (OCRと共用)
 *   check()   → Promise<{ok, message?}>                    利用可否 (設定・生存確認)
 *   acquire() → Promise<{endpoint, model, release()}>      確保 (使用後は必ず release)
 */
function createHtmlRagManager({
  getConfig,
  baseDir,
  uploadsDir,
  log = () => {},
  ragIngestFile = null,
  ragDeleteDoc = null,
  ensureEmbedding = null,
  checkEmbedding = null,
  vlm: vlmDep = null,
}) {
  const cfg = () => (getConfig() || {});
  const jobsFile = () => {
    const v = cfg().jobsFile || 'ml/htmlrag/jobs.json';
    return path.isAbsolute(v) ? v : path.join(baseDir, v);
  };

  const running = new Map();    // jobId → { cancelled, abort }
  const listeners = new Map();  // jobId → Set<fn>  (SSE配信)
  let jobs = [];
  let loaded = false;

  // ─── 永続化 ───────────────────────────────────────────────

  function ensureDirs() {
    try { fs.mkdirSync(path.dirname(jobsFile()), { recursive: true }); } catch {}
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
      log('-', `[HTML-RAG] jobs.json 読み込み失敗: ${e.message}`);
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
      log('-', `[HTML-RAG] jobs.json 保存失敗: ${e.message}`);
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
    const elapsedMs = job.startedAt
      ? ((job.status === 'running' ? Date.now() : (job.finishedAt || job.startedAt)) - job.startedAt)
      : 0;
    return {
      jobId: job.jobId,
      source: job.source,                    // 'upload' | 'url'
      url: job.url || null,
      filename: job.filename || null,        // uploads 内の元HTML
      mdFilename: job.mdFilename || null,    // uploads 内の登録済み成果物 (.md / .rag.html)
      title: job.title,
      sizeBytes: job.sizeBytes || 0,
      status: job.status,
      phase: job.phase || null,
      crawl: !!job.crawl,                    // リンク先も取り込むジョブか (1階層)
      pagesTotal: job.pagesTotal || 0,       // クロール時のページ進捗 (起点含む)
      pagesDone: job.pagesDone || 0,
      crawlInfo: job.crawlInfo || null,      // {linksFound, outOfScope, robotsBlocked, limitSkipped, errors}
      imagesTotal: job.imagesTotal || 0,     // 画像解析の進捗
      imagesDone: job.imagesDone || 0,
      imagesFailed: job.imagesFailed || 0,
      imageNote: job.imageNote || null,      // 画像解析をスキップした理由 (VLM未設定等)
      originalChars: job.originalChars || 0,
      cleanedChars: job.cleanedChars || 0,
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
    };
  }

  function setStatus(job, status, extra = {}) {
    job.status = status;
    Object.assign(job, extra);
    saveJobs();
    emitEvent(job.jobId, { type: 'status', job: jobView(job) });
  }

  // ─── URL 取得 ────────────────────────────────────────────

  async function fetchHtml(rawUrl, ctl) {
    const c = cfg();
    let u;
    try { u = new URL(rawUrl); } catch { throw new Error(`URLが不正です: ${rawUrl}`); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('http / https のURLのみ対応しています');
    if (c.blockPrivateHosts === true && isPrivateHost(u.hostname)) {
      throw new Error(`プライベートアドレスへの取得は禁止されています (${u.hostname})。許可する場合は htmlRag.blockPrivateHosts を false にしてください`);
    }

    const maxBytes = (parseInt(c.maxFetchMB) || 20) * 1024 * 1024;
    const timeoutMs = (parseInt(c.fetchTimeoutSec) || 60) * 1000;
    const controller = new AbortController();
    if (ctl) ctl.abort = controller;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(u.href, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          // 既定UAは bot 扱いで弾くサイトが多いので、Web検索機能と同じブラウザUAを名乗る
          'User-Agent': c.userAgent || DEFAULT_UA,
          'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        },
      });
      if (!resp.ok) throw new Error(`ページを取得できません (HTTP ${resp.status})`);
      const contentType = (resp.headers.get('content-type') || '').toLowerCase();
      const isHtml = /text\/html|application\/xhtml\+xml|\bxml\b/.test(contentType) || contentType === '';
      const isText = /^text\/(plain|markdown)/.test(contentType);
      if (!isHtml && !isText) {
        throw new Error(`HTML/テキスト以外のコンテンツです (Content-Type: ${contentType.split(';')[0] || '不明'})。PDFはOCR画面を使ってください`);
      }
      const buf = await readBodyCapped(resp, maxBytes, 'ページ');
      return {
        html: decodeHtmlBuffer(buf, contentType),
        finalUrl: resp.url || u.href,
        bytes: buf.length,
        isHtml,
      };
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new Error(ctl && ctl.cancelled ? 'キャンセルされました' : `ページ取得がタイムアウトしました (${timeoutMs / 1000}秒)`);
      }
      // undici は原因を cause に隠すので表に出す (ENOTFOUND 等)
      const cause = e.cause && e.cause.message ? ` (${e.cause.message})` : '';
      throw new Error(`ページ取得に失敗しました: ${e.message}${cause}`);
    } finally {
      clearTimeout(timer);
      if (ctl) ctl.abort = null;
    }
  }

  /** robots.txt を取得してルールにする。無い・読めない時は「制限なし」扱いで [] */
  async function fetchRobotsRules(origin, ctl) {
    const controller = new AbortController();
    if (ctl) ctl.abort = controller;
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const resp = await fetch(`${origin}/robots.txt`, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': cfg().userAgent || DEFAULT_UA },
      });
      if (!resp.ok) return [];
      const text = await resp.text();
      return parseRobots(text.slice(0, 512 * 1024));
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
      if (ctl) ctl.abort = null;
    }
  }

  /** 画像を1枚取得する。小さすぎる (アイコン等)・大きすぎる・未対応形式は例外でスキップさせる */
  async function fetchImage(url, ctl) {
    const c = cfg();
    const maxBytes = (parseInt(c.imageMaxMB) || 8) * 1024 * 1024;
    const minRaw = parseInt(c.imageMinKB);
    const minBytes = (Number.isFinite(minRaw) ? Math.max(0, minRaw) : 10) * 1024;
    const controller = new AbortController();
    if (ctl) ctl.abort = controller;
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const resp = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': c.userAgent || DEFAULT_UA, 'Accept': 'image/*' },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await readBodyCapped(resp, maxBytes, '画像');
      // Content-Type は octet-stream や誤設定が多いので、先頭バイトで形式を確定する
      const mime = sniffImageMime(buf);
      if (!mime) throw new Error('Vision LLM が未対応の画像形式 (png/jpeg/gif/bmp のみ)');
      if (buf.length < minBytes) throw new Error(`小さすぎる画像のためスキップ (${Math.round(buf.length / 1024)}KB < ${Math.round(minBytes / 1024)}KB)`);
      return { buf, mime };
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new Error(ctl && ctl.cancelled ? 'キャンセルされました' : '画像取得タイムアウト (30秒)');
      }
      throw e;
    } finally {
      clearTimeout(timer);
      if (ctl) ctl.abort = null;
    }
  }

  /** Vision LLM に画像を渡して説明・文字起こしを得る (OCRの ocrImage と同じ呼び方) */
  async function describeImage(vlmHandle, image, ctl) {
    const c = cfg();
    const controller = new AbortController();
    if (ctl) ctl.abort = controller;
    const timeoutMs = (parseInt(c.imageTimeoutSec) || 180) * 1000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(vlmHandle.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: vlmHandle.model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: c.imagePrompt || DEFAULT_IMAGE_PROMPT },
              { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.buf.toString('base64')}` } },
            ],
          }],
          max_tokens: parseInt(c.imageMaxTokens) || 1024,
          temperature: 0.1,
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        throw new Error(`Vision LLM エラー (${resp.status}): ${t.slice(0, 200)}`);
      }
      const data = await resp.json();
      let content = data?.choices?.[0]?.message?.content;
      if (Array.isArray(content)) {
        content = content.map(p => (typeof p === 'string' ? p : (p?.text || ''))).join('');
      }
      if (typeof content !== 'string') throw new Error('Vision LLM のレスポンス形式が不正です');
      // thinkタグと全体を包むコードフェンスの除去 (ocr.js の cleanupMarkdown と同じ方針)
      let s = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      const fence = s.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
      if (fence) s = fence[1].trim();
      return s.slice(0, 4000);
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new Error(ctl && ctl.cancelled ? 'キャンセルされました' : `画像解析タイムアウト (${timeoutMs / 1000}秒)`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
      if (ctl) ctl.abort = null;
    }
  }

  // ─── ジョブ実行 ──────────────────────────────────────────

  async function processJob(job) {
    const c = cfg();
    const ctl = { cancelled: false, abort: null };
    running.set(job.jobId, ctl);
    // 画像解析用の Vision LLM。使う間だけ確保し、finally で必ず返す
    let vlm = null;

    const analyzeOpts = {
      dropBoilerplate: c.dropBoilerplate !== false,
      preferMainContent: c.preferMainContent !== false,
    };

    try {
      job.startedAt = Date.now();
      job.finishedAt = null;
      job.interrupted = false;
      job.error = null;
      job.pagesTotal = 0;
      job.pagesDone = 0;
      job.imagesTotal = 0;
      job.imagesDone = 0;
      job.imagesFailed = 0;
      job.imageNote = null;
      job.crawlInfo = null;

      // ── 1. 起点ページの入手 (URL取得 or アップロード済みファイル) ──
      // pages[0] が起点で、クロール時はリンク先が後ろに増える。
      // plain はテキスト直登録 (URLが text/plain だった時) で、tree を持たない
      const pages = [];   // [{ url, title, tree, plain, rawLen }]
      let rawStartHtml = null;

      if (job.source === 'url') {
        setStatus(job, 'running', { phase: 'fetch' });
        const r = await fetchHtml(job.url, ctl);
        if (ctl.cancelled) throw new Error('__CANCELLED__');
        job.sizeBytes = r.bytes;
        log('-', `[HTML-RAG] 取得: ${job.url} (${humanBytes(r.bytes)})`);
        if (!r.html || !r.html.trim()) throw new Error('コンテンツが空です');
        if (!r.isHtml) {
          pages.push({ url: r.finalUrl, title: '', tree: null, plain: r.html, rawLen: r.html.length });
        } else {
          rawStartHtml = r.html;
          setStatus(job, 'running', { phase: 'clean' });
          const a = analyzeHtml(r.html, analyzeOpts);
          pages.push({ url: r.finalUrl, title: a.title, tree: a.tree, plain: null, rawLen: r.html.length });
        }
      } else {
        setStatus(job, 'running', { phase: 'clean' });
        const abs = path.join(uploadsDir, job.filename);
        if (!fs.existsSync(abs)) throw new Error(`HTMLファイルが見つかりません: ${job.filename}`);
        const html = fs.readFileSync(abs, 'utf-8');
        if (!html.trim()) throw new Error('コンテンツが空です');
        const a = analyzeHtml(html, analyzeOpts);
        pages.push({ url: null, title: a.title, tree: a.tree, plain: null, rawLen: html.length });
      }
      const startPage = pages[0];

      // タイトル確定 (URLジョブはページの <title> を採用。ユーザー指定があればそちら優先)
      if (!job.titleLocked && startPage.title) {
        job.title = startPage.title.replace(/[\r\n\t]/g, ' ').trim().slice(0, 120) || job.title;
      }

      // URLジョブの元HTML保存 (初回に保存名を確定し、再実行では同じ名前へ上書き)
      if (job.source === 'url' && c.keepHtml !== false && rawStartHtml !== null) {
        if (!job.filename) {
          job.filename = uniqueName(uploadsDir, sanitizeHtmlName(job.title));
          saveJobs();
        }
        fs.writeFileSync(path.join(uploadsDir, job.filename), rawStartHtml, 'utf-8');
      }

      // ── 2. 1階層クロール (オプトイン。同一パス配下のリンクだけ辿る) ──
      job.pagesTotal = 1;
      job.pagesDone = 1;
      if (job.crawl && job.source === 'url' && c.crawlEnabled !== false && startPage.tree) {
        setStatus(job, 'running', { phase: 'crawl' });
        const maxPages = Math.min(Math.max(parseInt(c.crawlMaxPages) || 20, 1), 200);
        const { links, outOfScope } = collectCrawlLinks(startPage.tree, startPage.url);

        // robots.txt はクロールする時だけ読む (起点ページはユーザーの明示指定なので対象外)
        let robotsRules = [];
        if (c.crawlRespectRobots !== false) {
          robotsRules = await fetchRobotsRules(new URL(startPage.url).origin, ctl);
        }
        if (ctl.cancelled) throw new Error('__CANCELLED__');
        const allowed = [];
        let robotsBlocked = 0;
        for (const l of links) {
          const u = new URL(l);
          if (robotsRules.length && !robotsAllows(robotsRules, u.pathname + u.search)) robotsBlocked++;
          else allowed.push(l);
        }
        const planned = allowed.slice(0, maxPages - 1);
        job.crawlInfo = {
          linksFound: links.length,
          outOfScope,
          robotsBlocked,
          limitSkipped: allowed.length - planned.length,
          errors: [],
        };
        job.pagesTotal = 1 + planned.length;
        saveJobs();
        emitEvent(job.jobId, { type: 'status', job: jobView(job) });
        log('-', `[HTML-RAG] クロール計画: ${job.title} (リンク${links.length}件 → 取得${planned.length}件、範囲外${outOfScope}、robots除外${robotsBlocked}、上限超過${job.crawlInfo.limitSkipped})`);

        const dRaw = parseInt(c.crawlDelayMs);
        const delayMs = Number.isFinite(dRaw) ? Math.max(0, dRaw) : 1000;
        for (const url of planned) {
          if (ctl.cancelled) throw new Error('__CANCELLED__');
          // 取得間隔 (相手サイトへの負荷配慮)。キャンセルは直後の判定で拾う
          if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
          if (ctl.cancelled) throw new Error('__CANCELLED__');
          try {
            const r = await fetchHtml(url, ctl);
            if (!r.isHtml) throw new Error('HTMLではないコンテンツ');
            const a = analyzeHtml(r.html, analyzeOpts);
            pages.push({ url: r.finalUrl, title: a.title, tree: a.tree, plain: null, rawLen: r.html.length });
            job.sizeBytes += r.bytes;
          } catch (e) {
            if (ctl.cancelled) throw new Error('__CANCELLED__');
            // 1ページの失敗でジョブは止めない (OCRの失敗ページと同じ方針)
            if (job.crawlInfo.errors.length < 10) {
              job.crawlInfo.errors.push({ url, error: String(e.message || e).slice(0, 200) });
            }
            log('-', `[HTML-RAG] リンク先スキップ (${url}): ${e.message}`);
          }
          job.pagesDone++;
          saveJobs();
          emitEvent(job.jobId, { type: 'status', job: jobView(job) });
        }
      }

      // ── 3. 画像の内容解析 (OCRと同じ Vision LLM で説明・文字起こし) ──
      // モデルは ocr.vlmPoolModel / ocr.vlmEndpoint の設定を共用する。
      // Vision LLM が未設定・停止中でもジョブは止めず、スキップ理由を記録する
      if (c.describeImages !== false && vlmDep) {
        const ppRaw = parseInt(c.imageMaxPerPage);
        const perPage = Number.isFinite(ppRaw) ? Math.max(0, ppRaw) : 8;
        const seenImg = new Set();   // 同じ画像がページをまたいで再掲されても1回だけ
        const targets = [];
        for (const p of pages) {
          if (!p.tree || perPage === 0) continue;
          let n = 0;
          for (const t of collectImages(p.tree, p.url)) {
            if (n >= perPage) break;
            if (seenImg.has(t.url)) continue;
            seenImg.add(t.url);
            targets.push(t);
            n++;
          }
        }
        job.imagesTotal = targets.length;
        if (targets.length > 0) {
          const chk = await vlmDep.check();
          if (ctl.cancelled) throw new Error('__CANCELLED__');
          if (!chk.ok) {
            job.imageNote = `画像解析をスキップ: ${chk.message || 'Vision LLM が利用できません'}`;
            log('-', `[HTML-RAG] ${job.imageNote}`);
          } else {
            setStatus(job, 'running', { phase: 'images' });
            vlm = await vlmDep.acquire();
            for (const t of targets) {
              if (ctl.cancelled) throw new Error('__CANCELLED__');
              try {
                const img = await fetchImage(t.url, ctl);
                const desc = await describeImage(vlm, img, ctl);
                if (desc) t.node.attrs['data-description'] = desc;
                job.imagesDone++;
              } catch (e) {
                if (ctl.cancelled) throw new Error('__CANCELLED__');
                job.imagesFailed++;
                log('-', `[HTML-RAG] 画像スキップ (${t.url}): ${e.message}`);
              }
              saveJobs();
              emitEvent(job.jobId, { type: 'status', job: jobView(job) });
            }
            // 出力の組み立てとRAG登録では使わないので、ここで返してVRAMを空ける
            vlm.release();
            vlm = null;
            log('-', `[HTML-RAG] 画像解析: ${job.imagesDone}/${job.imagesTotal}件 (失敗${job.imagesFailed})`);
          }
        }
      }
      if (ctl.cancelled) throw new Error('__CANCELLED__');

      // ── 4. 出力の組み立てと書き出し ──
      setStatus(job, 'running', { phase: 'merge' });
      const sections = [];
      let originalChars = 0;
      let cleanedChars = 0;
      for (const p of pages) {
        originalChars += p.rawLen;
        if (p.plain !== null) {
          cleanedChars += p.rawLen;
          sections.push({ url: p.url, title: p.title, markdown: p.plain.trim(), cleanedHtml: null });
        } else {
          const o = renderOutputs(p.tree, { baseUrl: p.url });
          cleanedChars += o.cleanedHtml.length;
          sections.push({ url: p.url, title: p.title, markdown: o.markdown, cleanedHtml: o.cleanedHtml });
        }
      }
      if (!sections.some(s => s.markdown.trim())) {
        throw new Error('本文を抽出できませんでした (JavaScriptで描画されるページの可能性があります。ブラウザで保存したHTMLをアップロードしてください)');
      }

      const format = c.registerFormat === 'html' ? 'html' : 'markdown';
      if (!job.mdFilename) {
        const stem = (job.filename ? job.filename.replace(/\.(html?|xhtml)$/i, '') : sanitizeHtmlName(job.title).replace(/\.html$/i, ''));
        job.mdFilename = uniqueName(uploadsDir, format === 'html' ? `${stem}.rag.html` : `${stem}.md`);
        saveJobs();
      }
      let output;
      if (format === 'html' && sections.every(s => s.cleanedHtml !== null)) {
        // 論文に忠実なモード: クリーン済みHTMLをそのまま登録 (出典コメント付き)
        output = sections.map(s => (s.url ? `<!-- source: ${s.url} -->\n` : '') + s.cleanedHtml).join('\n');
      } else {
        const parts = [];
        const head = [`# ${job.title}`];
        if (job.url) head.push(`> 出典: ${job.url} (取得日時: ${new Date().toLocaleString('ja-JP')})`);
        if (sections.length > 1) head.push(`> リンク先 ${sections.length - 1}ページを含む (同一パス配下・1階層)`);
        parts.push(head.join('\n\n'));
        parts.push(sections[0].markdown);
        // リンク先ページは出典コメント付きのセクションとして続ける
        // (チャンクの近くに出典が残るので、チャットの回答から元ページを辿れる)
        for (const s of sections.slice(1)) {
          parts.push(['---', `<!-- source: ${s.url} -->`, `# ${s.title || s.url}`, `> 出典: ${s.url}`, s.markdown].join('\n\n'));
        }
        output = parts.join('\n\n') + '\n';
      }
      fs.writeFileSync(path.join(uploadsDir, job.mdFilename), output, 'utf-8');
      job.originalChars = originalChars;
      job.cleanedChars = cleanedChars;
      job.charCount = output.length;
      saveJobs();
      const pct = originalChars > 0 ? Math.round((cleanedChars / originalChars) * 100) : 100;
      log('-', `[HTML-RAG] クリーニング: ${job.title} (${sections.length}ページ、${originalChars.toLocaleString()}文字 → ${cleanedChars.toLocaleString()}文字 = ${pct}%)`);

      // ── 5. RAG 登録 ──
      if (c.autoRegisterToRag !== false && ragIngestFile) {
        setStatus(job, 'running', { phase: 'rag' });
        try {
          if (ensureEmbedding) await ensureEmbedding();
          const r = await ragIngestFile(job.mdFilename);
          job.ragDocId = r.docId;
          job.ragChunkCount = r.chunkCount;
          job.ragError = null;
          log('-', `[HTML-RAG] RAG登録: ${job.mdFilename} (docId=${r.docId}, ${r.chunkCount}チャンク)`);
        } catch (e) {
          // 登録に失敗しても成果物は残っているのでジョブ自体は成功扱い (OCRと同じ方針)
          job.ragError = e.message;
          log('-', `[HTML-RAG] RAG登録失敗: ${job.mdFilename} - ${e.message}`);
        }
      }

      setStatus(job, 'completed', { phase: null, finishedAt: Date.now() });
      log('-', `[HTML-RAG] 完了: ${job.title} (${Math.round((job.finishedAt - job.startedAt) / 1000)}秒)`);
      emitEvent(job.jobId, { type: 'done', job: jobView(job) });
    } catch (e) {
      if (e.message === '__CANCELLED__' || ctl.cancelled) {
        setStatus(job, 'cancelled', { phase: null, finishedAt: Date.now() });
        log('-', `[HTML-RAG] キャンセル: ${job.title}`);
        emitEvent(job.jobId, { type: 'done', job: jobView(job) });
      } else {
        setStatus(job, 'failed', { phase: null, finishedAt: Date.now(), error: e.message });
        log('-', `[HTML-RAG] 失敗: ${job.title} - ${e.message}`);
        emitEvent(job.jobId, { type: 'error', message: e.message, job: jobView(job) });
      }
    } finally {
      // 失敗・キャンセルで抜けた場合も Vision LLM を必ず返す
      if (vlm) { vlm.release(); vlm = null; }
      running.delete(job.jobId);
      pump();
    }
  }

  /** 空きスロットぶんだけ queued ジョブを走らせる */
  function pump() {
    const max = Math.max(1, parseInt(cfg().maxConcurrentJobs) || 2);
    if (running.size >= max) return;
    const next = loadJobs().filter(j => j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
    for (const job of next) {
      if (running.size >= max) break;
      if (running.has(job.jobId)) continue;
      processJob(job);   // 自前で例外を握るので await 不要
    }
  }

  // ─── 公開 API ────────────────────────────────────────────

  function isEnabled() {
    return cfg().enabled !== false;
  }

  function newJobId() {
    return `hrag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * HTMLファイルのアップロード受信 → ジョブ登録。
   * multipart/form-data でも、Content-Type: text/html の生ボディでも受ける
   * (後者は ?name= か X-Filename でファイル名を渡す)
   */
  async function receiveUpload(req, { ip = '-' } = {}) {
    ensureDirs();
    const c = cfg();
    const maxBytes = (parseInt(c.maxUploadMB) || 20) * 1024 * 1024;

    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (declared && declared > maxBytes + 65536) {
      const err = new Error(`ファイルが大きすぎます (${humanBytes(declared)} / 上限 ${c.maxUploadMB || 20} MB)`);
      err.status = 413;
      throw err;
    }

    const tmpPath = path.join(uploadsDir, `.htmlrag_upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.part`);
    let originalName = '';
    let bytes = 0;

    const ct = req.headers['content-type'] || '';
    if (ct.startsWith('multipart/form-data')) {
      const r = await receiveMultipartToFile(req, { maxBytes, destPath: tmpPath });
      originalName = r.file.filename;
      bytes = r.file.bytes;
    } else {
      originalName = String(req.query?.name || req.headers['x-filename'] || 'page.html');
      bytes = await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(tmpPath);
        let total = 0;
        let failed = false;
        const fail = (err) => {
          if (failed) return;
          failed = true;
          try { req.destroy(); } catch {}
          try { ws.destroy(); } catch {}
          try { fs.unlinkSync(tmpPath); } catch {}
          reject(err);
        };
        req.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxBytes) return fail(new Error(`ファイルが大きすぎます (上限 ${Math.round(maxBytes / 1024 / 1024)} MB)`));
          if (!ws.write(chunk)) { req.pause(); ws.once('drain', () => { if (!failed) req.resume(); }); }
        });
        req.on('end', () => { if (!failed) ws.end(() => resolve(total)); });
        req.on('error', fail);
        ws.on('error', fail);
      });
    }

    const cleanup = () => { try { fs.unlinkSync(tmpPath); } catch {} };
    try {
      if (bytes === 0) { const e = new Error('ファイルが空です'); e.status = 400; throw e; }
      if (!/\.(html?|xhtml)$/i.test(originalName)) {
        const e = new Error('HTML ファイル (.html / .htm) のみアップロードできます');
        e.status = 400; throw e;
      }
      // 中身の確認 (先頭4KBにタグらしきものが1つも無ければHTMLではない)
      const head = Buffer.alloc(Math.min(4096, bytes));
      const fd = fs.openSync(tmpPath, 'r');
      try { fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
      if (!/<[!a-zA-Z]/.test(head.toString('utf-8'))) {
        const e = new Error('HTML ファイルではないようです (タグが見つかりません)');
        e.status = 400; throw e;
      }

      const filename = uniqueName(uploadsDir, sanitizeHtmlName(originalName));
      fs.renameSync(tmpPath, path.join(uploadsDir, filename));

      const job = {
        jobId: newJobId(),
        source: 'upload',
        url: null,
        crawl: false,
        filename,
        mdFilename: null,
        title: filename.replace(/\.(html?|xhtml)$/i, ''),
        titleLocked: false,
        sizeBytes: bytes,
        status: 'pending',
        phase: null,
        originalChars: 0,
        cleanedChars: 0,
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
      log(ip, `[HTML-RAG] アップロード: ${filename} (${humanBytes(bytes)})`);
      return jobView(job);
    } catch (e) {
      cleanup();
      throw e;
    }
  }

  /** URL からの取り込みジョブを登録する (取得は startJob → processJob で行う) */
  function addUrlJob(rawUrl, { title = '', crawl = false, ip = '-' } = {}) {
    const c = cfg();
    if (c.allowUrlFetch === false) {
      const e = new Error('URLからの取り込みは無効です (config.json の htmlRag.allowUrlFetch)');
      e.status = 403; throw e;
    }
    let u;
    try { u = new URL(String(rawUrl || '').trim()); }
    catch { const e = new Error('URLが不正です'); e.status = 400; throw e; }
    if (!/^https?:$/.test(u.protocol)) {
      const e = new Error('http / https のURLのみ対応しています'); e.status = 400; throw e;
    }

    const userTitle = String(title || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 120);
    const job = {
      jobId: newJobId(),
      source: 'url',
      url: u.href,
      // リンク先の同時取り込み (同一パス配下・1階層)。再取り込みでも引き継がれる
      crawl: crawl === true && c.crawlEnabled !== false,
      filename: null,        // ページの <title> が分かった時点で命名する
      mdFilename: null,
      title: userTitle || titleFromUrl(u.href),
      titleLocked: !!userTitle,
      sizeBytes: 0,
      status: 'pending',
      phase: null,
      originalChars: 0,
      cleanedChars: 0,
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
    log(ip, `[HTML-RAG] URL登録: ${u.href}`);
    return jobView(job);
  }

  function listJobs() {
    return loadJobs().map(jobView);
  }

  function getJob(jobId) {
    return jobView(findJob(jobId));
  }

  /**
   * ジョブを実行キューに載せる。redo=true なら完了済みでも走らせる
   * (URLジョブはページを取得し直すので、更新されたページの再取り込みに使える)
   */
  function startJob(jobId, { redo = false } = {}) {
    const job = findJob(jobId);
    if (!job) { const e = new Error('ジョブが見つかりません'); e.status = 404; throw e; }
    if (ACTIVE_STATUSES.includes(job.status)) {
      const e = new Error('このジョブは既に実行中です'); e.status = 409; throw e;
    }
    if (job.status === 'completed' && !redo) {
      const e = new Error('このジョブは完了済みです。取り込み直す場合は「再取り込み」を使ってください'); e.status = 409; throw e;
    }
    if (job.source === 'url' && cfg().allowUrlFetch === false) {
      const e = new Error('URLからの取り込みは無効です (config.json の htmlRag.allowUrlFetch)'); e.status = 403; throw e;
    }
    if (redo) log('-', `[HTML-RAG] 再取り込み: ${job.title}`);
    setStatus(job, 'queued', { error: null, interrupted: false });
    pump();
    return jobView(job);
  }

  /** 実行中ジョブの中断 (URL取得中なら fetch を abort する) */
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
    } else {
      setStatus(job, 'cancelled', { phase: null, finishedAt: Date.now() });
    }
    return jobView(job);
  }

  /** ジョブ削除 (元HTML・成果物・RAG登録をまとめて片付ける) */
  function deleteJob(jobId, { keepFiles = false } = {}) {
    const job = findJob(jobId);
    if (!job) { const e = new Error('ジョブが見つかりません'); e.status = 404; throw e; }
    if (ACTIVE_STATUSES.includes(job.status)) {
      const e = new Error('実行中のジョブは削除できません。先にキャンセルしてください'); e.status = 409; throw e;
    }
    if (!keepFiles) {
      if (job.filename) { try { fs.unlinkSync(path.join(uploadsDir, job.filename)); } catch {} }
      if (job.mdFilename) { try { fs.unlinkSync(path.join(uploadsDir, job.mdFilename)); } catch {} }
      if (job.ragDocId && ragDeleteDoc) { try { ragDeleteDoc(job.ragDocId); } catch {} }
    }
    jobs = loadJobs().filter(j => j.jobId !== jobId);
    saveJobs();
    emitEvent(jobId, { type: 'deleted', jobId });
    listeners.delete(jobId);
    return { ok: true };
  }

  /** 起動時の復元。実行中のまま落ちたジョブは「待機中」に戻す */
  function restoreOnBoot() {
    ensureDirs();
    const list = loadJobs();
    let n = 0;
    for (const job of list) {
      if (ACTIVE_STATUSES.includes(job.status)) {
        job.status = 'pending';
        job.phase = null;
        job.interrupted = true;
        job.startedAt = null;
        job.finishedAt = null;
        n++;
      }
    }
    if (n > 0) {
      saveJobs();
      log('-', `[HTML-RAG] 再起動により中断された ${n} 件のジョブを待機中に戻しました`);
    }
    return n;
  }

  /** UI 用のステータス (機能ON/OFF・URL取得可否・embedding・クロール・画像解析の有無) */
  async function health() {
    const c = cfg();
    const imagesEnabled = c.describeImages !== false;
    // 画像解析に使う Vision LLM の利用可否 (OCRと同じ設定を共用)
    let imagesVlm = null;
    if (imagesEnabled) {
      if (!vlmDep) {
        imagesVlm = { ok: false, message: 'Vision LLM が構成されていません' };
      } else {
        try { imagesVlm = await vlmDep.check(); }
        catch (e) { imagesVlm = { ok: false, message: e.message }; }
      }
    }
    const mpRaw = parseInt(c.crawlMaxPages);
    const dRaw = parseInt(c.crawlDelayMs);
    return {
      enabled: isEnabled(),
      allowUrlFetch: c.allowUrlFetch !== false,
      maxUploadMB: parseInt(c.maxUploadMB) || 20,
      maxFetchMB: parseInt(c.maxFetchMB) || 20,
      registerFormat: c.registerFormat === 'html' ? 'html' : 'markdown',
      autoRegisterToRag: c.autoRegisterToRag !== false,
      embedding: checkEmbedding ? checkEmbedding() : { available: true },
      crawl: {
        enabled: c.crawlEnabled !== false,
        maxPages: Number.isFinite(mpRaw) ? Math.min(Math.max(mpRaw, 1), 200) : 20,
        delayMs: Number.isFinite(dRaw) ? Math.max(0, dRaw) : 1000,
        respectRobots: c.crawlRespectRobots !== false,
      },
      images: {
        enabled: imagesEnabled,
        vlm: imagesVlm,
      },
      runningCount: running.size,
    };
  }

  return {
    isEnabled,
    health,
    receiveUpload,
    addUrlJob,
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
  createHtmlRagManager,
  // 以下はテスト用に公開 (単体で HTML → Markdown 変換や robots 判定を確認できる)
  processHtml,
  parseHtml,
  sanitizeHtmlName,
  parseRobots,
  robotsAllows,
};
