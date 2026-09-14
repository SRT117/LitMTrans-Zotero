(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  LitMTrans.DeepSeekWeb = LitMTrans.DeepSeekWeb || {};
  const U = LitMTrans.Utils;

  const DPI_SCALE = 250 / 72; // 250 dpi (~3.472)
  const JPEG_QUALITY = 0.90;

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

  function getPartitionStrategy(numPages) {
    if (numPages <= 50) {
      const groups = [];
      for (let p = 1; p <= numPages; p++) {
        const name = `Page_${String(p).padStart(2, "0")}.jpg`;
        groups.push({ pages: [p], filename: name });
      }
      return { chunkSize: 1, groups, downgraded: false };
    }
    if (numPages <= 100) {
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
    if (numPages <= 150) {
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
      message: "文献超过 150 页，已自动切换为纯文本深度问答模式"
    };
  }

  async function renderSinglePageToCanvas(pdfDoc, pageNum, doc) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: DPI_SCALE });
    const canvas = doc.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas;
  }

  async function stitchCanvasesHorizontal(canvases, doc) {
    if (canvases.length === 1) return canvases[0];
    const totalWidth = canvases.reduce((sum, c) => sum + c.width, 0);
    const maxHeight = Math.max(...canvases.map(c => c.height));
    const stitched = doc.createElement("canvas");
    stitched.width = totalWidth;
    stitched.height = maxHeight;
    const ctx = stitched.getContext("2d");
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
      return PathUtils.join(docDir, "deepseek-web", "pages");
    }

    async resolvePDFDocument(runtime, documentID) {
      const existingDoc = runtime?.pdfPreview?._internalReader?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfDocument;
      if (existingDoc && existingDoc.numPages > 0) return existingDoc;

      const pdfWindow = runtime?.pdfPreview?._internalReader?._primaryView?._iframeWindow;
      const pdfjsLib = pdfWindow?.pdfjsLib;
      if (pdfjsLib && runtime?.attachmentID) {
        const item = await Zotero.Items.getAsync(runtime.attachmentID);
        if (item?.isAttachment()) {
          const filePath = await item.getFilePathAsync();
          if (filePath && await IOUtils.exists(filePath)) {
            const data = await IOUtils.read(filePath);
            const loadingTask = pdfjsLib.getDocument({ data });
            return await loadingTask.promise;
          }
        }
      }
      return null;
    }

    async renderAndCachePages(runtime, documentID) {
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
      const strategy = getPartitionStrategy(numPages);
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

      const win = runtime.window || Services.wm.getMostRecentWindow("navigator:browser");
      const doc = win?.document || runtime.browser?.contentDocument || document;

      for (let i = 0; i < strategy.groups.length; i++) {
        const group = strategy.groups[i];
        const filePath = targetPaths[i];
        if (await IOUtils.exists(filePath)) continue;

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
