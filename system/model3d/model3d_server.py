#!/usr/bin/env python3
"""
model3d_server.py — ローカル 3D モデル生成ワーカー (画像→3D / テキスト→3D)

OpenGeekLLMChat の server.js が子プロセスとして起動し (sd-server / Irodori-TTS と同じ方式)、
localhost HTTP で「画像 (またはテキスト) → GLB ファイル」の変換を提供する。
タスク管理・キュー・Meshy 互換 API・テキスト→画像 (stable-diffusion.cpp) は Node 側の責務で、
このワーカーは「1件ずつ GLB を作る」ことだけをする。

構造は vjepa2_server.py / rl_online_server.py に倣い、stdlib http.server のみで実装する
(FastAPI 等を足さない。バックエンドの venv に余計な依存を入れずに済む)。

使い方:
    python3 system/model3d/model3d_server.py --backend hunyuan3d --port 8093
    python3 system/model3d/model3d_server.py --backend dummy        # 依存なしの動作確認用

バックエンド (--backend):
    dummy      依存なし。入力画像の平均色で塗った多面体を返す (配線確認・テスト用)
    hunyuan3d  Tencent Hunyuan3D-2 系 (hy3dgen パッケージ)。画像→形状、任意でテクスチャ
               (--model tencent/Hunyuan3D-2mini --subfolder hunyuan3d-dit-v2-mini 等で軽量版)
    trellis    Microsoft TRELLIS。画像→テクスチャ付きGLB。--trellis-text でテキスト→3D も
    sf3d       Stability AI Stable Fast 3D。画像→テクスチャ付きGLB (省VRAM・高速)
    <module>:<Class>  独自バックエンド。下の Backend と同じメソッドを持つクラスを指定

    各バックエンドのパッケージ (hy3dgen / trellis / sf3d) は、それぞれの公式リポジトリの
    手順で venv に入れておくこと。server.js の config.json model3d.command にその venv の
    python を指定する。

API (すべて JSON, localhost 内部用):
    GET  /health   -> {ok, backend, loaded, capabilities{text,image,texture,retexture,textured}}
    GET  /status   -> {busy, stage, progress}
    POST /generate {mode:'image'|'text', image?(base64/data URL), prompt?, seed?, texture?,
                    target_faces?, options?{}, output_path, formats?[]}
                   -> {ok, output_path, files{glb,obj?,stl?}, vertices, faces, textured, elapsed}
    POST /texture  {mesh_path, image, seed?, options?, output_path, formats?[]}
                   -> /generate と同じ (既存メッシュにテクスチャを貼り直す。Meshy の refine 用)
    POST /unload   -> モデルを解放して VRAM を返す
"""
import argparse
import base64
import binascii
import errno
import importlib
import io
import json
import logging
import math
import os
import struct
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

log = logging.getLogger('model3d')

MAX_BODY = 64 * 1024 * 1024  # 画像 base64 を受けるので大きめ


# ─── 進捗 (/status で Node がポーリングする) ───
class Progress:
    def __init__(self):
        self.lock = threading.Lock()
        self.busy = False
        self.stage = ''
        self.progress = 0

    def set(self, stage=None, progress=None):
        with self.lock:
            if stage is not None:
                self.stage = stage
            if progress is not None:
                self.progress = max(0, min(100, int(progress)))
        if stage:
            log.info('[%3d%%] %s', self.progress, self.stage)

    def snapshot(self):
        with self.lock:
            return {'busy': self.busy, 'stage': self.stage, 'progress': self.progress}


PROGRESS = Progress()
JOB_LOCK = threading.Lock()  # GPU は1件ずつ。同時に来たら後のリクエストは待つ


def decode_image(data):
    """base64 / data URL → PIL.Image (RGBA)。PIL が無い (dummy) なら生バイトを返す"""
    if not data or not isinstance(data, str):
        raise ValueError('image が空です')
    if data.startswith('data:'):
        data = data.split(',', 1)[1] if ',' in data else ''
    try:
        raw = base64.b64decode(data, validate=False)
    except (binascii.Error, ValueError) as e:
        raise ValueError(f'image の base64 が不正です: {e}')
    try:
        from PIL import Image
    except ImportError:
        return raw
    img = Image.open(io.BytesIO(raw))
    img.load()
    return img.convert('RGBA') if img.mode != 'RGBA' else img


def has_alpha_cutout(img):
    """背景が既に透過で抜かれているか (rembg を省けるか)"""
    try:
        if img.mode != 'RGBA':
            return False
        lo, _hi = img.getchannel('A').getextrema()
        return lo < 250
    except Exception:
        return False


def mesh_stats(path):
    """GLB の JSON チャンクだけを読んで頂点数・面数を数える (trimesh 不要・メッシュ本体は読まない)"""
    try:
        with open(path, 'rb') as fp:
            magic, _ver, _total = struct.unpack('<4sII', fp.read(12))
            if magic != b'glTF':
                return None, None
            n, kind = struct.unpack('<I4s', fp.read(8))
            if kind != b'JSON':
                return None, None
            gltf = json.loads(fp.read(n).decode('utf-8'))
        acc = gltf.get('accessors', [])
        verts = faces = 0
        for m in gltf.get('meshes', []):
            for prim in m.get('primitives', []):
                pos = prim.get('attributes', {}).get('POSITION')
                vcount = acc[pos]['count'] if pos is not None else 0
                verts += vcount
                if prim.get('indices') is not None:
                    faces += acc[prim['indices']]['count'] // 3
                else:
                    faces += vcount // 3
        return verts, faces
    except Exception:
        return None, None


