#!/usr/bin/env python3
"""
vjepa2_server.py — V-JEPA 2 エンコーダの常駐ワーカー (Phase 3)

V-JEPA 2 の重みをメモリ (VRAM) に載せたまま保持し、観測 → 埋め込みの変換を
localhost HTTP で提供する。狙いは「毎回 1.3GB のモデルを読み直す」のをやめること。

  これまで: /policy を1回叩くたびに python 起動 + ViT-L ロード = 30秒〜
  これから: 常駐ワーカーに投げる = 数十ミリ秒〜

構造は rl_online_server.py / transcribe-server.py に倣い、stdlib http.server のみで実装する。
Node.js (server.js) から localhost 経由で呼ばれる想定。

使い方:
    python3 vjepa2_server.py [PORT]
デフォルトポート: 11601

環境変数:
    VJEPA2_CACHE_DIR  埋め込みキャッシュのルート (既定: <repo>/ml/vjepa2_cache)
    VJEPA2_BASE_DIR   観測パスの基点。この外を指すパスは拒否 (既定: <repo>/public/uploads)
    VJEPA2_DEVICE     cuda / cpu (既定: 自動)
    VJEPA2_MAX_ENCODERS  同時に保持するエンコーダ数 (既定: 1。VRAM 節約)

API (すべて JSON, localhost 内部用):
    GET  /health                    -> {status, device, loaded[], cacheDir}
    POST /embed  {paths[], spec?}   -> {embeddings[][], embDim, hit, miss}
        観測ファイル/ディレクトリのパスから埋め込みを作る。ディスクキャッシュを使う。
    POST /embed_frames {frames[], spec?} -> {embedding[], embDim}
        base64 (または data URL) のフレーム列を直接エンコードする。
        ロボットやゲームからその場のフレームを送る用途。キャッシュはしない。
    POST /unload {spec?}            -> エンコーダを解放して VRAM を返す
    POST /status                    -> ロード済みエンコーダの一覧
    POST /plan {name, frames?|framePath?, goalFrames?|goalPath?, horizon?, samples?, iterations?}
        世界モデル (V-JEPA 2-AC) で「ゴール画像に近づく行動系列」を CEM で探索する。
        現在の観測とゴールをエンコードし、predictor の潜在ロールアウトで候補を採点する。
        predictor は小さい (残差MLP) ので CPU で回し、VRAM はエンコーダ分しか使わない。
"""
import base64
import binascii
import io
import json
import logging
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vjepa2_common as vj
import vjepa2_ac_common as ac

DEFAULT_PORT = 11601
_REPO = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.environ.get('VJEPA2_CACHE_DIR', os.path.join(_REPO, 'ml', 'vjepa2_cache'))
BASE_DIR = os.environ.get('VJEPA2_BASE_DIR', os.path.join(_REPO, 'public', 'uploads'))
DEVICE = os.environ.get('VJEPA2_DEVICE') or None
MAX_ENCODERS = max(1, int(os.environ.get('VJEPA2_MAX_ENCODERS', '1')))
# 世界モデル (V-JEPA 2-AC) の保存先。/plan で名前指定して読む
AC_MODELS_DIR = os.environ.get('VJEPA2_AC_DIR', os.path.join(_REPO, 'ml', 'ac_models'))

# リクエストボディの上限 (フレームを base64 で送ると膨らむため広めに取る)
MAX_BODY_BYTES = 64 * 1024 * 1024
MAX_FRAMES_PER_REQUEST = 128
MAX_PATHS_PER_REQUEST = 512

logging.basicConfig(
    level=logging.INFO,
    format='[vjepa2] %(asctime)s %(levelname)s: %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
)
log = logging.getLogger(__name__)

# spec_key → {'encoder': Encoder, 'spec': dict, 'lastUsed': float, 'calls': int}
ENCODERS = {}
REGISTRY_LOCK = threading.Lock()
# エンコード自体は1つずつ流す (同一モデルへの並列 forward で VRAM が跳ねるのを防ぐ)
INFER_LOCK = threading.Lock()


