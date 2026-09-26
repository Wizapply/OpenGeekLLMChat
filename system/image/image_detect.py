#!/usr/bin/env python3
"""
image_detect.py — OpenGeekLLMChat 画像物体検出 (torchvision, COCO事前学習)

引数:
  --image <path>     検出対象の画像ファイルパス (必須)
  --model <name>     使用モデル (デフォルト: fasterrcnn_resnet50_fpn)
  --threshold <float> 信頼度のしきい値 (デフォルト: 0.5)
  --device <str>     cuda / cpu (デフォルト: 自動検出)

標準出力 (JSON):
  {
    "model": "fasterrcnn_resnet50_fpn",
    "imageWidth": 640, "imageHeight": 480,
    "device": "cuda",
    "detections": [
      {"label": "person", "labelId": 1, "score": 0.99,
       "box": {"x1": 10.2, "y1": 20.1, "x2": 200.5, "y2": 400.8}},
      ...
    ],
    "count": 3
  }

エラー時:
  { "error": "...", "traceback": "..." }
"""
import argparse
import json
import os
import sys
import traceback


# COCO 2017 のクラス名 (torchvision のラベルIDに対応、index 0 は __background__)
# torchvision の検出モデルは COCO の 91 カテゴリID体系 (一部欠番あり) を返す
COCO_INSTANCE_CATEGORY_NAMES = [
    '__background__', 'person', 'bicycle', 'car', 'motorcycle', 'airplane',
    'bus', 'train', 'truck', 'boat', 'traffic light', 'fire hydrant', 'N/A',
    'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse',
    'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'N/A', 'backpack',
    'umbrella', 'N/A', 'N/A', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis',
    'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove',
    'skateboard', 'surfboard', 'tennis racket', 'bottle', 'N/A', 'wine glass',
    'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich',
    'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake',
    'chair', 'couch', 'potted plant', 'bed', 'N/A', 'dining table', 'N/A',
    'N/A', 'toilet', 'N/A', 'tv', 'laptop', 'mouse', 'remote', 'keyboard',
    'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator',
    'N/A', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier',
    'toothbrush',
]

