#!/usr/bin/env python3
"""
image_keypoint3d_detect.py — OpenGeekLLMChat 3Dキーポイント回帰の推論

image_keypoint3d_train.py で学習した ResNet 回帰モデルを使い、RGB画像1枚から
各キーポイントの (x, y, z) を推定する。z は相対深度 [-1,1]。単一インスタンス。

引数:
  --image <path>            検出対象の画像ファイルパス (必須)
  --custom-model-dir <path> 学習済みモデルのディレクトリ (config.json + model.pt, 必須)
  --device <str>            cuda / cpu (省略時は自動)
  --cache-dir <path>        torch / MIOpen キャッシュ先

標準出力 (JSON):
  {
    "model": "<name> (custom 3D)", "isCustom": true, "is3d": true,
    "imageWidth": W, "imageHeight": H, "device": "...",
    "keypointNames": [...], "skeleton": [...],
    "detections": [
      {"score": 1.0, "keypoints": [{"name":"wrist","x":..,"y":..,"z":..}, ...]}
    ],
    "count": 1
  }
"""
import argparse
import json
import os
import sys
import traceback


IMAGENET_MEAN = [0.485, 0.456, 0.406]
IMAGENET_STD = [0.229, 0.224, 0.225]
BACKBONES = ('resnet18', 'resnet34', 'resnet50')


def build_model(torch, torchvision, backbone, K):
    tvm = torchvision.models
    if backbone == 'resnet18':
        m = tvm.resnet18(weights=None)
    elif backbone == 'resnet34':
        m = tvm.resnet34(weights=None)
    elif backbone == 'resnet50':
        m = tvm.resnet50(weights=None)
    else:
        raise ValueError(f"未対応のバックボーン: {backbone}")
    in_f = m.fc.in_features
    m.fc = torch.nn.Linear(in_f, K * 3)
    return m


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True)
    parser.add_argument('--custom-model-dir', required=True)
    parser.add_argument('--device', default=None)
    parser.add_argument('--cache-dir', default=None)
    args = parser.parse_args()

    real_stdout = sys.stdout
    sys.stdout = sys.stderr

    def emit(obj):
        real_stdout.write(json.dumps(obj, ensure_ascii=False))
        real_stdout.flush()

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
        from torchvision.transforms.functional import convert_image_dtype, resize

        cfg_path = os.path.join(args.custom_model_dir, 'config.json')
        if not os.path.exists(cfg_path):
            raise FileNotFoundError(f"config.json が見つかりません: {cfg_path}")
        with open(cfg_path, encoding='utf-8') as f:
            cfg = json.load(f)
        keypoint_names = cfg['keypoints']
        K = len(keypoint_names)
        backbone = cfg.get('backbone', 'resnet18')
        S = int(cfg.get('imageSize', 256))
        skeleton = cfg.get('skeleton', [])

        if not os.path.exists(args.image):
            raise FileNotFoundError(f"画像が見つかりません: {args.image}")

        forced_device = args.device
        gpu_available = torch.cuda.is_available()

        model = build_model(torch, torchvision, backbone, K)
        state = torch.load(os.path.join(args.custom_model_dir, 'model.pt'), map_location='cpu')
        model.load_state_dict(state)
        model.eval()

        img = read_image(args.image)
        if img.shape[0] == 1:
            img = img.repeat(3, 1, 1)
        elif img.shape[0] == 4:
            img = img[:3, :, :]
        _, H, W = img.shape
        imgf = convert_image_dtype(img, dtype=torch.float)
        imgf = resize(imgf, [S, S], antialias=True)
        mean_t = torch.tensor(IMAGENET_MEAN).view(3, 1, 1)
        std_t = torch.tensor(IMAGENET_STD).view(3, 1, 1)
        imgf = (imgf - mean_t) / std_t
        inp = imgf.unsqueeze(0)  # (1,3,S,S)

        def run_on(dev):
            m = model.to(dev)
            x = inp.to(dev)
            with torch.no_grad():
                out = m(x).view(1, K, 3)
                xy = torch.sigmoid(out[..., :2])
                z = torch.tanh(out[..., 2:3])
                pred = torch.cat([xy, z], dim=-1)
            return pred[0].cpu()

        if forced_device:
            try_devices = [torch.device(forced_device)]
        elif gpu_available:
            try_devices = [torch.device('cuda'), torch.device('cpu')]
        else:
            try_devices = [torch.device('cpu')]

        pred = None
        device = None
        last_err = None
        fallback_note = None
        for i, dev in enumerate(try_devices):
            try:
                pred = run_on(dev)
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

        if pred is None:
            raise RuntimeError(f"全デバイスで推論失敗: {last_err}")

        kps_out = []
        for ki in range(K):
            x_norm = float(pred[ki, 0])
            y_norm = float(pred[ki, 1])
            z = float(pred[ki, 2])
            kps_out.append({
                'name': keypoint_names[ki],
                'x': round(x_norm * W, 1),
                'y': round(y_norm * H, 1),
                'z': round(z, 4),
            })

        result = {
            'model': cfg.get('datasetName', 'custom') + ' (custom 3D)',
            'isCustom': True,
            'is3d': True,
            'imageWidth': int(W),
            'imageHeight': int(H),
            'device': str(device),
            'keypointNames': keypoint_names,
            'skeleton': skeleton,
            'detections': [{'score': 1.0, 'keypoints': kps_out}],
            'count': 1,
        }
        if fallback_note:
            result['note'] = fallback_note
        emit(result)
        sys.exit(0)

    except Exception as e:
        emit({'error': str(e), 'traceback': traceback.format_exc()})
        sys.exit(1)


if __name__ == '__main__':
    main()
