"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const nodeCrypto = require("crypto");
const zlib = require("zlib");

const root = path.resolve(__dirname, "..");
const prefValues = new Map();
const context = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  AbortController,
  TextDecoder,
  TextEncoder,
  URL,
  URLSearchParams,
  fetch,
  crypto: {
    randomUUID: nodeCrypto.randomUUID
  },
  atob: value => Buffer.from(String(value), "base64").toString("binary"),
  btoa: value => Buffer.from(String(value), "binary").toString("base64"),
  PathUtils: {
    join: (...parts) => path.posix.join(...parts.map(part => String(part).replace(/\\/g, "/"))),
    parent: value => path.posix.dirname(String(value)),
    filename: value => path.posix.basename(String(value))
  },
  Zotero: {
    locale: "zh-CN",
    Profile: { dir: "/profile" },
    Prefs: {
      get: key => prefValues.get(key),
      set: (key, value) => prefValues.set(key, value),
      clear: key => prefValues.delete(key)
    },
    debug() {},
    logError(error) { throw error; }
  },
  Services: {
    prefs: {
      prefHasUserValue: key => prefValues.has(key),
      getBranch: prefix => ({
        getChildList: () => [...prefValues.keys()]
          .filter(key => key.startsWith(prefix))
          .map(key => key.slice(prefix.length))
      })
    }
  },
  Cc: {},
  Ci: {},
  IOUtils: {}
};
context.globalThis = context;
vm.createContext(context);

function load(relative) {
  const filename = path.join(root, relative);
  vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });
}

load("assets/vendor/pako/pako_inflate.min.js");
load("assets/vendor/pdf-lib/pdf-lib.min.js");
load("src/ported-core.js");

for (const file of [
  "src/utils.js",
  "src/storage.js",
  "src/secrets.js",
  "src/http.js",
  "src/markdown.js",
  "src/mindmap.js",
  "src/mindmap-v2.js",
  "src/flowchart.js",
  "src/mineru.js",
  "src/llm.js",
  "src/edge-local-translation.js",
  "src/web-machine-translation.js",
  "src/translation.js",
  "src/layout.js",
  "src/chat.js",
  "src/pipeline.js",
  "src/controller.js"
]) load(file);

const {
  Utils: U,
  Markdown: M,
  HTTP: H,
  LLMService,
  LLMInternals,
  TranslationService,
  TranslationInternals,
  WebMachineTranslationService,
  WebMachineTranslation,
  EdgeLocalTranslation,
  LayoutTranslationService,
  LayoutHelpers,
  MinerUService,
  MinerUInternals,
  Mindmap,
  MindmapV2,
  Flowchart,
  ChatService,
  ChatInternals,
  ControllerInternals,
  DocumentPipeline
} = context.LitMTrans;

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

function testOpenRouterModelPricing() {
  const priced = LLMInternals.translationModelOptions("openrouter", [{
    id: "example/paid-model",
    name: "Paid model",
    pricing: { prompt: "0.0000006", completion: "0.0000025" }
  }]);
  assert.equal(
    priced[0].priceText,
    "输入 $0.6 / 输出 $2.5（每百万 Tokens）",
    "OpenRouter's per-token pricing must be displayed in the conventional per-million-token unit"
  );
  assert.equal(LLMInternals.formatOpenRouterPricePerMillion("0.000000125"), "0.125");
  assert.equal(LLMInternals.formatOpenRouterPricePerMillion("not-a-price"), "");
  const free = LLMInternals.translationModelOptions("openrouter", [{
    id: "example/free-model:free",
    pricing: { prompt: "0e-7", completion: "0" }
  }]);
  assert.equal(free[0].priceText, "免费", "free OpenRouter models must retain their free label");
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

function testMindmap() {
  const map = Mindmap.parseMarkdownMindmap(`<!-- litmtrans-mindmap -->
# 论文核心
## 方法
- 双盲实验
  - 500 名参与者
## 结果
- 准确率提升 12%`);
  assert(map, "explicitly marked Markdown outlines must parse as mind maps");
  assert.equal(map.root.label, "论文核心");
  assert.equal(map.root.children[0].label, "方法");
  assert.equal(map.root.children[0].children[0].children[0].label, "500 名参与者");
  assert.equal(Mindmap.parseMarkdownMindmap("# 普通回答\n- 不应被当作导图"), null, "ordinary Markdown must remain a normal chat reply");
  assert.equal(Mindmap.parseMarkdownMindmap(`${Mindmap.MARKER}\n这不是大纲`), null, "a marker without a hierarchy must not create an empty map");
  const v2 = MindmapV2.parse(`${MindmapV2.MARKER}\n${JSON.stringify({ version: 2, mode: "paper_mindmap", title: "研究地图", nodes: [
    { id: "root", parentId: null, label: "核心贡献", kind: "root", importance: 3 },
    { id: "result", parentId: "root", label: "关键结果", detail: "与基线相比显著提升", kind: "result", importance: 3 }
  ] })}`);
  assert(!v2.error && v2.root.children[0].id === "result", "semantic Mindmap V2 must build a validated tree");
  const invalidV2 = MindmapV2.parse(`${MindmapV2.MARKER}\n{"version":2,"nodes":[{"id":"a","parentId":"b","label":"A"},{"id":"b","parentId":"a","label":"B"}]}`);
  assert(invalidV2.error, "cyclic V2 mind maps must fail gracefully");
  const latexEvidence = MindmapV2.parse(`${MindmapV2.MARKER}\n{"version":2,"nodes":[{"id":"root","parentId":null,"label":"结果","kind":"root","evidence":[{"type":"quote","quote":"The value is $T_{\\mathrm{b}}$."}]}]}`);
  assert(!latexEvidence.error, "bare LaTeX backslashes in model-provided mind-map evidence must be repaired");
  assert.equal(latexEvidence.root.evidence[0].quote, "The value is $T_{\\mathrm{b}}$.", "repairing model JSON must preserve the evidence quote");
}

function testFlowchart() {
  const chart = Flowchart.parseFlowchart(`<!-- litmtrans-flowchart -->
{"direction":"TB","nodes":[{"id":"start","type":"terminator","label":"开始"},{"id":"check","type":"decision","label":"还有元素？"},{"id":"body","type":"process","label":"处理元素"},{"id":"end","type":"terminator","label":"结束"}],"edges":[{"from":"start","to":"check"},{"from":"check","to":"body","label":"是"},{"from":"check","to":"end","label":"否"},{"from":"body","to":"check"}]}`);
  assert(!chart.error, "a flowchart with a decision and back edge must parse");
  assert.equal(chart.edges.at(-1).to, "check", "cycles must be retained as ordinary directed edges");
  assert(Flowchart.mermaidSource(chart).includes('lm_check@{ shape: diam, label: "还有元素？" };'), "decision nodes must use the robust Mermaid diamond shape syntax with parser-safe IDs");
  const tolerant = Flowchart.parseFlowchart(`${Flowchart.MARKER}\n{"nodes":[{"id":"noh3o","type":"process","label":"检查结果"}],"edges":[{"from":"no h3o","to":"noh3o"}]}`);
  assert.equal(tolerant.edges[0].from, "noh3o", "unambiguous spacing differences in model edge IDs should be repaired");
  const researchScale = Flowchart.parseFlowchart(`${Flowchart.MARKER}\n${JSON.stringify({
    nodes: Array.from({ length: 44 }, (_, index) => ({ id: `n${index}`, type: "process", label: `步骤 ${index + 1}` })),
    edges: []
  })}`);
  assert(!researchScale.error, "a 44-node research workflow must not be rejected by the safety limit");
  assert(Flowchart.parseFlowchart(`${Flowchart.MARKER}\n{"nodes":[{"id":"ok","type":"process","label":"步骤"}],"edges":[{"from":"ok","to":"missing"}]}`).error, "unknown edge endpoints must be rejected");
  const v2 = Flowchart.parseFlowchart(`${Flowchart.V2_MARKER}\n${JSON.stringify({ version: 2, mode: "paper_logic_flow", title: "研究逻辑", layout: "LR", nodes: [{ id: "gap", type: "process", role: "gap", label: "研究缺口" }, { id: "evidence", type: "io", role: "evidence", label: "关键证据", detail: "准确率相对基线提高 12%", evidence: [{ type: "quote", quote: "Accuracy increased by 12%." }] }], edges: [{ from: "gap", to: "evidence", relation: "motivates", label: "驱动" }] })}`);
  assert(!v2.error && v2.version === 2 && v2.nodes[1].type === "io", "flowchart V2 must retain distinct process and research semantics");
  assert.equal(v2.nodes[1].detail, "准确率相对基线提高 12%", "flowchart V2 must retain substantive node details for the interactive viewer");
  assert.equal(v2.nodes[1].evidence[0].quote, "Accuracy increased by 12%.", "flowchart V2 must retain evidence used by PDF location actions");
  const latexEvidence = Flowchart.parseFlowchart(`${Flowchart.V2_MARKER}\n{"version":2,"nodes":[{"id":"result","type":"process","role":"result","label":"方向结果","evidence":[{"type":"quote","quote":"The $0^{\\circ}$ direction is strongest and $R_{\\mathrm{b}}$ is measured."}]}],"edges":[]}`);
  assert(!latexEvidence.error, "bare LaTeX backslashes in model-provided flowchart evidence must be repaired");
  assert.equal(latexEvidence.nodes[0].evidence[0].quote, "The $0^{\\circ}$ direction is strongest and $R_{\\mathrm{b}}$ is measured.", "flowchart JSON repair must preserve evidence text");
  assert(Flowchart.mermaidSource(v2).includes('label: "关键证据：准确率相对基线提高 12%"'), "flowchart nodes must expose substantive detail without fragile Mermaid Markdown labels");
  assert(Flowchart.mermaidSource(v2).includes("class lm_evidence io;\nclass lm_evidence r_evidence;"), "node shape and research-role palettes must be assigned as distinct Mermaid classes");
  const flowchartSource = fs.readFileSync(path.join(root, "src", "flowchart.js"), "utf8");
  const evidencePanel = flowchartSource.match(/function showNodeEvidence[\s\S]*?\n  async function renderInteractive/)?.[0] || "";
  assert(flowchartSource.includes('element.classList.add("flowchart-node-interactive")')
    && flowchartSource.includes("function flowNodeElements(svg, chart)")
    && flowchartSource.includes("const nodeElements = flowNodeElements(svg, chart);")
    && !flowchartSource.includes('if (!evidence.length) continue;'),
  "Mermaid node-ID fallback must preserve both title/detail decoration and interaction for every flowchart node");
  assert(evidencePanel.includes('eyebrow.textContent = "原文证据"')
    && evidencePanel.includes("evidenceText(item)")
    && evidencePanel.includes("options.resolveEvidence(item)")
    && !evidencePanel.includes("node.detail")
    && !evidencePanel.includes("onAsk"),
  "expanding a flowchart node must reveal only verbatim evidence and its source-location action");
  const viewerSource = fs.readFileSync(path.join(root, "src", "diagram-viewer.js"), "utf8");
  const workbenchCSS = fs.readFileSync(path.join(root, "src", "workbench.css"), "utf8");
  assert(viewerSource.includes('centerOnElements(diagram, { behavior: "auto" })')
    && !viewerSource.includes("viewport.scrollLeft = 0; viewport.scrollTop = 0;"),
  "fitted diagrams must center their rendered bounds instead of resetting the viewport to the top-left corner");
  assert(!workbenchCSS.includes('content: "打开交互图"')
    && !viewerSource.includes("点击“证据”节点查看原文")
    && !flowchartSource.includes("flowchart-evidence-marker")
    && !workbenchCSS.includes("flowchart-evidence-marker"),
  "diagram UI must not narrate implemented interaction through redundant developer-facing hints");
}

function testDiagramEvidenceMatching() {
  const compiled = { model: { pages: [{ index: 10, width: 1000, height: 1400, blocks: [
    { id: "unrelated", text: "The experimental configuration and pressure measurements are described here.", bbox: [10, 20, 500, 80] },
    { id: "wall", text: "To sum up, the influence of the wall on the first period of bubble oscillation is greater than that on the bubble maximum radius in near-wall underwater explosion, and these influences decrease rapidly as the bubble is away from the wall.", bbox: [100, 200, 900, 360] }
  ] }] } };
  const fuzzy = ControllerInternals.compiledEvidenceMatches(compiled, { type: "quote", quote: "In the near-wall underwater explosion, the influence of the wall on the first period of bubble oscillation is greater than that on the bubble maximum radius in near-wall underwater explosion, and these influences decrease rapidly as the bubble is away from the wall." });
  assert(fuzzy?.approximate && fuzzy.blockID === "wall" && fuzzy.confidence >= .72, "a uniquely strong near-verbatim quote must fall back to an explicitly approximate PDF location");
  assert(fuzzy.highlightText.startsWith("In the near-wall"), "resolved quote locations must retain text for sentence-level PDF highlighting");
  const omitted = ControllerInternals.compiledEvidenceMatches(compiled, { type: "quote", quote: "influence of the wall...bubble maximum radius...away from the wall" });
  assert(omitted?.blockID === "wall" && omitted.approximate, "ellipsis-style AI quotes must resolve ordered fragments in one source block");
  const distant = ControllerInternals.compiledEvidenceMatches(compiled, { type: "quote", quote: "A substantially rewritten claim that shares almost no literal wording." });
  assert(distant?.resolved !== false && distant?.blockID && distant.approximate, "even a weak quote match must retain a nearest-location action for reader judgment");
  assert.deepEqual(ControllerInternals.findEvidenceSegmentRanges("prefix aaa middle bbb end ccc suffix", "aaa...bbb…ccc"), [{ start: 6, end: 9 }, { start: 15, end: 18 }, { start: 21, end: 24 }], "ASCII and Unicode ellipses must produce ordered sentence-fragment ranges");
  const ambiguous = { model: { pages: [{ index: 1, blocks: [{ id: "a", text: "This repeated evidence sentence contains the same important result for testing." }, { id: "b", text: "This repeated evidence sentence contains the same important result for testing." }] }] } };
  const nearest = ControllerInternals.compiledEvidenceMatches(ambiguous, { type: "quote", quote: "This repeated evidence sentence contains the same important result for testing." });
  assert(nearest?.approximate && nearest.blockID, "an ambiguous quote must still expose a visibly approximate nearest location");
}

async function testUtils() {
  assert.equal(U.isMinerUTokenCredentialError('HTTP 401: {"msgCode":"A0211","msg":"user token expired"}'), true);
  assert.equal(U.isMinerUTokenCredentialError({ status: 401, message: "Unauthorized" }), true);
  assert.equal(U.isMinerUTokenCredentialError("MinerU token无效，请重新配置"), true);
  assert.equal(U.isMinerUTokenCredentialError("HTTP 429: Too Many Requests"), false);
  prefValues.set("extensions.ai-literature-translator.provider", "deepseek");
  U.migrateLegacyPreferences();
  assert.equal(
    prefValues.get("extensions.litmtrans.provider"),
    "deepseek",
    "legacy preferences must migrate without deleting the old branch"
  );
  prefValues.set("extensions.ai-literature-translator.provider", "gemini");
  U.migrateLegacyPreferences();
  assert.equal(
    prefValues.get("extensions.litmtrans.provider"),
    "deepseek",
    "the one-time migration must not overwrite a current LitMTrans setting"
  );
  prefValues.delete("extensions.ai-literature-translator.provider");
  prefValues.delete("extensions.litmtrans.provider");
  prefValues.delete("extensions.litmtrans.migration.legacyPreferencesV1");
  assert.equal(U.normalizeBaseURL("https://openrouter.ai/api", "openrouter"), "https://openrouter.ai/api/v1");
  assert.equal(U.normalizeBaseURL("https://api.deepseek.com/chat/completions", "deepseek"), "https://api.deepseek.com");
  assert.equal(U.providerSpec("oneapi").defaultBaseURL, "");
  assert.equal(U.providerSpec("openai_compatible").name, "OpenAI 兼容接口");
  assert.equal(
    U.normalizeBaseURL("https://gateway.example/chat/completions", "openai_compatible"),
    "https://gateway.example/v1"
  );
  assert.equal(U.endpointURL("https://api.siliconflow.cn/v1", "models", "siliconflow"), "https://api.siliconflow.cn/v1/models?sub_type=chat");
  assert.equal(U.endpointURL("https://api.siliconflow.cn/v1", "chat/completions", "siliconflow"), "https://api.siliconflow.cn/v1/chat/completions");
  assert.equal(U.extension("paper.PDF"), ".pdf");
  assert(!U.safeStem("../bad:name", 80).includes("/"));
  const figureOneKey = U.imageAnchorKey("resource://litmtrans-data/doc/images/figure-1.png");
  const figureEightKey = U.imageAnchorKey("resource://litmtrans-data/doc/images/figure-8.png");
  const figureNineKey = U.imageAnchorKey("resource://litmtrans-data/doc/images/figure-9.png");
  assert.notEqual(figureOneKey, figureEightKey, "different image resources must never share a scroll anchor key");
  assert.deepEqual(
    [...U.sharedImageAnchorKeys(
      [figureOneKey, figureEightKey],
      [figureNineKey, figureOneKey]
    )],
    [figureOneKey],
    "scroll sync must match the same image resource even when pane image order differs"
  );
  assert.deepEqual(
    [...U.sharedImageAnchorKeys([figureOneKey], [figureEightKey])],
    [],
    "different figures at the same ordinal position must not be paired"
  );
  assert.deepEqual(
    [...U.sharedImageAnchorKeys(
      [figureOneKey, figureOneKey],
      [figureOneKey, figureOneKey]
    )],
    [],
    "repeated use of one image resource must be excluded when its occurrence cannot be paired unambiguously"
  );
  assert.equal(U.redactLocalPaths("来源: C:\\Users\\Alice\\paper.pdf"), "来源: [本地路径已隐藏]");
  assert.equal(U.redactLocalPaths("文件路径: \\\\server\\private\\notes.txt"), "文件路径: [本地路径已隐藏]");
  assert.equal(
    context.LitMTransPort.removeLocalAbsolutePaths("$$\\n\\begin{array}{l}a\\\\ = b\\end{array}\\n$$"),
    "$$\\n\\begin{array}{l}a\\\\ = b\\end{array}\\n$$",
    "TeX row breaks must not be mistaken for UNC paths"
  );
  assert.equal(
    context.LitMTransPort.removeLocalAbsolutePaths("来源: C:\\Users\\Alice\\paper.pdf；共享：\\\\server\\private\\notes.txt"),
    "来源: [本地路径已隐藏]",
    "Windows drive and UNC paths must remain redacted"
  );
  assert.equal(
    context.LitMTransPort.removeLocalAbsolutePaths("在线查看: http:\\\\doi.org\\10.1063/1.1421630"),
    "在线查看: http:\\\\doi.org\\10.1063/1.1421630",
    "OCR-damaged citation URLs must not be mistaken for UNC paths"
  );
  assert.equal(
    context.LitMTransPort.removeLocalAbsolutePaths("目录: https:\\doi.org\\10.1063/1.1421630"),
    "目录: https:\\doi.org\\10.1063/1.1421630",
    "single-backslash OCR citation URLs must not be redacted"
  );
  assert(U.markerDetected("done LitMTrans_TRANSLATION_END_123_456", "LitMTrans_TRANSLATION_END_123_456"));
  assert.equal(U.providerSpec("siliconflow").name, "硅基流动 (SiliconFlow)");
  const pastedName = U.pastedImageName(new Date(2026, 7, 4, 10, 34, 55, 123), 2, "image/png");
  assert.equal(pastedName, "粘贴图片-20260804-103455-123-02.png");
  assert(U.isIdentifiedPastedImageName(pastedName));
  assert.equal(U.chatImageExtension("image/jpeg"), ".jpg");
  assert.equal(await U.sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(await U.sha256Bytes(new Uint8Array([0x61, 0x62, 0x63])), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(ChatInternals.decodeImageDataURL("data:image/bmp;base64,Qk0=").mimeType, "image/bmp");
  assert.equal(ChatInternals.decodeImageDataURL("data:image/jp2;base64,anAy").mimeType, "image/jp2");
  assert.equal(ChatInternals.decodeImageDataURL("data:image/svg+xml;base64,PHN2Zz4=").mimeType, "image/svg+xml");
  assert.equal(LLMInternals.decodeImageDataURL("data:image/bmp;base64,Qk0=").mimeType, "image/bmp");
  assert.equal(LLMInternals.detectImageMimeType(new Uint8Array([0x42, 0x4d])), "image/bmp");
  assert.equal(LLMInternals.detectImageMimeType(new TextEncoder().encode("<svg></svg>")), "image/svg+xml");
}

function testMarkdown() {
  const unsafe = M.renderMarkdown("<script>alert(1)</script>");
  assert(!unsafe.includes("<script>"));
  assert(unsafe.includes("&lt;script&gt;"));

  const math = M.renderMarkdown("Equation \\(\\frac{a}{b}\\) remains.");
  assert(math.includes("litmtrans-frac"));
  const paddedDollarMath = M.renderMarkdown("At $R / R _ { 0 } = 6 , 1 0 $ the after flow dominates.");
  assert(paddedDollarMath.includes("litmtrans-math-inline"),
    "MinerU-style TeX with a space before its closing dollar delimiter must render");
  const paddedDollarProse = M.renderMarkdown("The literal marker is $price $ only.");
  assert(paddedDollarProse.includes("$price $"),
    "ordinary dollar-delimited prose must not be promoted to mathematics");
  const comparisonMath = M.renderTeX("R/R_0 &gt; 12");
  assert(comparisonMath.endsWith("R/R<sub>0</sub> &gt; 12</span>"),
    "HTML comparison entities inside TeX must be decoded before rendering");
  const repairedChatMath = M.normalizeBareTeXFragments("The fitted value is s_{\\text{wp}}.");
  assert(repairedChatMath.includes("\\(s_{\\text{wp}}\\)"), "bare TeX subscripts in AI replies must gain inline delimiters");
  const commandScriptChatMath = M.normalizeBareTeXFragments("The fitted value is u_\\text{wp}.");
  assert(commandScriptChatMath.includes("\\(u_\\text{wp}\\)"), "bare TeX scripts followed directly by a command must gain inline delimiters");
  const imageInsideBold = "**![IMAGE_004](images/image_004.jpg) (FIG. 3)**";
  const repairedImageInsideBold = M.normalizeBareTeXFragments(imageInsideBold);
  assert.equal(repairedImageInsideBold, imageInsideBold, "MinerU IMAGE_004 ids inside Markdown images must not be rewritten as bare TeX subscripts");
  assert(!M.renderMarkdown(repairedImageInsideBold).includes("@@LitMTrans"), "nested Markdown formatting must never leak internal renderer placeholders");
  assert.equal(
    M.normalizeEscapedTeXDelimiters("Gateway returned \\\\(u_{\\\\mathrm{sw}}\\\\)."),
    "Gateway returned \\(u_{\\mathrm{sw}}\\).",
    "doubly escaped complete TeX expressions must be decoded before rendering"
  );
  assert.equal(
    M.normalizeTranslatedInlineHTML("Values \\\\(\\\\mu > 0\\\\) and \\\\(\\\\rho_{0}\\\\); C:\\\\Temp remains."),
    "Values \\(\\mu > 0\\) and \\(\\rho_{0}\\); C:\\\\Temp remains.",
    "translation normalization must decode standalone TeX commands only inside complete formulas"
  );
  assert.equal(
    M.normalizeBareTeXFragments("Already rendered: \\(s_{\\text{wp}}\\)."),
    "Already rendered: \\(s_{\\text{wp}}\\).",
    "existing TeX delimiters must remain unchanged"
  );
  const displayMath = M.renderMarkdown("$$\n\\frac{a}{b}\n$$");
  assert(displayMath.includes("litmtrans-math-display"), "multi-line display mathematics must be rendered as one formula block");
  assert(displayMath.includes("litmtrans-frac"));
  const arrayMath = M.renderMarkdown("$$\n\\begin{array}{l}a\\\\b\\end{array}\n$$");
  assert(arrayMath.includes("litmtrans-matrix"), "array alignment declarations must not prevent formula rendering");
  assert.equal(M.mathIntegrityIssue("A \\(x+y\\)", "B \\(x+y\\)"), "");
  assert(M.mathIntegrityIssue("A \\(x+y\\)", "B \\(x-y\\)"));
  assert.equal(
    M.repairEquationReferenceTranslation("", "See Eq. \\~2! and Eqs. \\~3! and \\~4!."),
    "See Eq. (2) and Eqs. (3) and (4).",
    "MinerU-garbled source equation references must be safe to render"
  );

  const remoteImage = M.renderMarkdown("![x](https://example.com/a.png)");
  assert(!remoteImage.includes("<img"));
  const localImage = M.renderMarkdown("![x](images/a.png)", { resolveImage: () => "resource://litmtrans-data/doc/images/a.png" });
  assert(localImage.includes("<img"));
  assert(localImage.includes(" />"), "XHTML workbench requires self-closing image tags");
  assert(localImage.includes('loading="lazy"'), "markdown images should remain lazy by default");
  assert(!localImage.includes('style="width:'), "images without a layout width must retain their natural display width");
  const sizedLocalImage = M.renderMarkdown("![x](images/a.png)", {
    resolveImage: () => "resource://litmtrans-data/doc/images/a.png",
    resolveImageWidth: () => 42.5
  });
  assert(sizedLocalImage.includes('style="width:42.5%"'), "a valid layout image width must remain bounded and rendered");
  const eagerImage = M.renderMarkdown("![x](images/a.png)", {
    resolveImage: () => "resource://litmtrans-data/doc/images/a.png",
    imageLoading: "eager"
  });
  assert(eagerImage.includes('loading="eager"'), "stream readers must eagerly load images before measuring sync anchors");
  assert(M.renderMarkdown("line one\nline two").includes("<br />"));
  assert.equal(
    M.toXHTMLFragment('<p>line<br>next<img src="image.png"></p>'),
    '<p>line<br />next<img src="image.png" /></p>',
    "HTML-parser output must be normalized before assigning it to XHTML innerHTML"
  );
  const anchored = M.injectSyncAnchors("# Title\n\nFirst paragraph.\n\nSecond paragraph.");
  assert(anchored.includes('id="doc-block-0001"'));
  assert(anchored.includes('id="doc-block-0003"'));
  const anchoredHTML = M.renderMarkdown(anchored);
  assert(anchoredHTML.includes('class="litmtrans-anchor litmtrans-sync-anchor"'), "reader block anchors must survive Markdown rendering");

  const source = "# A\n\n" + "Paragraph. ".repeat(200) + "\n\n# B\n\n" + "Second. ".repeat(200);
  const chunks = M.splitForTranslation(source, 800);
  assert(chunks.length > 1);
  assert.equal(chunks.join(""), source);

  const formulaSource = "前文\n$$\nx + y = z\n$$\n后文";
  const formulaBlocks = M.markdownBlocks(formulaSource);
  assert.equal(formulaBlocks.length, 2, "display-math blocks must remain intact through adjacent prose");
  assert(formulaBlocks[0].includes("$$\nx + y = z\n$$\n"));
}

function testMinerUImageAssetValidation() {
  assert.deepEqual(
    MinerUInternals.localMarkdownImageTargets(
      "![figure](images/plot.jpg)\n![again](<images/plot.jpg>)\n![inline](data:image/png;base64,AA==)\n![remote](https://example.com/a.png)"
    ),
    ["images/plot.jpg"],
    "only MinerU-relative image targets require a packaged local asset"
  );
  assert.equal(MinerUInternals.extensionFromTarget("https://example.com/figure.final.PNG?download=1#page=2"), ".png");
  assert.equal(MinerUInternals.extensionFromTarget("images/figure%20one.jpg"), ".jpg");
}

async function testMinerUAutomaticPDFSplit() {
  assert.deepEqual(
    JSON.parse(JSON.stringify(MinerUInternals.planMinerUPageRanges(400))),
    [{ start: 0, end: 200, pageCount: 200 }, { start: 200, end: 400, pageCount: 200 }],
    "a boundary search must not create an avoidable extra upload"
  );
  const pageTexts = Array.from({ length: 401 }, (_, index) => `continued page ${index + 1},`);
  pageTexts[189] = "End of a complete section.";
  pageTexts[190] = "2 Methods";
  const semantic = MinerUInternals.planMinerUPageRanges(401, pageTexts);
  assert.equal(semantic.length, 3);
  assert.equal(semantic[0].end, 190, "a nearby semantic boundary should be preferred when part count stays constant");
  assert(semantic.every(part => part.pageCount <= 200));

  const source = await context.PDFLib.PDFDocument.create();
  for (let index = 0; index < 401; index++) source.addPage();
  const storage = new MemoryStorage();
  storage.stat = async () => { throw new Error("联网翻译不得读取参考文件"); };
  const sourcePath = "/mem/source.pdf";
  await storage.writeBytes(sourcePath, await source.save());
  const service = new MinerUService(storage, { getMinerUToken: () => "test" });
  const parts = await service.prepareUploadParts(sourcePath, "/mem/staging");
  assert.deepEqual(parts.map(part => part.pageCount), [200, 200, 1]);
  const toPDFRealmBytes = vm.runInContext("(value) => Uint8Array.from(value)", context);
  for (const part of parts) {
    const pdf = await context.PDFLib.PDFDocument.load(
      toPDFRealmBytes(await storage.readBytes(part.filePath))
    );
    assert.equal(pdf.getPageCount(), part.pageCount, "every generated upload part must preserve its planned pages");
  }

  const originalLoad = context.PDFLib.PDFDocument.load;
  const loadOptions = [];
  try {
    context.PDFLib.PDFDocument.load = async (_bytes, options) => {
      loadOptions.push(options);
      return { isEncrypted: true, getPageCount: () => 3 };
    };
    const encryptedOriginal = await service.prepareUploadParts(sourcePath, "/mem/encrypted");
    assert.deepEqual(
      JSON.parse(JSON.stringify(encryptedOriginal)),
      [{ filePath: sourcePath, start: 0, end: 3, pageCount: 3, temporary: false }],
      "a passwordless permissions-encrypted PDF under the limit must upload unchanged"
    );
    assert.equal(loadOptions.at(-1).ignoreEncryption, true, "page counting must accept PDF permission encryption");

    context.PDFLib.PDFDocument.load = async () => ({ isEncrypted: true, getPageCount: () => 201 });
    await assert.rejects(
      () => service.prepareUploadParts(sourcePath, "/mem/encrypted-long"),
      /无法安全拆分此类文件/
    );
  }
  finally {
    context.PDFLib.PDFDocument.load = originalLoad;
  }

  const rebased = MinerUInternals.rebaseMinerUPayload(
    { page_idx: 0, blocks: [{ page_index: 2, image_path: "images/a.png" }] },
    200,
    { "images/a.png": "assets/p002-a.png" }
  );
  assert.equal(rebased.page_idx, 200);
  assert.equal(rebased.blocks[0].page_index, 202);
  assert.equal(rebased.blocks[0].image_path, "assets/p002-a.png");
}

function testShortTemporaryDirectory() {
  const storage = new context.LitMTrans.Storage();
  const temporary = storage.temporaryDir("parse");
  assert(temporary.includes("\\litmtrans-tmp\\parse-") || temporary.includes("/litmtrans-tmp/parse-"));
  assert(temporary.length < 80, "MinerU temporary extraction path must remain short");
}

async function testLegacyStorageMigration() {
  const originalIOUtils = context.IOUtils;
  const existing = new Set(["/profile/ai-literature-translator"]);
  const moves = [];
  context.IOUtils = {
    async exists(file) { return existing.has(file); },
    async move(source, destination) {
      moves.push([source, destination]);
      existing.delete(source);
      existing.add(destination);
    }
  };
  try {
    const storage = new context.LitMTrans.Storage();
    await storage.migrateLegacyRoot();
    assert.deepEqual(
      moves,
      [["/profile/ai-literature-translator", "/profile/litmtrans"]],
      "an existing cache root must move to the LitMTrans directory before use"
    );
  }
  finally {
    context.IOUtils = originalIOUtils;
  }
}

function testLegacySecretMigration() {
  const originalLogins = context.Services.logins;
  context.Services.logins = {
    findLogins(origin, _formActionOrigin, realm) {
      if (origin === "chrome://ai-literature-translator" && realm === "AI Literature Translator") {
        return [{ username: "mineru", password: "legacy-token" }];
      }
      return [];
    }
  };
  try {
    const secrets = new context.LitMTrans.Secrets();
    let migrated = null;
    secrets.set = (name, value) => {
      migrated = { name, value };
      return true;
    };
    assert.equal(secrets.get("mineru"), "legacy-token");
    assert.deepEqual(migrated, { name: "mineru", value: "legacy-token" });
  }
  finally {
    context.Services.logins = originalLogins;
  }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipU16(value) {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value, 0);
  return out;
}

function zipU32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0, 0);
  return out;
}

function zipU64(value) {
  const out = Buffer.alloc(8);
  out.writeUInt32LE(value >>> 0, 0);
  out.writeUInt32LE(Math.floor(value / 0x100000000) >>> 0, 4);
  return out;
}

function oneEntryZip(name, text) {
  const fileName = Buffer.from(name);
  const source = Buffer.from(text);
  const compressed = zlib.deflateRawSync(source);
  const crc = crc32(source);
  const local = Buffer.concat([
    zipU32(0x04034b50), zipU16(20), zipU16(0), zipU16(8), zipU16(0), zipU16(0),
    zipU32(crc), zipU32(compressed.length), zipU32(source.length), zipU16(fileName.length), zipU16(0),
    fileName, compressed
  ]);
  const central = Buffer.concat([
    zipU32(0x02014b50), zipU16(20), zipU16(20), zipU16(0), zipU16(8), zipU16(0), zipU16(0),
    zipU32(crc), zipU32(compressed.length), zipU32(source.length), zipU16(fileName.length), zipU16(0),
    zipU16(0), zipU16(0), zipU16(0), zipU32(0), zipU32(0), fileName
  ]);
  return Buffer.concat([
    local, central,
    zipU32(0x06054b50), zipU16(0), zipU16(0), zipU16(1), zipU16(1),
    zipU32(central.length), zipU32(local.length), zipU16(0)
  ]);
}

function oneEntryZip64(name, text) {
  const fileName = Buffer.from(name);
  const source = Buffer.from(text);
  const compressed = zlib.deflateRawSync(source);
  const crc = crc32(source);
  const local = Buffer.concat([
    zipU32(0x04034b50), zipU16(45), zipU16(0), zipU16(8), zipU16(0), zipU16(0),
    zipU32(crc), zipU32(compressed.length), zipU32(source.length), zipU16(fileName.length), zipU16(0),
    fileName, compressed
  ]);
  const zip64Extra = Buffer.concat([zipU16(0x0001), zipU16(24), zipU64(source.length), zipU64(compressed.length), zipU64(0)]);
  const central = Buffer.concat([
    zipU32(0x02014b50), zipU16(45), zipU16(45), zipU16(0), zipU16(8), zipU16(0), zipU16(0),
    zipU32(crc), zipU32(0xffffffff), zipU32(0xffffffff), zipU16(fileName.length), zipU16(zip64Extra.length),
    zipU16(0), zipU16(0), zipU16(0), zipU32(0), zipU32(0xffffffff), fileName, zip64Extra
  ]);
  const directoryOffset = local.length;
  const zip64EOCD = Buffer.concat([
    zipU32(0x06064b50), zipU64(44), zipU16(45), zipU16(45), zipU32(0), zipU32(0),
    zipU64(1), zipU64(1), zipU64(central.length), zipU64(directoryOffset)
  ]);
  const zip64Locator = Buffer.concat([zipU32(0x07064b50), zipU32(0), zipU64(directoryOffset + central.length), zipU32(1)]);
  const classicEOCD = Buffer.concat([
    zipU32(0x06054b50), zipU16(0), zipU16(0), zipU16(0xffff), zipU16(0xffff),
    zipU32(0xffffffff), zipU32(0xffffffff), zipU16(0)
  ]);
  return Buffer.concat([local, central, zip64EOCD, zip64Locator, classicEOCD]);
}

function testPortableMinerUZipFallback() {
  const archive = MinerUInternals.readPortableZip(oneEntryZip("nested/model.json", '{"stable":true}'));
  const decoded = MinerUInternals.readPortableZipEntry(archive, "nested/model.json");
  assert.equal(Buffer.from(decoded).toString("utf8"), '{"stable":true}', "portable ZIP fallback must decode raw-DEFLATE entries");
  const zip64 = MinerUInternals.readPortableZip(oneEntryZip64("nested/zip64.json", '{"zip64":true}'));
  const decodedZip64 = MinerUInternals.readPortableZipEntry(zip64, "nested/zip64.json");
  assert.equal(Buffer.from(decodedZip64).toString("utf8"), '{"zip64":true}', "portable ZIP fallback must decode ZIP64 entries");
}

function testHTTPParsing() {
  const parts = H.extractStreamParts({
    choices: [{ delta: { content: "answer", reasoning_content: "thought" } }],
    usage: { total_tokens: 3 }
  });
  assert.equal(parts.text, "answer");
  assert.equal(parts.reasoning, "thought");
  assert.equal(parts.usage.total_tokens, 3);
  const gatewayReasoning = H.extractStreamParts({
    reasoning_delta: "event-level thought",
    choices: [{ delta: { reasoning_details: { analysis: "analysis" } } }]
  });
  assert.equal(gatewayReasoning.reasoning, "analysis", "a choice-level reasoning delta must not be duplicated by an alias");
  const duplicatedOpenRouterShape = H.extractStreamParts({
    choices: [{ delta: {
      reasoning: "same public thought",
      reasoning_details: [{ type: "reasoning.text", text: "same public thought" }]
    }}]
  });
  assert.equal(duplicatedOpenRouterShape.reasoning, "same public thought", "equivalent OpenRouter reasoning fields must be treated as alternatives");
  assert.equal(H.extractStreamParts({ type: "message.delta", delta: { text: "compat text" } }).text, "compat text");
  assert.equal(H.extractStreamParts({ type: "content.delta", delta: "legacy text" }).text, "legacy text");
  assert.equal(H.extractStreamParts({ type: "content_block_delta", delta: { type: "text_delta", text: "anthropic text" } }).text, "anthropic text");
  assert.equal(H.extractStreamParts({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "anthropic thought" } }).reasoning, "anthropic thought");
  assert.equal(H.extractStreamParts({ output: [{ type: "reasoning", content: [{ type: "summary_text", text: "response thought" }] }] }).reasoning, "response thought");
  assert.equal(H.extractStreamParts({ content: "answer", reasoning_content: "top-level thought" }).reasoning, "top-level thought");
  assert.equal(H.extractOpenAIText({ output: [
    { type: "reasoning", content: [{ type: "summary_text", text: "hidden thought" }] },
    { type: "message", content: [{ type: "output_text", text: "visible answer" }] }
  ] }), "visible answer");
  assert.equal(H.extractOpenAIText({ choices: [{ message: { content: "ok" } }] }), "ok");
  assert.equal(
    H.geminiUsageToOpenAI({ promptTokenCount: 8000, candidatesTokenCount: 40, cachedContentTokenCount: 7600 }).prompt_tokens_details.cached_tokens,
    7600,
    "Gemini cachedContentTokenCount must reach the per-turn cache diagnostics"
  );
}

