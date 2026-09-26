#!/usr/bin/env python3
"""
ml_predict.py — OpenGeekLLMChat 機械学習モデルでの推論

引数: モデルディレクトリパス
標準入力: 推論したい特徴量データ JSON
標準出力: 予測結果 JSON

入力JSON形式:
  { "features": [{"col1": "Tokyo", "col2": 5}, {"col1": "Osaka", "col2": 3}, ...] }
  または時系列の場合:
  { "features": [[v1, v2, v3, ...], [...], ...] }  // windowSize 個の過去値を並べる

出力JSON形式:
  回帰: { "predictions": [12345.6, 7890.1, ...], "task": "regression" }
  分類: { "predictions": ["Tokyo", "Osaka", ...], "probabilities": [[0.7, 0.2, 0.1], ...], "classes": [...], "task": "classification" }
  時系列: { "predictions": [123.4, 56.7, ...], "task": "timeseries" }
"""
import argparse
import json
import os
import pickle
import sys
import traceback

# 共通モジュール (学習・推論で同じ前処理ロジックを共有)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ml_common import (
    DATETIME_FEATURES,
    classify_dtype,
    parse_datetime,
    expand_datetime_features,
    encode_value,
    example_input,
)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('model_dir', help='モデルが保存されたディレクトリのパス')
    args = parser.parse_args()

    model_dir = args.model_dir
    if not os.path.isdir(model_dir):
        print(json.dumps({'error': f'モデルディレクトリが存在しません: {model_dir}'}))
        sys.exit(1)

    try:
        # 設定ロード
        with open(os.path.join(model_dir, 'config.json'), 'r', encoding='utf-8') as f:
            cfg = json.load(f)
        with open(os.path.join(model_dir, 'scaler.pkl'), 'rb') as f:
            scaler_info = pickle.load(f)
        with open(os.path.join(model_dir, 'label_encoders.pkl'), 'rb') as f:
            encoders = pickle.load(f)

        # 入力読み込み
        input_data = json.loads(sys.stdin.read())
        features_in = input_data.get('features', [])
        if not features_in:
            print(json.dumps({'error': 'features が空です'}))
            sys.exit(1)

        # PyTorch + numpy をここで import (起動高速化)
        import numpy as np
        import torch
        import torch.nn as nn

        task = cfg['task']
        # 元の特徴量 (ユーザー指定) と展開後 (StandardScaler順) の両方を取得
        original_features = cfg.get('originalFeatures', cfg['features'])
        expanded_features = cfg.get('expandedFeatures', cfg['features'])
        feature_dtypes = cfg.get('featureDtypes', {})
        datetime_source_cols = set(cfg.get('datetimeSourceCols', []))
        datetime_features = cfg.get('datetimeFeatures', ['year', 'month', 'day', 'dayofweek', 'dayofyear', 'is_weekend'])

        # ─── 1. 入力をモデル用テンソルに変換 ───
        # 時系列タスクの場合は配列 of シーケンス、それ以外は配列 of 辞書
        if task == 'timeseries':
            # 入力: [[v1,v2,...,vN], ...] N=windowSize
            window = int(cfg.get('windowSize', 7))
            input_dim = cfg['inputDim']
            X_list = []
            for sample in features_in:
                if not isinstance(sample, list):
                    print(json.dumps({'error': '時系列タスクの features は配列の配列を期待 (各サンプルが windowSize 個の過去値)'}))
                    sys.exit(1)
                if len(sample) != window:
                    print(json.dumps({'error': f'各サンプルは {window} 個の過去値が必要 (受信: {len(sample)})'}))
                    sys.exit(1)
                # 各時点の値: スカラなら [v] に、リストなら [v1, v2, ...] に
                row = []
                for v in sample:
                    if isinstance(v, (int, float)):
                        row.append([float(v)])
                    elif isinstance(v, dict):
                        # 辞書なら原特徴量を展開してから取得
                        expanded = expand_datetime_features(v, datetime_source_cols, datetime_features)
                        vec = []
                        for col in expanded_features:
                            val = expanded.get(col)
                            vec.append(encode_value(col, val, feature_dtypes, encoders))
                        row.append(vec)
                    elif isinstance(v, list):
                        row.append([float(x) for x in v])
                    else:
                        row.append([0.0])
                X_list.append(row)
            X = np.array(X_list, dtype='float32')
            # スケーリング: 各時点の特徴量に対して標準化
            # X shape: (batch, window, features)
            scaler_mean = np.array(scaler_info['mean'], dtype='float32')
            scaler_scale = np.array(scaler_info['scale'], dtype='float32')
            X = (X - scaler_mean) / scaler_scale
        else:
            # 回帰/分類: 入力は辞書配列
            X_list = []
            for sample in features_in:
                if not isinstance(sample, dict):
                    print(json.dumps({'error': '回帰/分類の features は辞書配列を期待 (例: [{"region": "Tokyo", "quantity": 5}])'}))
                    sys.exit(1)
                # ⚠️ よくある間違い: ユーザー/LLM が日時派生列を直接渡している場合
                # 例: {"date_year": 2027, "date_month": 4} のような呼び方
                # → 元の日時列 (例: "date": "2027-04-15") を渡すべき
                misused_derived = []
                for src in datetime_source_cols:
                    for feat in datetime_features:
                        if f'{src}_{feat}' in sample and src not in sample:
                            misused_derived.append(f'{src}_{feat}')
                if misused_derived:
                    print(json.dumps({
                        'error': (
                            f'❌ 派生列が直接渡されています: {misused_derived}\n'
                            f'   このモデルは日時列 {list(datetime_source_cols)} を自動分解する設計です。\n'
                            f'   分解後の列 (例: date_year, date_month, ...) を直接渡すのは間違いです。\n'
                            f'   ✅ 正しい呼び方: 元の日時列を渡してください (例: "{list(datetime_source_cols)[0]}": "2027-04-15")。'
                        ),
                        'required_features_to_provide': original_features,
                        'datetime_columns_auto_expanded': list(datetime_source_cols),
                        'example_correct_input': example_input(original_features, datetime_source_cols),
                    }, ensure_ascii=False))
                    sys.exit(1)

                # 日時列があれば自動分解
                expanded = expand_datetime_features(sample, datetime_source_cols, datetime_features)
                row = []
                missing_cols = []
                for col in expanded_features:
                    val = expanded.get(col)
                    if val is None:
                        missing_cols.append(col)
                    else:
                        row.append(encode_value(col, val, feature_dtypes, encoders))
                if missing_cols:
                    # 不足列が日時派生列の場合、元の日時列が欠けていることを意味する
                    missing_datetime_sources = set()
                    for mc in missing_cols:
                        for src in datetime_source_cols:
                            if mc.startswith(src + '_'):
                                missing_datetime_sources.add(src)
                    missing_originals = []
                    for f in original_features:
                        if f in datetime_source_cols:
                            if f in missing_datetime_sources:
                                missing_originals.append(f)
                        elif f in missing_cols:
                            missing_originals.append(f)
                    print(json.dumps({
                        'error': (
                            f'❌ 必要な特徴量が不足しています: {missing_originals}\n'
                            f'   モデルが必要とする特徴量(元の列): {original_features}'
                        ),
                        'required_features_to_provide': original_features,
                        'missing': missing_originals,
                        'provided': list(sample.keys()),
                        'datetime_columns_auto_expanded': list(datetime_source_cols),
                        'example_correct_input': example_input(original_features, datetime_source_cols),
                    }, ensure_ascii=False))
                    sys.exit(1)
                X_list.append(row)
            X = np.array(X_list, dtype='float32')
            # スケーリング
            scaler_mean = np.array(scaler_info['mean'], dtype='float32')
            scaler_scale = np.array(scaler_info['scale'], dtype='float32')
            X = (X - scaler_mean) / scaler_scale

        # ─── 2. モデル再構築 + state_dict ロード ───
        input_dim = cfg['inputDim']
        hidden_size = int(cfg.get('hiddenSize', 64))
        num_layers = int(cfg.get('numLayers', 2))
        num_classes = cfg.get('numClasses')

        device = 'cuda' if torch.cuda.is_available() else 'cpu'

        if task == 'timeseries':
            class LSTMModel(nn.Module):
                def __init__(self):
                    super().__init__()
                    self.lstm = nn.LSTM(input_dim, hidden_size, num_layers=num_layers, batch_first=True)
                    self.fc = nn.Linear(hidden_size, 1)
                def forward(self, x):
                    out, _ = self.lstm(x)
                    return self.fc(out[:, -1, :]).squeeze(-1)
            model = LSTMModel()
        elif task == 'regression':
            class MLPReg(nn.Module):
                def __init__(self):
                    super().__init__()
                    layers = []
                    in_d = input_dim
                    for _ in range(num_layers):
                        layers += [nn.Linear(in_d, hidden_size), nn.ReLU(), nn.Dropout(0.1)]
                        in_d = hidden_size
                    layers.append(nn.Linear(hidden_size, 1))
                    self.net = nn.Sequential(*layers)
                def forward(self, x):
                    return self.net(x).squeeze(-1)
            model = MLPReg()
        elif task == 'classification':
            class MLPCls(nn.Module):
                def __init__(self):
                    super().__init__()
                    layers = []
                    in_d = input_dim
                    for _ in range(num_layers):
                        layers += [nn.Linear(in_d, hidden_size), nn.ReLU(), nn.Dropout(0.1)]
                        in_d = hidden_size
                    layers.append(nn.Linear(hidden_size, num_classes))
                    self.net = nn.Sequential(*layers)
                def forward(self, x):
                    return self.net(x)
            model = MLPCls()
        else:
            print(json.dumps({'error': f'未知のタスク: {task}'}))
            sys.exit(1)

        # state_dict 読み込み (CPU で読んでから device 転送)
        sd = torch.load(os.path.join(model_dir, 'model.pt'), map_location='cpu', weights_only=True)
        model.load_state_dict(sd)
        model = model.to(device)
        model.eval()

        # ─── 3. 推論 ───
        with torch.no_grad():
            xt = torch.tensor(X, dtype=torch.float32).to(device)
            out = model(xt)

            if task == 'classification':
                probs = torch.softmax(out, dim=1).cpu().numpy()
                pred_idx = out.argmax(dim=1).cpu().numpy()
                classes = encoders.get('target', {}).get('classes', [])
                predictions = [classes[i] if i < len(classes) else int(i) for i in pred_idx]
                result = {
                    'task': 'classification',
                    'predictions': predictions,
                    'probabilities': probs.tolist(),
                    'classes': classes,
                }
            else:
                # 回帰/時系列: スケール戻す
                pred_scaled = out.cpu().numpy().flatten()
                target_mean = scaler_info.get('target_mean')
                target_scale = scaler_info.get('target_scale')
                if target_mean is not None and target_scale is not None:
                    pred_raw = pred_scaled * target_scale + target_mean
                else:
                    pred_raw = pred_scaled
                result = {
                    'task': task,
                    'predictions': [float(v) for v in pred_raw],
                }

        result['modelName'] = cfg['modelName']
        result['count'] = len(result['predictions'])
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(0)

    except Exception as e:
        err_info = {
            'error': str(e),
            'traceback': traceback.format_exc(),
        }
        print(json.dumps(err_info, ensure_ascii=False))
        sys.exit(1)




if __name__ == '__main__':
    main()
