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

async function testWebMachineTranslationProtection() {
  assert.strictEqual(WebMachineTranslation.isWebMachineProvider("free_machine"), true);
  const protectedText = WebMachineTranslation.protectInline(
    "See Eq. (16), <sup>7</sup>, $x^2$, https://example.org/a and ![Figure](image.png)."
  );
  assert(protectedText.placeholders.length >= 4, "web machine service must protect equations, citations, formulas, URLs and image syntax");
  const restoredInline = WebMachineTranslation.restoreInline(protectedText.output, protectedText.placeholders);
  for (const required of ["(16)", "<sup>7</sup>", "$x^2$", "https://example.org/a", "![Figure](image.png)"]) {
    assert(restoredInline.includes(required), `protected inline fragment was lost: ${required}`);
  }
  const encoded = WebMachineTranslation.encodeBatch([["a", "first"], ["b", "second"]]);
  assert.deepStrictEqual(
    { ...WebMachineTranslation.parseBatch(encoded.text, encoded.map) },
    { a: "first", b: "second" },
    "web machine batch sentinels must round-trip exactly"
  );
  const service = new WebMachineTranslationService();
  const echo = { currentProvider: "google_free", translate: async text => text };
  const translated = await service.translateMarkdown(
    "# ABSTRACT\n\nThe value is $x^2$ in Eq. (16). <sup>7</sup>\n",
    { targetLanguage: "简体中文", sourceLanguage: "英文", translator: echo }
  );
  assert(translated.startsWith("# 摘要"), "web machine stream path must retain deterministic academic headings");
  assert(translated.includes("$x^2$") && translated.includes("<sup>7</sup>") && translated.includes("(16)"), "web machine stream path must restore protected inline content");
  const records = await service.translateRecords([{ id: "r1", text: "FIGURE 2. Result $x^2$" }], {
    targetLanguage: "简体中文", sourceLanguage: "英文", translator: echo
  });
  assert(records.r1.startsWith("图 2."), "web machine layout path must normalize figure captions");
  assert(records.r1.includes("$x^2$"), "web machine layout path must preserve inline TeX");

  const progress = [];
  await service.translateRecords([
    { id: "heading", text: "ABSTRACT" },
    { id: "symbol", text: "123" },
    { id: "body", text: "A normal paragraph." }
  ], {
    targetLanguage: "简体中文",
    sourceLanguage: "英文",
    translator: echo,
    liveUpdate: value => progress.push(value)
  });
  assert(progress[0].includes("已处理：1/3"), "layout progress must include records handled by local rules");
  assert(progress.at(-1).includes("已处理：3/3"), "layout progress must finish at the displayed total");
}

