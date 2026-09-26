#!/usr/bin/env python3
"""
sim_rl_runner.py — 外部シミュレータ (HTTP) を相手にしたオンライン強化学習ジョブ

sim_http.py のプロトコルを実装したシミュレータに接続し、TD-MPC2 / PETS / SAC を
同じ条件 (同じシミュレータ試行数・同じ評価条件・同じ乱数) で学習・評価する。

流れ (train):
  1. /info で状態・行動の定義と、変えられる物理条件 (params) を取る
  2. 初期データ: ランダム操作で seedSteps ステップ集め、状態の正規化を決める
  3. 学習: 各ステップで操作を選び (TD-MPC2 は MPPI で計画)、遷移を貯めて更新する
     物理条件は randomize の範囲からエピソードごとに引く
  4. evalEvery ごとに学習条件で評価 (固定の乱数・固定の条件なので方式間で比べられる)
  5. 最後に「学習条件」と「学習に使っていない条件 (holdouts)」で評価し、
     成功率の低下・危険な終了・1手の計算時間 (p50/p95/p99) を記録する

経験ログ:
  すべての遷移を outputDir/transitions/*.ndjson に書く。ジョブ終了後に Node 側が
  DuckDB の強化学習用テーブルに取り込む (🎬 経験ログ / 🔍 SQLクエリ で見られる)。

使い方:
  python system/sim/sim_rl_runner.py <config.json>
    mode=train : { name, algo, simUrls[], totalSteps, seed, randomize{}, holdouts[], outputDir, ... }
    mode=eval  : { modelDir, simUrls[]?, episodes?, conditions[]? }

標準出力の最後に RESULT_JSON:<json> 行を出す (Node.js が結果を拾う)。
"""
import argparse
import json
import math
import os
import random
import re
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sim_http import SimClient, SimError  # noqa: E402

EVAL_SEED_BASE = 1_000_000   # 評価用の乱数 (学習用とは重ならない範囲)


def log(msg):
    print(msg, flush=True)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def percentile(xs, p):
    if not xs:
        return None
    s = sorted(xs)
    k = (len(s) - 1) * p / 100.0
    f, c = math.floor(k), math.ceil(k)
    if f == c:
        return s[int(k)]
    return s[f] + (s[c] - s[f]) * (k - f)


def rnd(v, n=4):
    return None if v is None else round(float(v), n)


# ════════════════════════════════════════════════════════════════════
# 列名 (DuckDB に入れる時の名前)
# ════════════════════════════════════════════════════════════════════

def col_names(prefix, names):
    """シミュレータ側の名前を DDL で安全な列名にする (s_q1, a_lever1, p_lag, r_progress)。"""
    out, seen = [], set()
    for n in names:
        base = prefix + re.sub(r'[^A-Za-z0-9_]', '_', str(n))[:56]
        c, i = base, 2
        while c.lower() in seen:
            c = f'{base}_{i}'
            i += 1
        seen.add(c.lower())
        out.append(c)
    return out


