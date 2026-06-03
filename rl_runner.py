#!/usr/bin/env python3
"""
rl_runner.py — OpenGeekLLMChat 強化学習 (Reinforcement Learning / RL) ジョブ実行スクリプト

データテーブル (DuckDB) のログ済み経験データから、PyTorch で DQN エージェントを
オフライン学習する (Offline RL)。外部依存 (gym 等) はなし。

列マッピング:
  stateColumns      : 状態(文脈)の特徴量カラム (数値/カテゴリ)
  actionColumn      : 実際に取られた離散行動のカラム
  rewardColumn      : その行動で得られた報酬 (数値) のカラム
  nextStateColumns  : (任意) 遷移先の状態カラム。stateColumns と1対1で対応。
                      指定あり → 遷移ベースのオフラインDQN (γで先読み)
                      指定なし → 文脈付きバンディット (1ステップ報酬最大化)
  doneColumn        : (任意) エピソード終了フラグ (0/1, true/false)

前処理は ml_runner と整合: カテゴリ列は index 化、全特徴量を StandardScaler で正規化。
next_state も同じ変換を適用する。

使い方:
  python rl_runner.py <config.json>

config.json (mode 別):
  train  : 学習。{ "mode":"train", "name", "tableName", "stateColumns", "actionColumn",
                   "rewardColumn", "nextStateColumns"?, "doneColumn"?, "episodes",
                   "gamma", "learningRate", "hiddenSize", "batchSize",
                   "dbPath", "outputDir" }
  eval   : オフライン方策評価。{ "mode":"eval", "modelDir", "dbPath" }
  policy : 推論 (状態1件→推奨行動)。{ "mode":"policy", "modelDir", "state": {列名:値} }

学習出力 (outputDir):
  - model.pt       # Q ネットワークの state_dict
  - config.json    # 学習設定 + 前処理メタ (列・エンコーダ・scaler 等)
  - metrics.json   # TD損失履歴・方策一致率・推定価値 等
  - train.log      # 学習ログ

標準出力の最後に RESULT_JSON:<json> 行を出力する (Node.js が結果を拾う)。
"""
import argparse
import json
import os
import random
import sys
import time
import traceback
from pathlib import Path

# 共通モジュール (モデル構築・状態エンコード・損失計算を online ワーカーと共有)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rl_common import (
    build_qnet,
    classify_state_kind as _classify_state_kind,
    encode_state_dict as _encode_state_dict,
    compute_loss,
)


def log(msg):
    print(msg, flush=True)


