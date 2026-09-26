#!/usr/bin/env python3
"""
image_keypoint_train.py — OpenGeekLLMChat 画像キーポイント検出のカスタム学習

torchvision の Keypoint R-CNN を、ユーザーのアノテーション済みデータセットで
ファインチューニングする。手の関節など、対象(バウンディングボックス)とその
キーポイント(順序付きの点)を関連付けて学習する。

引数:
  --dataset-dir <path>   データセットディレクトリ (dataset.json と images/ を含む)
  --output-dir <path>    学習済みモデルの保存先
  --base-model <name>    keypointrcnn_resnet50_fpn (COCO事前学習) | scratch (ゼロから)
  --epochs <int>         エポック数 (デフォルト10)
  --batch-size <int>     バッチサイズ (デフォルト2)
  --lr <float>           学習率 (デフォルト0.005)
  --cache-dir <path>     torch / MIOpen キャッシュ先
  --device <str>         cuda / cpu (省略時は自動、GPU失敗時はCPUフォールバック)

進捗は標準出力に逐次出力 (Node.js がログとして拾う)。
学習完了後、output-dir に model.pt / config.json / metrics.json を保存。
"""
import argparse
import json
import os
import sys
import time
import traceback


def log(msg):
    """進捗を逐次出力 (flush して Node 側が即座に拾えるように)"""
    print(msg, flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dataset-dir', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--base-model', default='keypointrcnn_resnet50_fpn')
    parser.add_argument('--epochs', type=int, default=10)
    parser.add_argument('--batch-size', type=int, default=2)
    parser.add_argument('--lr', type=float, default=0.005)
    parser.add_argument('--cache-dir', default=None)
    parser.add_argument('--device', default=None)
    args = parser.parse_args()

    # キャッシュ先設定 (import torch より前)
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
        from torchvision.transforms.functional import convert_image_dtype
        from torchvision.models.detection.faster_rcnn import FastRCNNPredictor
        from torchvision.models.detection.keypoint_rcnn import KeypointRCNNPredictor

        # ベースモデル: COCO事前学習 か scratch (ゼロから)
        BASE_MODELS = ('keypointrcnn_resnet50_fpn', 'scratch')
        if args.base_model not in BASE_MODELS:
            raise ValueError(f"未対応のベースモデル: {args.base_model}")
        is_scratch = (args.base_model == 'scratch')

        # データセット読み込み
        meta_path = os.path.join(args.dataset_dir, 'dataset.json')
        with open(meta_path, encoding='utf-8') as f:
            meta = json.load(f)
        keypoint_names = meta['keypoints']
        K = len(keypoint_names)
        if K < 1:
            raise ValueError("キーポイント名が1つもありません")
        # 物体検出のクラスは「対象1種 + 背景」の2クラス (キーポイント学習では対象を1種に固定)
        num_classes = 2
        images_dir = os.path.join(args.dataset_dir, 'images')

        # アノテーション済み (インスタンスを持つ) 画像のみ抽出
        annotated = [im for im in meta.get('images', []) if im.get('instances')]
        if len(annotated) == 0:
            raise ValueError("アノテーション済みの画像がありません。対象を囲み、キーポイントを打ってから学習してください")

        log(f"=== 画像キーポイント検出 学習開始 ===")
        log(f"データセット: {meta['name']}")
        log(f"キーポイント: {', '.join(keypoint_names)} ({K}点)")
        log(f"学習画像: {len(annotated)}枚 (アノテーション済み)")
        log(f"ベースモデル: {args.base_model}")
        if is_scratch:
            log(f"⚠️ 事前学習なし (scratch) モードです。ゼロから学習するため、")
            log(f"   少量データでは精度が出にくく、多数のエポック・大量データが必要です。")
        log(f"エポック: {args.epochs}, バッチ: {args.batch_size}, 学習率: {args.lr}")

        # デバイス決定 (GPU優先、失敗時CPU)
        if args.device:
            try_devices = [torch.device(args.device)]
        elif torch.cuda.is_available():
            try_devices = [torch.device('cuda'), torch.device('cpu')]
        else:
            try_devices = [torch.device('cpu')]

        # データ準備: (画像テンソル, target辞書) のリスト
        def load_sample(im):
            img_path = os.path.join(images_dir, im['file'])
            img = read_image(img_path)
            if img.shape[0] == 1:
                img = img.repeat(3, 1, 1)
            elif img.shape[0] == 4:
                img = img[:3, :, :]
            img = convert_image_dtype(img, dtype=torch.float)

            boxes = []
            labels = []
            kpts = []
            for inst in im['instances']:
                b = inst.get('box') or {}
                x1, y1, x2, y2 = b.get('x1'), b.get('y1'), b.get('x2'), b.get('y2')
                if None in (x1, y1, x2, y2):
                    continue
                # 退化 boxを除外 (幅・高さが0以下)
                if x2 <= x1 or y2 <= y1:
                    continue
                # キーポイント配列 [K, 3] (x, y, visibility) を組み立てる
                kp_list = inst.get('keypoints') or []
                row = []
                visible_count = 0
                for ki in range(K):
                    kp = kp_list[ki] if ki < len(kp_list) else None
                    if kp is None:
                        row.append([0.0, 0.0, 0])
                        continue
                    v = int(kp.get('v', 2))
                    kx = float(kp.get('x', 0.0))
                    ky = float(kp.get('y', 0.0))
                    if v <= 0:
                        row.append([0.0, 0.0, 0])
                    else:
                        row.append([kx, ky, v])
                        visible_count += 1
                # 可視キーポイントが1つもないインスタンスは学習に使えない (loss が計算できない)
                if visible_count == 0:
                    continue
                boxes.append([x1, y1, x2, y2])
                labels.append(1)  # 対象クラスは1 (背景0)
                kpts.append(row)

            if not boxes:
                return None
            target = {
                'boxes': torch.tensor(boxes, dtype=torch.float32),
                'labels': torch.tensor(labels, dtype=torch.int64),
                'keypoints': torch.tensor(kpts, dtype=torch.float32),
            }
            return img, target

        samples = []
        for im in annotated:
            s = load_sample(im)
            if s is not None:
                samples.append(s)
        if len(samples) == 0:
            raise ValueError("有効なアノテーション(対象+可視キーポイント)がありません")
        log(f"有効サンプル: {len(samples)}枚")

        # モデル構築 (事前学習済みヘッドを付け替え、または scratch でゼロから)
        def build_model():
            if is_scratch:
                # 事前学習なし: num_classes / num_keypoints を直接指定して構築
                model = torchvision.models.detection.keypointrcnn_resnet50_fpn(
                    weights=None, weights_backbone=None, progress=False,
                    num_classes=num_classes, num_keypoints=K,
                )
                return model
            # COCO事前学習を読み込み、キーポイント数 K に合わせてヘッドを付け替える
            weights_enum = torchvision.models.detection.KeypointRCNN_ResNet50_FPN_Weights
            model = torchvision.models.detection.keypointrcnn_resnet50_fpn(
                weights=weights_enum.DEFAULT, progress=False,
            )
            # 分類ヘッド (背景 + 対象1種 = 2クラス) を付け替え
            in_features = model.roi_heads.box_predictor.cls_score.in_features
            model.roi_heads.box_predictor = FastRCNNPredictor(in_features, num_classes)
            # キーポイント予測ヘッドを K 点に付け替え
            kp_in = model.roi_heads.keypoint_predictor.kps_score_lowres.in_channels
            model.roi_heads.keypoint_predictor = KeypointRCNNPredictor(kp_in, num_keypoints=K)
            return model

        # 学習ループ (デバイスフォールバック付き)
        last_err = None
        fallback_note = None
        trained_model = None
        used_device = None
        metrics_history = []

        for di, device in enumerate(try_devices):
            try:
                log(f"\nデバイス {device} で学習を試行...")
                model = build_model().to(device)
                model.train()
                params = [p for p in model.parameters() if p.requires_grad]
                optimizer = torch.optim.SGD(params, lr=args.lr, momentum=0.9, weight_decay=0.0005)

                batch_size = max(1, args.batch_size)
                metrics_history = []
                for epoch in range(args.epochs):
                    epoch_loss = 0.0
                    n_batches = 0
                    for i in range(0, len(samples), batch_size):
                        batch = samples[i:i + batch_size]
                        imgs = [s[0].to(device) for s in batch]
                        targets = [{k: v.to(device) for k, v in s[1].items()} for s in batch]

                        loss_dict = model(imgs, targets)
                        losses = sum(loss for loss in loss_dict.values())

                        optimizer.zero_grad()
                        losses.backward()
                        optimizer.step()

                        epoch_loss += float(losses.item())
                        n_batches += 1

                    avg_loss = epoch_loss / max(1, n_batches)
                    metrics_history.append({'epoch': epoch + 1, 'loss': round(avg_loss, 4)})
                    log(f"Epoch {epoch + 1}/{args.epochs} - loss: {avg_loss:.4f}")

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

        # 保存
        os.makedirs(args.output_dir, exist_ok=True)
        model_path = os.path.join(args.output_dir, 'model.pt')
        trained_model.eval()
        torch.save(trained_model.state_dict(), model_path)

        config = {
            'task': 'keypoint',
            'baseModel': args.base_model,
            'keypoints': keypoint_names,     # 順序付きのキーポイント名
            'numKeypoints': K,
            'numClasses': num_classes,       # 背景込み (2)
            'skeleton': meta.get('skeleton', []),  # 描画用の骨格エッジ (任意)
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