class TransitionLogger:
    """1エピソード = 1ファイル (書き終えてから rename) で NDJSON を書く。

    ジョブが途中で止められても、書き終えたエピソードは欠けずに取り込める。
    """

    def __init__(self, out_dir, info, model_name, enabled=True):
        self.enabled = enabled
        self.dir = os.path.join(out_dir, 'transitions')
        if enabled:
            os.makedirs(self.dir, exist_ok=True)
        self.model = model_name
        self.sim = info['name']
        self.s_cols = col_names('s_', info['stateNames'])
        self.a_cols = col_names('a_', info['actionNames'])
        self.p_names = list(info['params'].keys())
        self.p_cols = col_names('p_', self.p_names)
        self.r_names = list(info.get('rewardTerms') or [])
        self.r_cols = col_names('r_', self.r_names)
        self.count = 0

    def schema(self):
        cols = {'episode': 'VARCHAR', 'step': 'BIGINT', 'recorded_at': 'TIMESTAMP',
                'source': 'VARCHAR', 'model': 'VARCHAR', 'sim': 'VARCHAR', 'seed': 'BIGINT',
                'sim_time': 'DOUBLE'}
        for c in self.s_cols + self.a_cols:
            cols[c] = 'DOUBLE'
        cols['reward'] = 'DOUBLE'
        for c in self.r_cols:
            cols[c] = 'DOUBLE'
        cols.update({'done': 'BOOLEAN', 'terminated': 'BOOLEAN', 'truncated': 'BOOLEAN',
                     'end_reason': 'VARCHAR', 'success': 'BOOLEAN'})
        for c in self.p_cols:
            cols[c] = 'DOUBLE'
        cols.update({'uncertainty': 'DOUBLE', 'plan_ms': 'DOUBLE'})
        return cols

    def row(self, slot, step_i, obs, a_sim, res, act_info, plan_ms):
        r = {'episode': slot.ep_id, 'step': step_i, 'recorded_at': now_iso(),
             'source': slot.source, 'model': self.model, 'sim': self.sim, 'seed': slot.seed,
             'sim_time': slot.sim_time}   # この状態を観測した時刻 (操作と同じ時刻にそろえる)
        for c, v in zip(self.s_cols, obs):
            r[c] = v
        for c, v in zip(self.a_cols, a_sim):
            r[c] = v
        r['reward'] = res['reward']
        for c, n in zip(self.r_cols, self.r_names):
            r[c] = res['rewardTerms'].get(n)
        ended = res['terminated'] or res['truncated'] or slot.forced_end
        r['done'] = bool(ended)
        r['terminated'] = bool(res['terminated'])
        r['truncated'] = bool(res['truncated'] or (slot.forced_end and not res['terminated']))
        r['end_reason'] = slot.end_reason if ended else None
        r['success'] = bool(res['success'])
        for c, n in zip(self.p_cols, self.p_names):
            v = slot.params_full.get(n)
            r[c] = float(v) if isinstance(v, (int, float)) else None
        r['uncertainty'] = act_info.get('uncertainty') if act_info else None
        r['plan_ms'] = plan_ms
        return r

    def write_episode(self, slot):
        if not self.enabled or not slot.rows:
            return
        fn = os.path.join(self.dir, f'{slot.ep_id}.ndjson')
        tmp = fn + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            for r in slot.rows:
                f.write(json.dumps(r, ensure_ascii=False) + '\n')
        os.replace(tmp, fn)
        self.count += len(slot.rows)


# ════════════════════════════════════════════════════════════════════
# 物理条件のサンプリング
# ════════════════════════════════════════════════════════════════════

def sanitize_params(p, info):
    out = {}
    for k, v in (p or {}).items():
        if k in info['params'] and isinstance(v, (int, float)) and math.isfinite(float(v)):
            out[k] = float(v)
    return out


def params_full(p, info):
    """ログ用: 指定していない条件はシミュレータの既定値で埋める。"""
    full = {k: d.get('default') for k, d in info['params'].items()}
    full.update(p)
    return full


def sample_params(randomize, info, rng):
    out = {}
    for k, rng_def in (randomize or {}).items():
        if k not in info['params']:
            continue
        if isinstance(rng_def, (list, tuple)) and len(rng_def) == 2:
            lo, hi = float(rng_def[0]), float(rng_def[1])
            out[k] = rng.uniform(min(lo, hi), max(lo, hi))
        elif isinstance(rng_def, (int, float)):
            out[k] = float(rng_def)
    return out


def in_dist_condition(cfg, info):
    return {'label': '学習条件', 'kind': 'train', 'randomize': cfg.get('randomize') or {}}


def condition_episodes(cond, n, info, cond_i):
    """評価の条件ごとに (seed, params) を決める。方式が違っても同じ並びになる。"""
    rng = random.Random(EVAL_SEED_BASE + 7919 * cond_i)
    eps = []
    for k in range(n):
        seed = EVAL_SEED_BASE + cond_i * 10_000 + k
        if cond.get('params') is not None:
            p = sanitize_params(cond['params'], info)
        else:
            p = sample_params(cond.get('randomize'), info, rng)
        eps.append((seed, p))
    return eps


# ════════════════════════════════════════════════════════════════════
# 環境スロット (1 URL = 1 環境) と同期実行
# ════════════════════════════════════════════════════════════════════

class Slot:
    def __init__(self, i, client):
        self.i = i
        self.client = client
        self.active = False

    def begin(self, obs, seed, params, pfull, source, ep_id, sim_time=None):
        self.obs = obs
        self.sim_time = sim_time
        self.seed = seed
        self.params = params
        self.params_full = pfull
        self.source = source
        self.ep_id = ep_id
        self.t = 0
        self.ret = 0.0
        self.rows = []
        self.tr_obs, self.tr_act, self.tr_rew, self.tr_next, self.tr_term = [], [], [], [], []
        self.end_reason = None
        self.forced_end = False
        self.success = False
        self.active = True