def load_dataset_for_train(cfg, np):
    """DuckDB の表からログ済み経験データを読み出し、前処理して遷移配列を作る。"""
    import duckdb
    import pandas as pd
    from sklearn.preprocessing import StandardScaler

    state_cols = list(cfg['stateColumns'])
    action_col = cfg['actionColumn']
    reward_col = cfg['rewardColumn']
    next_cols = list(cfg.get('nextStateColumns') or [])
    done_col = cfg.get('doneColumn') or None
    has_next = len(next_cols) == len(state_cols) and len(next_cols) > 0

    needed = list(dict.fromkeys(
        state_cols + [action_col, reward_col] + (next_cols if has_next else []) + ([done_col] if done_col else [])
    ))
    con = duckdb.connect(cfg['dbPath'], read_only=True)
    cols_sql = ', '.join(f'"{c}"' for c in needed)
    df = con.execute(f'SELECT {cols_sql} FROM "{cfg["tableName"]}"').df()
    con.close()
    log(f"  取得行数: {len(df)}")

    req = state_cols + [action_col, reward_col] + (next_cols if has_next else [])
    before = len(df)
    df = df.dropna(subset=req).reset_index(drop=True)
    if before != len(df):
        log(f"  NULL除外: {before} → {len(df)} 行")
    if len(df) < 10:
        raise RuntimeError(f"学習に使える行が少なすぎます ({len(df)} 行)。最低10行必要です。")

    col_types = {c: _classify_state_kind(df[c].dtype) for c in state_cols}
    encoders = {}
    for i, col in enumerate(state_cols):
        if col_types[col] == 'category':
            vals = set(df[col].astype(str).unique().tolist())
            if has_next:
                vals |= set(df[next_cols[i]].astype(str).unique().tolist())
            encoders[col] = sorted(vals)

    def encode_block(src_cols):
        m = np.zeros((len(df), len(state_cols)), dtype='float32')
        for j, scol in enumerate(state_cols):
            src = src_cols[j]
            if col_types[scol] == 'category':
                idx = {c: k for k, c in enumerate(encoders[scol])}
                m[:, j] = df[src].astype(str).map(lambda v: idx.get(v, 0)).to_numpy(dtype='float32')
            else:
                m[:, j] = pd.to_numeric(df[src], errors='coerce').fillna(0.0).to_numpy(dtype='float32')
        return m

    S = encode_block(state_cols)
    S2 = encode_block(next_cols) if has_next else np.zeros_like(S)
    scaler = StandardScaler().fit(S)
    S = scaler.transform(S).astype('float32')
    if has_next:
        S2 = scaler.transform(S2).astype('float32')

    action_classes = sorted(set(df[action_col].astype(str).unique().tolist()))
    a_idx = {c: k for k, c in enumerate(action_classes)}
    A = df[action_col].astype(str).map(lambda v: a_idx.get(v, 0)).to_numpy(dtype='int64')
    R = pd.to_numeric(df[reward_col], errors='coerce').fillna(0.0).to_numpy(dtype='float32')

    if done_col and done_col in df.columns:
        D = df[done_col].map(
            lambda v: 1.0 if str(v).strip().lower() in ('1', 'true', 'yes', 't', 'done') else 0.0
        ).to_numpy(dtype='float32')
    else:
        # next_state があれば継続(0)、なければバンディット(各行終端=1)
        D = (np.zeros(len(df)) if has_next else np.ones(len(df))).astype('float32')

    meta = {
        'stateColumns': state_cols,
        'colTypes': col_types,
        'encoders': encoders,
        'actionColumn': action_col,
        'rewardColumn': reward_col,
        'actionClasses': action_classes,
        'hasNext': has_next,
        'doneColumn': done_col,
        'scalerMean': scaler.mean_.tolist(),
        'scalerScale': scaler.scale_.tolist(),
    }
    return S, A, R, S2, D, meta


