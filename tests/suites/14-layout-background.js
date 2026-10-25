"use strict";

module.exports = function (env) {
  const { assert, fs, path, root, vm } = env;
  const ts = require("typescript");
  const { parseHTML } = require("linkedom");
  const workbench = fs.readFileSync(path.join(root, "src/workbench.js"), "utf8");
  const ast = ts.createSourceFile("workbench.js", workbench, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = new Map();
  function visit(node) {
    if (ts.isFunctionDeclaration(node)) functions.set(node.name.text, node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  function load(names, values = {}) {
    const sandbox = vm.createContext(values);
    vm.runInContext(names.map(name => functions.get(name)).join("\n"), sandbox);
    return sandbox;
  }
  function pixels(rgb, width = 24, height = 24) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) data.set([...rgb, 255], i);
    return data;
  }
  function dom() {
    const { document, window } = parseHTML('<html><body><div id="translation-layout"></div></body></html>');
    const createElement = document.createElement.bind(document);
    document.createElement = name => {
      const node = createElement(name);
      if (name === "canvas") {
        node.width = node.height = 24;
        node._pixels = pixels([255, 255, 255]);
        node.getContext = () => ({
          drawImage(source) { node._pixels = new Uint8ClampedArray(source._pixels); },
          getImageData() { return { data: new Uint8ClampedArray(node._pixels) }; },
          putImageData(value) { node._pixels = new Uint8ClampedArray(value.data); },
          clearRect() {}, fillRect() {}
        });
        node.toDataURL = () => "data:image/png;base64,native";
      }
      if (name === "img") node.decode = async () => {};
      return node;
    };
    return { document, window };
  }

  function coloredBackgroundsAndUncertainFallback() {
    const sandbox = load(["medianByte", "samplePerimeterColor", "eraseAndPatchPageBackground"]);
    for (const rgb of [[20, 60, 110], [46, 52, 64], [230, 230, 230], [255, 255, 255]]) {
      const data = pixels(rgb);
      const sample = sandbox.samplePerimeterColor(data, 24, 24, 2, 2, 20, 20);
      assert.deepEqual([sample.r, sample.g, sample.b], rgb);
      assert.equal(sample.isWhitePaper, rgb[0] === 255);
      assert.equal(sample.available, true);
    }
    const { document } = dom();
    const canvas = document.createElement("canvas");
    canvas._pixels = pixels([20, 60, 110]);
    const node = document.createElement("div");
    const page = { width: 24, height: 24 };
    const item = { boxes: [[4, 4, 18, 18]], kind: "text", node, allowDarkBg: true };
    const before = JSON.stringify(page);
    assert.equal(sandbox.eraseAndPatchPageBackground(canvas, page, [item]), true);
    assert.equal(node.dataset.onDarkBg, "1");
    assert.equal(JSON.stringify(page), before, "runtime adaptation must not mutate the cached page model");
    canvas._pixels = new Uint8ClampedArray(24 * 24 * 4);
    assert.equal(sandbox.eraseAndPatchPageBackground(canvas, page, [item]), false, "missing background samples must retain the existing renderer");
    const fills = [];
    const opaque = {
      getImageData: () => ({ data: pixels([255, 255, 255]) }),
      clearRect() { throw new Error("native PDF backgrounds must remain opaque"); },
      fillRect() { fills.push(this.fillStyle); }
    };
    assert.equal(sandbox.eraseAndPatchPageBackground({ width: 24, height: 24, getContext: () => opaque }, page, [item]), true);
    assert.deepEqual(fills, ["#ffffff"]);
  }

  async function nativePDFRenderingSkipsWindowTheme() {
    const sandbox = vm.createContext({ LitMTrans: { Utils: {} } });
    vm.runInContext(fs.readFileSync(path.join(root, "src/deepseek-web/pdf-pages.js"), "utf8"), sandbox);
    const renderer = new sandbox.LitMTrans.DeepSeekWeb.PDFPageRenderer({ storage: {} });
    const calls = [];
    const { document } = dom();
    const page = { getViewport: () => ({ width: 24, height: 24 }), render: options => {
      calls.push({ skipBlender: options.canvasContext.skipBlender, pageColors: options.pageColors });
      return { promise: Promise.resolve() };
    } };
    const pdfDocument = { numPages: 1, getPage: async () => page };
    const iframe = vm.createContext({ window: { theme: { background: "#2E3440" }, PDFViewerApplication: { pdfDocument } }, document });
    renderer.getPreviewIframeContext = () => ({ pdfDocument, cw: { eval: code => vm.runInContext(code, iframe) } });
    await renderer.renderPage({}, 1, { nativeColors: true, returnDataURL: true });
    renderer.getPreviewIframeContext = () => null;
    renderer.loadSelfDocument = async () => pdfDocument;
    await renderer.renderPage({ window: { document } }, 1, { nativeColors: true, returnDataURL: true });
    await renderer.renderPage({ window: { document } }, 1, { returnDataURL: true });
    assert.deepEqual(calls, [
      { skipBlender: true, pageColors: undefined },
      { skipBlender: true, pageColors: undefined },
      { skipBlender: undefined, pageColors: undefined }
    ], "native background rendering must bypass Blender in both realms without changing other rendering callers");
  }

  function screenThemeNeverChangesNativePixels() {
    const { document, window } = dom();
    vm.runInNewContext(fs.readFileSync(path.join(root, "src/reader-images.js"), "utf8"), {
      window, document, MutationObserver: class { observe() {} }
    });
    const page = document.createElement("div");
    page.className = "layout-page has-pdf-bg";
    const canvas = document.createElement("canvas");
    canvas.className = "layout-page-bg";
    canvas._pixels = pixels([0, 0, 0]);
    page.appendChild(canvas);
    document.getElementById("translation-layout").appendChild(page);
    const native = Array.from(canvas._pixels);
    const neutralLabel = document.createElement("div");
    neutralLabel.dataset.onDarkBg = "1";
    neutralLabel.dataset.pdfBackgroundRgb = "0,0,0";
    const blueLabel = document.createElement("div");
    blueLabel.dataset.onDarkBg = "1";
    blueLabel.dataset.pdfBackgroundRgb = "53,36,184";
    page.append(neutralLabel, blueLabel);
    const images = window.LitMTrans.ReaderImages;
    images.setTheme({ background: "#2E3440", foreground: "#D8DEE9" });
    assert.deepEqual(Array.from(page.querySelector(".reader-background-overlay")._pixels.slice(0, 3)), [216, 222, 233]);
    assert.equal(neutralLabel.style.getPropertyValue("--layout-background-ink"), "#2E3440");
    assert.equal(blueLabel.style.getPropertyValue("--layout-background-ink"), "#D8DEE9");
    images.setTheme({ background: "#000000", foreground: "#FFFFFF" });
    assert.equal(page.querySelectorAll(".reader-background-overlay").length, 1);
    assert.deepEqual(Array.from(page.querySelector(".reader-background-overlay")._pixels.slice(0, 3)), [255, 255, 255]);
    assert.deepEqual(Array.from(canvas._pixels), native);
    images.setTheme({ background: "#ffffff", foreground: "#121212" });
    assert.equal(page.querySelectorAll(".reader-background-overlay").length, 0);
    assert.equal(page.classList.contains("has-themed-pdf-bg"), false);
  }

  async function printSnapshotUsesNativeCompressedBackground() {
    const { document } = dom();
    const source = document.createElement("div");
    source.className = "layout-page has-pdf-bg has-themed-pdf-bg";
    const canvas = document.createElement("canvas");
    canvas.className = "layout-page-bg reader-color-background";
    source.appendChild(canvas);
    for (const name of ["reader-background-overlay", "reader-image-overlay"]) {
      const overlay = document.createElement("canvas");
      overlay.className = name;
      overlay.toDataURL = () => { throw new Error("screen pixels must never enter print output"); };
      source.appendChild(overlay);
    }
    const clone = source.cloneNode(true);
    const sandbox = load(["copyLayoutCanvasPaint"], { document });
    await sandbox.copyLayoutCanvasPaint(source, clone);
    assert.equal(clone.querySelectorAll("canvas").length, 0);
    assert.equal(clone.querySelector("img.layout-page-bg").src, "data:image/png;base64,native");
    assert.equal(clone.classList.contains("has-themed-pdf-bg"), false);
    assert.equal(source.querySelectorAll("canvas").length, 3);
  }

  async function offscreenCanvasesAreReleasedAndStaleLoadsCannotPublish() {
    const { document, window } = dom();
    const container = document.getElementById("translation-layout");
    const wrap = document.createElement("section");
    wrap.className = "layout-page-wrap";
    const page = document.createElement("div");
    page.className = "layout-page";
    const canvas = document.createElement("canvas");
    canvas.className = "layout-page-bg";
    page._litmtransPageModel = { index: 1, width: 24, height: 24 };
    page.appendChild(canvas); wrap.appendChild(page); container.appendChild(wrap);
    let notify, release;
    let pending = new Promise(resolve => release = resolve);
    const sandbox = load(["renderLayoutPageBackground", "installLayoutBackgroundManager"], {
      window, state: { data: { item: { attachmentID: 1 } } }, els: { "translation-layout": container },
      IntersectionObserver: class { constructor(callback) { notify = callback; } observe() {} disconnect() {} },
      fetchLayoutPageBackgroundImage: () => pending,
      eraseAndPatchPageBackground: () => true
    });
    sandbox.installLayoutBackgroundManager(container, null);
    notify([{ target: wrap, isIntersecting: true }]);
    const oldTask = page._litmtransBgPromise;
    notify([{ target: wrap, isIntersecting: false }]);
    release({ naturalWidth: 24, naturalHeight: 24, _pixels: pixels([255, 255, 255]) });
    assert.equal(await oldTask, false);
    assert.equal(page.classList.contains("has-pdf-bg"), false);
    assert.equal(canvas.width, 1);
    pending = Promise.resolve({ naturalWidth: 24, naturalHeight: 24, _pixels: pixels([255, 255, 255]) });
    const manager = container._litmtransBgManager;
    manager.prepareForPrint();
    page._litmtransBgPromise = Promise.resolve(false).finally(() => { page._litmtransBgPromise = null; });
    await manager.preparePageForPrint(page);
    assert.equal(page.classList.contains("has-pdf-bg"), true);
    manager.releasePageAfterPrint(page);
    assert.equal(canvas.width, 1);
    manager.resume(); manager.disconnect();
  }

  async function concurrentPrintSnapshotsAreSerialized() {
    let active = 0, maximum = 0;
    const order = [];
    const run = async (kind, callback) => {
      active++; maximum = Math.max(maximum, active); order.push(kind);
      try { await Promise.resolve(); return await callback(); }
      finally { active--; }
    };
    const sandbox = load(["withReaderPrintSnapshot", "withLayoutPaintPrintRoot", "withFrozenLayoutPrintRoot", "withStreamPrintRoot"], {
      readerPrintSnapshotTask: Promise.resolve(),
      buildLayoutPaintPrintRoot: (callback, pane) => run(pane || "translation", callback),
      buildFrozenLayoutPrintRoot: callback => run("frozen", callback),
      buildStreamPrintRoot: (pane, callback) => run(pane, callback)
    });
    const results = await Promise.allSettled([
      sandbox.withLayoutPaintPrintRoot(() => 1, "source"),
      sandbox.withFrozenLayoutPrintRoot(() => { throw new Error("controlled print failure"); }),
      sandbox.withStreamPrintRoot("stream", () => 3)
    ]);
    assert.equal(maximum, 1, "different export entrypoints must never mount two print roots together");
    assert.deepEqual(order, ["source", "frozen", "stream"]);
    assert.equal(results[1].status, "rejected");
    assert.equal(results[2].value, 3, "a failed print must release the snapshot lock");
  }

  async function comparisonUsesOneScaleAndTopAlignment() {
    const draws = [], sizes = [];
    const sourcePages = [{ width: 595, height: 842 }, { width: 612, height: 809.972 }];
    const translatedPages = [{ width: 612, height: 842 }, { width: 612, height: 842 }];
    const document = pages => ({ getPageCount: () => pages.length, getPage: index => pages[index] });
    const PDFLib = { PDFDocument: {
      load: async bytes => document(bytes[0] === 1 ? sourcePages : translatedPages),
      create: async () => ({ embedPage: async page => page, save: async () => new Uint8Array([3]),
        addPage: size => { const rows = []; draws.push(rows); sizes.push(size); return { drawPage: (page, options) => rows.push({ page, ...options }) }; }
      })
    } };
    const method = env.context.LitMTrans.Controller.prototype.createLayoutComparisonPDF;
    const create = vm.runInNewContext(`({${method}}).createLayoutComparisonPDF`, { PDFLib, global: { Uint8Array } });
    await create.call({ storage: { readBytes: async name => new Uint8Array([name === "source" ? 1 : 2]), writeBytes: async () => {} } }, "source", "translation", "output");
    for (const rows of draws) for (const row of rows) {
      assert.equal(row.width, row.page.width);
      assert.equal(row.height, row.page.height, "the shorter source page must not be enlarged to the common print sheet");
    }
    const [left, right] = draws[1];
    assert(Math.abs((left.y + 20) - (right.y + 52.028)) < .001, "corresponding footer positions must align despite bottom print padding");
    assert.equal(sizes[1][1], 866);
  }

  async function unexpectedPageCountCannotDiscardRealPages() {
    let pageCount = 32, writes = 0, settings;
    const method = env.context.LitMTrans.Controller.prototype.printWorkbenchPDF;
    const print = vm.runInNewContext(`({${method}}).printWorkbenchPDF`, {
      global: { Uint8Array }, U: { safeStem: value => value }, setTimeout: callback => callback(),
      Cc: { "@mozilla.org/gfx/printsettings-service;1": { getService: () => ({ createNewPrintSettings: () => ({}) }) } },
      Ci: { nsIPrintSettingsService: {}, nsIPrintSettings: { kOutputDestinationFile: 1, kOutputFormatPDF: 2 } },
      PDFLib: { PDFDocument: { load: async () => ({ getPageCount: () => pageCount }) } }
    });
    const controller = {
      storage: { stat: async () => ({ size: 2000 }), readBytes: async () => [1], writeBytes: async () => writes++ },
      attachmentContext: async () => ({ title: "paper", attachment: {}, filePath: "source" }),
      isOriginalAttachmentPath: async () => false
    };
    const runtime = { browser: { browsingContext: { print: async value => { settings = value; } } } };
    await assert.rejects(print.call(controller, runtime, { path: "output", layout: true, expectedPages: 16 }), /预期 16 页，实际 32 页/);
    assert.equal(writes, 0, "a doubled document must be rejected intact instead of losing every second page");
    assert.equal(settings.numCopies, 1);
    pageCount = 16;
    assert.equal((await print.call(controller, runtime, { path: "output", layout: true, expectedPages: 16 })).cancelled, false);
  }

  async function nativeThemeBackgroundDropsObsoleteResults() {
    const { document, window } = dom();
    vm.runInNewContext(fs.readFileSync(path.join(root, "src/reader-images.js"), "utf8"), { window, document, MutationObserver: class { observe() {} } });
    const page = document.createElement("div"); page.className = "layout-page has-pdf-bg";
    const source = document.createElement("canvas"); source.className = "layout-page-bg"; source._litmtransBgVersion = 1;
    page.appendChild(source); document.getElementById("translation-layout").appendChild(page);
    const requests = [];
    source._litmtransRenderTheme = theme => new Promise(resolve => requests.push({ theme, resolve }));
    const api = window.LitMTrans.ReaderImages;
    api.setTheme({ background: "#2E3440", foreground: "#D8DEE9" });
    const first = api.paintBackground(source);
    api.setTheme({ background: "#000000", foreground: "#FFFFFF" });
    const second = api.paintBackground(source);
    const old = document.createElement("canvas"), current = document.createElement("canvas");
    current._pixels = pixels([255, 255, 255]);
    current._pixels.set([0, 0, 0, 255], 4);
    current._pixels.set([255, 0, 0, 255], 8);
    requests[1].resolve({ canvas: current, displayBackgrounds: [] }); await second;
    requests[0].resolve({ canvas: old, displayBackgrounds: [] }); await first;
    assert.equal(page.querySelector(".reader-background-overlay"), current);
    assert.equal(current._pixels[3], 0, "white image backgrounds must reveal the current paper color");
    assert.deepEqual(Array.from(current._pixels.slice(4, 8)), [255, 255, 255, 255], "neutral lines must follow the current foreground");
    assert.deepEqual(Array.from(current._pixels.slice(8, 12)), [255, 0, 0, 255], "colored data must retain its color");
    assert.equal(old.width, 1);
    assert.equal(page.querySelectorAll(".reader-background-overlay").length, 1);
    assert.deepEqual(Array.from(source._pixels.slice(0, 3)), [255, 255, 255]);
  }

  async function nativeFigureGroupsAndTableProtection() {
    const { document, window } = dom();
    const imageNode = document.createElement("div"); imageNode.className = "layout-block layout-image type-image_body";
    const image = document.createElement("img"); image.src = "figure.png"; imageNode.appendChild(image);
    const tableNode = document.createElement("div"); tableNode.className = "layout-block layout-image type-table_body layout-table-translation-host";
    const items = [
      { kind: "image", boxes: [[2, 2, 8, 8]], node: imageNode },
      { kind: "image", boxes: [[14, 2, 22, 8]], node: imageNode },
      { kind: "image", boxes: [[2, 14, 22, 22]], node: tableNode }
    ];
    let fills = 0;
    const context = { getImageData: () => ({ data: pixels([211, 211, 211]) }), fillRect: () => fills++ };
    const canvas = { width: 24, height: 24, getContext: () => context };
    const sampler = load(["medianByte", "samplePerimeterColor", "eraseAndPatchPageBackground"]);
    const displayRetainedImages = [];
    sampler.eraseAndPatchPageBackground(canvas, { width: 24, height: 24 }, items, {
      displayBackgrounds: [], displayRetainedImages
    });
    assert.equal(fills, 1, "display rendering must retain compound-figure pixels and gaps while still erasing replacement tables");
    assert(displayRetainedImages.every(node => node === imageNode));
    fills = 0;
    sampler.eraseAndPatchPageBackground(canvas, { width: 24, height: 24 }, items);
    assert.equal(fills, 3, "native PDF export must keep its existing image replacement path");

    vm.runInNewContext(fs.readFileSync(path.join(root, "src/reader-images.js"), "utf8"), { window, document, MutationObserver: class { observe() {} } });
    const page = document.createElement("div"); page.className = "layout-page has-pdf-bg";
    const source = document.createElement("canvas"); source.className = "layout-page-bg"; source._litmtransBgVersion = 1;
    const background = document.createElement("canvas");
    const button = document.createElement("div");
    source._litmtransRenderTheme = async () => ({ canvas: background,
      displayBackgrounds: [{ node: button, rgb: [220, 220, 220] }], displayRetainedImages: [imageNode] });
    page.append(source, imageNode, tableNode, button); document.getElementById("translation-layout").appendChild(page);
    const api = window.LitMTrans.ReaderImages;
    api.setTheme({ background: "#2E3440", foreground: "#D8DEE9" });
    await api.paintBackground(source);
    assert.equal(imageNode.dataset.pdfScreenRetained, "1");
    assert.equal(tableNode.dataset.pdfScreenRetained, undefined);
    assert.equal(image.isConnected, true);
    assert.equal(image.hasAttribute("hidden"), false, "retain original image elements for context menus and preview actions");
    assert.equal(button.dataset.themedBackgroundInk, "1");
    assert.equal(button.style.getPropertyValue("--layout-background-ink"), "#D8DEE9", "text over the fused raw background must retain contrast");
  }

  async function displayBackgroundRequestsRawFigureColors() {
    const { document } = dom();
    let request;
    const sandbox = load(["renderLayoutDisplayBackground"], {
      document, LAYOUT_BG_RENDER_SCALE: 2,
      queueLayoutBackgroundRender: callback => callback(),
      hostCall: async (_, payload) => { request = payload; return { available: true, dataURL: "native-page" }; },
      Image: class { constructor() { this.naturalWidth = this.naturalHeight = 24; this._pixels = pixels([255, 255, 255]); } async decode() {} },
      eraseAndPatchPageBackground: (_, __, ___, options) => {
        assert.equal(options.paperRGB, undefined, "screen erasure must start with native white paper before theme fusion");
        return true;
      }
    });
    const result = await sandbox.renderLayoutDisplayBackground(240, 11, { width: 24, height: 24 }, []);
    assert.equal(request.displayTheme, undefined, "do not feed Zotero-tinted figures into the legacy white-paper fusion");
    assert.deepEqual(Array.from(result.canvas._pixels.slice(0, 4)), [255, 255, 255, 255]);
  }

  return { coloredBackgroundsAndUncertainFallback, nativePDFRenderingSkipsWindowTheme,
    screenThemeNeverChangesNativePixels, printSnapshotUsesNativeCompressedBackground,
    offscreenCanvasesAreReleasedAndStaleLoadsCannotPublish, concurrentPrintSnapshotsAreSerialized,
    comparisonUsesOneScaleAndTopAlignment, unexpectedPageCountCannotDiscardRealPages,
    nativeThemeBackgroundDropsObsoleteResults, nativeFigureGroupsAndTableProtection,
    displayBackgroundRequestsRawFigureColors };
};
