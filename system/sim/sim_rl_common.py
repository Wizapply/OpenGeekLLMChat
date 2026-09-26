#!/usr/bin/env python3
"""
sim_rl_common.py — シミュレータ接続学習 (sim_rl_runner.py) のモデル・バッファ・計画器

状態ベクトル (画像ではない) と連続行動を前提に、次の3方式を同じ入出力で実装する。
どれも行動は [-1, 1] に正規化した空間で扱い、シミュレータの単位への変換は runner が行う。

  tdmpc2 : TD-MPC2 (Hansen et al., ICLR 2024)。潜在状態・報酬・価値・方策を同時に学び、
           MPPI で操作列を毎回選び直す。公式の単一タスク 5M 構成の既定値に合わせている
           (潜在 512 次元 / Q 5本 / ホライズン 3 / 操作列 512 本 / 探索 6 回)。
  pets   : PETS (Chua et al., NeurIPS 2018)。確率的な予測器のアンサンブルで次状態と報酬を
           予測し、CEM で操作列を探す。予測のばらつき (不確実さ) を比較する基準。
  sac    : SAC (Haarnoja et al., ICML 2018)。世界モデルを使わず、方策が操作を直接出す基準。

公式実装との違い (意図的なもの):
  - 状態の正規化: シミュレータの状態は単位がばらばら (角度・力・位置) なので、
    ランダム操作で集めた初期データの平均/標準偏差で入力を正規化し、以後は固定する。
    3方式とも同じ正規化を使うので、比較の条件はそろう。
  - Q のアンサンブルは vmap ではなく ModuleList (5本程度なら差は小さい)。
  - 早期終了するエピソード (失敗で止まる等) は、終端のあとを「吸収状態」で埋めて
    ホライズン分の系列を作る (終端フラグ=1・報酬 0)。
"""
import copy
import math
import random

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F


# ════════════════════════════════════════════════════════════════════
# 既定値
# ════════════════════════════════════════════════════════════════════

TDMPC2_DEFAULTS = {
    # 5M 構成 (公式 model_size=5)
    'latent_dim': 512, 'enc_dim': 256, 'mlp_dim': 512, 'num_enc_layers': 2,
    'num_q': 5, 'simnorm_dim': 8, 'num_bins': 101, 'vmin': -10.0, 'vmax': 10.0, 'dropout': 0.01,
    # 最適化
    'lr': 3e-4, 'enc_lr_scale': 0.3, 'grad_clip_norm': 20.0, 'batch_size': 256,
    'rho': 0.5, 'consistency_coef': 20.0, 'reward_coef': 0.1, 'value_coef': 0.1,
    'termination_coef': 1.0, 'tau': 0.01, 'entropy_coef': 1e-4,
    'log_std_min': -10.0, 'log_std_max': 2.0,
    # 計画 (MPPI)
    'horizon': 3, 'iterations': 6, 'num_samples': 512, 'num_elites': 64, 'num_pi_trajs': 24,
    'min_std': 0.05, 'max_std': 2.0, 'temperature': 0.5,
    # 割引率はエピソード長から決める (公式と同じ式)
    'discount_denom': 5, 'discount_min': 0.95, 'discount_max': 0.995,
}

PETS_DEFAULTS = {
    'ensemble': 5, 'hidden': 200, 'layers': 4, 'lr': 1e-3, 'weight_decay': 1e-5, 'batch_size': 256,
    'train_every': 250, 'updates_per_round': 250,
    'horizon': 10, 'num_samples': 400, 'num_elites': 40, 'iterations': 5, 'alpha': 0.1,
    'init_std': 0.5, 'min_std': 0.05,
}

SAC_DEFAULTS = {
    'hidden': 256, 'lr': 3e-4, 'batch_size': 256, 'tau': 0.005, 'gamma': 0.99,
    'init_alpha': 0.1, 'log_std_min': -5.0, 'log_std_max': 2.0,
}

ALGOS = {
    'tdmpc2': {'label': 'TD-MPC2 5M', 'defaults': TDMPC2_DEFAULTS,
               'desc': '潜在状態・報酬・価値を予測し、MPPI で操作列を毎周期選び直す (第一候補)'},
    'pets': {'label': 'PETS', 'defaults': PETS_DEFAULTS,
             'desc': '確率的な予測器のアンサンブル + CEM。予測の不確実さを扱う比較対象'},
    'sac': {'label': 'SAC', 'defaults': SAC_DEFAULTS,
            'desc': '世界モデルなし。方策が操作を直接出す。効果と実行速度の基準'},
}


def merged(defaults, override):
    out = dict(defaults)
    for k, v in (override or {}).items():
        if k in defaults and v is not None:
            out[k] = type(defaults[k])(v) if not isinstance(defaults[k], bool) else bool(v)
    return out


def clamp_plan_sizes(c):
    """詳細設定で探索の本数を変えた時に、エリート数などが候補数を超えないようにする。"""
    c['horizon'] = max(1, int(c['horizon']))
    c['iterations'] = max(1, int(c['iterations']))
    c['num_samples'] = max(2, int(c['num_samples']))
    if 'num_pi_trajs' in c:
        c['num_pi_trajs'] = min(max(0, int(c['num_pi_trajs'])), c['num_samples'] - 1)
    c['num_elites'] = min(max(1, int(c['num_elites'])), c['num_samples'])
    return c


