#!/usr/bin/env python3
"""
vjepa2_encode.py — V-JEPA 2 埋め込みキャッシュの事前生成 / 環境チェック CLI

rl_runner.py は学習時に未キャッシュ分を自動でエンコードするので、このスクリプトは
必須ではない。ただし次の用途で役に立つ:

  - 学習を回す前にキャッシュを温めておく (長いエンコードを学習と切り離す)
  - 依存ライブラリ・GPU・モデルIDが正しいかを軽く確認する (--probe)
  - キャッシュの使用量を確認する (--stat)

使い方:
  # 環境チェック (重みは落とすが1クリップだけ流す)
  python3 vjepa2_encode.py --probe

  # DuckDB のテーブルの列に入っているパスを全部エンコードしてキャッシュ
  python3 vjepa2_encode.py --db ml/ml.duckdb --table demos \
      --column frames --column next_frames --base-dir public/uploads

  # パス一覧ファイルからエンコード (1行1パス)
  python3 vjepa2_encode.py --paths clips.txt --base-dir public/uploads

  # キャッシュの状況
  python3 vjepa2_encode.py --stat

標準出力の最後に RESULT_JSON:<json> 行を出力する (Node.js が結果を拾う)。
"""
import argparse
import json
import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vjepa2_common as vj

DEFAULT_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ml', 'vjepa2_cache')


def log(msg):
    print(msg, flush=True)


def build_spec(args):
    return vj.normalize_spec({
        'modelId': args.model,
        'frames': args.frames,
        'stride': args.stride,
        'pooling': args.pooling,
        'batchSize': args.batch_size,
    })


def do_probe(args):
    """依存関係・デバイス・モデルを一通り確認し、ダミークリップを1本流す。"""
    import numpy as np
    import torch

    spec = build_spec(args)
    log('=== V-JEPA 2 環境チェック ===')
    log(f"  torch {torch.__version__}  cuda={torch.cuda.is_available()}")
    try:
        import transformers
        log(f"  transformers {transformers.__version__}")
        major, minor = (int(x) for x in transformers.__version__.split('.')[:2])
        if (major, minor) < (4, 52):
            log('  ⚠ V-JEPA 2 は transformers 4.52 以降が必要です')
    except ImportError:
        log('  ❌ transformers が入っていません')
        raise

    decoders = []
    for name in ('torchcodec', 'torchvision', 'decord'):
        try:
            __import__(name)
            decoders.append(name)
        except ImportError:
            pass
    log(f"  動画デコーダ: {', '.join(decoders) if decoders else '(なし)'}")
    if not decoders:
        log('  ⚠ 動画を読むには torchcodec / av(torchvision) / decord のいずれかが必要です')

    enc = vj.Encoder(spec, device=args.device, log=log)
    try:
        crop = int(getattr(enc.model.config, 'crop_size', 256))
        dummy = np.zeros((spec['frames'], crop, crop, 3), dtype='uint8')
        t0 = time.time()
        emb = enc.embed_clips([dummy])
        dt = time.time() - t0
        log(f"  ダミー1クリップ: {emb.shape} ({dt:.2f}秒)")
    finally:
        enc.close()

    log('RESULT_JSON:' + json.dumps({
        'status': 'completed', 'mode': 'probe',
        'spec': spec, 'embDim': int(emb.shape[1]),
        'device': enc.device, 'decoders': decoders,
        'secPerClip': round(dt, 3),
    }, ensure_ascii=False))


def do_stat(args):
    """キャッシュディレクトリの中身を spec 単位で集計する。"""
    root = args.cache_dir
    entries = []
    if os.path.isdir(root):
        for name in sorted(os.listdir(root)):
            d = os.path.join(root, name)
            if not os.path.isdir(d):
                continue
            files = [f for f in os.listdir(d) if f.endswith('.npy')]
            size = 0
            for f in files:
                try:
                    size += os.path.getsize(os.path.join(d, f))
                except OSError:
                    pass
            meta = vj._read_cache_meta(d) or {}
            entries.append({
                'key': name, 'count': len(files), 'bytes': size,
                'modelId': meta.get('modelId'), 'embDim': meta.get('embDim'),
            })
            log(f"  {name}: {len(files)} 件, {size/1e6:.1f} MB")
    if not entries:
        log('  (キャッシュは空です)')
    log('RESULT_JSON:' + json.dumps({
        'status': 'completed', 'mode': 'stat', 'cacheDir': root, 'entries': entries,
    }, ensure_ascii=False))