function testCacheFriendlyChatMessageOrdering() {
  const messages = [
    { role: "system", content: "fixed system" },
    { role: "user", content: "fixed document\n\nquestion" }
  ];
  ChatInternals.appendDynamicContextToLatestUser(messages, "selected excerpt that changes per turn");
  assert.equal(messages.length, 2, "dynamic selection context must not become an early system message");
  assert(messages[1].content.endsWith("selected excerpt that changes per turn"));
  assert(messages[0].content === "fixed system", "the cacheable system prefix must remain byte-stable");
}

function testReasoningRequestConstruction() {
  const deepseekPayload = { model: "deepseek-reasoner", messages: [], stream: true };
  const deepseekConfig = {
    provider: "deepseek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-reasoner",
    thinkingMode: "enabled",
    reasoningEffort: "medium"
  };
  LLMInternals.applyReasoningPayload(deepseekPayload, deepseekConfig);
  assert.deepEqual(deepseekPayload.thinking, { type: "enabled" });
  assert.equal(deepseekPayload.reasoning_effort, "high");
  assert.equal(LLMInternals.shouldSendTemperature(deepseekConfig), false);

  const oneAPIPayload = { model: "gpt-5.6", messages: [], stream: true };
  LLMInternals.applyReasoningPayload(oneAPIPayload, {
    provider: "oneapi",
    baseURL: "https://gateway.invalid/v1",
    model: "gpt-5.6",
    thinkingMode: "disabled",
    reasoningEffort: "default"
  });
  assert.equal(oneAPIPayload.reasoning_effort, "none");

  const geminiPayload = { model: "gemini-3.5-flash", messages: [], stream: true };
  LLMInternals.applyReasoningPayload(geminiPayload, {
    provider: "gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.5-flash",
    thinkingMode: "disabled",
    reasoningEffort: "default"
  });
  assert.equal(geminiPayload.reasoning_effort, "minimal");

  const geminiFlashPayload = { model: "gemini-2.5-flash", messages: [], stream: true };
  LLMInternals.applyReasoningPayload(geminiFlashPayload, {
    provider: "gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    thinkingMode: "disabled",
    reasoningEffort: "default"
  });
  assert.equal(geminiFlashPayload.reasoning_effort, "none");
  assert.equal(LLMInternals.normalizeGeminiModelID("models/gemini-2.5-flash"), "gemini-2.5-flash");
  assert.equal(LLMInternals.normalizeGeminiReasoningEffort("xhigh"), "high");
  assert.equal(LLMInternals.normalizeGeminiReasoningEffort("max"), "high");
  assert.equal(LLMInternals.normalizeReasoningEffort("oneapi", "max", "gpt-5.6"), "xhigh");
  const siliconConfig = { provider: "siliconflow", baseURL: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V4-Flash", thinkingMode: "enabled", reasoningEffort: "high" };
  const siliconPayload = LLMInternals.applyReasoningPayload({}, siliconConfig);
  assert.equal(siliconPayload.enable_thinking, undefined, "SiliconFlow must not send thinking before capability detection");
  LLMInternals.markSiliconflowThinkingCapability(siliconConfig.baseURL, siliconConfig.model, true);
  assert.deepEqual(LLMInternals.applyReasoningPayload({}, siliconConfig), { enable_thinking: true, thinking_budget: 8192 });
  assert.deepEqual(LLMInternals.applyReasoningPayload({}, { ...siliconConfig, thinkingMode: "default", reasoningEffort: "default" }), {});
  assert.deepEqual(LLMInternals.applyReasoningPayload({}, { ...siliconConfig, thinkingMode: "enabled", reasoningEffort: "low" }), { enable_thinking: true, thinking_budget: 2048 });
  LLMInternals.markSiliconflowThinkingCapability(siliconConfig.baseURL, siliconConfig.model, false);
  assert.equal(LLMInternals.siliconflowThinkingCapability(siliconConfig.baseURL, siliconConfig.model), false);
  assert.equal(LLMInternals.siliconflowThinkingCapability(siliconConfig.baseURL, "never-probed"), null);
  const siliconKey = LLMInternals.siliconflowCapabilityKey(siliconConfig.baseURL, siliconConfig.model);
  context.LitMTrans.Utils.setPref("siliconflowThinkingCapabilities", JSON.stringify({
    [siliconKey]: { supported: true, checkedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 }
  }));
  assert.equal(
    LLMInternals.siliconflowThinkingCapability(siliconConfig.baseURL, siliconConfig.model),
    null,
    "expired SiliconFlow capability probes must be discarded"
  );
  context.LitMTrans.Utils.setPref("siliconflowThinkingCapabilities", JSON.stringify({ [siliconKey]: true }));
  assert.equal(
    LLMInternals.siliconflowThinkingCapability(siliconConfig.baseURL, siliconConfig.model),
    null,
    "legacy bare-boolean capability records must be re-probed"
  );
  const sanitized = LLMInternals.sanitizeContentForAPI([
    { type: "text", text: "来源: C:\\Users\\Alice\\paper.pdf" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AA==", extra: "drop" } },
    { type: "tool_result", content: "must not leak" }
  ]);
  assert.deepEqual(sanitized, [
    { type: "text", text: "来源: [本地路径已隐藏]" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }
  ]);

  const geminiDefaultPayload = { model: "gemini-2.5-flash", messages: [], stream: true };
  LLMInternals.applyReasoningPayload(geminiDefaultPayload, {
    provider: "gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    thinkingMode: "default",
    reasoningEffort: "default"
  });
  assert.equal(geminiDefaultPayload.reasoning_effort, "medium");
  assert.equal(
    LLMInternals.geminiOpenAIChatURL("https://generativelanguage.googleapis.com/v1beta"),
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    "Gemini chat must retain the Python project's OpenAI-compatible transport"
  );

  const geminiThoughtPayload = { model: "gemini-3.1-flash-lite", messages: [], stream: true };
  LLMInternals.applyReasoningPayload(geminiThoughtPayload, {
    provider: "gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.1-flash-lite",
    thinkingMode: "default",
    reasoningEffort: "default",
    showReasoning: true
  });
  assert.equal(geminiThoughtPayload.reasoning_effort, undefined);
  assert.deepEqual(geminiThoughtPayload.extra_body, {
    google: { thinking_config: { thinking_level: "medium", include_thoughts: true } }
  });
}

async function testIndependentTranslationAndChatSettings() {
  assert.equal(LLMInternals.requestTimeout({}), 300000, "an omitted timeout must retain the transport default");
  assert.equal(LLMInternals.requestTimeout({ timeout: 0 }), 0, "an explicit zero timeout must disable the wall-clock deadline");
  assert.equal(LLMInternals.requestTimeout({ timeout: null }), 0, "an explicit null timeout must disable the wall-clock deadline");
  const secrets = {
    has: () => false,
    hasMinerUToken: false,
    llmKeyName: provider => `llm:${provider}`,
    getLLMKey: () => "",
    setLLMKey() {},
    removeLLMKey() {},
    setMinerUToken() {},
    removeMinerUToken() {}
  };
  const llm = new LLMService(secrets);
  const defaults = llm.getSettings();
  assert.equal(llm.getSettings("chat").chatUsesTranslationModel, true, "chat must share the translation model by default");
  assert.equal(defaults.sourceLanguage, "自动识别", "LLM translation must infer the source language");
  assert.equal(defaults.chunkChars, 135000, "chunked fallback must use the Python default boundary");
  assert.equal(defaults.layoutChunkChars, 135000, "layout translation must cap each JSON group at the shared character boundary");
  assert.equal(defaults.layoutChunkBlocks, 160, "layout translation must cap the number of id mappings per group");
  llm.saveSettings({ sourceLanguage: "日文", chunkChars: 20000, layoutChunkChars: 60000, layoutChunkBlocks: 20 }, "translation");
  const fixedTranslationDefaults = llm.getSettings("translation");
  assert.equal(fixedTranslationDefaults.sourceLanguage, "自动识别", "source-language preferences must not affect LLM translation");
  assert.equal(fixedTranslationDefaults.chunkChars, 135000, "chunk boundaries must remain internal");
  assert.equal(fixedTranslationDefaults.layoutChunkChars, 135000, "layout character grouping must remain internal");
  assert.equal(fixedTranslationDefaults.layoutChunkBlocks, 160, "layout block grouping must remain internal");
  llm.saveSettings({ customTranslationInstruction: "统一保留缩写" }, "translation");
  assert.equal(llm.getSettings("translation").customTranslationInstruction, "统一保留缩写");
  assert(new TranslationService({}, llm).baseSystemPrompt(llm.getSettings("translation")).includes("统一保留缩写"), "custom translation instructions must be sent with translation prompts");
  llm.saveSettings({ readerFontPt: 36.25 }, "translation");
  assert.equal(llm.getSettings("translation").readerFontPt, 12, "reader font size must remain the built-in default");
  assert.equal(context.LitMTransPort.normalizeSettings({ readerFontPt: 3.25 }).readerFontPt, 3.25, "core settings must preserve positive reader font sizes below the former lower bound");
  llm.saveSettings({
    provider: "deepseek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-reasoner",
    thinkingMode: "enabled",
    reasoningEffort: "max"
  }, "translation");
  llm.saveSettings({
    provider: "openrouter",
    baseURL: "https://openrouter.ai/api",
    model: "chat-model",
    thinkingMode: "disabled",
    reasoningEffort: "default"
  }, "chat");
  const translation = llm.getSettings("translation");
  const chat = llm.getSettings("chat");
  assert.equal(translation.provider, "deepseek");
  assert.equal(translation.model, "deepseek-reasoner");
  assert.equal(translation.thinkingMode, "enabled", "translation thinking mode must persist");
  assert.equal(translation.reasoningEffort, "max", "translation reasoning effort must persist");
  llm.saveSettings({
    provider: "deepseek", baseURL: "https://api.deepseek.com", model: "translation-fast-model",
    thinkingMode: "disabled", reasoningEffort: "low"
  }, "translation");
  llm.saveSettings({ provider: "deepseek", baseURL: "https://api.deepseek.com", model: "deepseek-reasoner" }, "translation");
  const restoredTranslationReasoningModel = llm.getSettings("translation");
  assert.equal(restoredTranslationReasoningModel.thinkingMode, "enabled", "translation reasoning mode must be restored per model");
  assert.equal(restoredTranslationReasoningModel.reasoningEffort, "max", "translation reasoning effort must be restored per model");
  assert.equal(chat.provider, "openrouter");
  assert.equal(chat.baseURL, "https://openrouter.ai/api/v1");
  assert.equal(chat.model, "chat-model");
  assert.equal(chat.thinkingMode, "disabled");
  assert.equal(chat.chatUsesTranslationModel, false, "saving a dedicated chat profile must disable model sharing");
  // Python stores reasoning controls per provider/model, not globally. A
  // fast chat model and a reasoning model must recover their own visibility.
  llm.saveSettings({
    provider: "oneapi", baseURL: "https://gateway.invalid/v1", model: "reasoning-model",
    thinkingMode: "enabled", reasoningEffort: "high", showReasoning: true
  }, "chat");
  llm.saveSettings({
    provider: "oneapi", baseURL: "https://gateway.invalid/v1", model: "fast-model",
    thinkingMode: "disabled", reasoningEffort: "default", showReasoning: false
  }, "chat");
  llm.saveSettings({
    provider: "oneapi", baseURL: "https://gateway.invalid/v1", model: "reasoning-model"
  }, "chat");
  const restoredReasoningModel = llm.getSettings("chat");
  assert.equal(restoredReasoningModel.thinkingMode, "enabled");
  assert.equal(restoredReasoningModel.reasoningEffort, "high");
  assert.equal(restoredReasoningModel.showReasoning, true);
  await assert.rejects(
    () => llm.ensureConfiguredModel({ purpose: "translation", model: "" }),
    /尚未选择翻译模型/
  );
  assert.equal(typeof ChatInternals.DEFAULT_KEY_POINTS_PROMPT, "string");
  assert(ChatInternals.DEFAULT_KEY_POINTS_PROMPT.trim().length > 0, "default key-points prompt must stay non-empty");
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


async function testHTTPStreaming() {
  const originalFetch = context.fetch;
  const encoder = new TextEncoder();
  const chunks = [
    encoder.encode('data: {"choices":[{"delta":{"content":"A"}}]}\n'),
    encoder.encode('data: {"choices":[{"delta":{"content":"<thought>reason"}}]}\n'),
    encoder.encode('data: {"choices":[{"delta":{"content":"ing</thought>B"}}]}\n'),
    encoder.encode('data: [DONE]\n')
  ];
  let index = 0;
  context.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: name => String(name).toLowerCase() === 'content-type' ? 'text/event-stream' : '' },
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[index++] };
          },
          async cancel() {}
        };
      }
    }
  });
  try {
    let streamed = '';
    let reasoning = '';
    const result = await H.streamOpenAI('https://example.invalid/chat/completions', { stream: true }, {
      token: 'x',
      onText: delta => { streamed += delta; },
      onReasoning: delta => { reasoning += delta; }
    });
    assert.equal(streamed, 'AB');
    assert.equal(result.text, 'AB');
    assert.equal(reasoning, 'reasoning');
    assert.equal(result.reasoning, 'reasoning');

    let cancelled = false;
    context.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: name => String(name).toLowerCase() === 'content-type' ? 'text/event-stream' : '' },
      body: {
        getReader() {
          return {
            read() { return new Promise(() => {}); },
            async cancel() { cancelled = true; }
          };
        }
      }
    });
    await assert.rejects(
      () => H.streamOpenAI('https://example.invalid/chat/completions', { stream: true }, {
        token: 'x',
        timeout: 1000,
        firstEventTimeout: 10
      }),
      error => error?.name === 'StreamTimeoutError' && error?.timeout === true
    );
    assert.equal(cancelled, true, 'a stalled stream reader must be cancelled after the first-event deadline');
  }
  finally {
    context.fetch = originalFetch;
  }
}

