#!/usr/bin/env python3
"""
sim_rl_test.py — シミュレータ接続学習のスモークテスト (python3 system/sim/sim_rl_test.py)

GPU もシミュレータも不要。見本のシミュレータ (sim_dummy_server.py) をこのプロセス内で
立ち上げ、小さな設定の TD-MPC2 / PETS / SAC を数百ステップずつ通しで動かす。
学習の良し悪しではなく「接続 → 学習 → 評価 → 経験ログ」の配管が壊れていないかを見る。
"""
import json
import os
import shutil
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np  # noqa: E402
import torch  # noqa: E402

import sim_dummy_server as dummy  # noqa: E402
import sim_rl_common as C  # noqa: E402
import sim_rl_runner as R  # noqa: E402
from sim_http import SimClient, SimError, normalize_info  # noqa: E402

FAILS = []


def check(cond, msg):
    print(('  ✓ ' if cond else '  ✕ ') + msg)
    if not cond:
        FAILS.append(msg)


def test_buffer_padding():
    print('[バッファ: 終端のあとを吸収状態で埋める]')
    buf = C.EpisodeBuffer(100, 2, 1)
    T = 2   # 失敗で2ステップで終わったエピソード
    obs = np.arange(T * 2, dtype=np.float32).reshape(T, 2)
    buf.add_episode(obs, np.ones((T, 1), np.float32), np.array([1.0, 2.0], np.float32),
                    obs + 100, np.array([0.0, 1.0], np.float32))
    o, a, r, d = buf.sample_seq(4, 3, np.random.default_rng(0))
    check(o.shape == (4, 4, 2) and a.shape == (3, 4, 1), 'ホライズン3の系列の形')
    i = int(np.argmax(o[0, :, 0] == 0))   # 先頭から始まる系列
    check(r[:, i, 0].tolist() == [1.0, 2.0, 0.0], '終端のあとの報酬は0')
    check(d[:, i, 0].tolist() == [0.0, 1.0, 1.0], '終端のあとは終端フラグ=1')
    check(np.allclose(o[3, i], o[2, i]), '終端のあとの状態は最後の状態のまま')
    buf2 = C.EpisodeBuffer(100, 2, 1)
    buf2.add_episode(obs, np.ones((T, 1), np.float32), np.ones(T, np.float32), obs, np.zeros(T, np.float32))
    check(buf2.sample_seq(4, 3, np.random.default_rng(0)) is None, '打ち切り (時間切れ) の短いエピソードは系列に使わない')


def test_two_hot():
    print('[報酬・価値の two-hot 表現]')
    th = C.TwoHot(C.TDMPC2_DEFAULTS, 'cpu')
    x = torch.tensor([[-5.0], [0.0], [0.3], [12.5], [300.0]])
    y = th.decode(torch.log(th.encode(x) + 1e-12))
    check(torch.allclose(x, y, rtol=1e-3, atol=1e-3), f'エンコード→デコードで値が戻る {y.flatten().tolist()}')


def test_protocol():
    print('[HTTP プロトコルの検証]')
    try:
        normalize_info({'stateNames': ['a'], 'actionNames': ['u'], 'actionLow': [1], 'actionHigh': [0]})
        check(False, 'actionHigh <= actionLow を拒否')
    except SimError:
        check(True, 'actionHigh <= actionLow を拒否')
    inf = normalize_info({'stateNames': ['a'], 'actionNames': ['u'], 'params': {'k': 0.5}})
    check(inf['actionLow'] == [-1.0] and inf['params']['k']['default'] == 0.5, '省略した項目の補完')
    check(R.col_names('s_', ['x-1', 'x_1', 'q']) == ['s_x_1', 's_x_1_2', 's_q'], '列名の衝突を避ける')


def start_dummy(n):
    servers, urls = [], []
    for _ in range(n):
        srv = ThreadingHTTPServer(('127.0.0.1', 0), dummy.make_handler(dummy.ArmEnv()))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        servers.append(srv)
        urls.append(f'http://127.0.0.1:{srv.server_address[1]}')
    return servers, urls


