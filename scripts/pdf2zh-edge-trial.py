"""独立试验：复用 pdf2zh 普通机翻管道，仅替换文本翻译传输。"""

import argparse
import concurrent.futures
from contextlib import contextmanager
import hashlib
import json
import logging
import os
from pathlib import Path
import queue
import re
import shutil
import socket
import subprocess
import threading
import time


ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / ".zotero-dev" / "pdf2zh-edge"


def prepare_profile(source: Path, destination: Path):
    destination.mkdir(parents=True, exist_ok=True)
    for name in ("EdgeTranslateKitLanguagePack", "EdgeLLMRuntime"):
        if not (destination / name).exists():
            shutil.copytree(source / name, destination / name)
    state = json.loads((source / "Local State").read_text(encoding="utf-8"))
    # 仅复制本地模型注册信息，不复制浏览器会话、账号和文献数据。
    selected = {key: state[key] for key in ("edge_llm", "edge_translate_kit") if key in state}
    serialized = json.dumps(selected).replace(
        json.dumps(str(source))[1:-1], json.dumps(str(destination))[1:-1]
    )
    (destination / "Local State").write_text(serialized, encoding="utf-8")


@contextmanager
def open_edge(playwright, profile):
    executable = Path(os.environ.get("PROGRAMFILES(X86)", "C:/Program Files (x86)")) / "Microsoft/Edge/Application/msedge.exe"
    with socket.socket() as port_socket:
        port_socket.bind(("127.0.0.1", 0))
        port = port_socket.getsockname()[1]
    # Playwright 的默认参数会禁用 Translate；沿用插件的最小启动参数。
    process = subprocess.Popen([
        str(executable), "--headless=new", f"--user-data-dir={profile}",
        f"--remote-debugging-port={port}", "--remote-debugging-address=127.0.0.1",
        "--no-first-run", "--no-default-browser-check", "--disable-extensions", "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
    browser = None
    try:
        for attempt in range(80):
            try:
                browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{port}", timeout=1000)
                break
            except Exception:
                time.sleep(0.1)
        if browser is None:
            raise RuntimeError("Edge debugging endpoint did not start")
        yield browser.contexts[0]
    finally:
        if browser:
            try:
                browser.close()
            except Exception:
                pass
        import psutil
        for candidate in psutil.process_iter(["pid", "name", "cmdline"]):
            try:
                if candidate.info["name"].lower() == "msedge.exe" and f"--user-data-dir={profile}" in (candidate.info["cmdline"] or []):
                    for child in candidate.children(recursive=True):
                        child.terminate()
                    candidate.terminate()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.terminate()


class EdgeWorker:
    def __init__(self, profile: Path, log_path: Path):
        self.profile = profile
        self.log_path = log_path
        self.jobs = queue.Queue()
        self.ready = concurrent.futures.Future()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.calls = 0
        self.thread.start()
        self.ready.result(timeout=120)

    def run(self):
        from playwright.sync_api import sync_playwright

        try:
            with sync_playwright() as playwright:
                with open_edge(playwright, self.profile) as context:
                    page = context.pages[0]
                    host = self.profile / "translator-host.html"
                    host.write_text("<!doctype html><meta charset=utf-8><button id=start>Start</button>", encoding="utf-8")
                    page.goto(host.as_uri())
                    availability = page.evaluate("typeof Translator === 'undefined' ? 'missing' : Translator.availability({sourceLanguage:'en',targetLanguage:'zh-Hans'})")
                    print(f"Edge availability: {availability}", flush=True)
                    if availability == "missing" or availability == "unavailable":
                        raise RuntimeError(f"Edge Translator unavailable: {availability}")
                    page.evaluate("""() => { window.started=false; window.startError='';
                      document.querySelector('#start').onclick=async()=>{
                        try {window.translator=await Translator.create({sourceLanguage:'en',targetLanguage:'zh-Hans'});window.started=true}
                        catch(e){window.startError=String(e)}
                      }}""")
                    page.locator("#start").click()
                    page.wait_for_function("window.started || window.startError", timeout=90000)
                    if error := page.evaluate("window.startError"):
                        raise RuntimeError(error)
                    # 模型初始化后禁止页面联网，再执行实际翻译。
                    context.set_offline(True)
                    context.route("http://**/*", lambda route: route.abort())
                    context.route("https://**/*", lambda route: route.abort())
                    self.ready.set_result(True)
                    with self.log_path.open("w", encoding="utf-8") as log:
                        while (job := self.jobs.get()) is not None:
                            text, future = job
                            started = time.monotonic()
                            try:
                                result = page.evaluate("text => window.translator.translate(text)", text)
                                if not isinstance(result, str) or not result.strip():
                                    raise RuntimeError("Edge returned empty translation")
                                placeholders = re.findall(r"\{\s*v\s*\d+\s*\}", text)
                                record = {"input": text, "output": result, "seconds": round(time.monotonic()-started, 3),
                                          "offline": True, "placeholder_exact": all(result.count(p) == text.count(p) for p in placeholders)}
                                self.calls += 1
                                log.write(json.dumps(record, ensure_ascii=False) + "\n")
                                log.flush()
                                future.set_result(result)
                            except Exception as error:
                                log.write(json.dumps({"input": text, "error": str(error)}, ensure_ascii=False) + "\n")
                                log.flush()
                                future.set_exception(error)
        except BaseException as error:
            if not self.ready.done():
                self.ready.set_exception(error)
            else:
                while not self.jobs.empty():
                    job = self.jobs.get_nowait()
                    if job is not None:
                        job[1].set_exception(error)
                logging.exception("Edge worker failed")

    def translate(self, text):
        future = concurrent.futures.Future()
        self.jobs.put((text, future))
        return future.result(timeout=150)

    def close(self):
        self.jobs.put(None)
        self.thread.join(timeout=15)


def translate_pdf(args, worker):
    from pdf2zh_next.config.model import SettingsModel
    from pdf2zh_next.translator.base_translator import BaseTranslator
    from pdf2zh_next.translator.rate_limiter.qps_rate_limiter import QPSRateLimiter
    from pdf2zh_next import high_level
    from babeldoc.format.pdf.high_level import translate

    class EdgeTranslator(BaseTranslator):
        name = getattr(worker, "name", "edge_local_trial")
        model = getattr(worker, "model", "edge-translator-api")

        def do_translate(self, text, rate_limit_params=None):
            return worker.translate(text)

    settings = SettingsModel(translate_engine_settings=None)
    settings.basic.debug = False
    settings.translation.lang_in = "en"
    settings.translation.lang_out = "zh"
    settings.translation.output = str(args.output)
    settings.translation.ignore_cache = True
    settings.translation.no_auto_extract_glossary = True
    settings.translation.qps = 4
    settings.translation.pool_max_workers = 1
    settings.pdf.watermark_output_mode = "no_watermark"
    settings.pdf.skip_scanned_detection = True
    settings.pdf.auto_enable_ocr_workaround = False
    settings.pdf.pages = args.pages
    settings.pdf.only_include_translated_page = bool(args.pages)
    translator = EdgeTranslator(settings, QPSRateLimiter(4))
    # 仅替换本进程的翻译器工厂，配置转换和排版均使用上游代码。
    high_level.get_translator = lambda _: translator
    config = high_level.create_babeldoc_config(settings, args.pdf)
    config.working_dir = args.output / "working"
    config.working_dir.mkdir(parents=True, exist_ok=True)
    result = translate(config)
    print(str(result), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf", type=Path, nargs="?")
    parser.add_argument("--pages", default=None)
    parser.add_argument("--output", type=Path, default=ROOT / "output/pdf/pdf2zh-edge-trial")
    parser.add_argument("--edge-source-profile", type=Path, default=ROOT / ".zotero-dev/compat/10.0/profile/litmtrans/edge-local-translation")
    args = parser.parse_args()
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    profile = RUNTIME / "edge-profile-current"
    prepare_profile(args.edge_source_profile.resolve(), profile.resolve())
    logging.basicConfig(filename=args.output / "pipeline.log", level=logging.INFO, encoding="utf-8")
    started = time.monotonic()
    worker = EdgeWorker(profile, args.output / "edge-calls.jsonl")
    try:
        if args.pdf:
            args.pdf = args.pdf.resolve()
            source_hash = hashlib.sha256(args.pdf.read_bytes()).hexdigest()
            translate_pdf(args, worker)
            if source_hash != hashlib.sha256(args.pdf.read_bytes()).hexdigest():
                raise RuntimeError("Source PDF changed during trial")
        else:
            for text in ("The bubble radius is {v0}, and the pressure is {v1}.", "The experiment did not show a significant increase in pressure."):
                print(json.dumps({"input": text, "output": worker.translate(text)}, ensure_ascii=False), flush=True)
        (args.output / "run.json").write_text(json.dumps({
            "pdf": str(args.pdf) if args.pdf else None, "pages": args.pages, "calls": worker.calls,
            "elapsed_seconds": round(time.monotonic()-started, 2), "edge_page_offline": True,
            "mode": "upstream-machine-translation-raw-edge", "source_sha256": source_hash if args.pdf else None,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
    finally:
        worker.close()


if __name__ == "__main__":
    main()
