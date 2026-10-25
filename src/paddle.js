(function (global) {
  "use strict";

  const L = global.LitMTrans = global.LitMTrans || {};
  const U = L.Utils;
  const H = L.HTTP;
  const P = L.ParserModel;
  const API = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs";
  const DEFAULT_MODEL = "PaddleOCR-VL-1.6";
  const DEFAULT_OPTIONS = Object.freeze({ useDocOrientationClassify: false, useDocUnwarping: false, useChartRecognition: false, mergeLayoutBlocks: false });

  function safeError(error) {
    const clean = new Error(String(error?.message || error).replace(/https?:\/\/\S+/gi, "[资源链接]"));
    clean.status = error?.status;
    clean.cancelled = error?.cancelled;
    clean.paddleAuth = error?.paddleAuth;
    return clean;
  }

  function multipart(bytes, model, options = DEFAULT_OPTIONS) {
    const boundary = `litmtrans-${U.randomID("paddle").replace(/[^A-Za-z0-9]/g, "")}`;
    const encoder = new TextEncoder();
    const prefix = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="optionalPayload"\r\n\r\n${JSON.stringify(options)}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="document.pdf"\r\nContent-Type: application/pdf\r\n\r\n`);
    const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(prefix.length + bytes.length + suffix.length);
    body.set(prefix); body.set(bytes, prefix.length); body.set(suffix, prefix.length + bytes.length);
    return { body, contentType: `multipart/form-data; boundary=${boundary}` };
  }

  class PaddleService {
    constructor(storage, secrets) {
      this.storage = storage;
      this.secrets = secrets;
    }

    async getJSON(url, token, signal) {
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await H.requestJSON("GET", url, { token, signal, timeout: 60000 });
          if (result?.code !== 0) throw new Error(`Paddle请求失败：${result?.msg || "未知响应"}`);
          return result;
        }
        catch (error) {
          if ([401, 403].includes(error.status)) error.paddleAuth = true;
          if (error.cancelled || signal?.aborted || error.paddleAuth || attempt >= 2
            || (error.status && ![429, 500, 502, 503, 504].includes(error.status))) throw error;
          await U.sleep(1000 * (attempt + 1), signal);
        }
      }
    }

    async submit(bytes, model, token, signal, options = DEFAULT_OPTIONS) {
      if (!model || /[\r\n]/.test(model)) throw new Error("Paddle模型名称无效");
      const form = multipart(bytes, model, options);
      try {
        const result = await H.requestJSON("POST", API, { token, signal, timeout: 180000,
          headers: { "Content-Type": form.contentType }, body: form.body });
        if (result?.code !== 0 || !result?.data?.jobId) throw new Error(`Paddle未创建解析任务：${result?.msg || "响应不完整"}`);
        return { jobID: String(result.data.jobId), traceID: String(result.traceId || ""), state: "pending" };
      }
      catch (error) {
        if ([401, 403].includes(error.status)) error.paddleAuth = true;
        throw error;
      }
    }

    async poll(task, token, persist, options, emit, signal) {
      const deadline = Date.now() + Math.max(1, Number(options.timeoutSeconds || 900)) * 1000;
      let pendingSince = null;
      while (Date.now() < deadline) {
        U.throwIfAborted(signal);
        const result = await this.getJSON(`${API}/${encodeURIComponent(task.jobID)}`, token, signal);
        const data = result.data || {};
        Object.assign(task, { state: String(data.state || ""), traceID: String(result.traceId || task.traceID || "") });
        await persist(task);
        if (task.state === "failed") throw new Error(`Paddle解析失败：${data.errorMsg || "云端任务失败"}（任务 ${task.jobID}）`);
        if (task.state === "done") {
          if (!data.resultUrl?.jsonUrl) throw new Error(`Paddle任务 ${task.jobID} 缺少结果链接`);
          return data.resultUrl.jsonUrl;
        }
        if (!["pending", "running"].includes(task.state)) throw new Error(`Paddle返回未知任务状态：${task.state || "空"}`);
        const progress = data.extractProgress || {};
        const total = Number(progress.totalPages || 0);
        if (task.state === "pending") pendingSince ??= Date.now();
        else pendingSince = null;
        const hint = pendingSince !== null && Date.now() - pendingSince >= 120000
          ? "；等待时间较长，可在设置中将解析服务切换为 MinerU 后重试" : "";
        emit?.({ type: "progress", phase: "paddle-poll", progress: total ? 15 + Math.min(60, Number(progress.extractedPages || 0) / total * 60) : null,
          message: (total ? `Paddle解析中：${Number(progress.extractedPages || 0)}/${total} 页` : "正在等待Paddle解析结果") + hint });
        await U.sleep(options.pollIntervalMs ?? 3000, signal);
      }
      throw new Error(`Paddle等待超时，可重试以继续查询任务 ${task.jobID}`);
    }

    async resource(url, root, stem, signal) {
      if (new URL(String(url)).protocol !== "https:") throw new Error("Paddle返回了不支持的资源地址");
      const response = await H.request("GET", url, { signal, timeout: 90000, accept: "image/*,application/octet-stream" });
      const length = Number(response.headers?.get?.("content-length") || 0);
      if (length > 64 * 1024 * 1024) throw new Error("Paddle图片资源过大");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error("Paddle图片资源为空或过大");
      const mime = String(response.headers?.get?.("content-type") || "").split(";")[0];
      const ext = ({ "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/svg+xml": ".svg" })[mime] || ".png";
      const relative = stem + ext;
      await this.storage.writeBytes(PathUtils.join(root, ...relative.split("/")), bytes);
      return relative;
    }

    async cropImage(root, source, bbox, expected, relative, signal) {
      U.throwIfAborted(signal);
      const win = Zotero.getMainWindow?.();
      if (!win?.document || !win.Image) throw new Error("当前宿主无法生成表格或插图裁图");
      const image = new win.Image();
      await new Promise((resolve, reject) => {
        const cleanup = () => { image.onload = null; image.onerror = null; signal?.removeEventListener?.("abort", abort); };
        const abort = () => { cleanup(); image.src = ""; reject(new U.CancelledError("操作已停止")); };
        image.onload = () => { cleanup(); resolve(); };
        image.onerror = () => { cleanup(); reject(new Error("Paddle原页图片无法解码")); };
        signal?.addEventListener?.("abort", abort, { once: true });
        image.src = PathUtils.toFileURI(PathUtils.join(root, ...source.split("/")));
      });
      if (image.naturalWidth !== expected[0] || image.naturalHeight !== expected[1]) throw new Error("Paddle原页图片与布局尺寸不一致");
      const [x, y, right, bottom] = bbox;
      if (x < 0 || y < 0 || right > image.naturalWidth + 1 || bottom > image.naturalHeight + 1 || right <= x || bottom <= y) throw new Error("Paddle裁图位置无效");
      const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = Math.max(1, Math.ceil(right - x));
      canvas.height = Math.max(1, Math.ceil(bottom - y));
      try {
        const context = canvas.getContext("2d");
        context.drawImage(image, x, y, right - x, bottom - y, 0, 0, canvas.width, canvas.height);
        const encoded = canvas.toDataURL("image/png").split(",")[1];
        const decoded = U.base64Decode(encoded);
        const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
        await this.storage.writeBytes(PathUtils.join(root, ...relative.split("/")), bytes);
      }
      finally { canvas.width = canvas.height = 1; image.src = ""; }
      return relative;
    }

    async localize(pages, document, root, signal) {
      const assetMap = {};
      const imageMap = [];
      const markdown = [];
      for (let index = 0; index < pages.length; index++) {
        U.throwIfAborted(signal);
        const page = pages[index];
        const native = page.prunedResult;
        const prefix = `p${String(index + 1).padStart(3, "0")}`;
        const resources = Object.entries(page.markdown?.images || {});
        const local = {};
        for (let start = 0; start < resources.length; start += 4) {
          await Promise.all(resources.slice(start, start + 4).map(async ([key, url]) => {
            local[key] = await this.resource(url, root, `images/${prefix}-${U.hashString(key)}`, signal);
          }));
        }
        let sourceImage = "";
        for (const block of document.pages[index].blocks) {
          if (!["image", "table", "header_image", "footer_image"].includes(block.role)) continue;
          const matches = resources.filter(([key]) => {
            const match = key.match(/_box_(-?\d+)_(-?\d+)_(-?\d+)_(-?\d+)\./);
            return match && block.source.bbox.every((n, axis) => Math.abs(n - Number(match[axis + 1])) <= 1);
          });
          if (matches.length === 1) block.asset = local[matches[0][0]];
          else {
            if (!page.inputImage) throw new Error(`Paddle第 ${index + 1} 页缺少插图或表格资源`);
            if (!sourceImage) sourceImage = await this.resource(page.inputImage, root, `parser-source/paddle/${prefix}-input`, signal);
            block.asset = await this.cropImage(root, sourceImage, block.source.bbox, [native.width, native.height], `images/${block.id}.png`, signal);
          }
          assetMap[P.assetKey(block.asset)] = block.asset;
          if (["image", "table"].includes(block.role)) {
            const id = `IMAGE_${String(imageMap.length + 1).padStart(3, "0")}`;
            imageMap.push({ id, page: index + 1, bbox: block.bbox, alt: "", title: "", originalTarget: matches[0]?.[0] || block.id,
              cleanTarget: block.asset, warning: "" });
          }
        }
        let text = String(page.markdown?.text || "");
        for (const [key, target] of Object.entries(local).sort((a, b) => b[0].length - a[0].length)) {
          assetMap[P.assetKey(target)] = target;
          text = text.split(key).join(target);
        }
        for (const record of imageMap.filter(record => record.page === index + 1)) {
          const escaped = record.cleanTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          text = text.replace(new RegExp(`!\\[[^\\]]*\\]\\(\\s*${escaped}\\s*\\)`, "g"), `![${record.id}](${record.cleanTarget})`)
            .replace(new RegExp(`<img\\b[^>]*\\bsrc=["']${escaped}["'][^>]*>`, "gi"), `![${record.id}](${record.cleanTarget})`);
        }
        text = P.mathTokens(text).map(token => token.kind === "math"
          ? (token.display ? `\\[${token.tex}\\]` : `\\(${token.tex}\\)`) : token.text).join("");
        markdown.push(text.trim());
      }
      return { markdown: markdown.join("\n\n") + "\n", assetMap, imageMap };
    }

    async prepare(filePath, root, options = {}, emit = null, signal = null, taskPath = "") {
      if (U.extension(filePath) !== ".pdf") throw new Error("Paddle解析目前支持PDF文件，请将此文件转换为PDF后重试");
      const token = String(this.secrets.getPaddleToken() || "").trim();
      if (!token) throw new Error("尚未配置Paddle访问令牌");
      if (!/^[\x21-\x7E]+$/.test(token)) throw new Error("Paddle访问令牌包含无效字符");
      const stat = await this.storage.stat(filePath);
      if (stat?.size && stat.size > 200 * 1024 * 1024) {
        throw new Error(`文档大小（${(stat.size / (1024 * 1024)).toFixed(1)} MB）超过限制，Paddle单次解析最多支持 200 MB`);
      }
      const model = String(options.parseModel || options.paddleModel || DEFAULT_MODEL).trim();
      const bytes = await this.storage.readBytes(filePath);
      if (bytes.length > 200 * 1024 * 1024) {
        throw new Error(`文档大小（${(bytes.length / (1024 * 1024)).toFixed(1)} MB）超过限制，Paddle单次解析最多支持 200 MB`);
      }
      if (!global.PDFLib?.PDFDocument) throw new Error("当前宿主缺少PDF页面读取组件");
      const pdf = await global.PDFLib.PDFDocument.load(global.Uint8Array.from(bytes), { ignoreEncryption: true, updateMetadata: false });
      const sizes = pdf.getPages().map(page => {
        const box = page.getCropBox();
        const rotated = Math.abs(page.getRotation().angle % 180) === 90;
        return { width: rotated ? box.height : box.width, height: rotated ? box.width : box.height };
      });
      if (sizes.length > 1000) {
        throw new Error(`文档共 ${sizes.length} 页，超过Paddle单次解析上限（最多支持 1000 页），请先拆分后重试`);
      }
      const identity = U.hashString(`${options.sourceIdentity || filePath}|${bytes.length}|${model}|${JSON.stringify(DEFAULT_OPTIONS)}`);
      const persist = task => taskPath ? this.storage.writeJSON(taskPath, { ...task, identity, model, provider: "paddle" }) : Promise.resolve();
      let task = taskPath ? await this.storage.readJSON(taskPath, null) : null;
      try {
        if (!task?.jobID || task.identity !== identity || ["failed", "published"].includes(task.state)) {
          emit?.({ type: "progress", phase: "paddle-upload", progress: 5, message: "正在上传文献到Paddle" });
          task = await this.submit(bytes, model, token, signal);
          await persist(task);
        }
        emit?.({ type: "log", message: `Paddle任务：${task.jobID}` });
        const url = await this.poll(task, token, persist, options, emit, signal);
        if (new URL(String(url)).protocol !== "https:") throw new Error("Paddle结果链接无效");
        const resultBytes = await H.requestBytes(url, { signal, timeout: 90000, maxBytes: 64 * 1024 * 1024 });
        const rawText = new TextDecoder().decode(resultBytes);
        const pages = L.PaddleAdapter.decodeResults(rawText);
        const document = L.PaddleAdapter.normalize(pages, sizes, { model });
        emit?.({ type: "progress", phase: "paddle-assets", progress: 80, message: "正在保存Paddle解析内容和图片" });
        const localized = await this.localize(pages, document, root, signal);
        U.throwIfAborted(signal);
        await this.storage.writeText(PathUtils.join(root, "parser-source", "paddle", "result.jsonl"), rawText);
        await this.storage.writeJSON(PathUtils.join(root, "parser-source", "paddle", "pages.json"), { pages });
        await this.storage.writeJSON(PathUtils.join(root, "parsed-document.v1.json"), document);
        await this.storage.writeJSON(PathUtils.join(root, "layout.json"), P.projectLayout(document));
        await this.storage.writeJSON(PathUtils.join(root, "asset-map.json"), localized.assetMap);
        await this.storage.writeJSON(PathUtils.join(root, "image-map.json"), localized.imageMap);
        await this.storage.writeText(PathUtils.join(root, "full.md"), pages.map(page => page.markdown?.text || "").join("\n\n"));
        await this.storage.writeText(PathUtils.join(root, "full.cleaned.md"), localized.markdown);
        return { ...localized, document, task, model };
      }
      catch (error) { throw safeError(error); }
    }
  }

  L.PaddleService = PaddleService;
  L.PaddleInternals = { API, DEFAULT_MODEL, DEFAULT_OPTIONS, multipart };
})(this);