def export_extra_formats(glb_path, formats):
    """GLB から OBJ / STL / PLY を書き出す (trimesh がある時だけ)。失敗しても GLB は残す"""
    out = {}
    wanted = [f for f in (formats or []) if f in ('obj', 'stl', 'ply')]
    if not wanted:
        return out
    try:
        import trimesh
    except ImportError:
        log.warning('trimesh が無いため %s の書き出しを省略', wanted)
        return out
    base = os.path.splitext(glb_path)[0]
    scene = trimesh.load(glb_path, force='scene')
    for fmt in wanted:
        try:
            p = f'{base}.{fmt}'
            if fmt == 'obj':
                # テクスチャ付きは mtl / png も同じフォルダに書く
                mesh = scene.dump(concatenate=True) if hasattr(scene, 'dump') else scene
                from trimesh.exchange.obj import export_obj
                res = export_obj(mesh, include_texture=True, return_texture=True,
                                 mtl_name=os.path.basename(base) + '.mtl')
                text, files = res if isinstance(res, tuple) else (res, {})
                with open(p, 'w', encoding='utf-8') as fp:
                    fp.write(text)
                for name, data in (files or {}).items():
                    with open(os.path.join(os.path.dirname(p), os.path.basename(name)), 'wb') as fp:
                        fp.write(data)
                    if name.endswith('.mtl'):
                        out['mtl'] = os.path.basename(name)
            else:
                scene.export(p, file_type=fmt)
            out[fmt] = os.path.basename(p)
        except Exception as e:
            log.warning('%s の書き出しに失敗: %s', fmt, e)
    return out


# ════════════════════════════════════════════════
# バックエンド
# ════════════════════════════════════════════════
class Backend:
    """バックエンドの共通形。独自バックエンドもこの形に合わせる。

    capabilities:
      text      … テキストから直接 3D を作れる (False なら Node 側が画像生成を経由する)
      image     … 画像から 3D を作れる
      texture   … テクスチャ付きで出せる
      retexture … 既存メッシュにテクスチャを貼れる (Meshy の refine)
      textured  … 常にテクスチャ付きで出る (texture=False でも色が付く)
    progress(stage, pct) で進捗を伝える。出力は output_path に GLB で書く。
    """
    name = 'base'
    capabilities = {'text': False, 'image': True, 'texture': False, 'retexture': False, 'textured': False}

    def __init__(self, args):
        self.args = args
        self.loaded = False

    def load(self, progress):
        self.loaded = True

    def unload(self):
        self.loaded = False

    def image_to_3d(self, image, output_path, *, seed, texture, target_faces, options, progress):
        raise NotImplementedError('このバックエンドは画像→3Dに対応していません')

    def text_to_3d(self, prompt, output_path, *, seed, texture, target_faces, options, progress):
        raise NotImplementedError('このバックエンドはテキスト→3Dに対応していません')

    def retexture(self, mesh_path, image, output_path, *, seed, options, progress):
        raise NotImplementedError('このバックエンドはテクスチャ生成に対応していません')


def free_cuda():
    try:
        import gc
        gc.collect()
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def torch_generator(seed, device):
    if seed is None or seed < 0:
        return None
    import torch
    try:
        return torch.Generator(device=device).manual_seed(int(seed))
    except Exception:
        return torch.Generator().manual_seed(int(seed))


def default_device(args):
    if args.device:
        return args.device
    try:
        import torch
        return 'cuda' if torch.cuda.is_available() else 'cpu'
    except ImportError:
        return 'cpu'


