#!/usr/bin/env python3
"""
rl_online_server.py — OpenGeekLLMChat リアルタイム/オンライン強化学習ワーカー

モデル・オプティマイザ・リプレイバッファをメモリ上に常駐させ、外部から
逐次的に経験 (state, action, reward[, next_state, done]) を受け取って
その場で 1 ステップ学習する (Online RL)。推論 (act) と学習 (learn) を分離。

Node.js (server.js) から localhost 上の HTTP で呼び出される常駐サーバー。
構造は transcribe-server.py に倣い、stdlib http.server のみで実装する
(Flask 不要・DuckDB 不要)。依存は torch + numpy のみ。

使い方:
    python3 rl_online_server.py [PORT]
デフォルトポート: 11600

環境変数:
    RL_MODELS_DIR    : エージェント保存先 (既定: <repo>/ml/rl_models)
    RL_ONLINE_DEVICE : cpu / cuda (既定: cpu。llama-server との VRAM 競合回避)

API (すべて JSON, localhost 内部用):
    GET  /health                  -> {status, agents, device}
    POST /load_offline {name}     -> オフライン学習済みエージェントをメモリへ (ウォームスタート)
    POST /create {name, spec}     -> スキーマ指定でゼロから新規エージェント
    POST /act {name, state, epsilon?}   -> {action, actionIndex, qValues, explored}
    POST /learn {name, state, action, reward, next_state?, done?}  (or {experiences:[...]})

視覚エージェント (V-JEPA 2 埋め込みを使うもの) の state:
    {"speed": 1.2, "_embedding": [...]}  ← 表の列に加えて埋め込みを配列で渡す
    埋め込みの生成はこのワーカーの外 (vjepa2_encode.py / 呼び出し側) で行う。
    生フレームを直接受け取る常駐エンコーダは Phase 3 で追加予定。
    POST /checkpoint {name}       -> model.pt / config.json / metrics.json を保存
    POST /status {name}           -> 学習状況
    POST /unload {name}           -> メモリから解放 (dirty なら checkpoint)
"""
import sys
import os
import json
import time
import math
import random
import signal
import logging
import threading
import collections
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rl_common import build_qnet, encode_state_dict, compute_loss

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 11600
RL_MODELS_DIR = os.environ.get(
    'RL_MODELS_DIR',
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ml', 'rl_models'),
)
DEVICE = os.environ.get('RL_ONLINE_DEVICE', 'cpu')

# 自動チェックポイント条件
CHECKPOINT_EVERY_STEPS = 500
CHECKPOINT_EVERY_SECONDS = 60
MAX_GRAD_STEPS_PER_CALL = 16   # 1回の /learn での最大勾配ステップ数 (レイテンシ上限)
VALID_ALGOS = ('dqn', 'ddqn', 'cql', 'bc')

logging.basicConfig(
    level=logging.INFO,
    format='[rl-online] %(asctime)s %(levelname)s: %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
)
log = logging.getLogger(__name__)

# 遅延 import (起動を軽く)
torch = None
nn = None
np = None


def _ensure_libs():
    global torch, nn, np
    if torch is None:
        import torch as _torch
        import torch.nn as _nn
        import numpy as _np
        torch, nn, np = _torch, _nn, _np