async function testGeminiQuotaCooldownUsesRetryAfter() {
  assert.equal(H.retryAfterMilliseconds({ get: () => "2" }, 0), 2000);
  assert.equal(
    H.retryAfterMilliseconds({ get: () => "Thu, 01 Jan 1970 00:00:03 GMT" }, 1000),
    2000
  );
  const llm = new LLMService({
    has: () => true,
    llmKeyName: provider => `llm:${provider}`,
    getLLMKey: () => "test-key"
  });
  llm.resolveConfig = () => ({
    provider: "gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-test",
    apiKey: "test-key"
  });
  let now = 1000;
  const waits = [];
  const notices = [];
  llm.rateLimitNow = () => now;
  llm.rateLimitSleep = async milliseconds => {
    waits.push(milliseconds);
    now += milliseconds;
  };
  let calls = 0;
  llm.completeOnce = async () => {
    calls++;
    if (calls === 1) throw new H.HTTPError("HTTP 429: RESOURCE_EXHAUSTED", 429, "", 2500);
    return { text: "恢复成功", reasoning: "", usage: null };
  };
  const result = await llm.complete([], {
    onRateLimitWait: event => notices.push(event)
  });
  assert.equal(result.text, "恢复成功");
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2500], "Gemini retries must respect Retry-After instead of imposing a proactive RPM limit");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].waitMs, 2500);
}

async function testDeepSeekGlobalConcurrencyLimit() {
  const llm = new LLMService({
    getLLMKey: () => "test-key"
  });
  llm.resolveConfig = () => ({
    provider: "deepseek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-chat",
    apiKey: "test-key"
  });
  const originalStreamOpenAI = H.streamOpenAI;
  let active = 0;
  let maximumActive = 0;
  H.streamOpenAI = async () => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    return { text: "ok", reasoning: "", usage: null };
  };
  try {
    const requestCount = LLMInternals.DEEPSEEK_CONCURRENCY_LIMIT + 5;
    const results = await Promise.all(
      Array.from({ length: requestCount }, () => llm.complete([], { stream: true }))
    );
    assert.equal(results.length, requestCount);
    assert(maximumActive > 3 && maximumActive <= LLMInternals.DEEPSEEK_CONCURRENCY_LIMIT,
      `expected the shared DeepSeek limiter to allow up to 500 requests without exceeding it, got ${maximumActive}`);
  }
  finally {
    H.streamOpenAI = originalStreamOpenAI;
  }
}

async function testPresignedUploadHeaders() {
  const originalFetch = context.fetch;
  let received = null;
  context.fetch = async (_url, options) => {
    received = options;
    return { ok: true, status: 200, statusText: "OK", headers: { get: () => "" } };
  };
  try {
    await H.uploadBytes("https://oss.example.invalid/presigned", new Uint8Array([1, 2, 3]));
    assert.equal(received.method, "PUT");
    assert.equal(received.headers["Content-Type"], undefined, "presigned MinerU upload must not add Content-Type");
    assert.equal(received.headers["User-Agent"], "LitMTrans/2.0.0");
  }
  finally {
    context.fetch = originalFetch;
  }
}

async function testLayout() {
  const documentID = "1-ABC";
  const payload = {
    pdf_info: [{
      page_size: [600, 800],
      preproc_blocks: [
        { type: "title", bbox: [50, 40, 550, 90], lines: [{ spans: [{ type: "text", content: "Source title" }] }] },
        { type: "text", bbox: [50, 120, 550, 220], lines: [{ spans: [
          { type: "text", content: "Body " },
          { type: "equation_inline", content: "x+y" },
          { type: "text", content: "." }
        ] }] },
        { type: "interline_equation", bbox: [180, 225, 420, 255], image_path: "images/equation.png", lines: [{ spans: [{ type: "text", content: "\\\\[E = mc^2 \\\\tag{1}\\\\]" }] }] },
        {
          type: "image", bbox: [100, 260, 500, 520], image_path: "images/figure.png", lines: [],
          blocks: [{
            type: "image_footnote", bbox: [348, 521, 559, 545],
            lines: [{ spans: [{ type: "text", content: "Open Access This article is licensed." }] }]
          }]
        }
      ]
    }]
  };
  const files = new Map([
    ["/data/1-ABC/layout.json", payload],
    ["/data/1-ABC/asset-map.json", { "images/figure.png": "assets/figure.png" }]
  ]);
  const storage = {
    path: (...parts) => path.posix.join("/data", ...parts),
    async readJSON(file, fallback) {
      const value = files.get(file);
      // Storage deserializes JSON on every read. Keep the fixture faithful so
      // layout-model normalization cannot mutate its persisted source.
      return value === undefined ? fallback : JSON.parse(JSON.stringify(value));
    },
    async writeJSON(file, value) {
      files.set(file, value);
    },
    async readText(file) { return file.endsWith("layout.json") ? JSON.stringify(payload) : ""; },
    resourceURL(id, relative) { return `resource://litmtrans-data/${id}/${relative}`; }
  };
  const llm = { getSettings: () => ({ targetLanguage: "简体中文" }) };
  const service = new LayoutTranslationService(storage, llm);
  const revision = {
    sourceFingerprint: U.hashString(JSON.stringify(payload)),
    assetMapHash: U.hashString(JSON.stringify(files.get("/data/1-ABC/asset-map.json")))
  };
  const translations = {
    p001_b0001: "译文标题",
    p001_b0002: "正文 \\(x+y\\)。",
    p001_c0003: "开放获取：本文采用知识共享许可。"
  };
  const model = await service.buildModel(documentID, translations, null, revision);
  assert(files.has("/data/1-ABC/compiled-model.json"), "compiled model must be saved to disk cache");
  let rawReadCount = 0;
  const originalReadText = storage.readText;
  storage.readText = async file => {
    if (file.endsWith("layout.json")) rawReadCount++;
    return originalReadText(file);
  };
  const cachedModel = await service.buildModel(documentID, translations, null, revision);
  assert.equal(rawReadCount, 0, "buildModel on cache hit must bypass raw layout.json reading");
  assert.equal(cachedModel.pages.length, 1);
  assert.equal(cachedModel.pages[0].blocks[0].translatedText, "译文标题");
  await service.buildModel(documentID, translations, null, { ...revision, sourceFingerprint: "changed-layout-fingerprint" });
  assert.equal(rawReadCount, 1, "a compiled model must not be reused when the current layout fingerprint differs");
  rawReadCount = 0;
  const persistedRevision = await service.ensureRevision(documentID);
  assert.equal(rawReadCount, 1, "legacy layout caches must create a durable revision manifest once");
  assert.equal(persistedRevision.sourceFingerprint, revision.sourceFingerprint);
  rawReadCount = 0;
  const reusedRevision = await service.ensureRevision(documentID);
  assert.equal(rawReadCount, 0, "a durable layout revision must avoid later layout.json reads");
  assert.equal(reusedRevision.assetMapHash, revision.assetMapHash);
  assert.equal(model.pages.length, 1);
  assert.equal(model.pages[0].blocks[0].id, "p001_b0001");
  assert.equal(model.pages[0].blocks[0].translatedText, "译文标题");
  assert.equal(model.pages[0].blocks[2].kind, "formula", "equation blocks with an image crop must remain semantic formulas");
  assert.equal(model.pages[0].blocks[2].imageURL, "", "formula crops must not replace the TeX renderer");
  assert.equal(model.pages[0].blocks[3].imageURL, "resource://litmtrans-data/1-ABC/assets/figure.png");
  const restoredFormula = model.pages[0].restoration.absoluteBlocks.find(block => block.kind === "formula");
  assert(restoredFormula, "restored layout must retain the equation as a formula block");
  assert.equal(restoredFormula.imageURL, "", "restored formula must not emit an image element");
  assert.equal(restoredFormula.bbox[2], 420,
    "a TeX-tagged formula must retain MinerU's formula-ink bbox");
  assert.equal(restoredFormula.numberRight, 550,
    "a TeX-tagged formula must retain a separate local-column anchor for its number");
  const restoredImageFootnote = model.pages[0].restoration.absoluteBlocks.find(block => block.type === "image_footnote");
  assert(restoredImageFootnote, "image footnotes must remain absolute layout blocks");
  assert.equal(restoredImageFootnote.translatedText, "开放获取：本文采用知识共享许可。");
  assert.equal(restoredImageFootnote.fontSize, 7.2);
  assert.equal(restoredImageFootnote.lineHeight, 1.2);
  const pipeline = new DocumentPipeline({ storage, mineru: {}, translation: {}, layout: service, chat: {}, getSettings: () => ({}) });
  const parsed = { imageMap: [{ originalTarget: "images/figure.png", cleanTarget: "images/figure.png" }] };
  pipeline.attachImageWidths(parsed, model);
  assert.equal(parsed.imageWidths["images/figure.png"], 400 / 600 * 100, "layout image width must use source page ratio");
  model.pages[0].blocks[3].imagePath = "assets/p001-figure.png";
  const multipartParsed = { imageMap: [{ originalTarget: "images/figure.png", cleanTarget: "images/image_001.png" }] };
  pipeline.attachImageWidths(multipartParsed, model);
  assert.equal(
    multipartParsed.imageWidths["images/image_001.png"],
    400 / 600 * 100,
    "multipart layout asset prefixes must not prevent stream images from retaining their source-page width"
  );
  const records = await service.extractRecords(documentID);
  assert.equal(records.length, 3);
  assert.equal(records[1].text, "Body \\(x+y\\).", "layout translation input must retain delimiters around inline equation spans");
  assert.equal(records[2].type, "image_footnote");
  assert.equal(records[2].text, "Open Access This article is licensed.");
  assert(M.mathIntegrityIssue(records[1].text, "正文 x+y。"), "a missing inline-equation delimiter must be visible to layout validation");
  assert(records[1].formulas.includes("\\(x+y\\)"));
}

async function testLayoutEquationBarrier() {
  const prose = "This paragraph contains enough ordinary academic prose to be promoted as body text and to exercise the restored-column merge logic. It deliberately has multiple sentences and sufficient length for the body classifier to accept it.";
  const payload = {
    pdf_info: [{
      page_size: [600, 800],
      preproc_blocks: [
        { type: "text", bbox: [50, 500, 270, 550], lines: [{ spans: [{ type: "text", content: prose }] }] },
        { type: "interline_equation", bbox: [50, 555, 270, 585], lines: [{ spans: [{ type: "text", content: "\\\\[a=b\\\\]" }] }] },
        { type: "text", bbox: [50, 590, 270, 645], lines: [{ spans: [{ type: "text", content: `Following paragraph is separate prose, not a continuation. ${prose}` }] }] }
      ]
    }]
  };
  const storage = {
    path: (...parts) => path.posix.join("/data", ...parts),
    async readJSON(file, fallback) {
      if (file.endsWith("layout.json")) return payload;
      if (file.endsWith("asset-map.json")) return {};
      return fallback;
    },
    async readText(file) { return file.endsWith("layout.json") ? JSON.stringify(payload) : ""; },
    resourceURL() { return ""; }
  };
  const service = new LayoutTranslationService(storage, { getSettings: () => ({ targetLanguage: "简体中文" }) });
  const model = await service.buildModel("equation-barrier");
  const streams = model.pages[0].restoration.streams.filter(stream => stream.debugRole === "merged_body");
  assert.equal(streams.length, 2, "an interline equation must prevent adjacent body blocks from becoming one stream");
  const formula = model.pages[0].restoration.absoluteBlocks.find(block => block.kind === "formula");
  assert.deepEqual(formula?.bbox, [50, 555, 270, 585],
    "an untagged equation must retain its original MinerU ink bbox");
}

function testSingleColumnBodyPromotion() {
  const textBlock = (bbox, lines = 5) => ({
    type: "text",
    bbox,
    lines: Array.from({ length: lines }, () => ({ spans: [{ type: "text", content: "prose" }] }))
  });
  const pages = [
    { page_size: [600, 800], preproc_blocks: [textBlock([48, 160, 552, 610]), textBlock([48, 615, 552, 740])] },
    { page_size: [600, 800], preproc_blocks: [textBlock([48, 60, 552, 430]), textBlock([48, 435, 552, 730])] }
  ];
  const profile = LayoutHelpers.inferSingleColumnProfile(pages);
  assert(profile, "repeated full-width source text must establish a single-column profile");
  assert.equal(profile.supportingPages.size, 2);

  const anchor = {
    kind: "text", bbox: [48, 430, 552, 700], originalLineCount: 7,
    pageIndex: 3, debugRole: "body_candidate"
  };
  const transition = {
    kind: "text", bbox: [48, 350, 230, 366], originalLineCount: 1,
    pageIndex: 3, debugRole: "text"
  };
  const frontMatter = {
    kind: "text", bbox: [48, 110, 250, 126], originalLineCount: 1,
    pageIndex: 0, debugRole: "text"
  };
  const inherited = LayoutHelpers.inheritStableSingleColumnShortItems(
    [anchor, transition, frontMatter], 600, 800, profile
  );
  assert.equal(inherited[1].debugRole, "body_inherited",
    "a later left-aligned derivation transition must inherit the body baseline");
  assert.equal(inherited[0].debugRole, "body_candidate",
    "the stable full-width anchor must retain its normal body role");
  assert.equal(inherited[2].debugRole, "text",
    "first-page metadata geometry must remain on the legacy path");

  const twoColumnItems = [
    anchor,
    { kind: "text", bbox: [48, 220, 280, 620], originalLineCount: 8, pageIndex: 3, debugRole: "body_candidate" },
    { kind: "text", bbox: [320, 220, 552, 620], originalLineCount: 8, pageIndex: 3, debugRole: "body_candidate" },
    transition
  ];
  const blocked = LayoutHelpers.inheritStableSingleColumnShortItems(twoColumnItems, 600, 800, profile);
  assert.equal(blocked.at(-1).debugRole, "text",
    "parallel columns on the current page must veto the single-column short-text role");
}

function testEquationNumberAnchorUsesLocalColumns() {
  const numberRight = LayoutHelpers.equationNumberRightForBBox;
  const textBoxes = [
    { columnKey: "column-0", left: 40, right: 180, top: 180, bottom: 310 },
    { columnKey: "column-1", left: 210, right: 380, top: 180, bottom: 310 },
    { columnKey: "column-2", left: 410, right: 580, top: 180, bottom: 310 }
  ];
  const edges = { bodyBoxes: [], textBoxes };
  assert.deepEqual(
    numberRight([250, 220, 320, 246], 620, edges),
    380,
    "a numbered equation in a three-column middle lane must anchor its number at that lane's right edge"
  );
  assert.deepEqual(
    numberRight([80, 220, 170, 246], 620, edges),
    180,
    "ordinary text geometry, even when not body-fitted, must support a single-column number anchor"
  );
  assert.deepEqual(
    numberRight([100, 220, 350, 246], 620, edges),
    380,
    "a formula spanning two locally visible columns must place its number at the outer span edge"
  );
  assert.deepEqual(
    numberRight([250, 500, 320, 526], 620, edges),
    320,
    "without nearby column evidence, the number must stay at the source formula edge"
  );
  const edgesWithShortTransition = {
    "column-0": 288,
    bodyBoxes: [
      { columnKey: "column-0", left: 44, right: 288, top: 400, bottom: 450 }
    ],
    textBoxes: [
      { columnKey: "column-0", left: 54, right: 171, top: 490, bottom: 503 },
      { columnKey: "column-0", left: 44, right: 288, top: 400, bottom: 450 }
    ]
  };
  assert.deepEqual(
    numberRight([44, 513, 94, 525], 612, edgesWithShortTransition),
    288,
    "a formula vertically near an incomplete transition line must still align with the full column right edge"
  );
}

async function testLayoutCodeAndContentsRules() {
  const contents = [
    "1 Introduction ........ 1",
    "1.1 Motivation ........ 3",
    "1.2 Contributions ........ 5",
    "2 Methods ........ 9",
    "2.1 Dataset ........ 11",
    "2.2 Evaluation ........ 14",
    "3 Results ........ 18"
  ].join("\n");
  const tocLines = [{ spans: [{ type: "text", content: contents }] }];
  const rows = LayoutHelpers.parseTocRows(tocLines);
  assert.equal(rows.length, 7, "an embedded multi-line contents span must be split into logical rows");
  assert.equal(
    LayoutHelpers.layoutVisualLineCount([{ spans: [{ type: "text", content: "Keywords:\nUnderwater explosion\nShock wave\nBubble motion\nEulerian finite element formulation\nContinuous simulation" }] }]),
    6,
    "embedded span newlines must count as visual source lines"
  );
  assert.equal(LayoutHelpers.layoutVisualLineCount([{ spans: [{ type: "text", content: "Abstract" }] }]), 1);
  assert.equal(rows[1].level, 1, "numbered subsections must retain their contents indentation level");
  assert.equal(rows[6].page, "18", "contents page numbers must be retained separately from titles");
  assert.equal(
    LayoutHelpers.parseTocRows([{ spans: [{ type: "text", content: "1 First item\n2 Second item\n3 Third item\n4 Fourth item\n5 Fifth item\n6 Sixth item" }] }]),
    null,
    "an ordinary numbered list without leader/page pairs must not be classified as contents"
  );

  const codeBlock = {
    type: "code",
    guess_lang: "python",
    bbox: [50, 300, 550, 430],
    lines: [{ spans: [{ type: "text", content: "def outer():" }] }],
    blocks: [{
      type: "code_body",
      lines: [
        { spans: [{ type: "text", content: "    if ready:" }] },
        { spans: [{ type: "text", content: "        return value" }] }
      ]
    }]
  };
  assert.equal(
    LayoutHelpers.codeTextFromBlock(codeBlock),
    "def outer():\n    if ready:\n        return value",
    "code/code_body collection must preserve leading indentation"
  );
  assert.equal(
    context.LitMTransPort.codeTextFromLayoutBlock(codeBlock),
    "def outer():\n    if ready:\n        return value",
    "the typed core model must preserve the same code text"
  );
  assert.equal(context.LitMTransPort.parseTocRows(tocLines).length, 7);
  const normalizedToc = context.LitMTransPort.normalizeLayoutBlock(
    { type: "text", lines: tocLines },
    1,
    0
  );
  assert(normalizedToc.text.includes("\n1.1 Motivation"), "typed translation input must retain contents row boundaries");

  const payload = {
    pdf_info: [{
      page_size: [600, 800],
      preproc_blocks: [
        { type: "text", bbox: [45, 60, 555, 250], lines: tocLines },
        codeBlock
      ]
    }]
  };
  const storage = {
    path: (...parts) => path.posix.join("/data", ...parts),
    async readJSON(file, fallback) {
      if (file.endsWith("layout.json")) return payload;
      if (file.endsWith("asset-map.json")) return {};
      return fallback;
    },
    async readText(file) { return file.endsWith("layout.json") ? JSON.stringify(payload) : ""; },
    resourceURL() { return ""; }
  };
  const service = new LayoutTranslationService(storage, { getSettings: () => ({ targetLanguage: "简体中文" }) });
  const model = await service.buildModel("code-and-contents");
  const translationRecords = await service.extractRecords("code-and-contents");
  assert(
    translationRecords.find(record => record.type === "text")?.text.includes("\n1.1 Motivation"),
    "runtime layout translation input must retain contents row boundaries"
  );
  const tocStream = model.pages[0].restoration.streams.find(stream => stream.debugRole === "toc");
  assert(tocStream, "recognized contents must remain a dedicated stream instead of being promoted to body prose");
  assert.equal(tocStream.items[0].tocRows.length, 7);
  const renderedCode = model.pages[0].restoration.absoluteBlocks.find(block => block.kind === "code");
  assert(renderedCode, "code/code_body must be carried to the absolute layout renderer as code");
  assert.equal(renderedCode.codeLanguage, "python");
  assert(renderedCode.text.includes("\n    if ready:"), "the rendered code model must retain indentation");

  const workbenchSource = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");
  const workbenchCSS = fs.readFileSync(path.join(root, "src", "workbench.css"), "utf8");
  assert(workbenchSource.includes('<pre class="layout-code"'), "the workbench must render code through pre/code");
  assert(workbenchSource.includes("function clampTranslatedCodeOverflow()"), "translated code blocks must have a dedicated overflow fitter");
  assert(workbenchSource.includes("code.scrollHeight > code.clientHeight + 1"), "code fitting must measure the pre container instead of silently clipping it");
  assert(workbenchSource.includes("code.style.overflow = 'auto';"), "overlong code must fall back to an internal scrollbar");
  assert(workbenchSource.includes("clampTranslatedCodeOverflow();"), "the translated code fitter must run with the layout fit pass");
  assert(workbenchSource.includes("const minFont = 7.0;"), "code fitting must preserve a readable minimum font size");
  assert(workbenchSource.includes("const minLineRatio = 1.10;"), "code fitting must preserve a readable minimum line-height");
  assert(workbenchCSS.includes("line-height: inherit;"), "code line-height must inherit the fitted parent value");
  assert(workbenchSource.includes("renderLayoutTocRows"), "the workbench must use the dedicated contents row renderer");
  assert(
    workbenchSource.includes("tuneEach('.layout-flow-stream.debug-text[data-flow-kind=\"text\"][data-original-lines=\"multi\"]', {"),
    "multi-line text must use the same Python-parity fitting selector"
  );
  assert(workbenchSource.includes("litmtrans-layout-fit-runtime:v23:"), "layout fitting must invalidate snapshots that predate inherited single-column body text");
  assert(workbenchSource.includes('U.hashString(String(node.textContent || "").replace(/\\s+/g, " ").trim())'),
    "a retranslated page must not reuse a fit snapshot for different text");
  assert(workbenchSource.includes('pending = restored.size === active.length ? [] : active;'),
    "a partial cache miss must rerun the document-wide fitter over every page");
  assert(
    workbenchSource.includes("function queueLayoutPageScaleRefresh(container)")
      && workbenchSource.includes("page._litmtransRefreshLayoutScale?.(false);")
      && workbenchSource.includes("queueLayoutPageScaleRefresh(els[\"translation-layout\"]);"),
    "a completed layout and AI-rail visibility transitions must reapply the existing page scale without rebuilding or refitting text"
  );
  assert(
    workbenchSource.includes("const savedLayoutFont = Number(layoutFonts[documentID]);")
      && workbenchSource.includes("state.layoutFontPt = Number.isFinite(savedLayoutFont) && savedLayoutFont > 0")
      && workbenchSource.includes("else delete document.body.dataset.userBodyFontPt;"),
    "an absent per-document layout font must leave body typography to the automatic fitter instead of treating the stream-reader default as an override"
  );
  assert(
    workbenchSource.includes("function reflectAutomaticLayoutFont(container)")
      && workbenchSource.includes("state.detectedLayoutFontPt = Math.round(fontPt * 10) / 10;")
      && workbenchSource.includes("reflectAutomaticLayoutFont(container);"),
    "the layout font control must reflect the fitted body size before a first user adjustment becomes a per-document override"
  );
  const workbenchMarkup = fs.readFileSync(path.join(root, "src", "workbench.xhtml"), "utf8");
  assert(workbenchMarkup.includes('id="reader-font-input" type="number" step="any" value="" placeholder="自动"'),
    "layout fitting must not advertise the unrelated 12pt stream-reader default while its automatic result is pending");
  assert(workbenchSource.includes('els["reader-font-input"].value = automaticLayout ? "" : value;')
      && workbenchSource.includes("else delete layoutReaderFonts[documentID];"),
    "clearing the layout font control must restore automatic fitting instead of persisting a 12pt override");
  assert(
    workbenchSource.includes("demoteFalseSingleLineText(active);")
      && workbenchSource.includes("function demoteFalseSingleLineText(pages = null)"),
    "the active Zotero layout fit path must demote MinerU false single-line blocks before restoring a fit snapshot"
  );
  assert(workbenchSource.includes("installLayoutImageMemoryManager"), "long layout documents must unload distant images");
  assert(workbenchSource.includes('rootMargin: "1800px 0px"'), "nearby pages must be prefetched before they enter the viewport");
  assert(workbenchSource.includes("await prepareLayoutImagesForPrint();"), "PDF export must restore and await distant images");
  assert(workbenchSource.includes('window.addEventListener("beforeprint", restoreLayoutImagesForPrintEvent)'), "system printing must restore distant images");
  assert(workbenchSource.includes('window.addEventListener("afterprint", resumeLayoutImageMemoryManagement)'), "image eviction must resume after printing");
  assert(workbenchCSS.includes(".toc-leader"), "contents rows must expose a dotted leader column");
  assert(workbenchCSS.includes("content-visibility: auto"), "offscreen layout pages must avoid unnecessary paint/layout work");
  const controllerSource = fs.readFileSync(path.join(root, "src", "controller.js"), "utf8");
  assert(
    controllerSource.includes('doc.getElementById("litmtrans-reader-toolbar-button")')
      && controllerSource.includes('button.id = "litmtrans-reader-toolbar-button";'),
    "Reader toolbar rendering must deduplicate the LitMTrans entry point after host redraws"
  );
}

