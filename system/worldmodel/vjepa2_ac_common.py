#!/usr/bin/env python3
"""
vjepa2_ac_common.py — V-JEPA 2-AC (行動条件付き世界モデル) の共通モジュール

「今の潜在 z_t と行動 a_t から、次の潜在 z_{t+1} を予測する」predictor と、
その上で行動系列を探索する CEM (交差エントロピー法) プランナーの部品を集約する。
学習 (vjepa2_ac_runner.py) と 計画 (vjepa2_server.py の /plan) で共有し、
挙動の乖離を防ぐ (rl_common.py / vjepa2_common.py と同じ狙い)。

設計方針:
  - エンコーダ (V-JEPA 2) は常に凍結。predictor は潜在空間の中だけで学習する。
    論文の V-JEPA 2-AC はトークン列に対する 300M の Transformer だが、ここでは
    プーリング済み潜在 (1024次元級) に対する **残差MLP** にする。データ量が
    数百〜数万遷移の規模で 300M を回しても過学習するだけで、この規模なら
    残差MLP が正しいサイズ。
  - predictor は Δz (変化量) を学ぶ。出力層をゼロ初期化するので、学習0ステップの
    時点で恒等写像 (z_{t+1}=z_t) に一致する。「恒等ベースラインより良いか」が
    そのまま学習の進みになる。
  - 潜在も行動も学習側統計で正規化してから扱う。CEM の距離計算も同じ正規化空間。
  - CEM の分布更新は numpy の純関数にする (torch 無しでテストできる)。
    ロールアウトは rollout_score_fn として外から注入する。

torch は関数内で遅延 import する (呼び出し側のスタイルに合わせる)。
"""
import json
import os

# 学習の既定値。UI/API から上書きできるが、この規模なら大きく外れない
DEFAULTS = {
    'hiddenSize': 1024,   # 残差ブロックの幅
    'numBlocks': 2,       # 残差ブロック数
    'rolloutK': 3,        # 学習時に自分の予測で先まで転がすステップ数
    'epochs': 200,
    'batchSize': 256,
    'learningRate': 0.001,
    'valSplit': 0.2,
}

# CEM の既定値。horizon×samples×iterations がそのまま計画1回の forward 回数になる
PLAN_DEFAULTS = {
    'horizon': 8,         # 何手先まで計画するか
    'samples': 256,       # 1イテレーションの候補数
    'iterations': 4,      # 分布更新の回数
    'eliteFrac': 0.1,     # 上位何割で分布を更新するか
    'minStd': 0.05,       # 連続行動の標準偏差の下限 (早すぎる収束を防ぐ)
    'clip': 3.0,          # 正規化空間での行動のクリップ (±3σ)
    'smooth': 0.5,        # 離散行動の確率スムージング (ラプラス平滑化)
}


# ════════════════════════════════════════════════════════════════════
# 行動の符号化 (離散 → one-hot / 連続 → 正規化)
# ════════════════════════════════════════════════════════════════════

def action_dim(spec):
    """predictor に入る行動ベクトルの次元。"""
    if spec['type'] == 'discrete':
        return len(spec['classes'])
    return len(spec['columns'])


def encode_actions(np, spec, raw):
    """行動を predictor 入力に変換する。

    discrete   : raw = (n,) の行動 index → one-hot (n, nA)
    continuous : raw = (n, Da) の生値   → 学習側統計で正規化 (n, Da)
    """
    if spec['type'] == 'discrete':
        n_a = len(spec['classes'])
        idx = np.asarray(raw, dtype='int64')
        out = np.zeros((len(idx), n_a), dtype='float32')
        out[np.arange(len(idx)), np.clip(idx, 0, n_a - 1)] = 1.0
        return out
    mean = np.asarray(spec['mean'], dtype='float32')
    scale = np.asarray(spec['scale'], dtype='float32')
    return ((np.asarray(raw, dtype='float32') - mean) / scale).astype('float32')


def decode_actions(np, spec, encoded):
    """CEM が出した行動を人間/ロボットが使う形に戻す。

    discrete   : (H,) index → ラベルのリスト
    continuous : (H, Da) 正規化値 → [{列名: 生値}] のリスト
    """
    if spec['type'] == 'discrete':
        return [spec['classes'][int(i)] for i in np.asarray(encoded).ravel()]
    mean = np.asarray(spec['mean'], dtype='float32')
    scale = np.asarray(spec['scale'], dtype='float32')
    raw = np.asarray(encoded, dtype='float32') * scale + mean
    return [{c: round(float(raw[h, j]), 5) for j, c in enumerate(spec['columns'])}
            for h in range(raw.shape[0])]


# ════════════════════════════════════════════════════════════════════
# 潜在の正規化
# ════════════════════════════════════════════════════════════════════

def fit_latent_norm(np, Z, idx=None):
    """潜在の正規化統計 (mean, std)。std には床を敷いてゼロ割りを防ぐ。"""
    sub = Z if idx is None else Z[idx]
    mean = sub.mean(axis=0).astype('float32')
    std = np.maximum(sub.std(axis=0), 1e-4).astype('float32')
    return mean, std