async function testEdgeLocalTranslationMigration() {
  assert.equal(U.normalizeProviderID("edge_local"), "edge_local");
  assert.equal(U.providerSpec("edge_local").supportsChat, false);
  assert.equal(U.isWebMachineProvider("edge_local"), true, "Edge must use the document machine-translation route");
  assert.equal(EdgeLocalTranslation.languageCode("英文"), "en");
  assert.equal(EdgeLocalTranslation.languageCode("英语"), "en");
  assert.equal(EdgeLocalTranslation.languageCode("简体中文"), "zh-Hans");
  assert.equal(EdgeLocalTranslation.languageCode("德文"), "de");
  assert.equal(
    EdgeLocalTranslation.normalizeOCRSource("where ܦ, ܹ, ܴ, ݐ, ܽ and ݑ are variables", "英文"),
    "where D, W, R, t, a and u are variables",
    "English Edge input must repair common mathematical letters misread as Syriac glyphs"
  );
  assert.equal(
    EdgeLocalTranslation.normalizeOCRSource("ܦ", "阿拉伯文"),
    "ܦ",
    "OCR confusable repair must not rewrite non-English source text"
  );
  assert.equal(
    EdgeLocalTranslation.replaceOCRReplacementCharacters("via �NN search"),
    "via ?NN search",
    "Edge input must safely replace the OCR replacement character before translation"
  );
  assert.equal(U.normalizeLanguageName("日语"), "日文");
  assert.equal(U.normalizeLanguageName("custom-language"), "custom-language");
  const preferenceLanguageMarkup = fs.readFileSync(path.join(root, "src", "preferences.xhtml"), "utf8");
  const workbenchLanguageMarkup = fs.readFileSync(path.join(root, "src", "workbench.xhtml"), "utf8");
  assert(preferenceLanguageMarkup.includes('id="litmtrans-pref-target-language-picker" class="litmtrans-language-picker"')
    && preferenceLanguageMarkup.includes('id="litmtrans-pref-machine-source-language-picker" class="litmtrans-language-picker"'),
  "preferences must expose editable source and target language suggestion lists");
  assert(workbenchLanguageMarkup.includes('id="setting-target-language-picker" class="language-picker"')
    && workbenchLanguageMarkup.includes('id="setting-machine-source-language-picker" class="language-picker"'),
  "workbench must expose editable source and target language suggestion lists");
  assert(workbenchLanguageMarkup.includes('<details id="settings-advanced" class="settings-advanced">')
    && !workbenchLanguageMarkup.includes('<details id="settings-advanced" class="settings-advanced" open'),
  "workbench advanced settings must use a collapsed details disclosure by default");
  assert(preferenceLanguageMarkup.includes('<html:details id="litmtrans-pref-advanced" class="litmtrans-pref-advanced">')
    && !preferenceLanguageMarkup.includes('<html:details id="litmtrans-pref-advanced" class="litmtrans-pref-advanced" open'),
  "Zotero preferences must mirror the collapsed advanced-settings disclosure");
  assert(!workbenchLanguageMarkup.includes("必须设置")
    && !preferenceLanguageMarkup.includes("必须设置")
    && workbenchLanguageMarkup.includes("请配置访问令牌，用于解析文献内容，是必要的设置内容"),
  "settings surfaces must use the gentler MinerU token guidance without a required badge");
  assert(workbenchLanguageMarkup.indexOf('id="setting-api-key"') < workbenchLanguageMarkup.indexOf('id="setting-base-url"')
    && preferenceLanguageMarkup.indexOf('id="litmtrans-pref-api-key"') < preferenceLanguageMarkup.indexOf('id="litmtrans-pref-base-url"'),
  "translation API keys must appear before API addresses in both settings surfaces");
  assert(workbenchLanguageMarkup.includes('id="setting-mineru-model" type="hidden" value="vlm"')
    && preferenceLanguageMarkup.includes('id="litmtrans-pref-mineru-model" type="hidden" value="vlm"')
    && !workbenchLanguageMarkup.includes('<option value="pipeline">')
    && !preferenceLanguageMarkup.includes('<html:option value="pipeline">'),
  "MinerU model selection must stay hidden and fixed to the supported VLM model");
  assert(workbenchLanguageMarkup.includes("记忆卡片")
    && workbenchLanguageMarkup.includes('id="provider-card-api-key-state"')
    && !workbenchLanguageMarkup.includes("连接配置")
    && !workbenchLanguageMarkup.includes("留空则保留"),
  "memory cards must expose explicit API-key state without legacy ambiguous copy");
  const workbenchSettingsCSS = fs.readFileSync(path.join(root, "src", "workbench.css"), "utf8");
  const workbenchSettingsCode = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");
  const preferenceSettingsCSS = fs.readFileSync(path.join(root, "src", "preferences.css"), "utf8");
  const controllerCode = fs.readFileSync(path.join(root, "src", "controller.js"), "utf8");
  assert(workbenchLanguageMarkup.includes('id="open-token-guide-button"')
    && preferenceLanguageMarkup.includes('id="litmtrans-pref-open-token-guide"')
    && !workbenchLanguageMarkup.includes("密钥保存在Zotero/Firefox的本地登录存储。")
    && controllerCode.includes('assets/docs/token-guide.pdf')
    && controllerCode.includes('case "open-token-guide"'),
  "both settings surfaces must open the packaged token guide with the default application");
  assert(workbenchSettingsCSS.includes(".settings-modal { min-height: 0; height: fit-content; }")
    && workbenchSettingsCSS.includes(".settings-modal .settings-grid { max-height: calc(100vh - 170px); }")
    && !workbenchSettingsCSS.includes(".settings-modal { height: min(860px"),
  "settings dialogs must fit collapsed content instead of reserving an empty full-height body");
  assert(workbenchSettingsCode.includes("function fitSettingsDialog(dialog)")
    && workbenchSettingsCode.includes('const desired = Math.min(available, Math.ceil(card.scrollHeight));')
    && workbenchSettingsCode.includes('els["settings-advanced"].addEventListener("toggle"'),
  "the main settings dialog must be remeasured after opening and when advanced settings change");
  assert(workbenchSettingsCSS.includes(".settings-card-chat { --settings-section: #8661c1; grid-column: 1; grid-row: 2; }")
    && workbenchSettingsCSS.includes(".settings-card-model { --settings-section: #5368d9; grid-column: 2; grid-row: 1 / span 2; }"),
  "workbench chat settings must remain directly below MinerU while the translation model occupies the right rail");
  assert(preferenceSettingsCSS.includes(".litmtrans-pref-card-chat")
    && preferenceSettingsCSS.includes("grid-column: 1; grid-row: 2;")
    && preferenceSettingsCSS.includes(".litmtrans-pref-card-model { grid-column: 2; grid-row: 1 / span 2; }"),
  "Zotero preferences must mirror the workbench two-rail settings layout");

  const calls = [];
  const echoEdge = {
    currentProvider: "edge_local",
    maxChars: 3000,
    async translate(text) { calls.push(text); return text; }
  };
  const service = new WebMachineTranslationService();
  const translated = await service.translateMarkdown(
    "A first paragraph with $x^2$.\n\nA second paragraph cites Eq. (16).",
    { provider: "edge_local", targetLanguage: "简体中文", sourceLanguage: "英文", translator: echoEdge }
  );
  assert.equal(calls.length, 2, "Edge must translate every protected block exactly once");
  assert(calls.every(text => !text.includes("[[[ZXA") && !text.includes("[[[ZXZ")),
    "Edge must not receive the packed batch sentinels that its local model rewrites");
  assert(translated.includes("$x^2$") && translated.includes("(16)"));
  await service.translateRecords([{
    id: "python-compatible-formula",
    text: "The density is \\(1 . 6 5 ~ \\mathrm { g } / \\mathrm { c m } ^ { 3 } ;\\)."
  }], {
    provider: "edge_local", targetLanguage: "简体中文", sourceLanguage: "英文", translator: echoEdge
  });
  assert(calls.at(-1).includes("ZXQH008F0F284876HQXZ"),
    "Edge layout formulas must use the same placeholder digest as Python's equivalent $...$ form");

  const OriginalEdgeTranslator = context.LitMTrans.EdgeLocalTranslator;
  const previousAppInfo = context.Services.appinfo;
  context.Services.appinfo = { OS: "WINNT" };
  try {
    const lifecycleCommands = [];
    const lifecycle = new OriginalEdgeTranslator("简体中文", "英文", {
      runSystemCommand: async (name, arguments_) => {
        lifecycleCommands.push([name, [...arguments_]]);
        if (name === "netstat.exe") {
          return "TCP    127.0.0.1:49152    0.0.0.0:0    LISTENING    4242\r\n";
        }
        return "";
      }
    });
    assert.equal(await lifecycle.edgePIDForDebugPort(49152), 4242,
      "Edge cleanup must follow the process that owns the private DevTools port");
    const closeCalls = [];
    lifecycle.connection = {
      async command(method, params, options) { closeCalls.push([method, params, options]); },
      close() { closeCalls.push(["socket.close"]); }
    };
    lifecycle.process = { pid: 3131, exitCode: null, async kill() { closeCalls.push(["process.kill"]); } };
    lifecycle.edgeProcessPID = 4242;
    lifecycle.pidIsRunning = async pid => {
      closeCalls.push(["pidIsRunning", pid]);
      return false;
    };
    await lifecycle.close();
    assert.equal(closeCalls[0][0], "Browser.close", "Edge must be asked to flush and close through CDP first");
    assert(closeCalls.some(call => call[0] === "pidIsRunning" && call[1] === 4242),
      "shutdown must prefer the debug-port owner over the possibly stale launch PID");
    assert(!closeCalls.some(call => call[0] === "process.kill"), "an Edge process that exited cleanly must not be killed");
    assert(lifecycleCommands.some(([name]) => name === "netstat.exe"));

    const availabilityProbe = new OriginalEdgeTranslator("简体中文", "英文");
    let availabilityProbeClosed = 0;
    availabilityProbe.evaluate = async () => "downloadable";
    availabilityProbe.close = async () => { availabilityProbeClosed++; };
    await assert.rejects(() => availabilityProbe.ensureAvailable(null), /尚未下载/);
    assert.equal(availabilityProbeClosed, 1,
      "the no-download availability probe must close Edge before consent or cached-model activation");

    let consentRequests = 0;
    const declined = new OriginalEdgeTranslator("简体中文", "英文", {
      downloadConsent: async () => { consentRequests++; return false; }
    });
    declined.ensureAvailable = async () => { throw new Error("Edge本地翻译语言模型尚未下载。"); };
    declined.hasCachedLanguageModel = async () => false;
    await assert.rejects(() => declined.ensureSession(null), /用户未同意/);
    await assert.rejects(() => declined.ensureSession(null), /用户未同意/);
    assert.equal(consentRequests, 1, "a declined model download must only prompt once per Edge job");

    const retryMessages = [];
    const emptyResultRetry = new OriginalEdgeTranslator("简体中文", "英文", {
      log: message => retryMessages.push(message)
    });
    emptyResultRetry.ensureSession = async () => {};
    const retryResults = ["", "第一段", "第二段"];
    let retryCalls = 0;
    emptyResultRetry.evaluate = async () => retryResults[retryCalls++];
    let retryClosed = false;
    emptyResultRetry.close = async () => { retryClosed = true; };
    assert.equal(
      await emptyResultRetry.translate("The first clause contains a variable.\nThe second clause explains the result."),
      "第一段\n第二段",
      "an empty Edge result must retry the source as smaller pieces"
    );
    assert.equal(retryCalls, 3, "empty-result recovery must retry both split pieces in the existing Edge session");
    assert.equal(retryClosed, false, "successful empty-result recovery must keep the Edge session alive");
    assert(retryMessages.some(message => message.includes("拆分该文本块重试")));

    const unchangedInput = new OriginalEdgeTranslator("简体中文", "英文");
    unchangedInput.ensureSession = async () => {};
    const unchangedExpressions = [];
    unchangedInput.evaluate = async expression => {
      unchangedExpressions.push(expression);
      return "正常译文";
    };
    assert.equal(await unchangedInput.translate("A Syriac quotation keeps ܦ intact."), "正常译文");
    assert.equal(unchangedExpressions.length, 1, "a successful block must be sent to Edge only once");
    assert(unchangedExpressions[0].includes("ܦ"), "a successful block must reach Edge without OCR rewriting");

    const failedBlockNormalization = new OriginalEdgeTranslator("简体中文", "英文");
    failedBlockNormalization.ensureSession = async () => {};
    const normalizedExpressions = [];
    failedBlockNormalization.evaluate = async expression => {
      normalizedExpressions.push(expression);
      return normalizedExpressions.length === 1 ? "" : "纠正后译文";
    };
    assert.equal(await failedBlockNormalization.translate("where ܦ is the water depth"), "纠正后译文");
    assert.equal(normalizedExpressions.length, 2, "OCR normalization must run only after the original block returns empty");
    assert(normalizedExpressions[0].includes("ܦ") && normalizedExpressions[1].includes("where D is"),
      "only the failed retry may receive normalized OCR glyphs");

    const replacementCharacterRetry = new OriginalEdgeTranslator("简体中文", "英文");
    const replacementExpressions = [];
    replacementCharacterRetry.ensureSession = async () => {};
    replacementCharacterRetry.evaluate = async expression => {
      replacementExpressions.push(expression);
      return "安全替换后的译文";
    };
    assert.equal(await replacementCharacterRetry.translate("via �NN search"), "安全替换后的译文");
    assert.equal(replacementExpressions.length, 1, "a replacement character must be fixed before the first Edge request");
    assert(replacementExpressions[0].includes("via ?NN search") && !replacementExpressions[0].includes("�"),
      "Edge must receive the safe replacement rather than the OCR replacement character");

    const placeholderErrorRetry = new OriginalEdgeTranslator("简体中文", "英文");
    let placeholderSessionStarts = 0;
    let placeholderSessionCloses = 0;
    placeholderErrorRetry.ensureSession = async () => { placeholderSessionStarts++; };
    placeholderErrorRetry.close = async () => { placeholderSessionCloses++; };
    const placeholderExpressions = [];
    placeholderErrorRetry.evaluate = async expression => {
      placeholderExpressions.push(expression);
      if (placeholderExpressions.length === 1) {
        throw new EdgeLocalTranslation.EdgeLocalTranslationError(
          "Edge本地翻译错误：UnknownError: Other generic failures occurred."
        );
      }
      return "译文保留 LTMKEEP00";
    };
    const longPlaceholder = "ZXQH001E4E0FC897HQXZ";
    assert.equal(
      await placeholderErrorRetry.translate(`The density is ${longPlaceholder}.`),
      `译文保留 ${longPlaceholder}`,
      "an Edge UnknownError caused by a long protected marker must retry with a short marker and restore it"
    );
    assert.equal(placeholderExpressions.length, 2, "placeholder recovery must be limited to the failed block");
    assert.equal(placeholderSessionStarts, 2, "a poisoned Edge Translator object must be recreated before retry");
    assert.equal(placeholderSessionCloses, 1, "placeholder recovery must close the failed Edge session exactly once");
    assert(placeholderExpressions[0].includes(longPlaceholder) && placeholderExpressions[1].includes("LTMKEEP00"),
      "the original protected input must be attempted before its short-marker retry");

    const genericPromiseRetry = new OriginalEdgeTranslator("简体中文", "英文");
    let genericSessionStarts = 0;
    let genericSessionCloses = 0;
    const genericExpressions = [];
    genericPromiseRetry.ensureSession = async () => { genericSessionStarts++; };
    genericPromiseRetry.close = async () => { genericSessionCloses++; };
    genericPromiseRetry.evaluate = async expression => {
      genericExpressions.push(expression);
      if (genericExpressions.length === 1) {
        throw new EdgeLocalTranslation.EdgeLocalTranslationError("Edge本地翻译错误：Uncaught (in promise)");
      }
      return "恢复后的译文";
    };
    const plainSource = "A plain paragraph without protected content.";
    assert.equal(await genericPromiseRetry.translate(plainSource), "恢复后的译文");
    assert.equal(genericExpressions.length, 2, "a generic Edge promise error must retry once after rebuilding the session");
    assert(genericExpressions.every(expression => expression.includes(plainSource)),
      "a generic Edge retry must preserve the original text when no protected marker exists");
    assert.equal(genericSessionStarts, 2);
    assert.equal(genericSessionCloses, 1);

    const persistentPromiseRetry = new OriginalEdgeTranslator("简体中文", "英文");
    const persistentSource = "The first half contains enough words to form a useful fragment while the second half remains translatable.";
    const persistentExpressions = [];
    persistentPromiseRetry.ensureSession = async () => {};
    persistentPromiseRetry.close = async () => {};
    persistentPromiseRetry.evaluate = async expression => {
      persistentExpressions.push(expression);
      if (expression.includes(persistentSource)) {
        throw new EdgeLocalTranslation.EdgeLocalTranslationError("Edge本地翻译错误：Uncaught (in promise)");
      }
      return "分段译文";
    };
    assert.equal(await persistentPromiseRetry.translate(persistentSource), "分段译文 分段译文");
    assert.equal(persistentExpressions.length, 4, "a persistent generic Edge error must split the local request after one rebuilt-session retry");
    assert(EdgeLocalTranslation.splitEdgeLocalRetryText(persistentSource),
      "the Edge recovery splitter must retain two substantial text fragments");

    const persistentPlaceholderRetry = new OriginalEdgeTranslator("简体中文", "英文");
    const protectedMarker = "ZXQH001E4E0FC897HQXZ";
    const protectedSource = `The formula ${protectedMarker} appears here.`;
    persistentPlaceholderRetry.ensureSession = async () => {};
    persistentPlaceholderRetry.close = async () => {};
    persistentPlaceholderRetry.evaluate = async expression => {
      if (expression.includes(protectedMarker) || expression.includes("LTMKEEP00")) {
        throw new EdgeLocalTranslation.EdgeLocalTranslationError("Edge本地翻译错误：UnknownError: Other generic failures occurred.");
      }
      return "分段译文";
    };
    assert.equal(await persistentPlaceholderRetry.translate(protectedSource), `分段译文${protectedMarker}分段译文`);
  }
  finally {
    context.Services.appinfo = previousAppInfo;
  }

  let active = 0;
  let maximumActive = 0;
  let closed = 0;
  class FakeEdgeTranslator {
    constructor(_targetLanguage, sourceLanguage) {
      assert.equal(sourceLanguage, "英文");
      this.currentProvider = "edge_local";
      this.maxChars = 3000;
      active++;
      maximumActive = Math.max(maximumActive, active);
    }
    async translate(text) {
      await new Promise(resolve => setTimeout(resolve, 5));
      return text;
    }
    async close() {
      if (!this.closed) {
        this.closed = true;
        active--;
        closed++;
      }
    }
    async endJob() { await this.close(); }
  }
  context.LitMTrans.EdgeLocalTranslator = FakeEdgeTranslator;
  try {
    const serialized = new WebMachineTranslationService({ edgeDownloadConsent: async () => true });
    await Promise.all([
      serialized.translateMarkdown("The first concurrent Edge document.", { provider: "edge_local", targetLanguage: "简体中文", sourceLanguage: "英文" }),
      serialized.translateMarkdown("The second concurrent Edge document.", { provider: "edge_local", targetLanguage: "简体中文", sourceLanguage: "英文" })
    ]);
    assert.equal(maximumActive, 1, "one Edge profile must never be opened by concurrent Zotero translation jobs");
    assert.equal(closed, 2, "every Edge document job must close its browser session");
  }
  finally {
    context.LitMTrans.EdgeLocalTranslator = OriginalEdgeTranslator;
  }
}

