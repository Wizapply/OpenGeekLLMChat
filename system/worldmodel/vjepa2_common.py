#!/usr/bin/env python3
"""
vjepa2_common.py — V-JEPA 2 エンコーダの共通モジュール

「観測(動画/フレーム列/画像) → 固定長ベクトル」の変換をここに集約する。
オフライン学習 (rl_runner.py) と 事前エンコード CLI (vjepa2_encode.py)、
将来の常駐エンコーダ (vjepa2_server.py) が同じ前処理を共有するのが目的
(rl_common.py と同じ狙い: 学習時と推論時で埋め込みがズレる事故を防ぐ)。

設計方針:
  - エンコーダは常に **凍結** して使う (勾配を流さない)。V-JEPA 2 の売りは
    「凍結表現 + 小さなタスクヘッド」なので、埋め込みは一度作れば使い回せる。
  - 埋め込みは必ずディスクにキャッシュする。エンコードは BC ヘッドの学習より
    2〜3桁遅いため、ハイパラを変えて再学習するたびに再エンコードしていられない。
  - 埋め込みには StandardScaler を掛けない (呼び出し側の責務)。1024次元に
    実行統計ベースの正規化を掛けると初期に scale≈0 になって発散する。
    正規化は方策ヘッド側の LayerNorm で行う (rl_common.build_qnet 参照)。

torch / numpy / transformers は関数内で遅延 import する (呼び出し側のスタイルに合わせる)。
"""
import hashlib
import json
import os

# 既定のチェックポイント (ViT-L / hidden 1024 / crop 256 / patch 16 / tubelet 2)
DEFAULT_MODEL_ID = 'facebook/vjepa2-vitl-fpc64-256'

# 既定のクリップ設定。frames=16, stride=4 で 64フレーム相当の時間幅をカバーしつつ、
# トークン数を 1/4 (8192 → 2048) に抑える。frames_per_clip は推論時の入力長を縛らない。
DEFAULT_FRAMES = 16
DEFAULT_STRIDE = 4
DEFAULT_POOLING = 'mean'
DEFAULT_BATCH_SIZE = 4

# プーリング方式
#   mean         : 全トークンの平均 → (hidden,)。時間・空間を全部潰す。最も汎用
#   mean_last    : 最後の時間スライスのトークンだけ平均 → (hidden,)。「今の観測」重視の制御向け
#   spatial_mean : 空間だけ平均し時間軸を残す → (T', hidden) を平坦化。
#                  T' = フレーム数 / tubelet_size (既定 16/2 = 8)。動きの向きや速さが
#                  効くタスクで有利。キャッシュは T' 倍 (16フレームで約16KB/clip)、
#                  状態次元も T' 倍になるので hiddenSize を大きめにすること。
POOLINGS = ('mean', 'mean_last', 'spatial_mean')

VIDEO_EXTS = {'.mp4', '.avi', '.mov', '.mkv', '.webm', '.m4v', '.mpg', '.mpeg'}
IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.bmp', '.webp'}


# ════════════════════════════════════════════════════════════════════
# 設定 (spec) の正規化とキャッシュキー
# ════════════════════════════════════════════════════════════════════

def normalize_spec(spec):
    """エンコード設定を既定値で埋めて正規化する。

    spec: {modelId?, frames?, stride?, pooling?, batchSize?}
    """
    spec = dict(spec or {})
    model_id = str(spec.get('modelId') or DEFAULT_MODEL_ID)
    frames = max(2, min(int(spec.get('frames') or DEFAULT_FRAMES), 128))
    stride = max(1, min(int(spec.get('stride') or DEFAULT_STRIDE), 16))
    pooling = spec.get('pooling') or DEFAULT_POOLING
    if pooling not in POOLINGS:
        pooling = DEFAULT_POOLING
    batch_size = max(1, min(int(spec.get('batchSize') or DEFAULT_BATCH_SIZE), 32))
    return {
        'modelId': model_id,
        'frames': frames,
        'stride': stride,
        'pooling': pooling,
        'batchSize': batch_size,
    }


