#!/usr/bin/env python3
"""
tune_runner.py - LoRA SFT トレーニング実行スクリプト

ナレッジ反映:
- TRL の SFTTrainer + SFTConfig 使用（標準）
- ROCm/AMD GPU 対応（attn_implementation="eager", device_map=cuda）
- dtype=torch.bfloat16（torch_dtype は deprecated）
- マルチターン (messages形式) とシングルターン (instruction/output) 両対応
- 環境変数で GPU 選択可能（HIP_VISIBLE_DEVICES）
- 学習後の自動マージ機能

実行:
    python system/tuning/tune_runner.py /path/to/job_dir

ジョブディレクトリ構成（入力）:
    config.json   - 学習設定
    train.jsonl   - 学習データ

出力:
    adapter/      - LoRAアダプタ
    merged/       - マージ済みフルモデル（mergeAdapter=true時、デフォルト）
    training.log  - サーバー側で stdout/stderr リダイレクト

依存:
    pip install --pre torch --index-url https://download.pytorch.org/whl/nightly/rocm7.0  # AMD
    pip install transformers datasets peft trl accelerate sentencepiece
"""

import json
import os
import sys
import time
from pathlib import Path


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def load_config(job_dir):
    with open(job_dir / "config.json", "r", encoding="utf-8") as f:
        return json.load(f)