def get_encoder(spec):
    """spec に対応するエンコーダを返す。無ければロードする。

    VRAM を食うので同時保持数を MAX_ENCODERS に制限し、超えたら
    最後に使われたのが一番古いものを解放する。
    """
    spec = vj.normalize_spec(spec)
    key = vj.spec_key(spec)
    with REGISTRY_LOCK:
        entry = ENCODERS.get(key)
        if entry is not None:
            entry['lastUsed'] = time.time()
            return entry['encoder'], spec

        while len(ENCODERS) >= MAX_ENCODERS:
            old = min(ENCODERS.items(), key=lambda kv: kv[1]['lastUsed'])[0]
            log.info(f'エンコーダを解放 (上限{MAX_ENCODERS}): {old}')
            try:
                ENCODERS[old]['encoder'].close()
            except Exception as e:  # noqa: BLE001 - 解放失敗でも登録は消す
                log.warning(f'解放時のエラー: {e}')
            ENCODERS.pop(old, None)

        log.info(f'エンコーダをロード: {vj.spec_label(spec)}')
        t0 = time.time()
        enc = vj.Encoder(spec, device=DEVICE, log=lambda m: log.info(m.strip()))
        log.info(f'ロード完了 ({time.time() - t0:.1f}秒)  device={enc.device} 出力次元={enc.out_dim}')
        ENCODERS[key] = {'encoder': enc, 'spec': spec, 'lastUsed': time.time(), 'calls': 0}
        return enc, spec


def unload(spec=None):
    """エンコーダを解放して VRAM を返す。spec 省略で全部。"""
    with REGISTRY_LOCK:
        keys = [vj.spec_key(spec)] if spec else list(ENCODERS.keys())
        freed = []
        for k in keys:
            entry = ENCODERS.pop(k, None)
            if entry is None:
                continue
            try:
                entry['encoder'].close()
            except Exception as e:  # noqa: BLE001
                log.warning(f'解放時のエラー: {e}')
            freed.append(k)
    if freed:
        log.info(f'解放: {", ".join(freed)}')
    return freed


def _decode_frame(raw):
    """base64 / data URL の1フレームを (H, W, 3) uint8 にする。"""
    import numpy as np
    from PIL import Image
    if not isinstance(raw, str):
        raise ValueError('frames の要素は base64 文字列で指定してください')
    s = raw.strip()
    if s.startswith('data:'):
        # data:image/png;base64,xxxx
        comma = s.find(',')
        if comma < 0:
            raise ValueError('data URL の形式が不正です')
        s = s[comma + 1:]
    try:
        blob = base64.b64decode(s, validate=True)
    except (binascii.Error, ValueError) as e:
        raise ValueError(f'base64 のデコードに失敗しました: {e}') from e
    with Image.open(io.BytesIO(blob)) as im:
        return np.asarray(im.convert('RGB'), dtype='uint8')


def embed_paths(paths, spec):
    """観測パスの配列 → 埋め込み。ディスクキャッシュを使う。"""
    enc, spec = get_encoder(spec)
    with INFER_LOCK:
        emb, stats = vj.ensure_embeddings(
            paths, spec, CACHE_DIR, base_dir=BASE_DIR,
            log=lambda m: log.info(m.strip()), encoder=enc, strict=True,
        )
    with REGISTRY_LOCK:
        e = ENCODERS.get(vj.spec_key(spec))
        if e:
            e['calls'] += 1
            e['lastUsed'] = time.time()
    return emb, stats


def embed_frames(frames, spec):
    """その場のフレーム列 → 埋め込み1本。キャッシュしない (毎回中身が違うため)。"""
    import numpy as np
    enc, spec = get_encoder(spec)
    if not isinstance(frames, list) or not frames:
        raise ValueError('frames は1枚以上の配列で指定してください')
    if len(frames) > MAX_FRAMES_PER_REQUEST:
        raise ValueError(f'frames は {MAX_FRAMES_PER_REQUEST} 枚以下にしてください')

    imgs = [_decode_frame(f) for f in frames]
    shapes = {im.shape for im in imgs}
    if len(shapes) > 1:
        raise ValueError(f'フレームの画像サイズが揃っていません: {sorted(shapes)}')

    want = spec['frames']
    if len(imgs) == 1:
        clip = np.repeat(imgs[0][None, ...], want, axis=0)      # 静止画1枚 → 複製
    else:
        # 学習時と同じ「末尾から stride 間隔」で選ぶ。足りなければ先頭で頭打ち
        idx = vj._frame_indices(len(imgs), want, spec['stride'])
        clip = np.stack([imgs[i] for i in idx], axis=0)

    with INFER_LOCK:
        emb = enc.embed_clips([clip])
    with REGISTRY_LOCK:
        e = ENCODERS.get(vj.spec_key(spec))
        if e:
            e['calls'] += 1
            e['lastUsed'] = time.time()
    return emb[0]


