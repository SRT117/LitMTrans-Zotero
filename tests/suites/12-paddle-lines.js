"use strict";

module.exports = function (env) {
  const { assert, context, prefValues, MemoryStorage, LayoutTranslationService, U } = env;
  const L = context.LitMTrans;
  const H = L.PaddleLineHelpers;
  const item = (text, x, baseline, size = 10, width = 180) => ({ text, baseline, size, bbox: [x, baseline - size * .8, x + width, baseline + size * .2] });
  const block = (id, bbox, text) => ({ type: "text", bbox,
    parser: { schema: "litmtrans-document-v1", id, semanticRole: "body", translatable: true, estimatedLineCount: 9 },
    lines: [{ bbox, spans: [{ type: "text", content: text }] }] });
  const page = blocks => ({ page_idx: 0, page_size: [600, 800], preproc_blocks: blocks });

  async function testFormulaFragmentsAndColumnOwnership() {
    const lines = H.groupLines([
      item("A normal body line", 50, 100), item("Another line with integral", 50, 120),
      item("Text after the formula", 50, 140), item("∫", 100, 112, 16, 6),
      item("∞", 103, 111, 5, 4), item("0", 103, 129, 5, 4)
    ]);
    assert.equal(lines.length, 3, "integral limits must not become new text lines");
    const continuation = H.groupLines([item("Scientific body paragraph", 50, 100),
      item("V α (r + r₀) V β (r₀) = E", 50, 120, 10, 210), item("2013).", 50, 140, 10, 26)]);
    assert.equal(continuation.length, 3, "a formula occupying a whole row and a final citation year must retain their own rows");
    const blocks = [block("left", [40, 85, 290, 145], "A normal body line Another line with integral Text after the formula"),
      block("right", [310, 85, 560, 145], "Right column body text")];
    const result = H.pageGeometry(page(blocks), [item("A normal body line", 50, 100),
      item("Another line with integral", 50, 120), item("Text after the formula", 50, 140),
      item("Right column body text", 320, 100), item("Adjacent earlier paragraph", 50, 72)], "pdf-text");
    assert.equal(result.left.lines.length, 3);
    assert.equal(result.right.lines.length, 1);
    assert(result.left.lines.every(b => b[2] < 310), "left and right columns must remain separate");
  }

  async function testGeometryPreservesSemanticLines() {
    const original = block("body", [40, 90, 290, 145], "A body paragraph with $x^2$ and text");
    const before = JSON.stringify(original.lines);
    const p = page([original]);
    H.applyGeometry([p], { pages: [{ blocks: { body: { source: "pdf-text", lines: [[60, 92, 280, 102], [40, 105, 280, 115], [40, 118, 270, 128]] } } }] });
    assert.equal(original._layout_original_line_count, 3);
    assert.equal(original.parser.id, "body");
    assert.equal(JSON.stringify(original.lines), before, "translation content and formula tokens must not be split or rewritten");
    assert.equal(p._layoutLineBoxes.length, 3);
  }

  async function testOCRSchemaAndCoordinates() {
    const raw = { prunedResult: { dt_polys: [], rec_texts: ["A scanned body line"], rec_polys: [[[100, 200], [500, 200], [500, 220], [100, 220]]] } };
    const items = H.ocrItems(raw, { width: 1200, height: 1600 }, page([]));
    assert.deepEqual(Array.from(items[0].bbox), [50, 100, 250, 110]);
    assert.throws(() => H.ocrItems(raw, { width: 1600, height: 1200 }, page([])), /尺寸不匹配/);
    assert.throws(() => H.ocrItems({ prunedResult: {} }, { width: 1200, height: 1600 }, page([])), /行坐标/);
    assert(H.textCoverage("A sufficiently long scientific paragraph", "7") < .1, "one page number cannot qualify as a usable text layer");
  }

  function setup(textItems = [], pageItems = null) {
    const storage = new MemoryStorage();
    const b = block("body", [40, 90, 290, 145], "First sentence of body text. Second sentence of body text. Third sentence of body text.");
    const texts = pageItems || [textItems];
    const payload = { parser_schema: "litmtrans-document-v1", pdf_info: texts.map((_items, i) => ({
      ...page([{ ...b, parser: { ...b.parser, id: i ? `body-${i + 1}` : "body" } }]), page_idx: i
    })) };
    const rawText = JSON.stringify(payload), id = "1-LINES";
    const meta = { parseProvider: "paddle", sourcePath: "/source.pdf", sourceIdentity: "source", parseRevisionID: "parse-1" };
    storage.getDocumentMeta = async () => ({ ...meta });
    storage.bytes.set(meta.sourcePath, new Uint8Array([1, 2, 3]));
    storage.text.set(storage.path(id, "layout.json"), rawText);
    storage.json.set(storage.path(id, "layout.json"), payload);
    let loads = 0, destroyed = 0;
    const lib = { Util: { transform: (_a, b) => b }, getDocument: () => {
      loads++;
      return { promise: Promise.resolve({ numPages: texts.length, getPage: async number => ({
        getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, 1, 0, 0] }),
        getTextContent: async () => ({ items: texts[number - 1], styles: {} }), cleanup() {}
      }) }), destroy: async () => { destroyed++; } };
    } };
    const service = new L.PaddleLineService(storage, {}, { loadOwnPDFJS: () => lib });
    const layout = { payload, pages: payload.pdf_info, rawText };
    return { storage, service, layout, meta, id, counts: () => ({ loads, destroyed }) };
  }

  async function testScanFallbackCacheAndModelUpgrade() {
    const s = setup([{ str: "1", transform: [10, 0, 0, 10, 100, 103], width: 5 }]);
    let cloudCalls = 0, selectedModel;
    s.service.collectOCR = async (_id, _bytes, _pages, geometry, missing, model) => {
      cloudCalls++; selectedModel = model;
      assert.equal(missing.length, 1);
      geometry.pages[0].blocks.body = { source: "paddle-ocr", coverage: 1, lines: [[60, 92, 280, 102], [40, 106, 280, 116]] };
    };
    U.setPref("paddleOCRModel", "PP-OCRv6");
    const first = await s.service.ensure(s.id, s.layout);
    assert.equal(first.complete, true);
    assert.equal(cloudCalls, 1);
    assert.equal(selectedModel, "PP-OCRv6");
    U.setPref("paddleOCRModel", "PP-OCRv7");
    const next = await s.service.ensure(s.id, s.layout);
    assert.equal(next.ocrModel, "PP-OCRv6", "catalog updates must not invalidate existing line geometry");
    assert.equal(cloudCalls, 1);
    assert.equal(s.counts().loads, 1);
    assert.equal(s.counts().destroyed, 1);
    assert.equal(s.storage.text.get(s.storage.path(s.id, "layout.json")), s.layout.rawText);
    U.clearPref("paddleOCRModel");
  }

  async function testLocalTextAndParseRevisionProtection() {
    const strings = ["First sentence of body text.", "Second sentence of body text.", "Third sentence of body text."];
    const s = setup(strings.map((str, i) => ({ str, transform: [10, 0, 0, 10, i ? 40 : 60, 100 + i * 13], width: 180 })));
    s.service.collectOCR = async () => assert.fail("usable text layer must not trigger cloud OCR");
    const geometry = await s.service.ensure(s.id, s.layout);
    assert.equal(geometry.pages[0].blocks.body.lines.length, 3);
    assert.equal(geometry.pages[0].blocks.body.source, "pdf-text");
    const scanned = setup();
    scanned.service.collectOCR = async () => { scanned.meta.parseRevisionID = "parse-2"; };
    await assert.rejects(() => scanned.service.ensure(scanned.id, scanned.layout), /解析结果已变化/);
    assert(!scanned.storage.json.has(scanned.storage.path(scanned.id, "line-geometry.v1.json")), "stale results must never be published");
  }

  async function testFailedAndCancelledOCRPreservesSource() {
    const s = setup();
    s.service.collectOCR = async () => { throw new Error("offline"); };
    const result = await s.service.ensure(s.id, s.layout);
    assert.equal(result.complete, false);
    assert.equal(s.storage.text.get(s.storage.path(s.id, "layout.json")), s.layout.rawText);
    const cancelled = setup();
    cancelled.service.collectOCR = async () => { const error = new Error("cancelled"); error.cancelled = true; throw error; };
    await assert.rejects(() => cancelled.service.ensure(cancelled.id, cancelled.layout), /cancelled/);
    assert(!cancelled.storage.json.has(cancelled.storage.path(cancelled.id, "line-geometry.v1.json")));
    assert.equal(cancelled.counts().destroyed, 1);
  }

  async function testCompiledGeometryCacheAndLegacyData() {
    const s = setup();
    const aside = block("aside", [590, 200, 598, 290], "Unrelated margin notice");
    aside.type = "unknown";
    aside.parser.source = { provider: "paddle", label: "aside_text" };
    s.layout.pages[0].preproc_blocks.push(aside);
    s.layout.rawText = JSON.stringify(s.layout.payload);
    await s.storage.writeText(s.storage.path(s.id, "layout.json"), s.layout.rawText);
    const oldCompiled = { version: 12, model: { preserved: true } };
    await s.storage.writeJSON(s.storage.path(s.id, "compiled-model.json"), oldCompiled);
    const service = new LayoutTranslationService(s.storage, { getSettings: () => ({}) });
    service.lineService = { ensure: async () => ({ key: "geometry-v1", pages: [{ blocks: { body: {
      source: "pdf-text", lines: [[60, 92, 280, 102], [40, 106, 280, 116], [40, 120, 280, 130]]
    } } }] }) };
    const model = await service.buildModel(s.id, { body: "已有译文" }, {});
    assert.equal(model.pages[0].blocks[0].lineCount, 3);
    const cached = s.storage.json.get(s.storage.path(s.id, "compiled-model.paddle-lines.v1.json"));
    assert(cached.geometryHash);
    assert.deepEqual(s.storage.json.get(s.storage.path(s.id, "compiled-model.json")), oldCompiled);
    assert.equal(s.storage.text.get(s.storage.path(s.id, "layout.json")), s.layout.rawText);
    const paragraph = model.pages[0].restoration.streams[0].items[0];
    assert(paragraph.indent > 0, "real line positions must restore the first-line indent");
    assert.equal(model.geometryHash, cached.geometryHash, "browser fitting caches must be tied to the geometry revision");
    assert(!model.pages[0].blocks.some(block => block.id === "aside"), "Paddle aside_text must not enter the layout");
    cached.model.pages[0].blocks.push({ id: "aside", type: "unknown", text: "Unrelated margin notice" });
    delete cached.asidePolicyVersion;
    await s.storage.writeJSON(s.storage.path(s.id, "compiled-model.paddle-lines.v1.json"), cached);
    const reopened = await service.buildModel(s.id, { body: "已有译文" }, {}, {
      sourceFingerprint: cached.sourceFingerprint, assetMapHash: cached.assetMapHash
    });
    assert(!reopened.pages[0].blocks.some(block => block.id === "aside"), "older compiled caches must also omit margin notices");
    assert(!reopened.pages[0].restoration.absoluteBlocks.some(block => block.text === "Unrelated margin notice"));
    assert.equal(s.storage.text.get(s.storage.path(s.id, "layout.json")), s.layout.rawText);
  }

  async function testOCRTaskProtocolAndPinnedModel() {
    const s = setup(), oldPDF = context.PDFLib, oldRequest = L.HTTP.requestBytes;
    let submissions = 0;
    const requestedPages = [];
    context.PDFLib = { PDFDocument: { load: async () => ({}), create: async () => ({
      copyPages: async (_source, indexes) => { requestedPages.push(...indexes); return indexes.map(index => ({ index })); },
      addPage() {}, save: async () => new Uint8Array([1, 2, 3])
    }) } };
    const sourceTexts = ["First sentence of body text.", "Second sentence of body text.", "Third sentence of body text."];
    const record = { errorCode: 0, result: { dataInfo: { pages: [{ width: 1200, height: 1600 }] },
      ocrResults: [{ prunedResult: { dt_polys: [], rec_texts: sourceTexts,
        rec_polys: sourceTexts.map((_text, i) => [[100, 184 + i * 26], [560, 184 + i * 26], [560, 204 + i * 26], [100, 204 + i * 26]]) } }] } };
    L.HTTP.requestBytes = async url => { assert.equal(url, "https://ocr.test/result"); return new TextEncoder().encode(JSON.stringify(record)); };
    s.service.paddle = { secrets: { getPaddleToken: () => "fixture-token" },
      submit: async (_bytes, model, _token, _signal, options) => {
        submissions++;
        assert.equal(model, "PP-OCRv6");
        assert.equal(options.useDocUnwarping, false);
        U.setPref("paddleOCRModel", "PP-OCRv7");
        return { jobID: "fixture-job", state: "pending" };
      },
      poll: async (task, _token, persist) => { task.state = "done"; await persist(task); return "https://ocr.test/result"; }
    };
    try {
      const geometry = { key: "source-1", pages: [{ blocks: {} }] };
      const missing = [{ index: 0, ids: ["body"] }];
      await s.service.collectOCR(s.id, new Uint8Array([1, 2, 3]), s.layout.pages, geometry, missing, "PP-OCRv6");
      assert.deepEqual(requestedPages, [0]);
      assert.equal(geometry.pages[0].blocks.body.lines.length, 3);
      assert.equal(s.storage.json.get(s.storage.path(s.id, "paddle-line-task.json")).model, "PP-OCRv6");
      await s.service.collectOCR(s.id, new Uint8Array([1, 2, 3]), s.layout.pages, geometry, missing, "PP-OCRv6");
      assert.equal(submissions, 1, "a completed or interrupted cloud job must be resumed instead of resubmitted");
    } finally {
      context.PDFLib = oldPDF; L.HTTP.requestBytes = oldRequest; U.clearPref("paddleOCRModel");
    }
  }

  async function testIndependentOCRCatalogUpdates() {
    const controller = Object.create(L.Controller.prototype);
    controller.version = "2.1.3";
    const entry = (model, extra = {}) => ({ model, minPluginVersion: "2.1.3", apiProtocol: "aistudio-jobs-v2", resultSchema: "paddle-text-lines-v1", ...extra });
    try {
      controller.syncPaddleModel({ revision: 7, paddleOCR: entry("PP-OCRv7") });
      assert.equal(U.getPref("paddleOCRModel", ""), "PP-OCRv7");
      assert.equal(U.getPref("paddleOCRModelCatalogRevision", 0), 7);
      controller.syncPaddleModel({ revision: 8, paddleOCR: entry("PP-OCRv8", { minPluginVersion: "99.0" }) });
      assert.equal(U.getPref("paddleOCRModelCatalogRevision", 0), 7);
      controller.syncPaddleModel({ revision: 6, paddleOCR: entry("PP-OCRv6") });
      assert.equal(U.getPref("paddleOCRModel", ""), "PP-OCRv7");
      controller.syncPaddleModel({ revision: 9, paddleOCR: entry("PP-StructureV3") });
      assert.equal(U.getPref("paddleOCRModel", ""), "PP-OCRv7", "OCR catalog must not switch to a document parsing model");
      const normalized = L.Updater.normalizeParserModels({ revision: 10, paddle: { model: "bad" }, paddleOCR: entry("PP-OCRv8") });
      assert.equal(normalized.paddleOCR.model, "PP-OCRv8", "an incompatible VL entry must not block an independent OCR update");
      assert.equal(L.Updater.normalizeParserModels({ revision: 11, paddleOCR: entry("PP-OCRv8.1") }).paddleOCR.model,
        "PP-OCRv8.1", "a compatible minor model upgrade must not require a hardcoded name change");
    } finally {
      U.clearPref("paddleOCRModel"); U.clearPref("paddleOCRModelCatalogRevision");
    }
  }

  async function testReaderStateForwardsLineProgress() {
    const controller = Object.create(L.Controller.prototype);
    const runtime = { attachmentID: 240 }, other = { attachmentID: 241 }, events = [];
    controller.tabs = new Map([["reader", runtime], ["other", other]]);
    controller.attachmentContext = async () => ({ documentID: "1-LINES", filePath: "/source.pdf",
      attachment: { id: 240, attachmentFilename: "source.pdf" } });
    const model = { pages: [{ blocks: [{ translatedText: "已保存的译文" }] }] };
    controller.pipeline = { snapshot: async (_context, emit) => {
      emit({ type: "log", message: "已复用行信息缓存" });
      return { parsed: { meta: {} }, layout: { model } };
    } };
    controller.emit = (target, event) => events.push({ target, event });
    controller.hasCAJAttachment = () => false;
    controller.getSettings = () => ({});
    const result = await controller.stateForAttachment(240);
    assert.equal(result.layout.model, model, "line progress must not interrupt loading a saved translation");
    assert.equal(events.length, 1);
    assert.equal(events[0].target, runtime, "progress must only reach the matching attachment");
  }

  async function testReferenceNumbersUseExplicitPDFMarkers() {
    const ref = block("ref", [40, 90, 290, 145], "R H Cole Underwater Explosions Princeton University Press");
    ref.type = "ref_text";
    const items = [item("3", 42, 96, 6, 4), item("R H Cole Underwater Explosions Princeton University Press", 52, 101)];
    const result = H.pageGeometry(page([ref]), items, "pdf-text");
    assert.equal(result.ref.referenceNumber, 3);
    assert.equal(H.pageGeometry(page([ref]), items, "paddle-ocr").ref.referenceNumber, undefined, "OCR must not override the original reference number");
    const noMarker = H.pageGeometry(page([ref]), items.slice(1), "pdf-text");
    assert.equal(noMarker.ref.referenceNumber, undefined, "missing numbers must not be inferred from entry order");
    const ambiguous = H.pageGeometry(page([ref]), [...items, item("4", 47, 96, 6, 4)], "pdf-text");
    assert.equal(ambiguous.ref.referenceNumber, undefined);
    ref.type = "text";
    assert.equal(H.pageGeometry(page([ref]), items, "pdf-text").ref.referenceNumber, undefined, "body exponents must not become reference labels");
    const strings = ["First sentence of body text.", "Second sentence of body text.", "Third sentence of body text."];
    const s = setup([{ str: "11", transform: [6, 0, 0, 6, 42, 96], width: 7 },
      ...strings.map((str, i) => ({ str, transform: [10, 0, 0, 10, 60, 101 + i * 13], width: 180 }))]);
    s.layout.pages[0].preproc_blocks[0].type = "ref_text";
    s.layout.rawText = JSON.stringify(s.layout.payload);
    await s.storage.writeText(s.storage.path(s.id, "layout.json"), s.layout.rawText);
    s.service.collectOCR = async () => assert.fail("reference label upgrades must use the text layer");
    const initial = await s.service.ensure(s.id, s.layout);
    assert.equal(initial.pages[0].blocks.body.referenceNumber, 11);
    delete initial.referenceNumbersVersion;
    delete initial.pages[0].blocks.body.referenceNumber;
    await s.storage.writeJSON(s.storage.path(s.id, "line-geometry.v1.json"), initial);
    const upgraded = await s.service.ensure(s.id, s.layout);
    assert.equal(upgraded.pages[0].blocks.body.referenceNumber, 11);
    assert.equal(s.counts().loads, 2, "existing geometry must gain reference labels without re-parsing");
  }

  async function testFormulaCommandsDoNotTriggerOCR() {
    const cases = JSON.parse(env.fs.readFileSync(env.path.join(env.root, "tests/fixtures/paddle/formula-text-coverage.json"), "utf8"));
    for (const sample of cases) {
      assert(H.textCoverage(sample.source, sample.pdfText) >= .9, `page ${sample.page}: LaTeX command names must not count as missing PDF text`);
      assert(H.textCoverage(sample.source, "An unrelated paragraph with different words") < .6);
      assert.equal(H.textCoverage(sample.source, ""), 0, "scanned regions must still require OCR");
    }
  }

  async function testDocumentTextLayerControlsAutomaticOCR() {
    const native = ["First sentence of body text.", "Second sentence of body text.", "Third sentence of body text."]
      .map((str, i) => ({ str, transform: [10, 0, 0, 10, 60, 100 + i * 13], width: 180 }));
    const unmatched = setup(native.map(item => ({ ...item, str: "Different native text deliberately fails the paragraph matching check." })));
    unmatched.service.collectOCR = async () => assert.fail("a digital PDF must not call OCR for unmatched blocks");
    const digital = await unmatched.service.ensure(unmatched.id, unmatched.layout);
    assert.equal(digital.documentText.kind, "digital");
    assert.equal(digital.complete, true);
    assert.deepEqual(Array.from(digital.missingPages), [1]);
    assert.equal(digital.timings.ocrMs, 0);

    const headers = setup([20, 32, 770, 782].map((baseline) => ({ str: "A repeated journal header copyright and publication notice containing many letters.",
      transform: [10, 0, 0, 10, 60, baseline], width: 400 })));
    let scannedCalls = 0;
    headers.service.collectOCR = async () => { scannedCalls++; };
    const scanned = await headers.service.ensure(headers.id, headers.layout);
    assert.equal(scanned.documentText.kind, "scanned", "native headers alone must not classify a scanned document as digital");
    assert.equal(scannedCalls, 1);

    const mixed = setup([], [native, []]);
    let mixedCalls = 0;
    mixed.service.collectOCR = async (_id, _bytes, _pages, geometry, missing) => {
      mixedCalls++;
      assert.deepEqual(Array.from(missing, page => page.index), [1]);
      geometry.pages[1].blocks["body-2"] = { source: "paddle-ocr", lines: [[60, 92, 280, 102]], coverage: 1 };
    };
    const automatic = await mixed.service.ensure(mixed.id, mixed.layout);
    assert.equal(automatic.documentText.kind, "mixed");
    assert.equal(mixedCalls, 0, "mixed documents require explicit OCR supplementation");
    assert.deepEqual(Array.from(automatic.missingPages), [2]);
    const manual = await mixed.service.ensure(mixed.id, mixed.layout, null, null, { forceOCR: true });
    assert.equal(mixedCalls, 1);
    assert.equal(manual.missingPages.length, 0);
    await mixed.service.ensure(mixed.id, mixed.layout);
    assert.equal(mixedCalls, 1, "reopening must reuse manually supplemented lines");
  }

  async function testManualOCRActionKeepsTranslations() {
    const controller = Object.create(L.Controller.prototype), events = [];
    const state = { layout: { translations: { body: "已有译文" } } };
    controller.withOperation = (_runtime, key, work) => { assert.equal(key, "layout-lines"); return work(null, event => events.push(event)); };
    controller.attachmentContext = async () => ({ documentID: "1-LINES" });
    controller.storage = { getDocumentMeta: async () => ({ parseProvider: "paddle" }) };
    controller.layout = { loadLayout: async () => ({}), lineService: {
      ensure: async (id, _layout, _signal, _emit, options) => { assert.equal(id, "1-LINES"); assert.equal(options.forceOCR, true); return { complete: true }; }
    } };
    controller.stateForAttachment = async () => state;
    const result = await controller.dispatch({ attachmentID: 240 }, "supplement-paddle-lines", {});
    assert.equal(result.state, state);
    assert.equal(result.state.layout.translations.body, "已有译文");
    controller.storage.getDocumentMeta = async () => ({ parseProvider: "mineru" });
    await assert.rejects(controller.dispatch({ attachmentID: 240 }, "supplement-paddle-lines", {}), /Paddle/);
  }

  return { testFormulaFragmentsAndColumnOwnership, testGeometryPreservesSemanticLines, testOCRSchemaAndCoordinates,
    testScanFallbackCacheAndModelUpgrade, testLocalTextAndParseRevisionProtection, testFailedAndCancelledOCRPreservesSource,
    testCompiledGeometryCacheAndLegacyData, testOCRTaskProtocolAndPinnedModel, testIndependentOCRCatalogUpdates,
    testReaderStateForwardsLineProgress, testReferenceNumbersUseExplicitPDFMarkers, testFormulaCommandsDoNotTriggerOCR,
    testDocumentTextLayerControlsAutomaticOCR, testManualOCRActionKeepsTranslations };
};