def train(cfg):
    import numpy as np
    import torch
    import torch.nn as nn

    seed = int(cfg.get('seed', 42))
    random.seed(seed); np.random.seed(seed); torch.manual_seed(seed)
    device = 'cuda' if torch.cuda.is_available() else 'cpu'

    log(f"=== オフラインRL 学習開始 ===")
    log(f"エージェント名: {cfg['name']}")
    log(f"テーブル: {cfg['tableName']}")
    log(f"device:   {device}")
    log("\n[データ読み込み・前処理]")
    S, A, R, S2, D, meta = load_dataset_for_train(cfg, np)

    n = len(S)
    state_dim = S.shape[1]
    n_actions = len(meta['actionClasses'])
    mode = 'transition' if meta['hasNext'] else 'bandit'
    log(f"  方式: {'遷移ベース オフラインDQN' if mode=='transition' else '文脈付きバンディット'}")
    log(f"  状態次元: {state_dim} ({', '.join(meta['stateColumns'])})")
    log(f"  行動: {n_actions} クラス {meta['actionClasses'][:8]}{'...' if n_actions>8 else ''}")
    log(f"  報酬範囲: [{float(R.min()):.3f}, {float(R.max()):.3f}], 平均 {float(R.mean()):.3f}")
    log(f"  遷移数: {n}")
    if n_actions < 2:
        raise RuntimeError("行動が1種類しかありません。行動カラムに2種類以上必要です。")

    gamma = float(cfg.get('gamma', 0.99)) if mode == 'transition' else 0.0
    lr = float(cfg.get('learningRate', 0.001))
    hidden = int(cfg.get('hiddenSize', 128))
    batch_size = min(int(cfg.get('batchSize', 64)), n)
    epochs = int(cfg.get('episodes', 300))  # データセットでは「エポック数」として解釈
    target_update = max(1, int(cfg.get('targetUpdate', 200)))
    algo = cfg.get('algo', 'dqn')
    if algo not in ('dqn', 'ddqn', 'cql', 'bc'):
        algo = 'dqn'
    cql_alpha = float(cfg.get('cqlAlpha', 0.5))
    algo_label = {
        'dqn': 'DQN', 'ddqn': 'Double DQN',
        'cql': f'CQL (保守的・α={cql_alpha})', 'bc': 'Behavior Cloning (模倣)',
    }[algo]
    log(f"  アルゴリズム: {algo_label}")
    is_value = algo in ('dqn', 'ddqn', 'cql')  # 価値ベース (BC以外)

    qnet = build_qnet(torch, nn, state_dim, n_actions, hidden).to(device)
    target = build_qnet(torch, nn, state_dim, n_actions, hidden).to(device)
    target.load_state_dict(qnet.state_dict()); target.eval()
    optimizer = torch.optim.Adam(qnet.parameters(), lr=lr)
    log(f"  Q ネットワーク パラメータ数: {sum(p.numel() for p in qnet.parameters()):,}")

    St = torch.tensor(S, device=device)
    At = torch.tensor(A, dtype=torch.long, device=device).unsqueeze(1)
    Rt = torch.tensor(R, device=device).unsqueeze(1)
    S2t = torch.tensor(S2, device=device)
    Dt = torch.tensor(D, device=device).unsqueeze(1)

    loss_name = '損失(CE)' if algo == 'bc' else 'TD損失'
    loss_history = []
    best_loss = float('inf')
    step = 0
    start = time.time()
    log("\n[学習ループ]")
    for ep in range(epochs):
        perm = torch.randperm(n, device=device)
        total = 0.0
        for b in range(0, n, batch_size):
            idx = perm[b:b + batch_size]
            loss = compute_loss(
                algo, mode, qnet, target, torch, nn,
                St[idx], At[idx], Rt[idx], S2t[idx], Dt[idx], gamma, cql_alpha,
            )
            optimizer.zero_grad(); loss.backward()
            torch.nn.utils.clip_grad_norm_(qnet.parameters(), 10.0); optimizer.step()
            total += float(loss.item()) * len(idx)
            step += 1
            if is_value and step % target_update == 0:
                target.load_state_dict(qnet.state_dict())
        ep_loss = total / n
        loss_history.append(round(ep_loss, 6))
        best_loss = min(best_loss, ep_loss)
        if (ep + 1) % max(1, epochs // 20) == 0 or ep == 0 or ep == epochs - 1:
            log(f"  Epoch {ep+1:4d}/{epochs}: {loss_name}={ep_loss:.5f}")

    elapsed = time.time() - start

    # 学習後の方策評価 (ログ済み行動との一致率・推定価値)
    qnet.eval()
    with torch.no_grad():
        qvals = qnet(St)
        greedy = qvals.argmax(1)
        agreement = float((greedy == torch.tensor(A, device=device)).float().mean().item())
        mean_q = float(qvals.max(1)[0].mean().item())
    logged_mean_reward = float(R.mean())
    value_label = '推定価値(平均maxQ)' if is_value else '平均スコア(max)'
    log(f"\n完了 ({elapsed:.1f}秒)  {loss_name}={loss_history[-1]:.5f}  "
        f"方策一致率={agreement*100:.1f}%  {value_label}={mean_q:.3f}")

    # 保存 (前処理情報は全て config.json に同梱)
    output_dir = Path(cfg['outputDir'])
    output_dir.mkdir(parents=True, exist_ok=True)
    torch.save(qnet.state_dict(), output_dir / 'model.pt')
    final_config = {
        'name': cfg['name'],
        'env': 'dataset',
        'algo': algo,
        'cqlAlpha': cql_alpha if algo == 'cql' else None,
        'datasetMode': mode,
        'tableName': cfg['tableName'],
        'stateDim': state_dim,
        'nActions': n_actions,
        'actionLabels': meta['actionClasses'],
        'hiddenSize': hidden,
        'gamma': gamma,
        'learningRate': lr,
        'episodes': epochs,
        'seed': seed,
        'meta': meta,
        'trainedAt': time.time(),
    }
    with open(output_dir / 'config.json', 'w', encoding='utf-8') as f:
        json.dump(final_config, f, indent=2, ensure_ascii=False)
    metrics = {
        'env': 'dataset',
        'algo': algo,
        'datasetMode': mode,
        'epochs': epochs,
        'lossHistory': loss_history,
        'lossName': loss_name,
        'finalLoss': loss_history[-1],
        'bestLoss': round(best_loss, 6),
        'policyAgreement': round(agreement, 4),
        'meanQ': round(mean_q, 4),
        'loggedMeanReward': round(logged_mean_reward, 4),
        'nTransitions': n,
        'nActions': n_actions,
        'elapsedSec': round(elapsed, 1),
    }
    with open(output_dir / 'metrics.json', 'w', encoding='utf-8') as f:
        json.dump(metrics, f, indent=2, ensure_ascii=False)

    log(f"\n✅ 保存先: {output_dir}")
    log(f"\n=== 学習完了 ===")
    log("RESULT_JSON:" + json.dumps({
        'status': 'completed', 'env': 'dataset', 'algo': algo, 'datasetMode': mode,
        'finalLoss': loss_history[-1], 'policyAgreement': round(agreement, 4),
        'meanQ': round(mean_q, 4), 'loggedMeanReward': round(logged_mean_reward, 4),
        'nActions': n_actions, 'device': device, 'elapsedSec': round(elapsed, 1),
    }, ensure_ascii=False))


def _encode_state_dict(state, meta, np):
    """1件の状態辞書を学習時と同じ前処理で数値ベクトルに変換する。"""
    cols = meta['stateColumns']
    vec = np.zeros(len(cols), dtype='float32')
    for j, col in enumerate(cols):
        v = state.get(col)
        if meta['colTypes'].get(col) == 'category':
            classes = meta['encoders'].get(col, [])
            vec[j] = float(classes.index(str(v))) if str(v) in classes else 0.0
        else:
            try:
                vec[j] = float(v)
            except (TypeError, ValueError):
                vec[j] = 0.0
    mean = np.array(meta['scalerMean'], dtype='float32')
    scale = np.array(meta['scalerScale'], dtype='float32')
    scale = np.where(scale == 0, 1.0, scale)
    return ((vec - mean) / scale).astype('float32')


def _json_safe(v):
    try:
        import numpy as _np
        if isinstance(v, (_np.integer,)):
            return int(v)
        if isinstance(v, (_np.floating,)):
            return float(v)
    except Exception:
        pass
    if isinstance(v, (int, float, str, bool)):
        return v
    return str(v)


def evaluate(cfg):
    """シミュレータの無いオフライン評価: ログ行動との一致率・行動分布・推定価値・推薦サンプル。"""
    import numpy as np
    import torch
    import torch.nn as nn
    import duckdb
    import pandas as pd

    model_dir = Path(cfg['modelDir'])
    with open(model_dir / 'config.json', 'r', encoding='utf-8') as f:
        mcfg = json.load(f)

    meta = mcfg['meta']
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    log(f"=== オフラインRL 評価 ===  table={mcfg['tableName']}, device={device}")
    qnet = build_qnet(torch, nn, mcfg['stateDim'], mcfg['nActions'], int(mcfg.get('hiddenSize', 128)))
    qnet.load_state_dict(torch.load(model_dir / 'model.pt', map_location='cpu'))
    qnet.to(device).eval()

    state_cols = meta['stateColumns']
    action_col = meta['actionColumn']
    reward_col = meta['rewardColumn']
    action_classes = mcfg['actionLabels']
    needed = list(dict.fromkeys(state_cols + [action_col, reward_col]))
    con = duckdb.connect(cfg['dbPath'], read_only=True)
    df = con.execute(f'SELECT {", ".join(chr(34)+c+chr(34) for c in needed)} FROM "{mcfg["tableName"]}"').df()
    con.close()
    df = df.dropna(subset=needed).reset_index(drop=True)
    if len(df) == 0:
        raise RuntimeError("評価できる行がありません")

    # 状態行列を構築 (学習時と同じ index 化 + scaler)
    X = np.zeros((len(df), len(state_cols)), dtype='float32')
    for j, col in enumerate(state_cols):
        if meta['colTypes'].get(col) == 'category':
            idx = {c: k for k, c in enumerate(meta['encoders'].get(col, []))}
            X[:, j] = df[col].astype(str).map(lambda v: idx.get(v, 0)).to_numpy(dtype='float32')
        else:
            X[:, j] = pd.to_numeric(df[col], errors='coerce').fillna(0.0).to_numpy(dtype='float32')
    mean = np.array(meta['scalerMean'], dtype='float32')
    scale = np.where(np.array(meta['scalerScale'], dtype='float32') == 0, 1.0, np.array(meta['scalerScale'], dtype='float32'))
    X = (X - mean) / scale

    with torch.no_grad():
        qv = qnet(torch.tensor(X, device=device))
        greedy = qv.argmax(1).cpu().numpy()
        max_q = qv.max(1)[0].cpu().numpy()

    a_idx = {c: k for k, c in enumerate(action_classes)}
    logged = df[action_col].astype(str).map(lambda v: a_idx.get(v, 0)).to_numpy()
    rewards = pd.to_numeric(df[reward_col], errors='coerce').fillna(0.0).to_numpy()
    agree = (greedy == logged)
    agreement = float(agree.mean())

    logged_dist = {c: 0 for c in action_classes}
    policy_dist = {c: 0 for c in action_classes}
    for a in logged:
        logged_dist[action_classes[a]] += 1
    for a in greedy:
        policy_dist[action_classes[a]] += 1

    # 推薦サンプル (元の状態値で表示)
    sample = []
    for i in range(min(20, len(df))):
        sample.append({
            'state': {c: (None if pd.isna(df[c].iloc[i]) else _json_safe(df[c].iloc[i])) for c in state_cols},
            'loggedAction': action_classes[int(logged[i])],
            'recommendedAction': action_classes[int(greedy[i])],
            'reward': round(float(rewards[i]), 4),
            'qValues': {action_classes[k]: round(float(qv[i, k].item()), 4) for k in range(len(action_classes))},
        })

    result = {
        'status': 'completed',
        'env': 'dataset',
        'kind': 'dataset',
        'datasetMode': mcfg.get('datasetMode'),
        'nRows': len(df),
        'actionLabels': action_classes,
        'policyAgreement': round(agreement, 4),
        'meanQ': round(float(max_q.mean()), 4),
        'loggedMeanReward': round(float(rewards.mean()), 4),
        'rewardWhenFollowed': round(float(rewards[agree].mean()), 4) if agree.any() else None,
        'loggedActionDist': logged_dist,
        'policyActionDist': policy_dist,
        'samples': sample,
    }
    log(f"  方策一致率={agreement*100:.1f}%  推定価値(平均maxQ)={float(max_q.mean()):.3f}  行数={len(df)}")
    log("RESULT_JSON:" + json.dumps(result, ensure_ascii=False))


def policy(cfg):
    """学習済みエージェントに状態を1件与えて推奨行動とQ値を返す (推論)。DuckDB は使わない。"""
    import numpy as np
    import torch
    import torch.nn as nn

    model_dir = Path(cfg['modelDir'])
    with open(model_dir / 'config.json', 'r', encoding='utf-8') as f:
        mcfg = json.load(f)
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    qnet = build_qnet(torch, nn, mcfg['stateDim'], mcfg['nActions'], int(mcfg.get('hiddenSize', 128)))
    qnet.load_state_dict(torch.load(model_dir / 'model.pt', map_location='cpu'))
    qnet.to(device).eval()
    labels = mcfg.get('actionLabels') or [str(i) for i in range(mcfg['nActions'])]

    state = cfg.get('state', {})
    if not isinstance(state, dict):
        raise RuntimeError("state は {列名: 値} の辞書で指定してください")
    vec = _encode_state_dict(state, mcfg['meta'], np)

    with torch.no_grad():
        q = qnet(torch.tensor(vec, device=device).unsqueeze(0))[0]
        best = int(q.argmax().item())
    result = {
        'status': 'completed',
        'env': 'dataset',
        'recommendedAction': labels[best],
        'actionIndex': best,
        'qValues': {labels[k]: round(float(q[k].item()), 4) for k in range(len(labels))},
    }
    log("RESULT_JSON:" + json.dumps(result, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('config_path', help='設定JSONのパス')
    args = parser.parse_args()

    with open(args.config_path, 'r', encoding='utf-8') as f:
        cfg = json.load(f)

    try:
        try:
            import numpy  # noqa
            import torch  # noqa
        except ImportError as e:
            log(f"❌ ライブラリ不足: {e}")
            log("  pip install numpy torch duckdb pandas scikit-learn --break-system-packages")
            log("RESULT_JSON:" + json.dumps({'status': 'failed', 'error': f'missing library: {e}'}))
            sys.exit(2)

        mode = cfg.get('mode', 'train')
        if mode == 'eval':
            evaluate(cfg)
        elif mode == 'policy':
            policy(cfg)
        else:
            train(cfg)
        sys.exit(0)
    except Exception as e:
        log(f"\n❌ エラー: {e}")
        log(traceback.format_exc())
        log("RESULT_JSON:" + json.dumps({'status': 'failed', 'error': str(e)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == '__main__':
    main()