def episode_discount(ep_len, c):
    """公式 TD-MPC2 と同じ: エピソードが長いほど遠くまで見る割引率。"""
    frac = ep_len / c['discount_denom']
    return float(min(max((frac - 1) / frac, c['discount_min']), c['discount_max']))


# ════════════════════════════════════════════════════════════════════
# リプレイバッファ (エピソード単位で追加。系列サンプリング対応)
# ════════════════════════════════════════════════════════════════════

class EpisodeBuffer:
    """遷移をエピソードごとに連続した領域へ詰める。

    複数の環境を同時に回すと遷移が交互に届くので、エピソードが終わってから
    まとめて追加する (公式 TD-MPC2 と同じ)。容量は学習ステップ数ぶん確保し、
    リングにはしない (系列の境界管理を単純に保つため)。
    """

    def __init__(self, capacity, obs_dim, act_dim):
        self.cap = int(capacity)
        self.obs = np.zeros((self.cap, obs_dim), np.float32)
        self.next_obs = np.zeros((self.cap, obs_dim), np.float32)
        self.act = np.zeros((self.cap, act_dim), np.float32)
        self.rew = np.zeros((self.cap,), np.float32)
        self.term = np.zeros((self.cap,), np.float32)
        self.ep_end = np.zeros((self.cap,), np.int64)       # そのエピソードの最終遷移の index
        self.ep_terminated = np.zeros((self.cap,), bool)    # 終端 (打ち切りではない) で終わったか
        self.n = 0
        self._valid = {}   # horizon → 系列の開始に使える index の配列 (キャッシュ)

    def __len__(self):
        return self.n

    def add_episode(self, obs, act, rew, next_obs, term):
        T = len(rew)
        if T == 0:
            return
        if self.n + T > self.cap:
            T = self.cap - self.n
            if T <= 0:
                return
        s, e = self.n, self.n + T
        self.obs[s:e] = obs[:T]
        self.act[s:e] = act[:T]
        self.rew[s:e] = rew[:T]
        self.next_obs[s:e] = next_obs[:T]
        self.term[s:e] = term[:T]
        self.ep_end[s:e] = e - 1
        terminated = bool(term[T - 1] > 0.5)
        self.ep_terminated[s:e] = terminated
        self.n = e
        for h, arr in list(self._valid.items()):
            self._valid[h] = np.concatenate([arr, self._valid_range(s, e, h)])

    def _valid_range(self, s, e, h):
        idx = np.arange(s, e)
        rem = self.ep_end[s:e] - idx + 1
        ok = (rem >= h) | self.ep_terminated[s:e]
        return idx[ok]

    def valid_starts(self, h):
        if h not in self._valid:
            self._valid[h] = self._valid_range(0, self.n, h) if self.n else np.zeros(0, np.int64)
        return self._valid[h]

    def sample_seq(self, batch, horizon, rng):
        """(H+1, B, obs), (H, B, act), (H, B, 1) 報酬, (H, B, 1) 終端 を返す (numpy)。"""
        starts = self.valid_starts(horizon)
        if len(starts) == 0:
            return None
        i0 = starts[rng.integers(0, len(starts), size=batch)]
        H = horizon
        obs = np.empty((H + 1, batch, self.obs.shape[1]), np.float32)
        act = np.empty((H, batch, self.act.shape[1]), np.float32)
        rew = np.empty((H, batch, 1), np.float32)
        term = np.empty((H, batch, 1), np.float32)
        obs[0] = self.obs[i0]
        end = self.ep_end[i0]
        for t in range(H):
            j = i0 + t
            pad = j > end                 # 終端のあと (吸収状態で埋める)
            jc = np.minimum(j, end)
            obs[t + 1] = self.next_obs[jc]
            act[t] = np.where(pad[:, None], 0.0, self.act[jc])
            rew[t, :, 0] = np.where(pad, 0.0, self.rew[jc])
            term[t, :, 0] = np.where(pad, 1.0, self.term[jc])
        return obs, act, rew, term

    def sample(self, batch, rng):
        idx = rng.integers(0, self.n, size=batch)
        return self.obs[idx], self.act[idx], self.rew[idx, None], self.next_obs[idx], self.term[idx, None]


class ObsNorm:
    """状態の正規化 (初期データで平均/標準偏差を決めて固定する)。"""

    def __init__(self, dim):
        self.mean = np.zeros(dim, np.float32)
        self.std = np.ones(dim, np.float32)
        self.fitted = False

    def fit(self, x):
        self.mean = x.mean(0).astype(np.float32)
        self.std = np.maximum(x.std(0), 1e-3).astype(np.float32)
        self.fitted = True

    def state_dict(self):
        return {'mean': self.mean.tolist(), 'std': self.std.tolist(), 'fitted': self.fitted}

    def load_state_dict(self, d):
        self.mean = np.asarray(d['mean'], np.float32)
        self.std = np.asarray(d['std'], np.float32)
        self.fitted = bool(d.get('fitted', True))


# ════════════════════════════════════════════════════════════════════
# TD-MPC2 の部品
# ════════════════════════════════════════════════════════════════════