class Driver:
    """全環境を同じ周期で進める。行動は環境ごとに順に選び (計算時間を個別に測るため)、
    シミュレータの step は並列に投げる (シミュレータ側の待ち時間を重ねる)。"""

    def __init__(self, clients, info, act_low, act_high, ep_len, logger):
        import numpy as np
        self.np = np
        self.slots = [Slot(i, c) for i, c in enumerate(clients)]
        self.info = info
        self.low = np.asarray(act_low, np.float32)
        self.high = np.asarray(act_high, np.float32)
        self.ep_len = ep_len
        self.logger = logger
        self.pool = ThreadPoolExecutor(max_workers=max(1, len(clients))) if len(clients) > 1 else None
        self.step_ms = []

    def to_sim(self, a):
        a = self.np.clip(a, -1.0, 1.0)
        return (self.low + (a + 1.0) * 0.5 * (self.high - self.low)).tolist()

    def _start(self, slot, ep):
        if ep is None:
            slot.active = False
            return False
        seed, params, source, ep_id = ep
        obs, r_info = slot.client.reset(seed=seed, params=params)
        slot.begin(obs, seed, params, params_full(params, self.info), source, ep_id,
                   sim_time=r_info.get('simTime'))
        return True

    def _step_all(self, pairs):
        def one(sa):
            s, a_sim = sa
            t0 = time.perf_counter()
            r = s.client.step(a_sim)
            return r, (time.perf_counter() - t0) * 1000
        if self.pool is None:
            return [one(p) for p in pairs]
        return list(self.pool.map(one, pairs))

    def run(self, next_episode, choose, on_step=None, on_episode_end=None, stop=None):
        """next_episode(slot) → (seed, params, source, ep_id) か None (この環境は休む)。
        choose(slot) → (a_norm, act_info, plan_ms)。on_step(n_transitions) は学習更新用。"""
        np = self.np
        for s in self.slots:
            self._start(s, next_episode(s))
        while any(s.active for s in self.slots):
            if stop is not None and stop():
                break
            active = [s for s in self.slots if s.active]
            chosen = [choose(s) for s in active]
            pairs = [(s, self.to_sim(c[0])) for s, c in zip(active, chosen)]
            results = self._step_all(pairs)
            for s, (a, a_info, plan_ms), (_, a_sim), (res, ms) in zip(active, chosen, pairs, results):
                self.step_ms.append(ms)
                s.t += 1
                s.ret += res['reward']
                ended = res['terminated'] or res['truncated']
                if not ended and s.t >= self.ep_len:
                    s.forced_end = True
                    ended = True
                if ended:
                    s.end_reason = res['endReason'] or ('success' if res['success'] else
                                                        ('timeout' if not res['terminated'] else 'terminated'))
                    s.success = res['success']
                s.tr_obs.append(s.obs)
                s.tr_act.append(np.asarray(a, np.float32))
                s.tr_rew.append(res['reward'])
                s.tr_next.append(res['state'])
                s.tr_term.append(1.0 if res['terminated'] else 0.0)
                if self.logger is not None:
                    s.rows.append(self.logger.row(s, s.t - 1, s.obs, a_sim, res, a_info, plan_ms))
                s.obs = res['state']
                s.sim_time = res['info'].get('simTime')
                if ended:
                    if on_episode_end is not None:
                        on_episode_end(s)
                    if self.logger is not None:
                        self.logger.write_episode(s)
                    self._start(s, next_episode(s))
            if on_step is not None:
                on_step(len(active))

    def close(self):
        if self.pool is not None:
            self.pool.shutdown(wait=False)
        for s in self.slots:
            s.client.close()


# ════════════════════════════════════════════════════════════════════
# 評価
# ════════════════════════════════════════════════════════════════════

