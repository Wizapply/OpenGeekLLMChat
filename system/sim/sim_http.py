#!/usr/bin/env python3
"""
sim_http.py — 外部シミュレータと HTTP でやり取りするクライアント (gym 風)

シミュレータ側が HTTP サーバーになり、学習ジョブ (sim_rl_runner.py) がクライアントとして
reset / step を呼ぶ。オンライン学習 (TD-MPC2 等) は「自分で操作して集めたデータ」で
学ぶので、ジョブ側が主導してシミュレータを進める形にしている。

────────────────────────────────────────────────────────────────────
プロトコル (JSON over HTTP。シミュレータ側が実装する)
────────────────────────────────────────────────────────────────────
GET  /info
  → {
      "name": "arm_reach",                       # シミュレータ名 (比較表のグループ化に使う)
      "stateNames":  ["q1", "q2", ...],          # 状態ベクトルの各要素の名前 (順序が意味を持つ)
      "actionNames": ["lever1", "lever2"],       # 行動ベクトルの各要素の名前
      "actionLow":   [-1, -1],                   # 行動の下限 (シミュレータ側の単位)
      "actionHigh":  [ 1,  1],                   # 行動の上限
      "dt": 0.1,                                 # 1ステップの秒数 (任意)
      "maxSteps": 150,                           # 1エピソードの上限ステップ (任意)
      "params": {                                # 変えられる物理条件 (任意)
        "lag": {"default": 0.15, "min": 0.02, "max": 0.5, "unit": "s", "description": "..."}
      },
      "rewardTerms": ["progress", "effort"],     # step が返す報酬内訳のキー (任意)
      "unsafeReasons": ["joint_limit", "overload"]  # 危険な終了理由 (任意。評価で数える)
    }

POST /reset   body: {"seed": 123, "params": {"lag": 0.3}}   # params は省略可 (既定値)
  → {"state": [...] | {"q1": ..}, "info": {"simTime": 0.0}}

POST /step    body: {"action": [0.2, -0.5]}                  # actionNames の順、シミュレータの単位
  → {
      "state": [...] | {...},
      "reward": 0.12,
      "done": false,          # 終端 (成功・失敗)。以降の価値を 0 として扱う
      "truncated": false,     # 時間切れ等の打ち切り (価値は 0 にしない)
      "endReason": null,      # 終了理由 ("success", "collision", ...)。done/truncated 時に入れる
      "success": false,       # 任意。endReason == "success" でも成功扱いになる
      "rewardTerms": {"progress": 0.1, "effort": -0.01},
      "info": {"simTime": 0.1}
    }

state は配列 (stateNames の順) でも、名前→値の辞書でもよい。
複数のシミュレータを同時に動かす時は、同じ /info を返すサーバーを別ポートで並べ、
URL を複数渡す (1 URL = 1 環境)。
"""
import http.client
import json
import math
import time
import urllib.parse


class SimError(RuntimeError):
    pass


def _finite_list(v, what):
    out = []
    for x in v:
        try:
            f = float(x)
        except (TypeError, ValueError):
            raise SimError(f'{what} に数値でない値があります: {x!r}')
        if not math.isfinite(f):
            raise SimError(f'{what} に NaN/Inf があります')
        out.append(f)
    return out


def normalize_info(info):
    """/info の応答を検証し、欠けている任意項目を埋める。"""
    if not isinstance(info, dict):
        raise SimError('/info の応答が JSON オブジェクトではありません')
    s_names = info.get('stateNames')
    a_names = info.get('actionNames')
    if not isinstance(s_names, list) or not s_names:
        raise SimError('/info に stateNames (配列) がありません')
    if not isinstance(a_names, list) or not a_names:
        raise SimError('/info に actionNames (配列) がありません')
    n_a = len(a_names)
    low = info.get('actionLow', [-1.0] * n_a)
    high = info.get('actionHigh', [1.0] * n_a)
    if len(low) != n_a or len(high) != n_a:
        raise SimError('actionLow / actionHigh の長さが actionNames と一致しません')
    low = _finite_list(low, 'actionLow')
    high = _finite_list(high, 'actionHigh')
    if any(h <= l for l, h in zip(low, high)):
        raise SimError('actionHigh は actionLow より大きくしてください')
    params = info.get('params') or {}
    if not isinstance(params, dict):
        raise SimError('params はオブジェクトで指定してください')
    norm_params = {}
    for k, p in params.items():
        if not isinstance(p, dict):
            p = {'default': p}
        norm_params[str(k)] = {
            'default': p.get('default'),
            'min': p.get('min'), 'max': p.get('max'),
            'unit': p.get('unit') or '',
            'description': p.get('description') or '',
        }
    max_steps = info.get('maxSteps')
    return {
        'name': str(info.get('name') or 'sim'),
        'stateNames': [str(s) for s in s_names],
        'actionNames': [str(a) for a in a_names],
        'actionLow': low, 'actionHigh': high,
        'dt': float(info['dt']) if info.get('dt') is not None else None,
        'maxSteps': int(max_steps) if max_steps else None,
        'params': norm_params,
        'rewardTerms': [str(t) for t in (info.get('rewardTerms') or [])],
        'unsafeReasons': [str(r) for r in (info.get('unsafeReasons') or [])],
    }


