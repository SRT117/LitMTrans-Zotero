import "../assets/vendor/local-ocr/local-ocr.js";

const defaultRoot = PathUtils.join(PathUtils.profileDir, "litmtrans", "local-ocr", "v1");
const defaultAssets = {
  "ort-wasm-simd-threaded.jsep.mjs": {
    size: 47250,
    sha256: "7838b4b2e77d6f1a739cd0de800e7f18a089328b365e6af4d416a88a94fd7fd3",
    urls: ["https://registry.npmmirror.com/onnxruntime-web/1.31.1/files/dist/ort-wasm-simd-threaded.jsep.mjs"]
  },
  "ort-wasm-simd-threaded.jsep.wasm": {
    size: 29520971,
    sha256: "5ab8361783822d02a57d1e97cf2514bceb451a628f2b29ae0d7b6e618201ff8f",
    urls: ["https://registry.npmmirror.com/onnxruntime-web/1.31.1/files/dist/ort-wasm-simd-threaded.jsep.wasm"]
  },
  "PP-OCRv6_tiny_det_onnx_infer.tar": {
    size: 1792000,
    sha256: "ff6ab415b0a6e0c488550f2fb5d5046f1719848df220b2dc21b56402a65bc05d",
    urls: ["https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_tiny_det_onnx_infer.tar"]
  },
  "PP-OCRv6_tiny_rec_onnx_infer.tar": {
    size: 4526080,
    sha256: "1e13b22717b1edd89d4cde4fda272b6c17d5b505c97c2baea99da1a3a2d54b29",
    urls: ["https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_tiny_rec_onnx_infer.tar"]
  }
};

const state = { progress: "正在准备本地图片识别", percent: null, model: null };
let activeRoot = defaultRoot;
let activeAssets = defaultAssets;
let initializedRoot = "";
let activeAbortController = null;