def evaluate_conditions(driver, agent, conditions, episodes, info, tag, sync):
    """各条件で episodes 本ずつ回し、成功率・収益・終了理由・計算時間を集計する。"""
    unsafe = set(info.get('unsafeReasons') or [])
    results = []
    all_plan_ms, all_unc = [], []
    for ci, cond in enumerate(conditions):
        queue = [(seed, p) for seed, p in condition_episodes(cond, episodes, info, ci)]
        eps_out = []
        k = {'i': 0}

        def next_ep(slot):
            if k['i'] >= len(queue):
                return None
            seed, p = queue[k['i']]
            k['i'] += 1
            agent.reset_env(slot.i)
            return (seed, p, f'eval:{cond["label"]}', f'{tag}_c{ci}_e{k["i"]:04d}')

        def choose(slot):
            sync()
            t0 = time.perf_counter()
            a, a_info = agent.act(slot.obs, env_i=slot.i, eval_mode=True)
            sync()
            ms = (time.perf_counter() - t0) * 1000
            all_plan_ms.append(ms)
            if a_info.get('uncertainty') is not None:
                all_unc.append(a_info['uncertainty'])
            return a, a_info, ms

        def on_end(slot):
            eps_out.append({'return': slot.ret, 'length': slot.t, 'success': slot.success,
                            'endReason': slot.end_reason})

        driver.run(next_ep, choose, on_episode_end=on_end)
        n = len(eps_out)
        rets = [e['return'] for e in eps_out]
        reasons = {}
        for e in eps_out:
            reasons[e['endReason']] = reasons.get(e['endReason'], 0) + 1
        mean_r = sum(rets) / n if n else None
        results.append({
            'label': cond['label'], 'kind': cond.get('kind', 'holdout'),
            'params': cond.get('params'), 'randomize': cond.get('randomize'),
            'episodes': n,
            'successRate': rnd(100.0 * sum(e['success'] for e in eps_out) / n, 1) if n else None,
            'unsafeRate': rnd(100.0 * sum(e['endReason'] in unsafe for e in eps_out) / n, 1) if n else None,
            'meanReturn': rnd(mean_r, 3),
            'stdReturn': rnd(math.sqrt(sum((r - mean_r) ** 2 for r in rets) / n), 3) if n else None,
            'meanLength': rnd(sum(e['length'] for e in eps_out) / n, 1) if n else None,
            'endReasons': reasons,
        })
        log(f"  [{cond['label']}] 成功率 {results[-1]['successRate']}% · 収益 {results[-1]['meanReturn']}"
            f" · 危険終了 {results[-1]['unsafeRate']}% · {reasons}")
    latency = {
        'n': len(all_plan_ms),
        'p50': rnd(percentile(all_plan_ms, 50), 2), 'p95': rnd(percentile(all_plan_ms, 95), 2),
        'p99': rnd(percentile(all_plan_ms, 99), 2), 'max': rnd(max(all_plan_ms), 2) if all_plan_ms else None,
        'mean': rnd(sum(all_plan_ms) / len(all_plan_ms), 2) if all_plan_ms else None,
    }
    unc = {'mean': rnd(sum(all_unc) / len(all_unc), 5) if all_unc else None,
           'p95': rnd(percentile(all_unc, 95), 5)}
    return results, latency, unc


def judge(final, budget_ms):
    """資料の合格基準に沿った判定材料を並べる (最終判断は人が行う)。"""
    conds = final['conditions']
    train = next((c for c in conds if c['kind'] == 'train'), None)
    holds = [c for c in conds if c['kind'] != 'train']
    drops = []
    if train and train['successRate'] is not None:
        for h in holds:
            if h['successRate'] is not None:
                drops.append({'label': h['label'], 'dropPts': rnd(train['successRate'] - h['successRate'], 1)})
    p99 = final['latency'].get('p99')
    return {
        'latencyBudgetMs': budget_ms,
        'latencyOk': (p99 is not None and p99 <= budget_ms),
        'holdoutDrops': drops,
        'maxHoldoutDropPts': max((d['dropPts'] for d in drops), default=None),
    }


# ════════════════════════════════════════════════════════════════════
# 学習
# ════════════════════════════════════════════════════════════════════

def connect(urls, timeout):
    if not urls:
        raise RuntimeError('simUrls が空です')
    clients = [SimClient(u, timeout=timeout) for u in urls]
    infos = [c.info() for c in clients]
    base = infos[0]
    for u, inf in zip(urls[1:], infos[1:]):
        if inf['stateNames'] != base['stateNames'] or inf['actionNames'] != base['actionNames']:
            raise RuntimeError(f'{u} の状態/行動の定義が {urls[0]} と一致しません')
    return clients, base


