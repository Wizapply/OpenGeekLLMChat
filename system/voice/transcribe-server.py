#!/usr/bin/env python3
"""
Gemma 4 E2B 音声認識サーバー for OpenGeekLLMChat

マイク音声データを受け取り、Gemma 4 E2Bで日本語テキストに変換する。
Node.jsサーバーから HTTP POST で呼び出される常駐サーバー。

使い方:
    python3 system/voice/transcribe-server.py [PORT]

デフォルトポート: 11500

API:
    POST /transcribe
        Content-Type: audio/webm (または audio/wav, audio/ogg)
        Body: 音声バイナリ
        Response: { "text": "文字起こし結果" }

    GET /health
        Response: { "status": "ok", "model": "..." }

依存:
    pip install torch transformers accelerate flask numpy scipy
    # ffmpegが必要（Gemma 4の音声前処理）
    sudo apt install ffmpeg
"""
import sys
import os
import io
import tempfile
import subprocess
import logging
from http.server import HTTPServer, BaseHTTPRequestHandler
from threading import Thread, Lock
import json

# 環境変数でHuggingFaceキャッシュディレクトリを明示（任意）
# os.environ['HF_HOME'] = '/path/to/hf_cache'

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 11500
MODEL_ID = os.environ.get('TRANSCRIBE_MODEL', 'google/gemma-4-E2B-it')
DEVICE = os.environ.get('TRANSCRIBE_DEVICE', 'cuda')  # cuda / cpu / auto

logging.basicConfig(
    level=logging.INFO,
    format='[transcribe] %(asctime)s %(levelname)s: %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
)
log = logging.getLogger(__name__)

# グローバル状態
model = None
processor = None
model_lock = Lock()

def load_model():
    """Gemma 4 E2Bモデルをロード"""
    global model, processor
    log.info(f"Loading model: {MODEL_ID} on {DEVICE}")
    try:
        import torch
        from transformers import AutoProcessor, AutoModelForCausalLM
        processor = AutoProcessor.from_pretrained(MODEL_ID)
        model_kwargs = {'dtype': torch.float16}
        if DEVICE == 'auto':
            model_kwargs['device_map'] = 'auto'
        model = AutoModelForCausalLM.from_pretrained(MODEL_ID, **model_kwargs)
        if DEVICE == 'cuda' and torch.cuda.is_available():
            model = model.to('cuda')
        elif DEVICE == 'cpu':
            model = model.to('cpu')
        model.eval()
        log.info(f"Model loaded. VRAM: {_vram_usage()}")
    except Exception as e:
        log.error(f"Model load failed: {e}")
        raise

def _vram_usage():
    try:
        import torch
        if torch.cuda.is_available():
            return f"{torch.cuda.memory_allocated()/1024**3:.1f}GB / {torch.cuda.get_device_properties(0).total_memory/1024**3:.1f}GB"
    except Exception:
        pass
    return "N/A"

def convert_to_wav(audio_bytes):
    """入力音声をffmpegで16kHz mono wav float32 numpy配列に変換"""
    import numpy as np
    with tempfile.NamedTemporaryFile(suffix='.in', delete=False) as fin:
        fin.write(audio_bytes)
        in_path = fin.name
    try:
        proc = subprocess.run(
            ['ffmpeg', '-y', '-i', in_path, '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'],
            capture_output=True, timeout=60,
        )
        if proc.returncode != 0:
            log.error(f"ffmpeg error: {proc.stderr.decode('utf-8', errors='ignore')[:500]}")
            return None
        audio = np.frombuffer(proc.stdout, dtype=np.float32)
        return audio
    finally:
        try: os.unlink(in_path)
        except Exception: pass

def transcribe(audio_bytes):
    """音声バイナリを文字起こし"""
    global model, processor
    if model is None or processor is None:
        return None, "Model not loaded"

    audio = convert_to_wav(audio_bytes)
    if audio is None or len(audio) == 0:
        return None, "Audio decoding failed"
    log.info(f"Audio: {len(audio)/16000:.1f}s, {len(audio)} samples")

    prompt = (
        "Transcribe the following speech segment in Japanese into Japanese text. "
        "Follow these specific instructions for formatting the answer:\n"
        "* Only output the transcription, with no newlines.\n"
        "* When transcribing numbers, write the digits."
    )

    with model_lock:
        try:
            import torch
            messages = [{
                "role": "user",
                "content": [
                    {"type": "audio", "audio": audio, "sample_rate": 16000},
                    {"type": "text", "text": prompt},
                ],
            }]
            inputs = processor.apply_chat_template(
                messages,
                add_generation_prompt=True,
                tokenize=True,
                return_dict=True,
                return_tensors="pt",
                enable_thinking=False,
            ).to(model.device)
            with torch.no_grad():
                out = model.generate(**inputs, max_new_tokens=512, do_sample=False)
            # 入力部分を除去してデコード
            input_len = inputs['input_ids'].shape[1]
            text = processor.decode(out[0][input_len:], skip_special_tokens=True).strip()
            return text, None
        except Exception as e:
            log.error(f"Transcription error: {e}")
            return None, str(e)

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        log.info("%s - %s", self.client_address[0], fmt % args)

    def do_GET(self):
        if self.path == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                'status': 'ok' if model is not None else 'loading',
                'model': MODEL_ID,
                'vram': _vram_usage(),
            }).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path != '/transcribe':
            self.send_response(404); self.end_headers(); return
        try:
            length = int(self.headers.get('Content-Length', 0))
            if length <= 0 or length > 100 * 1024 * 1024:
                self.send_response(400); self.end_headers()
                self.wfile.write(b'{"error":"invalid size"}'); return
            audio_bytes = self.rfile.read(length)
            log.info(f"Received {length} bytes")
            text, err = transcribe(audio_bytes)
            if err:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'error': err}).encode()); return
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'text': text}, ensure_ascii=False).encode('utf-8'))
        except Exception as e:
            log.error(f"Handler error: {e}")
            try:
                self.send_response(500); self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode())
            except Exception: pass

def main():
    log.info(f"Transcribe Server starting on :{PORT}")
    load_model()
    server = HTTPServer(('0.0.0.0', PORT), Handler)
    log.info(f"Listening on 0.0.0.0:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Shutting down")
        server.server_close()

if __name__ == '__main__':
    main()