# ─── dummy: 依存なしで GLB を作る (配線確認・テスト用) ───
def write_glb(path, positions, normals, indices, color):
    """最小の glTF 2.0 バイナリ (1メッシュ・1マテリアル) を書く"""
    pos_bytes = b''.join(struct.pack('<3f', *p) for p in positions)
    nrm_bytes = b''.join(struct.pack('<3f', *n) for n in normals)
    idx_bytes = b''.join(struct.pack('<I', i) for i in indices)
    pad = lambda b, ch=b'\x00': b + ch * ((4 - len(b) % 4) % 4)
    bin_chunk = pad(pos_bytes) + pad(nrm_bytes) + pad(idx_bytes)
    off_nrm = len(pad(pos_bytes))
    off_idx = off_nrm + len(pad(nrm_bytes))
    mins = [min(p[i] for p in positions) for i in range(3)]
    maxs = [max(p[i] for p in positions) for i in range(3)]
    gltf = {
        'asset': {'version': '2.0', 'generator': 'OpenGeekLLMChat model3d_server (dummy)'},
        'scene': 0,
        'scenes': [{'nodes': [0]}],
        'nodes': [{'mesh': 0, 'name': 'model'}],
        'meshes': [{'primitives': [{
            'attributes': {'POSITION': 0, 'NORMAL': 1}, 'indices': 2, 'material': 0,
        }]}],
        'materials': [{'pbrMetallicRoughness': {
            'baseColorFactor': [color[0], color[1], color[2], 1.0],
            'metallicFactor': 0.0, 'roughnessFactor': 0.6,
        }}],
        'buffers': [{'byteLength': len(bin_chunk)}],
        'bufferViews': [
            {'buffer': 0, 'byteOffset': 0, 'byteLength': len(pos_bytes), 'target': 34962},
            {'buffer': 0, 'byteOffset': off_nrm, 'byteLength': len(nrm_bytes), 'target': 34962},
            {'buffer': 0, 'byteOffset': off_idx, 'byteLength': len(idx_bytes), 'target': 34963},
        ],
        'accessors': [
            {'bufferView': 0, 'componentType': 5126, 'count': len(positions), 'type': 'VEC3',
             'min': mins, 'max': maxs},
            {'bufferView': 1, 'componentType': 5126, 'count': len(normals), 'type': 'VEC3'},
            {'bufferView': 2, 'componentType': 5125, 'count': len(indices), 'type': 'SCALAR'},
        ],
    }
    json_chunk = pad(json.dumps(gltf, separators=(',', ':')).encode('utf-8'), b' ')
    total = 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)
    with open(path, 'wb') as fp:
        fp.write(struct.pack('<4sII', b'glTF', 2, total))
        fp.write(struct.pack('<I4s', len(json_chunk), b'JSON'))
        fp.write(json_chunk)
        fp.write(struct.pack('<I4s', len(bin_chunk), b'BIN\x00'))
        fp.write(bin_chunk)


def icosphere(subdiv, seed):
    """少し歪ませた球 (seed ごとに形が変わる)。フラットシェーディング用に頂点を面ごとに分ける"""
    t = (1 + 5 ** 0.5) / 2
    verts = [(-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0), (0, -1, t), (0, 1, t),
             (0, -1, -t), (0, 1, -t), (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1)]
    faces = [(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11), (1, 5, 9), (5, 11, 4),
             (11, 10, 2), (10, 7, 6), (7, 1, 8), (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8),
             (3, 8, 9), (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1)]
    norm = lambda v: tuple(c / math.sqrt(sum(x * x for x in v)) for c in v)
    verts = [norm(v) for v in verts]
    for _ in range(subdiv):
        cache, nf = {}, []

        def mid(a, b):
            key = (min(a, b), max(a, b))
            if key not in cache:
                va, vb = verts[a], verts[b]
                verts.append(norm(tuple((va[i] + vb[i]) / 2 for i in range(3))))
                cache[key] = len(verts) - 1
            return cache[key]
        for a, b, c in faces:
            ab, bc, ca = mid(a, b), mid(b, c), mid(c, a)
            nf += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
        faces = nf
    s = (seed or 0) % 997
    bumpy = lambda v: tuple(c * (1 + 0.12 * math.sin(3 * v[0] + s) * math.cos(2 * v[1] + s * 0.7)) for c in v)
    verts = [bumpy(v) for v in verts]
    positions, normals, indices = [], [], []
    for a, b, c in faces:
        pa, pb, pc = verts[a], verts[b], verts[c]
        u = [pb[i] - pa[i] for i in range(3)]
        w = [pc[i] - pa[i] for i in range(3)]
        n = norm((u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]))
        for p in (pa, pb, pc):
            indices.append(len(positions))
            positions.append(p)
            normals.append(n)
    return positions, normals, indices


class DummyBackend(Backend):
    name = 'dummy'
    capabilities = {'text': True, 'image': True, 'texture': True, 'retexture': True, 'textured': True}

    def _make(self, output_path, color, seed, progress):
        steps = max(1, int(self.args.dummy_delay * 4))
        for i in range(steps):
            progress('dummy: 形状を生成中', 10 + 80 * i / steps)
            time.sleep(0.25)
        positions, normals, indices = icosphere(3, seed)
        write_glb(output_path, positions, normals, indices, color)

    @staticmethod
    def _color_of(image):
        try:
            small = image.convert('RGB').resize((1, 1))
            r, g, b = small.getpixel((0, 0))
            return (r / 255, g / 255, b / 255)
        except Exception:
            return (0.7, 0.7, 0.75)

    def image_to_3d(self, image, output_path, *, seed, texture, target_faces, options, progress):
        self._make(output_path, self._color_of(image) if texture else (0.75, 0.75, 0.78), seed, progress)

    def text_to_3d(self, prompt, output_path, *, seed, texture, target_faces, options, progress):
        h = sum(ord(c) for c in prompt or '')
        color = ((h % 255) / 255, (h * 7 % 255) / 255, (h * 13 % 255) / 255) if texture else (0.75, 0.75, 0.78)
        self._make(output_path, color, seed if seed is not None and seed >= 0 else h, progress)

    def retexture(self, mesh_path, image, output_path, *, seed, options, progress):
        self._make(output_path, self._color_of(image), seed, progress)


