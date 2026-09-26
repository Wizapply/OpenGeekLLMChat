#!/usr/bin/env python3
"""
image_keypoint_detect.py — OpenGeekLLMChat 画像キーポイント検出 (torchvision)

torchvision の Keypoint R-CNN で、画像から対象とそのキーポイント(関節など)を
検出する。COCO事前学習 (人物17点) と、カスタム学習済みモデルの両方に対応。

引数:
  --image <path>            検出対象の画像ファイルパス (必須)
  --threshold <float>       インスタンス信頼度のしきい値 (デフォルト: 0.5)
  --device <str>            cuda / cpu (省略時は自動)
  --cache-dir <path>        モデルweightのキャッシュ先 (書き込み可能なディレクトリ)
  --custom-model-dir <path> カスタム学習済みモデルのディレクトリ (config.json + model.pt)

標準出力 (JSON):
  {
    "model": "keypointrcnn_resnet50_fpn",
    "isCustom": false,
    "imageWidth": 640, "imageHeight": 480,
    "device": "cuda",
    "keypointNames": ["nose", ...],
    "skeleton": [[0,1], ...],
    "detections": [
      {"score": 0.99,
       "box": {"x1":..,"y1":..,"x2":..,"y2":..},
       "keypoints": [{"name":"nose","x":..,"y":..,"score":..}, ...]},
      ...
    ],
    "count": 2
  }

エラー時:
  { "error": "...", "traceback": "..." }
"""
import argparse
import json
import os
import sys
import traceback