def spec_key(spec):
    """キャッシュディレクトリ名。人が読めるうえで衝突しないようにハッシュを付ける。"""
    spec = normalize_spec(spec)
    short = spec['modelId'].split('/')[-1]
    safe = ''.join(c if (c.isalnum() or c in '-_.') else '_' for c in short)[:48]
    raw = f"{spec['modelId']}|{spec['frames']}|{spec['stride']}|{spec['pooling']}"
    h = hashlib.sha1(raw.encode('utf-8')).hexdigest()[:8]
    return f"{safe}_f{spec['frames']}s{spec['stride']}_{spec['pooling']}_{h}"


def spec_label(spec):
    """ログ表示用の1行サマリ。"""
    s = normalize_spec(spec)
    return f"{s['modelId']} (frames={s['frames']}, stride={s['stride']}, pooling={s['pooling']})"


# ════════════════════════════════════════════════════════════════════
# 観測ソースの解決 (パス検証 + 指紋)
# ════════════════════════════════════════════════════════════════════

def resolve_source(path, base_dir=None):
    """テーブルの列に入っているパスを実ファイルの絶対パスに解決する。

    base_dir を与えた場合、解決先が base_dir の外に出るパス (../ 等) は拒否する。
    テーブルの中身はユーザーデータなので、パストラバーサルを通さない。
    """
    if path is None or path != path:   # None と NaN (pandas の欠損) を弾く
        return None
    s = str(path).strip()
    if not s or s.lower() in ('nan', 'none', 'null'):
        return None
    if base_dir:
        base = os.path.realpath(base_dir)
        cand = s if os.path.isabs(s) else os.path.join(base, s)
        full = os.path.realpath(cand)
        if full != base and not full.startswith(base + os.sep):
            raise ValueError(f"参照先がベースディレクトリの外です: {s}")
    else:
        full = os.path.realpath(s)
    if not os.path.exists(full):
        raise FileNotFoundError(f"観測ファイルが見つかりません: {s}")
    return full


def source_fingerprint(full_path):
    """内容ハッシュの代わりに (パス + サイズ + mtime) で指紋を作る。

    動画の全バイトを読んで SHA1 を取るのは高すぎるので、統計情報で代用する。
    ディレクトリ (フレーム連番) の場合は中身のファイル数と最大 mtime を混ぜる。
    """
    h = hashlib.sha1()
    h.update(full_path.encode('utf-8', 'replace'))
    if os.path.isdir(full_path):
        files = sorted(f for f in os.listdir(full_path)
                       if os.path.splitext(f)[1].lower() in IMAGE_EXTS)
        h.update(f"|dir|{len(files)}".encode())
        mt = 0
        for f in files:
            try:
                mt = max(mt, os.stat(os.path.join(full_path, f)).st_mtime_ns)
            except OSError:
                pass
        h.update(f"|{mt}".encode())
    else:
        st = os.stat(full_path)
        h.update(f"|{st.st_size}|{st.st_mtime_ns}".encode())
    return h.hexdigest()


# ════════════════════════════════════════════════════════════════════
# クリップ読み込み
# ════════════════════════════════════════════════════════════════════

def _frame_indices(total, frames, stride):
    """末尾を最新フレームに合わせて frames 本を stride 間隔でサンプルする。

    制御用途では「直近の過去」が効くので、先頭からではなく末尾から数える。
    総フレーム数が足りない場合は先頭フレームを繰り返してクランプする。
    """
    end = max(total - 1, 0)
    return [max(0, end - (frames - 1 - i) * stride) for i in range(frames)]


def _decode_torchcodec(path, frames, stride):
    """torchcodec (transformers 公式サンプルと同じ経路。必要フレームだけデコード)。"""
    from torchcodec.decoders import VideoDecoder
    vr = VideoDecoder(path)
    idx = _frame_indices(len(vr), frames, stride)
    data = vr.get_frames_at(indices=idx).data      # (T, C, H, W) uint8
    return data.permute(0, 2, 3, 1).contiguous().numpy().astype('uint8')


