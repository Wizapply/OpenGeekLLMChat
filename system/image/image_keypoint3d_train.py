#!/usr/bin/env python3
"""
image_keypoint3d_train.py — OpenGeekLLMChat 3Dキーポイント回帰の学習

torchvision の ResNet バックボーンを使い、RGB画像1枚から各キーポイントの
(x, y, z) を直接回帰する。z はユーザーが手動で付けた「相対深度」(-1..1)。
MediaPipe は使わない。単一インスタンス(画像内に対象1つ)を前提とする。

出力座標の規約:
  x, y : 画像幅・高さで正規化した [0,1] (解像度非依存)
  z    : 相対深度 [-1,1] (アノテーションで手動設定した値)

引数:
  --dataset-dir <path>   データセットディレクトリ (dataset.json と images/)
  --output-dir <path>    学習済みモデルの保存先
  --backbone <name>      resnet18 | resnet34 | resnet50 (デフォルト resnet18)
  --epochs <int>         エポック数 (デフォルト30)
  --batch-size <int>     バッチサイズ (デフォルト8)
  --lr <float>           学習率 (デフォルト0.0005)
  --image-size <int>     入力リサイズの一辺 (デフォルト256)
  --cache-dir <path>     torch / MIOpen キャッシュ先
  --device <str>         cuda / cpu (省略時は自動、GPU失敗時CPUフォールバック)
"""
import argparse
import json
import os
import sys
import time
import traceback


def log(msg):
    print(msg, flush=True)


# ImageNet 正規化 (事前学習バックボーンに合わせる)
IMAGENET_MEAN = [0.485, 0.456, 0.406]
IMAGENET_STD = [0.229, 0.224, 0.225]

BACKBONES = ('resnet18', 'resnet34', 'resnet50')


def build_model(torch, torchvision, backbone, K, pretrained=True):
    """ResNet バックボーン + (K*3) を出力する全結合ヘッド"""
    tvm = torchvision.models
    if backbone == 'resnet18':
        m = tvm.resnet18(weights=tvm.ResNet18_Weights.DEFAULT if pretrained else None)
    elif backbone == 'resnet34':
        m = tvm.resnet34(weights=tvm.ResNet34_Weights.DEFAULT if pretrained else None)
    elif backbone == 'resnet50':
        m = tvm.resnet50(weights=tvm.ResNet50_Weights.DEFAULT if pretrained else None)
    else:
        raise ValueError(f"未対応のバックボーン: {backbone}")
    in_f = m.fc.in_features
    m.fc = torch.nn.Linear(in_f, K * 3)
    return m