# ─── Hunyuan3D-2 (hy3dgen) ───
class Hunyuan3DBackend(Backend):
    name = 'hunyuan3d'

    def __init__(self, args):
        super().__init__(args)
        # テクスチャ (Hunyuan3D Paint) は CUDA 専用の拡張 (custom_rasterizer 等) を使うので、
        # ROCm 等でビルドできない環境がある。--no-texture か、読み込みに失敗した時は形状だけ出す
        self.texture_error = 'テクスチャ生成は無効です (--no-texture)' if args.no_texture else None
        self._update_caps()

    def _update_caps(self):
        ok = self.texture_error is None
        self.capabilities = {'text': False, 'image': True, 'texture': ok, 'retexture': ok, 'textured': False}

    def load(self, progress):
        from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline
        from hy3dgen.rembg import BackgroundRemover
        self.device = default_device(self.args)
        model = self.args.model or 'tencent/Hunyuan3D-2'
        kw = {}
        if self.args.subfolder:
            kw['subfolder'] = self.args.subfolder
            kw['use_safetensors'] = True
        progress(f'Hunyuan3D 形状モデルを読み込み中 ({model})', 2)
        self.shape = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(model, device=self.device, **kw)
        self.rembg = BackgroundRemover()
        self.paint = None  # テクスチャは使う時に読む (VRAM を食うため)
        self.loaded = True

    def _paint(self, progress):
        """テクスチャのパイプライン。使えない環境なら None (理由は self.texture_error)"""
        if self.texture_error:
            return None
        if self.paint is None:
            try:
                from hy3dgen.texgen import Hunyuan3DPaintPipeline
            except ImportError as e:
                self.texture_error = (f'テクスチャ生成の部品が読み込めません ({e})。'
                                      'hy3dgen/texgen の custom_rasterizer と differentiable_renderer のビルドが必要です'
                                      ' (NVIDIA は CUDA、AMD は ROCm の hipcc でビルド。手順は README の「テクスチャ生成」)')
                self._update_caps()
                log.warning('%s → 以後は形状のみ出力', self.texture_error)
                return None
            model = self.args.texture_model or 'tencent/Hunyuan3D-2'
            # subfolder 省略時は Hunyuan3D-2 の既定 (hunyuan3d-paint-v2-0-turbo: 速い・軽い)
            kw = {'subfolder': self.args.texture_subfolder} if self.args.texture_subfolder else {}
            progress(f'Hunyuan3D テクスチャモデルを読み込み中 ({model})', None)
            self.paint = Hunyuan3DPaintPipeline.from_pretrained(model, **kw)
            if self.args.low_vram and hasattr(self.paint, 'enable_model_cpu_offload'):
                self.paint.enable_model_cpu_offload()
        return self.paint

    def unload(self):
        self.shape = None
        self.paint = None
        self.rembg = None
        self.loaded = False
        free_cuda()

    def _prepare(self, image, progress):
        if has_alpha_cutout(image) and not self.args.force_rembg:
            return image
        progress('背景を除去中', 8)
        return self.rembg(image.convert('RGB'))

    def image_to_3d(self, image, output_path, *, seed, texture, target_faces, options, progress):
        from hy3dgen.shapegen import FloaterRemover, DegenerateFaceRemover, FaceReducer
        image = self._prepare(image, progress)
        progress('形状を生成中 (Hunyuan3D DiT)', 15)
        kw = {
            'num_inference_steps': int(options.get('steps') or self.args.steps),
            'guidance_scale': float(options.get('guidance') or self.args.guidance),
            'octree_resolution': int(options.get('octree_resolution') or self.args.octree_resolution),
        }
        gen = torch_generator(seed, self.device)
        if gen is not None:
            kw['generator'] = gen
        mesh = self.shape(image=image, **kw)[0]
        progress('メッシュを整理中', 55)
        mesh = FloaterRemover()(mesh)
        mesh = DegenerateFaceRemover()(mesh)
        if target_faces:
            mesh = FaceReducer()(mesh, max_facenum=int(target_faces))
        textured = False
        if texture:
            paint = self._paint(progress)
            if paint is None:
                progress('テクスチャ生成は使えないため形状のみ出力します', 90)
            else:
                progress('テクスチャを生成中 (Hunyuan3D Paint)', 65)
                mesh = paint(mesh, image=image)
                textured = True
        progress('GLB を書き出し中', 95)
        mesh.export(output_path)
        return {'textured': textured, 'warning': self.texture_error if texture and not textured else None}

    def retexture(self, mesh_path, image, output_path, *, seed, options, progress):
        paint = self._paint(progress)
        if paint is None:
            raise SetupError(self.texture_error)
        import trimesh
        image = self._prepare(image, progress)
        mesh = trimesh.load(mesh_path, force='mesh')
        progress('テクスチャを生成中 (Hunyuan3D Paint)', 20)
        mesh = paint(mesh, image=image)
        progress('GLB を書き出し中', 95)
        mesh.export(output_path)


