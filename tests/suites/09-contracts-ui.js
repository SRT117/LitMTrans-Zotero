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
  assert(workbench.includes('hostCall("deepseek-web-paste-clipboard")'), "the web context menu must expose clipboard paste");
  assert(controller.includes('case "clipboard-read-text"'), "the host must expose clipboard text to the editable-control context menu");
  assert(controller.includes('setAttribute("label", "粘贴")') && controller.includes('case "deepseek-web-paste-clipboard"'),
    "the native web context menu must expose a working clipboard paste action");
  assert(controller.includes('"text/plain"') && controller.includes('"text/unicode"'), "clipboard text transfer must support standard plain text and unicode flavors");
  assert(workbench.includes("navigator?.clipboard?.readText"), "context menu paste must provide fallback clipboard reading");
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

function testDirectExternalLinkOpening() {
  const controllerCode = fs.readFileSync(path.join(root, "src", "controller.js"), "utf8");
  const preferencesCode = fs.readFileSync(path.join(root, "src", "preferences.js"), "utf8");
  const workbenchCode = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");

  assert(controllerCode.includes("typeof Zotero?.launchURL === \"function\""), "controller must prefer Zotero.launchURL for direct browser launch");
  assert(preferencesCode.includes('event.target?.closest?.("a")'), "preferences must intercept link clicks directly");
  assert(workbenchCode.includes('event.target?.closest?.("a")'), "workbench must intercept link clicks directly");

  const controller = new context.LitMTrans.Controller({ rootURI: "chrome://litmtrans/" });
  context.Zotero.lastLaunchedURL = null;

  controller.openExternalURL("https://mineru.net/apiManage/token");
  assert.strictEqual(context.Zotero.lastLaunchedURL, "https://mineru.net/apiManage/token", "HTTP(S) URLs must be launched through Zotero.launchURL");

  controller.openExternalURL("doi:10.1000/182");
  assert.strictEqual(context.Zotero.lastLaunchedURL, "https://doi.org/10.1000/182", "DOI URLs must be resolved to HTTPS and launched directly");

  controller.openExternalURL("https://open.bigmodel.cn/apikey/platform");
  assert.strictEqual(context.Zotero.lastLaunchedURL, "https://open.bigmodel.cn/apikey/platform", "Z.ai key platform URL must be launched through Zotero.launchURL");

  assert(workbenchCode.includes("https://open.bigmodel.cn/apikey/platform"), "workbench must include Z.ai key platform link");
  assert(preferencesCode.includes("https://open.bigmodel.cn/apikey/platform"), "preferences must include Z.ai key platform link");
  assert(workbenchCode.includes("（外网google，国内自动切换bing，bing很慢）"), "workbench must include free machine translation label hint");
  assert(preferencesCode.includes("（外网google，国内自动切换bing，bing很慢）"), "preferences must include free machine translation label hint");
  assert(workbenchCode.includes("[baseURL, model, key, refresh, thinkingMode, reasoningEffort]"), "workbench must disable reasoning controls on web machine translation");
  assert(preferencesCode.includes("[baseURL, model, key, refresh, thinkingMode, reasoningEffort]"), "preferences must disable reasoning controls on web machine translation");

  assert.throws(() => controller.openExternalURL("javascript:alert(1)"), /只允许打开 HTTP\(S\) 官网地址/);
  assert.throws(() => controller.openExternalURL(""), /官网地址无效/);
}