function testLayoutTranslationValidation() {
  assert.equal(
    LayoutHelpers.layoutLinesToHTML([
      { spans: [{ type: "text", content: "first" }] },
      { spans: [{ type: "text", content: "second" }] }
    ]),
    "first<br />second",
    "layout HTML must be valid for the XHTML workbench"
  );
  assert.equal(LayoutHelpers.safeLayoutTextToHTML("first\nsecond"), "first<br />second");
  const glossaryParagraphs = LayoutHelpers.symbolGlossaryParagraphs({
    symbolGlossary: true,
    html: "\\(a\\)alpha<br />\\(b\\)beta",
    text: "\\(a\\)alpha\n\\(b\\)beta",
    translatedText: "\\(a\\) 阿尔法\n\n\\(b\\) 贝塔"
  });
  assert.equal(glossaryParagraphs.length, 2,
    "translated nomenclature rows must remain independent layout paragraphs");
  assert.equal(glossaryParagraphs[1].parts[0].translatedText, "\\(b\\) 贝塔");
  assert(LayoutHelpers.hasUnsafeControlCharacters("bad\bTeX"));
  assert.equal(LayoutHelpers.sanitizeModelText("bad\bTeX\f"), "badTeX");
  const parser = new LayoutTranslationService(new MemoryStorage(), { getSettings: () => ({ targetLanguage: "简体中文" }) });
  const transportRecord = { id: "transport", type: "text", text: "Source \\(x\\)." };
  assert.deepEqual(
    parser.parseTranslationResponse(
      JSON.stringify({ translations: [{ id: "transport", text: "译文\b" }], formula_replacements: [] }),
      [transportRecord]
    ).translations,
    {},
    "JSON escape artefacts from model TeX must be retried instead of reaching the renderer"
  );
  assert.equal(
    LayoutHelpers.plainBlockText({
      lines: [{ spans: [
        { type: "text", content: "At " },
        { type: "equation_inline", content: "\\(R / R _ { 0 } = 6\\)" },
        { type: "text", content: ", the afterflow dominates." }
      ] }]
    }),
    "At \\(R / R _ { 0 } = 6\\), the afterflow dominates.",
    "translation records must preserve one canonical delimiter pair for inline equation spans"
  );
  const unchangedModelAnswer = {
    id: "unchanged-model-answer",
    type: "text",
    text: "A sufficiently long English answer may be intentionally retained by a model and must not trigger a paid retry from a language heuristic."
  };
  assert.equal(
    LayoutHelpers.recordsNeedingRetry([unchangedModelAnswer], { [unchangedModelAnswer.id]: unchangedModelAnswer.text }).length,
    0,
    "an unchanged model answer must not trigger a language-based retry"
  );

  const fragment = {
    id: "fragment",
    type: "text",
    text: "The result indicates that the proposed mechanism affects the observed pheno-"
  };
  assert(LayoutHelpers.looksOverexpanded(fragment, "海马编码与地点和事件有关的记忆。".repeat(20)));
  assert.equal(
    LayoutHelpers.repairEquationReferenceTranslation("See Eqs. (3) and (4).", "见式 3 和式 4。"),
    "见式 (3) 和式 (4)。"
  );
  const formula = {
    id: "formula",
    type: "text",
    text: "The measured value is \\(x + y\\) under compression."
  };
  assert(M.mathIntegrityIssue(formula.text, "测得的数值为 \\(x+y\\)。"));
  assert.equal(
    M.mathRetryIssue(formula.text, "测得的数值为 \\(x+y\\)。"),
    "",
    "same-count formula spelling differences are review warnings, not retry triggers"
  );
  assert.equal(
    LayoutHelpers.recordsNeedingRetry(
      [formula],
      { formula: "测得的数值为 \\(x+y\\)。" },
      "简体中文"
    ).length,
    0
  );
  assert.equal(
    LayoutHelpers.recordsNeedingRetry(
      [formula],
      { formula: "测得的数值为 \\(x-z\\)。" },
      "简体中文"
    ).length,
    0,
    "same-count formula-body differences must be review warnings, not layout retries"
  );
  assert.equal(
    LayoutHelpers.recordsNeedingRetry(
      [formula],
      { formula: "测得的数值为 x+y。" },
      "简体中文"
    ).length,
    1,
    "losing a formula delimiter remains a structural retry condition"
  );
  const variableList = {
    id: "variable-list",
    type: "text",
    text: "where \\(n_w, n_g, \\rho_w\\) and \\(p\\) denote the variables."
  };
  assert.equal(
    M.mathRetryIssue(variableList.text, "式中 \\(n_w\\)、\\(n_g\\)、\\(\\rho_w\\) 和 \\(p\\) 表示这些变量。"),
    "",
    "safe formula-list splitting must not spend another translation request"
  );
  assert.equal(
    M.mathRetryIssue(
      "After normalizing by \\(\\Delta E\\), the result contains parameter M.",
      "用 \\(\\Delta E\\) 归一化后，结果包含参数 \\(M\\)。"
    ),
    "",
    "wrapping a source-side bare variable in TeX is a safe formatting repair"
  );
  assert.equal(
    M.mathRetryIssue(
      "After normalizing by \\(\\Delta E\\), the result contains parameter M.",
      "用 \\(\\Delta E\\) 归一化后，结果包含参数 \\(Z\\)。"
    ),
    "",
    "additional TeX is audited but must not trigger another paid request"
  );
  assert.equal(
    M.mathRetryIssue("速度为 \\(u_{sw}\\)。", "速度为 \\(u_{{sw}}\\)。"),
    "",
    "redundant nested TeX braces must not trigger a paid retry"
  );
  assert.equal(
    M.mathRetryIssue("元素 \\(\\mathrm{H}\\)。", "元素 \\(H\\)。"),
    "",
    "equivalent mathrm presentation must not trigger a paid retry"
  );
  assert.equal(
    M.mathRetryIssue("参数 \\(C_p = 1; (ii)\\)。", "参数 \\(C_p = 1\\) (ii)。"),
    "",
    "an OCR list marker moved out of a formula must not trigger a paid retry"
  );
  assert(
    M.mathRetryIssue("参数 \\(x+y\\)。", "参数 \\(x+z\\)。").includes("标准化源"),
    "real formula changes must return a concrete normalized diff"
  );
}

async function testManualLayoutJSONLProtocol() {
  const records = [
    { id: "p001_b0001", page: 1, type: "text", text: "First source line with \\(x+y\\)." },
    { id: "p001_b0002", page: 1, type: "title", text: "Second source block" },
    { id: "p001_b0003", page: 1, type: "text", text: "Third source block" }
  ];
  const service = new LayoutTranslationService(
    new MemoryStorage(),
    { getSettings: () => ({ targetLanguage: "简体中文" }) }
  );
  service.extractRecords = async () => records;
  const pipeline = new DocumentPipeline({
    storage: {},
    mineru: { loadParsed: async () => ({ hasLayout: true }) },
    translation: {},
    layout: service,
    chat: {},
    getSettings: () => ({ targetLanguage: "简体中文" })
  });

  const command = await pipeline.manualTranslationCommand({ documentID: "manual-jsonl" }, "layout");
  assert(command.includes("JSON Lines"));
  assert(command.includes('{"id":"原始id","text":"该id对应的译文"}'));
  assert(command.includes("不要添加外层对象、外层数组或 `translations` 字段"));
  assert(!command.includes('{"translations":[{"id":"...","text":"..."}]}'),
    "the manual command must no longer require one aggregate JSON document");

  const firstText = "第一行\n第二行保留 \\(x+y\\)。";
  const firstLine = JSON.stringify({ id: records[0].id, text: firstText });
  const secondLine = JSON.stringify({ id: records[1].id, text: "第二个文本块" });
  const unknownLine = JSON.stringify({ id: "unknown", text: "不应导入" });
  const truncatedResponse = [
    '模型回答：以下是“JSON Lines”记录。',
    "```text",
    firstLine,
    unknownLine,
    secondLine,
    '{"id":"p001_b0003","text":"未闭合的最后一条记录'
  ].join("\n");
  const parsed = service.parseManualTranslationResponse(truncatedResponse, records).translations;
  assert.equal(parsed[records[0].id], firstText,
    "manual JSONL must preserve escaped newlines and TeX backslashes");
  assert.equal(parsed[records[1].id], "第二个文本块");
  assert.equal(parsed[records[2].id], undefined,
    "an incomplete final record must not invalidate earlier complete records");
  assert.equal(parsed.unknown, undefined);

  const legacy = service.parseManualTranslationResponse(JSON.stringify({
    translations: records.map((record, index) => ({ id: record.id, text: `旧格式译文${index + 1}` }))
  }), records).translations;
  assert.deepEqual(Object.keys(legacy), records.map(record => record.id),
    "legacy aggregate manual answers must remain readable");

  const truncatedLegacy = [
    '{"translations":[',
    JSON.stringify({ id: records[0].id, text: "旧格式中已完成的记录" }) + ",",
    '{"id":"p001_b0002","text":"未闭合"'
  ].join("\n");
  assert.equal(
    service.parseManualTranslationResponse(truncatedLegacy, records).translations[records[0].id],
    "旧格式中已完成的记录",
    "the compatibility parser should also salvage complete rows from a truncated legacy answer"
  );

  const normalized = service.normalizeManualTranslations(records, [truncatedResponse]);
  assert.deepEqual(Object.keys(normalized), [records[0].id, records[1].id]);
  const merged = await service.mergeManualTranslationResponse(
    "manual-jsonl",
    { [records[0].id]: "先前译文" },
    JSON.stringify({ id: records[2].id, text: "第三个文本块" })
  );
  assert.equal(merged.translations[records[0].id], "先前译文");
  assert.equal(merged.translations[records[2].id], "第三个文本块");
  assert.equal(merged.parsedBlocks, 1);

  const recovery = await pipeline.manualTranslationRecoveryCommand(
    { documentID: "manual-jsonl" },
    "layout",
    normalized
  );
  assert(recovery.includes("JSON Lines"));
  assert(recovery.includes(records[2].id));
  assert(!recovery.includes(`\"id\": \"${records[0].id}\"`),
    "manual recovery must request only IDs still missing after JSONL salvage");

  const apiCalls = [];
  const apiService = new LayoutTranslationService(new MemoryStorage(), {
    async complete(messages, options) {
      apiCalls.push({ messages, options });
      return {
        text: JSON.stringify({
          translations: [{ id: records[0].id, text: "第一段来源文本保留 \\(x+y\\)。" }]
        })
      };
    }
  });
  await apiService.translateGroup(
    [records[0]], "", "", "api-unchanged", "identity",
    { targetLanguage: "简体中文" }, 0, 1, null, null
  );
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].options.responseFormat, "json_object",
    "automatic API layout translation must keep its structured JSON response mode");
  assert(String(apiCalls[0].messages[1].content).includes('{"translations":[{"id":"...","text":"..."}]}'),
    "automatic API layout translation must keep its existing aggregate response prompt");
  assert(!String(apiCalls[0].messages[1].content).includes("JSON Lines"));
}

async function testDeferredLayoutRetryPreservesTrueMissingState() {
  const storage = new MemoryStorage();
  const llm = {
    async complete() {
      return { text: JSON.stringify({ translations: [] }), reasoning: "" };
    }
  };
  const service = new LayoutTranslationService(storage, llm);
  service.parseTranslationResponse = () => ({ translations: {}, formulaReplacements: {} });
  const record = {
    id: "p001_b0001",
    page: 1,
    type: "text",
    text: "A sufficiently long English source paragraph must remain absent until document-wide validation classifies it."
  };
  const result = await service.translateGroup(
    [record],
    "",
    "",
    "deferred-missing",
    "identity",
    {
      provider: "gemini",
      baseURL: "https://example.invalid",
      model: "test",
      apiKey: "test",
      targetLanguage: "简体中文",
      deferLayoutRetry: true
    },
    0,
    1
  );
  assert.equal(result.translations[record.id], undefined);
  const classified = LayoutHelpers.classifyRetryRecords([record], result.translations);
  assert.deepEqual([...classified[0].reasons], ["missing"]);
}

function testLayoutWholePaperGrouping() {
  const service = new LayoutTranslationService({}, {});
  const records = Array.from({ length: 205 }, (_, index) => ({
    id: `p001_b${String(index + 1).padStart(4, "0")}`,
    text: `Block ${index + 1}`
  }));
  const wholePaper = service.groupRecords(records, 0, 0);
  assert.equal(wholePaper.length, 1);
  assert.equal(wholePaper[0].length, records.length);
  const grouped = service.groupRecords(records, 0, 80);
  assert.equal(grouped.length, 3);
  assert.deepEqual(grouped.flat().map(record => record.id), records.map(record => record.id));
}

async function testLayoutConcurrentGroupsAndCache() {
  const storage = new MemoryStorage();
  const records = Array.from({ length: 12 }, (_, index) => ({
    id: `p001_b${String(index + 1).padStart(4, "0")}`,
    page: 1,
    type: "text",
    text: `Source block number ${index + 1} contains enough English words for deterministic translation validation.`
  }));
  let active = 0;
  let maximumActive = 0;
  const maximumActiveByProvider = new Map();
  let requestCount = 0;
  const attemptsByID = new Map();
  const llm = {
    getSettings: () => ({
      provider: "gemini",
      baseURL: "https://example.invalid",
      model: "test-model",
      apiKey: "not-a-secret",
      targetLanguage: "简体中文",
      layoutChunkChars: 0,
      layoutChunkBlocks: 1
    }),
    resolveConfig: options => options,
    ensureConfiguredModel: async options => options
  };
  const service = new LayoutTranslationService(storage, llm);
  service.loadLayout = async () => ({ rawText: "stable-layout-source" });
  service.extractRecords = async () => records;
  service.extractFormulaContext = async () => [];
  service.buildGuide = async () => "统一术语指南";
  service.buildModel = async (_documentID, translations) => ({ translations: { ...translations } });
  service.translateGroup = async (group, _guide, _reference, _documentID, _identity, settings) => {
    requestCount++;
    for (const record of group) {
      attemptsByID.set(record.id, (attemptsByID.get(record.id) || 0) + 1);
    }
    active++;
    maximumActive = Math.max(maximumActive, active);
    const provider = String(settings.provider || "").toLowerCase();
    maximumActiveByProvider.set(
      provider,
      Math.max(maximumActiveByProvider.get(provider) || 0, active)
    );
    const ordinal = Number(group[0].id.slice(-4));
    await new Promise(resolve => setTimeout(resolve, (13 - ordinal) % 4 + 1));
    active--;
    return {
      translations: Object.fromEntries(group.map(record => {
        const recordOrdinal = Number(record.id.slice(-4));
        return [
          record.id,
          attemptsByID.get(record.id) === 1
            ? record.text
            : `这是第 ${recordOrdinal} 个块的完整中文译文。`
        ];
      })),
      formulaReplacements: {}
    };
  };

  const first = await service.translate("concurrent-layout", {
    mode: "chunked",
    layoutChunkChars: 0,
    layoutChunkBlocks: 1,
    layoutConcurrency: 6
  });
  assert(maximumActive > 1 && maximumActive <= 3, `expected bounded concurrency, got ${maximumActive}`);
  assert.equal(requestCount, records.length + 1, "all first-pass findings must share one bounded layout retry request");
  assert([...attemptsByID.values()].every(count => count === 2), "the consolidated retry must repair every flagged block in one request");
  assert.deepEqual(Object.keys(first.translations), records.map(record => record.id), "out-of-order completions must merge in source-group order");
  assert.equal(first.meta.complete, true);

  const second = await service.translate("concurrent-layout", {
    mode: "chunked",
    layoutChunkChars: 0,
    layoutChunkBlocks: 1,
    layoutConcurrency: 6
  });
  assert.equal(second.cached, true, "a complete concurrent result must hit the final cache");
  assert.equal(requestCount, records.length + 1, "cache hit must not issue a new primary or repair request");

  const deepSeek = await service.translate("concurrent-layout-deepseek", {
    provider: "deepseek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-chat",
    mode: "chunked",
    layoutChunkChars: 0,
    layoutChunkBlocks: 1,
    layoutConcurrency: 999
  });
  assert(maximumActiveByProvider.get("deepseek") > 3 && maximumActiveByProvider.get("deepseek") <= 500,
    `expected DeepSeek layout concurrency to exceed the default cap and stay within 500, got ${maximumActiveByProvider.get("deepseek")}`);
  assert.equal(deepSeek.meta.concurrency, 500);
  assert.equal(LayoutHelpers.layoutConcurrencyLimit("gemini"), 3);
  assert.equal(LayoutHelpers.layoutConcurrencyLimit("deepseek"), 500);
  assert.equal(
    LayoutHelpers.layoutConcurrencyLimit("oneapi", "https://api.deepseek.com/v1"),
    500,
    "official DeepSeek URLs imported as OpenAI-compatible profiles must retain the DeepSeek cap"
  );
}

async function testDeepSeekFastLayoutWarmupConcurrencyAndTelemetry() {
  const storage = new MemoryStorage();
  const records = [
    { id: "p001_b0001", page: 1, type: "title", text: "Fast layout translation test title." },
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `p001_b${String(index + 2).padStart(4, "0")}`,
      page: 1,
      type: "text",
      text: (`Source paragraph ${index + 1} provides sufficient academic context for the DeepSeek cache concurrency regression test. `.repeat(32)).trim()
    }))
  ];
  storage.text.set(storage.path("fast-layout", "full.cleaned.md"), "# Fast layout translation test title\n\n![ignored](figure.png)\n\n<img src=\"ignored.png\">\n\n" + records.map(record => record.text).join("\n\n"));
  const calls = [];
  const logs = [];
  let active = 0;
  let maximumActive = 0;
  let waits = 0;
  const llm = {
    getSettings: () => ({
      provider: "deepseek", baseURL: "https://api.deepseek.com", model: "deepseek-v4-flash",
      apiKey: "test-key", targetLanguage: "简体中文", deepseekFastLayoutTranslation: true
    }),
    resolveConfig: options => options,
    ensureConfiguredModel: async options => options
  };
  const service = new LayoutTranslationService(storage, llm);
  service.loadLayout = async () => ({ rawText: "deepseek-fast-layout-source" });
  service.extractRecords = async () => records;
  service.buildModel = async (_documentID, translations) => ({ translations: { ...translations } });
  service.waitForFastCacheSettle = async () => { waits++; };
  service.translateGroup = async (group, _guide, _reference, _documentID, _identity, settings, index) => {
    calls.push({ ids: group.map(record => record.id), settings: { ...settings }, index });
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setTimeout(resolve, index < 2 ? 2 : 12));
    active--;
    return {
      translations: Object.fromEntries(group.map(record => [record.id, `高速中文译文：${record.id}`])),
      formulaReplacements: {},
      usage: {
        prompt_tokens: 1000 + index,
        completion_tokens: 100 + index,
        prompt_cache_hit_tokens: index === 1 ? 900 : (index > 1 ? 850 : 0),
        prompt_cache_miss_tokens: index === 1 ? 100 : 150
      }
    };
  };
  const result = await service.translate("fast-layout", { mode: "full_context" }, event => {
    if (event.type === "log") logs.push(event.message);
  });
  assert.deepEqual(calls[0].ids, ["p001_b0001"], "the title request must be the first fast-layout warm-up");
  assert.equal(waits, 2, "fast layout must wait one cache-settle interval after each warm-up stage");
  assert(maximumActive > 1, "cache-hit confirmation must release the remaining fast groups concurrently");
  assert(calls.every(call => call.settings.thinkingMode === "disabled"), "fast layout must force DeepSeek thinking off");
  assert(calls.every(call => call.settings.fullMarkdownContext && !call.settings.fullMarkdownContext.includes("ignored.png")), "each initial fast request must carry the same image-free Markdown context");
  assert(logs.some(message => message.includes("正在使用 DeepSeek 快速翻译")));
  assert(logs.some(message => message.includes("快速翻译已准备就绪")));
  assert(logs.some(message => message.includes("已完成第")));
  assert.equal(result.meta.translationMode, "deepseek_fast");
  assert.equal(result.meta.fastCacheTelemetry.length, calls.length);
}

async function testDeepSeekFastLayoutStopsBeforeParallelWaveWhenProbeIsBelowThreshold() {
  const storage = new MemoryStorage();
  const records = [
    { id: "p001_b0001", page: 1, type: "title", text: "Fast layout translation test title." },
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `p001_b${String(index + 2).padStart(4, "0")}`,
      page: 1,
      type: "text",
      text: (`Source paragraph ${index + 1} provides sufficient academic context for the DeepSeek cache protection regression test. `.repeat(40)).trim()
    }))
  ];
  storage.text.set(storage.path("fast-layout-cache-protection", "full.cleaned.md"), records.map(record => record.text).join("\n\n"));
  const calls = [];
  const llm = {
    getSettings: () => ({
      provider: "deepseek", baseURL: "https://api.deepseek.com", model: "deepseek-v4-flash",
      apiKey: "test-key", targetLanguage: "简体中文", deepseekFastLayoutTranslation: true
    }),
    resolveConfig: options => options,
    ensureConfiguredModel: async options => options
  };
  const service = new LayoutTranslationService(storage, llm);
  service.loadLayout = async () => ({ rawText: "deepseek-fast-layout-cache-protection-source" });
  service.extractRecords = async () => records;
  service.buildModel = async (_documentID, translations) => ({ translations: { ...translations } });
  service.waitForFastCacheSettle = async () => {};
  service.translateGroup = async (group, _guide, _reference, _documentID, _identity, _settings, index) => {
    calls.push(group.map(record => record.id));
    return {
      translations: Object.fromEntries(group.map(record => [record.id, `高速中文译文：${record.id}`])),
      formulaReplacements: {},
      usage: {
        prompt_cache_hit_tokens: index === 1 ? 49 : (index === 2 ? 59 : 0),
        prompt_cache_miss_tokens: index === 1 ? 51 : (index === 2 ? 41 : 100)
      }
    };
  };

  await assert.rejects(
    () => service.translate("fast-layout-cache-protection", { mode: "full_context" }),
    /DEEPSEEK_FAST_CACHE_PROTECTION/
  );
  assert.equal(calls.length, 3, "a below-50% second probe must send one third verification request before stopping");
  const checkpoint = await storage.readJSON(storage.path("fast-layout-cache-protection", "layout-translation", "meta.简体中文.json"), {});
  assert.equal(checkpoint.complete, false);
  assert.equal(checkpoint.completedGroups, 3);
}

async function testStaleDeepSeekFastPreferenceDoesNotAffectGemini() {
  const storage = new MemoryStorage();
  const records = [
    { id: "p001_b0001", page: 1, type: "text", text: "A source paragraph for Gemini translation." }
  ];
  const events = [];
  const calls = [];
  const llm = {
    getSettings: () => ({
      provider: "gemini",
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-test",
      apiKey: "test-key",
      targetLanguage: "简体中文",
      deepseekFastLayoutTranslation: true
    }),
    resolveConfig: options => options,
    ensureConfiguredModel: async options => options
  };
  const service = new LayoutTranslationService(storage, llm);
  service.loadLayout = async () => ({ rawText: "gemini-standard-layout-source" });
  service.extractRecords = async () => records;
  service.extractFormulaContext = async () => [];
  service.buildGuide = async () => "";
  service.buildModel = async (_documentID, translations) => ({ translations: { ...translations } });
  service.translateGroup = async (group, _guide, _reference, _documentID, _identity, settings) => {
    calls.push({ ...settings });
    return {
      translations: Object.fromEntries(group.map(record => [record.id, `中文：${record.text}`])),
      formulaReplacements: {}
    };
  };

  const result = await service.translate("gemini-stale-fast-preference", { mode: "full_context" }, event => events.push(event));
  assert.equal(result.meta.translationMode, "full_context", "a remembered DeepSeek preference must not change Gemini's translation mode");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].thinkingMode, undefined, "Gemini thinking settings must not be disabled by a remembered DeepSeek preference");
  assert(!events.some(event => /DeepSeek|快速排版/.test(String(event.message || ""))),
    "Gemini translation must not show a DeepSeek fallback or fast-mode message");
}

async function testLayoutRetriesFailedTransportGroupOnce() {
  const storage = new MemoryStorage();
  const records = [
    { id: "p001_b0001", page: 1, type: "text", text: "First source block." },
    { id: "p001_b0002", page: 1, type: "text", text: "Second source block." }
  ];
  const attempts = [];
  const warnings = [];
  const llm = {
    getSettings: () => ({
      provider: "gemini", baseURL: "https://example.invalid", model: "test-model",
      apiKey: "not-a-secret", targetLanguage: "简体中文", layoutChunkChars: 0, layoutChunkBlocks: 1
    }),
    resolveConfig: options => options,
    ensureConfiguredModel: async options => options
  };
  const service = new LayoutTranslationService(storage, llm);
  service.loadLayout = async () => ({ rawText: "transport-retry-layout-source" });
  service.extractRecords = async () => records;
  service.extractFormulaContext = async () => [];
  service.buildGuide = async () => "";
  service.buildModel = async (_documentID, translations) => ({ translations: { ...translations } });
  service.translateGroup = async (group, _guide, _reference, _documentID, _identity, settings) => {
    attempts.push({ id: group[0].id, recovery: Boolean(settings.transportRecovery) });
    if (group[0].id === records[0].id && !settings.transportRecovery) {
      throw new Error("JSON.parse: malformed response");
    }
    return { translations: { [group[0].id]: `中文：${group[0].text}` }, formulaReplacements: {} };
  };

  const result = await service.translate("transport-retry-layout", {
    mode: "chunked", layoutChunkChars: 0, layoutChunkBlocks: 1, layoutConcurrency: 1
  }, event => {
    if (event.type === "warning") warnings.push(event.message);
  });
  assert.deepEqual(attempts, [
    { id: records[0].id, recovery: false },
    { id: records[0].id, recovery: true },
    { id: records[1].id, recovery: false }
  ], "a failed group must be retried exactly once with transport recovery enabled");
  assert.equal(result.meta.complete, true);
  assert.equal(Object.keys(result.translations).length, records.length);
  assert(warnings.some(message => message.includes("正在自动重试一次")));
}