# ─── TRELLIS (microsoft/TRELLIS) ───
class TrellisBackend(Backend):
    name = 'trellis'

    def __init__(self, args):
        super().__init__(args)
        self.capabilities = {'text': bool(args.trellis_text), 'image': True, 'texture': True,
                             'retexture': False, 'textured': True}

    def load(self, progress):
        os.environ.setdefault('SPCONV_ALGO', 'native')
        from trellis.pipelines import TrellisImageTo3DPipeline
        model = self.args.model or 'microsoft/TRELLIS-image-large'
        progress(f'TRELLIS を読み込み中 ({model})', 2)
        self.pipe = TrellisImageTo3DPipeline.from_pretrained(model)
        self.pipe.cuda()
        self.text_pipe = None
        self.loaded = True

    def unload(self):
        self.pipe = None
        self.text_pipe = None
        self.loaded = False
        free_cuda()

    def _params(self, seed, options):
        steps = int(options.get('steps') or self.args.steps)
        cfg = float(options.get('guidance') or self.args.guidance)
        return {
            'seed': int(seed) if seed is not None and seed >= 0 else 1,
            'sparse_structure_sampler_params': {'steps': steps, 'cfg_strength': cfg},
            'slat_sampler_params': {'steps': steps, 'cfg_strength': max(1.0, cfg / 2.5)},
        }

    def _export(self, outputs, output_path, target_faces, options, progress):
        from trellis.utils import postprocessing_utils
        progress('メッシュとテクスチャを焼き込み中', 70)
        simplify = 0.95
        if target_faces:
            try:
                n = int(outputs['mesh'][0].faces.shape[0])
                simplify = min(0.99, max(0.0, 1 - int(target_faces) / max(n, 1)))
            except Exception:
                pass
        glb = postprocessing_utils.to_glb(
            outputs['gaussian'][0], outputs['mesh'][0], simplify=simplify,
            texture_size=int(options.get('texture_size') or self.args.texture_size), verbose=False)
        progress('GLB を書き出し中', 95)
        glb.export(output_path)

    def image_to_3d(self, image, output_path, *, seed, texture, target_faces, options, progress):
        progress('形状とテクスチャを生成中 (TRELLIS)', 15)
        outputs = self.pipe.run(image, formats=['gaussian', 'mesh'], **self._params(seed, options))
        self._export(outputs, output_path, target_faces, options, progress)

    def text_to_3d(self, prompt, output_path, *, seed, texture, target_faces, options, progress):
        if not self.args.trellis_text:
            raise NotImplementedError('--trellis-text を付けて起動するとテキスト→3D が使えます')
        if self.text_pipe is None:
            from trellis.pipelines import TrellisTextTo3DPipeline
            model = self.args.text_model or 'microsoft/TRELLIS-text-xlarge'
            progress(f'TRELLIS (テキスト) を読み込み中 ({model})', 5)
            self.text_pipe = TrellisTextTo3DPipeline.from_pretrained(model)
            self.text_pipe.cuda()
        progress('形状とテクスチャを生成中 (TRELLIS text)', 15)
        outputs = self.text_pipe.run(prompt, formats=['gaussian', 'mesh'], **self._params(seed, options))
        self._export(outputs, output_path, target_faces, options, progress)


# ─── Stable Fast 3D (stabilityai/stable-fast-3d) ───
class SF3DBackend(Backend):
    name = 'sf3d'
    capabilities = {'text': False, 'image': True, 'texture': True, 'retexture': False, 'textured': True}

    def load(self, progress):
        import rembg
        from sf3d.system import SF3D
        self.device = default_device(self.args)
        model = self.args.model or 'stabilityai/stable-fast-3d'
        progress(f'Stable Fast 3D を読み込み中 ({model})', 2)
        self.model = SF3D.from_pretrained(model, config_name='config.yaml', weight_name='model.safetensors')
        self.model.to(self.device)
        self.model.eval()
        self.rembg_session = rembg.new_session()
        self.loaded = True

    def unload(self):
        self.model = None
        self.loaded = False
        free_cuda()

    def image_to_3d(self, image, output_path, *, seed, texture, target_faces, options, progress):
        import contextlib
        import torch
        from sf3d.utils import remove_background, resize_foreground
        progress('背景を除去中', 8)
        image = remove_background(image, self.rembg_session)
        image = resize_foreground(image, 0.85)
        if seed is not None and seed >= 0:
            torch.manual_seed(int(seed))
        progress('形状とテクスチャを生成中 (SF3D)', 20)
        ctx = torch.autocast(device_type='cuda', dtype=torch.bfloat16) if 'cuda' in self.device \
            else contextlib.nullcontext()
        with torch.no_grad(), ctx:
            mesh, _glob = self.model.run_image(
                image,
                bake_resolution=int(options.get('texture_size') or self.args.texture_size),
                remesh=options.get('remesh') or self.args.sf3d_remesh,
                vertex_count=int(target_faces) // 2 if target_faces else -1,
            )
        if isinstance(mesh, (list, tuple)):
            mesh = mesh[0]
        progress('GLB を書き出し中', 95)
        mesh.export(output_path, include_normals=True)


