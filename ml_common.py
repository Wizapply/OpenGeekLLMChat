"""
ml_common.py — OpenGeekLLMChat 機械学習機能の共通ロジック

学習 (ml_runner.py) と推論 (ml_predict.py) で共有する関数群:
  - dtype 判定 (classify_dtype)
  - 日時列の派生特徴展開 (expand_datetime_features, DATETIME_FEATURES)
  - 値エンコード (encode_value)
  - 日時パース (parse_datetime)
  - 入力例生成 (example_input)

両ファイルで同じロジックを保持していると、修正漏れで「学習と推論で挙動が違う」
不具合に直結する。共通化することで一箇所メンテになる。
"""
import datetime as _dt
import time as _time


def connect_duckdb_ro(db_path, retries=15, delay=2.0, log=None):
    """DuckDB を read_only で開く。ロック競合時はリトライする。

    Node 側は学習ジョブ開始前に接続を閉じるが、close の完了と本プロセスの connect の
    間にわずかな時間差があり、稀に "Conflicting lock is held" になる。数秒待てば
    解消するので、即死せずリトライする (既定: 2秒間隔 × 15回 = 最大30秒)。
    それでも取れない場合は、Node 側がロックを握りっぱなし (要サーバー再起動) の疑い。
    """
    import duckdb
    last = None
    for i in range(max(1, int(retries))):
        try:
            return duckdb.connect(db_path, read_only=True)
        except Exception as e:  # duckdb.IOException 等。型名がバージョンで揺れるため広く取る
            msg = str(e)
            if 'lock' not in msg.lower():
                raise                     # ロック以外のエラーは即時失敗
            last = e
            if log and i == 0:
                log(f"  DuckDB がロック中のため待機します (最大{int(retries * delay)}秒)...")
            _time.sleep(delay)
    raise RuntimeError(
        f"DuckDB のロックを {int(retries * delay)}秒待ちましたが取得できませんでした。"
        f"Node 側がハンドルを握りっぱなしの可能性があります (サーバー再起動で解消)。"
        f" 元エラー: {last}")


# 日時列を分解する際の派生特徴名 (固定、6特徴量)
DATETIME_FEATURES = ['year', 'month', 'day', 'dayofweek', 'dayofyear', 'is_weekend']


def classify_dtype(col_dtype):
    """pandas dtype から特徴量の種別を判定する。

    Returns:
        'datetime' | 'category' | 'numeric'

    判定基準:
      - 'datetime'/'timestamp'/'date' を含む → 日時 (自動分解対象)
      - 'object', 'category', 'str', 'string', 'bool', 'boolean' → カテゴリ
        (DuckDB Node binding が pandas 2.0+ で 'str' dtype を返すケースに対応)
      - その他 → 数値
    """
    name = str(col_dtype).lower()
    if 'datetime' in name or 'timestamp' in name or 'date' in name:
        return 'datetime'
    if name in ('object', 'category', 'str', 'string', 'bool', 'boolean'):
        return 'category'
    return 'numeric'


def parse_datetime(v):
    """文字列/数値/datetime から datetime オブジェクトを返す。失敗時は None。

    Pythonの datetime に変換できる代表的なフォーマットを順に試す。
    pandas 依存を避けるため標準ライブラリのみで実装 (推論側の起動高速化)。
    """
    if v is None:
        return None
    if isinstance(v, _dt.datetime):
        return v
    if isinstance(v, _dt.date):
        return _dt.datetime(v.year, v.month, v.day)
    s = str(v).strip()
    if not s:
        return None
    formats = [
        '%Y-%m-%d %H:%M:%S',
        '%Y-%m-%dT%H:%M:%S',
        '%Y-%m-%dT%H:%M:%S.%f',
        '%Y-%m-%d',
        '%Y/%m/%d %H:%M:%S',
        '%Y/%m/%d',
        '%Y%m%d',
    ]
    for fmt in formats:
        try:
            return _dt.datetime.strptime(s, fmt)
        except ValueError:
            continue
    # ISO 形式 fallback (Python 3.11+ なら fromisoformat が緩い)
    try:
        return _dt.datetime.fromisoformat(s.replace('Z', '+00:00'))
    except (ValueError, AttributeError):
        return None