class SimNorm(nn.Module):
    """潜在をグループごとに softmax する正規化 (潜在が発散しないようにする)。"""

    def __init__(self, dim):
        super().__init__()
        self.dim = dim

    def forward(self, x):
        shp = x.shape
        x = x.view(*shp[:-1], -1, self.dim)
        return F.softmax(x, dim=-1).view(*shp)


class NormedLinear(nn.Linear):
    """Linear → (Dropout) → LayerNorm → 活性化 (既定 Mish)。"""

    def __init__(self, in_f, out_f, dropout=0.0, act=None):
        super().__init__(in_f, out_f)
        self.ln = nn.LayerNorm(out_f)
        self.act = act if act is not None else nn.Mish()
        self.drop = nn.Dropout(dropout) if dropout else None

    def forward(self, x):
        x = super().forward(x)
        if self.drop is not None:
            x = self.drop(x)
        return self.act(self.ln(x))


def mlp(in_dim, hidden, out_dim, act=None, dropout=0.0):
    dims = [in_dim] + list(hidden) + [out_dim]
    layers = []
    for i in range(len(dims) - 2):
        layers.append(NormedLinear(dims[i], dims[i + 1], dropout=dropout if i == 0 else 0.0))
    if act is not None:
        layers.append(NormedLinear(dims[-2], dims[-1], act=act))
    else:
        layers.append(nn.Linear(dims[-2], dims[-1]))
    return nn.Sequential(*layers)


def weight_init(m):
    if isinstance(m, nn.Linear):
        nn.init.trunc_normal_(m.weight, std=0.02)
        if m.bias is not None:
            nn.init.zeros_(m.bias)


def symlog(x):
    return torch.sign(x) * torch.log(1 + torch.abs(x))


def symexp(x):
    return torch.sign(x) * (torch.exp(torch.abs(x)) - 1)


class TwoHot:
    """スカラー (報酬・価値) を symlog 空間の 101 ビンの分布として扱う。"""

    def __init__(self, c, device):
        self.n = c['num_bins']
        self.vmin, self.vmax = c['vmin'], c['vmax']
        self.bin_size = (self.vmax - self.vmin) / (self.n - 1)
        self.bins = torch.linspace(self.vmin, self.vmax, self.n, device=device)

    def encode(self, x):
        x = torch.clamp(symlog(x), self.vmin, self.vmax).squeeze(-1)
        pos = (x - self.vmin) / self.bin_size
        idx = torch.floor(pos).long().clamp(0, self.n - 1)
        off = (pos - idx.float()).unsqueeze(-1)
        soft = torch.zeros(*x.shape, self.n, device=x.device)
        soft.scatter_(-1, idx.unsqueeze(-1), 1 - off)
        soft.scatter_(-1, ((idx + 1) % self.n).unsqueeze(-1), off)
        return soft

    def decode(self, logits):
        p = F.softmax(logits, dim=-1)
        return symexp((p * self.bins).sum(-1, keepdim=True))

    def soft_ce(self, logits, target):
        return -(self.encode(target) * F.log_softmax(logits, dim=-1)).sum(-1, keepdim=True)


def gaussian_logprob(eps, log_std):
    residual = -0.5 * eps.pow(2) - log_std
    return (residual - 0.5 * math.log(2 * math.pi)).sum(-1, keepdim=True)


def squash(mu, pi, log_pi):
    mu = torch.tanh(mu)
    pi = torch.tanh(pi)
    log_pi = log_pi - torch.log(F.relu(1 - pi.pow(2)) + 1e-6).sum(-1, keepdim=True)
    return mu, pi, log_pi


class RunningScale:
    """Q 値の 5〜95 パーセンタイル幅で方策の損失をスケールする (報酬の大きさに依らない学習)。"""

    def __init__(self, tau, device):
        self.tau = tau
        self.value = torch.ones(1, device=device)

    def update(self, x):
        x = x.detach().float().flatten()
        lo, hi = torch.quantile(x, torch.tensor([0.05, 0.95], device=x.device))
        self.value.lerp_(torch.clamp(hi - lo, min=1.0).view(1), self.tau)

    def __call__(self, x):
        return x * (1.0 / self.value)