BUILTIN_BACKENDS = {
    'dummy': DummyBackend,
    'hunyuan3d': Hunyuan3DBackend,
    'trellis': TrellisBackend,
    'sf3d': SF3DBackend,
}


def create_backend(args):
    name = args.backend
    if name in BUILTIN_BACKENDS:
        return BUILTIN_BACKENDS[name](args)
    if ':' in name:
        mod_name, cls_name = name.split(':', 1)
        cls = getattr(importlib.import_module(mod_name), cls_name)
        return cls(args)
    raise SystemExit(f'不明なバックエンド: {name} (dummy / hunyuan3d / trellis / sf3d / <module>:<Class>)')


# ════════════════════════════════════════════════
# HTTP
# ════════════════════════════════════════════════
BACKEND = None
LOAD_LOCK = threading.Lock()


class SetupError(Exception):
    """バックエンドの準備不足 (パッケージ未インストール等)。利用者が直せる問題として 400 で返す"""


# バックエンドごとの「入っていない時の直し方」
SETUP_HINTS = {
    'hy3dgen': 'Hunyuan3D-2 を clone したフォルダで、この python の venv に `pip install -r requirements.txt` と `pip install -e .` を実行してください'
               ' (または config.json の model3d.cwd に Hunyuan3D-2 のフォルダを指定)',
    'trellis': 'TRELLIS の公式手順 (setup.sh) で依存を入れ、model3d.cwd に TRELLIS のフォルダを指定してください',
    'sf3d': 'stable-fast-3d を clone したフォルダで `pip install -r requirements.txt` を実行し、model3d.cwd にそのフォルダを指定してください',
    'rembg': '`pip install rembg` を実行してください',
    'custom_rasterizer': 'テクスチャ用の custom_rasterizer がビルドされていません (CUDA が必要)。形状だけで使うなら --no-texture を付けてください',
    'torch': 'GPU 対応の PyTorch (CUDA 版 / ROCm 版) を入れてください',
}


def ensure_loaded():
    with LOAD_LOCK:
        if not BACKEND.loaded:
            try:
                BACKEND.load(PROGRESS.set)
            except ModuleNotFoundError as e:
                raise missing_module_error(e) from e


def with_known_fix(msg):
    """よくある失敗に直し方を添える (エラー全文は長いので先頭だけ残す)"""
    if 'state_dict' in msg and ('q_proj' in msg or 'k_proj' in msg):
        # transformers 5.18 で DINOv2 の重み名が query/key/value → q_proj/k_proj/v_proj に変わり、
        # 旧名で保存された Hunyuan3D-2 等のチェックポイントが読めなくなった
        return ('transformers が新しすぎて、モデルの画像エンコーダ (DINOv2) の重みを読み込めません。'
                f'この python の venv で `pip install "transformers<5.18"` を実行してから再起動してください'
                f' (python: {sys.executable})。元のエラー: {msg[:300]}')
    return msg


def readonly_error(e):
    """モデルのダウンロード先に書けない時の説明。systemd の ProtectHome=read-only で起きやすい"""
    where = e.filename or ''
    return (f'モデルの保存先に書き込めません: {where} ({e.strerror})。'
            'OpenGeekLLMChat を systemd (ProtectHome=read-only) で動かしている場合、ホーム以下は書き込み禁止です。'
            'ホームに書けない時は主なライブラリの保存先を自動で <OpenGeekLLMChat>/models/model3d_cache に'
            '向けていますが、このライブラリは対象外でした。config.json の model3d.env でこのライブラリの保存先を'
            '書き込めるフォルダに向けるか、サービスの ReadWritePaths にこのフォルダを追加してください')


def missing_module_error(e):
    """ModuleNotFoundError を、使っている python・cwd・直し方を添えた SetupError にする"""
    mod = (e.name or '').split('.')[0]
    hint = SETUP_HINTS.get(mod, f'`{mod}` をこの python の環境に入れてください')
    return SetupError(
        f'バックエンド {BACKEND.name} に必要なパッケージ {mod} が見つかりません '
        f'(python: {sys.executable}, cwd: {os.getcwd()})。{hint}。'
        'config.json の model3d.command がそのパッケージを入れた venv の python を指しているかも確認してください')


def check_output_path(p):
    if not p or not isinstance(p, str) or not p.lower().endswith('.glb'):
        raise ValueError('output_path (.glb の絶対パス) が必要です')
    p = os.path.abspath(p)
    if ARGS.output_root and not p.startswith(os.path.abspath(ARGS.output_root) + os.sep):
        raise ValueError('output_path が出力ルートの外を指しています')
    os.makedirs(os.path.dirname(p), exist_ok=True)
    return p