class Agent:
    """1エージェントのメモリ上状態 (Q網・オプティマイザ・リプレイバッファ・前処理メタ)。"""

    def __init__(self, name, meta, algo, mode, gamma, lr, hidden,
                 buffer_size, batch_size, target_update, cql_alpha,
                 state_dim, n_actions, action_labels):
        self.name = name
        self.meta = meta
        self.algo = algo if algo in VALID_ALGOS else 'dqn'
        self.mode = mode  # 'transition' | 'bandit'
        self.gamma = gamma if mode == 'transition' else 0.0
        self.lr = lr
        self.hidden = hidden
        self.batch_size = batch_size
        self.target_update = max(1, int(target_update))
        self.cql_alpha = cql_alpha
        self.state_dim = state_dim
        self.n_actions = n_actions
        self.action_labels = action_labels
        self.is_value = self.algo in ('dqn', 'ddqn', 'cql')
        # 視覚エージェント: 状態ベクトル末尾 emb_dim 次元は V-JEPA 2 埋め込み。
        # act/learn では state['_embedding'] で渡す (rl_common.encode_state_dict 参照)。
        self.emb_dim = int(meta.get('embDim') or 0)

        self.qnet = build_qnet(torch, nn, state_dim, n_actions, hidden, self.emb_dim).to(DEVICE)
        self.target = build_qnet(torch, nn, state_dim, n_actions, hidden, self.emb_dim).to(DEVICE)
        self.target.load_state_dict(self.qnet.state_dict())
        self.target.eval()
        self.optimizer = torch.optim.Adam(self.qnet.parameters(), lr=lr)

        self.buffer = collections.deque(maxlen=buffer_size)
        self.lock = threading.Lock()
        self.total_steps = 0
        self.learn_calls = 0
        self.loss_ema = None
        self.reward_ema = None
        self.dirty = False
        self.last_used = time.time()
        self.last_ckpt_step = 0
        self.last_ckpt_time = time.time()
        self.created_at = time.time()

    # --- 正規化の実行統計 (Welford) ---
    def _update_running(self, state):
        meta = self.meta
        cols = meta['stateColumns']
        meta['runningCount'] = int(meta.get('runningCount', 0)) + 1
        n = meta['runningCount']
        mean = meta['runningMean']
        m2 = meta['runningM2']
        for j, col in enumerate(cols):
            if meta['colTypes'].get(col) != 'numeric':
                continue  # カテゴリ列は index をそのまま通す (mean=0,M2=0 のまま)
            try:
                x = float(state.get(col))
            except (TypeError, ValueError):
                x = 0.0
            delta = x - mean[j]
            mean[j] += delta / n
            m2[j] += delta * (x - mean[j])

    def _action_index(self, action):
        a = str(action)
        if a not in self.action_labels:
            return None
        return self.action_labels.index(a)

    # --- 推論 ---
    def act(self, state, epsilon):
        with self.lock:
            self.last_used = time.time()
            vec = encode_state_dict(state, self.meta, np)
            self.qnet.eval()
            with torch.no_grad():
                q = self.qnet(torch.tensor(vec, device=DEVICE).unsqueeze(0))[0]
            qvals = {self.action_labels[k]: round(float(q[k].item()), 5)
                     for k in range(self.n_actions)}
            if epsilon and epsilon > 0 and random.random() < epsilon:
                idx = random.randrange(self.n_actions)
                explored = True
            else:
                idx = int(q.argmax().item())
                explored = False
            return {
                'action': self.action_labels[idx],
                'actionIndex': idx,
                'qValues': qvals,
                'explored': explored,
                'totalSteps': self.total_steps,
            }

    # --- 学習 (経験投入 + 勾配更新) ---
    def learn(self, experiences):
        with self.lock:
            self.last_used = time.time()
            ingested = 0
            errors = []
            for exp in experiences:
                state = exp.get('state')
                action = exp.get('action')
                reward = exp.get('reward')
                if not isinstance(state, dict):
                    errors.append('state は辞書で指定してください')
                    continue
                a_idx = self._action_index(action)
                if a_idx is None:
                    errors.append(f'未知の行動: {action}')
                    continue
                try:
                    r = float(reward)
                except (TypeError, ValueError):
                    errors.append('reward は数値で指定してください')
                    continue
                # 実行統計を更新してからエンコード
                self._update_running(state)
                s_vec = encode_state_dict(state, self.meta, np)
                next_state = exp.get('next_state')
                if isinstance(next_state, dict):
                    s2_vec = encode_state_dict(next_state, self.meta, np)
                else:
                    s2_vec = None
                done_raw = exp.get('done')
                if done_raw is None:
                    done = 0.0 if (self.mode == 'transition' and s2_vec is not None) else 1.0
                else:
                    done = 1.0 if str(done_raw).strip().lower() in (
                        '1', 'true', 'yes', 't', 'done') else 0.0
                self.buffer.append((s_vec, a_idx, r, s2_vec, done))
                self.reward_ema = r if self.reward_ema is None else (0.99 * self.reward_ema + 0.01 * r)
                ingested += 1

            # 勾配更新 (バッファが batch_size 以上たまってから)
            grad_steps = 0
            if len(self.buffer) >= self.batch_size:
                grad_steps = min(max(ingested, 1), MAX_GRAD_STEPS_PER_CALL)
                self.qnet.train()
                for _ in range(grad_steps):
                    loss_val = self._train_step()
                    self.total_steps += 1
                    self.loss_ema = loss_val if self.loss_ema is None else (
                        0.99 * self.loss_ema + 0.01 * loss_val)
                    if self.is_value and self.total_steps % self.target_update == 0:
                        self.target.load_state_dict(self.qnet.state_dict())

            self.learn_calls += 1
            if ingested > 0:
                self.dirty = True
            result = {
                'ingested': ingested,
                'gradSteps': grad_steps,
                'loss': (round(self.loss_ema, 6) if self.loss_ema is not None else None),
                'buffered': len(self.buffer) < self.batch_size,
                'bufferSize': len(self.buffer),
                'totalSteps': self.total_steps,
                'learnCalls': self.learn_calls,
                'rewardEMA': (round(self.reward_ema, 5) if self.reward_ema is not None else None),
            }
            if errors:
                result['warnings'] = errors[:10]
        # ロック外で自動チェックポイント判定
        self._maybe_checkpoint()
        return result

    def _train_step(self):
        batch = random.sample(self.buffer, self.batch_size)
        S = np.stack([b[0] for b in batch]).astype('float32')
        A = np.array([b[1] for b in batch], dtype='int64')
        R = np.array([b[2] for b in batch], dtype='float32')
        D = np.array([b[4] for b in batch], dtype='float32')
        if self.mode == 'transition':
            # next_state が None の遷移は終端扱い (done=1, S2 はダミー0)
            S2 = np.stack([(b[3] if b[3] is not None else np.zeros(self.state_dim, dtype='float32'))
                           for b in batch]).astype('float32')
            D = np.array([(1.0 if b[3] is None else b[4]) for b in batch], dtype='float32')
        else:
            S2 = np.zeros_like(S)

        St = torch.tensor(S, device=DEVICE)
        At = torch.tensor(A, dtype=torch.long, device=DEVICE).unsqueeze(1)
        Rt = torch.tensor(R, device=DEVICE).unsqueeze(1)
        S2t = torch.tensor(S2, device=DEVICE)
        Dt = torch.tensor(D, device=DEVICE).unsqueeze(1)

        loss = compute_loss(self.algo, self.mode, self.qnet, self.target, torch, nn,
                            St, At, Rt, S2t, Dt, self.gamma, self.cql_alpha)
        self.optimizer.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(self.qnet.parameters(), 10.0)
        self.optimizer.step()
        return float(loss.item())

    def _maybe_checkpoint(self):
        if not self.dirty:
            return
        if (self.total_steps - self.last_ckpt_step >= CHECKPOINT_EVERY_STEPS or
                time.time() - self.last_ckpt_time >= CHECKPOINT_EVERY_SECONDS):
            self.checkpoint()

    def checkpoint(self):
        with self.lock:
            out_dir = os.path.join(RL_MODELS_DIR, self.name)
            os.makedirs(out_dir, exist_ok=True)
            torch.save(self.qnet.state_dict(), os.path.join(out_dir, 'model.pt'))
            config = {
                'name': self.name,
                'env': 'online',
                'online': True,
                'algo': self.algo,
                'cqlAlpha': self.cql_alpha if self.algo == 'cql' else None,
                'datasetMode': self.mode,
                'tableName': None,
                'stateDim': self.state_dim,
                'embDim': self.emb_dim,
                'vjepa2': self.meta.get('vjepa2'),
                'nActions': self.n_actions,
                'actionLabels': self.action_labels,
                'hiddenSize': self.hidden,
                'gamma': self.gamma,
                'learningRate': self.lr,
                'batchSize': self.batch_size,
                'bufferSize': self.buffer.maxlen,
                'targetUpdate': self.target_update,
                'meta': self.meta,
                'trainedAt': time.time(),
            }
            with open(os.path.join(out_dir, 'config.json'), 'w', encoding='utf-8') as f:
                json.dump(config, f, indent=2, ensure_ascii=False)
            metrics = {
                'env': 'online',
                'online': True,
                'algo': self.algo,
                'datasetMode': self.mode,
                'totalSteps': self.total_steps,
                'learnCalls': self.learn_calls,
                'bufferSize': len(self.buffer),
                'lossEMA': (round(self.loss_ema, 6) if self.loss_ema is not None else None),
                'rewardEMA': (round(self.reward_ema, 5) if self.reward_ema is not None else None),
                'nActions': self.n_actions,
                'checkpointedAt': time.time(),
            }
            with open(os.path.join(out_dir, 'metrics.json'), 'w', encoding='utf-8') as f:
                json.dump(metrics, f, indent=2, ensure_ascii=False)
            self.dirty = False
            self.last_ckpt_step = self.total_steps
            self.last_ckpt_time = time.time()
            return {'ok': True, 'totalSteps': self.total_steps, 'savedAt': self.last_ckpt_time}

    def status(self):
        return {
            'name': self.name,
            'exists': True,
            'loaded': True,
            'online': True,
            'algo': self.algo,
            'mode': self.mode,
            'stateDim': self.state_dim,
            'embDim': self.emb_dim,
            'nActions': self.n_actions,
            'actionLabels': self.action_labels,
            'bufferSize': len(self.buffer),
            'totalSteps': self.total_steps,
            'learnCalls': self.learn_calls,
            'lossEMA': (round(self.loss_ema, 6) if self.loss_ema is not None else None),
            'rewardEMA': (round(self.reward_ema, 5) if self.reward_ema is not None else None),
            'dirty': self.dirty,
            'lastUsed': self.last_used,
            'device': DEVICE,
        }