def _decode_torchvision(path, frames, stride):
    """torchvision.io.read_video (PyAV 経由。動画全体を読むので短いクリップ向け)。

    torchvision が入っていても PyAV が無いと **import ではなく呼び出し時** に
    落ちるので、ImportError だけを見ていると次の候補に進めない。
    """
    from torchvision.io import read_video
    vid, _, _ = read_video(path, output_format='THWC', pts_unit='sec')
    if int(vid.shape[0]) == 0:
        raise RuntimeError('フレームを読み取れませんでした')
    idx = _frame_indices(int(vid.shape[0]), frames, stride)
    return vid[idx].numpy().astype('uint8')


def _decode_decord(path, frames, stride):
    import decord
    vr = decord.VideoReader(path)
    idx = _frame_indices(len(vr), frames, stride)
    return vr.get_batch(idx).asnumpy().astype('uint8')


VIDEO_DECODERS = (
    ('torchcodec', _decode_torchcodec),
    ('torchvision(av)', _decode_torchvision),
    ('decord', _decode_decord),
)


def _read_video_file(path, frames, stride):
    """動画ファイルから (T, H, W, C) uint8 を取り出す。

    torchcodec → torchvision.io.read_video → decord の順にフォールバックする。
    どのバックエンドも「未インストール (ImportError)」と「入っているが動かない
    (RuntimeError/OSError 等)」の両方があり得るので、どちらでも次の候補へ進む。
    全部失敗したら、何をどう試したかをまとめて投げる。
    """
    errors = []
    for name, fn in VIDEO_DECODERS:
        try:
            return fn(path, frames, stride)
        except ImportError:
            errors.append(f'{name}: 未インストール')
        except Exception as e:                      # noqa: BLE001 - 次の候補を試す
            errors.append(f'{name}: {type(e).__name__}: {e}')
    raise RuntimeError(
        f"動画をデコードできませんでした ({os.path.basename(path)})。\n  "
        + '\n  '.join(errors)
        + '\n  いずれかを入れてください: pip install torchcodec / pip install av / pip install decord'
    )


def _read_image_dir(path, frames, stride):
    """フレーム連番ディレクトリから (T, H, W, C) uint8 を取り出す。"""
    import numpy as np
    from PIL import Image

    files = sorted(f for f in os.listdir(path)
                   if os.path.splitext(f)[1].lower() in IMAGE_EXTS)
    if not files:
        raise RuntimeError(f"画像ファイルが1枚もありません: {path}")
    idx = _frame_indices(len(files), frames, stride)
    out = []
    cache = {}
    for i in idx:
        if i not in cache:
            with Image.open(os.path.join(path, files[i])) as im:
                cache[i] = np.asarray(im.convert('RGB'), dtype='uint8')
        out.append(cache[i])
    return np.stack(out, axis=0)


def _read_single_image(path, frames):
    """静止画1枚を frames 本に複製する (画像ベースの制御タスク向け)。"""
    import numpy as np
    from PIL import Image
    with Image.open(path) as im:
        arr = np.asarray(im.convert('RGB'), dtype='uint8')
    return np.repeat(arr[None, ...], frames, axis=0)


def read_clip(full_path, spec):
    """観測ソース (動画 / フレームディレクトリ / 静止画) を (T, H, W, C) uint8 にする。"""
    spec = normalize_spec(spec)
    frames, stride = spec['frames'], spec['stride']
    if os.path.isdir(full_path):
        return _read_image_dir(full_path, frames, stride)
    ext = os.path.splitext(full_path)[1].lower()
    if ext in VIDEO_EXTS:
        return _read_video_file(full_path, frames, stride)
    if ext in IMAGE_EXTS:
        return _read_single_image(full_path, frames)
    # 拡張子不明は動画として試す (デコーダ側でエラーになれば分かる)
    return _read_video_file(full_path, frames, stride)