# ─── 世界モデル (predictor) の管理 ───
# predictor は残差MLP (数百万パラメータ) なので CPU に置く。VRAM はエンコーダ専用。
# model.pt の mtime を見て、再学習されたら自動で読み直す。
AC_MODELS = {}
AC_LOCK = threading.Lock()


def get_ac_model(name):
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', name or ''):
        raise ValueError('無効なモデル名です')
    model_dir = os.path.join(AC_MODELS_DIR, name)
    pt = os.path.join(model_dir, 'model.pt')
    if not os.path.exists(pt):
        raise FileNotFoundError(f'世界モデルが見つかりません: {name}')
    mtime = os.stat(pt).st_mtime_ns
    with AC_LOCK:
        entry = AC_MODELS.get(name)
        if entry and entry['mtime'] == mtime:
            entry['lastUsed'] = time.time()
            return entry['predictor'], entry['cfg']
        import torch
        import torch.nn as nn
        predictor, cfg = ac.load_predictor(torch, nn, model_dir, 'cpu')
        AC_MODELS[name] = {'predictor': predictor, 'cfg': cfg,
                           'mtime': mtime, 'lastUsed': time.time()}
        log.info(f'世界モデルをロード: {name} (embDim={cfg["embDim"]}, actionDim={cfg["actionDim"]})')
        return predictor, cfg


def _embed_one(body, key_frames, key_path, spec):
    """frames (base64) か path のどちらかから埋め込み1本を作る。"""
    frames = body.get(key_frames)
    if isinstance(frames, list) and frames:
        return embed_frames(frames, spec)
    p = body.get(key_path)
    if isinstance(p, str) and p.strip():
        emb, _ = embed_paths([p.strip()], spec)
        return emb[0]
    raise ValueError(f'{key_frames} (base64配列) か {key_path} (uploadsからの相対パス) が必要です')


def run_plan(body):
    """現在の観測 + ゴール → CEM で行動系列。"""
    import numpy as np
    import torch
    predictor, cfg = get_ac_model(body.get('name'))
    spec_vj = vj.normalize_spec(cfg.get('vjepa2') or {})
    a_spec = cfg['actionSpec']

    t0 = time.time()
    z_cur = _embed_one(body, 'frames', 'framePath', spec_vj)
    z_goal = _embed_one(body, 'goalFrames', 'goalPath', spec_vj)
    if z_cur.shape[0] != int(cfg['embDim']):
        raise ValueError(f"埋め込み次元が学習時と違います (期待 {cfg['embDim']}, 実際 {z_cur.shape[0]})")
    z0 = ac.normalize_latent(np, z_cur[None, :], cfg['latentMean'], cfg['latentStd'])[0]
    zg = ac.normalize_latent(np, z_goal[None, :], cfg['latentMean'], cfg['latentStd'])[0]
    encode_sec = time.time() - t0

    p = ac.PLAN_DEFAULTS
    horizon = max(1, min(int(body.get('horizon') or p['horizon']), 32))
    samples = max(16, min(int(body.get('samples') or p['samples']), 2048))
    iters = max(1, min(int(body.get('iterations') or p['iterations']), 16))
    seed = int(body.get('seed') or 0)

    t1 = time.time()
    score_fn = ac.make_rollout_score_fn(torch, predictor, z0, zg, a_spec, np)
    r = ac.cem_plan(np, score_fn, a_spec, horizon, samples, iters, seed)
    actions = ac.decode_actions(np, a_spec, r['best'])
    init_dist = float(((z0 - zg) ** 2).mean())
    return {
        'actions': actions,
        'firstAction': actions[0],
        'actionType': a_spec['type'],
        'horizon': horizon, 'samples': samples, 'iterations': iters,
        'initialDistance': round(init_dist, 5),
        'predictedFinalDistance': round(-r['bestScore'], 5),
        'scoreHistory': [round(s, 5) for s in r['scoreHistory']],
        'encodeSec': round(encode_sec, 3),
        'planSec': round(time.time() - t1, 3),
    }