async function testLayoutFullContextIgnoresChunkLimits() {
  const storage = new MemoryStorage();
  const records = Array.from({ length: 12 }, (_, index) => ({
    id: `p001_b${String(index + 1).padStart(4, "0")}`,
    page: 1,
    type: "text",
    text: `Source block ${index + 1} contains enough English words to require a real translation.`
  }));
  const seenGroupSizes = [];
  let guideCalls = 0;
  const llm = {
    getSettings: () => ({
      provider: "gemini",
      baseURL: "https://example.invalid",
      model: "test-model",
      apiKey: "not-a-secret",
      targetLanguage: "简体中文",
      translationMode: "full_context",
      layoutChunkChars: 1,
      layoutChunkBlocks: 1,
      layoutConcurrency: 3
    }),
    resolveConfig: options => options,
    ensureConfiguredModel: async options => options
  };
  const service = new LayoutTranslationService(storage, llm);
  service.loadLayout = async () => ({ rawText: "full-context-layout-source" });
  service.extractRecords = async () => records;
  service.extractFormulaContext = async () => [];
  service.buildGuide = async () => {
    guideCalls++;
    return "不应生成";
  };
  service.buildModel = async (_documentID, translations) => ({ translations: { ...translations } });
  service.translateGroup = async group => {
    seenGroupSizes.push(group.length);
    return {
      translations: Object.fromEntries(
        group.map((record, index) => [record.id, `这是第 ${index + 1} 个版面块的完整中文译文。`])
      ),
      formulaReplacements: {}
    };
  };

  const result = await service.translate(
    "full-context-layout",
    { mode: "full_context", layoutChunkChars: 1, layoutChunkBlocks: 1, layoutConcurrency: 3 }
  );
  assert.deepEqual(seenGroupSizes, [records.length], "layout full-context mode must send every layout block in one request");
  assert.equal(guideCalls, 0, "a one-request full-context translation must not build a chunk glossary");
  assert.equal(result.meta.translationMode, "full_context");

  const chunked = await service.translate(
    "full-context-layout",
    { mode: "chunked", layoutChunkChars: 0, layoutChunkBlocks: 1, layoutConcurrency: 3 }
  );
  assert.equal(chunked.cached, false, "switching layout strategy must not reuse the other strategy's final cache");
  assert.deepEqual(
    seenGroupSizes.slice(1),
    Array(records.length).fill(1),
    "layout chunked mode must apply its block grouping limit"
  );
  assert.equal(guideCalls, 1);
  assert.equal(chunked.meta.translationMode, "chunked");
}

async function testLayoutTargetedRetryKeepsPrimaryPrefix() {
  const storage = new MemoryStorage();
  const calls = [];
  const record = {
    id: "p001_b0001",
    page: 1,
    type: "text",
    text: "A sufficiently long English sentence that remains deliberately untranslated for retry validation and layout checking."
  };
  const llm = {
    async complete(messages, options) {
      calls.push(JSON.parse(JSON.stringify(messages)));
      const text = calls.length <= 2
        ? JSON.stringify({ translations: [{ id: record.id, text: record.text }], formula_replacements: [] })
        : JSON.stringify({ translations: [{ id: record.id, text: "这是一段用于重试验证和排版检查的完整中文译文。" }], formula_replacements: [] });
      options.onText?.(text);
      return { text };
    }
  };
  const service = new LayoutTranslationService(storage, llm);
  const result = await service.translateGroup(
    [record],
    "guide",
    "",
    "doc",
    "identity",
    { targetLanguage: "简体中文" },
    0,
    1,
    null,
    null
  );
  assert.equal(calls.length, 1, "the default must not retry an unchanged LLM answer");
  assert.equal(result.translations[record.id], record.text);

  const enabledResult = await service.translateGroup(
    [record], "guide", "", "doc", "identity",
    { targetLanguage: "简体中文", enableUntranslatedCheck: true }, 0, 1, null, null
  );
  assert.equal(calls.length, 3, "the internal opt-in must retain the legacy heuristic");
  assert.deepEqual(calls[2].slice(0, 2), calls[1]);
  assert.equal(calls[2].length, 3);
  assert.equal(enabledResult.translations[record.id], "这是一段用于重试验证和排版检查的完整中文译文。");

  await service.translateGroup(
    [record], "guide", "", "doc", "identity",
    { targetLanguage: "简体中文", transportRecovery: true }, 0, 1, null, null
  );
  assert(
    String(calls.at(-1)?.[1]?.content || "").includes("Transport recovery notice"),
    "a transport-recovery retry must tell the model about malformed JSON/TeX escaping without exposing host stack traces"
  );
}

async function testLayoutFirstRetryContextPolicy() {
  const storage = new MemoryStorage();
  const calls = [];
  const sourceGroup = [
    { id: "p001_b0001", page: 1, type: "text", text: "First complete source block." },
    { id: "p001_b0002", page: 1, type: "text", text: "Second complete source block with \(x\)." }
  ];
  const llm = {
    async complete(messages) {
      calls.push(JSON.parse(JSON.stringify(messages)));
      return { text: JSON.stringify({ translations: [{ id: "p001_b0002", text: "第二个完整译文，含 \(x\)。" }] }) };
    }
  };
  const service = new LayoutTranslationService(storage, llm);
  const base = {
    targetLanguage: "简体中文",
    deferLayoutRetry: true,
    retryContextGroup: sourceGroup
  };
  await service.translateGroup(
    [sourceGroup[1]], "", "", "doc", "identity",
    { ...base, retryDetails: new Map([[sourceGroup[1].id, { reasons: ["missing"], currentTranslation: "" }]]) },
    0, 1, null, null
  );
  assert.equal(calls[0].length, 3, "the first translation-quality retry must retain its original complete group");
  assert(String(calls[0][1].content).includes(sourceGroup[0].text));

  await service.translateGroup(
    [sourceGroup[1]], "", "", "doc", "identity",
    {
      ...base,
      retryContextGroup: null,
      retryDetails: new Map([[sourceGroup[1].id, { reasons: ["formula-structure"], currentTranslation: "第二个完整译文，含 \(x\)。" }]])
    },
    0, 1, null, null
  );
  assert.equal(calls[1].length, 2, "a formula-only retry must send only the complete affected block");
  assert(!String(calls[1][1].content).includes(sourceGroup[0].text));
}

async function testLayoutFormatRetryIsSurgicalAndBounded() {
  const storage = new MemoryStorage();
  const record = {
    id: "p001_formula",
    page: 1,
    type: "text",
    text: "The value is \\(x+y\\)."
  };
  const calls = [];
  const badJSON = JSON.stringify({ translations: [{ id: record.id, text: "数值为 x+y。" }] });
  const llm = {
    async complete(messages, options) {
      calls.push({ messages: JSON.parse(JSON.stringify(messages)), options });
      return { text: badJSON };
    }
  };
  const service = new LayoutTranslationService(storage, llm);
  await service.translateGroup(
    [record], "", "", "doc", "identity",
    { targetLanguage: "简体中文", enableUntranslatedCheck: false }, 0, 1, null, null
  );
  assert.equal(calls.length, 2, "a pure formula issue must receive at most one paid format retry");
  assert.equal(calls[1].options.thinkingMode, "disabled");
  assert.equal(calls[1].options.reasoningEffort, "minimal");
  assert.equal(calls[1].messages.length, 2, "a pure format retry must not resend the full primary context");
  assert(String(calls[1].messages[1].content).includes("retry_details"));
}

class MemoryStorage {
  constructor() { this.json = new Map(); this.text = new Map(); this.bytes = new Map(); }
  path(...parts) { return path.posix.join("/mem", ...parts); }
  resourceURL(documentID, relativePath = "") { return `resource://litmtrans-data/${documentID}/${relativePath}`; }
  async ensureDir() {}
  async readJSON(file, fallback) { return this.json.has(file) ? JSON.parse(JSON.stringify(this.json.get(file))) : fallback; }
  async writeJSON(file, value) { this.json.set(file, JSON.parse(JSON.stringify(value))); }
  async readText(file, fallback = "") { return this.text.has(file) ? this.text.get(file) : fallback; }
  async writeText(file, value) { this.text.set(file, String(value)); }
  async readBytes(file) { return this.bytes.get(file) || new Uint8Array(); }
  async writeBytes(file, value) { this.bytes.set(file, new Uint8Array(value)); }
  async stat(file) {
    if (this.text.has(file)) {
      const value = this.text.get(file);
      return { type: "regular", size: String(value).length, lastModified: 1234 };
    }
    if (this.bytes.has(file)) return { type: "regular", size: this.bytes.get(file).length, lastModified: 1234 };
    return null;
  }
  async remove(file, recursive = false) {
    for (const store of [this.json, this.text, this.bytes]) {
      if (recursive) {
        for (const key of [...store.keys()]) if (key === file || key.startsWith(file + "/")) store.delete(key);
      }
      else store.delete(file);
    }
  }
  async publishFilesAtomically(entries) {
    const destinations = [];
    for (const entry of entries || []) {
      const source = entry?.source;
      const destination = entry?.destination;
      if (!source || !destination) continue;
      let moved = false;
      for (const store of [this.json, this.text, this.bytes]) {
        if (!store.has(source)) continue;
        const value = store.get(source);
        store.set(destination, value instanceof Uint8Array ? new Uint8Array(value) : JSON.parse(JSON.stringify(value)));
        store.delete(source);
        moved = true;
        break;
      }
      if (!moved) throw new Error(`Missing staged file: ${source}`);
      destinations.push(destination);
    }
    return destinations;
  }
}

function withResolvedChatModel(llm) {
  llm.resolveConfig = values => ({
    provider: "deepseek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-chat",
    ...(values || {})
  });
  llm.ensureConfiguredModel = async config => config;
  return llm;
}

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

async function testCompleteReferenceCorpus() {
  assert.equal(
    TranslationInternals.compactReferenceMarkdown("Before\n\n![figure](images/a.png)\n\nAfter"),
    "Before\n\n\nAfter"
  );
  const storage = new MemoryStorage();
  await storage.writeText("/refs/reference.md", "# Reference\n\nAcademic wording and complete discourse.");
  const llm = {
    getSettings: () => ({
      provider: "deepseek",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-chat",
      targetLanguage: "简体中文",
      translationReferencePaths: ["/refs/reference.md"]
    })
  };
  const service = new TranslationService(storage, llm);
  const result = await service.buildReferenceCorpus("doc", llm.getSettings(), null, null);
  assert(result.corpus.includes("Academic wording and complete discourse."));
  assert(result.corpus.includes("Full reference corpus 1: reference.md"));
  assert(!result.corpus.includes("/refs/reference.md"), "absolute reference paths must not be sent to the model");
}

async function testRequestAuditExcludesSecrets() {
  const storage = new MemoryStorage();
  U.setPref("requestAudit", true);
  const path = await context.LitMTrans.Storage.prototype.writeRequestAudit.call(
    storage,
    "doc",
    "流式-全文连续翻译-第1轮",
    {
      provider: "oneapi",
      baseURL: "https://gateway.invalid/v1",
      model: "test-model",
      apiKey: "must-not-appear",
      promptCacheKey: "cache-key"
    },
    [
      { role: "system", content: "system prompt" },
      { role: "user", content: "full source text" }
    ],
    300
  );
  const saved = await storage.readText(path, "");
  assert(saved.includes("system prompt"));
  assert(saved.includes("full source text"));
  assert(saved.includes("请求缓存标识: cache-key"));
  assert(!saved.includes("must-not-appear"));
  U.setPref("requestAudit", false);
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

async function testChat() {
  const storage = new MemoryStorage();
  await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Paper\n\nSource context.");
  let lastChatRequest = [];
  const llm = withResolvedChatModel({
    getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000 }),
    async complete(messages, options) {
      lastChatRequest = messages;
      assert(JSON.stringify(messages).includes("Source context"));
      assert(!JSON.stringify(messages).includes("译文上下文。"), "文献AI默认不得把整篇译文加入上下文");
      options.onText?.("回答");
      return { text: "回答", reasoning: "" };
    }
  });
  const translation = { load: async () => ({ markdown: "译文上下文。" }) };
  const chat = new ChatService(storage, llm, translation);
  const summary = chat.responseSummary({ model: "test-model", usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 20 } } }, "test-provider");
  assert(summary.includes("服务商：test-provider") && summary.includes("模型：test-model"));
  assert(summary.includes("输入：100") && summary.includes("输出：50") && summary.includes("缓存命中：20%"));
  const session = await chat.loadSession("doc");
  const result = await chat.send("doc", session.id, "这篇文章讲了什么？", { contextMode: "both" });
  assert.equal(result.message.content, "回答");
  const mindmapResult = await chat.send("doc", session.id, "请画思维导图", { contextMode: "source", mindmap: true });
  assert.equal(mindmapResult.session.messages.at(-2).formatInstruction, ChatInternals.MINDMAP_V2_FORMAT_INSTRUCTION, "mind-map V2 format must persist on the user turn");
  assert.equal(mindmapResult.session.messages.at(-2).taskType, "generic_mindmap", "generic mind-map task must persist independently from its renderer");
  assert(ChatInternals.MINDMAP_FORMAT_INSTRUCTION.includes("真实意图"), "mind-map keyword matching must be advisory, not a forced rendering command");
  assert(JSON.stringify(lastChatRequest).includes(ChatInternals.MINDMAP_V2_FORMAT_INSTRUCTION), "later requests must receive the persisted V2 format instruction as chat history");
  assert.equal(mindmapResult.session.messages.at(-2).attachments.length, 0, "a rendered mind map must never become an AI image attachment");
  assert(mindmapResult.session.messages.at(-2).taskInstruction.includes("必须使用简体中文"), "generic mind-map visible text must default to Simplified Chinese even for English source material");
  assert(mindmapResult.session.messages.at(-2).formatInstruction.includes("evidence 中逐字引用的 quote 必须保持论文原文"), "mind-map language rules must preserve exact source-language evidence quotes");
  const flowchartResult = await chat.send("doc", session.id, "请画算法流程图", { contextMode: "source", flowchart: true });
  assert.equal(flowchartResult.session.messages.at(-2).formatInstruction, ChatInternals.FLOWCHART_V2_FORMAT_INSTRUCTION, "flowchart V2 format must persist on the user turn");
  assert.equal(flowchartResult.session.messages.at(-2).taskType, "generic_flowchart", "generic flowchart task must persist independently from its renderer");
  assert(ChatInternals.FLOWCHART_FORMAT_INSTRUCTION.includes("真实意图"), "flowchart keyword matching must be advisory, not a forced rendering command");
  assert(flowchartResult.session.messages.at(-2).taskInstruction.includes("不得因为论文或上下文原文是英文而输出整句英文"), "generic flowchart visible text must not inherit the source document language");
  const keyPoints = await chat.send("doc", session.id, "请提炼全文", { contextMode: "source", taskType: "key_points" });
  assert.equal(keyPoints.session.messages.at(-2).taskType, "key_points", "key-points must be a first-class task rather than a fabricated quote");
  assert(keyPoints.session.messages.at(-2).taskInstruction.includes("要点提炼任务"), "key-points task instruction must stay on the newest user turn");
  assert(keyPoints.session.messages.at(-2).taskInstruction.endsWith(ChatInternals.DIAGRAM_CHINESE_INSTRUCTION), "key-points language rule must remain after any task preference so it cannot be overridden accidentally");
  assert(ChatInternals.PAPER_MINDMAP_TASK_INSTRUCTION.includes("原文语言"), "paper mind-map prompts must request exact source-language evidence for reliable PDF jumps");
  assert(ChatInternals.PAPER_LOGIC_FLOW_TASK_INSTRUCTION.includes("数值指标") && ChatInternals.PAPER_LOGIC_FLOW_TASK_INSTRUCTION.includes("不能翻译、改写、拼接或编造"), "paper logic-flow prompts must require substantive details and exact evidence quotes");
  const sessions = await chat.listSessions("doc");
  assert.deepEqual(sessions.map(row => row.id), ["document-chat"], "each literature attachment must expose one durable conversation");
  const cleared = await chat.clearSession("doc", session.id);
  assert.equal(cleared.id, "document-chat");
  assert.equal(cleared.messages.length, 0, "clearing history must reset only the current literature conversation");
}

async function testChatGeminiStreamTimeoutFallback() {
  const storage = new MemoryStorage();
  await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Paper\n\nSource context.");
  const calls = [];
  const llm = withResolvedChatModel({
    getSettings: () => ({
      provider: "gemini",
      targetLanguage: "简体中文",
      chatContextChars: 50000
    }),
    async complete(_messages, options) {
      calls.push({ ...options });
      if (calls.length === 1) {
        const error = new Error("first event stalled");
        error.name = "StreamTimeoutError";
        error.timeout = true;
        throw error;
      }
      assert.equal(options.stream, false);
      assert.equal(options.timeout, 0);
      options.onText?.("降级后回答");
      return { text: "降级后回答", reasoning: "" };
    }
  });
  const events = [];
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  const session = await chat.loadSession("doc");
  const result = await chat.send("doc", session.id, "解释所选内容", {}, event => events.push(event));
  assert.equal(calls.length, 2, "Gemini stream timeout must trigger exactly one non-stream retry");
  assert.equal(calls[0].timeout, 0);
  assert.equal(calls[0].firstEventTimeout, 0);
  assert.equal(calls[0].inactivityTimeout, 0);
  assert.equal(result.message.content, "降级后回答");
  assert(events.some(event => event.type === "warning"), "the transport fallback should remain visible to the user");
}

async function testChatCurrentDocumentAfterClear() {
  const storage = new MemoryStorage();
  await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Paper\n\nSource context.");
  const requests = [];
  const llm = withResolvedChatModel({
    getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000 }),
    async complete(messages, options) {
      requests.push(messages);
      options.onText?.("回答");
      return { text: "回答", reasoning: "" };
    }
  });
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  const session = await chat.loadSession("doc");
  await chat.send("doc", session.id, "第一问");
  await chat.send("doc", session.id, "追问");
  const cleared = await chat.clearSession("doc", session.id);
  await chat.send("doc", cleared.id, "清空后的第一问");

  const currentDocumentCount = request => request.filter(message =>
    message.role === "user" && JSON.stringify(message.content).includes("===== 当前Zotero文献开始 =====")
  ).length;
  assert.equal(currentDocumentCount(requests[0]), 1, "首次对话必须携带当前论文");
  assert.equal(currentDocumentCount(requests[1]), 1, "追问必须复用历史中的论文，不能重复插入");
  assert.equal(currentDocumentCount(requests[2]), 1, "清空历史后的下一轮必须重新携带当前论文");
  const persisted = await chat.loadSession("doc", cleared.id);
  assert.equal(persisted.messages[0].currentDocument, true, "清空后的首轮要重新标记为论文上下文首轮");

  const unavailable = new ChatService(new MemoryStorage(), llm, { load: async () => ({ markdown: "" }) });
  const unavailableSession = await unavailable.loadSession("missing");
  await assert.rejects(
    unavailable.send("missing", unavailableSession.id, "没有论文时不应发送"),
    /没有可用的正文/
  );
}

async function testChatImageCitationsStayDisplayOnly() {
  const storage = new MemoryStorage();
  const currentPlaceholder = "![Figure 1](images/figure-1.png)";
  await storage.writeText(
    storage.path("doc", "full.cleaned.md"),
    `# Paper\n\nEvidence.\n\n${currentPlaceholder}\n\nFigure 1 caption.`
  );
  await storage.writeJSON(storage.path("doc", "image-map.json"), [{
    id: "Figure 1", alt: "Figure 1", cleanTarget: "images/figure-1.png", warning: ""
  }]);
  await storage.writeBytes(storage.path("doc", "images", "figure-1.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  const requests = [];
  let call = 0;
  const llm = withResolvedChatModel({
    getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000 }),
    async complete(messages, options) {
      requests.push(JSON.parse(JSON.stringify(messages)));
      const text = ++call === 1 ? `结果见论文图片。\n\n${currentPlaceholder}` : "后续回答";
      options.onText?.(text);
      return { text, reasoning: "" };
    }
  });
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  const session = await chat.loadSession("doc");
  const first = await chat.send("doc", session.id, "结果在哪里？");
  assert(JSON.stringify(requests[0]).includes(ChatInternals.IMAGE_CITATION_INSTRUCTION), "the first document turn must teach the exact image citation protocol");
  assert(ChatInternals.IMAGE_CITATION_INSTRUCTION.includes("每张图片必须另起一行"));
  assert(ChatInternals.IMAGE_CITATION_INSTRUCTION.includes("错误示例"), "the image protocol must explicitly contrast the common reversed source-tag form");
  assert.equal(first.message.citedImages.length, 1, "an exact source placeholder must resolve to one visible cited image");
  assert.equal(first.message.citedImages[0].url, "resource://litmtrans-data/doc/images/figure-1.png");
  const raw = await chat.loadSession("doc", session.id, false);
  assert.equal(raw.messages[1].citedImages[0].relativePath, "images/figure-1.png");
  assert(!("url" in raw.messages[1].citedImages[0]), "persisted citations must keep only a local locator, not a presentation URL");
  assert(!JSON.stringify(raw.messages[1].citedImages).includes("base64"), "persisted citations must never duplicate image data");

  await chat.send("doc", session.id, "继续解释");
  const priorAssistant = requests[1].find(message => message.role === "assistant");
  assert.equal(typeof priorAssistant.content, "string", "a cited assistant image must re-enter API history only as its textual marker");
  assert(!JSON.stringify(priorAssistant).includes("image_url"), "display-only cited images must not become multimodal history parts");

  // MinerU restarts IMAGE_001 numbering in each paper, so source labels must
  // disambiguate identical placeholders across the current and added papers.
  const attachedPlaceholder = currentPlaceholder;
  await storage.writeText(storage.path("doc", "chat", "documents", "extra", "document.md"), attachedPlaceholder);
  await storage.writeBytes(storage.path("doc", "chat", "documents", "extra", "images", "figure-1.png"), new Uint8Array([1, 2, 3]));
  const attachedSession = {
    messages: [{
      role: "user",
      content: "附加文档",
      documents: [{
        id: "extra",
        name: "补充材料.pdf",
        markdownRelativePath: "chat/documents/extra/document.md",
        rootRelativePath: "chat/documents/extra",
        imageMap: [{ id: "Figure 1", alt: "Figure 1", cleanTarget: "images/figure-1.png" }]
      }]
    }]
  };
  const ambiguous = await chat.resolveAssistantImageCitations("doc", attachedSession, 0, attachedPlaceholder);
  assert.equal(ambiguous.length, 0, "an identical placeholder from multiple papers must not display the wrong image without a source label");
  const attached = await chat.resolveAssistantImageCitations(
    "doc", attachedSession, 0, `[图片来源：补充材料.pdf] ${attachedPlaceholder}`
  );
  assert.equal(attached.length, 1, "images from documents added later to the conversation must also be citeable");
  assert.equal(attached[0].relativePath, "chat/documents/extra/images/figure-1.png");
  const proseScoped = await chat.resolveAssistantImageCitations(
    "doc",
    attachedSession,
    0,
    `在文档《补充材料.pdf》中，最重要的图是 **${attachedPlaceholder} (FIG. 3)**。`
  );
  assert.equal(proseScoped.length, 1, "an attached document title in the same sentence must safely disambiguate a model-omitted source tag");
  const responseScoped = await chat.resolveAssistantImageCitations(
    "doc",
    attachedSession,
    0,
    `文档《补充材料.pdf》的图片如下。\n\n${"说明文字。".repeat(80)}\n\n${attachedPlaceholder}`
  );
  assert.equal(responseScoped.length, 0, "a distant document title must not guess the source of a colliding placeholder");
  const reversedCurrentTag = await chat.resolveAssistantImageCitations(
    "doc",
    attachedSession,
    0,
    `**最重要的图片：${attachedPlaceholder}**\n[图片来源：当前文献]`
  );
  assert.equal(reversedCurrentTag.length, 1, "legacy replies with a source tag immediately after the placeholder must be recovered");
  assert.equal(reversedCurrentTag[0].sourceType, "current-document", "a reversed current-document tag must never fall through to an attached document with the same placeholder");
}

async function testChatTurnMutationSemantics() {
  const storage = new MemoryStorage();
  await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Paper\n\nSource context.");
  const calls = [];
  let answerNumber = 0;
  const llm = withResolvedChatModel({
    getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000 }),
    async complete(messages, options) {
      calls.push(JSON.parse(JSON.stringify(messages)));
      const text = `回答-${++answerNumber}`;
      options.onText?.(text);
      return { text, reasoning: "" };
    }
  });
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  const initial = await chat.loadSession("doc");
  const first = await chat.send("doc", initial.id, "第一问", { contextMode: "selected" });
  const firstUserID = first.session.messages[0].id;
  const second = await chat.send("doc", initial.id, "第二问", { contextMode: "selected" });
  const secondAssistantID = second.session.messages[3].id;

  const resent = await chat.resend("doc", initial.id, firstUserID, { contextMode: "selected" });
  assert.deepEqual(
    resent.session.messages.map(message => `${message.role}:${message.content}`),
    ["user:第一问", "assistant:回答-3", "user:第二问", "assistant:回答-2"]
  );
  const resendRequest = calls[2];
  assert(resendRequest.some(message => message.role === "user" && JSON.stringify(message.content).includes("第一问")));
  assert(!resendRequest.some(message => String(message.content).includes("第二问")));
  assert(!resendRequest.some(message => String(message.content).includes("回答-2")));

  const edited = await chat.editMessage("doc", initial.id, resent.message.id, "人工修订回答");
  assert.equal(edited.session.messages[1].content, "人工修订回答");
  assert.equal(calls.length, 3, "editing an assistant response must not call the model");

  const deleted = await chat.deleteTurn("doc", initial.id, secondAssistantID);
  assert.deepEqual(
    deleted.session.messages.map(message => `${message.role}:${message.content}`),
    ["user:第一问", "assistant:人工修订回答"]
  );
  assert.deepEqual(ChatInternals.findTurnRange(deleted.session.messages, 1), { start: 0, end: 2, index: 1 });
}