function testPDFPreviewLifecycle() {
  const controller = fs.readFileSync(path.join(root, "src", "controller.js"), "utf8");
  const workbench = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");
  const workbenchXHTML = fs.readFileSync(path.join(root, "src", "workbench.xhtml"), "utf8");
  const styles = fs.readFileSync(path.join(root, "src", "workbench.css"), "utf8");

  assert(controller.includes('case "fit-pdf-preview":'), "controller must expose a post-layout PDF fitting action");
  assert(controller.includes('Object.defineProperty(preview, "updatePDFAttr"'), "embedded PDF preview must disable thumbnail-only page-height rewrites");
  assert(controller.indexOf('Object.defineProperty(preview, "updatePDFAttr"') < controller.indexOf("preview._open("), "PDF preview policy must be disabled before ReaderPreview opens");
  assert(controller.includes('viewer.currentScaleValue = "page-width"'), "PDF fitting action must use PDF.js native page-width scaling");
  assert(controller.includes("pdfWindow.addEventListener(\"resize\", fitPDFToWidth"), "PDF preview must preserve page-width on nested reader resize");
  assert(controller.includes("pdfPreviewInitializationTask"), "PDF preview initialization must be runtime-scoped");
  assert(controller.includes("pdfPreviewInitializationTasks"), "all pending PDF preview tasks must remain discoverable for tab cleanup");
  assert(controller.includes("task.cancelled"), "late PDF preview initialization must honor cancellation");
  assert(controller.includes("ensureTaskActive"), "PDF preview must not publish after its runtime is invalid");
  assert(controller.includes("runtime.bridgeInstalled = injected"), "bridge status must reflect actual injection success");
  assert(controller.includes("runtime.hostReadySent = readySent"), "bridge startup must record host-ready delivery");
  assert(controller.includes('case "bridge-handshake":'), "controller must expose a bridge handshake operation");
  assert(workbench.includes("function scheduleSourcePDFFit"), "workbench must fit PDF after the preview becomes visible");
  assert(workbench.includes("sourcePDFFailedAttachmentID"), "failed PDF initialization must remain latched instead of immediately retrying");
  assert(workbench.includes("retrySourcePDF"), "failed PDF initialization must expose an explicit retry path");
  assert(workbench.includes("sourcePDFRetryBlocked"), "hung PDF initialization must require reopening instead of offering an endless retry");
  assert(workbenchXHTML.includes('id="retry-source-pdf-button"'), "workbench must expose an explicit PDF retry control");
  assert(workbench.includes("if (initializePromise) return initializePromise"), "workbench initialization must deduplicate host-ready and polling entry points");
  assert(workbench.includes("function verifyHostBridge"), "workbench must verify a page-to-host request/response before initialization");
  assert(workbench.includes("await verifyHostBridge()"), "workbench startup must wait for a successful bridge handshake");
  assert(workbench.includes("function reconnectHost"), "bridge handshake failure must expose a bounded explicit reconnect path");
  assert(workbenchXHTML.includes('id="reconnect-host-button"'), "workbench must expose a bridge reconnect control");
  assert(workbench.includes('classList.toggle("is-initializing", preparingPDF)'), "PDF preview must retain a layout box during initialization");
  assert(styles.includes(".source-pdf.is-initializing") && styles.includes("opacity: 0"), "initializing PDF preview must remain laid out behind the placeholder");
}

function testPDFExportUsesCompletePaneSources() {
  const controller = fs.readFileSync(path.join(root, "src", "controller.js"), "utf8");
  const workbench = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");

  assert(workbench.includes("function hasCurrentExportContent(layout, pane)"), "export availability must be decided per pane and reading mode");
  assert(workbench.includes("function withStreamPrintRoot(pane, callback)"), "stream exports must build an isolated print root");
  assert(workbench.includes('String(state.data?.translation?.markdown || "")'), "stream translation export must use the persisted full Markdown");
  assert(workbench.includes('String(state.data?.parsed?.markdown || "")'), "stream source export must use the parsed full Markdown");
  assert(workbench.includes('document.body.dataset.printSnapshot = "stream"'), "stream export must mark its dedicated print snapshot");
  assert(workbench.includes('hostCall("export-pdf", { pane, layout: true, expectedPages, layoutPaper })'), "layout translation export must retain the complete fitted-page path");
  assert(workbench.includes('return state.readerView === "source" ? "source" : "translation";'), "the toolbar must follow the explicitly selected pane");
  assert(workbench.includes('state.running.size > 0 || exportBusy || !hasCurrentExportContent(state.mode === "layout", paneName)'), "context-menu export must disable unavailable or busy pane targets");
  assert(workbench.includes("async function ensureSourceLayoutExportPane()"), "layout source export must prepare the parsed source layout");
  assert(workbench.includes("renderLayoutPane(container, els[\"source-scroll\"], model, false)"), "layout source export must render source blocks instead of copying the PDF");
  assert(workbench.includes("withLayoutPaintPrintRoot((expectedPages, layoutPaper) =>"), "layout source export must use the complete fitted-page print path");
  assert(!controller.includes("copiedSource"), "layout source export must not silently copy the original PDF");
  assert(controller.includes('label: "导出排版原文为PDF"') && controller.includes('type: "export-reader-pdf"'), "embedded Zotero Reader must route parsed-layout export back to the workbench");
}

