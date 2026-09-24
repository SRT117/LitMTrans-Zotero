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
  const deepSeekDriver = fs.readFileSync(path.join(root, "src", "deepseek-web", "driver.js"), "utf8");
  const deepSeekPages = fs.readFileSync(path.join(root, "src", "deepseek-web", "pdf-pages.js"), "utf8");

  assert(controller.includes('case "operation-state"'), "workbench must be able to reconcile lost operation events");
  assert(controller.includes('case "pdf-page-count"'), "workbench must be able to check the source PDF page count before translating");
  assert(workbench.includes('els["retry-source-pdf-button"].hidden = !sourcePDFFailed || sourcePDFRetryBlocked;'), "failed source PDFs must expose the retry action when retrying is safe");
  assert(workbench.includes("summary.documentsPrimaryBytes ??") && workbench.includes("summary.orphanedCoreBytes ??"), "storage chart segments must use non-overlapping document totals");
  assert(deepSeekDriver.includes("while (true)")
    && deepSeekDriver.includes("网络较慢，DeepSeek仍在上传或解析附件，请继续等待…")
    && deepSeekDriver.includes("if (options.throwOnTimeout === true)"),
  "observed attachment uploads must keep waiting by default on slow networks");
  assert(deepSeekDriver.includes('"DEEPSEEK_ATTACHMENT_REJECTED"')
    && deepSeekDriver.includes('"DEEPSEEK_ATTACHMENT_TIMEOUT"'),
  "attachment rejection and readiness timeout must remain distinct outcomes");
  assert(deepSeekPages.includes("adjustDeepSeekWebPagesCacheBytes?.(-stats.bytes)"), "obsolete page-image profiles must be deducted from the cache ledger");
  assert(controller.includes('this.withOperation(runtime, "deepseek-pages"')
    && controller.includes('`页面图像生成完成，正在上传 ${imagePaths.length} 张图像…`')
    && controller.includes("waitIndefinitely: true")
    && deepSeekPages.includes('message: `正在生成页面图像 ${i + 1}/${strategy.groups.length}…`'),
  "manual page-image attachment must expose persistent generation and upload progress after cache cleanup");
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
  const closeStart = workbench.indexOf("  async function closeSettingsDialog() {");
  const closeEnd = workbench.indexOf("  async function initialize()", closeStart);
  assert(closeStart >= 0 && closeEnd > closeStart, "settings close must have an explicit save guard");
  const closeSettingsHandler = workbench.slice(closeStart, closeEnd);
  assert(closeSettingsHandler.includes("await flushSettingsAutoSave(false)"), "settings must flush pending changes before closing");
  assert(!closeSettingsHandler.includes("renderLayoutPanes()"), "closing settings must not rebuild an already fitted layout");
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
    workbenchCode.includes("const SHOW_DEVELOPMENT_PROBES_IN_USER_UI = false;")
      && workbenchCode.includes("function isDevelopmentProbeMessage(message)")
      && workbenchCode.includes("state.logEntries.filter(row => !isDevelopmentProbeMessage(row.text))")
      && workbenchCode.includes("state.systemMessages.filter(item => !isDevelopmentProbeMessage(item.text))"),
    "development probes must remain recorded but stay hidden from user-facing message lists"
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
  assert(workbenchCode.includes("（外网google，国内自动切换bing，bing较慢）"), "workbench must include free machine translation label hint");
  assert(preferencesCode.includes("（外网google，国内自动切换bing，bing较慢）"), "preferences must include free machine translation label hint");
  assert(workbenchCode.includes("[baseURL, model, key, refresh, thinkingMode, reasoningEffort]"), "workbench must disable reasoning controls on web machine translation");
  assert(preferencesCode.includes("[baseURL, model, key, refresh, thinkingMode, reasoningEffort]"), "preferences must disable reasoning controls on web machine translation");

  assert.throws(() => controller.openExternalURL("javascript:alert(1)"), /只允许打开 HTTP\(S\) 官网地址/);
  assert.throws(() => controller.openExternalURL(""), /官网地址无效/);
}

