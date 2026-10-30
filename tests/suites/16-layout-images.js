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
    const settings = { provider: "gemini", baseURL: "https://example.test", model: "fixture", targetLanguage: "简体中文", deepseekFastLayoutTranslation: false, enableUntranslatedCheck: false };
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
    context.PDFLib = { PDFDocument: { create: async () => ({
      embedPng: async () => assert.fail("JPEG data with a .png suffix must not be decoded as PNG"),
      embedJpg: async () => { jpeg++;return { width: 100, height: 100 }; }, addPage: () => ({ drawImage() {} }), save: async () => new Uint8Array([1])
    }) } };
    context.LitMTrans.HTTP.requestBytes = async () => new TextEncoder().encode(JSON.stringify({ result: {
      ocrResults: [{ prunedResult: { rec_texts: ["RAW INPUT"], rec_scores: [.99], rec_polys: [[[42, 42], [92, 42], [92, 62], [42, 62]]] } }], dataInfo: { pages: [{ width: 164, height: 164 }] }
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
    context.PDFLib = { PDFDocument: { create: async () => ({
      embedJpg: async () => ({ width: 1000, height: 1000 }), addPage: () => { pages++;return { drawImage() {} }; },
      save: async () => new Uint8Array([1])
    }) } };
    context.LitMTrans.HTTP.requestBytes = async () => new TextEncoder().encode(JSON.stringify({ result: {
      ocrResults: Array.from({ length: 62 }, (_, i) => ({ prunedResult: { rec_texts: [`Label ${i}`], rec_scores: [1],
        rec_polys: [[[42, 42], [142, 42], [142, 62], [42, 62]]] } })),
      dataInfo: { pages: Array.from({ length: 62 }, () => ({ width: 1064, height: 1064 })) }
    } }));
    const paddle = { secrets: { getPaddleToken: () => "fixture" }, submit: async () => { requests++;return {}; }, poll: async () => "https://example.test/result" };
    try {
      const ocr = new context.LitMTrans.ImageTranslationService(storage, paddle);
      const result = await ocr.ensure(documentID, await service.loadLayout(documentID));
      assert.equal(requests, 1, "超过20张图片的多页PDF仍只提交一次");
      assert.equal(pages, 62);
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
    context.PDFLib = { PDFDocument: { create: async () => ({ embedJpg: async () => ({ width: 100, height: 100 }),
      addPage: () => ({ drawImage() {} }), save: async () => new Uint8Array([1]) }) } };
    context.LitMTrans.HTTP.requestBytes = async () => new TextEncoder().encode(JSON.stringify({ result: {
      ocrResults: [{ prunedResult: { rec_texts: ["Label"], rec_scores: [1], rec_polys: [[[42, 42], [92, 42], [92, 62], [42, 62]]] } }], dataInfo: { pages: [{ width: 164, height: 164 }] }
    } }));
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
    } finally { context.PDFLib = oldPDF;context.LitMTrans.HTTP.requestBytes = request; }
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
    context.PDFLib = { PDFDocument: { create: async () => ({ embedJpg: async () => { embedded++;return { width: 100, height: 100 }; },
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
    ocr.recognizeSharedImageText = async () => [await ocr.recognizeMinerU(new Uint8Array([1]), 1, "fixture").then(rows => rows[0])];
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
    } finally { context.PDFLib = oldPDF; }
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
    ocr.recognizeMinerU = async (_bytes, count) => { requests++;assert.equal(count, 1);return [[{ text: "New label", bbox: [24 / 200, 24 / 68, 64 / 200, 44 / 68], score: 1 }]]; };
    const cached = { version: 1, model: "mineru-pipeline", sourceFingerprint: U.hashString(layout.rawText), parseRevisionID: "",
      images: [{ ...I.extract(layout)[0], lines: [original] }] };
    const cachePath = storage.path(documentID, "image-ocr.v1.json");
    try {
      await storage.writeJSON(cachePath, cached);
      const before = await storage.readText(storage.path(documentID, "layout.json"));
      const result = await ocr.ensure(documentID, layout);
      assert.equal(result.strategy, "shared-gray-crops-v3");assert.equal(result.images[0].lines.length, 2);
      assert.equal(result.images[0].lines[0].text, "Old label");
      assert.equal(requests, 1);assert.equal(pagesAdded, 1, "临时 PDF 只放文字裁片");
      await ocr.ensure(documentID, layout);assert.equal(requests, 1);
      await storage.writeJSON(cachePath, { ...cached, strategy: "text-crops-v1" });
      await ocr.ensure(documentID, layout);assert.equal(requests, 1, "旧裁片识别缓存不因拼页方式改变而重新请求");
      await storage.writeJSON(cachePath, { ...cached, strategy: "shared-text-crops-v2", images: [{ ...cached.images[0], lines: [] }] });
      ocr.recognizeMinerU = async () => { requests++;return [[]]; };
      const retried = await ocr.ensure(documentID, layout);
      assert.equal(retried.strategy, "shared-gray-crops-v3");
      assert.equal(retried.images[0].lines.length, 0);
      assert.equal(requests, 2, "旧掩膜结果中无文字的图片可补识别一次");
      await ocr.ensure(documentID, layout);assert.equal(requests, 2, "新版空结果也不能反复消耗 OCR 额度");
      assert.equal(await storage.readText(storage.path(documentID, "layout.json")), before);
      await storage.writeJSON(cachePath, cached);
      ocr.recognizeMinerU = async () => { throw new Error("service unavailable"); };
      assert.equal((await ocr.ensure(documentID, layout)).images[0].lines[0].text, "Old label");
      assert.equal((await storage.readJSON(cachePath)).strategy, undefined, "失败不能改写旧缓存");
    } finally { context.PDFLib = oldPDF;context.Zotero.getMainWindow = oldWindow; }
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
    assert(parseFloat(label.style.fontSize) < 19, "actual CJK font overflow must shrink the label before falling back");
    assert(label.scrollHeight <= label.clientHeight + 1);
    fractional = true;fit([page]);
    assert(Math.abs(parseFloat(label.style.left) - 10.24) < .001, "使用实际小数尺寸，避免擦除层偏移后露出英文细边");
    mixed = true;delete host._litmtransImageLabelFit;fit([page]);
    assert.equal(label.hidden, true, "uncertain image backgrounds must keep the original text pixels");
    mixed = false;loaded = false;fit([page]);
    state.settings.translateImages = false;fit([page]);
    loaded = true;image.dispatchEvent(new Event("load"));
    assert.equal(label.hidden, true, "关闭图片翻译后，已注册的加载回调不能重新显示译文");
    state.settings.translateImages = true;fit([page]);
    assert.equal(label.hidden, false, "重新开启后应正常显示已有译文");
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

  return { OCRCoordinatesAndUncertainInput, pageFurnitureSkipsOCRTranslationAndCachedOverlay, sharedBatchCacheAndImageOnlyCompletion, missingImageResponseRetainsBodyAndPriorImageCache,
    paddleImagesShareOneMultipageRequest, paddleRequestSplitsOnlyAtDocumentLimits,
    taskLanguageKeepsMediaCacheAligned,
    imagePreferenceSkipsOCRAndSupplementsOnlyImages,
    imageOCRUsesTheSelectedParserWithoutCrossServiceFallback,
    switchingOCRServiceSupplementsOnlyEmptyImages,
    packedMinerUCoordinatesAndOverlapProtection, imageTextCandidatesExcludeLargeGraphics, imageOCRPackingPreservesOriginalStrokes, packedMinerUBatchingCacheUpgradeAndFailure,
    sharedSheetsKeepImageOwnershipAndBudget, strokeRestorationPreservesLinesColorsAndProtectedValues,
    twoDimensionalRepairPreservesLocalBackground, twoDimensionalRepairDoesNotSpreadNeighboringInk,
    paddleWholeImagesSharePagesWithoutShrinking,
    shortIDsDenseIndicesAndManualTaskBinding, OCRSniffsImageContentAndReusesSidecar, mineruOnlyOCRAndTemporaryCleanup, imageLabelsFitActualFontAndRejectMixedBackground,
    publicationRestoresOldFilesOnDiskFailure, translationChainsStageMediaWithoutExtraRequests };
};