function testDeepSeekWebSidebarIntegration() {
  const prefs = fs.readFileSync(path.join(root, "src", "prefs.js"), "utf8");
  const controller = fs.readFileSync(path.join(root, "src", "controller.js"), "utf8");
  const preferencesXHTML = fs.readFileSync(path.join(root, "src", "preferences.xhtml"), "utf8");
  const preferencesJS = fs.readFileSync(path.join(root, "src", "preferences.js"), "utf8");
  const workbenchXHTML = fs.readFileSync(path.join(root, "src", "workbench.xhtml"), "utf8");
  const workbenchJS = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");
  const workbenchCSS = fs.readFileSync(path.join(root, "src", "workbench.css"), "utf8");
  const chat = fs.readFileSync(path.join(root, "src", "chat.js"), "utf8");
  const pdfPages = fs.readFileSync(path.join(root, "src", "deepseek-web", "pdf-pages.js"), "utf8");
  const deepSeekProvider = fs.readFileSync(path.join(root, "src", "deepseek-web", "provider.js"), "utf8");

  const host = new context.LitMTrans.Controller({ rootURI: "chrome://litmtrans/" });
  let created = 0, navigations = 0;
  const attributes = {};
  const slot = { firstElementChild: null, appendChild(node) { this.firstElementChild = node; } };
  const doc = {
    getElementById(id) { return id === "deepseek-web-frame" ? slot : null; },
    createXULElement(name) {
      assert.strictEqual(name, "browser"); created++;
      return { style: {}, addProgressListener() {}, loadURI() { navigations++; }, setAttribute(key, value) { attributes[key] = value; },
        getAttribute(key) { return attributes[key]; } };
    }
  };
  const runtime = { browser: { contentDocument: doc } };
  context.ChromeUtils = { generateQI() { return () => {}; } };
  context.Ci.nsIWebProgress = { NOTIFY_STATE_NETWORK: 1 };
  context.Services.scriptSecurityManager = { getSystemPrincipal() { return {}; } };
  host.loadDeepSeekWeb(runtime);
  host.loadDeepSeekWeb(runtime);
  assert.strictEqual(created, 1, "switching modes must preserve the existing website session");
  assert.strictEqual(navigations, 1, "switching modes must not restart navigation");
  assert.strictEqual(attributes.type, "content", "website must use an isolated content browser");
  host.loadDeepSeekWeb(runtime, true);
  clearTimeout(runtime.deepSeekLoadTimer);
  assert.strictEqual(navigations, 2, "explicit reload must navigate again");
  assert.throws(() => host.loadDeepSeekWeb({}), /网页容器尚未就绪/);
  assert(prefs.includes('pref("extensions.litmtrans.chatEngine", "api");'), "prefs must define chatEngine with default api");
  assert(prefs.includes('pref("extensions.litmtrans.webPageImageQuality", "high");')
    && prefs.includes('pref("extensions.litmtrans.webInputMode", "auto");')
    && prefs.includes('pref("extensions.litmtrans.deleteWebTranslationSessions", true);'),
  "web mode preferences must have stable defaults");
  assert(!workbenchXHTML.includes('<option value="none">不发送</option>')
    && !preferencesXHTML.includes('<html:option value="none">不发送</html:option>'),
  "web mode image quality must not offer none option");
  assert(pdfPages.includes('String(value || "high").trim().toLowerCase()')
    && pdfPages.includes("PAGE_IMAGE_PROFILES[quality] || PAGE_IMAGE_PROFILES.high"),
  "PDF page rendering must default and fall back to high quality");
  assert(!deepSeekProvider.includes('pageImageQuality === "none"')
    && deepSeekProvider.includes('["low", "medium", "high"].includes(rawPageImageQuality)'),
  "web provider must normalize legacy or invalid page image quality instead of disabling uploads");
  assert(!controller.includes("setResponseHeader"), "web sidebar must not rewrite global response headers");
  assert(!workbenchCSS.includes(".embedded-ai-topbar:has(#chat-navigator-button[hidden])"), "mode tabs must remain visible without chat history");
  assert(controller.includes('case "save-chat-engine":'), "controller must handle save-chat-engine bridge action");
  assert(preferencesXHTML.includes('id="litmtrans-pref-chat-engine-web"'), "preferences must provide DeepSeek web checkbox");
  assert(preferencesXHTML.includes("要点提炼等自动注入提示词") && workbenchXHTML.includes("要点提炼等自动注入提示词")
    && !preferencesXHTML.includes("自动注入图片与提示词") && !workbenchXHTML.includes("自动注入图片与提示词"),
  "web auto mode must describe prompt injection without promising automatic page images");
  assert(preferencesJS.includes('this.$("chat-engine-web").checked')
    && preferencesJS.includes('pageImagesGroup.hidden = !isWebEngine;')
    && preferencesJS.includes('webPageImageQuality: this.$("web-page-image-quality").value')
    && preferencesJS.includes('webInputMode: this.$("web-input-mode-auto").checked ? "auto" : "clipboard"')
    && preferencesJS.includes('deleteWebTranslationSessions: this.$("delete-web-translation-sessions").checked'),
  "preferences.js must load, persist, and independently expose web mode settings");
  assert(workbenchXHTML.includes('id="ai-mode-web-button"') && workbenchXHTML.includes('id="ai-mode-api-button"'), "workbench must provide dual-mode tabs");
  assert(workbenchXHTML.includes('id="deepseek-web-container"') && workbenchXHTML.includes('id="deepseek-web-frame"'), "workbench must provide deepseek web container and frame");
  assert(workbenchJS.includes("function setAIMode") && workbenchJS.includes("function sendToDeepSeekWeb"), "workbench.js must provide mode switcher and bridge sender");
  assert(workbenchJS.includes('pageImagesGroup.hidden = !isWebEngine;')
    && workbenchJS.includes('webPageImageQuality: els["setting-web-page-image-quality"].value')
    && workbenchJS.includes('webInputMode: els["setting-web-input-mode-auto"].checked ? "auto" : "clipboard"')
    && workbenchJS.includes('deleteWebTranslationSessions: els["setting-delete-web-translation-sessions"].checked'),
  "workbench.js must load, persist, and independently expose web mode settings");
  assert(workbenchCSS.includes('.settings-modal .modal-card { height: 100%; grid-template-rows: auto minmax(0, 1fr) auto; }')
    && workbenchCSS.includes('.settings-modal .settings-grid { max-height: none; }'),
  "settings dialog must keep its footer outside the scrolling content area");
  assert(chat.includes('taskType: session.messages[userIndex]?.taskType || options.taskType || "chat"'),
    "web chat completion must preserve the selected task type");
  assert(deepSeekProvider.includes('new Set(["key_points", "paper_mindmap", "paper_logic_flow"])')
    && deepSeekProvider.includes("当前任务仅注入文献文本，跳过论文页面图像"),
  "paper insight tasks must skip automatic PDF page image uploads");
  assert(workbenchCSS.includes(".deepseek-web-container") && workbenchCSS.includes(".deepseek-web-frame"), "workbench.css must style the web container");
}

