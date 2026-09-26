#!/usr/bin/env python3
"""
sim_dummy_server.py — シミュレータ接続 (sim_http.py のプロトコル) の参照実装

本物のシミュレータが無くても「接続 → 学習 → 比較 → 未知条件 → 実時間」を
一通り試せるよう、油圧の遅れ・レバーの遊び・土の抵抗を持つ 2関節アームの
到達タスクを標準ライブラリだけで実装している。シミュレータ側の開発者は、
このファイルを HTTP の受け口の見本として読めばよい (numpy も不要)。

タスク:
  アーム先端を目標点 (地面より下のこともある) へ運び、そこで止める。
  - レバー入力は遊び (deadband) を通ってから弁の指令になる
  - 弁は一次遅れ (lag 秒) で指令に追従し、弁開度が関節速度になる
  - 先端が地面 (y<0) に入ると、土の硬さと深さに応じて速度が落ち、接触力が出る
  - 関節の可動域を超える / 接触力が上限を超えると失敗 (危険な終了) で終わる
  - 目標の近くに 3 ステップ留まると成功で終わる

使い方:
  python3 system/sim/sim_dummy_server.py --port 18080              # 1環境
  python3 system/sim/sim_dummy_server.py --port 18080 --instances 4 # 18080〜18083 に4環境
"""
import argparse
import json
import math
import random
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DT = 0.1            # 制御周期 10Hz
SUBSTEPS = 10       # 物理の内部刻み
MAX_STEPS = 150
BASE = (0.0, 0.8)   # 旋回中心の高さ
L1, L2 = 2.0, 1.5   # リンク長
Q1_RANGE = (-0.3, 1.6)
Q2_RANGE = (-2.6, -0.2)
VMAX = 1.0          # 弁全開時の関節速度 [rad/s]
FORCE_LIMIT = 20.0  # 接触力の上限 (超えたら過負荷で失敗)
SUCCESS_TOL = 0.12
SUCCESS_HOLD = 3

PARAMS = {
    'lag': {'default': 0.15, 'min': 0.02, 'max': 0.5, 'unit': 's',
            'description': '弁 (油圧) が指令に追従するまでの時定数'},
    'deadband': {'default': 0.05, 'min': 0.0, 'max': 0.2, 'unit': '',
                 'description': 'レバーの遊び (この範囲の入力は効かない)'},
    'soil_hardness': {'default': 1.0, 'min': 0.0, 'max': 3.0, 'unit': '',
                      'description': '土の硬さ (地中での減速と接触力の大きさ)'},
    'mass_scale': {'default': 1.0, 'min': 0.5, 'max': 2.0, 'unit': 'x',
                   'description': '機体質量の倍率 (大きいほど速度が出ない)'},
    'sensor_noise': {'default': 0.0, 'min': 0.0, 'max': 0.05, 'unit': '',
                     'description': '状態に乗るセンサ雑音の標準偏差'},
}
STATE_NAMES = ['q1', 'q2', 'dq1', 'dq2', 'tip_x', 'tip_y', 'target_x', 'target_y',
               'valve1', 'valve2', 'contact_force']
ACTION_NAMES = ['lever1', 'lever2']
UNSAFE = ['joint_limit', 'overload']


def tip_of(q1, q2):
    x = BASE[0] + L1 * math.cos(q1) + L2 * math.cos(q1 + q2)
    y = BASE[1] + L1 * math.sin(q1) + L2 * math.sin(q1 + q2)
    return x, y