class TDMPC2Model(nn.Module):
    def __init__(self, obs_dim, act_dim, c):
        super().__init__()
        L, M = c['latent_dim'], c['mlp_dim']
        self.c = c
        self._encoder = mlp(obs_dim, max(c['num_enc_layers'] - 1, 1) * [c['enc_dim']], L,
                            act=SimNorm(c['simnorm_dim']))
        self._dynamics = mlp(L + act_dim, 2 * [M], L, act=SimNorm(c['simnorm_dim']))
        self._reward = mlp(L + act_dim, 2 * [M], c['num_bins'])
        self._termination = mlp(L, 2 * [M], 1)
        self._pi = mlp(L, 2 * [M], 2 * act_dim)
        self._Qs = nn.ModuleList([mlp(L + act_dim, 2 * [M], c['num_bins'], dropout=c['dropout'])
                                  for _ in range(c['num_q'])])
        self.apply(weight_init)
        # 報酬と Q の出力層はゼロ初期化 (公式と同じ。学習初期の値を 0 から始める)
        nn.init.zeros_(self._reward[-1].weight)
        for q in self._Qs:
            nn.init.zeros_(q[-1].weight)
        self._target_Qs = copy.deepcopy(self._Qs).requires_grad_(False)

    def encode(self, obs):
        return self._encoder(obs)

    def next(self, z, a):
        return self._dynamics(torch.cat([z, a], -1))

    def reward(self, z, a):
        return self._reward(torch.cat([z, a], -1))

    def termination(self, z):
        return self._termination(z)

    def pi(self, z):
        c = self.c
        mean, log_std = self._pi(z).chunk(2, dim=-1)
        log_std = c['log_std_min'] + 0.5 * (c['log_std_max'] - c['log_std_min']) * (torch.tanh(log_std) + 1)
        eps = torch.randn_like(mean)
        log_prob = gaussian_logprob(eps, log_std)
        scaled_log_prob = log_prob * eps.shape[-1]
        action = mean + eps * log_std.exp()
        mean, action, log_prob = squash(mean, action, log_prob)
        entropy_scale = scaled_log_prob / (log_prob + 1e-8)
        return action, {'mean': mean, 'scaled_entropy': -log_prob * entropy_scale}

    def Q(self, z, a, return_type='min', target=False, detach=False, two_hot=None):
        x = torch.cat([z, a], -1)
        qs = self._target_Qs if target else self._Qs
        if return_type == 'all':
            return torch.stack([q(x) for q in qs])
        i1, i2 = random.sample(range(len(qs)), 2)
        if detach:
            outs = []
            for i in (i1, i2):
                params = {k: v.detach() for k, v in qs[i].named_parameters()}
                outs.append(torch.func.functional_call(qs[i], params, (x,)))
        else:
            outs = [qs[i1](x), qs[i2](x)]
        q1, q2 = two_hot.decode(outs[0]), two_hot.decode(outs[1])
        return torch.min(q1, q2) if return_type == 'min' else (q1 + q2) / 2

    def q_disagreement(self, z, a):
        """5本の価値予測のばらつき (標準偏差)。安全監視・不確実さの指標に使う。"""
        x = torch.cat([z, a], -1)
        return x, [q(x) for q in self._Qs]

    def soft_update_target(self, tau):
        with torch.no_grad():
            for p, tp in zip(self._Qs.parameters(), self._target_Qs.parameters()):
                tp.lerp_(p, tau)


class Agent:
    """3方式に共通の外形。runner はこのメソッドだけを使う。"""
    algo = 'base'

    def __init__(self, obs_dim, act_dim, cfg, device, ep_len):
        self.obs_dim, self.act_dim = obs_dim, act_dim
        self.device = device
        self.norm = ObsNorm(obs_dim)
        self.rng = np.random.default_rng(int(cfg.get('seed', 0)))
        self.ep_len = ep_len

    def _obs_t(self, obs):
        x = (np.asarray(obs, np.float32) - self.norm.mean) / self.norm.std
        return torch.as_tensor(x, device=self.device)

    def reset_env(self, env_i):
        pass

    def n_params(self):
        return sum(p.numel() for p in self.modules_for_count().parameters())