async function testWebMachineRulesAndSettingsTransitions() {
  assert.equal(U.normalizeProviderID("google_free"), "free_machine");
  assert.equal(U.normalizeProviderID("bing_free"), "free_machine");
  assert.equal(U.normalizeProviderID("legacy_web"), "free_machine");
  assert.equal(U.providerSpec("free_machine").supportsChat, false);

  const storage = new MemoryStorage();
  const events = [];
  let webCalls = 0;
  let webOptions = null;
  const webMachine = {
    async translateMarkdown(_markdown, options) {
      webCalls++;
      webOptions = options;
      return "# 译文";
    }
  };
  const webSettings = {
    provider: "free_machine",
    baseURL: "",
    model: "",
    sourceLanguage: "自动识别",
    targetLanguage: "简体中文",
    translationReferencePaths: ["/refs/domain.md"],
    customTranslationInstruction: "不要使用这条指令"
  };
  const translation = new TranslationService(storage, { getSettings: () => ({}) }, null, webMachine);
  const first = await translation.translate("web-rules", "# Source\n\nA paragraph.", webSettings, event => events.push(event));
  assert.equal(first.markdown, "# 译文");
  assert.equal(webCalls, 1);
  assert.equal(webOptions.customTranslationInstruction, undefined);
  assert.equal(webOptions.translationReferencePaths, undefined);
  assert(events.some(event => event.type === "log" && event.message.includes("参考文件")));
  assert(events.some(event => event.type === "log" && event.message.includes("自定义翻译要求")));

  const cached = await translation.translate("web-rules", "# Source\n\nA paragraph.", {
    ...webSettings,
    translationReferencePaths: ["/refs/another.md"],
    customTranslationInstruction: "换一条也不应改变机翻缓存"
  });
  assert.equal(cached.cached, true, "web-machine cache identity must ignore references and custom instructions");
  assert.equal(webCalls, 1, "ignored web-machine context must not invalidate the machine translation cache");

  let referenceCalled = false;
  let layoutOptions = null;
  const pipeline = new DocumentPipeline({
    storage: { appendProcessLog: async () => {} },
    mineru: { loadParsed: async () => ({ hasLayout: true }) },
    translation: {
      async buildReferenceCorpus() {
        referenceCalled = true;
        throw new Error("web machine must bypass reference corpus construction");
      }
    },
    layout: {
      async translate(_documentID, options) {
        layoutOptions = options;
        return { ok: true };
      }
    },
    chat: {},
    getSettings: () => webSettings
  });
  await pipeline.translateLayout({ documentID: "web-layout" });
  assert.equal(referenceCalled, false, "layout web-machine route must not parse reference files");
  assert.equal(layoutOptions.referenceContext, "");
  assert.equal(layoutOptions.customTranslationInstruction, "");

  const preferenceSnapshot = new Map(prefValues);
  try {
    const secretValues = new Map();
    const secrets = {
      has: key => secretValues.has(key),
      get: key => secretValues.get(key) || "",
      set: (key, value) => secretValues.set(key, value),
      remove: key => secretValues.delete(key),
      llmKeyName: provider => `llm:${provider}`,
      getLLMKey: provider => secretValues.get(`llm:${provider}`) || "",
      setLLMKey: (provider, value) => secretValues.set(`llm:${provider}`, value),
      removeLLMKey: provider => secretValues.delete(`llm:${provider}`),
      getMinerUToken: () => "",
      hasMinerUToken: () => false,
      setMinerUToken() {},
      removeMinerUToken() {}
    };
    const controller = context.LitMTrans.createController({
      id: "litmtrans@local",
      version: "1.0.0",
      rootURI: "file:///plugin/"
    });
    controller.secrets = secrets;
    controller.llm = new LLMService(secrets);
    controller.llm.saveSettings({
      provider: "oneapi", baseURL: "https://chat.example/v1", model: "chat-kept",
      thinkingMode: "disabled", reasoningEffort: "low"
    }, "chat");
    controller.llm.saveSettings({ provider: "free_machine", model: "" }, "translation");
    U.setPref("chatUsesTranslationModel", true);
    let settings = controller.getSettings();
    assert.equal(settings.translationProvider, "free_machine");
    assert.equal(settings.chatUsesTranslationModel, false, "machine translation must always release the chat model");
    assert.equal(settings.chatProvider, "oneapi");
    assert.throws(
      () => controller.llm.resolveConfig({ purpose: "chat", provider: "free_machine" }),
      /联网翻译仅用于文献翻译/
    );

    controller.saveSettings({
      translationProvider: "google_free",
      translationBaseURL: "",
      translationModel: "",
      translationThinkingMode: "default",
      translationReasoningEffort: "default",
      chatUsesTranslationModel: true,
      chatProvider: "oneapi",
      chatBaseURL: "https://chat.example/v1",
      chatModel: "chat-kept",
      chatThinkingMode: "disabled",
      chatReasoningEffort: "low",
      translationReferencePaths: ["/refs/domain.md"],
      customTranslationInstruction: "保留设置但机翻不执行"
    });
    settings = controller.getSettings();
    assert.equal(settings.translationProvider, "free_machine", "retired Google ID must migrate to combined web route");
    assert.equal(settings.chatUsesTranslationModel, false);
    assert.equal(settings.customTranslationInstruction, "保留设置但机翻不执行");

    controller.saveSettings({
      translationProvider: "edge_local",
      translationBaseURL: "",
      translationModel: "",
      targetLanguage: "英语",
      machineSourceLanguage: "日语",
      chatUsesTranslationModel: true
    });
    settings = controller.getSettings();
    assert.equal(settings.translationProvider, "edge_local");
    assert.equal(settings.targetLanguage, "英文", "known target-language aliases must be stored canonically");
    assert.equal(settings.machineSourceLanguage, "日文", "Edge source-language aliases must persist canonically without changing the LLM auto-detection setting");
    assert.equal(settings.sourceLanguage, "自动识别");
    assert.equal(settings.chatUsesTranslationModel, false);

    const card = controller.saveProviderCard({
      name: "恢复翻译服务",
      provider: "deepseek",
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "card-key"
    });
    controller.applyProviderCard(card.card.id, "translation");
    settings = controller.getSettings();
    assert.equal(settings.translationProvider, "deepseek");
    assert.equal(settings.chatUsesTranslationModel, true, "applying a translation card must also restore sharing after web machine mode");
    assert.equal(settings.chatProvider, "deepseek");

    controller.saveSettings({
      translationProvider: "bing_free",
      translationBaseURL: "",
      translationModel: "",
      chatUsesTranslationModel: true
    });
    assert.equal(controller.getSettings().chatUsesTranslationModel, false);

    controller.saveSettings({
      translationProvider: "deepseek",
      translationBaseURL: "https://api.deepseek.com/v1",
      translationModel: "translation-authority",
      translationThinkingMode: "enabled",
      translationReasoningEffort: "high",
      chatUsesTranslationModel: false,
      chatProvider: "oneapi",
      chatBaseURL: "https://chat.example/v1",
      chatModel: "old-dedicated-chat",
      chatThinkingMode: "disabled",
      chatReasoningEffort: "low",
      translationReferencePaths: ["/refs/domain.md"],
      customTranslationInstruction: "恢复大模型后继续使用"
    });
    settings = controller.getSettings();
    assert.equal(U.getPref("chatUsesTranslationModel", false), true, "returning from web machine must re-enable sharing");
    assert.equal(settings.chatUsesTranslationModel, true);
    assert.equal(settings.chatProvider, "deepseek");
    assert.equal(settings.chatModel, "translation-authority", "shared chat settings must use translation parameters as authority");
    assert.equal(settings.chatThinkingMode, "enabled");
    assert.equal(settings.chatReasoningEffort, "high");

    controller.saveSettings({
      translationProvider: "machine_translate",
      translationBaseURL: "",
      translationModel: "",
      translationThinkingMode: "default",
      translationReasoningEffort: "default",
      chatUsesTranslationModel: true,
      chatProvider: "deepseek",
      chatBaseURL: "https://api.deepseek.com",
      chatModel: "translation-authority",
      chatThinkingMode: "enabled",
      chatReasoningEffort: "high"
    });
    assert.equal(controller.getSettings().chatUsesTranslationModel, false, "selecting web machine must override a stale checked sharing flag");
  }
  finally {
    prefValues.clear();
    for (const [key, value] of preferenceSnapshot) prefValues.set(key, value);
  }

  const workbench = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");
  const preferences = fs.readFileSync(path.join(root, "src", "preferences.js"), "utf8");
  assert(workbench.includes("syncChatMode: true"), "workbench settings must synchronize sharing on provider transitions");
  assert(preferences.includes("syncChatMode: true"), "Zotero Preferences settings must synchronize sharing on provider transitions");
  assert(preferences.includes("supportsChat !== false"), "Zotero Preferences chat provider list must exclude web machine translation");
  const fastLayoutControl = preferences.slice(
    preferences.indexOf("updateDeepSeekFastLayoutControl()"),
    preferences.indexOf("syncChatSettingsFromTranslation()")
  );
  assert(fastLayoutControl.includes("group.hidden = !available"),
    "DeepSeek fast-layout visibility must still follow the selected translation service");
  assert(!fastLayoutControl.includes('this.$("thinking-mode")')
    && !fastLayoutControl.includes('this.$("reasoning-effort")'),
  "DeepSeek fast layout must not mutate or lock the persisted reasoning controls");
  const workbenchFastLayoutControl = workbench.slice(
    workbench.indexOf("function updateDeepSeekFastLayoutControl()"),
    workbench.indexOf("function syncChatSettingsFromTranslation()")
  );
  assert(workbenchFastLayoutControl.includes("group.hidden = !available"),
    "workbench DeepSeek fast-layout visibility must still follow the selected translation service");
  assert(!workbenchFastLayoutControl.includes('els["setting-thinking-mode"]')
    && !workbenchFastLayoutControl.includes('els["setting-reasoning-effort"]'),
  "workbench DeepSeek fast layout must not mutate or lock the persisted reasoning controls");
}