class ArmEnv:
    def __init__(self):
        self.lock = threading.Lock()
        self.reset(0, {})

    def reset(self, seed, params):
        self.rng = random.Random(seed)
        self.p = {k: float(v['default']) for k, v in PARAMS.items()}
        for k, v in (params or {}).items():
            if k in self.p:
                lo, hi = PARAMS[k]['min'], PARAMS[k]['max']
                self.p[k] = min(max(float(v), lo), hi)
        self.q = [0.9 + self.rng.uniform(-0.05, 0.05), -1.8 + self.rng.uniform(-0.05, 0.05)]
        self.dq = [0.0, 0.0]
        self.valve = [0.0, 0.0]
        self.target = (self.rng.uniform(2.0, 3.2), self.rng.uniform(-0.4, 0.3))
        self.force = 0.0
        self.t = 0
        self.hold = 0
        self.prev_u = [0.0, 0.0]
        self.prev_dist = self._dist()
        return self._state()

    def _dist(self):
        x, y = tip_of(*self.q)
        return math.hypot(x - self.target[0], y - self.target[1])

    def _state(self):
        x, y = tip_of(*self.q)
        s = [self.q[0], self.q[1], self.dq[0], self.dq[1], x, y,
             self.target[0], self.target[1], self.valve[0], self.valve[1], self.force]
        n = self.p['sensor_noise']
        if n > 0:
            s = [v + self.rng.gauss(0, n) for v in s[:6]] + s[6:8] + \
                [v + self.rng.gauss(0, n) for v in s[8:]]
        return s

    def step(self, action):
        u = [min(max(float(a), -1.0), 1.0) for a in action[:2]]
        db = self.p['deadband']
        cmd = [0.0 if abs(a) <= db else math.copysign((abs(a) - db) / (1 - db + 1e-9), a) for a in u]
        h = DT / SUBSTEPS
        alpha = min(1.0, h / max(self.p['lag'], 1e-3))
        vscale = VMAX / math.sqrt(self.p['mass_scale'])
        end_reason = None
        for _ in range(SUBSTEPS):
            for i in range(2):
                self.valve[i] += (cmd[i] - self.valve[i]) * alpha
            x, y = tip_of(*self.q)
            depth = max(0.0, -y)
            slow = 1.0 / (1.0 + 2.0 * self.p['soil_hardness'] * depth)
            self.dq = [self.valve[0] * vscale * slow, self.valve[1] * vscale * slow]
            speed = abs(self.dq[0]) * L1 + abs(self.dq[1]) * L2
            self.force = 10.0 * self.p['soil_hardness'] * depth * (1.0 + speed)
            self.q[0] += self.dq[0] * h
            self.q[1] += self.dq[1] * h
            if not (Q1_RANGE[0] <= self.q[0] <= Q1_RANGE[1]) or not (Q2_RANGE[0] <= self.q[1] <= Q2_RANGE[1]):
                self.q[0] = min(max(self.q[0], Q1_RANGE[0]), Q1_RANGE[1])
                self.q[1] = min(max(self.q[1], Q2_RANGE[0]), Q2_RANGE[1])
                end_reason = 'joint_limit'
                break
            if self.force > FORCE_LIMIT:
                end_reason = 'overload'
                break
        self.t += 1

        dist = self._dist()
        progress = 10.0 * (self.prev_dist - dist)
        effort = -0.01 * (u[0] ** 2 + u[1] ** 2)
        jerk = -0.02 * (abs(u[0] - self.prev_u[0]) + abs(u[1] - self.prev_u[1]))
        self.prev_dist = dist
        self.prev_u = u
        terms = {'progress': progress, 'effort': effort, 'smooth': jerk, 'bonus': 0.0, 'penalty': 0.0}

        done = False
        truncated = False
        if end_reason is not None:
            done = True
            terms['penalty'] = -10.0
        else:
            self.hold = self.hold + 1 if dist < SUCCESS_TOL else 0
            if self.hold >= SUCCESS_HOLD:
                done = True
                end_reason = 'success'
                terms['bonus'] = 10.0
            elif self.t >= MAX_STEPS:
                truncated = True
                end_reason = 'timeout'
        reward = sum(terms.values())
        return {
            'state': self._state(),
            'reward': reward,
            'done': done or truncated,
            'truncated': truncated,
            'endReason': end_reason,
            'success': end_reason == 'success',
            'rewardTerms': terms,
            'info': {'simTime': round(self.t * DT, 4), 'distance': dist},
        }


INFO = {
    'name': 'dummy_arm_reach',
    'stateNames': STATE_NAMES,
    'actionNames': ACTION_NAMES,
    'actionLow': [-1.0, -1.0],
    'actionHigh': [1.0, 1.0],
    'dt': DT,
    'maxSteps': MAX_STEPS,
    'params': PARAMS,
    'rewardTerms': ['progress', 'effort', 'smooth', 'bonus', 'penalty'],
    'unsafeReasons': UNSAFE,
}


def make_handler(env):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'   # keep-alive (制御周期ごとに TCP を張り直さない)

        def log_message(self, *args):
            pass

        def _send(self, code, obj):
            body = json.dumps(obj).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self):
            n = int(self.headers.get('Content-Length') or 0)
            if n <= 0:
                return {}
            return json.loads(self.rfile.read(n).decode('utf-8') or '{}')

        def do_GET(self):
            if self.path.rstrip('/') == '/info':
                return self._send(200, INFO)
            self._send(404, {'error': 'not found'})

        def do_POST(self):
            try:
                b = self._body()
            except ValueError:
                return self._send(400, {'error': 'invalid json'})
            path = self.path.rstrip('/')
            with env.lock:
                if path == '/reset':
                    st = env.reset(b.get('seed'), b.get('params') or {})
                    return self._send(200, {'state': st, 'info': {'simTime': 0.0, 'params': env.p}})
                if path == '/step':
                    a = b.get('action')
                    if not isinstance(a, list) or len(a) != 2:
                        return self._send(400, {'error': 'action は長さ2の配列'})
                    return self._send(200, env.step(a))
            self._send(404, {'error': 'not found'})
    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=18080)
    ap.add_argument('--instances', type=int, default=1, help='連続したポートに環境を並べる数')
    args = ap.parse_args()
    servers = []
    for i in range(max(1, args.instances)):
        srv = ThreadingHTTPServer((args.host, args.port + i), make_handler(ArmEnv()))
        servers.append(srv)
        print(f'dummy sim: http://{args.host}:{args.port + i}', flush=True)
    for srv in servers[1:]:
        threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