class TDMPC2Agent(Agent):
    algo = 'tdmpc2'

    def __init__(self, obs_dim, act_dim, cfg, device, ep_len):
        super().__init__(obs_dim, act_dim, cfg, device, ep_len)
        self.c = c = clamp_plan_sizes(merged(TDMPC2_DEFAULTS, cfg.get('hyper')))
        if c['num_q'] < 2:
            raise ValueError('num_q は 2 以上にしてください (価値の推定に2本を使うため)')
        self.model = TDMPC2Model(obs_dim, act_dim, c).to(device)
        self.two_hot = TwoHot(c, device)
        self.optim = torch.optim.Adam([
            {'params': self.model._encoder.parameters(), 'lr': c['lr'] * c['enc_lr_scale']},
            {'params': self.model._dynamics.parameters()},
            {'params': self.model._reward.parameters()},
            {'params': self.model._termination.parameters()},
            {'params': self.model._Qs.parameters()},
        ], lr=c['lr'], capturable=False)
        self.pi_optim = torch.optim.Adam(self.model._pi.parameters(), lr=c['lr'], eps=1e-5)
        self.scale = RunningScale(c['tau'], device)
        self.discount = episode_discount(ep_len, c)
        self.prev_mean = {}   # 環境ごとの前回の探索平均 (ずらして次の周期の初期値にする)

    def modules_for_count(self):
        # target Q は学習しないので数えない
        m = nn.ModuleList([self.model._encoder, self.model._dynamics, self.model._reward,
                           self.model._termination, self.model._pi, self.model._Qs])
        return m

    def reset_env(self, env_i):
        self.prev_mean.pop(env_i, None)

    @torch.no_grad()
    def _estimate_value(self, z, actions):
        m, c = self.model, self.c
        G, disc = 0, 1.0
        term = torch.zeros(z.shape[0], 1, device=z.device)
        for t in range(actions.shape[0]):
            r = self.two_hot.decode(m.reward(z, actions[t]))
            z = m.next(z, actions[t])
            G = G + disc * (1 - term) * r
            disc = disc * self.discount
            term = torch.clip(term + (torch.sigmoid(m.termination(z)) > 0.5).float(), max=1.0)
        a, _ = m.pi(z)
        return G + disc * (1 - term) * m.Q(z, a, 'avg', two_hot=self.two_hot)

    @torch.no_grad()
    def act(self, obs, env_i=0, eval_mode=False):
        m, c = self.model, self.c
        m.eval()
        try:
            z = m.encode(self._obs_t(obs).unsqueeze(0))
            H, A = c['horizon'], self.act_dim
            N, P = c['num_samples'], c['num_pi_trajs']
            # 1) 方策から操作列を P 本作る
            pi_actions = torch.empty(H, P, A, device=self.device)
            _z = z.repeat(P, 1)
            for t in range(H - 1):
                pi_actions[t], _ = m.pi(_z)
                _z = m.next(_z, pi_actions[t])
            pi_actions[-1], _ = m.pi(_z)
            # 2) MPPI
            z = z.repeat(N, 1)
            mean = torch.zeros(H, A, device=self.device)
            std = torch.full((H, A), c['max_std'], device=self.device)
            if env_i in self.prev_mean:
                mean[:-1] = self.prev_mean[env_i][1:]
            actions = torch.empty(H, N, A, device=self.device)
            actions[:, :P] = pi_actions
            for _ in range(c['iterations']):
                r = torch.randn(H, N - P, A, device=self.device)
                actions[:, P:] = (mean.unsqueeze(1) + std.unsqueeze(1) * r).clamp(-1, 1)
                value = self._estimate_value(z, actions).nan_to_num(0)
                elite_idx = torch.topk(value.squeeze(1), c['num_elites'], dim=0).indices
                elite_value, elite_actions = value[elite_idx], actions[:, elite_idx]
                max_value = elite_value.max(0).values
                score = torch.exp(c['temperature'] * (elite_value - max_value))
                score = score / score.sum(0)
                mean = (score.unsqueeze(0) * elite_actions).sum(1) / (score.sum(0) + 1e-9)
                std = ((score.unsqueeze(0) * (elite_actions - mean.unsqueeze(1)) ** 2).sum(1)
                       / (score.sum(0) + 1e-9)).sqrt().clamp(c['min_std'], c['max_std'])
            # 3) エリートの中から重みに応じて1本選び、その先頭だけ実行する
            g = -torch.empty_like(score.squeeze(1)).exponential_().log()
            idx = int((score.squeeze(1).log() + g).argmax())
            a = elite_actions[:, idx][0]
            if not eval_mode:
                a = a + std[0] * torch.randn(A, device=self.device)
            self.prev_mean[env_i] = mean.clone()
            a = a.clamp(-1, 1)
            # 不確実さ: 選んだ操作に対する 5本の価値予測のばらつき
            _, q_logits = m.q_disagreement(z[:1], a.unsqueeze(0))
            qv = torch.cat([self.two_hot.decode(l) for l in q_logits], dim=-1)
            unc = float(qv.std(dim=-1).item())
            return a.cpu().numpy(), {'uncertainty': unc, 'value': float(qv.mean().item())}
        finally:
            m.train()

    def _td_target(self, next_z, reward, term):
        a, _ = self.model.pi(next_z)
        return reward + self.discount * (1 - term) * self.model.Q(next_z, a, 'min', target=True,
                                                                     two_hot=self.two_hot)

    def update(self, buf):
        c, m = self.c, self.model
        s = buf.sample_seq(c['batch_size'], c['horizon'], self.rng)
        if s is None:
            return None
        obs, act, rew, term = [torch.as_tensor(x, device=self.device) for x in s]
        obs = (obs - torch.as_tensor(self.norm.mean, device=self.device)) / \
            torch.as_tensor(self.norm.std, device=self.device)
        H = c['horizon']
        with torch.no_grad():
            next_z = m.encode(obs[1:])
            td_targets = self._td_target(next_z, rew, term)

        m.train()
        zs = torch.empty(H + 1, obs.shape[1], c['latent_dim'], device=self.device)
        z = m.encode(obs[0])
        zs[0] = z
        consistency = 0
        for t in range(H):
            z = m.next(z, act[t])
            consistency = consistency + F.mse_loss(z, next_z[t]) * c['rho'] ** t
            zs[t + 1] = z
        _zs = zs[:-1]
        qs = m.Q(_zs, act, return_type='all')
        reward_preds = m.reward(_zs, act)
        term_logits = m.termination(zs[1:])
        reward_loss, value_loss = 0, 0
        for t in range(H):
            reward_loss = reward_loss + self.two_hot.soft_ce(reward_preds[t], rew[t]).mean() * c['rho'] ** t
            for q in range(c['num_q']):
                value_loss = value_loss + self.two_hot.soft_ce(qs[q][t], td_targets[t]).mean() * c['rho'] ** t
        consistency = consistency / H
        reward_loss = reward_loss / H
        value_loss = value_loss / (H * c['num_q'])
        term_loss = F.binary_cross_entropy_with_logits(term_logits, term)
        total = (c['consistency_coef'] * consistency + c['reward_coef'] * reward_loss
                 + c['termination_coef'] * term_loss + c['value_coef'] * value_loss)
        self.optim.zero_grad(set_to_none=True)
        total.backward()
        grad_norm = torch.nn.utils.clip_grad_norm_(m.parameters(), c['grad_clip_norm'])
        self.optim.step()

        # 方策: 潜在は止めて、Q (勾配は止める) を最大化 + エントロピー
        zs_d = zs.detach()
        a, info = m.pi(zs_d)
        qv = m.Q(zs_d, a, 'avg', detach=True, two_hot=self.two_hot)
        self.scale.update(qv[0])
        qv = self.scale(qv)
        rho = torch.pow(c['rho'], torch.arange(len(qv), device=self.device))
        pi_loss = (-(c['entropy_coef'] * info['scaled_entropy'] + qv).mean(dim=(1, 2)) * rho).mean()
        self.pi_optim.zero_grad(set_to_none=True)
        pi_loss.backward()
        torch.nn.utils.clip_grad_norm_(m._pi.parameters(), c['grad_clip_norm'])
        self.pi_optim.step()
        m.soft_update_target(c['tau'])
        return {'loss': float(total.item()), 'consistency': float(consistency.item()),
                'reward': float(reward_loss.item()), 'value': float(value_loss.item()),
                'termination': float(term_loss.item()), 'pi': float(pi_loss.item()),
                'gradNorm': float(grad_norm.item())}

    def pretrain_updates(self, seed_steps):
        return int(seed_steps)   # 公式: 初期データのステップ数だけまとめて更新する

    def state_dict(self):
        return {'model': self.model.state_dict(), 'scale': self.scale.value.cpu()}

    def load_state_dict(self, d):
        self.model.load_state_dict(d['model'])
        if 'scale' in d:
            self.scale.value = d['scale'].to(self.device)