function testPromptLibraryPresetAndReordering() {
  const workbenchJS = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");
  const workbenchCSS = fs.readFileSync(path.join(root, "src", "workbench.css"), "utf8");

  // 1. Constants 契约
  const defaults = context.LitMTrans?.Constants?.DEFAULT_PROMPT_LIBRARY;
  assert(Array.isArray(defaults), "DEFAULT_PROMPT_LIBRARY must be an array");
  assert.equal(defaults.length, 6, "Must provide exactly 6 mature academic preset prompts");
  for (const item of defaults) {
    assert(item.id && item.title && item.content, "Each preset prompt must have id, title, and content");
  }

  // 2. 旧数据迁移、首次预设与删除不恢复测试
  const controller = new context.LitMTrans.Controller({ rootURI: "chrome://litmtrans/" });
  const legacyLibrary = [{ id: "legacy-prompt", title: "旧提示词", content: "保留这条" }];
  prefValues.set("extensions.litmtrans.promptLibrary", JSON.stringify(legacyLibrary));
  prefValues.delete("extensions.litmtrans.promptLibraryInitialized");
  assert.deepEqual(controller.promptLibrary(), legacyLibrary, "Existing prompt library must survive first-run migration");
  assert.equal(prefValues.get("extensions.litmtrans.promptLibraryInitialized"), true, "Migration must mark the prompt library initialized");

  prefValues.delete("extensions.litmtrans.promptLibrary");
  prefValues.delete("extensions.litmtrans.promptLibraryInitialized");

  // 首次读取：自动填充默认预设
  const firstLoad = controller.promptLibrary();
  assert.equal(firstLoad.length, 6, "First-run promptLibrary() must return the 6 default preset prompts");
  assert.equal(prefValues.get("extensions.litmtrans.promptLibraryInitialized"), true, "promptLibraryInitialized flag must be set");

  // 用户调整顺序并保存
  const reordered = [firstLoad[1], firstLoad[0], ...firstLoad.slice(2)];
  controller.savePromptLibrary(reordered);
  const loadedReordered = controller.promptLibrary();
  assert.equal(loadedReordered[0].id, firstLoad[1].id, "First item should now be previous second item");
  assert.equal(loadedReordered[1].id, firstLoad[0].id, "Second item should now be previous first item");

  // 用户将所有条目清空：绝不自动恢复默认
  controller.savePromptLibrary([]);
  const cleared = controller.promptLibrary();
  assert.deepEqual(cleared, [], "Empty library must be preserved and not restored when user deleted all items");

  // 3. UI 交互契约
  assert(workbenchJS.includes("button.draggable = true"), "workbench prompt-library-item must be draggable");
  assert(workbenchJS.includes('button.addEventListener("dragstart"'), "workbench must bind dragstart event");
  assert(workbenchJS.includes('button.addEventListener("dragover"'), "workbench must bind dragover event");
  assert(workbenchJS.includes('button.addEventListener("drop"'), "workbench must bind drop event");
  assert(workbenchJS.includes("currentRows.splice"), "drop event must reorder rows using splice");
  assert(workbenchJS.includes("schedulePromptLibrarySave()"), "drop event must schedule automatic persistence");
  assert(workbenchJS.includes("promptLibrarySavePromise"), "prompt-library saves must serialize in-flight requests");
  assert(workbenchJS.includes("promptLibrarySaveRevision"), "prompt-library saves must track local revisions");
  assert(workbenchJS.includes("revision !== promptLibrarySaveRevision"), "stale prompt-library responses must not overwrite newer edits");
  assert(workbenchJS.includes("function mergePromptLibraryDraft"), "settings snapshots must preserve pending prompt-library edits");

  assert(workbenchCSS.includes("cursor: grab"), "prompt-library-item must have grab cursor");
  assert(workbenchCSS.includes(".prompt-library-item.dragging"), "prompt-library-item must have dragging style");
  assert(workbenchCSS.includes(".prompt-library-item.drag-over-before"), "prompt-library-item must have drag-over-before indicator");
  assert(workbenchCSS.includes(".prompt-library-item.drag-over-after"), "prompt-library-item must have drag-over-after indicator");
}