def expand_datetime_features(sample_dict, datetime_source_cols, datetime_features=None):
    """入力辞書に日時列が含まれていれば、学習時と同じ派生列に展開して返す。

    例: {"date": "2027-07-15", "region": "Tokyo"}
        → {"date_year": 2027, "date_month": 7, "date_day": 15,
           "date_dayofweek": 3, "date_dayofyear": 196, "date_is_weekend": 0,
           "region": "Tokyo"}

    元の日時列は結果に含めない (展開後の派生列で置き換える)。

    Args:
        sample_dict: 入力辞書
        datetime_source_cols: 日時列名の集合 (set or list)
        datetime_features: 派生特徴のリスト (デフォルトは DATETIME_FEATURES)

    Returns:
        展開済み辞書 (元の辞書は破壊しない)
    """
    if datetime_features is None:
        datetime_features = DATETIME_FEATURES
    if not datetime_source_cols:
        return dict(sample_dict)

    out = {}
    src_set = set(datetime_source_cols)
    for k, v in sample_dict.items():
        if k in src_set:
            dt = parse_datetime(v)
            if dt is None:
                # パース失敗 → 0埋め
                for feat in datetime_features:
                    out[f'{k}_{feat}'] = 0
                continue
            for feat in datetime_features:
                if feat == 'year':         out[f'{k}_{feat}'] = dt.year
                elif feat == 'month':      out[f'{k}_{feat}'] = dt.month
                elif feat == 'day':        out[f'{k}_{feat}'] = dt.day
                elif feat == 'dayofweek':  out[f'{k}_{feat}'] = dt.weekday()
                elif feat == 'dayofyear':  out[f'{k}_{feat}'] = dt.timetuple().tm_yday
                elif feat == 'is_weekend': out[f'{k}_{feat}'] = 1 if dt.weekday() >= 5 else 0
        else:
            out[k] = v
    return out


def encode_value(col, val, feature_dtypes, encoders):
    """1つの特徴量値を、学習時のエンコーダ情報を使って数値化する (推論用)。

    Args:
        col: 列名
        val: 値
        feature_dtypes: {列名: 'category'|'numeric'} (学習時に保存した情報)
        encoders: {'features': {列名: {'classes': [...]}}, 'target': ...}

    Returns:
        float: モデルに渡せる数値

    Note:
        - カテゴリ: classes_ から index を返す。未知の値は 0 (最初のクラスにフォールバック)
        - 数値: float に変換、失敗時は 0.0
    """
    dtype = feature_dtypes.get(col, 'numeric')
    if dtype == 'category':
        enc_info = encoders.get('features', {}).get(col, {})
        classes = enc_info.get('classes', [])
        s = str(val)
        if s in classes:
            return float(classes.index(s))
        # 未知のカテゴリ → 0 (最初のクラス) にフォールバック
        return 0.0
    else:
        try:
            return float(val)
        except (TypeError, ValueError):
            return 0.0


def example_input(original_features, datetime_source_cols):
    """LLM/UI 向けの「正しい入力例」を生成する。

    モデルが要求する元の特徴量を列挙し、それぞれに代表的なサンプル値を割り当てる。
    日時列は ISO 形式の文字列、よくある列名 (region/product/quantity 等) は典型例で、
    それ以外は "(値)" プレースホルダー。

    Args:
        original_features: 元の特徴量名リスト
        datetime_source_cols: 日時列名の集合

    Returns:
        サンプル入力辞書
    """
    src_set = set(datetime_source_cols)
    example = {}
    for f in original_features:
        if f in src_set:
            example[f] = "2027-04-15"
        else:
            lf = f.lower()
            if any(k in lf for k in ('region', 'area', 'city', '地域', '都市')):
                example[f] = "Tokyo"
            elif any(k in lf for k in ('product', 'item', '商品')):
                example[f] = "ProductA"
            elif any(k in lf for k in ('quantity', 'qty', 'count', '数量', '個数')):
                example[f] = 5
            else:
                example[f] = "(値)"
    return example