class SimClient:
    """1つのシミュレータ (1 URL) との接続。接続は keep-alive で使い回す。

    10Hz の制御周期では毎回 TCP を張り直すコストが無視できないので、
    http.client の持続接続を使い、切れたら張り直して1回だけ再送する。
    """

    def __init__(self, url, timeout=30.0, retries=2):
        u = urllib.parse.urlparse(url)
        if u.scheme not in ('http', 'https'):
            raise SimError(f'http(s) の URL を指定してください: {url}')
        self.url = url
        self.scheme = u.scheme
        self.host = u.hostname
        self.port = u.port or (443 if u.scheme == 'https' else 80)
        self.base = u.path.rstrip('/')
        self.timeout = float(timeout)
        self.retries = int(retries)
        self._conn = None
        self.info_ = None

    def _connect(self):
        cls = http.client.HTTPSConnection if self.scheme == 'https' else http.client.HTTPConnection
        self._conn = cls(self.host, self.port, timeout=self.timeout)

    def close(self):
        if self._conn is not None:
            try:
                self._conn.close()
            except Exception:
                pass
            self._conn = None

    def _request(self, method, path, body=None):
        payload = None if body is None else json.dumps(body).encode('utf-8')
        headers = {'Content-Type': 'application/json', 'Connection': 'keep-alive'}
        last_err = None
        for attempt in range(self.retries + 1):
            if self._conn is None:
                self._connect()
            try:
                self._conn.request(method, self.base + path, body=payload, headers=headers)
                resp = self._conn.getresponse()
                raw = resp.read()
                if resp.status >= 400:
                    msg = raw.decode('utf-8', 'replace')[:300]
                    raise SimError(f'{method} {path} → HTTP {resp.status}: {msg}')
                try:
                    return json.loads(raw.decode('utf-8'))
                except ValueError:
                    raise SimError(f'{method} {path} の応答が JSON ではありません')
            except SimError:
                raise
            except (OSError, http.client.HTTPException) as e:
                # 持続接続がサーバー側で切られていた等。張り直して再送する
                last_err = e
                self.close()
                if attempt < self.retries:
                    time.sleep(0.2 * (attempt + 1))
        raise SimError(f'{self.url}{path} に接続できません: {last_err}')

    # ─── プロトコル ───

    def info(self):
        self.info_ = normalize_info(self._request('GET', '/info'))
        return self.info_

    def _parse_state(self, st):
        names = self.info_['stateNames']
        if isinstance(st, dict):
            missing = [n for n in names if n not in st]
            if missing:
                raise SimError(f'state に {missing[:5]} がありません')
            vals = [st[n] for n in names]
        elif isinstance(st, list):
            if len(st) != len(names):
                raise SimError(f'state の長さ {len(st)} が stateNames ({len(names)}) と一致しません')
            vals = st
        else:
            raise SimError('state は配列か辞書で返してください')
        return _finite_list(vals, 'state')

    def reset(self, seed=None, params=None):
        if self.info_ is None:
            self.info()
        body = {}
        if seed is not None:
            body['seed'] = int(seed)
        if params:
            body['params'] = params
        r = self._request('POST', '/reset', body)
        if not isinstance(r, dict) or 'state' not in r:
            raise SimError('/reset の応答に state がありません')
        info = r.get('info') if isinstance(r.get('info'), dict) else {}
        return self._parse_state(r['state']), info

    def step(self, action):
        r = self._request('POST', '/step', {'action': [float(a) for a in action]})
        if not isinstance(r, dict) or 'state' not in r:
            raise SimError('/step の応答に state がありません')
        try:
            reward = float(r.get('reward', 0.0))
        except (TypeError, ValueError):
            raise SimError('reward が数値ではありません')
        if not math.isfinite(reward):
            raise SimError('reward が NaN/Inf です')
        terms = r.get('rewardTerms') if isinstance(r.get('rewardTerms'), dict) else {}
        end_reason = r.get('endReason')
        done = bool(r.get('done', False))
        truncated = bool(r.get('truncated', False))
        success = bool(r.get('success', False)) or end_reason == 'success'
        return {
            'state': self._parse_state(r['state']),
            'reward': reward,
            'terminated': done and not truncated,
            'truncated': truncated,
            'endReason': str(end_reason) if end_reason is not None else None,
            'success': success,
            'rewardTerms': {str(k): float(v) for k, v in terms.items()
                            if isinstance(v, (int, float)) and math.isfinite(float(v))},
            'info': r.get('info') if isinstance(r.get('info'), dict) else {},
        }


def probe(url, timeout=10.0):
    """URL に繋がるか・/info が正しいかを確かめる (UI の「接続確認」用)。"""
    c = SimClient(url, timeout=timeout, retries=0)
    try:
        t0 = time.time()
        info = c.info()
        return {'ok': True, 'info': info, 'latencyMs': round((time.time() - t0) * 1000, 1)}
    finally:
        c.close()


if __name__ == '__main__':
    import sys
    if len(sys.argv) < 2:
        print('usage: python3 system/sim/sim_http.py <sim_url>   # /info を取得して表示')
        sys.exit(1)
    print(json.dumps(probe(sys.argv[1]), ensure_ascii=False, indent=2))