function configure(options = {}) {
  const nextRoot = typeof options?.root === "string" && options.root.trim() ? options.root.trim() : defaultRoot;
  if (nextRoot !== activeRoot) {
    activeRoot = nextRoot;
    initializedRoot = "";
  }
  const merged = {};
  for (const [name, fallback] of Object.entries(defaultAssets)) {
    const incoming = options?.assets?.[name];
    const validIncoming = incoming && Number.isSafeInteger(incoming.size) && incoming.size > 0
      && /^[a-f0-9]{64}$/.test(String(incoming.sha256 || ""))
      && Array.isArray(incoming.urls) && incoming.urls.some(u => /^https:\/\//i.test(String(u || "").trim()));
    merged[name] = validIncoming
      ? { size: incoming.size, sha256: incoming.sha256, urls: incoming.urls.filter(u => /^https:\/\//i.test(String(u || "").trim())) }
      : fallback;
  }
  activeAssets = merged;
}

async function readResponseBytes(response, expectedSize, onChunk) {
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onChunk?.(bytes.length);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) {
        chunks.push(value);
        loaded += value.length;
        if (expectedSize > 0 && loaded > expectedSize * 1.2) {
          throw new Error("本地图片识别组件大小异常");
        }
        onChunk?.(loaded);
      }
    }
  } finally {
    try { reader.releaseLock(); } catch (_) {}
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function downloadFileFromMirrors(name, entry, tracker, signal) {
  const path = PathUtils.join(activeRoot, name);
  const partPath = `${path}.part`;
  let lastError = null;
  for (const url of entry.urls) {
    if (signal?.aborted) throw new Error("操作已取消");
    try {
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await readResponseBytes(response, entry.size, loaded => {
        if (!tracker) return;
        tracker.received.set(name, Math.min(entry.size, loaded));
        const sum = [...tracker.received.values()].reduce((acc, value) => acc + value, 0);
        const percent = Math.max(0, Math.min(99, Math.round((sum * 100) / Math.max(1, tracker.total))));
        state.percent = percent;
        state.progress = `正在下载本地图片识别组件（${percent}%）`;
      });
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map(x => x.toString(16).padStart(2, "0")).join("");
      if (bytes.length !== entry.size || hash !== entry.sha256) {
        throw new Error("本地图片识别组件校验失败");
      }
      await IOUtils.write(partPath, bytes);
      await IOUtils.move(partPath, path);
      return bytes;
    } catch (error) {
      await IOUtils.remove(partPath, { ignoreAbsent: true }).catch(() => {});
      if (signal?.aborted || error?.name === "AbortError") throw error;
      lastError = error;
    }
  }
  throw lastError || new Error(`本地图片识别组件下载失败：${name}`);
}

async function ensureFile(name, tracker = null, signal = null, readBytes = true) {
  const entry = activeAssets[name];
  if (!entry) throw new Error("不支持的本地识别资源");
  const path = PathUtils.join(activeRoot, name);
  if (await IOUtils.exists(path)) {
    const stat = await IOUtils.stat(path).catch(() => null);
    if (stat && stat.type !== "directory" && stat.size === entry.size) {
      if (tracker) tracker.received.set(name, entry.size);
      return readBytes ? IOUtils.read(path) : null;
    }
  }
  const bytes = await downloadFileFromMirrors(name, entry, tracker, signal);
  return readBytes ? bytes : null;
}

async function downloadModels(options = {}) {
  configure(options);
  await IOUtils.makeDirectory(activeRoot, { createAncestors: true });
  const names = Object.keys(activeAssets);
  const tracker = {
    total: names.reduce((sum, name) => sum + activeAssets[name].size, 0),
    received: new Map()
  };
  let missing = 0;
  for (const name of names) {
    const path = PathUtils.join(activeRoot, name);
    const stat = await IOUtils.exists(path) ? await IOUtils.stat(path).catch(() => null) : null;
    if (stat && stat.type !== "directory" && stat.size === activeAssets[name].size) {
      tracker.received.set(name, activeAssets[name].size);
    } else {
      missing++;
    }
  }
  if (!missing) {
    state.percent = 100;
    state.progress = "本地图片识别模型已就绪";
    return;
  }
  state.percent = Math.round(([...tracker.received.values()].reduce((a, b) => a + b, 0) * 100) / Math.max(1, tracker.total));
  state.progress = `正在下载本地图片识别组件（${state.percent}%）`;
  activeAbortController?.abort();
  const controller = new AbortController();
  activeAbortController = controller;
  try {
    await Promise.all(names.map(name => ensureFile(name, tracker, controller.signal, false)));
    state.percent = 100;
    state.progress = "本地图片识别组件下载完成";
  } finally {
    if (activeAbortController === controller) activeAbortController = null;
  }
}

async function initialize(options = {}) {
  configure(options);
  if (state.model && initializedRoot === activeRoot) return;
  if (state.model && initializedRoot !== activeRoot) {
    await state.model.dispose().catch(() => {});
    state.model = null;
  }
  await downloadModels(options);
  state.percent = null;
  state.progress = "正在加载本地图片识别模型";
  const wasmPaths = `${PathUtils.toFileURI(activeRoot).replace(/\/+$/, "")}/`;
  state.model = await window.LitMTransPaddleOCR.create({
    textDetectionModelName: "PP-OCRv6_tiny_det", textRecognitionModelName: "PP-OCRv6_tiny_rec",
    ortOptions: { backend: "wasm", numThreads: 1, wasmPaths },
    fetch: async url => {
      const name = new URL(url).pathname.split("/").pop();
      return new Response(await ensureFile(name));
    }
  });
  initializedRoot = activeRoot;
}

const normalCanvas = document.createElement("canvas");
const rotatedCanvas = document.createElement("canvas");

function lines(result, rotated) {
  const parser = window.LitMTrans?.LayoutImages?.ocrLineFromPolygon;
  return result.items.flatMap(item => {
    const line = parser?.(item.text, item.score, item.poly, result.image.width, result.image.height, {
      clamp: true, minAspect: 1.2, minScore: .5, rotated
    });
    return line ? [line] : [];
  });
}

window.LitMTransLocalOCR = {
  state,
  async downloadModels(options = {}) { await downloadModels(options); },
  async initialize(options = {}) { await initialize(options); },
  cancel() {
    try { activeAbortController?.abort("操作已取消"); } catch (_) {}
    activeAbortController = null;
  },
  async recognize(base64, mime) {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const blob = new Blob([bytes], { type: mime }), image = await createImageBitmap(blob);
    const w = image.width, h = image.height;
    normalCanvas.width = w; normalCanvas.height = h;
    const normalContext = normalCanvas.getContext("2d", { willReadFrequently: true });
    normalContext.drawImage(image, 0, 0);
    rotatedCanvas.width = h; rotatedCanvas.height = w;
    const rotContext = rotatedCanvas.getContext("2d");
    rotContext.translate(h, 0); rotContext.rotate(Math.PI / 2); rotContext.drawImage(image, 0, 0);
    try {
      const result = await window.LitMTrans.LayoutImages.recognizeLocalImageText(state.model, normalCanvas, rotatedCanvas,
        { textDetLimitSideLen: 1024, textDetLimitType: "max", textRecScoreThresh: .5, rotatedHorizontalOnly: true });
      let rows = window.LitMTrans.LayoutImages.mergeImageLines(lines(result.normal, false), lines(result.rotated, true));
      const needsPixelScan = rows.some(line => (!line.rotation && line.score < .7 && line.bbox[2] - line.bbox[0] >= .4 && line.bbox[3] - line.bbox[1] >= .12)
        || (!line.rotation && /-{2,}|–{2,}|—+|─+|━+|\.{3,}|…+/.test(line.text)));
      if (needsPixelScan) {
        const pixels = normalContext.getImageData(0, 0, w, h).data;
        rows = rows.filter(line => !window.LitMTrans.LayoutImages.isColoredCurveCandidate(line, pixels, w, h));
        rows = window.LitMTrans.LayoutImages.splitMergedLegendLines?.(rows, pixels, w, h) || rows;
      }
      return JSON.stringify(rows);
    } finally { image.close(); }
  },
  async dispose() {
    this.cancel();
    normalCanvas.width = normalCanvas.height = 1;
    rotatedCanvas.width = rotatedCanvas.height = 1;
    initializedRoot = "";
    await state.model?.dispose();
    state.model = null;
  }
};