# ════════════════════════════════════════════════════════════════════
# PETS
# ════════════════════════════════════════════════════════════════════

class EnsembleLinear(nn.Module):
    def __init__(self, E, in_f, out_f):
        super().__init__()
        self.w = nn.Parameter(torch.empty(E, in_f, out_f))
        self.b = nn.Parameter(torch.zeros(E, 1, out_f))
        for e in range(E):
            nn.init.trunc_normal_(self.w.data[e], std=1.0 / (2 * math.sqrt(in_f)))

    def forward(self, x):   # x: (E, B, in)
        return torch.baddbmm(self.b, x, self.w)


class ProbEnsemble(nn.Module):
    """E 個の確率的 MLP。出力は [Δ状態, 報酬] の平均と対数分散 + 終端ロジット。"""

    def __init__(self, obs_dim, act_dim, c):
        super().__init__()
        E, h = c['ensemble'], c['hidden']
        self.E, self.obs_dim = E, obs_dim
        self.out_dim = obs_dim + 1
        dims = [obs_dim + act_dim] + [h] * c['layers']
        self.layers = nn.ModuleList([EnsembleLinear(E, dims[i], dims[i + 1]) for i in range(len(dims) - 1)])
        self.head = EnsembleLinear(E, h, 2 * self.out_dim + 1)
        self.max_logvar = nn.Parameter(torch.full((1, 1, self.out_dim), 0.5))
        self.min_logvar = nn.Parameter(torch.full((1, 1, self.out_dim), -10.0))
        # 入力・出力の正規化 (学習ごとに全データから計算し直す)
        self.register_buffer('in_mu', torch.zeros(obs_dim + act_dim))
        self.register_buffer('in_sd', torch.ones(obs_dim + act_dim))
        self.register_buffer('out_mu', torch.zeros(self.out_dim))
        self.register_buffer('out_sd', torch.ones(self.out_dim))

    def forward(self, x):
        x = (x - self.in_mu) / self.in_sd
        for l in self.layers:
            x = F.silu(l(x))
        out = self.head(x)
        mean = out[..., :self.out_dim]
        logvar = out[..., self.out_dim:2 * self.out_dim]
        term_logit = out[..., -1:]
        logvar = self.max_logvar - F.softplus(self.max_logvar - logvar)
        logvar = self.min_logvar + F.softplus(logvar - self.min_logvar)
        return mean, logvar, term_logit


