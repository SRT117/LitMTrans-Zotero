"use strict";

module.exports = function (env) {
  const { assert, context, MemoryStorage, LayoutTranslationService, U, fs, path, root, vm } = env;
  const { DOMParser } = require("linkedom");
  const I = context.LitMTrans.LayoutImages;
  const lines = [
    { text: "RAW INPUT", bbox: [.08, .2, .3, .3], score: .99 },
    { text: "IMAGE TEXT 7319", bbox: [.05, .5, .4, .6], score: .99 },
    { text: "61%", bbox: [.6, .2, .7, .3], score: .99 },
    { text: "Rate $x$", bbox: [.6, .5, .8, .6], score: .99 }
  ];
  const fixture = () => {
    const storage = new MemoryStorage(), documentID = "image-case", calls = [];
    storage.writeTextAtomically = async (path, text) => storage.writeJSON(path, JSON.parse(text));
    storage.getDocumentMeta = async () => ({});
    const raw = JSON.stringify({ pdf_info: [{ page_size: [600, 800], preproc_blocks: [
      { type: "text", bbox: [20, 20, 580, 60], lines: [{ spans: [{ content: "Source body" }] }] },
      { type: "table", bbox: [20, 80, 580, 150], blocks: [{ type: "table_body", bbox: [20, 80, 580, 150], lines: [{ spans: [{ html: "<table><tr><td>Method</td><td>12.5</td></tr></table>" }] }] }] },
      { type: "image", bbox: [20, 200, 580, 400], blocks: [{ type: "image_body", bbox: [20, 200, 580, 400], image_path: "images/figure.png", lines: [] }] }
    ] }] });
    storage.text.set(storage.path(documentID, "layout.json"), raw);
    const sourceFingerprint = U.hashString(raw);
    const settings = { provider: "gemini", baseURL: "https://example.test", model: "fixture", targetLanguage: "简体中文", translateImages: true, deepseekFastLayoutTranslation: false, enableUntranslatedCheck: false };
    const llm = { getSettings: () => settings, resolveConfig: values => values, ensureConfiguredModel: async values => values,
      complete: async messages => {
        const blocks = JSON.parse(messages[1].content.split("Input blocks JSON:\n").at(-1)).blocks;calls.push(blocks);
        return { text: JSON.stringify({ translations: blocks.map(block => block.cells ? { id: block.id, cells: block.cells.map(([index, text]) => [index, text.replace("RAW INPUT", "原始输入").replace("IMAGE TEXT", "图片文字").replace("Method", "方法")]) } : { id: block.id, text: "正文译文。" }) }) };
      } };
    const service = new LayoutTranslationService(storage, llm);
    service.extractRecords = async () => [{ id: "body", page: 1, type: "text", text: "Source body" }];
    service.buildBaseModel = async () => ({ sourceFingerprint, pages: [{ blocks: [{ id: "figure", type: "image_body", kind: "image", bbox: [20, 200, 580, 400], imagePath: "images/figure.png", imageURL: "fixture.png" }] }] });
    service.imageService = { ensure: async () => ({ version: 1, sourceFingerprint, images: [{ ...I.extract({ pages: JSON.parse(raw).pdf_info })[0], lines }] }) };
    return { storage, documentID, calls, service, sourceFingerprint, settings };
  };

  function OCRCoordinatesAndUncertainInput() {
    const record = { prunedResult: { rec_texts: ["Readable", "Low score", "Tilted", "Outside"], rec_scores: [.99, .2, .99, .99], rec_polys: [
      [[10, 10], [60, 10], [60, 25], [10, 25]], [[10, 30], [60, 30], [60, 45], [10, 45]],
      [[10, 50], [60, 65], [60, 80], [10, 65]], [[-10, 1], [10, 1], [10, 20], [-10, 20]]
    ] } };
    const before = JSON.stringify(record);
    const accepted = I.linesFromOCR(record, { width: 100, height: 100 });
    assert.equal(accepted.length, 1);assert.equal(accepted[0].text, "Readable");
    assert.equal(JSON.stringify(record), before);
    assert.equal(I.linesFromOCR({ prunedResult: { rec_texts: ["Text"] } }, { width: 100, height: 100 }).length, 0);
  }

  async function pageFurnitureSkipsOCRTranslationAndCachedOverlay() {
    const body = { type: "image_body", bbox: [100, 200, 300, 350], image_path: "images/chart.png",
      parser: { semanticRole: "image", translatable: false } };
    const header = { type: "image", bbox: [390, 35, 550, 85], parser: { semanticRole: "header_image", translatable: false },
      blocks: [{ type: "image_body", bbox: [390, 35, 550, 85], image_path: "images/logo.png", parser: { semanticRole: "header_image" } }] };
    const footer = { type: "footer", bbox: [30, 750, 120, 780], blocks: [{ type: "image_body", bbox: [30, 750, 120, 780], image_path: "images/footer.png" }] };
    const layout = { pages: [{ preproc_blocks: [header, body, footer] }] };
    layout.rawText = JSON.stringify(layout.pages);
    const sourceFingerprint = U.hashString(layout.rawText), before = JSON.stringify(layout);
    assert.deepEqual(I.extract(layout).map(figure => figure.asset), ["images/chart.png"], "遵守页眉页脚分类；普通图片的 translatable:false 不应禁用图内翻译");
    const ocr = { version: 1, sourceFingerprint, images: [
      { id: "image:0:0.0", page: 0, bbox: header.bbox, lines: [lines[0]] },
      { ...I.extract(layout)[0], lines: [lines[0]] }
    ] };
    context.DOMParser = DOMParser;
    try {
      const plan = I.requestPlan(ocr, layout);
      assert.equal(plan.images.length, 1, "旧 OCR 缓存中的页眉也不能生成翻译请求");
      const cache = I.cacheFromRecords(plan, { [plan.records[0].id]: JSON.stringify([[0, "图内文字"]]) }, sourceFingerprint, "简体中文");
      const image = cache.images[0];
      cache.images.push({ ...image, bbox: header.bbox });
      const model = { sourceFingerprint, pages: [{ blocks: [
        { type: "image", bbox: header.bbox, original: header, translatedImageLabels: [{ text: "旧标志译文" }] },
        { type: "image_body", bbox: header.bbox, original: header.blocks[0] },
        { type: "image_body", bbox: body.bbox, original: body }
      ] }] };
      const cacheBefore = JSON.stringify(cache), attached = I.attach(model, cache);
      assert.equal(attached.pages[0].blocks[0].translatedImageLabels, undefined);
      assert.equal(attached.pages[0].blocks[1].translatedImageLabels, undefined);
      assert(attached.pages[0].blocks[2].translatedImageLabels?.length, "普通图表旧译文继续显示");
      assert.equal(JSON.stringify(cache), cacheBefore, "筛选展示不能删除原缓存");
      assert.equal(JSON.stringify(layout), before);
      assert(model.pages[0].blocks[0].translatedImageLabels.length, "不能修改输入模型");
      const { service, storage, documentID } = fixture();
      const legacy = { ...model, pages: [{ blocks: model.pages[0].blocks.map(({ original, ...block }) => block),
        restoration: { streams: [], absoluteBlocks: model.pages[0].blocks.map(({ original, ...block }) => block) } }] };
      service.buildBaseModel = async () => legacy;
      storage.getDocumentMeta = async () => ({ parseRevisionID: "", parseProvider: "paddle" });
      await storage.writeText(storage.path(documentID, "layout.json"), JSON.stringify({ pdf_info: layout.pages }));
      await storage.writeJSON(service.paths(documentID, "简体中文").images, cache);
      const restored = await service.buildModel(documentID);
      for (const blocks of [restored.pages[0].blocks, restored.pages[0].restoration.absoluteBlocks]) {
        assert.equal(blocks[0].sourceOnly, true, "无原始分类的旧模型应复用原 PDF 底图");
        assert.equal(blocks[1].sourceOnly, true);
        assert.equal(blocks[0].translatedImageLabels, undefined);
        assert.equal(blocks[1].translatedImageLabels, undefined);
        assert(blocks[2].translatedImageLabels?.length);
      }
      const withoutCache = I.attach(legacy, null, "", layout);
      assert.equal(withoutCache.pages[0].blocks[0].sourceOnly, true, "尚未生成图片译文时也应沿用原 PDF 底图");
      assert.equal(legacy.pages[0].blocks[0].sourceOnly, undefined, "兼容处理不得改写旧模型");
    } finally { delete context.DOMParser; }
  }

  async function sharedBatchCacheAndImageOnlyCompletion() {
    context.DOMParser = DOMParser;
    try {
      const { service, storage, documentID, calls, settings, sourceFingerprint } = fixture();
      const original = await storage.readText(storage.path(documentID, "layout.json"));
      const result = await service.translate(documentID);
      assert.equal(calls.length, 1, "body, tables and image labels must share one small-document request");
      assert.equal(JSON.stringify(calls[0].map(record => record.type)), JSON.stringify(["text", "table_cells", "image_labels"]));
      const paths = service.paths(documentID, settings.targetLanguage);
      const body = await storage.readJSON(paths.translations);
      assert.deepEqual(Object.keys(body), ["body"], "image labels must not enter the body cache");
      const imageCache = await storage.readJSON(paths.images);
      assert.equal(imageCache.images.length, 1);
      assert.equal(result.meta.translatedImages, 1);
      assert(result.model.imageTranslationHash);
      const labels = result.model.pages[0].blocks[0].translatedImageLabels;
      assert.equal(labels.length, 2, "numeric-only and formula-containing labels must remain original");
      assert.equal(labels[1].text, "图片文字 7319", "protected numeric content must be restored locally");
      await service.translate(documentID);assert.equal(calls.length, 1, "existing image translations must be reused");
      storage.json.delete(paths.images);
      await service.translate(documentID);
      assert.equal(calls.length, 2);
      assert(calls[1].every(record => record.type === "image_labels"), "adding images to a completed old document must not retranslate the body or tables");
      assert.equal(JSON.stringify(await storage.readJSON(paths.translations)), JSON.stringify(body));
      assert.equal(await storage.readText(storage.path(documentID, "layout.json")), original);
      const stale = I.attach(result.model, { ...imageCache, sourceFingerprint: "other" });
      assert.equal(stale.imageTranslationHash, undefined);assert.equal(stale.pages[0].blocks[0].translatedImageLabels, undefined);
      assert.equal(I.attach(result.model, { ...imageCache, images: "invalid" }).imageTranslationHash, undefined);
      assert.equal(I.attach(result.model, imageCache, "new-parse").imageTranslationHash, undefined, "re-parsing the same figure bbox must not reuse old image text");
      assert.equal(I.requestPlan({ version: 1, sourceFingerprint, images: [null] }, { rawText: original }).records.length, 0);
      assert.equal(I.cachedRecords({ images: [], records: [] }, imageCache, sourceFingerprint).constructor.name, "Object");
    } finally { delete context.DOMParser; }
  }

  async function taskLanguageKeepsMediaCacheAligned() {
    context.DOMParser = DOMParser;
    try {
      for (const chain of ["api", "machine"]) {
        const { service, storage, documentID, settings, calls } = fixture();
        await service.translate(documentID);
        const originalPaths = service.paths(documentID, settings.targetLanguage);
        const originalMedia = await Promise.all([originalPaths.tables, originalPaths.images].map(file => storage.readJSON(file)));
        const complete = service.llm.complete;
        service.llm.complete = async (...args) => {
          const response = await complete(...args);
          return { ...response, text: response.text.replaceAll("正文译文", "本文の訳文").replaceAll("原始输入", "元の入力").replaceAll("图片文字", "画像の文字").replaceAll("方法", "手法") };
        };
        let machineCalls = 0;
        service.webMachine = { translateRecords: async records => {
          machineCalls++;
          return Object.fromEntries(records.map(record => [record.id, record.text.replace("Source body", "本文の訳文").replace("RAW INPUT", "元の入力").replace("IMAGE TEXT", "画像の文字").replace("Method", "手法")]));
        } };
        if (chain === "machine") settings.provider = "free_machine";
        storage.appendProcessLog = async () => {};
        const pipeline = new env.DocumentPipeline({ storage, layout: service,
          parser: { loadParsed: async () => ({ hasLayout: true }) }, getSettings: () => settings,
          translation: { buildReferenceCorpus: async () => ({ corpus: "", identity: "" }) }
        });
        const run = () => pipeline.translateLayout({ documentID }, { targetLanguage: "日语" });
        const check = result => {
          assert.equal(result.meta.targetLanguage, "日语", `${chain}: 单篇目标语言必须传入翻译服务`);
          assert(result.translations.body.includes("本文の訳文"));
          assert.equal(result.model.pages[0].blocks[0].translatedImageLabels[0].text, "元の入力", `${chain}: 图片必须读取本次任务语言的缓存`);
        };
        const result = await run();check(result);
        const translatedPaths = service.paths(documentID, "日语");
        assert.equal((await storage.readJSON(translatedPaths.images)).targetLanguage, "日语");
        assert.equal((await storage.readJSON(translatedPaths.tables)).tables[0].translations[0], "手法");
        const requests = calls.length + machineCalls;
        const cached = await run();check(cached);
        assert.equal(cached.cached, true);
        assert.equal(calls.length + machineCalls, requests, "命中目标语言缓存不能重复翻译");
        const state = await pipeline.buildLayoutState(documentID, { hasLayout: true }, result);
        assert.equal(state.model.pages[0].blocks[0].translatedImageLabels[0].text, "元の入力", "读取已加载译文时必须沿用其语言");
        assert.equal(settings.targetLanguage, "简体中文", "单篇语言不能修改全局设置");
        assert.deepEqual(await Promise.all([originalPaths.tables, originalPaths.images].map(file => storage.readJSON(file))), originalMedia, "其他语言的缓存保持原样");
      }
    } finally { delete context.DOMParser; }
  }

  async function missingImageResponseRetainsBodyAndPriorImageCache() {
    context.DOMParser = DOMParser;
    try {
      const { service, storage, documentID, settings } = fixture();
      const first = await service.translate(documentID), paths = service.paths(documentID, settings.targetLanguage);
      const before = JSON.stringify(await storage.readJSON(paths.images));
      const input = await service.manualTranslationInput(documentID);
      const bodyOnly = [{ id: "body", text: "手工正文。" }];
      const table = input.records.find(record => record.type === "table_cells");
      bodyOnly.push({ id: table.id, cells: table.cells.map(([index]) => [index, "方法"]) });
      await service.importManualTranslation(documentID, JSON.stringify({ translations: bodyOnly }));
      assert.equal(JSON.stringify(await storage.readJSON(paths.images)), before, "incomplete new answers must retain complete prior image translations");
      assert.equal(first.model.pages[0].blocks[0].translatedImageLabels.length, 2);
      service.imageService.ensure = async () => { throw new Error("OCR unavailable"); };
      const failedOCR = await service.translate(documentID, { force: true });
      assert.equal(failedOCR.translations.body, "正文译文。");
      assert.equal(JSON.stringify(await storage.readJSON(paths.images)), before);
    } finally { delete context.DOMParser; }
  }

  async function shortIDsDenseIndicesAndManualTaskBinding() {
    context.DOMParser = DOMParser;
    try {
      const { service, documentID } = fixture();
      const ocr = await service.imageService.ensure();
      ocr.images[0].lines = ["100", "25", "Control", "50", "Treatment", "75", "ACCURACY"].map((text, index) => ({ text, bbox: [.1, .05 + index * .1, .7, .1 + index * .1], score: .99 }));
      service.imageService.ensure = async () => ocr;
      const { records, imagePlan } = await service.manualTranslationInput(documentID);
      const image = records.find(record => record.type === "image_labels");
      const wire = service.manualRecordPayload(image);
      assert.equal(wire.id, "I1");
      assert.deepEqual(Array.from(wire.cells, pair => pair[0]), [1, 2, 3]);
      assert.deepEqual(Array.from(image.cells, pair => pair[0]), [2, 4, 6], "original OCR row indices must stay local");
      const row = { id: "I1", cells: [[1, "对照组"], [2, "处理组"], [3, "准确率"]] };
      const raw = JSON.stringify({ request: records.requestCode }) + "\n" + JSON.stringify(row);
      const received = service.parseManualTranslationResponse(raw, records).translations;
      const cache = I.cacheFromRecords(imagePlan, received, ocr.sourceFingerprint, "简体中文");
      assert.equal(cache.images[0].translations[2], "对照组");assert.equal(cache.images[0].translations[6], "准确率");
      assert.equal(service.parseTranslationResponse(JSON.stringify({ translations: [row] }), records).translations[image.id], received[image.id]);
      assert.throws(() => service.parseManualTranslationResponse(JSON.stringify(row), records), /任务码/);
      assert.throws(() => service.parseManualTranslationResponse(raw.replace(records.requestCode, "other-task"), records), /任务码/);
      const different = service.bindManualRequest("another-document", [...records], "简体中文");
      assert.throws(() => service.parseManualTranslationResponse(raw, different), /任务码/);
      const legacy = { id: image.id, cells: [[2, "对照组"], [4, "处理组"], [6, "准确率"]] };
      assert.equal(service.parseManualTranslationResponse(JSON.stringify(legacy), records).translations[image.id], received[image.id], "old long-ID answers remain readable");
      const table = records.find(record => record.type === "table_cells");
      assert.equal(service.manualRecordPayload(table).id, "T1");
      const map = context.LitMTrans.LayoutTables.recordMap([
        { id: "tbl0", wireID: "T1" }, { id: "tbl1", wireID: "T2" }
      ]);
      assert.equal(map.get("T1").id, "tbl0");assert.equal(map.get("tbl1").wireID, "T2");
    } finally { delete context.DOMParser; }
  }

  async function OCRSniffsImageContentAndReusesSidecar() {
    const { storage, documentID, service } = fixture();
    storage.getDocumentMeta = async () => ({ parseProvider: "paddle" });
    const layout = await service.loadLayout(documentID);
    const originalPDF = context.PDFLib, originalRequest = context.LitMTrans.HTTP.requestBytes;
    let uploads = 0, jpeg = 0;
    storage.readBytes = async () => new Uint8Array([255, 216, 255, 0]);
    context.PDFLib = { degrees: value => ({ angle: value }), PDFDocument: { create: async () => ({
      embedPng: async () => assert.fail("JPEG data with a .png suffix must not be decoded as PNG"),
      embedJpg: async () => { jpeg++;return { width: 100, height: 100 }; }, addPage: () => ({ drawImage() {} }), save: async () => new Uint8Array([1])
    }) } };
    context.LitMTrans.HTTP.requestBytes = async () => new TextEncoder().encode(JSON.stringify({ result: {
      ocrResults: [{ prunedResult: { rec_texts: ["RAW INPUT"], rec_scores: [.99], rec_polys: [[[42, 42], [92, 42], [92, 62], [42, 62]]] } }], dataInfo: { pages: [{ width: 296, height: 164 }] }
    } }));
    const paddle = { secrets: { getPaddleToken: () => "fixture-token" }, submit: async (_bytes, model, _token, _signal, options) => {
      uploads++;assert.equal(model, "PP-OCRv6");assert.equal(options.textDetLimitSideLen, 2000);return {};
    }, poll: async () => "https://example.test/result" };
    try {
      const ocr = new context.LitMTrans.ImageTranslationService(storage, paddle);
      const first = await ocr.ensure(documentID, layout);
      assert.equal(first.images.length, 1);assert.equal(first.images[0].lines.length, 1);assert.equal(jpeg, 1);
      await ocr.ensure(documentID, layout);assert.equal(uploads, 1, "reopening or retranslating must reuse source-bound OCR");
      paddle.secrets.getPaddleToken = () => "";
      assert.equal((await ocr.ensure(documentID, layout)).images.length, 1, "existing OCR must remain usable after a token is removed");
      storage.json.delete(storage.path(documentID, "image-ocr.v1.json"));
      const events = [];
      assert.equal((await ocr.ensure(documentID, layout, null, event => events.push(event))).images.length, 0);
      assert.equal(uploads, 1, "a MinerU-only setup must not submit Paddle requests");
      assert(events.some(event => event.message.includes("Paddle") && event.message.includes("原文")));
    } finally { context.PDFLib = originalPDF;context.LitMTrans.HTTP.requestBytes = originalRequest; }
  }

  async function imagePreferenceSkipsOCRAndSupplementsOnlyImages() {
    context.DOMParser = DOMParser;
    const { storage, service, documentID, settings, calls } = fixture();
    let recognized = 0;
    const originalEnsure = service.imageService.ensure;
    service.imageService.ensure = async (...args) => {
      recognized++;const ocr = await originalEnsure(...args);
      await storage.writeJSON(storage.path(documentID, "image-ocr.v1.json"), ocr);return ocr;
    };
    try {
      await storage.writeText(storage.path(documentID, "full.cleaned.md"), "Full document context.");
      delete settings.translateImages;
      await service.translate(documentID);
      assert.equal(recognized, 0, "未勾选图片翻译时默认不能消耗 OCR 额度");
      calls.length = 0;
      await storage.remove(service.paths(documentID, settings.targetLanguage).translations);
      settings.translateImages = false;
      await service.translate(documentID);
      assert.equal(recognized, 0, "关闭图片翻译时不能消耗 OCR 额度");
      assert(calls[0].every(record => record.type !== "image_labels"));
      const paths = service.paths(documentID, settings.targetLanguage);
      const body = JSON.stringify(await storage.readJSON(paths.translations)), tables = JSON.stringify(await storage.readJSON(paths.tables));
      await service.imageTranslationInput(documentID, { includeMarkdown: false });
      assert.equal(recognized, 0, "状态检查不能发起 OCR");
      settings.translateImages = true;
      await service.translateImagesOnly(documentID);
      assert.equal(calls.length, 2);assert(calls[1].every(record => record.type === "image_labels"));
      assert.equal(JSON.stringify(await storage.readJSON(paths.translations)), body);
      assert.equal(JSON.stringify(await storage.readJSON(paths.tables)), tables);
      const status = await service.imageTranslationInput(documentID, { includeMarkdown: false });
      assert.equal(status.missing.length, 0);assert(Object.keys(status.cached).length > 0);
      assert.equal(recognized, 1);
      await service.translateImagesOnly(documentID);assert.equal(calls.length, 2, "已有图片译文不能重复请求翻译模型");
    } finally { delete context.DOMParser; }
  }

  async function paddleImagesShareOneMultipageRequest() {
    const { storage, documentID, service } = fixture();
    storage.getDocumentMeta = async () => ({ parseProvider: "paddle" });
    const raw = JSON.stringify({ pdf_info: [{ page_size: [600, 800], preproc_blocks: Array.from({ length: 62 }, (_, i) => ({
      type: "image_body", bbox: [10, 10 + i, 100, 100 + i], image_path: `images/${i}.jpg`
    })) }] });
    storage.text.set(storage.path(documentID, "layout.json"), raw);
    storage.readBytes = async () => new Uint8Array([255, 216, 255]);
    const originalPDF = context.PDFLib, originalRequest = context.LitMTrans.HTTP.requestBytes;
    let requests = 0, pages = 0;
    context.PDFLib = { degrees: value => ({ angle: value }), PDFDocument: { create: async () => ({
      embedJpg: async () => ({ width: 1000, height: 1000 }), addPage: () => { pages++;return { drawImage() {} }; },
      save: async () => new Uint8Array([1])
    }) } };
    context.LitMTrans.HTTP.requestBytes = async () => new TextEncoder().encode(JSON.stringify({ result: {
      ocrResults: Array.from({ length: 124 }, (_, i) => ({ prunedResult: { rec_texts: [`Label ${Math.floor(i / 2)}`], rec_scores: [1],
        rec_polys: [[[42, 42], [142, 42], [142, 62], [42, 62]]] } })),
      dataInfo: { pages: Array.from({ length: 124 }, () => ({ width: 1064, height: 1064 })) }
    } }));
    const paddle = { secrets: { getPaddleToken: () => "fixture" }, submit: async () => { requests++;return {}; }, poll: async () => "https://example.test/result" };
    try {
      const ocr = new context.LitMTrans.ImageTranslationService(storage, paddle);
      const result = await ocr.ensure(documentID, await service.loadLayout(documentID));
      assert.equal(requests, 1, "超过20张图片的多页PDF仍只提交一次");
      assert.equal(pages, 124);
      for (let i = 0; i < 62; i++) assert.equal(result.images[i].lines[0].text, `Label ${i}`, "返回页必须映射到对应原图");
      await ocr.ensure(documentID, await service.loadLayout(documentID));assert.equal(requests, 1);
    } finally { context.PDFLib = originalPDF;context.LitMTrans.HTTP.requestBytes = originalRequest; }
  }

  async function paddleRequestSplitsOnlyAtDocumentLimits() {
    const originalPDF = context.PDFLib, P = require("pdf-lib");
    context.PDFLib = { ...P, PDFDocument: { create: async () => {
      const doc = await P.PDFDocument.create(), copy = doc.copyPages.bind(doc);
      doc.copyPages = (source, indices) => copy(source, Array.from(indices));
      return doc;
    } } };
    try {
      const pdf = await P.PDFDocument.create();
      for (let i = 0; i < 5; i++) pdf.addPage([100, 100]);
      const sheets = Array.from({ length: 5 }, (_, i) => ({ id: i }));
      const ocr = new context.LitMTrans.ImageTranslationService(new MemoryStorage(), null);
      const requests = await ocr.paddleImageRequests(pdf, sheets, 200 * 1024 * 1024, 2);
      assert.deepEqual(requests.flatMap(r => r.sheets.map(s => s.id)), [0, 1, 2, 3, 4]);
      for (const request of requests) assert((await P.PDFDocument.load(request.bytes)).getPageCount() <= 2);
      const one = await P.PDFDocument.create();one.addPage([100, 100]);
      await assert.rejects(ocr.paddleImageRequests(one, [{}], 1), /上传限制/);
    } finally { context.PDFLib = originalPDF; }
  }

  async function imageOCRUsesTheSelectedParserWithoutCrossServiceFallback() {
    const oldPDF = context.PDFLib, request = context.LitMTrans.HTTP.requestBytes;
    context.PDFLib = { degrees: value => ({ angle: value }), PDFDocument: { create: async () => ({ embedJpg: async () => ({ width: 100, height: 100 }),
      addPage: () => ({ drawImage() {} }), save: async () => new Uint8Array([1]) }) } };
    context.LitMTrans.HTTP.requestBytes = async () => new TextEncoder().encode(JSON.stringify({ result: {
      ocrResults: [{ prunedResult: { rec_texts: ["Label"], rec_scores: [1], rec_polys: [[[42, 42], [92, 42], [92, 62], [42, 62]]] } }], dataInfo: { pages: [{ width: 164, height: 164 }] }
    } }));
    const oldMineruLocal = I.mineruUseLocalOCR;
    I.mineruUseLocalOCR = false;
    try {
      for (const [provider, paddleToken, mineruToken] of [["mineru", "pp", "mu"], ["paddle", "pp", "mu"], ["mineru", "pp", ""], ["paddle", "", "mu"], ["", "pp", "mu"]]) {
        const { storage, service, documentID, sourceFingerprint } = fixture(), layout = await service.loadLayout(documentID);
        storage.getDocumentMeta = async () => ({ parseProvider: provider });
        storage.readBytes = async () => new Uint8Array([255, 216, 255]);
        let pp = 0, mu = 0, ppReads = 0, muReads = 0;
        const paddle = { secrets: { getPaddleToken: () => { ppReads++;return paddleToken; } },
          submit: async () => { pp++;return {}; }, poll: async () => "https://example.test/result" };
        const mineru = { secrets: { getMinerUToken: () => { muReads++;return mineruToken; } } };
        const ocr = new context.LitMTrans.ImageTranslationService(storage, paddle, mineru);
        ocr.collectMinerUFigures = async () => { mu++;return [{ ...I.extract(layout)[0], lines }]; };
        const hint = provider === "paddle" ? "mineru" : "paddle", selected = hint;
        const result = await ocr.ensure(documentID, layout, null, null, { parseProvider: hint });
        assert.equal(pp, selected === "paddle" && Boolean(paddleToken) ? 1 : 0);
        assert.equal(mu, selected === "mineru" && Boolean(mineruToken) ? 1 : 0);
        assert.equal(selected === "mineru" ? ppReads : muReads, 0, "不能读取或调用另一家已保存的令牌");
        assert.equal(result.model, selected === "paddle" ? "PP-OCRv6" : "mineru-pipeline");
        if (!(selected === "paddle" ? paddleToken : mineruToken)) assert.equal(result.images.length, 0, "所选服务缺少令牌时保留原图，不跨服务兜底");
        const cache = { version: 1, sourceFingerprint, parseRevisionID: "", model: "PP-OCRv6", images: [{ ...I.extract(layout)[0], lines }] };
        await storage.writeJSON(storage.path(documentID, "image-ocr.v1.json"), cache);
        const before = pp + mu;
        assert.equal((await ocr.ensure(documentID, layout, null, null, { parseProvider: hint })).images[0].lines.length, lines.length);
        assert.equal(pp + mu, before, "已有 OCR 缓存不因分离服务而强制重识别");
      }
    } finally { I.mineruUseLocalOCR = oldMineruLocal;context.PDFLib = oldPDF;context.LitMTrans.HTTP.requestBytes = request; }
  }

  async function switchingOCRServiceSupplementsOnlyEmptyImages() {
    const { storage, documentID, service, settings } = fixture();
    const raw = JSON.parse(await storage.readText(storage.path(documentID, "layout.json")));
    raw.pdf_info[0].preproc_blocks.push({ type: "image_body", bbox: [40, 450, 300, 600], image_path: "images/empty.jpg" });
    await storage.writeText(storage.path(documentID, "layout.json"), JSON.stringify(raw));
    const layout = await service.loadLayout(documentID), figures = I.extract(layout);
    storage.getDocumentMeta = async () => ({ parseProvider: "mineru", parseRevisionID: "" });
    storage.readBytes = async () => new Uint8Array([255, 216, 255]);
    const prior = { version: 1, sourceFingerprint: U.hashString(layout.rawText), parseRevisionID: "", model: "mineru-pipeline", strategy: "shared-gray-crops-v3",
      images: [{ ...figures[0], lines }, { ...figures[1], lines: [] }] };
    const cachePath = storage.path(documentID, "image-ocr.v1.json");
    await storage.writeJSON(cachePath, prior);
    const originalPDF = context.PDFLib, originalRequest = context.LitMTrans.HTTP.requestBytes;
    let requests = 0, embedded = 0, token = "fixture";
    context.PDFLib = { degrees: value => ({ angle: value }), PDFDocument: { create: async () => ({ embedJpg: async () => { embedded++;return { width: 100, height: 100 }; },
      addPage: () => ({ drawImage() {} }), save: async () => new Uint8Array([1]) }) } };
    context.LitMTrans.HTTP.requestBytes = async () => new TextEncoder().encode(JSON.stringify({ result: {
      ocrResults: [{ prunedResult: { rec_texts: [], rec_scores: [], rec_polys: [] } }], dataInfo: { pages: [{ width: 164, height: 164 }] }
    } }));
    const paddle = { secrets: { getPaddleToken: () => token }, submit: async () => { requests++;return {}; }, poll: async () => "https://example.test/result" };
    const ocr = new context.LitMTrans.ImageTranslationService(storage, paddle, { secrets: { getMinerUToken: () => assert.fail("不能读取旧解析服务的令牌") } });
    try {
      settings.parseProvider = "paddle";
      assert.equal((await service.imageTranslationInput(documentID)).needsOCR, true);
      token = "";
      assert.deepEqual(await ocr.ensure(documentID, layout, null, null, { parseProvider: "paddle" }), prior, "没有所选令牌时保留旧结果");
      token = "fixture";
      const result = await ocr.ensure(documentID, layout, null, null, { parseProvider: "paddle" });
      assert.equal(requests, 1);assert.equal(embedded, 1, "只提交旧结果为空的图片");
      assert.equal(result.model, "PP-OCRv6");
      assert.deepEqual(result.images[0], prior.images[0], "已成功的 OCR 行和顺序必须完整保留");
      assert.equal(result.images[1].id, figures[1].id);
      await ocr.ensure(documentID, layout, null, null, { parseProvider: "paddle" });
      assert.equal(requests, 1, "所选服务仍返回空结果也不重复请求");
      assert.equal((await service.imageTranslationInput(documentID)).needsOCR, false);
    } finally { context.PDFLib = originalPDF;context.LitMTrans.HTTP.requestBytes = originalRequest; }
  }

  async function mineruOnlyOCRAndTemporaryCleanup() {
    const pages = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/mineru/image-ocr-model.json"), "utf8"));
    const flow = I.linesFromMinerU(pages[0]);
    assert.equal(flow.length, 6);assert.equal(flow[1].text, "IMAGE TEXT 7319");
    assert.equal(I.linesFromMinerU(pages[1]).length, 1, "chart internals are unavailable and must not be inferred");
    assert(Math.abs(flow[0].bbox[0] - 153 / 1441) < 1e-9, "normalize against raw OCR page dimensions");
    const invalid = JSON.parse(JSON.stringify(pages[0]));
    const source = invalid.layout_dets.find(line => line.label === "ocr_text");
    invalid.layout_dets = [
      { ...source, score: .2 }, { ...source, angle: 90 }, { ...source, bbox: [-1, 10, 200, 30] },
      { ...source, bbox: [10, 10, 20, 200] }, { ...source, text: "two\nlines" }, { ...source, label: "chart" }
    ];
    assert.equal(I.linesFromMinerU(invalid).length, 0);
    const { storage, documentID, service } = fixture();
    const layout = await service.loadLayout(documentID);
    const oldPDF = context.PDFLib;
    let submits = 0, removed = 0, options;
    storage.readBytes = async () => new Uint8Array([255, 216, 255]);
    storage.temporaryDir = () => "/tmp/imageocr-fixture";
    storage.ensureDir = async () => {};
    storage.writeBytes = async () => {};
    storage.remove = async dir => { assert.equal(dir, "/tmp/imageocr-fixture");removed++; };
    await storage.writeJSON("/tmp/model.json", [pages[0]]);
    context.PDFLib = { PDFDocument: { create: async () => ({ embedJpg: async () => ({}),
      addPage: () => ({ drawImage() {} }), save: async () => new Uint8Array([1]) }) } };
    const mineru = { secrets: { getMinerUToken: () => "fixture" },
      submit: async (_file, values) => { submits++;options = values;return {}; }, upload: async () => {},
      poll: async () => ({}), downloadResult: async () => ({ zipPath: "/tmp/result.zip" }),
      extractZip: async () => {}, locateResultFiles: async () => ({ model: "/tmp/model.json" }) };
    const paddle = { secrets: { getPaddleToken: () => "" }, submit: async () => assert.fail("must not call Paddle") };
    const ocr = new context.LitMTrans.ImageTranslationService(storage, paddle, mineru);
    ocr.packImageText = async () => ({ bytes: new Uint8Array([1]), size: [100, 100], sourceSize: [100, 100], mapping: [] });
    let sharedCalls = 0;
    ocr.recognizeSharedImageText = async inputs => ++sharedCalls === 1
      ? [await ocr.recognizeMinerU(new Uint8Array([1]), 1, "fixture").then(rows => rows[0]), []] : inputs.map(() => []);
    const oldMineruLocal = I.mineruUseLocalOCR;
    I.mineruUseLocalOCR = false;
    try {
      const result = await ocr.ensure(documentID, layout);
      assert.equal(result.model, "mineru-pipeline");assert.equal(result.images[0].lines.length, 6);
      assert.equal(options.modelVersion, "pipeline");assert.equal(options.isOCR, true);
      assert.equal(options.enableTable, false);assert.equal(options.enableFormula, false);
      assert.equal(removed, 1);
      await ocr.ensure(documentID, layout);assert.equal(submits, 1, "reuse OCR without another MinerU request");
      await assert.rejects(ocr.recognizeMinerU(new Uint8Array([1]), 2, "fixture"), /页数|顺序/);
      assert.equal(removed, 2, "remove temporary files on incompatible responses");
      mineru.poll = async () => { throw new Error("service unavailable"); };
      await assert.rejects(ocr.recognizeMinerU(new Uint8Array([1]), 1, "fixture"), /service unavailable/);
      assert.equal(removed, 3, "remove temporary files on request failures");
    } finally { I.mineruUseLocalOCR = oldMineruLocal;context.PDFLib = oldPDF; }
  }

  function packedMinerUCoordinatesAndOverlapProtection() {
    const data = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/mineru/image-packed-chart.json"), "utf8"));
    const mapped = I.mapPackedImageLines(data.lines, data.packing);
    for (const text of ["Treatment response", "Control", "Treatment", "ACCURACY"]) {
      assert(mapped.some(line => line.text === text), `真实 OCR 必须能反映射 ${text}`);
    }
    assert(!mapped.some(line => line.text === "Stable growth"), "与数值框重叠的标签保留原文，不能遮住 87%");
    const growth = I.mapPackedImageLines(data.lines.filter(line => line.text === "Stable growth"), data.packing)[0];
    const value = I.mapPackedImageLines(data.lines.filter(line => line.text === "87%"), data.packing)[0];
    assert(growth.bbox[0] > value.bbox[0], "同一候选中的文字和数值按各自行框还原");
    assert(growth.bbox[1] < value.bbox[1]);
    const merged = I.mergeImageLines([{ ...mapped[0], text: "Existing title" }], mapped);
    assert.equal(merged.filter(line => line.text === "Treatment response").length, 0, "新候选不能覆盖原 OCR 行");
    assert(merged.some(line => line.text === "Control"));
    const ambiguous = { ...data.packing, mapping: [...data.packing.mapping, ...data.packing.mapping] };
    assert.equal(I.mapPackedImageLines(data.lines, ambiguous).length, 0, "位置不唯一时保留原图");
    assert.equal(I.mapPackedImageLines([{ text: "Outside", bbox: [.9, .98, 1, 1], score: 1 }], data.packing).length, 0);
    const scaled = { size: [600, 300], sourceSize: [200, 100], mapping: [{ source: [20, 10, 120, 30], packed: [30, 30, 330, 90] }] };
    const row = { text: "Wind Lidar", bbox: [60 / 600, 36 / 300, 300 / 600, 84 / 300], score: 1 };
    const restored = I.mapPackedImageLines([row], scaled)[0];
    assert.deepEqual(restored.bbox.map(value => Math.round(value * 1000)), [150, 120, 550, 280]);
    const shallow = { size: [100, 100], sourceSize: [100, 100], mapping: [{ source: [0, 0, 100, 100], packed: [0, 0, 100, 100] }] };
    assert.equal(I.mapPackedImageLines([{ text: "Elevation", bbox: [.1, .1, .8, .3] }, { text: "4000", bbox: [.6, .26, .9, .46] }], shallow).length, 2);
  }

  function verticalLabelsAvoidAdjacentTicks() {
    const ticks = [{ text: "0.12", bbox: [.033, .72, .06, .75] }];
    const label = { text: "Kinetic energy", bbox: [.01, .70, .034, .90], rotation: -90 };
    const result = I.mergeImageLines(ticks, [label]);
    assert.equal(result.length, 2);
    assert.equal(result[1].bbox[2], ticks[0].bbox[0]);
    assert.equal(result[1].rotation, -90);
    assert.equal(label.bbox[2], .034, "不得修改已有识别结果");
    const replacement = I.mergeImageLines([{ text: "Hei (m)", bbox: [.5, .3, .52, .4] }],
      [{ text: "Height (m)", bbox: [.5, .3, .52, .4], rotation: -90 }]);
    assert.equal(replacement.length, 1);
    assert.equal(replacement[0].text, "Height (m)");
    assert.equal(replacement[0].rotation, -90);
    const numbered = I.mergeImageLines([{ text: "(a) 3", bbox: [.01, 0, .07, .04] }],
      [{ text: "Kinetic energy", bbox: [.025, 0, .045, .24], rotation: -90 }]);
    assert.equal(numbered.length, 2);
    assert.equal(numbered[1].bbox[1], .04);
  }

  function repeatedFigureLabelsCorrectOCRSpelling() {
    const input = ["----- Ultrasonic anemometer", "Ultrasonic anemometer", "Ultrasonic anemonteter", "Control 1", "Control 2"]
      .map(text => ({ text, bbox: [0, 0, .5, .1] }));
    const output = I.normalizeImageLines(input);
    assert.deepEqual(output.map(line => line.text), ["Ultrasonic anemometer", "Ultrasonic anemometer", "Ultrasonic anemometer", "Control 1", "Control 2"]);
    assert.equal(input[0].text, "----- Ultrasonic anemometer");
    const overlap = I.normalizeImageLines([{ text: "Local time (h)", bbox: [.2, .5, .4, .6] },
      { text: "2022/1/1 12:00", bbox: [.2, .41, .4, .51] }]);
    assert.equal(overlap[0].bbox[1], .51);
    assert.equal(overlap[1].bbox[3], .51);
    const units = I.normalizeImageLines(["Kinetic energy (m²/s2)", "Kinetic energy (m²/s²)", "Kinetic energy (m²/s2)2"]
      .map(text => ({ text, bbox: [0, 0, .5, .1] })));
    assert(units.every(line => line.text === "Kinetic energy (m²/s²)"));
    const distinct = I.normalizeImageLines(["Control group", "Control group", "Control groups"].map(text => ({ text, bbox: [0, 0, .5, .1] })));
    assert.equal(distinct[2].text, "Control groups");
    const page = I.normalizeImageLines([{ text: "Local time (h)", bbox: [.2, .5, .4, .6] },
      { text: "Local time (h)", bbox: [.2, .5, .4, .6] }, { text: "Iocal time (h)", bbox: [.2, .5, .4, .6] },
      { text: "4000", bbox: [.2, .51, .4, .6] }], false);
    assert.equal(page[2].text, "Local time (h)");
    assert.equal(page[0].bbox[1], .5, "跨子图复用文本不能混用不同图片的坐标");
  }

  function neutralCandidatesSeparateTextFromColoredLines() {
    const width = 240, height = 300, pixels = new Uint8Array(width * height * 4).fill(255);
    for (let x = 20; x < 210; x++) pixels.set([190, 20, 20, 255], (35 * width + x) * 4);
    for (let x = 80; x < 160; x += 10) for (let y = 27; y < 41; y++) for (let dx = 0; dx < 5; dx++)
      pixels.set([20, 20, 20, 255], (y * width + x + dx) * 4);
    const boxes = I.imageTextCandidates(pixels, width, height, true).boxes;
    assert(boxes.some(box => box[0] <= 80 && box[2] >= 155 && box[0] > 20), "文字候选应与横穿的彩色线分开");
  }

  function partialMachineImageTranslationsRemainVisible() {
    const image = { id: "image:0:0", page: 0, bbox: [0, 0, 100, 100], lines: lines.slice(0, 2) };
    context.DOMParser = DOMParser;
    try {
      const layout = { rawText: JSON.stringify({ pdf_info: [] }) };
      const fingerprint = U.hashString(layout.rawText);
      const plan = I.requestPlan({ version: 1, sourceFingerprint: fingerprint, images: [image] }, layout, true);
      const result = I.cacheFromRecords(plan, { [plan.records[0].id]: "原始输入" }, fingerprint, "简体中文");
      assert.equal(result.images.length, 1);
      assert.deepEqual(Object.keys(I.cachedRecords(plan, result, fingerprint)), [plan.records[0].id]);
      const model = { sourceFingerprint: fingerprint, pages: [{ blocks: [{ type: "image_body", bbox: image.bbox }] }] };
      const block = I.attach(model, result).pages[0].blocks[0];
      assert.equal(block.translatedImageLabels.length, 1);
      assert.equal(block.imageProtectedBoxes.length, 1);
    } finally { delete context.DOMParser; }
  }

  function imageTextCandidatesExcludeLargeGraphics() {
    const width = 400, height = 300, pixels = new Uint8Array(width * height * 4).fill(255);
    const rect = (left, top, w, h) => {
      for (let y = top; y < top + h; y++) for (let x = left; x < left + w; x++) pixels.set([20, 20, 20, 255], (y * width + x) * 4);
    };
    rect(10, 20, 80, 100);
    for (let x = 160; x < 240; x += 10) { rect(x, 50, 5, 14);rect(x, 90, 5, 14); }
    const result = I.imageTextCandidates(pixels, width, height);
    assert.equal(result.boxes.length, 2, "分行提取小笔画，大图形不进入识别副本");
    assert(result.boxes.every(box => box[0] >= 150 && box[2] <= 250));
    assert.equal(result.mask[30 * width + 20], 0);
    assert.equal(I.imageTextCandidates(pixels, 4000, 3000).boxes.length, 0);
  }

  async function imageOCRPackingPreservesOriginalStrokes() {
    const pixels = new Uint8ClampedArray(400 * 300 * 4).fill(255);
    const rect = (left, top, w, h) => {
      for (let y = top; y < top + h; y++) for (let x = left; x < left + w; x++) pixels.set([40, 80, 120, 255], (y * 400 + x) * 4);
    };
    rect(10, 20, 80, 100);
    for (let x = 160; x < 240; x += 10) rect(x, 50, 5, 14);
    const before = new Uint8ClampedArray(pixels), oldWindow = context.Zotero.getMainWindow;
    let written;
    context.Zotero.getMainWindow = () => ({ Image: class {
      constructor() { this.naturalWidth = 400;this.naturalHeight = 300; }
      set src(value) { if (value) this.onload?.(); }
    }, document: { createElementNS: () => ({ width: 0, height: 0,
      getContext: () => ({ fillRect() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(pixels) }),
        putImageData: image => { written = image.data; } }), toDataURL: () => "data:image/png;base64,AA=="
    }) } });
    try {
      const ocr = new context.LitMTrans.ImageTranslationService(new MemoryStorage(), null);
      const result = await ocr.packImageText(new Uint8Array([1]), true);
      assert(result.mapping.length > 0);
      assert.equal(I.imageTextCandidates(before, 400, 300).mask[30 * 400 + 20], 0);
      assert.equal(written[(30 * 400 + 20) * 4], 73, "被定位掩膜剔除的连通笔画仍须保留在灰度识别副本中");
      assert.equal(written[(50 * 400 + 160) * 4], 73);
      assert.deepEqual(pixels, before, "原始图片像素不可修改");
    } finally { context.Zotero.getMainWindow = oldWindow; }
  }

  function sharedSheetsKeepImageOwnershipAndBudget() {
    const inputs = Array.from({ length: 12 }, () => ({ packing: { sourceSize: [500, 300], mapping: [
      { source: [10, 20, 130, 40], packed: [20, 20, 140, 40] }, { source: [10, 80, 110, 100], packed: [20, 70, 120, 90] }
    ] } }));
    const sheets = I.planImageOCRSheets(inputs);
    assert.equal(sheets.length, 1, "十二张图片的短标签共用一页，不上传十二张原图");
    assert(sheets[0].size[0] <= 712 && sheets[0].size[1] <= 1000, "裁片原尺寸并排摆放，控制单页尺寸");
    assert.equal(sheets[0].cells.length, 24);
    for (let index = 0; index < inputs.length; index++) {
      const cells = sheets[0].cells.filter(cell => cell.input === index);
      const packing = { size: sheets[0].size, sourceSize: inputs[index].packing.sourceSize, mapping: cells };
      const rows = cells.map((cell, i) => ({ text: `Image ${index} line ${i}`, bbox: cell.packed.map((v, axis) => v / sheets[0].size[axis % 2]), score: 1 }));
      const mapped = I.mapPackedImageLines(rows, packing);
      assert.equal(mapped.length, 2);
      assert.equal(mapped[0].text, `Image ${index} line 0`);
      assert(Math.abs(mapped[0].bbox[0] - .02) < 1e-9);
    }
    const large = I.planImageOCRSheets(Array.from({ length: 100 }, () => inputs[0]));
    assert(large.length > 1);assert.equal(large.flatMap(sheet => sheet.cells).length, 200);
    for (const sheet of large) for (const cell of sheet.cells) {
      assert(cell.packed[2] <= sheet.size[0] && cell.packed[3] <= sheet.size[1]);
      for (const other of sheet.cells) if (other !== cell) {
        assert(Math.min(cell.packed[2], other.packed[2]) <= Math.max(cell.packed[0], other.packed[0])
          || Math.min(cell.packed[3], other.packed[3]) <= Math.max(cell.packed[1], other.packed[1]), "共享页中的裁片不能重叠");
      }
    }
    const pairs = I.planImageOCRSheets(inputs, 2);
    assert.equal(pairs.length, 12, "补识别裁片两两拼页，减少文件页数");
    assert(pairs.every(sheet => sheet.cells.length === 2));
    for (const sheet of pairs) {
      const [left, right] = sheet.cells;
      assert(left.packed[2] < right.packed[0], "不同图片的补识别裁片必须留出间隔");
    }
  }

  async function mineruPreservesSuccessfulBatches() {
    const oldPDF = context.PDFLib, { storage } = fixture();
    context.PDFLib = { ...require("pdf-lib"), PDFDocument: { create: async () => ({
      embedPng: async () => ({}), addPage: () => ({ drawImage() {}, pushOperators() {} }), save: async () => new Uint8Array([1])
    }) } };
    try {
      const ocr = new context.LitMTrans.ImageTranslationService(storage, null);
      let calls = 0;
      ocr.recognizeMinerU = async (_bytes, count) => {
        calls++;
        if (calls === 1) throw new Error("first task failed");
        return Array.from({ length: count }, () => [{ text: "Recovered label", bbox: [.12, .24, .32, .44], score: 1 }]);
      };
      const inputs = Array.from({ length: 41 }, () => ({ packing: { bytes: new Uint8Array([1]), size: [100, 100], sourceSize: [100, 100],
        mapping: [{ source: [50, 50, 90, 70], packed: [10, 10, 50, 30] }] } }));
      const result = await ocr.recognizeSharedImageText(inputs, "fixture", null, null, true);
      assert.equal(calls, 2);
      assert.equal(result[0].length, 0);
      assert.equal(result[40][0].text, "Recovered label", "前一个任务失败不能丢掉后续成功结果");
    } finally { context.PDFLib = oldPDF; }
  }

  function paddleWholeImagesSharePagesWithoutShrinking() {
    const inputs = [{ width: 1440, height: 450 }, { width: 1440, height: 650 }, { width: 676, height: 423 }, { width: 681, height: 545 }];
    const sheets = I.planPaddleImageSheets(inputs);
    assert.equal(sheets.length, 1, "四张完整图片共用一页");
    const sheet = sheets[0];
    for (const cell of sheet.cells) {
      assert.equal(cell.box[2] - cell.box[0], inputs[cell.input].width);
      assert.equal(cell.box[3] - cell.box[1], inputs[cell.input].height);
      const row = { text: `Image ${cell.input}`, bbox: [cell.box[0] + 10, cell.box[1] + 10, cell.box[0] + 100, cell.box[1] + 30].map((value, i) => value / sheet.size[i % 2]), score: 1 };
      const mapped = I.mapPaddleSheetLines([row], sheet);
      assert.equal(mapped.get(cell.input).length, 1);
      assert.equal([...mapped.values()].flat().length, 1, "不能串到另一张图片");
      assert(Math.abs(mapped.get(cell.input)[0].bbox[0] - 10 / inputs[cell.input].width) < 1e-9);
    }
    assert.equal([...I.mapPaddleSheetLines([{ text: "Across images", bbox: [0, 0, 1, 1], score: 1 }], sheet).values()].flat().length, 0);
    const large = I.planPaddleImageSheets([{ width: 2300, height: 1400 }, ...inputs]);
    assert.equal(large.length, 2);assert.equal(large[0].size[0], 2364, "大图单独成页，不能强行缩小");
    const live = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/mineru/paddle-image-sheet.json"), "utf8"));
    const restored = I.mapPaddleSheetLines(live.lines, live.sheet);
    assert.equal(restored.get(0).length, 6);assert.equal(restored.get(1).length, 12);assert.equal(restored.get(2).length, 10);
    assert(restored.get(2).some(line => line.text === "Al2O₃"), "公式和图内文字的坐标都必须保留，交由已有保护规则处理");
    assert(!restored.get(0).some(line => line.text === "Control"));
    assert(restored.get(3).some(line => line.text === "Mole fraction of Oxygen"));
  }

  function strokeRestorationPreservesLinesColorsAndProtectedValues() {
    const width = 220, height = 100, pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set([240 + Math.round(y * .1), 225 + Math.round(y * .1), 220 + Math.round(y * .1), 255], (y * width + x) * 4);
    const paint = (x0, y0, w, h, rgb) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) pixels.set([...rgb, 255], (y * width + x) * 4); };
    paint(5, 55, 45, 2, [10, 10, 10]);
    for (let x = 70; x <= 150; x += 20) paint(x, 42, 9, 20, [190, 20, 20]);
    const original = new Uint8Array(pixels), result = I.restoreImageLabel(pixels, width, height, [0, .35, .8, .68], [], "LABEL");
    assert(result && result.changed > 0);
    assert(result.box[0] > 50, "译文字框排除左侧引线，不能把中文居中写到引线上");
    assert(result.color[0] > 150 && result.color[1] < 40, "保留原文字颜色");
    const at = ((48 - result.box[1]) * result.width + 73 - result.box[0]) * 4;
    assert(result.pixels[at] > 230 && result.pixels[at + 1] > 220, "按局部渐变补色，擦除红色笔画");
    assert.deepEqual(pixels, original, "不能改写原图像素数组");
    assert.equal(I.restoreImageLabel(pixels, width, height, [0, .35, .8, .68], [[.3, .4, .75, .65]], "LABEL"), null, "已知数值或公式区域不能覆盖");
    pixels[(50 * width + 100) * 4 + 3] = 0;
    assert.equal(I.restoreImageLabel(pixels, width, height, [0, .35, .8, .68], [], "LABEL"), null, "透明背景不能填成不透明色块");
  }

  function restorationDoesNotEraseOutsideOCRBox() {
    const width = 180, height = 100, pixels = new Uint8Array(width * height * 4).fill(255);
    const paint = (x0, y0, w, h) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) pixels.set([20, 20, 20, 255], (y * width + x) * 4); };
    for (const x of [30, 45, 60, 75]) paint(x, 40, 5, 16);
    paint(91, 40, 5, 16);
    const box = [25 / width, 38 / height, 90 / width, 58 / height];
    const result = I.restoreImageLabel(pixels, width, height, box, [], "LABEL");
    assert(result && result.changed > 0);
    for (let y = 0; y < result.height; y++) for (let x = 0; x < result.width; x++) {
      const gx = result.box[0] + x, gy = result.box[1] + y;
      if (gx >= 90) assert.equal(result.pixels[(y * result.width + x) * 4], pixels[(gy * width + gx) * 4]);
    }
  }

  function restorationKeepsColoredLegendInsideTextBox() {
    const width = 180, height = 80, pixels = new Uint8ClampedArray(width * height * 4).fill(255);
    const paint = (x0, y0, w, h, rgb) => {
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) pixels.set([...rgb, 255], (y * width + x) * 4);
    };
    for (let x = 24; x < 58; x += 9) paint(x, 38, 6, 2, [190, 40, 40]);
    for (let x = 64; x < 142; x += 10) paint(x, 32, 5, 14, [20, 20, 20]);
    const result = I.restoreImageLabel(pixels, width, height, [20 / width, 29 / height, 145 / width, 50 / height], [], "Ultrasonic anemometer");
    assert(result && result.changed > 0);
    for (let x = 24; x < 58; x++) {
      if (x < result.box[0] || x >= result.box[2]) continue;
      const source = (38 * width + x) * 4, target = ((38 - result.box[1]) * result.width + x - result.box[0]) * 4;
      assert.deepEqual([...result.pixels.slice(target, target + 4)], [...pixels.slice(source, source + 4)], "保留文字框内的红色图例线");
    }
  }

  function rotatedWordsJoinWithoutSwallowingUnits() {
    const lines = [
      { text: "Kinetic", bbox: [.02, .82, .04, .89], rotation: -90, score: .98 },
      { text: "energy", bbox: [.021, .76, .041, .82], rotation: -90, score: .97 },
      { text: "(m²/s²)", bbox: [.02, .69, .04, .76], rotation: -90, score: .9 }
    ];
    const merged = I.mergeAdjacentRotatedWords(lines);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].text, "Kinetic energy");
    assert.equal(merged[1].text, "(m²/s²)");
    assert.deepEqual([...merged[0].bbox], [.02, .76, .041, .89]);
  }

  function rotatedDetectionSkipsOnlyAlreadyRecognizedText() {
    const normal = [{ poly: [[10, 20], [60, 20], [60, 30], [10, 30]], text: "Known label" }];
    const known = { poly: [[70, 10], [80, 10], [80, 60], [70, 60]] };
    const missed = { poly: [[70, 70], [80, 70], [80, 90], [70, 90]] };
    const axis = { poly: [[20, 4], [75, 4], [75, 12], [20, 12]] };
    const rows = [{ boxes: [known, missed, axis] }];
    const filtered = I.filterRotatedDetections(rows, normal, 100);
    assert.equal(filtered[0].boxes.length, 2);
    assert(filtered[0].boxes.includes(missed), "未识别到的横向文字仍须复查");
    assert(filtered[0].boxes.includes(axis), "竖向文字旋转后必须识别");
    assert.equal(rows[0].boxes.length, 3);
    const horizontalOnly = I.filterRotatedDetections(rows, normal, 100, true);
    assert.deepEqual(horizontalOnly[0].boxes, [axis], "仅需旋转识别横向框时应跳过竖向框，避免无效识别");
  }

  function coloredCurveFilteringPreservesOrdinaryLabels() {
    const pixels = new Uint8ClampedArray(100 * 100 * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([235, 70, 70, 255], i);
    const curve = { bbox: [.1, .2, .7, .45], score: .58 };
    assert(I.isColoredCurveCandidate(curve, pixels, 100, 100));
    assert(!I.isColoredCurveCandidate({ ...curve, score: .9 }, pixels, 100, 100));
    assert(!I.isColoredCurveCandidate({ ...curve, bbox: [.1, .2, .3, .25] }, pixels, 100, 100));
    for (let i = 0; i < pixels.length; i += 4) pixels.set([20, 20, 20, 255], i);
    assert(!I.isColoredCurveCandidate(curve, pixels, 100, 100));
  }

  async function localOCRKeepsNewRotatedTextAndRestoresDetector() {
    const normal = [{ poly: [[10, 20], [60, 20], [60, 30], [10, 30]], text: "Known label" }];
    const known = { poly: [[70, 10], [80, 10], [80, 60], [70, 60]] };
    const missed = { poly: [[70, 70], [80, 70], [80, 90], [70, 90]] };
    const axis = { poly: [[20, 4], [75, 4], [75, 12], [20, 12]] };
    const detector = { predict: async () => [{ boxes: [known, missed, axis] }] }, original = detector.predict;
    const model = { detModel: detector, predict: async source => source === "normal"
      ? [{ image: { height: 100 }, items: normal }]
      : [{ items: (await detector.predict())[0].boxes }] };
    const result = await I.recognizeLocalImageText(model, "normal", "rotated");
    assert.equal(result.rotated.items.length, 2);
    assert(result.rotated.items.includes(missed));
    assert(result.rotated.items.includes(axis));
    assert.strictEqual(detector.predict, original, "一次识别完成后不改变模型检测器");
    model.predict = async source => { if (source === "normal") return [{ image: { height: 100 }, items: normal }];throw new Error("fixture failure"); };
    await assert.rejects(I.recognizeLocalImageText(model, "normal", "rotated"));
    assert.strictEqual(detector.predict, original, "失败后也不影响下一次识别");
  }

  async function localOCRPreservesLabelsAndReusesCache() {
    const { storage, documentID, service } = fixture(), layout = await service.loadLayout(documentID);
    let calls = 0;
    const ocr = new context.LitMTrans.ImageTranslationService(storage,
      { secrets: { getPaddleToken: () => assert.fail("MinerU 默认本地识别不能读取云端令牌") } },
      { secrets: { getMinerUToken: () => assert.fail("MinerU 默认本地识别不能读取云端令牌") } });
    ocr.collectLocalFigures = async (_id, figures) => {
      calls++;
      return figures.map(figure => ({ ...figure, lines: [
        { text: "2022/1/1", bbox: [.1, .8, .5, .9], score: .99 },
        { text: "Local time", bbox: [.2, .89, .5, .96], score: .98 }
      ] }));
    };
    const first = await ocr.ensure(documentID, layout), second = await ocr.ensure(documentID, layout);
    assert.equal(first.model, "local-ppocr-v6-tiny");
    assert(first.images[0].lines.some(line => line.text === "Local time"));
    assert.equal(second.images[0].lines.length, 2);
    assert.equal(calls, 1, "已有识别结果应直接复用");
  }

  function restorationCleansTextOnPaleBackground() {
    const width = 200, height = 80, pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) pixels.set([242, 244, 246, 255], i * 4);
    for (let x = 40; x < 160; x += 10) for (let y = 32; y < 48; y++) {
      for (let dx = 0; dx < 5; dx++) pixels.set([20, 20, 20, 255], (y * width + x + dx) * 4);
    }
    const result = I.restoreImageLabel(pixels, width, height, [35 / width, 29 / height, 165 / width, 51 / height], [], "Observation Tower");
    assert(result && result.changed > 0);
    for (const x of [42, 82, 122, 152]) {
      const at = ((40 - result.box[1]) * result.width + x - result.box[0]) * 4;
      assert(result.pixels[at] > 230, "浅色背景上的整行英文都应清除");
    }
  }

  function twoDimensionalRepairPreservesLocalBackground() {
    const width = 240, height = 100;
    const base = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const glow = 35 * Math.exp(-((x - 100) ** 2 + (y - 50) ** 2) / 3000);
      base.set([250, 250 - glow, 245 - glow, 255], (y * width + x) * 4);
    }
    const pixels = new Uint8ClampedArray(base);
    const paint = (x0, y0, w, h) => {
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) pixels.set([15, 15, 15, 255], (y * width + x) * 4);
    };
    for (const x of [70, 100, 130, 160]) paint(x, 40, 7, 20);
    paint(60, 62, 125, 2);
    const before = new Uint8ClampedArray(pixels);
    const result = I.restoreImageLabel(pixels, width, height, [.2, .35, .85, .65], [], "LABEL");
    assert(result && result.changed > 0);
    let repaired = 0, worstError = 0;
    for (let y = 0; y < result.height; y++) for (let x = 0; x < result.width; x++) {
      const gx = result.box[0] + x, gy = result.box[1] + y, src = (gy * width + gx) * 4, dst = (y * result.width + x) * 4;
      if (gy >= 62 && gy < 64) {
        assert.deepEqual([...result.pixels.slice(dst, dst + 4)], [...before.slice(src, src + 4)], "相邻引线必须保持原像素");
      } else if (before[src] === 15 && result.pixels[dst] > 200) {
        repaired++;
        for (let c = 0; c < 3; c++) worstError = Math.max(worstError, Math.abs(result.pixels[dst + c] - base[src + c]));
      } else if (before[src] !== 15) {
        assert.deepEqual([...result.pixels.slice(dst, dst + 4)], [...before.slice(src, src + 4)], "未遮挡的二维渐变不得重绘");
      }
    }
    assert(repaired > 100, "必须确实修复文字笔画");
    assert(worstError <= 4, `曲面背景补色误差过大：${worstError}`);
    assert.deepEqual(pixels, before);
  }

  function twoDimensionalRepairDoesNotSpreadNeighboringInk() {
    const width = 240, height = 100, pixels = new Uint8ClampedArray(width * height * 4).fill(255);
    const paint = (x0, y0, w, h) => {
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) pixels.set([20, 20, 20, 255], (y * width + x) * 4);
    };
    paint(90, 20, 15, 6);
    for (let x = 70; x < 190; x += 18) paint(x, 36, 8, 18);
    const result = I.restoreImageLabel(pixels, width, height, [.2, .3, .9, .6], [], "Ultrasonic anemometer");
    assert(result && result.changed > 0);
    for (let y = 0; y < result.height; y++) for (let x = 0; x < result.width; x++) {
      const source = ((result.box[1] + y) * width + result.box[0] + x) * 4, at = (y * result.width + x) * 4;
      if (pixels[source] === 255) assert.equal(result.pixels[at], 255, "相邻文字不可扩散成黑条");
    }
  }

  function adjacentImageLabelsKeepWhiteBackground() {
    const width = 180, height = 80, pixels = new Uint8ClampedArray(width * height * 4).fill(255);
    const paint = (x, y) => {
      for (let dy = 0; dy < 10; dy++) for (let dx = 0; dx < 5; dx++) pixels.set([25, 25, 25, 255], ((y + dy) * width + x + dx) * 4);
    };
    for (let x = 25; x < 120; x += 12) { paint(x, 24);paint(x, 36); }
    const first = [20 / width, 22 / height, 125 / width, 35 / height];
    const second = [20 / width, 35 / height, 125 / width, 48 / height];
    const result = I.restoreImageLabel(pixels, width, height, second, [], "second line", [first]);
    assert(result && result.changed > 0);
    for (let y = 0; y < result.height; y++) for (let x = 0; x < result.width; x++) {
      const gx = result.box[0] + x, gy = result.box[1] + y, source = (gy * width + gx) * 4, at = (y * result.width + x) * 4;
      if (gy < 35) assert.deepEqual([...result.pixels.slice(at, at + 4)], [...pixels.slice(source, source + 4)], "相邻文字行不得被擦除");
      if (gy >= 36 && gy < 46 && pixels[source] === 25) assert(result.pixels[at] >= 245, "白底不应被相邻文字染灰");
    }
  }

  async function packedMinerUBatchingCacheUpgradeAndFailure() {
    const { storage, documentID, service } = fixture();
    const layout = await service.loadLayout(documentID), oldPDF = context.PDFLib, oldWindow = context.Zotero.getMainWindow;
    let requests = 0, pagesAdded = 0;
    const original = { text: "Old label", bbox: [.1, .1, .4, .2], score: 1 };
    context.Zotero.getMainWindow = () => ({ Image: function () {} });
    context.PDFLib = { ...require('pdf-lib'), PDFDocument: { create: async () => ({ embedJpg: async () => assert.fail("不能上传完整原图"), embedPng: async () => ({}),
      addPage: () => { pagesAdded++;return { drawImage() {}, pushOperators() {} }; }, save: async () => new Uint8Array([1]) }) } };
    storage.readBytes = async () => new Uint8Array([255, 216, 255]);
    const paddle = { secrets: { getPaddleToken: () => "" }, submit: async () => assert.fail("不能调用 Paddle") };
    const mineru = { secrets: { getMinerUToken: () => "fixture" } };
    const ocr = new context.LitMTrans.ImageTranslationService(storage, paddle, mineru);
    ocr.packImageText = async () => ({ bytes: new Uint8Array([1]), size: [100, 100], sourceSize: [100, 100],
      mapping: [{ source: [50, 50, 90, 70], packed: [10, 10, 50, 30] }] });
    ocr.recognizeMinerU = async (_bytes, count) => {
      requests++;assert.equal(count, 4);
      return Array.from({ length: count }, (_, index) => index < 2 ? [{ text: "New label", bbox: [24 / 200, 24 / 68, 64 / 200, 44 / 68], score: 1 }] : []);
    };
    const cached = { version: 1, model: "mineru-pipeline", sourceFingerprint: U.hashString(layout.rawText), parseRevisionID: "",
      images: [{ ...I.extract(layout)[0], lines: [original] }] };
    const cachePath = storage.path(documentID, "image-ocr.v1.json");
    const oldMineruLocal = I.mineruUseLocalOCR;
    I.mineruUseLocalOCR = false;
    try {
      await storage.writeJSON(cachePath, cached);
      const before = await storage.readText(storage.path(documentID, "layout.json"));
      const result = await ocr.ensure(documentID, layout);
      assert.equal(result.strategy, "shared-gray-crops-v3");assert.equal(result.images[0].lines.length, 2);
      assert.equal(result.images[0].lines[0].text, "Old label");
      assert.equal(requests, 1);assert.equal(pagesAdded, 4, "不同文字裁片共用一次任务，保留原有页面布局");
      await ocr.ensure(documentID, layout);assert.equal(requests, 1);
      await storage.writeJSON(cachePath, { ...cached, strategy: "text-crops-v1" });
      await ocr.ensure(documentID, layout);assert.equal(requests, 1, "旧裁片识别缓存不因拼页方式改变而重新请求");
      await storage.writeJSON(cachePath, { ...cached, strategy: "shared-text-crops-v2", images: [{ ...cached.images[0], lines: [] }] });
      ocr.recognizeMinerU = async (_bytes, count) => { requests++;return Array.from({ length: count }, () => []); };
      const retried = await ocr.ensure(documentID, layout);
      assert.equal(retried.strategy, "shared-gray-crops-v3");
      assert.equal(retried.images[0].lines.length, 0);
      assert.equal(requests, 3, "旧掩膜空结果使用合并的常规任务和一次补识别");
      await ocr.ensure(documentID, layout);assert.equal(requests, 3, "新版空结果也不能反复消耗 OCR 额度");
      assert.equal(await storage.readText(storage.path(documentID, "layout.json")), before);
      await storage.writeJSON(cachePath, cached);
      ocr.recognizeMinerU = async () => { throw new Error("service unavailable"); };
      assert.equal((await ocr.ensure(documentID, layout)).images[0].lines[0].text, "Old label");
      assert.equal((await storage.readJSON(cachePath)).strategy, undefined, "失败不能改写旧缓存");
    } finally { I.mineruUseLocalOCR = oldMineruLocal;context.PDFLib = oldPDF;context.Zotero.getMainWindow = oldWindow; }
  }

  function imageLabelsFitActualFontAndRejectMixedBackground() {
    const { document, Event } = require("linkedom").parseHTML('<html><body><div class="layout-page"><div class="layout-block" data-image-source-width="100"><div class="layout-image-translation"><img src="fixture.png"><span class="layout-image-label" hidden data-box="[0.1,0.2,0.5,0.4]">译</span></div></div></div></body></html>');
    const page = document.querySelector(".layout-page"), block = document.querySelector(".layout-block"), host = document.querySelector(".layout-image-translation"), image = host.querySelector("img"), label = host.querySelector("span");
    for (const node of [block, host]) Object.defineProperties(node, { clientWidth: { value: 100 }, clientHeight: { value: 100 } });
    let loaded = true;
    Object.defineProperties(image, { complete: { get: () => loaded }, naturalWidth: { get: () => loaded ? 100 : 0 }, naturalHeight: { get: () => loaded ? 100 : 0 } });
    Object.defineProperties(label, {
      clientWidth: { get: () => Math.round(parseFloat(label.style.width)) }, clientHeight: { get: () => Math.round(parseFloat(label.style.height)) },
      scrollWidth: { get: () => Math.max(label.clientWidth, Math.ceil(parseFloat(label.style.fontSize))) },
      scrollHeight: { get: () => Math.max(label.clientHeight, Math.ceil(parseFloat(label.style.fontSize) * 1.6)) }
    });
    let mixed = false, fractional = false;
    const create = document.createElement.bind(document);
    document.createElement = name => {
      if (name !== "canvas") return create(name);
      const canvas = { width: 100, height: 100, toDataURL: () => "data:image/png;base64,fixture" };
      canvas.getContext = () => ({ drawImage() {}, createImageData: () => ({ data: new Uint8ClampedArray(40000) }), putImageData() {}, getImageData() {
        const data = new Uint8ClampedArray(100 * 100 * 4);
        for (let i = 0; i < data.length; i += 4) data.set(mixed && Math.floor(i / 4) % 2 ? [0, 0, 0, 255] : [219, 234, 255, 255], i);
        return { data };
      }, measureText: () => ({ width: 10 }) });
      return canvas;
    };
    const ts = require("typescript"), code = fs.readFileSync(path.join(root, "src/workbench.js"), "utf8");
    const ast = ts.createSourceFile("workbench.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), functions = [];
    function visit(node) { if (ts.isFunctionDeclaration(node) && ["medianByte", "fitLayoutImageLabels"].includes(node.name?.text)) functions.push(node.getText(ast));ts.forEachChild(node, visit); }
    visit(ast);
    const state = { settings: { translateImages: true } };
    const fit = vm.runInNewContext(functions.join("\n") + "\nfitLayoutImageLabels", { document, getComputedStyle: node => ({ fontFamily: "serif", ...(node === host && fractional ? { width: "100.4px", height: "99.9px" } : {}) }),
      state,
      window: { LitMTrans: { LayoutImages: { restoreImageLabel: () => mixed ? null : { pixels: [], width: 40, height: 20, box: [10, 20, 50, 40], color: [20, 20, 20] } } } } });
    fit([page]);assert.equal(label.hidden, false);
    assert.equal(image.style.visibility, "hidden", "文字修复后应显示原图尺寸合成的底图");
    assert.equal(host._litmtransCleanedImage.hidden, false);
    assert(parseFloat(label.style.fontSize) < 19, "actual CJK font overflow must shrink the label before falling back");
    assert(label.scrollHeight <= label.clientHeight + 1);
    fractional = true;fit([page]);
    assert(Math.abs(parseFloat(label.style.left) - 10.24) < .001, "使用实际小数尺寸，避免擦除层偏移后露出英文细边");
    mixed = true;delete host._litmtransImageLabelFit;fit([page]);
    assert.equal(label.hidden, false, "背景无法修复时仍应显示译文");
    assert.equal(label.style.backgroundColor, "white", "使用局部底色覆盖原文字");
    assert.equal(image.style.visibility, "hidden");
    assert.equal(host._litmtransCleanedImage.hidden, false);
    mixed = false;loaded = false;fit([page]);
    state.settings.translateImages = false;fit([page]);
    assert.equal(image.style.visibility, "", "关闭图片翻译时显示原图");
    assert.equal(host._litmtransCleanedImage.hidden, true);
    loaded = true;image.dispatchEvent(new Event("load"));
    assert.equal(label.hidden, true, "关闭图片翻译后，已注册的加载回调不能重新显示译文");
    state.settings.translateImages = true;fit([page]);
    assert.equal(label.hidden, false, "重新开启后应正常显示已有译文");
  }

  function translatedImagePreviewPreservesLabelLayout() {
    const { document } = require("linkedom").parseHTML('<html><body><div><span data-rotation="-90" style="left:20px;top:40px;width:80px;height:10px;font-size:8px;color:#111">纵轴译文</span></div></body></html>');
    const host = document.querySelector("div"), label = host.querySelector("span");
    Object.defineProperties(host, { clientWidth: { value: 200 }, clientHeight: { value: 150 } });
    label.className = "layout-image-label";
    host._litmtransCleanedImage = { complete: true, naturalWidth: 400, naturalHeight: 200 };
    const calls = [], ctx = {
      drawImage() {}, save() {}, restore() {}, beginPath() {}, clip() {},
      translate: (...args) => calls.push(["translate", ...args]), rotate: angle => calls.push(["rotate", angle]),
      rect: (...args) => calls.push(["rect", ...args]),
      fillRect(...args) { calls.push(["background", this.fillStyle, ...args]); },
      fillText(...args) { calls.push(["text", this.textAlign, this.font, ...args]); }
    };
    document.createElement = () => ({ getContext: () => ctx, toDataURL: () => "data:image/png;base64,translated" });
    const ts = require("typescript"), code = fs.readFileSync(path.join(root, "src/workbench.js"), "utf8");
    const ast = ts.createSourceFile("workbench.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    let fn;
    function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === "translatedImagePreviewDataURL") fn = node.getText(ast);ts.forEachChild(node, visit); }
    visit(ast);
    let align = "center", overflow = "hidden";
    const preview = vm.runInNewContext(fn + "\ntranslatedImagePreviewDataURL", { document,
      getComputedStyle: node => node === host ? {} : { fontWeight: "normal", fontFamily: "serif", backgroundColor: "white", justifyContent: align, overflow } });
    assert.equal(preview(host), "data:image/png;base64,translated");
    assert.deepEqual(calls, [
      ["translate", 120, 40], ["rotate", -Math.PI / 2], ["rect", -80, -10, 160, 20],
      ["background", "white", -80, -10, 160, 20], ["text", "center", "normal 16px serif", "纵轴译文", 0, 0]
    ], "弹窗需保留纵轴旋转、留白偏移、字号与遮盖底色");
    label.dataset.rotation = "0";
    for (const [value, textAlign, x] of [["flex-start", "left", -80], ["flex-end", "right", 80]]) {
      calls.length = 0;align = value;overflow = "visible";preview(host);
      assert(!calls.some(call => call[0] === "rotate" || call[0] === "rect"));
      assert.deepEqual(calls.at(-1), ["text", textAlign, "normal 16px serif", "纵轴译文", x, 0], "保留阅读器的左右对齐，不额外压缩文字");
    }
  }

  function translatedImageHostOpensOriginalPreview() {
    const { document, Event } = require("linkedom").parseHTML('<html><body><div id="translation-pane"><div class="layout-block layout-image" data-block-id="image-1"><div class="layout-image-translation"><img src="original.png"><span class="layout-image-label">译文</span><img class="layout-image-cleaned" src="data:image/png;base64,cleaned"></div></div></div></body></html>');
    const host = document.querySelector(".layout-image-translation"), pane = document.getElementById("translation-pane");
    let preview;
    const ts = require("typescript"), code = fs.readFileSync(path.join(root, "src/workbench.js"), "utf8");
    const ast = ts.createSourceFile("workbench.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    let fn;
    function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === "bindLayoutInteractions") fn = node.getText(ast);ts.forEachChild(node, visit); }
    visit(ast);
    const viewState = { settings: { translateImages: true } };
    const bind = vm.runInNewContext(fn + "\nbindLayoutInteractions", { document, state: viewState,
      readerPaneForTarget: () => pane, layoutFormulaTarget: () => null, inferImageMimeType: () => "image/png",
      readerImageQuote: () => null, translatedImagePreviewDataURL: () => "data:image/png;base64,translated", openImagePreview: value => { preview = value; } });
    bind();
    const event = new Event("click", { bubbles: true });event.button = 0;host.dispatchEvent(event);
    assert.equal(preview.url, "original.png", "点击译图外层应打开原图而不是内部修复副本");
    assert.equal(preview.displayURL, "data:image/png;base64,translated", "预览应优先显示译图，同时保留原图引用");
    assert.equal(preview.name, "image-1.png");
    viewState.settings.translateImages = false;
    host.dispatchEvent(Object.assign(new Event("click", { bubbles: true }), { button: 0 }));
    assert.equal(preview.displayURL, "", "未勾选翻译图片时点击预览不应覆盖显示译图");
  }

  async function translatedPreviewKeepsOriginalForChat() {
    const ts = require("typescript"), code = fs.readFileSync(path.join(root, "src/workbench.js"), "utf8");
    const ast = ts.createSourceFile("workbench.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), functions = [];
    function visit(node) { if (ts.isFunctionDeclaration(node) && ["openImagePreview", "reusePreviewImage"].includes(node.name?.text)) functions.push(node.getText(ast));ts.forEachChild(node, visit); }
    visit(ast);
    const state = {}, els = {
      "image-preview-original": { hidden: false }, "image-preview-image": {},
      "image-preview-compare": { setAttribute() {} }, "image-preview-dialog": { showModal() {}, close() {} }
    };
    let added;
    const api = vm.runInNewContext(functions.join("\n") + "\n({openImagePreview,reusePreviewImage})", {
      state, els, normalizeReferenceQuote: value => value, setPreviewTableMode() {}, syncDeepSeekWebBounds() {},
      addImageDescriptorToComposer: async image => { added = image; }, toast() {}
    });
    api.openImagePreview({ url: "original.png", displayURL: "data:image/png;base64,translated", name: "figure.png" });
    assert.equal(els["image-preview-image"].src, "data:image/png;base64,translated");
    assert.equal(els["image-preview-original"].src, "original.png");
    assert.equal(els["image-preview-original"].hidden, true, "默认仅显示译图");
    await api.reusePreviewImage();
    assert.equal(added.url, "original.png", "添加到对话必须继续使用原图");
  }

  async function publicationRestoresOldFilesOnDiskFailure() {
    const paths = { root: "/document/layout", translations: "/document/body.json", formulaReplacements: "/document/formulas.json", tables: "/document/tables.json", images: "/document/images.json", meta: "/document/meta.json" };
    const files = new Map(), old = new Map();
    for (const name of ["translations", "formulaReplacements", "tables", "images", "meta"]) {
      const bytes = Buffer.from(JSON.stringify({ version: "old", name }));files.set(paths[name], bytes);old.set(paths[name], bytes);
    }
    let failure = "write";
    const originalIO = context.IOUtils;
    const storage = {
      temporaryDir: () => "/stage", ensureDir: async () => {}, exists: async file => files.has(file),
      readBytes: async file => files.get(file), writeBytes: async (file, bytes) => { files.set(file, Buffer.from(bytes)); },
      writeJSON: async (file, value) => { if (failure === "write" && file.endsWith("media-1.json")) throw new Error("disk write failed");files.set(file, Buffer.from(JSON.stringify(value))); },
      remove: async (file, recursive) => { for (const key of [...files.keys()]) if (key === file || (recursive && key.startsWith(file + "/"))) files.delete(key); },
      publishFilesAtomically: context.LitMTrans.Storage.prototype.publishFilesAtomically
    };
    context.IOUtils = { move: async (source, destination) => {
      if (failure === "move" && destination === paths.images) throw new Error("disk move failed");
      files.set(destination, files.get(source));files.delete(source);
    } };
    const media = [{ path: paths.tables, value: { version: "new-table" } }, { path: paths.images, value: { version: "new-image" } }];
    const publish = () => LayoutTranslationService.prototype.publishTranslationResult.call({ storage }, paths, { version: "new-body" }, {}, { version: "new-meta" }, media);
    try {
      for (const mode of ["write", "move"]) {
        failure = mode;await assert.rejects(publish(), /disk/);
        for (const [file, bytes] of old) assert.deepEqual(files.get(file), bytes, `${mode} failure must preserve ${file}`);
        assert(![...files.keys()].some(file => file.startsWith("/stage/")));
      }
      failure = null;await publish();
      assert.equal(JSON.parse(files.get(paths.translations)).version, "new-body");
      assert.equal(JSON.parse(files.get(paths.tables)).version, "new-table");
      assert.equal(JSON.parse(files.get(paths.images)).version, "new-image");
      assert.equal(JSON.parse(files.get(paths.meta)).version, "new-meta");
    } finally { context.IOUtils = originalIO; }
  }

  async function translationChainsStageMediaWithoutExtraRequests() {
    context.DOMParser = DOMParser;
    try {
      for (const chain of ["api", "machine", "manual"]) {
        const { service, storage, documentID, settings, calls } = fixture();
        await service.translate(documentID);
        const paths = service.paths(documentID, settings.targetLanguage);
        const destinations = [paths.translations, paths.formulaReplacements, paths.tables, paths.images, paths.meta];
        const snapshot = async () => Promise.all(destinations.map(async file => JSON.stringify(await storage.readJSON(file))));
        const old = await snapshot(), publish = storage.publishFilesAtomically.bind(storage);
        let fail = true, attempts = 0, omitImages = false, machineCalls = 0;
        storage.publishFilesAtomically = async entries => {
          attempts++;
          assert.deepEqual(await snapshot(), old, `${chain}: media must not change before publication`);
          assert.deepEqual(new Set(entries.map(entry => entry.destination)), new Set(destinations));
          if (fail) throw new Error("publication failed");
          return publish(entries);
        };
        const complete = service.llm.complete;
        service.llm.complete = async (...args) => {
          const response = await complete(...args), data = JSON.parse(response.text);
          if (omitImages) data.translations = data.translations.filter(row => !String(row.id).startsWith("I"));
          return { text: JSON.stringify(data).replaceAll("正文译文", "新版正文").replaceAll("原始输入", "新版输入").replaceAll("方法", "新版方法") };
        };
        service.webMachine = { translateRecords: async records => {
          machineCalls++;return Object.fromEntries(records.map(record => [record.id, record.type === "text" ? "新版正文。" : record.text.replace("Method", "新版方法").replace("RAW INPUT", "新版输入")]));
        } };
        const run = async () => {
          if (chain !== "manual") return service.translate(documentID, { force: true, ...(chain === "machine" ? { provider: "free_machine" } : {}) });
          const { records } = await service.manualTranslationInput(documentID);
          const values = Object.fromEntries(records.map(record => [record.id, record.cells
            ? JSON.stringify(record.cells.map(([index, text]) => [index, "新版" + text])) : "新版正文。"]));
          return service.importManualTranslation(documentID, values);
        };
        await assert.rejects(run(), /publication failed/);
        assert.deepEqual(await snapshot(), old);
        fail = false;await run();assert.equal(attempts, 2);
        assert((await storage.readJSON(paths.translations)).body.includes("新版"));
        assert.notEqual(JSON.stringify(await storage.readJSON(paths.images)), old[3]);
        assert.equal(chain === "manual" ? calls.length : chain === "machine" ? machineCalls : calls.length - 1, chain === "manual" ? 1 : 2,
          "saving must not add translation calls or retries");
        storage.publishFilesAtomically = publish;
        if (chain === "api") {
          const previousImage = JSON.stringify(await storage.readJSON(paths.images));omitImages = true;
          const result = await run();assert.equal(result.meta.complete, true);
          assert.equal(JSON.stringify(await storage.readJSON(paths.images)), previousImage, "a missing optional image answer must keep the prior image and still publish the body");
          assert.equal(calls.length, 4);
        }
      }
    } finally { delete context.DOMParser; }
  }

  function adjacentSubfigureEdgeOverlapCleansPartialResidueAndPreservesPriorLabel() {
    const width = 120, height = 80, pixels = new Uint8Array(width * height * 4).fill(255);
    for (let y = 0; y < 3; y++) for (let x = 44; x < 76; x += 4) pixels.set([20, 20, 20, 255], (y * width + x) * 4);
    for (let x = 10; x < 110; x++) pixels.set([20, 20, 20, 255], (18 * width + x) * 4);
    assert.equal(I.restoreImageLabel(pixels, width, height, [.3, 0, .7, .08], [], ""), null, "默认策略会忽略高度过小的残缺笔画");
    const partial = I.restoreImageLabel(pixels, width, height, [.3, 0, .7, .08], [], "", [], { allowPartialEdge: true });
    assert(partial && partial.changed > 0, "相邻子图边界模式应清理被裁断的半行英文残片");
    assert.equal(partial.pixels[((1 - partial.box[1]) * partial.width + (45 - partial.box[0])) * 4], 255);

    const { document } = require("linkedom").parseHTML(
      '<html><body><div class="layout-page">' +
      '<div class="layout-block" data-image-source-width="100" style="left:10%;top:10%;width:40%;height:20%"><div class="layout-image-translation"><img src="a.png"><span class="layout-image-label" hidden data-box="[0.35,0.92,0.65,1]">当地时间</span></div></div>' +
      '<div class="layout-block" data-image-source-width="100" style="left:10%;top:29.8%;width:40%;height:20%"><div class="layout-image-translation"><img src="b.png"><span class="layout-image-label" hidden data-box="[0.1,0.4,0.3,0.55]">曲线</span></div></div>' +
      '</div></body></html>'
    );
    const page = document.querySelector(".layout-page");
    const hosts = [...page.querySelectorAll(".layout-image-translation")];
    const blocks = [...page.querySelectorAll(".layout-block")];
    for (const node of [...blocks, ...hosts]) Object.defineProperties(node, { clientWidth: { value: 120 }, clientHeight: { value: 80 } });
    for (const img of page.querySelectorAll("img")) Object.defineProperties(img, { complete: { get: () => true }, naturalWidth: { get: () => 120 }, naturalHeight: { get: () => 80 } });
    for (const label of page.querySelectorAll(".layout-image-label")) {
      Object.defineProperties(label, {
        clientWidth: { get: () => Math.round(parseFloat(label.style.width)) }, clientHeight: { get: () => Math.round(parseFloat(label.style.height)) },
        scrollWidth: { get: () => Math.max(label.clientWidth, 10) }, scrollHeight: { get: () => Math.max(label.clientHeight, 10) }
      });
    }
    let writtenB = null;
    const create = document.createElement.bind(document);
    document.createElement = name => {
      if (name !== "canvas") return create(name);
      const canvas = { width: 120, height: 80, toDataURL: () => "data:image/png;base64,fixture" };
      canvas.getContext = () => ({
        drawImage() {},
        createImageData: () => ({ data: new Uint8ClampedArray(120 * 80 * 4) }),
        putImageData: img => { writtenB = img.data; },
        getImageData: () => ({ data: new Uint8ClampedArray(pixels) }),
        measureText: () => ({ width: 10 })
      });
      return canvas;
    };
    const ts = require("typescript"), code = fs.readFileSync(path.join(root, "src/workbench.js"), "utf8");
    const ast = ts.createSourceFile("workbench.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), functions = [];
    function visit(node) { if (ts.isFunctionDeclaration(node) && ["fitLayoutImageLabels"].includes(node.name?.text)) functions.push(node.getText(ast));ts.forEachChild(node, visit); }
    visit(ast);
    const fit = vm.runInNewContext(functions.join("\n") + "\nfitLayoutImageLabels", {
      document,
      getComputedStyle: () => ({ fontFamily: "serif", width: "120px", height: "80px" }),
      state: { settings: { translateImages: true } },
      window: { LitMTrans: { LayoutImages: I } }
    });
    fit([page]);
    assert(writtenB, "第二张子图应生成修复后的底图");
    assert.equal(writtenB[(0 * 120 + 60) * 4 + 3], 0, "后绘子图与前图边缘译文重叠区域应设为透明，避免遮挡中文译文");
    assert.equal(writtenB[(18 * 120 + 60) * 4 + 3], 255, "非重叠区域及坐标轴线应保持不透明");
    assert.equal(writtenB[(18 * 120 + 60) * 4], 20, "坐标轴线本身不能被擦除");
  }

  async function duplicateImageLabelsDeduplicateAndExpandAcrossChains() {
    context.DOMParser = DOMParser;
    try {
      const boxA = [20, 200, 280, 400], boxB = [300, 200, 580, 400], boxC = [20, 420, 280, 620];
      const raw = JSON.stringify({ pdf_info: [{ page_size: [600, 800], preproc_blocks: [
        { type: "text", bbox: [20, 20, 580, 60], lines: [{ spans: [{ content: "Source body" }] }] },
        { type: "image", bbox: boxA, blocks: [{ type: "image_body", bbox: boxA, image_path: "images/a.png", lines: [] }] },
        { type: "image", bbox: boxB, blocks: [{ type: "image_body", bbox: boxB, image_path: "images/b.png", lines: [] }] },
        { type: "image", bbox: boxC, blocks: [{ type: "image_body", bbox: boxC, image_path: "images/c.png", lines: [] }] }
      ] }] });
      const sourceFingerprint = U.hashString(raw);
      const figures = I.extract({ pages: JSON.parse(raw).pdf_info });
      const ocr = { version: 1, sourceFingerprint, images: [
        { ...figures[0], lines: [
          { text: "Local time (h)", bbox: [.1, .1, .4, .2], score: .99 },
          { text: "Amplitude (mV)", bbox: [.1, .3, .4, .4], score: .99 },
          { text: "Local time (h)", bbox: [.1, .5, .4, .6], score: .99 },
          { text: "Group 1", bbox: [.1, .7, .4, .8], score: .99 }
        ] },
        { ...figures[1], lines: [
          { text: "Local time (h)", bbox: [.1, .1, .4, .2], score: .99 },
          { text: "Group 2", bbox: [.1, .3, .4, .4], score: .99 },
          { text: "Phase (rad)", bbox: [.1, .5, .4, .6], score: .99 },
          { text: "local time (h)", bbox: [.1, .7, .4, .8], score: .99 }
        ] },
        { ...figures[2], lines: [
          { text: "Local time (h)", bbox: [.1, .1, .4, .2], score: .99 },
          { text: "Phase (rad)", bbox: [.1, .5, .4, .6], score: .99 }
        ] }
      ] };
      const layout = { pages: JSON.parse(raw).pdf_info, rawText: raw };
      const plan = I.requestPlan(ocr, layout);
      assert.equal(plan.images.length, 3, "全部图片仍保留用于译文回填与渲染");
      assert.deepEqual(plan.records.map(record => record.wireID), ["I1", "I2"], "完全重复的图片不再生成翻译记录，线缆编号保持连续");
      assert.deepEqual(plan.records[0].cells, [[0, "Local time (h)"], [1, "Amplitude (mV)"], [3, "Group ⟦0⟧"]]);
      assert.deepEqual(plan.records[1].cells, [[2, "Phase (rad)"], [3, "local time (h)"]]);

      // 局部失败重试与回填：先仅第 2 条记录成功，验证第 1 条不会被误判为已缓存，随后补齐全部 3 张图
      const [recA, recB] = plan.records;
      const partialCache = I.cacheFromRecords(plan, {
        [recB.id]: JSON.stringify([[2, "相位 (rad)"], [3, "当地时间小写"]])
      }, sourceFingerprint, "简体中文");
      const partialCached = I.cachedRecords(plan, partialCache, sourceFingerprint);
      assert.deepEqual(Object.keys(partialCached), [recB.id], "仅含部分重复项的首图不能被当作已完整缓存");
      assert.equal(partialCache.images.length, 2, "第三张图中命中的局部唯一标签也应先行回填");

      const fullCache = I.cacheFromRecords(plan, {
        ...partialCached,
        [recA.id]: JSON.stringify([[0, "当地时间 (h)"], [1, "振幅 (mV)"], [3, "第 ⟦0⟧ 组"]])
      }, sourceFingerprint, "简体中文");
      assert.equal(fullCache.images.length, 3);
      assert.equal(Object.keys(I.cachedRecords(plan, fullCache, sourceFingerprint)).length, 2);

      const baseModel = { sourceFingerprint, pages: [{ blocks: [
        { id: "figA", type: "image_body", kind: "image", bbox: boxA, imagePath: "images/a.png", imageURL: "a.png" },
        { id: "figB", type: "image_body", kind: "image", bbox: boxB, imagePath: "images/b.png", imageURL: "b.png" },
        { id: "figC", type: "image_body", kind: "image", bbox: boxC, imagePath: "images/c.png", imageURL: "c.png" }
      ] }] };
      const attached = I.attach(baseModel, fullCache);
      assert.deepEqual(attached.pages[0].blocks[0].translatedImageLabels.map(item => item.text), ["当地时间 (h)", "振幅 (mV)", "当地时间 (h)", "第 1 组"]);
      assert.deepEqual(attached.pages[0].blocks[1].translatedImageLabels.map(item => item.text), ["当地时间 (h)", "第 2 组", "相位 (rad)", "当地时间小写"]);
      assert.deepEqual(attached.pages[0].blocks[2].translatedImageLabels.map(item => item.text), ["当地时间 (h)", "相位 (rad)"]);

      // 端到端覆盖 api / machine / manual 三条链路
      const dict = text => text
        .replace("Local time (h)", "当地时间 (h)")
        .replace("local time (h)", "当地时间小写")
        .replace("Amplitude (mV)", "振幅 (mV)")
        .replace("Phase (rad)", "相位 (rad)")
        .replace("Group", "第");
      const setup = () => {
        const storage = new MemoryStorage(), documentID = "dedup-case", apiCalls = [], machineCalls = [];
        storage.writeTextAtomically = async (file, text) => storage.writeJSON(file, JSON.parse(text));
        storage.getDocumentMeta = async () => ({});
        storage.text.set(storage.path(documentID, "layout.json"), raw);
        storage.text.set(storage.path(documentID, "full.cleaned.md"), "Full document context.");
        const settings = { provider: "gemini", baseURL: "https://example.test", model: "fixture", targetLanguage: "简体中文", translateImages: true, deepseekFastLayoutTranslation: false, enableUntranslatedCheck: false };
        const llm = {
          getSettings: () => settings,
          resolveConfig: values => values,
          ensureConfiguredModel: async values => values,
          complete: async messages => {
            const blocks = JSON.parse(messages[1].content.split("Input blocks JSON:\n").at(-1)).blocks;
            apiCalls.push(blocks);
            return { text: JSON.stringify({ translations: blocks.map(block => block.cells
              ? { id: block.id, cells: block.cells.map(([index, text]) => [index, dict(text)]) }
              : { id: block.id, text: "正文译文。" }) }) };
          }
        };
        const service = new LayoutTranslationService(storage, llm);
        service.extractRecords = async () => [{ id: "body", page: 1, type: "text", text: "Source body" }];
        service.buildBaseModel = async () => JSON.parse(JSON.stringify(baseModel));
        service.imageService = { ensure: async () => JSON.parse(JSON.stringify(ocr)) };
        service.webMachine = { translateRecords: async records => {
          machineCalls.push(records);
          return Object.fromEntries(records.map(record => [record.id, record.type === "text" ? "正文译文。" : dict(record.text)]));
        } };
        return { storage, documentID, service, settings, apiCalls, machineCalls };
      };

      // 1. API 链路
      {
        const { service, apiCalls, documentID } = setup();
        const result = await service.translate(documentID);
        const sentImageRecords = apiCalls[0].filter(block => block.type === "image_labels");
        assert.equal(sentImageRecords.length, 2, "API 请求只应发送去重后的图片记录");
        assert.equal(sentImageRecords.reduce((sum, item) => sum + item.cells.length, 0), 5);
        assert.deepEqual(result.model.pages[0].blocks.map(block => block.translatedImageLabels.map(item => item.text)), [
          ["当地时间 (h)", "振幅 (mV)", "当地时间 (h)", "第 1"],
          ["当地时间 (h)", "第 2", "相位 (rad)", "当地时间小写"],
          ["当地时间 (h)", "相位 (rad)"]
        ]);
        await service.translate(documentID);
        assert.equal(apiCalls.length, 1, "再次运行应直接命中缓存");
      }

      // 2. 机器翻译（machine）链路与断点重译
      {
        const { service, storage, settings, machineCalls, documentID } = setup();
        const result = await service.translate(documentID, { provider: "free_machine" });
        const sentLabels = machineCalls[0].filter(record => record.type === "image_label");
        assert.equal(sentLabels.length, 5, "机器翻译链路同样只发送 5 条去重标签而非 10 条");
        assert.deepEqual(result.model.pages[0].blocks[2].translatedImageLabels.map(item => item.text), ["当地时间 (h)", "相位 (rad)"]);
        // 模拟部分老缓存/部分失败缓存：清空图片缓存后再做一次部分成功重译
        const imagePath = service.paths(documentID, settings.targetLanguage).images;
        const partial = await storage.readJSON(imagePath);
        partial.images = [partial.images[1]];
        await storage.writeJSON(imagePath, partial);
        await service.translateImagesOnly(documentID, { provider: "free_machine" });
        const retrySent = machineCalls[1].filter(record => record.type === "image_label");
        assert.deepEqual(retrySent.map(record => record.text), ["Amplitude (mV)"], "已缓存的图片同文译文可在补充重译时直接复用");
      }

      // 3. 手工翻译（manual）链路
      {
        const { service, documentID } = setup();
        const manual = await service.manualTranslationInput(documentID);
        const imageRecords = manual.records.filter(record => record.type === "image_labels");
        assert.deepEqual(imageRecords.map(record => record.wireID), ["I1", "I2"]);
        const payload = { request: manual.records.requestCode };
        const rows = [
          { id: "T0", text: "正文译文。" },
          { id: "I1", cells: [[1, "当地时间 (h)"], [2, "振幅 (mV)"], [3, "第 ⟦0⟧ 组"]] },
          { id: "I2", cells: [[1, "相位 (rad)"], [2, "当地时间小写"]] }
        ];
        // 使用实际 body 记录 id 发送手工响应
        const bodyRecord = manual.records.find(record => record.type === "text");
        rows[0].id = bodyRecord.wireID || bodyRecord.id;
        const rawManual = JSON.stringify(payload) + "\n" + rows.map(row => JSON.stringify(row)).join("\n");
        const imported = await service.importManualTranslation(documentID, rawManual);
        assert.deepEqual(imported.model.pages[0].blocks[1].translatedImageLabels.map(item => item.text), ["当地时间 (h)", "第 2 组", "相位 (rad)", "当地时间小写"]);
        assert.deepEqual(imported.model.pages[0].blocks[2].translatedImageLabels.map(item => item.text), ["当地时间 (h)", "相位 (rad)"]);
      }
    } finally { delete context.DOMParser; }
  }

  async function parserRoutingAndLocalOCRReadinessChecks() {
    assert.equal(I.resolveImageOCRMode("paddle"), "paddle-api");
    assert.equal(I.resolveImageOCRModel("paddle"), "PP-OCRv6");
    assert.equal(I.resolveImageOCRMode("mineru"), "local");
    assert.equal(I.resolveImageOCRModel("mineru"), "local-ppocr-v6-tiny");
    assert.equal(I.resolveImageOCRMode("mineru", { mineruUseLocal: false }), "mineru-api");
    assert.equal(I.resolveImageOCRModel("mineru", { mineruUseLocal: false }), "mineru-pipeline");

    // 验证偏好设置与设置页面移除图片OCR选项、默认关闭翻译图片
    const prefsText = fs.readFileSync(path.join(root, "src/prefs.js"), "utf8");
    assert(prefsText.includes('pref("extensions.litmtrans.translateImages", false)'));
    assert(!prefsText.includes("imageOCRProvider"));
    assert(!fs.readFileSync(path.join(root, "src/preferences.xhtml"), "utf8").includes("litmtrans-pref-image-ocr-provider"));
    assert(!fs.readFileSync(path.join(root, "src/workbench.xhtml"), "utf8").includes("setting-image-ocr-provider"));
    const llmSettings = new context.LitMTrans.LLMService({ getLLMKey: () => "", llmKeyName: () => "llm", has: () => false }).getSettings();
    assert.equal(llmSettings.translateImages, false);

    // 验证 Storage 本地 OCR 模型存在性与完整性校验
    const tempDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "litmtrans-local-ocr-"));
    try {
      const storage = new context.LitMTrans.Storage();
      storage.root = tempDir;
      storage.stat = async filePath => {
        try {
          const stat = fs.statSync(filePath);
          return { size: stat.size, type: stat.isDirectory() ? "directory" : "regular" };
        } catch (_) { return null; }
      };
      const initialStatus = await storage.getLocalOCRStatus();
      assert.equal(initialStatus.ready, false);
      assert.equal(initialStatus.missingFiles.length, 4);
      fs.mkdirSync(initialStatus.root, { recursive: true });
      const config = storage.getLocalOCRConfig();
      for (const [name, entry] of Object.entries(config.assets)) {
        fs.writeFileSync(path.join(config.root, name), Buffer.alloc(entry.size));
      }
      assert.equal(await storage.hasLocalOCRModels(), true);
      fs.writeFileSync(path.join(config.root, "PP-OCRv6_tiny_det_onnx_infer.tar"), Buffer.alloc(10));
      assert.equal(await storage.hasLocalOCRModels(), false, "损坏或尺寸不符的本地模型必须重新提示");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    // 验证切换到 MinerU 后发起请求前的模型检查、取消与切回 Paddle 分支
    const { storage, documentID, service } = fixture();
    const layout = await service.loadLayout(documentID);
    const oldPDF = context.PDFLib, oldRequest = context.LitMTrans.HTTP.requestBytes;
    context.PDFLib = { degrees: value => ({ angle: value }), PDFDocument: { create: async () => ({
      embedJpg: async () => ({ width: 100, height: 100 }),
      embedPng: async () => ({ width: 100, height: 100 }),
      addPage: () => ({ drawImage() {} }), save: async () => new Uint8Array([1])
    }) } };
    context.LitMTrans.HTTP.requestBytes = async () => new TextEncoder().encode(JSON.stringify({ result: {
      ocrResults: [{ prunedResult: { rec_texts: ["Switched"], rec_scores: [1], rec_polys: [[[42, 42], [92, 42], [92, 62], [42, 62]]] } }],
      dataInfo: { pages: [{ width: 164, height: 164 }] }
    } }));
    try {
      storage.hasLocalOCRModels = async () => false;
      storage.readBytes = async () => new Uint8Array([255, 216, 255]);
      let localCalls = 0, switched = 0, paddleCalls = 0;
      let decision = "cancel";
      const paddle = {
        secrets: { getPaddleToken: () => "paddle-tok" },
        submit: async () => { paddleCalls++; return {}; },
        poll: async () => "https://example.test/ocr"
      };
      const ocr = new context.LitMTrans.ImageTranslationService(storage, paddle, null, {
        localOCRConsent: async () => decision,
        switchToPaddle: async () => { switched++; }
      });
      ocr.collectLocalFigures = async (_id, figures) => { localCalls++; return figures.map(figure => ({ ...figure, lines })); };
      const cancelled = await ocr.ensure(documentID, layout, null, null, { parseProvider: "mineru" });
      assert.equal(cancelled.images.length, 0);
      assert.equal(localCalls, 0, "未安装本地模型且用户取消时不能调用本地识别");

      decision = "paddle";
      const switchedResult = await ocr.ensure(documentID, layout, null, null, { parseProvider: "mineru" });
      assert.equal(switched, 1);
      assert.equal(paddleCalls, 1);
      assert.equal(switchedResult.model, "PP-OCRv6", "选择切换为 Paddle 时本次识别直接走 Paddle API");

      storage.hasLocalOCRModels = async () => true;
      storage.json.delete(storage.path(documentID, "image-ocr.v1.json"));
      decision = () => assert.fail("已有本地模型时不应用询问弹窗打扰用户");
      const readyResult = await ocr.ensure(documentID, layout, null, null, { parseProvider: "mineru" });
      assert.equal(localCalls, 1);
      assert.equal(readyResult.model, "local-ppocr-v6-tiny");
    } finally {
      context.PDFLib = oldPDF;
      context.LitMTrans.HTTP.requestBytes = oldRequest;
    }

    // 验证 localOCR 更新清单校验会拒绝非 HTTPS 或被禁公共 CDN
    const published = JSON.parse(fs.readFileSync(path.join(root, "docs/parser-models.json"), "utf8"));
    assert(context.LitMTrans.Updater.normalizeParserModels(published)?.localOCR);
    const badManifest = JSON.parse(JSON.stringify(published));
    badManifest.localOCR.files["ort-wasm-simd-threaded.jsep.mjs"].urls = ["https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/x.mjs"];
    assert.equal(context.LitMTrans.Updater.normalizeParserModels(badManifest)?.localOCR, undefined);
  }

  return { OCRCoordinatesAndUncertainInput, pageFurnitureSkipsOCRTranslationAndCachedOverlay, sharedBatchCacheAndImageOnlyCompletion, missingImageResponseRetainsBodyAndPriorImageCache,
    paddleImagesShareOneMultipageRequest, paddleRequestSplitsOnlyAtDocumentLimits,
    taskLanguageKeepsMediaCacheAligned,
    imagePreferenceSkipsOCRAndSupplementsOnlyImages,
    imageOCRUsesTheSelectedParserWithoutCrossServiceFallback,
    switchingOCRServiceSupplementsOnlyEmptyImages,
    packedMinerUCoordinatesAndOverlapProtection, verticalLabelsAvoidAdjacentTicks, repeatedFigureLabelsCorrectOCRSpelling, neutralCandidatesSeparateTextFromColoredLines, partialMachineImageTranslationsRemainVisible, imageTextCandidatesExcludeLargeGraphics, imageOCRPackingPreservesOriginalStrokes, packedMinerUBatchingCacheUpgradeAndFailure,
    sharedSheetsKeepImageOwnershipAndBudget, mineruPreservesSuccessfulBatches, strokeRestorationPreservesLinesColorsAndProtectedValues, restorationDoesNotEraseOutsideOCRBox, restorationKeepsColoredLegendInsideTextBox, rotatedWordsJoinWithoutSwallowingUnits, rotatedDetectionSkipsOnlyAlreadyRecognizedText, coloredCurveFilteringPreservesOrdinaryLabels, localOCRKeepsNewRotatedTextAndRestoresDetector, localOCRPreservesLabelsAndReusesCache, restorationCleansTextOnPaleBackground,
    twoDimensionalRepairPreservesLocalBackground, twoDimensionalRepairDoesNotSpreadNeighboringInk, adjacentImageLabelsKeepWhiteBackground,
    paddleWholeImagesSharePagesWithoutShrinking,
    shortIDsDenseIndicesAndManualTaskBinding, OCRSniffsImageContentAndReusesSidecar, mineruOnlyOCRAndTemporaryCleanup, imageLabelsFitActualFontAndRejectMixedBackground, translatedImagePreviewPreservesLabelLayout, translatedImageHostOpensOriginalPreview, translatedPreviewKeepsOriginalForChat,
    publicationRestoresOldFilesOnDiskFailure, translationChainsStageMediaWithoutExtraRequests, adjacentSubfigureEdgeOverlapCleansPartialResidueAndPreservesPriorLabel,
    duplicateImageLabelsDeduplicateAndExpandAcrossChains,
    parserRoutingAndLocalOCRReadinessChecks };
};