async function testFullContextResume() {
  const storage = new MemoryStorage();
  const settings = {
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    sourceLanguage: '英文',
    targetLanguage: '简体中文',
    translationMode: 'full_context',
    force: false
  };
  const marker = 'LitMTrans_TRANSLATION_END_123_456';
  let calls = 0;
  const llm = {
    getSettings: () => settings,
    async complete(messages, options) {
      calls++;
      assert(messages.some(message => message.role === 'assistant' && message.content === '第一部分'));
      const text = `第二部分\n${marker}`;
      options.onText?.(text);
      return { text, reasoning: '' };
    }
  };
  const service = new TranslationService(storage, llm);
  const markdown = '# Paper\n\nSource.';
  const paths = service.paths('doc', settings.targetLanguage);
  const identity = service.translationIdentity(markdown, settings, 'full_context');
  await storage.writeJSON(paths.meta, { identity, complete: false, marker, startedAt: '2026-01-01T00:00:00.000Z' });
  await storage.writeJSON(paths.state, { identity, complete: false, marker, round: 1 });
  await storage.writeJSON(paths.transcript, [
    { role: 'system', content: 'system' },
    { role: 'user', content: markdown },
    { role: 'assistant', content: '第一部分' },
    { role: 'user', content: 'continue' }
  ]);
  const result = await service.translateFullContext('doc', markdown, settings, paths, identity, null, null);
  assert.equal(calls, 1);
  assert(result.markdown.includes('第一部分'));
  assert(result.markdown.includes('第二部分'));
  assert.equal(result.meta.rounds, 2);
}