# 対応モデル: 名前 → (torchvision weights enum 属性名, モデル構築関数名)
SUPPORTED_MODELS = {
    'fasterrcnn_resnet50_fpn': 'FasterRCNN_ResNet50_FPN_Weights',
    'fasterrcnn_mobilenet_v3_large_fpn': 'FasterRCNN_MobileNet_V3_Large_FPN_Weights',
    'retinanet_resnet50_fpn': 'RetinaNet_ResNet50_FPN_Weights',
    'ssd300_vgg16': 'SSD300_VGG16_Weights',
    'ssdlite320_mobilenet_v3_large': 'SSDLite320_MobileNet_V3_Large_Weights',
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True, help='検出対象の画像パス')
    parser.add_argument('--model', default='fasterrcnn_resnet50_fpn', help='使用モデル名')
    parser.add_argument('--threshold', type=float, default=0.5, help='信頼度しきい値')
    parser.add_argument('--device', default=None, help='cuda / cpu (省略時は自動)')
    parser.add_argument('--cache-dir', default=None, help='モデルweightのキャッシュ先 (書き込み可能なディレクトリ)')
    parser.add_argument('--custom-model-dir', default=None, help='カスタム学習済みモデルのディレクトリ (config.json + model.pt)')
    parser.add_argument('--nms-iou', type=float, default=None,
                        help='重複抑制(NMS)のIoU閾値。小さいほど重複を厳しく削除 (例: 0.2)。省略時はモデル既定値')
    parser.add_argument('--max-per-class', type=int, default=None,
                        help='クラスごとの最大検出数。信頼度の高い順に絞る (例: 顔1, 目2 など固定数なら有効)')
    args = parser.parse_args()

    # torch / torchvision は重みダウンロード時に「Downloading: ...」を stdout に
    # 直接 print することがある。これが検出結果JSONと混ざってパース失敗するため、
    # 処理中の stdout は stderr に退避し、最終的なJSON出力だけ本物の stdout に書く。
    real_stdout = sys.stdout
    sys.stdout = sys.stderr

    def emit(obj):
        """検出結果/エラーJSONを本物のstdoutに出力する"""
        real_stdout.write(json.dumps(obj, ensure_ascii=False))
        real_stdout.flush()

    # torch のモデルキャッシュ先を、書き込み可能なディレクトリに設定する。
    # 本番環境では systemd の ProtectHome 等で ~/.cache が読み取り専用のことがあるため、
    # import torch より前に環境変数で明示する必要がある。
    if args.cache_dir:
        os.makedirs(args.cache_dir, exist_ok=True)
        os.environ['TORCH_HOME'] = args.cache_dir
        # HuggingFace 系も念のため同じ場所に
        os.environ.setdefault('XDG_CACHE_HOME', args.cache_dir)

        # AMD ROCm の MIOpen (CNN畳み込みカーネル) も ~/.cache/miopen に
        # 実行時コンパイルしたカーネルをキャッシュしようとする。
        # 読み取り専用だと miopenStatusUnknownError になるため、書き込み可能な場所へ。
        miopen_dir = os.path.join(args.cache_dir, 'miopen')
        os.makedirs(miopen_dir, exist_ok=True)
        os.environ['MIOPEN_USER_DB_PATH'] = miopen_dir
        os.environ['MIOPEN_CUSTOM_CACHE_DIR'] = miopen_dir
        # HIP のカーネルキャッシュも同様に
        os.environ.setdefault('HIP_CACHE_DIR', os.path.join(args.cache_dir, 'hip'))

    try:
        import torch
        import torchvision
        from torchvision.io import read_image
        from torchvision.transforms.functional import convert_image_dtype

        is_custom = bool(args.custom_model_dir)

        # カスタムモデル: config.json からクラス名を読む。COCO標準: 固定リスト
        custom_classes = None
        if is_custom:
            cfg_path = os.path.join(args.custom_model_dir, 'config.json')
            if not os.path.exists(cfg_path):
                raise FileNotFoundError(f"カスタムモデルの config.json が見つかりません: {cfg_path}")
            with open(cfg_path, encoding='utf-8') as f:
                custom_cfg = json.load(f)
            custom_classes = custom_cfg['classes']  # 0始まりのクラス名
            base_model_name = custom_cfg.get('baseModel', 'fasterrcnn_resnet50_fpn')
        else:
            if args.model not in SUPPORTED_MODELS:
                raise ValueError(
                    f"未対応のモデル: {args.model}. "
                    f"対応モデル: {', '.join(SUPPORTED_MODELS.keys())}"
                )
        if not os.path.exists(args.image):
            raise FileNotFoundError(f"画像が見つかりません: {args.image}")

        # デバイス決定 (ROCm環境でも torch.cuda.is_available() は True)
        forced_device = args.device
        gpu_available = torch.cuda.is_available()

        # torch.hub のダウンロード進捗バーは stderr を汚染し、
        # 呼び出し側(Node)がエラーと誤認することがあるため抑制する
        try:
            torch.hub.set_dir(os.path.join(os.environ.get('TORCH_HOME', '.'), 'hub'))
        except Exception:
            pass

        if is_custom:
            # カスタム学習済みモデル: ベース構造を作って state_dict をロード
            from torchvision.models.detection.faster_rcnn import FastRCNNPredictor
            num_classes = len(custom_classes) + 1  # +1 背景
            if base_model_name == 'scratch':
                # scratch学習: ResNet50アーキを num_classes 直接指定で構築 (学習時と同じ)
                base_model = torchvision.models.detection.fasterrcnn_resnet50_fpn(
                    weights=None, weights_backbone=None, progress=False, num_classes=num_classes
                )
            else:
                model_fn = getattr(torchvision.models.detection, base_model_name)
                base_model = model_fn(weights=None, progress=False)  # weightsは後でロードするので不要
                in_features = base_model.roi_heads.box_predictor.cls_score.in_features
                base_model.roi_heads.box_predictor = FastRCNNPredictor(in_features, num_classes)
            state = torch.load(os.path.join(args.custom_model_dir, 'model.pt'), map_location='cpu')
            base_model.load_state_dict(state)
            base_model.eval()
        else:
            # COCO 事前学習モデル
            weights_enum_name = SUPPORTED_MODELS[args.model]
            weights_enum = getattr(torchvision.models.detection, weights_enum_name)
            weights = weights_enum.DEFAULT
            model_fn = getattr(torchvision.models.detection, args.model)
            base_model = model_fn(weights=weights, progress=False)
            base_model.eval()

        # NMS (重複抑制) のIoU閾値を上書き (小さいほど重複矩形を厳しく削除)
        # 目のような小さく密集した対象では 0.2〜0.3 が有効。デフォルトは 0.5。
        # Faster R-CNN / RetinaNet / SSD で属性名が異なるので、存在するものに設定する。
        if args.nms_iou is not None:
            try:
                if hasattr(base_model, 'roi_heads') and hasattr(base_model.roi_heads, 'nms_thresh'):
                    base_model.roi_heads.nms_thresh = float(args.nms_iou)  # Faster R-CNN
                elif hasattr(base_model, 'nms_thresh'):
                    base_model.nms_thresh = float(args.nms_iou)  # RetinaNet / SSD
            except Exception:
                pass

        # 画像読み込み (RGB に正規化)
        img = read_image(args.image)
        if img.shape[0] == 1:
            img = img.repeat(3, 1, 1)
        elif img.shape[0] == 4:
            img = img[:3, :, :]
        _, height, width = img.shape
        img_float_cpu = convert_image_dtype(img, dtype=torch.float)

        # 推論実行 (指定デバイスで試行、GPUで失敗したらCPUにフォールバック)
        def run_on(dev):
            model = base_model.to(dev)
            inp = img_float_cpu.to(dev)
            with torch.no_grad():
                outputs = model([inp])
            return outputs[0]

        # 試行するデバイスの順序を決める
        if forced_device:
            try_devices = [torch.device(forced_device)]
        elif gpu_available:
            # まずGPU、ダメならCPU
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
                    # フォールバックが発生した
                    fallback_note = f"GPU推論に失敗したためCPUで実行しました ({last_err})"
                break
            except Exception as e:
                last_err = str(e).split('\n')[0][:200]  # 1行目だけ
                # GPUメモリ解放
                try:
                    if dev.type == 'cuda':
                        torch.cuda.empty_cache()
                except Exception:
                    pass
                continue

        if out is None:
            raise RuntimeError(f"全デバイスで推論失敗: {last_err}")

        boxes = out['boxes'].cpu().tolist()
        labels = out['labels'].cpu().tolist()
        scores = out['scores'].cpu().tolist()

        detections = []
        for box, label_id, score in zip(boxes, labels, scores):
            if score < args.threshold:
                continue
            # ラベル名解決
            if is_custom:
                # カスタムモデル: labelId は 1始まり (背景0) → custom_classes は0始まり
                ci = label_id - 1
                if 0 <= ci < len(custom_classes):
                    label_name = custom_classes[ci]
                else:
                    label_name = f"id_{label_id}"
            else:
                # COCO: 範囲外や N/A はIDをそのまま使う
                if 0 <= label_id < len(COCO_INSTANCE_CATEGORY_NAMES):
                    label_name = COCO_INSTANCE_CATEGORY_NAMES[label_id]
                else:
                    label_name = f"id_{label_id}"
                if label_name == 'N/A':
                    label_name = f"id_{label_id}"
            x1, y1, x2, y2 = box
            detections.append({
                'label': label_name,
                'labelId': int(label_id),
                'score': round(float(score), 4),
                'box': {
                    'x1': round(float(x1), 1), 'y1': round(float(y1), 1),
                    'x2': round(float(x2), 1), 'y2': round(float(y2), 1),
                },
            })

        # 既に torchvision の出力は信頼度の降順だが、念のため score でソートしてから
        # クラスごとに最大検出数で打ち切る (顔1個・目2個など固定数の対象に有効)
        if args.max_per_class is not None and args.max_per_class > 0:
            detections.sort(key=lambda d: d['score'], reverse=True)
            seen_per_class = {}
            kept = []
            for d in detections:
                cls = d['label']
                n = seen_per_class.get(cls, 0)
                if n < args.max_per_class:
                    kept.append(d)
                    seen_per_class[cls] = n + 1
            detections = kept

        # スコア降順
        detections.sort(key=lambda d: d['score'], reverse=True)

        result = {
            'model': (custom_cfg.get('datasetName', 'custom') + ' (custom)') if is_custom else args.model,
            'isCustom': is_custom,
            'imageWidth': int(width),
            'imageHeight': int(height),
            'device': str(device),
            'threshold': args.threshold,
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