def run_job(kind, body):
    """1件を同期実行。GPU は1件ずつなので JOB_LOCK で直列化する"""
    with JOB_LOCK:
        PROGRESS.busy = True
        PROGRESS.set('開始', 0)
        t0 = time.time()
        try:
            ensure_loaded()
            out = check_output_path(body.get('output_path'))
            seed = body.get('seed')
            seed = int(seed) if seed is not None and str(seed).lstrip('-').isdigit() else -1
            options = body.get('options') or {}
            if kind == 'texture':
                mesh_path = body.get('mesh_path')
                if not mesh_path or not os.path.isfile(mesh_path):
                    raise ValueError('mesh_path が見つかりません')
                BACKEND.retexture(mesh_path, decode_image(body.get('image')), out,
                                  seed=seed, options=options, progress=PROGRESS.set)
                textured = True
                warning = None
            else:
                texture = body.get('texture', True) is not False
                target_faces = body.get('target_faces') or None
                if body.get('mode') == 'text':
                    prompt = (body.get('prompt') or '').strip()
                    if not prompt:
                        raise ValueError('prompt が必要です')
                    r = BACKEND.text_to_3d(prompt, out, seed=seed, texture=texture, target_faces=target_faces,
                                           options=options, progress=PROGRESS.set)
                else:
                    r = BACKEND.image_to_3d(decode_image(body.get('image')), out, seed=seed, texture=texture,
                                            target_faces=target_faces, options=options, progress=PROGRESS.set)
                # バックエンドは {'textured', 'warning'} を返せる (返さなければ要求と能力から推定)
                info = r if isinstance(r, dict) else {}
                warning = info.get('warning')
                textured = info['textured'] if 'textured' in info \
                    else (texture or bool(BACKEND.capabilities.get('textured')))
            if not os.path.isfile(out):
                raise RuntimeError('バックエンドが GLB を書き出しませんでした')
            files = {'glb': os.path.basename(out)}
            files.update(export_extra_formats(out, body.get('formats')))
            verts, faces = mesh_stats(out)
            PROGRESS.set('完了', 100)
            return {
                'ok': True, 'output_path': out, 'files': files, 'textured': textured, 'warning': warning,
                'vertices': verts, 'faces': faces, 'elapsed': round(time.time() - t0, 1),
            }
        finally:
            PROGRESS.busy = False
            if ARGS.free_after_job:
                free_cuda()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *a):
        log.debug('%s - %s', self.address_string(), fmt % a)

    def _send(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > MAX_BODY:
            raise ValueError('リクエストが大きすぎます')
        raw = self.rfile.read(n) if n > 0 else b'{}'
        return json.loads(raw.decode('utf-8') or '{}')

    def do_GET(self):
        if self.path == '/health':
            return self._send(200, {
                'ok': True, 'backend': BACKEND.name, 'loaded': BACKEND.loaded,
                'capabilities': BACKEND.capabilities,
            })
        if self.path == '/status':
            return self._send(200, PROGRESS.snapshot())
        self._send(404, {'error': 'not found'})

    def do_POST(self):
        try:
            body = self._body()
        except Exception as e:
            return self._send(400, {'error': str(e)})
        if self.path in ('/generate', '/texture'):
            try:
                return self._send(200, run_job('texture' if self.path == '/texture' else 'generate', body))
            except (ValueError, NotImplementedError, SetupError) as e:
                return self._send(400, {'error': str(e)})
            except ModuleNotFoundError as e:
                return self._send(400, {'error': str(missing_module_error(e))})
            except OSError as e:
                if e.errno in (errno.EROFS, errno.EACCES, errno.EPERM):
                    return self._send(400, {'error': readonly_error(e)})
                log.error('生成失敗: %s\n%s', e, traceback.format_exc())
                return self._send(500, {'error': with_known_fix(f'{type(e).__name__}: {e}')})
            except Exception as e:
                log.error('生成失敗: %s\n%s', e, traceback.format_exc())
                return self._send(500, {'error': with_known_fix(f'{type(e).__name__}: {e}')})
        if self.path == '/unload':
            with JOB_LOCK:
                BACKEND.unload()
            return self._send(200, {'ok': True})
        self._send(404, {'error': 'not found'})


def parse_args(argv=None):
    p = argparse.ArgumentParser(description='OpenGeekLLMChat ローカル3Dモデル生成ワーカー')
    p.add_argument('--host', default='127.0.0.1')
    p.add_argument('--port', type=int, default=8093)
    p.add_argument('--backend', default='dummy', help='dummy / hunyuan3d / trellis / sf3d / <module>:<Class>')
    p.add_argument('--model', default=None, help='形状 (または全体) のモデル ID / パス')
    p.add_argument('--subfolder', default=None, help='hunyuan3d: サブフォルダ (例: hunyuan3d-dit-v2-mini)')
    p.add_argument('--texture-model', default=None, help='hunyuan3d: テクスチャモデル (既定 tencent/Hunyuan3D-2)')
    p.add_argument('--texture-subfolder', default=None,
                   help='hunyuan3d: テクスチャモデルの種類 (既定 hunyuan3d-paint-v2-0-turbo。高品質版は hunyuan3d-paint-v2-0)')
    p.add_argument('--text-model', default=None, help='trellis: テキストモデル (既定 microsoft/TRELLIS-text-xlarge)')
    p.add_argument('--trellis-text', action='store_true', help='trellis: テキスト→3D を有効にする')
    p.add_argument('--device', default=None, help='cuda / cpu (既定: 自動)')
    p.add_argument('--steps', type=int, default=30, help='拡散ステップ数 (hunyuan3d / trellis)')
    p.add_argument('--guidance', type=float, default=5.0, help='CFG スケール (hunyuan3d / trellis)')
    p.add_argument('--octree-resolution', type=int, default=256, help='hunyuan3d: メッシュ解像度')
    p.add_argument('--texture-size', type=int, default=1024, help='trellis / sf3d: テクスチャ解像度')
    p.add_argument('--sf3d-remesh', default='none', choices=['none', 'triangle', 'quad'])
    p.add_argument('--low-vram', action='store_true', help='hunyuan3d: テクスチャ生成を CPU オフロード')
    p.add_argument('--no-texture', action='store_true',
                   help='hunyuan3d: テクスチャ生成を使わず形状だけ出す (custom_rasterizer をビルドできない ROCm 環境等)')
    p.add_argument('--force-rembg', action='store_true', help='透過画像でも背景除去をかける')
    p.add_argument('--preload', action='store_true', help='起動時にモデルを読み込む (既定は最初の要求で読む)')
    p.add_argument('--free-after-job', action='store_true', help='1件ごとに CUDA キャッシュを解放')
    p.add_argument('--output-root', default=None, help='この配下以外への書き出しを拒否する')
    p.add_argument('--cache-dir', default=None,
                   help='モデル等の保存先をまとめてここに向ける (既定: ホームに書けない時だけ <OpenGeekLLMChat>/models/model3d_cache)')
    p.add_argument('--dummy-delay', type=float, default=2.0, help='dummy: 擬似的な処理時間 (秒)')
    return p.parse_args(argv)


ARGS = None

# OpenGeekLLMChat のルート (このファイルは system/model3d/ にある)
APP_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))