# ---- レジストリ ----
AGENTS = {}
REGISTRY_LOCK = threading.Lock()


def _build_fresh_meta(spec):
    state_columns = []
    col_types = {}
    encoders = {}
    for c in spec.get('stateColumns', []):
        name = c['name']
        ctype = 'category' if c.get('type') == 'categorical' else 'numeric'
        state_columns.append(name)
        col_types[name] = ctype
        if ctype == 'category':
            vals = [str(v) for v in (c.get('values') or [])]
            encoders[name] = vals
    d = len(state_columns)
    return {
        'stateColumns': state_columns,
        'colTypes': col_types,
        'encoders': encoders,
        'actionColumn': None,
        'rewardColumn': None,
        'actionClasses': [str(a) for a in spec['actionLabels']],
        'hasNext': spec.get('mode') == 'transition',
        'doneColumn': None,
        # 視覚エージェント (V-JEPA 2 等の埋め込みを状態に連結する場合)
        'videoColumn': spec.get('videoColumn'),
        'nextVideoColumn': None,
        'embDim': max(0, int(spec.get('embDim') or 0)),
        'vjepa2': spec.get('vjepa2'),
        # オンライン実行統計 (Welford)。カテゴリ列は更新せず index を通す。
        # 埋め込み側には掛けないので、長さは表の列数 d のまま。
        'runningCount': 0,
        'runningMean': [0.0] * d,
        'runningM2': [0.0] * d,
    }


