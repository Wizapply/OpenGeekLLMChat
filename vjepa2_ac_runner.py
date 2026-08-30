#!/usr/bin/env python3
"""
vjepa2_ac_runner.py — V-JEPA 2-AC (世界モデル) の学習・評価・計画 CLI

経験ログテーブル (episode / step / 観測 / 行動) から、
「今の潜在 z_t + 行動 a_t → 次の潜在 z_{t+1}」を予測する predictor を学習する。
エンコーダ (V-JEPA 2) は凍結のまま。predictor は潜在空間の残差MLP。

学習した世界モデルは CEM プランナーと組み合わせて、
「ゴール画像に近づく行動系列」をデモ無しで探索できる (vjepa2_server.py の /plan)。

使い方:
  python vjepa2_ac_runner.py <config.json>

config.json (mode 別):
  train : { "mode":"train", "name", "tableName", "dbPath", "outputDir",
            "videoColumn", "episodeColumn", "stepColumn",
            "actionType": "discrete"|"continuous",
            "actionColumn"?|"actionColumns"?[],
            "vjepa2"?{}, "vjepa2CacheDir"?, "videoBaseDir"?,
            "epochs"?, "batchSize"?, "learningRate"?, "hiddenSize"?, "numBlocks"?,
            "rolloutK"?, "valSplit"?, "seed"? }
  eval  : { "mode":"eval", "modelDir", "dbPath" }
  plan  : { "mode":"plan", "modelDir", "framePath", "goalPath",
            "horizon"?, "samples"?, "iterations"?, "seed"?,
            "vjepa2CacheDir"?, "videoBaseDir"? }

学習の指標 (metrics.json):
  val1StepMSE      : 検証エピソードでの1ステップ予測誤差 (正規化潜在空間)
  identityMSE      : 恒等ベースライン (z_{t+1}=z_t とみなした場合) の誤差
  improveRatio     : identityMSE / val1StepMSE。**1.0 を超えなければ何も学習していない**
  actionSensitivity: 行動をシャッフルした場合の誤差 / 本来の誤差。
                     **1.0 付近なら行動を無視している** = 計画には使えない
  rolloutMSE       : rolloutK ステップ自己回帰の誤差 (計画の実用性の目安)

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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vjepa2_ac_common as ac
import vjepa2_common as vj

DEFAULT_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ml', 'vjepa2_cache')


def log(msg):
    print(msg, flush=True)


def _resolve_ac_action_spec(cfg, df=None, np=None, train_rows=None):
    """行動仕様を検証・正規化する。連続は学習側統計で mean/scale を確定する。"""
    atype = cfg.get('actionType') or 'discrete'
    if atype not in ('discrete', 'continuous'):
        raise RuntimeError(f"actionType は discrete か continuous です: {atype}")
    if atype == 'continuous':
        cols = [c for c in (cfg.get('actionColumns') or []) if c]
        if not cols:
            raise RuntimeError('actionType=continuous には actionColumns が必要です')
        spec = {'type': 'continuous', 'columns': cols}
        if df is not None:
            import pandas as pd
            raw = np.stack([pd.to_numeric(df[c], errors='coerce').fillna(0.0).to_numpy('float32')
                            for c in cols], axis=1)
            sub = raw[train_rows] if train_rows is not None else raw
            mean = sub.mean(axis=0)
            scale = np.maximum(sub.std(axis=0), 1e-6)
            spec['mean'] = mean.astype('float32').tolist()
            spec['scale'] = scale.astype('float32').tolist()
            return spec, raw
        return spec, None
    col = cfg.get('actionColumn')
    if not col:
        raise RuntimeError('actionColumn が必要です')
    spec = {'type': 'discrete', 'column': col}
    if df is not None:
        classes = sorted(set(df[col].astype(str).unique().tolist()))
        if len(classes) < 2:
            raise RuntimeError('行動が1種類しかありません')
        spec['classes'] = classes
        idx = {c: k for k, c in enumerate(classes)}
        raw = df[col].astype(str).map(lambda v: idx.get(v, 0)).to_numpy('int64')
        return spec, raw
    return spec, None


def _load_table(cfg, np):
    """テーブルから (df, Z, episodes, steps) を作る。観測はキャッシュ付きでエンコード。"""
    import duckdb

    ep_col = cfg.get('episodeColumn') or 'episode'
    st_col = cfg.get('stepColumn') or 'step'
    video_col = cfg.get('videoColumn') or 'frame'
    atype = cfg.get('actionType') or 'discrete'
    a_cols = ([cfg.get('actionColumn')] if atype == 'discrete'
              else list(cfg.get('actionColumns') or []))
    a_cols = [c for c in a_cols if c]
    if not a_cols:
        raise RuntimeError('行動カラムが指定されていません')
    for c in [ep_col, st_col, video_col] + a_cols:
        if not isinstance(c, str) or '"' in c or '\\' in c or ';' in c:
            raise RuntimeError(f'不正な列名: {c}')

    needed = list(dict.fromkeys([ep_col, st_col, video_col] + a_cols))
    from ml_common import connect_duckdb_ro
    con = connect_duckdb_ro(cfg['dbPath'], log=log)
    cols_sql = ', '.join(f'"{c}"' for c in needed)
    df = con.execute(f'SELECT {cols_sql} FROM "{cfg["tableName"]}"').df()
    con.close()
    log(f"  取得行数: {len(df)}")

    before = len(df)
    df = df.dropna(subset=needed).reset_index(drop=True)
    if before != len(df):
        log(f"  NULL除外: {before} → {len(df)} 行")
    # 遷移の並びが命なので、必ず (episode, step) で時系列順に揃える
    df['_step_i'] = df[st_col].astype('int64')
    df = df.sort_values([ep_col, '_step_i'], kind='stable').reset_index(drop=True)
    if len(df) < 20:
        raise RuntimeError(f"行が少なすぎます ({len(df)} 行)。最低20行 (遷移十数個) は必要です。")

    spec_vj = vj.normalize_spec(cfg.get('vjepa2') or {})
    log(f"\n[V-JEPA 2 エンコード] {vj.spec_label(spec_vj)}")
    Z, stats = vj.ensure_embeddings(
        df[video_col].tolist(), spec_vj,
        cfg.get('vjepa2CacheDir') or DEFAULT_CACHE_DIR,
        base_dir=cfg.get('videoBaseDir') or None,
        log=log, device=cfg.get('vjepa2Device'), strict=True)
    log(f"  埋め込み: {Z.shape}")

    episodes = df[ep_col].astype(str).to_numpy()
    steps = df['_step_i'].to_numpy()
    return df, Z.astype('float32'), episodes, steps, spec_vj, \
        {'episodeColumn': ep_col, 'stepColumn': st_col, 'videoColumn': video_col}


def _batched_mse(torch, predictor, Z_t, A_t, starts, k, batch=1024):
    """開始 index 群に対する kステップ自己回帰の平均 MSE (勾配なし)。"""
    total, cnt = 0.0, 0
    with torch.no_grad():
        for b in range(0, len(starts), batch):
            idx = starts[b:b + batch]
            z = Z_t[idx]
            loss = 0.0
            for j in range(k):
                z = predictor(z, A_t[idx + j])
                loss = loss + ((z - Z_t[idx + j + 1]) ** 2).mean(dim=1)
            total += float(loss.sum().item()) / k
            cnt += len(idx)
    return total / max(cnt, 1)


def _identity_mse(torch, Z_t, starts, k):
    """恒等ベースライン: 「何も動かない」と予測した場合の同じ指標。"""
    total, cnt = 0.0, 0
    with torch.no_grad():
        for b in range(0, len(starts), 4096):
            idx = starts[b:b + 4096]
            z0 = Z_t[idx]
            loss = 0.0
            for j in range(k):
                loss = loss + ((z0 - Z_t[idx + j + 1]) ** 2).mean(dim=1)
            total += float(loss.sum().item()) / k
            cnt += len(idx)
    return total / max(cnt, 1)


def train(cfg):
    import numpy as np
    import torch
    import torch.nn as nn

    seed = int(cfg.get('seed', 42))
    random.seed(seed); np.random.seed(seed); torch.manual_seed(seed)
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    d = ac.DEFAULTS

    log("=== 世界モデル (V-JEPA 2-AC) 学習開始 ===")
    log(f"モデル名: {cfg['name']}  テーブル: {cfg['tableName']}  device: {device}")
    log("\n[データ読み込み]")
    df, Z, episodes, steps, spec_vj, colinfo = _load_table(cfg, np)

    # 分割 → 正規化 (学習側の行だけで統計を取る。検証を混ぜると評価が甘くなる)
    val_split = min(max(float(cfg.get('valSplit', d['valSplit'])), 0.0), 0.5)
    train_eps, val_eps = ac.split_episodes(np, episodes, val_split, seed)
    is_train_row = np.fromiter((e in train_eps for e in episodes), bool, len(episodes))
    z_mean, z_std = ac.fit_latent_norm(np, Z, np.nonzero(is_train_row)[0])
    Zn = ac.normalize_latent(np, Z, z_mean, z_std)

    a_spec, A_raw = _resolve_ac_action_spec(cfg, df, np, np.nonzero(is_train_row)[0])
    A = ac.encode_actions(np, a_spec, A_raw)
    act_dim = ac.action_dim(a_spec)

    k = max(1, min(int(cfg.get('rolloutK', d['rolloutK'])), 16))
    windows = ac.build_windows(np, episodes, steps, k)
    pairs = ac.build_windows(np, episodes, steps, 1)      # 1ステップ評価用
    w_train = windows[np.fromiter((episodes[i] in train_eps for i in windows), bool, len(windows))] \
        if len(windows) else windows
    p_val = pairs[np.fromiter((episodes[i] in val_eps for i in pairs), bool, len(pairs))] \
        if len(pairs) else pairs
    w_val = windows[np.fromiter((episodes[i] in val_eps for i in windows), bool, len(windows))] \
        if len(windows) else windows

    log(f"  エピソード: 学習 {len(train_eps)} / 検証 {len(val_eps)}")
    log(f"  遷移ペア: {len(pairs)}  学習ウィンドウ(k={k}): {len(w_train)}  検証ペア: {len(p_val)}")
    if len(w_train) < 10:
        raise RuntimeError(
            f"学習に使えるウィンドウが少なすぎます ({len(w_train)})。"
            f"エピソードを増やすか rolloutK を下げてください")
    has_val = len(p_val) >= 5

    hidden = int(cfg.get('hiddenSize', d['hiddenSize']))
    blocks = int(cfg.get('numBlocks', d['numBlocks']))
    epochs = int(cfg.get('epochs', d['epochs']))
    batch_size = min(int(cfg.get('batchSize', d['batchSize'])), max(len(w_train), 1))
    lr = float(cfg.get('learningRate', d['learningRate']))
    emb_dim = Z.shape[1]

    predictor = ac.build_predictor(torch, nn, emb_dim, act_dim, hidden, blocks).to(device)
    n_params = sum(p.numel() for p in predictor.parameters())
    optimizer = torch.optim.Adam(predictor.parameters(), lr=lr)
    log(f"  predictor: 残差MLP hidden={hidden} × {blocks}ブロック "
        f"({n_params:,} パラメータ)  行動次元={act_dim}")

    Z_t = torch.tensor(Zn, device=device)
    A_t = torch.tensor(A, device=device)
    wt = torch.tensor(w_train, dtype=torch.long, device=device)

    loss_history, val_history = [], []
    best_val = float('inf')
    best_state, best_epoch = None, None   # 検証損失が最小のエポックの重み
    start = time.time()
    log("\n[学習ループ]")
    predictor.train()
    for ep in range(epochs):
        perm = wt[torch.randperm(len(wt), device=device)]
        total = 0.0
        for b in range(0, len(perm), batch_size):
            idx = perm[b:b + batch_size]
            z = Z_t[idx]
            loss = 0.0
            # k ステップ自己回帰: 自分の予測を入力に次を予測する
            # (1ステップだけ学習すると、計画時の多段ロールアウトで誤差が爆発する)
            for j in range(k):
                z = predictor(z, A_t[idx + j])
                loss = loss + ((z - Z_t[idx + j + 1]) ** 2).mean()
            loss = loss / k
            optimizer.zero_grad(); loss.backward()
            torch.nn.utils.clip_grad_norm_(predictor.parameters(), 10.0)
            optimizer.step()
            total += float(loss.item()) * len(idx)
        ep_loss = total / max(len(perm), 1)
        loss_history.append(round(ep_loss, 6))
        if has_val:
            predictor.eval()
            v = _batched_mse(torch, predictor, Z_t, A_t,
                             torch.tensor(p_val, dtype=torch.long, device=device), 1)
            predictor.train()
            val_history.append(round(v, 6))
            if v < best_val:
                best_val = v
                best_epoch = ep + 1
                # 検証が最良の時点の重みを控える (最後まで回すと過学習した重みで終わるため)
                best_state = {k: t.detach().cpu().clone() for k, t in predictor.state_dict().items()}
        if (ep + 1) % max(1, epochs // 20) == 0 or ep == 0 or ep == epochs - 1:
            extra = f"  検証={val_history[-1]:.5f}" if val_history else ''
            log(f"  Epoch {ep+1:4d}/{epochs}: 損失={ep_loss:.5f}{extra}")

    elapsed = time.time() - start

    # ─── 検証最良の重みへ巻き戻し (early stopping 相当) ───
    if best_state is not None and best_epoch is not None and best_epoch < epochs:
        predictor.load_state_dict(best_state)
        log(f"  検証損失が最小だった Epoch {best_epoch} の重みを採用 "
            f"(最終Epochは過学習しているため)")

    # ─── 評価: 恒等ベースラインと行動感度 ───
    predictor.eval()
    ev_pairs = torch.tensor(p_val if has_val else pairs, dtype=torch.long, device=device)
    val_mse = _batched_mse(torch, predictor, Z_t, A_t, ev_pairs, 1)
    ident_mse = _identity_mse(torch, Z_t, ev_pairs, 1)
    # 行動をシャッフルして予測 → 誤差が変わらなければ行動を無視している
    A_shuf = A_t[torch.randperm(len(A_t), device=device)]
    shuf_mse = _batched_mse(torch, predictor, Z_t, A_shuf, ev_pairs, 1)
    ev_win = torch.tensor((w_val if (has_val and len(w_val) >= 5) else windows),
                          dtype=torch.long, device=device)
    rollout_mse = _batched_mse(torch, predictor, Z_t, A_t, ev_win, k) if len(ev_win) else None
    rollout_ident = _identity_mse(torch, Z_t, ev_win, k) if len(ev_win) else None

    improve = ident_mse / max(val_mse, 1e-12)
    sensitivity = shuf_mse / max(val_mse, 1e-12)
    label = '検証' if has_val else '全データ(検証なし・甘め)'
    log(f"\n完了 ({elapsed:.1f}秒)")
    log(f"  [{label}] 1ステップMSE={val_mse:.5f}  恒等ベースライン={ident_mse:.5f}  "
        f"改善比={improve:.2f}x")
    log(f"  行動感度={sensitivity:.2f}x (シャッフル時の誤差 ÷ 本来の誤差)")
    if improve < 1.1:
        log("  ⚠ 恒等ベースラインとほぼ同じです。データ不足か、観測の変化が小さすぎます")
    if sensitivity < 1.1:
        log("  ⚠ 行動を無視して予測しています。このままでは計画に使えません "
            "(行動と観測変化の対応が学べるデータか確認してください)")

    # ─── 保存 ───
    out = Path(cfg['outputDir']); out.mkdir(parents=True, exist_ok=True)
    torch.save(predictor.state_dict(), out / 'model.pt')
    final_cfg = {
        'name': cfg['name'], 'kind': 'worldmodel',
        'tableName': cfg['tableName'],
        'embDim': emb_dim, 'actionDim': act_dim,
        'hiddenSize': hidden, 'numBlocks': blocks, 'rolloutK': k,
        'actionSpec': a_spec,
        'latentMean': z_mean.tolist(), 'latentStd': z_std.tolist(),
        'vjepa2': spec_vj, **colinfo,
        'valSplit': val_split, 'seed': seed, 'trainedAt': time.time(),
    }
    with open(out / 'config.json', 'w', encoding='utf-8') as f:
        json.dump(final_cfg, f, indent=2, ensure_ascii=False)
    rnd = lambda v, n=6: (round(v, n) if isinstance(v, float) else v)
    metrics = {
        'kind': 'worldmodel', 'epochs': epochs,
        'lossHistory': loss_history, 'valLossHistory': val_history,
        'lossName': '損失(MSE)',
        'finalLoss': loss_history[-1],
        'finalValLoss': val_history[-1] if val_history else None,
        'bestValEpoch': best_epoch,
        'val1StepMSE': rnd(val_mse), 'identityMSE': rnd(ident_mse),
        'improveRatio': rnd(improve, 3), 'actionSensitivity': rnd(sensitivity, 3),
        'rolloutK': k, 'rolloutMSE': rnd(rollout_mse), 'rolloutIdentityMSE': rnd(rollout_ident),
        'nTransitions': int(len(pairs)), 'nTrainWindows': int(len(w_train)),
        'nValPairs': int(len(p_val)), 'hasVal': has_val,
        'nParams': n_params, 'elapsedSec': round(elapsed, 1),
    }
    with open(out / 'metrics.json', 'w', encoding='utf-8') as f:
        json.dump(metrics, f, indent=2, ensure_ascii=False)
    log(f"\n✅ 保存先: {out}")
    log("RESULT_JSON:" + json.dumps({
        'status': 'completed', 'kind': 'worldmodel',
        'finalLoss': loss_history[-1],
        'val1StepMSE': rnd(val_mse), 'identityMSE': rnd(ident_mse),
        'improveRatio': rnd(improve, 3), 'actionSensitivity': rnd(sensitivity, 3),
        'rolloutMSE': rnd(rollout_mse),
        'nTransitions': int(len(pairs)), 'device': device, 'elapsedSec': round(elapsed, 1),
    }, ensure_ascii=False))


def evaluate(cfg):
    """保存済み世界モデルを、テーブルの現在の中身で評価し直す。"""
    import numpy as np
    import torch
    import torch.nn as nn

    model_dir = Path(cfg['modelDir'])
    predictor, mcfg = ac.load_predictor(torch, nn, str(model_dir),
                                        'cuda' if torch.cuda.is_available() else 'cpu')
    merged = {**mcfg, **{k: v for k, v in cfg.items() if v is not None},
              'actionType': mcfg['actionSpec']['type'],
              'actionColumn': mcfg['actionSpec'].get('column'),
              'actionColumns': mcfg['actionSpec'].get('columns')}
    log(f"=== 世界モデル評価 ===  table={merged['tableName']}")
    df, Z, episodes, steps, _, _ = _load_table(merged, np)
    Zn = ac.normalize_latent(np, Z, mcfg['latentMean'], mcfg['latentStd'])
    a_spec = mcfg['actionSpec']
    if a_spec['type'] == 'discrete':
        idx = {c: k for k, c in enumerate(a_spec['classes'])}
        A_raw = df[a_spec['column']].astype(str).map(lambda v: idx.get(v, 0)).to_numpy('int64')
    else:
        import pandas as pd
        A_raw = np.stack([pd.to_numeric(df[c], errors='coerce').fillna(0.0).to_numpy('float32')
                          for c in a_spec['columns']], axis=1)
    A = ac.encode_actions(np, a_spec, A_raw)
    k = int(mcfg.get('rolloutK', 3))
    pairs = ac.build_windows(np, episodes, steps, 1)
    windows = ac.build_windows(np, episodes, steps, k)
    device = next(predictor.parameters()).device
    Z_t = torch.tensor(Zn, device=device); A_t = torch.tensor(A, device=device)
    pt = torch.tensor(pairs, dtype=torch.long, device=device)
    mse = _batched_mse(torch, predictor, Z_t, A_t, pt, 1)
    ident = _identity_mse(torch, Z_t, pt, 1)
    shuf = _batched_mse(torch, predictor, Z_t, A_t[torch.randperm(len(A_t), device=device)], pt, 1)
    ro = _batched_mse(torch, predictor, Z_t, A_t,
                      torch.tensor(windows, dtype=torch.long, device=device), k) if len(windows) else None
    rnd = lambda v, n=6: (round(v, n) if isinstance(v, float) else v)
    result = {
        'status': 'completed', 'kind': 'worldmodel', 'nTransitions': int(len(pairs)),
        'oneStepMSE': rnd(mse), 'identityMSE': rnd(ident),
        'improveRatio': rnd(ident / max(mse, 1e-12), 3),
        'actionSensitivity': rnd(shuf / max(mse, 1e-12), 3),
        'rolloutK': k, 'rolloutMSE': rnd(ro),
        'note': '学習に使った行を含む全行での評価です。汎化性能は学習時の val 指標を見てください',
    }
    log(f"  1ステップMSE={mse:.5f}  改善比={result['improveRatio']}x  "
        f"行動感度={result['actionSensitivity']}x")
    log("RESULT_JSON:" + json.dumps(result, ensure_ascii=False))


def plan(cfg):
    """現在の観測とゴール画像から、CEM で行動系列を探索する (CLI 検証用)。

    常駐エンコーダを使う本番経路は vjepa2_server.py の /plan。こちらは
    エンコーダを都度ロードするので遅いが、単体で動作確認できる。
    """
    import numpy as np
    import torch
    import torch.nn as nn

    model_dir = Path(cfg['modelDir'])
    predictor, mcfg = ac.load_predictor(torch, nn, str(model_dir), 'cpu')
    spec_vj = vj.normalize_spec(mcfg.get('vjepa2') or {})
    cache = cfg.get('vjepa2CacheDir') or DEFAULT_CACHE_DIR
    base = cfg.get('videoBaseDir') or None
    log(f"=== 計画 (CEM) ===  {vj.spec_label(spec_vj)}")
    emb, _ = vj.ensure_embeddings([cfg['framePath'], cfg['goalPath']], spec_vj, cache,
                                  base_dir=base, log=log, strict=True)
    z0 = ac.normalize_latent(np, emb[0:1], mcfg['latentMean'], mcfg['latentStd'])[0]
    zg = ac.normalize_latent(np, emb[1:2], mcfg['latentMean'], mcfg['latentStd'])[0]

    p = ac.PLAN_DEFAULTS
    horizon = max(1, min(int(cfg.get('horizon', p['horizon'])), 32))
    samples = max(16, min(int(cfg.get('samples', p['samples'])), 2048))
    iters = max(1, min(int(cfg.get('iterations', p['iterations'])), 16))
    t0 = time.time()
    score_fn = ac.make_rollout_score_fn(torch, predictor, z0, zg, mcfg['actionSpec'], np)
    r = ac.cem_plan(np, score_fn, mcfg['actionSpec'], horizon, samples, iters,
                    int(cfg.get('seed', 0)))
    actions = ac.decode_actions(np, mcfg['actionSpec'], r['best'])
    init_dist = float(((z0 - zg) ** 2).mean())
    result = {
        'status': 'completed', 'kind': 'plan',
        'actions': actions, 'firstAction': actions[0],
        'horizon': horizon, 'samples': samples, 'iterations': iters,
        'initialDistance': round(init_dist, 5),
        'predictedFinalDistance': round(-r['bestScore'], 5),
        'scoreHistory': [round(s, 5) for s in r['scoreHistory']],
        'elapsedSec': round(time.time() - t0, 2),
    }
    log(f"  初期距離={init_dist:.4f} → 予測最終距離={-r['bestScore']:.4f}  "
        f"1手目={actions[0]}")
    log("RESULT_JSON:" + json.dumps(result, ensure_ascii=False))


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
        mode = cfg.get('mode', 'train')
        if mode == 'eval':
            evaluate(cfg)
        elif mode == 'plan':
            plan(cfg)
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
