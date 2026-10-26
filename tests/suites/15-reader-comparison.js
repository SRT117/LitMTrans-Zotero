"use strict";

module.exports = function(env) {
  const { assert, fs, path, root, vm } = env;
  const ts = require("typescript");
  const source = ts.createSourceFile("controller.js", fs.readFileSync(path.join(root, "src/controller.js"), "utf8"), ts.ScriptTarget.Latest, true);
  const methods = [];
  const names = new Set(["isRegisteredComparisonAttachment", "ensureReaderComparisonDarkSupport", "patchReaderViewerWindow", "patchReaderComparisonBlender", "readerItemID"]);
  function visit(node) {
    if (ts.isMethodDeclaration(node) && names.has(node.name.getText(source))) methods.push(node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  const imageThemeScope = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/reader-image-theme.js"), "utf8"), imageThemeScope);
  function controller(values = {}) {
    const Controller = vm.runInNewContext("(class {" + methods.join("\n") + "})", { global: imageThemeScope, Cu: { exportFunction: fn => fn, waiveXrays: value => value }, ...values });
    return Object.assign(new Controller(), { log() {}, isWorkbenchReader: () => false });
  }
  function fixture() {
    const image = { width: 2, height: 2, pixels: new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 240, 240, 240, 255, 254, 254, 254, 255]) };
    const handlers = new Map();
    const win = {
      theme: { background: "#2E3440", foreground: "#D8DEE9" },
      CanvasRenderingContext2D: class {},
      pdfjsLib: { OPS: { paintFormXObjectBegin: 74, paintFormXObjectEnd: 75, constructPath: 91, fill: 22 } },
      addEventListener() {}, removeEventListener() {},
      PDFViewerApplication: {
        pdfViewer: { _pages: [] },
        eventBus: { _on: (name, fn) => handlers.set(name, fn), _off: (name, fn) => { if (handlers.get(name) === fn) handlers.delete(name); } }
      },
      document: { createElement() {
        const canvas = { width: 0, height: 0 };
        canvas.getContext = () => ({
          drawImage(img) { canvas.pixels = new Uint8ClampedArray(img.pixels); },
          getImageData() { return { data: new Uint8ClampedArray(canvas.pixels) }; },
          putImageData(value) { canvas.pixels = new Uint8ClampedArray(value.data); }
        });
        return canvas;
      } }
    };
    class Blender {
      constructor() {
        this.dark = true;
        this.pageWidth = this.pageHeight = 1000;
        this.ctx = { fillStyle: "#ffffff", globalAlpha: 1, globalCompositeOperation: "source-over", getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) };
        this.cachedImage = "old white background";
        this.background = { lightness: 20, deltaE: color => Math.abs(color.lightness - 20) };
        this.foreground = { lightness: 90 };
        this.fallbacks = 0;
        this.draws = [];
      }
      deleteCachedImage() { delete this.cachedImage; }
      origFillStyle(value) { this.ctx.fillStyle = value; }
      getTextStyle(color) { return color; }
      customDrawImage(args) { this.fallbacks++; this.lastFallback = args; return "original"; }
      origDrawImage(...args) { this.draws.push(args); return "drawn"; }
    }
    class Graphics {
      constructor(blender) {
        this.blender = blender; this.ctx = blender.ctx; this.baseTransformStack = [];
        this.current = { fillColor: "#ffffff", fillAlpha: 1, patternFill: false };
        this.fills = [];
      }
      paintFormXObjectBegin() { this.baseTransformStack.push(null); }
      paintFormXObjectEnd() { this.baseTransformStack.pop(); }
      constructPath(opIdx, op, data, bounds) {
        this.fills.push({ style: this.ctx.fillStyle, op, data, bounds });
        if (this.failFill) throw new Error("native fill failed");
        return "filled";
      }
    }
    Graphics.prototype[74] = Graphics.prototype.paintFormXObjectBegin;
    Graphics.prototype[75] = Graphics.prototype.paintFormXObjectEnd;
    Graphics.prototype[91] = Graphics.prototype.constructPath;
    return { image, win, handlers, Blender, Graphics, args: [image, 520, 12, 468, 976] };
  }

  async function onlyRegisteredComparisonReadersAreAttached() {
    const attachment = (id, key, parentID = 10, libraryID = 1) => ({ id, key, parentID, libraryID, attachmentContentType: "application/pdf", isAttachment: () => true });
    const items = new Map([[1, attachment(1, "SOURCE")], [2, attachment(2, "COMPARE")], [3, attachment(3, "TRANSLATE")], [4, attachment(4, "ORDINARY")], [10, { getAttachments: () => [1, 2, 3, 4] }]]);
    const c = controller({ Zotero: { Items: { get: id => items.get(id) } } });
    c.storage = { documentID: item => item.key, path: (...args) => args.join("/"), readJSON: async p => p.startsWith("SOURCE/") ? [{ comparisonKey: "COMPARE", translationKey: "TRANSLATE" }] : [] };
    assert.equal(await c.isRegisteredComparisonAttachment(2), true);
    for (const id of [1, 3, 4]) {
      const reader = { itemID: id, _internalReader: { _primaryView: { _iframeWindow: {} } } };
      c.patchReaderViewerWindow = () => { throw new Error("must not patch other readers"); };
      await c.ensureReaderComparisonDarkSupport(reader);
      assert.equal(c.readerComparisonBindings.size, 0);
    }
    const calls = [];
    const reader = { itemID: 2, _waitForReader: async () => {}, _internalReader: { _primaryView: { _iframeWindow: {} } } };
    c.patchReaderViewerWindow = (_, active) => { assert.equal(active(), true); calls.push("attach"); return () => calls.push("detach"); };
    await c.ensureReaderComparisonDarkSupport(reader);
    await c.ensureReaderComparisonDarkSupport(reader);
    for (const dispose of c.readerComparisonBindings.values()) dispose();
    assert.deepEqual(calls, ["attach", "detach"]);
    assert.equal(c.readerComparisonBindings.size, 0);
    items.get(1).libraryID = 2;
    assert.equal(await c.isRegisteredComparisonAttachment(2), false);
  }

  function backgroundDrawPreservesBookkeepingAndDrawingChain() {
    const f = fixture(), c = controller(), blender = new f.Blender();
    const prototype = Object.getOwnPropertyDescriptors(f.win.CanvasRenderingContext2D.prototype);
    const native = blender.origDrawImage;
    let pluginCalls = 0;
    blender.origDrawImage = function(...args) { pluginCalls++; return native.apply(this, args); };
    const originalPixels = Array.from(f.image.pixels);
    const restore = c.patchReaderComparisonBlender(f.win, blender, () => true);
    assert.equal(blender.customDrawImage(f.args), "drawn");
    assert.equal(blender.hasBackgrounds, true);
    assert.equal(blender.cachedImage, undefined);
    assert.deepEqual(Array.from(blender.draws[0][0].pixels.slice(0, 3)), [46, 52, 64]);
    assert.equal(pluginCalls, 1);
    assert.equal(blender.fallbacks, 0);
    assert.equal(blender.ctx.globalAlpha, 1);
    assert.equal(blender.ctx.globalCompositeOperation, "source-over");
    assert.deepEqual(Array.from(f.image.pixels), originalPixels);
    assert.deepEqual(Object.getOwnPropertyDescriptors(f.win.CanvasRenderingContext2D.prototype), prototype);
    restore();
    assert.equal(blender.customDrawImage(f.args), "original");
  }

  function uncertainImagesAndHostModesKeepOriginalBehavior() {
    for (const change of [
      f => { f.args[1] = 12; },
      f => { f.args[3] = 100; f.args[4] = 100; },
      f => { f.win.theme = { background: "#FFFFFF", foreground: "#000000" }; },
      (f, b) => { b.forceInversion = true; },
      (f, b) => { b.ctx.globalAlpha = .5; },
      (f, b) => { b.ctx.globalCompositeOperation = "multiply"; },
      f => { f.image.pixels[3] = 128; },
      f => { f.win.theme.background = "invalid"; },
      (f, b) => { b.ctx.getTransform = () => ({ a: 0, b: 1, c: -1, d: 0, e: 1000, f: 0 }); },
      f => { f.args = [f.image, 1, 0, 1, 2, 520, 12, 468, 976]; }
    ]) {
      const f = fixture(), c = controller(), b = new f.Blender();
      change(f, b);
      c.patchReaderComparisonBlender(f.win, b, () => true);
      assert.equal(b.customDrawImage(f.args), "original");
      assert.equal(b.fallbacks, 1);
      assert.strictEqual(b.lastFallback, f.args);
      assert.equal(b.draws.length, 0);
    }
    const f = fixture(), c = controller(), b = new f.Blender();
    c.patchReaderComparisonBlender(f.win, b, () => true);
    assert.equal(b.customDrawImage([f.image, 0, 0, 2, 2, 520, 12, 468, 976]), "drawn");
    f.win.theme = { background: "#000000", foreground: "#FFFFFF" };
    b.customDrawImage(f.args);
    assert.deepEqual(Array.from(b.draws.at(-1)[0].pixels.slice(0, 3)), [0, 0, 0]);
  }

  function grayscaleFastPathPreservesEveryShadeAndAlpha() {
    for (const theme of [
      { background: "#2E3440", foreground: "#D8DEE9", bg: [46, 52, 64], fg: [216, 222, 233] },
      { background: "#F4ECD8", foreground: "#5B4636", bg: [244, 236, 216], fg: [91, 70, 54] }
    ]) {
      const f = fixture(), c = controller(), b = new f.Blender();
      f.win.theme = theme;
      c.patchReaderComparisonBlender(f.win, b, () => true);
      b.customDrawImage(f.args);
      const pixels = new Uint8ClampedArray(256 * 4);
      for (let gray = 0; gray < 256; gray++) pixels.set([gray, gray, gray, gray], gray * 4);
      const image = { width: 16, height: 16, pixels };
      assert.equal(b.customDrawImage([image, 600, 300, 200, 180]), "drawn");
      const output = b.draws.at(-1)[0].pixels;
      for (let gray = 0; gray < 256; gray++) {
        const coverage = 1 - gray / 255;
        const expected = theme.fg.map((ink, channel) => Math.round(ink * coverage + theme.bg[channel] * (1 - coverage)));
        assert.deepEqual(Array.from(output.slice(gray * 4, gray * 4 + 3)), expected);
        assert.equal(output[gray * 4 + 3], gray);
        assert.deepEqual(Array.from(pixels.slice(gray * 4, gray * 4 + 4)), [gray, gray, gray, gray]);
      }
    }
  }

  function protectedPixelBufferDoesNotDisableThemeConversion() {
    const f = fixture(), c = controller(), b = new f.Blender();
    const createElement = f.win.document.createElement;
    f.win.document.createElement = function(...args) {
      const canvas = createElement.apply(this, args);
      const context = canvas.getContext();
      const getImageData = context.getImageData;
      context.getImageData = function(...values) {
        const data = getImageData.apply(this, values);
        data.data = new Proxy(data.data, { get(target, property) {
          if (property === "buffer") throw new Error("cross-window buffer is protected");
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        } });
        return data;
      };
      canvas.getContext = () => context;
      return canvas;
    };
    c.patchReaderComparisonBlender(f.win, b, () => true);
    assert.equal(b.customDrawImage(f.args), "drawn");
    assert.equal(b.fallbacks, 0);
    assert.deepEqual(Array.from(b.draws[0][0].pixels.slice(0, 3)), [46, 52, 64]);
  }

  function pixelLoopUsesTheReaderWindowTransformer() {
    const f = fixture(), c = controller(), b = new f.Blender();
    let calls = 0;
    f.win.LitMTransReaderImageTheme = { recolor(data, ...args) {
      calls++;
      assert.deepEqual(args, [46, 52, 64, 216, 222, 233, true]);
      return imageThemeScope.LitMTransReaderImageTheme.recolor(data, ...args);
    } };
    c.patchReaderComparisonBlender(f.win, b, () => true);
    assert.equal(b.customDrawImage(f.args), "drawn");
    assert.equal(calls, 1);
    assert.deepEqual(Array.from(b.draws[0][0].pixels.slice(0, 3)), [46, 52, 64]);
    b.customDrawImage(f.args);
    assert.equal(calls, 1, "reuse an already converted image");
  }

  function otherPluginHooksSurviveCleanupAndErrors() {
    const f = fixture(), c = controller(), b = new f.Blender();
    const restore = c.patchReaderComparisonBlender(f.win, b, () => true);
    const ours = b.customDrawImage;
    const otherPlugin = function(args) { return ours.call(this, args); };
    b.customDrawImage = otherPlugin;
    restore();
    assert.strictEqual(b.customDrawImage, otherPlugin);
    assert.equal(b.customDrawImage(f.args), "original");
    assert.equal(c.patchReaderComparisonBlender(f.win, b, () => true), null);
    const broken = new f.Blender();
    let calls = 0;
    const proto = Object.getPrototypeOf(broken);
    proto.customDrawImage = () => { calls++; throw new Error("original draw error"); };
    c.patchReaderComparisonBlender(f.win, broken, () => true);
    assert.throws(() => broken.customDrawImage([f.image, 12, 12, 468, 976]), /original draw error/);
    assert.equal(calls, 1);
  }

  function figuresBlendOnlyInsideConfirmedTranslationBackground() {
    for (const theme of [
      { background: "#2E3440", foreground: "#D8DEE9", paper: [46, 52, 64], ink: [216, 222, 233] },
      { background: "#F4ECD8", foreground: "#5B4636", paper: [244, 236, 216], ink: [91, 70, 54] }
    ]) {
      const f = fixture(), c = controller(), b = new f.Blender();
      f.win.theme = theme;
      b.dark = theme.background === "#2E3440";
      const photo = { width: 2, height: 2, pixels: new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 230, 230, 230, 255]) };
      const local = [photo, 600, 300, 200, 180];
      const original = Array.from(photo.pixels);
      const restore = c.patchReaderComparisonBlender(f.win, b, () => true);
      assert.equal(b.customDrawImage(local), "original", "right-side position alone must never authorize image conversion");
      b.customDrawImage(f.args);
      assert.equal(b.customDrawImage(local), "drawn");
      const output = b.draws.at(-1)[0].pixels;
      assert.deepEqual(Array.from(output.slice(0, 3)), theme.paper);
      assert.deepEqual(Array.from(output.slice(4, 7)), theme.ink);
      assert.deepEqual(Array.from(output.slice(8, 11)), [255, 0, 0]);
      assert.deepEqual(Array.from(photo.pixels), original);
      assert.equal(b.customDrawImage([photo, 20, 300, 200, 180]), "original");
      assert.equal(b.customDrawImage([photo, 900, 300, 200, 180]), "original", "images crossing the confirmed region must retain native behavior");
      const count = b.draws.length;
      f.win.theme = { background: "#FFFFFF", foreground: "#000000" };
      assert.equal(b.customDrawImage(local), "original");
      assert.equal(b.draws.length, count);
      restore();
    }
  }

  function legacyVectorAttachmentsUseOnlyTopLevelTranslationForm() {
    const f = fixture(), c = controller(), b = new f.Blender(), graphics = new f.Graphics(b);
    const restore = c.patchReaderComparisonBlender(f.win, b, () => true, graphics);
    const local = [f.image, 600, 300, 200, 180];
    assert.equal(b.customDrawImage(local), "original");
    graphics[74](0, null, [12, 12, 480, 988]);
    graphics[74](0, null, [520, 12, 988, 988]);
    assert.equal(b.customDrawImage(local), "original", "a nested source figure cannot authorize translation-side image handling");
    graphics[75]();
    graphics[75]();
    graphics[74](0, null, [520, 12, 988, 988]);
    assert.equal(b.customDrawImage(local), "drawn", "a registered vector translation page requires no full-page bitmap");
    graphics[75]();
    assert.equal(b.customDrawImage(local), "original", "end of the translated form must restore normal image handling");
    restore();
    assert.equal(Object.hasOwn(graphics, 74), false);
    assert.equal(Object.hasOwn(graphics, 75), false);
    graphics.paintFormXObjectBegin = () => {};
    assert.equal(c.patchReaderComparisonBlender(f.win, b, () => true, graphics), null, "retain an existing plugin's form hooks");
  }

  function textContrastChangesOnlyOverConfirmedDarkBackground() {
    const f = fixture(), c = controller(), b = new f.Blender();
    let x = 600;
    b.ctx.getTransform = () => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: 100 });
    const color = { lightness: 10 };
    const restore = c.patchReaderComparisonBlender(f.win, b, () => true);
    assert.strictEqual(b.getTextStyle(color, b.background), color, "no confirmed background, no text adjustment");
    b.ctx.getTransform = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    b.customDrawImage(f.args);
    b.ctx.getTransform = () => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: 100 });
    assert.strictEqual(b.getTextStyle(color, b.background), b.foreground);
    const whiteFigure = { lightness: 100 };
    assert.strictEqual(b.getTextStyle(color, whiteFigure), color, "preserve text on a light figure");
    x = 20;
    assert.strictEqual(b.getTextStyle(color, b.background), color, "preserve source-side text");
    x = 600;
    assert.strictEqual(b.getTextStyle(b.foreground, b.background), b.foreground);
    b.dark = false;
    assert.strictEqual(b.getTextStyle(color, b.background), color);
    b.dark = true;
    const ours = b.getTextStyle;
    const otherPlugin = function(...args) { return ours.call(this, ...args); };
    b.getTextStyle = otherPlugin;
    restore();
    assert.strictEqual(b.getTextStyle, otherPlugin);
    assert.strictEqual(b.getTextStyle(color, b.background), color);
  }

  function onlyOpaqueFullTranslationPaperFillsAreThemed() {
    const f = fixture(), c = controller(), b = new f.Blender(), g = new f.Graphics(b);
    const restore = c.patchReaderComparisonBlender(f.win, b, () => true, g);
    const bounds = [520, 12, 988, 988], path = ["native path"];
    g[91](0, 22, path, bounds);
    assert.equal(g.fills.at(-1).style, "#ffffff", "a matching rectangle without a confirmed translated form must be untouched");
    g[74](0, null, bounds);
    assert.equal(g[91](0, 22, path, bounds), "filled");
    assert.equal(g.fills.at(-1).style, "#2E3440");
    assert.strictEqual(g.fills.at(-1).data, path);
    assert.strictEqual(g.fills.at(-1).bounds, bounds);
    assert.equal(b.ctx.fillStyle, "#ffffff", "restore the caller's style after the background fill");
    assert.equal(g.current.fillColor, "#ffffff");
    f.win.theme = { background: "#F4ECD8", foreground: "#5B4636" };
    g[91](0, 22, path, bounds);
    assert.equal(g.fills.at(-1).style, "#F4ECD8");
    g.failFill = true;
    assert.throws(() => g[91](0, 22, path, bounds), /native fill failed/);
    assert.equal(b.ctx.fillStyle, "#ffffff");
    g.failFill = false;
    const ourHook = g[91];
    const pluginHook = function(...args) { return ourHook.call(this, ...args); };
    g[91] = pluginHook;
    restore();
    assert.strictEqual(g[91], pluginHook);
    g[91](0, 22, path, bounds);
    assert.equal(g.fills.at(-1).style, "#ffffff", "a later plugin hook must keep working after disposal");
  }

  function graphPathsTransparencyAndOriginalSideKeepNativeFills() {
    for (const change of [
      (f, b, g, call) => { call[3] = [600, 200, 800, 500]; },
      (f, b, g, call) => { call[1] = 20; },
      (f, b) => { b.ctx.globalAlpha = .5; },
      (f, b) => { b.ctx.globalCompositeOperation = "multiply"; },
      (f, b, g) => { g.current.fillAlpha = .5; },
      (f, b, g) => { g.current.patternFill = true; },
      (f, b, g) => { g.current.fillColor = "#000000"; },
      (f, b, g) => { g.pendingClip = 1; },
      (f, b) => { b.ctx.fillStyle = "#eeeeee"; },
      f => { f.win.theme.background = "#ffffff"; }
    ]) {
      const f = fixture(), c = controller(), b = new f.Blender(), g = new f.Graphics(b);
      const restore = c.patchReaderComparisonBlender(f.win, b, () => true, g);
      g[74](0, null, [520, 12, 988, 988]);
      const call = [0, 22, [], [520, 12, 988, 988]];
      change(f, b, g, call);
      const previous = b.ctx.fillStyle;
      g[91](...call);
      assert.equal(g.fills.at(-1).style, previous);
      assert.equal(b.ctx.fillStyle, previous);
      restore();
    }
    const f = fixture(), c = controller(), b = new f.Blender(), g = new f.Graphics(b);
    const restore = c.patchReaderComparisonBlender(f.win, b, () => true, g);
    g[74](0, null, [12, 12, 480, 988]);
    g[91](0, 22, [], [12, 12, 480, 988]);
    assert.equal(g.fills.at(-1).style, "#ffffff");
    restore();
    assert.equal(Object.hasOwn(g, 91), false);
    const pluginHook = () => "other plugin";
    g[91] = pluginHook;
    const cleanup = c.patchReaderComparisonBlender(f.win, b, () => true, g);
    assert.strictEqual(g[91], pluginHook, "an existing path hook must not be replaced");
    cleanup();
  }

  async function renderLifecyclePreservesCallbacksAndReleasesHooks() {
    const f = fixture(), c = controller(), b = new f.Blender();
    let finish, continued = 0, originalCalls = 0;
    const original = callback => { originalCalls++; callback(); };
    const graphics = new f.Graphics(b);
    const task = { onContinue: original, promise: new Promise(resolve => { finish = resolve; }), _internalRenderTask: { gfx: graphics } };
    const dispose = c.patchReaderViewerWindow(f.win, () => true);
    const event = { source: { renderTask: task } };
    f.handlers.get("pagerender")(event);
    task.onContinue(() => continued++);
    assert.equal(continued, 1);
    assert.equal(originalCalls, 1);
    graphics[74](0, null, [520, 12, 988, 988]);
    assert.equal(b.customDrawImage(f.args), "drawn");
    finish();
    await task.promise;
    assert.strictEqual(task.onContinue, original);
    assert.equal(b.customDrawImage(f.args), "original");
    const unsupported = { onContinue: original };
    f.handlers.get("pagerender")({ source: { renderTask: unsupported } });
    assert.strictEqual(unsupported.onContinue, original);
    const detail = { ...task, onContinue: original };
    f.handlers.get("pagerender")({ source: { pageView: {}, renderTask: detail } });
    assert.strictEqual(detail.onContinue, original);
    dispose();
    assert.equal(f.handlers.size, 0);
  }

  async function pendingReaderCannotAttachAfterDisposal() {
    const c = controller();
    let resolve;
    c.isRegisteredComparisonAttachment = () => new Promise(done => { resolve = done; });
    c.patchReaderViewerWindow = () => { throw new Error("disposed reader attached"); };
    const reader = { itemID: 2, _internalReader: { _primaryView: { _iframeWindow: {} } } };
    const pending = c.ensureReaderComparisonDarkSupport(reader);
    for (const dispose of c.readerComparisonBindings.values()) dispose();
    resolve(true);
    await pending;
    assert.equal(c.readerComparisonBindings.size, 0);
  }

  return { onlyRegisteredComparisonReadersAreAttached, backgroundDrawPreservesBookkeepingAndDrawingChain,
    uncertainImagesAndHostModesKeepOriginalBehavior, grayscaleFastPathPreservesEveryShadeAndAlpha,
    protectedPixelBufferDoesNotDisableThemeConversion, pixelLoopUsesTheReaderWindowTransformer,
    otherPluginHooksSurviveCleanupAndErrors,
    figuresBlendOnlyInsideConfirmedTranslationBackground,
    legacyVectorAttachmentsUseOnlyTopLevelTranslationForm,
    textContrastChangesOnlyOverConfirmedDarkBackground,
    onlyOpaqueFullTranslationPaperFillsAreThemed, graphPathsTransparencyAndOriginalSideKeepNativeFills,
    renderLifecyclePreservesCallbacksAndReleasesHooks, pendingReaderCannotAttachAfterDisposal };
};
