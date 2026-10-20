/**
 * jsx_loader.js — .jsx を変換してキャッシュし、実行するローダー
 *
 * <script type="text/babel" src="..."> に任せると、Babel Standalone は既定で
 * react + env プリセットとインラインソースマップ付きで毎回変換する。600KB 級の
 * index.jsx では env (ES5 への書き戻し) だけで 10 秒前後かかり、その間は画面が
 * 真っ黒のままになっていた。対応ブラウザはすべて ES2020 以降を解釈できるので、
 * ここでは JSX だけを変換し (react プリセットのみ)、結果を IndexedDB に保存する。
 * 2回目以降は .jsx の内容が変わっていなければ変換も Babel のダウンロードも省く。
 *
 * 使い方: <script src="/js/jsx_loader.js" data-src="/js/index.jsx"></script>
 *   ページ側の #root 内に .boot-loading / .boot-loading-text があれば、
 *   進み具合やエラーをそこに表示する (React の描画で置き換わる)。
 */
(function () {
  'use strict';

  var BABEL_URL = 'https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.9/babel.min.js';
  // 変換方法を変えたらここを上げて、古いキャッシュを使わないようにする
  var CACHE_VERSION = 'v1|babel-7.23.9|react';
  var DB_NAME = 'ogc-jsx-cache';
  var STORE = 'code';

  var self = document.currentScript;
  var src = self && self.getAttribute('data-src');
  if (!src) return;

  function setStatus(text, isError) {
    var el = document.querySelector('.boot-loading-text');
    if (!el) return;
    el.textContent = text;
    if (isError) el.parentNode.classList.add('boot-loading-error');
  }

  // 内容のハッシュ (FNV-1a 32bit)。暗号用途ではなく変更検知だけなので十分。
  // crypto.subtle は HTTP (非セキュアコンテキスト) で使えないため自前で計算する
  function hash(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16) + ':' + str.length;
  }

  // ─── IndexedDB (localStorage は容量が小さくアプリ本体と取り合うので使わない) ───
  // プライベートモード等で使えない時はキャッシュなしで動く
  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('IndexedDB なし'));
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function dbGet(db, key) {
    return new Promise(function (resolve, reject) {
      var req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function dbPut(db, key, value) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  function loadBabel() {
    if (window.Babel) return Promise.resolve(window.Babel);
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = BABEL_URL;
      s.onload = function () { resolve(window.Babel); };
      s.onerror = function () { reject(new Error('Babel の読み込みに失敗しました (' + BABEL_URL + ')')); };
      document.head.appendChild(s);
    });
  }

  function run(code) {
    var el = document.createElement('script');
    // 従来 (env プリセット) の出力と同じく strict モードで実行する
    el.text = '"use strict";\n' + code + '\n//# sourceURL=' + src;
    // 実行時の例外は window の error イベントにしか来ないので、その間だけ拾って画面に出す
    // (挿入した script は appendChild の中で同期的に実行される)
    function onError(ev) { setStatus('画面の起動に失敗しました: ' + ev.message, true); }
    window.addEventListener('error', onError);
    document.head.appendChild(el);
    window.removeEventListener('error', onError);
  }

  // 本体の取得とキャッシュの読み出しは並行して進める
  var dbPromise = openDb().catch(function () { return null; });
  var srcPromise = fetch(src, { cache: 'no-cache', credentials: 'same-origin' }).then(function (res) {
    if (!res.ok) throw new Error(src + ' の取得に失敗しました (HTTP ' + res.status + ')');
    return res.text();
  });

  Promise.all([srcPromise, dbPromise]).then(function (r) {
    var text = r[0], db = r[1];
    var key = CACHE_VERSION + '|' + hash(text);
    var cached = db ? dbGet(db, src).catch(function () { return null; }) : Promise.resolve(null);
    return cached.then(function (entry) {
      if (entry && entry.key === key) return entry.code;
      setStatus('画面を準備しています… (更新後の初回のみ数秒かかります)');
      return loadBabel().then(function (Babel) {
        var code = Babel.transform(text, { presets: ['react'], filename: src }).code;
        if (db) dbPut(db, src, { key: key, code: code }).catch(function () {});
        return code;
      });
    });
  }).then(run).catch(function (e) {
    console.error('[jsx_loader]', e);
    setStatus('読み込みに失敗しました: ' + (e && e.message ? e.message : e) + ' — 再読み込みしてください', true);
  });
})();
