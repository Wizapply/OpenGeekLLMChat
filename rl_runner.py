#!/usr/bin/env python3
"""
rl_runner.py — OpenGeekLLMChat 強化学習 (Reinforcement Learning / RL) ジョブ実行スクリプト

データテーブル (DuckDB) のログ済み経験データから、PyTorch で DQN エージェントを
オフライン学習する (Offline RL)。外部依存 (gym 等) はなし。

列マッピング:
  stateColumns      : 状態(文脈)の特徴量カラム (数値/カテゴリ)
  actionColumn      : 実際に取られた離散行動のカラム
  rewardColumn      : その行動で得られた報酬 (数値) のカラム
  nextStateColumns  : (任意) 遷移先の状態カラム。stateColumns と1対1で対応。
                      指定あり → 遷移ベースのオフラインDQN (γで先読み)
                      指定なし → 文脈付きバンディット (1ステップ報酬最大化)
  doneColumn        : (任意) エピソード終了フラグ (0/1, true/false)
  videoColumn       : (任意) 観測 (動画 / フレーム連番ディレクトリ / 静止画) のパス列。
                      指定すると V-JEPA 2 の凍結エンコーダで埋め込みに変換し、
                      stateColumns のベクトルの後ろに連結する。
                      state = [ scaler(表の列) ‖ V-JEPA2埋め込み ]
  nextVideoColumn   : (任意) 遷移先の観測パス列 (nextStateColumns と併用)

前処理は ml_runner と整合: カテゴリ列は index 化、表の特徴量を StandardScaler で正規化。
next_state も同じ変換を適用する。視覚埋め込みには scaler を掛けず、方策ヘッド側の
LayerNorm で正規化する (rl_common.build_qnet 参照)。

使い方:
  python rl_runner.py <config.json>

config.json (mode 別):
  train  : 学習。{ "mode":"train", "name", "tableName", "stateColumns", "actionColumn",
                   "rewardColumn", "nextStateColumns"?, "doneColumn"?, "episodes",
                   "gamma", "learningRate", "hiddenSize", "batchSize",
                   "dbPath", "outputDir" }
  eval   : オフライン方策評価。{ "mode":"eval", "modelDir", "dbPath" }
  policy : 推論 (状態1件→推奨行動)。{ "mode":"policy", "modelDir", "state": {列名:値} }

学習出力 (outputDir):
  - model.pt       # Q ネットワークの state_dict
  - config.json    # 学習設定 + 前処理メタ (列・エンコーダ・scaler 等)
  - metrics.json   # TD損失履歴・方策一致率・推定価値 等
  - train.log      # 学習ログ

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

# 共通モジュール (モデル構築・状態エンコード・損失計算を online ワーカーと共有)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rl_common import (
    build_qnet,
    classify_state_kind as _classify_state_kind,
    encode_state_dict as _encode_state_dict,
    compute_loss,
)

DEFAULT_VJEPA2_CACHE_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), 'ml', 'vjepa2_cache')


def log(msg):
    print(msg, flush=True)


def _vjepa2_settings(cfg):
    """cfg から V-JEPA 2 のエンコード設定・キャッシュ先・パス基点を取り出す。"""
    import vjepa2_common as vj
    return (
        vj.normalize_spec(cfg.get('vjepa2') or {}),
        cfg.get('vjepa2CacheDir') or DEFAULT_VJEPA2_CACHE_DIR,
        cfg.get('videoBaseDir') or None,
    )


def _embed_paths(paths, cfg, encoder=None):
    """観測パス配列 → (N, D) の埋め込み行列。キャッシュがあれば再利用する。"""
    import vjepa2_common as vj
    spec, cache_dir, base_dir = _vjepa2_settings(cfg)
    return vj.ensure_embeddings(
        paths, spec, cache_dir, base_dir=base_dir, log=log,
        device=cfg.get('vjepa2Device'), encoder=encoder,
        strict=not cfg.get('skipUnreadableVideos'),
    )


VALID_ACTION_TYPES = ('discrete', 'continuous')


def _resolve_action_spec(cfg):
    """行動の設定 (離散/連続・チャンク長・エピソード列) を検証して正規化する。

    設定不備はここで全部弾く。V-JEPA 2 のエンコードは数分〜数十分かかるので、
    その **前** に落とさないと無駄が大きい。
    """
    atype = cfg.get('actionType') or 'discrete'
    if atype not in VALID_ACTION_TYPES:
        raise RuntimeError(f"actionType は discrete か continuous です: {atype}")
    chunk = max(1, min(int(cfg.get('chunkSize') or 1), 64))
    episode_col = cfg.get('episodeColumn') or None
    step_col = cfg.get('stepColumn') or None
    if chunk > 1 and not episode_col:
        raise RuntimeError(
            'chunkSize > 1 には episodeColumn が必要です '
            '(エピソード境界をまたいだ未来の行動を教師にしないため)')
    # 連続値やチャンクは argmax できないので、価値ベースのアルゴリズムでは成立しない
    algo = cfg.get('algo') if cfg.get('algo') in ('dqn', 'ddqn', 'cql', 'bc') else 'dqn'
    if (atype == 'continuous' or chunk > 1) and algo != 'bc':
        raise RuntimeError(
            f"{'連続行動' if atype == 'continuous' else '行動チャンキング'}は "
            f"Behavior Cloning 専用です (指定されたアルゴリズム: {algo})。algo を bc にしてください")
    if atype == 'continuous':
        cols = [c for c in (cfg.get('actionColumns') or []) if c]
        if not cols:
            raise RuntimeError('actionType=continuous には actionColumns が必要です')
        return {'type': 'continuous', 'chunk': chunk, 'columns': cols,
                'episodeColumn': episode_col, 'stepColumn': step_col}
    if not cfg.get('actionColumn'):
        raise RuntimeError('actionColumn が必要です')
    return {'type': 'discrete', 'chunk': chunk, 'columns': [cfg['actionColumn']],
            'episodeColumn': episode_col, 'stepColumn': step_col}


def _chunk_targets(flat, episodes, chunk, np):
    """行動列を K ステップ分のチャンクに展開し、有効位置のマスクを返す。

    行動チャンキング: 状態1件から K ステップ先までの行動をまとめて予測させる。
    BC の「1ステップずつ予測して誤差が積み上がる」弱点が緩和され、動きが滑らかになる。

    Args:
        flat: (n,) int64 (離散) か (n, Da) float32 (連続)
        episodes: (n,) のエピソードID配列。None なら全体を1本の系列とみなす
    Returns:
        (A, M): A は (n, K) / (n, K, Da)、M は (n, K) float32。
        エピソード終端で K 本に満たない位置は M=0 になり、損失に寄与しない。
    """
    n = flat.shape[0]
    base = np.arange(n)
    outs, masks = [], []
    for k in range(chunk):
        idx = np.clip(base + k, 0, max(n - 1, 0))
        ok = (base + k) < n
        if episodes is not None:
            ok = ok & (episodes[idx] == episodes)
        outs.append(flat[idx])
        masks.append(ok.astype('float32'))
    A = np.stack(outs, axis=1)
    # 一度途切れたらそれ以降も無効にする (念のための単調化)
    M = np.minimum.accumulate(np.stack(masks, axis=1), axis=1).astype('float32')
    return A, M


def _make_split(n, val_split, groups, np, seed):
    """学習用 / 検証用の行インデックスを返す。

    groups (エピソードID) を渡すとエピソード単位で分割する。BC のように観測が
    時間的に強く相関するデータでは、行単位のランダム分割だと「ほぼ同じ画像が
    学習側にも検証側にも入る」ため、検証値が実力より良く出てしまう。
    """
    all_idx = np.arange(n)
    empty = np.zeros(0, dtype='int64')
    if not val_split or val_split <= 0 or n < 4:
        return all_idx, empty
    rng = np.random.default_rng(seed)
    if groups is not None:
        uniq = np.unique(groups)
        if len(uniq) < 2:
            return all_idx, empty   # エピソードが1本しかない → 分割できない
        perm = rng.permutation(len(uniq))
        n_val = min(max(1, int(round(len(uniq) * val_split))), len(uniq) - 1)
        val_groups = set(uniq[perm[:n_val]].tolist())
        is_val = np.fromiter((g in val_groups for g in groups), dtype=bool, count=n)
    else:
        n_val = min(max(1, int(round(n * val_split))), n - 1)
        is_val = np.zeros(n, dtype=bool)
        is_val[rng.permutation(n)[:n_val]] = True
    return all_idx[~is_val], all_idx[is_val]


def load_dataset_for_train(cfg, np):
    """DuckDB の表からログ済み経験データを読み出し、前処理して遷移配列を作る。"""
    import duckdb
    import pandas as pd
    from sklearn.preprocessing import StandardScaler

    state_cols = list(cfg['stateColumns'] or [])
    aspec = _resolve_action_spec(cfg)
    action_cols = aspec['columns']
    action_col = action_cols[0] if aspec['type'] == 'discrete' else None
    episode_col = aspec['episodeColumn']
    step_col = aspec['stepColumn']
    # 報酬は BC では使わないので任意にする (デモ動画には報酬列が無いことが多い)
    reward_col = cfg.get('rewardColumn') or None
    next_cols = list(cfg.get('nextStateColumns') or [])
    done_col = cfg.get('doneColumn') or None
    video_col = cfg.get('videoColumn') or None
    next_video_col = (cfg.get('nextVideoColumn') or None) if video_col else None
    if cfg.get('algo') != 'bc' and not reward_col:
        raise RuntimeError('rewardColumn が必要です (報酬なしで学習できるのは BC だけです)')

    # 遷移ベースにできるのは「表側・視覚側とも次状態が揃っている」ときだけ。
    # 視覚のみ (stateColumns が空) の構成もあり得るので、両者を分けて判定する。
    tab_next_ok = len(next_cols) == len(state_cols) and len(next_cols) > 0
    if video_col:
        has_next = bool(next_video_col) and (len(state_cols) == 0 or tab_next_ok)
    else:
        has_next = tab_next_ok
    if not state_cols and not video_col:
        raise RuntimeError('stateColumns か videoColumn のどちらかは必要です')

    extra = ([reward_col] if reward_col else []) \
        + ([video_col] if video_col else []) \
        + ([next_video_col] if (has_next and next_video_col) else [])
    needed = list(dict.fromkeys(
        state_cols + action_cols + extra
        + (next_cols if has_next else [])
        + ([episode_col] if episode_col else [])
        + ([step_col] if step_col else [])
        + ([done_col] if done_col else [])
    ))
    from ml_common import connect_duckdb_ro
    con = connect_duckdb_ro(cfg['dbPath'], log=log)
    cols_sql = ', '.join(f'"{c}"' for c in needed)
    df = con.execute(f'SELECT {cols_sql} FROM "{cfg["tableName"]}"').df()
    con.close()
    log(f"  取得行数: {len(df)}")

    req = (state_cols + action_cols + extra
           + (next_cols if has_next else [])
           + ([episode_col] if episode_col else []))
    before = len(df)
    df = df.dropna(subset=req).reset_index(drop=True)
    if before != len(df):
        log(f"  NULL除外: {before} → {len(df)} 行")
    if len(df) < 10:
        raise RuntimeError(f"学習に使える行が少なすぎます ({len(df)} 行)。最低10行必要です。")

    # チャンク作成の前に時系列順へ並べ替える (エピソード内で時間順になっていないと
    # 「未来の行動」を教師にできない)。step 列が無い場合は元の行順を時間順とみなす。
    if episode_col:
        df['_row_order'] = np.arange(len(df))
        sort_keys = [episode_col] + ([step_col] if step_col else ['_row_order'])
        df = df.sort_values(sort_keys, kind='stable').reset_index(drop=True)
        df = df.drop(columns=['_row_order'])
        n_eps = df[episode_col].astype(str).nunique()
        log(f"  エピソード: {n_eps} 本 (並べ替えキー: {', '.join(sort_keys)})")
        if not step_col and aspec['chunk'] > 1:
            log("  ⚠ stepColumn 未指定のため、テーブルの行順をエピソード内の時間順とみなします")

    col_types = {c: _classify_state_kind(df[c].dtype) for c in state_cols}
    encoders = {}
    for i, col in enumerate(state_cols):
        if col_types[col] == 'category':
            vals = set(df[col].astype(str).unique().tolist())
            if has_next:
                vals |= set(df[next_cols[i]].astype(str).unique().tolist())
            encoders[col] = sorted(vals)

    def encode_block(src_cols):
        m = np.zeros((len(df), len(state_cols)), dtype='float32')
        for j, scol in enumerate(state_cols):
            src = src_cols[j]
            if col_types[scol] == 'category':
                idx = {c: k for k, c in enumerate(encoders[scol])}
                m[:, j] = df[src].astype(str).map(lambda v: idx.get(v, 0)).to_numpy(dtype='float32')
            else:
                m[:, j] = pd.to_numeric(df[src], errors='coerce').fillna(0.0).to_numpy(dtype='float32')
        return m

    # ─── 学習 / 検証の分割 (scaler を当てる **前** に決める) ───
    # 検証行の統計を scaler に混ぜると、検証スコアがその分だけ甘く出る。
    episodes = df[episode_col].astype(str).to_numpy() if episode_col else None
    val_split = min(max(float(cfg.get('valSplit') or 0.0), 0.0), 0.5)
    train_idx, val_idx = _make_split(len(df), val_split, episodes, np, int(cfg.get('seed', 42)))
    if val_split > 0:
        if len(val_idx) == 0:
            log(f"  ⚠ 検証分割を要求されましたが分割できませんでした "
                f"({'エピソードが1本のみ' if episodes is not None else '行数不足'})")
        else:
            unit = 'エピソード単位' if episodes is not None else '行単位 (ランダム)'
            log(f"  分割: 学習 {len(train_idx)} 行 / 検証 {len(val_idx)} 行  [{unit}]")
            if episodes is None:
                log("  ⚠ episodeColumn 未指定のため行単位で分割しています。観測が時間的に"
                    "連続するデータでは検証値が実力より良く出ます (エピソード列の指定を推奨)")

    S = encode_block(state_cols)
    S2 = encode_block(next_cols) if has_next else np.zeros_like(S)
    if len(state_cols) > 0:
        scaler = StandardScaler().fit(S[train_idx])
        S = scaler.transform(S).astype('float32')
        if has_next:
            S2 = scaler.transform(S2).astype('float32')
        scaler_mean, scaler_scale = scaler.mean_.tolist(), scaler.scale_.tolist()
    else:
        scaler_mean, scaler_scale = [], []   # 視覚のみの構成 (表の列が0本)

    # ─── V-JEPA 2 の視覚埋め込みを連結 ───
    # state = [ scaler(表の列) ‖ 埋め込み ]。埋め込みには scaler を掛けない
    # (方策ヘッドの LayerNorm が担当。rl_common.build_qnet の docstring 参照)
    emb_dim = 0
    vj_spec = None
    if video_col:
        import vjepa2_common as vj
        vj_spec, _cache_dir, _base_dir = _vjepa2_settings(cfg)
        log(f"\n[V-JEPA 2 エンコード] {vj.spec_label(vj_spec)}")
        # 現状と次状態のパスをまとめて1回で処理する (エンコーダのロードは1回で済む)
        paths = df[video_col].tolist()
        n_cur = len(paths)
        if has_next and next_video_col:
            paths = paths + df[next_video_col].tolist()
        all_emb, stats = _embed_paths(paths, cfg)
        emb_dim = int(stats['embDim'])
        E = all_emb[:n_cur]
        E2 = all_emb[n_cur:] if (has_next and next_video_col) else np.zeros_like(E)
        S = np.hstack([S, E]).astype('float32')
        S2 = np.hstack([S2, E2]).astype('float32')
        log(f"  埋め込み次元: {emb_dim}  → 状態次元 {len(state_cols)} + {emb_dim} = {S.shape[1]}")

    # ─── 行動 (離散ラベル / 連続ベクトル) ───
    chunk = aspec['chunk']
    action_classes, action_mean, action_scale = [], [], []
    if aspec['type'] == 'continuous':
        A_flat = np.zeros((len(df), len(action_cols)), dtype='float32')
        for j, c in enumerate(action_cols):
            A_flat[:, j] = pd.to_numeric(df[c], errors='coerce').fillna(0.0).to_numpy(dtype='float32')
        # 連続行動は正規化してから回帰する。次元ごとにスケールが違うと (関節角とグリッパ開度など)
        # Huber 損失が大きいスケールの次元に引っ張られる。統計は学習側の行だけから取る。
        am = A_flat[train_idx].mean(axis=0)
        asd = A_flat[train_idx].std(axis=0)
        asd = np.where(asd < 1e-6, 1.0, asd).astype('float32')
        A_flat = ((A_flat - am) / asd).astype('float32')
        action_mean = am.astype('float32').tolist()
        action_scale = asd.tolist()
        action_dim = len(action_cols)
    else:
        action_classes = sorted(set(df[action_col].astype(str).unique().tolist()))
        a_idx = {c: k for k, c in enumerate(action_classes)}
        A_flat = df[action_col].astype(str).map(lambda v: a_idx.get(v, 0)).to_numpy(dtype='int64')
        action_dim = 1
    # (n,) → (n, K[, Da])。M は終端でチャンクがはみ出した位置を落とすマスク
    A, M = _chunk_targets(A_flat, episodes, chunk, np)

    if reward_col:
        R = pd.to_numeric(df[reward_col], errors='coerce').fillna(0.0).to_numpy(dtype='float32')
    else:
        R = np.zeros(len(df), dtype='float32')   # BC は報酬を使わない

    if done_col and done_col in df.columns:
        D = df[done_col].map(
            lambda v: 1.0 if str(v).strip().lower() in ('1', 'true', 'yes', 't', 'done') else 0.0
        ).to_numpy(dtype='float32')
    else:
        # next_state があれば継続(0)、なければバンディット(各行終端=1)
        D = (np.zeros(len(df)) if has_next else np.ones(len(df))).astype('float32')

    meta = {
        'stateColumns': state_cols,
        'colTypes': col_types,
        'encoders': encoders,
        'actionColumn': action_col,
        'rewardColumn': reward_col,
        'actionClasses': action_classes,
        'hasNext': has_next,
        'doneColumn': done_col,
        'scalerMean': scaler_mean,
        'scalerScale': scaler_scale,
        # 視覚埋め込み (使わない場合は embDim=0 で従来と完全に同じ挙動)
        'videoColumn': video_col,
        'nextVideoColumn': next_video_col if has_next else None,
        'embDim': emb_dim,
        'vjepa2': vj_spec,
        # 行動仕様 (既定は discrete / chunk=1 で従来と完全に同じ挙動)
        'actionType': aspec['type'],
        'actionColumns': action_cols,
        'actionDim': action_dim,
        'chunkSize': chunk,
        'actionMean': action_mean,
        'actionScale': action_scale,
        'episodeColumn': episode_col,
        'stepColumn': step_col,
    }
    return S, A, R, S2, D, M, meta, (train_idx, val_idx)


def runtime_action_spec(meta, n_actions):
    """meta から compute_loss / 推論が使う行動仕様を組み立てる。

    古いモデル (actionType 無し) は discrete / chunk=1 として扱うので、
    この変更以前に学習したエージェントもそのまま動く。
    """
    return {
        'type': meta.get('actionType') or 'discrete',
        'chunk': max(1, int(meta.get('chunkSize') or 1)),
        'dim': max(1, int(meta.get('actionDim') or 1)),
        'nActions': int(n_actions),
    }


def head_out_dim(spec):
    """方策ヘッドの出力次元。離散は K×クラス数、連続は K×行動次元。"""
    if spec['type'] == 'continuous':
        return spec['chunk'] * spec['dim']
    return spec['chunk'] * spec['nActions']


def _predict_actions(qnet, torch, St, spec, batch=4096):
    """状態バッチ → 予測行動。

    discrete   → (n, K) の行動index
    continuous → (n, K, Da) の正規化済み行動ベクトル
    """
    outs = []
    with torch.no_grad():
        for i in range(0, St.shape[0], batch):
            o = qnet(St[i:i + batch])
            b = o.shape[0]
            if spec['type'] == 'continuous':
                outs.append(o.view(b, spec['chunk'], spec['dim']))
            else:
                outs.append(o.view(b, spec['chunk'], spec['nActions']).argmax(-1))
    return torch.cat(outs, 0)


def _action_metrics(pred, At, Mt, spec):
    """予測行動と教師行動から指標を返す (連続は正規化空間での誤差)。

    first* はチャンク先頭 = 実際に実行される1手についての指標。
    chunk* は K 手すべてをマスク込みで平均したもの。
    """
    m = Mt                       # (n, K)
    m0 = m[:, :1]                # (n, 1)
    if spec['type'] == 'continuous':
        err = (pred - At).abs().mean(-1)     # (n, K)
        return {
            'firstMAE': float((err[:, :1] * m0).sum() / m0.sum().clamp(min=1.0)),
            'chunkMAE': float((err * m).sum() / m.sum().clamp(min=1.0)),
        }
    hit = (pred == At).float()               # (n, K)
    return {
        'firstAgreement': float((hit[:, :1] * m0).sum() / m0.sum().clamp(min=1.0)),
        'chunkAgreement': float((hit * m).sum() / m.sum().clamp(min=1.0)),
    }


def train(cfg):
    import numpy as np
    import torch
    import torch.nn as nn

    seed = int(cfg.get('seed', 42))
    random.seed(seed); np.random.seed(seed); torch.manual_seed(seed)
    device = 'cuda' if torch.cuda.is_available() else 'cpu'

    log(f"=== オフラインRL 学習開始 ===")
    log(f"エージェント名: {cfg['name']}")
    log(f"テーブル: {cfg['tableName']}")
    log(f"device:   {device}")
    log("\n[データ読み込み・前処理]")
    S, A, R, S2, D, M, meta, (train_idx, val_idx) = load_dataset_for_train(cfg, np)

    n = len(S)
    state_dim = S.shape[1]
    emb_dim = int(meta.get('embDim') or 0)
    n_actions = len(meta['actionClasses'])
    spec = runtime_action_spec(meta, n_actions)
    out_dim = head_out_dim(spec)
    is_continuous = spec['type'] == 'continuous'
    chunk = spec['chunk']
    mode = 'transition' if meta['hasNext'] else 'bandit'
    log(f"  方式: {'遷移ベース オフラインDQN' if mode=='transition' else '文脈付きバンディット'}")
    desc = ', '.join(meta['stateColumns']) or '(表の列なし)'
    if emb_dim:
        desc += f" + V-JEPA2埋め込み {emb_dim}次元 ({meta['videoColumn']})"
    log(f"  状態次元: {state_dim} ({desc})")
    if is_continuous:
        log(f"  行動: 連続 {spec['dim']} 次元 ({', '.join(meta['actionColumns'])})")
    else:
        log(f"  行動: 離散 {n_actions} クラス {meta['actionClasses'][:8]}{'...' if n_actions>8 else ''}")
    if chunk > 1:
        log(f"  行動チャンキング: 1状態から {chunk} ステップ先まで予測 (出力次元 {out_dim})")
    if meta.get('rewardColumn'):
        log(f"  報酬範囲: [{float(R.min()):.3f}, {float(R.max()):.3f}], 平均 {float(R.mean()):.3f}")
    else:
        log("  報酬: なし (BC は報酬を使わない)")
    log(f"  遷移数: {n}")
    if not is_continuous and n_actions < 2:
        raise RuntimeError("行動が1種類しかありません。行動カラムに2種類以上必要です。")

    gamma = float(cfg.get('gamma', 0.99)) if mode == 'transition' else 0.0
    lr = float(cfg.get('learningRate', 0.001))
    hidden = int(cfg.get('hiddenSize', 128))
    epochs = int(cfg.get('episodes', 300))  # データセットでは「エポック数」として解釈
    target_update = max(1, int(cfg.get('targetUpdate', 200)))
    algo = cfg.get('algo', 'dqn')
    if algo not in ('dqn', 'ddqn', 'cql', 'bc'):
        algo = 'dqn'
    # (連続行動・チャンキングと algo の整合は _resolve_action_spec で確認済み)
    cql_alpha = float(cfg.get('cqlAlpha', 0.5))
    algo_label = {
        'dqn': 'DQN', 'ddqn': 'Double DQN',
        'cql': f'CQL (保守的・α={cql_alpha})', 'bc': 'Behavior Cloning (模倣)',
    }[algo]
    log(f"  アルゴリズム: {algo_label}")
    is_value = algo in ('dqn', 'ddqn', 'cql')  # 価値ベース (BC以外)

    n_train, n_val = len(train_idx), len(val_idx)
    batch_size = min(int(cfg.get('batchSize', 64)), max(n_train, 1))

    if emb_dim and hidden < 256:
        log(f"  ⚠ 埋め込み {emb_dim} 次元に対して hiddenSize={hidden} は小さすぎます "
            f"(256〜512 を推奨)")
    qnet = build_qnet(torch, nn, state_dim, out_dim, hidden, emb_dim).to(device)
    target = build_qnet(torch, nn, state_dim, out_dim, hidden, emb_dim).to(device)
    target.load_state_dict(qnet.state_dict()); target.eval()
    optimizer = torch.optim.Adam(qnet.parameters(), lr=lr)
    log(f"  方策ネットワーク パラメータ数: {sum(p.numel() for p in qnet.parameters()):,}")

    St = torch.tensor(S, device=device)
    if is_value:
        # 価値ベースは従来どおり (batch,1) の行動index
        At = torch.tensor(A[:, 0], dtype=torch.long, device=device).unsqueeze(1)
    elif is_continuous:
        At = torch.tensor(A, dtype=torch.float32, device=device)      # (n, K, Da)
    else:
        At = torch.tensor(A, dtype=torch.long, device=device)         # (n, K)
    Rt = torch.tensor(R, device=device).unsqueeze(1)
    S2t = torch.tensor(S2, device=device)
    Dt = torch.tensor(D, device=device).unsqueeze(1)
    Mt = torch.tensor(M, dtype=torch.float32, device=device)          # (n, K)
    tr = torch.tensor(train_idx, dtype=torch.long, device=device)
    va = torch.tensor(val_idx, dtype=torch.long, device=device) if n_val else None

    def batch_loss(idx):
        return compute_loss(
            algo, mode, qnet, target, torch, nn,
            St[idx], At[idx], Rt[idx], S2t[idx], Dt[idx], gamma, cql_alpha,
            action_spec=spec, mask=Mt[idx],
        )

    def eval_loss(idx):
        """検証損失 (勾配なし・バッチ分割)。"""
        qnet.eval()
        total, cnt = 0.0, 0
        with torch.no_grad():
            for b in range(0, len(idx), 4096):
                sub = idx[b:b + 4096]
                total += float(batch_loss(sub).item()) * len(sub)
                cnt += len(sub)
        qnet.train()
        return total / max(cnt, 1)

    loss_name = ('損失(Huber)' if is_continuous else '損失(CE)') if algo == 'bc' else 'TD損失'
    loss_history, val_loss_history = [], []
    best_loss = float('inf')
    best_val = float('inf')
    best_state, best_epoch = None, None   # 検証損失が最小のエポックの重み
    step = 0
    start = time.time()
    log("\n[学習ループ]")
    qnet.train()
    for ep in range(epochs):
        perm = tr[torch.randperm(n_train, device=device)]
        total = 0.0
        for b in range(0, n_train, batch_size):
            idx = perm[b:b + batch_size]
            loss = batch_loss(idx)
            optimizer.zero_grad(); loss.backward()
            torch.nn.utils.clip_grad_norm_(qnet.parameters(), 10.0); optimizer.step()
            total += float(loss.item()) * len(idx)
            step += 1
            if is_value and step % target_update == 0:
                target.load_state_dict(qnet.state_dict())
        ep_loss = total / max(n_train, 1)
        loss_history.append(round(ep_loss, 6))
        best_loss = min(best_loss, ep_loss)
        if va is not None:
            v = eval_loss(va)
            val_loss_history.append(round(v, 6))
            if v < best_val:
                best_val = v
                best_epoch = ep + 1
                # 検証が最良の時点の重みを控える (最後まで回すと過学習した重みで終わるため)
                best_state = {k: t.detach().cpu().clone() for k, t in qnet.state_dict().items()}
        if (ep + 1) % max(1, epochs // 20) == 0 or ep == 0 or ep == epochs - 1:
            extra = f"  検証={val_loss_history[-1]:.5f}" if val_loss_history else ''
            log(f"  Epoch {ep+1:4d}/{epochs}: {loss_name}={ep_loss:.5f}{extra}")

    elapsed = time.time() - start

    # ─── 検証最良の重みへ巻き戻し (early stopping 相当) ───
    if best_state is not None and best_epoch is not None and best_epoch < epochs:
        qnet.load_state_dict(best_state)
        log(f"  検証損失が最小だった Epoch {best_epoch} の重みを採用 "
            f"(最終Epochは過学習しているため)")

    # ─── 学習後の方策評価 ───
    # 学習データ上の一致率だけだと過学習を見逃すので、検証分割があればそちらも出す。
    qnet.eval()
    pred = _predict_actions(qnet, torch, St, spec)
    # 指標計算用の教師。価値ベースの At は (n,1) なので、ここでは常に (n,K) 形に揃える
    Atgt = At if is_continuous else torch.tensor(A, dtype=torch.long, device=device)
    train_metrics = _action_metrics(pred[tr], Atgt[tr], Mt[tr], spec)
    val_metrics = _action_metrics(pred[va], Atgt[va], Mt[va], spec) if va is not None else {}

    mean_q = None
    if not is_continuous and chunk == 1:
        with torch.no_grad():
            mean_q = float(qnet(St).max(1)[0].mean().item())
    logged_mean_reward = float(R.mean()) if meta.get('rewardColumn') else None

    key = 'firstMAE' if is_continuous else 'firstAgreement'
    headline = val_metrics.get(key, train_metrics.get(key))
    if is_continuous:
        # 正規化空間の MAE を元スケールに戻して人が読める形にする
        scale = np.array(meta['actionScale'], dtype='float32')
        head_txt = (f"検証MAE" if val_metrics else "学習MAE") + \
                   f"={headline:.4f} (正規化) / {headline * float(scale.mean()):.4f} (元スケール平均)"
    else:
        head_txt = ("検証一致率" if val_metrics else "学習一致率") + f"={headline*100:.1f}%"
    log(f"\n完了 ({elapsed:.1f}秒)  {loss_name}={loss_history[-1]:.5f}  {head_txt}"
        + (f"  推定価値(平均maxQ)={mean_q:.3f}" if (is_value and mean_q is not None) else ''))
    if val_metrics and not is_continuous:
        gap = train_metrics['firstAgreement'] - val_metrics['firstAgreement']
        log(f"  学習一致率={train_metrics['firstAgreement']*100:.1f}%  "
            f"検証一致率={val_metrics['firstAgreement']*100:.1f}%  (差 {gap*100:+.1f}pt)")
        if gap > 0.15:
            log("  ⚠ 学習と検証の差が大きいです (過学習の疑い)。エポック数を減らすか、"
                "hiddenSize を下げるか、デモを増やしてください")

    # 互換のため policyAgreement は残す (検証があれば検証値、無ければ学習値)
    agreement = headline if not is_continuous else None

    # 保存 (前処理情報は全て config.json に同梱)
    output_dir = Path(cfg['outputDir'])
    output_dir.mkdir(parents=True, exist_ok=True)
    torch.save(qnet.state_dict(), output_dir / 'model.pt')
    final_config = {
        'name': cfg['name'],
        'env': 'dataset',
        'algo': algo,
        'cqlAlpha': cql_alpha if algo == 'cql' else None,
        'datasetMode': mode,
        'tableName': cfg['tableName'],
        'stateDim': state_dim,
        'embDim': emb_dim,
        'vjepa2': meta.get('vjepa2'),
        'nActions': n_actions,
        'outDim': out_dim,
        'actionType': spec['type'],
        'actionDim': spec['dim'],
        'chunkSize': chunk,
        'actionLabels': meta['actionClasses'],
        'hiddenSize': hidden,
        'gamma': gamma,
        'learningRate': lr,
        'episodes': epochs,
        'valSplit': min(max(float(cfg.get('valSplit') or 0.0), 0.0), 0.5),
        'seed': seed,
        'meta': meta,
        'trainedAt': time.time(),
    }
    with open(output_dir / 'config.json', 'w', encoding='utf-8') as f:
        json.dump(final_config, f, indent=2, ensure_ascii=False)

    def _r(v, nd=4):
        return round(v, nd) if isinstance(v, (int, float)) else None

    metrics = {
        'env': 'dataset',
        'algo': algo,
        'datasetMode': mode,
        'actionType': spec['type'],
        'chunkSize': chunk,
        'epochs': epochs,
        'lossHistory': loss_history,
        'valLossHistory': val_loss_history,
        'lossName': loss_name,
        'finalLoss': loss_history[-1],
        'bestLoss': round(best_loss, 6),
        'finalValLoss': val_loss_history[-1] if val_loss_history else None,
        'bestValLoss': round(best_val, 6) if val_loss_history else None,
        'bestValEpoch': best_epoch,
        # 離散: 一致率 / 連続: MAE。first* は実際に実行する1手、chunk* は K手平均
        'policyAgreement': _r(agreement),          # 互換: 検証があれば検証値
        'trainAgreement': _r(train_metrics.get('firstAgreement')),
        'valAgreement': _r(val_metrics.get('firstAgreement')),
        'trainChunkAgreement': _r(train_metrics.get('chunkAgreement')),
        'valChunkAgreement': _r(val_metrics.get('chunkAgreement')),
        'trainMAE': _r(train_metrics.get('firstMAE'), 5),
        'valMAE': _r(val_metrics.get('firstMAE'), 5),
        'trainChunkMAE': _r(train_metrics.get('chunkMAE'), 5),
        'valChunkMAE': _r(val_metrics.get('chunkMAE'), 5),
        'meanQ': _r(mean_q),
        'loggedMeanReward': _r(logged_mean_reward),
        'nTransitions': n,
        'nTrain': n_train,
        'nVal': n_val,
        'nActions': n_actions,
        'elapsedSec': round(elapsed, 1),
    }
    with open(output_dir / 'metrics.json', 'w', encoding='utf-8') as f:
        json.dump(metrics, f, indent=2, ensure_ascii=False)

    log(f"\n✅ 保存先: {output_dir}")
    log(f"\n=== 学習完了 ===")
    log("RESULT_JSON:" + json.dumps({
        'status': 'completed', 'env': 'dataset', 'algo': algo, 'datasetMode': mode,
        'actionType': spec['type'], 'chunkSize': chunk,
        'finalLoss': loss_history[-1],
        'finalValLoss': metrics['finalValLoss'],
        'policyAgreement': metrics['policyAgreement'],
        'trainAgreement': metrics['trainAgreement'],
        'valAgreement': metrics['valAgreement'],
        'trainMAE': metrics['trainMAE'], 'valMAE': metrics['valMAE'],
        'meanQ': metrics['meanQ'], 'loggedMeanReward': metrics['loggedMeanReward'],
        'nTrain': n_train, 'nVal': n_val,
        'nActions': n_actions, 'device': device, 'elapsedSec': round(elapsed, 1),
    }, ensure_ascii=False))


def _embed_cfg_for_model(cfg, mcfg):
    """評価/推論時のエンコード設定を作る。

    エンコード設定 (モデルID・frames・stride・pooling) は必ず **学習時に保存したもの**
    を使う。ここが学習時とズレると埋め込み空間が変わり、方策が静かに壊れる。
    キャッシュ先とパス基点だけは実行時の cfg から取る。
    """
    out = dict(cfg)
    out['vjepa2'] = mcfg.get('vjepa2') or (mcfg.get('meta') or {}).get('vjepa2') or {}
    return out


def _json_safe(v):
    try:
        import numpy as _np
        if isinstance(v, (_np.integer,)):
            return int(v)
        if isinstance(v, (_np.floating,)):
            return float(v)
    except Exception:
        pass
    if isinstance(v, (int, float, str, bool)):
        return v
    return str(v)


def evaluate(cfg):
    """シミュレータの無いオフライン評価: ログ行動との一致率・行動分布・推定価値・推薦サンプル。"""
    import numpy as np
    import torch
    import torch.nn as nn
    import duckdb
    import pandas as pd

    model_dir = Path(cfg['modelDir'])
    with open(model_dir / 'config.json', 'r', encoding='utf-8') as f:
        mcfg = json.load(f)

    meta = mcfg['meta']
    emb_dim = int(mcfg.get('embDim') or meta.get('embDim') or 0)
    video_col = meta.get('videoColumn') or None
    action_classes = mcfg['actionLabels']
    spec = runtime_action_spec(meta, len(action_classes))
    out_dim = int(mcfg.get('outDim') or head_out_dim(spec))
    is_continuous = spec['type'] == 'continuous'
    chunk = spec['chunk']
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    log(f"=== オフラインRL 評価 ===  table={mcfg['tableName']}, device={device}")
    qnet = build_qnet(torch, nn, mcfg['stateDim'], out_dim,
                      int(mcfg.get('hiddenSize', 128)), emb_dim)
    qnet.load_state_dict(torch.load(model_dir / 'model.pt', map_location='cpu'))
    qnet.to(device).eval()

    state_cols = meta['stateColumns']
    action_col = meta['actionColumn']
    action_cols = meta.get('actionColumns') or ([action_col] if action_col else [])
    reward_col = meta.get('rewardColumn') or None
    needed = list(dict.fromkeys(
        state_cols + action_cols
        + ([reward_col] if reward_col else [])
        + ([video_col] if video_col else [])))
    from ml_common import connect_duckdb_ro
    con = connect_duckdb_ro(cfg['dbPath'], log=log)
    df = con.execute(f'SELECT {", ".join(chr(34)+c+chr(34) for c in needed)} FROM "{mcfg["tableName"]}"').df()
    con.close()
    df = df.dropna(subset=needed).reset_index(drop=True)
    if len(df) == 0:
        raise RuntimeError("評価できる行がありません")

    # 状態行列を構築 (学習時と同じ index 化 + scaler)
    X = np.zeros((len(df), len(state_cols)), dtype='float32')
    for j, col in enumerate(state_cols):
        if meta['colTypes'].get(col) == 'category':
            idx = {c: k for k, c in enumerate(meta['encoders'].get(col, []))}
            X[:, j] = df[col].astype(str).map(lambda v: idx.get(v, 0)).to_numpy(dtype='float32')
        else:
            X[:, j] = pd.to_numeric(df[col], errors='coerce').fillna(0.0).to_numpy(dtype='float32')
    mean = np.array(meta['scalerMean'], dtype='float32')
    scale = np.where(np.array(meta['scalerScale'], dtype='float32') == 0, 1.0, np.array(meta['scalerScale'], dtype='float32'))
    X = (X - mean) / scale

    # 学習時と同じ V-JEPA 2 埋め込みを連結 (キャッシュ済みなら即座に返る)
    if video_col:
        import vjepa2_common as vj
        ecfg = _embed_cfg_for_model(cfg, mcfg)
        log(f"[V-JEPA 2 エンコード] {vj.spec_label(ecfg['vjepa2'])}")
        E, stats = _embed_paths(df[video_col].tolist(), ecfg)
        if E.shape[1] != emb_dim:
            raise RuntimeError(
                f"埋め込み次元が学習時と違います (学習 {emb_dim} / 今回 {E.shape[1]})。"
                f"エンコード設定が変わっていないか確認してください")
        X = np.hstack([X, E]).astype('float32')

    Xt = torch.tensor(X, device=device)
    with torch.no_grad():
        raw = qnet(Xt)
    # チャンク学習していても、評価するのは「実際に実行される先頭の1手」
    seq = raw.view(raw.shape[0], chunk, -1)
    pred = seq[:, 0] if is_continuous else seq.argmax(-1)[:, 0]

    rewards = (pd.to_numeric(df[reward_col], errors='coerce').fillna(0.0).to_numpy()
               if reward_col else None)
    disp_cols = state_cols + ([video_col] if video_col else [])
    result = {
        'status': 'completed',
        'env': 'dataset',
        'kind': 'dataset',
        'datasetMode': mcfg.get('datasetMode'),
        'actionType': spec['type'],
        'chunkSize': chunk,
        'nRows': len(df),
        'loggedMeanReward': round(float(rewards.mean()), 4) if rewards is not None else None,
    }

    if is_continuous:
        # 連続行動: 正規化空間で誤差を測り、元スケールにも戻して返す
        amean = np.array(meta['actionMean'], dtype='float32')
        ascale = np.array(meta['actionScale'], dtype='float32')
        raw_logged = np.zeros((len(df), spec['dim']), dtype='float32')
        for j, c in enumerate(action_cols):
            raw_logged[:, j] = pd.to_numeric(df[c], errors='coerce').fillna(0.0).to_numpy(dtype='float32')
        pred_raw = pred.cpu().numpy() * ascale + amean       # 元スケールへ
        abs_err = np.abs(pred_raw - raw_logged)
        result.update({
            'actionColumns': action_cols,
            'actionMAE': round(float(abs_err.mean()), 5),
            'actionMAEPerDim': {c: round(float(abs_err[:, j].mean()), 5)
                                for j, c in enumerate(action_cols)},
            'actionRMSE': round(float(np.sqrt((abs_err ** 2).mean())), 5),
            'loggedActionStd': {c: round(float(raw_logged[:, j].std()), 5)
                                for j, c in enumerate(action_cols)},
        })
        result['samples'] = [{
            'state': {c: (None if pd.isna(df[c].iloc[i]) else _json_safe(df[c].iloc[i]))
                      for c in disp_cols},
            'loggedAction': {c: round(float(raw_logged[i, j]), 4) for j, c in enumerate(action_cols)},
            'recommendedAction': {c: round(float(pred_raw[i, j]), 4) for j, c in enumerate(action_cols)},
            'absError': {c: round(float(abs_err[i, j]), 4) for j, c in enumerate(action_cols)},
            'reward': round(float(rewards[i]), 4) if rewards is not None else None,
        } for i in range(min(20, len(df)))]
        log(f"  行動MAE={result['actionMAE']:.5f} (元スケール)  行数={len(df)}")
        log("  ※ 比較の目安: ログ行動の標準偏差 "
            + ', '.join(f"{c}={v}" for c, v in result['loggedActionStd'].items()))
    else:
        greedy = pred.cpu().numpy()
        a_idx = {c: k for k, c in enumerate(action_classes)}
        logged = df[action_col].astype(str).map(lambda v: a_idx.get(v, 0)).to_numpy()
        agree = (greedy == logged)
        agreement = float(agree.mean())
        logged_dist = {c: 0 for c in action_classes}
        policy_dist = {c: 0 for c in action_classes}
        for a in logged:
            logged_dist[action_classes[a]] += 1
        for a in greedy:
            policy_dist[action_classes[a]] += 1
        # チャンク学習時、先頭手のスコアは出力の先頭 nActions 個
        head = seq[:, 0]
        max_q = head.max(1)[0].cpu().numpy()
        result.update({
            'actionLabels': action_classes,
            'policyAgreement': round(agreement, 4),
            'meanQ': round(float(max_q.mean()), 4),
            'rewardWhenFollowed': (round(float(rewards[agree].mean()), 4)
                                   if (rewards is not None and agree.any()) else None),
            'loggedActionDist': logged_dist,
            'policyActionDist': policy_dist,
            'samples': [{
                'state': {c: (None if pd.isna(df[c].iloc[i]) else _json_safe(df[c].iloc[i]))
                          for c in disp_cols},
                'loggedAction': action_classes[int(logged[i])],
                'recommendedAction': action_classes[int(greedy[i])],
                'reward': round(float(rewards[i]), 4) if rewards is not None else None,
                'qValues': {action_classes[k]: round(float(head[i, k].item()), 4)
                            for k in range(len(action_classes))},
            } for i in range(min(20, len(df)))],
        })
        log(f"  方策一致率={agreement*100:.1f}%  推定価値(平均maxQ)={float(max_q.mean()):.3f}  行数={len(df)}")

    # 学習時に検証分割していれば、その値も一緒に返す (この評価は表の全行が対象なので、
    # 学習に使った行を含む = 甘めに出る。汎化性能は valAgreement/valMAE の方を見ること)
    try:
        with open(model_dir / 'metrics.json', 'r', encoding='utf-8') as f:
            tm = json.load(f)
        result['trainedValSplit'] = {
            'nTrain': tm.get('nTrain'), 'nVal': tm.get('nVal'),
            'trainAgreement': tm.get('trainAgreement'), 'valAgreement': tm.get('valAgreement'),
            'trainMAE': tm.get('trainMAE'), 'valMAE': tm.get('valMAE'),
        } if tm.get('nVal') else None
    except (OSError, ValueError):
        pass
    log("RESULT_JSON:" + json.dumps(result, ensure_ascii=False))


def policy(cfg):
    """学習済みエージェントに状態を1件与えて推奨行動とQ値を返す (推論)。DuckDB は使わない。"""
    import numpy as np
    import torch
    import torch.nn as nn

    model_dir = Path(cfg['modelDir'])
    with open(model_dir / 'config.json', 'r', encoding='utf-8') as f:
        mcfg = json.load(f)
    meta = mcfg['meta']
    emb_dim = int(mcfg.get('embDim') or meta.get('embDim') or 0)
    labels = mcfg.get('actionLabels') or [str(i) for i in range(mcfg['nActions'])]
    spec = runtime_action_spec(meta, len(labels))
    out_dim = int(mcfg.get('outDim') or head_out_dim(spec))
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    qnet = build_qnet(torch, nn, mcfg['stateDim'], out_dim,
                      int(mcfg.get('hiddenSize', 128)), emb_dim)
    qnet.load_state_dict(torch.load(model_dir / 'model.pt', map_location='cpu'))
    qnet.to(device).eval()

    state = cfg.get('state', {})
    if not isinstance(state, dict):
        raise RuntimeError("state は {列名: 値} の辞書で指定してください")

    # 視覚エージェントなら、観測パス (または _embedding 直指定) を埋め込みに変換する
    if emb_dim and state.get('_embedding') is None:
        video_col = meta.get('videoColumn')
        src = state.get(video_col) if video_col else None
        if src is None:
            raise RuntimeError(
                f"観測が指定されていません。state に \"{video_col}\" (動画/フレーム/画像のパス) "
                f"か \"_embedding\" ({emb_dim}次元の配列) を入れてください")
        E, _ = _embed_paths([src], _embed_cfg_for_model(cfg, mcfg))
        state = dict(state, _embedding=E[0].tolist())

    vec = _encode_state_dict(state, meta, np)
    St = torch.tensor(vec, device=device).unsqueeze(0)

    with torch.no_grad():
        raw = qnet(St)[0]
    chunk = spec['chunk']
    result = {
        'status': 'completed',
        'env': 'dataset',
        'actionType': spec['type'],
        'chunkSize': chunk,
    }

    if spec['type'] == 'continuous':
        # 正規化空間の予測を元スケールに戻して返す
        amean = np.array(meta['actionMean'], dtype='float32')
        ascale = np.array(meta['actionScale'], dtype='float32')
        cols = meta['actionColumns']
        seq = raw.view(chunk, spec['dim']).cpu().numpy() * ascale + amean
        result['recommendedAction'] = {c: round(float(seq[0, j]), 5) for j, c in enumerate(cols)}
        result['actionColumns'] = cols
        if chunk > 1:
            # チャンク全体も返す。呼び出し側は先頭だけ実行しても、K手まとめて実行してもよい
            result['actionChunk'] = [
                {c: round(float(seq[k, j]), 5) for j, c in enumerate(cols)} for k in range(chunk)]
    else:
        logits = raw.view(chunk, len(labels))
        best = logits.argmax(dim=1).cpu().numpy()
        result['recommendedAction'] = labels[int(best[0])]
        result['actionIndex'] = int(best[0])
        result['qValues'] = {labels[k]: round(float(logits[0, k].item()), 4)
                             for k in range(len(labels))}
        if chunk > 1:
            result['actionChunk'] = [labels[int(b)] for b in best]
    log("RESULT_JSON:" + json.dumps(result, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('config_path', help='設定JSONのパス')
    args = parser.parse_args()

    with open(args.config_path, 'r', encoding='utf-8') as f:
        cfg = json.load(f)

    try:
        try:
            import numpy  # noqa
            import torch  # noqa
        except ImportError as e:
            log(f"❌ ライブラリ不足: {e}")
            log("  pip install numpy torch duckdb pandas scikit-learn --break-system-packages")
            log("RESULT_JSON:" + json.dumps({'status': 'failed', 'error': f'missing library: {e}'}))
            sys.exit(2)

        mode = cfg.get('mode', 'train')
        if mode == 'eval':
            evaluate(cfg)
        elif mode == 'policy':
            policy(cfg)
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
