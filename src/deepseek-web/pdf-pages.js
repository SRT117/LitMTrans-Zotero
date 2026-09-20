(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  LitMTrans.DeepSeekWeb = LitMTrans.DeepSeekWeb || {};
  const U = LitMTrans.Utils;

  const PAGE_IMAGE_PROFILES = Object.freeze({
    low: { cacheDir: "pages-v4-low", scale: 100 / 72, quality: 0.75 },
    // 中等档沿用当前页面图规格，也兼容此前已生成的 pages-v3 缓存。
    medium: { cacheDir: "pages-v3", scale: 150 / 72, quality: 0.85 },
    high: { cacheDir: "pages-v4-high", scale: 220 / 72, quality: 0.92 }
  });

  function pageImageProfile(value) {
    const quality = String(value || "high").trim().toLowerCase();
    return PAGE_IMAGE_PROFILES[quality] || PAGE_IMAGE_PROFILES.high;
  }

  function base64ToUint8Array(base64) {
    const clean = base64.replace(/\s+/g, "");
    if (typeof atob === "function") {
      const binary = atob(clean);
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
    if (typeof ChromeUtils?.base64URLDecode === "function") {
      return new Uint8Array(ChromeUtils.base64URLDecode(clean, { padding: "required" }));
    }
    throw new Error("无法解码Base64图片数据");
  }

  function dataURLToUint8Array(dataURL) {
    const match = String(dataURL || "").match(/^data:[^;,]+;base64,(.*)$/s);
    if (!match) throw new Error("页面图像编码无效");
    return base64ToUint8Array(match[1]);
  }

  function readUint32(bytes, offset) {
    return (((bytes[offset] << 24) >>> 0) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
  }

  function writeUint32(bytes, offset, value) {
    const n = Number(value) >>> 0;
    bytes[offset] = n >>> 24;
    bytes[offset + 1] = n >>> 16;
    bytes[offset + 2] = n >>> 8;
    bytes[offset + 3] = n;
  }

  function pngCRC32(bytes) {
    let crc = 0xffffffff;
    for (const value of bytes) {
      crc ^= value;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function pngChunk(type, data) {
    const payload = data instanceof Uint8Array ? data : new Uint8Array(data || []);
    const chunk = new Uint8Array(payload.length + 12);
    writeUint32(chunk, 0, payload.length);
    for (let index = 0; index < 4; index++) chunk[4 + index] = type.charCodeAt(index) || 0;
    chunk.set(payload, 8);
    const crcInput = new Uint8Array(payload.length + 4);
    crcInput.set(chunk.slice(4, 8), 0);
    crcInput.set(payload, 4);
    writeUint32(chunk, payload.length + 8, pngCRC32(crcInput));
    return chunk;
  }

  function addPNGResolution(bytes, dpi = 300) {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (!(bytes instanceof Uint8Array) || bytes.length < 33 || !signature.every((value, index) => bytes[index] === value)) return bytes;
    const pixelsPerMeter = Math.max(1, Math.round(Number(dpi || 300) / 0.0254));
    const phys = new Uint8Array(9);
    writeUint32(phys, 0, pixelsPerMeter);
    writeUint32(phys, 4, pixelsPerMeter);
    phys[8] = 1;
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = readUint32(bytes, offset);
      const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      const end = offset + 12 + length;
      if (end > bytes.length) return bytes;
      if (type === "pHYs" && length === 9) {
        const output = bytes.slice();
        output.set(phys, offset + 8);
        const crcInput = new Uint8Array(13);
        crcInput.set(output.slice(offset + 4, offset + 8), 0);
        crcInput.set(phys, 4);
        writeUint32(output, offset + 17, pngCRC32(crcInput));
        return output;
      }
      if (type === "IHDR") {
        const chunk = pngChunk("pHYs", phys);
        const output = new Uint8Array(bytes.length + chunk.length);
        output.set(bytes.slice(0, end), 0);
        output.set(chunk, end);
        output.set(bytes.slice(end), end + chunk.length);
        return output;
      }
      offset = end;
    }
    return bytes;
  }

  function getPartitionStrategy(numPages, maxImages = 49) {
    const limit = Math.max(1, Number(maxImages) || 49);
    if (numPages <= limit) {
      const groups = [];
      for (let p = 1; p <= numPages; p++) {
        const name = `Page_${String(p).padStart(2, "0")}.jpg`;
        groups.push({ pages: [p], filename: name });
      }
      return { chunkSize: 1, groups, downgraded: false };
    }
    if (numPages <= limit * 2) {
      const groups = [];
      for (let p = 1; p <= numPages; p += 2) {
        const p2 = Math.min(p + 1, numPages);
        const name = p === p2
          ? `Page_${String(p).padStart(2, "0")}.jpg`
          : `Page_${String(p).padStart(2, "0")}-${String(p2).padStart(2, "0")}.jpg`;
        const pages = p === p2 ? [p] : [p, p2];
        groups.push({ pages, filename: name });
      }
      return { chunkSize: 2, groups, downgraded: false };
    }
    if (numPages <= limit * 3) {
      const groups = [];
      for (let p = 1; p <= numPages; p += 3) {
        const pEnd = Math.min(p + 2, numPages);
        const name = p === pEnd
          ? `Page_${String(p).padStart(2, "0")}.jpg`
          : `Page_${String(p).padStart(2, "0")}-${String(pEnd).padStart(2, "0")}.jpg`;
        const pages = [];
        for (let i = p; i <= pEnd; i++) pages.push(i);
        groups.push({ pages, filename: name });
      }
      return { chunkSize: 3, groups, downgraded: false };
    }
    return {
      chunkSize: 0,
      groups: [],
      downgraded: true,
      message: `文献超过 ${limit * 3} 页，已自动切换为纯文本深度问答模式`
    };
  }

  function createCanvas(doc) {
    try {
      const hiddenWin = Services?.appShell?.hiddenDOMWindow;
      if (hiddenWin?.document?.createElementNS) {
        return hiddenWin.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      }
    } catch (_) {}
    if (doc?.createElementNS) {
      return doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    }
    return doc.createElement("canvas");
  }

  // 特权域自加载渲染：文档实例与画布同域（备选路径，见 renderAndCachePages）
  async function renderSinglePageToCanvas(pdfDoc, pageNum, doc, scale) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(doc);
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("无法获取 2D 画布上下文");
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas;
  }

  async function stitchCanvasesHorizontal(canvases, doc) {
    if (canvases.length === 1) return canvases[0];
    const totalWidth = canvases.reduce((sum, c) => sum + c.width, 0);
    const maxHeight = Math.max(...canvases.map(c => c.height));
    const stitched = createCanvas(doc);
    stitched.width = totalWidth;
    stitched.height = maxHeight;
    const ctx = stitched.getContext("2d");
    if (!ctx) {
      throw new Error("无法获取 2D 画布上下文");
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, totalWidth, maxHeight);
    let xOffset = 0;
    for (const c of canvases) {
      ctx.drawImage(c, xOffset, 0);
      xOffset += c.width;
    }
    return stitched;
  }

  class PDFPageRenderer {
    constructor(controller) {
      this.controller = controller;
      this.storage = controller.storage;
    }

    getPagesDir(documentID, profile) {
      const docDir = PathUtils.join(this.storage.documentsRoot, String(documentID));
      return PathUtils.join(docDir, "deepseek-web", profile.cacheDir);
    }

    getPageImagesRoot(documentID) {
      const docDir = PathUtils.join(this.storage.documentsRoot, String(documentID));
      return PathUtils.join(docDir, "deepseek-web");
    }

    async removeObsoletePages(documentID, activeCacheDir, options = {}) {
      const candidates = ["pages-v2", ...Object.values(PAGE_IMAGE_PROFILES).map(profile => profile.cacheDir)];
      for (const cacheDir of candidates) {
        if (cacheDir === activeCacheDir) continue;
        const cachePath = PathUtils.join(this.getPageImagesRoot(documentID), cacheDir);
        try {
          const stats = await this.storage.dirStats(cachePath);
          await IOUtils.remove(cachePath, { recursive: true, ignoreAbsent: true });
          if (stats.bytes > 0) this.storage.adjustDeepSeekWebPagesCacheBytes?.(-stats.bytes);
        } catch (error) {
          options.emit?.({ type: "warning", message: `[探针5-Provider] 页面图缓存清理失败: ${error?.message || error}` });
          return;
        }
      }
      options.emit?.({ type: "log", message: "[探针5-Provider] 已清理其他清晰度的页面图缓存" });
    }

    async clearPageCaches(documentID, options = {}) {
      await this.removeObsoletePages(documentID, "", options);
    }

    // 主渲染路径：预览 iframe 是 content 域页面，pdf.js 文档、页面代理与画布
    // 天然同域，getViewport/render 等原型方法完整可用。特权域若直接跨 Realm
    // 调用页面代理会报 "page.getViewport is not a function"；若在特权域自加载
    // pdf.js 又会因 Map.prototype 等内置原型被冻结而导入失败。因此渲染动作
    // 全部在 iframe 一侧的原始对象上执行，最终只把 dataURL 字符串传回特权域。
    getPreviewIframeContext(runtime, diagnostics = []) {
      const iframeWindow = runtime?.pdfPreview?._internalReader?._primaryView?._iframeWindow;
      if (!iframeWindow) {
        diagnostics.push("未找到预览 iframe 窗口（pdfPreview._internalReader._primaryView._iframeWindow 不可用）");
        return null;
      }
      let cw = null;
      try {
        // Xray 不存在或已 waive 的情况下兜底直接使用该窗口
        cw = iframeWindow.wrappedJSObject || iframeWindow;
      } catch (_) {}
      if (!cw?.document?.createElement) {
        diagnostics.push("无法访问预览 iframe 的 content 域 document");
        return null;
      }
      const pdfDocument = cw.PDFViewerApplication?.pdfDocument;
      if (!pdfDocument || !(pdfDocument.numPages > 0) || typeof pdfDocument.getPage !== "function") {
        diagnostics.push("iframe 内 PDFViewerApplication.pdfDocument 不可用（文献可能尚未在预览中打开）");
        return null;
      }
      return { cw, cdoc: cw.document, pdfDocument };
    }

    // 在预览 iframe 的 content 域内渲染一组页面并横向拼接，返回 JPEG dataURL。
    // 跨 Realm 直接调用页面代理的方法在 Gecko 包装下会丢失（page.getViewport
    // 报 "not a function"），因此把整段渲染逻辑放进 iframe 自身域内 eval 执行，
    // 让 pdf.js 的文档、页面代理与画布天然同域；注入参数仅为数字，结果以
    // JSON 字符串回传（字符串跨 Realm 无损）。
    async renderGroupInPreview(ctx, pageNums, profile) {
      const { cw } = ctx;
      const code = `
        (async () => {
          const pdfDocument = window.PDFViewerApplication && window.PDFViewerApplication.pdfDocument;
          if (!pdfDocument) return JSON.stringify({ ok: false, error: "PDFViewerApplication.pdfDocument 不可用" });
          const pages = ${JSON.stringify(pageNums)};
          const scale = ${profile.scale};
          const quality = ${profile.quality};
          const canvases = [];
          for (const pageNum of pages) {
            const page = await pdfDocument.getPage(pageNum);
            const viewport = page.getViewport({ scale: scale });
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(viewport.width);
            canvas.height = Math.round(viewport.height);
            const g = canvas.getContext("2d");
            if (!g) return JSON.stringify({ ok: false, error: "iframe 画布 2D 上下文不可用" });
            g.fillStyle = "#ffffff";
            g.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: g, viewport: viewport }).promise;
            canvases.push(canvas);
          }
          let out = canvases[0];
          if (canvases.length > 1) {
            const totalWidth = canvases.reduce((sum, c) => sum + c.width, 0);
            const maxHeight = Math.max.apply(null, canvases.map(c => c.height));
            out = document.createElement("canvas");
            out.width = totalWidth;
            out.height = maxHeight;
            const g = out.getContext("2d");
            if (!g) return JSON.stringify({ ok: false, error: "iframe 拼接画布 2D 上下文不可用" });
            g.fillStyle = "#ffffff";
            g.fillRect(0, 0, totalWidth, maxHeight);
            let xOffset = 0;
            for (const c of canvases) { g.drawImage(c, xOffset, 0); xOffset += c.width; }
          }
          return JSON.stringify({ ok: true, dataUrl: out.toDataURL("image/jpeg", quality) });
        })()
      `;
      let rawResult;
      try {
        rawResult = await cw.eval(code);
      } catch (err) {
        throw new Error(`iframe 内渲染执行失败: ${err?.message || err}`);
      }
      if (typeof rawResult !== "string") {
        throw new Error("iframe 内渲染未返回可解析的结果");
      }
      const result = JSON.parse(rawResult);
      if (!result.ok || !result.dataUrl) {
        throw new Error(result.error || "iframe 内渲染返回空结果");
      }
      return result.dataUrl;
    }

    // 自己加载打包在 Zotero 里的 pdf.js，让文档实例与渲染画布同域，
    // 页面代理的 getPage/getViewport 等原型方法可正常调用。直接复用阅读器
    // iframe 里的文档实例会跨域，在 Gecko 包装下报
    // "page.getViewport is not a function" 之类的错误。
    // Zotero 定制打包的 pdf.mjs（8/9/10）在模块顶层直接引用 DOMMatrix，
    // 而插件 chrome 特权域没有 DOM 全局，importESModule 会在顶层抛
    // "DOMMatrix is not defined"。加载前从主窗口借用这些 WebIDL 接口挂到全局。
    ensurePDFJSGlobals() {
      try {
        const win = Zotero.getMainWindow?.() || Services.appShell?.hiddenDOMWindow;
        if (!win) return false;
        for (const name of ["DOMMatrix", "ImageData", "Path2D"]) {
          if (!globalThis[name] && typeof win[name] !== "undefined") {
            globalThis[name] = win[name];
          }
        }
        return !!(globalThis.DOMMatrix && globalThis.ImageData && globalThis.Path2D);
      } catch (_) {
        return false;
      }
    }

    loadOwnPDFJS(failures = []) {
      // 实测 Zotero 7.0.32 / 8.0.4 / 9.0.6 / 10.0 的打包位置：
      // app omni.ja 静态别名 resource zotero -> resource/ 下均有
      // resource/reader/pdf/build/pdf.mjs（含同目录 pdf.worker.mjs），
      // 优先用它；Zotero 7 的 core 还带 UMD 版 resource://pdf.js/build/pdf.js，作为兜底。
      const candidates = [
        "resource://zotero/reader/pdf/build/pdf.mjs",
        "resource://reader/pdf/build/pdf.mjs",
        "resource://pdf.js/build/pdf.js"
      ];
      if (!this.ensurePDFJSGlobals()) {
        failures.push("无法从主窗口借用 DOMMatrix 等 DOM 全局，pdf.js 导入将失败");
      }
      for (const spec of candidates) {
        try {
          const mod = spec.endsWith(".mjs")
            ? ChromeUtils.importESModule(spec)
            : ChromeUtils.import(spec);
          const lib = mod?.pdfjsLib || mod;
          if (typeof lib?.getDocument !== "function") {
            failures.push(`${spec} 无 getDocument 导出`);
            continue;
          }
          try {
            const workerName = spec.endsWith(".mjs") ? "pdf.worker.mjs" : "pdf.worker.js";
            lib.GlobalWorkerOptions.workerSrc = spec.replace(/[^/]+$/, workerName);
          } catch (err) {
            failures.push(`${spec} 设置 workerSrc 失败: ${err?.message || err}`);
          }
          return lib;
        } catch (err) {
          failures.push(`${spec}: ${err?.message || err}`);
        }
      }
      return null;
    }

    // 特权域自加载文档实例（iframe 主路径不可用时才走）
    async loadSelfDocument(runtime, diagnostics = []) {
      const attachmentID = runtime?.attachmentID;
      if (!attachmentID) {
        diagnostics.push("runtime 未提供 attachmentID，无法自加载 PDF");
        return null;
      }
      const lib = this.loadOwnPDFJS(diagnostics);
      if (!lib) return null;
      try {
        const item = await Zotero.Items.getAsync(attachmentID);
        if (!item?.isAttachment()) {
          diagnostics.push("附件条目无效");
          return null;
        }
        const { filePath } = await this.controller.attachmentContext(attachmentID);
        if (!filePath || !await IOUtils.exists(filePath)) {
          diagnostics.push(`附件文件不存在: ${filePath || "null"}`);
          return null;
        }
        const bytes = await IOUtils.read(filePath);
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const doc = await lib.getDocument({ data: buffer }).promise;
        if (doc && doc.numPages > 0) return doc;
        diagnostics.push("自加载文档 numPages 无效");
        return null;
      } catch (err) {
        diagnostics.push(`自加载渲染链异常: ${err?.message || err}`);
        return null;
      }
    }

    async renderAndCachePages(runtime, documentID, options = {}) {
      const profile = pageImageProfile(options.quality);
      const pagesDir = this.getPagesDir(documentID, profile);
      await this.storage.ensureDir(pagesDir);
      await this.storage.ensureDeepSeekWebPagesCacheBytesInitialized?.();

      const diagnostics = [];
      const emitDiagnostics = () => {
        for (const msg of diagnostics) {
          options.emit?.({ type: "warning", message: `[探针6-页图] ${msg}` });
        }
        diagnostics.length = 0;
      };

      // 主路径：预览 iframe content 域渲染
      const iframeCtx = this.getPreviewIframeContext(runtime, diagnostics);
      if (iframeCtx) {
        options.emit?.({ type: "log", message: `[探针6-页图] 预览 iframe 渲染路径可用: numPages=${iframeCtx.pdfDocument.numPages}` });
      }
      emitDiagnostics();

      // 备选路径：特权域自加载 Zotero 打包的 pdf.js
      let selfDoc = null;
      if (!iframeCtx) {
        selfDoc = await this.loadSelfDocument(runtime, diagnostics);
        if (selfDoc) {
          options.emit?.({ type: "log", message: `[探针6-页图] 特权域自加载渲染路径可用: numPages=${selfDoc.numPages}` });
        }
        emitDiagnostics();
      }

      const numPages = iframeCtx ? iframeCtx.pdfDocument.numPages : (selfDoc ? selfDoc.numPages : 0);
      if (!numPages) {
        return {
          images: [],
          downgraded: false,
          error: "尚未获取到PDF文档，无法渲染页面"
        };
      }

      const maxImages = options.maxImages !== undefined ? options.maxImages : 49;
      const strategy = getPartitionStrategy(numPages, maxImages);
      if (strategy.downgraded) {
        return {
          images: [],
          downgraded: true,
          message: strategy.message
        };
      }

      let allCached = true;
      const targetPaths = [];
      for (const group of strategy.groups) {
        const filePath = PathUtils.join(pagesDir, group.filename);
        targetPaths.push(filePath);
        if (!await IOUtils.exists(filePath)) {
          allCached = false;
        }
      }

      if (allCached && targetPaths.length) {
        options.emit?.({ type: "progress", phase: "deepseek-pages", message: `已找到 ${targetPaths.length} 张页面图缓存`, progress: 70 });
        await this.removeObsoletePages(documentID, profile.cacheDir, options);
        return { images: targetPaths, downgraded: false, cached: true };
      }

      let newBytesWritten = 0;
      for (let i = 0; i < strategy.groups.length; i++) {
        U.throwIfAborted(options.signal);
        const group = strategy.groups[i];
        const filePath = targetPaths[i];
        if (await IOUtils.exists(filePath)) continue;

        options.emit?.({ type: "log", message: `[探针5-Provider] 正在准备文献高清页面 (${i + 1}/${strategy.groups.length})...` });
        options.emit?.({
          type: "progress",
          phase: "deepseek-pages",
          message: `正在生成页面图像 ${i + 1}/${strategy.groups.length}…`,
          progress: 10 + Math.round((i / Math.max(1, strategy.groups.length)) * 60)
        });

        let dataUrl = null;
        try {
          if (iframeCtx) {
            dataUrl = await this.renderGroupInPreview(iframeCtx, group.pages, profile);
          } else if (selfDoc) {
            const win = runtime.window
              || runtime.browser?.ownerGlobal
              || Zotero.getMainWindow?.()
              || Services.wm.getMostRecentWindow("navigator:browser");
            const doc = win?.document || runtime.browser?.contentDocument || document;
            const renderedCanvases = [];
            for (const pageNum of group.pages) {
              renderedCanvases.push(await renderSinglePageToCanvas(selfDoc, pageNum, doc, profile.scale));
            }
            const finalCanvas = await stitchCanvasesHorizontal(renderedCanvases, doc);
            dataUrl = finalCanvas.toDataURL("image/jpeg", profile.quality);
          }
        } catch (err) {
          options.emit?.({ type: "warning", message: `[探针6-页图] 第 ${i + 1} 组页面渲染失败（${group.filename}）: ${err?.message || err}` });
          continue;
        }
        if (!dataUrl) continue;

        const base64Data = dataUrl.replace(/^data:image\/jpeg;base64,/, "");
        const bytes = base64ToUint8Array(base64Data);
        await IOUtils.write(filePath, bytes);
        U.throwIfAborted(options.signal);
        newBytesWritten += Number(bytes.byteLength || bytes.length || 0);
      }

      if (newBytesWritten > 0 && this.storage?.recordDeepSeekWebPagesWritten) {
        const totalPagesBytes = this.storage.recordDeepSeekWebPagesWritten(newBytesWritten);
        if (this.storage.shouldAlertDeepSeekWebCache && this.storage.shouldAlertDeepSeekWebCache(totalPagesBytes)) {
          const formatted = this.storage.formatBytes ? this.storage.formatBytes(totalPagesBytes) : `${Math.round(totalPagesBytes / 1048576)} MB`;
          options.emit?.({
            type: "deepseek-web-cache-warning",
            bytes: totalPagesBytes,
            formatted
          });
          this.controller?.notifyDeepSeekWebCacheWarning?.({ bytes: totalPagesBytes, formatted });
        }
      }

      const readyPaths = [];
      for (const p of targetPaths) {
        if (await IOUtils.exists(p)) readyPaths.push(p);
      }
      if (readyPaths.length === targetPaths.length && targetPaths.length) {
        await this.removeObsoletePages(documentID, profile.cacheDir, options);
      }
      return {
        images: readyPaths,
        downgraded: false,
        via: iframeCtx ? "iframe" : "self"
      };
    }

    async renderPagesToDirectory(runtime, outputDir, options = {}) {
      const diagnostics = [];
      const iframeCtx = this.getPreviewIframeContext(runtime, diagnostics);
      let selfDoc = null;
      if (!iframeCtx) selfDoc = await this.loadSelfDocument(runtime, diagnostics);
      if (diagnostics.length) {
        options.emit?.({
          type: "warning",
          message: `[导出PDF页面图] ${diagnostics.join("；")}`
        });
      }

      const pdfDocument = iframeCtx?.pdfDocument || selfDoc;
      const numPages = Number(pdfDocument?.numPages || 0);
      if (!numPages) throw new Error("尚未获取到PDF文档，无法转换页面图像");

      const scale = 300 / 72;
      const images = [];
      await this.storage.ensureDir(outputDir);
      const baseStem = U.safeStem(String(options.stem || "document"), 80, "document");
      const existingNames = new Set((await this.storage.walk(outputDir)).map(path => PathUtils.filename(path)));
      let stem = "";
      for (let serial = 1; serial < 1000; serial++) {
        const candidate = serial === 1 ? baseStem : `${baseStem}-${serial}`;
        const prefix = `${candidate}-第`;
        const conflict = [...existingNames].some(name => name.startsWith(prefix) && name.endsWith("页.png"));
        if (!conflict) {
          stem = candidate;
          break;
        }
      }
      if (!stem) throw new Error("无法为页面图找到不冲突的导出文件名");
      try {
        for (let pageNumber = 1; pageNumber <= numPages; pageNumber++) {
          U.throwIfAborted(options.signal);
          options.emit?.({
            type: "progress",
            phase: "export-pdf-pages",
            message: `正在转换第 ${pageNumber}/${numPages} 页…`,
            progress: Math.round((pageNumber - 1) / numPages * 95)
          });
          let dataURL = "";
          if (iframeCtx) {
            const { cw } = iframeCtx;
            const code = `
              (async () => {
                const pdfDocument = window.PDFViewerApplication && window.PDFViewerApplication.pdfDocument;
                if (!pdfDocument) return JSON.stringify({ ok: false, error: "PDFViewerApplication.pdfDocument 不可用" });
                const page = await pdfDocument.getPage(${pageNumber});
                const viewport = page.getViewport({ scale: ${scale} });
                const canvas = document.createElement("canvas");
                canvas.width = Math.round(viewport.width);
                canvas.height = Math.round(viewport.height);
                const context = canvas.getContext("2d");
                if (!context) return JSON.stringify({ ok: false, error: "iframe 画布 2D 上下文不可用" });
                context.fillStyle = "#ffffff";
                context.fillRect(0, 0, canvas.width, canvas.height);
                await page.render({ canvasContext: context, viewport }).promise;
                return JSON.stringify({ ok: true, dataURL: canvas.toDataURL("image/png") });
              })()
            `;
            const result = JSON.parse(await cw.eval(code));
            if (!result.ok || !result.dataURL) throw new Error(result.error || "页面图像为空");
            dataURL = result.dataURL;
          }
          else {
            const win = runtime.window
              || runtime.browser?.ownerGlobal
              || Zotero.getMainWindow?.()
              || Services.wm.getMostRecentWindow("navigator:browser");
            const doc = win?.document || runtime.browser?.contentDocument || document;
            const canvas = await renderSinglePageToCanvas(selfDoc, pageNumber, doc, scale);
            dataURL = canvas.toDataURL("image/png");
            canvas.width = 1;
            canvas.height = 1;
          }
          const outputPath = PathUtils.join(
            outputDir,
            `${stem}-第${String(pageNumber).padStart(String(numPages).length, "0")}页.png`
          );
          const imageBytes = addPNGResolution(dataURLToUint8Array(dataURL), 300);
          await this.storage.writeBytes(outputPath, imageBytes);
          images.push(outputPath);
        }
      }
      catch (error) {
        await Promise.all(images.map(path => this.storage.remove(path, false)));
        throw error;
      }
      options.emit?.({
        type: "progress",
        phase: "export-pdf-pages",
        message: `已完成 ${numPages} 页，分辨率 300 DPI`,
        progress: 100
      });
      return { images, pageCount: numPages, dpi: 300, via: iframeCtx ? "iframe" : "self" };
    }
  }

  LitMTrans.DeepSeekWeb.PDFPageRenderer = PDFPageRenderer;
  LitMTrans.DeepSeekWeb.getPartitionStrategy = getPartitionStrategy;
})(this);