# COCO の人物キーポイント名 (keypointrcnn_resnet50_fpn の出力順、17点)
COCO_KEYPOINT_NAMES = [
    'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
    'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
    'left_wrist', 'right_wrist', 'left_hip', 'right_hip',
    'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
]
# COCO 人物の骨格エッジ (描画用、0始まりインデックス)
COCO_SKELETON = [
    [0, 1], [0, 2], [1, 3], [2, 4], [5, 6], [5, 7], [7, 9], [6, 8], [8, 10],
    [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True, help='検出対象の画像パス')
    parser.add_argument('--threshold', type=float, default=0.5, help='信頼度しきい値')
    parser.add_argument('--device', default=None, help='cuda / cpu (省略時は自動)')
    parser.add_argument('--cache-dir', default=None, help='モデルweightのキャッシュ先')
    parser.add_argument('--custom-model-dir', default=None, help='カスタム学習済みモデルのディレクトリ')
    parser.add_argument('--max-instances', type=int, default=None,
                        help='検出インスタンスの最大数 (信頼度の高い順に絞る)')
    args = parser.parse_args()

    # torch / torchvision はダウンロード進捗を stdout に直接 print することがあり、
    # 結果JSONと混ざってパース失敗するため、処理中の stdout は stderr に退避する。
    real_stdout = sys.stdout
    sys.stdout = sys.stderr

    def emit(obj):
        real_stdout.write(json.dumps(obj, ensure_ascii=False))
        real_stdout.flush()

    # torch のモデルキャッシュ先を書き込み可能なディレクトリに設定 (import torch より前)
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

        is_custom = bool(args.custom_model_dir)

        # カスタムモデル: config.json からキーポイント名を読む。COCO標準: 固定リスト
        custom_cfg = None
        if is_custom:
            cfg_path = os.path.join(args.custom_model_dir, 'config.json')
            if not os.path.exists(cfg_path):
                raise FileNotFoundError(f"カスタムモデルの config.json が見つかりません: {cfg_path}")
            with open(cfg_path, encoding='utf-8') as f:
                custom_cfg = json.load(f)
            keypoint_names = custom_cfg['keypoints']
            skeleton = custom_cfg.get('skeleton', [])
            base_model_name = custom_cfg.get('baseModel', 'keypointrcnn_resnet50_fpn')
        else:
            keypoint_names = COCO_KEYPOINT_NAMES
            skeleton = COCO_SKELETON

        if not os.path.exists(args.image):
            raise FileNotFoundError(f"画像が見つかりません: {args.image}")

        K = len(keypoint_names)
        forced_device = args.device
        gpu_available = torch.cuda.is_available()

        try:
            torch.hub.set_dir(os.path.join(os.environ.get('TORCH_HOME', '.'), 'hub'))
        except Exception:
            pass

        if is_custom:
            # カスタム学習済みモデル: ベース構造を作って state_dict をロード
            from torchvision.models.detection.faster_rcnn import FastRCNNPredictor
            from torchvision.models.detection.keypoint_rcnn import KeypointRCNNPredictor
            num_classes = custom_cfg.get('numClasses', 2)
            if base_model_name == 'scratch':
                base_model = torchvision.models.detection.keypointrcnn_resnet50_fpn(
                    weights=None, weights_backbone=None, progress=False,
                    num_classes=num_classes, num_keypoints=K,
                )
            else:
                base_model = torchvision.models.detection.keypointrcnn_resnet50_fpn(
                    weights=None, progress=False,
                )
                in_features = base_model.roi_heads.box_predictor.cls_score.in_features
                base_model.roi_heads.box_predictor = FastRCNNPredictor(in_features, num_classes)
                kp_in = base_model.roi_heads.keypoint_predictor.kps_score_lowres.in_channels
                base_model.roi_heads.keypoint_predictor = KeypointRCNNPredictor(kp_in, num_keypoints=K)
            state = torch.load(os.path.join(args.custom_model_dir, 'model.pt'), map_location='cpu')
            base_model.load_state_dict(state)
            base_model.eval()
        else:
            # COCO 事前学習モデル (人物17点)
            weights_enum = torchvision.models.detection.KeypointRCNN_ResNet50_FPN_Weights
            base_model = torchvision.models.detection.keypointrcnn_resnet50_fpn(
                weights=weights_enum.DEFAULT, progress=False,
            )
            base_model.eval()

        # 画像読み込み (RGB に正規化)
        img = read_image(args.image)
        if img.shape[0] == 1:
            img = img.repeat(3, 1, 1)
        elif img.shape[0] == 4:
            img = img[:3, :, :]
        _, height, width = img.shape
        img_float_cpu = convert_image_dtype(img, dtype=torch.float)

        def run_on(dev):
            model = base_model.to(dev)
            inp = img_float_cpu.to(dev)
            with torch.no_grad():
                outputs = model([inp])
            return outputs[0]

        if forced_device:
            try_devices = [torch.device(forced_device)]
        elif gpu_available:
            try_devices = [torch.device('cuda'), torch.device('cpu')]
        else:
            try_devices = [torch.device('cpu')]

        out = None
        device = None
        last_err = None
        fallback_note = None
        for i, dev in enumerate(try_devices):
            try:
                out = run_on(dev)
                device = dev
                if i > 0:
                    fallback_note = f"GPU推論に失敗したためCPUで実行しました ({last_err})"
                break
            except Exception as e:
                last_err = str(e).split('\n')[0][:200]
                try:
                    if dev.type == 'cuda':
                        torch.cuda.empty_cache()
                except Exception:
                    pass
                continue

        if out is None:
            raise RuntimeError(f"全デバイスで推論失敗: {last_err}")

        boxes = out['boxes'].cpu().tolist()
        scores = out['scores'].cpu().tolist()
        # keypoints: [N, K, 3] (x, y, visibility), keypoints_scores: [N, K]
        keypoints = out['keypoints'].cpu().tolist() if 'keypoints' in out else []
        kp_scores = out['keypoints_scores'].cpu().tolist() if 'keypoints_scores' in out else None

        detections = []
        for idx, score in enumerate(scores):
            if score < args.threshold:
                continue
            x1, y1, x2, y2 = boxes[idx]
            kps_out = []
            kp_arr = keypoints[idx] if idx < len(keypoints) else []
            for ki in range(min(K, len(kp_arr))):
                kx, ky = kp_arr[ki][0], kp_arr[ki][1]
                ks = (kp_scores[idx][ki] if kp_scores and idx < len(kp_scores)
                      and ki < len(kp_scores[idx]) else None)
                kps_out.append({
                    'name': keypoint_names[ki] if ki < len(keypoint_names) else f"kp{ki}",
                    'x': round(float(kx), 1),
                    'y': round(float(ky), 1),
                    'score': round(float(ks), 4) if ks is not None else None,
                })
            detections.append({
                'score': round(float(score), 4),
                'box': {
                    'x1': round(float(x1), 1), 'y1': round(float(y1), 1),
                    'x2': round(float(x2), 1), 'y2': round(float(y2), 1),
                },
                'keypoints': kps_out,
            })

        detections.sort(key=lambda d: d['score'], reverse=True)
        if args.max_instances is not None and args.max_instances > 0:
            detections = detections[:args.max_instances]

        result = {
            'model': (custom_cfg.get('datasetName', 'custom') + ' (custom)') if is_custom else 'keypointrcnn_resnet50_fpn',
            'isCustom': is_custom,
            'imageWidth': int(width),
            'imageHeight': int(height),
            'device': str(device),
            'threshold': args.threshold,
            'keypointNames': keypoint_names,
            'skeleton': skeleton,
            'detections': detections,
            'count': len(detections),
        }
        if fallback_note:
            result['note'] = fallback_note
        emit(result)
        sys.exit(0)

    except Exception as e:
        emit({
            'error': str(e),
            'traceback': traceback.format_exc(),
        })
        sys.exit(1)


if __name__ == '__main__':
    main()