def create_agent(name, spec):
    state_cols = spec.get('stateColumns')
    labels = spec.get('actionLabels')
    emb_dim = max(0, int(spec.get('embDim') or 0))
    if not isinstance(state_cols, list) or (len(state_cols) == 0 and emb_dim == 0):
        raise ValueError('stateColumns を1つ以上指定してください (視覚のみの場合は embDim を指定)')
    if not isinstance(labels, list) or len(labels) < 2:
        raise ValueError('actionLabels は2つ以上指定してください')
    meta = _build_fresh_meta(spec)
    mode = 'transition' if spec.get('mode') == 'transition' else 'bandit'
    agent = Agent(
        name=name, meta=meta,
        algo=spec.get('algo', 'dqn'), mode=mode,
        gamma=float(spec.get('gamma', 0.99)),
        lr=float(spec.get('learningRate', 0.001)),
        hidden=int(spec.get('hiddenSize', 128)),
        buffer_size=int(spec.get('bufferSize', 50000)),
        batch_size=int(spec.get('batchSize', 64)),
        target_update=int(spec.get('targetUpdate', 200)),
        cql_alpha=float(spec.get('cqlAlpha', 0.5)),
        state_dim=len(meta['stateColumns']) + emb_dim,
        n_actions=len(meta['actionClasses']),
        action_labels=meta['actionClasses'],
    )
    with REGISTRY_LOCK:
        AGENTS[name] = agent
    # loadRlAgents が config.json + model.pt の両方を要求するため、初期重みを即保存
    agent.dirty = True
    agent.checkpoint()
    return agent