function testAPIProviderDropdownsExcludeWebDriver() {
  const controller = fs.readFileSync(path.join(root, "src", "controller.js"), "utf8");
  const workbench = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");
  const preferences = fs.readFileSync(path.join(root, "src", "preferences.js"), "utf8");

  assert(controller.includes("webDriver: spec.webDriver === true"), "settings must identify web-driver providers separately from API providers");
  assert(workbench.includes("if (provider.webDriver === true) continue;"), "workbench API provider lists must exclude web-driver providers");
  assert(workbench.includes("spec.webDriver !== true && spec.supportsChat !== false"), "embedded chat provider list must exclude web-driver providers");
  assert(workbench.includes("provider.webDriver !== true"), "provider cards must exclude web-driver providers");
  assert(preferences.includes("spec.webDriver !== true && (!chat || spec.supportsChat !== false)"), "Zotero Preferences provider lists must exclude web-driver providers");
}

async function testStartupNoticeContracts() {
  const bootstrap = fs.readFileSync(path.join(root, "src", "bootstrap.js"), "utf8");
  const controllerSource = fs.readFileSync(path.join(root, "src", "controller.js"), "utf8");
  const workbench = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");
  const workbenchXHTML = fs.readFileSync(path.join(root, "src", "workbench.xhtml"), "utf8");
  const workbenchStyles = fs.readFileSync(path.join(root, "src", "workbench.css"), "utf8");
  const prefs = fs.readFileSync(path.join(root, "src", "prefs.js"), "utf8");

  assert(bootstrap.includes('"src/release-notes.js"'), "startup content must be bundled for offline use");
  assert(controllerSource.includes('case "get-startup-notice":'), "controller must expose the startup notice snapshot");
  assert(controllerSource.includes('case "mark-startup-notice-seen":'), "controller must acknowledge startup notices only after the UI displays them");
  assert(workbench.includes('hostCall("get-startup-notice")'), "workbench must request the startup notice before rendering the document");
  assert(workbench.includes('hostCall("mark-startup-notice-seen"'), "workbench must acknowledge a startup notice after showModal succeeds");
  assert(workbench.includes("startupNoticeGateClosed"), "startup notices must wait before online alert modals can open");
  assert(workbench.includes('tutorialButton.textContent = "查看新手教程"'), "welcome guide must expose a prominent beginner tutorial entry");
  assert(workbench.includes('tutorialButton.addEventListener("click", openTokenGuide);'), "beginner tutorial entry must keep the notice open while opening the guide");
  assert(workbench.includes('hostCall("open-token-guide")'), "beginner tutorial entry must reuse the token guide action");
  assert(workbenchStyles.includes(".startup-notice-tutorial"), "beginner tutorial entry must have dedicated emphasis styling");
  assert(workbench.includes("responsiveDefaultWidth") && workbench.includes("按工作区实测宽度重新计算默认值"), "responsive sidebar width must follow the actual viewport");
  assert(workbenchStyles.includes(":root { --sidebar-width: 0px; }"), "stacked small-screen layout must release the desktop sidebar width");
  assert(workbenchXHTML.includes('id="welcome-guide-dialog"') && workbenchXHTML.includes('id="release-notes-dialog"'), "workbench must expose welcome and release-note dialogs");
  assert(prefs.includes('pref("extensions.litmtrans.startupNoticeVersion", "");'), "startup notice version must persist in the profile");

  const snapshot = new Map(prefValues);
  try {
    prefValues.clear();
    const controller = context.LitMTrans.createController({ id: "litmtrans@local", version: "2.0.0", rootURI: "file:///plugin/" });
    const welcome = await controller.getStartupNotice();
    assert.equal(welcome.type, "welcome", "a clean profile must receive the welcome guide");
    assert.notEqual(prefValues.get("extensions.litmtrans.startupNoticeVersion"), "2.0.0", "reading the notice must not mark it as displayed");
    assert.equal(controller.markStartupNoticeSeen("2.0.0"), true);
    assert.equal(prefValues.get("extensions.litmtrans.startupNoticeVersion"), "2.0.0");
    assert.equal(await controller.getStartupNotice(), null, "the same version must not reopen after the UI acknowledges it");

    prefValues.clear();
    prefValues.set("extensions.litmtrans.promptLibraryInitialized", true);
    const update = await controller.getStartupNotice();
    assert.equal(update.type, "update", "an existing profile must receive release notes");
    assert(update.entries.some(entry => String(entry).includes("首次使用指南")), "release notes must come from the bundled version entry");
  }
  finally {
    prefValues.clear();
    for (const [key, value] of snapshot) prefValues.set(key, value);
  }
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
  const styles = fs.readFileSync(path.join(root, "src", "workbench.css"), "utf8");
  const pdfPages = fs.readFileSync(path.join(root, "src", "deepseek-web", "pdf-pages.js"), "utf8");

  assert(workbench.includes("function hasCurrentExportContent(layout, pane)"), "export availability must be decided per pane and reading mode");
  assert(workbench.includes("function withStreamPrintRoot(pane, callback)"), "stream exports must build an isolated print root");
  assert(workbench.includes('String(state.data?.translation?.markdown || "")'), "stream translation export must use the persisted full Markdown");
  assert(workbench.includes('String(state.data?.parsed?.markdown || "")'), "stream source export must use the parsed full Markdown");
  assert(workbench.includes("text-align:justify;"), "stream PDF print styles must preserve the reader's justified paragraphs");
  assert(workbench.includes('kind: "stream-source-markdown"') && workbench.includes('kind: "stream-translation-markdown"'), "stream source and translation must each expose Markdown export");
  assert(workbench.includes('hostCall("export-stream-markdown", { pane: target })'), "stream Markdown export must use the host file picker path");
  assert(workbench.includes('meta: "Markdown + 图片"'), "stream Markdown export must advertise its bundled image resources");
  assert(workbench.includes('label: "排版对照版（当前字体）"') && workbench.includes('label: "原始文件"') && workbench.includes('label: "文献转图片"'), "export option names must keep file types in the metadata line instead of the title");
  assert(workbench.includes('document.body.dataset.printSnapshot = "stream"'), "stream export must mark its dedicated print snapshot");
  assert(workbench.includes('hostCall("export-pdf", { pane, layout: true, expectedPages, layoutPaper })'), "layout translation export must retain the complete fitted-page path");
  assert(workbench.includes('return state.readerView === "source" ? "source" : "translation";'), "the toolbar must follow the explicitly selected pane");
  assert(workbench.includes('state.running.size > 0 || exportBusy || !hasCurrentExportContent(state.mode === "layout", paneName)'), "context-menu export must disable unavailable or busy pane targets");
  assert(workbench.includes("async function ensureSourceLayoutExportPane()"), "layout source export must prepare the parsed source layout");
  assert(workbench.includes("renderLayoutPane(container, els[\"source-scroll\"], model, false)"), "layout source export must render source blocks instead of copying the PDF");
  assert(workbench.includes("withLayoutPaintPrintRoot((expectedPages, layoutPaper) =>"), "layout source export must use the complete fitted-page print path");
  assert(styles.includes(".document-pane .markdown-body > p { text-align: justify;"), "the reader must keep the canonical paragraph alignment rule");
  assert(controller.includes('async exportStreamMarkdown(runtime, payload = {})') && controller.includes('case "export-stream-markdown":'), "controller must provide a persisted stream Markdown export command");
  assert(controller.includes("async exportMarkdownImageBundle(markdown, documentID, outputPath)") && controller.includes("assetDirectory"), "stream Markdown export must bundle referenced local images beside the Markdown file");
  assert(controller.includes("PathUtils.filename(sourcePath)") && controller.includes("nextAvailableExportFilePath"), "standalone document image export must preserve source Markdown filenames with collision handling");
  assert(controller.includes('match(/\\]\\(\\s*/)') && controller.includes('match(/\\bsrc\\s*=\\s*["\']/i)'), "Markdown image export must locate the URL after the link delimiter instead of using an ambiguous first indexOf");
  assert(controller.includes("isGeneratedExportAttachment(item)") && controller.includes('title.includes("（LitMTrans）")'), "generated PDF attachments must be distinguishable from original files");
  assert(pdfPages.includes("addPNGResolution") && pdfPages.includes('pngChunk("pHYs"'), "PDF page images must carry explicit 300 DPI PNG metadata");
  assert(pdfPages.includes("await Promise.all(images.map(path => this.storage.remove(path, false)))"), "failed page-image exports must clean up partial output");
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
  assert(prefs.includes('pref("extensions.litmtrans.chatEngine", "deepseek_web");'), "prefs must define chatEngine with default web mode");
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
  assert(preferencesXHTML.includes('id="litmtrans-pref-chat-engine-web" type="checkbox" checked="checked"'), "preferences must provide a checked DeepSeek web checkbox");
  assert(preferencesXHTML.includes("要点提炼等自动注入提示词") && workbenchXHTML.includes("要点提炼等自动注入提示词")
    && !preferencesXHTML.includes("自动注入图片与提示词") && !workbenchXHTML.includes("自动注入图片与提示词"),
  "web auto mode must describe prompt injection without promising automatic page images");
  assert(preferencesJS.includes('this.$("chat-engine-web").checked')
    && preferencesJS.includes('pageImagesGroup.hidden = !isWebEngine;')
    && preferencesJS.includes('webPageImageQuality: this.$("web-page-image-quality").value')
    && preferencesJS.includes('webInputMode: this.$("web-input-mode-auto").checked ? "auto" : "clipboard"')
    && preferencesJS.includes('deleteWebTranslationSessions: this.$("delete-web-translation-sessions").checked'),
  "preferences.js must load, persist, and independently expose web mode settings");
  assert(workbenchXHTML.includes('id="ai-mode-web-button"') && workbenchXHTML.includes('id="ai-mode-api-button"') && workbenchXHTML.includes('id="setting-chat-engine-web" type="checkbox" checked="checked"'), "workbench must provide dual-mode tabs and a checked web default");
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

async function testCAJFontContractAndWorkerGuard() {
  const fontPath = path.join(root, "assets", "fonts", "SourceHanSerifCN-Regular.ttf");
  assert(fs.existsSync(fontPath), "SourceHanSerifCN-Regular.ttf must exist in assets/fonts");
  const fontStat = fs.statSync(fontPath);
  assert(fontStat.size > 10 * 1024 * 1024, "Font file must be the complete unsubsetted font (> 10MB)");

  const wasmPath = path.join(root, "native", "dist", "caj2pdf", "caj2pdf.wasm");
  assert(fs.existsSync(wasmPath), "caj2pdf.wasm must exist in native/dist/caj2pdf");
  const wasmStat = fs.statSync(wasmPath);
  assert(wasmStat.size < 1.5 * 1024 * 1024, "caj2pdf.wasm must be decoupled from font and stay < 1.5MB");

  const wasmBytes = fs.readFileSync(wasmPath);
  const wasmModule = await WebAssembly.compile(wasmBytes);
  const exportsList = WebAssembly.Module.exports(wasmModule).map(e => e.name);
  assert(exportsList.includes("ltm_alloc_font"), "caj2pdf.wasm must export ltm_alloc_font");
  assert(exportsList.includes("ltm_init_font"), "caj2pdf.wasm must export ltm_init_font");
  assert(exportsList.includes("ltm_alloc"), "caj2pdf.wasm must export ltm_alloc");
  assert(exportsList.includes("ltm_convert"), "caj2pdf.wasm must export ltm_convert");

  const controller = fs.readFileSync(path.join(root, "src", "controller.js"), "utf8");
  assert(controller.includes("loadNativeCAJFont"), "controller must implement loadNativeCAJFont");
  assert(controller.includes("!font?.bytes?.length"), "controller must assert font presence for HN/C8");

  const worker = fs.readFileSync(path.join(root, "src", "caj-worker.js"), "utf8");
  assert(worker.includes("缺少 CAJ 文字渲染字体数据，已停止转换"), "worker must guard against missing font");
  assert(worker.includes("CAJ 字体初始化失败，无法渲染文字页"), "worker must guard against failed font initialization");
  assert(worker.includes("data.font = null"), "worker must release font buffer reference after initialization");
}

async function testUpdaterContractsAndSafety() {
  const updaterCode = fs.readFileSync(path.join(root, "src", "updater.js"), "utf8");
  const prefsCode = fs.readFileSync(path.join(root, "src", "prefs.js"), "utf8");
  const controllerCode = fs.readFileSync(path.join(root, "src", "controller.js"), "utf8");

  assert(updaterCode.includes("releases/latest/download/update.json"), "updater must target official update.json manifest");
  assert(!updaterCode.includes("@main/manifest.json"), "updater must not use unreleased main branch manifest.json");

  assert(prefsCode.includes('pref("extensions.litmtrans.lastUpdateCheckTime", "0");'), "lastUpdateCheckTime must be string pref");
  assert(controllerCode.includes('U.setPref("lastUpdateCheckTime", String(Date.now()));'), "controller must save timestamp as string");

  assert(updaterCode.includes("computeSha256") && updaterCode.includes("actualHash !== expectedHash"), "updater must enforce SHA-256 integrity check");
  assert(updaterCode.includes("/^[a-f0-9]{64}$/.test(expectedHash)"), "updater must validate 64-hex SHA-256 format strictly");
  assert(updaterCode.includes("fetchBytesWithFullTimeout"), "updater must enforce body-covering download timeout");
  assert(updaterCode.includes("onDownloadFailed") && updaterCode.includes("onInstallCancelled") && updaterCode.includes("install.cancel()"), "updater must handle full install lifecycle");
  assert(updaterCode.includes("candidateId !== ADDON_ID"), "updater must verify addon id before installing");
  assert(updaterCode.includes("fetchBytesWithFullTimeout(url, 120000, onProgress)"), "download must pass onProgress callback");
  assert(controllerCode.includes("this.autoUpdateTimer = setInterval"), "controller must establish periodic auto-update check interval");

  const workbenchCode = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");
  assert(workbenchCode.includes('if (type === "update-progress")'), "workbench must handle update-progress events");

  const sandbox = { module: {}, exports: {}, require, LitMTrans: {}, TextEncoder };
  vm.runInNewContext(updaterCode, sandbox);
  const computeSha256 = sandbox.LitMTrans.computeSha256;
  assert(typeof computeSha256 === "function", "computeSha256 must be exposed");

  const testBytes = new TextEncoder().encode("LitMTrans-Security-Test");
  const digest = await computeSha256(testBytes);
  const expected = nodeCrypto.createHash("sha256").update(testBytes).digest("hex").toLowerCase();
  assert(digest === expected, `SHA-256 digest mismatch: ${digest} vs ${expected}`);

  // 验证非法哈希格式被严格拦截
  assert(!/^[a-f0-9]{64}$/.test(""), "empty hash must fail");
  assert(!/^[a-f0-9]{64}$/.test("xyz123"), "invalid characters must fail");
  assert(/^[a-f0-9]{64}$/.test(expected), "valid 64-char hex hash must pass");
}

function testDeepSeekWebDriverSessionActionAndRetryContracts() {
  const driverSource = fs.readFileSync(path.join(root, "src", "deepseek-web", "driver.js"), "utf8");
  const childSource = fs.readFileSync(path.join(root, "src", "deepseek-web", "DeepSeekActorChild.sys.mjs"), "utf8");

  // 1. 确保已彻底清除未公开私有 API 相关调用
  assert(!driverSource.includes("forceAPI"), "driver.js must not contain forceAPI");
  assert(!driverSource.includes("sessionAPI"), "driver.js must not call sessionAPI");
  assert(!childSource.includes("sessionAPI"), "DeepSeekActorChild must not define or call sessionAPI");
  assert(!childSource.includes("/api/v0/chat_session"), "DeepSeekActorChild must not call private chat_session endpoints");

  // 2. 检查 mayRetryAfterNavigation 判定逻辑：delete 和 rename 等有副作用操作绝不自动重试
  assert(
    driverSource.includes('action === "session-action" && ["list", "select"].includes(payload?.subAction)'),
    "driver.js must restrict session-action retry to read-only list/select and forbid retry on mutating delete/rename"
  );

  // 3. 检查 deleteCurrentSession 的安全契约：导航必须位于 try 块内，且 finally 必须重置回根页面
  assert(
    driverSource.includes("try {\n        const currentURL =")
      && driverSource.includes("finally {\n        try { await this.navigate(rootURL); } catch (_) {}"),
    "deleteCurrentSession must wrap target navigation in try and guarantee reset to rootURL in finally"
  );
  assert(
    driverSource.includes('execute("session-action", { subAction: "delete", expectedURL: targetURL }, 20000)'),
    "deleteCurrentSession must execute delete with adequate timeout margin (20000ms)"
  );
}

async function testAnnouncementSystemContracts() {
  const updaterCode = fs.readFileSync(path.join(root, "src", "updater.js"), "utf8");
  const controllerCode = fs.readFileSync(path.join(root, "src", "controller.js"), "utf8");
  const workbenchXhtml = fs.readFileSync(path.join(root, "src", "workbench.xhtml"), "utf8");
  const workbenchJs = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");

  // 1. 结构与 UI 契约断言
  assert(workbenchXhtml.includes('id="announcement-modal"'), "workbench.xhtml must declare announcement-modal dialog");
  assert(workbenchXhtml.includes('id="announcements-list"'), "workbench.xhtml must declare announcements-list container");
  assert(workbenchXhtml.includes('id="system-messages-badge"'), "workbench.xhtml must declare system-messages-badge element");
  assert(workbenchJs.includes('"announcement-modal"'), "workbench.js must register announcement-modal element");
  assert(workbenchJs.includes('renderAnnouncementsList'), "workbench.js must implement renderAnnouncementsList");
  assert(workbenchJs.includes('updateAnnouncementUI'), "workbench.js must implement updateAnnouncementUI");
  assert(workbenchJs.includes('shownAlertNoticeIds'), "workbench.js must track shown announcements per ID rather than single boolean");
  assert(workbenchJs.includes('type === "announcements-updated"'), "workbench.js must handle announcements-updated host event");
  assert(workbenchJs.includes('els["announcement-modal"]?.addEventListener("cancel"'), "workbench.js must handle Esc cancel on announcement-modal");
  assert(workbenchJs.includes('if (currentAlertAnnouncement || modal?.open) return;'), "workbench.js must not replace an already open announcement modal");

  // 2. Controller 契约与广播断言
  assert(controllerCode.includes('getDismissedAnnouncementIds'), "controller must implement getDismissedAnnouncementIds");
  assert(controllerCode.includes('dismissAnnouncement'), "controller must implement dismissAnnouncement");
  assert(controllerCode.includes('dismissAnnouncements'), "controller must implement dismissAnnouncements for batch updates");
  assert(controllerCode.includes('broadcastAnnouncements'), "controller must broadcast announcements to open workbenches");
  assert(controllerCode.includes('getAnnouncementsForWorkbench'), "controller must implement getAnnouncementsForWorkbench");
  assert(controllerCode.includes('case "dismiss-announcement":'), "controller must handle dismiss-announcement action");
  assert(controllerCode.includes('case "mark-all-announcements-read":'), "controller must handle mark-all-announcements-read action");

  // 3. 安全性断言：绝不能对远程公告字段使用 innerHTML
  assert(!workbenchJs.includes('.innerHTML = alertItem.message'), "must not inject alertItem.message with innerHTML");
  assert(!workbenchJs.includes('.innerHTML = item.message'), "must not inject item.message with innerHTML");
  assert(workbenchJs.includes('els["announcement-modal-message"].textContent = alertItem.message'), "modal message must be set using textContent");
  assert(workbenchJs.includes('msg.textContent = item.message'), "list message must be set using textContent");

  // 4. 状态机断言：更新失败不得标记已读，支持 dismiss 动作
  assert(
    workbenchJs.includes('const success = await triggerPluginUpdate()') &&
    workbenchJs.includes('if (success && item.id)') &&
    workbenchJs.includes('if (res?.success && state.announcements?.history)'),
    "workbench.js modal must only dismiss announcement when update succeeds"
  );
  assert(
    workbenchJs.includes('const updateSuccess = await triggerPluginUpdate()') &&
    workbenchJs.includes('if (updateSuccess && !item.isDismissed)'),
    "workbench.js list must only dismiss announcement when update succeeds"
  );
  assert(
    workbenchJs.includes('const opened = await hostCall("open-external-url", { url: item.action.url })') &&
    workbenchJs.includes('if (!opened?.opened || item.isDismissed) return;'),
    "workbench.js list URL action must dismiss only after the external URL opens"
  );
  assert(
    workbenchJs.includes('item.action.type === "dismiss"'),
    "workbench.js must support action.type: dismiss"
  );

  // 5. CI / CD Release 流程契约断言
  const releaseWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8");
  assert(releaseWorkflow.includes("--announcements"), "release.yml must pass --announcements to create-update-manifest");

  // 5. 运行环境沙箱内验证 normalizeAnnouncements 与 isAnnouncementApplicable 算法
  const sandbox = { module: {}, exports: {}, require, LitMTrans: {}, TextEncoder };
  vm.runInNewContext(updaterCode, sandbox);
  const Updater = sandbox.LitMTrans.Updater;
  assert(typeof Updater.normalizeAnnouncements === "function", "normalizeAnnouncements must be exposed on Updater");
  assert(typeof Updater.isAnnouncementApplicable === "function", "isAnnouncementApplicable must be exposed on Updater");

  // 验证非法数据过滤与清洗，以及无效 expireAt 防御（NaN 日期必须被丢弃）
  const rawList = [
    null,
    {},
    { id: "valid-1", title: "MinerU 4.0 升级预警", message: "协议已升级", level: "alert", targetMaxVersion: "2.1.0" },
    { id: "invalid-missing-msg", title: "测试" },
    { id: "invalid-expire", title: "坏日期", message: "测试", expireAt: "not-a-valid-date" },
    { id: "valid-2", title: "普通公告", message: "日常说明", level: "unknown_level", expireAt: "2020-01-01T00:00:00Z" }
  ];
  const normalized = Updater.normalizeAnnouncements(rawList);
  assert.equal(normalized.length, 2, "Only valid announcements with valid date should be preserved");
  assert.equal(normalized[0].level, "alert", "Level alert should be preserved");
  assert.equal(normalized[1].level, "info", "Unknown level should default to info");
  assert.equal(normalized[0].cancelText, "我知道了", "Default cancelText should be provided");

  // 验证版本号与时效判定
  const item1 = normalized[0]; // targetMaxVersion: 2.1.0
  const item2 = normalized[1]; // expireAt: 2020-01-01 (已过期)

  assert(Updater.isAnnouncementApplicable(item1, "2.0.0"), "Should apply to version 2.0.0 (<= 2.1.0)");
  assert(Updater.isAnnouncementApplicable(item1, "2.1.0"), "Should apply to version 2.1.0 (<= 2.1.0)");
  assert(!Updater.isAnnouncementApplicable(item1, "2.2.0"), "Should NOT apply to version 2.2.0 (> 2.1.0)");

  // 验证已忽略/已读过滤
  const dismissed = new Set(["valid-1"]);
  assert(!Updater.isAnnouncementApplicable(item1, "2.0.0", dismissed), "Should NOT apply if id is already dismissed");

  // 验证过期过滤
  assert(!Updater.isAnnouncementApplicable(item2, "2.0.0"), "Expired announcement should not be applicable");

  // 6. 验证 create-update-manifest.mjs 的 fail-closed 逻辑
  const manifestScript = fs.readFileSync(path.join(root, "scripts", "create-update-manifest.mjs"), "utf8");
  assert(!manifestScript.includes("console.warn"), "create-update-manifest.mjs must NOT fail-open with console.warn");
  assert(manifestScript.includes("throw new Error"), "create-update-manifest.mjs must throw on invalid announcements");
  assert(manifestScript.includes("ANNOUNCEMENT_LEVELS"), "manifest generation must validate announcement levels");
  assert(manifestScript.includes("ANNOUNCEMENT_ACTION_TYPES"), "manifest generation must validate action types");
  assert(manifestScript.includes("validateHttpUrl"), "manifest generation must validate announcement URLs");
  assert(manifestScript.includes("ids.has(id)"), "manifest generation must reject duplicate announcement IDs");
  assert(manifestScript.includes("compareVersionBounds"), "manifest generation must validate announcement version bounds");
}

async function testSettingsAutoSaveIsolationAndFailure() {
  const workbench = fs.readFileSync(path.join(root, "src", "workbench.js"), "utf8");
  const start = workbench.indexOf("  let settingsAutoSaveTimer = null;");
  const end = workbench.indexOf("  async function initialize()", start);
  assert(start >= 0 && end > start, "workbench auto-save implementation must be available");
  const form = { agentEnabled: false, autoUpdate: true, chatEngine: "api", translationProviderProfiles: { oneapi: { model: "old" } } };
  const server = { ...form };
  const calls = [];
  const state = { settings: { ...server }, aiMode: "api" };
  let fail = false;
  let modeChanges = 0;
  let closed = 0;
  const errors = [];
  const sandbox = {
    state, els: { "settings-dialog": { open: true, close: () => { closed++; } } }, window: {}, document: { activeElement: null }, setTimeout, clearTimeout,
    settingsPayload: () => JSON.parse(JSON.stringify(form)),
    mergePromptLibraryDraft: value => value,
    setAIMode: mode => { state.aiMode = mode; modeChanges++; },
    renderMode: () => {},
    toast: message => errors.push(message),
    hostCall: async (method, patch) => {
      if (method === "save-mineru-token") {
        if (fail) throw new Error("credential save failed");
        return { hasToken: Boolean(patch.token) };
      }
      assert.equal(method, "save-settings");
      if (fail) throw new Error("save failed");
      calls.push(patch);
      Object.assign(server, patch);
      return { ...server };
    }
  };
  const autoSave = vm.runInNewContext(`${workbench.slice(start, end)}\n({
    baseline: value => { settingsAutoSaveBaseline = value; },
    dirty: () => { settingsAutoSaveRevision++; },
    flush: flushSettingsAutoSave,
    close: closeSettingsDialog,
    credential: queueSettingsCredentialWrite
  })`, sandbox);
  autoSave.baseline(JSON.parse(JSON.stringify(form)));
  await autoSave.flush();
  assert.equal(calls.length, 0, "closing an unchanged settings dialog must not write stale settings");
  server.autoUpdate = false;
  form.agentEnabled = true;
  autoSave.dirty();
  await autoSave.flush();
  assert.deepEqual(Object.keys(calls[0]), ["agentEnabled"], "auto-save must write only the changed field");
  assert.equal(server.autoUpdate, false, "another pane's preference change must survive workbench auto-save");
  form.chatEngine = "deepseek_web";
  autoSave.dirty();
  await autoSave.flush();
  assert.equal(state.aiMode, "web", "a saved chat mode must immediately update the active workbench");
  assert.equal(modeChanges, 1);
  form.translationProviderProfiles.oneapi.model = "new";
  autoSave.dirty();
  await autoSave.flush();
  assert.deepEqual(Object.keys(calls.at(-1)), ["translationProviderProfiles"]);
  assert.deepEqual(Object.keys(calls.at(-1).translationProviderProfiles), ["oneapi"]);
  form.agentEnabled = false;
  autoSave.dirty();
  fail = true;
  await assert.rejects(autoSave.flush(false), /save failed/, "failed saves must reject instead of reporting success");
  await Promise.all([autoSave.close(), autoSave.close()]);
  assert.equal(closed, 0, "the settings dialog must remain open when its final save fails");
  assert.equal(errors.at(-1), "save failed");
  assert.equal(errors.length, 1, "repeated close attempts must show one save error");
  fail = false;
  await autoSave.close();
  assert.equal(closed, 1, "closing must succeed once pending changes are saved");
  fail = true;
  autoSave.credential("save-mineru-token", { token: "saved-on-close" }, "setting-mineru-token");
  await autoSave.close();
  assert.equal(closed, 1, "an unfinished credential write must also keep settings open on failure");
  fail = false;
  await autoSave.close();
  assert.equal(closed, 2, "closing retries a failed credential write");

  const preferences = fs.readFileSync(path.join(root, "src", "preferences.js"), "utf8");
  const pane = vm.runInNewContext(`${preferences}\nLitMTransControllerPreferences`, {
    document: { addEventListener() {} }, setTimeout, clearTimeout
  });
  const paneForm = { agentEnabled: false, chatEngine: "api", autoUpdate: true };
  const paneServer = { ...paneForm };
  const paneCalls = [];
  const messages = [];
  pane.payload = () => ({ ...paneForm });
  pane.$ = () => null;
  pane.message = (message, error) => messages.push({ message, error });
  pane.controller = () => ({ saveSettings(patch) {
    if (fail) throw new Error("save failed");
    paneCalls.push(patch);
    Object.assign(paneServer, patch);
    return { ...paneServer };
  } });
  pane.settings = { ...paneServer };
  pane.autoSaveBaseline = { ...paneForm };
  await pane.flushAutoSave();
  assert.equal(paneCalls.length, 0);
  fail = false;
  paneServer.autoUpdate = false;
  paneForm.chatEngine = "deepseek_web";
  pane.autoSaveRevision++;
  await pane.flushAutoSave();
  assert.deepEqual(Object.keys(paneCalls[0]), ["chatEngine"]);
  assert.equal(paneServer.autoUpdate, false);
  paneForm.agentEnabled = true;
  fail = true;
  pane.autoSaveRevision++;
  pane.flushAutoSaveWithFeedback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.at(-1).message, "save failed");
  assert.equal(messages.at(-1).error, true);
  const settingsMarkup = fs.readFileSync(path.join(root, "src", "workbench.xhtml"), "utf8")
    .split('<dialog id="settings-dialog"')[1].split('<dialog id="custom-translation-instruction-dialog"')[0];
  assert(!settingsMarkup.includes('>取消</button>') && !settingsMarkup.includes('>保存</button>'));
  assert(settingsMarkup.includes('id="close-settings-button"'));
  assert(!fs.readFileSync(path.join(root, "src", "preferences.xhtml"), "utf8").includes('id="litmtrans-pref-save"'));
}

  return {
    testExclusions,
    testWorkbenchChatRecoveryAndFormulaPreview,
    testSilentNotifications,
    testWorkbenchStreamScrollUsesExclusiveImageTier,
    testConciseStructuredOperationMessages,
    testDirectExternalLinkOpening,
    testAPIProviderDropdownsExcludeWebDriver,
    testStartupNoticeContracts,
    testPDFPreviewLifecycle,
    testPDFExportUsesCompletePaneSources,
    testDeepSeekWebSidebarIntegration,
    testPromptLibraryPresetAndReordering,
    testDiagramCacheAndPromptModeContracts,
    testCAJFontContractAndWorkerGuard,
    testUpdaterContractsAndSafety,
    testDeepSeekWebDriverSessionActionAndRetryContracts,
    testAnnouncementSystemContracts,
    testSettingsAutoSaveIsolationAndFailure,
  };
};
