"use strict";

module.exports = function createSuite(env) {
  const {
    assert, fs, path, root, prefValues, context, zlib, nodeCrypto, vm,
    crc32, zipU16, zipU32, zipU64, oneEntryZip, oneEntryZip64,
    MemoryStorage, withResolvedChatModel,
    U, M, H, LLMService, LLMInternals,
    TranslationService, TranslationInternals,
    WebMachineTranslationService, WebMachineTranslation,
    EdgeLocalTranslation, LayoutTranslationService, LayoutHelpers,
    MinerUService, MinerUInternals, Mindmap, MindmapV2, Flowchart,
    ChatService, ChatInternals, ControllerInternals, DocumentPipeline
  } = env;

async function testAtomicEntryPublicationRollback() {
  const originalIOUtils = context.IOUtils;
  const files = new Map([
    ["/dest/a.txt", "old-a"],
    ["/dest/b.txt", "old-b"],
    ["/stage/a.txt", "new-a"],
    ["/stage/b.txt", "new-b"]
  ]);
  let injected = false;
  context.IOUtils = {
    async exists(file) { return files.has(file); },
    async makeDirectory() {},
    async move(source, destination) {
      if (destination === "/dest/b.txt" && !injected) {
        injected = true;
        throw new Error("injected publish failure");
      }
      if (!files.has(source)) throw new Error(`missing ${source}`);
      if (files.has(destination)) throw new Error(`destination exists: ${destination}`);
      files.set(destination, files.get(source));
      files.delete(source);
    },
    async remove(file, options = {}) {
      if (options.recursive) {
        for (const key of [...files.keys()]) if (key === file || key.startsWith(file + "/")) files.delete(key);
      }
      else files.delete(file);
    }
  };
  try {
    const storage = new context.LitMTrans.Storage();
    await assert.rejects(
      storage.publishEntriesAtomically([
        { source: "/stage/a.txt", destination: "/dest/a.txt" },
        { source: "/stage/b.txt", destination: "/dest/b.txt" }
      ], "/rollback"),
      /injected publish failure/
    );
    assert.equal(files.get("/dest/a.txt"), "old-a", "first destination must be restored after a later publish failure");
    assert.equal(files.get("/dest/b.txt"), "old-b", "second destination must be restored after a later publish failure");
    assert(!files.has("/stage/a.txt"), "staged file moved during failed publish should not be left in staging");
    assert(![...files.keys()].some(file => file.startsWith("/rollback")), "successful rollback should clean its rollback directory");
  }
  finally {
    context.IOUtils = originalIOUtils;
  }
}

async function testPortedCore() {
  const P = context.LitMTrans.PortedCore;
  assert(P, "ported core must be loaded before runtime modules");

  assert(P.is_supported_input_file("论文.PDF"));
  assert(P.is_direct_text_input_file("notes.markdown"));
  assert.equal(P.inputKind("paper.docx"), "office");
  assert(!P.safe_document_stem("../CON", "document", 40).includes("/"));
  assert.equal(P.normalizeRelativePath("外层\\结果\\图片.png"), "外层/结果/图片.png");
  assert.throws(() => P.normalizeRelativePath("../../escape.txt"), /ZIP/);
  const used = new Set();
  assert.equal(P.deduplicateRelativePath("图.png", used), "图.png");
  assert.equal(P.deduplicateRelativePath("图.png", used), "图 (2).png");
  assert(P.shortenWindowsPath(("很长目录/".repeat(40)) + "文件.json", 120).length <= 120);

  const zipEntries = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/01_mineru_raw/zip-entries.json"), "utf8"));
  const planned = P.planZipExtraction(zipEntries, { windowsMaxPath: 120 });
  assert.equal(planned.length, zipEntries.length);
  assert(planned.some(row => row.relativePath.includes("图 1 (2).png")), "duplicate Chinese names must be retained with deterministic suffixes");
  assert(planned.every(row => row.relativePath.length <= 120));
  const traversal = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/01_mineru_raw/path-traversal.json"), "utf8"));
  assert.throws(() => P.planZipExtraction(traversal), /ZIP/);
  assert(P.identifyMinerURoot(planned.map(row => row.relativePath)).includes("result") || P.identifyMinerURoot(planned.map(row => row.relativePath)) === "");

  const docA = P.newNormalizedDocument("doc-1", "# Title\r\n\r\nText $x+y$.\n");
  const docB = P.newNormalizedDocument("doc-1", "# Title\n\nText $x-y$.\n");
  assert(docA.sourceFingerprint);
  assert.notEqual(docA.sourceFingerprint, docB.sourceFingerprint);
  assert(P.sourceChanged(docA, docB));
  const artifact = P.createTranslationArtifact("doc-1", docA.sourceFingerprint, "stream", { markdown: "译文", status: "complete" });
  assert(P.translationIsCurrent(artifact, docA.sourceFingerprint));
  assert(!P.translationIsCurrent(artifact, docB.sourceFingerprint));
  assert.throws(() => P.assertTranslationCurrent(artifact, docB.sourceFingerprint), /当前译文已失效/);
  assert(P.shouldPublishTranslation(artifact, docA.sourceFingerprint));
  assert(!P.shouldPublishTranslation({ ...artifact, status: "cancelled" }, docA.sourceFingerprint));

  const legacyManifest = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/07_cache_manifest/v1.json"), "utf8"));
  const migrated = P.migrateCacheManifest(legacyManifest, "doc-1");
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.documentID, "doc-1");
  const archive = P.createArchiveEntry("doc-1", "old", "new", ["a", "a", "b"], ["s1", "s1"], new Date("2026-07-27T00:00:00Z"));
  assert.equal(archive.files.length, 2);
  assert.equal(archive.chatSessionIDs.length, 1);

  const chunks = P.buildTranslationChunks("# A\n\n" + "paragraph. ".repeat(300) + "\n\n# B\n\nend", 120);
  assert(chunks.length > 1);
  const messages = P.buildStreamTranslationMessages(chunks[0], { targetLanguage: "简体中文" });
  assert(messages[0].content.includes(chunks[0].marker));
  const accepted = P.acceptStreamChunk(`译文 $x+y$\n${chunks[0].marker}`, chunks[0]);
  assert(!accepted.includes(chunks[0].marker));
  assert.throws(() => P.acceptStreamChunk("没有结束标记", chunks[0]), /结束标记/);
  const merged = P.mergeTranslatedChunks(chunks.slice(0, 2).map((chunk, index) => ({ chunk, text: `part-${index}` })));
  assert(merged.includes("part-0") && merged.includes("part-1"));

  const streamState = P.readingModeContract("stream");
  const layoutState = P.readingModeContract("layout");
  assert.equal(streamState.sourceKind, "parsed-markdown");
  assert.equal(layoutState.sourceKind, "zotero-reader");
  assert.equal(P.validateReaderModeState(streamState).length, 0);
  assert(P.validateReaderModeState({ ...layoutState, sourceKind: "parsed-markdown" }).length > 0);
  const clean = P.captureCleanReadingSnapshot({ mode: "layout", readerView: "translation", swapped: true, sourceSharePercent: 42, sourceScrollTop: 100, translationScrollTop: 200, focusedElementID: "translation" });
  assert(clean.active && clean.swapped && clean.mode === "layout");
  assert(!P.exitCleanReadingSnapshot(clean).active);
  assert.equal(
    P.inlineFormulaRetryIssue("参数 \\(x\\)。", "参数 \\(z\\)。"),
    "",
    "ported layout validation must treat same-count TeX differences as review-only"
  );
  assert(
    P.inlineFormulaRetryIssue("参数 \\(x\\) 和 \\(y\\)。", "参数 \\(x\\) 和 y。"),
    "ported layout validation must still detect a missing recognizable formula"
  );

  let attempts = 0;
  const retryEvents = [];
  const retryResult = await P.runWithRetry(async attempt => {
    attempts = attempt;
    if (attempt < 3) throw new P.PortError("HTTP", "temporary", { retryable: true });
    return "ok";
  }, { attempts: 3, baseDelay: 0, maxDelay: 0, jitter: 0, onRetry: (_error, next) => retryEvents.push(next) });
  assert.equal(retryResult, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(retryEvents, [2, 3]);
  assert.throws(() => P.throwIfAborted({ aborted: true, reason: "用户取消" }), /用户取消/);
  const cleanupOrder = [];
  const task = new P.TaskContext("fixture");
  await P.runTask(task, async ctx => {
    ctx.defer(() => cleanupOrder.push("first"));
    ctx.defer(() => cleanupOrder.push("second"));
    return 1;
  });
  assert.deepEqual(cleanupOrder, ["second", "first"]);

  class MemoryStore {
    constructor(entries = {}) { this.entries = new Map(Object.entries(entries)); this.failOnMove = ""; this.failedMove = false; }
    join(...parts) { return parts.join("/"); }
    async exists(key) { return this.entries.has(key); }
    async readText(key) { return String(this.entries.get(key) || ""); }
    async readBytes(key) { return new TextEncoder().encode(String(this.entries.get(key) || "")); }
    async readJSON(key, fallback) { return this.entries.has(key) ? JSON.parse(this.entries.get(key)) : fallback; }
    async writeText(key, value) { this.entries.set(key, String(value)); }
    async writeBytes(key, value) { this.entries.set(key, new TextDecoder().decode(value)); }
    async writeJSON(key, value) { this.entries.set(key, JSON.stringify(value)); }
    async makeDirectory() {}
    async list() { return [...this.entries.keys()]; }
    async copy(source, destination) { this.entries.set(destination, this.entries.get(source)); }
    async move(source, destination) {
      if (destination === this.failOnMove && !this.failedMove) { this.failedMove = true; throw new Error("move failed"); }
      if (!this.entries.has(source)) throw new Error(`missing ${source}`);
      this.entries.set(destination, this.entries.get(source)); this.entries.delete(source);
    }
    async remove(key) { this.entries.delete(key); }
  }
  const store = new MemoryStore({ "tmp/a": "new-a", "tmp/b": "new-b", "out/a": "old-a", "out/b": "old-b" });
  await P.atomicPublish(store, P.createAtomicPublishPlan([{ temporaryPath: "tmp/a", destinationPath: "out/a" }, { temporaryPath: "tmp/b", destinationPath: "out/b" }], "tx-ok"));
  assert.equal(await store.readText("out/a"), "new-a");
  assert.equal(await store.readText("out/b"), "new-b");
  const rollbackStore = new MemoryStore({ "tmp/a": "new-a", "tmp/b": "new-b", "out/a": "old-a", "out/b": "old-b" });
  rollbackStore.failOnMove = "out/b";
  await assert.rejects(() => P.atomicPublish(rollbackStore, P.createAtomicPublishPlan([{ temporaryPath: "tmp/a", destinationPath: "out/a" }, { temporaryPath: "tmp/b", destinationPath: "out/b" }], "tx-fail")), /原子发布失败/);
  assert.equal(await rollbackStore.readText("out/a"), "old-a");
  assert.equal(await rollbackStore.readText("out/b"), "old-b");

  const geminiConfig = P.normalizeLLMConfig({ purpose: "translation", provider: "gemini", model: "models/gemini-3.5-flash", apiKey: "secret", showReasoning: true, thinkingMode: "enabled", reasoningEffort: "medium" });
  assert.equal(geminiConfig.baseURL, "https://generativelanguage.googleapis.com/v1beta");
  assert.equal(geminiConfig.model, "gemini-3.5-flash");
  assert.equal(P.geminiInteractionsURL("https://generativelanguage.googleapis.com/v1beta/openai", true), "https://generativelanguage.googleapis.com/v1beta/interactions?alt=sse");
  assert.equal(P.geminiModelsURL("https://generativelanguage.googleapis.com/v1beta"), "https://generativelanguage.googleapis.com/v1beta/models");
  const geminiRequest = P.buildGeminiInteractionRequest(geminiConfig, [
    { role: "system", content: "Translate faithfully." },
    { role: "user", content: [{ type: "text", text: "Text" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }
  ], { stream: true, responseFormat: "json_object", maxTokens: 2000 });
  assert.equal(geminiRequest.model, "gemini-3.5-flash");
  assert.equal(geminiRequest.store, false);
  assert.equal(geminiRequest.system_instruction, "Translate faithfully.");
  assert.equal(geminiRequest.response_format.mime_type, "application/json");
  assert.equal(geminiRequest.input[0].type, "text");
  assert.equal(geminiRequest.input[1].type, "image");
  assert.equal(geminiRequest.input[1].mime_type, "image/png");
  const geminiHistoryRequest = P.buildGeminiInteractionRequest(geminiConfig, [
    { role: "user", content: "Question" },
    { role: "assistant", content: "Answer" },
    { role: "user", content: "Follow-up" }
  ], { stream: false });
  assert.deepEqual(
    geminiHistoryRequest.input.map(step => step.type),
    ["user_input", "model_output", "user_input"],
    "multi-turn history must keep the Interactions timeline step schema"
  );
  const events = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/05_translation_result/stream-events.json"), "utf8"));
  const textEvent = P.parseGeminiInteractionEvent(events[0]);
  const thoughtEvent = P.parseGeminiInteractionEvent(events[1]);
  const doneEvent = P.parseGeminiInteractionEvent(events[2]);
  assert.equal(textEvent.text, "翻译");
  assert.equal(thoughtEvent.reasoning, "正在检查术语");
  assert(doneEvent.done && doneEvent.text === "翻译正文");
  assert.equal(doneEvent.usage.reasoningTokens, 5);
  assert.equal(doneEvent.usage.totalTokens, 120);
  assert.equal(P.providerHeaders(geminiConfig)["x-goog-api-key"], "secret");
  assert(!("Authorization" in P.providerHeaders(geminiConfig)));
  const modelRecords = P.filterTextModels([
    { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3-pro-image", outputModalities: ["IMAGE"] },
    { name: "models/gemini-3.1-flash-tts-preview", outputModalities: ["AUDIO"] },
    { name: "models/text-embedding-004" }
  ], "gemini");
  assert.deepEqual(modelRecords.map(item => item.id), ["gemini-3.5-flash"]);

  const ui = P.createWorkbenchUIState();
  const layoutUI = P.applyModeToWorkbench(ui, "layout");
  assert(layoutUI.layoutChildrenVisible);
  const pure = P.openProviderCardsDialog(P.openModelSettingsDialog(ui));
  assert.equal(pure.activeDialog, "provider-cards");
  const combo = P.ShowPopupSafely(P.SafeCombo(["a", "b"], "b"));
  assert(combo.popupOpen && combo.selected === "b");
  assert(P.OnComboDestroyed(combo).destroyed);
  assert.equal(P.layoutReaderContract(8).parsedSourceToggleAllowed, false);
  assert.equal(P.sourceKindForMode("stream"), "parsed-markdown");
  assert.equal(P.sourceKindForMode("layout"), "zotero-reader");

  const fakeProtector = { protect: bytes => Uint8Array.from([...bytes].reverse()), unprotect: bytes => Uint8Array.from([...bytes].reverse()) };
  const protectedSecret = P.protectSecret("密钥", fakeProtector);
  assert.equal(P.unprotectSecret(protectedSecret, fakeProtector), "密钥");
  assert.throws(() => P.protectSecret("x"), error => error?.code === "HOST_ADAPTER");
  const style = P.applyElevation({ classes: ["panel"], stylesheet: "" });
  assert(style.classes.includes("litmtrans-elevated"));
  assert(!P.removeElevation(style).classes.includes("litmtrans-elevated"));
  assert(P.applyMonochromeAppStyle("").includes("--litmtrans-accent"));
  assert(P.installSearchAgentDialogStyleFilter("").includes("agent-dialog"));

  const secretValues = new Map();
  const secretStore = {
    has(scope, provider) { return secretValues.has(`${scope}|${provider}`); },
    get(scope, provider) { return secretValues.get(`${scope}|${provider}`) || ""; },
    set(scope, provider, value) { secretValues.set(`${scope}|${provider}`, value); },
    delete(scope, provider) { secretValues.delete(`${scope}|${provider}`); }
  };
  assert.equal(P.saveKey(secretStore, " mineru-test-token "), "mineru/official");
  assert.equal(secretStore.get("mineru", "official"), "mineru-test-token");

  const parseCalls = [];
  const documentTool = P.buildMineruDocumentToolAdapter({
    isConfigured: () => true,
    saveKey: token => `secret:${token.length}`,
    isSupportedInputFile: input => input.endsWith(".pdf"),
    createOutputDirectory: documentID => `cache/${documentID}`,
    async parse(inputPath, outputDirectory, context) {
      context.progress("parse", "fixture", 1, 1);
      parseCalls.push({ inputPath, outputDirectory });
      return P.newNormalizedDocument("worker-doc", "# Parsed");
    },
    latestTranslationPath: documentID => `cache/${documentID}/translated.md`,
    findStoredOriginal: documentID => `cache/${documentID}/original.pdf`,
    createReaderWindow: mode => P.readingModeContract(mode)
  });
  assert(documentTool.isConfigured());
  assert(documentTool.isSupportedInputFile("paper.pdf"));
  assert.throws(() => P.buildMineruDocumentToolAdapter({}), /缺少/);
  const workerProgress = [];
  const worker = P.createParseWorker(documentTool, "paper.pdf", "cache/worker-doc", event => workerProgress.push(event));
  const workerDocument = await worker.run();
  assert.equal(workerDocument.documentID, "worker-doc");
  assert.deepEqual(parseCalls, [{ inputPath: "paper.pdf", outputDirectory: "cache/worker-doc" }]);
  assert.equal(workerProgress[0].stage, "parse");
  worker.requestStop("fixture stop");
  assert(worker.isCancelled());
}

function testControllerConstruction() {
  const controller = context.LitMTrans.createController({
    id: "litmtrans@local",
    version: "1.0.0",
    rootURI: "file:///plugin/"
  });
  assert(controller.storage instanceof context.LitMTrans.Storage);
  assert(controller.secrets instanceof context.LitMTrans.Secrets);
  assert(controller.llm instanceof context.LitMTrans.LLMService);
  assert(controller.mineru instanceof context.LitMTrans.MinerUService);
  assert(controller.translation instanceof context.LitMTrans.TranslationService);
  assert(controller.layout instanceof context.LitMTrans.LayoutTranslationService);
  assert(controller.chat instanceof context.LitMTrans.ChatService);
  assert(controller.pipeline instanceof context.LitMTrans.DocumentPipeline);
}

  return {
    testAtomicEntryPublicationRollback,
    testPortedCore,
    testControllerConstruction,
  };
};
