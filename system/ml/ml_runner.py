#!/usr/bin/env python3
"""
ml_runner.py — OpenGeekLLMChat 機械学習 (ML) ジョブ実行スクリプト

DuckDB の表データから PyTorch で MLP / LSTM を学習する。
タスク:
  - regression:     数値予測 (MSELoss, MLP)
  - classification: カテゴリ予測 (CrossEntropyLoss, MLP)
  - timeseries:     時系列予測 (MSELoss, LSTM, スライディングウィンドウ)

入力: 設定 JSON ファイルパスを引数で受け取る
  {
    "modelName": "sales_predictor",
    "task": "regression" | "classification" | "timeseries",
    "tableName": "sales_test",
    "features": ["col1", "col2", ...],  // 特徴量カラム
    "target": "target_col",              // ターゲットカラム
    "timeCol": "date",                   // 時系列のみ (時間順ソート用)
    "windowSize": 7,                     // 時系列のみ (過去N点を入力)
    "epochs": 100,
    "learningRate": 0.001,
    "batchSize": 32,
    "hiddenSize": 64,
    "numLayers": 2,                      // 隠れ層数 (MLP) / LSTM層数
    "testRatio": 0.2,
    "outputDir": "/path/to/models/sales_predictor",
    "dbPath": "/path/to/ml/datasets.duckdb"
  }

出力 (outputDir に保存):
  - config.json         # 設定 + メタ (カラム順、エンコーダ情報等)
  - model.pt            # state_dict
  - scaler.pkl          # 特徴量の StandardScaler
  - label_encoders.pkl  # カテゴリカラムの LabelEncoder マップ
  - metrics.json        # 学習指標
  - train.log           # 学習ログ

注意: pickle ファイルは互換性のため簡素なフォーマット (dict) で保存する。
"""
import argparse
import json
import os
import pickle
import sys
import time
import traceback
from pathlib import Path

# 共通モジュール (学習・推論で同じ前処理ロジックを共有)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ml_common import classify_dtype, DATETIME_FEATURES

