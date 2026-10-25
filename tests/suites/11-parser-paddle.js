"use strict";

module.exports = function createSuite(env) {
  const { assert, fs, path, root, context, MemoryStorage, ParserModel, PaddleAdapter,
    PaddleService, PaddleInternals, DocumentParserService, LayoutTranslationService, H, U } = env;
  const fixture = () => JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/paddle/vl-page.json"), "utf8"));
  const sizes = [{ width: 595.44, height: 793.92 }];
  const clone = value => JSON.parse(JSON.stringify(value));

  class ParserStorage extends MemoryStorage {
    constructor() { super(); this.serial = 0; this.publications = 0; }
    beginActivity() { return env.Storage.prototype.beginActivity.call(this); }
    documentID(item) { return typeof item === "string" ? item : `${item.libraryID}-${item.key}`; }
    documentDir(item) { return this.path(this.documentID(item)); }
    temporaryDir(label) { return this.path("temporary", `${label}-${++this.serial}`); }
    async getDocumentMeta(id) { return this.readJSON(this.path(id, "document.json"), null); }
    async setDocumentMeta(id, patch) { await this.writeJSON(this.path(id, "document.json"), { ...await this.getDocumentMeta(id), ...patch }); }
    async ensureDocument(item) { return { id: this.documentID(item), dir: this.documentDir(item) }; }
    async sourceIdentity() { return "source-v1"; }
    async writeJSON(file, value) { await super.writeJSON(file, value); await super.writeText(file, JSON.stringify(value)); }
    async publishEntriesAtomically(entries) {
      this.publications++;
      for (const row of entries) {
        const exists = await this.exists(row.source);
        await this.remove(row.destination, true);
        if (exists) { await this.copyTree(row.source, row.destination); await this.copyFile(row.source, row.destination); await this.remove(row.source, true); }
      }
    }
  }

  async function seed(storage) {
    await storage.writeText(storage.path("1-TEST", "full.cleaned.md"), "Old readable document");
    await storage.writeJSON(storage.path("1-TEST", "document.json"), { sourceIdentity: "source-v1", parseProvider: "mineru" });
    await storage.writeJSON(storage.path("1-TEST", "layout.json"), { pdf_info: [] });
    await storage.writeText(storage.path("1-TEST", "translation", "translation.zh.md"), "旧译文");
    await storage.writeJSON(storage.path("1-TEST", "layout-translation", "translations.zh.json"), { old: "旧排版译文" });
    await storage.writeBytes(storage.path("1-TEST", "images", "old.png"), new Uint8Array([1, 2, 3]));
  }

  async function testPaddleStructureAndSemanticBoundaries() {
    const pages = PaddleAdapter.decodeResults(JSON.stringify(fixture()));
    const document = PaddleAdapter.normalize(pages, sizes);
    const blocks = document.pages[0].blocks;
    assert.equal(blocks.filter(b => b.role === "formula").length, 6);
    assert.equal(blocks.filter(b => b.role === "formula_number").length, 6);
    assert.equal(blocks.filter(b => b.role === "table_caption").length, 2);
    assert(blocks.filter(b => b.role === "formula_number").every(b => !b.translatable));
    const first = blocks[0];
    assert(Math.abs(first.bbox[0] - first.source.bbox[0] * sizes[0].width / 1191) < .0001);
    assert.equal(first.source.rawRef, "parser-source/paddle/pages.json#/pages/0/prunedResult/parsing_res_list/0");
    for (const b of blocks.filter(b => b.role === "table")) b.asset = `images/${b.id}.png`;
    const projected = ParserModel.projectLayout(document);
    const service = new LayoutTranslationService(new MemoryStorage(), {});
    const flattened = service.flattenPage(projected.pdf_info[0], 0, "test", {});
    const orders = flattened.blocks.map(b => b.original.parser.readingOrder);
    assert.deepEqual([...orders].sort((a, b) => a - b), [...orders]);
    assert.equal(flattened.blocks.filter(b => b.type === "formula_number").length, 6);
    assert.equal(flattened.blocks.filter(b => b.kind === "formula").length, 6);
    assert(flattened.blocks.filter(b => b.type === "table_body").every(b => b.imagePath));
    const repeated = service.flattenPage(projected.pdf_info[0], 0, "test", {});
    assert.deepEqual(flattened.blocks.map(b => b.id), repeated.blocks.map(b => b.id));
  }

  async function testPaddleAbstractReferencesUnknownAndMalformedPages() {
    const input = fixture();
    const raw = input.result.layoutParsingResults[0].prunedResult;
    raw.parsing_res_list = [
      { block_id: 0, block_label: "abstract", block_bbox: [100, 100, 1000, 300], block_content: "Abstract with $ x^2 $ and text.", block_order: 1 },
      { block_id: 1, block_label: "reference_content", block_bbox: [100, 500, 1000, 560], block_content: "Reference source", block_order: 2 },
      { block_id: 2, block_label: "new_vendor_type", block_bbox: [100, 600, 1000, 660], block_content: "Unknown source", block_order: null }
    ];
    const document = PaddleAdapter.normalize(PaddleAdapter.decodeResults(JSON.stringify(input)), sizes);
    const projected = ParserModel.projectLayout(document);
    const storage = new ParserStorage();
    await storage.writeJSON(storage.path("test", "layout.json"), projected);
    const service = new LayoutTranslationService(storage, { getSettings: () => ({}) });
    const records = service.extractRecordsFromLayout({ pages: projected.pdf_info }, "test");
    assert.equal(records.length, 1);
    assert(records[0].formulas.some(token => ParserModel.stripMath(token) === "x^2"));
    assert.equal(document.pages[0].blocks[0].source.blockID, 0);
    const compiled = await service.buildModel("test", {}, {});
    assert.equal(compiled.pages.length, 1);
    assert.throws(() => PaddleAdapter.normalize([input.result.layoutParsingResults[0]], [...sizes, ...sizes]), /尚不完整/);
    raw.width = 200;
    assert.throws(() => PaddleAdapter.normalize(input.result.layoutParsingResults, sizes), /尺寸/);
    assert.throws(() => PaddleAdapter.decodeResults('{"result":'), /JSON/);
    assert.throws(() => PaddleAdapter.decodeResults('{"result":{}}'), /结果结构/);
    const tokens = ParserModel.mathTokens("`$code$` and \\$5, $ x^2 $ and \\(y\\)");
    assert.deepEqual(tokens.filter(t => t.kind === "math").map(t => t.tex), ["x^2", "y"]);
  }

  async function testPaddleTaskFailureAndResume() {
    const storage = new ParserStorage();
    const service = new PaddleService(storage, { getPaddleToken: () => "test" });
    const old = H.requestJSON;
    let calls = 0;
    try {
      H.requestJSON = async (method, url, options) => {
        calls++;
        assert.equal(method, "GET");
        assert(url.endsWith("/existing-job"));
        assert.equal(options.token, "test");
        return { code: 0, traceId: "trace", data: { state: "failed", errorMsg: "OCR服务请求失败，状态码 500" } };
      };
      const task = { jobID: "existing-job", state: "running" };
      const persisted = [];
      await assert.rejects(service.poll(task, "test", async v => persisted.push(clone(v)), {}, null, null), /500/);
      assert.equal(calls, 1);
      assert.equal(persisted[0].state, "failed");
      H.requestJSON = async () => ({ code: 0, data: { state: "done", resultUrl: { jsonUrl: "https://example.invalid/result" } } });
      assert.equal(await service.poll(task, "test", async () => {}, {}, null, null), "https://example.invalid/result");
      const controller = new AbortController(); controller.abort();
      await assert.rejects(service.poll(task, "test", async () => {}, {}, null, controller.signal), error => error.cancelled);
    }
    finally { H.requestJSON = old; }
  }

  async function testParserCacheIgnoresProviderAndCredentials() {
    const storage = new ParserStorage(); await seed(storage);
    const native = { parse: async () => { throw new Error("Unexpected MinerU call"); } };
    const paddle = { prepare: async () => { throw new Error("Unexpected Paddle call"); } };
    const service = new DocumentParserService(storage, {}, native, paddle);
    const result = await service.parse({ libraryID: 1, key: "TEST" }, "/source.pdf", { parseProvider: "paddle" });
    assert.equal(result.markdown, "Old readable document");
    assert.equal(storage.publications, 0);
    assert.equal(await storage.readText(storage.path("1-TEST", "translation", "translation.zh.md")), "旧译文");
  }

  async function testParserFailureRestoresWholeOldGeneration() {
    const storage = new ParserStorage(); await seed(storage);
    const native = { parse: async () => {
      await storage.writeText(storage.path("1-TEST", "full.cleaned.md"), "Changed before failure");
      await storage.remove(storage.path("1-TEST", "translation"), true);
      throw new Error("Publication interrupted");
    } };
    const service = new DocumentParserService(storage, {}, native, {});
    await assert.rejects(service.parse({ libraryID: 1, key: "TEST" }, "/source.pdf", { force: true, parseProvider: "mineru" }), /interrupted/);
    assert.equal((await service.loadParsed("1-TEST")).markdown, "Old readable document");
    assert.equal(await storage.readText(storage.path("1-TEST", "translation", "translation.zh.md")), "旧译文");
    assert.equal((await storage.readJSON(storage.path("1-TEST", "layout-translation", "translations.zh.json"))).old, "旧排版译文");
    assert.deepEqual([...await storage.readBytes(storage.path("1-TEST", "images", "old.png"))], [1, 2, 3]);
    assert(!await storage.exists(storage.path("1-TEST", "parser-publication.json")));
  }

  async function testMinerUReparsePublishesWithCleanupProtection() {
    for (const change of ["source", "layout", "unchanged"]) {
      const storage = new ParserStorage(); await seed(storage);
      storage.clearTranslation = (...args) => env.Storage.prototype.clearTranslation.apply(storage, args);
      const secrets = { getMinerUToken: () => "test-token" };
      const mineru = new env.MinerUService(storage, secrets);
      mineru.queryQuota = async () => ({});
      mineru.prepareUploadParts = async filePath => [{ filePath, start: 0, end: 1, pageCount: 1 }];
      mineru.runUploadPart = async part => ({ part, submitted: {}, downloaded: {} });
      const markdown = change === "source" ? "New readable document" : "Old readable document";
      const layout = change === "unchanged" ? { pdf_info: [] }
        : { pdf_info: [{ page_size: [600, 800], preproc_blocks: [] }] };
      mineru.mergeUploadPartResults = async (_parts, _id, staging) => {
        await storage.writeText(context.PathUtils.join(staging, "full.cleaned.md"), markdown);
        await storage.writeJSON(context.PathUtils.join(staging, "layout.json"), layout);
        return { markdown, hasLayout: true, records: [] };
      };
      const service = new DocumentParserService(storage, secrets, mineru, {});
      const result = await service.parse({ libraryID: 1, key: "TEST" }, "/source.pdf", { force: true, parseProvider: "mineru" });
      assert.equal(result.markdown, markdown, "the real MinerU publication must finish under the parser activity lock");
      const streamPath = storage.path("1-TEST", "translation", "translation.zh.md");
      const layoutPath = storage.path("1-TEST", "layout-translation", "translations.zh.json");
      assert.equal(await storage.exists(streamPath), change !== "source", "only a changed source invalidates stream translations");
      assert.equal(await storage.exists(layoutPath), change === "unchanged", "only changed layout invalidates layout translations");
      const [history] = await storage.list(storage.path("1-TEST", "parser-history"));
      assert.equal(await storage.readText(context.PathUtils.join(history, "translation", "translation.zh.md")), "旧译文");
      assert.equal((await storage.readJSON(context.PathUtils.join(history, "layout-translation", "translations.zh.json"))).old, "旧排版译文");
      assert.equal(storage._cacheActivities, 0);
      assert(!await storage.exists(storage.path("1-TEST", "parser-publication.json")));
    }
  }

  async function testParserRecoversAfterRestartAndBlocksConcurrentParse() {
    const storage = new ParserStorage(); await seed(storage);
    const service = new DocumentParserService(storage, {}, {}, {});
    const archive = await service.archive("1-TEST");
    await storage.writeJSON(storage.path("1-TEST", "parser-publication.json"), { archive });
    await storage.remove(storage.path("1-TEST", "full.cleaned.md"), false);
    const restarted = new DocumentParserService(storage, {}, {}, {});
    assert.equal((await restarted.loadParsed("1-TEST")).markdown, "Old readable document");
    assert(!await storage.exists(storage.path("1-TEST", "parser-history", archive)));
    restarted.active.add("1-TEST");
    await assert.rejects(restarted.parse({ libraryID: 1, key: "TEST" }, "/source.pdf", {}), /正在解析/);
  }

  async function testRecoveryPrecedesTranslationReads() {
    for (const entry of ["snapshot", "parse"]) {
      const storage = new ParserStorage(); await seed(storage);
      const parser = new DocumentParserService(storage, {}, {}, {});
      const archive = await parser.archive("1-TEST");
      await storage.writeJSON(storage.path("1-TEST", "parser-publication.json"), { archive });
      await storage.remove(storage.path("1-TEST", "translation"), true);
      await storage.remove(storage.path("1-TEST", "layout-translation"), true);
      const llm = { getSettings: () => ({ targetLanguage: "zh" }) };
      let captured;
      const pipeline = new env.DocumentPipeline({
        storage, parser, translation: new env.TranslationService(storage, llm),
        layout: new LayoutTranslationService(storage, llm), getSettings: llm.getSettings,
        chat: { listSessions: async () => [], loadSession: async () => null,
          archiveDocumentRevision: async (_id, _before, _after, values) => { captured = values; return { archived: 0 }; } }
      });
      pipeline.buildLayoutState = async (_id, _parsed, translations) => translations;
      pipeline.attachImageWidths = () => {};
      const context = { documentID: "1-TEST", attachment: { libraryID: 1, key: "TEST" }, filePath: "/source.pdf" };
      if (entry === "snapshot") {
        const result = await pipeline.snapshot(context);
        assert.equal(result.translation.markdown, "旧译文", "the first snapshot after recovery must include the restored stream translation");
        assert.equal(result.layout.translations.old, "旧排版译文");
      } else {
        await pipeline.parse(context);
        assert.equal(captured.translatedMarkdown, "旧译文", "revision capture must read translations after recovery");
      }
    }
  }

  async function testCrossProviderMetadataAndFailedArchiveCleanup() {
    const storage = new ParserStorage(); await seed(storage);
    const item = { libraryID: 1, key: "TEST" };
    await storage.setDocumentMeta("1-TEST", { parseProvider: "paddle", parseModel: "PaddleOCR-VL-1.6",
      parseRevisionID: "old-paddle", layoutPDFIdentity: "old-pdf" });
    await storage.writeJSON(storage.path("1-TEST", "paddle-task.json"), { state: "published", jobID: "old" });
    await storage.writeJSON(storage.path("1-TEST", "parsed-document.v1.json"), { provider: "paddle" });
    await storage.writeJSON(storage.path("1-TEST", "compiled-model.json"), { old: "paddle" });
    await storage.writeJSON(storage.path("1-TEST", "fit", "old.json"), { old: "paddle" });
    const native = { parse: async () => {
      await storage.writeText(storage.path("1-TEST", "full.cleaned.md"), "New MinerU result");
      return {};
    } };
    const service = new DocumentParserService(storage, {}, native, { prepare: async () => { throw new Error("Cloud failed"); } });
    const result = await service.parse(item, "/source.pdf", { force: true, parseProvider: "mineru" });
    assert.equal(result.meta.parseProvider, "mineru");
    assert.equal(result.meta.parseModel, "vlm");
    assert.notEqual(result.meta.parseRevisionID, "old-paddle");
    assert.equal(result.meta.layoutPDFIdentity, "");
    assert(!await storage.exists(storage.path("1-TEST", "paddle-task.json")));
    assert(!await storage.exists(storage.path("1-TEST", "parsed-document.v1.json")));
    assert(!await storage.exists(storage.path("1-TEST", "compiled-model.json")));
    assert(!await storage.exists(storage.path("1-TEST", "fit")));
    const histories = await storage.list(storage.path("1-TEST", "parser-history"));
    assert.equal(histories.length, 1);
    assert.equal((await storage.readJSON(context.PathUtils.join(histories[0], "archive.json"))).parseRevisionID, "old-paddle");
    assert.equal((await storage.readJSON(context.PathUtils.join(histories[0], "fit", "old.json"))).old, "paddle");
    for (let retry = 0; retry < 3; retry++) {
      await assert.rejects(service.parse(item, "/source.pdf", { force: true, parseProvider: "paddle" }), /Cloud failed/);
    }
    assert.deepEqual(await storage.list(storage.path("1-TEST", "parser-history")), histories);
    assert.equal((await service.loadParsed("1-TEST")).meta.parseRevisionID, result.meta.parseRevisionID);
    const firstRead = await service.loadParsed("1-TEST");
    assert.equal(firstRead.markdown, "New MinerU result");
  }

  async function testHistoryCleanupKeepsActiveDataAndPDFRecords() {
    const storage = new ParserStorage(); await seed(storage);
    storage.dirStats = (...args) => env.Storage.prototype.dirStats.call(storage, ...args);
    storage.formatBytes = value => String(value);
    await storage.writeJSON(storage.path("1-TEST", "generated-pdfs.json"), [{ translationKey: "PDF-KEY" }]);
    const service = new DocumentParserService(storage, {}, {}, {});
    const archive = await service.archive("1-TEST");
    await storage.writeJSON(storage.path("1-TEST", "parser-publication.json"), { archive });
    await assert.rejects(env.Storage.prototype.clearDocumentSubcategory.call(storage, "1-TEST", "parserHistory"), /正在解析或恢复/);
    await storage.removeFile(storage.path("1-TEST", "parser-publication.json"));
    await env.Storage.prototype.clearDocumentSubcategory.call(storage, "1-TEST", "parserHistory");
    assert(!await storage.exists(storage.path("1-TEST", "parser-history")));
    assert.equal(await storage.readText(storage.path("1-TEST", "full.cleaned.md")), "Old readable document");
    assert.equal(await storage.readText(storage.path("1-TEST", "translation", "translation.zh.md")), "旧译文");
    await env.Storage.prototype.clearDocumentSubcategory.call(storage, "1-TEST", "model");
    assert.equal((await storage.readJSON(storage.path("1-TEST", "generated-pdfs.json")))[0].translationKey, "PDF-KEY");
  }

  async function testPaddlePrepareThroughPublication() {
    const storage = new ParserStorage();
    const secrets = { getPaddleToken: () => "paddle-test" };
    const paddle = new PaddleService(storage, secrets);
    const service = new DocumentParserService(storage, secrets, {}, paddle);
    const pdf = await context.PDFLib.PDFDocument.create();
    pdf.addPage().setSize(595.44, 793.92);
    await storage.writeBytes("/source.pdf", await pdf.save());
    const oldJSON = H.requestJSON, oldDownload = H.requestBytes;
    assert.equal(typeof oldDownload, "function");
    let submits = 0, crops = 0;
    paddle.resource = async (_url, folder, stem) => { const target = `${stem}.png`; await storage.writeBytes(context.PathUtils.join(folder, target), new Uint8Array([1])); return target; };
    paddle.cropImage = async (folder, _source, _bbox, expected, relative) => {
      crops++; assert.deepEqual([...expected], [1191, 1588]);
      await storage.writeBytes(context.PathUtils.join(folder, relative), new Uint8Array([2])); return relative;
    };
    try {
      H.requestJSON = async (method, _url, options) => {
        if (method === "POST") {
          submits++;
          const body = Buffer.from(options.body).toString();
          assert(body.includes('"useDocUnwarping":false'));
          assert(body.includes("PaddleOCR-VL-1.6"));
          return { code: 0, data: { jobId: "job-test" } };
        }
        return { code: 0, data: { state: "done", resultUrl: { jsonUrl: "https://example.invalid/result" } } };
      };
      H.requestBytes = async (_url, options) => {
        assert(!options.token, "BOS downloads must not receive the API token");
        return new TextEncoder().encode(JSON.stringify(fixture()));
      };
      const result = await service.parse({ libraryID: 1, key: "TEST" }, "/source.pdf", { parseProvider: "paddle" });
      assert.equal(submits, 1); assert.equal(crops, 2);
      assert.equal(result.meta.parseProvider, "paddle");
      assert.equal(result.hasLayout, true);
      assert.equal(result.imageMap.length, 2);
      assert.equal((await storage.readJSON(storage.path("1-TEST", "paddle-task.json"))).state, "published");
      const layout = new LayoutTranslationService(storage, { getSettings: () => ({}) });
      assert.equal((await layout.buildModel("1-TEST", {}, {})).pages.length, 1);
      await service.parse({ libraryID: 1, key: "TEST" }, "/source.pdf", { parseProvider: "mineru" });
      assert.equal(submits, 1);
    }
    finally { H.requestJSON = oldJSON; H.requestBytes = oldDownload; }
  }

  async function testPaddleMultiPageResourceNamesAndOrder() {
    const storage = new ParserStorage();
    const paddle = new PaddleService(storage, {});
    const first = fixture(), second = fixture();
    for (const record of [first, second]) {
      const page = record.result.layoutParsingResults[0];
      page.markdown = { text: "![figure](images/shared.png)", images: { "images/shared.png": "https://example.invalid/image.png" } };
      page.prunedResult.parsing_res_list = [{ block_label: "image", block_bbox: [100, 100, 500, 500], block_content: "", block_order: 0 }];
    }
    const pages = PaddleAdapter.decodeResults([first, second].map(JSON.stringify).join("\n"));
    const document = PaddleAdapter.normalize(pages, [...sizes, ...sizes]);
    paddle.resource = async (_url, folder, stem) => {
      const target = `${stem}.png`; await storage.writeBytes(context.PathUtils.join(folder, target), new Uint8Array([1])); return target;
    };
    paddle.cropImage = async (folder, _source, _bbox, _expected, target) => {
      await storage.writeBytes(context.PathUtils.join(folder, target), new Uint8Array([2])); return target;
    };
    const localized = await paddle.localize(pages, document, "/stage");
    assert.equal(document.pages.length, 2);
    assert.equal(localized.imageMap.length, 2);
    assert.notEqual(document.pages[0].blocks[0].asset, document.pages[1].blocks[0].asset);
    assert.deepEqual(localized.imageMap.map(row => row.page), [1, 2]);
    assert(localized.markdown.includes("images/p001-"));
    assert(localized.markdown.includes("images/p002-"));
    assert(!localized.markdown.includes("images/shared.png"));
    assert.equal(new Set(ParserModel.projectLayout(document).pdf_info.flatMap(page => page.preproc_blocks.map(block => block.parser.id))).size, 2);
  }

  async function testPaddleReferenceCacheAndFailureIsolation() {
    const storage = new ParserStorage();
    await storage.writeBytes("/reference.pdf", new Uint8Array([1, 2]));
    let prepares = 0;
    const paddle = { prepare: async (_file, stage) => {
      prepares++;
      await storage.writeJSON(context.PathUtils.join(stage, "image-map.json"), []);
      return { markdown: "Reference text", model: "PaddleOCR-VL-1.6", imageMap: [] };
    } };
    const service = new DocumentParserService(storage, {}, { parseExternalReference: () => { throw new Error("Wrong provider"); } }, paddle);
    const first = await service.parseExternalReference("/reference.pdf", "/references", { parseProvider: "paddle" });
    assert.equal(first.cached, false);
    assert.equal(first.meta.parseProvider, "paddle");
    const cached = await service.parseExternalReference("/reference.pdf", "/references", { parseProvider: "paddle" });
    assert.equal(cached.markdown, "Reference text");
    assert.equal(cached.cached, true);
    assert.equal(prepares, 1);
    paddle.prepare = async () => { throw new Error("Cloud failed"); };
    await assert.rejects(service.parseExternalReference("/reference.pdf", "/references", { parseProvider: "paddle", force: true }), /Cloud failed/);
    assert.equal(await storage.readText(context.PathUtils.join(first.root, "reference.md")), "Reference text");
  }

  async function testPaddlePageAndFileSizeLimits() {
    const storage = new ParserStorage();
    const secrets = { getPaddleToken: () => "paddle-test" };
    const paddle = new PaddleService(storage, secrets);

    await storage.writeBytes("/large.pdf", new Uint8Array([1, 2]));
    const originalStat = storage.stat;
    storage.stat = async () => ({ type: "regular", size: 201 * 1024 * 1024, lastModified: Date.now() });
    try {
      await assert.rejects(
        paddle.prepare("/large.pdf", "/stage"),
        /超过限制，Paddle单次解析最多支持 200 MB/
      );
    } finally {
      storage.stat = originalStat;
    }

    const pdf = await context.PDFLib.PDFDocument.create();
    for (let i = 0; i < 1001; i++) pdf.addPage().setSize(100, 100);
    await storage.writeBytes("/many-pages.pdf", await pdf.save());
    await assert.rejects(
      paddle.prepare("/many-pages.pdf", "/stage"),
      /超过Paddle单次解析上限（最多支持 1000 页）/
    );
  }

  async function testPendingRecoverySurvivesEveryCleanupEntry() {
    const storage = new ParserStorage(); await seed(storage);
    const service = new DocumentParserService(storage, {}, {}, {});
    const archive = await service.archive("1-TEST");
    await storage.writeJSON(storage.path("1-TEST", "parser-publication.json"), { archive });
    await storage.writeText(storage.path("1-TEST", "full.cleaned.md"), "Interrupted result");
    await storage.remove(storage.path("1-TEST", "images"), true);
    for (const category of ["model", "mineruResult", "parserHistory", "images", "translation", "other", "all"]) {
      await assert.rejects(env.Storage.prototype.clearDocumentSubcategory.call(storage, "1-TEST", category), /正在解析或恢复/);
    }
    await assert.rejects(env.Storage.prototype.clearDocument.call(storage, "1-TEST"), /正在解析或恢复/);
    await assert.rejects(env.Storage.prototype.clearTranslation.call(storage, "1-TEST"), /正在解析或恢复/);
    const restarted = new DocumentParserService(storage, {}, {}, {});
    const restored = await restarted.loadParsed("1-TEST");
    assert.equal(restored.markdown, "Old readable document");
    assert(restored.meta.parseRevisionID.startsWith("legacy-"));
    assert.equal(await storage.readText(storage.path("1-TEST", "translation", "translation.zh.md")), "旧译文");
    assert.deepEqual([...await storage.readBytes(storage.path("1-TEST", "images", "old.png"))], [1, 2, 3]);
    storage.dirStats = (...args) => env.Storage.prototype.dirStats.call(storage, ...args);
    storage.formatBytes = String;
    await env.Storage.prototype.clearDocumentSubcategory.call(storage, "1-TEST", "model");
    assert(!await storage.exists(storage.path("1-TEST", "full.cleaned.md")));
  }

  async function testRunningParseRejectsCleanupAndCompletes() {
    for (const provider of ["mineru", "paddle"]) {
      const storage = new ParserStorage(); await seed(storage);
      storage.tempRoot = storage.path("temporary");
      storage.documentsRoot = storage.path();
      const taskFile = context.PathUtils.join(storage.tempRoot, "active", "resource.png");
      let resume, started;
      const ready = new Promise(resolve => { started = resolve; });
      const wait = new Promise(resolve => { resume = resolve; });
      const service = new DocumentParserService(storage, {}, { parse: async () => {
        await storage.writeText(taskFile, "working resource"); started(); await wait;
        assert.equal(await storage.readText(taskFile), "working resource");
      } }, {});
      if (provider === "paddle") service.parsePaddle = service.mineru.parse;
      const job = service.parse({ libraryID: 1, key: "TEST" }, "/source.pdf", { force: true, parseProvider: provider });
      await ready;
      await assert.rejects(env.Storage.prototype.clearTempFiles.call(storage), /有任务正在运行/);
      await assert.rejects(env.Storage.prototype.clearDocumentSubcategory.call(storage, "1-TEST", "all"), /有任务正在运行/);
      resume(); await job;
      assert.equal(storage._cacheActivities, 0);
      storage.dirStats = (...args) => env.Storage.prototype.dirStats.call(storage, ...args);
      storage.formatBytes = String;
      await env.Storage.prototype.clearTempFiles.call(storage);
      assert(!await storage.exists(taskFile));
    }
  }

  async function testWholeDocumentCleanupRunsAttachmentRemovalUnderLock() {
    const storage = new ParserStorage(); await seed(storage);
    storage.formatBytes = String;
    storage.dirStats = async () => ({ bytes: 1, files: 1 });
    storage.deepSeekWebPagesStatsAtDocumentDir = async () => ({ bytes: 0 });
    const clear = beforeRemove => env.Storage.prototype.clearDocumentSubcategory.call(storage, "1-TEST", "all", beforeRemove);
    const source = storage.path("1-TEST", "full.cleaned.md");
    await assert.rejects(clear(async () => {
      assert.throws(() => storage.beginActivity(), /正在清理缓存/);
      assert(await storage.exists(source), "keep ownership records until attachment removal succeeds");
      throw new Error("attachment removal failed");
    }), /attachment removal failed/);
    assert(await storage.exists(source));
    assert.equal(storage._cacheCleanup, false);
    const release = storage.beginActivity();
    await assert.rejects(clear(() => assert.fail("must not remove attachments during an active task")), /有任务正在运行/);
    release();
    await clear(async () => assert(await storage.exists(source)));
    assert(!await storage.exists(source));
  }

  async function testCleanupExcludesNewTasksAndKeepsReferenceSources() {
    const storage = new ParserStorage(); await seed(storage);
    storage.formatBytes = String;
    let resume, started;
    const ready = new Promise(resolve => { started = resolve; });
    const wait = new Promise(resolve => { resume = resolve; });
    storage.dirStats = async () => { started(); await wait; return { bytes: 3, files: 1 }; };
    const root = storage.path("1-TEST", "reference-context");
    await storage.writeText(context.PathUtils.join(root, "parsed", "hash", "reference.md"), "Derived reference");
    await storage.writeText(context.PathUtils.join(root, "source.pdf"), "Keep source");
    await storage.writeText(storage.path("1-TEST", "chat", "attachment.pdf"), "Keep attachment");
    const cleaning = env.Storage.prototype.clearDocumentSubcategory.call(storage, "1-TEST", "other");
    await ready;
    const service = new DocumentParserService(storage, {}, {}, {});
    await assert.rejects(service.parse({ libraryID: 1, key: "TEST" }, "/source.pdf"), /正在清理缓存/);
    assert.throws(() => env.Storage.prototype.temporaryDir.call(storage), /正在清理缓存/);
    resume(); await cleaning;
    assert(!await storage.exists(context.PathUtils.join(root, "parsed")));
    assert.equal(await storage.readText(context.PathUtils.join(root, "source.pdf")), "Keep source");
    assert.equal(await storage.readText(storage.path("1-TEST", "chat", "attachment.pdf")), "Keep attachment");
    assert.equal((await service.loadParsed("1-TEST")).markdown, "Old readable document");
  }

  async function testPaddleTypeCheckFollowsCacheReuse() {
    const storage = new ParserStorage(); await seed(storage);
    let calls = 0;
    const service = new DocumentParserService(storage, {}, { parse: async () => { calls++; } }, { prepare: async () => { throw new Error("Unexpected Paddle request"); } });
    for (const provider of ["mineru", "paddle"]) {
      assert.equal((await service.parse({ libraryID: 1, key: "TEST" }, "/source.docx", { parseProvider: provider })).markdown, "Old readable document");
    }
    await assert.rejects(service.parse({ libraryID: 1, key: "TEST" }, "/source.docx", { parseProvider: "paddle", force: true }), /支持PDF/);
    assert(!await storage.exists(storage.path("1-TEST", "parser-history")));
    await service.parse({ libraryID: 1, key: "TEST" }, "/source.docx", { parseProvider: "mineru", force: true });
    assert.equal(calls, 1);
    assert.equal(await storage.readText(storage.path("1-TEST", "translation", "translation.zh.md")), "旧译文");
    await assert.rejects(new PaddleService(storage, {}).prepare("/source.png", "/stage"), /支持PDF/);
  }

  async function testParserStorageCleanupMatchesKnownArtifacts() {
    const storage = new ParserStorage(); await seed(storage);
    storage.dirStats = (...args) => env.Storage.prototype.dirStats.call(storage, ...args);
    storage.formatBytes = String;
    const targets = ["mineru-result/raw.json", "mineru-task.json", "parser-source/paddle/pages.json", "paddle-task.json"];
    for (const file of targets) await storage.writeText(storage.path("1-TEST", file), "raw");
    const result = await env.Storage.prototype.clearDocumentSubcategory.call(storage, "1-TEST", "mineruResult");
    assert.equal(result.clearedFiles, 4);
    assert.equal(result.clearedBytes, 12);
    for (const file of targets) assert(!await storage.exists(storage.path("1-TEST", file)));
    assert.equal((await new DocumentParserService(storage, {}, {}, {}).loadParsed("1-TEST")).markdown, "Old readable document");
    assert.equal(await storage.readText(storage.path("1-TEST", "translation", "translation.zh.md")), "旧译文");
  }

  async function testMissingDefaultTokenDoesNotSelectConfiguredAlternative() {
    const storage = new ParserStorage();
    let paddleCalls = 0;
    const secrets = { getMinerUToken: () => "", getPaddleToken: () => "configured-alternative" };
    const service = new DocumentParserService(storage, secrets, new env.MinerUService(storage, secrets), { prepare: async () => { paddleCalls++; } });
    const oldProvider = U.getPref("parseProvider", "mineru");
    U.setPref("parseProvider", "mineru");
    try {
      await assert.rejects(service.parse({ libraryID: 1, key: "TEST" }, "/source.pdf"), /尚未配置MinerU/);
      assert.equal(paddleCalls, 0);
      assert.equal(storage._cacheActivities, 0);
    }
    finally { U.setPref("parseProvider", oldProvider); }
  }

  async function testGeneratedPDFsReplaceAcrossParsersAndDeduplicate() {
    const storage = new ParserStorage(), controller = Object.create(context.LitMTrans.Controller.prototype);
    const id = "1-TEST", registryPath = storage.path(id, "generated-pdfs.json");
    const registry = [
      { parseRevisionID: "mineru-1", targetLanguage: "简体中文", translationKey: "old1", comparisonKey: "old2" },
      { parseRevisionID: "paddle-1", targetLanguage: "简体中文", translationKey: "old3", comparisonKey: "old4" },
      { parseRevisionID: "mineru-1", targetLanguage: "English", translationKey: "en1", comparisonKey: "en2" }
    ];
    await storage.writeJSON(registryPath, registry);
    await storage.setDocumentMeta(id, { parseProvider: "paddle", parseRevisionID: "paddle-2" });
    const items = new Map(["old1", "old2", "old3", "old4", "en1", "en2", "unrelated"].map((key, i) => [key, { key, id: i + 1 }]));
    const previousItems = context.Zotero.Items;
    let created = 0, printed = 0, failComparison = false;
    const trashed = [], erased = [];
    context.Zotero.Items = {
      get: id => [...items.values()].find(item => item.id === id),
      getByLibraryAndKey: (_library, key) => items.get(key),
      trashTx: async ids => { trashed.push(...ids); for (const item of items.values()) if (ids.includes(item.id)) item.deleted = true; },
      erase: async ids => erased.push(...ids)
    };
    controller.storage = storage;
    controller.attachmentContext = async () => ({ documentID: id, filePath: "/source.pdf", title: "Paper",
      attachment: { id: 20, libraryID: 1 } });
    controller.getSettings = () => ({ targetLanguage: "简体中文" });
    controller.printWorkbenchPDF = async () => { printed++; };
    controller.createLayoutComparisonPDF = async () => {};
    controller.createGeneratedPDFAttachment = async (_context, _file, title) => {
      if (failComparison && title.includes("译文对照版")) throw new Error("import failed");
      created++;
      const item = { id: 100 + created, key: `new${created}` };
      items.set(item.key, item);
      assert(!/MinerU|PaddleOCR/.test(title));
      return item;
    };
    try {
      const runtime = { attachmentID: 20 }, payload = { layoutIdentity: "latest-layout", targetLanguage: "简体中文" };
      const results = await Promise.all([controller.createLayoutPDFAttachments(runtime, payload), controller.createLayoutPDFAttachments(runtime, payload)]);
      assert.equal(printed, 1, "concurrent readers must share the saved result instead of creating duplicate PDFs");
      assert.equal(created, 2);
      assert.equal(results[0].translationAttachmentID, results[1].translationAttachmentID);
      assert.equal(results[1].cached, true);
      assert.deepEqual(trashed, [1, 2, 3, 4], "replace registered old PDFs across parser revisions");
      const saved = await storage.readJSON(registryPath);
      assert.equal(saved.length, 2);
      assert(saved.some(entry => entry.targetLanguage === "English"));
      assert(!items.get("unrelated").deleted);
      failComparison = true;
      await assert.rejects(controller.createLayoutPDFAttachments(runtime, { ...payload, layoutIdentity: "next-layout" }), /import failed/);
      assert.deepEqual(await storage.readJSON(registryPath), saved, "failed publication must preserve the previous PDF registry");
      assert.deepEqual(trashed, [1, 2, 3, 4]);
      assert.deepEqual(erased, [103], "only the incomplete new attachment is cleaned up");
      assert.equal(controller.layoutPDFTasks.size, 0);
    } finally { context.Zotero.Items = previousItems; }
  }

  async function testGeneratedPDFsPreserveLegacyAnnotationsAndNotes() {
    const storage = new ParserStorage(), controller = Object.create(context.LitMTrans.Controller.prototype);
    await storage.setDocumentMeta("1-TEST", { parseRevisionID: "current" });
    const items = new Map();
    const makeItem = (id, key, title, content = "") => {
      let loaded = false;
      const item = { id, key, libraryID: 1, parentID: 10, attachmentContentType: "application/pdf",
        isAttachment: () => true, isFileAttachment: () => true, getField: () => title,
        loadDataType: async () => { loaded = true; },
        getAnnotations: () => { assert(loaded); return content === "annotations" ? [1000] : []; },
        getNotes: () => { assert(loaded); return content === "notes" ? [1001] : []; }, getNote: () => "" };
      items.set(key, item);
      return item;
    };
    makeItem(1, "annotated", "简体中文-译文-Paper", "annotations");
    makeItem(2, "noted", "简体中文-译文对照版-Paper", "notes");
    makeItem(3, "clean", "简体中文-译文-Paper");
    const previousItems = context.Zotero.Items, trashed = [];
    context.Zotero.Items = {
      get: id => [...items.values()].find(item => item.id === id),
      getByLibraryAndKey: (_library, key) => items.get(key),
      trashTx: async ids => { trashed.push(...ids); for (const item of items.values()) if (ids.includes(item.id)) item.deleted = true; }
    };
    controller.storage = storage;
    controller.attachmentContext = async () => ({ documentID: "1-TEST", filePath: "/source.pdf", title: "Paper",
      attachment: { id: 20, libraryID: 1 },
      parent: { id: 10, isRegularItem: () => true, getAttachments: () => [...items.values()].map(item => item.id) } });
    controller.getSettings = () => ({ targetLanguage: "简体中文" });
    let printed = 0;
    controller.printWorkbenchPDF = async () => { printed++; };
    controller.createLayoutComparisonPDF = async () => {};
    controller.createGeneratedPDFAttachment = async (_context, _file, title) => makeItem(items.size + 100, `new${items.size}`, title);
    try {
      const runtime = { attachmentID: 20 }, payload = { layoutIdentity: "current-layout" };
      await controller.createLayoutPDFAttachments(runtime, payload);
      assert.deepEqual(trashed, [3], "legacy PDFs containing annotations or notes must stay attached");
      assert(!items.get("annotated").deleted && !items.get("noted").deleted);
      const cached = await controller.createLayoutPDFAttachments(runtime, payload);
      assert.equal(cached.cached, true);
      assert.equal(printed, 1);
      assert.deepEqual(trashed, [3], "deduplication must also preserve legacy user content");
    } finally { context.Zotero.Items = previousItems; }
  }

  return { testWholeDocumentCleanupRunsAttachmentRemovalUnderLock, testGeneratedPDFsReplaceAcrossParsersAndDeduplicate,
    testGeneratedPDFsPreserveLegacyAnnotationsAndNotes, testPaddleStructureAndSemanticBoundaries, testPaddleAbstractReferencesUnknownAndMalformedPages,
    testPaddleTaskFailureAndResume, testParserCacheIgnoresProviderAndCredentials,
    testParserFailureRestoresWholeOldGeneration, testMinerUReparsePublishesWithCleanupProtection, testParserRecoversAfterRestartAndBlocksConcurrentParse,
    testRecoveryPrecedesTranslationReads,
    testPaddlePrepareThroughPublication, testPaddleMultiPageResourceNamesAndOrder,
    testPaddleReferenceCacheAndFailureIsolation, testCrossProviderMetadataAndFailedArchiveCleanup,
    testHistoryCleanupKeepsActiveDataAndPDFRecords, testPaddlePageAndFileSizeLimits,
    testPendingRecoverySurvivesEveryCleanupEntry, testRunningParseRejectsCleanupAndCompletes,
    testCleanupExcludesNewTasksAndKeepsReferenceSources, testPaddleTypeCheckFollowsCacheReuse,
    testParserStorageCleanupMatchesKnownArtifacts, testMissingDefaultTokenDoesNotSelectConfiguredAlternative };
};
