"""使用独立 llama.cpp CPU 运行时对照测试混元翻译与 PDF 回填。"""

import argparse
from collections import Counter
import hashlib
import importlib.util
import json
import logging
from pathlib import Path
import re
import socket
import subprocess
import time
import urllib.request

import psutil


ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / ".zotero-dev/hy-mt"


def placeholder_counts(text):
    return Counter(re.sub(r"\s", "", token).lower() for token in re.findall(r"\{\s*v\s*\d+\s*\}", text, re.I))


class HunyuanWorker:
    name = "hymt2_local_trial"
    model = "Hy-MT2-1.8B-Q4_K_M"

    def __init__(self, port, output, process):
        self.url = f"http://127.0.0.1:{port}/v1/chat/completions"
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.records = []
        self.output = output
        self.process = process

    def translate(self, text):
        prompt = (
            "将以下英文文本翻译为简体中文，只输出译文，不要额外解释。"
            "原文中的 {v数字} 是公式或引文标记，必须逐一原样保留，不得遗漏、重复或更改编号。\n\n" + text
        )
        request = urllib.request.Request(self.url, data=json.dumps({
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.7, "top_p": 0.6, "top_k": 20, "repeat_penalty": 1.05,
            "seed": 42, "max_tokens": 2048, "stream": False, "cache_prompt": False,
        }).encode(), headers={"Content-Type": "application/json"})
        started = time.monotonic()
        with self.opener.open(request, timeout=300) as response:
            data = json.load(response)
        message = data["choices"][0]["message"]
        result = message.get("content") or ""
        if not result.strip() or data["choices"][0].get("finish_reason") == "length":
            raise RuntimeError("混元返回空结果或输出达到长度限制")
        record = {
            "input": text, "output": result, "seconds": time.monotonic() - started,
            "usage": data.get("usage"), "timings": data.get("timings"),
            "placeholder_ids_preserved": placeholder_counts(text) == placeholder_counts(result),
            "reasoning_content": message.get("reasoning_content"),
            "peak_working_set": self.process.memory_info().peak_wset,
        }
        self.records.append(record)
        with (self.output / "hymt-calls.jsonl").open("a", encoding="utf-8") as log:
            log.write(json.dumps(record, ensure_ascii=False) + "\n")
        print(f"Call {len(self.records)}: {record['seconds']:.2f}s, placeholders={record['placeholder_ids_preserved']}", flush=True)
        return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", type=Path)
    parser.add_argument("--pages", default="1-3")
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--model", type=Path, default=RUNTIME / "Hy-MT2-1.8B-Q4_K_M.gguf")
    parser.add_argument("--runtime", type=Path, default=RUNTIME / "runtime/llama-server.exe")
    parser.add_argument("--output", type=Path, default=ROOT / "output/pdf/pdf2zh-hymt-sample")
    args = parser.parse_args()
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(filename=args.output / "pipeline.log", level=logging.INFO, encoding="utf-8")
    model = args.model.resolve()
    with socket.socket() as allocation:
        allocation.bind(("127.0.0.1", 0))
        port = allocation.getsockname()[1]
    server_log = (args.output / "llama-server.log").open("w", encoding="utf-8")
    help_result = subprocess.run([str(args.runtime.resolve()), "--help"], capture_output=True, text=True,
                                 encoding="utf-8", errors="replace", creationflags=subprocess.CREATE_NO_WINDOW)
    runtime_help = help_result.stdout + help_result.stderr
    optional_flags = []
    if "--reasoning " in runtime_help:
        optional_flags += ["--reasoning", "off"]
    if "--offline" in runtime_help:
        optional_flags += ["--offline"]
    process = subprocess.Popen([
        str(args.runtime.resolve()), "--model", str(model),
        "--host", "127.0.0.1", "--port", str(port), "--threads", str(args.threads),
        "--threads-batch", str(args.threads), "--ctx-size", "4096", "--parallel", "1",
        "--n-gpu-layers", "0", "--jinja",
    ] + optional_flags, stdout=server_log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
    native = psutil.Process(process.pid)
    worker = HunyuanWorker(port, args.output, native)
    worker.model = model.stem
    started = time.monotonic()
    try:
        for attempt in range(120):
            if process.poll() is not None:
                raise RuntimeError("llama.cpp 启动失败，请检查 llama-server.log")
            try:
                with worker.opener.open(f"http://127.0.0.1:{port}/health", timeout=1) as response:
                    if response.status == 200:
                        break
            except Exception:
                time.sleep(0.5)
        else:
            raise RuntimeError("模型加载超时")
        ready_seconds = time.monotonic() - started
        print(f"Model ready: {ready_seconds:.2f}s", flush=True)
        print("Warmup:", worker.translate("The experiment did not show a significant increase in pressure."), flush=True)
        warmup = worker.records.pop()
        measured_start = time.monotonic()
        if args.pdf:
            args.pdf = args.pdf.resolve()
            original_hash = hashlib.sha256(args.pdf.read_bytes()).hexdigest()
            spec = importlib.util.spec_from_file_location("pdf_trial", ROOT / "scripts/pdf2zh-edge-trial.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            module.translate_pdf(args, worker)
            if hashlib.sha256(args.pdf.read_bytes()).hexdigest() != original_hash:
                raise RuntimeError("试验期间原 PDF 已变化")
        else:
            records = [json.loads(line) for line in (ROOT / "output/pdf/pdf2zh-edge-sample/edge-calls.jsonl").read_text(encoding="utf-8").splitlines()]
            for record in records:
                worker.translate(record["input"])
        elapsed = time.monotonic() - measured_start
        token_count = sum((r.get("usage") or {}).get("completion_tokens", 0) for r in worker.records)
        translation_seconds = sum(r["seconds"] for r in worker.records)
        summary = {
            "model": worker.model, "threads": args.threads, "gpu_layers": 0, "context": 4096,
            "runtime": str(args.runtime.resolve()),
            "model_ready_seconds": ready_seconds, "calls": len(worker.records),
            "translation_seconds": translation_seconds, "measured_seconds": elapsed,
            "completion_tokens": token_count, "completion_tokens_per_wall_second": token_count / translation_seconds,
            "placeholder_integrity_failures": sum(not r["placeholder_ids_preserved"] for r in worker.records),
            "peak_working_set": native.memory_info().peak_wset, "warmup": warmup,
        }
        (args.output / "run.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
        server_log.close()


if __name__ == "__main__":
    main()
