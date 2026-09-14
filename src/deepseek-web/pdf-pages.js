(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  LitMTrans.DeepSeekWeb = LitMTrans.DeepSeekWeb || {};
  const U = LitMTrans.Utils;

  const DPI_SCALE = 100 / 72; // 100 dpi (~1.388) 标清阅读清晰度，图表可辨，体积缩减90%
  const JPEG_QUALITY = 0.75;

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

  async function renderSinglePageToCanvas(pdfDoc, pageNum, doc) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: DPI_SCALE });
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

    getPagesDir(documentID) {
      const docDir = PathUtils.join(this.storage.documentsRoot, String(documentID));
      return PathUtils.join(docDir, "deepseek-web", "pages-v2");
    }

    async resolvePDFDocument(runtime, documentID) {
      const existingDoc = runtime?.pdfPreview?._internalReader?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfDocument;
      if (existingDoc && existingDoc.numPages > 0) return existingDoc;

      const attachmentID = runtime?.attachmentID || (documentID ? Number(String(documentID).split("-")[1]) : null);

      let pdfjsLib = runtime?.pdfPreview?._internalReader?._primaryView?._iframeWindow?.pdfjsLib;
      for (const reader of (Zotero.Reader?._readers || [])) {
        const doc = reader?._internalReader?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfDocument;
        if (doc && doc.numPages > 0 && attachmentID && (reader.itemID === attachmentID || reader._itemID === attachmentID)) {
          return doc;
        }
        if (!pdfjsLib) {
          pdfjsLib = reader?._internalReader?._primaryView?._iframeWindow?.pdfjsLib;
        }
      }

      if (!pdfjsLib) {
        try {
          const mod = ChromeUtils.importESModule("resource://pdf.js/build/pdf.mjs");
          pdfjsLib = mod?.pdfjsLib || mod;
        } catch (_) {
          try {
            const mod = ChromeUtils.import("resource://zotero/pdf.js");
            pdfjsLib = mod?.pdfjsLib || mod;
          } catch (_) {}
        }
      }

      if (pdfjsLib && attachmentID) {
        try {
          const item = await Zotero.Items.getAsync(attachmentID);
          if (item?.isAttachment()) {
            const filePath = await item.getFilePathAsync();
            if (filePath && await IOUtils.exists(filePath)) {
              const data = await IOUtils.read(filePath);
              const loadingTask = pdfjsLib.getDocument({ data });
              return await loadingTask.promise;
            }
          }
        } catch (_) {}
      }
      return null;
    }

    async renderAndCachePages(runtime, documentID, options = {}) {
      const pagesDir = this.getPagesDir(documentID);
      await this.storage.ensureDir(pagesDir);

      const pdfDoc = await this.resolvePDFDocument(runtime, documentID);
      if (!pdfDoc) {
        return {
          images: [],
          downgraded: false,
          error: "尚未获取到PDF文档，无法渲染页面"
        };
      }

      const numPages = pdfDoc.numPages;
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
        return { images: targetPaths, downgraded: false, cached: true };
      }

      const win = runtime.window
        || runtime.browser?.ownerGlobal
        || Zotero.getMainWindow?.()
        || Services.wm.getMostRecentWindow("navigator:browser");
      const doc = win?.document || runtime.browser?.contentDocument || document;

      for (let i = 0; i < strategy.groups.length; i++) {
        const group = strategy.groups[i];
        const filePath = targetPaths[i];
        if (await IOUtils.exists(filePath)) continue;

        options.emit?.({ type: "log", message: `[探针5-Provider] 正在准备文献标清页面 (${i + 1}/${strategy.groups.length})...` });

        const renderedCanvases = [];
        for (const pageNum of group.pages) {
          const canvas = await renderSinglePageToCanvas(pdfDoc, pageNum, doc);
          renderedCanvases.push(canvas);
        }

        const finalCanvas = await stitchCanvasesHorizontal(renderedCanvases, doc);
        const dataUrl = finalCanvas.toDataURL("image/jpeg", JPEG_QUALITY);
        const base64Data = dataUrl.replace(/^data:image\/jpeg;base64,/, "");
        const bytes = base64ToUint8Array(base64Data);
        await IOUtils.write(filePath, bytes);
      }

      return {
        images: targetPaths,
        downgraded: false,
        cached: false
      };
    }
  }

  LitMTrans.DeepSeekWeb.PDFPageRenderer = PDFPageRenderer;
  LitMTrans.DeepSeekWeb.getPartitionStrategy = getPartitionStrategy;
})(this);