async function testOrderedReferenceQuotes() {
  const quotes = [
    {
      type: "text",
      text: "First quoted passage.",
      pane: "source",
      readerMode: "zotero-reader",
      origin: "zotero-reader",
      nativePageIndex: 1,
      page: 2
    },
    { type: "formula", text: "E = mc^2", formulaTex: "E = mc^2", pane: "translation", page: 3 },
    {
      type: "text",
      text: "First quoted passage.",
      pane: "source",
      readerMode: "zotero-reader",
      origin: "zotero-reader",
      nativePageIndex: 1,
      page: 2
    }
  ];
  const normalized = ChatInternals.normalizeReferenceQuotes(quotes);
  assert.equal(normalized.length, 2, "duplicate references must be removed without changing order");
  assert.equal(normalized[0].readerMode, "zotero-reader");
  assert.equal(normalized[0].origin, "zotero-reader");
  assert.equal(normalized[0].nativePageIndex, 1, "native Zotero page index must survive persistence");
  assert.equal(
    ChatInternals.combinedReferenceText(normalized),
    "[引用 1 · 第 2 页]\nFirst quoted passage.\n\n[公式 2 · 第 3 页]\nE = mc^2"
  );
  const invalidPage = ChatInternals.normalizeReferenceQuotes([{ type: "text", text: "safe", page: "not-a-page" }]);
  assert.equal(invalidPage[0].page, 0, "invalid quote page values must normalize to zero");
  const legacyMessage = ChatInternals.normalizeMessage({
    role: "user",
    content: [{ type: "text", text: "legacy question" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }]
  });
  assert.equal(legacyMessage.content, "legacy question", "legacy multimodal message arrays must retain their text");
  assert.equal(legacyMessage.legacyContentParts.filter(part => part.type === "image_url").length, 1);
  for (const mime of ["image/bmp", "image/jp2", "image/svg+xml"]) {
    const legacyImage = ChatInternals.normalizeMessage({
      role: "user",
      content: [{ type: "image_url", image_url: { url: `data:${mime};base64,AA==` } }]
    });
    assert.equal(legacyImage.legacyContentParts.length, 1, `legacy ${mime} image must be retained`);
  }
  assert.equal(ChatInternals.normalizeMessage({ role: "assistant", content: [{ type: "image_url", image_url: { url: "https://remote.invalid/a.png" } }] }), null, "remote legacy image URLs must not be persisted");
  assert.equal(ChatInternals.normalizeMessage({ role: "user", content: [], text: "legacy text fallback" }).content, "legacy text fallback");
  const safeFilename = ChatInternals.normalizeMessage({
    role: "user",
    content: "document",
    documents: [{
      id: "doc",
      markdownRelativePath: "chat/documents/doc/paper..draft.md",
      rootRelativePath: "chat/documents/doc",
      imageMap: [{ cleanTarget: "fig..1.png" }]
    }]
  });
  assert.equal(safeFilename.documents[0].markdownRelativePath, "chat/documents/doc/paper..draft.md");
  assert.equal(safeFilename.documents[0].imageMap[0].cleanTarget, "fig..1.png");
  assert.equal(ChatInternals.normalizeMessage({
    role: "user", content: "unsafe", documents: [{
      markdownRelativePath: "chat/documents/doc/../escape.md",
      rootRelativePath: "chat/documents/doc"
    }]
  }).documents.length, 0, "path traversal segments must be rejected");
  assert.equal(ChatInternals.normalizeMessage({
    role: "user", content: "unsafe", documents: [{
      markdownRelativePath: "/chat/documents/doc/paper.md",
      rootRelativePath: "chat/documents/doc"
    }]
  }).documents.length, 0, "absolute document paths must be rejected");
  const legacyAssistant = ChatInternals.normalizeMessage({
    role: "assistant", content: "answer", thinking: "old reasoning", interrupted: "false"
  });
  assert.equal(legacyAssistant.reasoning, "old reasoning");
  assert.equal(legacyAssistant.interrupted, false, "string false must not become a truthy interruption flag");
  const invalidCounts = ChatInternals.normalizeMessage({
    role: "user", content: "counts", attachments: [{ mimeType: "image/png", relativePath: "chat/attachments/a.png", size: "bad" }],
    documents: [{ id: "d", name: "doc", markdownRelativePath: "chat/documents/d/document.md", rootRelativePath: "chat/documents/d", charCount: "bad", imageCount: "bad" }]
  });
  assert.equal(invalidCounts.attachments[0].size, 0);
  assert.equal(invalidCounts.documents[0].charCount, 0);
  assert.equal(invalidCounts.documents[0].imageCount, 0);
  const apiText = ChatInternals.messageTextForAPI({
    role: "user",
    content: "",
    referenceQuotes: normalized
  });
  assert(apiText.includes("用户引用了文档中的以下内容"));
  assert(apiText.includes("请解释这段内容的含义"));

  const storage = new MemoryStorage();
  await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Paper\n\nSource context.");
  let request = null;
  const llm = withResolvedChatModel({
    getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000 }),
    async complete(messages, options) {
      request = messages;
      options.onText?.("引用回答");
      return { text: "引用回答", reasoning: "" };
    }
  });
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  const session = await chat.loadSession("doc");
  const result = await chat.send("doc", session.id, "", {
    contextMode: "selected",
    referenceQuotes: quotes
  });
  assert.equal(result.session.messages[0].content, "");
  assert.equal(result.session.messages[0].referenceQuotes.length, 2);
  assert(request.some(message => message.role === "user" && JSON.stringify(message.content).includes("First quoted passage.")));
}

async function testLegacyChatSessionMigration() {
  const storage = new MemoryStorage();
  const llm = withResolvedChatModel({ getSettings: () => ({ targetLanguage: "简体中文" }) });
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  await storage.ensureDir(storage.path("doc", "chat"));
  await storage.writeJSON(storage.path("doc", "chat", "index.json"), [
    { id: "older", updatedAt: "2020-01-01T00:00:00Z" },
    { id: "newer", updatedAt: "2024-01-01T00:00:00Z" }
  ]);
  await storage.writeJSON(storage.path("doc", "chat", "session.older.json"), { messages: [{ role: "user", content: "old" }] });
  await storage.writeJSON(storage.path("doc", "chat", "session.newer.json"), {
    messages: [{ role: "user", content: "migrated" }], apiCacheSessionID: "legacy-cache"
  });
  const migrated = await chat.loadSession("doc");
  assert.equal(migrated.id, "document-chat");
  assert.equal(migrated.messages[0].content, "migrated");
  assert.equal(migrated.apiCacheSessionID, "legacy-cache");
  const index = await storage.readJSON(storage.path("doc", "chat", "index.json"), []);
  assert.deepEqual(index.map(row => row.id), ["document-chat", "older"]);
  const again = await chat.loadSession("doc", "older");
  assert.equal(again.id, "document-chat", "a legacy session ID must not open another conversation in embedded mode");
  assert.equal(again.messages[0].content, "migrated");
}



async function testMultimodalChat() {
  const storage = new MemoryStorage();
  await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Paper\n\nSource context.");
  const tinyPNG = "data:image/png;base64,iVBORw0KGgo=";
  let calls = 0;
  const events = [];
  const userRequests = [];
  const llm = withResolvedChatModel({
    getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000 }),
    async complete(messages, options) {
      calls++;
      const user = [...messages].reverse().find(message => message.role === "user");
      assert(Array.isArray(user.content));
      userRequests.push(user.content);
      const imageIndex = user.content.findIndex(part => part.type === "image_url" && part.image_url.url.startsWith("data:image/png;base64,"));
      const questionIndex = user.content.findIndex(part => part.type === "text" && part.text.includes("当前最新一轮用户问题"));
      assert(imageIndex >= 0, "the latest pasted image must reach the model payload");
      assert(questionIndex > imageIndex, "the current question must follow its pasted image so the visual reference is unambiguous");
      options.onText?.("图像回答");
      return { text: "图像回答", reasoning: "" };
    }
  });
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  const session = await chat.loadSession("doc");
  const first = await chat.send("doc", session.id, "解释截图", {
    contextMode: "source",
    images: [{
      name: "image.png",
      originalName: "image.png",
      source: "paste",
      capturedAt: "2026-08-04T02:34:55.123Z",
      mimeType: "image/png",
      dataURL: tinyPNG,
      width: 1177,
      height: 256,
      originalWidth: 262,
      originalHeight: 57,
      optimizedForVision: true
    }]
  }, event => events.push(event));
  const second = await chat.send("doc", first.session.id, "我指的是当前这张图", {
    contextMode: "source",
    images: [{
      name: "image.png",
      originalName: "image.png",
      source: "paste",
      capturedAt: "2026-08-04T02:35:37.456Z",
      mimeType: "image/png",
      dataURL: tinyPNG,
      width: 1177,
      height: 256,
      originalWidth: 262,
      originalHeight: 57,
      optimizedForVision: true
    }]
  }, event => events.push(event));
  assert.equal(calls, 2);
  const users = second.session.messages.filter(message => message.role === "user");
  assert.equal(users.length, 2);
  assert.equal(users[0].attachments.length, 1);
  assert.equal(users[1].attachments.length, 1);
  assert(users[0].attachments[0].url.startsWith("resource://litmtrans-data/doc/chat/attachments/"));
  assert(U.isIdentifiedPastedImageName(users[0].attachments[0].name));
  assert(U.isIdentifiedPastedImageName(users[1].attachments[0].name));
  assert.notEqual(users[0].attachments[0].name, users[1].attachments[0].name, "successive clipboard images must remain distinguishable");
  assert(userRequests[0].some(part => part.type === "text" && part.text.includes("[用户图片 1-1]")));
  assert(userRequests[1].some(part => part.type === "text" && part.text.includes("[用户图片 2-1]")));
  assert(userRequests[1].some(part => part.type === "text" && part.text.includes("不要与论文内图片或更早轮次图片混淆")));
  assert.equal(storage.bytes.size, 2);
}

async function testMissingCurrentImageIsNotMaskedByHistory() {
  const storage = new MemoryStorage();
  await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Paper\n\nSource context.");
  const tinyPNG = "data:image/png;base64,iVBORw0KGgo=";
  let calls = 0;
  const llm = withResolvedChatModel({
    getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000 }),
    async complete(messages, options) {
      calls++;
      options.onText?.("历史图片回答");
      return { text: "历史图片回答", reasoning: "" };
    }
  });
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  const session = await chat.loadSession("doc");
  const first = await chat.send("doc", session.id, "解释第一张图", {
    contextMode: "source",
    images: [{ name: "history.png", mimeType: "image/png", dataURL: tinyPNG }]
  });
  assert.equal(calls, 1);
  first.session.messages.push({
    id: "message-current-missing",
    role: "user",
    content: "解释当前这张图",
    attachments: [{
      id: "image-current-missing",
      name: "粘贴图片-20260804-104500-000-01.png",
      mimeType: "image/png",
      relativePath: "chat/attachments/document-chat/missing-current.png",
      size: 2906,
      source: "paste",
      capturedAt: "2026-08-04T02:45:00.000Z"
    }],
    createdAt: "2026-08-04T02:45:00.000Z"
  });
  await assert.rejects(
    () => chat.generateReply("doc", first.session, first.session.messages.length - 1, { contextMode: "source" }),
    /无法读取本轮添加的图片.*粘贴图片-20260804-104500-000-01\.png/,
    "a readable historical image must not mask failure to load the current pasted image"
  );
  assert.equal(calls, 1, "the provider must not be called when the current image payload is missing");
}

async function testCurrentImageValidationSurvivesTransientPartMetadataLoss() {
  const storage = new MemoryStorage();
  await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Paper\n\nSource context.");
  const tinyPNG = "data:image/png;base64,iVBORw0KGgo=";
  let calls = 0;
  const llm = withResolvedChatModel({
    getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000 }),
    async complete(messages, options) {
      calls++;
      const user = [...messages].reverse().find(message => message.role === "user");
      assert(Array.isArray(user.content));
      assert(user.content.some(part => part.type === "image_url"));
      assert(user.content.every(part => !part.localAttachmentID), "the simulated Zotero path must strip transient part metadata");
      options.onText?.("图片已读取");
      return { text: "图片已读取", reasoning: "" };
    }
  });
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  const originalHistoryMessagesForAPI = chat.historyMessagesForAPI.bind(chat);
  chat.historyMessagesForAPI = async (...args) => {
    const history = await originalHistoryMessagesForAPI(...args);
    for (const message of history) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part?.type !== "image_url") continue;
        delete part.localAttachmentID;
        delete part.localAttachmentReference;
      }
    }
    return history;
  };
  const session = await chat.loadSession("doc");
  const result = await chat.send("doc", session.id, "解释当前图片", {
    contextMode: "source",
    images: [{
      name: "image.png",
      source: "paste",
      capturedAt: "2026-08-04T03:40:27.901Z",
      mimeType: "image/png",
      dataURL: tinyPNG
    }]
  });
  assert.equal(calls, 1);
  assert.equal(result.message.content, "图片已读取");
}

async function testCurrentImagePayloadRecoversWhenTransportBookkeepingIsLost() {
  const storage = new MemoryStorage();
  await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Paper\n\nSource context.");
  const tinyPNG = "data:image/png;base64,iVBORw0KGgo=";
  let calls = 0;
  const llm = withResolvedChatModel({
    getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000 }),
    async complete(messages, options) {
      calls++;
      const user = [...messages].reverse().find(message => message.role === "user");
      assert(Array.isArray(user.content));
      assert(user.content.some(part => part?.type === "image_url" && part.image_url.url === tinyPNG));
      options.onText?.("已从附件恢复图片");
      return { text: "已从附件恢复图片", reasoning: "" };
    }
  });
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  const originalHistoryMessagesForAPI = chat.historyMessagesForAPI.bind(chat);
  chat.historyMessagesForAPI = async (...args) => {
    const history = await originalHistoryMessagesForAPI(...args);
    args[3]?.clear();
    const latest = history[history.length - 1];
    if (Array.isArray(latest?.content)) latest.content = latest.content.filter(part => part?.type !== "image_url");
    return history;
  };
  const session = await chat.loadSession("doc");
  const result = await chat.send("doc", session.id, "解释当前图片", {
    contextMode: "source",
    images: [{
      name: "image.png",
      source: "paste",
      capturedAt: "2026-08-04T04:11:53.332Z",
      mimeType: "image/png",
      dataURL: tinyPNG
    }]
  });
  assert.equal(calls, 1);
  assert.equal(result.message.content, "已从附件恢复图片");
}

async function testPastedImageHistoryKeepsOriginalDataURL() {
  const storage = new MemoryStorage();
  await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Paper\n\nSource context.");
  const tinyPNG = "data:image/png;base64,iVBORw0KGgo=";
  let calls = 0;
  const llm = withResolvedChatModel({
    getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000 }),
    async complete(messages, options) {
      calls++;
      const user = [...messages].reverse().find(message => message.role === "user");
      assert(Array.isArray(user.content));
      assert(user.content.some(part => part?.type === "image_url" && part.image_url.url === tinyPNG));
      options.onText?.("图片历史正常");
      return { text: "图片历史正常", reasoning: "" };
    }
  });
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  const session = await chat.loadSession("doc");
  const first = await chat.send("doc", session.id, "解释当前图片", {
    contextMode: "source",
    images: [{ name: "image.png", source: "paste", mimeType: "image/png", dataURL: tinyPNG }]
  });
  const raw = await storage.readJSON(storage.path("doc", "chat", "session.document-chat.json"), null);
  assert.equal(raw.messages[0].attachments[0].dataURL, tinyPNG, "pasted image data must persist with the conversation like the Python implementation");
  await storage.remove(storage.path("doc", raw.messages[0].attachments[0].relativePath), false);
  const retry = await chat.resend("doc", first.session.id, raw.messages[0].id, { contextMode: "source" });
  assert.equal(calls, 2, "resending a historical pasted image must not depend on its cache file");
  assert.equal(retry.message.content, "图片历史正常");
}

async function testMultimodalFallback() {
  const storage = new MemoryStorage();
  await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Paper\n\nSource context.");
  const tinyPNG = "data:image/png;base64,iVBORw0KGgo=";
  let calls = 0;
  const warnings = [];
  const llm = withResolvedChatModel({
    getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000 }),
    async complete(messages, options) {
      calls++;
      const user = [...messages].reverse().find(message => message.role === "user");
      if (calls === 1) {
        assert(Array.isArray(user.content));
        throw new Error("HTTP 400: {\"error\":{\"code\":\"1210\",\"message\":\"messages.content.type 参数非法，取值范围 ['text']\"}}");
      }
      assert.equal(typeof user.content, "string");
      options.onText?.("纯文本回答");
      return { text: "纯文本回答", reasoning: "" };
    }
  });
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  const session = await chat.loadSession("doc");
  const result = await chat.send("doc", session.id, "解释截图", {
    contextMode: "selected",
    images: [{ name: "figure.png", mimeType: "image/png", dataURL: tinyPNG }]
  }, event => { if (event.type === "warning") warnings.push(event.message); });
  assert.equal(calls, 2);
  assert.equal(result.message.content, "纯文本回答");
  assert.equal(warnings.length, 1);
  assert(ChatInternals.looksLikeImageUnsupportedError(new Error("unknown image_url variant")));
  assert(ChatInternals.looksLikeImageUnsupportedError(new Error("messages.content.type 参数非法，取值范围 ['text']")));
  assert(!ChatInternals.looksLikeImageUnsupportedError(new Error("messages.content.type 参数非法，取值范围 ['json']")));
  assert(ChatInternals.looksLikeImageUnsupportedError(new Error('Failed to deserialize the JSON body into the target type: messages[0]: invalid type: string "https://example.com/test.png", expected struct OpenAICompletionImageUrl at line 1 column 184')));
  assert(ChatInternals.looksLikeImageUnsupportedError(new Error('{"code":20041,"message":"The model is not a VLM (Vision Language Model). Please use text-only prompts.","data":null}')));
  assert(ChatInternals.looksLikeImageUnsupportedError(new Error("当前模型不支持图片输入，请使用纯文本")));
  assert(!ChatInternals.looksLikeImageUnsupportedError(new Error("HTTP 413: <html><title>413 Request Entity Too Large</title></html>")));
}

async function testPayloadTooLargePreservesImageCapability() {
  const errors = [
    Object.assign(new Error("image_url request rejected"), { status: 413 }),
    new Error("HTTP 413: <html><title>413 Request Entity Too Large</title></html>"),
    new Error("Payload too large"),
    Object.assign(new Error("Request rejected"), { body: "Request entity too large: image_url" })
  ];
  for (const error of errors) {
    const storage = new MemoryStorage();
    U.setPref("nonMultimodalModelMarks", "{}");
    await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Paper\n\nSource context.");
    const tinyPNG = "data:image/png;base64,iVBORw0KGgo=";
    const model = "vision-payload-limit-test";
    let calls = 0;
    const warnings = [];
    const llm = withResolvedChatModel({
      getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000, model }),
      resolveConfig: () => ({ provider: "openai", model }),
      async complete(messages) {
        calls++;
        const user = [...messages].reverse().find(message => message.role === "user");
        if (calls === 2) {
          assert(messages.every(message => typeof message.content === "string"));
          assert(user.content.includes("解释截图"));
          return { text: "纯文本回答", reasoning: "" };
        }
        assert(Array.isArray(user.content));
        assert(user.content.some(part => part?.type === "image_url" && part.image_url.url === tinyPNG));
        if (calls === 1) throw error;
        return { text: "图片回答", reasoning: "" };
      }
    });
    const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
    const session = await chat.loadSession("doc");
    const options = {
      contextMode: "selected",
      images: [{ name: "figure.png", mimeType: "image/png", dataURL: tinyPNG }]
    };
    await chat.send("doc", session.id, "解释截图", options, event => {
      if (event.type === "warning") warnings.push(event.message);
    });
    assert.equal(calls, 2);
    assert.equal(warnings.length, 1);
    assert(warnings[0].includes("请求内容过大"));
    assert(!chat.imageUnsupportedModels.has(model));
    assert.equal(U.getPref("nonMultimodalModelMarks", "{}"), "{}");
    const saved = await chat.loadSession("doc");
    assert.equal(saved.messages[0].attachments.length, 1);
    const attachment = saved.messages[0].attachments[0];
    assert((await storage.readBytes(storage.path("doc", attachment.relativePath))).length > 0);
    assert.equal(await chat.attachmentDataURL("doc", attachment), tinyPNG);
    const reloaded = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
    await reloaded.send("doc", session.id, "解释下一张小图", options);
    assert.equal(calls, 3);
  }
}

async function testDeepSeekDeserializeFallbackAndRollback() {
  const storage = new MemoryStorage();
  U.setPref("nonMultimodalModelMarks", "{}");
  await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Paper\n\nSource context.");
  const tinyPNG = "data:image/png;base64,iVBORw0KGgo=";
  let calls = 0;
  const warnings = [];
  const llm = withResolvedChatModel({
    getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000, model: "deepseek-v4-flash" }),
    resolveConfig: () => ({ provider: "deepseek", baseURL: "https://api.deepseek.com", model: "deepseek-v4-flash" }),
    async complete(messages, options) {
      calls++;
      const user = [...messages].reverse().find(message => message.role === "user");
      if (calls === 1) {
        assert(Array.isArray(user.content));
        throw new Error('HTTP 400: {"error":{"message":"Failed to deserialize the JSON body into the target type: messages[0]: invalid type: string \\"https://example.com/test.png\\", expected struct OpenAICompletionImageUrl at line 1 column 184","type":"invalid_request_error"}}');
      }
      assert.equal(typeof user.content, "string");
      options.onText?.("降级纯文本回答成功");
      return { text: "降级纯文本回答成功", reasoning: "" };
    }
  });
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  const session = await chat.loadSession("doc");
  const result = await chat.send("doc", session.id, "分析这篇文献", {
    contextMode: "selected",
    images: [{ name: "fig.png", mimeType: "image/png", dataURL: tinyPNG }]
  }, event => { if (event.type === "warning") warnings.push(event.message); });
  assert.equal(calls, 2);
  assert.equal(result.message.content, "降级纯文本回答成功");
  assert.equal(warnings.length, 1);

  const failingLLM = withResolvedChatModel({
    getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000, model: "deepseek-v4-flash" }),
    resolveConfig: () => ({ provider: "deepseek", baseURL: "https://api.deepseek.com", model: "deepseek-v4-flash" }),
    async complete() {
      throw new Error("Fatal network error 500");
    }
  });
  const chatWithFail = new ChatService(storage, failingLLM, { load: async () => ({ markdown: "" }) });
  let failed = false;
  try {
    await chatWithFail.send("doc", session.id, "一次失败的提问", { contextMode: "source" });
  }
  catch (_) {
    failed = true;
  }
  assert(failed);
  const reloadedSession = await chatWithFail.loadSession("doc");
  assert.notEqual(reloadedSession.messages[reloadedSession.messages.length - 1]?.content, "一次失败的提问");
}

async function testDocumentImageSendOptions() {
  const storage = new MemoryStorage();
  const markdownPath = storage.path("doc", "chat", "documents", "ref", "document.md");
  const imagePath = storage.path("doc", "chat", "documents", "ref", "images", "figure.png");
  await storage.writeText(markdownPath, "# Reference\n\n![FIGURE_001](images/figure.png)\n\nBody.");
  await storage.writeBytes(imagePath, new Uint8Array([137, 80, 78, 71]));
  await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Current\n\n![FIGURE_001](images/figure.png)\n\nCurrent body.");
  await storage.writeJSON(storage.path("doc", "image-map.json"), [{ alt: "FIGURE_001", cleanTarget: "images/figure.png" }]);
  await storage.writeBytes(storage.path("doc", "images", "figure.png"), new Uint8Array([137, 80, 78, 71]));
  const chat = new ChatService(storage, withResolvedChatModel({ getSettings: () => ({ chatContextChars: 50000 }) }), null);
  const document = {
    id: "ref",
    name: "Reference",
    markdownRelativePath: "chat/documents/ref/document.md",
    rootRelativePath: "chat/documents/ref",
    imageMap: [{ alt: "FIGURE_001", cleanTarget: "images/figure.png" }]
  };
  const forcedImages = await chat.documentMessageParts("doc", {
    documents: [document],
    documentOptions: { imageMode: "full_no_images" },
    content: "请概括"
  }, new Set());
  assert.equal(forcedImages.filter(part => part.type === "image_url").length, 1, "embedded mode must ignore a caller's text-only override");
  assert(forcedImages.some(part => part.type === "text" && part.text.includes("===== 用户问题 =====")));
  const withImages = await chat.documentMessageParts("doc", {
    documents: [document],
    documentOptions: { imageMode: "full_with_images", compressImages: false, sequentialImages: true },
    content: "请概括"
  }, new Set());
  assert.equal(withImages.filter(part => part.type === "image_url").length, 1);
  const stillSequential = await chat.documentMessageParts("doc", {
    documents: [document],
    documentOptions: { imageMode: "full_with_images", compressImages: false, sequentialImages: false },
    content: "请概括"
  }, new Set());
  assert.equal(stillSequential.filter(part => part.type === "image_url").length, 1);
  assert(stillSequential.some(part => part.type === "text" && part.text.includes("Body.")));
  const currentForcedImages = await chat.currentDocumentMessageParts("doc", "请概括", null, { imageMode: "full_no_images" });
  assert.equal(currentForcedImages.filter(part => part.type === "image_url").length, 1);
  assert(currentForcedImages.some(part => part.type === "text" && part.text.includes("===== 当前Zotero文献结束 =====")));
  const currentWithImages = await chat.currentDocumentMessageParts("doc", "请概括", null, { imageMode: "full_with_images", compressImages: false });
  assert.equal(currentWithImages.filter(part => part.type === "image_url").length, 1);
  const currentStillSequential = await chat.currentDocumentMessageParts("doc", "请概括", null, { imageMode: "full_with_images", compressImages: false, sequentialImages: false });
  assert.equal(currentStillSequential.filter(part => part.type === "image_url").length, 1);
  assert(currentStillSequential.some(part => part.type === "text" && part.text.includes("Current body.")));
}

