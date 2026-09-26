#!/usr/bin/env python3
"""
merge_adapter.py - LoRAアダプタをベースモデルにマージ

実行:
    python system/tuning/merge_adapter.py <job_dir>

入力:
    <job_dir>/config.json      - baseModel を読み取る
    <job_dir>/adapter/         - tune_runner.py が出力したLoRAアダプタ

出力:
    <job_dir>/merged/          - マージ済みフルモデル（GGUF変換用）
"""

import json
import sys
import time
from pathlib import Path


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def main():
    if len(sys.argv) < 2:
        log("使い方: python system/tuning/merge_adapter.py <job_dir>")
        sys.exit(1)

    job_dir = Path(sys.argv[1]).resolve()
    config = json.loads((job_dir / "config.json").read_text(encoding="utf-8"))
    base_model = config["baseModel"]
    adapter_dir = job_dir / "adapter"
    merged_dir = job_dir / "merged"

    if not adapter_dir.exists():
        log(f"ERROR: アダプタが存在しません: {adapter_dir}")
        log("先に tune_runner.py で学習を完了してください")
        sys.exit(1)

    log(f"=== マージ開始 ===")
    log(f"ベースモデル: {base_model}")
    log(f"アダプタ:    {adapter_dir}")
    log(f"出力:        {merged_dir}")

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import PeftModel

    log("ベースモデル読み込み中...")
    tokenizer = AutoTokenizer.from_pretrained(base_model, trust_remote_code=True)
    base = AutoModelForCausalLM.from_pretrained(
        base_model,
        dtype=torch.bfloat16,
        trust_remote_code=True,
    )

    log("アダプタ適用中...")
    model = PeftModel.from_pretrained(base, str(adapter_dir))

    log("マージ実行中...")
    merged = model.merge_and_unload()

    log(f"保存中: {merged_dir}")
    merged.save_pretrained(str(merged_dir), safe_serialization=True)
    tokenizer.save_pretrained(str(merged_dir))

    log("=== マージ完了 ===")
    log("")
    log("次のステップ: GGUF変換")
    log(f"  cd ~/llama.cpp")
    log(f"  python convert_hf_to_gguf.py {merged_dir} \\")
    log(f"      --outfile {job_dir}/{config.get('outputName', 'tuned-model')}.gguf \\")
    log(f"      --outtype f16")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        log(f"ERROR: {type(e).__name__}: {e}")
        traceback.print_exc()
        sys.exit(1)