def normalize_latent(np, Z, mean, std):
    return ((Z - np.asarray(mean, dtype='float32')) / np.asarray(std, dtype='float32')).astype('float32')


# ════════════════════════════════════════════════════════════════════
# 遷移ウィンドウの構築 (エピソード境界・step の欠落を跨がない)
# ════════════════════════════════════════════════════════════════════

def build_windows(np, episodes, steps, k):
    """行 i から i+k までが「同一エピソードかつ step が +1 ずつ連続」な開始 index を返す。

    エピソード削除や記録の欠落で step が飛んでいる箇所は遷移として使わない
    (飛びを 1ステップの遷移として学習すると力学が汚れる)。
    """
    episodes = np.asarray(episodes)
    steps = np.asarray(steps, dtype='int64')
    n = len(episodes)
    if n <= k or k < 1:
        return np.zeros(0, dtype='int64')
    same = episodes[1:] == episodes[:-1]
    contig = steps[1:] == steps[:-1] + 1
    pair_ok = same & contig                      # 長さ n-1: 行 i→i+1 が有効か
    valid = np.ones(n - k, dtype=bool)
    for j in range(k):
        valid &= pair_ok[j:j + (n - k)]
    return np.nonzero(valid)[0].astype('int64')


def split_episodes(np, episodes, val_split, seed):
    """エピソード単位で train/val のエピソード集合を返す (BC の分割と同じ思想)。"""
    uniq = np.unique(np.asarray(episodes))
    if not val_split or val_split <= 0 or len(uniq) < 2:
        return set(uniq.tolist()), set()
    rng = np.random.default_rng(seed)
    perm = rng.permutation(len(uniq))
    n_val = min(max(1, int(round(len(uniq) * val_split))), len(uniq) - 1)
    val = set(uniq[perm[:n_val]].tolist())
    return set(uniq.tolist()) - val, val


# ════════════════════════════════════════════════════════════════════
# predictor (残差MLP)
# ════════════════════════════════════════════════════════════════════

def build_predictor(torch, nn, emb_dim, act_dim, hidden, blocks):
    """(正規化済み z, 符号化済み a) → 次の z。Δz を学び、出力層はゼロ初期化。

    ゼロ初期化により初期状態が恒等写像 (z_{t+1} = z_t) になる。
    「動かない」を出発点に「行動でどう変わるか」だけを上乗せしていく形なので
    学習が安定し、恒等ベースラインとの比較もそのまま成立する。
    """
    class Predictor(nn.Module):
        def __init__(self):
            super().__init__()
            self.inp = nn.Linear(emb_dim + act_dim, hidden)
            self.blocks = nn.ModuleList([
                nn.Sequential(
                    nn.LayerNorm(hidden),
                    nn.Linear(hidden, hidden), nn.GELU(),
                    nn.Linear(hidden, hidden),
                ) for _ in range(blocks)
            ])
            self.out = nn.Linear(hidden, emb_dim)
            nn.init.zeros_(self.out.weight)
            nn.init.zeros_(self.out.bias)

        def forward(self, z, a):
            h = self.inp(torch.cat([z, a], dim=-1))
            for b in self.blocks:
                h = h + b(h)
            return z + self.out(h)
    return Predictor()


# ════════════════════════════════════════════════════════════════════
# CEM (交差エントロピー法) — 分布更新は numpy 純関数
# ════════════════════════════════════════════════════════════════════

def cem_update_continuous(np, samples, scores, elite_frac, min_std):
    """上位 elite_frac の候補で (mean, std) を更新する。std には床を敷く。"""
    n_elite = max(2, int(round(len(samples) * elite_frac)))
    elite = samples[np.argsort(scores)[-n_elite:]]
    return (elite.mean(axis=0).astype('float32'),
            np.maximum(elite.std(axis=0), min_std).astype('float32'))


def cem_update_discrete(np, samples, scores, n_actions, elite_frac, smooth):
    """上位候補の出現頻度 (+スムージング) で各時刻の行動確率を更新する。"""
    n_elite = max(2, int(round(len(samples) * elite_frac)))
    elite = samples[np.argsort(scores)[-n_elite:]]
    horizon = samples.shape[1]
    probs = np.zeros((horizon, n_actions), dtype='float32')
    for h in range(horizon):
        cnt = np.bincount(elite[:, h], minlength=n_actions).astype('float32')
        probs[h] = (cnt + smooth) / (cnt.sum() + smooth * n_actions)
    return probs