async function testImageGenerationRequest() {
  const secrets = {
    has: () => true,
    hasMinerUToken: false,
    llmKeyName: provider => `llm:${provider}`,
    getLLMKey: () => "test-key",
    setLLMKey() {}, removeLLMKey() {}, setMinerUToken() {}, removeMinerUToken() {}
  };
  const llm = new LLMService(secrets);
  llm.saveSettings({
    provider: "oneapi", baseURL: "https://gateway.invalid/v1", model: "gpt-image-test",
    showReasoning: false
  }, "chat");
  const originalRequestJSON = H.requestJSON;
  let request = null;
  H.requestJSON = async (method, url, options) => {
    request = { method, url, options };
    return { data: [{ b64_json: "iVBORw0KGgo=" }], revised_prompt: "revised" };
  };
  try {
    const result = await llm.generateImage("draw a figure", {
      imageSize: "1024x1024", imageQuality: "high", imageFormat: "png"
    });
    assert.equal(request.method, "POST");
    assert.equal(request.url, "https://gateway.invalid/v1/images/generations");
    assert.deepEqual(request.options.json, {
      model: "gpt-image-test", prompt: "draw a figure", size: "1024x1024", quality: "high", output_format: "png"
    });
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].mimeType, "image/png");
    assert(result.text.includes("revised"));
  }
  finally {
    H.requestJSON = originalRequestJSON;
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

async function testDeletedZoteroItemsClearDocumentCaches() {
  const storage = {
    documentsRoot: "/profile/litmtrans/documents",
    async list() { return ["/profile/litmtrans/documents/1-ATTACH", "/profile/litmtrans/documents/1-KEEP"]; },
    async readJSON(file, fallback) {
      const records = {
        "/profile/litmtrans/documents/1-ATTACH/document.json": { itemID: 41, parentItemID: 40 },
        "/profile/litmtrans/documents/1-KEEP/document.json": { itemID: 51, parentItemID: 50 }
      };
      return records[file] || fallback;
    },
    async remove(directory, recursive) {
      assert.equal(recursive, true, "deleted document cache must be removed recursively");
      removed.push(directory);
    }
  };
  const removed = [];
  const cleared = await context.LitMTrans.Storage.prototype.clearDocumentsForDeletedItemIDs.call(storage, [40]);
  assert.deepEqual(cleared, ["1-ATTACH"], "deleting a parent item must remove its attachment cache");
  assert.deepEqual(removed, ["/profile/litmtrans/documents/1-ATTACH"]);

  const controller = context.LitMTrans.createController({ id: "litmtrans@local", version: "1.0.0", rootURI: "file:///plugin/" });
  const originalNotifier = context.Zotero.Notifier;
  const registrations = [];
  const stopped = [];
  context.Zotero.Notifier = {
    registerObserver(observer, types, id) { registrations.push({ observer, types, id }); return 73; },
    unregisterObserver(id) { registrations.push({ unregistered: id }); }
  };
  controller.storage = { clearDocumentsForDeletedItemIDs: async ids => { stopped.push(`cleared:${ids.join(",")}`); return ["1-ATTACH"]; } };
  controller.stopOperations = tabID => stopped.push(`stopped:${tabID}`);
  controller.cleanupTab = tabID => stopped.push(`closed:${tabID}`);
  try {
    assert(controller.registerItemDeletionObserver(), "the controller must register an item notifier");
    registrations[0].observer.notify("trash", "item", [41]);
    await Promise.resolve();
    assert.deepEqual(stopped, ["stopped:litmtrans-41", "closed:litmtrans-41", "cleared:41"], "moving an item to the Zotero trash must clear its cache immediately");
    assert.equal(controller.itemNotifierID, 73, "the notifier registration ID must be retained for shutdown cleanup");
  }
  finally {
    context.Zotero.Notifier = originalNotifier;
  }
}

function testProviderCardsApplyToSelectedPurpose() {
  const controller = context.LitMTrans.createController({
    id: "litmtrans@local",
    version: "1.0.0",
    rootURI: "file:///plugin/"
  });
  const secrets = new Map();
  controller.secrets = {
    has: key => secrets.has(key),
    get: key => secrets.get(key) || "",
    set: (key, value) => secrets.set(key, value),
    remove: key => secrets.delete(key),
    llmKeyName: provider => `llm:${provider}`,
    getLLMKey: provider => secrets.get(`llm:${provider}`) || "",
    setLLMKey: (provider, value) => secrets.set(`llm:${provider}`, value),
    removeLLMKey: provider => secrets.delete(`llm:${provider}`),
    getMinerUToken: () => "",
    hasMinerUToken: () => false
  };
  controller.llm = new LLMService(controller.secrets);
  const previousCards = context.LitMTrans.Utils.getPref("providerCards", "[]");
  try {
    controller.writeProviderCards([]);
    const saved = controller.saveProviderCard({
      name: "翻译线路",
      provider: "deepseek",
      baseURL: "https://api.deepseek.com",
      apiKey: "card-key"
    });
    assert.deepEqual(controller.getProviderCardAPIKey(saved.card.id), {
      cardID: saved.card.id,
      apiKey: "card-key",
      hasAPIKey: true
    }, "a memory card editor must receive the real saved key for an unambiguous masked display");
    controller.llm.saveSettings({ provider: "deepseek", model: "remembered-translation-model" }, "translation");
    controller.llm.saveSettings({ provider: "oneapi", model: "translate-model" }, "translation");
    controller.llm.saveSettings({ provider: "openrouter", model: "chat-model" }, "chat");
    const applied = controller.applyProviderCard(saved.card.id, "translation");
    assert.equal(applied.purpose, "translation");
    assert.equal(controller.llm.getSettings("translation").provider, "deepseek");
    assert.equal(controller.llm.getSettings("translation").baseURL, "https://api.deepseek.com");
    assert.equal(controller.llm.getSettings("translation").model, "remembered-translation-model", "a card must retain that provider's remembered translation model");
    assert.equal(controller.llm.getSettings("chat").provider, "openrouter", "applying to translation must not alter a dedicated chat model");
    assert.equal(controller.llm.getSettings("translation").hasAPIKey, true);
    const cleared = controller.saveProviderCard({
      cardID: saved.card.id,
      name: "翻译线路",
      provider: "deepseek",
      baseURL: "https://api.deepseek.com",
      apiKey: ""
    });
    assert.equal(cleared.card.hasAPIKey, false, "clearing a visible memory-card key must delete it instead of silently retaining it");
    assert.equal(controller.getProviderCardAPIKey(saved.card.id).apiKey, "");
  }
  finally {
    context.LitMTrans.Utils.setPref("providerCards", previousCards);
  }
}

function testExclusions() {
  const contentRoot = path.join(root, "src");
  const files = [];
  const walk = dir => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (/\.(?:js|xhtml|css)$/i.test(name)) files.push(full);
    }
  };
  walk(contentRoot);
  const combined = files.map(file => fs.readFileSync(file, "utf8")).join("\n").toLowerCase();
  // The web translator is a supported, separately audited service.  Keep
  // only the removed local-engine and export stacks out of the package.
  for (const forbidden of ["mtranserver", "youdao_direct", "pandoc", "python-docx", "export_fidelity.lua"]) {
    assert(!combined.includes(forbidden), `forbidden excluded feature leaked into plugin: ${forbidden}`);
  }
  assert(!combined.includes("cdn.jsdelivr.net"));
  assert(!combined.includes("unpkg.com"));
}

function testWorkbenchChatRecoveryAndFormulaPreview() {
  const controller = fs.readFileSync(path.join(root, "src", "controller.js"), "utf8");
  const workbench = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");
  const xhtml = fs.readFileSync(path.join(root, "src", "workbench.xhtml"), "utf8");
  const css = fs.readFileSync(path.join(root, "src", "workbench.css"), "utf8");

  assert(controller.includes('case "operation-state"'), "workbench must be able to reconcile lost operation events");
  assert(controller.includes('case "pdf-page-count"'), "workbench must be able to check the source PDF page count before translating");
  assert(controller.includes('pdf.getPageCount()'), "source PDF page count must come from the original PDF");
  assert(workbench.includes('recommendedTranslationModeForLongPDF'), "workbench must offer a long-PDF translation-mode recommendation");
  assert(xhtml.includes('当前所译文档超过150页'), "long-PDF recommendation text must be present in the workbench dialog");
  assert(css.includes('.long-document-translation-body strong'), "the recommended chunked mode must be visually emphasized");
  assert(xhtml.includes('id="mineru-token-dialog"'), "missing MinerU credentials must have an in-workbench prompt");
  assert(xhtml.includes('data-external-url="https://mineru.net/apiManage/token"'), "the MinerU credential prompt must expose the token website link");
  assert(workbench.includes('if (method === "parse" && !await ensureMinerUTokenForParse()) return null;'), "parse must request a missing MinerU token before starting the host operation");
  assert(workbench.includes('await hostCall("save-mineru-token", { token });'), "the credential prompt must persist the token before continuing parsing");
  assert(workbench.includes('hostCall("operation-state", {}, { timeout: 5000 })'));
  assert(workbench.includes('state.running.delete("chat")'), "terminal chat events must release a stale chat lock");
  assert(
    workbench.includes("chatFollowLatest: true")
      && workbench.includes('els["chat-messages"].addEventListener("scroll", () => {')
      && workbench.includes("state.chatFollowLatest = chatIsNearBottom();")
      && workbench.includes("if (!state.chatFollowLatest) return;")
      && workbench.includes("scrollChatToLatest();")
      && !workbench.includes("if (atBottom || hasStreamingTurn)"),
    "streaming chat must pause bottom-following while the user reads history and resume after they return to the bottom"
  );
  assert(
    workbench.includes('if (!isChatReasoning) {\n        appendReasoningLog(event);\n        return;\n      }'),
    "translation and layout reasoning must go to the process log without entering the shared AI chat transcript"
  );
  assert(workbench.includes('function appendReasoningLog(event)'), "process log must render streamed translation reasoning");
  assert(
    workbench.includes("state.data?.layout?.meta?.complete\n          && Object.keys(state.data?.layout?.translations || {}).length"),
    "a partial layout checkpoint must resume instead of being treated as a forced retranslation"
  );
  assert(xhtml.includes('id="formula-preview-dialog"'));
  assert(xhtml.includes('id="formula-preview-ask"'));
  assert(xhtml.includes('id="formula-preview-copy"'));
  assert(workbench.includes("Markdown.renderTeX(equation.body || previewTex, true)"), "formula preview must render the equation body without its tag");
  assert(workbench.includes("function formulaTeXWithoutTag(value)"), "formula preview must have a tag-free TeX copy path");
  assert(workbench.includes("state.previewFormulaTeX = previewTex"), "formula preview copy state must exclude the equation tag");
  assert(workbench.includes("copyText(formulaTeXWithoutTag(layoutFormulaTeX(formula)))"), "context-menu TeX copy must exclude the equation tag");
  assert(!xhtml.includes('id="formula-preview-number"'), "formula preview must not render an equation number");
  assert(!workbench.includes("formulaPreviewNumber(equation.number)"), "formula preview must not render an equation number");
  assert(!css.includes(".formula-preview-number"), "formula preview must not reserve space for an equation number");
  assert(workbench.includes("event.clipboardData?.items"), "image paste must read clipboard items");
  assert(workbench.includes("event.clipboardData?.files"), "image paste must also read direct clipboard files");
  assert(workbench.includes('addImageFiles(files, { source: "paste" })'), "pasted images must retain their source identity");
  assert(workbench.includes("async function prepareComposerImage(file, mimeType, source)"), "small pasted images must pass through vision preparation");
  assert(workbench.includes('name.className = "pending-image-name"'), "pending pasted images must display their unique filename");
  assert(workbench.includes("function bindEditableContextMenu()"), "editable controls must provide a mouse context menu in Zotero's embedded browser");
  assert(workbench.includes('addAction("粘贴"'), "the editable-control context menu must expose paste");
  assert(workbench.includes('hostCall("clipboard-read-text")'), "mouse paste must read text from Zotero's host clipboard");
  assert(workbench.includes('(control.closest("dialog[open]") || document.body).appendChild(menu);'),
    "an editable-control menu inside a modal dialog must remain in the browser top layer");
  assert(controller.includes('case "clipboard-read-text"'), "the host must expose clipboard text to the editable-control context menu");
  const diagramViewer = fs.readFileSync(path.join(root, "src", "diagram-viewer.js"), "utf8");
  assert(diagramViewer.includes("dialog.show();") && !diagramViewer.includes("dialog.showModal();"), "the diagram viewer must remain modeless so evidence jumps can be inspected in the reader");
  assert(diagramViewer.includes("function bindWindowDrag()") && diagramViewer.includes('header.setPointerCapture?.(event.pointerId)'), "the diagram viewer title bar must support bounded pointer dragging");
  assert(css.includes(".pending-image-name"), "the pending-image filename must remain visible in the composer");
  assert(workbench.includes("function renderLayoutTranslatedText(text)"), "layout translations must have a dedicated inline-TeX rendering path");
  assert(workbench.includes("Markdown.normalizeEscapedTeXDelimiters(source)"), "persisted layout translations must normalize complete doubly escaped TeX before rendering");
  assert(workbench.includes("return useTranslation\n      ? renderLayoutTranslatedText(translated)"), "translated layout blocks must repair bare TeX before rendering");
  assert(workbench.includes("if (useTranslation && translated) return renderLayoutTranslatedText(translated);"), "translated layout fragments must repair bare TeX before rendering");
  assert(workbench.includes("function layoutTranslationPageState(page, useTranslation)"));
  assert(
    workbench.includes("const showAwaitingOverlay = Boolean(useTranslation && hasTranslatableBlocks && !hasPageTranslation);"),
    "only pages with requested-but-missing translations may show the awaiting overlay"
  );
  assert(workbench.includes("if (!showAwaitingOverlay) {"), "reference-only pages must retain their source layout in the translation pane");
  assert(workbench.includes("async function waitForLayoutFitToSettle(pageNodes)"), "layout reveal must wait for the ResizeObserver-driven fit to settle");
  assert(workbench.includes("await nextLayoutPaint();\n    await nextLayoutPaint();")
    && workbench.includes("if (!visiblePages.length) return false;")
    && workbench.includes("await ensureLayoutFit(pageNodes);"),
  "the layout mask must survive the observer turn and remain when no visible measurement occurred");
  assert(workbench.includes("container.dataset.layoutRenderVersion !== version"), "a stale layout fit must not reveal a newer pane");
  assert(workbench.includes("layoutPublicationRevision: 0"), "the workbench must track final layout publication events");
  assert(workbench.includes("state.layoutPublicationRevision += 1;"), "a final layout event must mark its model as published");
  assert(workbench.includes("if (state.layoutPublicationRevision === publicationRevision) renderLayoutPanes();"), "the bridge result must rebuild layout only when its final event was lost");
  assert(workbench.includes("await refreshState({ preserveLayout: true });"), "post-translation state refresh must not remount an already published layout");
  const saveSettingsHandler = workbench.slice(
    workbench.indexOf('els["save-settings-button"].addEventListener("click", async () => {'),
    workbench.indexOf('els["clear-document-button"].addEventListener("click", async () => {')
  );
  assert(!saveSettingsHandler.includes("renderLayoutPanes()"), "saving connection settings must not rebuild an already fitted layout");
}

function testSilentNotifications() {
  const controller = fs.readFileSync(path.join(root, "src", "controller.js"), "utf8");
  assert(controller.includes('doc.createXULElement("panel")'), "plugin errors must use a custom, non-native notification panel");
  assert(controller.includes('panel.setAttribute("noautohide", "true")'), "silent notification panel must remain actionable");
  assert(!controller.includes("prompt.alert("), "plugin must not invoke the native prompt alert, which plays system sounds");
}