def forward_pred(torch, model, imgs, K):
    """モデル出力を (B, K, 3) にして xy=sigmoid, z=tanh を適用"""
    out = model(imgs).view(-1, K, 3)
    xy = torch.sigmoid(out[..., :2])
    z = torch.tanh(out[..., 2:3])
    return torch.cat([xy, z], dim=-1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dataset-dir', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--backbone', default='resnet18')
    parser.add_argument('--epochs', type=int, default=30)
    parser.add_argument('--batch-size', type=int, default=8)
    parser.add_argument('--lr', type=float, default=0.0005)
    parser.add_argument('--image-size', type=int, default=256)
    parser.add_argument('--cache-dir', default=None)
    parser.add_argument('--device', default=None)
    args = parser.parse_args()

    if args.cache_dir:
        os.makedirs(args.cache_dir, exist_ok=True)
        os.environ['TORCH_HOME'] = args.cache_dir
        os.environ.setdefault('XDG_CACHE_HOME', args.cache_dir)
        miopen_dir = os.path.join(args.cache_dir, 'miopen')
        os.makedirs(miopen_dir, exist_ok=True)
        os.environ['MIOPEN_USER_DB_PATH'] = miopen_dir
        os.environ['MIOPEN_CUSTOM_CACHE_DIR'] = miopen_dir
        os.environ.setdefault('HIP_CACHE_DIR', os.path.join(args.cache_dir, 'hip'))

    try:
        import torch
        import torchvision
        from torchvision.io import read_image
        from torchvision.transforms.functional import convert_image_dtype, resize, normalize

        if args.backbone not in BACKBONES:
            raise ValueError(f"未対応のバックボーン: {args.backbone}")

        meta_path = os.path.join(args.dataset_dir, 'dataset.json')
        with open(meta_path, encoding='utf-8') as f:
            meta = json.load(f)
        keypoint_names = meta['keypoints']
        K = len(keypoint_names)
        if K < 1:
            raise ValueError("キーポイント名が1つもありません")
        images_dir = os.path.join(args.dataset_dir, 'images')
        S = max(64, int(args.image_size))

        annotated = [im for im in meta.get('images', []) if im.get('instances')]
        if len(annotated) == 0:
            raise ValueError("アノテーション済みの画像がありません。対象を囲み、キーポイントとzを設定してから学習してください")

        log(f"=== 3Dキーポイント回帰 学習開始 ===")
        log(f"データセット: {meta['name']}")
        log(f"キーポイント: {', '.join(keypoint_names)} ({K}点) + z(相対深度)")
        log(f"学習画像: {len(annotated)}枚 (アノテーション済み)")
        log(f"バックボーン: {args.backbone}, 入力サイズ: {S}x{S}")
        log(f"エポック: {args.epochs}, バッチ: {args.batch_size}, 学習率: {args.lr}")

        if args.device:
            try_devices = [torch.device(args.device)]
        elif torch.cuda.is_available():
            try_devices = [torch.device('cuda'), torch.device('cpu')]
        else:
            try_devices = [torch.device('cpu')]

        mean_t = torch.tensor(IMAGENET_MEAN).view(3, 1, 1)
        std_t = torch.tensor(IMAGENET_STD).view(3, 1, 1)

        # (画像テンソル[3,S,S], target[K,3], mask[K,1]) を作る
        def load_sample(im):
            img_path = os.path.join(images_dir, im['file'])
            img = read_image(img_path)
            if img.shape[0] == 1:
                img = img.repeat(3, 1, 1)
            elif img.shape[0] == 4:
                img = img[:3, :, :]
            _, H, W = img.shape
            imgf = convert_image_dtype(img, dtype=torch.float)
            imgf = resize(imgf, [S, S], antialias=True)
            imgf = (imgf - mean_t) / std_t

            # 可視キーポイントが最も多いインスタンスを採用 (単一インスタンス前提)
            best = None
            best_vis = -1
            for inst in im['instances']:
                kps = inst.get('keypoints') or []
                vis = sum(1 for kp in kps if kp and int(kp.get('v', 0)) > 0)
                if vis > best_vis:
                    best_vis = vis
                    best = inst
            if best is None or best_vis == 0:
                return None

            target = torch.zeros(K, 3, dtype=torch.float32)
            mask = torch.zeros(K, 1, dtype=torch.float32)
            kps = best.get('keypoints') or []
            for ki in range(K):
                kp = kps[ki] if ki < len(kps) else None
                if not kp:
                    continue
                v = int(kp.get('v', 0))
                if v <= 0:
                    continue
                x = float(kp.get('x', 0.0)) / max(1.0, W)
                y = float(kp.get('y', 0.0)) / max(1.0, H)
                z = float(kp.get('z', 0.0))
                # 範囲にクランプ
                x = min(1.0, max(0.0, x))
                y = min(1.0, max(0.0, y))
                z = min(1.0, max(-1.0, z))
                target[ki, 0] = x
                target[ki, 1] = y
                target[ki, 2] = z
                mask[ki, 0] = 1.0
            return imgf, target, mask

        samples = []
        for im in annotated:
            s = load_sample(im)
            if s is not None:
                samples.append(s)
        if len(samples) == 0:
            raise ValueError("有効なアノテーション(可視キーポイント)がありません")
        log(f"有効サンプル: {len(samples)}枚")

        last_err = None
        fallback_note = None
        trained_model = None
        used_device = None
        metrics_history = []

        for di, device in enumerate(try_devices):
            try:
                log(f"\nデバイス {device} で学習を試行...")
                model = build_model(torch, torchvision, args.backbone, K, pretrained=True).to(device)
                model.train()
                optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)
                l1 = torch.nn.L1Loss(reduction='none')
                batch_size = max(1, args.batch_size)

                metrics_history = []
                for epoch in range(args.epochs):
                    epoch_loss = 0.0
                    n_batches = 0
                    for i in range(0, len(samples), batch_size):
                        batch = samples[i:i + batch_size]
                        imgs = torch.stack([s[0] for s in batch]).to(device)
                        targets = torch.stack([s[1] for s in batch]).to(device)  # (B,K,3)
                        masks = torch.stack([s[2] for s in batch]).to(device)    # (B,K,1)

                        pred = forward_pred(torch, model, imgs, K)  # (B,K,3)
                        diff = l1(pred, targets) * masks  # 可視点のみ
                        denom = masks.sum() * 3.0
                        loss = diff.sum() / torch.clamp(denom, min=1.0)

                        optimizer.zero_grad()
                        loss.backward()
                        optimizer.step()

                        epoch_loss += float(loss.item())
                        n_batches += 1

                    avg_loss = epoch_loss / max(1, n_batches)
                    metrics_history.append({'epoch': epoch + 1, 'loss': round(avg_loss, 5)})
                    if (epoch + 1) % max(1, args.epochs // 20) == 0 or epoch == 0:
                        log(f"Epoch {epoch + 1}/{args.epochs} - loss: {avg_loss:.5f}")

                trained_model = model
                used_device = device
                if di > 0:
                    fallback_note = f"GPU学習に失敗したためCPUで実行しました ({last_err})"
                break
            except Exception as e:
                last_err = str(e).split('\n')[0][:200]
                log(f"デバイス {device} で失敗: {last_err}")
                try:
                    if device.type == 'cuda':
                        torch.cuda.empty_cache()
                except Exception:
                    pass
                continue

        if trained_model is None:
            raise RuntimeError(f"全デバイスで学習失敗: {last_err}")

        os.makedirs(args.output_dir, exist_ok=True)
        trained_model.eval()
        torch.save(trained_model.state_dict(), os.path.join(args.output_dir, 'model.pt'))

        config = {
            'task': 'keypoint',
            'dim': '3d',
            'backbone': args.backbone,
            'keypoints': keypoint_names,
            'numKeypoints': K,
            'imageSize': S,
            'skeleton': meta.get('skeleton', []),
            'datasetName': meta['name'],
            'epochs': args.epochs,
            'trainedAt': int(time.time()),
            'device': str(used_device),
        }
        with open(os.path.join(args.output_dir, 'config.json'), 'w', encoding='utf-8') as f:
            json.dump(config, f, ensure_ascii=False, indent=2)

        metrics = {
            'history': metrics_history,
            'finalLoss': metrics_history[-1]['loss'] if metrics_history else None,
            'sampleCount': len(samples),
        }
        with open(os.path.join(args.output_dir, 'metrics.json'), 'w', encoding='utf-8') as f:
            json.dump(metrics, f, ensure_ascii=False, indent=2)

        log(f"\n=== 学習完了 ===")
        log(f"最終loss: {metrics['finalLoss']}")
        log(f"保存先: {args.output_dir}")
        if fallback_note:
            log(f"注意: {fallback_note}")

        result = {
            'status': 'completed',
            'finalLoss': metrics['finalLoss'],
            'device': str(used_device),
            'keypoints': keypoint_names,
            'dim': '3d',
        }
        if fallback_note:
            result['note'] = fallback_note
        log("RESULT_JSON:" + json.dumps(result, ensure_ascii=False))
        sys.exit(0)

    except Exception as e:
        err = {'status': 'failed', 'error': str(e), 'traceback': traceback.format_exc()}
        log("RESULT_JSON:" + json.dumps(err, ensure_ascii=False))
        sys.exit(1)


if __name__ == '__main__':
    main()