async function testChunkedStreamingConcurrencyContinuationAndCache() {
  const storage = new MemoryStorage();
  const settings = {
    provider: "deepseek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-chat",
    sourceLanguage: "英文",
    targetLanguage: "简体中文",
    translationMode: "chunked",
    chunkChars: 1000,
    force: false,
    sourceFingerprint: "source-fingerprint",
    promptCacheKey: "cache-key",
    referenceContext: ""
  };
  const markdown = Array.from(
    { length: 7 },
    (_, index) => (
      `## Section ${index + 1}\n\n` +
      `Source chunk ${index + 1} has complete academic prose. ${"technical wording ".repeat(48)}\n\n`
    )
  ).join("");
  let active = 0;
  let maximumActive = 0;
  let requestCount = 0;
  const llm = {
    getSettings: () => settings,
    async complete(messages, options) {
      requestCount++;
      active++;
      maximumActive = Math.max(maximumActive, active);
      const serialized = JSON.stringify(messages);
      const chunkNumber = Number(serialized.match(/Source chunk (\d+)/)?.[1] || 0);
      const marker = serialized.match(/<<<\d{8}>>>/)?.[0];
      const assistantRounds = messages.filter(message => message.role === "assistant").length;
      await new Promise(resolve => setTimeout(resolve, Math.max(1, 12 - chunkNumber)));
      active--;
      const text = assistantRounds
        ? `译文-${chunkNumber}-B\n${marker}`
        : `译文-${chunkNumber}-A`;
      options.onText?.(text);
      return { text, reasoning: "" };
    }
  };
  const service = new TranslationService(storage, llm);
  service.buildGuide = async () => "统一术语指南";
  const identity = service.translationIdentity(markdown, settings, "chunked");
  const paths = service.paths("stream-doc", settings.targetLanguage);
  const first = await service.translateChunked(
    "stream-doc",
    markdown,
    settings,
    paths,
    identity,
    null,
    null
  );
  const firstRequestCount = requestCount;
  const second = await service.translateChunked(
    "stream-doc",
    markdown,
    settings,
    paths,
    identity,
    null,
    null
  );
  assert(maximumActive > 3 && maximumActive <= 500, `expected DeepSeek stream concurrency to exceed 3 and stay within 500, got ${maximumActive}`);
  assert.equal(firstRequestCount, 14, "seven chunks with short model output must each continue for a second round");
  assert.equal(requestCount, firstRequestCount, "a complete second run must use only chunk caches");
  assert.equal(first.markdown, second.markdown);
  for (let index = 1; index <= 7; index++) {
    const current = first.markdown.indexOf(`译文-${index}-A`);
    const next = index < 7 ? first.markdown.indexOf(`译文-${index + 1}-A`) : first.markdown.length;
    assert(current >= 0 && current < next, "out-of-order model responses must still publish chunks in source order");
    assert(first.markdown.includes(`译文-${index}-B`));
  }
  assert.equal(first.meta.concurrency, 500);
  assert.equal(first.meta.maxRoundsPerChunk, 64);
  assert.equal(TranslationInternals.STREAM_CHUNK_CONCURRENCY, 3);
  assert.equal(TranslationInternals.streamChunkConcurrency("gemini"), 3);
  assert.equal(TranslationInternals.streamChunkConcurrency("deepseek"), 500);
  assert.equal(TranslationInternals.streamChunkConcurrency("oneapi", "https://api.deepseek.com/v1"), 500);
}