function testWorkbenchStreamScrollUsesExclusiveImageTier() {
  const workbench = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");
  assert(
    workbench.includes("const sharedImageKeys = new Set(U.sharedImageAnchorKeys("),
    "stream scroll sync must establish image correspondence across both panes"
  );
  assert(
    workbench.includes("const key = U.imageAnchorKey(source);"),
    "stream scroll sync must derive image anchors from resource identity instead of pane ordinal"
  );
  assert(
    workbench.includes("new MutationObserver(() => invalidate(source)).observe(source, {"),
    "streaming Markdown replacement must invalidate cached image identities"
  );
  assert(
    workbench.includes('{ syncAnchors: true, imageLoading: "eager" }'),
    "both stream panes must load image geometry before it is used as the primary anchor tier"
  );
  assert(
    workbench.includes('const pageNodes = state.mode === "layout"'),
    "hidden layout-reader pages must never replace visible stream-reader anchors"
  );
  assert(
    workbench.includes("queueSync(lastUserPair.source, lastUserPair.target);"),
    "an image load must repeat the newest user-driven mapping after geometry changes"
  );
  assert(
    workbench.includes('mode: "image",') && workbench.includes('mode: "fallback",'),
    "stream scroll sync must keep image and legacy anchor tiers separate"
  );
  assert(
    !/fallbackAnchors\.push\(\{\s*key:\s*`image:/.test(workbench),
    "image anchors must not be mixed back into the legacy interpolation tier"
  );
}

function testLayoutReaderIsAvailableBeforeParsing() {
  const pipeline = fs.readFileSync(path.join(root, "src", "pipeline.js"), "utf8");
  const workbench = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");
  const controller = fs.readFileSync(path.join(root, "src", "controller.js"), "utf8");

  assert(pipeline.includes('canUseLayoutReader = U.extension(context.filePath) === ".pdf"'));
  assert(pipeline.includes('enableUntranslatedCheck: Boolean(payload.enableUntranslatedCheck)'));
  assert(workbench.includes('data?.item?.readerMode === "stream" ? "stream" : "layout"'));
  assert(workbench.includes('hostCall("save-reader-mode", { mode: "layout" })'));
  assert(workbench.includes('hostCall("save-reader-mode", { mode: "stream" })'));
  assert(workbench.includes('els["layout-mode-button"].disabled = !caps.canUseLayoutReader'));
  assert(!workbench.includes('els["layout-mode-button"].disabled = !caps.hasLayout'));
  assert(controller.includes('options.preview = false'), "the embedded original PDF must retain PDF.js's selectable text layer");
  assert(controller.includes('preview._isReadOnly = () => false'), "the embedded original PDF must retain native annotation interactions");
  assert(controller.includes('const readerWindow = preview._iframeWindow || frame.contentWindow'), "the embedded interactive reader must restore its outer UI for the selection toolbar");
  assert(controller.includes('#reader-ui > div > div:first-child'), "the embedded interactive reader must hide only its toolbar, not its context-menu layer");
  assert(controller.includes('preview._openContextMenu = async'), "the embedded reader must provide a popup host for native PDF context menus");
  assert(controller.includes('type: "native-pdf-selection"'), "native PDF selections must be transported to the workbench Ask AI toolbar");
  assert(workbench.includes('function askNativePDFSelection()'), "the workbench must send a native-PDF selection into the document chat");
  assert(workbench.includes('if (type === "chat-usage")'), "per-turn chat usage must be recorded without opening a notification");
  assert(workbench.includes('sourcePDFAvailable && switchToReferenceMode'), "native-PDF citations must jump in the embedded source pane before falling back to Zotero");
  assert(controller.includes('id = "litmtrans-pdf-reference-focus"'), "embedded PDF citations must restore their selected-page highlight");
  assert(workbench.includes('pdfRects: selection.pdfRects'), "native-PDF selection geometry must persist with the chat reference");
  assert(controller.includes('convertToViewportRectangle'), "native Zotero PDF selections must retain their page-relative highlight geometry");
  assert(controller.includes('pdfReaderView: "both"'), "native Zotero PDF citations must return to the dual-pane workbench view");
}

function testCompletedLayoutCreatesPDFItemAttachments() {
  const controller = fs.readFileSync(path.join(root, "src", "controller.js"), "utf8");
  const workbench = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");
  assert(controller.includes('async createLayoutComparisonPDF(sourcePath, translationPath, outputPath)'));
  assert(controller.includes('const translationTitle = `${targetLanguage}-译文-${stem}`;'), "generated translation PDFs must use the target-language prefix without a layout label");
  assert(controller.includes('const comparisonTitle = `${targetLanguage}-译文对照版-${stem}`;'), "generated comparison PDFs must use the target-language prefix without a layout label");
  assert(controller.includes('await this.createGeneratedPDFAttachment(context, translationPath, translationTitle)'));
  assert(controller.includes('await this.createGeneratedPDFAttachment(context, comparisonPath, comparisonTitle)'));
  assert(controller.includes('if (item?.getField?.("title") !== title) continue;'), "retranslation must replace generated attachments by their stable title");
  assert(controller.includes('await Zotero.Items.trashTx(id);'), "old generated attachments must be moved to trash before importing replacements");
  assert(!controller.includes('item.trashTx()'), "attachment replacement must use Zotero.Items.trashTx(), not a nonexistent item method");
  assert(controller.includes('page.drawPage(embedded,'), "comparison PDF must draw source and translation pages together");
  assert(controller.includes('const normalizePDFBytes = value => value instanceof global.Uint8Array'), "pdf-lib inputs must be normalized into its privileged runtime realm");
  assert(controller.includes('let stableChecks = 0;'), "PDF export must wait for the asynchronous writer to finish reading print DOM");
  assert(controller.includes('if (stableChecks < 12)'), "PDF export must not clean up its print snapshot after only the first written bytes");
  assert(controller.includes('const expectedPages = Math.max(0, Number(payload.expectedPages || 0));'), "printed layout PDFs must verify their expected page count");
  assert(controller.includes('const contentIndexes = Array.from({ length: expectedPages }, (_, index) => index * 2);'), "an exact Gecko continuation-page double must be compacted before page-count validation");
  assert(!controller.includes('const layoutScale = Number(payload.layoutScale || 0);'), "layout pages must be paint-scaled before printing instead of rewritten after printing");
  assert(controller.includes('const layoutPDFIdentity = String(payload.layoutIdentity || "")'), "controller must use the completed layout identity provided by the workbench");
  assert(workbench.includes('queueLayoutPDFAttachmentsAfterFinalPublication();'), "final layout event must queue PDF attachment generation");
  assert(workbench.includes('if (result?.meta?.complete === true) queueLayoutPDFAttachmentsAfterFinalPublication();'), "the first completed layout response must provide the PDF-generation fallback");
  assert(controller.includes('await this.storage.setDocumentMeta(context.documentID, { layoutPDFIdentity })'), "completed PDF exports must be persisted to avoid duplicate regeneration");
  assert(workbench.includes('withLayoutPaintPrintRoot((expectedPages, layoutPaper) =>'), "automatic PDF generation must reuse the same complete-page print root as manual export");
  assert(workbench.includes('async function waitForLayoutPDFReady()'), "PDF exports must wait for the translated layout to finish fitting");
  assert(workbench.includes('if (!await waitForLayoutPDFReady()) return null;'), "automatic attachment exports must defer while the fitting mask is active");
  assert(workbench.includes('async function withLayoutPaintPrintRoot(callback)'), "PDF export must build an isolated complete-page print root");
  assert(workbench.includes('const clone = page.cloneNode(true);'), "PDF export must retain the complete fitted page DOM");
  assert(workbench.includes('const printScale = 96 / 72;'), "source-point page coordinates must be converted to the 96dpi print canvas before printing");
  assert(workbench.includes('clone.style.transform = `scale(${printScale})`;'), "the complete page must receive one paint-only scale without rebuilding text or formulas");
  assert(workbench.includes('sheet.style.height = `${Math.max(1, printPaper.height - 1)}px`;'), "the paint container must absorb custom-paper quantization without a continuation page");
  assert(workbench.includes('contain:layout paint'), "each complete print page must contain scaled paint to prevent a blank continuation page");
  assert(workbench.includes('hostCall("export-pdf", { pane, layout: true, expectedPages, layoutPaper })'), "manual PDF export must use the same already-scaled print DOM as automatic export");
  assert(workbench.includes('document.body.dataset.printLayout = "false";'), "only stream exports may enable the legacy live-DOM print stylesheet");
  assert(workbench.includes('hostCall("create-layout-pdf-attachments", { layoutIdentity, targetLanguage, expectedPages, layoutPaper })'), "automatic PDF attachments must preserve the completed translation language while using the same already-scaled print DOM as manual export");
  assert(!workbench.includes('page:litmtransFrozen${index}'), "frozen PDF pages must not use Gecko's named-page continuation path");
  assert(!controller.includes('page.setSize(width, height);'), "all layout pages must retain the same common print sheet instead of restoring mixed source MediaBoxes");
  assert(!controller.includes('layoutPageSizes'), "mixed per-page source sizes must not be sent into post-print PDF rewriting");
  assert(workbench.includes('const LAYOUT_PDF_EXPORT_REVISION = 20;'), "an exporter change must replace stale generated PDF attachments without rerunning translation");
  assert(controller.includes('settings.paperWidth = paperWidth / 96;'), "layout PDF printing must explicitly set the native paper width instead of falling back to Letter");
  assert(controller.includes('settings.paperHeight = paperHeight / 96;'), "layout PDF printing must explicitly set the native paper height instead of falling back to Letter");
  assert(!controller.includes('settings.paperName ='), "layout PDF printing must not add unsupported properties to Zotero's WrappedNative print settings");
  assert(workbench.includes('transform:scale(${printScale}) !important;'), "text and KaTeX must remain in one inline layout and receive the same paint transform");
  assert(!workbench.includes('hostCall("export-pdf", { pane, layout: true, expectedPages, layoutScale:'), "layout PDF export must not request post-print content scaling");
  const workbenchCSS = fs.readFileSync(path.join(root, "src", "workbench.css"), "utf8");
  assert(workbenchCSS.includes('body[data-print-pane] .toast-region,'), "print output must exclude transient completion toasts");
}

function testLayoutBodyLeadingIsSlightlyRelaxed() {
  const layout = fs.readFileSync(path.join(root, "src", "layout.js"), "utf8");
  assert(layout.includes('Math.min(1.28, Math.max(1.22, inferredBodyStyle[1] + .06))'),
    "translated body leading must preserve the Python render_translated_layout formula");
}

function testLayoutCapacityUsesTranslatedText() {
  const layout = fs.readFileSync(path.join(root, "src", "layout.js"), "utf8");
  assert(layout.includes("function translatedFlowPlainText(part)"));
  assert(layout.includes("Math.floor((text.length - first + full - 1) / full)"),
    "stream wrapping must preserve Python's floating-point floor expression");
  assert(layout.includes('part?.translatedText || part?.text'));
  assert(layout.includes(".map(translatedFlowPlainText)"),
    "stream capacity must measure the translation that the browser renders");
  assert.equal(
    LayoutHelpers.translatedFlowPlainText({ translatedText: "正文<sup>12</sup>与\\(x &gt; 1\\)" }),
    "正文 12 与\\(x &gt; 1\\)",
    "capacity text must match Python body_text_from_html tag spacing and entity preservation"
  );
  assert.equal(LayoutHelpers.fixedLayoutFontSize("chart_caption"), 7.6);
  assert.equal(LayoutHelpers.fixedLayoutFontSize("table_footnote"), 7.2);
  assert.equal(LayoutHelpers.fixedLayoutFontSize("image_footnote"), 7.2);
  assert(layout.includes("cached.version === 11"));
  assert(layout.includes("version: 11"));
  assert(layout.includes("String(record?.translatedText || text)"),
    "absolute title and caption estimates must see the text that is rendered");
}

function testLayoutCollisionGeometryUsesSourcePdfCoordinates() {
  const workbench = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");
  assert(workbench.includes('node.dataset.fitBandRatio = "0.120"'),
    "caption blocks must preserve Python's frame-relative fit band");
  assert(workbench.includes('table_caption|table_footnote|chart_caption|image_caption|image_footnote'),
    "image footnotes must use the caption fit band");
  assert(workbench.includes("tuneCaptionGroup('.layout-block.type-image_footnote');"),
    "image footnotes must participate in caption collision iteration");
  assert(workbench.includes("function layoutPageCoordinateScale(page)"),
    "the canonical reader page needs an explicit source-coordinate conversion");
  assert(workbench.includes("/ scaleX / coordinateScale"));
  assert(workbench.includes("/ scaleY / coordinateScale"));
  assert(workbench.includes("const pageWidth = layoutPageSourceSize(page).width"));
  assert(workbench.includes("rect.right > pageSize.width + 1.5"));
  assert(workbench.includes("rect.bottom > pageSize.height + 1.5"));
}

function testLayoutComposesAtSourcePdfDimensions() {
  const workbench = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "src", "workbench.css"), "utf8");
  assert(workbench.includes('const canonicalWidth = Math.max(1, Number(page.width) || 1)'));
  assert(workbench.includes('node.dataset.layoutFontScale = "1"'));
  assert(workbench.includes('pageNode.style.setProperty("--layout-scale", "1")'));
  assert(!workbench.includes('node.dataset.layoutFontScale = String(920 /'),
    "920px must remain a display limit rather than a second layout coordinate system");
  assert(css.includes("width: var(--layout-canonical-width, 612px)"));
  assert(css.includes(".layout-line-debug-box { position: absolute; z-index: 5; display: none;"));
  assert(css.includes(".layout-debug .layout-line-debug-box { display: block; }"),
    "original MinerU line boxes must never leak into the production reader");
}

function testBundledSourceHanSerif() {
  const css = fs.readFileSync(path.join(root, "src", "workbench.css"), "utf8");
  const font = path.join(root, "assets", "fonts", "SourceHanSerifCN-Regular.ttf");
  const license = path.join(root, "assets", "fonts", "LICENSE-SourceHanSerif.txt");

  assert(fs.existsSync(font), "the reading font must be shipped with the plugin");
  assert(fs.statSync(font).size > 10_000_000, "the bundled font must not be a placeholder");
  assert(fs.existsSync(license), "the bundled font license must be shipped with the plugin");
  assert(css.includes('font-family: "LitMTrans Source Han Serif"'), "the reader must declare its bundled font face");
  assert(css.includes('url("../assets/fonts/SourceHanSerifCN-Regular.ttf")'), "the reader must load the bundled font asset");
  assert(css.includes(".layout-block .katex { font-size: 100%; }"),
    "KaTeX must use the Python MathJax root scale inside layout blocks");
  assert(css.includes('.katex:not(.katex-display) { font-size: 92%; }'),
    "translated body formulas must preserve Python's optical scale");
}

function testGeminiRequestHeadersDoNotImpersonateGoogleSDK() {
  const llm = new LLMService(new MemoryStorage(), {
    getLLMKey: () => "test-key"
  });
  const headers = llm.requestHeaders({
    provider: "gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "test-key"
  });
  assert.equal(headers["x-goog-api-key"], "test-key");
  assert.equal(
    headers["x-goog-api-client"],
    undefined,
    "the plugin must not send an invented Google SDK identification header"
  );
}

function testOneAPIRequestHeadersKeepCacheSessionStable() {
  const llm = new LLMService(new MemoryStorage(), {
    getLLMKey: () => "test-key"
  });
  const headers = llm.requestHeaders({
    provider: "oneapi",
    baseURL: "https://gateway.invalid/v1",
    apiKey: "test-key",
    promptCacheKey: "4b8e51bf-91ea-4a2d-b6c8-100000000001"
  });
  assert.equal(headers["session-id"], "4b8e51bf-91ea-4a2d-b6c8-100000000001");
  assert.equal(headers["thread-id"], headers["session-id"]);
  assert.equal(headers["x-client-request-id"], headers["session-id"]);

  const compatibleHeaders = llm.requestHeaders({
    provider: "openai_compatible",
    baseURL: "https://gateway.invalid/v1",
    apiKey: "test-key",
    promptCacheKey: "4b8e51bf-91ea-4a2d-b6c8-100000000002"
  });
  assert.equal(compatibleHeaders["session-id"], "4b8e51bf-91ea-4a2d-b6c8-100000000002");

  const openRouterKey = "4b8e51bf-91ea-4a2d-b6c8-100000000003";
  const openRouterHeaders = llm.requestHeaders({
    provider: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKey: "test-key", promptCacheKey: openRouterKey
  });
  assert.equal(openRouterHeaders["x-session-id"], openRouterKey, "OpenRouter must receive its documented sticky-routing session header");
  assert.equal(openRouterHeaders["session-id"], undefined, "OpenRouter must not receive gateway-specific cache headers");
  const openRouterPayload = { model: "deepseek/deepseek-v4-flash-0731", messages: [], stream: true };
  assert.equal(LLMInternals.applyPromptCacheSession(openRouterPayload, { provider: "openrouter", promptCacheKey: openRouterKey }), true);
  assert.equal(openRouterPayload.session_id, openRouterKey);
  assert.deepEqual(openRouterPayload.stream_options, { include_usage: true });
  const anthropicPayload = { messages: [{ role: "system", content: "stable" }, { role: "user", content: "question" }] };
  assert.equal(LLMInternals.applyOpenRouterCacheStrategy(anthropicPayload, { provider: "openrouter", model: "anthropic/claude-sonnet-4" }), "anthropic-auto");
  assert.deepEqual(anthropicPayload.cache_control, { type: "ephemeral" });
  const qwenPayload = { messages: [{ role: "system", content: "stable" }, { role: "user", content: "question" }] };
  assert.equal(LLMInternals.applyOpenRouterCacheStrategy(qwenPayload, { provider: "openrouter", model: "qwen/qwen3-coder-plus" }), "explicit-breakpoint");
  assert.deepEqual(qwenPayload.messages[0].content[0].cache_control, { type: "ephemeral" }, "explicit-cache models must mark the stable prompt prefix");
}

function testLayoutMultiPassTargetedRetryWithErrorFeedback() {
  const layoutCode = fs.readFileSync(path.join(root, "src", "layout.js"), "utf8");
  assert(
    layoutCode.includes('RETRY_REASON_DESCRIPTIONS'),
    "layout service must define RETRY_REASON_DESCRIPTIONS for mapping block errors"
  );
  assert(
    layoutCode.includes("retry_reasons: reasons || []"),
    "layout retry payload must include heuristic retry reasons for LLM"
  );
  assert(
    layoutCode.includes('const maxAttempts = 1;'),
    "group retry loop must issue at most one targeted repair"
  );
  assert(
    layoutCode.includes('attempt === 1 && !retryFormatOnly ? primaryMessages'),
    "only non-format first retries may retain the complete source-group context"
  );
  assert(
    layoutCode.includes("not factual conclusions; they can be false positives or false negatives"),
    "layout retry prompt must describe automated quality signals as fallible heuristics"
  );
  assert(
    layoutCode.includes('repair_mode: isFormatOnlyRetryReasons(reasons)'),
    "layout retry payload must distinguish symbol-format-only repairs"
  );
  assert(
    layoutCode.includes('const maxDocumentRetryPasses = 1;'),
    "document recovery phase must issue at most one targeted pass"
  );
}

function testLayoutFitParityForTitlesAndGlyphCollision() {
  const layoutCode = fs.readFileSync(path.join(root, "src", "layout.js"), "utf8");
  const workbenchCode = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");
  const workbenchCSS = fs.readFileSync(path.join(root, "src", "workbench.css"), "utf8");
  assert(
    layoutCode.includes("bboxHeight(block.bbox) >= Math.max(24, pageHeight * .035)"),
    "layout model must use desktop-equivalent geometry for later article titles"
  );
  assert(workbenchCode.includes("function runLayoutParityEngine(pageWraps = null, persist = false)"),
    "the runtime reader must have one named Python-parity layout engine");
  assert(workbenchCode.includes("const MAX_CONSECUTIVE_LAYOUT_FIT_PASSES = 2;"),
    "a feedbacking page-size observer must not monopolize the Zotero UI thread with unbounded fits");
  assert(workbenchCode.includes("const observerTarget = documentRoot || wrap;")
    && workbenchCode.includes("observer.observe(observerTarget)"),
  "layout resizes must observe the reader width, not each height-mutating page wrapper");
  assert(workbenchCode.includes("const MAX_FINAL_COLLISION_REPAIRS_PER_NODE = 192;"),
    "one malformed text frame must have a local final-audit repair limit");
  assert(workbenchCode.includes("let scanIndex = 0;")
    && workbenchCode.includes("textCollisionDetails([candidate], options)")
    && workbenchCode.includes("while (scanIndex < nodes.length)"),
  "final collision safety must recheck only the source that just moved instead of rescanning every page");
  assert(!workbenchCode.includes("for (let safety = 0; safety < 3000; safety += 1)"),
    "the old 3,000-pass whole-document final collision scan must not return");
  assert(layoutCode.includes("if (isMainTitle) {\n        // A title remains the article's main title"),
    "main-title classification must not depend on whether a publisher first page exposes a body stream");
  assert(layoutCode.includes("cached.version === 11"),
    "models compiled before nomenclature-row paragraph restoration must be rebuilt");
  assert(!workbenchCode.includes("function runPythonParityFit("),
    "the previous parity-engine name must not leave a second callable engine behind");
  assert(workbenchCode.includes("function rectUnion(rects)"),
    "the parity fitter must define the rendered-text union helper used by title recovery");
  assert(workbenchCode.includes("contentBounds: contentGeometry.bounds"),
    "the parity fitter must retain the union broad phase before exact glyph collision tests");
  assert(workbenchCode.includes("layout-fit-v43-logical-span-lines"),
    "the parity engine must invalidate styles created before embedded span lines were counted");
  const shortTitleRepair = workbenchCode.slice(
    workbenchCode.indexOf("function keepShortTitlesOnOneLine(selector, options = {})"),
    workbenchCode.indexOf("// Monotone collision-constrained growth")
  );
  assert(shortTitleRepair.includes("renderedTextLineCount(node) <= 1")
    && !shortTitleRepair.includes("dataset.originalLines"),
  "short-title repair must use actual rendered lines instead of MinerU's single-line label");
  assert(shortTitleRepair.includes("node.style.whiteSpace = 'nowrap';")
    && shortTitleRepair.includes("borrowedWidth > maxBorrowPx")
    && shortTitleRepair.includes("requiredWidth / ownWidth > maxWidthRatio"),
  "short-title repair must remain a tightly bounded no-wrap exception");
  assert(shortTitleRepair.includes("requiredWidth * coordinateScale")
    && shortTitleRepair.includes("textCollisionDetails([node]")
    && shortTitleRepair.includes("avoidPageOverflow: true"),
  "short-title borrowing must use Zotero page scaling and exact collision safety");
  assert(workbenchCode.includes("keepShortTitlesOnOneLine('.layout-block.type-title:not(.main-title)'"),
    "short-title borrowing must exclude article titles and ordinary text blocks");
  assert(workbenchCode.includes("fitLayoutFormulas(pages);\n    runLayoutParityEngine(wraps, false);"),
    "formula boxes must converge before they become barriers for the text fitter");
  assert(workbenchCode.includes('formula.style.width = "max-content"'));
  assert(workbenchCode.includes('formula.style.maxWidth = "none"'),
    "equation fitting must measure intrinsic formula content rather than a capped wrapper");
  assert(workbenchCode.includes("const availableWidth = Math.max(1, blockRect.width - 4);"),
    "formula fitting must retain the original width-only rule");
  assert(!workbenchCode.includes("const availableHeight = Math.max(1, blockRect.height - 2);"),
    "equation numbering must not add a formula-height fitting rule");
  assert(workbenchCSS.includes(".layout-block.layout-formula { display: grid; place-items: center; overflow: visible; text-align: center; }"),
    "equation numbering must not clip formula or neighboring text frames");
  const flowRule = workbenchCSS.match(/\.layout-flow-stream\s*\{([^}]*)\}/)?.[1] || "";
  assert(/\boverflow:\s*visible;/.test(flowRule),
    "layout flow streams must expose collision-safe text that extends beyond MinerU's source bbox");
  assert(workbenchCode.includes(".mjx-assistive-mml, .katex-mathml"));
  assert(workbenchCode.includes("!parent.closest('.katex-html')"),
    "KaTeX's visible aria-hidden HTML glyphs must be measured while its hidden MathML is excluded");
  assert(workbenchCode.includes("const firstLineTopCollision = !isBodyText"));
  assert(workbenchCode.includes("lineRatio = Math.min(1.85, lineRatio + 0.025)"),
    "top-edge glyph collisions must move the first baseline down instead of farther up");
  assert(workbenchCode.includes("const overflowTolerance = 1.5 * coordinateScale"),
    "canonical-page height measurements must scale the Python source-pixel tolerance");
  assert(workbenchCode.includes("snapshot?.version !== 11")
    && workbenchCode.includes("snapshot.pages.length !== requested.length")
    && workbenchCode.includes("return restored;"),
    "the runtime must reject old or partial snapshots instead of mixing per-page solves");
  assert(workbenchCode.includes('if (fittedTranslation) reflectAutomaticLayoutFont(els["translation-layout"])'),
    "every automatic refit must publish its final body font to the control");
  assert(workbenchCode.includes("node.dataset.originalLines = originalLineCount > 1 ? \"multi\" : \"single\""),
    "absolute text blocks must expose Python's original-lines contract to the fitter");
  assert(layoutCode.includes("lineCount: Math.max(1, Number(block._layout_original_line_count"),
    "the restored absolute-text model must retain original line counts");
  assert(workbenchCode.includes("refreshLayoutPageScales(pageWraps);\n      resetBodyIterationInspection"),
    "the core parity engine must preserve Python's scale-before-glyph-measurement call order");
  assert(workbenchCode.includes("function continueUnderfilledNodes(nodes, options)"),
    "the runtime reader must retain Python's second body-text iteration");
  assert(workbenchCode.includes("reason=line-backoff-exhausted"),
    "a failed body-text growth round must roll back instead of shrinking one body block");
  assert(workbenchCode.includes("collisionMinLineRatio: 1.02")
    && workbenchCode.includes("const sourceMinLineRatio = minLineRatio;")
    && workbenchCode.includes("const minLineRatio = isBodyText ? 1.02 : 0.98;"),
  "body-text collision recovery must use the 1.02 local line-height minimum");
  assert(workbenchCode.includes("bodyColumnIndependentFit: true"),
    "body-text fitting must preserve Python's independent-column rule");
  assert(workbenchCode.includes("function enforceFinalTextCollisionSafety()"),
    "the runtime reader must retain Python's final glyph-level safety audit");
  assert(workbenchCode.includes("function syncInheritedBodyFontToBodyGroup()")
    && workbenchCode.includes("syncInheritedBodyFontToBodyGroup();"),
  "single-column short transitions must inherit the final shared body font before the final audit");
  assert(workbenchCode.includes("const ALLOW_INHERITED_BODY_FONT_BACKOFF = true;")
    && workbenchCode.includes("if (ALLOW_INHERITED_BODY_FONT_BACKOFF && isInheritedBodyText"),
  "the final audit must allow only a colliding inherited transition to shrink locally");
  assert(
    workbenchCode.includes("if (firstBad === -1 && lastOk < ticks)")
      && workbenchCode.includes("if (collides(at(ticks))) firstBad = ticks;"),
    "galloping font search must probe its unvisited tail before accepting the maximum size"
  );
  assert(workbenchCode.includes("runLayoutParityEngine(wraps, false);"),
    "fitLayoutPages must route normal rendering through the sole parity engine");
  assert(workbenchCSS.includes(".layout-debug .layout-flow-stream[data-fit-label]::after"),
    "fit diagnostics must be visible only in explicit layout-debug mode");
  assert(workbenchCSS.includes(".layout-fit-pending .layout-page-wrap {\n  /* The fitter measures real Range glyph rectangles"),
    "pending layout pages must stay measurable while their paint is masked");
  assert(workbenchCSS.includes(".layout-fit-measuring .layout-page-wrap {")
    && workbenchCSS.includes("content-visibility: visible;")
    && workbenchCode.includes('root.classList.add("layout-fit-measuring")')
    && workbenchCode.includes('root.classList.remove("layout-fit-measuring")'),
    "every cold or later document-wide fit must materialize off-screen page glyphs");
  assert(!workbenchCSS.includes(".layout-fit-pending .layout-page-wrap { visibility: hidden; }"),
    "visibility:hidden must never erase glyphs from the collision fitter");
  assert(workbenchCode.includes("if (!visiblePages.length) return false;"),
    "a hidden translated pane must not be treated as a completed layout fit");
  assert(workbenchCode.includes("function scheduleLayoutPaneSettle(container, scroll, renderVersion, position = null)"),
    "translated layouts must retain a versioned settle task until visible measurement succeeds");
  assert(workbenchCode.includes('classList.contains("layout-fit-pending")'),
    "showing a previously hidden translated pane must resume its document-wide fit");
  assert(!workbenchCSS.includes("\n.layout-flow-stream[data-fit-label]::after,"),
    "fit diagnostics must never leak into ordinary reader pages");
}

function testConciseStructuredOperationMessages() {
  const workbenchCode = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");
  const workbenchMarkup = fs.readFileSync(path.join(root, "src", "workbench.xhtml"), "utf8");
  assert(
    workbenchCode.includes("function translationConfigurationField(message)")
      && workbenchCode.includes('["translate", "translate-layout"].includes(method)')
      && workbenchCode.includes("await openSettingsDialog(configurationField);")
      && workbenchCode.includes("field?.focus();"),
    "missing translation-model configuration must open settings and focus the field the user needs to complete"
  );
  assert(
    workbenchCode.includes('previous.rawText = (previous.rawText || "") + String(event.delta || "");')
      && workbenchCode.includes("function updateReasoningText(node, text)")
      && workbenchCode.includes("const followLatest = node.scrollHeight - node.scrollTop - node.clientHeight < 36;")
      && workbenchCode.includes("if (followLatest) node.scrollTop = node.scrollHeight;")
      && workbenchCode.includes("updateReasoningText(previous.reasoningNode, previous.rawText);")
      && workbenchCode.includes("updateReasoningText(previous.messageReasoningNode, previous.rawText);"),
    "the task panel must keep showing live model reasoning so long requests do not appear stalled"
  );
  assert(
    workbenchCode.includes('const key = `reasoning:${scope}:${group}`;'),
    "reasoning activity must still be deduplicated by scope and group"
  );
  assert(
    workbenchCode.includes('const visibleTypes = new Set(["started", "completed", "warning", "error"]);'),
    "the message center must exclude raw reasoning history while the live task panel displays it"
  );
  assert(
    workbenchCode.includes('badge.textContent = ({ success: "完成", warning: "提醒", error: "错误", info: "信息" })[kind];'),
    "message-center entries must have plain-language categories"
  );
  assert(
    workbenchCode.includes('if (key && previous?.key === key && previous.kind === kind && previous.textNode)')
      && workbenchCode.includes('previous.textNode.textContent = text;'),
    "changing progress for one phase must update its current row instead of flooding the task panel"
  );
  assert(
    workbenchCode.includes("item.node?.remove();")
      && workbenchCode.includes("item.messageNode?.remove();"),
    "trimming operation history must remove stale rows from both progress views"
  );
  assert(
    !workbenchMarkup.includes("实时显示处理步骤和模型思考"),
    "the task-panel heading must not contain explanatory implementation copy"
  );
  assert(
    workbenchMarkup.includes('id="task-messages-list"')
      && workbenchMarkup.includes("<h3>任务进度</h3>")
      && workbenchMarkup.includes("<h3>结果与提醒</h3>")
      && !workbenchMarkup.includes("过程详情请查看“任务进度”"),
    "the message dialog itself must expose both live task progress and durable notices"
  );
  assert(
    workbenchCode.includes("function renderTaskMessages()")
      && workbenchCode.includes("updateReasoningText(previous.messageReasoningNode, previous.rawText);"),
    "the message dialog must keep live task progress and reasoning current while it is open"
  );
  assert(
    !workbenchCode.includes('addLog(error.stack || message, "error")')
      && !workbenchCode.includes('addLog(`${notice}\\n${error.stack || message}`, "error")'),
    "user-facing task messages must not include JavaScript stack traces"
  );
}

(async () => {
  await testUtils();
  await testWebMachineTranslationProtection();
  testOpenRouterModelPricing();
  await testEdgeLocalTranslationMigration();
  testConciseStructuredOperationMessages();
  testMarkdown();
  testMinerUImageAssetValidation();
  await testMinerUAutomaticPDFSplit();
  testShortTemporaryDirectory();
  await testLegacyStorageMigration();
  testLegacySecretMigration();
  testPortableMinerUZipFallback();
  testHTTPParsing();
  testCacheFriendlyChatMessageOrdering();
  testReasoningRequestConstruction();
  await testIndependentTranslationAndChatSettings();
  await testWebMachineRulesAndSettingsTransitions();
  await testHTTPStreaming();
  await testGeminiQuotaCooldownUsesRetryAfter();
  await testDeepSeekGlobalConcurrencyLimit();
  await testPresignedUploadHeaders();
  await testLayout();
  await testLayoutEquationBarrier();
  testSingleColumnBodyPromotion();
  testEquationNumberAnchorUsesLocalColumns();
  await testLayoutCodeAndContentsRules();
  testLayoutTranslationValidation();
  await testManualLayoutJSONLProtocol();
  await testDeferredLayoutRetryPreservesTrueMissingState();
  testLayoutWholePaperGrouping();
  await testLayoutConcurrentGroupsAndCache();
  await testDeepSeekFastLayoutWarmupConcurrencyAndTelemetry();
  await testDeepSeekFastLayoutStopsBeforeParallelWaveWhenProbeIsBelowThreshold();
  await testStaleDeepSeekFastPreferenceDoesNotAffectGemini();
  await testLayoutRetriesFailedTransportGroupOnce();
  testMindmap();
  testFlowchart();
  testDiagramEvidenceMatching();
  await testLayoutFullContextIgnoresChunkLimits();
  await testLayoutTargetedRetryKeepsPrimaryPrefix();
  await testLayoutFirstRetryContextPolicy();
  await testLayoutFormatRetryIsSurgicalAndBounded();
  await testCompleteReferenceCorpus();
  await testRequestAuditExcludesSecrets();
  await testFullContextResume();
  await testChunkedStreamingConcurrencyContinuationAndCache();
  await testChunkedExtraFormulaWarnsWithoutWholeChunkRetry();
  await testChat();
  await testChatGeminiStreamTimeoutFallback();
  await testChatCurrentDocumentAfterClear();
  await testChatImageCitationsStayDisplayOnly();
  await testChatTurnMutationSemantics();
  await testOrderedReferenceQuotes();
  await testLegacyChatSessionMigration();
  await testMultimodalChat();
  await testMissingCurrentImageIsNotMaskedByHistory();
  await testCurrentImageValidationSurvivesTransientPartMetadataLoss();
  await testCurrentImagePayloadRecoversWhenTransportBookkeepingIsLost();
  await testPastedImageHistoryKeepsOriginalDataURL();
  await testMultimodalFallback();
  await testPayloadTooLargePreservesImageCapability();
  await testDeepSeekDeserializeFallbackAndRollback();
  await testDocumentImageSendOptions();
  await testImageGenerationRequest();
  await testAtomicEntryPublicationRollback();
  await testPortedCore();
  testControllerConstruction();
  await testDeletedZoteroItemsClearDocumentCaches();
  testProviderCardsApplyToSelectedPurpose();
  testWorkbenchChatRecoveryAndFormulaPreview();
  testSilentNotifications();
  testWorkbenchStreamScrollUsesExclusiveImageTier();
  testLayoutReaderIsAvailableBeforeParsing();
  testCompletedLayoutCreatesPDFItemAttachments();
  testLayoutBodyLeadingIsSlightlyRelaxed();
  testLayoutCapacityUsesTranslatedText();
  testLayoutCollisionGeometryUsesSourcePdfCoordinates();
  testLayoutComposesAtSourcePdfDimensions();
  testBundledSourceHanSerif();
  testGeminiRequestHeadersDoNotImpersonateGoogleSDK();
  testOneAPIRequestHeadersKeepCacheSessionStable();
  testLayoutMultiPassTargetedRetryWithErrorFeedback();
  testLayoutFitParityForTitlesAndGlyphCollision();
  testExclusions();
  console.log("All tests passed.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