def cem_plan(np, rollout_score_fn, spec, horizon, n_samples, n_iters, seed,
             elite_frac=None, min_std=None, clip=None, smooth=None):
    """CEM で行動系列を探索する。

    rollout_score_fn(candidates) → (N,) のスコア (大きいほど良い)。
      discrete   : candidates は (N, H) の行動 index
      continuous : candidates は (N, H, Da) の **正規化空間** の行動
    ロールアウト (predictor による先読み) は呼び出し側が実装して渡す。
    テストでは numpy の擬似スコア関数を渡せる (torch 不要)。

    Returns:
        {'best': (H,) or (H,Da), 'bestScore': float,
         'scoreHistory': [各イテレーションのベストスコア]}
    """
    p = PLAN_DEFAULTS
    elite_frac = p['eliteFrac'] if elite_frac is None else elite_frac
    min_std = p['minStd'] if min_std is None else min_std
    clip = p['clip'] if clip is None else clip
    smooth = p['smooth'] if smooth is None else smooth
    rng = np.random.default_rng(seed)

    best = None
    best_score = -np.inf
    history = []

    if spec['type'] == 'discrete':
        n_a = len(spec['classes'])
        probs = np.full((horizon, n_a), 1.0 / n_a, dtype='float32')
        for _ in range(n_iters):
            cand = np.stack([rng.choice(n_a, size=n_samples, p=probs[h])
                             for h in range(horizon)], axis=1)   # (N, H)
            if best is not None:
                cand[0] = best   # 前回のベストを保持 (エリートが失われるのを防ぐ)
            scores = np.asarray(rollout_score_fn(cand), dtype='float64')
            i_best = int(np.argmax(scores))
            if scores[i_best] > best_score:
                best_score = float(scores[i_best])
                best = cand[i_best].copy()
            history.append(float(scores[i_best]))
            probs = cem_update_discrete(np, cand, scores, n_a, elite_frac, smooth)
    else:
        d_a = len(spec['columns'])
        mean = np.zeros((horizon, d_a), dtype='float32')   # 正規化空間なので 0 が「平均的な行動」
        std = np.ones((horizon, d_a), dtype='float32')
        for _ in range(n_iters):
            cand = rng.normal(mean, std, size=(n_samples, horizon, d_a)).astype('float32')
            cand = np.clip(cand, -clip, clip)
            if best is not None:
                cand[0] = best
            scores = np.asarray(rollout_score_fn(cand), dtype='float64')
            i_best = int(np.argmax(scores))
            if scores[i_best] > best_score:
                best_score = float(scores[i_best])
                best = cand[i_best].copy()
            history.append(float(scores[i_best]))
            mean, std = cem_update_continuous(np, cand, scores, elite_frac, min_std)

    return {'best': best, 'bestScore': best_score, 'scoreHistory': history}


# ════════════════════════════════════════════════════════════════════
# torch ロールアウト (runner と server が共有)
# ════════════════════════════════════════════════════════════════════

def make_rollout_score_fn(torch, predictor, z0, z_goal, spec, np):
    """CEM に渡すスコア関数を作る。距離は正規化潜在空間の平均二乗。

    スコア = -(最終距離 + 0.1 × 途中距離の平均)
    最終的にゴールへ着くことを主目的に、途中もゴールへ向かう系列を僅かに優遇する。
    """
    device = next(predictor.parameters()).device
    z0_t = torch.tensor(z0, dtype=torch.float32, device=device)
    zg_t = torch.tensor(z_goal, dtype=torch.float32, device=device)

    def score(candidates):
        cand = np.asarray(candidates)
        n = cand.shape[0]
        horizon = cand.shape[1]
        if spec['type'] == 'discrete':
            n_a = len(spec['classes'])
            onehot = np.zeros((n, horizon, n_a), dtype='float32')
            for h in range(horizon):
                onehot[np.arange(n), h, cand[:, h]] = 1.0
            acts = torch.tensor(onehot, device=device)
        else:
            acts = torch.tensor(cand.astype('float32'), device=device)
        with torch.no_grad():
            z = z0_t.unsqueeze(0).expand(n, -1).contiguous()
            inter = 0.0
            for h in range(horizon):
                z = predictor(z, acts[:, h])
                if h < horizon - 1:
                    inter = inter + ((z - zg_t) ** 2).mean(dim=1)
            final = ((z - zg_t) ** 2).mean(dim=1)
            inter_mean = inter / max(horizon - 1, 1)
            s = -(final + 0.1 * inter_mean)
        return s.cpu().numpy()
    return score


# ════════════════════════════════════════════════════════════════════
# モデルの保存 / 読み込み
# ════════════════════════════════════════════════════════════════════

def load_ac_config(model_dir):
    with open(os.path.join(model_dir, 'config.json'), 'r', encoding='utf-8') as f:
        return json.load(f)


def load_predictor(torch, nn, model_dir, device='cpu'):
    """保存済み世界モデルを読み込む。(predictor, config) を返す。"""
    cfg = load_ac_config(model_dir)
    pred = build_predictor(
        torch, nn, int(cfg['embDim']), int(cfg['actionDim']),
        int(cfg.get('hiddenSize', DEFAULTS['hiddenSize'])),
        int(cfg.get('numBlocks', DEFAULTS['numBlocks'])))
    pred.load_state_dict(torch.load(os.path.join(model_dir, 'model.pt'), map_location='cpu'))
    pred.to(device).eval()
    return pred, cfg
