# 音声認識 (Gemma 4 E2B) セットアップ

OpenGeekLLMChatの音声認識機能は、`transcribe-server.py`（Python）が独立して動作します。
Gemma 4 E2B を使用した日本語音声→テキスト変換を行います。

## 必要環境

- NVIDIA GPU（VRAM 10GB以上推奨、fp16で約9.5GB使用）
- CUDA対応のPyTorch
- Python 3.10以上
- ffmpeg（音声フォーマット変換用）

## セットアップ手順

### 1. システムパッケージ

```bash
# Ubuntu/Debian
sudo apt install -y ffmpeg python3-venv

# macOS
brew install ffmpeg
```

### 2. venv作成（推奨）

```bash
cd opengeek-llm-chat
python3 -m venv .venv-transcribe
source .venv-transcribe/bin/activate
```

### 3. Pythonパッケージインストール

```bash
# PyTorch + torchvision（CUDA 12.1の場合、環境に合わせて変更）
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121

# --- AMD Radeon (ROCm) の場合 ---
# pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/rocm6.2
# pip install "numpy<2.0"
# （RX 6600等は HSA_OVERRIDE_GFX_VERSION=10.3.0 環境変数が必要な場合あり）

# Transformers + 依存
pip install "transformers>=4.50.0" accelerate numpy scipy

# Gemma 4のマルチモーダル処理に必要
pip install pillow librosa soundfile

# Gemma 4は最新のtransformersが必要な場合があります
# 動かない場合は以下を試してください
# pip install git+https://github.com/huggingface/transformers.git
```

### 4. HuggingFaceログイン（Gemmaモデルはライセンス承諾が必要）

```bash
pip install "huggingface_hub[cli]"
hf auth login  # 旧: huggingface-cli login (パッケージ更新で hf に統合)
# https://huggingface.co/google/gemma-4-E2B-it でライセンス承諾が必要
```

### 5. 起動

```bash
# フォアグラウンド
source .venv-transcribe/bin/activate
python3 system/voice/transcribe-server.py

# ポート変更
python3 system/voice/transcribe-server.py 12000

# CPU強制
TRANSCRIBE_DEVICE=cpu python3 system/voice/transcribe-server.py
```

初回起動時にモデルがダウンロードされます（約5GB）。起動後は常駐し、VRAMを約9.5GB占有します。

### 6. systemd自動起動（Linux本番環境）

```bash
sudo tee /etc/systemd/system/opengeek-transcribe.service << EOF
[Unit]
Description=OpenGeekLLMChat Transcribe Server
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$(pwd)
ExecStart=$(pwd)/.venv-transcribe/bin/python3 $(pwd)/system/voice/transcribe-server.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now opengeek-transcribe
```

## config.json

OpenGeekLLMChat 側で有効化:

```json
"transcribe": {
  "enabled": true,
  "host": "127.0.0.1",
  "port": 11500
}
```

## 動作確認

```bash
# ヘルスチェック
curl http://127.0.0.1:11500/health
# → {"status": "ok", "model": "google/gemma-4-E2B-it", "vram": "9.5GB / 16.0GB"}

# OpenGeekLLMChat経由のヘルスチェック
curl http://127.0.0.1:3000/transcribe/health \
  -H "Cookie: wz_session=..."
```

## 使い方（ブラウザ）

1. 入力エリア下の 🎤 ボタンをクリック
2. ブラウザがマイク許可を求めるので許可
3. 🔴 が表示されて録音中（脈打つ赤枠）
4. もう一度ボタンをクリックして録音停止
5. ⏳ 変換中表示 → 認識されたテキストが入力欄に反映

## トラブルシューティング

### モデルが見つからない

```
OSError: google/gemma-4-E2B-it does not appear to be a valid repository
```

→ HuggingFaceでGemma 4 E2Bのライセンス承諾が必要です。
   https://huggingface.co/google/gemma-4-E2B-it を開いて「Access repository」を承諾してください。

### VRAM不足

```
torch.cuda.OutOfMemoryError
```

→ llama-serverが大きなモデルを常駐させている場合があります。以下を試してください:
- `config.json` に `"llamaServer": { "idleUnloadMs": 600000 }` を設定してアイドル時に自動アンロード
- より小さいチャットモデルを使う
- CPUに移行: `TRANSCRIBE_DEVICE=cpu python3 system/voice/transcribe-server.py`（ただし遅い）

### transformersでaudio入力が未対応エラー

```
ValueError: audio input type is not supported
```

→ transformers が古い可能性があります:
```bash
pip install -U transformers
# または
pip install git+https://github.com/huggingface/transformers.git
```

### 音声が認識されない

- マイクの音量を確認
- `/tmp` にffmpegのエラーが出ていないか確認
- `transcribe-server.py` のログを確認

## パフォーマンス

RTX 4070 Ti Super（16GB）での実測（記事参照）:

| 音声長 | 推論時間 |
|:--|:--|
| 5秒 | 0.3〜1.8秒 |
| 30秒 | 2〜5秒 |
| 60秒 | 5〜10秒 |

長時間録音は記事の「リアルタイム文字起こし」方式のほうが効率的ですが、
シンプルな録音停止時一括変換のほうが実装がシンプルで安定します。
