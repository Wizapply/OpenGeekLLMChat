#!/usr/bin/env python3
"""
rl_common.py — OpenGeekLLMChat 強化学習(RL)の共通モジュール

オフライン学習 (rl_runner.py) と 常駐オンライン学習ワーカー (rl_online_server.py) の
両方で使う「モデル構築・状態エンコード・損失計算」をここに集約する。
両者で前処理・損失の挙動が分岐しないようにするのが目的 (挙動の乖離防止)。

torch / numpy は各関数内で遅延 import する (呼び出し側のスタイルに合わせる)。
"""
import os
import sys

# 前処理の dtype 判定を ml_runner と共有
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ml_common import classify_dtype


def build_qnet(torch, nn, state_dim, n_actions, hidden):
    """Q ネットワーク (3層 MLP)。オフライン/オンラインで同一構造。"""
    class QNet(nn.Module):
        def __init__(self):
            super().__init__()
            self.net = nn.Sequential(
                nn.Linear(state_dim, hidden), nn.ReLU(),
                nn.Linear(hidden, hidden), nn.ReLU(),
                nn.Linear(hidden, n_actions),
            )

        def forward(self, x):
            return self.net(x)
    return QNet()


def classify_state_kind(dtype):
    """状態カラムの種別を numeric / category に単純化する。"""
    k = classify_dtype(dtype)
    # 日時はカテゴリ扱い (文字列として index 化) にして単純化
    return 'category' if k in ('category', 'datetime') else 'numeric'


def _mean_scale_from_meta(meta, np):
    """meta から正規化の (mean, scale) ベクトルを得る。

    - オンライン (Welford 実行統計): meta['runningCount']/['runningMean']/['runningM2']
      がある場合は、その実行統計から mean と 標準偏差(scale) を算出する。
    - オフライン (StandardScaler): meta['scalerMean']/['scalerScale'] を使う。
    どちらも scale==0 は 1.0 にガードする。
    """
    count = meta.get('runningCount')
    if count is not None and meta.get('runningMean') is not None:
        mean = np.array(meta['runningMean'], dtype='float32')
        m2 = np.array(meta.get('runningM2', [0.0] * len(mean)), dtype='float32')
        c = max(int(count) - 1, 1)
        var = m2 / c
        scale = np.sqrt(np.maximum(var, 0.0)).astype('float32')
    else:
        mean = np.array(meta['scalerMean'], dtype='float32')
        scale = np.array(meta['scalerScale'], dtype='float32')
    scale = np.where(scale == 0, 1.0, scale).astype('float32')
    return mean.astype('float32'), scale


def encode_state_dict(state, meta, np):
    """1件の状態辞書を学習時と同じ前処理で数値ベクトルに変換する。

    カテゴリ列は encoders の index 化 (未知値→0)、数値列は float 化 (失敗→0.0)、
    最後に (vec - mean) / scale で正規化する。mean/scale は _mean_scale_from_meta が
    オフライン scaler / オンライン実行統計のどちらからでも求める。
    """
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
    mean, scale = _mean_scale_from_meta(meta, np)
    return ((vec - mean) / scale).astype('float32')


def compute_loss(algo, mode, qnet, target, torch, nn, S, A, R, S2, D, gamma, cql_alpha):
    """1ミニバッチ分の損失を返す (zero_grad/backward/step は呼び出し側)。

    algo: dqn | ddqn | cql | bc
    mode: 'transition' (γで先読み) | 'bandit' (1ステップ報酬)
    S,S2: 状態テンソル (batch, dim)、A: (batch,1) long、R/D: (batch,1) float
    """
    if algo == 'bc':
        # Behavior Cloning: ログ行動を教師ラベルにした分類 (報酬・次状態は不使用)
        logits = qnet(S)
        return nn.functional.cross_entropy(logits, A.squeeze(1))

    q_all = qnet(S)
    q = q_all.gather(1, A)
    with torch.no_grad():
        if mode == 'transition':
            if algo == 'ddqn':
                # Double DQN: 行動選択はオンライン網、評価はターゲット網
                next_act = qnet(S2).argmax(1, keepdim=True)
                next_q = target(S2).gather(1, next_act)
            else:  # dqn, cql
                next_q = target(S2).max(1, keepdim=True)[0]
            tgt = R + gamma * next_q * (1.0 - D)
        else:
            tgt = R
    bellman = nn.functional.smooth_l1_loss(q, tgt)
    if algo == 'cql':
        # Conservative Q-Learning: ログ外行動のQを抑え、ログ行動のQを相対的に上げる
        cons = (torch.logsumexp(q_all, dim=1, keepdim=True) - q).mean()
        return bellman + cql_alpha * cons
    return bellman