def build_conditions(cfg, info):
    conds = [in_dist_condition(cfg, info)]
    for h in cfg.get('holdouts') or []:
        if not isinstance(h, dict) or not isinstance(h.get('params'), dict):
            continue
        conds.append({'label': str(h.get('label') or f'未知条件{len(conds)}'), 'kind': 'holdout',
                      'params': sanitize_params(h['params'], info)})
    return conds


def train(cfg):
    import numpy as np
    import torch
    import sim_rl_common as C

    seed = int(cfg.get('seed', 0))
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    device = 'cuda' if torch.cuda.is_available() and not cfg.get('cpu') else 'cpu'
    sync = (lambda: torch.cuda.synchronize()) if device == 'cuda' else (lambda: None)
    algo = cfg.get('algo', 'tdmpc2')
    out_dir = cfg['outputDir']
    os.makedirs(out_dir, exist_ok=True)

    log(f"=== シミュレータ接続学習 ({C.ALGOS[algo]['label']}) ===")
    log(f"モデル名: {cfg['name']}  device: {device}  seed: {seed}")
    clients, info = connect(cfg['simUrls'], float(cfg.get('timeoutSec', 30)))
    log(f"シミュレータ: {info['name']}  環境数: {len(clients)}  状態 {len(info['stateNames'])} 次元 · "
        f"行動 {len(info['actionNames'])} 次元")
    ep_len = int(cfg.get('maxSteps') or info.get('maxSteps') or 1000)
    total_steps = int(cfg.get('totalSteps', 100_000))
    seed_steps = int(cfg.get('seedSteps') or max(1000, 5 * ep_len))
    seed_steps = min(seed_steps, max(total_steps // 2, 1))
    eval_every = int(cfg.get('evalEvery') or max(total_steps // 10, ep_len))
    eval_eps = int(cfg.get('evalEpisodes', 10))
    final_eps = int(cfg.get('finalEvalEpisodes', max(eval_eps, 20)))
    utd = float(cfg.get('updatesPerStep', 1.0))
    budget_ms = float(cfg.get('latencyBudgetMs', 100))
    conditions = build_conditions(cfg, info)
    randomize = cfg.get('randomize') or {}
    log(f"試行数 {total_steps} (初期データ {seed_steps}) · エピソード上限 {ep_len} · 評価 {eval_every} ごと")
    if randomize:
        log(f"物理条件のランダム化: {json.dumps(randomize, ensure_ascii=False)}")
    for c in conditions[1:]:
        log(f"未知条件 (学習に使わない): {c['label']} {json.dumps(c['params'], ensure_ascii=False)}")

    obs_dim, act_dim = len(info['stateNames']), len(info['actionNames'])
    agent = C.make_agent(algo, obs_dim, act_dim, cfg, device, ep_len)
    n_params = agent.n_params()
    log(f"パラメータ数: {n_params:,}")
    buf = C.EpisodeBuffer(total_steps + len(clients) * ep_len + 1, obs_dim, act_dim)
    logger = TransitionLogger(out_dir, info, cfg['name'], enabled=cfg.get('logTransitions', True))
    driver = Driver(clients, info, info['actionLow'], info['actionHigh'], ep_len, logger)
    rng = random.Random(seed)

    st = {'total': 0, 'episodes': 0, 'pretrained': False, 'updates': 0, 'upd_acc': 0.0,
          'last_ckpt': 0, 'last_metrics_t': 0.0, 'next_eval': eval_every}
    metrics = {
        'status': 'running', 'algo': algo, 'algoLabel': C.ALGOS[algo]['label'], 'sim': info['name'],
        'nEnvs': len(clients), 'seed': seed, 'device': device, 'nParams': n_params,
        'totalSteps': total_steps, 'seedSteps': seed_steps, 'epLen': ep_len,
        'hyper': getattr(agent, 'c', {}),
        'envSteps': 0, 'episodes': 0, 'updates': 0,
        'trainEpisodes': [], 'lossHistory': [], 'evalHistory': [],
        'finalEval': None, 'startedAt': time.time(),
    }
    t_start = time.time()

    def save_config():
        conf = {
            'name': cfg['name'], 'algo': algo, 'sim': info, 'simUrls': cfg['simUrls'],
            'hyper': getattr(agent, 'c', {}), 'obsNorm': agent.norm.state_dict(),
            'epLen': ep_len, 'seed': seed, 'totalSteps': total_steps, 'seedSteps': seed_steps,
            'randomize': randomize, 'holdouts': cfg.get('holdouts') or [],
            'latencyBudgetMs': budget_ms, 'logTable': cfg.get('logTable'),
            'logSchema': logger.schema(), 'trainedAt': int(time.time() * 1000),
        }
        with open(os.path.join(out_dir, 'config.json'), 'w', encoding='utf-8') as f:
            json.dump(conf, f, ensure_ascii=False, indent=2)

    def save_ckpt():
        torch.save(agent.state_dict(), os.path.join(out_dir, 'model.pt.tmp'))
        os.replace(os.path.join(out_dir, 'model.pt.tmp'), os.path.join(out_dir, 'model.pt'))
        save_config()

    def save_metrics(force=False):
        if not force and time.time() - st['last_metrics_t'] < 5:
            return
        st['last_metrics_t'] = time.time()
        metrics.update({'envSteps': st['total'], 'episodes': st['episodes'], 'updates': st['updates'],
                        'elapsedSec': round(time.time() - t_start, 1),
                        'bufferSize': len(buf)})
        tmp = os.path.join(out_dir, 'metrics.json.tmp')
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(metrics, f, ensure_ascii=False)
        os.replace(tmp, os.path.join(out_dir, 'metrics.json'))

    def next_train_ep(slot):
        if st['total'] >= total_steps or (st['pretrained'] and st['total'] >= st['next_eval']):
            return None   # 評価の区切り or 終了: この環境は今のエピソードで止める
        agent.reset_env(slot.i)
        ep_seed = rng.randrange(0, EVAL_SEED_BASE)
        params = sample_params(randomize, info, rng)
        st['episodes'] += 1
        return (ep_seed, params, 'train', f'train_{st["episodes"]:06d}_env{slot.i}')

    def choose(slot):
        if not st['pretrained']:
            return np.random.uniform(-1, 1, act_dim).astype(np.float32), {}, None
        t0 = time.perf_counter()
        a, a_info = agent.act(slot.obs, env_i=slot.i, eval_mode=False)
        return a, a_info, round((time.perf_counter() - t0) * 1000, 3)

    def on_episode_end(slot):
        buf.add_episode(np.asarray(slot.tr_obs, np.float32), np.asarray(slot.tr_act, np.float32),
                        np.asarray(slot.tr_rew, np.float32), np.asarray(slot.tr_next, np.float32),
                        np.asarray(slot.tr_term, np.float32))
        metrics['trainEpisodes'].append({'step': st['total'], 'return': rnd(slot.ret, 3), 'length': slot.t,
                                         'success': slot.success, 'endReason': slot.end_reason})
        if len(metrics['trainEpisodes']) > 3000:
            metrics['trainEpisodes'] = metrics['trainEpisodes'][::2]
        n_ep = len(metrics['trainEpisodes'])
        if n_ep % 10 == 0:
            recent = metrics['trainEpisodes'][-10:]
            log(f"  step {st['total']:>8} · ep {st['episodes']} · 直近10本の収益 "
                f"{sum(e['return'] for e in recent) / 10:.2f} · 成功 {sum(e['success'] for e in recent)}/10")

    def on_step(n):
        st['total'] += n
        if not st['pretrained']:
            if st['total'] >= seed_steps and len(buf) > 0:
                agent.norm.fit(buf.obs[:len(buf)])
                n_pre = agent.pretrain_updates(seed_steps)
                log(f"\n[初期データ {len(buf)} 遷移 → 状態の正規化を固定し、事前学習 {n_pre} 回]")
                t0 = time.time()
                last = None
                if hasattr(agent, 'pretrain'):
                    last = agent.pretrain(buf, n_pre)
                else:
                    for k in range(n_pre):
                        last = agent.update(buf) or last
                        if (k + 1) % max(n_pre // 5, 1) == 0 and last:
                            log(f"  事前学習 {k + 1}/{n_pre}  loss={last.get('loss'):.4f}")
                st['updates'] += n_pre
                st['pretrained'] = True
                st['next_eval'] = max(st['next_eval'], st['total'])
                log(f"  事前学習 完了 ({time.time() - t0:.1f}秒)")
                if last:
                    metrics['lossHistory'].append({'step': st['total'], **{k: rnd(v, 5) for k, v in last.items()}})
            save_metrics()
            return
        st['upd_acc'] += n * utd
        last = None
        while st['upd_acc'] >= 1.0:
            st['upd_acc'] -= 1.0
            r = agent.update(buf)
            if r is not None:
                last = r
            st['updates'] += 1
        if last is not None and (st['updates'] % 50 == 0 or getattr(agent, 'algo', '') == 'pets'):
            metrics['lossHistory'].append({'step': st['total'], **{k: rnd(v, 5) for k, v in last.items()}})
            if len(metrics['lossHistory']) > 2000:
                metrics['lossHistory'] = metrics['lossHistory'][::2]
        if st['total'] - st['last_ckpt'] >= int(cfg.get('checkpointEvery', 20_000)):
            st['last_ckpt'] = st['total']
            save_ckpt()
        save_metrics()

    try:
        log("\n[初期データ収集: ランダム操作]")
        while st['total'] < total_steps:
            driver.run(next_train_ep, choose, on_step=on_step, on_episode_end=on_episode_end)
            if st['pretrained'] and (st['total'] >= st['next_eval'] or st['total'] >= total_steps):
                st['next_eval'] = st['total'] + eval_every
                if st['total'] < total_steps:
                    log(f"\n[評価 @ step {st['total']}] 学習条件で {eval_eps} 本")
                    res, lat, _ = evaluate_conditions(driver, agent, conditions[:1], eval_eps, info,
                                                      f'evalstep{st["total"]}', sync)
                    metrics['evalHistory'].append({'step': st['total'], 'successRate': res[0]['successRate'],
                                                   'meanReturn': res[0]['meanReturn'], 'p99Ms': lat['p99']})
                    save_metrics(force=True)

        save_ckpt()
        log(f"\n[最終評価] 条件 {len(conditions)} 種 × {final_eps} 本 (評価モード: 探索ノイズなし)")
        res, lat, unc = evaluate_conditions(driver, agent, conditions, final_eps, info, 'final', sync)
        final = {'at': int(time.time() * 1000), 'step': st['total'], 'episodes': final_eps,
                 'conditions': res, 'latency': lat, 'uncertainty': unc,
                 'simStepMs': {'p50': rnd(percentile(driver.step_ms, 50), 2),
                               'p99': rnd(percentile(driver.step_ms, 99), 2)}}
        final['criteria'] = judge(final, budget_ms)
        metrics['finalEval'] = final
        metrics['evalHistory'].append({'step': st['total'], 'successRate': res[0]['successRate'],
                                       'meanReturn': res[0]['meanReturn'], 'p99Ms': lat['p99']})
        log(f"  1手の計算時間: p50 {lat['p50']}ms · p99 {lat['p99']}ms (目標 {budget_ms:.0f}ms 以内 → "
            f"{'OK' if final['criteria']['latencyOk'] else '超過'})")
        if final['criteria']['maxHoldoutDropPts'] is not None:
            log(f"  未知条件での成功率の低下: 最大 {final['criteria']['maxHoldoutDropPts']} ポイント")
        metrics['status'] = 'completed'
        save_metrics(force=True)
    except BaseException:
        metrics['status'] = 'failed'
        try:
            if st['pretrained']:
                save_ckpt()
            save_metrics(force=True)
        except Exception:
            pass
        raise
    finally:
        driver.close()

    result = {
        'status': 'completed', 'algo': algo, 'device': device, 'envSteps': st['total'],
        'episodes': st['episodes'], 'nParams': n_params,
        'successRate': res[0]['successRate'], 'meanReturn': res[0]['meanReturn'],
        'latencyP99': lat['p99'], 'maxHoldoutDropPts': final['criteria']['maxHoldoutDropPts'],
        'transitions': logger.count, 'elapsedSec': round(time.time() - t_start, 1),
    }
    log("RESULT_JSON:" + json.dumps(result, ensure_ascii=False))


# ════════════════════════════════════════════════════════════════════
# 評価のみ (学習済みモデルを別の条件で試す)
# ════════════════════════════════════════════════════════════════════

def load_agent(model_dir, device):
    import torch
    import sim_rl_common as C
    with open(os.path.join(model_dir, 'config.json'), 'r', encoding='utf-8') as f:
        conf = json.load(f)
    info = conf['sim']
    agent = C.make_agent(conf['algo'], len(info['stateNames']), len(info['actionNames']),
                         {'hyper': conf.get('hyper'), 'seed': conf.get('seed', 0)}, device, conf['epLen'])
    agent.norm.load_state_dict(conf['obsNorm'])
    agent.load_state_dict(torch.load(os.path.join(model_dir, 'model.pt'), map_location=device,
                                     weights_only=False))
    return agent, conf


def evaluate(cfg):
    import torch
    device = 'cuda' if torch.cuda.is_available() and not cfg.get('cpu') else 'cpu'
    sync = (lambda: torch.cuda.synchronize()) if device == 'cuda' else (lambda: None)
    model_dir = cfg['modelDir']
    agent, conf = load_agent(model_dir, device)
    torch.manual_seed(int(cfg.get('seed', 0)))
    urls = cfg.get('simUrls') or conf['simUrls']
    log(f"=== 評価: {conf['name']} ({conf['algo']}) device={device} ===")
    clients, info = connect(urls, float(cfg.get('timeoutSec', 30)))
    if info['stateNames'] != conf['sim']['stateNames'] or info['actionNames'] != conf['sim']['actionNames']:
        raise RuntimeError('シミュレータの状態/行動の定義が学習時と一致しません')
    budget_ms = float(cfg.get('latencyBudgetMs') or conf.get('latencyBudgetMs', 100))
    conds_cfg = {'randomize': conf.get('randomize'), 'holdouts': cfg.get('holdouts', conf.get('holdouts'))}
    conditions = build_conditions(conds_cfg, info)
    episodes = int(cfg.get('episodes', 20))
    tag = f"evaljob{int(time.time())}"
    logger = TransitionLogger(model_dir, info, conf['name'], enabled=cfg.get('logTransitions', True))
    driver = Driver(clients, info, info['actionLow'], info['actionHigh'], conf['epLen'], logger)
    t0 = time.time()
    try:
        res, lat, unc = evaluate_conditions(driver, agent, conditions, episodes, info, tag, sync)
    finally:
        driver.close()
    ev = {'at': int(time.time() * 1000), 'episodes': episodes, 'conditions': res, 'latency': lat,
          'uncertainty': unc, 'device': device,
          'simStepMs': {'p50': rnd(percentile(driver.step_ms, 50), 2),
                        'p99': rnd(percentile(driver.step_ms, 99), 2)}}
    ev['criteria'] = judge(ev, budget_ms)
    mp = os.path.join(model_dir, 'metrics.json')
    try:
        with open(mp, 'r', encoding='utf-8') as f:
            metrics = json.load(f)
    except Exception:
        metrics = {}
    metrics.setdefault('evals', []).append(ev)
    metrics['evals'] = metrics['evals'][-20:]
    with open(mp + '.tmp', 'w', encoding='utf-8') as f:
        json.dump(metrics, f, ensure_ascii=False)
    os.replace(mp + '.tmp', mp)
    log(f"  1手の計算時間: p50 {lat['p50']}ms · p99 {lat['p99']}ms")
    log("RESULT_JSON:" + json.dumps({
        'status': 'completed', 'successRate': res[0]['successRate'], 'latencyP99': lat['p99'],
        'maxHoldoutDropPts': ev['criteria']['maxHoldoutDropPts'], 'transitions': logger.count,
        'elapsedSec': round(time.time() - t0, 1)}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('config_path')
    args = parser.parse_args()
    with open(args.config_path, 'r', encoding='utf-8') as f:
        cfg = json.load(f)
    try:
        try:
            import numpy  # noqa
            import torch  # noqa
        except ImportError as e:
            log(f"❌ ライブラリ不足: {e}")
            log("RESULT_JSON:" + json.dumps({'status': 'failed', 'error': f'missing library: {e}'}))
            sys.exit(2)
        if cfg.get('mode') == 'eval':
            evaluate(cfg)
        else:
            train(cfg)
        sys.exit(0)
    except SimError as e:
        log(f"\n❌ シミュレータとの通信エラー: {e}")
        log("RESULT_JSON:" + json.dumps({'status': 'failed', 'error': f'sim: {e}'}, ensure_ascii=False))
        sys.exit(1)
    except Exception as e:
        log(f"\n❌ エラー: {e}")
        log(traceback.format_exc())
        log("RESULT_JSON:" + json.dumps({'status': 'failed', 'error': str(e)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == '__main__':
    main()