def load_samples(job_dir):
    """train.jsonl を読み込む。
    各サンプルは以下のいずれかの形式:
      A) {"instruction": "...", "response": "...", "system": "..."}  - サーバー保存形式
      B) {"messages": [{"role": "user", "content": "..."}, ...]}     - マルチターン
    """
    samples = []
    with open(job_dir / "train.jsonl", "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            samples.append(json.loads(line))
    return samples


def to_messages(sample, default_system):
    """サンプルを messages 形式に統一"""
    if "messages" in sample and sample["messages"]:
        messages = list(sample["messages"])
        if not messages or messages[0].get("role") != "system":
            if default_system:
                messages = [{"role": "system", "content": default_system}] + messages
        return messages

    response = sample.get("response") or sample.get("output") or ""
    instruction = sample.get("instruction", "")
    system = sample.get("system", "") or default_system

    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": instruction})
    messages.append({"role": "assistant", "content": response})
    return messages


def main():
    if len(sys.argv) < 2:
        log("ERROR: ジョブディレクトリが指定されていません")
        log("使い方: python system/tuning/tune_runner.py <job_dir>")
        sys.exit(1)

    job_dir = Path(sys.argv[1]).resolve()
    if not job_dir.exists():
        log(f"ERROR: ジョブディレクトリが存在しません: {job_dir}")
        sys.exit(1)

    log("=" * 60)
    log("OpenGeekLLM Fine-Tuning: LoRA SFT トレーニング")
    log("=" * 60)
    log(f"ジョブディレクトリ: {job_dir}")

    config = load_config(job_dir)
    log(f"設定:\n{json.dumps(config, ensure_ascii=False, indent=2)}")

    samples = load_samples(job_dir)
    log(f"学習サンプル数: {len(samples)}")
    if len(samples) == 0:
        log("ERROR: 学習サンプルが空です")
        sys.exit(1)

    # ─── ライブラリの遅延 import ───
    try:
        import torch
        from transformers import AutoTokenizer, AutoModelForCausalLM
        from peft import LoraConfig
        from trl import SFTTrainer, SFTConfig
        from datasets import Dataset
    except ImportError as e:
        log(f"ERROR: 必要なライブラリが不足: {e}")
        log("インストール例:")
        log("  AMD ROCm:  pip install --pre torch --index-url https://download.pytorch.org/whl/nightly/rocm7.0")
        log("  NVIDIA:    pip install torch --index-url https://download.pytorch.org/whl/cu121")
        log("  共通:      pip install transformers datasets peft trl accelerate sentencepiece")
        sys.exit(2)

    # ─── GPU 確認 ───
    log("")
    log("─── GPU環境 ───")
    log(f"PyTorch: {torch.__version__}")
    if hasattr(torch.version, "hip") and torch.version.hip:
        log(f"HIP version: {torch.version.hip}")
    if hasattr(torch.version, "cuda") and torch.version.cuda:
        log(f"CUDA version: {torch.version.cuda}")
    log(f"CUDA/ROCm利用可能: {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        for i in range(torch.cuda.device_count()):
            log(f"  GPU {i}: {torch.cuda.get_device_name(i)}")
    else:
        log("WARNING: GPUが利用できません。CPU実行は非常に遅いです。")

    log("")
    log("─── 重要な環境変数 ───")
    for var in ["HIP_VISIBLE_DEVICES", "CUDA_VISIBLE_DEVICES",
                "HSA_OVERRIDE_GFX_VERSION", "PYTORCH_HIP_ALLOC_CONF",
                "HF_HOME", "HF_TOKEN"]:
        val = os.environ.get(var)
        if val:
            display = val if var != "HF_TOKEN" else val[:6] + "..." + val[-4:]
            log(f"  {var}={display}")

    # ─── トークナイザー ───
    base_model = config["baseModel"]
    log("")
    log(f"─── トークナイザー読み込み: {base_model} ───")
    tokenizer = AutoTokenizer.from_pretrained(base_model, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    log(f"  vocab_size: {tokenizer.vocab_size}")
    log(f"  chat_template: {'有り' if tokenizer.chat_template else '無し（Alpaca形式にフォールバック）'}")

    # ─── モデル読み込み ───
    method = config.get("method", "lora")
    log("")
    log(f"─── モデル読み込み: {base_model} (method={method}) ───")
    log("これには数分かかります（初回はダウンロードが必要）...")

    model_kwargs = dict(
        trust_remote_code=True,
        dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32,
        attn_implementation="eager",  # ROCm環境ではsdpaで問題が出るケースあり
    )

    if method == "qlora":
        try:
            from transformers import BitsAndBytesConfig
            from peft import prepare_model_for_kbit_training
            bnb_config = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_compute_dtype=torch.bfloat16,
                bnb_4bit_use_double_quant=True,
                bnb_4bit_quant_type="nf4",
            )
            model_kwargs["quantization_config"] = bnb_config
        except ImportError:
            log("WARNING: bitsandbytes が見つからないため QLoRA → LoRA に変更します")
            method = "lora"

    model = AutoModelForCausalLM.from_pretrained(base_model, **model_kwargs)
    if torch.cuda.is_available():
        model = model.to("cuda")

    if method == "qlora":
        from peft import prepare_model_for_kbit_training
        model = prepare_model_for_kbit_training(model)

    # ─── データセット ───
    log("")
    log("─── データセット準備 ───")
    default_system = config.get("defaultSystem", "")
    formatted = []
    for s in samples:
        messages = to_messages(s, default_system)
        if tokenizer.chat_template:
            text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=False)
        else:
            parts = []
            for m in messages:
                role = m["role"]
                content = m["content"]
                if role == "system":
                    parts.append(f"### System:\n{content}")
                elif role == "user":
                    parts.append(f"### Instruction:\n{content}")
                elif role == "assistant":
                    parts.append(f"### Response:\n{content}")
            text = "\n\n".join(parts)
        formatted.append({"text": text})

    dataset = Dataset.from_list(formatted)
    log(f"  最終データセット件数: {len(dataset)}")
    preview = formatted[0]["text"][:300]
    log(f"  サンプル先頭:\n{preview}{'...' if len(formatted[0]['text']) > 300 else ''}")

    # ─── LoRA設定 ───
    log("")
    log("─── LoRA設定 ───")
    if method in ("lora", "qlora"):
        peft_config = LoraConfig(
            r=int(config.get("loraR", 16)),
            lora_alpha=int(config.get("loraAlpha", 32)),
            lora_dropout=0.05,
            bias="none",
            task_type="CAUSAL_LM",
            target_modules=[
                "q_proj", "k_proj", "v_proj", "o_proj",
                "gate_proj", "up_proj", "down_proj",
            ],
        )
        log(f"  r={peft_config.r}, alpha={peft_config.lora_alpha}, dropout={peft_config.lora_dropout}")
    else:
        peft_config = None
        log("  フルファインチューニング（LoRA無効）")

    # ─── トレーニング設定 ───
    output_dir = job_dir / "checkpoints"
    output_dir.mkdir(exist_ok=True)
    log("")
    log("─── トレーニング設定 ───")
    log(f"  output_dir: {output_dir}")
    log(f"  epochs: {config.get('epochs', 3)}")
    log(f"  batch_size: {config.get('batchSize', 2)}")
    log(f"  grad_accum_steps: {config.get('gradAccumSteps', 4)}")
    log(f"  learning_rate: {config.get('learningRate', 2e-4)}")
    log(f"  max_length: {config.get('maxSeqLength', 2048)}")

    sft_args = SFTConfig(
        output_dir=str(output_dir),
        num_train_epochs=int(config.get("epochs", 3)),
        per_device_train_batch_size=int(config.get("batchSize", 2)),
        gradient_accumulation_steps=int(config.get("gradAccumSteps", 4)),
        learning_rate=float(config.get("learningRate", 2e-4)),
        warmup_steps=10,
        logging_steps=5,
        save_strategy="epoch",
        save_total_limit=1,
        bf16=torch.cuda.is_available(),
        gradient_checkpointing=True,
        max_length=int(config.get("maxSeqLength", 2048)),
        dataset_text_field="text",
        packing=False,
        report_to="none",
        remove_unused_columns=False,
    )

    log("")
    log("─── トレーニング開始 ───")
    trainer = SFTTrainer(
        model=model,
        args=sft_args,
        train_dataset=dataset,
        peft_config=peft_config,
        processing_class=tokenizer,
    )

    trainer.train()

    log("")
    log("─── トレーニング完了 ───")

    # ─── アダプタ保存 ───
    adapter_dir = job_dir / "adapter"
    log(f"アダプタ保存: {adapter_dir}")
    trainer.model.save_pretrained(str(adapter_dir))
    tokenizer.save_pretrained(str(adapter_dir))

    # ─── マージ（オプション、デフォルトON）───
    if config.get("mergeAdapter", True) and method in ("lora", "qlora"):
        log("")
        log("─── ベースモデルへマージ ───")
        try:
            from peft import PeftModel
            del trainer
            del model
            import gc
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

            log("ベースモデルを再読み込み中...")
            base = AutoModelForCausalLM.from_pretrained(
                base_model,
                trust_remote_code=True,
                dtype=torch.bfloat16,
            )
            log("アダプタを適用してマージ中...")
            peft_model = PeftModel.from_pretrained(base, str(adapter_dir))
            merged = peft_model.merge_and_unload()

            merged_dir = job_dir / "merged"
            merged.save_pretrained(str(merged_dir), safe_serialization=True)
            tokenizer.save_pretrained(str(merged_dir))
            log(f"マージ済みモデル: {merged_dir}")
        except Exception as e:
            log(f"WARNING: マージに失敗: {e}")
            log("アダプタは保存済みなので、後で手動でマージできます")

    log("")
    log("=" * 60)
    log("✅ すべて完了")
    log("=" * 60)
    log(f"アダプタ:    {adapter_dir}")
    if (job_dir / "merged").exists():
        log(f"マージ済み:  {job_dir / 'merged'}")
        log("")
        log("次のステップ（GGUF変換、サーバーUIから可能）:")
        log(f"  python llama.cpp/convert_hf_to_gguf.py {job_dir / 'merged'} \\")
        log(f"    --outfile {job_dir}/model.gguf --outtype f16")
        log(f"  llama-quantize {job_dir}/model.gguf {job_dir}/model-Q4_K_M.gguf Q4_K_M")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("中断されました")
        sys.exit(130)
    except Exception as e:
        import traceback
        log(f"ERROR: {type(e).__name__}: {e}")
        traceback.print_exc()
        sys.exit(1)