def _seed_running_from_scaler(meta, n_samples):
    """オフライン scaler を Welford 実行統計に変換して種付けする (ウォームスタート)。"""
    if 'scalerMean' not in meta or 'scalerScale' not in meta:
        return
    pseudo = max(int(n_samples or 0), 100)
    mean = list(meta['scalerMean'])
    scale = meta['scalerScale']
    m2 = [(float(s) ** 2) * (pseudo - 1) for s in scale]
    meta['runningCount'] = pseudo
    meta['runningMean'] = mean
    meta['runningM2'] = m2


def load_offline_agent(name):
    cfg_path = os.path.join(RL_MODELS_DIR, name, 'config.json')
    model_path = os.path.join(RL_MODELS_DIR, name, 'model.pt')
    if not os.path.exists(cfg_path) or not os.path.exists(model_path):
        raise FileNotFoundError(f'エージェント {name} が見つかりません')
    with open(cfg_path, 'r', encoding='utf-8') as f:
        cfg = json.load(f)
    meta = cfg['meta']
    # 連続行動 / 行動チャンキングは出力の意味が Q値ではないため、
    # このワーカーの act(argmax) / learn(経験再生) がそのままでは成立しない。
    # 誤った形のネットを黙って組み立てるより、明示的に断る。
    if (cfg.get('actionType') or meta.get('actionType') or 'discrete') != 'discrete':
        raise ValueError(
            f'エージェント {name} は連続行動 (BC回帰) のため、オンライン学習に未対応です '
            '(オフライン学習と /policy 推論は使えます)')
    if int(cfg.get('chunkSize') or meta.get('chunkSize') or 1) > 1:
        raise ValueError(
            f'エージェント {name} は行動チャンキング付きのため、オンライン学習に未対応です '
            '(オフライン学習と /policy 推論は使えます)')
    mode = cfg.get('datasetMode') or ('transition' if meta.get('hasNext') else 'bandit')
    # 既にオンライン実行統計があればそれを使い、なければ scaler から種付け
    if meta.get('runningMean') is None:
        # metrics.json から学習サンプル数を取得 (種付けの擬似カウント用)
        n_samples = 1000
        mpath = os.path.join(RL_MODELS_DIR, name, 'metrics.json')
        if os.path.exists(mpath):
            try:
                with open(mpath, 'r', encoding='utf-8') as f:
                    n_samples = json.load(f).get('nTransitions', 1000)
            except Exception:
                pass
        _seed_running_from_scaler(meta, n_samples)
    agent = Agent(
        name=name, meta=meta,
        algo=cfg.get('algo', 'dqn'), mode=mode,
        gamma=float(cfg.get('gamma', 0.99)),
        lr=float(cfg.get('learningRate', 0.001)),
        hidden=int(cfg.get('hiddenSize', 128)),
        buffer_size=int(cfg.get('bufferSize', 50000)),
        batch_size=int(cfg.get('batchSize', 64)),
        target_update=int(cfg.get('targetUpdate', 200)),
        cql_alpha=float(cfg.get('cqlAlpha') or 0.5),
        state_dim=cfg['stateDim'],
        n_actions=cfg['nActions'],
        action_labels=cfg.get('actionLabels') or [str(i) for i in range(cfg['nActions'])],
    )
    agent.qnet.load_state_dict(torch.load(model_path, map_location=DEVICE))
    agent.target.load_state_dict(agent.qnet.state_dict())
    with REGISTRY_LOCK:
        AGENTS[name] = agent
    return agent


def get_agent(name, auto_load=True):
    """メモリ上のエージェントを返す。未ロードならディスクから自動再水和。"""
    with REGISTRY_LOCK:
        if name in AGENTS:
            return AGENTS[name]
    if auto_load:
        cfg_path = os.path.join(RL_MODELS_DIR, name, 'config.json')
        model_path = os.path.join(RL_MODELS_DIR, name, 'model.pt')
        if os.path.exists(cfg_path) and os.path.exists(model_path):
            return load_offline_agent(name)
    return None