class PETSAgent(Agent):
    algo = 'pets'

    def __init__(self, obs_dim, act_dim, cfg, device, ep_len):
        super().__init__(obs_dim, act_dim, cfg, device, ep_len)
        self.c = c = clamp_plan_sizes(merged(PETS_DEFAULTS, cfg.get('hyper')))
        self.model = ProbEnsemble(obs_dim, act_dim, c).to(device)
        self.optim = torch.optim.Adam(self.model.parameters(), lr=c['lr'], weight_decay=c['weight_decay'])
        self.prev_mean = {}
        self._since_train = 0

    def modules_for_count(self):
        return self.model

    def reset_env(self, env_i):
        self.prev_mean.pop(env_i, None)

    def _refit_norm(self, buf):
        n = len(buf)
        obs_n = (buf.obs[:n] - self.norm.mean) / self.norm.std
        nxt_n = (buf.next_obs[:n] - self.norm.mean) / self.norm.std
        x = np.concatenate([obs_n, buf.act[:n]], 1)
        y = np.concatenate([nxt_n - obs_n, buf.rew[:n, None]], 1)
        m = self.model
        m.in_mu.copy_(torch.as_tensor(x.mean(0), device=self.device))
        m.in_sd.copy_(torch.as_tensor(np.maximum(x.std(0), 1e-3), device=self.device))
        m.out_mu.copy_(torch.as_tensor(y.mean(0), device=self.device))
        m.out_sd.copy_(torch.as_tensor(np.maximum(y.std(0), 1e-3), device=self.device))

    def _train_round(self, buf, n_updates):
        c, m = self.c, self.model
        self._refit_norm(buf)
        mu_o = torch.as_tensor(self.norm.mean, device=self.device)
        sd_o = torch.as_tensor(self.norm.std, device=self.device)
        last = None
        for _ in range(n_updates):
            # 各メンバーは別々の添字でサンプルする (ブートストラップ)
            idx = self.rng.integers(0, len(buf), size=(c['ensemble'], c['batch_size']))
            o = (torch.as_tensor(buf.obs[idx], device=self.device) - mu_o) / sd_o
            o2 = (torch.as_tensor(buf.next_obs[idx], device=self.device) - mu_o) / sd_o
            a = torch.as_tensor(buf.act[idx], device=self.device)
            r = torch.as_tensor(buf.rew[idx], device=self.device).unsqueeze(-1)
            d = torch.as_tensor(buf.term[idx], device=self.device).unsqueeze(-1)
            y = (torch.cat([o2 - o, r], -1) - m.out_mu) / m.out_sd
            mean, logvar, tl = m(torch.cat([o, a], -1))
            nll = (((mean - y) ** 2) * torch.exp(-logvar) + logvar).mean()
            bce = F.binary_cross_entropy_with_logits(tl, d)
            loss = nll + bce + 0.01 * (m.max_logvar.sum() - m.min_logvar.sum())
            self.optim.zero_grad(set_to_none=True)
            loss.backward()
            self.optim.step()
            last = {'loss': float(loss.item()), 'nll': float(nll.item()), 'termination': float(bce.item())}
        return last

    def pretrain_updates(self, seed_steps):
        return max(self.c['updates_per_round'] * 4, 1)

    def update(self, buf):
        # 毎ステップではなく train_every ステップごとにまとめて学習する (PETS の流儀)
        self._since_train += 1
        if self._since_train < self.c['train_every']:
            return None
        self._since_train = 0
        return self._train_round(buf, self.c['updates_per_round'])

    def pretrain(self, buf, n):
        return self._train_round(buf, n)

    @torch.no_grad()
    def _rollout_score(self, o, cand):
        """o: (obs,) 正規化済み, cand: (N, H, A) → 各候補のスコア (E 本の平均)。"""
        m = self.model
        E = m.E
        N, H, _ = cand.shape
        s = o.view(1, 1, -1).expand(E, N, -1)
        ret = torch.zeros(E, N, 1, device=self.device)
        alive = torch.ones(E, N, 1, device=self.device)
        for t in range(H):
            a = cand[:, t].unsqueeze(0).expand(E, -1, -1)
            mean, logvar, tl = m(torch.cat([s, a], -1))
            y = mean + torch.randn_like(mean) * torch.exp(0.5 * logvar)   # 軌道サンプリング
            y = y * m.out_sd + m.out_mu
            s = s + y[..., :-1]
            ret = ret + alive * y[..., -1:]
            alive = alive * (torch.sigmoid(tl) < 0.5).float()
        return ret.mean(0).squeeze(-1)

    @torch.no_grad()
    def act(self, obs, env_i=0, eval_mode=False):
        c, m = self.c, self.model
        o = self._obs_t(obs)
        H, A, N = c['horizon'], self.act_dim, c['num_samples']
        mean = torch.zeros(H, A, device=self.device)
        if env_i in self.prev_mean:
            mean[:-1] = self.prev_mean[env_i][1:]
        std = torch.full((H, A), c['init_std'], device=self.device)
        best = None
        for _ in range(c['iterations']):
            cand = (mean + std * torch.randn(N, H, A, device=self.device)).clamp(-1, 1)
            if best is not None:
                cand[0] = best
            score = self._rollout_score(o, cand)
            elite = cand[torch.topk(score, c['num_elites']).indices]
            best = cand[int(torch.argmax(score))].clone()
            mean = c['alpha'] * mean + (1 - c['alpha']) * elite.mean(0)
            std = (c['alpha'] * std + (1 - c['alpha']) * elite.std(0)).clamp(min=c['min_std'])
        self.prev_mean[env_i] = mean.clone()
        a = mean[0]
        if not eval_mode:
            a = a + 0.1 * torch.randn(A, device=self.device)
        a = a.clamp(-1, 1)
        # 不確実さ: 選んだ操作で E 本が予測する次状態のばらつき (正規化空間)
        mu, _, _ = m(torch.cat([o, a], -1).view(1, 1, -1).expand(m.E, 1, -1))
        unc = float(mu[..., :-1].std(0).mean().item())
        return a.cpu().numpy(), {'uncertainty': unc}

    def state_dict(self):
        return {'model': self.model.state_dict()}

    def load_state_dict(self, d):
        self.model.load_state_dict(d['model'])


# ════════════════════════════════════════════════════════════════════
# SAC
# ════════════════════════════════════════════════════════════════════

def _plain_mlp(in_dim, h, out_dim):
    return nn.Sequential(nn.Linear(in_dim, h), nn.ReLU(), nn.Linear(h, h), nn.ReLU(), nn.Linear(h, out_dim))


