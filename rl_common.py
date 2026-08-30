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


def build_qnet(torch, nn, state_dim, n_actions, hidden, emb_dim=0):
    """Q ネットワーク (3層 MLP)。オフライン/オンラインで同一構造。

    emb_dim > 0 のとき、状態ベクトルの末尾 emb_dim 次元を V-JEPA 2 等の視覚埋め込みと
    みなし、そこだけ LayerNorm を通してから MLP に入れる。

    埋め込みに StandardScaler / Welford 実行統計を掛けてはいけない理由:
      1024次元の高次元ベクトルに少数サンプルの分散推定を当てると、初期に scale≈0 の
      次元が出て (値 - mean)/scale が発散する。LayerNorm ならサンプル数に依存せず、
      表側の列 (既に scaler 済み) とスケールを揃えられる。

    emb_dim == 0 のときは emb_norm を作らないので、state_dict のキーは従来と完全に
    同一 (net.0.weight ...)。既存の学習済みモデルはそのまま読める。
    """
    tab_dim = state_dim - emb_dim

    class QNet(nn.Module):
        def __init__(self):
            super().__init__()
            self.emb_dim = emb_dim
            self.tab_dim = tab_dim
            if emb_dim > 0:
                self.emb_norm = nn.LayerNorm(emb_dim)
            self.net = nn.Sequential(
                nn.Linear(state_dim, hidden), nn.ReLU(),
                nn.Linear(hidden, hidden), nn.ReLU(),
                nn.Linear(hidden, n_actions),
            )

        def forward(self, x):
            if self.emb_dim > 0:
                tab = x[:, :self.tab_dim]
                emb = self.emb_norm(x[:, self.tab_dim:])
                x = torch.cat([tab, emb], dim=1)
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

    meta['embDim'] > 0 (V-JEPA 2 等の視覚埋め込みを使うエージェント) の場合は、
    正規化済みの表ベクトルの後ろに state['_embedding'] を **素のまま** 連結する。
    埋め込み側の正規化は方策ヘッドの LayerNorm が担当する (build_qnet 参照)。
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
    out = ((vec - mean) / scale).astype('float32')

    emb_dim = int(meta.get('embDim') or 0)
    if emb_dim > 0:
        raw = state.get('_embedding')
        emb = np.zeros(emb_dim, dtype='float32')
        if raw is not None:
            arr = np.asarray(raw, dtype='float32').ravel()
            if arr.shape[0] != emb_dim:
                raise ValueError(
                    f"_embedding の次元が違います (期待 {emb_dim}, 実際 {arr.shape[0]})")
            emb = arr
        out = np.concatenate([out, emb]).astype('float32')
    return out


def default_action_spec(n_actions):
    """従来どおりの「1ステップ・離散」行動仕様。"""
    return {'type': 'discrete', 'chunk': 1, 'dim': 1, 'nActions': int(n_actions)}


def bc_loss(qnet, nn, S, A, action_spec=None, mask=None, reduction='mean'):
    """Behavior Cloning の損失 (報酬・次状態は不使用)。

    action_spec:
        {'type': 'discrete'|'continuous', 'chunk': K, 'dim': Da, 'nActions': N}
        None なら「1ステップ・離散」(従来動作) とみなす。
    A:
        discrete   → (batch, K) long   (K=1 なら従来の (batch,1) がそのまま通る)
        continuous → (batch, K, Da) float (正規化済みの行動ベクトル)
    mask:
        (batch, K) float。エピソード終端でチャンクがはみ出した位置を 0 にする。
        None なら全位置を使う。
    reduction:
        'mean' → スカラー、'none' → (batch, K) の位置ごとの損失

    行動チャンキング: 1つの状態から K ステップ先までの行動をまとめて予測する。
    ACT / π0 系で定番の手法で、BC の「1ステップずつ予測して誤差が積み上がる」
    弱点を緩和し、動きが滑らかになる。
    """
    spec = action_spec or {}
    atype = spec.get('type', 'discrete')
    chunk = max(1, int(spec.get('chunk') or 1))
    out = qnet(S)
    b = out.shape[0]

    if atype == 'continuous':
        dim = int(spec['dim'])
        pred = out.view(b, chunk, dim)
        tgt = A.view(b, chunk, dim).to(pred.dtype)
        # Huber (smooth L1): 外れ値のあるデモに対して L2 より安定する
        per = nn.functional.smooth_l1_loss(pred, tgt, reduction='none').mean(-1)
    else:
        n_act = int(spec.get('nActions') or (out.shape[1] // chunk))
        logits = out.view(b, chunk, n_act)
        tgt = A.view(b, chunk).long()
        per = nn.functional.cross_entropy(
            logits.reshape(-1, n_act), tgt.reshape(-1), reduction='none'
        ).view(b, chunk)

    if reduction == 'none':
        return per if mask is None else per * mask.view(b, chunk)
    if mask is None:
        return per.mean()
    m = mask.view(b, chunk)
    return (per * m).sum() / m.sum().clamp(min=1.0)


def compute_loss(algo, mode, qnet, target, torch, nn, S, A, R, S2, D, gamma, cql_alpha,
                 action_spec=None, mask=None):
    """1ミニバッチ分の損失を返す (zero_grad/backward/step は呼び出し側)。

    algo: dqn | ddqn | cql | bc
    mode: 'transition' (γで先読み) | 'bandit' (1ステップ報酬)
    S,S2: 状態テンソル (batch, dim)、R/D: (batch,1) float
    A: 価値ベース (dqn/ddqn/cql) は (batch,1) long。BC は bc_loss の説明を参照。
    action_spec / mask: BC の連続行動・チャンキング用 (価値ベースでは未使用)
    """
    if algo == 'bc':
        return bc_loss(qnet, nn, S, A, action_spec=action_spec, mask=mask)

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
