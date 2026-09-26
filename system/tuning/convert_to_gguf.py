#!/usr/bin/env python3
"""
convert_to_gguf.py - マージ済みモデルをGGUFに変換し量子化する

ファインチューニング後のマージモデル（HuggingFace形式）を
llama.cpp の convert_hf_to_gguf.py で GGUF 形式に変換し、
さらに llama-quantize で量子化する。

事前条件:
- llama.cpp が ~/llama.cpp にクローン+ビルド済み
- convert_hf_to_gguf.py の実行に必要な依存（gguf, sentencepiece等）が
  入った venv が ~/llama.cpp/.venv-llama にある（推奨）
- llama-quantize バイナリが ~/llama.cpp/build/bin/llama-quantize にある

実行:
    python system/tuning/convert_to_gguf.py <merged_dir> <out_dir> [--quant Q4_K_M] [--no-quantize]

ナレッジ:
- 小さいモデル（0.5B〜1.5B）はQ8_0またはF16推奨
- 7B以上ならQ4_K_M
- 強い量子化（Q4_K_M）を小さいモデルにかけると知識劣化
"""

import argparse
import os
import subprocess
import sys
import shutil
from pathlib import Path


def log(msg):
    import time
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def find_llama_cpp():
    """llama.cpp のパスを推測"""
    candidates = [
        Path.home() / "llama.cpp",
        Path("/home/wizapply-ai/llama.cpp"),
        Path("/opt/llama.cpp"),
    ]
    env = os.environ.get("LLAMA_CPP_DIR")
    if env:
        candidates.insert(0, Path(env))
    for c in candidates:
        if c.is_dir() and (c / "convert_hf_to_gguf.py").exists():
            return c
    return None


def main():
    parser = argparse.ArgumentParser(description="GGUF変換＆量子化")
    parser.add_argument("merged_dir", help="マージ済みモデルのHFディレクトリ")
    parser.add_argument("out_dir", help="出力ディレクトリ")
    parser.add_argument("--quant", default="Q4_K_M",
                        help="量子化レベル: F16, Q8_0, Q6_K, Q5_K_M, Q4_K_M (default: Q4_K_M)")
    parser.add_argument("--no-quantize", action="store_true",
                        help="GGUF変換のみ。量子化しない (F16出力)")
    parser.add_argument("--llama-cpp-dir", help="llama.cppディレクトリのパス")
    parser.add_argument("--python", help="convert_hf_to_gguf.py 用のpython（venv推奨）")
    args = parser.parse_args()

    merged_dir = Path(args.merged_dir).resolve()
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    if not merged_dir.exists():
        log(f"ERROR: マージ済みディレクトリが見つかりません: {merged_dir}")
        sys.exit(1)

    llama_cpp = Path(args.llama_cpp_dir).resolve() if args.llama_cpp_dir else find_llama_cpp()
    if not llama_cpp or not llama_cpp.exists():
        log("ERROR: llama.cpp ディレクトリが見つかりません")
        log("環境変数 LLAMA_CPP_DIR を設定するか --llama-cpp-dir で指定してください")
        sys.exit(1)
    log(f"llama.cpp: {llama_cpp}")

    convert_script = llama_cpp / "convert_hf_to_gguf.py"
    if not convert_script.exists():
        log(f"ERROR: {convert_script} が見つかりません")
        sys.exit(1)

    # Python実行パス
    python_bin = args.python
    if not python_bin:
        # venv候補を探す
        for candidate in [llama_cpp / ".venv-llama" / "bin" / "python",
                          llama_cpp / ".venv" / "bin" / "python",
                          llama_cpp / "venv" / "bin" / "python"]:
            if candidate.exists():
                python_bin = str(candidate)
                log(f"convert用venv検出: {python_bin}")
                break
        if not python_bin:
            python_bin = sys.executable
            log(f"convert用venv未検出。現在のpython使用: {python_bin}")

    quantize_bin = llama_cpp / "build" / "bin" / "llama-quantize"
    if not args.no_quantize and not quantize_bin.exists():
        log(f"ERROR: {quantize_bin} が見つかりません")
        log("llama.cpp をビルドしてください: cmake -B build && cmake --build build -j")
        sys.exit(1)

    # ─── Step 1: GGUF変換（F16中間ファイル） ───
    f16_path = out_dir / "model-F16.gguf"
    log("")
    log("=" * 60)
    log(f"Step 1: GGUF変換 (F16) → {f16_path}")
    log("=" * 60)
    cmd = [
        python_bin, str(convert_script),
        str(merged_dir),
        "--outfile", str(f16_path),
        "--outtype", "f16",
    ]
    log(f"$ {' '.join(cmd)}")
    proc = subprocess.run(cmd, cwd=str(llama_cpp))
    if proc.returncode != 0:
        log(f"ERROR: GGUF変換に失敗 (code={proc.returncode})")
        sys.exit(proc.returncode)
    log(f"✅ F16 GGUF生成完了: {f16_path}")

    if args.no_quantize:
        log("")
        log("--no-quantize 指定のため量子化をスキップします")
        return

    # ─── Step 2: 量子化 ───
    quant_path = out_dir / f"model-{args.quant}.gguf"
    log("")
    log("=" * 60)
    log(f"Step 2: 量子化 ({args.quant}) → {quant_path}")
    log("=" * 60)
    cmd = [str(quantize_bin), str(f16_path), str(quant_path), args.quant]
    log(f"$ {' '.join(cmd)}")
    proc = subprocess.run(cmd)
    if proc.returncode != 0:
        log(f"ERROR: 量子化に失敗 (code={proc.returncode})")
        sys.exit(proc.returncode)
    log(f"✅ 量子化完了: {quant_path}")

    # サイズ表示
    log("")
    log("─── 生成ファイル ───")
    for p in [f16_path, quant_path]:
        if p.exists():
            size_mb = p.stat().st_size / (1024 * 1024)
            log(f"  {p.name}: {size_mb:,.1f} MB")

    log("")
    log("=" * 60)
    log("✅ 完了")
    log("=" * 60)
    log("")
    log("次のステップ:")
    log("- config.json の chatModels に GGUF パスを追加")
    log(f"  {{\"name\": \"my-tuned\", \"path\": \"{quant_path}\", \"ctx\": 4096, \"ngl\": 99}}")
    log("- OpenGeekLLMChat を再起動")


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