async function testChunkedExtraFormulaWarnsWithoutWholeChunkRetry() {
  const storage = new MemoryStorage();
  const settings = {
    provider: "gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-test",
    sourceLanguage: "英文",
    targetLanguage: "简体中文",
    translationMode: "chunked",
    chunkChars: 10000,
    force: false,
    sourceFingerprint: "formula-source",
    promptCacheKey: "formula-cache",
    referenceContext: ""
  };
  let calls = 0;
  const llm = {
    getSettings: () => settings,
    async complete(messages, options) {
      calls++;
      const marker = JSON.stringify(messages).match(/<<<\d{8}>>>/)?.[0];
      const text = `译文保留 \\(x+y\\)，并额外标记 \\(Z\\)。\n${marker}`;
      options.onText?.(text);
      return { text, reasoning: "" };
    }
  };
  const events = [];
  const service = new TranslationService(storage, llm);
  service.buildGuide = async () => "统一术语指南";
  const markdown = "# Formula\n\nThe value is \\(x+y\\).";
  const identity = service.translationIdentity(markdown, settings, "chunked");
  const paths = service.paths("formula-warning-doc", settings.targetLanguage);

  await service.translateChunked(
    "formula-warning-doc",
    markdown,
    settings,
    paths,
    identity,
    event => events.push(event),
    null
  );

  assert.equal(calls, 1, "an additional formula must not re-send the complete source chunk");
  assert(
    events.some(event => event.phase === "formula-review-warning"),
    "the exact formula difference must remain visible as a review warning"
  );
}

