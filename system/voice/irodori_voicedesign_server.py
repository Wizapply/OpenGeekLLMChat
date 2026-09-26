#!/usr/bin/env python3
"""
Irodori-TTS VoiceDesign 用 OpenAI互換ラッパーサーバー（簡易・CLI方式）

OpenGeekLLMChat の /tts は OpenAI互換 `POST /v1/audio/speech` に対して
  - input        : 読み上げる本文
  - instructions : 声の説明（VoiceDesign キャプション）
  - irodori.caption : 同上（フォールバック）
を送る。

公式の `irodori_openai_tts`（OpenAI互換サーバー）は VoiceDesign（テキストでの
声指定 = キャプション）に非対応のため、このスクリプトが VoiceDesign モデルの
`infer.py` をリクエスト毎にサブプロセス実行し、キャプションから声を生成する。
※モデルを毎回ロードするため1回あたり数秒〜十数秒かかる（簡易方式）。

────────────────────────────────────────────────────────────
セットアップ
  1) Irodori-TTS 本体（core リポジトリ。`infer.py` が含まれる）を取得
       git clone https://github.com/Aratako/Irodori-TTS.git
  2) 依存の入った venv を用意（Irodori-TTS-Server の venv を再利用可。
     fastapi / uvicorn / soundfile / torch / irodori-tts が必要）
  3) 本ファイルを Irodori-TTS（`infer.py` と同じディレクトリ）に置く
  4) 起動（例）:
       cd ~/Irodori-TTS
       VD_PYTHON=~/Irodori-TTS-Server/venv/bin/python \
       VD_HF_CHECKPOINT=Aratako/Irodori-TTS-600M-v3-VoiceDesign \
       ~/Irodori-TTS-Server/venv/bin/python -m uvicorn \
         irodori_voicedesign_server:app --host 127.0.0.1 --port 8089

  → OpenGeekLLMChat 側 config.json の irodoriTts をこのサーバー(8089)へ向ける。
    詳細は README の「VoiceDesign をチャットで使う」を参照。

環境変数
  VD_PYTHON          infer.py を実行する python（既定: 本サーバーの python）
  VD_INFER           infer.py のパス（既定: 本ファイルと同じ場所の ./infer.py）
  VD_HF_CHECKPOINT   VoiceDesign モデル（既定: Aratako/Irodori-TTS-600M-v3-VoiceDesign）
  VD_DEFAULT_CAPTION 声指定が無い時の既定キャプション
  VD_OUT_DIR         一時 wav 出力先（既定: $TMPDIR/irodori_vd_outputs。
                     systemd の ProtectHome=read-only でも書けるよう /tmp 既定）
  VD_TIMEOUT         1リクエストの上限秒（既定: 600）
  VD_EXTRA_ARGS      infer.py への追加引数（空白区切り。任意）
"""
import io
import os
import sys
import shlex
import uuid
import tempfile
import subprocess

from fastapi import FastAPI, Request, Response, HTTPException

try:
    import soundfile as sf  # ブラウザ確実再生のため 16bit PCM WAV へ正規化する
except Exception:  # pragma: no cover
    sf = None

app = FastAPI()

_HERE = os.path.dirname(os.path.abspath(__file__)) or "."
VD_PYTHON = os.environ.get("VD_PYTHON", sys.executable)
VD_INFER = os.environ.get("VD_INFER", os.path.join(_HERE, "infer.py"))
VD_MODEL = os.environ.get("VD_HF_CHECKPOINT", "Aratako/Irodori-TTS-600M-v3-VoiceDesign")
VD_DEFAULT_CAPTION = os.environ.get(
    "VD_DEFAULT_CAPTION", "落ち着いた自然な声で、明瞭に読み上げてください。"
)
VD_OUT_DIR = os.environ.get("VD_OUT_DIR", os.path.join(tempfile.gettempdir(), "irodori_vd_outputs"))
VD_TIMEOUT = int(os.environ.get("VD_TIMEOUT", "600"))
VD_EXTRA_ARGS = shlex.split(os.environ.get("VD_EXTRA_ARGS", ""))

os.makedirs(VD_OUT_DIR, exist_ok=True)


def resolve_caption(body):
    """instructions → irodori.caption → voice(自由記述) → 既定 の優先順でキャプション決定。"""
    cap = (body.get("instructions") or "").strip()
    if not cap:
        iro = body.get("irodori") or {}
        c = iro.get("caption")
        cap = (str(c).strip() if c else "")
    if not cap:
        v = body.get("voice")
        if isinstance(v, str) and v.strip().lower() not in ("", "none", "default", "sample"):
            cap = v.strip()
    return cap or VD_DEFAULT_CAPTION


def to_pcm16_wav(path):
    """infer.py の出力 wav を 16bit PCM WAV に正規化（ブラウザ <audio> 互換のため）。"""
    if sf is None:
        with open(path, "rb") as f:
            return f.read()
    data, sr = sf.read(path, dtype="float32", always_2d=False)
    buf = io.BytesIO()
    sf.write(buf, data, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


@app.get("/health")
def health():
    return {"ok": True, "model": VD_MODEL, "infer": VD_INFER}


@app.post("/v1/audio/speech")
async def speech(req: Request):
    body = await req.json()
    text = (body.get("input") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="input is required")

    caption = resolve_caption(body)
    out_wav = os.path.join(VD_OUT_DIR, f"vd_{uuid.uuid4().hex}.wav")
    cmd = [
        VD_PYTHON, VD_INFER,
        "--hf-checkpoint", VD_MODEL,
        "--text", text,
        "--caption", caption,
        "--no-ref",
        "--output-wav", out_wav,
        *VD_EXTRA_ARGS,
    ]
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=VD_TIMEOUT,
            cwd=os.path.dirname(VD_INFER) or ".",
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="synthesis timeout")

    if proc.returncode != 0 or not os.path.exists(out_wav):
        msg = (proc.stderr or proc.stdout or "")[-800:]
        raise HTTPException(status_code=500, detail=f"infer.py failed: {msg}")

    try:
        audio = to_pcm16_wav(out_wav)
    finally:
        try:
            os.remove(out_wav)
        except OSError:
            pass

    return Response(content=audio, media_type="audio/wav")