function testDiagramCacheAndPromptModeContracts() {
  const chat = fs.readFileSync(path.join(root, "src", "chat.js"), "utf8");
  const controller = fs.readFileSync(path.join(root, "src", "controller.js"), "utf8");
  const workbench = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");

  assert(chat.includes("MINDMAP_V2_FORMAT_INSTRUCTION") && chat.includes("FLOWCHART_V2_FORMAT_INSTRUCTION")
    && chat.includes("WEB_MINDMAP_FORMAT_INSTRUCTION") && chat.includes("WEB_FLOWCHART_FORMAT_INSTRUCTION"), "API and web diagram protocols must remain separate");
  assert(chat.includes("MERMAID_MINDMAP_INSTRUCTION") && chat.includes("clipboardTaskPrompt"), "clipboard mode must have a separate Mermaid prompt path");
  assert(chat.includes("Research Gap") && chat.includes("vs. Baseline/SOTA") && chat.includes("核心机理，禁止单纯堆砌组件或模块名称"),
    "DEFAULT_KEY_POINTS_PROMPT must incorporate research gap, baseline comparison, and mechanism rules");
  assert(controller.includes("DIAGRAM_CACHE_TASK_TYPES")
    && controller.includes("sourceFingerprint")
    && controller.includes("withDiagramCacheLock"), "diagram cache commands must be scoped, source-bound, and serialized");
  assert(workbench.includes('hostCall("diagram-get-cached", { taskType }, { timeout: 5000 })')
    && workbench.includes("清空[${taskName}]数据失败"), "diagram cache UI must have bounded reads and visible clear failures");
  assert(!workbench.includes('if (renderAssistantMarkdown && message.taskType) {\n      if (flowchart'), "rendering historical chat messages must not rewrite diagram caches with unknown provenance");
}

  return {
    testExclusions,
    testWorkbenchChatRecoveryAndFormulaPreview,
    testSilentNotifications,
    testWorkbenchStreamScrollUsesExclusiveImageTier,
    testConciseStructuredOperationMessages,
    testDirectExternalLinkOpening,
    testPDFPreviewLifecycle,
    testPDFExportUsesCompletePaneSources,
    testDeepSeekWebSidebarIntegration,
    testPromptLibraryPresetAndReordering,
    testDiagramCacheAndPromptModeContracts,
  };
};