def collect_paths(args):
    """--table / --paths から観測ソースのパス配列を集める。"""
    paths = []
    if args.paths:
        with open(args.paths, 'r', encoding='utf-8') as f:
            paths += [ln.strip() for ln in f if ln.strip()]
    if args.table:
        import duckdb
        if not args.column:
            raise RuntimeError('--table には --column を1つ以上指定してください')
        for c in args.column:
            if '"' in c or '\\' in c or ';' in c:
                raise RuntimeError(f'不正な列名: {c}')
        from ml_common import connect_duckdb_ro
        con = connect_duckdb_ro(args.db, log=log)
        cols = ', '.join(f'"{c}"' for c in args.column)
        df = con.execute(f'SELECT {cols} FROM "{args.table}"').df()
        con.close()
        for c in args.column:
            paths += [v for v in df[c].tolist() if v is not None and str(v).strip()]
    return paths


def do_encode(args):
    spec = build_spec(args)
    log('=== V-JEPA 2 事前エンコード ===')
    log(f"  {vj.spec_label(spec)}")
    log(f"  キャッシュ: {args.cache_dir}")

    paths = collect_paths(args)
    log(f"  対象パス: {len(paths)} 件 (重複含む)")
    if not paths:
        raise RuntimeError('エンコード対象のパスがありません')

    t0 = time.time()
    emb, stats = vj.ensure_embeddings(
        paths, spec, args.cache_dir, base_dir=args.base_dir,
        log=log, device=args.device, strict=not args.skip_errors,
    )
    elapsed = time.time() - t0
    log(f"\n✅ 完了 ({elapsed:.1f}秒)  埋め込み次元={stats['embDim']}  "
        f"ヒット={stats['hit']} 新規={stats['miss']}")
    log('RESULT_JSON:' + json.dumps({
        'status': 'completed', 'mode': 'encode', 'spec': spec,
        'nPaths': len(paths), **stats, 'elapsedSec': round(elapsed, 1),
    }, ensure_ascii=False))


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--probe', action='store_true', help='環境チェックのみ')
    p.add_argument('--stat', action='store_true', help='キャッシュ使用状況のみ')
    p.add_argument('--db', default=os.path.join('ml', 'ml.duckdb'))
    p.add_argument('--table', default=None)
    p.add_argument('--column', action='append', default=None, help='観測パスの列 (複数可)')
    p.add_argument('--paths', default=None, help='パス一覧ファイル (1行1パス)')
    p.add_argument('--base-dir', default=None, help='相対パスの基点 (この外は拒否)')
    p.add_argument('--cache-dir', default=DEFAULT_CACHE_DIR)
    p.add_argument('--model', default=vj.DEFAULT_MODEL_ID)
    p.add_argument('--frames', type=int, default=vj.DEFAULT_FRAMES)
    p.add_argument('--stride', type=int, default=vj.DEFAULT_STRIDE)
    p.add_argument('--pooling', default=vj.DEFAULT_POOLING, choices=list(vj.POOLINGS))
    p.add_argument('--batch-size', type=int, default=vj.DEFAULT_BATCH_SIZE)
    p.add_argument('--device', default=None, help='cuda / cpu (既定は自動)')
    p.add_argument('--skip-errors', action='store_true', help='読めない観測をゼロベクトルで飛ばす')
    args = p.parse_args()

    os.makedirs(args.cache_dir, exist_ok=True)
    try:
        if args.stat:
            do_stat(args)
        elif args.probe:
            do_probe(args)
        else:
            do_encode(args)
        sys.exit(0)
    except Exception as e:
        log(f"\n❌ エラー: {e}")
        log(traceback.format_exc())
        log('RESULT_JSON:' + json.dumps({'status': 'failed', 'error': str(e)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == '__main__':
    main()