def checkpoint_all_dirty():
    with REGISTRY_LOCK:
        agents = list(AGENTS.values())
    for a in agents:
        if a.dirty:
            try:
                a.checkpoint()
            except Exception as e:
                log.error(f'checkpoint {a.name} 失敗: {e}')


# ---- バックグラウンドの定期チェックポイント ----
def _ckpt_sweeper():
    while True:
        time.sleep(30)
        try:
            checkpoint_all_dirty()
        except Exception as e:
            log.error(f'sweeper error: {e}')


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # アクセスログは抑制 (Node 側でログ)

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get('Content-Length', 0) or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode('utf-8'))

    def do_GET(self):
        if self.path == '/health':
            with REGISTRY_LOCK:
                names = list(AGENTS.keys())
            self._send(200, {'status': 'ok', 'agents': names, 'device': DEVICE})
        else:
            self._send(404, {'error': 'not found'})

    def do_POST(self):
        try:
            body = self._read_json()
        except Exception as e:
            self._send(400, {'error': f'JSON parse error: {e}'})
            return
        try:
            route = self.path
            if route == '/load_offline':
                name = body.get('name')
                agent = load_offline_agent(name)
                self._send(200, {'ok': True, 'name': name, 'warmStarted': True,
                                 'stateDim': agent.state_dim, 'nActions': agent.n_actions,
                                 'actionLabels': agent.action_labels, 'algo': agent.algo,
                                 'mode': agent.mode})
            elif route == '/create':
                name = body.get('name')
                spec = body.get('spec') or {}
                agent = create_agent(name, spec)
                self._send(200, {'ok': True, 'name': name, 'warmStarted': False,
                                 'stateDim': agent.state_dim, 'nActions': agent.n_actions,
                                 'actionLabels': agent.action_labels, 'algo': agent.algo,
                                 'mode': agent.mode})
            elif route == '/act':
                agent = get_agent(body.get('name'))
                if agent is None:
                    self._send(404, {'error': 'エージェントが見つかりません'})
                    return
                self._send(200, agent.act(body.get('state') or {}, body.get('epsilon')))
            elif route == '/learn':
                agent = get_agent(body.get('name'))
                if agent is None:
                    self._send(404, {'error': 'エージェントが見つかりません'})
                    return
                if isinstance(body.get('experiences'), list):
                    exps = body['experiences']
                else:
                    exps = [{
                        'state': body.get('state'),
                        'action': body.get('action'),
                        'reward': body.get('reward'),
                        'next_state': body.get('next_state'),
                        'done': body.get('done'),
                    }]
                self._send(200, agent.learn(exps))
            elif route == '/checkpoint':
                agent = get_agent(body.get('name'))
                if agent is None:
                    self._send(404, {'error': 'エージェントが見つかりません'})
                    return
                agent.dirty = True
                self._send(200, agent.checkpoint())
            elif route == '/status':
                agent = get_agent(body.get('name'))
                if agent is None:
                    name = body.get('name')
                    cfg_path = os.path.join(RL_MODELS_DIR, name or '', 'config.json')
                    self._send(200, {'name': name, 'exists': os.path.exists(cfg_path),
                                     'loaded': False, 'online': False})
                    return
                self._send(200, agent.status())
            elif route == '/unload':
                name = body.get('name')
                with REGISTRY_LOCK:
                    agent = AGENTS.pop(name, None)
                if agent and agent.dirty:
                    agent.checkpoint()
                self._send(200, {'ok': True, 'name': name})
            else:
                self._send(404, {'error': 'not found'})
        except FileNotFoundError as e:
            self._send(404, {'error': str(e)})
        except ValueError as e:
            self._send(400, {'error': str(e)})
        except Exception as e:
            import traceback
            log.error(f'handler error: {e}\n{traceback.format_exc()}')
            self._send(500, {'error': str(e)})


def _shutdown(signum, frame):
    log.info('シャットダウン: dirty なエージェントを保存します')
    checkpoint_all_dirty()
    os._exit(0)


def main():
    _ensure_libs()
    os.makedirs(RL_MODELS_DIR, exist_ok=True)
    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)
    threading.Thread(target=_ckpt_sweeper, daemon=True).start()
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    log.info(f'Online RL worker listening on 127.0.0.1:{PORT} (device={DEVICE}, models={RL_MODELS_DIR})')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        _shutdown(None, None)


if __name__ == '__main__':
    main()