# 進捗を逐次標準出力に流す (Node.js が拾う)
def log(msg):
    print(msg, flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('config_path', help='設定JSONのパス')
    args = parser.parse_args()

    with open(args.config_path, 'r', encoding='utf-8') as f:
        cfg = json.load(f)

    log(f"=== ML 学習開始 ===")
    log(f"モデル名: {cfg['modelName']}")
    log(f"タスク:   {cfg['task']}")
    log(f"テーブル: {cfg['tableName']}")
    log(f"特徴量:   {', '.join(cfg['features'])}")
    log(f"ターゲット: {cfg['target']}")

    output_dir = Path(cfg['outputDir'])
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        # 1. ライブラリ読み込み (遅延 import で起動を高速化)
        log("\n[1/6] ライブラリ読み込み...")
        try:
            import duckdb
            import numpy as np
            import pandas as pd
            from sklearn.preprocessing import StandardScaler, LabelEncoder
            from sklearn.model_selection import train_test_split
            import torch
            import torch.nn as nn
            from torch.utils.data import DataLoader, TensorDataset
        except ImportError as e:
            log(f"❌ ライブラリ不足: {e}")
            log("  pip install duckdb pandas scikit-learn torch --break-system-packages")
            sys.exit(2)

        device = 'cuda' if torch.cuda.is_available() else 'cpu'
        # ROCm/HIP の場合も torch.cuda.is_available() が true を返す (HIP互換)
        log(f"  device: {device}")
        if device == 'cuda':
            log(f"  GPU: {torch.cuda.get_device_name(0)}")

        # 2. DuckDB からデータ取得 (read-only で開く)
        # 注意: DuckDB は排他ロック (https://duckdb.org/docs/stable/connect/concurrency)
        # サーバー側(Node.js)が学習開始時にCHECKPOINT + 接続クローズを行うので、
        # ここでは普通に read_only で開ける。Pythonが終了したらNodeが自動で再オープン。
        log("\n[2/6] データ取得...")
        con = duckdb.connect(cfg['dbPath'], read_only=True)
        cols_needed = cfg['features'] + [cfg['target']]
        if cfg['task'] == 'timeseries':
            cols_needed.append(cfg['timeCol'])
        cols_list = ', '.join(f'"{c}"' for c in set(cols_needed))
        if cfg['task'] == 'timeseries':
            sql = f'SELECT {cols_list} FROM "{cfg["tableName"]}" ORDER BY "{cfg["timeCol"]}"'
        else:
            sql = f'SELECT {cols_list} FROM "{cfg["tableName"]}"'
        df = con.execute(sql).df()
        con.close()
        log(f"  取得行数: {len(df)}")
        # NULL 除去 (元データ段階の NULL)
        before = len(df)
        df = df.dropna(subset=cols_needed)
        if before != len(df):
            log(f"  元データNULL除外: {before} → {len(df)} 行")
        if len(df) < 10:
            raise RuntimeError(
                f"データが少なすぎます (NULL除外後 {len(df)} 行)。最低 10 行必要です。\n"
                f"  対象テーブル: {cfg['tableName']}\n"
                f"  必要カラム: {cols_needed}\n"
                f"  ヒント: 該当カラムに NULL/空値が大量にないか SQLクエリタブで確認してください。"
            )

        # 3. 前処理
        log("\n[3/6] 前処理...")
        # データ型情報を表示 (デバッグに便利)
        log(f"  カラム型: {dict(df.dtypes.astype(str))}")

        # カテゴリ/数値/日時 カラムの判定は ml_common.classify_dtype に集約
        # (DuckDB Node binding が pandas 2.0+ で 'str' を返す等の互換性は ml_common 側で対応)

        # 日時列が特徴量に含まれている場合、複数の派生特徴に展開
        # date → year, month, day, dayofweek, dayofyear, is_weekend (6列、ml_common.DATETIME_FEATURES と同じ)
        # 学習時に展開された列名を記憶 (推論時にも同じ展開を行う)
        datetime_source_cols = {}  # {'date': True} のように記録 (推論時に再現)
        expanded_features = []     # 展開後の最終的な特徴量カラム名リスト
        for col in cfg['features']:
            kind = classify_dtype(df[col].dtype)
            if kind == 'datetime':
                log(f"  日時:     {col} → 自動分解 ({', '.join(DATETIME_FEATURES)})")
                # 日時を確実に datetime64 に
                df[col] = pd.to_datetime(df[col], errors='coerce')
                # 派生列追加 (元の列名 + '_' + 派生名)
                for feat in DATETIME_FEATURES:
                    new_col = f'{col}_{feat}'
                    if feat == 'year':       df[new_col] = df[col].dt.year
                    elif feat == 'month':    df[new_col] = df[col].dt.month
                    elif feat == 'day':      df[new_col] = df[col].dt.day
                    elif feat == 'dayofweek': df[new_col] = df[col].dt.dayofweek
                    elif feat == 'dayofyear': df[new_col] = df[col].dt.dayofyear
                    elif feat == 'is_weekend': df[new_col] = (df[col].dt.dayofweek >= 5).astype(int)
                    df[new_col] = df[new_col].astype('float64')
                    expanded_features.append(new_col)
                datetime_source_cols[col] = True
                # 元の日時列は特徴量から除外
            else:
                expanded_features.append(col)

        # 元の cfg['features'] をそのまま保存 (推論時の再現性確保用)
        # 学習用は expanded_features を使う
        original_features = cfg['features']
        cfg_features_for_train = expanded_features

        label_encoders = {}
        feature_dtypes = {}
        for col in cfg_features_for_train:
            kind = classify_dtype(df[col].dtype)
            if kind == 'datetime':
                # この時点ではここに来ないはず (上で分解済み)、念のため
                raise RuntimeError(f"内部エラー: 日時列 {col} が展開漏れ")
            elif kind == 'category':
                le = LabelEncoder()
                df[col] = le.fit_transform(df[col].astype(str))
                label_encoders[col] = {'classes': le.classes_.tolist()}
                feature_dtypes[col] = 'category'
                cls_preview = list(le.classes_)[:5]
                log(f"  カテゴリ: {col} → {len(le.classes_)} クラス {cls_preview}{'...' if len(le.classes_) > 5 else ''}")
            else:  # numeric
                feature_dtypes[col] = 'numeric'
                try:
                    df[col] = df[col].astype('float64')
                except (TypeError, ValueError):
                    df[col] = pd.to_numeric(df[col], errors='coerce')
                # 日時派生列はログを抑制 (大量に出るため、まとめ表示済み)
                if not any(col.startswith(src + '_') for src in datetime_source_cols):
                    log(f"  数値:     {col} ({df[col].dtype})")

        # NaN を含む行を除外 (展開後の全特徴量で確認)
        before = len(df)
        df = df.dropna(subset=cfg_features_for_train)
        after = len(df)
        if before != after:
            log(f"  特徴量NaN除外: {before} → {after} 行")

        if len(df) == 0:
            raise RuntimeError(
                f"前処理後にデータが0行になりました。\n"
                f"  特徴量カラム (元): {original_features}\n"
                f"  特徴量カラム (展開後): {cfg_features_for_train}\n"
                f"  ターゲット: {cfg['target']}\n"
            )
        if len(df) < 20:
            log(f"  ⚠️ サンプル数が少ない ({len(df)} 行)、過学習に注意")

        X = df[cfg_features_for_train].values.astype('float32')
        log(f"  X shape: {X.shape} (特徴量 {len(cfg_features_for_train)}個: {cfg_features_for_train[:8]}{'...' if len(cfg_features_for_train) > 8 else ''})")

        target_encoder = None
        target_scaler = None  # 回帰/時系列用 (推論時に逆変換)
        if cfg['task'] == 'classification':
            le_t = LabelEncoder()
            y = le_t.fit_transform(df[cfg['target']].astype(str))
            target_encoder = {'classes': le_t.classes_.tolist()}
            num_classes = len(le_t.classes_)
            log(f"  分類クラス数: {num_classes} ({list(le_t.classes_)[:5]}{'...' if num_classes > 5 else ''})")
        else:
            # 回帰/時系列: ターゲットも float64 に強制
            try:
                y_series = df[cfg['target']].astype('float64')
            except (TypeError, ValueError):
                y_series = pd.to_numeric(df[cfg['target']], errors='coerce')
            # ターゲットが NaN な行を更に除外
            mask = y_series.notna()
            removed = (~mask).sum()
            if removed > 0:
                log(f"  ターゲットNaN除外: -{removed} 行")
                df = df[mask].reset_index(drop=True)
                X = X[mask.values]
                y_series = y_series[mask].reset_index(drop=True)
            if len(y_series) == 0:
                raise RuntimeError(f"ターゲット {cfg['target']} が全て NaN です。型を確認してください。")
            y_raw = y_series.values.astype('float32')
            log(f"  y(raw) shape: {y_raw.shape}, 範囲: [{y_raw.min():.2f}, {y_raw.max():.2f}], 平均: {y_raw.mean():.2f}")

            # ターゲットも StandardScale して学習安定化 (推論時は逆変換)
            # 大きな値域 (例: sales 10000~60000) だと MSE loss が 1e8 オーダーになり数値的に不安定
            target_scaler = StandardScaler()
            y = target_scaler.fit_transform(y_raw.reshape(-1, 1)).flatten().astype('float32')
            log(f"  y(scaled) shape: {y.shape}, 範囲: [{y.min():.2f}, {y.max():.2f}] (mean={target_scaler.mean_[0]:.2f}, scale={target_scaler.scale_[0]:.2f})")

        # 特徴量の StandardScaler
        scaler = StandardScaler()
        X = scaler.fit_transform(X)

        # 時系列の場合はウィンドウ作成
        if cfg['task'] == 'timeseries':
            window = int(cfg.get('windowSize', 7))
            if len(X) <= window + 5:
                raise RuntimeError(f"時系列データが少なすぎます ({len(X)} 行 ≤ ウィンドウ {window} + 5)")
            # X_seq[i] = X[i:i+window], y_seq[i] = y[i+window]
            X_seq, y_seq = [], []
            for i in range(len(X) - window):
                X_seq.append(X[i:i+window])
                y_seq.append(y[i+window])
            X = np.array(X_seq, dtype='float32')
            y = np.array(y_seq, dtype='float32')
            log(f"  時系列ウィンドウ: {window} 点入力 → 1点予測, サンプル数 {len(X)}")

        # train/test 分割
        test_ratio = float(cfg.get('testRatio', 0.2))
        # 時系列は shuffle しない (時系列の順序を保つ)
        if cfg['task'] == 'timeseries':
            split_idx = int(len(X) * (1 - test_ratio))
            X_train, X_test = X[:split_idx], X[split_idx:]
            y_train, y_test = y[:split_idx], y[split_idx:]
        else:
            X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=test_ratio, random_state=42)
        log(f"  学習: {len(X_train)} / テスト: {len(X_test)}")

        # 4. モデル定義
        log("\n[4/6] モデル構築...")
        input_dim = X.shape[-1]  # 特徴量数
        hidden_size = int(cfg.get('hiddenSize', 64))
        num_layers = int(cfg.get('numLayers', 2))

        if cfg['task'] == 'timeseries':
            class LSTMModel(nn.Module):
                def __init__(self):
                    super().__init__()
                    self.lstm = nn.LSTM(input_dim, hidden_size, num_layers=num_layers, batch_first=True)
                    self.fc = nn.Linear(hidden_size, 1)
                def forward(self, x):
                    out, _ = self.lstm(x)
                    return self.fc(out[:, -1, :]).squeeze(-1)
            model = LSTMModel()
            criterion = nn.MSELoss()
        elif cfg['task'] == 'regression':
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
            criterion = nn.MSELoss()
        elif cfg['task'] == 'classification':
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
            criterion = nn.CrossEntropyLoss()
        else:
            raise RuntimeError(f"不明なタスク: {cfg['task']}")

        model = model.to(device)
        total_params = sum(p.numel() for p in model.parameters())
        log(f"  パラメータ数: {total_params:,}")

        # 5. DataLoader 作成 + 学習
        log("\n[5/6] 学習...")
        if cfg['task'] == 'classification':
            X_train_t = torch.tensor(X_train, dtype=torch.float32)
            y_train_t = torch.tensor(y_train, dtype=torch.long)
            X_test_t = torch.tensor(X_test, dtype=torch.float32)
            y_test_t = torch.tensor(y_test, dtype=torch.long)
        else:
            X_train_t = torch.tensor(X_train, dtype=torch.float32)
            y_train_t = torch.tensor(y_train, dtype=torch.float32)
            X_test_t = torch.tensor(X_test, dtype=torch.float32)
            y_test_t = torch.tensor(y_test, dtype=torch.float32)

        train_ds = TensorDataset(X_train_t, y_train_t)
        batch_size = int(cfg.get('batchSize', 32))
        train_loader = DataLoader(train_ds, batch_size=batch_size, shuffle=(cfg['task'] != 'timeseries'))

        optimizer = torch.optim.Adam(model.parameters(), lr=float(cfg.get('learningRate', 0.001)))
        epochs = int(cfg.get('epochs', 100))

        history = []
        best_test_loss = float('inf')
        start = time.time()
        for epoch in range(epochs):
            model.train()
            total_loss = 0.0
            for xb, yb in train_loader:
                xb, yb = xb.to(device), yb.to(device)
                optimizer.zero_grad()
                out = model(xb)
                loss = criterion(out, yb)
                loss.backward()
                optimizer.step()
                total_loss += loss.item() * xb.size(0)
            train_loss = total_loss / len(train_ds)

            # 評価
            model.eval()
            with torch.no_grad():
                xt = X_test_t.to(device)
                yt = y_test_t.to(device)
                pred = model(xt)
                test_loss = criterion(pred, yt).item()
                metric_extra = {}
                if cfg['task'] == 'classification':
                    acc = (pred.argmax(dim=1) == yt).float().mean().item()
                    metric_extra['accuracy'] = acc
                else:
                    # スケール済みの値を元の単位に戻して MAE/RMSE を計算 (人間が読みやすい)
                    pred_cpu = pred.cpu().numpy().reshape(-1, 1)
                    yt_cpu = yt.cpu().numpy().reshape(-1, 1)
                    if target_scaler is not None:
                        pred_raw = target_scaler.inverse_transform(pred_cpu).flatten()
                        yt_raw = target_scaler.inverse_transform(yt_cpu).flatten()
                    else:
                        pred_raw = pred_cpu.flatten()
                        yt_raw = yt_cpu.flatten()
                    mae = float(np.abs(pred_raw - yt_raw).mean())
                    rmse = float(np.sqrt(((pred_raw - yt_raw) ** 2).mean()))
                    metric_extra['mae'] = mae
                    metric_extra['rmse'] = rmse

            history.append({
                'epoch': epoch + 1,
                'train_loss': train_loss,
                'test_loss': test_loss,
                **metric_extra,
            })
            best_test_loss = min(best_test_loss, test_loss)

            # 進捗ログ (5エポック毎 + 最終)
            if (epoch + 1) % max(1, epochs // 20) == 0 or epoch == 0 or epoch == epochs - 1:
                extra_str = ', '.join(f'{k}={v:.4f}' for k, v in metric_extra.items())
                log(f"  Epoch {epoch+1:4d}/{epochs}: train_loss={train_loss:.4f}, test_loss={test_loss:.4f}{', ' + extra_str if extra_str else ''}")

        elapsed = time.time() - start
        log(f"  完了 ({elapsed:.1f} 秒)")

        # 6. 保存
        log("\n[6/6] 保存...")
        torch.save(model.state_dict(), output_dir / 'model.pt')
        with open(output_dir / 'scaler.pkl', 'wb') as f:
            pickle.dump({
                'mean': scaler.mean_.tolist(),
                'scale': scaler.scale_.tolist(),
                # 回帰/時系列: 推論結果を元のスケールに戻すための情報
                'target_mean': float(target_scaler.mean_[0]) if target_scaler is not None else None,
                'target_scale': float(target_scaler.scale_[0]) if target_scaler is not None else None,
            }, f)
        with open(output_dir / 'label_encoders.pkl', 'wb') as f:
            pickle.dump({
                'features': label_encoders,
                'target': target_encoder,
            }, f)

        # 推論用に必要な情報を全て config.json に統合
        final_config = {
            **cfg,
            'inputDim': input_dim,
            'numClasses': num_classes if cfg['task'] == 'classification' else None,
            'featureDtypes': feature_dtypes,
            'hasTargetEncoder': target_encoder is not None,
            'hasTargetScaler': target_scaler is not None,
            # 日時派生情報 (推論時に同じ展開を行うため)
            'originalFeatures': original_features,            # ユーザーが指定した元の特徴量
            'expandedFeatures': cfg_features_for_train,        # 展開後の最終特徴量 (StandardScaler順)
            'datetimeSourceCols': list(datetime_source_cols.keys()),  # 日時として分解した元列名
            'datetimeFeatures': DATETIME_FEATURES,             # 各日時列の派生サフィックス
            'savedAt': time.time(),
        }
        with open(output_dir / 'config.json', 'w', encoding='utf-8') as f:
            json.dump(final_config, f, indent=2, ensure_ascii=False)

        metrics = {
            'task': cfg['task'],
            'trainSamples': len(X_train),
            'testSamples': len(X_test),
            'epochs': epochs,
            'finalTrainLoss': history[-1]['train_loss'],
            'finalTestLoss': history[-1]['test_loss'],
            'bestTestLoss': best_test_loss,
            'elapsedSec': elapsed,
            'history': history,
        }
        if cfg['task'] == 'classification':
            metrics['finalAccuracy'] = history[-1].get('accuracy')
        else:
            metrics['finalMAE'] = history[-1].get('mae')
            metrics['finalRMSE'] = history[-1].get('rmse')
        with open(output_dir / 'metrics.json', 'w', encoding='utf-8') as f:
            json.dump(metrics, f, indent=2, ensure_ascii=False)

        log(f"\n✅ 保存先: {output_dir}")
        log(f"   model.pt, scaler.pkl, label_encoders.pkl, config.json, metrics.json")
        log(f"\n=== 学習完了 ===")
        sys.exit(0)

    except Exception as e:
        log(f"\n❌ エラー: {e}")
        log(traceback.format_exc())
        sys.exit(1)


if __name__ == '__main__':
    main()