def status():
    with REGISTRY_LOCK:
        return [{
            'key': k,
            'spec': v['spec'],
            'outDim': getattr(v['encoder'], 'out_dim', None),
            'device': getattr(v['encoder'], 'device', None),
            'calls': v['calls'],
            'lastUsed': v['lastUsed'],
        } for k, v in ENCODERS.items()]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # アクセスログは抑制 (Node 側でログ)

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get('Content-Length', 0) or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY_BYTES:
            raise ValueError(f'リクエストが大きすぎます ({length} bytes)')
        return json.loads(self.rfile.read(length).decode('utf-8'))

    def do_GET(self):
        if self.path == '/health':
            self._send(200, {
                'status': 'ok',
                'device': DEVICE or 'auto',
                'loaded': [s['key'] for s in status()],
                'cacheDir': CACHE_DIR,
                'baseDir': BASE_DIR,
            })
        else:
            self._send(404, {'error': 'not found'})

    def do_POST(self):
        try:
            body = self._read_json()
        except Exception as e:  # noqa: BLE001
            self._send(400, {'error': f'JSON parse error: {e}'})
            return
        try:
            route = self.path
            spec = body.get('spec') or {}
            if route == '/embed':
                paths = body.get('paths')
                if not isinstance(paths, list) or not paths:
                    self._send(400, {'error': 'paths は1件以上の配列で指定してください'})
                    return
                if len(paths) > MAX_PATHS_PER_REQUEST:
                    self._send(400, {'error': f'paths は {MAX_PATHS_PER_REQUEST} 件以下にしてください'})
                    return
                t0 = time.time()
                emb, stats = embed_paths(paths, spec)
                self._send(200, {
                    'embeddings': emb.tolist(),
                    'embDim': int(emb.shape[1]),
                    'hit': stats['hit'], 'miss': stats['miss'],
                    'elapsedSec': round(time.time() - t0, 3),
                })
            elif route == '/embed_frames':
                t0 = time.time()
                vec = embed_frames(body.get('frames'), spec)
                self._send(200, {
                    'embedding': vec.tolist(),
                    'embDim': int(vec.shape[0]),
                    'elapsedSec': round(time.time() - t0, 3),
                })
            elif route == '/plan':
                self._send(200, run_plan(body))
            elif route == '/unload':
                freed = unload(body.get('spec'))
                with AC_LOCK:
                    AC_MODELS.clear()   # predictor は軽いが、まとめて読み直させる
                self._send(200, {'ok': True, 'freed': freed})
            elif route == '/status':
                self._send(200, {'encoders': status(), 'device': DEVICE or 'auto'})
            else:
                self._send(404, {'error': 'not found'})
        except (ValueError, FileNotFoundError) as e:
            self._send(400, {'error': str(e)})
        except Exception as e:  # noqa: BLE001 - 想定外は500で返しつつログに残す
            log.exception('リクエスト処理でエラー')
            self._send(500, {'error': f'{type(e).__name__}: {e}'})


def main():
    # 引数の解釈は main の中でだけ行う (テストから import しても副作用が出ないように)
    try:
        port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    except ValueError:
        port = DEFAULT_PORT
    os.makedirs(CACHE_DIR, exist_ok=True)
    log.info(f'起動: :{port}  cache={CACHE_DIR}  base={BASE_DIR}  maxEncoders={MAX_ENCODERS}')
    log.info('モデルは最初のリクエストで読み込みます (起動自体は即座に完了)')
    srv = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        unload()
        srv.server_close()
        log.info('停止')


if __name__ == '__main__':
    main()