def test_end_to_end():
    servers, urls = start_dummy(2)
    c = SimClient(urls[0])
    s0, _ = c.reset(seed=1, params={'lag': 0.3})
    st = c.step([0.5, -0.5])
    check(len(s0) == len(dummy.STATE_NAMES) and 'progress' in st['rewardTerms'], '見本のシミュレータに reset / step できる')
    c.close()

    small = {
        'tdmpc2': {'latent_dim': 64, 'mlp_dim': 64, 'enc_dim': 64, 'num_samples': 32, 'num_elites': 8,
                   'num_pi_trajs': 4, 'iterations': 2, 'batch_size': 32},
        'pets': {'hidden': 32, 'layers': 2, 'num_samples': 32, 'num_elites': 8, 'iterations': 2,
                 'train_every': 50, 'updates_per_round': 20, 'batch_size': 32},
        'sac': {'hidden': 32, 'batch_size': 32},
    }
    tmp = tempfile.mkdtemp(prefix='simrl_test_')
    try:
        for algo, hyper in small.items():
            print(f'[通し: {algo}]')
            out = os.path.join(tmp, algo)
            cfg = {'mode': 'train', 'name': f't_{algo}', 'algo': algo, 'simUrls': urls, 'outputDir': out,
                   'totalSteps': 400, 'seedSteps': 200, 'evalEvery': 150, 'evalEpisodes': 1,
                   'finalEvalEpisodes': 1, 'maxSteps': 40, 'cpu': True, 'hyper': hyper,
                   'randomize': {'lag': [0.05, 0.25]},
                   'holdouts': [{'label': 'hard', 'params': {'soil_hardness': 2.8}}]}
            R.train(cfg)
            m = json.load(open(os.path.join(out, 'metrics.json'), encoding='utf-8'))
            conf = json.load(open(os.path.join(out, 'config.json'), encoding='utf-8'))
            check(m['status'] == 'completed' and m['envSteps'] >= 400, f'{algo}: 学習が最後まで進む')
            fe = m['finalEval']
            check(len(fe['conditions']) == 2 and fe['conditions'][1]['label'] == 'hard', f'{algo}: 未知条件も評価される')
            check(fe['latency']['p99'] is not None and fe['criteria']['latencyOk'] in (True, False),
                  f'{algo}: 1手の計算時間を測る (p99 {fe["latency"]["p99"]}ms)')
            files = os.listdir(os.path.join(out, 'transitions'))
            rows = [json.loads(l) for f in files for l in open(os.path.join(out, 'transitions', f), encoding='utf-8')]
            schema = conf['logSchema']
            check(all(set(r) == set(schema) for r in rows), f'{algo}: 経験ログの列が定義どおり ({len(rows)}行)')
            check(any(r['source'] == 'eval:hard' for r in rows) and any(r['source'] == 'train' for r in rows),
                  f'{algo}: 学習と評価の遷移を source で分けられる')
            first = next(r for r in rows if r['step'] == 0)
            check(first['sim_time'] == 0.0, f'{algo}: sim_time は状態を観測した時刻 (1行目は 0)')
            # 学習済みモデルを読み込み直して評価だけ回す
            shutil.rmtree(os.path.join(out, 'transitions'))
            R.evaluate({'mode': 'eval', 'modelDir': out, 'episodes': 1, 'cpu': True})
            m2 = json.load(open(os.path.join(out, 'metrics.json'), encoding='utf-8'))
            check(len(m2.get('evals', [])) == 1, f'{algo}: 保存したモデルで評価し直せる')
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        for s in servers:
            s.shutdown()


if __name__ == '__main__':
    torch.set_num_threads(1)   # 小さなモデルなので1スレッドの方が速い (他の処理と CPU を取り合わない)
    test_buffer_padding()
    test_two_hot()
    test_protocol()
    test_end_to_end()
    print()
    if FAILS:
        print(f'✕ {len(FAILS)} 件失敗')
        sys.exit(1)
    print('✓ すべて通過')