async function testEdgeLocalTranslationQualityHardening() {
  // 1. 占位符容错还原：Edge 漏掉 1 个十六进制字符时仍能准确还原
  const token = "ZXQH017537231F40HQXZ";
  const damaged = "影响超过50%(ZXQH017537231F4HQXZ,仅 32%)";
  const restored = WebMachineTranslation.restoreInline(damaged, [[token, "$R/R_0 = 17$"]]);
  assert.equal(restored, "影响超过50%($R/R_0 = 17$,仅 32%)", "容错还原必须匹配因模型吞字符而损坏的占位符");

  // 2. 伪标签剥除与冒号消噪
  const rawAcademic = "惯性子范围内的 -<b9000>/3幂律 在 PP9004></b9004> 中，水下爆炸。<sup>1–3</sup> :不同载荷... A. : 实验安排 图 5. 图:5 ,分别在";
  const normalized = WebMachineTranslation.normalizeAcademic("", rawAcademic, "简体中文");
  assert(!/<b\d+/i.test(normalized), "必须剥除 <b9000> 等伪标签碎片");
  assert(!/PP\d+/i.test(normalized), "必须剥除 PP9004 等碎片标签");
  assert(!/<sup>[^<]+<\/sup>\s*[:：]/.test(normalized), "必须安全剥除上标后的邻接多余冒号");
  assert(!/A\.\s*[:：]/.test(normalized), "必须安全剥除标题后的多余冒号");
  assert(normalized.includes("图 5. 分别在"), "必须规范化重复图号并移除多余冒号");

  // 3. 标题前缀规范化（绝无多余冒号）
  const headingA = WebMachineTranslation.normalizeAcademic("A. UNDEX shock wave on the beam", "A. : 梁上 UNDEX 冲击波", "简体中文");
  assert.equal(headingA, "A. 梁上 UNDEX 冲击波", "章节标题编号后不得含有多余冒号");
  const headingB = WebMachineTranslation.normalizeAcademic("B. The after flow on the beam", ": 梁上的后流", "简体中文");
  assert.equal(headingB, "B. 梁上的后流", "章节标题缺失标号或有冒号时应正确规范化");

  // 4. 公式说明“其中/式中”引导词与公式后冒号消噪
  const formulaDesc = WebMachineTranslation.normalizeAcademic("where $Q _ { T N T }$ is the mass of TNT.", "其中 : $Q _ { T N T }$ : 是 TNT 的质量。", "简体中文");
  assert.equal(formulaDesc, "其中 $Q _ { T N T }$ 是 TNT 的质量。", "公式说明中的其中与公式后冒号必须消除");
  const formulaDescTeX = WebMachineTranslation.normalizeAcademic("where \\(Q _ { T N T }\\) is the mass of TNT.", "其中 : \\(Q _ { T N T }\\) : 是 TNT 的质量。", "简体中文");
  assert.equal(formulaDescTeX, "其中 \\(Q _ { T N T }\\) 是 TNT 的质量。", "LaTeX行内公式说明后的冒号必须消除");

  // 5. 正文引用陈述句 vs 图表题注区分
  const bodySentence = WebMachineTranslation.normalizeAcademic(
    "Figure 5 shows the wall pressure-time history of the midship under the impact of UNDEX shock wave",
    "图:<sup>5</sup> ,分别显示了 R/R0=6, 10, 和17三个不同爆轰距离下船艏在UNDEX冲击波下的历史",
    "简体中文"
  );
  assert(bodySentence.startsWith("图 5 分别显示了"), "普通正文中的 Figure X shows 不得被当成题注拼出重复图号");

  const captionFig5 = WebMachineTranslation.normalizeAcademic(
    "FIG. 5. The wall pressure at midship under three different detonation distances:",
    "图 5. 图:<sup>5</sup> ,在三种不同爆轰距离下船艏的壁压:",
    "简体中文"
  );
  assert.equal(captionFig5, "图 5. 在三种不同爆轰距离下船艏的壁压:", "图表题注必须剥除重复图号与上标图号");

  const captionFig3 = WebMachineTranslation.normalizeAcademic(
    "FIG. 3. The arrangement of the UNDEX experiment.",
    ",, 图 3. UNDEX实验的排列方式",
    "简体中文"
  );
  assert.equal(captionFig3, "图 3. UNDEX实验的排列方式", "题注前孤立逗号必须剥除");

  // 6. 子图标签与末尾病态标点
  const subFigA = WebMachineTranslation.normalizeAcademic("", "(a) 实验船体梁型号 ::", "简体中文");
  assert.equal(subFigA, "(a) 实验船体梁型号", "必须剥除行末连续冒号");
  const subFigC = WebMachineTranslation.normalizeAcademic("", "(c) 顶视图 ,,", "简体中文");
  assert.equal(subFigC, "(c) 顶视图", "必须剥除行末连续逗号");
  const subFigAlone = WebMachineTranslation.normalizeAcademic("", "(a)  ,  :", "简体中文");
  assert.equal(subFigAlone, "(a)", "孤立子图标签后的病态逗号和冒号必须剥除");
  const subFigWithCap = WebMachineTranslation.normalizeAcademic("", "(d) 侧视图 : 图 2. 船体梁模型尺寸示意图(单位:mm).", "简体中文");
  assert.equal(subFigWithCap, "(d) 侧视图. 图 2. 船体梁模型尺寸示意图(单位:mm).", "子图与主图题注之间的冒号应规范化为句号");

  // 7. Markdown 图片前后孤立逗号清理
  const imgWithCaption = WebMachineTranslation.normalizeAcademic("", "![IMAGE_012](images/image_012.jpg) , , 图 3。UNDEX实验的排列方式", "简体中文");
  assert(imgWithCaption.includes("![IMAGE_012](images/image_012.jpg)\n\n图 3。UNDEX实验的排列方式"), "Markdown图片后病态孤立逗号必须消除为段落分隔");

  // 8. 通用连续循环重复去重
  const repeatedText = "在实验中,在相同条件下进行了三次重复测试。在实验中,在相同条件下进行了三次重复测试。在实验中,在相同条件下进行了三次重复测试。在实验中,在相同条件下进行了三次重复测试。";
  const deduped = WebMachineTranslation.normalizeAcademic("", repeatedText, "简体中文");
  assert.equal(deduped, "在实验中,在相同条件下进行了三次重复测试。", "必须抑制连续重复 >= 2 次的病态死循环");

  // 9. 质量问题检出
  const issues = WebMachineTranslation.qualityIssues("", "设计了具有两个自由ZXQH002E59A59E3HQXZ的截面<b9002>模型", "简体中文");
  assert(issues.includes("存在未还原保护标记"), "必须检出未还原的占位符");
  assert(issues.includes("存在异常标签残留"), "必须检出残留的异常标签");

  // 10. 公式变量说明中文谓词冒号消除与 Edge 翻译器伪标签清洗
  const formulaDescVerb = WebMachineTranslation.normalizeAcademic("where Q is mass.", "其中 : Q : 代表了质量。", "简体中文");
  assert.equal(formulaDescVerb, "其中 Q 代表了质量。", "公式变量说明后的中文谓词冒号必须消除");
  const cleanedDirty = new context.LitMTrans.EdgeLocalTranslator("简体中文", "英文").cleanTranslationResult("<b class=\"test\">PP9004></b9004>4>4>这是一个测试结果 ::，，");
  assert.equal(cleanedDirty, "这是一个测试结果", "必须彻底清理伪标签碎片与病态标点");
}

  return {
    testWebMachineTranslationProtection,
    testEdgeLocalTranslationMigration,
    testWebMachineRulesAndSettingsTransitions,
    testFullContextResume,
    testChunkedStreamingConcurrencyContinuationAndCache,
    testChunkedExtraFormulaWarnsWithoutWholeChunkRetry,
    testEdgeLocalTranslationQualityHardening,
  };
};