class SACAgent(Agent):
    algo = 'sac'

    def __init__(self, obs_dim, act_dim, cfg, device, ep_len):
        super().__init__(obs_dim, act_dim, cfg, device, ep_len)
        self.c = c = merged(SAC_DEFAULTS, cfg.get('hyper'))
        h = c['hidden']
        self.actor = _plain_mlp(obs_dim, h, 2 * act_dim).to(device)
        self.q1 = _plain_mlp(obs_dim + act_dim, h, 1).to(device)
        self.q2 = _plain_mlp(obs_dim + act_dim, h, 1).to(device)
        self.q1_t = copy.deepcopy(self.q1).requires_grad_(False)
        self.q2_t = copy.deepcopy(self.q2).requires_grad_(False)
        self.log_alpha = torch.tensor(math.log(c['init_alpha']), device=device, requires_grad=True)
        self.target_entropy = -float(act_dim)
        self.a_optim = torch.optim.Adam(self.actor.parameters(), lr=c['lr'])
        self.q_optim = torch.optim.Adam(list(self.q1.parameters()) + list(self.q2.parameters()), lr=c['lr'])
        self.al_optim = torch.optim.Adam([self.log_alpha], lr=c['lr'])

    def modules_for_count(self):
        return nn.ModuleList([self.actor, self.q1, self.q2])

    def _pi(self, o):
        c = self.c
        mu, log_std = self.actor(o).chunk(2, -1)
        log_std = torch.clamp(log_std, c['log_std_min'], c['log_std_max'])
        eps = torch.randn_like(mu)
        log_prob = gaussian_logprob(eps, log_std)
        mu, a, log_prob = squash(mu, mu + eps * log_std.exp(), log_prob)
        return a, log_prob, mu

    @torch.no_grad()
    def act(self, obs, env_i=0, eval_mode=False):
        o = self._obs_t(obs).unsqueeze(0)
        a, _, mu = self._pi(o)
        a = mu if eval_mode else a
        x = torch.cat([o, a], -1)
        q1, q2 = self.q1(x), self.q2(x)
        return a[0].cpu().numpy(), {'uncertainty': float((q1 - q2).abs().item()),
                                    'value': float(((q1 + q2) / 2).item())}

    def update(self, buf):
        c = self.c
        o, a, r, o2, d = buf.sample(c['batch_size'], self.rng)
        mu = torch.as_tensor(self.norm.mean, device=self.device)
        sd = torch.as_tensor(self.norm.std, device=self.device)
        o = (torch.as_tensor(o, device=self.device) - mu) / sd
        o2 = (torch.as_tensor(o2, device=self.device) - mu) / sd
        a = torch.as_tensor(a, device=self.device)
        r = torch.as_tensor(r, device=self.device)
        d = torch.as_tensor(d, device=self.device)
        alpha = self.log_alpha.exp().detach()
        with torch.no_grad():
            a2, lp2, _ = self._pi(o2)
            x2 = torch.cat([o2, a2], -1)
            q_t = torch.min(self.q1_t(x2), self.q2_t(x2)) - alpha * lp2
            y = r + c['gamma'] * (1 - d) * q_t
        x = torch.cat([o, a], -1)
        q_loss = F.mse_loss(self.q1(x), y) + F.mse_loss(self.q2(x), y)
        self.q_optim.zero_grad(set_to_none=True)
        q_loss.backward()
        self.q_optim.step()

        an, lp, _ = self._pi(o)
        xn = torch.cat([o, an], -1)
        pi_loss = (alpha * lp - torch.min(self.q1(xn), self.q2(xn))).mean()
        self.a_optim.zero_grad(set_to_none=True)
        pi_loss.backward()
        self.a_optim.step()
        al_loss = -(self.log_alpha * (lp.detach() + self.target_entropy)).mean()
        self.al_optim.zero_grad(set_to_none=True)
        al_loss.backward()
        self.al_optim.step()
        with torch.no_grad():
            for net, tgt in ((self.q1, self.q1_t), (self.q2, self.q2_t)):
                for p, tp in zip(net.parameters(), tgt.parameters()):
                    tp.lerp_(p, c['tau'])
        return {'loss': float(q_loss.item()), 'pi': float(pi_loss.item()), 'alpha': float(alpha.item())}

    def pretrain_updates(self, seed_steps):
        return 0

    def state_dict(self):
        return {'actor': self.actor.state_dict(), 'q1': self.q1.state_dict(), 'q2': self.q2.state_dict(),
                'q1_t': self.q1_t.state_dict(), 'q2_t': self.q2_t.state_dict(),
                'log_alpha': self.log_alpha.detach().cpu()}

    def load_state_dict(self, d):
        self.actor.load_state_dict(d['actor'])
        self.q1.load_state_dict(d['q1'])
        self.q2.load_state_dict(d['q2'])
        self.q1_t.load_state_dict(d.get('q1_t', d['q1']))
        self.q2_t.load_state_dict(d.get('q2_t', d['q2']))
        with torch.no_grad():
            self.log_alpha.copy_(d['log_alpha'].to(self.device))


AGENT_CLASSES = {'tdmpc2': TDMPC2Agent, 'pets': PETSAgent, 'sac': SACAgent}


def make_agent(algo, obs_dim, act_dim, cfg, device, ep_len):
    if algo not in AGENT_CLASSES:
        raise ValueError(f'未対応のアルゴリズム: {algo}')
    return AGENT_CLASSES[algo](obs_dim, act_dim, cfg, device, ep_len)