# ════════════════════════════════════════════════════════════════════
# エンコーダ本体
# ════════════════════════════════════════════════════════════════════

def pooled_dim(hidden_size, frames, tubelet_size, pooling):
    """プーリング後の埋め込み次元。spatial_mean だけ時間軸の分だけ長くなる。"""
    if pooling == 'spatial_mean':
        t = max(1, int(frames) // max(1, int(tubelet_size)))
        return int(hidden_size) * t
    return int(hidden_size)


def probe_embed_dim(spec):
    """重みを落とさずに埋め込み次元だけ調べる (config だけ取得)。"""
    from transformers import AutoConfig
    spec = normalize_spec(spec)
    cfg = AutoConfig.from_pretrained(spec['modelId'])
    return pooled_dim(
        getattr(cfg, 'hidden_size', 1024),
        spec['frames'],
        getattr(cfg, 'tubelet_size', 2),
        spec['pooling'],
    )


def _pick_dtype(torch, device):
    """device に応じた推論 dtype。ROCm/CUDA なら bf16 優先、無ければ fp16。"""
    if not str(device).startswith('cuda'):
        return torch.float32
    try:
        if torch.cuda.is_bf16_supported():
            return torch.bfloat16
    except Exception:
        pass
    return torch.float16


class Encoder:
    """V-JEPA 2 エンコーダを1つメモリに保持する。常に eval / no_grad で使う。"""

    def __init__(self, spec, device=None, log=None):
        import torch
        from transformers import AutoModel, AutoVideoProcessor

        self.spec = normalize_spec(spec)
        self.log = log or (lambda m: None)
        self.device = device or ('cuda' if torch.cuda.is_available() else 'cpu')
        self.dtype = _pick_dtype(torch, self.device)
        self._torch = torch

        self.log(f"  V-JEPA 2 ロード中: {spec_label(self.spec)}  device={self.device} dtype={self.dtype}")
        self.processor = AutoVideoProcessor.from_pretrained(self.spec['modelId'])
        # dtype を指定するキーワードは transformers のバージョンで揺れる
        # (旧: torch_dtype / 新: dtype)。両方試し、どちらも駄目なら後から cast する。
        self.model = None
        for kw in ('dtype', 'torch_dtype'):
            try:
                self.model = AutoModel.from_pretrained(
                    self.spec['modelId'],
                    attn_implementation='sdpa',   # ROCm でも動く。flash-attn は不要
                    **{kw: self.dtype},
                )
                break
            except TypeError:
                continue
        if self.model is None:
            self.model = AutoModel.from_pretrained(
                self.spec['modelId'], attn_implementation='sdpa')
        self.model.to(device=self.device, dtype=self.dtype)
        self.model.eval()
        for p in self.model.parameters():   # 凍結
            p.requires_grad_(False)

        cfg = self.model.config
        self.hidden_size = int(getattr(cfg, 'hidden_size', 1024))
        patch = getattr(cfg, 'patch_size', 16)
        if isinstance(patch, (list, tuple)):
            patch = patch[0]
        crop = int(getattr(cfg, 'crop_size', 256))
        # 空間トークン数 = (crop/patch)^2。時間トークン数は seq_len から割り出す
        self.n_spatial = max(1, (crop // int(patch)) ** 2)
        self.tubelet = int(getattr(cfg, 'tubelet_size', 2) or 2)
        self.out_dim = pooled_dim(
            self.hidden_size, self.spec['frames'], self.tubelet, self.spec['pooling'])
        self._warned_pool = False
        self.log(f"  hidden_size={self.hidden_size}, 空間トークン数={self.n_spatial}, "
                 f"出力次元={self.out_dim}")

    def close(self):
        """VRAM を返す。学習の前に必ず呼ぶこと (llama-server との競合を避ける)。"""
        try:
            del self.model
        except AttributeError:
            pass
        self.model = None
        try:
            if str(self.device).startswith('cuda'):
                self._torch.cuda.empty_cache()
        except Exception:
            pass

    def _pool(self, hidden):
        """(B, seq_len, D) → (B, out_dim)。プーリング方式は spec に従う。

        V-JEPA 2 のトークン列は「時間が外側、空間が内側」の順に並んでいるので、
        (B, T', n_spatial, D) に見立てれば時間/空間を分けて畳める。
        """
        pooling = self.spec['pooling']
        if pooling == 'mean':
            return hidden.mean(dim=1)

        seq, d = hidden.shape[1], hidden.shape[2]
        grid_ok = (seq % self.n_spatial == 0) and (seq // self.n_spatial > 1)
        if not grid_ok:
            # トークン格子が想定と合わない場合は素直に全平均へフォールバック
            if not self._warned_pool:
                self._warned_pool = True
                self.log(f"  ⚠ トークン格子が想定と一致しません "
                         f"(seq_len={seq}, 空間={self.n_spatial}) → {pooling} を mean にフォールバック")
            return hidden.mean(dim=1)

        if pooling == 'mean_last':
            return hidden[:, -self.n_spatial:, :].mean(dim=1)
        # spatial_mean: 空間だけ潰して時間軸を残し、(B, T'*D) に平坦化する
        t = seq // self.n_spatial
        return hidden.view(-1, t, self.n_spatial, d).mean(dim=2).reshape(-1, t * d)

    def embed_clips(self, clips):
        """クリップのリスト (各 (T,H,W,C) uint8) → (N, D) float32。"""
        import numpy as np
        torch = self._torch
        out = []
        bs = self.spec['batchSize']
        for i in range(0, len(clips), bs):
            batch = clips[i:i + bs]
            inputs = self.processor(batch, return_tensors='pt')
            pv = inputs['pixel_values_videos'].to(self.device, dtype=self.dtype)
            with torch.no_grad():
                res = self.model(pixel_values_videos=pv, skip_predictor=True)
                vec = self._pool(res.last_hidden_state)
            out.append(vec.float().cpu().numpy().astype('float32'))
        return np.concatenate(out, axis=0) if out else np.zeros((0, self.out_dim), dtype='float32')


# ════════════════════════════════════════════════════════════════════
# キャッシュ付きエンコード (呼び出し側はこれだけ使えばよい)
# ════════════════════════════════════════════════════════════════════

def _cache_dir_for(cache_dir, spec):
    d = os.path.join(cache_dir, spec_key(spec))
    os.makedirs(d, exist_ok=True)
    return d


def _write_cache_meta(dirpath, spec, emb_dim):
    meta = dict(normalize_spec(spec))
    meta['embDim'] = int(emb_dim)
    try:
        with open(os.path.join(dirpath, 'spec.json'), 'w', encoding='utf-8') as f:
            json.dump(meta, f, indent=2, ensure_ascii=False)
    except OSError:
        pass


def _read_cache_meta(dirpath):
    try:
        with open(os.path.join(dirpath, 'spec.json'), 'r', encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def cached_embed_dim(cache_dir, spec):
    """キャッシュ済みなら埋め込み次元をディスクから読む (モデルを落とさずに済む)。"""
    meta = _read_cache_meta(_cache_dir_for(cache_dir, spec))
    return int(meta['embDim']) if meta and meta.get('embDim') else None


def ensure_embeddings(paths, spec, cache_dir, base_dir=None, log=None,
                      device=None, encoder=None, strict=True):
    """パスの配列を埋め込み行列 (N, D) float32 にする。キャッシュがあれば再利用。

    Args:
        paths: 観測ソースのパス配列 (None/空文字はゼロベクトル扱い)
        spec: エンコード設定 (normalize_spec で正規化される)
        cache_dir: 埋め込みキャッシュのルート
        base_dir: パス解決の基点 (この外を指すパスは拒否)
        encoder: 既存の Encoder を使い回す場合に渡す (None なら必要時のみ生成)
        strict: True なら読み込み失敗を例外にする。False ならゼロベクトルで継続

    Returns:
        (emb, stats): emb は (N, D) float32、stats は {'hit','miss','zero','embDim'}
    """
    import numpy as np

    log = log or (lambda m: None)
    spec = normalize_spec(spec)
    cdir = _cache_dir_for(cache_dir, spec)

    # 1) パス解決 + 指紋。同じソースは1回だけエンコードする
    n = len(paths)
    fps = [None] * n            # 各行の指紋 (None はゼロベクトル行)
    resolved = {}               # 指紋 → 絶対パス
    zero_rows = 0
    for i, p in enumerate(paths):
        try:
            full = resolve_source(p, base_dir)
        except (ValueError, FileNotFoundError) as e:
            if strict:
                raise
            log(f"  ⚠ {e} → ゼロベクトルで代替")
            full = None
        if full is None:
            zero_rows += 1
            continue
        fp = source_fingerprint(full)
        fps[i] = fp
        resolved.setdefault(fp, full)

    # 2) キャッシュヒット判定
    vectors = {}
    misses = []
    for fp, full in resolved.items():
        cpath = os.path.join(cdir, fp + '.npy')
        if os.path.exists(cpath):
            try:
                vectors[fp] = np.load(cpath).astype('float32')
                continue
            except (OSError, ValueError):
                pass  # 壊れたキャッシュは作り直す
        misses.append((fp, full))

    n_hit, n_miss = len(vectors), len(misses)
    log(f"  埋め込み: ユニーク {len(resolved)} 件 (キャッシュヒット {n_hit} / 新規 {n_miss}"
        + (f" / 観測なし {zero_rows} 行" if zero_rows else "") + ")")

    # 3) 未キャッシュ分をエンコード
    own_encoder = False
    if misses:
        if encoder is None:
            encoder = Encoder(spec, device=device, log=log)
            own_encoder = True
        try:
            bs = spec['batchSize']
            done = 0
            for i in range(0, len(misses), bs):
                chunk = misses[i:i + bs]
                clips, keys = [], []
                for fp, full in chunk:
                    try:
                        clips.append(read_clip(full, spec))
                        keys.append(fp)
                    except Exception as e:
                        if strict:
                            raise RuntimeError(f"クリップ読み込み失敗 ({full}): {e}") from e
                        log(f"  ⚠ クリップ読み込み失敗 ({full}): {e} → ゼロベクトルで代替")
                if not clips:
                    continue
                embs = encoder.embed_clips(clips)
                for fp, vec in zip(keys, embs):
                    # キャッシュは float16 で保存する (容量を半分に)。ここで一度 fp16 に
                    # 丸めてから返すことで、「初回だけ fp32 の値で学習し、次回の評価では
                    # fp16 の値が入る」という微妙な不一致を防ぐ。
                    vec16 = vec.astype('float16')
                    vectors[fp] = vec16.astype('float32')
                    try:
                        np.save(os.path.join(cdir, fp + '.npy'), vec16)
                    except OSError as e:
                        log(f"  ⚠ キャッシュ書き込み失敗: {e}")
                done += len(chunk)
                if done % max(bs, (len(misses) // 10) or bs) < bs or done >= len(misses):
                    log(f"    エンコード {min(done, len(misses))}/{len(misses)}")
        finally:
            if own_encoder:
                encoder.close()

    # 4) 埋め込み次元の確定 + 行列化
    emb_dim = None
    for v in vectors.values():
        emb_dim = int(v.shape[-1]); break
    if emb_dim is None:
        emb_dim = cached_embed_dim(cache_dir, spec) or probe_embed_dim(spec)
    else:
        _write_cache_meta(cdir, spec, emb_dim)

    out = np.zeros((n, emb_dim), dtype='float32')
    for i, fp in enumerate(fps):
        if fp is not None and fp in vectors:
            out[i] = vectors[fp]
    return out, {'hit': n_hit, 'miss': n_miss, 'zero': zero_rows, 'embDim': emb_dim}