# 各ライブラリがモデルやキャッシュを書く場所を決める環境変数 → 保存先のサブフォルダ
# (既定はどれもホーム以下: ~/.cache/huggingface, ~/.cache/hy3dgen, ~/.rembg, ~/.cache/torch,
#  ~/.config/miopen, ~/.cache/miopen 等)
CACHE_ENV_DIRS = {
    'HF_HOME': 'huggingface',
    'HY3DGEN_MODELS': 'hy3dgen',
    'REMBG_HOME': 'rembg',            # rembg 2.0.8x 以降
    'U2NET_HOME': 'rembg',            # それより前の rembg
    'TORCH_HOME': 'torch',
    'XDG_CACHE_HOME': 'xdg-cache',
    'XDG_DATA_HOME': 'xdg-data',
    'XDG_CONFIG_HOME': 'xdg-config',
    'MIOPEN_USER_DB_PATH': 'miopen',  # ROCm の MIOpen (カーネルの性能DB・コンパイル結果)
    'MIOPEN_CUSTOM_CACHE_DIR': 'miopen',
    'TRITON_CACHE_DIR': 'triton',
    'NUMBA_CACHE_DIR': 'numba',
    'MPLCONFIGDIR': 'matplotlib',
}


def redirect_caches():
    """ホームに書けない時 (systemd の ProtectHome=read-only 等) に、各ライブラリの保存先を
    書き込めるフォルダへまとめて向ける。ライブラリごとに「Read-only file system」で
    1つずつ止まるのを防ぐため。利用者が環境変数を設定済みならそちらを優先する。
    ホームに書ける普段の環境では何もしない (既存のキャッシュを捨てて再ダウンロードさせない)"""
    if not ARGS.cache_dir and os.access(os.path.expanduser('~'), os.W_OK):
        return
    root = os.path.abspath(ARGS.cache_dir or os.path.join(APP_ROOT, 'models', 'model3d_cache'))
    changed = []
    for key, sub in CACHE_ENV_DIRS.items():
        if os.environ.get(key):
            continue
        path = os.path.join(root, sub)
        try:
            os.makedirs(path, exist_ok=True)
        except OSError as e:
            log.warning('保存先を作れません: %s (%s)', path, e)
            continue
        os.environ[key] = path
        changed.append(key)
    if changed:
        log.info('ホームに書き込めないため、モデル・キャッシュの保存先を %s に変更: %s', root, ', '.join(changed))


def main():
    global ARGS, BACKEND
    ARGS = parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s [model3d] %(message)s')
    # torch / hy3dgen / rembg を import する前に保存先を決める (import 時に読むライブラリがある)
    redirect_caches()
    # 作業フォルダ (config.json の model3d.cwd) のパッケージも import できるようにする。
    # このスクリプトは OpenGeekLLMChat 側にあるので、python は既定ではスクリプトのフォルダしか見ない。
    # Hunyuan3D-2 / TRELLIS / SF3D を pip install せずに clone したフォルダで使う場合に効く
    # (後ろに足すので、インストール済みのパッケージや標準ライブラリを上書きしない)
    if os.getcwd() not in sys.path:
        sys.path.append(os.getcwd())
    BACKEND = create_backend(ARGS)
    if ARGS.preload:
        ensure_loaded()
    srv = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    log.info('listening on %s:%d (backend=%s, capabilities=%s)', ARGS.host, ARGS.port, BACKEND.name,
             BACKEND.capabilities)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
