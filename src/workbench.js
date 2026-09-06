(() => {
  "use strict";

  const U = window.LitMTrans?.Utils;
  const Markdown = window.LitMTrans?.Markdown;
  const Mindmap = window.LitMTrans?.Mindmap;
  const Flowchart = window.LitMTrans?.Flowchart;
  const Layout = window.LitMTrans?.LayoutHelpers;
  const P = window.LitMTrans?.PortedCore || {};
  const pending = new Map();
  const state = {
    data: null,
    settings: null,
    mode: "stream",
    modeInitialized: false,
    modeUserSelected: false,
    // Zero means this document has no manual layout-font override. The reader
    // control then reflects the fitted size once it is available.
    layoutFontPt: 0,
    detectedLayoutFontPt: 0,
    // A display-only multiplier for the single translated layout pane. It
    // deliberately never participates in layout fitting or PDF export.
    layoutPageZoom: 1,
    readerView: "both",
    syncScroll: false,
    cleanReadingSnapshot: null,
    modeScrollPositions: { stream: null, layout: null },
    readerSyncPage: 0,
    readerSyncPageRatio: 0,
    readerSyncUntil: 0,
    nativePDFSelection: null,
    swapped: false,
    selectedText: "",
    referenceQuotes: [],
    currentSession: null,
    sessions: [],
    running: new Set(),
    progress: 0,
    streamingChatMessageID: "",
    streamingChatInsertIndex: -1,
    streamingChatText: "",
    chatFollowLatest: true,
    // Translation deltas stay as chunks until completion.  Keeping the
    // growing result out of `state.data` prevents each token from copying a
    // document-sized string or triggering a full Markdown/KaTeX render.
    liveTranslationActive: false,
    liveTranslationParts: [],
    // Layout responses are strict JSON and can arrive concurrently from
    // several groups. Keep each response separate so the live preview stays
    // readable while the final layout model is being validated.
    layoutLiveTranslationGroups: new Map(),
    // A final layout event is the primary publication path. The bridge
    // response remains a fallback when that event is lost.
    layoutPublicationRevision: 0,
    layoutPDFGenerationKey: "",
    reasoning: "",
    expandedReasoningIDs: new Set(),
    pendingImages: [],
    pendingDocuments: [],
    referencePaths: [],
    pendingComposerSubmission: null,
    pendingTaskType: "",
    chatRenderMarkdown: true,
    expandedMessageIDs: new Set(),
    previewImage: null,
    previewScale: 1,
    previewFormulaTarget: null,
    previewFormulaTeX: "",
    previewFormulaScale: 1,
    previewFormulaX: 0,
    previewFormulaY: 0,
    editingProviderCardID: "",
    providerCardPurpose: "chat",
    providerCardKeyLoading: false,
    syncSource: null,
    syncFrame: null,
    logEntries: [],
    logAutoCloseTimer: null,
    logAutoOpened: false,
    systemMessages: []
  };
  // Bump when the print snapshot format changes.
  const LAYOUT_PDF_EXPORT_REVISION = 20;

  // Paint streaming text at a bounded cadence to keep Gecko responsive.
  let translationRenderTimer = null;
  let translationRenderQueued = false;
  let renderedTranslationMarkdown = null;
  let layoutLivePreviewRenderTimer = null;
  let layoutLivePreviewRenderQueued = false;
  let renderedSourceMarkdown = null;
  let sourcePDFAvailable = false;
  let sourcePDFLoading = false;
  let sourcePDFAttachmentID = null;
  let manualTranslationSteps = [];
  let activeManualTranslationStep = 0;
  let lastActionError = "";
  let manualLayoutTranslations = {};

  const $ = id => document.getElementById(id);
  const els = {};

  function cacheElements() {
    for (const id of [
      "app", "document-title", "document-subtitle", "document-state", "progress-bar", "progress-label",
      "manual-translate-button", "translate-button", "stop-button", "export-pdf-button", "clean-reader-button", "clean-reader-ai-button", "settings-button",
      "log-toggle", "log-drawer", "log-content", "log-clear", "log-close", "stream-mode-button", "layout-mode-button",
      "both-panes-button", "source-only-button", "translation-only-button",
      "sync-scroll-check",
      "reader-font-input", "key-points-button", "paper-mindmap-button", "paper-logic-flow-button",
      "swap-panes-button", "debug-boxes-control", "debug-boxes-check", "reader-split", "source-pane", "translation-pane", "split-handle", "sidebar-split-handle",
      "source-scroll", "translation-scroll", "source-placeholder", "translation-placeholder", "source-pdf", "source-content", "source-layout", "translation-content",
      "translation-layout", "empty-parse-button", "native-pdf-selection-toolbar", "native-pdf-ask-button",
      "system-messages-button", "system-messages-dialog", "task-messages-list", "system-messages-list", "close-system-messages",
      "chat-render-markdown", "selection-chip", "selection-text", "clear-selection-button", "chat-messages", "chat-empty", "chat-navigator-button", "chat-navigator-popup",
      "chat-form", "chat-input",
      "chat-document-preview", "chat-document-button", "remove-pending-documents-button", "chat-image-preview", "chat-image-input", "context-status", "chat-send-button",
      "chat-model-settings-dialog", "embedded-chat-provider", "embedded-provider-cards-button", "embedded-chat-base-url", "embedded-chat-model", "embedded-refresh-chat-models", "embedded-chat-api-key", "embedded-chat-thinking-mode", "embedded-chat-reasoning-effort", "embedded-chat-show-reasoning", "embedded-chat-render-markdown", "embedded-chat-api-key-state", "embedded-chat-image-group", "embedded-chat-image-note", "embedded-chat-image-size", "embedded-chat-image-quality", "embedded-chat-image-format", "save-embedded-chat-settings",
      "settings-dialog", "settings-form", "settings-advanced", "open-token-guide-button", "setting-provider", "setting-provider-label", "translation-provider-cards-button", "setting-base-url", "setting-model", "refresh-models-button", "setting-chat-uses-translation-model", "setting-chat-model-section",
      "setting-api-key", "setting-thinking-mode", "setting-reasoning-effort", "setting-deepseek-fast-layout-group", "setting-deepseek-fast-layout",
      "setting-chat-provider", "setting-chat-provider-label", "setting-chat-base-url", "setting-chat-model", "refresh-chat-models-button",
      "setting-chat-api-key", "setting-chat-thinking-mode", "setting-chat-reasoning-effort", "provider-cards-button",
      "setting-chat-image-group", "setting-chat-image-size", "setting-chat-image-quality", "setting-chat-image-format",
      "setting-mineru-token", "setting-mineru-model",
      "setting-target-language", "setting-target-language-picker", "setting-machine-source-language-group", "setting-machine-source-language", "setting-machine-source-language-picker", "setting-translation-mode",
      "long-document-translation-dialog", "chat-parse-before-send-dialog", "mineru-token-dialog", "mineru-token-dialog-title", "mineru-token-dialog-description", "mineru-token-input", "mineru-token-error", "save-mineru-token-and-parse", "manual-translation-dialog", "manual-translation-command-tabs", "manual-translation-response-tabs", "manual-translation-command", "manual-translation-response", "copy-manual-translation-command", "render-manual-translation",
      "setting-reference-list", "add-reference-button", "edit-custom-translation-instruction", "edit-custom-translation-instruction-preview", "custom-translation-instruction-preview", "custom-translation-instruction-preview-content", "remove-reference-button", "clear-reference-button",
      "setting-key-points-prompt", "restore-key-points-prompt",
      "clear-document-button", "save-settings-button", "custom-translation-instruction-dialog", "custom-translation-instruction-input", "save-custom-translation-instruction",
      "clear-chat-button",
      "provider-cards-dialog", "close-provider-cards", "done-provider-cards", "provider-card-list", "new-provider-card",
      "delete-provider-card", "provider-card-name", "provider-card-provider", "provider-card-base-url", "provider-card-api-key", "provider-card-api-key-state",
      "save-provider-card", "apply-provider-card",
      "image-preview-dialog", "image-preview-image", "image-preview-scale", "image-preview-zoom-out", "image-preview-zoom-in",
      "image-preview-fit", "image-preview-reuse", "image-preview-copy", "image-preview-save", "image-preview-close",
      "formula-preview-dialog", "formula-preview-viewport", "formula-preview-stage", "formula-preview-body",
      "formula-preview-scale", "formula-preview-zoom-out", "formula-preview-zoom-in", "formula-preview-fit",
      "formula-preview-ask", "formula-preview-copy", "formula-preview-close", "toast-region"
    ]) els[id] = $(id);
  }

  function requestID() {
    return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function hostFunction() {
    return window.__LitMTrans_HOST_CALL__ || window.wrappedJSObject?.__LitMTrans_HOST_CALL__ || null;
  }

  function hostCall(method, payload = {}, options = {}) {
    const fn = hostFunction();
    if (typeof fn !== "function") return Promise.reject(new Error("LitMTrans尚未准备好，请稍后重试"));
    const id = requestID();
    return new Promise((resolve, reject) => {
      const timeout = Math.max(0, Number(options.timeout || 0));
      const timer = timeout ? setTimeout(() => {
        pending.delete(id);
        reject(new Error("LitMTrans响应超时，请稍后重试"));
      }, timeout) : null;
      pending.set(id, { resolve, reject, method, timer });
      try {
        fn(String(method), JSON.stringify(payload || {}), id);
      }
      catch (error) {
        pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(error);
      }
    });
  }

  function syncWorkbenchViewport() {
    // Gecko can keep vh units at the tab's pre-maximize size. The host knows
    // the actual embedded-browser rectangle, so use it as a final sizing
    // authority whenever the Zotero window changes size.
    void hostCall("viewport").then(viewport => {
      const height = Number(viewport?.height || 0);
      if (height > 0) els["app"].style.height = `${height}px`;
    }).catch(() => {});
  }

  window.__LitMTrans_RECEIVE__ = raw => {
    let message;
    try { message = typeof raw === "string" ? JSON.parse(raw) : raw; }
    catch (_) { return; }
    if (!message || typeof message !== "object") return;
    if (message.type === "response") {
      const waiter = pending.get(String(message.requestID || ""));
      if (!waiter) return;
      pending.delete(String(message.requestID || ""));
      if (waiter.timer) clearTimeout(waiter.timer);
      if (["chat-send", "chat-resend", "chat-edit-message"].includes(waiter.method)) {
        state.running.delete("chat");
        updateOperationUI();
      }
      if (message.ok) waiter.resolve(message.payload);
      else {
        const error = new Error(message.error?.message || "操作失败");
        error.name = message.error?.name || "Error";
        error.cancelled = Boolean(message.error?.cancelled);
        waiter.reject(error);
      }
      return;
    }
    if (message.type === "event") handleEvent(message.payload || {});
    else if (message.type === "open-context") applyOpenContext(message.payload || {});
    else if (message.type === "host-ready") void initialize();
  };

  function imageResolver(target) {
    const value = String(target || "").trim();
    if (/^(?:resource|data|file|chrome):/i.test(value)) return value;
    const imageRecord = (state.data?.parsed?.imageMap || []).find(record =>
      record?.cleanTarget === value || record?.originalTarget === value
    );
    // Do not emit a broken resource:// image when MinerU's ZIP did not
    // contain the referenced binary. The Markdown renderer will show a
    // readable inline placeholder instead.
    if (imageRecord?.warning) return "";
    const documentID = state.data?.item?.documentID || "";
    return documentID ? U.resourceURL(documentID, value) : value;
  }

  function renderMarkdown(markdown, options = {}) {
    if (!Markdown) return `<pre>${U.escapeHTML(String(markdown || ""))}</pre>`;
    let source = String(markdown || "");
    if (options.normalizeEscapedTeX && Markdown.normalizeEscapedTeXDelimiters) {
      source = Markdown.normalizeEscapedTeXDelimiters(source);
    }
    if (options.repairBareTeX && Markdown.normalizeBareTeXFragments) {
      source = Markdown.normalizeBareTeXFragments(source);
    }
    source = options.syncAnchors && Markdown.injectSyncAnchors
      ? Markdown.injectSyncAnchors(source)
      : source;
    return Markdown.renderMarkdown(source, {
      resolveImage: imageResolver,
      imageLoading: options.imageLoading,
      resolveImageWidth: target => {
        const normalized = String(target || "")
          .replace(/\\/g, "/")
          .replace(/^(?:[.][/])+/, "")
          .split(/[?#]/, 1)[0]
          .toLowerCase();
        const name = normalized.split("/").pop() || normalized;
        return Number(
          state.data?.parsed?.imageWidths?.[normalized]
          || state.data?.parsed?.imageWidths?.[name]
          || 0
        );
      }
    });
  }

  function renderMarkdownInto(target, markdown, options = {}) {
    const source = String(markdown || "");
    const html = Markdown?.toXHTMLFragment
      ? Markdown.toXHTMLFragment(renderMarkdown(source, options))
      : renderMarkdown(source, options);
    try {
      target.innerHTML = html;
      target.classList.remove("markdown-render-fallback");
      return true;
    }
    catch (error) {
      // The workbench is XHTML, but KaTeX or a malformed MinerU fragment can
      // still contain HTML which Firefox refuses to assign through innerHTML.
      // Parse it as tolerant HTML and import the resulting DOM nodes instead
      // of discarding the rendered document and showing its raw Markdown.
      try {
        const parsed = new DOMParser().parseFromString(html, "text/html");
        const nodes = [...(parsed?.body?.childNodes || [])].map(node => document.importNode(node, true));
        if (nodes.length) {
          target.replaceChildren(...nodes);
          target.classList.remove("markdown-render-fallback");
          return true;
        }
      }
      catch (_) {
        // Fall through to a readable plain-text representation below.
      }

      // MinerU and model output is untrusted markup. An unrecoverable fragment
      // must never turn a successful parse/translation into a failed operation.
      const fallback = document.createElement("pre");
      fallback.className = "markdown-render-fallback";
      fallback.textContent = source;
      target.replaceChildren(fallback);
      target.classList.add("markdown-render-fallback");
      return false;
    }
  }

  function safeSetElementHTML(target, htmlInput) {
    if (!target) return false;
    const html = Markdown?.toXHTMLFragment
      ? Markdown.toXHTMLFragment(String(htmlInput || ""))
      : String(htmlInput || "");
    try {
      target.innerHTML = html;
      return true;
    }
    catch (_) {
      try {
        const parsed = new DOMParser().parseFromString(html, "text/html");
        const nodes = [...(parsed?.body?.childNodes || [])].map(node => document.importNode(node, true));
        if (nodes.length) {
          target.replaceChildren(...nodes);
          return true;
        }
      }
      catch (__) {}
      target.textContent = String(htmlInput || "");
      return false;
    }
  }

  function normalizeUserMessage(message) {
    return String(message || "")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .trim();
  }

  function toast(message, kind = "") {
    if (kind === "error" || kind === "warning") recordSystemMessage(message, kind);
    const node = document.createElement("div");
    node.className = `toast ${kind}`.trim();
    node.textContent = normalizeUserMessage(message);
    els["toast-region"].appendChild(node);
    setTimeout(() => node.remove(), kind === "error" ? 6500 : 3800);
  }

  function recordSystemMessage(message, kind = "info") {
    const text = normalizeUserMessage(message);
    if (!text) return;
    const previous = state.systemMessages[state.systemMessages.length - 1];
    if (previous?.text === text && previous?.kind === kind && Date.now() - previous.at < 1000) return;
    state.systemMessages.push({
      at: Date.now(),
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      text,
      kind
    });
    if (state.systemMessages.length > 300) state.systemMessages.splice(0, state.systemMessages.length - 300);
  }

  function updateReasoningText(node, text) {
    if (!node) return;
    const followLatest = node.scrollHeight - node.scrollTop - node.clientHeight < 36;
    node.textContent = text;
    if (followLatest) node.scrollTop = node.scrollHeight;
  }

  function appendLogRow(row) {
    const log = els["log-content"];
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 36;
    const node = document.createElement("div");
    node.className = `log-entry ${row.kind || "info"}`.trim();
    const time = document.createElement("time");
    time.textContent = row.time;
    const marker = document.createElement("span");
    marker.className = "log-entry-marker";
    marker.setAttribute("aria-hidden", "true");
    const content = document.createElement("div");
    content.className = "log-entry-content";
    if (row.kind === "reasoning") {
      const label = document.createElement("div");
      label.className = "log-reasoning-label";
      label.textContent = row.text;
      const reasoningText = document.createElement("div");
      reasoningText.className = "log-reasoning-text";
      reasoningText.textContent = row.rawText || "模型正在思考…";
      content.append(label, reasoningText);
      row.reasoningNode = reasoningText;
    }
    else {
      const text = document.createElement("span");
      text.className = "log-entry-text";
      text.textContent = row.text;
      content.appendChild(text);
      row.textNode = text;
    }
    node.append(time, marker, content);
    row.node = node;
    log.appendChild(node);
    if (row.reasoningNode) row.reasoningNode.scrollTop = row.reasoningNode.scrollHeight;
    if (els["system-messages-dialog"]?.open && els["task-messages-list"]) {
      appendTaskMessageRow(row);
    }
    if (nearBottom) log.scrollTop = log.scrollHeight;
    return node;
  }

  function appendTaskMessageRow(row) {
    const list = els["task-messages-list"];
    if (!list || !row.node) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 36;
    list.querySelector(".task-message-empty")?.remove();
    const clone = row.node.cloneNode(true);
    row.messageNode = clone;
    row.messageTextNode = clone.querySelector(".log-entry-text");
    row.messageReasoningNode = clone.querySelector(".log-reasoning-text");
    list.appendChild(clone);
    if (row.messageReasoningNode) row.messageReasoningNode.scrollTop = row.messageReasoningNode.scrollHeight;
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }

  function renderTaskMessages() {
    const list = els["task-messages-list"];
    if (!list) return;
    list.replaceChildren();
    for (const row of state.logEntries) appendTaskMessageRow(row);
    if (!state.logEntries.length) {
      const empty = document.createElement("p");
      empty.className = "task-message-empty";
      empty.textContent = "当前还没有任务进度。";
      list.appendChild(empty);
    }
  }

  function addLog(message, kind = "info", key = "") {
    const text = normalizeUserMessage(message);
    if (!text) return;
    // Streaming progress events can be emitted once per token/chunk even
    // when the human-readable status has not changed. Keep the operation
    // log useful by folding consecutive identical entries from all sources.
    const previous = state.logEntries.at(-1);
    if (previous && previous.text === text && previous.kind === kind && previous.key === key) return;
    if (key && previous?.key === key && previous.kind === kind && previous.textNode) {
      const log = els["log-content"];
      const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 36;
      previous.text = text;
      previous.time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      previous.node.querySelector("time").textContent = previous.time;
      previous.textNode.textContent = text;
      if (previous.messageNode) previous.messageNode.querySelector("time").textContent = previous.time;
      if (previous.messageTextNode) previous.messageTextNode.textContent = text;
      if (nearBottom) log.scrollTop = log.scrollHeight;
      return;
    }
    const row = {
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      text,
      kind,
      key
    };
    state.logEntries.push(row);
    if (state.logEntries.length > 300) {
      const removed = state.logEntries.splice(0, state.logEntries.length - 300);
      for (const item of removed) {
        item.node?.remove();
        item.messageNode?.remove();
      }
    }
    appendLogRow(row);
  }

  function reasoningLogLabel(event) {
    const scope = String(event?.scope || "translation");
    if (scope.startsWith("layout")) {
      return scope.includes("retry") ? "翻译模型正在校对排版内容" : "翻译模型正在思考";
    }
    if (scope === "guide") return "模型正在整理术语和行文风格";
    if (scope.includes("retry")) return "翻译模型正在校对译文";
    return "翻译模型正在思考";
  }

  function appendReasoningLog(event) {
    if (!String(event?.delta || "")) return;

    const label = reasoningLogLabel(event);
    const scope = String(event?.scope || "translation");
    const group = event?.group ? String(event.group) : "";
    const key = `reasoning:${scope}:${group}`;

    const previous = state.logEntries.at(-1);
    if (
      previous &&
      previous.kind === "reasoning" &&
      previous.key === key &&
      previous.node &&
      els["log-content"] &&
      els["log-content"].contains(previous.node)
    ) {
      const log = els["log-content"];
      const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 36;
      previous.rawText = (previous.rawText || "") + String(event.delta || "");
      updateReasoningText(previous.reasoningNode, previous.rawText);
      updateReasoningText(previous.messageReasoningNode, previous.rawText);
      if (nearBottom) log.scrollTop = log.scrollHeight;
      return;
    }

    const time = new Date().toLocaleTimeString();
    const text = label;
    const row = { time, text, kind: "reasoning", key, label, rawText: String(event.delta || ""), node: null, reasoningNode: null };
    state.logEntries.push(row);
    if (state.logEntries.length > 300) {
      const removed = state.logEntries.splice(0, state.logEntries.length - 300);
      for (const item of removed) {
        item.node?.remove();
        item.messageNode?.remove();
      }
    }

    if (els["log-content"]) appendLogRow(row);
  }

  function showOperationLog(autoOpened = false) {
    if (state.logAutoCloseTimer) {
      clearTimeout(state.logAutoCloseTimer);
      state.logAutoCloseTimer = null;
    }
    if (!autoOpened) state.logAutoOpened = false;
    else state.logAutoOpened = true;
    els["log-drawer"].hidden = false;
  }

  function hideOperationLogAfterCompletion() {
    if (!state.logAutoOpened) return;
    if (state.logAutoCloseTimer) clearTimeout(state.logAutoCloseTimer);
    // Leave the completion message visible briefly before collapsing the progress panel.
    state.logAutoCloseTimer = setTimeout(() => {
      if (!state.running.size && state.logAutoOpened) {
        els["log-drawer"].hidden = true;
        state.logAutoOpened = false;
      }
      state.logAutoCloseTimer = null;
    }, 1400);
  }

  function shouldAutoOpenOperationLog(operation) {
    // Translation starts with parsing when needed, then proceeds as either
    // stream or layout translation. Chat and document attachment work stay
    // within the sidebar and must never cover the reader with this popup.
    return ["parse", "translate", "layout"].includes(String(operation || ""));
  }

  function setStatus(message, progress = null, kind = "neutral") {
    const text = String(message || "就绪");
    els["progress-label"].textContent = text;
    if (progress !== null && Number.isFinite(Number(progress))) {
      state.progress = Math.max(0, Math.min(100, Number(progress)));
      els["progress-bar"].style.width = `${state.progress}%`;
    }
    const chip = els["document-state"];
    chip.textContent = text;
    chip.className = `status-chip status-${kind}`;
  }

  function restoreIdleStatus() {
    const parsed = Boolean(state.data?.capabilities?.hasParsed || state.data?.parsed?.markdown);
    const translated = Boolean(
      state.data?.translation?.markdown
      || state.data?.layout?.meta?.complete
      || Object.keys(state.data?.layout?.translations || {}).length
    );
    setStatus(parsed ? (translated ? "可阅读" : "已解析") : "尚未解析", 0, parsed ? "success" : "neutral");
  }

  function updateOperationUI() {
    const running = state.running.size > 0;
    els["stop-button"].hidden = !running;
    els["translate-button"].disabled = running || !state.data?.capabilities?.canTranslate;
    els["manual-translate-button"].disabled = running || !state.data?.capabilities?.canTranslate;
    els["export-pdf-button"].disabled = running || !state.data?.parsed?.markdown;
    els["chat-send-button"].disabled = state.running.has("chat") || state.running.has("document");
    els["chat-document-button"].disabled = state.running.has("chat") || state.running.has("document");
    renderPendingDocuments();
    if (!running && state.progress >= 100) setTimeout(() => {
      if (!state.running.size) els["progress-bar"].style.width = "0%";
    }, 900);
  }

  async function reconcileOperationState() {
    if (!hostFunction() || document.hidden) return;
    try {
      const result = await hostCall("operation-state", {}, { timeout: 5000 });
      const active = new Set(Array.isArray(result?.operations) ? result.operations.map(String) : []);
      let changed = false;
      for (const operation of [...state.running]) {
        if (!active.has(operation)) {
          state.running.delete(operation);
          changed = true;
        }
      }
      for (const operation of active) {
        if (!state.running.has(operation)) {
          state.running.add(operation);
          changed = true;
        }
      }
      if (changed) {
        updateOperationUI();
        if (!state.running.size) restoreIdleStatus();
      }
    }
    catch (_) {
      // A transient tab switch can briefly detach the content bridge. The
      // next visibility/focus tick retries without disturbing a real task.
    }
  }

  function handleEvent(event) {
    const type = String(event?.type || "");
    if (type === "operation") {
      if (event.running) {
        state.running.add(event.operation);
        if (event.operation === "layout") {
          state.layoutLiveTranslationGroups.clear();
          flushLayoutLivePreview();
        }
        if (shouldAutoOpenOperationLog(event.operation)) showOperationLog(true);
      }
      else state.running.delete(event.operation);
      updateOperationUI();
      if (event.running) setStatus("正在处理…", null, "running");
      else if (!state.running.size) {
        restoreIdleStatus();
        hideOperationLogAfterCompletion();
      }
      return;
    }
    if (type === "progress" || type === "status") {
      addLog(event.message || event.phase || "", "progress", String(event.phase || ""));
      // Events emitted by a cancelled or completed worker can reach the page
      // after its operation-finished notification. They remain useful in the
      // log, but must not resurrect the running indicator.
      if (state.running.size) {
        setStatus(event.message || event.phase || "正在处理…", event.progress ?? null, "running");
      }
      return;
    }
    if (type === "log") {
      addLog(event.message || "", "info");
      return;
    }
    if (type === "warning") {
      addLog(event.message || "", "warning");
      recordSystemMessage(event.message || "有一项内容需要核对", "warning");
      // Recoverable warnings remain available in the progress panel and message center.
      return;
    }
    if (type === "system-info") {
      const message = String(event.message || "").trim();
      if (!message) return;
      recordSystemMessage(message, "info");
      addLog(message);
      return;
    }
    if (type === "chat-usage") {
      // Per-turn usage is retained for the message-center dialog, but it is
      // intentionally not a toast or task-log entry.
      recordSystemMessage(event.message || "", "info");
      return;
    }
    if (type === "reasoning") {
      const isChatReasoning = String(event.scope || "") === "chat";
      // Translation/layout reasoning belongs to the running operation, not to
      // an assistant chat turn.  Keeping it in the shared chat accumulator can
      // create a phantom conversation message the next time the chat pane renders.
      if (!isChatReasoning) {
        appendReasoningLog(event);
        return;
      }
      const showReasoning = Boolean(state.settings?.chatShowReasoning ?? state.settings?.showReasoning);
      if (!showReasoning) return;
      state.reasoning += String(event.delta || "");
      state.streamingChatMessageID ||= String(event.messageID || "streaming");
      updateStreamingChatDOM();
      return;
    }
    if (type === "guide-delta" || type === "layout-raw-delta") {
      if (type === "guide-delta") {
        addLog("正在整理术语和行文风格…");
        return;
      }
      const group = Math.max(1, Number(event.group || 1));
      const attempt = String(event.attempt || "primary");
      const key = `${group}:${attempt}`;
      const previous = state.layoutLiveTranslationGroups.get(key) || {
        group,
        groupCount: Math.max(group, Number(event.groupCount || group)),
        attempt,
        text: ""
      };
      previous.groupCount = Math.max(previous.groupCount, Number(event.groupCount || 0));
      previous.text += String(event.delta || "");
      state.layoutLiveTranslationGroups.set(key, previous);
      scheduleLayoutLivePreview();
      addLog(`正在接收排版译文 ${group}/${previous.groupCount}…`);
      return;
    }
    if (type === "reader-location") {
      const page = Math.max(1, Math.trunc(Number(event.page || 1)));
      const pageRatio = Math.max(0, Math.min(1, Number(event.pageRatio || 0)));
      const anchorRatio = Math.max(0, Math.min(1, Number(event.anchorRatio ?? .35)));
      state.readerSyncPage = page;
      state.readerSyncPageRatio = pageRatio;
      if (state.mode === "layout" && state.syncScroll && performance.now() >= state.readerSyncUntil) {
        alignLayoutPagePosition(els["translation-scroll"], page, pageRatio, anchorRatio);
      }
      return;
    }
    if (type === "native-pdf-selection") {
      const text = String(event.text || "").replace(/\s+/g, " ").trim();
      state.nativePDFSelection = text ? {
        text,
        page: Math.max(1, Math.trunc(Number(event.page || 1))),
        pageLabel: String(event.pageLabel || ""),
        x: Number(event.x || 0),
        y: Number(event.y || 0),
        pdfRects: Array.isArray(event.pdfRects) ? event.pdfRects : []
      } : null;
      renderNativePDFSelectionToolbar();
      return;
    }
    if (type === "translation") {
      if (!state.data) return;
      state.data.translation = state.data.translation || {};
      state.data.translation.meta = { ...(state.data.translation.meta || {}), mode: event.mode, complete: Boolean(event.complete) };
      if (event.complete) {
        state.liveTranslationActive = false;
        state.liveTranslationParts = [];
        state.data.translation.markdown = String(event.markdown || "");
        // Only the completed document receives Markdown, TeX, and layout
        // rendering.  This is intentionally synchronous for a stable final
        // reader state.
        scheduleTranslationRender(true);
      }
      else if (Object.prototype.hasOwnProperty.call(event, "markdown")) {
        // Resume/checkpoint events are infrequent full snapshots. They reset
        // the plain live preview, but never invoke the Markdown renderer.
        state.liveTranslationActive = true;
        state.liveTranslationParts = [String(event.markdown || "")];
        replaceLiveTranslationPreview(state.liveTranslationParts[0]);
      }
      else if (event.delta) {
        state.liveTranslationActive = true;
        state.liveTranslationParts.push(String(event.delta));
        appendLiveTranslationPreview(String(event.delta));
      }
      setStatus(event.complete ? "全文翻译完成" : `正在翻译${event.chunkCount ? `：${event.chunk || 0}/${event.chunkCount}` : ""}`, event.complete ? 100 : null, event.complete ? "success" : "running");
      return;
    }
    if (type === "layout-translation") {
      if (!state.data) return;
      state.data.layout = state.data.layout || {};
      state.data.layout.translations = event.translations || {};
      state.data.layout.model = event.model || state.data.layout.model;
      state.data.layout.meta = { ...(state.data.layout.meta || {}), complete: Boolean(event.complete), translatedBlocks: event.translatedBlocks, totalBlocks: event.totalBlocks };
      // Layout geometry is a document-wide solve.  Publishing each group
      // tears down the page while formula and text measurements are changing,
      // so retain the last stable DOM and publish this model only as one unit.
      if (event.complete) {
        state.layoutLiveTranslationGroups.clear();
        flushLayoutLivePreview();
        renderLayoutPanes();
        state.layoutPublicationRevision += 1;
        queueLayoutPDFAttachmentsAfterFinalPublication();
      }
      setStatus(event.complete ? "排版翻译完成" : `排版翻译：${event.translatedBlocks || 0}/${event.totalBlocks || "?"}`, event.complete ? 100 : null, event.complete ? "success" : "running");
      return;
    }
    if (type === "chat-session") {
      state.currentSession = event.session || state.currentSession;
      if (state.pendingComposerSubmission) {
        state.pendingComposerSubmission = null;
        state.pendingImages = [];
        state.pendingDocuments = [];
        renderPendingImages();
        renderPendingDocuments();
      }
      renderChat();
      return;
    }
    if (type === "chat-delta") {
      state.streamingChatMessageID = String(event.messageID || "streaming");
      state.streamingChatInsertIndex = Number.isInteger(event.insertIndex) ? event.insertIndex : -1;
      state.streamingChatText += String(event.delta || "");
      updateStreamingChatDOM();
      return;
    }
    if (type === "chat-complete") {
      state.running.delete("chat");
      updateOperationUI();
      state.expandedReasoningIDs.delete(String(event.messageID || state.streamingChatMessageID || ""));
      state.streamingChatMessageID = "";
      state.streamingChatInsertIndex = -1;
      state.streamingChatText = "";
      state.reasoning = "";
      state.currentSession = event.session || state.currentSession;
      void refreshChatSessions(false);
      renderChat();
      return;
    }
    if (type === "chat-error") {
      state.running.delete("chat");
      updateOperationUI();
      state.streamingChatMessageID = "";
      state.streamingChatInsertIndex = -1;
      state.streamingChatText = "";
      state.reasoning = "";
      state.currentSession = event.session || state.currentSession;
      renderChat();
    }
  }

  function setData(data, { preserveLayout = false } = {}) {
    state.data = data || null;
    state.chatFollowLatest = true;
    renderedTranslationMarkdown = null;
    renderedSourceMarkdown = null;
    state.settings = data?.settings || state.settings;
    const isLayoutDebug = Boolean(els["debug-boxes-check"]?.checked || state.settings?.layoutDevelopmentMode);
    document.body.classList.toggle("layout-debug", isLayoutDebug);
    if (els["debug-boxes-check"]) els["debug-boxes-check"].checked = isLayoutDebug;
    const canUseLayoutReader = Boolean(data?.capabilities?.canUseLayoutReader);
    if (!state.modeInitialized) {
      // Reading mode belongs to this paper, not to the global preferences.
      // Documents without a saved choice deliberately enter layout mode first.
      state.mode = data?.item?.readerMode === "stream" ? "stream" : "layout";
      state.modeInitialized = true;
    }
    else if (state.mode === "layout" && !canUseLayoutReader) {
      state.mode = "stream";
    }
    state.syncScroll = state.mode === "layout"
      ? true
      : Boolean(state.settings?.streamSyncScroll ?? state.settings?.syncScroll ?? false);
    state.sessions = data?.chat?.sessions || [];
    state.currentSession = data?.chat?.session || null;
    els["sync-scroll-check"].checked = state.syncScroll;
    const documentID = String(data?.item?.documentID || "");
    const layoutFonts = state.settings?.layoutReaderFonts || {};
    // An absent per-document layout font means automatic fitting owns the body
    // font. Treating the stream reader's default as an override would replace
    // the fitted result after every render and can make dense blocks overlap.
    const savedLayoutFont = Number(layoutFonts[documentID]);
    state.layoutFontPt = Number.isFinite(savedLayoutFont) && savedLayoutFont > 0
      ? savedLayoutFont
      : 0;
    state.detectedLayoutFontPt = 0;
    if (state.mode === "layout") {
      if (state.layoutFontPt > 0) document.body.dataset.userBodyFontPt = String(state.layoutFontPt);
      else delete document.body.dataset.userBodyFontPt;
      ensureSourcePDF();
    }
    // In layout mode an empty control explicitly means "automatic fitting is
    // still in progress". Showing the stream reader's unrelated 12pt default
    // here makes it look like the fitter selected 12 and invites the first
    // user adjustment to persist a false override.
    els["reader-font-input"].value = state.mode === "layout"
      ? (state.layoutFontPt || state.detectedLayoutFontPt || "")
      : (state.settings?.readerFontPt || 12);
    document.documentElement.style.setProperty(
      "--reader-font-size",
      `${Number(els["reader-font-input"].value) || Number(state.settings?.readerFontPt) || 12}pt`
    );
    renderAll({ preserveLayout });
    updateOperationUI();
  }

  function ensureSourcePDF() {
    if (state.mode !== "layout") return;
    const attachmentID = Number(state.data?.item?.attachmentID || 0);
    if (!attachmentID || attachmentID === sourcePDFAttachmentID) return;
    sourcePDFAttachmentID = attachmentID;
    sourcePDFAvailable = false;
    sourcePDFLoading = true;
    void hostCall("initialize-pdf-preview").then(result => {
      if (Number(state.data?.item?.attachmentID || 0) !== attachmentID) return;
      sourcePDFAvailable = Boolean(result?.available);
      sourcePDFLoading = false;
      renderMode();
    }).catch(error => {
      if (Number(state.data?.item?.attachmentID || 0) === attachmentID) {
        sourcePDFAttachmentID = null;
        sourcePDFLoading = false;
        renderMode();
      }
      toast(error.message, "error");
    });
  }

  function renderAll({ preserveLayout = false } = {}) {
    const data = state.data;
    if (!data) return;
    els["document-title"].textContent = data.item?.title || "LitMTrans";
    els["document-subtitle"].textContent = data.item?.fileName || "附件";
    updateCapabilities();
    renderStreamPanes();
    if (!preserveLayout) renderLayoutPanes();
    renderMode();
    renderChatSessions();
    renderChat();
    renderPendingDocuments();
    renderSelection();
    populateSettings(state.settings);
    const parsed = Boolean(data.parsed?.markdown);
    const translated = Boolean(data.translation?.markdown);
    setStatus(parsed ? (translated ? "可阅读" : "已解析") : "尚未解析", parsed ? 0 : 0, parsed ? "success" : "neutral");
  }

  function updateCapabilities() {
    const caps = state.data?.capabilities || {};
    els["translate-button"].disabled = !caps.canTranslate || state.running.size > 0;
    els["manual-translate-button"].disabled = !caps.canTranslate || state.running.size > 0;
    els["layout-mode-button"].disabled = !caps.canUseLayoutReader;
    els["layout-mode-button"].title = caps.canUseLayoutReader
      ? "按原始PDF页面布局阅读；排版译文会在翻译后显示"
      : "排版阅读仅支持PDF附件";
  }

  function renderStreamPanes() {
    // MinerU can misread PDF equation-reference parentheses as `\~2!`.
    // Normalize only the display copy; parsed Markdown remains byte-for-byte
    // available for cache identity, retranslation, and export.
    const source = Markdown.repairEquationReferenceTranslation(
      "",
      String(state.data?.parsed?.markdown || "")
    );
    if (source !== renderedSourceMarkdown) {
      if (source) renderMarkdownInto(els["source-content"], source, { syncAnchors: true, imageLoading: "eager" });
      else els["source-content"].replaceChildren();
      renderedSourceMarkdown = source;
    }
    const liveTranslation = state.liveTranslationActive;
    const translation = liveTranslation
      ? state.liveTranslationParts.join("")
      : String(state.data?.translation?.markdown || state.data?.translation?.live || "");
    const stale = Boolean(state.data?.translation?.stale);
    els["translation-placeholder"].hidden = Boolean(translation);
    const placeholderTitle = els["translation-placeholder"].querySelector("h2");
    const placeholderText = els["translation-placeholder"].querySelector("p");
      if (placeholderTitle) placeholderTitle.textContent = stale ? "当前译文已失效" : "尚无译文";
    if (placeholderText) {
      placeholderText.textContent = stale
        ? (state.data?.translation?.error || "解析正文已变化，请重新翻译当前文档。")
        : "点击“翻译”即可翻译当前阅读模式。";
    }
    els["translation-content"].hidden = !translation || state.mode !== "stream";
    if (translation !== renderedTranslationMarkdown) {
      if (liveTranslation) replaceLiveTranslationPreview(translation);
      else if (translation) renderMarkdownInto(els["translation-content"], translation, { syncAnchors: true, imageLoading: "eager" });
      else els["translation-content"].replaceChildren();
      renderedTranslationMarkdown = translation;
    }
  }

  function liveTranslationPreviewNode() {
    const container = els["translation-content"];
    // Delta events bypass renderStreamPanes for performance, so they must
    // perform the small visibility transition that a full render normally
    // handles. Without this, the preview accumulates while still hidden and
    // appears only when the final Markdown render arrives.
    els["translation-placeholder"].hidden = true;
    container.hidden = state.mode !== "stream";
    let preview = container.querySelector(".translation-live-preview");
    if (!preview) {
      preview = document.createElement("pre");
      preview.className = "translation-live-preview streaming-cursor";
      container.replaceChildren(preview);
    }
    return preview;
  }

  function replaceLiveTranslationPreview(text) {
    const preview = liveTranslationPreviewNode();
    preview.textContent = String(text || "");
  }

  function appendLiveTranslationPreview(delta) {
    const preview = liveTranslationPreviewNode();
    const text = String(delta || "");
    if (!text) return;
    // Use bounded text nodes instead of repeatedly assigning one ever-growing
    // textContent string.  This keeps a long streaming translation linear in
    // allocation while retaining a single, cheap plain-text preview.
    let tail = preview.lastChild;
    if (!tail || tail.nodeType !== Node.TEXT_NODE || tail.data.length > 8192) {
      tail = document.createTextNode("");
      preview.appendChild(tail);
    }
    tail.data += text;
    requestAnimationFrame(() => keepTranslationAtLatest(true));
  }

  function translationIsNearBottom() {
    const scroll = els["translation-scroll"];
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
  }

  function keepTranslationAtLatest(shouldFollow) {
    if (!shouldFollow) return;
    const scroll = els["translation-scroll"];
    scroll.scrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
  }

  function flushTranslationRender(shouldFollow = translationIsNearBottom()) {
    if (translationRenderTimer) {
      clearTimeout(translationRenderTimer);
      translationRenderTimer = null;
    }
    translationRenderQueued = false;
    renderStreamPanes();
    requestAnimationFrame(() => keepTranslationAtLatest(shouldFollow));
  }

  function scheduleTranslationRender(complete = false) {
    if (complete) {
      // A partial stream may have fallen back to plain text because a formula
      // or tag was temporarily incomplete. Always render the final payload
      // again, even when its text equals the last streamed payload.
      renderedTranslationMarkdown = null;
      flushTranslationRender(translationIsNearBottom() || state.running.has("translate"));
      return;
    }
    if (translationRenderQueued) return;
    translationRenderQueued = true;
    translationRenderTimer = setTimeout(() => {
      translationRenderTimer = null;
      translationRenderQueued = false;
      const shouldFollow = translationIsNearBottom();
      renderStreamPanes();
      requestAnimationFrame(() => keepTranslationAtLatest(shouldFollow));
    }, 100);
  }

  function hasLayoutLivePreview() {
    return state.layoutLiveTranslationGroups.size > 0;
  }

  function renderLayoutLivePreview() {
    const active = hasLayoutLivePreview();
    const container = els["translation-content"];
    if (!active) {
      container.replaceChildren();
      return;
    }
    const fragment = document.createDocumentFragment();
    const heading = document.createElement("div");
    heading.className = "layout-live-preview-heading";
    heading.textContent = "正在生成译文，完成后会自动恢复页面排版";
    fragment.appendChild(heading);
    const groups = [...state.layoutLiveTranslationGroups.values()]
      .sort((first, second) => first.group - second.group || first.attempt.localeCompare(second.attempt));
    for (const item of groups) {
      const section = document.createElement("section");
      section.className = "layout-live-preview-group";
      const title = document.createElement("div");
      title.className = "layout-live-preview-group-title";
      title.textContent = `第 ${item.group}/${item.groupCount} 部分${item.attempt === "retry" ? "（校对中）" : ""}`;
      const text = document.createElement("pre");
      text.className = "layout-live-preview-text streaming-cursor";
      text.textContent = item.text;
      section.append(title, text);
      fragment.appendChild(section);
    }
    container.replaceChildren(fragment);
  }

  function flushLayoutLivePreview(shouldFollow = translationIsNearBottom()) {
    if (layoutLivePreviewRenderTimer) {
      clearTimeout(layoutLivePreviewRenderTimer);
      layoutLivePreviewRenderTimer = null;
    }
    layoutLivePreviewRenderQueued = false;
    renderLayoutLivePreview();
    renderMode();
    if (hasLayoutLivePreview()) requestAnimationFrame(() => keepTranslationAtLatest(shouldFollow));
  }

  function scheduleLayoutLivePreview() {
    if (layoutLivePreviewRenderQueued) return;
    layoutLivePreviewRenderQueued = true;
    layoutLivePreviewRenderTimer = setTimeout(() => {
      layoutLivePreviewRenderTimer = null;
      layoutLivePreviewRenderQueued = false;
      flushLayoutLivePreview();
    }, 80);
  }

  function splitTeXEquationTag(value) {
    const raw = String(value || "").trim()
      .replace(/^\\\[|\\\]$/g, "")
      .replace(/^\$\$|\$\$$/g, "")
      .trim();
    const match = raw.match(/\\tag\s*\{([^{}]+)\}\s*,?\s*$/);
    if (!match) return { body: raw, number: "" };
    return {
      body: raw.slice(0, match.index).replace(/,\s*$/, "").trim(),
      number: String(match[1] || "").trim()
    };
  }

  function formulaTeXWithoutTag(value) {
    const raw = String(value || "").trim();
    const equation = splitTeXEquationTag(raw);
    if (!equation.number) return raw;
    for (const [open, close] of [["\\[", "\\]"], ["$$", "$$"], ["\\(", "\\)"], ["$", "$"]]) {
      if (raw.startsWith(open) && raw.endsWith(close)) return `${open}${equation.body}${close}`;
    }
    return equation.body;
  }

  function renderLayoutTranslatedText(text) {
    // Layout translations are stored as plain text blocks.  Models can retain
    // TeX but omit its delimiters (for example `\\sigma _ { t }`), which
    // makes the inline renderer show the source literally.  Use the same
    // deliberately narrow repair path used for rendered chat replies.
    // Never trust persisted model text to be DOM-safe. Older cache entries
    // may contain JSON escape artefacts such as U+0008 from `\boldsymbol`.
    const source = [...String(text || "")].filter(character => {
      const code = character.codePointAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && !(code >= 0xD800 && code <= 0xDFFF));
    }).join("");
    const normalized = Markdown.normalizeEscapedTeXDelimiters
      ? Markdown.normalizeEscapedTeXDelimiters(source)
      : source;
    const repaired = Markdown.normalizeBareTeXFragments
      ? Markdown.normalizeBareTeXFragments(normalized)
      : normalized;
    return Markdown.renderInline(repaired, { resolveImage: imageResolver });
  }

  function renderLayoutTocRows(rows) {
    return (rows || []).map(row => {
      if (row?.gap) return '<div class="toc-gap" aria-hidden="true"></div>';
      if (!row?.page) {
        return `<div class="toc-unparsed">${U.escapeHTML(String(row?.text || ""))}</div>`;
      }
      const level = Math.max(0, Math.min(8, Number(row.level || 0)));
      return (
        `<div class="toc-row toc-level-${level}" style="--toc-level:${level}">` +
        `<span class="toc-label"><span class="toc-number">${U.escapeHTML(String(row.number || ""))}</span> ` +
        `<span class="toc-title">${U.escapeHTML(String(row.title || ""))}</span></span>` +
        '<span class="toc-leader" aria-hidden="true"></span>' +
        `<span class="toc-page">${U.escapeHTML(String(row.page || ""))}</span></div>`
      );
    }).join("");
  }

  function layoutBlockHTML(block, translated, useTranslation = false) {
    if (block.kind === "image" && block.imageURL) {
      return `<img src="${U.escapeAttribute(block.imageURL)}" alt="" loading="lazy" decoding="async" />`;
    }
    if (block.kind === "table" && block.tableHTML) {
      return `<div class="layout-table-wrap">${block.tableHTML}</div>`;
    }
    if (block.kind === "code") {
      const language = String(block.codeLanguage || "text");
      return (
        `<pre class="layout-code" data-code-language="${U.escapeAttribute(language)}">` +
        `<code>${U.escapeHTML(String(block.text || ""))}</code></pre>`
      );
    }
    if (block.kind === "formula") {
      const formula = block.formulas?.[0] || block.text || "";
      const formulaID = block.formulaItems?.[0]?.id || block.id || "";
      const equation = splitTeXEquationTag(formula);
      const number = equation.number
        ? `<span class="layout-equation-number">(${U.escapeHTML(equation.number)})</span>`
        : "";
      const numberRight = Number(block.numberRight);
      const numberStyle = equation.number && Number.isFinite(numberRight) && Array.isArray(block.bbox)
        ? ` style="--equation-number-right:${(numberRight - Number(block.bbox[0] || 0)).toFixed(2)}px"`
        : "";
      return (
        `<div class="layout-formula-target layout-equation-text${equation.number ? " has-number" : ""}"${numberStyle} ` +
        `data-formula-id="${U.escapeAttribute(formulaID)}" data-formula-tex="${U.escapeAttribute(formula)}">` +
        `<span class="layout-equation-formula">${Markdown.renderTeX(equation.body || formula, true)}</span>${number}</div>`
      );
    }
    if (!translated && block.sourceHTML) return block.sourceHTML;
    return useTranslation
      ? renderLayoutTranslatedText(translated)
      : Markdown.renderInline(translated, { resolveImage: imageResolver });
  }

  function placeLayoutNode(node, bbox, page) {
    const [left, top, right, bottom] = bbox || [0, 0, 1, 1];
    node.style.left = `${left / page.width * 100}%`;
    node.style.top = `${top / page.height * 100}%`;
    node.style.width = `${Math.max(.1, (right - left) / page.width * 100)}%`;
    node.style.height = `${Math.max(.1, (bottom - top) / page.height * 100)}%`;
  }

  function layoutPartHTML(part, useTranslation) {
    const translated = String(part?.translatedText || "");
    if (useTranslation && translated) return renderLayoutTranslatedText(translated);
    if (!useTranslation && part?.html) return String(part.html);
    return Markdown.renderInline(String(part?.text || ""), { resolveImage: imageResolver });
  }

  function appendLayoutDebugLines(node, lines, bbox, page) {
    if (!state.settings?.layoutDevelopmentMode || !Array.isArray(lines)) return;
    const width = Math.max(1, Number(bbox?.[2] || 0) - Number(bbox?.[0] || 0));
    const height = Math.max(1, Number(bbox?.[3] || 0) - Number(bbox?.[1] || 0));
    for (const line of lines) {
      if (!Array.isArray(line) || line.length < 4) continue;
      const overlay = document.createElement("span");
      overlay.className = "layout-line-debug-box";
      overlay.style.left = `${(line[0] - bbox[0]) / width * 100}%`;
      overlay.style.top = `${(line[1] - bbox[1]) / height * 100}%`;
      overlay.style.width = `${Math.max(.2, (line[2] - line[0]) / width * 100)}%`;
      overlay.style.height = `${Math.max(.2, (line[3] - line[1]) / height * 100)}%`;
      node.appendChild(overlay);
    }
  }

  function buildFlowStreamNode(stream, page, useTranslation) {
    const node = document.createElement("div");
    const roles = String(stream.debugRole || "text").replace(/[^a-z0-9_-]+/gi, "-");
    node.className = `layout-flow-stream debug-${roles}`;
    if (stream.refsOnly) node.classList.add("refs");
    const fromList = (stream.items || []).some(item => item.fromList || item.parts?.some(part => part.fromList));
    if (fromList) node.classList.add("from-list");
    if (stream.equationDense) node.classList.add("equation-dense");
    const sourceTocRows = (stream.items || []).flatMap(item => Array.isArray(item.tocRows) ? item.tocRows : []);
    const translatedTocText = (stream.items || [])
      .map(item => String(item.translatedText || ""))
      .filter(Boolean)
      .join("\n");
    const tocRows = useTranslation
      ? (Layout?.parseTocTextRows?.(translatedTocText) || null)
      : (sourceTocRows.length ? sourceTocRows : null);
    const isToc = Boolean(sourceTocRows.length && tocRows?.length);
    if (isToc) node.classList.add("toc-stream");
    const originalLineCount = (stream.items || []).reduce((sum, item) =>
      sum + Number(item.originalLineCount || item.parts?.reduce((partSum, part) => partSum + Number(part.originalLineCount || 0), 0) || 0), 0);
    const paragraphCount = (stream.items || []).reduce((sum, item) =>
      sum + (Array.isArray(item.paragraphs) && item.paragraphs.length ? item.paragraphs.length : 1), 0);
    const originalLines = isToc || (stream.items || []).length > 1 || paragraphCount > 1 || originalLineCount > 1 ? "multi" : "single";
    const [left, , right] = stream.bbox || [0, 0, 0, 0];
    const symmetry = Math.abs(left - (page.width - right)) / Math.max(1, right - left) <= .07;
    node.dataset.flowKind = stream.refsOnly ? "ref_text" : "text";
    node.dataset.styleKind = stream.styleKind || "text";
    node.dataset.bodyInherited = stream.bodyInherited ? "1" : "0";
    node.dataset.originalLines = originalLines;
    node.dataset.singleLineAlign = originalLines === "single" && stream.debugRole === "text" && symmetry ? "center" : "left";
    node.dataset.fromList = fromList ? "1" : "0";
    node.dataset.equationDense = stream.equationDense ? "1" : "0";
    node.dataset.toc = isToc ? "1" : "0";
    node.dataset.columnKey = String(stream.columnKey || "");
    node.dataset.blockID = String(stream.items?.[0]?.id || stream.items?.[0]?.parts?.[0]?.id || "");
    placeLayoutNode(node, stream.bbox, page);
    const baseFont = Math.max(4, Number(stream.fontSize || 7.6));
    const baseLineRatio = Math.max(1, Number(stream.lineHeight || 1.16));
    node.dataset.baseFont = String(baseFont);
    node.dataset.baseLineRatio = String(baseLineRatio);
    // Store fitting values in source-page coordinates while applying styles in
    // the reader's canonical 920px page coordinate system.
    node.dataset.lineRatio = String(baseLineRatio);
    node.dataset.layoutFontScale = "1";
    node.dataset.pageHeight = String(Math.max(1, Number(page.height) || 1));
    node.style.fontSize = `calc(${baseFont}px * var(--layout-scale))`;
    node.style.lineHeight = String(baseLineRatio);
    node.style.setProperty("--para-gap", `${Math.max(0, Number(stream.paragraphGap || .16))}em`);
    if (isToc) {
      safeSetElementHTML(node, renderLayoutTocRows(tocRows));
    }
    else {
      const paragraphs = (stream.items || []).flatMap(item =>
        Array.isArray(item.paragraphs) && item.paragraphs.length
          ? item.paragraphs
          : [{ parts: item.parts || [item], indent: item.indent || 0 }]);
      for (const paragraph of paragraphs) {
        const paragraphNode = document.createElement("div");
        paragraphNode.className = stream.refsOnly ? "flow-ref" : "flow-para";
        const parts = Array.isArray(paragraph.parts) ? paragraph.parts : [];
        if (!stream.refsOnly && Number(paragraph.indent || 0) > 0) {
          paragraphNode.style.textIndent = `calc(${Number(paragraph.indent)}px * var(--layout-scale))`;
        }
        const htmlParts = [];
        for (let index = 0; index < parts.length; index++) {
          const part = parts[index];
          const previous = parts[index - 1];
          const separator = index && !/[-−–]\s*$/.test(String(previous?.text || "")) ? " " : "";
          htmlParts.push(separator, layoutPartHTML(part, useTranslation));
        }
        safeSetElementHTML(paragraphNode, htmlParts.join(""));
        for (const part of parts) {
          if (part.id) paragraphNode.dataset.blockID ||= part.id;
        }
        node.appendChild(paragraphNode);
      }
    }
    const debugLines = (stream.items || []).flatMap(item => item.debugLines || item.parts?.flatMap(part => part.debugLines || []) || []);
    appendLayoutDebugLines(node, debugLines, stream.bbox, page);
    return node;
  }

  function buildAbsoluteLayoutNode(block, page, useTranslation) {
    const node = document.createElement("div");
    const safeType = String(block.type || "unknown").replace(/[^a-z0-9_-]+/gi, "-");
    node.className = `layout-block type-${safeType} layout-${block.kind || "text"}`;
    if (block.type === "title") node.classList.add("layout-title");
    if (block.mainTitle) node.classList.add("main-title");
    if (/caption|footnote/.test(block.type || "")) node.classList.add("layout-caption");
    const translatedText = useTranslation ? String(block.translatedText || "") : "";
    placeLayoutNode(node, block.bbox, page);
    const baseFont = Math.max(4, Number(block.fontSize || 8));
    // The fitter uses this metadata for multi-line absolute text; without it,
    // those blocks silently bypass collision and backoff iteration.
    const originalLineCount = Math.max(1, Number(block.lineCount || 1));
    node.dataset.baseFont = String(baseFont);
    node.dataset.baseLineRatio = String(Math.max(1, Number(block.lineHeight || 1.12)));
    node.dataset.lineRatio = node.dataset.baseLineRatio;
    node.dataset.blockKind = String(block.type || "text");
    node.dataset.fitLabel = "";
    if (/^(?:table_caption|table_footnote|chart_caption|image_caption|image_footnote)$/i.test(String(block.type || ""))) {
      // Caption blocks use a tight, frame-relative fill band. Without it the
      // page-wide fallback can treat a caption as already full and skip the
      // font-size and line-height iteration.
      node.dataset.fitBandRatio = "0.120";
    }
    if (String(block.type || "").toLowerCase() === "text") {
      node.dataset.originalLines = originalLineCount > 1 ? "multi" : "single";
      const [left, , right] = block.bbox || [0, 0, 0, 0];
      const symmetric = Math.abs(left - (page.width - right)) / Math.max(1, right - left) <= .07;
      node.dataset.singleLineAlign = node.dataset.originalLines === "single" && symmetric ? "center" : "left";
    }
    node.dataset.layoutFontScale = "1";
    node.dataset.pageHeight = String(Math.max(1, Number(page.height) || 1));
    node.style.fontSize = `calc(${baseFont}px * var(--layout-scale))`;
    if (String(block.kind || "").toLowerCase() === "code") {
      // Code blocks are positioned frames, not flowing content. Keep the
      // pre/code line box tied to the parent so the translated fit pass can
      // compact the frame without changing the geometry of following blocks.
      const codeLineRatio = Math.max(.95, Number(block.lineHeight || 1.18));
      node.dataset.baseLineRatio = String(codeLineRatio);
      node.dataset.lineRatio = node.dataset.baseLineRatio;
      node.style.lineHeight = String(codeLineRatio);
    }
    node.dataset.blockID = block.id || "";
    safeSetElementHTML(
      node,
      layoutBlockHTML(
        block,
        useTranslation ? (translatedText || String(block.text || "")) : (block.sourceHTML ? "" : String(block.text || "")),
        useTranslation
      )
    );
    appendLayoutDebugLines(node, block.debugLines, block.bbox, page);
    return node;
  }

  function layoutTextRects(node) {
    if (!node?.isConnected) return [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode(textNode) {
        if (!textNode.textContent?.trim()) return NodeFilter.FILTER_REJECT;
        if (textNode.parentElement?.closest(".layout-line-debug-box, .layout-collision-debug-layer, [aria-hidden='true']")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const range = document.createRange();
    const rects = [];
    let textNode;
    while ((textNode = walker.nextNode())) {
      range.selectNodeContents(textNode);
      for (const rect of range.getClientRects()) {
        if (rect.width <= .5 || rect.height <= .5) continue;
        rects.push({
          left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
          width: rect.width, height: rect.height
        });
      }
    }
    range.detach?.();
    return rects;
  }

  function layoutRectsOverlap(first, second, tolerance = 1.5) {
    return (
      Math.min(first.right, second.right) - Math.max(first.left, second.left) > tolerance
      && Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top) > tolerance
    );
  }

  // Use cheap block/union checks as a broad phase, then compare glyph ranges
  // only for candidates that may actually overlap.
  function layoutRectUnion(rects) {
    if (!rects?.length) return null;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const rect of rects) {
      if (!rect) continue;
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    }
    return Number.isFinite(left) ? { left, top, right, bottom } : null;
  }

  function layoutNodeCollision(node, sourceRects = null) {
    const page = node?.closest?.(".layout-page");
    if (!page) return null;
    const own = node.getBoundingClientRect();
    const rects = sourceRects || layoutTextRects(node);
    if (!rects.length) return null;
    const textUnionBox = layoutRectUnion(rects);
    const barriers = [...page.querySelectorAll(":scope > .layout-flow-stream, :scope > .layout-block")]
      .filter(barrier => barrier !== node && !barrier.hidden && barrier.getClientRects().length);
    for (const barrier of barriers) {
      const barrierBox = barrier.getBoundingClientRect();
      if (!layoutRectsOverlap(own, barrierBox, 0) && !layoutRectsOverlap(textUnionBox, barrierBox, 0)) continue;
      const barrierIsText = barrier.matches(".layout-flow-stream, .layout-block.layout-text, .layout-block.layout-title, .layout-block.layout-caption");
      const barrierRects = barrierIsText ? layoutTextRects(barrier) : [barrierBox];
      const barrierUnionBox = layoutRectUnion(barrierRects) || barrierBox;
      if (!layoutRectsOverlap(textUnionBox, barrierUnionBox, 1.5)) continue;
      for (const rect of rects) {
        for (const barrierRect of barrierRects) {
          if (!layoutRectsOverlap(rect, barrierRect, 1.5)) continue;
          // Adjacent columns and stacked boxes often share a mathematical
          // boundary. A small italic/MathJax optical overhang is harmless;
          // deeper ink intrusion is a real collision and must constrain the
          // document-wide fit.
          const sharesRight = Math.abs(own.right - barrierBox.left) <= 1.5;
          const sharesLeft = Math.abs(own.left - barrierBox.right) <= 1.5;
          const sharesBottom = Math.abs(own.bottom - barrierBox.top) <= 1.5;
          const sharesTop = Math.abs(own.top - barrierBox.bottom) <= 1.5;
          const horizontalIntrusion = Math.min(rect.right, barrierRect.right) - Math.max(rect.left, barrierRect.left);
          const verticalIntrusion = Math.min(rect.bottom, barrierRect.bottom) - Math.max(rect.top, barrierRect.top);
          if ((sharesRight || sharesLeft) && horizontalIntrusion <= 2.5) continue;
          if ((sharesBottom || sharesTop) && verticalIntrusion <= 2.5) continue;
          return { source: node, blocker: barrier, rect, barrierRect };
        }
      }
    }
    return null;
  }

  function layoutNodeFits(node, allowHorizontalOverflow = false, allowOwnOverflow = false) {
    if (!node?.isConnected || node.clientHeight <= 0 || node.clientWidth <= 0) return true;
    const vertical = node.scrollHeight <= node.clientHeight + 1;
    const horizontal = allowHorizontalOverflow || node.scrollWidth <= node.clientWidth + 1;
    if (!allowOwnOverflow && (!vertical || !horizontal)) {
      node._litmtransFitFailure = { type: vertical ? "horizontal-overflow" : "vertical-overflow" };
      return false;
    }
    const page = node.closest(".layout-page");
    if (!page) return true;
    const pageRect = page.getBoundingClientRect();
    const rects = layoutTextRects(node);
    for (const rect of rects) {
      if (rect.bottom > pageRect.bottom + 1 || rect.top < pageRect.top - 3) {
        node._litmtransFitFailure = { type: "page-vertical-overflow", rect };
        return false;
      }
      if (!allowHorizontalOverflow && (rect.left < pageRect.left - 1 || rect.right > pageRect.right + 1)) {
        node._litmtransFitFailure = { type: "page-horizontal-overflow", rect };
        return false;
      }
    }
    const collision = layoutNodeCollision(node, rects);
    if (collision) {
      node._litmtransFitFailure = { type: "block-collision", ...collision };
      return false;
    }
    node._litmtransFitFailure = null;
    return true;
  }

  function applyLayoutNodeStyle(node, fontPx, lineRatio) {
    node.style.fontSize = `calc(${fontPx}px * var(--layout-scale))`;
    node.style.lineHeight = String(lineRatio);
    node.dataset.fittedFontPx = Number(fontPx).toFixed(2);
    node.dataset.fittedLineRatio = Number(lineRatio).toFixed(3);
  }

  function allNodesFit(nodes, allowHorizontal, allowOwnOverflow = false) {
    let ok = true;
    for (const node of nodes) {
      if (!layoutNodeFits(node, allowHorizontal, allowOwnOverflow)) ok = false;
    }
    return ok;
  }

  function medianValueLocal(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function layoutTitleFrameFill(node) {
    const frame = node?.getBoundingClientRect?.();
    const ink = layoutRectUnion(layoutTextRects(node));
    if (!frame || !ink || frame.width <= 0 || frame.height <= 0) return { area: 0, width: 0, height: 0 };
    const usedWidth = Math.max(0, Math.min(frame.right, ink.right) - Math.max(frame.left, ink.left));
    const usedHeight = Math.max(0, Math.min(frame.bottom, ink.bottom) - Math.max(frame.top, ink.top));
    const width = Math.min(1, usedWidth / frame.width);
    const height = Math.min(1, usedHeight / frame.height);
    return { area: width * height, width, height };
  }

  // After the shared section-title pass, only titles that leave most of their
  // original source frame unused may grow on their own. Their glyphs still
  // undergo the same page-boundary and collision checks as every other block.
  function expandUnderfilledLayoutTitles(nodes, options = {}) {
    const areaThreshold = Number(options.areaThreshold ?? .42);
    const dimensionThreshold = Number(options.dimensionThreshold ?? .72);
    const maxFont = Number(options.maxFont ?? 42);
    const step = Number(options.fontStep ?? .25);
    for (const node of nodes || []) {
      const initial = layoutTitleFrameFill(node);
      if (initial.area >= areaThreshold || (initial.width >= dimensionThreshold && initial.height >= dimensionThreshold)) continue;
      let font = Number(node.dataset.fittedFontPx || node.dataset.baseFont || 8);
      const lineRatio = Number(node.dataset.fittedLineRatio || node.dataset.baseLineRatio || 1.12);
      for (let iteration = 0; iteration < 136 && font + step <= maxFont; iteration++) {
        const next = font + step;
        applyLayoutNodeStyle(node, next, lineRatio);
        if (!layoutNodeFits(node, true, true)) {
          applyLayoutNodeStyle(node, font, lineRatio);
          break;
        }
        font = next;
        const fill = layoutTitleFrameFill(node);
        if (fill.area >= areaThreshold || (fill.width >= dimensionThreshold && fill.height >= dimensionThreshold)) break;
      }
    }
  }

  // Keep near-equal headings visually coherent after the exceptional recovery
  // above. A cluster spans at most one px from its smallest member; different
  // semantic levels remain separate. Shrinking cannot introduce collisions.
  function clusterLayoutTitleFontSizes(nodes, maxDifference = 1.0) {
    const entries = (nodes || [])
      .filter(node => node?.isConnected)
      .map(node => ({ node, font: Number(node.dataset.fittedFontPx || node.dataset.baseFont || 0) }))
      .filter(entry => entry.font > 0)
      .sort((left, right) => left.font - right.font);
    let cluster = [];
    let minimum = 0;
    const applyCluster = () => {
      if (cluster.length < 2) return;
      for (const entry of cluster) {
        applyLayoutNodeStyle(entry.node, minimum, Number(entry.node.dataset.fittedLineRatio || entry.node.dataset.baseLineRatio || 1.12));
      }
    };
    for (const entry of entries) {
      if (!cluster.length || entry.font - minimum <= maxDifference + .001) {
        cluster.push(entry);
        if (cluster.length === 1) minimum = entry.font;
      } else {
        applyCluster();
        cluster = [entry];
        minimum = entry.font;
      }
    }
    applyCluster();
  }

  function collectPageColumnRights(page) {
    const pageWidth = Number(page.dataset.sourceWidth || page.clientWidth || 612);
    const nodes = [...page.querySelectorAll(".layout-flow-stream, .layout-block.type-text")];
    if (!nodes.length) return null;

    const columns = [];
    for (const node of nodes) {
      if (node.classList.contains("refs") || node.classList.contains("toc-stream")
        || node.classList.contains("layout-caption") || node.classList.contains("layout-title")) continue;
      const leftPct = Number.parseFloat(node.style.left);
      const widthPct = Number.parseFloat(node.style.width);
      if (!Number.isFinite(leftPct) || !Number.isFinite(widthPct)) continue;
      const left = leftPct * pageWidth / 100;
      const width = widthPct * pageWidth / 100;
      const right = left + width;
      if (width > pageWidth * 0.82 || width < 20) continue;
      const key = String(node.dataset.columnKey || "");
      if (key === "full") continue;

      let col = key
        ? columns.find(c => c.key === key)
        : columns.find(c => Math.abs(c.anchor - left) < 28);

      if (!col) {
        col = { key: key || `col-${columns.length}`, anchor: left, minLeft: left, maxRight: right };
        columns.push(col);
      } else {
        col.minLeft = Math.min(col.minLeft, left);
        col.maxRight = Math.max(col.maxRight, right);
      }
    }
    return columns.length ? columns : null;
  }

  function calibrateEquationNumberRight(block, target, page, columns) {
    const pageWidth = Number(page.dataset.sourceWidth || page.clientWidth || 612);
    const blockLeftPct = Number.parseFloat(block.style.left);
    const blockWidthPct = Number.parseFloat(block.style.width);
    if (!Number.isFinite(blockLeftPct)) return;

    const blockLeft = blockLeftPct * pageWidth / 100;
    const blockWidth = (Number.isFinite(blockWidthPct) ? blockWidthPct : 0) * pageWidth / 100;
    const blockRight = blockLeft + blockWidth;

    let bestCol = null;
    let minDist = Infinity;
    for (const col of columns) {
      const dist = Math.abs(blockLeft - col.anchor);
      if (dist < minDist) {
        minDist = dist;
        bestCol = col;
      }
    }
    if (!bestCol) return;

    let targetRight = bestCol.maxRight;
    const colWidth = Math.max(1, bestCol.maxRight - bestCol.minLeft);

    if (blockWidth >= colWidth * 1.25 || blockRight > bestCol.maxRight + 15) {
      const spanningCols = columns.filter(col => col.maxRight >= blockLeft && col.minLeft <= blockRight + 15);
      if (spanningCols.length > 1) {
        targetRight = Math.max(...spanningCols.map(c => c.maxRight));
      }
    }

    const desiredNumberRightPx = targetRight - blockLeft;
    if (desiredNumberRightPx > 20) {
      const currentVal = Number.parseFloat(target.style.getPropertyValue("--equation-number-right") || "0");
      if (!currentVal || desiredNumberRightPx > currentVal + 4) {
        target.style.setProperty("--equation-number-right", `${desiredNumberRightPx.toFixed(2)}px`);
      }
    }
  }

  function fitLayoutFormulas(pages, { expand = false } = {}) {
    for (const page of (pages || []).filter(Boolean)) {
      const formulas = [...page.querySelectorAll(".layout-block.layout-formula")];
      if (!formulas.length) continue;

      const columns = expand ? collectPageColumnRights(page) : null;

      for (const block of formulas) {
        const target = block.querySelector(".layout-formula-target") || block;
        const number = target.querySelector(".layout-equation-number");
        const formula = target.querySelector(".katex, .litmtrans-math") || target.firstElementChild || target;

        if (expand && number && columns) {
          calibrateEquationNumberRight(block, target, page, columns);
        }

        formula.style.transform = "";
        formula.style.transformOrigin = number ? "left center" : "center center";
        formula.style.display = "inline-block";
        // `.litmtrans-math` normally has max-width:100% for flowing Markdown.
        // Inside an absolute equation block that cap hides the true overflowing
        // content width from getBoundingClientRect(), so the scale calculation
        // can report success while descendants still cross into the next column.
        // Measure its intrinsic equation width, matching MathJax's width:auto
        formula.style.width = "max-content";
        formula.style.maxWidth = "none";
        formula.style.overflow = "visible";

        const blockRect = block.getBoundingClientRect();
        const formulaRect = formula.getBoundingClientRect();
        if (blockRect.width <= 0 || formulaRect.width <= 0) continue;

        const availableWidth = Math.max(1, blockRect.width - 4);
        let maxFormulaWidth = availableWidth;
        if (number) {
          const numRect = number.getBoundingClientRect();
          if (numRect.left > formulaRect.left) {
            const spaceBeforeNumber = numRect.left - formulaRect.left - 8;
            if (spaceBeforeNumber > 10) {
              maxFormulaWidth = Math.min(maxFormulaWidth, spaceBeforeNumber);
            }
          }
        }

        const scaleW = maxFormulaWidth / Math.max(1, formulaRect.width);
        let scale = Math.min(1, scaleW);

        if (expand && blockRect.height > 0 && formulaRect.height > 0) {
          const targetHeight = blockRect.height * 0.92;
          const scaleH = targetHeight / formulaRect.height;
          scale = Math.min(scaleW, Math.max(0.7, scaleH), 1.35);
        }

        if (Math.abs(scale - 1) > 0.005) {
          formula.style.transform = `scale(${scale.toFixed(4)})`;
        }
        block.classList.toggle("layout-fitted", scale < .999);
        if (state.settings?.layoutDevelopmentMode || document.body.classList.contains("layout-debug")) {
          block.dataset.fitLabel = `formula · ${scale.toFixed(3)}×`;
        }
      }
    }
  }

  function fitLayoutPages(pageNodes) {
    const pages = (pageNodes || []).filter(Boolean);
    const wraps = pages.map(page => page.closest(".layout-page-wrap")).filter(Boolean);

    // Initial pass: shrink-only so oversized un-fitted formulas do not become
    // false body-text barriers during shared font iteration.
    fitLayoutFormulas(pages);
    runLayoutParityEngine(wraps, false);
    // Post-pass: adapt formulas to bbox and right-align equation numbers.
    fitLayoutFormulas(pages, { expand: true });
  }

  // A layout solve is expensive because it measures real glyph rectangles.
  // The result is deterministic for one translated-layout identity, viewport
  // width and body-font choice, so retain the solved inline styles instead of
  // repeating the measurement whenever the user switches reading modes.
  const layoutFitSnapshots = new Map();
  function layoutFitSnapshotKey() {
    const documentID = String(state.data?.item?.documentID || "");
    const model = state.data?.layout?.model || {};
    const identity = String(
      state.data?.layout?.stale
        ? model.sourceFingerprint
        : (state.data?.layout?.meta?.identity || model.sourceFingerprint || "")
    );
    const bodyFont = Number(state.layoutFontPt || 0).toFixed(1);
    return `${documentID}|${identity}|${bodyFont}`;
  }

  function layoutFitPageKey(page) {
    const nodes = [...page.querySelectorAll(".layout-block, .layout-flow-stream")];
    const structure = nodes.map(node => [
      node.dataset.blockId || node.id || "",
      node.dataset.styleKind || "",
      node.dataset.flowKind || "",
      // Fitting may correct MinerU's single-line classification.
      node.dataset.originalLines || "",
      node.dataset.singleLineAlign || "",
      node.className || "",
      // Different wording can produce different line breaks, so text is part
      // of the fit-cache identity.
      U.hashString(String(node.textContent || "").replace(/\s+/g, " ").trim())
    ].join(":")).join("|");
    const pageIndex = page.closest(".layout-page-wrap")?.dataset.page || "";
    return `${layoutFitSnapshotKey()}|${pageIndex}|${Math.round(page.clientWidth || 0)}|${U.hashString(structure)}`;
  }

  function layoutFitStorageKey(key) {
    // Change this namespace whenever cached fitting rules become incompatible.
    return `litmtrans-layout-fit-runtime:v23:${U.hashString(key)}`;
  }

  function applyLayoutBodyFont(pages) {
    const requested = Number(state.layoutFontPt || 0);
    if (!Number.isFinite(requested) || requested <= 0) return;
    for (const page of pages || []) {
      for (const node of page.querySelectorAll(".layout-flow-stream[data-style-kind='body_text'][data-flow-kind='text']")) {
        // Captions, references, formulas and media retain their solved style.
        node.style.fontSize = `${requested}pt`;
        node.dataset.userBodyFontPt = requested.toFixed(2);
      }
    }
  }

  function applyLayoutFitSnapshot(pages, snapshot) {
    const restored = new Set();
    const requested = (pages || []).filter(Boolean);
    if (snapshot?.version !== 11 || !Array.isArray(snapshot.pages)) return restored;
    // Document-wide groups must be restored as one atomic fit.
    if (!requested.length || snapshot.pages.length !== requested.length) return restored;
    const byKey = new Map(snapshot.pages.map(page => [page.key, page]));
    const plans = [];
    for (const page of requested) {
      const pageKey = layoutFitPageKey(page);
      const record = byKey.get(pageKey);
      const nodes = [...page.querySelectorAll(".layout-block, .layout-flow-stream")];
      if (!record || !Array.isArray(record.styles) || record.styles.length !== nodes.length) return restored;
      plans.push({ page, pageKey, record, nodes });
    }
    for (const { page, pageKey, record, nodes } of plans) {
      for (let index = 0; index < nodes.length; index++) {
        nodes[index].style.fontSize = record.styles[index].fontSize;
        nodes[index].style.lineHeight = record.styles[index].lineHeight;
      }
      page.dataset.layoutFitKey = pageKey;
      restored.add(page);
    }
    return restored;
  }

  function restoreInjectedLayoutFitSnapshot(pages) {
    const key = layoutFitSnapshotKey();
    const snapshot = state.data?.layout?.fitSnapshot;
    if (snapshot?.version !== 11 || !Array.isArray(snapshot.pages)) return new Set();
    layoutFitSnapshots.set(key, snapshot);
    return applyLayoutFitSnapshot(pages, snapshot);
  }

  async function restoreLayoutFitSnapshot(pages) {
    const key = layoutFitSnapshotKey();
    let snapshot = layoutFitSnapshots.get(key);
    if (!snapshot) {
      const restoredInjected = restoreInjectedLayoutFitSnapshot(pages);
      if (restoredInjected.size) return restoredInjected;
      snapshot = layoutFitSnapshots.get(key);
    }
    if (!snapshot) {
      try { snapshot = await hostCall("load-layout-cache", { key }); }
      catch (_) { snapshot = null; }
      if (!snapshot) {
        try { snapshot = JSON.parse(localStorage.getItem(layoutFitStorageKey(key)) || "null"); }
        catch (_) { snapshot = null; }
      }
      if (snapshot?.version === 11 && Array.isArray(snapshot.pages)) layoutFitSnapshots.set(key, snapshot);
    }
    return applyLayoutFitSnapshot(pages, snapshot);
  }

  function saveLayoutFitSnapshot(pages) {
    const key = layoutFitSnapshotKey();
    const snapshot = {
      version: 11,
      pages: (pages || []).map(page => {
        const nodes = [...page.querySelectorAll(".layout-block, .layout-flow-stream")];
        return {
          key: layoutFitPageKey(page),
          styles: nodes.map(node => ({ fontSize: node.style.fontSize, lineHeight: node.style.lineHeight }))
        };
      })
    };
    layoutFitSnapshots.set(key, snapshot);
    try { localStorage.setItem(layoutFitStorageKey(key), JSON.stringify(snapshot)); } catch (_) {}
    hostCall("save-layout-cache", { key, data: snapshot }).catch(() => {});
    // Keep the in-memory cache bounded across documents opened in one window.
    while (layoutFitSnapshots.size > 12) layoutFitSnapshots.delete(layoutFitSnapshots.keys().next().value);
    for (const page of pages || []) page.dataset.layoutFitKey = layoutFitPageKey(page);
  }

  async function runLayoutFit(pages) {
    // A hidden pane reports a zero-sized page.  Fitting and snapshotting that
    // transient geometry made a source-only -> translation-only switch retain
    // a 0px/0.2-scale solution until another resize happened.
    const requested = (pages || []).filter(page => page?.isConnected);
    const documentRoots = new Set(requested.map(page => page.closest(".layout-document")).filter(Boolean));
    // A resize, cache miss or single-page request still needs a document-wide
    // body-font solution. Expand requests for one document before checking
    // page keys so no page acquires a private body-font result.
    const candidates = documentRoots.size === 1
      ? [...documentRoots.values().next().value.querySelectorAll(".layout-page")]
      : requested;
    for (const root of documentRoots) root.classList.add("layout-fit-measuring");
    const active = candidates.filter(page => {
      if (!page || !page.isConnected) return false;
      const rect = page.getBoundingClientRect();
      return page.clientWidth > 0 && page.clientHeight > 0 && rect.width > 0 && rect.height > 0;
    });
    if (!active.length) {
      for (const root of documentRoots) root.classList.remove("layout-fit-measuring");
      return;
    }

    // Measure in canonical source-page coordinates. CSS zoom then keeps CJK
    // glyph rasterization and baseline metrics stable in the visible reader.
    const transforms = active.map(page => page.style.transform);
    const zooms = active.map(page => page.style.zoom);
    try {
      if (typeof document !== "undefined" && document.fonts?.ready) {
        try { await document.fonts.ready; } catch (_) {}
      }
      // A whole paragraph may arrive as one `lines` item. Render it once in
      // canonical coordinates before using cached measurements; if its
      // single-line presentation escapes the page, convert it to a wrapped
      // block first because that changes the measured geometry.
      demoteFalseSingleLineText(active);
      let pending = active.filter(page => page.dataset.layoutFitKey !== layoutFitPageKey(page));
      if (pending.length) {
        const restored = await restoreLayoutFitSnapshot(active);
        // Full snapshot or full solve: document-wide groups must never combine
        // cached neighbouring pages with a newly fitted subset.
        pending = restored.size === active.length ? [] : active;
      }
      if (!pending.length) {
        // A restored snapshot already has fitted text styles, but equation
        // dimensions depend on the newly created KaTeX nodes. Re-converge
        // those cheaply in canonical coordinates without re-running text fit.
        fitLayoutFormulas(active, { expand: true });
        const codeFitChanged = clampTranslatedCodeOverflow();
        if (codeFitChanged) saveLayoutFitSnapshot(active);
        return;
      }
      // Any invalid page invalidates the shared document solution.
      fitLayoutPages(pending);
      applyLayoutBodyFont(pending);
      fitLayoutFormulas(pending, { expand: true });
      saveLayoutFitSnapshot(active);
    }
    finally {
      for (let index = 0; index < active.length; index++) {
        active[index].style.transform = transforms[index];
        active[index].style.zoom = zooms[index];
      }
      for (const root of documentRoots) root.classList.remove("layout-fit-measuring");
    }
  }

  // The initial paint and ResizeObserver can both request a fit in one frame.
  // Coalescing keeps an uncached document to one measurement pass and lets a
  // restored snapshot skip the duplicate work entirely.
  const MAX_CONSECUTIVE_LAYOUT_FIT_PASSES = 2;
  const queuedLayoutFitPages = new Set();
  let layoutFitRun = null;
  function ensureLayoutFit(pages) {
    for (const page of pages || []) {
      if (page?.isConnected) queuedLayoutFitPages.add(page);
    }
    if (layoutFitRun) return layoutFitRun;
    layoutFitRun = (async () => {
      let fittedTranslation = false;
      let passCount = 0;
      // A page-size observer can fire while the fitter is writing zoom and
      // height styles. Never let that feedback keep the Zotero UI thread in
      // one unbroken all-document solve. A later turn can safely reconcile
      // any genuinely newer geometry after the host has processed input.
      while (queuedLayoutFitPages.size && passCount < MAX_CONSECUTIVE_LAYOUT_FIT_PASSES) {
        const batch = [...queuedLayoutFitPages];
        queuedLayoutFitPages.clear();
        fittedTranslation ||= batch.some(page => Boolean(page?.closest?.("#translation-layout")));
        await runLayoutFit(batch);
        passCount += 1;
      }
      if (queuedLayoutFitPages.size) {
        const deferred = [...queuedLayoutFitPages];
        queuedLayoutFitPages.clear();
        setTimeout(() => {
          void ensureLayoutFit(deferred);
        }, 0);
      }
      // Keep the control synchronized with refits triggered after reveal.
      if (fittedTranslation) reflectAutomaticLayoutFont(els["translation-layout"]);
    })().finally(() => { layoutFitRun = null; });
    return layoutFitRun;
  }

  function nextLayoutPaint() {
    return new Promise(resolve => requestAnimationFrame(resolve));
  }

  function queueLayoutPageScaleRefresh(container) {
    // A completed layout can be published while Gecko is still applying the
    // conversation sidebar's width. ResizeObserver normally catches that
    // later, but an unchanged final size has no second notification. Re-read
    // existing page wrappers after two settled paints; this only reapplies
    // their visual scale and deliberately does not rerun text fitting.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (state.mode !== "layout" || !container?.isConnected || container.hidden) return;
      for (const page of container.querySelectorAll(".layout-page")) {
        page._litmtransRefreshLayoutScale?.(false);
      }
    }));
  }

  async function waitForLayoutFitToSettle(pageNodes) {
    // Building a pane registers its ResizeObservers in a frame, then those
    // observers queue their first fit in the following frame.  Revealing the
    // page after only a direct `ensureLayoutFit()` therefore exposes a
    // transient, pre-scale layout on slower hosts.  Let that observer turn
    // happen, drain its work, then require one quiet paint/fit cycle before
    // lifting the mask.
    await nextLayoutPaint();
    await nextLayoutPaint();
    const visiblePages = (pageNodes || []).filter(page => {
      if (!page?.isConnected || page.closest("[hidden]")) return false;
      const rect = page.getBoundingClientRect();
      return page.clientWidth > 0 && page.clientHeight > 0 && rect.width > 0 && rect.height > 0;
    });
    // Translation can finish while the reader is in stream mode or while the
    // live-preview pane is being replaced. A zero-sized/hidden page cannot be
    // measured. Keep the pending mask; renderMode() resumes this same atomic
    // settle operation when the pane becomes visible.
    if (!visiblePages.length) return false;
    await ensureLayoutFit(pageNodes);
    await nextLayoutPaint();
    await ensureLayoutFit(pageNodes);
    return true;
  }

  function scheduleLayoutPaneSettle(container, scroll, renderVersion, position = null) {
    if (!container?.isConnected) return Promise.resolve(false);
    const version = String(renderVersion || container.dataset.layoutRenderVersion || "0");
    if (container._litmtransSettlePromise && container._litmtransSettleVersion === version) {
      return container._litmtransSettlePromise;
    }
    const task = (async () => {
      const pageNodes = [...container.querySelectorAll(".layout-page")];
      const fitted = await waitForLayoutFitToSettle(pageNodes);
      if (!fitted || container.dataset.layoutRenderVersion !== version) return false;
      reflectAutomaticLayoutFont(container);
      if (position) restoreLayoutScrollPosition(scroll, position);
      container.classList.remove("layout-fit-pending");
      queueLayoutPageScaleRefresh(container);
      // A completed translation can become visible after its final event was
      // received. This is the first safe point for deferred PDF attachments.
      if (container === els["translation-layout"] && state.data?.layout?.meta?.complete) {
        queueLayoutPDFAttachmentsAfterFinalPublication();
      }
      return true;
    })().finally(() => {
      if (container._litmtransSettlePromise === task) {
        container._litmtransSettlePromise = null;
        container._litmtransSettleVersion = "";
      }
    });
    container._litmtransSettleVersion = version;
    container._litmtransSettlePromise = task;
    return task;
  }

  function applyLayoutPageRenderScale(pageNode, scale) {
    // `transform: scale()` resamples already-rasterized glyphs and produces
    // visibly uneven text sharpness between layout blocks at fractional scales.
    // Modern Zotero/Firefox supports CSS zoom, which lays out and rasterizes
    // glyphs at their final size. Keep the transform path only for old hosts.
    const supportsZoom = typeof CSS !== "undefined" && typeof CSS.supports === "function"
      && CSS.supports("zoom", "1");
    if (supportsZoom) {
      pageNode.style.transform = "none";
      pageNode.style.zoom = String(scale);
      pageNode.dataset.renderScaleMode = "zoom";
      return;
    }
    pageNode.style.zoom = "1";
    pageNode.style.transform = `scale(${scale})`;
    pageNode.dataset.renderScaleMode = "transform-fallback";
  }

  function layoutTranslationPageState(page, useTranslation) {
    const blocks = Array.isArray(page?.blocks) ? page.blocks : [];
    const hasTranslatableBlocks = blocks.some(block => Boolean(block?.translatable));
    const hasPageTranslation = blocks.some(block => Boolean(block?.translatable && block?.translatedText));
    // Reference-only and media-only pages have no requested translation IDs.
    // Keep rendering their source representation in the translation pane;
    // otherwise a complete bibliography becomes an unexplained blank page.
    const showAwaitingOverlay = Boolean(useTranslation && hasTranslatableBlocks && !hasPageTranslation);
    return { showAwaitingOverlay };
  }

  function fitLayoutText(pageNode) {
    const documentRoot = pageNode.closest(".layout-document");
    fitLayoutPages(documentRoot ? [...documentRoot.querySelectorAll(".layout-page")] : [pageNode]);
  }

  function buildLayoutDocument(model, useTranslation) {
    const root = document.createDocumentFragment();
    const observers = [];
    for (const page of model?.pages || []) {

      // scales the completed page for the reader viewport.  Keeping 920px as
      // a composition width changed glyph hinting, line breaks and every
      // fixed collision tolerance.  The wrapper may still display at up to
      // 920px, but the layout page itself remains in source coordinates.
      const canonicalWidth = Math.max(1, Number(page.width) || 1);
      const wrap = document.createElement("section");
      wrap.className = "layout-page-wrap";
      wrap.dataset.page = String(page.index);
      wrap.dataset.canonicalWidth = String(canonicalWidth);
      wrap.dataset.sourceWidth = String(page.width);
      wrap.dataset.sourceHeight = String(page.height);
      wrap.style.setProperty("--layout-canonical-width", `${canonicalWidth}px`);
      const pageNode = document.createElement("div");
      pageNode.className = "layout-page";
      pageNode.style.width = `${canonicalWidth}px`;
      pageNode.style.aspectRatio = `${page.width} / ${page.height}`;
      pageNode.style.setProperty("--layout-scale", "1");
      pageNode.dataset.sourceWidth = String(page.width);
      pageNode.dataset.sourceHeight = String(page.height);
      const { showAwaitingOverlay } = layoutTranslationPageState(page, useTranslation);
      const restoration = page.restoration;
      // An untranslated page must remain a clean placeholder. Rendering the
      // source blocks with translation coordinates produces an unreadable
      // pile-up while a layout job has not started yet. Once a page has at
      // least one translated block, the normal source fallback behavior is
      // retained for individual blocks that still need retry/fallback.
      if (!showAwaitingOverlay) {
        if (restoration?.streams?.length || restoration?.absoluteBlocks?.length) {
          for (const stream of restoration.streams || []) {
            pageNode.appendChild(buildFlowStreamNode(stream, page, useTranslation));
          }
          for (const block of restoration.absoluteBlocks || []) {
            pageNode.appendChild(buildAbsoluteLayoutNode(block, page, useTranslation));
          }
        }
        else {
          for (const block of page.blocks || []) {
            pageNode.appendChild(buildAbsoluteLayoutNode(block, page, useTranslation));
          }
        }
      }
      if (showAwaitingOverlay) {
        const overlay = document.createElement("div");
        overlay.className = "layout-awaiting-overlay";
        overlay.innerHTML = "<strong>尚无排版译文</strong><span>切换到排版阅读后点击“翻译”，即可生成与原页布局对应的译文。</span>";
        pageNode.appendChild(overlay);
      }
      wrap.append(pageNode);
      root.appendChild(wrap);
      observers.push(pageNode);
    }
    requestAnimationFrame(() => {
      let fitQueued = false;
      let fitInProgress = false;
      const scheduleFit = () => {
        if (fitQueued || fitInProgress) {
          if (fitInProgress) fitQueued = true;
          return;
        }
        fitQueued = true;
        requestAnimationFrame(async () => {
          fitQueued = false;
          fitInProgress = true;
          await ensureLayoutFit(observers);
          fitInProgress = false;
          for (const wrap of observers.map(node => node.closest(".layout-page-wrap"))) {
            if (wrap) wrap._litmtransInitialFitComplete = true;
          }
          if (fitQueued) scheduleFit();
        });
      };
      for (const pageNode of observers) {
        const wrap = pageNode.closest(".layout-page-wrap");
        const documentRoot = wrap?.closest(".layout-document");
        // Observe reader width, not wrapper styles written by update(), to
        // avoid a ResizeObserver feedback loop.
        const observerTarget = documentRoot || wrap;
        let observedWidth = Number(observerTarget?.clientWidth || 0);
        const update = () => {
          const canonical = Number(wrap?.dataset.canonicalWidth || pageNode.clientWidth || 1);
          const sourceWidth = Number(wrap?.dataset.sourceWidth || pageNode.dataset.sourceWidth || 1);
          const sourceHeight = Number(wrap?.dataset.sourceHeight || pageNode.dataset.sourceHeight || 1);
          // The wrapper's physical footprint must grow with a display-only
          // zoom. Otherwise the zoomed page paints beyond its old single-pane
          // box and gets clipped before the scroll container can expose it.
          // Measure the unzoomed reader width from the document root, rather
          // than the wrapper itself, so repeated ResizeObserver passes never
          // compound the selected zoom level.
          const availableWidth = Math.max(0, Number(documentRoot?.clientWidth || wrap?.clientWidth || 0) - 24);
          const renderedWidth = Math.min(920, availableWidth);
          // `display: none` is used for the inactive pane.  Its ResizeObserver
          // callback is expected, but it is not a valid layout measurement.
          // Do not write a fallback scale or cache a fit while that happens.
          if (renderedWidth <= 0) return;
          const viewZoom = pageNode.closest("#translation-layout") && state.readerView === "translation"
            ? state.layoutPageZoom
            : 1;
          const pageScale = renderedWidth / Math.max(1, canonical) * viewZoom;
          // Set an explicit visual footprint for both the layout-level zoom
          // path and the transform fallback, so page scrolling stays stable.
          if (wrap) {
            if (viewZoom === 1) {
              // Preserve the reader's regular dual-pane and 100% layout
              // rules. The single-pane footprint below is strictly a custom
              // display zoom, not a replacement for normal positioning.
              wrap.style.width = "";
              wrap.style.marginLeft = "";
              wrap.style.marginRight = "";
            }
            else {
              const scaledWidth = Math.max(1, renderedWidth * viewZoom);
              // Auto margins cannot center a width that was written by the
              // ResizeObserver consistently in Gecko's nested scroll layout.
              // Give a smaller page equal explicit side margins; once it grows
              // beyond the viewport, remove those margins so horizontal scroll
              // starts at the page's left edge rather than clipping it.
              const sideMargin = Math.max(0, (availableWidth - scaledWidth) / 2);
              wrap.style.width = `${scaledWidth}px`;
              wrap.style.marginLeft = `${sideMargin}px`;
              wrap.style.marginRight = `${sideMargin}px`;
            }
            wrap.style.height = `${Math.max(1, canonical * sourceHeight / Math.max(1, sourceWidth) * pageScale)}px`;
          }
          applyLayoutPageRenderScale(pageNode, pageScale);
        };
        // Kept on the page node so a known visibility/rail-width transition
        // can reapply this exact measurement without rebuilding its document.
        pageNode._litmtransRefreshLayoutScale = update;
        update();
        const observer = new ResizeObserver(() => {
          const width = Number(observerTarget?.clientWidth || 0);
          if (width <= 0 || Math.abs(width - observedWidth) < .5) return;
          observedWidth = width;
          update();
        });
        if (observerTarget) observer.observe(observerTarget);
        pageNode._litmtransResizeObserver = observer;
      }
      // All pages have their initial scale now. Queue exactly one cold fit;
      // subsequent ResizeObserver callbacks only rescale the rendered pages.
      scheduleFit();
    });
    return root;
  }

  function cleanupLayoutObservers(container) {
    try { container._litmtransImageMemoryManager?.disconnect(); } catch (_) {}
    container._litmtransImageMemoryManager = null;
    for (const page of container.querySelectorAll(".layout-page")) {
      try { page._litmtransResizeObserver?.disconnect(); } catch (_) {}
      page._litmtransRefreshLayoutScale = null;
    }
  }

  function installLayoutImageMemoryManager(container, scroll) {
    try { container._litmtransImageMemoryManager?.disconnect(); } catch (_) {}
    const images = [...container.querySelectorAll(".layout-block.layout-image img")];
    if (!images.length || typeof IntersectionObserver !== "function") return;
    const timers = new Set();
    const pageImages = new Map();
    let paused = false;
    for (const wrap of container.querySelectorAll(".layout-page-wrap")) {
      const rows = [...wrap.querySelectorAll(".layout-block.layout-image img")];
      if (!rows.length) continue;
      pageImages.set(wrap, rows);
      for (const image of rows) {
        const source = image.getAttribute("src");
        if (source) image.dataset.layoutImageSrc = source;
        image.loading = "lazy";
        image.decoding = "async";
      }
    }
    const cancelUnload = image => {
      if (!image._litmtransUnloadTimer) return;
      clearTimeout(image._litmtransUnloadTimer);
      timers.delete(image._litmtransUnloadTimer);
      image._litmtransUnloadTimer = null;
    };
    const observer = new IntersectionObserver(entries => {
      if (paused) return;
      for (const entry of entries) {
        const rows = pageImages.get(entry.target) || [];
        for (const image of rows) {
          cancelUnload(image);
          if (entry.isIntersecting) {
            const source = image.dataset.layoutImageSrc;
            if (source && !image.getAttribute("src")) image.setAttribute("src", source);
            image.classList.remove("layout-image-unloaded");
            continue;
          }
          const timer = setTimeout(() => {
            timers.delete(timer);
            image._litmtransUnloadTimer = null;
            if (!image.isConnected) return;
            const source = image.getAttribute("src");
            if (source) image.dataset.layoutImageSrc = source;
            image.removeAttribute("src");
            image.classList.add("layout-image-unloaded");
          }, 750);
          image._litmtransUnloadTimer = timer;
          timers.add(timer);
        }
      }
    }, {
      root: scroll || null,
      // Keep roughly one or two pages decoded on each side so ordinary
      // scrolling never waits for an image to be restored.
      rootMargin: "1800px 0px",
      threshold: 0
    });
    for (const wrap of pageImages.keys()) observer.observe(wrap);
    const restoreAll = () => {
      paused = true;
      observer.disconnect();
      for (const rows of pageImages.values()) {
        for (const image of rows) {
          cancelUnload(image);
          const source = image.dataset.layoutImageSrc;
          if (source && !image.getAttribute("src")) image.setAttribute("src", source);
          image.classList.remove("layout-image-unloaded");
          image.loading = "eager";
        }
      }
    };
    const waitForImages = async () => {
      const waits = images.map(image => {
        if (!image.getAttribute("src")) return Promise.resolve();
        if (image.complete) {
          return image.naturalWidth > 0 && typeof image.decode === "function"
            ? image.decode().catch(() => {})
            : Promise.resolve();
        }
        return new Promise(resolve => {
          const finish = () => {
            clearTimeout(timeout);
            image.removeEventListener("load", finish);
            image.removeEventListener("error", finish);
            resolve();
          };
          const timeout = setTimeout(finish, 10000);
          image.addEventListener("load", finish, { once: true });
          image.addEventListener("error", finish, { once: true });
        });
      });
      await Promise.all(waits);
    };
    container._litmtransImageMemoryManager = {
      async prepareForPrint() {
        restoreAll();
        await waitForImages();
      },
      restoreForPrintEvent() {
        // `beforeprint` is synchronous. Restore sources immediately; the
        // explicit PDF export path additionally awaits decoding above.
        restoreAll();
      },
      resume() {
        if (!paused) return;
        paused = false;
        for (const image of images) image.loading = "lazy";
        for (const wrap of pageImages.keys()) observer.observe(wrap);
      },
      disconnect() {
        paused = true;
        observer.disconnect();
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
      }
    };
  }

  function layoutImageMemoryManagers() {
    return ["source-layout", "translation-layout"]
      .map(id => els[id]?._litmtransImageMemoryManager)
      .filter(Boolean);
  }

  async function prepareLayoutImagesForPrint() {
    await Promise.all(layoutImageMemoryManagers().map(manager => manager.prepareForPrint()));
  }

  function restoreLayoutImagesForPrintEvent() {
    for (const manager of layoutImageMemoryManagers()) manager.restoreForPrintEvent();
  }

  function resumeLayoutImageMemoryManagement() {
    for (const manager of layoutImageMemoryManagers()) manager.resume();
  }

  function reflectAutomaticLayoutFont(container) {
    // An unmodified layout-font control reports the computed result of
    // automatic fitting, but does not turn that result into
    // a persisted override. Without this, the control still shows its 12 pt
    // placeholder and a user's first "decrease" can accidentally enlarge a
    // 7 pt fitted layout to 11 pt.
    if (state.mode !== "layout" || state.layoutFontPt > 0 || container !== els["translation-layout"]) return;
    const node = container.querySelector('.layout-flow-stream[data-style-kind="body_text"][data-flow-kind="text"]');
    if (!node) return;
    const px = Number.parseFloat(getComputedStyle(node).fontSize || "0");
    const fontPt = px > 0 ? px * 72 / 96 : 0;
    if (!Number.isFinite(fontPt) || fontPt <= 0) return;
    state.detectedLayoutFontPt = Math.round(fontPt * 10) / 10;
    els["reader-font-input"].value = String(state.detectedLayoutFontPt);
    document.documentElement.style.setProperty("--reader-font-size", `${state.detectedLayoutFontPt}pt`);
  }

  function renderLayoutPane(container, scroll, model, useTranslation) {
    // Layout translation arrives group by group. Rebuilding the positioned
    // page DOM without retaining the viewport made the reader jump back (or
    // appear to oscillate while both panes were synchronised).
    const position = captureLayoutScrollPosition(scroll);
    // Invalidate any in-flight settling task before deciding whether this
    // update has pages. A transition to an empty/hidden pane is a new render
    // too, so an older task must not restore its scroll state afterwards.
    const renderVersion = (Number(container.dataset.layoutRenderVersion || "0") || 0) + 1;
    container.dataset.layoutRenderVersion = String(renderVersion);
    if (!model?.pages?.length) {
      cleanupLayoutObservers(container);
      container.replaceChildren();
      container.hidden = true;
      container.classList.remove("layout-fit-pending");
      return;
    }
    // Compose first, then swap. If one malformed model response cannot be
    // rendered, the last stable page stays visible instead of becoming blank.
    const nextDocument = buildLayoutDocument(model, useTranslation);
    cleanupLayoutObservers(container);
    container.classList.add("layout-fit-pending");
    container.replaceChildren();
    container.hidden = false;
    container.appendChild(nextDocument);
    installLayoutImageMemoryManager(container, scroll);
    // KaTeX renders synchronously, but CSS layout, fonts, and ResizeObserver
    // work settle across several frames. Keep every page hidden until the
    // complete document has reached a quiet final fit.
    const pageNodes = [...container.querySelectorAll(".layout-page")];
    restoreInjectedLayoutFitSnapshot(pageNodes);
    requestAnimationFrame(() => {
      // A later model/state update may replace this pane while its old task is
      // awaiting fonts or visibility. The settle helper validates the render
      // version before it can reveal anything.
      void scheduleLayoutPaneSettle(container, scroll, renderVersion, position);
    });
  }

  function renderLayoutPanes() {
    const meta = state.data?.layout?.meta;
    const partial = meta?.complete === false && Object.keys(state.data?.layout?.translations || {}).length > 0;
    if (partial) return;
    const model = state.data?.layout?.model;
    renderLayoutPane(els["translation-layout"], els["translation-scroll"], model, true);
    if (!model?.pages?.length) {
      renderMode();
      return;
    }
    renderMode();
  }

  function layoutPageAtViewportAnchor(scroll, anchorRatio = .5) {
    if (!scroll) return null;
    const viewport = scroll.getBoundingClientRect();
    const focusY = viewport.top + scroll.clientHeight * anchorRatio;
    const wraps = [...scroll.querySelectorAll(".layout-page-wrap")];
    const wrap = wraps.find(node => {
      const page = node.querySelector(".layout-page") || node;
      const rect = page.getBoundingClientRect();
      return rect.top <= focusY && rect.bottom >= focusY;
    }) || wraps.reduce((closest, node) => {
      if (!closest) return node;
      const current = (node.querySelector(".layout-page") || node).getBoundingClientRect();
      const best = (closest.querySelector(".layout-page") || closest).getBoundingClientRect();
      return Math.abs((current.top + current.bottom) / 2 - focusY) < Math.abs((best.top + best.bottom) / 2 - focusY)
        ? node
        : closest;
    }, null);
    if (!wrap) return null;
    const page = wrap.querySelector(".layout-page") || wrap;
    const rect = page.getBoundingClientRect();
    return {
      page: Math.max(1, Number(wrap.dataset.page || 1)),
      pageRatio: Math.max(0, Math.min(1, (focusY - rect.top) / Math.max(1, rect.height))),
      anchorRatio
    };
  }

  function alignLayoutPagePosition(scroll, pageNumber, pageRatio = 0, anchorRatio = .35) {
    if (!scroll) return false;
    const wrap = [...scroll.querySelectorAll(".layout-page-wrap")]
      .find(node => Number(node.dataset.page || 0) === Number(pageNumber));
    const page = wrap?.querySelector(".layout-page") || wrap;
    if (!page) return false;
    const scrollRect = scroll.getBoundingClientRect();
    const rect = page.getBoundingClientRect();
    const range = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    const pageTop = scroll.scrollTop + rect.top - scrollRect.top;
    const top = pageTop + rect.height * Math.max(0, Math.min(1, Number(pageRatio || 0)))
      - scroll.clientHeight * Math.max(0, Math.min(1, Number(anchorRatio || 0)));
    scroll._litmtransProgrammaticUntil = performance.now() + 220;
    scroll.scrollTop = Math.max(0, Math.min(range, top));
    return true;
  }

  function captureLayoutScrollPosition(scroll) {
    if (!scroll || state.mode !== "layout") return null;
    const location = layoutPageAtViewportAnchor(scroll, .5);
    if (!location) return { ratio: scroll.scrollTop / Math.max(1, scroll.scrollHeight - scroll.clientHeight) };
    return {
      page: String(location.page),
      pageRatio: location.pageRatio,
      ratio: scroll.scrollTop / Math.max(1, scroll.scrollHeight - scroll.clientHeight)
    };
  }

  function restoreLayoutScrollPosition(scroll, position) {
    if (!scroll || !position || state.mode !== "layout") return;
    const range = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    const wrap = position.page
      ? [...scroll.querySelectorAll(".layout-page-wrap")].find(node => String(node.dataset.page || "") === position.page)
      : null;
    const page = wrap?.querySelector(".layout-page") || wrap;
    let top = Number(position.ratio || 0) * range;
    if (page) {
      const scrollRect = scroll.getBoundingClientRect();
      const rect = page.getBoundingClientRect();
      const pageTop = scroll.scrollTop + rect.top - scrollRect.top;
      top = pageTop + rect.height * Number(position.pageRatio || 0) - scroll.clientHeight * .5;
    }
    scroll._litmtransProgrammaticUntil = performance.now() + 140;
    scroll.scrollTop = Math.max(0, Math.min(range, top));
  }

  function renderMode() {
    const layout = state.mode === "layout";
    const documentID = String(state.data?.item?.documentID || "");
    const layoutFont = Number(state.layoutFontPt)
      || Number(state.detectedLayoutFontPt)
      || Number(state.settings?.layoutReaderFonts?.[documentID])
      || 0;
    const readerFont = layout ? layoutFont : (Number(state.settings?.readerFontPt) || 12);
    els["reader-font-input"].value = readerFont || "";
    document.documentElement.style.setProperty(
      "--reader-font-size",
      `${readerFont || Number(state.settings?.readerFontPt) || 12}pt`
    );
    const restoreLayout = layout;
    const hasLayout = Boolean(state.data?.layout?.model?.pages?.length);
    const hasParsedSource = Boolean(state.data?.parsed?.markdown);
    if (layout) ensureSourcePDF();
    const showPDF = layout && (sourcePDFLoading || sourcePDFAvailable);
    const showParsedSource = !layout && hasParsedSource;
    els["app"].dataset.view = state.mode;
    els["stream-mode-button"].classList.toggle("active", !layout);
    els["layout-mode-button"].classList.toggle("active", layout);
    // In layout mode this control changes body text only; titles, captions,
    // references, formulas and media retain their fitted styles.
    els["reader-font-input"].closest("label").hidden = false;
    if (els["debug-boxes-control"]) els["debug-boxes-control"].hidden = !layout;
    const showLayoutLivePreview = layout && hasLayoutLivePreview();
    els["translation-content"].hidden = showLayoutLivePreview
      ? false
      : (layout || !state.data?.translation?.markdown);
    els["translation-layout"].hidden = !(layout && hasLayout) || showLayoutLivePreview;
    if (layout && hasLayout && !showLayoutLivePreview && els["translation-layout"].classList.contains("layout-fit-pending")) {
      // A translation published while this pane was hidden deliberately kept
      // its pending mask. Becoming visible resumes the real document-wide
      // solve; never expose the model's provisional ~6pt body base.
      requestAnimationFrame(() => {
        void scheduleLayoutPaneSettle(
          els["translation-layout"],
          els["translation-scroll"],
          els["translation-layout"].dataset.layoutRenderVersion
        );
      });
    }
    els["source-placeholder"].hidden = showPDF || showParsedSource;
    els["source-pdf"].hidden = !showPDF;
    els["source-content"].hidden = !showParsedSource;
    // This DOM target is used only for PDF print layout. Stream reading uses
    // parsed Markdown, while layout reading uses Zotero Reader.
    els["source-layout"].hidden = true;
    if (!showPDF && !showParsedSource) {
      const title = els["source-placeholder"].querySelector("h2");
      const text = els["source-placeholder"].querySelector("p");
      if (layout) {
        title.textContent = sourcePDFLoading ? "正在加载PDF" : "无法显示原始PDF";
        text.textContent = sourcePDFLoading
          ? "原文将在Zotero PDF阅读器中显示。"
          : "请确认当前附件是PDF，并且可以在Zotero中正常打开。";
      }
      else {
        title.textContent = "尚未解析文档";
        text.textContent = "首次翻译前需要先解析正文、图片、公式、表格和页面结构。";
      }
    }
    renderReaderView();
    els["translation-placeholder"].hidden = layout || Boolean(state.data?.translation?.markdown);
  }

  function renderReaderView() {
    const view = ["source", "translation"].includes(state.readerView) ? state.readerView : "both";
    els["reader-split"].dataset.readerView = view;
    els["both-panes-button"].classList.toggle("active", view === "both");
    els["source-only-button"].classList.toggle("active", view === "source");
    els["translation-only-button"].classList.toggle("active", view === "translation");
    const singlePane = view !== "both";
    const layoutLocked = state.mode === "layout";
    els["sync-scroll-check"].checked = layoutLocked ? true : state.syncScroll;
    els["sync-scroll-check"].disabled = singlePane || layoutLocked;
    els["sync-scroll-check"].title = singlePane
      ? "单栏阅读时无需同步滚动"
      : (layoutLocked ? "排版模式按页面和块锚点固定同步" : "同步两侧阅读位置");
    // Grid visibility and ResizeObserver delivery happen in separate layout
    // phases in Zotero's embedded browser.  Waiting for the second frame keeps
    // a just-unhidden translation pane from being measured at its old width.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (view !== "source") {
        const pages = [...els["translation-layout"].querySelectorAll(".layout-page")];
        if (pages.length) ensureLayoutFit(pages);
      }
    }));
  }

  function changeTranslationLayoutPageZoom(delta, event) {
    if (state.mode !== "layout" || state.readerView !== "translation") return;
    const scroll = els["translation-scroll"];
    const rect = scroll.getBoundingClientRect();
    const viewportY = Math.max(0, Math.min(scroll.clientHeight, event.clientY - rect.top));
    const anchorRatio = (scroll.scrollTop + viewportY) / Math.max(1, scroll.scrollHeight);
    const factor = delta < 0 ? 1.12 : 1 / 1.12;
    state.layoutPageZoom = Math.max(.5, Math.min(3, state.layoutPageZoom * factor));
    refreshLayoutPageScales([...els["translation-layout"].querySelectorAll(".layout-page-wrap")]);
    requestAnimationFrame(() => {
      const top = anchorRatio * scroll.scrollHeight - viewportY;
      scroll.scrollTop = Math.max(0, Math.min(Math.max(0, scroll.scrollHeight - scroll.clientHeight), top));
    });
  }

  function renderChatSessions() {
    // Each Zotero attachment has one durable conversation, so refreshing the
    // workbench does not need a conversation picker.
  }

  const CHAT_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/jp2", "image/svg+xml"]);

  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result || "")), { once: true });
      reader.addEventListener("error", () => reject(reader.error || new Error("读取图片失败")), { once: true });
      reader.readAsDataURL(file);
    });
  }

  function dataURLByteLength(dataURL) {
    const encoded = String(dataURL || "").split(",", 2)[1]?.replace(/\s+/g, "") || "";
    if (!encoded) return 0;
    return Math.max(0, Math.floor(encoded.length * 3 / 4) - (encoded.endsWith("==") ? 2 : (encoded.endsWith("=") ? 1 : 0)));
  }

  function loadComposerImage(dataURL) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.addEventListener("load", () => resolve(image), { once: true });
      image.addEventListener("error", () => reject(new Error("无法解析剪贴板图片")), { once: true });
      image.src = dataURL;
    });
  }

  async function prepareComposerImage(file, mimeType, source) {
    const originalDataURL = await readFileAsDataURL(file);
    const prepared = {
      dataURL: originalDataURL,
      mimeType,
      size: Number(file?.size || dataURLByteLength(originalDataURL)),
      width: 0,
      height: 0,
      originalWidth: 0,
      originalHeight: 0,
      optimizedForVision: false
    };
    if (source !== "paste" || ["image/gif", "image/svg+xml"].includes(mimeType)) return prepared;
    try {
      const image = await loadComposerImage(originalDataURL);
      const width = Math.max(0, Number(image.naturalWidth || image.width || 0));
      const height = Math.max(0, Number(image.naturalHeight || image.height || 0));
      prepared.width = width;
      prepared.height = height;
      prepared.originalWidth = width;
      prepared.originalHeight = height;
      if (!width || !height) return prepared;
      const shortSide = Math.min(width, height);
      const longSide = Math.max(width, height);
      const scale = Math.min(6, 256 / Math.max(1, shortSide), 2048 / Math.max(1, longSide));
      if (!(scale > 1.05)) return prepared;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return prepared;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = false;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const dataURL = canvas.toDataURL("image/png");
      return {
        ...prepared,
        dataURL,
        mimeType: "image/png",
        size: dataURLByteLength(dataURL),
        width: canvas.width,
        height: canvas.height,
        optimizedForVision: true
      };
    }
    catch (_) {
      return prepared;
    }
  }

  function isImageFileCandidate(file) {
    const type = String(file?.type || "").toLowerCase();
    if (type.startsWith("image/")) return true;
    return /\.(?:png|jpe?g|webp|gif|bmp|jp2|svg)$/i.test(String(file?.name || ""));
  }

  async function imageDescriptorDataURL(image) {
    if (/^data:image\//i.test(String(image?.dataURL || ""))) return String(image.dataURL);
    const url = String(image?.url || "");
    if (!url) throw new Error("图片资源地址无效");
    const response = await fetch(url, { credentials: "omit", cache: "no-store" });
    if (!response.ok) throw new Error(`读取图片失败：HTTP ${response.status}`);
    const blob = await response.blob();
    return readFileAsDataURL(blob);
  }

  function applyPreviewScale(scale, anchor = null) {
    const image = els["image-preview-image"];
    const stage = image.closest(".image-preview-stage");
    const oldRect = image.getBoundingClientRect();
    const stageRect = stage?.getBoundingClientRect();
    const anchorX = anchor && oldRect.width
      ? Math.max(0, Math.min(1, (anchor.clientX - oldRect.left) / oldRect.width))
      : .5;
    const anchorY = anchor && oldRect.height
      ? Math.max(0, Math.min(1, (anchor.clientY - oldRect.top) / oldRect.height))
      : .5;
    const naturalWidth = Number(image.naturalWidth || 1);
    const naturalHeight = Number(image.naturalHeight || 1);
    state.previewScale = Math.max(.1, Math.min(8, Number(scale) || 1));
    image.style.width = `${Math.max(1, Math.round(naturalWidth * state.previewScale))}px`;
    image.style.height = `${Math.max(1, Math.round(naturalHeight * state.previewScale))}px`;
    els["image-preview-scale"].textContent = `${Math.round(state.previewScale * 100)}%`;
    if (anchor && stage && stageRect) {
      const nextRect = image.getBoundingClientRect();
      stage.scrollLeft += nextRect.left + nextRect.width * anchorX - anchor.clientX;
      stage.scrollTop += nextRect.top + nextRect.height * anchorY - anchor.clientY;
    }
  }

  function fitPreviewImage() {
    const image = els["image-preview-image"];
    const stage = image.closest(".image-preview-stage");
    if (!image.naturalWidth || !image.naturalHeight || !stage) return;
    const scale = Math.min(
      1,
      Math.max(.1, (stage.clientWidth - 34) / image.naturalWidth),
      Math.max(.1, (stage.clientHeight - 34) / image.naturalHeight)
    );
    applyPreviewScale(scale);
    stage.scrollLeft = 0;
    stage.scrollTop = 0;
  }

  function openImagePreview(image) {
    if (!image) return;
    state.previewImage = {
      name: String(image.name || "image.png"),
      mimeType: String(image.mimeType || "image/png"),
      size: Number(image.size || 0),
      url: String(image.dataURL || image.url || ""),
      dataURL: String(image.dataURL || ""),
      quote: normalizeReferenceQuote(image.quote)
    };
    els["image-preview-image"].src = state.previewImage.url;
    els["image-preview-image"].alt = state.previewImage.name;
    els["image-preview-dialog"].showModal();
  }

  async function addImageDescriptorToComposer(image) {
    if (!image) return;
    const dataURL = await imageDescriptorDataURL(image);
    const decodedSize = dataURLByteLength(dataURL);
    state.pendingImages.push({
      id: `reused-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      name: image.name || "reference-image.png",
      mimeType: image.mimeType || String(dataURL.match(/^data:([^;,]+)/i)?.[1] || "image/png"),
      size: decodedSize,
      dataURL,
      source: "reuse",
      originalName: String(image.originalName || image.name || ""),
      capturedAt: new Date().toISOString(),
      width: Number(image.width || 0),
      height: Number(image.height || 0),
      originalWidth: Number(image.originalWidth || image.width || 0),
      originalHeight: Number(image.originalHeight || image.height || 0),
      optimizedForVision: Boolean(image.optimizedForVision)
    });
    if (image.quote) appendReferenceQuote(image.quote);
    renderPendingImages();
    renderSelection();
    els["chat-input"].focus();
    if (!els["chat-input"].value.trim()) {
      els["chat-input"].value = "请分析这张图片，说明图中信息、它与正文的关系，以及可以得出的主要结论。";
    }
    toast("图片已添加到对话");
  }

  async function reusePreviewImage() {
    if (!state.previewImage) return;
    try {
      await addImageDescriptorToComposer(state.previewImage);
      els["image-preview-dialog"].close();
    }
    catch (error) {
      toast(error.message || "复用图片失败", "error");
    }
  }

  async function copyPreviewImage() {
    if (!state.previewImage) return;
    try {
      const dataURL = await imageDescriptorDataURL(state.previewImage);
      const response = await fetch(dataURL);
      const blob = await response.blob();
      if (navigator.clipboard?.write && typeof ClipboardItem === "function") {
        await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
      }
      else {
        await hostCall("copy-image", { dataURL });
      }
      toast("图片已复制");
    }
    catch (error) {
      try {
        const dataURL = await imageDescriptorDataURL(state.previewImage);
        await hostCall("copy-image", { dataURL });
        toast("图片已复制");
      }
      catch (fallbackError) {
        toast(fallbackError.message || error.message || "复制图片失败", "error");
      }
    }
  }

  async function savePreviewImage() {
    if (!state.previewImage) return;
    try {
      const dataURL = await imageDescriptorDataURL(state.previewImage);
      const result = await hostCall("save-image", {
        dataURL,
        name: state.previewImage.name || "generated_image.png"
      });
      if (!result?.cancelled) toast(`图片已保存：${result.path}`);
    }
    catch (error) {
      toast(error.message || "保存图片失败", "error");
    }
  }

  async function addImageFiles(files, options = {}) {
    const source = ["paste", "drop", "file"].includes(String(options.source || ""))
      ? String(options.source)
      : "file";
    const capturedAt = new Date();
    let accepted = 0;
    let optimized = 0;
    for (const file of Array.from(files || [])) {
      const extension = String(file?.name || "").toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || "";
      const mimeType = String(file?.type || "").toLowerCase() || ({
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
        ".jp2": "image/jp2", ".svg": "image/svg+xml"
      }[extension] || "");
      if (!CHAT_IMAGE_TYPES.has(mimeType)) {
        toast(`不支持的图片格式：${file?.name || mimeType || "未知"}`, "warning");
        continue;
      }
      try {
        const prepared = await prepareComposerImage(file, mimeType, source);
        accepted++;
        if (prepared.optimizedForVision) optimized++;
        const name = source === "paste"
          ? U.pastedImageName(capturedAt, accepted, prepared.mimeType)
          : String(file.name || `image-${accepted}${U.chatImageExtension(prepared.mimeType)}`);
        state.pendingImages.push({
          id: `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
          name,
          mimeType: prepared.mimeType,
          size: prepared.size,
          dataURL: prepared.dataURL,
          source,
          originalName: String(file.name || ""),
          capturedAt: capturedAt.toISOString(),
          width: prepared.width,
          height: prepared.height,
          originalWidth: prepared.originalWidth,
          originalHeight: prepared.originalHeight,
          optimizedForVision: prepared.optimizedForVision
        });
      }
      catch (error) {
        toast(error.message || "读取图片失败", "error");
      }
    }
    renderPendingImages();
    if (optimized) toast(`已放大 ${optimized} 张过小的剪贴板图片，便于模型识别。`);
  }

  function renderPendingImages() {
    const container = els["chat-image-preview"];
    container.replaceChildren();
    container.hidden = !state.pendingImages.length;
    for (const image of state.pendingImages) {
      const wrap = document.createElement("div");
      wrap.className = "pending-image";
      wrap.title = `${image.name} · ${Math.ceil(Number(image.size || 0) / 1024)} KB`;
      const img = document.createElement("img");
      img.src = image.dataURL;
      img.alt = image.name;
      img.addEventListener("click", () => openImagePreview(image));
      const name = document.createElement("span");
      name.className = "pending-image-name";
      name.textContent = image.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "pending-image-remove";
      remove.textContent = "×";
      remove.title = "移除图片";
      remove.addEventListener("click", event => {
        event.stopPropagation();
        state.pendingImages = state.pendingImages.filter(item => item.id !== image.id);
        renderPendingImages();
      });
      wrap.append(img, name, remove);
      container.appendChild(wrap);
    }
  }

  function renderPendingDocuments() {
    const container = els["chat-document-preview"];
    container.replaceChildren();
    container.hidden = !state.pendingDocuments.length;
    for (const documentRecord of state.pendingDocuments) {
      const row = document.createElement("div");
      row.className = "pending-document";
      const main = document.createElement("div");
      main.className = "pending-document-main";
      const name = document.createElement("strong");
      name.textContent = documentRecord.name || "未命名文档";
      const meta = document.createElement("small");
      meta.textContent = `${Number(documentRecord.charCount || 0).toLocaleString()} 字符${documentRecord.imageCount ? ` · ${documentRecord.imageCount} 图` : ""} · 本轮全文`;
      main.append(name, meta);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.title = "移除本轮文档";
      remove.addEventListener("click", () => {
        state.pendingDocuments = state.pendingDocuments.filter(item => item.id !== documentRecord.id);
        renderPendingDocuments();
      });
      row.append(main, remove);
      container.appendChild(row);
    }
    const currentSent = (state.currentSession?.messages || []).some(message => message?.role === "user" && message.currentDocument);
    const currentTitle = String(state.data?.item?.title || state.data?.item?.fileName || "当前文献");
    els["context-status"].textContent = state.running.has("document")
      ? "正在解析添加的文件，请等待解析完成后再发送…"
      : (
        state.pendingDocuments.length
          ? `本轮将额外发送 ${state.pendingDocuments.length} 个文件：${state.pendingDocuments.map(item => item.name || "未命名文档").join("；")}`
          : (
            currentSent
              ? (
                state.running.has("chat")
                  ? `当前文献全文及图片已随本轮发送，正在阅读：${currentTitle}`
                  : `当前文献全文及图片已附加，可以继续提问：${currentTitle}`
              )
              : `首次提问会自动附上当前文献全文及图片：${currentTitle}`
          )
      );
    els["remove-pending-documents-button"].disabled = !state.pendingDocuments.length;
  }

  function documentGallery(documents) {
    const rows = Array.isArray(documents) ? documents : [];
    if (!rows.length) return null;
    const gallery = document.createElement("div");
    gallery.className = "chat-documents";
    for (const documentRecord of rows) {
      const row = document.createElement(documentRecord.originalRelativePath ? "button" : "div");
      row.className = "chat-document-record";
      if (row.tagName === "BUTTON") {
        row.type = "button";
        row.title = "使用系统默认程序打开已发送的原始文档副本";
        row.addEventListener("click", async () => {
          try {
            await hostCall("chat-open-document", { relativePath: documentRecord.originalRelativePath });
          }
          catch (error) {
            toast(error.message || "无法打开原始文档", "error");
          }
        });
      }
      const main = document.createElement("div");
      main.className = "chat-document-record-main";
      const name = document.createElement("strong");
      name.textContent = documentRecord.name || "未命名文档";
      const meta = document.createElement("small");
      meta.textContent = `${Number(documentRecord.charCount || 0).toLocaleString()} 字符${documentRecord.imageCount ? ` · ${documentRecord.imageCount} 图` : ""} · 已随本轮发送`;
      main.append(name, meta);
      row.appendChild(main);
      gallery.appendChild(row);
    }
    return gallery;
  }

  function attachmentGallery(attachments) {
    const rows = (Array.isArray(attachments) ? attachments : []).filter(item => item?.url && /^(?:resource|data):/i.test(String(item.url)));
    if (!rows.length) return null;
    const gallery = document.createElement("div");
    gallery.className = "chat-attachments";
    for (const attachment of rows) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chat-attachment";
      button.title = attachment.name || "打开图片";
      const img = document.createElement("img");
      img.src = String(attachment.url);
      img.alt = String(attachment.name || "对话图片");
      const name = document.createElement("span");
      name.className = "chat-attachment-name";
      name.textContent = String(attachment.name || "图片");
      button.append(img, name);
      button.addEventListener("click", () => openImagePreview(attachment));
      button.addEventListener("contextmenu", event => {
        event.preventDefault();
        event.stopPropagation();
        const menu = document.createElement("div");
        menu.className = "layout-formula-menu";
        const addAction = (label, action) => {
          const item = document.createElement("button");
          item.type = "button";
          item.textContent = label;
          item.addEventListener("click", () => {
            menu.remove();
            action();
          });
          menu.appendChild(item);
        };
        addAction("在对话中提问", () => {
          void addImageDescriptorToComposer(attachment).catch(error => toast(error.message || "读取图片失败", "error"));
        });
        addAction("打开图片预览", () => openImagePreview(attachment));
        menu.style.left = `${Math.max(4, Math.min(window.innerWidth - 230, event.clientX))}px`;
        menu.style.top = `${Math.max(4, Math.min(window.innerHeight - 100, event.clientY))}px`;
        document.body.appendChild(menu);
        const dismiss = dismissEvent => {
          if (menu.contains(dismissEvent.target)) return;
          menu.remove();
          document.removeEventListener("pointerdown", dismiss, true);
        };
        setTimeout(() => document.addEventListener("pointerdown", dismiss, true), 0);
      });
      gallery.appendChild(button);
    }
    return gallery;
  }

  function legacyImageGallery(parts) {
    const images = (Array.isArray(parts) ? parts : [])
      .filter(part => part?.type === "image_url")
      .map(part => typeof part.image_url === "object" ? part.image_url?.url : part.image_url)
      .filter(url => /^data:image\//i.test(String(url || "")))
      .map((url, index) => ({ url: String(url), name: `历史图片 ${index + 1}` }));
    return attachmentGallery(images);
  }

  function citedImageGallery(citations) {
    const rows = (Array.isArray(citations) ? citations : []).filter(item =>
      item?.url && /^(?:resource|data):/i.test(String(item.url))
    );
    if (!rows.length) return null;
    const wrap = document.createElement("section");
    wrap.className = "chat-cited-image-wrap";
    const heading = document.createElement("div");
    heading.className = "chat-cited-image-heading";
    heading.textContent = `回答引用了 ${rows.length} 张论文图片`;
    const gallery = attachmentGallery(rows.map((item, index) => ({
      ...item,
      name: `${item.sourceDocumentName || "论文"} · ${item.alt || item.name || `图片 ${index + 1}`}`
    })));
    if (!gallery) return null;
    gallery.classList.add("chat-cited-images");
    wrap.append(heading, gallery);
    return wrap;
  }

  function imageCitationDisplayText(content, citations) {
    let output = String(content || "");
    (Array.isArray(citations) ? citations : []).forEach((citation, index) => {
      const marker = String(citation?.markdownRef || "");
      if (!marker) return;
      const label = String(citation.alt || citation.name || `图片 ${index + 1}`);
      output = output.split(marker).join(`〔引用图片 ${index + 1}：${label}〕`);
    });
    return output;
  }

  // Older sessions stored the whole document prompt as plain text. Keep the
  // raw value for copy/resend, but render a compact history summary so
  // reopening a session does not flood the chat viewport.
  function legacyDocumentDisplayText(content) {
    const text = Array.isArray(content)
      ? content.filter(part => part && ["text", "input_text"].includes(part.type)).map(part => String(part.text || "")).join("\n")
      : String(content || "");
    const stripped = text.trimStart();
    if (!stripped.startsWith("以下是用户添加的文档全文。请基于这些文档回答后续问题")) return null;
    const records = [...stripped.matchAll(/^===== 文档\s+\d+:\s*(.*?)\s*=====\s*\n来源:\s*([^\n]+)/gm)];
    if (!records.length) return null;
    const questionMarker = "===== 用户问题 =====";
    const question = stripped.includes(questionMarker)
      ? stripped.slice(stripped.lastIndexOf(questionMarker) + questionMarker.length).trim()
      : "请先阅读并概括这些文档。";
    const names = records.map(match => match[1].trim() || "未命名文档").join("；");
    return `已附加历史文档\n\n文档数量：${records.length}\n文档：${names}\n\n问题：\n${question || "请先阅读并概括这些文档。"}`;
  }

  function reasoningNode(message, streaming) {
    const reasoning = String(message.reasoning || "");
    if (!reasoning.trim() || !Boolean(state.settings?.chatShowReasoning ?? state.settings?.showReasoning)) return null;
    const details = document.createElement("details");
    details.className = `chat-reasoning${streaming ? " streaming" : ""}`;
    const messageID = String(message.id || "");
    details.open = streaming || state.expandedReasoningIDs.has(messageID);
    const summary = document.createElement("summary");
    summary.textContent = "思考过程";
    const content = document.createElement("pre");
    content.textContent = reasoning;
    details.append(summary, content);
    if (streaming) requestAnimationFrame(() => { content.scrollTop = content.scrollHeight; });
    details.addEventListener("toggle", () => {
      if (streaming || !messageID) return;
      if (details.open) state.expandedReasoningIDs.add(messageID);
      else state.expandedReasoningIDs.delete(messageID);
    });
    return details;
  }



  function messageNode(message, streaming = false, quoteStartIndex = 0) {
    const wrap = document.createElement("article");
    wrap.className = `chat-message ${message.role}`;
    wrap.dataset.messageID = message.id || "";
    if (streaming) wrap.dataset.streamingChat = "true";
    const actions = document.createElement("span");
    actions.className = "chat-message-actions";
    const addAction = (label, handler, title = label) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chat-message-action";
      button.textContent = label;
      button.title = title;
      button.disabled = streaming;
      button.addEventListener("click", handler);
      actions.appendChild(button);
    };
    addAction("复制", () => copyText(message.content || ""), "复制消息文本");
    if (!streaming) {
      const lines = String(message.content || "").split(/\r?\n/);
      if (lines.length > 15) {
        const expanded = state.expandedMessageIDs.has(message.id);
        addAction(expanded ? "折叠" : "展开", () => {
          if (expanded) state.expandedMessageIDs.delete(message.id);
          else state.expandedMessageIDs.add(message.id);
          renderChat();
        }, expanded ? "折叠为前 15 行" : "展开完整消息");
      }
      addAction("编辑", () => editChatMessage(message), message.role === "user" ? "编辑并重新生成该轮回答" : "编辑这条回答");
      if (message.role === "user") addAction("重发", () => resendChatMessage(message), "重新生成该轮回答");
      addAction("删除本轮", () => deleteChatTurn(message), "删除这条问题及其对应回答");
    }
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble${streaming ? " streaming-cursor" : ""}`;
    const messageQuotes = Array.isArray(message.referenceQuotes) ? message.referenceQuotes : [];
    if (messageQuotes.length) {
      const quoteList = document.createElement("div");
      quoteList.className = "chat-sent-quotes";
      messageQuotes.forEach((quote, index) => {
        quoteList.appendChild(referenceQuoteNode(quote, quoteStartIndex + index, false));
      });
      bubble.appendChild(quoteList);
    }
    if (message.role === "user" && String(message.formatInstruction || "").trim()) {
      const format = document.createElement("div");
      format.className = "chat-format-instruction";
      const taskLabels = { key_points: "要点提炼", paper_mindmap: "论文思维导图", paper_logic_flow: "论文思路流程", generic_mindmap: "思维导图", generic_flowchart: "流程图" };
      format.textContent = `本轮任务：${taskLabels[message.taskType] || "图形生成"}（结构由程序自动校验）`;
      bubble.appendChild(format);
    }
    const gallery = attachmentGallery(message.attachments);
    const legacyGallery = legacyImageGallery(message.legacyContentParts);
    const citedGallery = citedImageGallery(message.citedImages);
    const documents = documentGallery(message.documents);
    if (documents) bubble.appendChild(documents);
    if (gallery) bubble.appendChild(gallery);
    if (legacyGallery) bubble.appendChild(legacyGallery);
    const rawContent = String(message.content || "");
    const legacyDisplay = message.role === "user" ? legacyDocumentDisplayText(message.content) : null;
    const displaySource = legacyDisplay || rawContent;
    const contentLines = displaySource.split(/\r?\n/);
    let collapsed = !streaming && contentLines.length > 15 && !state.expandedMessageIDs.has(message.id);
    let displayContent = collapsed ? contentLines.slice(0, 15).join("\n") : displaySource;
    const reasoning = reasoningNode(message, streaming);
    // Completed replies use Markdown so headings, lists and TeX are preserved.
    // Live chunks remain plain text until completion to avoid reparsing on every
    // token. Saved preferences must not downgrade delimited TeX to raw text.
    const renderAssistantMarkdown = message.role === "assistant" && !streaming;
    const body = document.createElement(renderAssistantMarkdown ? "div" : "pre");
    // This document is XHTML, where tagName retains lowercase `div`.  Testing
    // against the HTML-only uppercase spelling silently sent every completed
    // assistant reply through the raw-text branch.
    // Parse diagram protocols from the complete response, not its preview.
    const flowchart = renderAssistantMarkdown ? Flowchart?.parseFlowchart?.(displaySource) : null;
    const mapV2 = !flowchart && renderAssistantMarkdown ? LitMTrans.MindmapV2?.parse?.(displaySource) : null;
    const map = !flowchart && !mapV2 && renderAssistantMarkdown ? Mindmap?.parseMarkdownMindmap?.(displaySource) : null;
    if ((flowchart && !flowchart.error) || (mapV2 && !mapV2.error) || map) {
      collapsed = false;
      displayContent = displaySource;
    }
    const askDiagramNode = node => {
      els["chat-input"].value = `请解释“${node.label}”${node.detail ? `：${node.detail}` : ""}在当前文献中的含义和证据。`;
      els["chat-input"].focus();
    };
    const saveDiagramImage = async image => {
      try {
        const result = await hostCall("save-image", { name: image.name || "图形.svg", dataURL: image.dataURL });
        if (!result?.cancelled) toast("图形已保存", "success");
      }
      catch (error) { toast(error.message || "保存图形失败", "error"); }
    };
    const resolveEvidence = evidence => hostCall("diagram-resolve-evidence", { evidence });
    const locateEvidence = resolved => void hostCall("reader-preview-jump", {
      page: resolved.page,
      highlightRects: resolved.highlightRects || [],
      highlightText: resolved.highlightText || ""
    }).catch(error => toast(error.message || "无法定位原文", "error"));
    if (flowchart && !flowchart.error) {
      body.className = "markdown-body chat-mindmap-body";
      Flowchart.renderFlowchart(body, flowchart, image => LitMTrans.DiagramViewer?.open?.({
        title: flowchart.title || "流程图",
        mode: "flowchart",
        diagram: flowchart,
        image,
        onAsk: askDiagramNode,
        onExport: saveDiagramImage,
        resolveEvidence,
        onLocate: locateEvidence
      }));
    }
    else if (mapV2 && !mapV2.error) {
      body.className = "markdown-body chat-mindmap-body";
      const image = LitMTrans.MindmapV2.imageForMap(mapV2);
      const open = document.createElement("button"); open.type = "button"; open.className = "chat-diagram-image"; open.title = "打开交互思维导图";
      const preview = document.createElement("img"); preview.src = image.dataURL; preview.alt = `思维导图：${mapV2.title}`;
      open.appendChild(preview); open.addEventListener("click", () => LitMTrans.DiagramViewer?.open?.({
        title: mapV2.title,
        mode: "mindmap",
        diagram: mapV2,
        onAsk: askDiagramNode,
        onExport: saveDiagramImage,
        resolveEvidence,
        onLocate: locateEvidence
      }));
      body.appendChild(open);
    }
    else if (map) {
      body.className = "markdown-body chat-mindmap-body";
      Mindmap.renderMindmap(body, map, openImagePreview);
    }
    else if (renderAssistantMarkdown) {
      body.className = "markdown-body";
      // Go through the XHTML-safe insertion path used by the reader.  This
      // avoids a malformed model fragment making an entire completed reply
      // fall back to literal Markdown in Zotero's XHTML browser surface.
      renderMarkdownInto(
        body,
        imageCitationDisplayText(displayContent, message.citedImages),
        { normalizeEscapedTeX: true, repairBareTeX: true }
      );
    }
    else {
      body.className = "chat-raw";
      body.textContent = displayContent;
    }
    bubble.appendChild(body);
    if (citedGallery) bubble.appendChild(citedGallery);
    if (collapsed) {
      const note = document.createElement("div");
      note.className = "chat-fold-note";
      note.textContent = "……（内容已折叠，点击“展开”查看全文）";
      bubble.appendChild(note);
      bubble.addEventListener("click", event => {
        if (event.target.closest("button, a")) return;
        state.expandedMessageIDs.add(message.id);
        renderChat();
      });
    }
    // Keep message operations out of the reading line and at the bubble's
    // lower-left edge, where they do not compete with the content itself.
    bubble.appendChild(actions);
    if (reasoning) wrap.appendChild(reasoning);
    wrap.appendChild(bubble);
    return wrap;
  }

  function renderChat() {
    const container = els["chat-messages"];
    const shouldFollowLatest = state.chatFollowLatest || chatIsNearBottom(container);
    if (shouldFollowLatest) state.chatFollowLatest = true;
    container.replaceChildren();
    const messages = state.currentSession?.messages || [];
    const hasStreamingTurn = Boolean(state.streamingChatText || state.reasoning);
    if (!messages.length && !hasStreamingTurn) {
      const empty = document.createElement("div");
      empty.id = "chat-empty";
      empty.className = "chat-empty";
      empty.innerHTML = `<div class="empty-mark small">问</div><p>询问文献的方法、公式、结果和局限，也可以在阅读器中选中文字后发送到这里。</p>`;
      container.appendChild(empty);
    }
    else {
      let quoteOrdinal = 0;
      const streamNode = () => messageNode({
        id: state.streamingChatMessageID,
        role: "assistant",
        content: state.streamingChatText,
        reasoning: state.reasoning
      }, true, quoteOrdinal);
      for (let index = 0; index < messages.length; index++) {
        if (hasStreamingTurn && state.streamingChatInsertIndex === index) container.appendChild(streamNode());
        container.appendChild(messageNode(messages[index], false, quoteOrdinal));
        quoteOrdinal += Array.isArray(messages[index]?.referenceQuotes) ? messages[index].referenceQuotes.length : 0;
      }
      if (hasStreamingTurn && (state.streamingChatInsertIndex < 0 || state.streamingChatInsertIndex >= messages.length)) {
        container.appendChild(streamNode());
      }
    }
    if (shouldFollowLatest) requestAnimationFrame(() => {
      scrollChatToLatest();
      if (hasStreamingTurn) {
        for (const reasoning of container.querySelectorAll(".chat-reasoning.streaming pre")) {
          reasoning.scrollTop = reasoning.scrollHeight;
        }
      }
    });
    renderChatSessions();
    renderMessageNavigator();
  }

  // During streaming, update only the transient bubble. Re-render the complete
  // history once on chat-complete.
  function chatIsNearBottom(container = els["chat-messages"]) {
    return !container || container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  }

  function scrollChatToLatest() {
    if (!state.chatFollowLatest) return;
    const container = els["chat-messages"];
    container.scrollTop = container.scrollHeight;
  }

  function updateStreamingChatDOM() {
    const container = els["chat-messages"];
    const stream = container.querySelector('[data-streaming-chat="true"]');
    if (!stream) {
      renderChat();
      return;
    }
    const output = stream.querySelector(".chat-raw");
    if (!output) {
      renderChat();
      return;
    }
    output.textContent = state.streamingChatText;
    const reasoning = stream.querySelector(".chat-reasoning.streaming pre");
    if (state.reasoning && !reasoning) {
      // The first reasoning fragment needs its disclosure element created.
      renderChat();
      return;
    }
    if (reasoning) reasoning.textContent = state.reasoning;
    requestAnimationFrame(() => {
      scrollChatToLatest();
      if (reasoning) reasoning.scrollTop = reasoning.scrollHeight;
    });
  }

  function messageNavigatorSummary(message) {
    const text = String(message?.content || "").replace(/\s+/g, " ").trim();
    if (!text) return "（图片或附件消息）";
    const end = text.search(/[。！？!?\n]/);
    const summary = end >= 0 ? text.slice(0, end + 1) : text;
    return summary.length <= 48 ? summary : `${summary.slice(0, 47).trim()}…`;
  }

  function renderMessageNavigator() {
    const popup = els["chat-navigator-popup"];
    if (!popup) return;
    popup.replaceChildren();
    const messages = (state.currentSession?.messages || []).filter(message => message?.role === "user");
    els["chat-navigator-button"].disabled = !messages.length;
    if (!messages.length) {
      popup.hidden = true;
      return;
    }
    const heading = document.createElement("div");
    heading.className = "chat-navigator-heading";
    heading.textContent = "已发送的问题";
    popup.appendChild(heading);
    messages.forEach((message, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chat-navigator-entry";
      button.textContent = `${index + 1}. ${messageNavigatorSummary(message)}`;
      button.title = messageNavigatorSummary(message);
      button.addEventListener("click", () => {
        const target = els["chat-messages"].querySelector(`[data-message-id="${CSS.escape(String(message.id || ""))}"]`);
        popup.hidden = true;
        target?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      popup.appendChild(button);
    });
  }

  function renderSystemMessages() {
    const list = els["system-messages-list"];
    list.replaceChildren();
    if (!state.systemMessages.length) {
      const empty = document.createElement("p");
      empty.className = "system-message-empty";
      empty.textContent = "暂无消息。";
      list.appendChild(empty);
      return;
    }
    for (const item of state.systemMessages) {
      const row = document.createElement("div");
      const kind = ["success", "warning", "error"].includes(item.kind) ? item.kind : "info";
      row.className = `system-message-row ${kind}`;
      const time = document.createElement("time");
      time.textContent = item.time;
      const badge = document.createElement("span");
      badge.className = "system-message-kind";
      badge.textContent = ({ success: "完成", warning: "提醒", error: "错误", info: "信息" })[kind];
      const text = document.createElement("span");
      text.className = "system-message-text";
      text.textContent = item.text;
      row.append(time, badge, text);
      list.appendChild(row);
    }
    requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }

  async function showPersistentTranslationLogs() {
    try {
      const entries = await hostCall("translation-logs", { limit: 300 });
      const visibleTypes = new Set(["started", "completed", "warning", "error"]);
      const rows = (Array.isArray(entries) ? entries : []).filter(entry => visibleTypes.has(String(entry.type || ""))).map(entry => {
        const at = new Date(entry.at || Date.now());
        const time = Number.isNaN(at.getTime()) ? "" : at.toLocaleString();
        const type = String(entry.type || "");
        const kind = type === "completed" ? "success" : type === "error" ? "error" : type === "warning" ? "warning" : "info";
        return { at: at.getTime() || 0, time, kind, text: normalizeUserMessage(entry.text) };
      });
      // Keep warnings generated in the still-open page alongside the
      // persisted history; only the latter survives a tab reload.
      const merged = [...rows, ...state.systemMessages].sort((a, b) => a.at - b.at);
      state.systemMessages = merged.filter((item, index) => {
        const next = merged[index + 1];
        return !next || item.text !== next.text || item.kind !== next.kind || Math.abs(item.at - next.at) > 1000;
      }).slice(-300);
      renderTaskMessages();
      renderSystemMessages();
      els["system-messages-dialog"].showModal();
    }
    catch (error) { toast(`无法读取翻译日志：${error.message}`, "error"); }
  }

  function hasCurrentTranslationForExport(layout) {
    return layout
      ? Boolean(state.data?.layout?.model?.pages?.some(page =>
        (page.blocks || []).some(block => block.translatable && block.translatedText)
      ))
      : Boolean(state.data?.translation?.markdown);
  }

  function layoutPDFExportIdentity() {
    const layoutIdentity = String(state.data?.layout?.meta?.identity || state.data?.layout?.meta?.sourceFingerprint || "");
    return layoutIdentity ? `${layoutIdentity}:pdf-${LAYOUT_PDF_EXPORT_REVISION}` : "";
  }

  async function waitForLayoutPDFReady() {
    const container = els["translation-layout"];
    // Export is a consumer of the completed reader state, never a reason to
    // start another collision/size solve.  If a normal reader settle is
    // already running, wait for that exact promise; otherwise require its
    // completed result to still be visible and current.
    const pending = container?._litmtransSettlePromise;
    if (pending) await pending;
    if (!container || container.classList.contains("layout-fit-pending") || !container.querySelector(".layout-page")) return false;
    await nextLayoutPaint();
    return true;
  }

  function frozenPrintStyle(pages, paper) {
    const paperWidth = Math.max(1, Number(paper?.width || 1));
    const paperHeight = Math.max(1, Number(paper?.height || 1));
    // Firefox's silent print backend cannot reliably combine named @page
    // rules with `page:` on each child: it emits a blank continuation after
    // every named fragment. The native print settings set this same paper
    // size, so a single non-named page rule is both sufficient and stable.
    return `@page {size:${paperWidth}px ${paperHeight}px;margin:0}\n#litmtrans-layout-print-root{display:none}\n@media print {
      body[data-print-snapshot="layout"] > :not(#litmtrans-layout-print-root) { display:none !important; }
      #litmtrans-layout-print-root { display:block !important; margin:0; padding:0; }
      #litmtrans-layout-print-root .layout-print-page { position:relative; box-sizing:border-box; contain:layout paint; margin:0; overflow:hidden; break-inside:avoid; page-break-inside:avoid; break-after:page; page-break-after:always; }
      #litmtrans-layout-print-root .layout-print-page:last-child { break-after:auto; page-break-after:auto; }
      #litmtrans-layout-print-root .layout-page { zoom:1 !important; transform:none !important; box-shadow:none !important; }
    }`;
  }

  function clearFlowingTextForPrint(node) {
    // Inline KaTeX belongs to a flowing paragraph in the reader. Remove it
    // from that blanked clone and add one page-coordinate atom below; leaving
    // it in place creates a second, stale formula position beside frozen text.
    for (const formula of node.querySelectorAll(".layout-flow-stream .litmtrans-math, .layout-flow-stream .katex-display, .layout-flow-stream .katex, .layout-flow-stream mjx-container")) formula.remove();
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let text;
    while ((text = walker.nextNode())) textNodes.push(text);
    for (const item of textNodes) {
      if (item.parentElement?.closest(".layout-formula, .katex, svg, canvas")) continue;
      item.textContent = "";
    }
  }

  function copyFrozenTextStyle(target, source, scale) {
    const style = getComputedStyle(source);
    const sourcePx = value => {
      const number = Number.parseFloat(value || "");
      return Number.isFinite(number) ? `${number / Math.max(1, scale)}px` : value;
    };
    Object.assign(target.style, {
      position: "absolute", display: "block", whiteSpace: "pre", margin: "0", padding: "0",
      fontFamily: style.fontFamily, fontSize: sourcePx(style.fontSize), fontWeight: style.fontWeight,
      fontStyle: style.fontStyle, fontStretch: style.fontStretch, lineHeight: sourcePx(style.lineHeight),
      letterSpacing: sourcePx(style.letterSpacing), wordSpacing: sourcePx(style.wordSpacing),
      color: style.color, textDecoration: style.textDecoration, textTransform: style.textTransform,
      fontKerning: style.fontKerning, fontFeatureSettings: style.fontFeatureSettings, direction: style.direction
    });
  }

  function printTextSegments(value) {
    const text = String(value || "");
    if (!text) return [];
    const pieces = [];
    let start = 0;
    const wordSegments = typeof Intl?.Segmenter === "function"
      ? [...new Intl.Segmenter("und", { granularity: "word" }).segment(text)]
      : [{ segment: text, index: 0 }];
    for (const part of wordSegments) {
      const segment = String(part.segment || "");
      const hasHan = /\p{Script=Han}/u.test(segment);
      if (hasHan) {
        for (const glyph of [...segment]) {
          pieces.push({ start, end: start + glyph.length });
          start += glyph.length;
        }
      }
      else {
        pieces.push({ start, end: start + segment.length });
        start += segment.length;
      }
    }
    return pieces.filter(part => part.end > part.start);
  }

  function appendFrozenTextFragments(sourcePage, printPage) {
    const pageRect = sourcePage.getBoundingClientRect();
    const sourceWidth = Math.max(1, Number(sourcePage.dataset.sourceWidth || sourcePage.offsetWidth || 1));
    const screenScale = Math.max(.001, pageRect.width / sourceWidth);
    const coordinateScale = Math.max(.001, layoutPageCoordinateScale(sourcePage));
    const walker = document.createTreeWalker(sourcePage, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);
    const range = document.createRange();
    for (const textNode of textNodes) {
      const parent = textNode.parentElement;
      if (!parent || !textNode.textContent?.trim() || parent.closest(".layout-formula, .katex, svg, canvas, .layout-line-debug-box")) continue;
      for (const part of printTextSegments(textNode.textContent)) {
        range.setStart(textNode, part.start);
        range.setEnd(textNode, part.end);
        const rects = [...range.getClientRects()].filter(rect => rect.width > .05 && rect.height > .05);
        // A long Latin run that crosses a visual line is split only in this
        // exceptional case; ordinary words remain shaping runs.
        const segments = rects.length > 1
          ? [...textNode.textContent.slice(part.start, part.end)].map((glyph, index) => ({ start: part.start + index, end: part.start + index + glyph.length }))
          : [part];
        for (const segment of segments) {
          range.setStart(textNode, segment.start);
          range.setEnd(textNode, segment.end);
          for (const rect of [...range.getClientRects()].filter(item => item.width > .05 && item.height > .05)) {
            const link = parent.closest("a");
            const fragment = link ? document.createElement("a") : document.createElement("span");
            if (link?.href) fragment.href = link.href;
            fragment.textContent = textNode.textContent.slice(segment.start, segment.end);
            copyFrozenTextStyle(fragment, parent, coordinateScale);
            fragment.style.left = `${(rect.left - pageRect.left) / screenScale}px`;
            fragment.style.top = `${(rect.top - pageRect.top) / screenScale}px`;
            fragment.style.width = `${rect.width / screenScale}px`;
            fragment.style.height = `${rect.height / screenScale}px`;
            printPage.appendChild(fragment);
          }
        }
      }
    }
  }

  function appendFrozenKaTeXFragments(katexRoot, printPage, pageRect, screenScale, coordinateScale) {
    // KaTeX's outer box is not a paint snapshot. Its internal vlist and
    // baseline offsets are recomputed in Gecko's print context, which can move
    // the visible formula by an entire text line even when the outer box has
    // the correct page coordinates. Freeze the visible HTML glyph tree at the
    // same granularity as ordinary reader text instead.
    const svgNS = "http://www.w3.org/2000/svg";
    const pageWidth = Math.max(1, Number.parseFloat(printPage.style.width || "0") || printPage.offsetWidth || 1);
    const pageHeight = Math.max(1, Number.parseFloat(printPage.style.height || "0") || printPage.offsetHeight || 1);
    const layer = document.createElementNS(svgNS, "svg");
    layer.classList.add("layout-print-math-layer");
    layer.setAttribute("width", String(pageWidth));
    layer.setAttribute("height", String(pageHeight));
    layer.setAttribute("viewBox", `0 0 ${pageWidth} ${pageHeight}`);
    layer.setAttribute("aria-hidden", "true");
    Object.assign(layer.style, {
      position: "absolute", display: "block", left: "0", top: "0",
      width: `${pageWidth}px`, height: `${pageHeight}px`, overflow: "visible",
      pointerEvents: "none", zIndex: "5"
    });
    const sourcePx = value => {
      const number = Number.parseFloat(value || "");
      return Number.isFinite(number) ? `${number / Math.max(.001, coordinateScale)}px` : value;
    };
    const range = document.createRange();
    const walker = document.createTreeWalker(katexRoot, NodeFilter.SHOW_TEXT, {
      acceptNode(text) {
        if (!text.textContent) return NodeFilter.FILTER_REJECT;
        const parent = text.parentElement;
        if (!parent || parent.closest(".katex-mathml")) return NodeFilter.FILTER_REJECT;
        const style = getComputedStyle(parent);
        return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0"
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      }
    });
    let textNode;
    while ((textNode = walker.nextNode())) {
      const parent = textNode.parentElement;
      const marker = document.createElement("span");
      marker.setAttribute("aria-hidden", "true");
      marker.style.cssText = "display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline;";
      parent.insertBefore(marker, textNode);
      const baseline = marker.getBoundingClientRect().top;
      marker.remove();
      range.selectNodeContents(textNode);
      const rects = [...range.getClientRects()].filter(rect => rect.width > .02 && rect.height > .02);
      const style = getComputedStyle(parent);
      for (const rect of rects) {
        const glyph = document.createElementNS(svgNS, "text");
        glyph.classList.add("layout-print-math-glyph");
        glyph.textContent = textNode.textContent;
        glyph.setAttribute("x", String((rect.left - pageRect.left) / screenScale));
        glyph.setAttribute("y", String((baseline - pageRect.top) / screenScale));
        glyph.setAttribute("dominant-baseline", "alphabetic");
        glyph.setAttribute("textLength", String(rect.width / screenScale));
        glyph.setAttribute("lengthAdjust", "spacingAndGlyphs");
        glyph.setAttribute("fill", style.color);
        glyph.style.fontFamily = style.fontFamily;
        glyph.style.fontSize = sourcePx(style.fontSize);
        glyph.style.fontWeight = style.fontWeight;
        glyph.style.fontStyle = style.fontStyle;
        glyph.style.fontStretch = style.fontStretch;
        glyph.style.fontKerning = style.fontKerning;
        glyph.style.fontFeatureSettings = style.fontFeatureSettings;
        glyph.style.letterSpacing = sourcePx(style.letterSpacing);
        glyph.style.wordSpacing = sourcePx(style.wordSpacing);
        glyph.style.opacity = style.opacity;
        layer.appendChild(glyph);
      }
    }

    // Fraction/radical rules and stretchy delimiters may be SVGs or empty
    // bordered spans, so they have no text Range to freeze. Preserve those as
    // independent vector/paint fragments at their measured visual boxes.
    const graphics = [...katexRoot.querySelectorAll(
      "svg, .frac-line, .sqrt-line, .overline-line, .underline-line, .rule"
    )].filter(node => !node.parentElement?.closest(
      "svg, .frac-line, .sqrt-line, .overline-line, .underline-line, .rule"
    ));
    for (const graphic of graphics) {
      const rect = graphic.getBoundingClientRect();
      if (rect.width <= .02 || rect.height <= .02) continue;
      const style = getComputedStyle(graphic);
      const left = (rect.left - pageRect.left) / screenScale;
      const top = (rect.top - pageRect.top) / screenScale;
      const width = rect.width / screenScale;
      const height = rect.height / screenScale;
      if (graphic.localName === "svg") {
        const clone = graphic.cloneNode(true);
        clone.classList.add("layout-print-math-graphic");
        clone.setAttribute("x", String(left));
        clone.setAttribute("y", String(top));
        clone.setAttribute("width", String(rect.width / screenScale));
        clone.setAttribute("height", String(rect.height / screenScale));
        layer.appendChild(clone);
        continue;
      }
      const bottomWidth = Number.parseFloat(style.borderBottomWidth || "0") || 0;
      const topWidth = Number.parseFloat(style.borderTopWidth || "0") || 0;
      const rule = document.createElementNS(svgNS, "line");
      rule.classList.add("layout-print-math-graphic");
      rule.setAttribute("x1", String(left));
      rule.setAttribute("x2", String(left + width));
      rule.setAttribute("y1", String(top + (bottomWidth > 0 ? height - bottomWidth / (2 * screenScale) : topWidth / (2 * screenScale))));
      rule.setAttribute("y2", rule.getAttribute("y1"));
      rule.setAttribute("stroke", bottomWidth > 0 ? style.borderBottomColor : (topWidth > 0 ? style.borderTopColor : style.color));
      rule.setAttribute("stroke-width", String(Math.max(.35, Math.max(bottomWidth, topWidth) / screenScale)));
      layer.appendChild(rule);
    }
    if (layer.childNodes.length) printPage.appendChild(layer);
  }

  function appendFrozenInlineAtoms(sourcePage, printPage) {
    const pageRect = sourcePage.getBoundingClientRect();
    const sourceWidth = Math.max(1, Number(sourcePage.dataset.sourceWidth || sourcePage.offsetWidth || 1));
    const screenScale = Math.max(.001, pageRect.width / sourceWidth);
    const coordinateScale = Math.max(.001, layoutPageCoordinateScale(sourcePage));
    const candidates = [...sourcePage.querySelectorAll(".layout-flow-stream .litmtrans-math, .layout-flow-stream .katex-display, .layout-flow-stream .katex, .layout-flow-stream mjx-container")]
      // A display formula owns its inner .katex node.  Freezing only that
      // inner node loses the full-line centering and the right-side equation
      // tag, which is why display equations drifted left in exported PDFs.
      .filter(atom => !(atom.classList.contains("katex") && atom.closest(".katex-display, .litmtrans-math")));
    for (const atom of candidates) {
      if (candidates.some(other => other !== atom && other.contains(atom))) continue;
      const rect = atom.getBoundingClientRect();
      if (rect.width <= .05 || rect.height <= .05) continue;
      const katexRoot = atom.classList.contains("katex") ? atom : atom.querySelector(".katex");
      const isDisplayMath = atom.classList.contains("katex-display")
        || atom.classList.contains("litmtrans-math-display")
        || Boolean(atom.closest(".layout-formula"))
        || Boolean(katexRoot?.closest(".katex-display"));
      if (katexRoot && !isDisplayMath) {
        appendFrozenKaTeXFragments(katexRoot, printPage, pageRect, screenScale, coordinateScale);
        continue;
      }
      const clone = atom.cloneNode(true);
      const style = getComputedStyle(atom);
      // Display equations own full-line alignment and equation-number layout,
      // so retain their wrapper while fixing it to the measured page box.
      const sourceLeft = (rect.left - pageRect.left) / screenScale;
      const sourceTop = (rect.top - pageRect.top) / screenScale;
      clone.style.position = "absolute";
      clone.style.display = "inline-block";
      clone.style.left = `${sourceLeft}px`;
      clone.style.top = `${sourceTop}px`;
      clone.style.width = `${rect.width / screenScale}px`;
      clone.style.height = "auto";
      clone.style.margin = "0";
      clone.style.transform = style.transform;
      clone.style.fontSize = `${Number.parseFloat(style.fontSize || "0") / coordinateScale}px`;
      const lineHeight = Number.parseFloat(style.lineHeight || "");
      if (Number.isFinite(lineHeight) && lineHeight > 0) clone.style.lineHeight = `${lineHeight / coordinateScale}px`;
      clone.style.verticalAlign = style.verticalAlign;
      clone.style.zIndex = "5";
      printPage.appendChild(clone);
    }
  }

  async function withFrozenLayoutPrintRoot(callback) {
    if (!await waitForLayoutPDFReady()) throw new Error("排版尚未完成，无法生成固定文本PDF");
    const source = els["translation-layout"];
    const pages = [...source.querySelectorAll(".layout-page")];
    if (!pages.length) throw new Error("没有可导出的排版页面");
    if (document.fonts?.ready) await document.fonts.ready;
    if (document.fonts?.load) await document.fonts.load('400 16px "LitMTrans Source Han Serif"');
    if (document.fonts?.check && !document.fonts.check('400 16px "LitMTrans Source Han Serif"')) throw new Error("排版字体未加载，已停止PDF导出");
    await prepareLayoutImagesForPrint();
    const root = document.createElement("main");
    root.id = "litmtrans-layout-print-root";
    const style = document.createElement("style");
    style.id = "litmtrans-layout-print-style";
    const paper = pages.reduce((size, page) => ({
      width: Math.max(size.width, Math.max(1, Number(page.dataset.sourceWidth || page.offsetWidth || 1))),
      height: Math.max(size.height, Math.max(1, Number(page.dataset.sourceHeight || page.offsetHeight || 1)))
    }), { width: 1, height: 1 });
    style.textContent = frozenPrintStyle(pages, paper);
    document.head.appendChild(style);
    pages.forEach((page, index) => {
      const width = Math.max(1, Number(page.dataset.sourceWidth || page.offsetWidth || 1));
      const height = Math.max(1, Number(page.dataset.sourceHeight || page.offsetHeight || 1));
      const sheet = document.createElement("section");
      sheet.className = "layout-print-page";
      // Gecko can round a custom sheet a fraction of a CSS pixel short. The
      // page and its cloned paint root must use the *same* quantized height:
      // making only the outer sheet shorter turns every source page into a
      // one-pixel overflow continuation (16 pages became 32).
      const printedHeight = Math.max(1, height - 1);
      sheet.style.cssText = `width:${width}px;height:${printedHeight}px;`;
      const clone = page.cloneNode(true);
      clone.style.width = `${width}px`;
      clone.style.height = `${printedHeight}px`;
      clone.style.zoom = "1";
      clone.style.transform = "none";
      clearFlowingTextForPrint(clone);
      sheet.appendChild(clone);
      appendFrozenTextFragments(page, clone);
      appendFrozenInlineAtoms(page, clone);
      root.appendChild(sheet);
    });
    document.body.appendChild(root);
    document.body.dataset.printSnapshot = "layout";
    const pageSizes = pages.map(page => ({
      width: Math.max(1, Number(page.dataset.sourceWidth || page.offsetWidth || 1)),
      height: Math.max(1, Number(page.dataset.sourceHeight || page.offsetHeight || 1))
    }));
    try { return await callback(pages.length, paper, pageSizes); }
    finally {
      delete document.body.dataset.printSnapshot;
      root.remove();
      style.remove();
      resumeLayoutImageMemoryManagement();
    }
  }

  function layoutPaintPrintStyle(paper, printScale) {
    const paperWidth = Math.max(1, Number(paper?.width || 1));
    const paperHeight = Math.max(1, Number(paper?.height || 1));
    // Keep the complete reader DOM in source-PDF coordinates. A paint-only
    // transform converts those point-like coordinates to the browser's 96dpi
    // print canvas, while the native paper uses the same physical dimensions.
    return `@page {size:${paperWidth}px ${paperHeight}px;margin:0}\n#litmtrans-layout-paint-print-root{display:none}\n@media print {
      html, body { margin:0 !important; padding:0 !important; background:#fff !important; overflow:visible !important; }
      body[data-print-snapshot="layout-paint"] > :not(#litmtrans-layout-paint-print-root) { display:none !important; }
      #litmtrans-layout-paint-print-root { display:block !important; width:${paperWidth}px; margin:0; padding:0; }
      #litmtrans-layout-paint-print-root .layout-paint-print-page { position:relative; box-sizing:border-box; contain:layout paint; width:${paperWidth}px; margin:0; overflow:hidden; break-inside:avoid; page-break-inside:avoid; break-after:page; page-break-after:always; }
      #litmtrans-layout-paint-print-root .layout-paint-print-page:last-child { break-after:auto; page-break-after:auto; }
      #litmtrans-layout-paint-print-root .layout-page { zoom:1 !important; transform:scale(${printScale}) !important; transform-origin:top left !important; box-shadow:none !important; print-color-adjust:exact; }
      #litmtrans-layout-paint-print-root .layout-line-debug-box,
      #litmtrans-layout-paint-print-root .layout-collision-debug-layer,
      #litmtrans-layout-paint-print-root .layout-awaiting-overlay { display:none !important; }
    }`;
  }

  function copyLayoutCanvasPaint(sourcePage, printPage) {
    const sourceCanvases = [...sourcePage.querySelectorAll("canvas")];
    const printCanvases = [...printPage.querySelectorAll("canvas")];
    for (let index = 0; index < Math.min(sourceCanvases.length, printCanvases.length); index++) {
      const source = sourceCanvases[index];
      const target = printCanvases[index];
      try {
        target.width = source.width;
        target.height = source.height;
        target.getContext("2d")?.drawImage(source, 0, 0);
      }
      catch (_) {}
    }
  }

  async function withLayoutPaintPrintRoot(callback) {
    if (!await waitForLayoutPDFReady()) throw new Error("排版尚未完成，无法生成文本PDF");
    const source = els["translation-layout"];
    const renderVersion = String(source?.dataset.layoutRenderVersion || "");
    const pages = [...source.querySelectorAll(".layout-page")];
    if (!pages.length) throw new Error("没有可导出的排版页面");
    if (document.fonts?.ready) await document.fonts.ready;
    if (document.fonts?.load) await document.fonts.load('400 16px "LitMTrans Source Han Serif"');
    if (document.fonts?.check && !document.fonts.check('400 16px "LitMTrans Source Han Serif"')) throw new Error("排版字体未加载，已停止PDF导出");
    await prepareLayoutImagesForPrint();
    if (source.classList.contains("layout-fit-pending") || String(source.dataset.layoutRenderVersion || "") !== renderVersion) {
      resumeLayoutImageMemoryManagement();
      throw new Error("排版在PDF准备期间发生变化，请重试");
    }

    const printScale = 96 / 72;
    const pageSizes = pages.map(page => ({
      width: Math.max(1, Number(page.dataset.sourceWidth || page.offsetWidth || 1)),
      height: Math.max(1, Number(page.dataset.sourceHeight || page.offsetHeight || 1))
    }));
    const sourcePaper = pageSizes.reduce((size, page) => ({
      width: Math.max(size.width, page.width),
      height: Math.max(size.height, page.height)
    }), { width: 1, height: 1 });
    const printPaper = {
      width: sourcePaper.width * printScale,
      height: sourcePaper.height * printScale
    };
    const root = document.createElement("main");
    root.id = "litmtrans-layout-paint-print-root";
    const style = document.createElement("style");
    style.id = "litmtrans-layout-paint-print-style";
    style.textContent = layoutPaintPrintStyle(printPaper, printScale);
    document.head.appendChild(style);
    pages.forEach((page, index) => {
      const { width, height } = pageSizes[index];
      const sheet = document.createElement("section");
      sheet.className = "layout-paint-print-page";
      // Match the Python/Qt exporter: the physical page and paint scale agree,
      // while the containing sheet stays one CSS pixel short to absorb printer
      // quantization without producing a blank continuation page.
      sheet.style.height = `${Math.max(1, printPaper.height - 1)}px`;
      const clone = page.cloneNode(true);
      clone.style.width = `${width}px`;
      clone.style.height = `${height}px`;
      clone.style.zoom = "1";
      clone.style.transform = `scale(${printScale})`;
      clone.style.transformOrigin = "top left";
      clone.querySelectorAll(".layout-line-debug-box, .layout-collision-debug-layer, .layout-awaiting-overlay")
        .forEach(node => node.remove());
      copyLayoutCanvasPaint(page, clone);
      sheet.appendChild(clone);
      root.appendChild(sheet);
    });
    document.body.appendChild(root);
    document.body.dataset.printSnapshot = "layout-paint";
    await nextLayoutPaint();
    await nextLayoutPaint();
    try { return await callback(pages.length, printPaper); }
    finally {
      delete document.body.dataset.printSnapshot;
      root.remove();
      style.remove();
      resumeLayoutImageMemoryManagement();
    }
  }

  async function exportCurrentTranslationPDF() {
    const pane = "translation";
    const layout = state.mode === "layout";
    if (!hasCurrentTranslationForExport(layout)) {
      toast(layout ? "当前没有可导出的排版译文" : "当前没有可导出的流式译文", "warning");
      return;
    }
    let pageStyle = null;
    if (layout) {
      // The fixed print root supplies its own per-page paper sizes.
    }
    else {
      document.body.dataset.printPane = pane;
      document.body.dataset.printLayout = "false";
      pageStyle = document.createElement("style");
      pageStyle.id = "litmtrans-pdf-page-style";
      pageStyle.textContent = "@media print { @page { size: A4 portrait; margin: 20mm 18mm 20mm 22mm; } }";
      document.head.appendChild(pageStyle);
    }
    try {
      if (layout) {
        const result = await withLayoutPaintPrintRoot((expectedPages, layoutPaper) =>
          hostCall("export-pdf", { pane, layout: true, expectedPages, layoutPaper })
        );
        if (!result?.cancelled) {
          recordSystemMessage(`PDF已导出：${result.path}`);
          toast("PDF已导出");
        }
        return;
      }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const result = await hostCall("export-pdf", { pane, layout });
      if (!result?.cancelled) {
        recordSystemMessage(`PDF已导出：${result.path}`);
        toast("PDF已导出");
      }
    }
    catch (error) {
      toast(error.message, "error");
    }
    finally {
      if (!layout) {
        delete document.body.dataset.printPane;
        delete document.body.dataset.printLayout;
      }
      pageStyle?.remove();
    }
  }

  async function createLayoutPDFAttachmentsAfterTranslation() {
    if (!hasCurrentTranslationForExport(true)) return;
    // The final translation publication precedes the visual settle task by a
    // few paints. Await it before marking the background attachment export as
    // printable, so PDFs never preserve the temporary fitting mask.
    if (!await waitForLayoutPDFReady()) return null;
    // This command is only queued after the translation service has emitted
    // its final publication. It consumes the reader's existing fitted state
    // and deliberately never starts another visual-fit pass.
    const layoutIdentity = layoutPDFExportIdentity();
    if (!layoutIdentity) throw new Error("缺少已完成排版译文的版本标识");
    const targetLanguage = state.data?.layout?.meta?.targetLanguage || state.settings?.targetLanguage;
    return withLayoutPaintPrintRoot((expectedPages, layoutPaper) =>
        hostCall("create-layout-pdf-attachments", { layoutIdentity, targetLanguage, expectedPages, layoutPaper })
    );
  }

  function queueLayoutPDFAttachmentsAfterFinalPublication() {
    const model = state.data?.layout?.model;
    const layoutPDFIdentity = layoutPDFExportIdentity();
    if (!model?.pages?.length || !layoutPDFIdentity) return;
    // The complete publication event is the authoritative boundary: all
    // translations have been persisted and the final page model is available.
    // Do not rely only on the later bridge response, which can be lost if the
    // surrounding translation operation finishes while the page is repainting.
    if (state.data?.item?.layoutPDFIdentity === layoutPDFIdentity) return;
    const key = `${state.data?.item?.documentID || ""}:${layoutPDFIdentity}`;
    if (state.layoutPDFGenerationKey === key) return;
    state.layoutPDFGenerationKey = key;
    void (async () => {
      try {
        const attachments = await createLayoutPDFAttachmentsAfterTranslation();
        if (attachments) addLog(`已在文献条目下生成PDF附件：${attachments.translationTitle}、${attachments.comparisonTitle}`);
        else state.layoutPDFGenerationKey = "";
      }
      catch (error) {
        const message = `排版译文已完成，但PDF附件生成失败：${error.message || error}`;
        addLog(message, "error");
        toast(message, "warning");
      }
    })();
  }

  function chatContextPayload() {
    return {
      sessionID: state.currentSession?.id,
      contextMode: "source",
      selectedText: state.selectedText,
      referenceQuotes: state.referenceQuotes
    };
  }

  function hasParsedCurrentDocument() {
    return Boolean(state.data?.capabilities?.hasParsed || state.data?.parsed?.markdown);
  }

  async function confirmParseBeforeChatSend() {
    const dialog = els["chat-parse-before-send-dialog"];
    if (!dialog?.showModal) {
      return window.confirm("这篇文献尚未解析。解析完成后将自动发送当前问题。\n\n是否立即解析？");
    }
    return new Promise(resolve => {
      const onClose = () => {
        dialog.removeEventListener("close", onClose);
        resolve(dialog.returnValue === "parse");
      };
      dialog.addEventListener("close", onClose);
      dialog.showModal();
    });
  }

  async function ensureParsedBeforeChatSend() {
    if (hasParsedCurrentDocument()) return true;
    if (!await confirmParseBeforeChatSend()) return false;
    const parsed = await runAction("parse", {}, { success: "解析完成，正在发送问题…" });
    return Boolean(parsed && hasParsedCurrentDocument());
  }

  async function resendChatMessage(message) {
    if (state.running.has("chat") || message?.role !== "user") return;
    state.reasoning = "";
    state.streamingChatText = "";
    state.streamingChatInsertIndex = -1;
    try {
      const result = await hostCall("chat-resend", {
        ...chatContextPayload(),
        messageID: message.id
      });
      state.currentSession = result.session;
      await refreshChatSessions(false);
      renderChat();
    }
    catch (error) {
      if (!error.cancelled) toast(error.message, "error");
    }
  }

  async function editChatMessage(message) {
    if (state.running.has("chat")) return;
    const text = window.prompt(
      message.role === "user" ? "编辑问题（保存后会重新生成这一轮回答）" : "编辑回答",
      String(message.content || "")
    );
    if (text === null || !text.trim() || text.trim() === String(message.content || "").trim()) return;
    state.reasoning = "";
    state.streamingChatText = "";
    state.streamingChatInsertIndex = -1;
    try {
      const result = await hostCall("chat-edit-message", {
        ...chatContextPayload(),
        messageID: message.id,
        text
      });
      state.currentSession = result.session;
      await refreshChatSessions(false);
      renderChat();
    }
    catch (error) {
      if (!error.cancelled) toast(error.message, "error");
    }
  }

  async function deleteChatTurn(message) {
    if (state.running.has("chat")) return;
    if (!window.confirm("删除这一整轮对话（用户消息及其对应回答）？")) return;
    try {
      const result = await hostCall("chat-delete-turn", {
        sessionID: state.currentSession?.id,
        messageID: message.id
      });
      state.currentSession = result.session;
      await refreshChatSessions(false);
      renderChat();
    }
    catch (error) {
      toast(error.message, "error");
    }
  }

  function normalizeReferenceQuote(quote) {
    if (typeof quote === "string") quote = { type: "text", text: quote };
    if (!quote || typeof quote !== "object") return null;
    const text = String(quote.text || quote.formulaTex || quote.formula_tex || "").trim();
    if (!text) return null;
    const pageValue = Number(quote.page ?? quote.pageNumber ?? 0);
    return {
      type: ["formula", "image"].includes(String(quote.type || "").toLowerCase()) ? String(quote.type).toLowerCase() : "text",
      text,
      formulaTex: String(quote.formulaTex || quote.formula_tex || ""),
      pane: String(quote.pane || "") === "translation" ? "translation" : "source",
      readerMode: ["stream", "layout", "zotero-reader"].includes(String(quote.readerMode || quote.reader_mode || ""))
        ? String(quote.readerMode || quote.reader_mode)
        : "",
      origin: String(quote.origin || ""),
      page: Number.isFinite(pageValue) ? Math.max(0, pageValue) : 0,
      pageLabel: String(quote.pageLabel || quote.page_label || "").trim().slice(0, 40),
      blockID: String(quote.blockID || quote.blockId || quote.block_id || ""),
      imageSrc: String(quote.imageSrc || quote.image_src || ""),
      imageAlt: String(quote.imageAlt || quote.image_alt || "").trim().slice(0, 240),
      nativePageIndex: Number.isFinite(Number(quote.nativePageIndex ?? quote.native_page_index))
        ? Math.max(0, Math.trunc(Number(quote.nativePageIndex ?? quote.native_page_index)))
        : null,
      title: String(quote.title || ""),
      anchorRatio: Number.isFinite(Number(quote.anchorRatio ?? quote.anchor_ratio))
        ? Math.max(0, Math.min(1, Number(quote.anchorRatio ?? quote.anchor_ratio)))
        : null,
      anchorRect: quote.anchorRect || quote.anchor_rect || null,
      anchorPoint: quote.anchorPoint || quote.anchor_point || null,
      pdfReaderView: ["both", "source"].includes(String(quote.pdfReaderView || quote.pdf_reader_view || ""))
        ? String(quote.pdfReaderView || quote.pdf_reader_view)
        : "",
      pdfRects: (Array.isArray(quote.pdfRects || quote.pdf_rects) ? (quote.pdfRects || quote.pdf_rects) : [])
        .map(rect => ({ x: Number(rect?.x), y: Number(rect?.y), width: Number(rect?.width), height: Number(rect?.height) }))
        .filter(rect => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0)
        .map(rect => ({ x: Math.min(1, rect.x), y: Math.min(1, rect.y), width: Math.min(1, rect.width), height: Math.min(1, rect.height) })),
      pdfRawRects: (Array.isArray(quote.pdfRawRects || quote.pdf_raw_rects) ? (quote.pdfRawRects || quote.pdf_raw_rects) : [])
        .map(rect => Array.isArray(rect) ? rect.slice(0, 4).map(Number) : [])
        .filter(rect => rect.length === 4 && rect.every(Number.isFinite))
    };
  }

  function referenceQuoteIdentity(quote) {
    const item = normalizeReferenceQuote(quote);
    return item
      ? [item.type, item.origin, item.readerMode, item.pane, item.page, item.pageLabel, item.blockID, item.imageSrc, item.formulaTex || item.text].join("\u001f")
      : "";
  }

  function appendReferenceQuote(quote) {
    const item = normalizeReferenceQuote(quote);
    const identity = referenceQuoteIdentity(item);
    if (!item || !identity || state.referenceQuotes.some(row => referenceQuoteIdentity(row) === identity)) return false;
    state.referenceQuotes.push(item);
    return true;
  }

  function layoutFormulaTarget(target) {
    return target?.closest?.(".layout-formula-target, .layout-page .litmtrans-math, .markdown-body .katex, .markdown-body .litmtrans-math") || null;
  }

  function layoutFormulaTeX(target) {
    return String(
      target?.dataset?.formulaTex
      || target?.getAttribute?.("title")
      || target?.closest?.("[data-formula-tex]")?.dataset?.formulaTex
      || target?.querySelector?.('annotation[encoding="application/x-tex"]')?.textContent
      || ""
    ).trim();
  }

  function layoutFormulaQuote(target, event = null) {
    const tex = layoutFormulaTeX(target);
    if (!tex) return null;
    const page = target.closest(".layout-page-wrap");
    const block = target.closest("[data-block-id]");
    const pageRect = page?.querySelector(".layout-page")?.getBoundingClientRect() || page?.getBoundingClientRect();
    const formulaRect = target.getBoundingClientRect();
    const anchorRect = pageRect?.width && pageRect?.height ? {
      x: Math.max(0, Math.min(1, (formulaRect.left - pageRect.left) / pageRect.width)),
      y: Math.max(0, Math.min(1, (formulaRect.top - pageRect.top) / pageRect.height)),
      width: Math.max(.01, Math.min(1, formulaRect.width / pageRect.width)),
      height: Math.max(.01, Math.min(1, formulaRect.height / pageRect.height))
    } : null;
    const anchorPoint = event && anchorRect && formulaRect.width && formulaRect.height ? {
      x: Math.max(0, Math.min(1, anchorRect.x
        + Math.max(0, Math.min(1, (event.clientX - formulaRect.left) / formulaRect.width)) * anchorRect.width)),
      y: Math.max(0, Math.min(1, anchorRect.y
        + Math.max(0, Math.min(1, (event.clientY - formulaRect.top) / formulaRect.height)) * anchorRect.height))
    } : null;
    return {
      type: "formula",
      text: tex,
      formulaTex: tex,
      pane: target.closest("#translation-pane") ? "translation" : "source",
      readerMode: state.mode,
      origin: "workbench",
      page: Math.max(0, Number(page?.dataset?.page || 0)),
      pageLabel: String(page?.dataset?.page || ""),
      blockID: String(block?.dataset?.blockId || ""),
      title: "版面公式",
      anchorRatio: anchorRect?.y ?? null,
      anchorRect,
      anchorPoint
    };
  }

  function askLayoutFormula(target, event = null) {
    const quote = layoutFormulaQuote(target, event);
    if (!quote) return;
    if (appendReferenceQuote(quote)) {
      renderSelection();
      if (!els["chat-input"].value.trim()) {
        els["chat-input"].value = "请解释这个公式的含义、各符号的定义、它在文中的作用，以及必要的推导关系。";
      }
      els["chat-input"].focus();
      toast("公式已加入本轮引用");
    }
  }

  function applyFormulaPreviewTransform(scale = state.previewFormulaScale, anchor = null) {
    const stage = els["formula-preview-stage"];
    const viewport = els["formula-preview-viewport"];
    const previous = state.previewFormulaScale || 1;
    const next = Math.max(.2, Math.min(10, Number(scale) || 1));
    if (anchor && viewport) {
      const viewportRect = viewport.getBoundingClientRect();
      const localX = anchor.clientX - viewportRect.left - viewportRect.width / 2;
      const localY = anchor.clientY - viewportRect.top - viewportRect.height / 2;
      state.previewFormulaX -= (localX - state.previewFormulaX) * (next / previous - 1);
      state.previewFormulaY -= (localY - state.previewFormulaY) * (next / previous - 1);
    }
    state.previewFormulaScale = next;
    stage.style.transform = `translate(${state.previewFormulaX}px, ${state.previewFormulaY}px) scale(${next})`;
    els["formula-preview-scale"].textContent = `${Math.round(next * 100)}%`;
  }

  function fitFormulaPreview() {
    state.previewFormulaScale = 1;
    state.previewFormulaX = 0;
    state.previewFormulaY = 0;
    applyFormulaPreviewTransform(1);
  }

  function openLayoutFormulaViewer(target) {
    const tex = layoutFormulaTeX(target);
    if (!tex) return;
    const previewTex = formulaTeXWithoutTag(tex);
    const equation = splitTeXEquationTag(previewTex);
    state.previewFormulaTarget = target;
    state.previewFormulaTeX = previewTex;
    els["formula-preview-body"].innerHTML = Markdown.renderTeX(equation.body || previewTex, true);
    fitFormulaPreview();
    els["formula-preview-dialog"].showModal();
  }

  function readerPaneForTarget(target) {
    return target?.closest?.("#source-pane, #translation-pane") || null;
  }

  function readerSelectionQuote(pane, eventTarget) {
    const selection = window.getSelection?.();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!pane.contains(range.commonAncestorContainer)) return null;
    const text = String(selection.toString() || "").replace(/\s+/g, " ").trim();
    if (!text) return null;
    const paneName = pane.id === "translation-pane" ? "translation" : "source";
    const page = eventTarget?.closest?.(".layout-page-wrap");
    const block = eventTarget?.closest?.("[data-block-id]");
    const scroll = paneName === "source" ? els["source-scroll"] : els["translation-scroll"];
    const rect = range.getBoundingClientRect?.();
    const scrollRect = scroll?.getBoundingClientRect?.();
    const pageRect = page?.querySelector?.(".layout-page")?.getBoundingClientRect?.() || page?.getBoundingClientRect?.();
    const anchorRatio = rect && scrollRect && scroll?.scrollHeight
      ? Math.max(0, Math.min(1, (scroll.scrollTop + rect.top - scrollRect.top) / scroll.scrollHeight))
      : null;
    const anchorRect = rect && pageRect?.width && pageRect?.height ? {
      x: Math.max(0, Math.min(1, (rect.left - pageRect.left) / pageRect.width)),
      y: Math.max(0, Math.min(1, (rect.top - pageRect.top) / pageRect.height)),
      width: Math.max(.01, Math.min(1, rect.width / pageRect.width)),
      height: Math.max(.01, Math.min(1, rect.height / pageRect.height))
    } : null;
    return {
      type: "text",
      text,
      pane: paneName,
      readerMode: state.mode,
      origin: "workbench",
      page: Math.max(0, Number(page?.dataset?.page || 0)),
      blockID: String(block?.dataset?.blockId || ""),
      title: paneName === "translation" ? "译文选文" : "原文选文",
      anchorRatio,
      anchorRect
    };
  }

  function readerImageQuote(image, pane) {
    if (!image) return null;
    const page = image.closest?.(".layout-page-wrap");
    const block = image.closest?.("[data-block-id]");
    const pageRect = page?.querySelector?.(".layout-page")?.getBoundingClientRect?.() || page?.getBoundingClientRect?.();
    const imageRect = image.getBoundingClientRect?.();
    const anchorRect = imageRect && pageRect?.width && pageRect?.height ? {
      x: Math.max(0, Math.min(1, (imageRect.left - pageRect.left) / pageRect.width)),
      y: Math.max(0, Math.min(1, (imageRect.top - pageRect.top) / pageRect.height)),
      width: Math.max(.01, Math.min(1, imageRect.width / pageRect.width)),
      height: Math.max(.01, Math.min(1, imageRect.height / pageRect.height))
    } : null;
    const name = String(
      image.alt
      || image.title
      || block?.dataset?.blockId
      || "阅读区图片"
    ).trim();
    return {
      type: "image",
      text: `图片：${name}`,
      pane: pane.id === "translation-pane" ? "translation" : "source",
      readerMode: state.mode,
      origin: "workbench",
      page: Math.max(0, Number(page?.dataset?.page || 0)),
      pageLabel: String(page?.dataset?.page || ""),
      blockID: String(block?.dataset?.blockId || ""),
      imageSrc: String(image.getAttribute?.("src") || image.currentSrc || image.src || ""),
      imageAlt: name,
      title: name,
      anchorRatio: anchorRect?.y ?? null,
      anchorRect
    };
  }

  function scrollRatio(scroll) {
    return Number(scroll?.scrollTop || 0) / Math.max(1, Number(scroll?.scrollHeight || 0) - Number(scroll?.clientHeight || 0));
  }

  function captureModeScrollPosition(mode = state.mode) {
    state.modeScrollPositions[mode] = {
      sourceTop: Number(els["source-scroll"]?.scrollTop || 0),
      translationTop: Number(els["translation-scroll"]?.scrollTop || 0),
      sourceRatio: scrollRatio(els["source-scroll"]),
      translationRatio: scrollRatio(els["translation-scroll"]),
      page: Number(state.readerSyncPage || 0)
    };
  }

  function restoreModeScrollPosition(mode = state.mode) {
    const saved = state.modeScrollPositions[mode];
    if (!saved) return;
    const restore = (scroll, top, ratio) => {
      const range = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
      const target = Math.min(range, Math.max(0, Number.isFinite(Number(top)) ? Number(top) : Number(ratio || 0) * range));
      scroll._litmtransProgrammaticUntil = performance.now() + 160;
      scroll.scrollTop = target;
    };
    restore(els["source-scroll"], saved.sourceTop, saved.sourceRatio);
    restore(els["translation-scroll"], saved.translationTop, saved.translationRatio);
    if (mode === "layout" && saved.page > 0 && sourcePDFAvailable) {
      state.readerSyncUntil = performance.now() + 250;
      void hostCall("reader-preview-jump", { page: saved.page }).catch(() => {});
    }
  }

  function cleanReadingSnapshot() {
    const source = els["source-scroll"];
    const translation = els["translation-scroll"];
    const share = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--source-share")) || 50;
    const input = {
      active: true,
      mode: state.mode,
      readerView: state.readerView,
      swapped: state.swapped,
      sourceSharePercent: share,
      sourceScrollTop: source.scrollTop,
      translationScrollTop: translation.scrollTop,
      sourceScrollRatio: scrollRatio(source),
      translationScrollRatio: scrollRatio(translation),
      focusedElementID: String(document.activeElement?.id || ""),
      logDrawerOpen: !els["log-drawer"].hidden,
      chatRailVisible: true,
      enteredAt: Date.now()
    };
    return P.captureCleanReadingSnapshot ? P.captureCleanReadingSnapshot(input) : input;
  }

  function updateCleanReaderButton(active) {
    els["clean-reader-button"].textContent = "专注阅读";
    els["clean-reader-button"].title = active ? "对话侧栏已隐藏；按Esc退出专注阅读" : "隐藏对话侧栏";
    els["clean-reader-button"].setAttribute("aria-label", els["clean-reader-button"].title);
    els["clean-reader-button"].setAttribute("aria-pressed", active ? "true" : "false");
  }

  function enterCleanReader() {
    if (document.body.classList.contains("clean-reader-mode")) return;
    captureModeScrollPosition();
    state.cleanReadingSnapshot = cleanReadingSnapshot();
    document.body.classList.add("clean-reader-mode");
    updateCleanReaderButton(true);
    requestAnimationFrame(() => {
      restoreModeScrollPosition(state.mode);
      queueLayoutPageScaleRefresh(els["translation-layout"]);
    });
    els["source-scroll"]?.focus();
  }

  function exitCleanReader({ focusChat = false } = {}) {
    if (!document.body.classList.contains("clean-reader-mode")) return;
    const snapshot = state.cleanReadingSnapshot;
    document.body.classList.remove("clean-reader-mode");
    updateCleanReaderButton(false);
    if (snapshot) {
      state.mode = snapshot.mode === "layout" ? "layout" : "stream";
      state.readerView = ["source", "translation"].includes(snapshot.readerView) ? snapshot.readerView : "both";
      state.swapped = Boolean(snapshot.swapped);
      els["reader-split"].classList.toggle("swapped", state.swapped);
      document.documentElement.style.setProperty("--source-share", `${Math.max(22, Math.min(78, Number(snapshot.sourceSharePercent || 50)))}%`);
      els["log-drawer"].hidden = !snapshot.logDrawerOpen;
      state.modeScrollPositions[state.mode] = {
        sourceTop: Number(snapshot.sourceScrollTop || 0),
        translationTop: Number(snapshot.translationScrollTop || 0),
        sourceRatio: Number(snapshot.sourceScrollRatio || 0),
        translationRatio: Number(snapshot.translationScrollRatio || 0),
        page: Number(state.readerSyncPage || 0)
      };
      state.cleanReadingSnapshot = P.exitCleanReadingSnapshot ? P.exitCleanReadingSnapshot(snapshot) : { ...snapshot, active: false };
      renderMode();
      renderReaderView();
    }
    requestAnimationFrame(() => {
      restoreModeScrollPosition(state.mode);
      queueLayoutPageScaleRefresh(els["translation-layout"]);
      if (focusChat) els["chat-input"]?.focus();
      else if (snapshot?.focusedElementID) document.getElementById(snapshot.focusedElementID)?.focus?.();
      else els["source-scroll"]?.focus();
    });
  }

  function prepareReaderAsk(quote, prompt) {
    if (!quote) return;
    if (document.body.classList.contains("clean-reader-mode")) exitCleanReader({ focusChat: true });
    appendReferenceQuote(quote);
    renderSelection();
    if (!els["chat-input"].value.trim()) els["chat-input"].value = prompt;
    els["chat-input"].focus();
  }

  function renderNativePDFSelectionToolbar() {
    const toolbar = els["native-pdf-selection-toolbar"];
    const selection = state.nativePDFSelection;
    if (!toolbar) return;
    toolbar.hidden = !selection || state.mode !== "layout" || !sourcePDFAvailable;
    if (toolbar.hidden) return;
    const width = Math.max(1, Number(toolbar.offsetWidth || 112));
    const height = Math.max(1, Number(toolbar.offsetHeight || 38));
    toolbar.style.left = `${Math.max(6, Math.min(window.innerWidth - width - 6, selection.x - width / 2))}px`;
    toolbar.style.top = `${Math.max(6, Math.min(window.innerHeight - height - 6, selection.y + 10))}px`;
  }

  function askNativePDFSelection() {
    const selection = state.nativePDFSelection;
    if (!selection) return;
    prepareReaderAsk({
      type: "text",
      text: selection.text,
      pane: "source",
      readerMode: "layout",
      origin: "zotero-reader",
      page: selection.page,
      pageLabel: selection.pageLabel || String(selection.page),
      nativePageIndex: selection.page - 1,
      pdfRects: selection.pdfRects,
      pdfReaderView: state.readerView === "source" ? "source" : "both",
      title: "原始PDF选文"
    }, "请解释这段内容，并结合全文说明它在文中的作用。");
    state.nativePDFSelection = null;
    renderNativePDFSelectionToolbar();
  }

  function exportReaderTranslationPDF(pane) {
    if (pane !== "translation") {
      toast("仅支持导出当前显示的译文", "warning");
      return;
    }
    void exportCurrentTranslationPDF();
  }

  function bindLayoutInteractions() {
    let menu = null;
    const removeMenu = () => {
      menu?.remove();
      menu = null;
    };
    document.addEventListener("click", event => {
      if (menu && !menu.contains(event.target)) removeMenu();
      if (event.button !== 0) return;
      const formula = layoutFormulaTarget(event.target);
      if (formula && !event.ctrlKey && !event.metaKey && !event.shiftKey && !formula.closest("#layout-formula-lightbox")) {
        event.preventDefault();
        event.stopPropagation();
        openLayoutFormulaViewer(formula);
        return;
      }
      const image = event.target?.closest?.(".layout-block.layout-image img, #source-content img, #translation-content img");
      if (image) {
        event.preventDefault();
        const pane = readerPaneForTarget(image);
        openImagePreview({
          name: image.closest(".layout-block")?.dataset?.blockId || "layout-image.png",
          mimeType: "image/png",
          url: image.currentSrc || image.src,
          quote: pane ? readerImageQuote(image, pane) : null
        });
      }
    }, true);
    document.addEventListener("contextmenu", event => {
      const pane = readerPaneForTarget(event.target);
      if (!pane) return;
      const formula = layoutFormulaTarget(event.target);
      event.preventDefault();
      removeMenu();
      menu = document.createElement("div");
      menu.className = "layout-formula-menu";
      const paneName = pane.id === "translation-pane" ? "translation" : "source";
      const image = event.target?.closest?.("img");
      const selectionQuote = readerSelectionQuote(pane, event.target);
      const imageQuote = readerImageQuote(image, pane);
      const addAction = (label, action, disabled = false) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.disabled = disabled;
        button.addEventListener("click", () => {
          removeMenu();
          action();
        });
        menu.appendChild(button);
      };
      const addSeparator = () => {
        const separator = document.createElement("div");
        separator.className = "layout-formula-menu-separator";
        menu.appendChild(separator);
      };

      addAction("重新翻译", () => {
        els["translate-button"].click();
      }, !state.data?.parsed?.markdown || state.running.size > 0);
      addSeparator();

      if (formula) {
        addAction("在对话中提问…", () => askLayoutFormula(formula, event));
        addAction("复制TeX", () => { void copyText(formulaTeXWithoutTag(layoutFormulaTeX(formula))); });
      }
      else if (imageQuote) {
        addAction("在对话中提问…", () => {
          void addImageDescriptorToComposer({
            name: imageQuote.imageAlt || "reader-image.png",
            mimeType: "image/png",
            url: String(image?.currentSrc || image?.src || ""),
            quote: imageQuote
          }).catch(error => toast(error.message || "读取图片失败", "error"));
        });
      }
      else if (selectionQuote) {
        addAction("在对话中提问…", () => prepareReaderAsk(
          selectionQuote,
          "请解释这段内容，并结合全文说明它在文中的作用。"
        ));
      }
      addAction("要点提炼", () => els["key-points-button"].click(), !state.data?.parsed?.markdown);
      addSeparator();
      addAction(
        `导出${paneName === "translation" ? "译文" : "原文"}为PDF`,
        () => exportReaderTranslationPDF(paneName),
        paneName === "translation"
          ? !(state.data?.translation?.markdown || Object.keys(state.data?.layout?.translations || {}).length)
          : !state.data?.parsed?.markdown
      );

      menu.style.left = `${Math.max(4, Math.min(window.innerWidth - 180, event.clientX))}px`;
      menu.style.top = `${Math.max(4, Math.min(window.innerHeight - 190, event.clientY))}px`;
      document.body.appendChild(menu);
    }, true);
    document.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        removeMenu();
        document.getElementById("layout-formula-lightbox")?.classList.remove("open");
      }
    });
  }

  function removeReferenceQuote(quote) {
    const identity = referenceQuoteIdentity(quote);
    state.referenceQuotes = state.referenceQuotes.filter(row => referenceQuoteIdentity(row) !== identity);
    renderSelection();
  }

  function referenceQuoteNode(quote, index, removable) {
    const item = normalizeReferenceQuote(quote);
    const row = document.createElement("div");
    row.className = "reference-quote";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "reference-quote-open";
    const kind = item?.type === "formula" ? "公式" : (item?.type === "image" ? "图片" : "引用");
    const page = item?.pageLabel
      ? ` · 页码 ${item.pageLabel}`
      : (item?.page ? ` · 第 ${item.page} 页` : "");
    open.innerHTML = `<span>${kind} ${index + 1}${page}</span><strong></strong>`;
    open.querySelector("strong").textContent = item?.text || "";
    open.title = "在阅读区定位这条引用";
    open.addEventListener("click", () => revealReferenceQuote(item));
    row.appendChild(open);
    if (removable) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "reference-quote-remove";
      remove.textContent = "×";
      remove.title = "移除这条引用";
      remove.addEventListener("click", () => removeReferenceQuote(item));
      row.appendChild(remove);
    }
    return row;
  }

  function normalizedVisibleText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function exactTextRange(root, wantedText) {
    if (!root || !wantedText) return null;
    const wanted = normalizedVisibleText(wantedText);
    if (!wanted) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const positions = [];
    let searchable = "";
    let previousWhitespace = false;
    let node = null;
    while ((node = walker.nextNode())) {
      const value = String(node.nodeValue || "");
      for (let offset = 0; offset < value.length; offset++) {
        const whitespace = /\s/.test(value[offset]);
        if (whitespace) {
          if (previousWhitespace || !searchable) continue;
          searchable += " ";
          positions.push({ node, offset });
          previousWhitespace = true;
        }
        else {
          searchable += value[offset];
          positions.push({ node, offset });
          previousWhitespace = false;
        }
      }
    }
    let index = searchable.indexOf(wanted);
    let matchPositions = positions;
    let matchLength = wanted.length;
    if (index < 0) {
      const compactPositions = [];
      let compactSearchable = "";
      for (let offset = 0; offset < searchable.length; offset++) {
        if (searchable[offset] === " ") continue;
        compactSearchable += searchable[offset];
        compactPositions.push(positions[offset]);
      }
      const compactWanted = wanted.replace(/\s+/g, "");
      index = compactSearchable.indexOf(compactWanted);
      matchPositions = compactPositions;
      matchLength = compactWanted.length;
    }
    if (index < 0) return null;
    const start = matchPositions[index];
    const end = matchPositions[index + matchLength - 1];
    if (!start || !end) return null;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset + 1);
    return range;
  }

  function showReferenceFocus(rects) {
    document.getElementById("litmtrans-reference-focus")?.remove();
    const usable = Array.from(rects || []).filter(rect => rect && rect.width >= 2 && rect.height >= 2);
    if (!usable.length) return false;
    const overlay = document.createElement("div");
    overlay.id = "litmtrans-reference-focus";
    overlay.setAttribute("aria-hidden", "true");
    for (const rect of usable) {
      const segment = document.createElement("span");
      segment.style.cssText = `position:fixed;z-index:2147483646;pointer-events:none;box-sizing:border-box;left:${Math.max(0, rect.left - 4)}px;top:${Math.max(0, rect.top - 3)}px;width:${Math.max(9, rect.width + 8)}px;height:${Math.max(9, rect.height + 6)}px;border:3px solid #d89400;background:rgba(255,193,7,.22);box-shadow:0 0 0 2px rgba(216,148,0,.22),0 3px 12px rgba(0,0,0,.2);border-radius:3px`;
      overlay.appendChild(segment);
    }
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("visible"));
    setTimeout(() => overlay.remove(), 4200);
    return true;
  }

  function imageLocatorKey(value) {
    const source = String(value || "").replace(/[?#].*$/, "").replace(/\\/g, "/");
    try {
      return decodeURIComponent(source).split("/").pop()?.toLowerCase() || source.toLowerCase();
    }
    catch (_) {
      return source.split("/").pop()?.toLowerCase() || source.toLowerCase();
    }
  }

  function switchToReferenceMode(item) {
    if (!["stream", "layout"].includes(item.readerMode) || item.readerMode === state.mode) return true;
    if (item.readerMode === "layout" && !state.data?.capabilities?.canUseLayoutReader) {
      toast("无法在Zotero PDF阅读器中打开这条引用", "warning");
      return false;
    }
    captureModeScrollPosition();
    state.modeUserSelected = true;
    state.mode = item.readerMode;
    if (state.mode === "layout") {
      state.syncScroll = true;
    }
    else {
      state.syncScroll = Boolean(state.settings?.streamSyncScroll ?? state.syncScroll);
    }
    els["sync-scroll-check"].checked = state.syncScroll;
    renderMode();
    void hostCall("save-reader-mode", { mode: state.mode }).catch(() => {});
    return true;
  }

  function revealReferenceQuote(quote) {
    const item = normalizeReferenceQuote(quote);
    if (!item) return;
    if (item.origin === "zotero-reader" || item.readerMode === "zotero-reader") {
      // Native-reader selections can now be displayed and selected inside the
      // workbench's embedded PDF. Prefer that already-open left pane so a
      // citation click does not unexpectedly leave this LitMTrans task.
      if (sourcePDFAvailable && switchToReferenceMode({ ...item, readerMode: "layout" })) {
        const wantedReaderView = item.pdfReaderView || "both";
        if (state.readerView !== wantedReaderView) {
          state.readerView = wantedReaderView;
          renderReaderView();
        }
        const page = Math.max(1, Number(item.nativePageIndex ?? -1) + 1 || Number(item.page || 1));
        void hostCall("reader-preview-jump", { page, highlightRects: item.pdfRects, highlightRawRects: item.pdfRawRects }).catch(error => toast(error.message || "无法定位PDF引用", "error"));
        return;
      }
      // The genuine Zotero tab remains a compatibility fallback when the
      // embedded reader could not be opened for this attachment.
      void hostCall("reveal-native-reference", {
        page: item.page,
        pageLabel: item.pageLabel,
        nativePageIndex: item.nativePageIndex
      }).catch(error => toast(error.message || "无法返回Zotero PDF阅读器", "error"));
      return;
    }
    if (!switchToReferenceMode(item)) return;
    let sourcePane = item.pane !== "translation";
    if (state.readerView !== "both") {
      const targetHidden = (sourcePane && state.readerView === "translation")
        || (!sourcePane && state.readerView === "source");
      if (targetHidden) {
        state.readerView = sourcePane ? "source" : "translation";
        renderReaderView();
      }
    }
    const root = sourcePane ? els["source-pane"] : els["translation-pane"];
    let target = null;
    let exactRange = null;
    let pageTarget = null;
    if (item.type === "formula" && item.formulaTex) {
      target = [...root.querySelectorAll("[data-formula-tex], .layout-page .litmtrans-math")]
        .find(node => layoutFormulaTeX(node) === item.formulaTex) || null;
    }
    if (item.type === "image") {
      const candidates = [...root.querySelectorAll("img")];
      if (item.blockID) {
        target = [...root.querySelectorAll("[data-block-id]")]
          .find(node => node.dataset.blockId === item.blockID)?.querySelector("img") || null;
      }
      const wantedSource = String(item.imageSrc || "");
      const wantedKey = imageLocatorKey(wantedSource);
      target ||= candidates.find(node => {
        const sources = [node.getAttribute?.("src"), node.currentSrc, node.src].filter(Boolean).map(String);
        return sources.includes(wantedSource)
          || (wantedKey && sources.some(source => imageLocatorKey(source) === wantedKey));
      }) || null;
      if (!target && item.imageAlt) {
        const wantedAlt = normalizedVisibleText(item.imageAlt);
        target = candidates.find(node =>
          normalizedVisibleText(node.alt || node.title) === wantedAlt
        ) || null;
      }
    }
    if (item.type !== "image" && item.blockID) {
      target ||= [...root.querySelectorAll("[data-block-id]")].find(node => node.dataset.blockId === item.blockID) || null;
    }
    if (!target && item.page) {
      pageTarget = [...root.querySelectorAll(".layout-page-wrap")].find(node => Number(node.dataset.page) === item.page) || null;
    }
    pageTarget ||= item.page
      ? [...root.querySelectorAll(".layout-page-wrap")].find(node => Number(node.dataset.page) === item.page) || null
      : null;
    if (item.type === "text" && item.text) {
      exactRange = exactTextRange(target || pageTarget || root, item.text)
        || exactTextRange(pageTarget || root, item.text)
        || exactTextRange(root, item.text);
      if (exactRange) target = exactRange.startContainer.parentElement;
    }
    if (item.type !== "image" && !target && !exactRange) {
      const needle = normalizedVisibleText(item.formulaTex || item.text);
      const shortNeedle = needle.slice(0, Math.min(100, needle.length));
      const candidates = root.querySelectorAll(".layout-block, .markdown-body p, .markdown-body li, .markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body blockquote, .markdown-body pre");
      target = [...candidates].find(node => {
        const haystack = normalizedVisibleText(node.textContent);
        return haystack.includes(shortNeedle) || (haystack.length >= 20 && needle.includes(haystack));
      }) || null;
    }
    if (!target && !(pageTarget && item.anchorRect)) {
      const kind = item.type === "image" ? "图片" : (item.type === "formula" ? "公式" : "文本");
      toast(item.page ? `已打开引用所在栏，但未能精确匹配第 ${item.page} 页${kind}` : `已打开引用所在栏，但未能精确匹配${kind}`, "warning");
      return;
    }
    (exactRange?.startContainer?.parentElement || target || pageTarget)?.scrollIntoView({ behavior: "auto", block: "center" });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const exactRects = exactRange ? [...exactRange.getClientRects()] : [];
      if (showReferenceFocus(exactRects)) return;
      if (target) {
        showReferenceFocus([target.getBoundingClientRect()]);
        return;
      }
      if (pageTarget && item.anchorRect) {
        const pageRect = (pageTarget.querySelector(".layout-page") || pageTarget).getBoundingClientRect();
        showReferenceFocus([{
          left: pageRect.left + pageRect.width * Number(item.anchorRect.x || 0),
          top: pageRect.top + pageRect.height * Number(item.anchorRect.y || 0),
          width: pageRect.width * Math.max(.01, Number(item.anchorRect.width || .08)),
          height: pageRect.height * Math.max(.01, Number(item.anchorRect.height || .035))
        }]);
      }
    }));
  }

  function renderSelection() {
    const hasQuotes = state.referenceQuotes.length > 0;
    const legacyText = String(state.selectedText || "").trim();
    els["selection-chip"].hidden = !hasQuotes && !legacyText;
    els["selection-text"].replaceChildren();
    if (hasQuotes) {
      const sentQuoteCount = (state.currentSession?.messages || []).reduce(
        (total, message) => total + (Array.isArray(message?.referenceQuotes) ? message.referenceQuotes.length : 0),
        0
      );
      state.referenceQuotes.forEach((quote, index) => {
        els["selection-text"].appendChild(referenceQuoteNode(quote, sentQuoteCount + index, true));
      });
    }
    else if (legacyText) {
      els["selection-text"].textContent = legacyText;
    }
    const quoteCount = hasQuotes ? state.referenceQuotes.length : (legacyText ? 1 : 0);
    els["context-status"].title = quoteCount ? `另附 ${quoteCount} 条Reader引用` : "";
  }

  function setSelectOptions(select, options, selected = "") {
    const selectedValue = String(selected || "").trim();
    const normalized = options
      .map(option => typeof option === "string" ? { id: option, label: option } : option)
      .filter(option => String(option?.id || "").trim());
    if (selectedValue && !normalized.some(option => String(option.id) === selectedValue)) {
      normalized.unshift({ id: selectedValue, label: selectedValue });
    }
    select.replaceChildren(...normalized.map(model => {
      const option = document.createElement("option");
      option.value = String(model.id);
      option.textContent = model.label || model.id;
      return option;
    }));
    select.value = selectedValue;
  }

  function setSelectValue(select, value) {
    const selectedValue = String(value || "").trim();
    if (String(select?.tagName || "").toUpperCase() === "INPUT") {
      select.value = selectedValue;
      return;
    }
    if (selectedValue && ![...select.options].some(option => option.value === selectedValue)) {
      const option = document.createElement("option");
      option.value = selectedValue;
      option.textContent = selectedValue;
      select.appendChild(option);
    }
    select.value = selectedValue;
  }

  function bindLanguagePicker(input, picker) {
    picker.addEventListener("change", () => {
      const selected = String(picker.value || "").trim();
      if (!selected) return;
      input.value = selected;
      picker.selectedIndex = 0;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.focus();
    });
  }

  function isWebMachineTranslationProvider(value) {
    return Boolean(U?.isWebMachineProvider?.(value));
  }

  function isEdgeLocalTranslationProvider(value) {
    return String(value || "").trim().toLowerCase() === "edge_local";
  }

  function isOfficialDeepSeekTranslation() {
    return String(els["setting-provider"]?.value || "").trim().toLowerCase() === "deepseek"
      && /(?:^|:\/\/)api\.deepseek\.com(?:[/:]|$)/i.test(String(els["setting-base-url"]?.value || "").trim());
  }

  function updateProviderLabel(prefix = "setting-") {
    const provider = String(els[`${prefix}provider`]?.value || "").trim().toLowerCase();
    const label = els[`${prefix}provider-label`];
    if (!label) return;
    label.replaceChildren("服务商");
    const providerLinks = {
      deepseek: ["https://platform.deepseek.com/api_keys", "DeepSeek key官网"],
      gemini: ["https://aistudio.google.com/api-keys", "Google AI Studio官网"],
      openrouter: ["https://openrouter.ai/workspaces/default/keys", "OpenRouter官网"]
    };
    const [href, text] = providerLinks[provider] || [];
    if (!href) return;
    const link = document.createElement("a");
    link.href = href;
    link.dataset.externalUrl = link.href;
    link.textContent = text;
    label.append("（", link, "）");
  }

  function updateDeepSeekFastLayoutControl() {
    const group = els["setting-deepseek-fast-layout-group"];
    const available = isOfficialDeepSeekTranslation();
    group.hidden = !available;
  }

  function syncChatSettingsFromTranslation() {
    const provider = els["setting-provider"]?.value || "oneapi";
    const option = els["setting-provider"]?.selectedOptions?.[0];
    els["setting-chat-provider"].value = provider;
    els["setting-chat-provider"].dataset.activeProvider = provider;
    els["setting-chat-base-url"].value = els["setting-base-url"].value;
    setSelectOptions(els["setting-chat-model"], [], els["setting-model"].value);
    els["setting-chat-thinking-mode"].value = els["setting-thinking-mode"].value;
    setSelectValue(els["setting-chat-reasoning-effort"], els["setting-reasoning-effort"].value);
    els["setting-chat-api-key"].value = els["setting-api-key"].value;
    if (!els["setting-chat-base-url"].value && option?.dataset.baseURL) {
      els["setting-chat-base-url"].value = option.dataset.baseURL;
    }
    updateChatImageSettingsVisibility();
  }

  function updateTranslationContextControls(disabled) {
    const hint = els["reference-list-empty-hint"];
    if (hint) {
      hint.textContent = disabled
        ? "免费或本地机器翻译不使用参考文件和自定义翻译要求；切换回模型服务后可继续使用。"
        : "可添加同领域、同目标语言的文献作为参考。模型会参考其中的术语和行文风格，但始终以当前文献的原意为准。也可用于将中文文献翻译成符合目标期刊参考文献风格的目标语言。支持PDF、Office文档、Markdown、文本和图片。";
    }
    for (const id of [
      "setting-reference-list", "add-reference-button", "edit-custom-translation-instruction",
      "edit-custom-translation-instruction-preview", "remove-reference-button", "clear-reference-button",
      "custom-translation-instruction-input"
    ]) {
      if (els[id]) els[id].disabled = disabled;
    }
  }

  function populateSettings(settings) {
    if (!settings) return;
    for (const [selectID, chat] of [["setting-provider", false], ["setting-chat-provider", true]]) {
      const providerSelect = els[selectID];
      providerSelect.replaceChildren();
      for (const provider of settings.providers || []) {
        if (chat && provider.supportsChat === false) continue;
        const option = document.createElement("option");
        option.value = provider.id;
        option.textContent = provider.name;
        option.dataset.baseURL = provider.defaultBaseURL || "";
        option.dataset.model = provider.defaultModel || "";
        option.dataset.chatModel = provider.chatDefaultModel || "";
        providerSelect.appendChild(option);
      }
    }
    els["setting-provider"].value = settings.translationProvider || settings.provider || "deepseek";
    els["setting-provider"].dataset.activeProvider = els["setting-provider"].value;
    els["setting-base-url"].value = settings.translationBaseURL || settings.baseURL || "";
    setSelectOptions(els["setting-model"], [], settings.translationModel || settings.model || "");
    els["setting-thinking-mode"].value = settings.translationThinkingMode || settings.thinkingMode || "default";
    setSelectValue(els["setting-reasoning-effort"], settings.translationReasoningEffort || settings.reasoningEffort || "default");
    els["setting-deepseek-fast-layout"].checked = Boolean(settings.deepseekFastLayoutTranslation);
    els["setting-api-key"].value = settings.apiKey || "";
    els["setting-chat-uses-translation-model"].checked = settings.chatUsesTranslationModel !== false;
    els["setting-chat-provider"].value = settings.chatProvider ?? "oneapi";
    els["setting-chat-provider"].dataset.activeProvider = els["setting-chat-provider"].value;
    els["setting-chat-base-url"].value = settings.chatBaseURL ?? "";
    setSelectOptions(els["setting-chat-model"], [], settings.chatModel ?? "");
    els["setting-chat-thinking-mode"].value = settings.chatThinkingMode || "default";
    setSelectValue(els["setting-chat-reasoning-effort"], settings.chatReasoningEffort || "default");
    els["setting-chat-image-size"].value = settings.chatImageSize || "auto";
    els["setting-chat-image-quality"].value = settings.chatImageQuality || "auto";
    els["setting-chat-image-format"].value = settings.chatImageFormat || "png";
    updateChatImageSettingsVisibility();
    state.chatRenderMarkdown = settings.chatRenderMarkdown !== false;
    els["setting-chat-api-key"].value = settings.chatAPIKey || "";
    els["setting-mineru-token"].value = settings.mineruToken || "";
    els["setting-mineru-model"].value = "vlm";
    els["setting-target-language"].value = settings.targetLanguage || "简体中文";
    els["setting-machine-source-language"].value = settings.machineSourceLanguage || "英文";
    els["setting-translation-mode"].value = settings.translationMode || "full_context";
    state.referencePaths = Array.isArray(settings.translationReferencePaths) ? [...settings.translationReferencePaths] : [];
    els["custom-translation-instruction-input"].value = settings.customTranslationInstruction || "";
    renderReferencePaths();
    renderCustomTranslationInstructionPreview();
    els["setting-key-points-prompt"].value = settings.effectiveKeyPointsPrompt || settings.keyPointsDefaultPrompt || "";
    updateWebMachineTranslationSettings();
    updateDeepSeekFastLayoutControl();
    updateProviderLabel();
    updateProviderLabel("setting-chat-");
    updateChatModelSectionVisibility();
  }

  function updateWebMachineTranslationSettings({ previousProvider = null, syncChatMode = false } = {}) {
    const provider = els["setting-provider"]?.value || "";
    const enabled = isWebMachineTranslationProvider(provider);
    const edgeLocal = isEdgeLocalTranslationProvider(provider);
    const baseURL = els["setting-base-url"];
    const model = els["setting-model"];
    const key = els["setting-api-key"];
    const refresh = els["refresh-models-button"];
    for (const input of [baseURL, model, key, refresh]) {
      if (input) input.disabled = enabled;
    }
    els["setting-machine-source-language-group"].hidden = !edgeLocal;
    updateTranslationContextControls(enabled);
    if (enabled) {
      if (baseURL) { baseURL.value = ""; baseURL.placeholder = `${edgeLocal ? "Edge本地翻译" : "联网翻译"}不需要API地址`; }
      if (key) { key.value = ""; key.placeholder = `${edgeLocal ? "Edge本地翻译" : "联网翻译"}不需要API密钥`; }
      if (model) {
        model.replaceChildren();
        const option = document.createElement("option");
        option.value = "";
        option.textContent = `${edgeLocal ? "Edge本地翻译" : "联网翻译"}不需要模型`;
        model.appendChild(option);
        model.value = "";
      }
    } else {
      if (baseURL) baseURL.placeholder = "https://api.example.com/v1";
      if (key) key.placeholder = "未配置";
    }
    if (syncChatMode) {
      const wasWeb = isWebMachineTranslationProvider(previousProvider);
      if (enabled) els["setting-chat-uses-translation-model"].checked = false;
      else if (wasWeb) {
        els["setting-chat-uses-translation-model"].checked = true;
        syncChatSettingsFromTranslation();
      }
    }
  }

  function updateChatModelSectionVisibility() {
    const shared = !isWebMachineTranslationProvider(els["setting-provider"]?.value)
      && els["setting-chat-uses-translation-model"].checked;
    if (!shared) els["setting-chat-uses-translation-model"].checked = false;
    els["setting-chat-model-section"].hidden = shared;
    els["settings-dialog"].querySelector(".settings-grid")?.classList.toggle("shared-chat-model", shared);
    if (els["settings-dialog"].open) requestAnimationFrame(() => fitSettingsDialog(els["settings-dialog"]));
  }

  function fitSettingsDialog(dialog) {
    if (!dialog?.open) return;
    const card = dialog.querySelector(".modal-card");
    if (!card) return;
    // Reset Gecko's stale dialog height after the grid becomes shorter.
    dialog.style.height = "auto";
    const available = Math.max(280, window.innerHeight - 48);
    const desired = Math.min(available, Math.ceil(card.scrollHeight));
    dialog.style.height = `${desired}px`;
  }

  function updateChatImageSettingsVisibility() {
    const group = els["setting-chat-image-group"];
    if (!group) return false;
    const providerID = String(els["setting-chat-provider"]?.value || "oneapi");
    const provider = (state.settings?.providers || []).find(item => item.id === providerID);
    const visible = provider?.supportsImages !== false
      && U.isProbablyImageModel(els["setting-chat-model"]?.value);
    group.hidden = !visible;
    return visible;
  }

  function restoreChatReasoningPreference(prefix) {
    const provider = String(els[`${prefix}-provider`]?.value || "").trim().toLowerCase();
    const model = String(els[`${prefix}-model`]?.value || "").trim().toLowerCase();
    const key = `${provider} | ${model}`;
    const preference = state.settings?.chatReasoningPreferences?.[key];
    if (!preference || typeof preference !== "object") return;
    const thinking = els[`${prefix}-thinking-mode`];
    const effort = els[`${prefix}-reasoning-effort`];
    const visible = els[`${prefix}-show-reasoning`];
    if (thinking) thinking.value = preference.thinkingMode || "default";
    if (effort) setSelectValue(effort, preference.reasoningEffort || "default");
    if (visible) visible.checked = Boolean(preference.showReasoning);
  }

  function updateEmbeddedChatImageSettingsVisibility() {
    const group = els["embedded-chat-image-group"];
    const note = els["embedded-chat-image-note"];
    const providerID = String(els["embedded-chat-provider"]?.value || "oneapi");
    const provider = (state.settings?.providers || []).find(item => item.id === providerID);
    const visible = provider?.supportsImages !== false && U.isProbablyImageModel(els["embedded-chat-model"]?.value);
    group.hidden = !visible;
    note.hidden = visible;
    return visible;
  }

  function populateEmbeddedChatSettings(settings) {
    if (!settings) return;
    const provider = els["embedded-chat-provider"];
    provider.replaceChildren(...(settings.providers || []).filter(spec => spec.supportsChat !== false).map(spec => {
      const option = document.createElement("option");
      option.value = spec.id;
      option.textContent = spec.name;
      option.dataset.baseURL = spec.defaultBaseURL || "";
      option.dataset.chatModel = spec.chatDefaultModel || "";
      return option;
    }));
    provider.value = settings.chatProvider || "oneapi";
    provider.dataset.activeProvider = provider.value;
    els["embedded-chat-base-url"].value = settings.chatBaseURL || "";
    setSelectOptions(els["embedded-chat-model"], [...els["setting-chat-model"].options].map(option => ({ id: option.value, label: option.textContent })), settings.chatModel || "");
    els["embedded-chat-thinking-mode"].value = settings.chatThinkingMode || "default";
    setSelectValue(els["embedded-chat-reasoning-effort"], settings.chatReasoningEffort || "default");
    els["embedded-chat-show-reasoning"].checked = Boolean(settings.chatShowReasoning);
    els["embedded-chat-api-key"].value = settings.chatAPIKey || "";
    els["embedded-chat-api-key-state"].textContent = settings.hasChatAPIKey ? "对话API密钥已保存" : "尚未配置对话API密钥";
    els["embedded-chat-render-markdown"].checked = settings.chatRenderMarkdown !== false;
    els["embedded-chat-image-size"].value = settings.chatImageSize || "auto";
    els["embedded-chat-image-quality"].value = settings.chatImageQuality || "auto";
    els["embedded-chat-image-format"].value = settings.chatImageFormat || "png";
    updateEmbeddedChatImageSettingsVisibility();
  }

  async function refreshInlineChatModels() {
    const button = els["refresh-chat-models-inline"];
    const provider = String(state.settings?.chatProvider || "oneapi").trim();
    const profile = state.settings?.chatProviderProfiles?.[provider] || {};
    const requested = els["chat-model-inline"].value.trim() || profile.model || state.settings?.chatModel || "";
    try {
      button.disabled = true;
      const credential = await hostCall("get-provider-api-key", { provider });
      const received = await hostCall("list-models", {
        purpose: "chat",
        provider,
        baseURL: String(profile.baseURL || state.settings?.chatBaseURL || "").trim(),
        apiKey: credential?.apiKey || "",
        currentModel: requested
      });
      const modelOptions = received.map(model => typeof model === "string" ? { id: model, label: model } : model);
      const models = modelOptions.map(model => String(model.id || "")).filter(Boolean);
      const selected = U.chooseChatModel(models, requested);
      setSelectOptions(els["chat-model-inline"], modelOptions, selected || requested);
      setSelectOptions(els["setting-chat-model"], modelOptions, selected || requested);
      if (selected) {
        els["chat-model-inline"].value = selected;
        els["setting-chat-model"].value = selected;
      }
      toast(`已刷新 ${models.length} 个对话模型${selected ? ` · 当前 ${selected}` : ""}`, "success");
    }
    catch (error) { toast(error.message, "error"); }
    finally { button.disabled = false; }
  }

  function embeddedChatSettingsPayload() {
    const provider = els["embedded-chat-provider"].value;
    return {
      chatUsesTranslationModel: false,
      chatProvider: provider,
      chatBaseURL: els["embedded-chat-base-url"].value.trim(),
      chatModel: els["embedded-chat-model"].value.trim(),
      chatThinkingMode: els["embedded-chat-thinking-mode"].value,
      chatReasoningEffort: els["embedded-chat-reasoning-effort"].value.trim(),
      chatShowReasoning: els["embedded-chat-show-reasoning"].checked,
      chatRenderMarkdown: els["embedded-chat-render-markdown"].checked,
      chatImageSize: els["embedded-chat-image-size"].value.trim() || "auto",
      chatImageQuality: els["embedded-chat-image-quality"].value,
      chatImageFormat: els["embedded-chat-image-format"].value,
      chatProviderProfiles: {
        ...(state.settings?.chatProviderProfiles || {}),
        [provider]: {
          baseURL: els["embedded-chat-base-url"].value.trim(),
          model: els["embedded-chat-model"].value.trim(),
          thinkingMode: els["embedded-chat-thinking-mode"].value,
          reasoningEffort: els["embedded-chat-reasoning-effort"].value.trim()
        }
      }
    };
  }

  function renderReferencePaths() {
    const list = els["setting-reference-list"];
    if (!list) return;
    list.replaceChildren(...state.referencePaths.map(path => {
      const option = document.createElement("option");
      option.value = path;
      option.textContent = String(path).replace(/\\/g, "/").split("/").pop() || path;
      option.title = path;
      return option;
    }));
    list.dataset.hasItems = state.referencePaths.length ? "true" : "false";
  }

  function renderCustomTranslationInstructionPreview() {
    const instruction = els["custom-translation-instruction-input"].value.trim();
    els["custom-translation-instruction-preview"].hidden = !instruction;
    els["custom-translation-instruction-preview-content"].value = instruction;
    els["edit-custom-translation-instruction"].textContent = instruction ? "编辑翻译要求" : "添加自定义翻译指令";
  }

  function providerCardByID(cardID) {
    return (state.settings?.providerCards || []).find(card => card.id === cardID) || null;
  }

  function setProviderCardAPIKeyState(label, stateName = "") {
    const status = els["provider-card-api-key-state"];
    status.textContent = label;
    if (stateName) status.dataset.state = stateName;
    else delete status.dataset.state;
  }

  function loadProviderCardEditor(cardID) {
    const card = providerCardByID(cardID);
    if (!card) return newProviderCard();
    state.editingProviderCardID = card.id;
    els["provider-card-list"].value = card.id;
    els["provider-card-name"].value = card.name || "";
    els["provider-card-provider"].value = card.provider || "oneapi";
    els["provider-card-base-url"].value = card.baseURL || "";
    els["provider-card-api-key"].value = "";
    els["provider-card-api-key"].placeholder = card.hasAPIKey ? "正在读取…" : "未配置";
    state.providerCardKeyLoading = Boolean(card.hasAPIKey);
    els["provider-card-api-key"].disabled = state.providerCardKeyLoading;
    setProviderCardAPIKeyState(card.hasAPIKey ? "正在读取…" : "未配置", card.hasAPIKey ? "pending" : "");
    if (!card.hasAPIKey) return;
    const requestedID = card.id;
    void hostCall("provider-card-get-api-key", { cardID: requestedID }).then(result => {
      if (state.editingProviderCardID !== requestedID) return;
      const apiKey = String(result?.apiKey || "");
      els["provider-card-api-key"].value = apiKey;
      els["provider-card-api-key"].placeholder = apiKey ? "已保存" : "未配置";
      setProviderCardAPIKeyState(apiKey ? "已保存" : "未配置", apiKey ? "saved" : "");
    }).catch(error => {
      if (state.editingProviderCardID === requestedID) setProviderCardAPIKeyState("读取失败", "delete");
      toast(error.message, "error");
    }).finally(() => {
      if (state.editingProviderCardID !== requestedID) return;
      state.providerCardKeyLoading = false;
      els["provider-card-api-key"].disabled = false;
    });
  }

  function newProviderCard() {
    state.editingProviderCardID = "";
    els["provider-card-list"].value = "";
    const translation = state.providerCardPurpose === "translation";
    const provider = els[translation ? "setting-provider" : "setting-chat-provider"].value || "oneapi";
    const spec = (state.settings?.providers || []).find(item => item.id === provider);
    els["provider-card-name"].value = `${spec?.name || provider}卡片${(state.settings?.providerCards || []).length + 1}`;
    els["provider-card-provider"].value = provider;
    els["provider-card-base-url"].value = els[translation ? "setting-base-url" : "setting-chat-base-url"].value || spec?.defaultBaseURL || "";
    els["provider-card-api-key"].value = els[translation ? "setting-api-key" : "setting-chat-api-key"].value || "";
    els["provider-card-api-key"].disabled = false;
    els["provider-card-api-key"].placeholder = "未配置";
    state.providerCardKeyLoading = false;
    setProviderCardAPIKeyState(els["provider-card-api-key"].value ? "待保存" : "未配置", els["provider-card-api-key"].value ? "pending" : "");
    els["provider-card-name"].focus();
    els["provider-card-name"].select();
  }

  function renderProviderCards(purpose = state.providerCardPurpose, selectID = "") {
    state.providerCardPurpose = purpose === "translation" ? "translation" : "chat";
    const providerSelect = els["provider-card-provider"];
    providerSelect.replaceChildren(...(state.settings?.providers || [])
      .filter(provider => state.providerCardPurpose === "translation" || provider.supportsChat !== false)
      .map(provider => {
      const option = document.createElement("option");
      option.value = provider.id;
      option.textContent = provider.name;
      return option;
      }));
    const list = els["provider-card-list"];
    list.replaceChildren(...(state.settings?.providerCards || []).map(card => {
      const option = document.createElement("option");
      option.value = card.id;
      option.textContent = card.name || "未命名卡片";
      return option;
    }));
    const target = selectID || state.editingProviderCardID || state.settings?.providerCards?.[0]?.id || "";
    if (target && providerCardByID(target)) loadProviderCardEditor(target);
    else newProviderCard();
  }

  async function saveProviderCard(apply = false) {
    if (state.providerCardKeyLoading) throw new Error("正在读取记忆卡片中的API密钥，请稍后再试");
    const payload = {
      cardID: state.editingProviderCardID,
      name: els["provider-card-name"].value.trim(),
      provider: els["provider-card-provider"].value,
      baseURL: els["provider-card-base-url"].value.trim(),
      apiKey: els["provider-card-api-key"].value.trim()
    };
    const saved = await hostCall("provider-card-save", payload);
    state.settings = { ...state.settings, providerCards: saved.cards || [] };
    state.editingProviderCardID = saved.card?.id || "";
    renderProviderCards(state.editingProviderCardID);
    if (!apply) {
      toast(`记忆卡片“${saved.card?.name || payload.name}”已保存`);
      return saved.card;
    }
    const applied = await hostCall("provider-card-apply", {
      cardID: state.editingProviderCardID,
      purpose: state.providerCardPurpose
    });
    state.settings = applied.settings;
    populateSettings(state.settings);
    renderChat();
    els["provider-cards-dialog"].close();
    toast(`已应用记忆卡片：${applied.card?.name || payload.name}`);
    return applied.card;
  }

  function settingsPayload() {
    const translationProvider = els["setting-provider"].value;
    const chatProvider = els["setting-chat-provider"].value;
    const translationProviderProfiles = {
      ...(state.settings?.translationProviderProfiles || {}),
      [translationProvider]: {
        baseURL: els["setting-base-url"].value.trim(),
        model: els["setting-model"].value.trim(),
        thinkingMode: els["setting-thinking-mode"].value,
        reasoningEffort: els["setting-reasoning-effort"].value
      }
    };
    const chatProviderProfiles = {
      ...(state.settings?.chatProviderProfiles || {}),
      [chatProvider]: {
        baseURL: els["setting-chat-base-url"].value.trim(),
        model: els["setting-chat-model"].value.trim(),
        thinkingMode: els["setting-chat-thinking-mode"].value,
        reasoningEffort: els["setting-chat-reasoning-effort"].value
      }
    };
    const sharedChatModel = !isWebMachineTranslationProvider(translationProvider)
      && els["setting-chat-uses-translation-model"].checked;
    const payload = {
      translationProvider,
      translationBaseURL: els["setting-base-url"].value.trim(),
      translationModel: els["setting-model"].value.trim(),
      translationThinkingMode: els["setting-thinking-mode"].value,
      translationReasoningEffort: els["setting-reasoning-effort"].value.trim(),
      deepseekFastLayoutTranslation: isOfficialDeepSeekTranslation()
        ? els["setting-deepseek-fast-layout"].checked
        : Boolean(state.settings?.deepseekFastLayoutTranslation),
      translationProviderProfiles,
      chatUsesTranslationModel: sharedChatModel,
      mineruModel: "vlm",
      // MinerU's stable parsing profile is intentionally not user-configurable.
      mineruOCR: false,
      mineruTable: true,
      mineruFormula: true,
      targetLanguage: U.normalizeLanguageName(els["setting-target-language"].value, "简体中文"),
      machineSourceLanguage: U.normalizeLanguageName(els["setting-machine-source-language"].value, "英文"),
      translationMode: els["setting-translation-mode"].value,
      translationReferencePaths: [...state.referencePaths],
      customTranslationInstruction: els["custom-translation-instruction-input"].value.trim(),
      keyPointsPrompt: els["setting-key-points-prompt"].value.trim() === String(state.settings?.keyPointsDefaultPrompt || "").trim()
        ? ""
        : els["setting-key-points-prompt"].value,
      showLayoutRestoration: true,
      layoutDevelopmentMode: Boolean(els["debug-boxes-check"]?.checked ?? state.settings?.layoutDevelopmentMode),
      showReasoning: true,
      requestAudit: false,
      syncScroll: true,
      streamSyncScroll: true
    };
    // Preserve both profiles on every save. Shared mode is synchronized by
    // the controller; independent mode restores the user's saved chat values.
    Object.assign(payload, {
      chatProvider,
      chatBaseURL: els["setting-chat-base-url"].value.trim(),
      chatModel: els["setting-chat-model"].value.trim(),
      chatThinkingMode: els["setting-chat-thinking-mode"].value,
      chatReasoningEffort: els["setting-chat-reasoning-effort"].value.trim(),
      chatShowReasoning: true,
      chatProviderProfiles,
      chatRenderMarkdown: true,
      chatImageSize: els["setting-chat-image-size"].value.trim() || "auto",
      chatImageQuality: els["setting-chat-image-quality"].value,
      chatImageFormat: els["setting-chat-image-format"].value
    });
    return payload;
  }

  async function initialize() {
    if (!hostFunction()) return;
    try {
      setStatus("正在读取文献状态…", 0, "running");
      const data = await hostCall("initialize");
      setData(data);
      // Recover an already-completed translation if the application was closed
      // between publication and attachment import. The persisted identity
      // prevents any duplicate generation on ordinary reopen.
      if (data?.layout?.meta?.complete) requestAnimationFrame(() => queueLayoutPDFAttachmentsAfterFinalPublication());
      void reconcileOperationState();
      syncWorkbenchViewport();
      setStatus(data.capabilities?.hasParsed ? "已就绪" : "尚未解析", 0, data.capabilities?.hasParsed ? "success" : "neutral");
    }
    catch (error) {
      if (!error.cancelled) {
        setStatus(error.message, 0, "error");
        toast(error.message, "error");
      }
    }
  }

  async function refreshState(options = {}) {
    const data = await hostCall("refresh");
    setData(data, options);
    return data;
  }

  function translationConfigurationField(message) {
    const text = String(message || "");
    const missing = /(?:尚未配置|尚未选择|请先(?:在.*设置中)?(?:配置|填写|选择))/.test(text);
    if (!missing) return "";
    if (/API\s*密钥/i.test(text)) return "setting-api-key";
    if (/API\s*地址/i.test(text)) return "setting-base-url";
    if (/模型/.test(text)) return "setting-model";
    return "";
  }

  async function openSettingsDialog(focusID = "") {
    // Always fetch the canonical settings snapshot when this entry opens.
    // The Zotero preference pane and this workbench must never render two
    // independently cached versions of the configuration.
    state.settings = await hostCall("get-settings");
    populateSettings(state.settings);
    els["settings-advanced"].open = false;
    els["settings-dialog"].style.height = "auto";
    if (!els["settings-dialog"].open) els["settings-dialog"].showModal();
    requestAnimationFrame(() => {
      fitSettingsDialog(els["settings-dialog"]);
      const field = focusID ? els[focusID] : null;
      field?.focus();
      field?.select?.();
    });
  }

  async function ensureMinerUTokenForParse(options = {}) {
    const settings = await hostCall("get-settings");
    state.settings = settings;
    const expired = options.reason === "expired";
    if (!options.force && String(settings?.mineruToken || "").trim()) return true;

    const dialog = els["mineru-token-dialog"];
    const title = els["mineru-token-dialog-title"];
    const description = els["mineru-token-dialog-description"];
    const input = els["mineru-token-input"];
    const errorNode = els["mineru-token-error"];
    const saveButton = els["save-mineru-token-and-parse"];
    title.textContent = expired ? "MinerU访问令牌可能已过期" : "配置MinerU访问令牌";
    description.textContent = expired
      ? "MinerU令牌有效期为三个月，请前往官网重新创建并替换。"
      : "解析文献前需要先填写访问令牌。";
    input.value = "";
    errorNode.hidden = !expired;
    errorNode.textContent = expired ? "当前令牌已无法通过MinerU验证，请粘贴新令牌后重试。" : "";
    saveButton.disabled = false;
    saveButton.textContent = expired ? "保存新令牌并重试" : "保存并继续解析";

    return new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        dialog.removeEventListener("close", onClose);
        saveButton.removeEventListener("click", onSave);
        input.removeEventListener("keydown", onKeyDown);
        resolve(value);
      };
      const onClose = () => finish(false);
      const onKeyDown = event => {
        if (event.key === "Enter") {
          event.preventDefault();
          void onSave();
        }
      };
      const onSave = async () => {
        const token = input.value.trim();
        if (!token) {
          errorNode.textContent = "请先填写MinerU访问令牌。";
          errorNode.hidden = false;
          input.focus();
          return;
        }
        try {
          saveButton.disabled = true;
          errorNode.hidden = true;
          await hostCall("save-mineru-token", { token });
          state.settings = { ...state.settings, mineruToken: token };
          els["setting-mineru-token"].value = token;
          finish(true);
          dialog.close("saved");
        }
        catch (error) {
          errorNode.textContent = String(error?.message || error);
          errorNode.hidden = false;
          saveButton.disabled = false;
          input.focus();
        }
      };
      dialog.addEventListener("close", onClose);
      saveButton.addEventListener("click", onSave);
      input.addEventListener("keydown", onKeyDown);
      dialog.showModal();
      requestAnimationFrame(() => input.focus());
    });
  }

  async function runAction(method, payload = {}, options = {}) {
    try {
      lastActionError = "";
      state.reasoning = "";
      if (method === "parse" && !await ensureMinerUTokenForParse()) return null;
      const result = await hostCall(method, payload);
      if (method === "parse" && result?.state) setData(result.state);
      else if (method === "translate") {
        state.data.translation = result;
        renderStreamPanes();
        await refreshState();
      }
      else if (method === "translate-layout") {
        const publicationRevision = state.layoutPublicationRevision;
        state.data.layout = { ...(state.data.layout || {}), ...result };
        // The completed layout event is normally delivered before this bridge
        // response. Publish from the response only if that event was lost;
        // otherwise this would re-create the same fully fitted DOM twice.
        if (state.layoutPublicationRevision === publicationRevision) renderLayoutPanes();
        // Refresh metadata/settings without mounting the just-published model
        // once more. The response above already provides the final model when
        // the event fallback was needed.
        await refreshState({ preserveLayout: true });
        // A first translation has no prior meta.json when its final event is
        // emitted, so that event intentionally lacks the new identity. Its
        // bridge response carries the persisted final metadata; use it as the
        // fallback trigger. Existing/retranslated layouts were already queued
        // by the final publication event and are deduplicated by identity.
        if (result?.meta?.complete === true) queueLayoutPDFAttachmentsAfterFinalPublication();
      }
      else if (method === "manual-translation-import") {
        if (payload.mode === "layout") {
          state.data.layout = { ...(state.data.layout || {}), ...result };
          renderLayoutPanes();
          if (result?.meta?.complete) queueLayoutPDFAttachmentsAfterFinalPublication();
        }
        else {
          state.data.translation = result;
          renderStreamPanes();
        }
        await refreshState({ preserveLayout: payload.mode === "layout" });
      }
      if (options.success) {
        // The operation-finished event only clears the busy state. Make the
        // successful result visible even if the final streaming event was
        // lost or arrived before the bridge response was rendered.
        setStatus(options.success, 100, "success");
        addLog(options.success);
        toast(options.success);
      }
      return result;
    }
    catch (error) {
      if (!error.cancelled) {
        const message = String(error?.message || error);
        lastActionError = message;
        const cacheProtectionPrefix = "DEEPSEEK_FAST_CACHE_PROTECTION:";
        if (method === "parse" && U.isMinerUTokenCredentialError?.(error)) {
          const notice = "MinerU访问令牌可能已过期或失效，请前往官网重新创建。";
          lastActionError = notice;
          setStatus("MinerU访问令牌需要更新", null, "error");
          addLog(notice, "error");
          const replaced = await ensureMinerUTokenForParse({ force: true, reason: "expired" });
          if (replaced) return runAction(method, payload, options);
        }
        else if (message.startsWith(cacheProtectionPrefix)) {
          const detail = message.slice(cacheProtectionPrefix.length);
          setStatus("DeepSeek 快速翻译已停止", null, "neutral");
          toast(detail, "warning");
          addLog(detail, "warning");
          window.alert(`DeepSeek 快速翻译已停止\n\n${detail}`);
        }
        else {
          setStatus(message, null, "error");
          toast(message, "error");
          addLog(message, "error");
          const configurationField = ["translate", "translate-layout"].includes(method)
            ? translationConfigurationField(message)
            : "";
          if (configurationField) {
            try { await openSettingsDialog(configurationField); }
            catch (settingsError) { toast(settingsError.message || "无法打开设置", "error"); }
          }
        }
      }
      return null;
    }
  }

  async function refreshChatSessions(loadCurrent = true) {
    try {
      state.sessions = await hostCall("chat-list");
      if (loadCurrent && state.currentSession?.id) state.currentSession = await hostCall("chat-load", { sessionID: state.currentSession.id });
      renderChatSessions();
      renderChat();
    }
    catch (error) { toast(error.message, "error"); }
  }

  function applyOpenContext(payload) {
    if (payload.quote) {
      if (typeof payload.quote === "object") appendReferenceQuote(payload.quote);
      else appendReferenceQuote({ type: "text", text: String(payload.quote), pane: "source" });
      state.selectedText = "";
      renderSelection();
    }
    if (payload.prompt) {
      els["chat-input"].value = String(payload.prompt);
      els["chat-input"].focus();
    }
  }

  async function copyText(text) {
    const value = String(text || "");
    try {
      await navigator.clipboard.writeText(value);
      toast("已复制");
      return;
    }
    catch (_) {}
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
    toast("已复制");
  }

  function bindScrollSync() {
    // Keep anchor measurement out of the scroll hot path. Repeatedly walking
    // every positioned layout block and reading its rect forced synchronous
    // reflow for every wheel tick, which was particularly visible in layout
    // mode. The original reader caches anchors and only invalidates them on a
    // size/content change.
    const anchorCache = new WeakMap();
    const anchorY = (scroll, node) => {
      const scrollRect = scroll.getBoundingClientRect();
      return scroll.scrollTop + node.getBoundingClientRect().top - scrollRect.top;
    };
    const dedupeAnchors = anchors => {
      anchors.sort((a, b) => a.y - b.y || b.priority - a.priority);
      const deduped = [];
      for (const anchor of anchors) {
        const previous = deduped[deduped.length - 1];
        if (previous && Math.abs(previous.y - anchor.y) < 1 && previous.priority >= anchor.priority) continue;
        if (previous && Math.abs(previous.y - anchor.y) < 1) deduped.pop();
        deduped.push(anchor);
      }
      return deduped;
    };
    const imageAnchor = (scroll, image) => {
      // Distant layout images deliberately drop `src`; retain their stable
      // resource identity so scroll synchronization does not collapse them
      // into the current document URL while they are unloaded.
      const source = image.dataset.layoutImageSrc || image.getAttribute("src") || image.currentSrc || "";
      const key = U.imageAnchorKey(source);
      return key
        ? { key, y: anchorY(scroll, image), node: image, priority: 85 }
        : null;
    };
    const anchorCatalogFor = scroll => {
      const cached = anchorCache.get(scroll);
      const signature = `${scroll.scrollHeight}:${scroll.clientHeight}:${scroll.clientWidth}`;
      if (cached?.signature === signature) return cached.catalog;
      const top = { key: "__top__", y: 0, node: null, priority: 100 };
      const fallbackAnchors = [top];
      const imageAnchors = [top];
      // The inactive layout DOM remains mounted in the same scroll containers.
      // Hidden pages must not change the stream reader's anchor catalog.
      const pageNodes = state.mode === "layout"
        ? [...scroll.querySelectorAll(".layout-page-wrap")]
        : [];
      if (pageNodes.length) {
        for (const page of pageNodes) {
          fallbackAnchors.push({ key: `page:${page.dataset.page || ""}`, y: anchorY(scroll, page), node: page, priority: 90 });
        }
        const seenBlocks = new Set();
        for (const block of scroll.querySelectorAll("[data-block-id]")) {
          const id = String(block.dataset.blockId || "");
          if (!id || seenBlocks.has(id)) continue;
          seenBlocks.add(id);
          fallbackAnchors.push({ key: `block:${id}`, y: anchorY(scroll, block), node: block, priority: 95 });
        }
        [...scroll.querySelectorAll(".layout-block.layout-image img")].forEach(image => {
          const anchor = imageAnchor(scroll, image);
          if (anchor) imageAnchors.push(anchor);
        });
      }
      else {
        const explicitBlocks = [...scroll.querySelectorAll(".markdown-body .litmtrans-sync-anchor[id]")];
        for (const anchor of explicitBlocks) {
          fallbackAnchors.push({ key: `block:${anchor.id}`, y: anchorY(scroll, anchor), node: anchor, priority: 95 });
        }
        const headingCounts = new Map();
        for (const heading of scroll.querySelectorAll(".markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6")) {
          const level = Number(heading.tagName.slice(1));
          const next = (headingCounts.get(level) || 0) + 1;
          headingCounts.set(level, next);
          fallbackAnchors.push({ key: `heading:${level}:${next}`, y: anchorY(scroll, heading), node: heading, priority: 90 });
        }
        [...scroll.querySelectorAll(".markdown-body img")].forEach(image => {
          const anchor = imageAnchor(scroll, image);
          if (anchor) imageAnchors.push(anchor);
        });
        [...scroll.querySelectorAll(".markdown-body table")].forEach((table, index) => {
          fallbackAnchors.push({ key: `table:${index + 1}`, y: anchorY(scroll, table), node: table, priority: 85 });
        });
        // Older cached renders may not contain explicit block markers. Keep
        // positional anchors solely as a backwards-compatible fallback.
        if (!explicitBlocks.length) {
          [...scroll.querySelectorAll(".markdown-body > p, .markdown-body > ul, .markdown-body > ol, .markdown-body > blockquote, .markdown-body > pre")].forEach((node, index) => {
            fallbackAnchors.push({ key: `flow:${index + 1}`, y: anchorY(scroll, node), node, priority: 40 });
          });
        }
      }
      const bottom = {
        key: "__bottom__",
        y: Math.max(0, scroll.scrollHeight - scroll.clientHeight),
        node: null,
        priority: 100
      };
      fallbackAnchors.push(bottom);
      imageAnchors.push(bottom);
      const catalog = {
        fallbackAnchors: dedupeAnchors(fallbackAnchors),
        imageAnchors: dedupeAnchors(imageAnchors)
      };
      anchorCache.set(scroll, { signature, catalog });
      return catalog;
    };
    const pairedAnchorsFor = (source, target) => {
      const sourceCatalog = anchorCatalogFor(source);
      const targetCatalog = anchorCatalogFor(target);
      const sharedImageKeys = new Set(U.sharedImageAnchorKeys(
        sourceCatalog.imageAnchors.filter(anchor => anchor.node).map(anchor => anchor.key),
        targetCatalog.imageAnchors.filter(anchor => anchor.node).map(anchor => anchor.key)
      ));
      if (sharedImageKeys.size) {
        const keepSharedImageOrEdge = anchor => !anchor.node || sharedImageKeys.has(anchor.key);
        return {
          mode: "image",
          source: sourceCatalog.imageAnchors.filter(keepSharedImageOrEdge),
          target: targetCatalog.imageAnchors.filter(keepSharedImageOrEdge)
        };
      }
      return {
        mode: "fallback",
        source: sourceCatalog.fallbackAnchors,
        target: targetCatalog.fallbackAnchors
      };
    };
    const payloadFor = (scroll, anchors, anchorMode) => {
      const y = scroll.scrollTop;
      let previous = anchors[0];
      let next = anchors[anchors.length - 1];
      for (const anchor of anchors) {
        if (anchor.y <= y) previous = anchor;
        if (anchor.y >= y) {
          next = anchor;
          break;
        }
      }
      const range = Math.max(1, scroll.scrollHeight - scroll.clientHeight);
      const span = Math.max(1, next.y - previous.y);
      let focusImage = null;
      const viewport = scroll.getBoundingClientRect();
      const focusLine = viewport.top + scroll.clientHeight * .42;
      for (const anchor of anchors.filter(candidate => candidate.node && candidate.key.startsWith("image:"))) {
        const image = anchor.node;
        const rect = image.getBoundingClientRect();
        const distance = Math.abs((rect.top + rect.bottom) / 2 - focusLine);
        if (!focusImage || distance < focusImage.distance) {
          focusImage = {
            key: anchor.key,
            viewportTop: rect.top - viewport.top,
            distance,
            visible: rect.bottom > viewport.top && rect.top < viewport.bottom
          };
        }
      }
      if (focusImage && !focusImage.visible && focusImage.distance > Math.max(180, scroll.clientHeight * .3)) focusImage = null;
      return {
        anchorMode,
        ratio: Math.max(0, Math.min(1, y / range)),
        previousKey: previous.key,
        nextKey: next.key,
        localRatio: Math.max(0, Math.min(1, (y - previous.y) / span)),
        offset: y - previous.y,
        focusImageKey: focusImage?.key || "",
        focusImageViewportTop: focusImage?.viewportTop ?? null
      };
    };
    const scrollToPayload = (scroll, payload, anchors) => {
      const byKey = new Map(anchors.map(anchor => [anchor.key, anchor]));
      const previous = byKey.get(payload.previousKey);
      const next = byKey.get(payload.nextKey);
      const focus = payload.focusImageKey ? byKey.get(payload.focusImageKey) : null;
      let top = null;
      if (focus?.node && payload.focusImageViewportTop != null) {
        top = focus.y - Number(payload.focusImageViewportTop);
      }
      else if (previous && next && next.y >= previous.y) {
        top = previous.y + (next.y - previous.y) * Number(payload.localRatio || 0);
      }
      else if (previous) top = previous.y + Number(payload.offset || 0);
      else if (next) top = next.y - (1 - Number(payload.localRatio || 0)) * Math.max(0, next.y);
      const range = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
      if (top == null || !Number.isFinite(top)) top = Number(payload.ratio || 0) * range;
      const nextTop = Math.max(0, Math.min(range, top));
      if (Math.abs(scroll.scrollTop - nextTop) > .5) scroll.scrollTop = nextTop;
    };
    const invalidate = scroll => anchorCache.delete(scroll);
    let lastUserPair = null;
    const queueSync = (source, target) => {
      state.syncSource = { source, target };
      if (state.syncFrame) return;
      state.syncFrame = requestAnimationFrame(() => {
        state.syncFrame = null;
        const pending = state.syncSource;
        state.syncSource = null;
        if (!pending || !state.syncScroll || state.mode === "layout") return;
        pending.target._litmtransProgrammaticUntil = performance.now() + 140;
        const pairedAnchors = pairedAnchorsFor(pending.source, pending.target);
        scrollToPayload(
          pending.target,
          payloadFor(pending.source, pairedAnchors.source, pairedAnchors.mode),
          pairedAnchors.target
        );
      });
    };
    const bind = (source, target) => {
      const markUserIntent = () => {
        const now = performance.now();
        source._litmtransUserScrollAt = now;
        source._litmtransUserScrollUntil = now + 700;
        lastUserPair = { source, target, at: now };
      };
      source.addEventListener("wheel", markUserIntent, { passive: true });
      source.addEventListener("touchstart", markUserIntent, { passive: true });
      source.addEventListener("pointerdown", markUserIntent, { passive: true });
      source.addEventListener("keydown", markUserIntent, { passive: true });
      new ResizeObserver(() => invalidate(source)).observe(source);
      new MutationObserver(() => invalidate(source)).observe(source, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src"]
      });
      source.addEventListener("load", event => {
        if (String(event.target?.tagName || "").toLowerCase() !== "img") return;
        invalidate(source);
        // Loading image metadata changes every following anchor coordinate.
        // Repeat the newest user-driven mapping after that geometry settles,
        // like the original reader's post-load synchronization pass.
        if (lastUserPair && performance.now() - lastUserPair.at < 3000) {
          invalidate(lastUserPair.source);
          invalidate(lastUserPair.target);
          queueSync(lastUserPair.source, lastUserPair.target);
        }
      }, true);
      source.addEventListener("scroll", () => {
        // A target assignment emits its own scroll event. Never treat that
        // event (or geometry restoration) as new user intent, otherwise the
        // opposite pane immediately sends a slightly different anchor back.
        if (!state.syncScroll || performance.now() < Number(source._litmtransProgrammaticUntil || 0)) return;
        if (performance.now() > Number(source._litmtransUserScrollUntil || 0)) return;
        if (lastUserPair?.source !== source) return;
        if (source.scrollHeight <= source.clientHeight || target.scrollHeight <= target.clientHeight) return;
        queueSync(source, target);
      }, { passive: true });
    };
    bind(els["source-scroll"], els["translation-scroll"]);
    bind(els["translation-scroll"], els["source-scroll"]);
    let readerJumpFrame = null;
    let pendingReaderLocation = null;
    els["translation-scroll"].addEventListener("scroll", () => {
      if (state.mode !== "layout" || !state.syncScroll) return;
      if (performance.now() < Number(els["translation-scroll"]._litmtransProgrammaticUntil || 0)) return;
      pendingReaderLocation = layoutPageAtViewportAnchor(els["translation-scroll"], .35);
      if (readerJumpFrame) return;
      readerJumpFrame = requestAnimationFrame(() => {
        readerJumpFrame = null;
        const location = pendingReaderLocation;
        pendingReaderLocation = null;
        if (!location) return;
        const page = location.page;
        // Page-only de-duplication made an entire long page inert after its
        // first jump. Keep Reader aligned while the user continues within the
        // same page, but avoid needless sub-pixel echo traffic.
        if (page === state.readerSyncPage && Math.abs(location.pageRatio - state.readerSyncPageRatio) < .012) return;
        state.readerSyncUntil = performance.now() + 120;
        state.readerSyncPage = page;
        state.readerSyncPageRatio = location.pageRatio;
        void hostCall("reader-preview-jump", {
          page,
          pageRatio: location.pageRatio,
          anchorRatio: location.anchorRatio
        }).catch(() => {});
      });
    }, { passive: true });
  }

  function bindSplitHandle() {
    const handle = els["split-handle"];
    let dragging = false;
    const isStacked = () => window.matchMedia?.("(max-width: 700px)")?.matches;
    const move = event => {
      if (!dragging) return;
      const rect = els["reader-split"].getBoundingClientRect();
      const vertical = isStacked();
      const size = vertical ? rect.height : rect.width;
      if (size <= 0) return;
      const origin = vertical ? rect.top : rect.left;
      const pointer = vertical ? event.clientY : event.clientX;
      const ratio = Math.max(.22, Math.min(.78, (pointer - origin) / size));
      document.documentElement.style.setProperty("--source-share", `${ratio * 100}%`);
    };
    handle.addEventListener("pointerdown", event => {
      dragging = true;
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", event => {
      dragging = false;
      try { handle.releasePointerCapture(event.pointerId); } catch (_) {}
    });
    handle.addEventListener("keydown", event => {
      const vertical = isStacked();
      const keys = vertical ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
      if (!keys.includes(event.key)) return;
      const current = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--source-share")) || 50;
      const decrease = vertical ? event.key === "ArrowUp" : event.key === "ArrowLeft";
      const next = Math.max(22, Math.min(78, current + (decrease ? -3 : 3)));
      document.documentElement.style.setProperty("--source-share", `${next}%`);
      event.preventDefault();
    });
  }

  function bindSidebarSplitHandle() {
    const handle = els["sidebar-split-handle"];
    if (!handle) return;
    const minimum = 240;
    const preferredMaximum = 640;
    let dragging = false;
    const maximumWidth = () => Math.max(minimum, Math.min(preferredMaximum, els["app"].getBoundingClientRect().width - 500));
    const apply = width => {
      const maximum = maximumWidth();
      const next = Math.max(Math.min(minimum, maximum), Math.min(maximum, Math.round(width)));
      document.documentElement.style.setProperty("--sidebar-width", `${next}px`);
      handle.setAttribute("aria-valuemax", String(maximum));
      handle.setAttribute("aria-valuenow", String(next));
    };
    const move = event => {
      if (!dragging) return;
      const rect = els["main-grid"]?.getBoundingClientRect?.() || els["app"].getBoundingClientRect();
      apply(rect.right - event.clientX);
    };
    handle.addEventListener("pointerdown", event => {
      if (window.matchMedia?.("(max-width: 860px)")?.matches) return;
      dragging = true;
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", event => {
      dragging = false;
      try { handle.releasePointerCapture(event.pointerId); } catch (_) {}
    });
    handle.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const current = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width")) || 350;
      const next = event.key === "Home" ? minimum
        : event.key === "End" ? maximumWidth()
          : current + (event.key === "ArrowLeft" ? 20 : -20);
      apply(next);
      event.preventDefault();
    });
    apply(parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width")) || 350);
  }

  function syncSplitHandleOrientation() {
    const handle = els["split-handle"];
    if (!handle) return;
    handle.setAttribute("aria-orientation", window.matchMedia?.("(max-width: 700px)")?.matches ? "horizontal" : "vertical");
  }

  // Local intent detection is deliberately conservative: diagram nouns alone
  // often occur in questions about an existing diagram rather than a request
  // to create one. Button tasks bypass this detector entirely.
  function detectDiagramIntent(value) {
    const text = String(value || "").trim();
    const flow = /(?:流程图|算法图|flow\s*chart|flowchart|workflow)/i.test(text);
    const map = /(?:思维导图|脑图|mind\s*map|mindmap)/i.test(text);
    if (!flow && !map) return { taskType: "" };
    const negative = /(?:不要|别|无需|不需要)\s*(?:画|绘制|生成|制作|整理|转成|用).{0,10}(?:流程图|算法图|脑图|思维导图|flow\s*chart|mind\s*map)|(?:什么是|区别|解释.{0,12}(?:刚才|这个|该).{0,12}(?:流程图|脑图))/i;
    if (negative.test(text)) return { taskType: "" };
    const action = /(?:画|绘制|生成|制作|整理成|转成|用.{0,8}(?:表示|展示)|visuali[sz]e|create|draw)/i;
    const terse = /^(?:思维导图|脑图|mind\s*map|mindmap|流程图|算法图|flow\s*chart|flowchart|workflow)[！!。.]?$/i;
    if (!action.test(text) && !terse.test(text)) return { taskType: "" };
    return { taskType: flow ? "generic_flowchart" : "generic_mindmap" };
  }

  function bindEditableContextMenu() {
    let menu = null;
    const editableInputTypes = new Set(["", "text", "password", "search", "email", "url", "tel", "number"]);
    const editableControl = target => {
      const control = target?.closest?.("input, textarea");
      if (!control || control.disabled) return null;
      if (control.localName === "input" && !editableInputTypes.has(String(control.type || "").toLowerCase())) return null;
      return control;
    };
    const removeMenu = () => {
      menu?.remove();
      menu = null;
    };
    const selectionRange = control => {
      const length = String(control.value || "").length;
      const start = Number.isInteger(control.selectionStart) ? control.selectionStart : length;
      const end = Number.isInteger(control.selectionEnd) ? control.selectionEnd : start;
      return { start, end };
    };
    const replaceSelection = (control, replacement) => {
      const { start, end } = selectionRange(control);
      control.focus();
      if (Number.isInteger(control.selectionStart) && typeof control.setRangeText === "function") {
        control.setRangeText(String(replacement || ""), start, end, "end");
      }
      else {
        control.value = String(replacement || "");
      }
      control.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const selectedText = control => {
      const { start, end } = selectionRange(control);
      return String(control.value || "").slice(start, end);
    };
    const writeSelectedText = async control => {
      const text = selectedText(control);
      if (!text) return false;
      await hostCall("clipboard-write-text", { text });
      return true;
    };

    document.addEventListener("contextmenu", event => {
      const control = editableControl(event.target);
      if (!control) return;
      event.preventDefault();
      event.stopPropagation();
      removeMenu();

      const { start, end } = selectionRange(control);
      const hasSelection = end > start;
      const readOnly = Boolean(control.readOnly);
      menu = document.createElement("div");
      menu.className = "layout-formula-menu editable-context-menu";
      menu.setAttribute("role", "menu");
      const addAction = (label, action, disabled = false) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.disabled = disabled;
        button.setAttribute("role", "menuitem");
        button.addEventListener("mousedown", downEvent => downEvent.preventDefault());
        button.addEventListener("click", () => {
          removeMenu();
          void Promise.resolve(action()).catch(error => toast(error.message || `${label}失败`, "error"));
        });
        menu.appendChild(button);
      };
      addAction("剪切", async () => {
        if (await writeSelectedText(control)) replaceSelection(control, "");
      }, readOnly || !hasSelection);
      addAction("复制", () => writeSelectedText(control), !hasSelection);
      addAction("粘贴", async () => {
        const result = await hostCall("clipboard-read-text");
        replaceSelection(control, result?.text || "");
      }, readOnly);
      addAction("全选", () => {
        control.focus();
        control.select();
      }, !String(control.value || "").length);

      menu.style.left = `${Math.max(4, Math.min(window.innerWidth - 150, event.clientX))}px`;
      menu.style.top = `${Math.max(4, Math.min(window.innerHeight - 150, event.clientY))}px`;
      // A modal <dialog> lives in the browser's top layer. No z-index on an
      // element under <body> can place it above that layer, so keep the menu
      // inside the active dialog when the edited control belongs to one.
      (control.closest("dialog[open]") || document.body).appendChild(menu);
    }, true);
    document.addEventListener("pointerdown", event => {
      if (menu && !menu.contains(event.target)) removeMenu();
    }, true);
    document.addEventListener("keydown", event => {
      if (event.key === "Escape") removeMenu();
    });
    window.addEventListener("blur", removeMenu);
  }

  function bindEvents() {
    bindEditableContextMenu();
    document.addEventListener("click", event => {
      const link = event.target?.closest?.("a[data-external-url]");
      if (!link) return;
      event.preventDefault();
      void hostCall("open-external-url", { url: link.dataset.externalUrl || link.href })
        .catch(error => toast(error.message || "无法打开官网", "error"));
    });
    els["open-token-guide-button"].addEventListener("click", () => {
      void hostCall("open-token-guide")
        .catch(error => toast(error.message || "无法打开令牌创建指南", "error"));
    });
    bindLanguagePicker(els["setting-target-language"], els["setting-target-language-picker"]);
    bindLanguagePicker(els["setting-machine-source-language"], els["setting-machine-source-language-picker"]);
    window.addEventListener("focus", () => { void reconcileOperationState(); });
    window.addEventListener("beforeprint", restoreLayoutImagesForPrintEvent);
    window.addEventListener("afterprint", resumeLayoutImageMemoryManagement);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) void reconcileOperationState();
    });
    setInterval(() => {
      if (state.running.size && !document.hidden) void reconcileOperationState();
    }, 3000);
    updateCleanReaderButton(false);
    const recommendedTranslationModeForLongPDF = async () => {
      const result = await hostCall("pdf-page-count");
      if (Number(result?.pageCount || 0) <= 150) return state.settings?.translationMode || "full_context";
      const dialog = els["long-document-translation-dialog"];
      const choice = await new Promise(resolve => {
        const onClose = () => {
          dialog.removeEventListener("close", onClose);
          resolve(dialog.returnValue);
        };
        dialog.addEventListener("close", onClose);
        dialog.showModal();
      });
      if (choice !== "yes") return state.settings?.translationMode || "full_context";
      const settings = await hostCall("save-settings", { translationMode: "chunked" });
      state.settings = settings;
      return "chunked";
    };
    const startTranslation = async () => {
      const translationMode = await recommendedTranslationModeForLongPDF();
      // Parsing is an implementation prerequisite, not a separate reading
      // action. The visible control remains one unambiguous "翻译" button.
      if (!state.data?.parsed?.markdown) {
        const parsed = await runAction("parse", {}, { success: "解析完成，开始翻译" });
        if (!parsed) return;
      }
      if (state.mode === "layout") {
        // Checkpoint events publish partial translations while a run is in
        // progress. A later click after a failed run must resume that
        // checkpoint, not mistake it for a finished version and erase it.
        const force = Boolean(
          state.data?.layout?.meta?.complete
          && Object.keys(state.data?.layout?.translations || {}).length
        );
        if (force && !window.confirm("确认重新进行排版翻译？当前译文会继续用于阅读和导出，直到新译文完成并通过校验后自动替换。")) return;
        if (force) setStatus("正在重新翻译 · 当前仍显示上一版，完成后自动替换", null, "running");
        await runAction(
          "translate-layout",
          { mode: translationMode, force },
          { success: force ? "新版排版译文已完成" : "排版翻译完成" }
        );
        return;
      }
      const force = Boolean(state.data?.translation?.markdown);
      if (force && !window.confirm("确定重新翻译吗？\n\nLitMTrans会按照当前设置重新生成译文，现有译文会保留到新版完成。")) return;
      state.liveTranslationActive = false;
      state.liveTranslationParts = [];
      await runAction("translate", { mode: translationMode, force }, { success: force ? "重新翻译完成" : "全文翻译完成" });
    };
    els["translate-button"].addEventListener("click", () => { void startTranslation(); });
    const openManualTranslation = async () => {
      if (!state.data?.parsed?.markdown) {
        if (!window.confirm("这篇文献尚未解析。是否立即解析？")) return;
        const parsed = await runAction("parse", {}, { success: "解析完成" });
        if (!parsed) return;
      }
      const mode = state.mode === "layout" ? "layout" : "stream";
      const result = await hostCall("manual-translation-command", { mode });
      manualTranslationSteps = [{ command: String(result?.command || ""), response: "" }];
      manualLayoutTranslations = {};
      activeManualTranslationStep = 0;
      renderManualTranslationSteps();
      els["manual-translation-dialog"].showModal();
    };
    const manualStepLabel = index => String(index + 1);
    const renderManualTranslationSteps = () => {
      const step = manualTranslationSteps[activeManualTranslationStep] || { command: "", response: "" };
      els["manual-translation-command"].value = step.command;
      els["manual-translation-response"].value = step.response;
      els["manual-translation-response"].placeholder = step.responseHint || "将AI的回答粘贴到这里";
      for (const id of ["manual-translation-command-tabs", "manual-translation-response-tabs"]) {
        const tabs = els[id];
        tabs.replaceChildren(...manualTranslationSteps.map((_, index) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = `manual-translation-tab${index === activeManualTranslationStep ? " active" : ""}`;
          button.textContent = manualStepLabel(index);
          button.setAttribute("aria-label", `第 ${index + 1} 轮`);
          button.setAttribute("aria-selected", String(index === activeManualTranslationStep));
          button.addEventListener("click", () => { activeManualTranslationStep = index; renderManualTranslationSteps(); });
          return button;
        }));
      }
    };
    els["manual-translate-button"].addEventListener("click", () => { void openManualTranslation(); });
    els["manual-translation-response"].addEventListener("input", () => {
      if (manualTranslationSteps[activeManualTranslationStep]) manualTranslationSteps[activeManualTranslationStep].response = els["manual-translation-response"].value;
    });
    els["copy-manual-translation-command"].addEventListener("click", async () => {
      const command = els["manual-translation-command"].value;
      try {
        await navigator.clipboard.writeText(command);
        setStatus("翻译命令已复制", null, "success");
      } catch (_) {
        els["manual-translation-command"].focus();
        els["manual-translation-command"].select();
        document.execCommand("copy");
        setStatus("翻译命令已复制", null, "success");
      }
    });
    els["render-manual-translation"].addEventListener("click", async () => {
      const response = els["manual-translation-response"].value;
      if (!response.trim()) { setStatus("请先粘贴AI的回答", null, "neutral"); return; }
      const mode = state.mode === "layout" ? "layout" : "stream";
      manualTranslationSteps[activeManualTranslationStep].response = response;
      const responses = manualTranslationSteps.map(step => step.response).filter(Boolean);
      if (mode === "layout") {
        try {
          const merged = await hostCall("manual-translation-merge-response", { mode, translations: manualLayoutTranslations, response });
          manualLayoutTranslations = merged?.translations || manualLayoutTranslations;
          setStatus(`已合并 ${Object.keys(manualLayoutTranslations).length}/${merged?.totalBlocks || "?"} 个文本块`, null, "running");
        } catch (error) {
          lastActionError = String(error?.message || error);
        }
      }
      const result = await runAction("manual-translation-import", { mode, responses: mode === "layout" ? manualLayoutTranslations : responses }, { success: "手动译文已渲染" });
      if (result) {
        els["manual-translation-dialog"].close();
        return;
      }
      try {
        const recovery = await hostCall("manual-translation-recovery-command", { mode, responses: mode === "layout" ? manualLayoutTranslations : responses });
        manualTranslationSteps.push({ command: String(recovery?.command || ""), response: "", responseHint: lastActionError || "上一轮回答未能渲染，请按左侧补救命令继续。" });
        activeManualTranslationStep = manualTranslationSteps.length - 1;
        renderManualTranslationSteps();
        setStatus(`第 ${manualTranslationSteps.length} 轮补救命令已生成`, null, "running");
      } catch (error) { toast(String(error?.message || error), "error"); }
    });
    els["empty-parse-button"].addEventListener("click", () => els["translate-button"].click());
    els["stop-button"].addEventListener("click", async () => {
      await hostCall("stop");
      state.running.clear();
      updateOperationUI();
      setStatus("已请求停止", null, "neutral");
    });
    els["clean-reader-button"].addEventListener("click", () => {
      if (document.body.classList.contains("clean-reader-mode")) exitCleanReader();
      else enterCleanReader();
    });
    const toggleLayoutDebugMode = enabled => {
      const active = typeof enabled === "boolean" ? enabled : !document.body.classList.contains("layout-debug");
      document.body.classList.toggle("layout-debug", active);
      if (els["debug-boxes-check"]) els["debug-boxes-check"].checked = active;
      if (state.settings) state.settings.layoutDevelopmentMode = active;
      if (state.mode === "layout") {
        const pages = [...document.querySelectorAll(".layout-page")];
        fitLayoutPages(pages);
      }
    };
    els["clean-reader-ai-button"].addEventListener("click", () => exitCleanReader({ focusChat: true }));
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && document.body.classList.contains("clean-reader-mode") && !document.querySelector("dialog[open]")) {
        event.preventDefault();
        exitCleanReader();
      }
      else if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === "D" || event.key === "d")) {
        event.preventDefault();
        toggleLayoutDebugMode();
      }
    });
    els["export-pdf-button"].addEventListener("click", () => { void exportCurrentTranslationPDF(); });
    els["settings-button"].addEventListener("click", async () => {
      try { await openSettingsDialog(); }
      catch (error) { toast(error.message, "error"); }
    });
    els["embedded-provider-cards-button"].addEventListener("click", () => {
      renderProviderCards("chat");
      els["provider-cards-dialog"].showModal();
    });
    els["embedded-chat-provider"].addEventListener("change", () => {
      const provider = els["embedded-chat-provider"];
      const profile = state.settings?.chatProviderProfiles?.[provider.value] || {};
      const option = provider.selectedOptions[0];
      els["embedded-chat-base-url"].value = profile.baseURL || option?.dataset.baseURL || "";
      setSelectOptions(els["embedded-chat-model"], [], profile.model || option?.dataset.chatModel || "");
      els["embedded-chat-thinking-mode"].value = profile.thinkingMode || "default";
      setSelectValue(els["embedded-chat-reasoning-effort"], profile.reasoningEffort || "default");
      restoreChatReasoningPreference("embedded-chat");
      els["embedded-chat-api-key"].value = "";
      void hostCall("get-provider-api-key", { provider: provider.value }).then(result => {
        if (provider.value === result.provider) els["embedded-chat-api-key"].value = result.apiKey || "";
      }).catch(error => toast(error.message, "error"));
      updateEmbeddedChatImageSettingsVisibility();
    });
    els["embedded-chat-model"].addEventListener("change", () => {
      restoreChatReasoningPreference("embedded-chat");
      updateEmbeddedChatImageSettingsVisibility();
    });
    els["embedded-chat-api-key"].addEventListener("change", async () => {
      try {
        const result = await hostCall("save-provider-api-key", {
          provider: els["embedded-chat-provider"].value,
          apiKey: els["embedded-chat-api-key"].value.trim()
        });
        els["embedded-chat-api-key-state"].textContent = result.hasAPIKey ? "对话API密钥已保存" : "尚未配置对话API密钥";
      }
      catch (error) { toast(error.message, "error"); }
    });
    els["embedded-refresh-chat-models"].addEventListener("click", async () => {
      const button = els["embedded-refresh-chat-models"];
      try {
        button.disabled = true;
        const received = await hostCall("list-models", {
          purpose: "chat",
          provider: els["embedded-chat-provider"].value,
          baseURL: els["embedded-chat-base-url"].value.trim(),
          apiKey: els["embedded-chat-api-key"].value.trim(),
          currentModel: els["embedded-chat-model"].value.trim()
        });
        const models = received.map(model => typeof model === "string" ? { id: model, label: model } : model);
        const requested = els["embedded-chat-model"].value.trim();
        setSelectOptions(els["embedded-chat-model"], models, requested);
        updateEmbeddedChatImageSettingsVisibility();
        toast(`已读取 ${models.length} 个模型`, "success");
      }
      catch (error) { toast(error.message, "error"); }
      finally { button.disabled = false; }
    });
    els["save-embedded-chat-settings"].addEventListener("click", async () => {
      try {
        const settings = await hostCall("save-settings", embeddedChatSettingsPayload());
        state.settings = settings;
        state.chatRenderMarkdown = settings.chatRenderMarkdown !== false;
        populateSettings(settings);
        populateEmbeddedChatSettings(settings);
        renderChat();
        els["chat-model-settings-dialog"].close();
        toast("对话模型设置已保存");
      }
      catch (error) { toast(error.message, "error"); }
    });
    els["translation-provider-cards-button"].addEventListener("click", () => {
      renderProviderCards("translation");
      els["provider-cards-dialog"].showModal();
    });
    els["provider-cards-button"].addEventListener("click", () => {
      renderProviderCards("chat");
      els["provider-cards-dialog"].showModal();
    });
    els["close-provider-cards"].addEventListener("click", () => els["provider-cards-dialog"].close());
    els["done-provider-cards"].addEventListener("click", () => els["provider-cards-dialog"].close());
    els["provider-card-list"].addEventListener("change", () => loadProviderCardEditor(els["provider-card-list"].value));
    els["new-provider-card"].addEventListener("click", newProviderCard);
    els["save-provider-card"].addEventListener("click", () => {
      void saveProviderCard(false).catch(error => toast(error.message, "error"));
    });
    els["apply-provider-card"].addEventListener("click", () => {
      void saveProviderCard(true).catch(error => toast(error.message, "error"));
    });
    els["delete-provider-card"].addEventListener("click", async () => {
      const card = providerCardByID(state.editingProviderCardID);
      if (!card) return toast("请先选择要删除的记忆卡片", "warning");
      if (!window.confirm(`确定删除记忆卡片“${card.name}”吗？其中保存的API密钥也会一并删除。`)) return;
      try {
        const result = await hostCall("provider-card-delete", { cardID: card.id });
        state.settings = { ...state.settings, providerCards: result.cards || [] };
        state.editingProviderCardID = "";
        renderProviderCards();
        toast(`已删除记忆卡片：${card.name}`);
      }
      catch (error) { toast(error.message, "error"); }
    });
    els["stream-mode-button"].addEventListener("click", () => {
      captureModeScrollPosition();
      state.modeUserSelected = true;
      state.mode = "stream";
      state.syncScroll = Boolean(state.settings?.streamSyncScroll ?? state.syncScroll);
      els["sync-scroll-check"].checked = state.syncScroll;
      renderMode();
      requestAnimationFrame(() => restoreModeScrollPosition("stream"));
      void hostCall("save-reader-mode", { mode: "stream" }).catch(() => {});
      // Offer to translate when the selected reading mode has no result yet.
      if (state.data?.parsed?.markdown && !state.data?.translation?.markdown && !state.running.size) {
        if (window.confirm("当前模式暂无译文。是否立即翻译？")) els["translate-button"].click();
      }
    });
    els["layout-mode-button"].addEventListener("click", () => {
      if (!state.data?.capabilities?.canUseLayoutReader) {
        return toast("排版阅读仅支持PDF附件", "warning");
      }
      captureModeScrollPosition();
      state.modeUserSelected = true;
      state.mode = "layout";
      state.syncScroll = true;
      els["sync-scroll-check"].checked = true;
      renderMode();
      requestAnimationFrame(() => restoreModeScrollPosition("layout"));
      void hostCall("save-reader-mode", { mode: "layout" }).catch(() => {});
    });
    els["both-panes-button"].addEventListener("click", () => {
      state.readerView = "both";
      renderReaderView();
    });
    els["source-only-button"].addEventListener("click", () => {
      state.readerView = "source";
      renderReaderView();
    });
    els["translation-only-button"].addEventListener("click", () => {
      state.readerView = "translation";
      renderReaderView();
    });
    els["translation-scroll"].addEventListener("wheel", event => {
      // Keep Ctrl+wheel reserved for full-page zoom in the translated layout
      // reader. Normal wheel scrolling and every other reader view retain
      // their native behavior.
      if (!event.ctrlKey || state.mode !== "layout" || state.readerView !== "translation") return;
      if (!event.deltaY) return;
      event.preventDefault();
      changeTranslationLayoutPageZoom(event.deltaY, event);
    }, { passive: false });
    els["sync-scroll-check"].addEventListener("change", () => {
      if (state.mode === "layout") {
        state.syncScroll = true;
        els["sync-scroll-check"].checked = true;
        return;
      }
      state.syncScroll = els["sync-scroll-check"].checked;
      const patch = { syncScroll: state.syncScroll, streamSyncScroll: state.syncScroll };
      state.settings = { ...state.settings, ...patch };
      void hostCall("save-settings", patch).catch(() => {});
    });
    els["reader-font-input"].addEventListener("change", () => {
      const requested = Number(els["reader-font-input"].value);
      const automaticLayout = state.mode === "layout" && (!Number.isFinite(requested) || requested <= 0);
      const value = Number.isFinite(requested) && requested > 0 ? requested : (state.mode === "layout" ? 0 : 12);
      els["reader-font-input"].value = automaticLayout ? "" : value;
      const documentID = String(state.data?.item?.documentID || "");
      if (state.mode === "layout" && documentID) {
        const layoutReaderFonts = { ...(state.settings?.layoutReaderFonts || {}) };
        if (value > 0) layoutReaderFonts[documentID] = value;
        else delete layoutReaderFonts[documentID];
        state.layoutFontPt = value;
        state.detectedLayoutFontPt = 0;
        state.settings = { ...state.settings, layoutReaderFonts };
        if (value > 0) document.body.dataset.userBodyFontPt = String(value);
        else delete document.body.dataset.userBodyFontPt;
        void hostCall("save-settings", { layoutReaderFonts }).catch(error => toast(error.message, "error"));
        requestAnimationFrame(() => {
          const pages = [...els["translation-layout"].querySelectorAll(".layout-page")];
          void ensureLayoutFit(pages).then(() => reflectAutomaticLayoutFont(els["translation-layout"]));
        });
      }
      else {
        state.settings = { ...state.settings, readerFontPt: value };
        void hostCall("save-settings", { readerFontPt: value }).catch(error => toast(error.message, "error"));
      }
      document.documentElement.style.setProperty(
        "--reader-font-size",
        `${value || Number(state.settings?.readerFontPt) || 12}pt`
      );
    });
    els["swap-panes-button"].addEventListener("click", () => {
      state.swapped = !state.swapped;
      els["reader-split"].classList.toggle("swapped", state.swapped);
    });
    els["debug-boxes-check"]?.addEventListener("change", () => {
      toggleLayoutDebugMode(els["debug-boxes-check"].checked);
    });
    const submitPaperAITask = async taskType => {
      if (!await ensureParsedBeforeChatSend()) return;
      if (state.running.has("chat")) {
        toast("正在生成回答，请稍候", "warning");
        return;
      }
      const labels = { key_points: "请提炼当前论文的核心要点。", paper_mindmap: "请建立当前论文的完整知识结构图。", paper_logic_flow: "请重建当前论文的研究逻辑与证据链。" };
      state.pendingTaskType = taskType;
      els["chat-input"].value = labels[taskType] || "请分析当前文献。";
      if (document.body.classList.contains("clean-reader-mode")) exitCleanReader({ focusChat: true });
      // Queue after the side rail returns to the layout so the submitted
      // request and its streaming response are visible immediately.
      requestAnimationFrame(() => els["chat-form"].requestSubmit());
    };
    els["key-points-button"].addEventListener("click", () => { void submitPaperAITask("key_points"); });
    els["paper-mindmap-button"].addEventListener("click", () => { void submitPaperAITask("paper_mindmap"); });
    els["paper-logic-flow-button"].addEventListener("click", () => { void submitPaperAITask("paper_logic_flow"); });
    els["log-toggle"].addEventListener("click", () => {
      if (els["log-drawer"].hidden) showOperationLog();
      else els["log-drawer"].hidden = true;
    });
    els["log-close"].addEventListener("click", () => { els["log-drawer"].hidden = true; });
    els["log-clear"].addEventListener("click", () => {
      state.logEntries = [];
      els["log-content"].replaceChildren();
      renderTaskMessages();
    });
    els["settings-advanced"].addEventListener("toggle", () => {
      requestAnimationFrame(() => fitSettingsDialog(els["settings-dialog"]));
    });
    els["settings-dialog"].addEventListener("close", () => {
      els["settings-dialog"].style.height = "auto";
    });

    els["clear-selection-button"].addEventListener("click", () => {
      state.selectedText = "";
      state.referenceQuotes = [];
      renderSelection();
    });
    els["chat-messages"].addEventListener("scroll", () => {
      state.chatFollowLatest = chatIsNearBottom();
    }, { passive: true });
    els["native-pdf-ask-button"].addEventListener("click", askNativePDFSelection);
    window.addEventListener("resize", renderNativePDFSelectionToolbar);
    els["chat-navigator-button"].addEventListener("click", () => {
      const popup = els["chat-navigator-popup"];
      if (!popup || popup.childElementCount < 2) return;
      popup.hidden = !popup.hidden;
    });
    els["system-messages-button"].addEventListener("click", () => {
      void showPersistentTranslationLogs();
    });
    els["close-system-messages"].addEventListener("click", () => els["system-messages-dialog"].close());
    els["clear-chat-button"].addEventListener("click", async () => {
      if (!window.confirm("确定清空当前文献的对话记录吗？\n\n解析结果和译文不会被删除。")) return;
      try {
        state.currentSession = await hostCall("chat-clear", { sessionID: state.currentSession?.id });
        await refreshChatSessions(false);
        renderChat();
        renderPendingDocuments();
        recordSystemMessage("已清空当前文献的对话记录。");
      }
      catch (error) { toast(error.message, "error"); }
    });
    els["remove-pending-documents-button"].addEventListener("click", () => {
      if (!state.pendingDocuments.length) return;
      state.pendingDocuments = [];
      renderPendingDocuments();
      toast("已移除本轮待发送文件。");
    });
    els["chat-document-button"].addEventListener("click", async () => {
      try {
        const result = await hostCall("chat-add-document", {});
        if (result?.cancelled || !result?.document) return;
        if (!state.pendingDocuments.some(item => item.id === result.document.id)) {
          state.pendingDocuments.push(result.document);
        }
        renderPendingDocuments();
        toast(`已添加文档：${result.document.name}`);
      }
      catch (error) {
        if (!error.cancelled) toast(error.message, "error");
      }
    });
    els["chat-image-input"].addEventListener("change", async () => {
      await addImageFiles(els["chat-image-input"].files, { source: "file" });
      els["chat-image-input"].value = "";
    });
    els["image-preview-image"].addEventListener("load", fitPreviewImage);
    els["image-preview-zoom-in"].addEventListener("click", () => applyPreviewScale(state.previewScale * 1.2));
    els["image-preview-zoom-out"].addEventListener("click", () => applyPreviewScale(state.previewScale / 1.2));
    els["image-preview-fit"].addEventListener("click", fitPreviewImage);
    els["image-preview-reuse"].addEventListener("click", reusePreviewImage);
    els["image-preview-copy"].addEventListener("click", copyPreviewImage);
    els["image-preview-save"].addEventListener("click", savePreviewImage);
    els["image-preview-close"].addEventListener("click", () => els["image-preview-dialog"].close());
    els["image-preview-dialog"].addEventListener("close", () => {
      els["image-preview-image"].removeAttribute("src");
      state.previewImage = null;
      state.previewScale = 1;
    });
    const previewStage = els["image-preview-image"].closest(".image-preview-stage");
    previewStage.addEventListener("wheel", event => {
      event.preventDefault();
      applyPreviewScale(state.previewScale * (event.deltaY < 0 ? 1.12 : 1 / 1.12), event);
    }, { passive: false });
    let previewDragging = false;
    let previewStartX = 0;
    let previewStartY = 0;
    let previewStartLeft = 0;
    let previewStartTop = 0;
    previewStage.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      previewDragging = true;
      previewStartX = event.clientX;
      previewStartY = event.clientY;
      previewStartLeft = previewStage.scrollLeft;
      previewStartTop = previewStage.scrollTop;
      previewStage.classList.add("dragging");
      previewStage.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    previewStage.addEventListener("pointermove", event => {
      if (!previewDragging) return;
      previewStage.scrollLeft = previewStartLeft - (event.clientX - previewStartX);
      previewStage.scrollTop = previewStartTop - (event.clientY - previewStartY);
    });
    const stopPreviewDrag = () => {
      previewDragging = false;
      previewStage.classList.remove("dragging");
    };
    previewStage.addEventListener("pointerup", stopPreviewDrag);
    previewStage.addEventListener("pointercancel", stopPreviewDrag);
    els["formula-preview-zoom-in"].addEventListener("click", () => {
      applyFormulaPreviewTransform(state.previewFormulaScale * 1.2);
    });
    els["formula-preview-zoom-out"].addEventListener("click", () => {
      applyFormulaPreviewTransform(state.previewFormulaScale / 1.2);
    });
    els["formula-preview-fit"].addEventListener("click", fitFormulaPreview);
    els["formula-preview-ask"].addEventListener("click", () => {
      if (state.previewFormulaTarget) askLayoutFormula(state.previewFormulaTarget);
      els["formula-preview-dialog"].close();
    });
    els["formula-preview-copy"].addEventListener("click", () => {
      void copyText(state.previewFormulaTeX);
    });
    els["formula-preview-close"].addEventListener("click", () => {
      els["formula-preview-dialog"].close();
    });
    els["formula-preview-dialog"].addEventListener("close", () => {
      els["formula-preview-body"].replaceChildren();
      state.previewFormulaTarget = null;
      state.previewFormulaTeX = "";
      fitFormulaPreview();
    });
    const formulaViewport = els["formula-preview-viewport"];
    formulaViewport.addEventListener("wheel", event => {
      event.preventDefault();
      applyFormulaPreviewTransform(
        state.previewFormulaScale * (event.deltaY < 0 ? 1.12 : 1 / 1.12),
        event
      );
    }, { passive: false });
    let formulaDragging = false;
    let formulaStartX = 0;
    let formulaStartY = 0;
    let formulaOriginX = 0;
    let formulaOriginY = 0;
    formulaViewport.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      formulaDragging = true;
      formulaStartX = event.clientX;
      formulaStartY = event.clientY;
      formulaOriginX = state.previewFormulaX;
      formulaOriginY = state.previewFormulaY;
      formulaViewport.classList.add("dragging");
      formulaViewport.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    formulaViewport.addEventListener("pointermove", event => {
      if (!formulaDragging) return;
      state.previewFormulaX = formulaOriginX + event.clientX - formulaStartX;
      state.previewFormulaY = formulaOriginY + event.clientY - formulaStartY;
      applyFormulaPreviewTransform();
    });
    const stopFormulaDrag = () => {
      formulaDragging = false;
      formulaViewport.classList.remove("dragging");
    };
    formulaViewport.addEventListener("pointerup", stopFormulaDrag);
    formulaViewport.addEventListener("pointercancel", stopFormulaDrag);
    els["chat-input"].addEventListener("paste", event => {
      const itemFiles = Array.from(event.clipboardData?.items || [])
        .filter(item => item.kind === "file")
        .map(item => item.getAsFile()).filter(isImageFileCandidate);
      const directFiles = Array.from(event.clipboardData?.files || []).filter(isImageFileCandidate);
      const seen = new Set();
      const files = [...itemFiles, ...directFiles].filter(file => {
        const key = [file?.name, file?.type, file?.size, file?.lastModified].join("\u001f");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (!files.length) return;
      event.preventDefault();
      void addImageFiles(files, { source: "paste" });
    });
    els["chat-form"].addEventListener("dragover", event => {
      if (Array.from(event.dataTransfer?.files || []).some(isImageFileCandidate)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }
    });
    els["chat-form"].addEventListener("drop", event => {
      const files = Array.from(event.dataTransfer?.files || []).filter(isImageFileCandidate);
      if (!files.length) return;
      event.preventDefault();
      void addImageFiles(files, { source: "drop" });
    });
    els["chat-form"].addEventListener("submit", async event => {
      event.preventDefault();
      const text = els["chat-input"].value.trim();
      const images = state.pendingImages.map(image => ({
        name: image.name,
        mimeType: image.mimeType,
        size: image.size,
        dataURL: image.dataURL,
        source: image.source,
        originalName: image.originalName,
        capturedAt: image.capturedAt,
        width: image.width,
        height: image.height,
        originalWidth: image.originalWidth,
        originalHeight: image.originalHeight,
        optimizedForVision: image.optimizedForVision
      }));
      const documents = state.pendingDocuments.slice();
      const intent = detectDiagramIntent(text);
      const taskType = state.pendingTaskType || intent.taskType;
      // Attach the complete document, use compressed images, and preserve the
      // image/text order defined by Markdown positions.
      const documentOptions = { imageMode: "full_with_images", compressImages: true, sequentialImages: true };
      if ((!text && !images.length && !documents.length && !state.referenceQuotes.length) || state.running.has("chat")) return;
      // The chat service deliberately receives the complete parsed document on
      // the first turn. Keep this check at the send boundary so selections,
      // pasted images, Ctrl+Enter and the ordinary Send button share one
      // confirmation-and-parse path, while a cancelled parse leaves the draft intact.
      if (!await ensureParsedBeforeChatSend()) return;
      state.pendingComposerSubmission = { text, images: state.pendingImages.slice(), documents };
      state.pendingTaskType = "";
      state.chatFollowLatest = true;
      els["chat-input"].value = "";
      state.reasoning = "";
      state.streamingChatText = "";
      try {
        const result = await hostCall("chat-send", {
          sessionID: state.currentSession?.id,
          text,
          images,
          documents,
          documentOptions,
          contextMode: "source",
          selectedText: state.selectedText,
          referenceQuotes: state.referenceQuotes,
          taskType
        });
        state.pendingComposerSubmission = null;
        state.pendingImages = [];
        state.pendingDocuments = [];
        renderPendingImages();
        renderPendingDocuments();
        state.currentSession = result.session;
        state.selectedText = "";
        state.referenceQuotes = [];
        renderSelection();
        await refreshChatSessions(false);
        renderChat();
      }
      catch (error) {
        if (state.pendingComposerSubmission) {
          if (!els["chat-input"].value) els["chat-input"].value = state.pendingComposerSubmission.text || "";
          state.pendingImages = state.pendingComposerSubmission.images || [];
          state.pendingDocuments = state.pendingComposerSubmission.documents || [];
          state.pendingComposerSubmission = null;
          renderPendingImages();
          renderPendingDocuments();
        }
        if (!error.cancelled) toast(error.message, "error");
      }
    });
    els["chat-input"].addEventListener("keydown", event => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        els["chat-form"].requestSubmit();
      }
    });
    for (const [providerID, baseID, modelID, thinkingModeID, reasoningEffortID] of [
      ["setting-provider", "setting-base-url", "setting-model", "setting-thinking-mode", "setting-reasoning-effort"],
      ["setting-chat-provider", "setting-chat-base-url", "setting-chat-model", "setting-chat-thinking-mode", "setting-chat-reasoning-effort"]
    ]) {
      els[providerID].addEventListener("change", () => {
        const chat = providerID === "setting-chat-provider";
        const profilesKey = chat ? "chatProviderProfiles" : "translationProviderProfiles";
        const previous = String(els[providerID].dataset.activeProvider || "");
        if (previous) {
          state.settings[profilesKey] = {
            ...(state.settings?.[profilesKey] || {}),
            [previous]: {
              baseURL: els[baseID].value.trim(),
              model: els[modelID].value.trim(),
              thinkingMode: els[thinkingModeID].value,
              reasoningEffort: els[reasoningEffortID].value
            }
          };
        }
        const option = els[providerID].selectedOptions[0];
        const profile = state.settings?.[profilesKey]?.[els[providerID].value] || {};
        els[baseID].value = profile.baseURL || option?.dataset.baseURL || "";
        setSelectOptions(els[modelID], [], profile.model ?? (chat ? option?.dataset.chatModel : option?.dataset.model) ?? "");
        setSelectValue(els[thinkingModeID], profile.thinkingMode || "default");
        setSelectValue(els[reasoningEffortID], profile.reasoningEffort || "default");
        if (chat) restoreChatReasoningPreference("setting-chat");
        els[providerID].dataset.activeProvider = els[providerID].value;
        const selectedProvider = els[providerID].value;
        const keyInput = els[chat ? "setting-chat-api-key" : "setting-api-key"];
        keyInput.value = "";
        void hostCall("get-provider-api-key", { provider: selectedProvider }).then(result => {
          if (els[providerID].value === selectedProvider) {
            keyInput.value = result.apiKey || "";
            if (!chat && !isWebMachineTranslationProvider(selectedProvider)
              && els["setting-chat-uses-translation-model"].checked) {
              syncChatSettingsFromTranslation();
            }
          }
        }).catch(error => toast(error.message, "error"));
        if (!chat) {
          updateWebMachineTranslationSettings({ previousProvider: previous, syncChatMode: true });
          updateDeepSeekFastLayoutControl();
          updateChatModelSectionVisibility();
        }
        updateProviderLabel(chat ? "setting-chat-" : "setting-");
        if (chat) updateChatImageSettingsVisibility();
      });
    }
    els["setting-chat-model"].addEventListener("change", () => {
      restoreChatReasoningPreference("setting-chat");
      updateChatImageSettingsVisibility();
    });
    const saveCredential = async (inputID, providerID = "") => {
      const value = els[inputID].value.trim();
      try {
        if (providerID) await hostCall("save-provider-api-key", { provider: els[providerID].value, apiKey: value });
        else await hostCall("save-mineru-token", { token: value });
      }
      catch (error) { toast(error.message, "error"); }
    };
    els["setting-api-key"].addEventListener("change", () => { void saveCredential("setting-api-key", "setting-provider"); });
    els["setting-base-url"].addEventListener("input", () => updateDeepSeekFastLayoutControl());
    els["setting-deepseek-fast-layout"].addEventListener("change", () => updateDeepSeekFastLayoutControl());
    els["setting-chat-api-key"].addEventListener("change", () => { void saveCredential("setting-chat-api-key", "setting-chat-provider"); });
    els["setting-mineru-token"].addEventListener("change", () => { void saveCredential("setting-mineru-token"); });
    const refreshModels = async (purpose) => {
      const chat = purpose === "chat";
      const button = els[chat ? "refresh-chat-models-button" : "refresh-models-button"];
      try {
        button.disabled = true;
        const receivedModels = await hostCall("list-models", {
          purpose,
          provider: els[chat ? "setting-chat-provider" : "setting-provider"].value,
          baseURL: els[chat ? "setting-chat-base-url" : "setting-base-url"].value.trim(),
          apiKey: els[chat ? "setting-chat-api-key" : "setting-api-key"].value.trim(),
          currentModel: els[chat ? "setting-chat-model" : "setting-model"].value.trim()
        });
        const modelOptions = receivedModels.map(model =>
          typeof model === "string" ? { id: model, label: model } : model
        );
        const models = modelOptions.map(model => String(model.id || "")).filter(Boolean);
        const modelInput = els[chat ? "setting-chat-model" : "setting-model"];
        const requested = modelInput.value.trim();
        const provider = els[chat ? "setting-chat-provider" : "setting-provider"].value;
        const selected = chat
          ? U.chooseChatModel(models, requested)
          : U.chooseTranslationModel(provider, models, requested);
        setSelectOptions(modelInput, modelOptions, selected || requested);
        if (selected) modelInput.value = selected;
        probeSiliconflowModel(purpose);
        if (chat) updateChatImageSettingsVisibility();
        toast(
          requested && !models.includes(requested) && selected
            ? `上次模型“${requested}”已不可用，已改用“${selected}”`
            : `已读取 ${models.length} 个模型${selected ? ` · 当前 ${selected}` : ""}`,
          requested && !models.includes(requested) ? "warning" : "success"
        );
      }
      catch (error) { toast(error.message, "error"); }
      finally { button.disabled = false; }
    };
    const probeSiliconflowModel = (purpose) => {
      const chat = purpose === "chat";
      const provider = els[chat ? "setting-chat-provider" : "setting-provider"].value;
      const model = els[chat ? "setting-chat-model" : "setting-model"].value.trim();
      if (String(provider || "").toLowerCase() !== "siliconflow" || !model) return;
      void hostCall("probe-siliconflow-thinking", {
        purpose,
        provider,
        baseURL: els[chat ? "setting-chat-base-url" : "setting-base-url"].value.trim(),
        apiKey: els[chat ? "setting-chat-api-key" : "setting-api-key"].value.trim(),
        model
      }).then(result => {
        if (result?.supported === true) toast("当前SiliconFlow模型支持思考模式", "success");
        else if (result?.supported === false) toast("当前SiliconFlow模型不支持思考模式", "warning");
      }).catch(() => {});
    };
    els["refresh-models-button"].addEventListener("click", () => refreshModels("translation"));
    els["refresh-chat-models-button"].addEventListener("click", () => refreshModels("chat"));
    els["setting-model"].addEventListener("change", () => probeSiliconflowModel("translation"));
    els["setting-chat-model"].addEventListener("change", () => probeSiliconflowModel("chat"));
    els["setting-chat-uses-translation-model"].addEventListener("change", () => {
      if (isWebMachineTranslationProvider(els["setting-provider"].value)) {
        els["setting-chat-uses-translation-model"].checked = false;
      }
      updateChatModelSectionVisibility();
    });
    els["provider-card-api-key"].addEventListener("input", () => {
      const hasValue = Boolean(els["provider-card-api-key"].value.trim());
      const existing = providerCardByID(state.editingProviderCardID);
      if (hasValue) setProviderCardAPIKeyState(existing ? "待更新" : "待保存", "pending");
      else if (existing?.hasAPIKey) setProviderCardAPIKeyState("保存后删除", "delete");
      else setProviderCardAPIKeyState("未配置");
    });
    els["restore-key-points-prompt"].addEventListener("click", () => {
      els["setting-key-points-prompt"].value = state.settings?.keyPointsDefaultPrompt || "";
    });
    els["add-reference-button"].addEventListener("click", async () => {
      try {
        state.referencePaths = await hostCall("select-reference-files", { paths: state.referencePaths });
        renderReferencePaths();
      }
      catch (error) {
        toast(error.message, "error");
      }
    });
    els["remove-reference-button"].addEventListener("click", () => {
      const selected = new Set([...els["setting-reference-list"].selectedOptions].map(option => option.value));
      state.referencePaths = state.referencePaths.filter(path => !selected.has(path));
      renderReferencePaths();
    });
    els["clear-reference-button"].addEventListener("click", () => {
      state.referencePaths = [];
      els["custom-translation-instruction-input"].value = "";
      renderReferencePaths();
      renderCustomTranslationInstructionPreview();
    });
    els["edit-custom-translation-instruction"].addEventListener("click", () => {
      els["custom-translation-instruction-dialog"].showModal();
    });
    els["save-custom-translation-instruction"].addEventListener("click", () => {
      els["custom-translation-instruction-dialog"].close();
      renderCustomTranslationInstructionPreview();
    });
    els["edit-custom-translation-instruction-preview"].addEventListener("click", () => {
      els["custom-translation-instruction-dialog"].showModal();
    });
    els["save-settings-button"].addEventListener("click", async () => {
      try {
        const settings = await hostCall("save-settings", settingsPayload());
        state.settings = settings;
        document.body.classList.toggle("layout-debug", false);
        state.chatRenderMarkdown = settings.chatRenderMarkdown !== false;
        state.syncScroll = state.mode === "layout"
          ? true
          : Boolean(settings.streamSyncScroll ?? settings.syncScroll);
        els["sync-scroll-check"].checked = state.syncScroll;
        populateSettings(settings);
        renderMode();
        // Connection/model settings affect future translation requests only.
        // Rebuilding an already fitted layout here discards its stable DOM and
        // can re-measure it while the settings dialog is still changing the
        // workbench geometry. Keep the completed reading view intact.
        els["settings-dialog"].close();
        toast("设置已保存");
      }
      catch (error) { toast(error.message, "error"); }
    });
    els["clear-document-button"].addEventListener("click", async () => {
      if (!window.confirm("确定清除这篇文献的解析结果、译文和对话记录吗？\n\nZotero中的原始附件不会被修改。")) return;
      try {
        setData(await hostCall("clear-document"));
        els["settings-dialog"].close();
        toast("这篇文献的数据已清除");
      }
      catch (error) { toast(error.message, "error"); }
    });

    bindScrollSync();
    bindSplitHandle();
    bindSidebarSplitHandle();
    bindLayoutInteractions();
  }

  async function waitForHost() {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (hostFunction()) {
        await initialize();
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    setStatus("LitMTrans未能正常启动，请关闭此标签页后重试", 0, "error");
  }

  document.addEventListener("DOMContentLoaded", () => {
    cacheElements();
    bindEvents();
    LitMTrans.DiagramViewer?.init?.();
    syncSplitHandleOrientation();
    window.addEventListener("resize", () => {
      syncWorkbenchViewport();
      syncSplitHandleOrientation();
    });
    void waitForHost();
  }, { once: true });
  // Limit fitting to the pages scheduled by the reader.
  let activeFitPages = null;
  // This namespace invalidates incompatible browser-side fit caches.
  const fitCacheVersion = 'layout-fit-v43-logical-span-lines';
  // A narrow transition may back off without changing the shared body font.
  const ALLOW_INHERITED_BODY_FONT_BACKOFF = true;
  let bodyIterationInspectionRound = 0;

  // Retain the first collision for the optional layout inspection view.
  function isBodyIterationNode(node) {
    return Boolean(node && node.matches && node.matches(
      '.layout-flow-stream[data-style-kind="body_text"][data-flow-kind="text"]:not([data-body-inherited="1"])'
    ));
  }

  function bodyIterationNodes(nodes) {
    return (nodes || []).filter(isBodyIterationNode);
  }

  // Show fitting diagnostics only in the inspection view.
  function setDiagnosticTitle(node, text) {
    if (!node) return;
    node.title = document.body.classList.contains('layout-debug') ? (text || '') : '';
  }

  function resetBodyIterationInspection(nodes) {
    for (const node of bodyIterationNodes(nodes)) {
      node.classList.remove('body-iteration-collision');
      node.dataset.bodyIterationCollisionRound = '';
      node.dataset.bodyIterationCollisionPhase = '';
      node.dataset.bodyIterationLastRound = '0';
    }
  }

  function beginBodyIterationProbe(nodes, phase) {
    const bodyNodes = bodyIterationNodes(nodes);
    if (!bodyNodes.length) return null;
    const round = ++bodyIterationInspectionRound;
    for (const node of bodyNodes) {
      node.dataset.bodyIterationLastRound = String(round);
    }
    return { round, phase };
  }

  function recordBodyIterationCollision(collision, probe) {
    if (!probe || !collision || !isBodyIterationNode(collision.source)) return;
    const source = collision.source;
    if (!source.dataset.bodyIterationCollisionRound) {
      source.dataset.bodyIterationCollisionRound = String(probe.round);
      source.dataset.bodyIterationCollisionPhase = probe.phase;
    }
    source.classList.add('body-iteration-collision');
  }

  function publishBodyIterationInspection(nodes) {
    const bodyNodes = bodyIterationNodes(nodes);
    const globalLimiter = bodyNodes.find((node) => node.dataset.bodyIterationCollisionRound);
    const globalLimiterRound = globalLimiter ? globalLimiter.dataset.bodyIterationCollisionRound : '';
    const globalLimiterPhase = globalLimiter ? globalLimiter.dataset.bodyIterationCollisionPhase : '';
    for (const node of bodyNodes) {
      const fontSize = layoutControlFontSize(node, 0);
      const lineRatio = parseFloat(node.style.lineHeight || node.dataset.lineRatio || '0') || 0;
      const collisionRound = node.dataset.bodyIterationCollisionRound;
      const lastRound = node.dataset.bodyIterationLastRound || '0';
      const globalText = globalLimiterRound
        ? `全文已收敛 R${lastRound} · 全局限制 R${globalLimiterRound}（${globalLimiterPhase || 'probe'}）`
        : `全文已收敛 R${lastRound} · 未发现碰撞`;
      const localText = collisionRound ? '当前框为限制源' : '当前框无碰撞';
      node.dataset.fitLabel = `正文迭代 · ${globalText} · ${localText} · 字号 ${fontSize.toFixed(2)}px · 行距 ${lineRatio.toFixed(3)}`;
      node.dataset.fitDebug = node.dataset.fitLabel;
      setDiagnosticTitle(node, node.dataset.fitLabel);
    }
  }

  function publishCachedBodyIterationInspection() {
    const nodes = Array.from(document.querySelectorAll(
      '.layout-flow-stream[data-style-kind="body_text"][data-flow-kind="text"]:not([data-body-inherited="1"])'
    ));
    const bodyNodes = bodyIterationNodes(nodes);
    const globalLimiter = bodyNodes.find((node) => node.dataset.bodyIterationCollisionRound);
    const globalText = globalLimiter
      ? `全文已收敛（完整缓存） · 全局限制 R${globalLimiter.dataset.bodyIterationCollisionRound || '?'}（${globalLimiter.dataset.bodyIterationCollisionPhase || 'probe'}）`
      : '全文已收敛（完整缓存）';
    for (const node of bodyNodes) {
      const fontSize = layoutControlFontSize(node, 0);
      const lineRatio = parseFloat(node.style.lineHeight || node.dataset.lineRatio || '0') || 0;
      const localText = node === globalLimiter ? '当前框为限制源' : '当前框无碰撞';
      const label = `正文迭代 · ${globalText} · ${localText} · 字号 ${fontSize.toFixed(2)}px · 行距 ${lineRatio.toFixed(3)}`;
      node.dataset.fitLabel = label;
      node.dataset.fitDebug = label;
      setDiagnosticTitle(node, label);
    }
  }

  function scopedNodes(selector) {
    const nodes = Array.from(document.querySelectorAll(selector));
    if (!activeFitPages) return nodes;
    return nodes.filter((node) => activeFitPages.has(node.closest('.layout-page-wrap')));
  }

  function fitCacheKey() {
    const fingerprint = document.body ? document.body.dataset.layoutCacheKey : '';
    const scope = document.body ? document.body.dataset.layoutCacheScope : '';
    if (!fingerprint || !scope) return '';
    return `${fitCacheVersion}:${scope}:${fingerprint}`;
  }

  function fitCacheNodes() {
    return Array.from(document.querySelectorAll('.layout-flow-stream, .layout-block'));
  }

  function restoreFitCache() {
    const key = fitCacheKey();
    if (!key) return false;
    try {
      const warm = window.__mineruInitialFitCache;
      const payload = warm && warm.key === key
        ? warm.payload
        : JSON.parse(localStorage.getItem(key) || 'null');
      const nodes = fitCacheNodes();
      if (!payload || payload.complete !== true || payload.count !== nodes.length || !Array.isArray(payload.styles)) return false;
      for (let index = 0; index < nodes.length; index += 1) {
        const value = payload.styles[index];
        if (!value) continue;
        const node = nodes[index];
        if (value.f) node.style.fontSize = value.f;
        if (value.l) node.style.lineHeight = value.l;
        if (value.o) node.dataset.originalLines = value.o;
        if (value.n === '1' && value.w) {
          node.style.width = value.w;
          node.style.whiteSpace = 'nowrap';
          node.dataset.shortTitleNoWrap = '1';
        }
      }
      const inspection = payload.bodyInspection || {};
      const cachedRound = String(inspection.lastRound || '0');
      for (const node of bodyIterationNodes(nodes)) node.dataset.bodyIterationLastRound = cachedRound;
      const limiterIndex = Number(inspection.limiterIndex);
      const limiter = Number.isInteger(limiterIndex) ? nodes[limiterIndex] : null;
      if (isBodyIterationNode(limiter)) {
        limiter.dataset.bodyIterationCollisionRound = String(inspection.limiterRound || '?');
        limiter.dataset.bodyIterationCollisionPhase = String(inspection.limiterPhase || 'probe');
        limiter.classList.add('body-iteration-collision');
      }
      document.body.dataset.layoutFitCached = '1';
      publishCachedBodyIterationInspection();
      return true;
    } catch (_error) {
      return false;
    }
  }

  function saveFitCache() {
    const key = fitCacheKey();
    if (!key) return;
    try {
      const nodes = fitCacheNodes();
      const styles = nodes.map((node) => ({
        f: node.style.fontSize || '',
        l: node.style.lineHeight || '',
        o: node.dataset.originalLines || '',
        n: node.dataset.shortTitleNoWrap === '1' ? '1' : '',
        w: node.dataset.shortTitleNoWrap === '1' ? (node.style.width || '') : '',
      }));
      const bodyNodes = bodyIterationNodes(nodes);
      const limiter = bodyNodes.find((node) => node.dataset.bodyIterationCollisionRound);
      const bodyInspection = {
        lastRound: Math.max(0, ...bodyNodes.map((node) => Number(node.dataset.bodyIterationLastRound || 0))),
        limiterIndex: limiter ? nodes.indexOf(limiter) : -1,
        limiterRound: limiter ? String(limiter.dataset.bodyIterationCollisionRound || '') : '',
        limiterPhase: limiter ? String(limiter.dataset.bodyIterationCollisionPhase || '') : '',
      };
      const scope = document.body ? document.body.dataset.layoutCacheScope : '';
      const stalePrefix = scope ? `${fitCacheVersion}:${scope}:` : '';
      if (stalePrefix) {
        const staleKeys = [];
        for (let index = 0; index < localStorage.length; index += 1) {
          const candidate = localStorage.key(index) || '';
          if (candidate !== key && candidate.startsWith(stalePrefix)) staleKeys.push(candidate);
        }
        for (const staleKey of staleKeys) localStorage.removeItem(staleKey);
      }
      localStorage.setItem(key, JSON.stringify({ complete: true, count: nodes.length, styles, bodyInspection }));
    } catch (_error) {
      // localStorage may be unavailable for file URLs or over quota.
    }
  }

  function measureTextBand(el) {
    const hostRect = el.getBoundingClientRect();
    const scaleY = hostRect.height > 0 && el.offsetHeight > 0 ? hostRect.height / el.offsetHeight : 1;
    const walker = document.createTreeWalker(
      el,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.textContent || !node.textContent.trim()) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.closest(
            '.mjx-assistive-mml, .katex-mathml, .layout-line-debug-box, .layout-collision-debug-layer'
          )) return NodeFilter.FILTER_REJECT;
          // KaTeX marks its visible HTML glyph tree aria-hidden because the
          // sibling MathML tree owns accessibility. Reject ordinary hidden
          // UI text, but keep that visible glyph tree measurable.
          if (parent.closest('[aria-hidden="true"]') && !parent.closest('.katex-html')) {
            return NodeFilter.FILTER_REJECT;
          }
          const style = getComputedStyle(parent);
          return style.display !== 'none' && style.visibility !== 'hidden'
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        }
      }
    );
    const range = document.createRange();
    let firstTop = null;
    let lastBottom = 0;
    let hasText = false;
    let node;
    while ((node = walker.nextNode())) {
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0.5 && rect.height > 0.5);
      for (const rect of rects) {
        const top = (rect.top - hostRect.top) / scaleY;
        const bottom = (rect.bottom - hostRect.top) / scaleY;
        if (firstTop === null || top < firstTop) firstTop = top;
        if (bottom > lastBottom) lastBottom = bottom;
        hasText = true;
      }
    }
    return {
      hasText,
      firstTop: firstTop ?? 0,
      lastBottom,
    };
  }

  // Layout fitting uses source PDF coordinates. The reader composes the page
  // at a canonical width of 920px, so DOM offsets and Range rectangles are
  // larger by this factor. Convert
  // all collision geometry back to source-page units before applying the
  // original fitter's fixed 1px/1.5px tolerances.
  function layoutPageCoordinateScale(page) {
    const sourceWidth = Number(page?.dataset?.sourceWidth || 0);
    const renderedWidth = Number(page?.offsetWidth || 0);
    return sourceWidth > 0 && renderedWidth > 0
      ? renderedWidth / sourceWidth
      : 1;
  }

  function layoutPageSourceSize(page) {
    const coordinateScale = layoutPageCoordinateScale(page);
    const sourceWidth = Number(page?.dataset?.sourceWidth || 0);
    const sourceHeight = Number(page?.dataset?.sourceHeight || 0);
    return {
      width: sourceWidth > 0 ? sourceWidth : Number(page?.offsetWidth || 0) / coordinateScale,
      height: sourceHeight > 0 ? sourceHeight : Number(page?.offsetHeight || 0) / coordinateScale,
    };
  }

  function textRectsInPage(el) {
    const page = el.closest('.layout-page');
    if (!page) return [];
    const pageRect = page.getBoundingClientRect();
    const scaleX = page.offsetWidth > 0 ? pageRect.width / page.offsetWidth : 1;
    const scaleY = page.offsetHeight > 0 ? pageRect.height / page.offsetHeight : 1;
    const coordinateScale = layoutPageCoordinateScale(page);
    const walker = document.createTreeWalker(
      el,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.textContent || !node.textContent.trim()) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.closest(
            '.mjx-assistive-mml, .katex-mathml, .layout-line-debug-box, .layout-collision-debug-layer'
          )) return NodeFilter.FILTER_REJECT;
          if (parent.closest('[aria-hidden="true"]') && !parent.closest('.katex-html')) {
            return NodeFilter.FILTER_REJECT;
          }
          const style = getComputedStyle(parent);
          return style.display !== 'none' && style.visibility !== 'hidden'
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        }
      }
    );
    const range = document.createRange();
    const rects = [];
    let node;
    while ((node = walker.nextNode())) {
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width <= 0.5 || rect.height <= 0.5) continue;
        rects.push({
          left: (rect.left - pageRect.left) / scaleX / coordinateScale,
          top: (rect.top - pageRect.top) / scaleY / coordinateScale,
          right: (rect.right - pageRect.left) / scaleX / coordinateScale,
          bottom: (rect.bottom - pageRect.top) / scaleY / coordinateScale,
        });
      }
    }
    return rects;
  }

  function viewportRectInPage(page, rect) {
    const pageRect = page.getBoundingClientRect();
    const scaleX = page.offsetWidth > 0 ? pageRect.width / page.offsetWidth : 1;
    const scaleY = page.offsetHeight > 0 ? pageRect.height / page.offsetHeight : 1;
    const coordinateScale = layoutPageCoordinateScale(page);
    return {
      left: (rect.left - pageRect.left) / scaleX / coordinateScale,
      top: (rect.top - pageRect.top) / scaleY / coordinateScale,
      right: (rect.right - pageRect.left) / scaleX / coordinateScale,
      bottom: (rect.bottom - pageRect.top) / scaleY / coordinateScale,
    };
  }

  // 正文专用的内容几何：文字取每个可见行的 Range rect；公式取 MathJax
  // 完成排版后的容器；图片和表格取实际元素的渲染矩形。没有可测内容时回退到块框。
  function renderedContentRectsInPage(el) {
    const page = el && el.closest ? el.closest('.layout-page') : null;
    if (!page) return [];
    const rects = textRectsInPage(el);
    const visualNodes = el.querySelectorAll
      ? el.querySelectorAll('mjx-container, img, table, svg, canvas')
      : [];
    const seen = new Set();
    for (const node of visualNodes) {
      if (!node || seen.has(node)) continue;
      seen.add(node);
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0.5 || rect.height <= 0.5) continue;
      rects.push(viewportRectInPage(page, rect));
    }
    return rects.length ? rects : [elementBoxInPage(el)];
  }

  function elementBoxInPage(el) {
    const page = el.closest('.layout-page');
    const coordinateScale = layoutPageCoordinateScale(page);
    return {
      left: el.offsetLeft / coordinateScale,
      top: el.offsetTop / coordinateScale,
      right: (el.offsetLeft + el.offsetWidth) / coordinateScale,
      bottom: (el.offsetTop + el.offsetHeight) / coordinateScale,
    };
  }

  function singleLineTextExceedsPage(node, tolerance = 1.5) {
    const page = node.closest('.layout-page');
    if (!page) return false;
    const pageWidth = layoutPageSourceSize(page).width;
    if (pageWidth <= 0) return false;
    const textRects = textRectsInPage(node);
    if (!textRects.length) return false;
    return textRects.some((rect) => rect.left < -tolerance || rect.right > pageWidth + tolerance);
  }

  function demoteFalseSingleLineText(pages = null) {
    const selector = [
      '.layout-flow-stream.debug-text[data-flow-kind="text"][data-original-lines="single"]',
      '.layout-block.type-text[data-original-lines="single"]',
    ].join(', ');
    const nodes = Array.isArray(pages)
      ? pages.flatMap(page => [...page.querySelectorAll(selector)])
      : scopedNodes(selector);
    for (const node of nodes) {
      if (!singleLineTextExceedsPage(node)) continue;
      node.dataset.originalLines = 'multi';
      node.dataset.singleLineAlign = 'left';
      node.dataset.fitLabel = node.dataset.fitLabel || 'DEMOTED single->multi';
      node.dataset.fitDebug = [
        'single line exceeded page bounds',
        `self=${blockDebugName(node)}`,
      ].join(' ');
      setDiagnosticTitle(node, node.dataset.fitDebug);
    }
  }

  function rectsOverlap(a, b, padding) {
    return a.left < b.right - padding &&
      a.right > b.left + padding &&
      a.top < b.bottom - padding &&
      a.bottom > b.top + padding;
  }

  // Conservative broad-phase envelope for rendered text rectangles. All
  // candidates still reach the exact per-rectangle test below, so this can
  // only avoid unnecessary work; it cannot hide a real glyph collision.
  function rectUnion(rects) {
    if (!rects || !rects.length) return null;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const rect of rects) {
      if (!rect) continue;
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    }
    return Number.isFinite(left) ? { left, top, right, bottom } : null;
  }

  function horizontalBoxesOverlap(a, b, padding = 0) {
    return a.left < b.right - padding && a.right > b.left + padding;
  }

  function blockDebugName(el) {
    if (!el) return 'unknown';
    const role = el.dataset.styleKind || el.dataset.flowKind || '';
    const classes = Array.from(el.classList || []).filter((name) => (
      name.startsWith('debug-') || name.startsWith('type-') || name === 'from-list' || name === 'refs'
    ));
    const box = elementBoxInPage(el);
    const text = (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 42);
    return [
      role || 'block',
      classes.join('.'),
      `@${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.right - box.left)}x${Math.round(box.bottom - box.top)}`,
      text
    ].filter(Boolean).join(' ');
  }

  function textCollisionDetails(nodes, options = {}) {
    const nodeSet = new Set(nodes);
    const renderedRectCache = new Map();
    const includeGroupPeers = Boolean(options.includeGroupPeers);
    const ignoreTopOverflow = Boolean(options.ignoreTopOverflow);
    const checkAllTextForCollisions = Boolean(options.checkAllTextForCollisions);
    const avoidPageOverflow = Boolean(options.avoidPageOverflow);
    const bodyColumnIndependentFit = Boolean(options.bodyColumnIndependentFit);
    for (const node of nodes) {
      const page = node.closest('.layout-page');
      if (!page) continue;
      const own = elementBoxInPage(node);
      const sharedEdgeTolerance = Number.isFinite(options.sharedEdgeTolerance)
        ? options.sharedEdgeTolerance
        : 0;
      const sharedHorizontalEdgeTolerance = Number.isFinite(options.sharedHorizontalEdgeTolerance)
        ? options.sharedHorizontalEdgeTolerance
        : 0;
      const ignoreNodeTopOverflow = ignoreTopOverflow || (
        Boolean(options.ignoreBodyTopOverflow) && node.dataset.styleKind === 'body_text'
      );
      const sourceIsBodyText = node.dataset.styleKind === 'body_text';
      // 每个文本源都逐行检测自身实际文字。区别仅在障碍物：正文迭代以实际
      // 内容为障碍；其它文本迭代以布局边框为障碍。
      const sourceRects = textRectsInPage(node).filter((rect) => {
        return checkAllTextForCollisions || rect.bottom > own.bottom + 1 ||
          (!ignoreNodeTopOverflow && rect.top < own.top - 1) ||
          rect.left < own.left - 1 ||
          rect.right > own.right + 1;
      });
      if (!sourceRects.length) continue;
      const barriers = Array.from(page.querySelectorAll('.layout-flow-stream, .layout-block'))
        .filter((candidate) => candidate !== node && (includeGroupPeers || !nodeSet.has(candidate)))
        .map((element) => {
          const box = elementBoxInPage(element);
          // 正文迭代：正文实际文字对所有块的实际内容；其它文本迭代：自己的
          // 实际文字对所有块的边框。这样正文不受空白边框的保守限制，而题注、
          // 标题等仍以稳定的布局边框作为外部约束。
          const barrierUsesTextGeometry = Boolean(options.bodyTextCollisionGeometry) &&
            sourceIsBodyText;
          const contentGeometry = barrierUsesTextGeometry
            ? (renderedRectCache.get(element) || (() => {
              const rects = renderedContentRectsInPage(element);
              const geometry = { rects, bounds: rectUnion(rects) || box };
              renderedRectCache.set(element, geometry);
              return geometry;
            })())
            : { rects: [box], bounds: box };
          return { element, box, contentRects: contentGeometry.rects, contentBounds: contentGeometry.bounds };
        });
      for (const rect of sourceRects) {
        const pageSize = layoutPageSourceSize(page);
        if (avoidPageOverflow && (
          rect.left < -1.5 || rect.top < -1.5 ||
          rect.right > pageSize.width + 1.5 || rect.bottom > pageSize.height + 1.5
        )) {
          return {
            source: node,
            blocker: null,
            rect,
            sourceName: blockDebugName(node),
            blockerName: 'page-boundary',
          };
        }
        const hit = barriers.find((barrier) => {
          // 正文的字号填充只受同列（或原始框已相互侵入）的块约束。
          // 并列栏即使处于同一高度，也不应互相压低字号；页面左右越界仍由
          // avoidPageOverflow 单独保护。这里按源框投影而非文字墨迹判断，故仍能
          // 捕获错误扩宽的正文框和向下增长压到同列块的情形。
          if (bodyColumnIndependentFit && node.dataset.styleKind === 'body_text' &&
              !horizontalBoxesOverlap(own, barrier.box, 1.5)) {
            return false;
          }
          if (!rectsOverlap(rect, barrier.contentBounds, 1.5)) return false;
          const contentHit = barrier.contentRects.some((contentRect) => rectsOverlap(rect, contentRect, 1.5));
          if (!contentHit) return false;
          // Adjacent source bboxes can overlap by a rounding pixel. Ignore only
          // that upper shared edge for body text; horizontal and lower-edge
          // collisions from the same first line are still enforced.
          if (ignoreNodeTopOverflow && rect.top < own.top && barrier.box.bottom <= own.top + 1.5) {
            return false;
          }
          // Inline math and justified CJK glyphs can overhang a column edge by
          // a few pixels even though the line box itself remains in-column.
          // Treat only a shallow overhang across an exactly shared vertical
          // edge as optical ink; any deeper intrusion remains a collision.
          const sharesRightEdge = Math.abs(own.right - barrier.box.left) <= 1.5;
          const sharesLeftEdge = Math.abs(own.left - barrier.box.right) <= 1.5;
          if (sharedEdgeTolerance > 0 && (
            (sharesRightEdge && rect.right <= own.right + sharedEdgeTolerance) ||
            (sharesLeftEdge && rect.left >= own.left - sharedEdgeTolerance)
          )) {
            return false;
          }
          const sharesBottomEdge = Math.abs(own.bottom - barrier.box.top) <= 1.5;
          const sharesTopEdge = Math.abs(own.top - barrier.box.bottom) <= 1.5;
          if (sharedHorizontalEdgeTolerance > 0 && (
            (sharesBottomEdge && rect.bottom <= own.bottom + sharedHorizontalEdgeTolerance) ||
            (sharesTopEdge && rect.top >= own.top - sharedHorizontalEdgeTolerance)
          )) {
            return false;
          }
          return true;
        });
        if (hit) {
          return {
            source: node,
            blocker: hit.element,
            rect,
            sourceName: blockDebugName(node),
            blockerName: blockDebugName(hit.element),
          };
        }
      }
    }
    return null;
  }

  function applyGroup(nodes, fontSize, lineRatio) {
    for (const node of nodes) {
      if (!node || !node.style) continue;
      const coordinateScale = Number(node.dataset.layoutFontScale || 1);
      node.style.fontSize = `${(fontSize * coordinateScale).toFixed(2)}px`;
      node.style.lineHeight = lineRatio.toFixed(3);
    }
  }

  function layoutControlFontSize(node, fallback = 8) {
    const rendered = parseFloat(node?.style?.fontSize || '');
    const coordinateScale = Number(node?.dataset?.layoutFontScale || 1);
    return Number.isFinite(rendered) && rendered > 0
      ? rendered / Math.max(.0001, coordinateScale)
      : (parseFloat(node?.dataset?.baseFont || String(fallback)) || fallback);
  }

  function measureGroup(nodes) {
    let overflow = false;
    let allReachedBand = true;
    let maxBottomGap = 0;
    let details = [];
    for (const node of nodes) {
      if (!node || !node.style) continue;
      const pageHeight = parseFloat(node.dataset.pageHeight || "792");
      const fitBandRatio = parseFloat(node.dataset.fitBandRatio || "");
      const band = Number.isFinite(fitBandRatio)
        ? Math.max(1.0, node.clientHeight * fitBandRatio)
        : pageHeight * 0.02;
      const metrics = measureTextBand(node);
      const coordinateScale = layoutPageCoordinateScale(node.closest('.layout-page'));
      const overflowTolerance = 1.5 * coordinateScale;
      const bottomGap = Math.max(0, node.clientHeight - metrics.lastBottom);
      const overflowAmount = Math.max(
        0,
        metrics.lastBottom - node.clientHeight - overflowTolerance,
        node.dataset.styleKind === 'body_text' ? 0 : -metrics.firstTop - overflowTolerance
      );
      maxBottomGap = Math.max(maxBottomGap, bottomGap);
      if (overflowAmount > 0.5) {
        overflow = true;
      }
      if (!metrics.hasText || bottomGap > band) {
        allReachedBand = false;
      }
      details.push({
        node,
        hasText: metrics.hasText,
        bottomGap,
        band,
        overflowAmount,
        reachedBand: metrics.hasText && bottomGap <= band,
      });
    }
    return { overflow, allReachedBand, maxBottomGap, details };
  }

  function measureAt(nodes, fontSize, lineRatio) {
    applyGroup(nodes, fontSize, lineRatio);
    return measureGroup(nodes);
  }

  function wouldCollideWithBlocks(nodes, options) {
    if (!options.avoidBlockOverlap) return false;
    return Boolean(textCollisionDetails(nodes, options));
  }

  function clearFitMarks(nodes) {
    for (const node of nodes) {
      if (!node || !node.classList) continue;
      node.classList.remove('fit-limiter');
      node.classList.remove('fit-blocker');
      node.dataset.fitLabel = '';
      node.dataset.fitDebug = '';
      setDiagnosticTitle(node, '');
    }
  }

  function ensureCollisionDebugLayer(page) {
    let layer = page.querySelector(':scope > .layout-collision-debug-layer');
    if (layer) return layer;
    layer = document.createElement('div');
    layer.className = 'layout-collision-debug-layer';
    layer.setAttribute('aria-hidden', 'true');
    page.appendChild(layer);
    return layer;
  }

  function clearCollisionDebugLayer(page) {
    const layer = page && page.querySelector(':scope > .layout-collision-debug-layer');
    if (layer) layer.replaceChildren();
  }

  function clearAllCollisionDebugLayers() {
    for (const page of document.querySelectorAll('.layout-page')) {
      clearCollisionDebugLayer(page);
    }
  }

  function drawCollisionDebug(collision) {
    if (!collision || !collision.source || !collision.blocker) return;
    if (!document.body.classList.contains('layout-debug')) return;
    const page = collision.source.closest('.layout-page');
    if (!page) return;
    const layer = ensureCollisionDebugLayer(page);
    const rect = collision.rect;
    const blockerBox = elementBoxInPage(collision.blocker);
    const sourceBox = elementBoxInPage(collision.source);
    const coordinateScale = layoutPageCoordinateScale(page);
    const hitBox = document.createElement('div');
    hitBox.className = 'layout-collision-debug-box';
    hitBox.dataset.debugLabel = 'TEXT HIT';
    hitBox.style.left = `${(rect.left * coordinateScale).toFixed(2)}px`;
    hitBox.style.top = `${(rect.top * coordinateScale).toFixed(2)}px`;
    hitBox.style.width = `${Math.max(1, (rect.right - rect.left) * coordinateScale).toFixed(2)}px`;
    hitBox.style.height = `${Math.max(1, (rect.bottom - rect.top) * coordinateScale).toFixed(2)}px`;
    hitBox.title = `text overflow hit blocker\nsource=${collision.sourceName}\nblocker=${collision.blockerName}`;
    layer.appendChild(hitBox);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('layout-collision-debug-line');
    svg.setAttribute('viewBox', `0 0 ${Math.max(1, page.offsetWidth)} ${Math.max(1, page.offsetHeight)}`);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', (((sourceBox.left + sourceBox.right) / 2) * coordinateScale).toFixed(2));
    line.setAttribute('y1', (((sourceBox.top + sourceBox.bottom) / 2) * coordinateScale).toFixed(2));
    line.setAttribute('x2', (((blockerBox.left + blockerBox.right) / 2) * coordinateScale).toFixed(2));
    line.setAttribute('y2', (((blockerBox.top + blockerBox.bottom) / 2) * coordinateScale).toFixed(2));
    line.setAttribute('stroke', 'rgba(185, 28, 28, 0.95)');
    line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-dasharray', '5 3');
    svg.appendChild(line);
    layer.appendChild(svg);
  }

  function markLimiter(nodes, fontSize, lineRatio, options, stopReason) {
    const finalState = measureAt(nodes, fontSize, lineRatio);
    const collision = options.avoidBlockOverlap ? textCollisionDetails(nodes, options) : null;
    const nextFontState = fontSize + options.step <= options.maxFont
      ? measureAt(nodes, fontSize + options.step, lineRatio)
      : null;
    const nextLineState = lineRatio + options.lineStep <= options.maxLineRatio
      ? measureAt(nodes, fontSize, lineRatio + options.lineStep)
      : null;
    applyGroup(nodes, fontSize, lineRatio);
    const fontLimiters = new Set(
      (nextFontState?.details || [])
        .filter((detail) => detail.overflowAmount > 0.5)
        .map((detail) => detail.node)
    );
    const lineLimiters = new Set(
      (nextLineState?.details || [])
        .filter((detail) => detail.overflowAmount > 0.5)
        .map((detail) => detail.node)
    );
    const candidates = finalState.details
      .slice()
      .sort((a, b) => {
        const aNextOverflow = (fontLimiters.has(a.node) ? 1 : 0) + (lineLimiters.has(a.node) ? 1 : 0);
        const bNextOverflow = (fontLimiters.has(b.node) ? 1 : 0) + (lineLimiters.has(b.node) ? 1 : 0);
        if (aNextOverflow !== bNextOverflow) return bNextOverflow - aNextOverflow;
        return a.bottomGap - b.bottomGap;
      });
    const limiter = candidates.find((detail) => fontLimiters.has(detail.node) || lineLimiters.has(detail.node))
      || (collision ? candidates.find((detail) => detail.node === collision.source) : null)
      || candidates.find((detail) => !detail.reachedBand)
      || candidates[0];
    for (const detail of finalState.details) {
      const gap = detail.bottomGap.toFixed(1);
      const band = detail.band.toFixed(1);
      const overflow = detail.overflowAmount.toFixed(1);
      const isLimiter = limiter && detail.node === limiter.node;
      if (detail.node.classList) detail.node.classList.toggle('fit-limiter', isLimiter);
      const labelPrefix = options.labelPrefix || 'LIMIT';
      const labelReason = collision && isLimiter ? `${labelPrefix} ${stopReason} hit` : `${labelPrefix} ${stopReason} gap ${gap}`;
      detail.node.dataset.fitLabel = (isLimiter || options.markAll) ? labelReason : '';
      detail.node.dataset.fitDebug = [
        `font=${fontSize.toFixed(2)}`,
        `line=${lineRatio.toFixed(3)}`,
        `gap=${gap}`,
        `band=${band}`,
        `overflow=${overflow}`,
        `stop=${stopReason}`,
        `self=${blockDebugName(detail.node)}`,
        collision ? `collisionSource=${collision.sourceName}` : '',
        collision ? `collisionBlocker=${collision.blockerName}` : '',
        `nextFontOverflow=${nextFontState ? fontLimiters.has(detail.node) : 'max'}`,
        `nextLineOverflow=${nextLineState ? lineLimiters.has(detail.node) : 'max'}`
      ].filter(Boolean).join(' ');
      setDiagnosticTitle(detail.node, detail.node.dataset.fitDebug);
    }
    if (collision && collision.blocker && document.body.classList.contains('layout-debug')) {
      collision.blocker.classList.add('fit-blocker');
      collision.blocker.dataset.fitLabel = 'BLOCKER';
      collision.blocker.dataset.fitDebug = [
        'collision blocker',
        `source=${collision.sourceName}`,
        `blocker=${collision.blockerName}`,
      ].join(' ');
      setDiagnosticTitle(collision.blocker, collision.blocker.dataset.fitDebug);
      drawCollisionDebug(collision);
    }
  }

  function tuneGroup(selector, options) {
    const nodes = scopedNodes(selector);
    if (!nodes.length) return;
    tuneNodes(nodes, options);
    if (options.continueUnderfilledNodes) {
      continueUnderfilledNodes(nodes, options);
    }
  }

  // Short single-column transitions inherit the shared body font, then back
  // off locally during the final collision audit if necessary.
  function syncInheritedBodyFontToBodyGroup() {
    const bodyNodes = scopedNodes(
      '.layout-flow-stream[data-style-kind="body_text"][data-flow-kind="text"]:not([data-body-inherited="1"])'
    );
    const inheritedNodes = scopedNodes(
      '.layout-flow-stream[data-style-kind="body_text"][data-flow-kind="text"][data-body-inherited="1"]'
    );
    if (!bodyNodes.length || !inheritedNodes.length) return;
    const fontSize = Math.min(...bodyNodes
      .map((node) => layoutControlFontSize(node, 0))
      .filter((value) => Number.isFinite(value) && value > 0));
    if (!Number.isFinite(fontSize) || fontSize <= 0) return;
    for (const node of inheritedNodes) {
      const lineRatio = parseFloat(node.style.lineHeight || node.dataset.lineRatio || '1.1') || 1.1;
      applyGroup([node], fontSize, lineRatio);
    }
  }

  function tuneEach(selector, options) {
    const nodes = scopedNodes(selector);
    for (const node of nodes) {
      tuneNodes([node], options);
    }
  }

  function titleFrameFill(node) {
    const own = elementBoxInPage(node);
    const ownWidth = Math.max(1, own.right - own.left);
    const ownHeight = Math.max(1, own.bottom - own.top);
    const ink = rectUnion(textRectsInPage(node));
    if (!ink) return { area: 0, width: 0, height: 0 };
    const usedWidth = Math.max(0, Math.min(own.right, ink.right) - Math.max(own.left, ink.left));
    const usedHeight = Math.max(0, Math.min(own.bottom, ink.bottom) - Math.max(own.top, ink.top));
    const width = Math.min(1, usedWidth / ownWidth);
    const height = Math.min(1, usedHeight / ownHeight);
    return { area: width * height, width, height };
  }

  function expandUnderfilledTitles(selector, options) {
    const areaThreshold = Number.isFinite(options.titleFillAreaThreshold)
      ? options.titleFillAreaThreshold
      : 0.42;
    const dimensionThreshold = Number.isFinite(options.titleFillDimensionThreshold)
      ? options.titleFillDimensionThreshold
      : 0.72;
    for (const node of scopedNodes(selector)) {
      const initialFill = titleFrameFill(node);
      if (initialFill.area >= areaThreshold || (
        initialFill.width >= dimensionThreshold && initialFill.height >= dimensionThreshold
      )) continue;
      let fontSize = layoutControlFontSize(node);
      const lineRatio = parseFloat(node.style.lineHeight || node.dataset.lineRatio || '1.12') || 1.12;
      for (let safety = 0; safety < 136 && fontSize + options.step <= options.maxFont; safety += 1) {
        const nextFont = fontSize + options.step;
        applyGroup([node], nextFont, lineRatio);
        if (textCollisionDetails([node], options)) {
          applyGroup([node], fontSize, lineRatio);
          break;
        }
        fontSize = nextFont;
        const fill = titleFrameFill(node);
        if (fill.area >= areaThreshold || (
          fill.width >= dimensionThreshold && fill.height >= dimensionThreshold
        )) break;
      }
    }
  }

  function clusterTitleFontSizes(selector, maxDifference = 1.0) {
    const nodes = scopedNodes(selector)
      .filter((node) => node && node.style)
      .map((node) => ({ node, fontSize: layoutControlFontSize(node, 0) }))
      .filter((entry) => entry.fontSize > 0)
      .sort((left, right) => left.fontSize - right.fontSize);
    let cluster = [];
    let clusterMinimum = 0;
    const applyCluster = () => {
      if (cluster.length < 2) return;
      for (const entry of cluster) {
        applyGroup([entry.node], clusterMinimum, parseFloat(entry.node.style.lineHeight || entry.node.dataset.lineRatio || '1.12') || 1.12);
      }
    };
    for (const entry of nodes) {
      if (!cluster.length || entry.fontSize - clusterMinimum <= maxDifference + 0.001) {
        cluster.push(entry);
        if (cluster.length === 1) clusterMinimum = entry.fontSize;
        continue;
      }
      applyCluster();
      cluster = [entry];
      clusterMinimum = entry.fontSize;
    }
    applyCluster();
  }

  function renderedTextLineCount(node, topTolerance = 1.5) {
    const tops = [];
    const rects = textRectsInPage(node).sort((left, right) => (
      left.top - right.top || left.left - right.left
    ));
    for (const rect of rects) {
      if (!tops.some((top) => Math.abs(top - rect.top) <= topTolerance)) {
        tops.push(rect.top);
      }
    }
    return tops.length;
  }

  // Keep a short translated title on one line only when a bounded width
  // extension is collision-free. Use rendered lines, not MinerU's label.
  function keepShortTitlesOnOneLine(selector, options = {}) {
    const maxCharacters = Number.isFinite(options.maxCharacters) ? options.maxCharacters : 12;
    const maxBorrowPx = Number.isFinite(options.maxBorrowPx) ? options.maxBorrowPx : 18;
    const maxWidthRatio = Number.isFinite(options.maxWidthRatio) ? options.maxWidthRatio : 1.35;
    for (const node of scopedNodes(selector)) {
      const text = (node.innerText || '').replace(/\s+/g, ' ').trim();
      if (Array.from(text).length < 2 || Array.from(text).length > maxCharacters) continue;
      if (renderedTextLineCount(node) <= 1) continue;

      const originalWidth = node.style.width;
      const originalWhiteSpace = node.style.whiteSpace;
      const page = node.closest('.layout-page');
      const coordinateScale = layoutPageCoordinateScale(page);
      const own = elementBoxInPage(node);
      const ownWidth = Math.max(1, own.right - own.left);
      node.style.whiteSpace = 'nowrap';

      const nowrapRects = textRectsInPage(node);
      const ink = rectUnion(nowrapRects);
      if (!ink || renderedTextLineCount(node) !== 1) {
        node.style.width = originalWidth;
        node.style.whiteSpace = originalWhiteSpace;
        continue;
      }
      const requiredWidth = Math.max(ownWidth, ink.right - own.left + 0.75);
      const borrowedWidth = requiredWidth - ownWidth;
      if (ink.left < own.left - 1.5 || borrowedWidth > maxBorrowPx || requiredWidth / ownWidth > maxWidthRatio) {
        node.style.width = originalWidth;
        node.style.whiteSpace = originalWhiteSpace;
        continue;
      }

      node.style.width = `${(requiredWidth * coordinateScale).toFixed(2)}px`;
      const collision = textCollisionDetails([node], {
        avoidBlockOverlap: true,
        avoidPageOverflow: true,
        checkAllTextForCollisions: true,
      });
      if (collision) {
        node.style.width = originalWidth;
        node.style.whiteSpace = originalWhiteSpace;
        continue;
      }
      node.dataset.shortTitleNoWrap = '1';
    }
  }

  // Monotone collision-constrained growth: find the largest value in
  // [start, max] (stepped by `step`) at which `collides(value)` is still false.
  // Chromium line breaks are only weakly monotone, so recheck the tick above
  // the bisected boundary. `collides` leaves the node at the probed value.
  function gallopingGrow(start, max, step, collides) {
    if (start >= max) return { value: start, probes: 0 };
    const ticks = Math.floor((max - start) / step + 1e-6);
    if (ticks <= 0) return { value: start, probes: 0 };
    const at = (t) => Math.min(max, start + t * step);
    let probes = 0;
    let lastOk = 0;
    let firstBad = -1;
    let jump = 1;
    while (lastOk + jump <= ticks) {
      const t = lastOk + jump;
      probes += 1;
      if (collides(at(t))) { firstBad = t; break; }
      lastOk = t;
      jump *= 2;
    }
    // A doubling jump can pass the final tick (for example 1, 3, 7, 15 on a
    // 23-tick search).  Probe that endpoint before declaring max feasible;
    // otherwise a collision in the unvisited tail can be accepted as max.
    if (firstBad === -1 && lastOk < ticks) {
      probes += 1;
      if (collides(at(ticks))) firstBad = ticks;
      else lastOk = ticks;
    }
    if (firstBad === -1) {
      return { value: at(ticks), probes, lastProbed: at(ticks) };
    }
    let lo = lastOk;
    let hi = firstBad;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      probes += 1;
      if (collides(at(mid))) hi = mid; else lo = mid;
    }
    let best = lo;
    for (let t = lo + 1; t <= Math.min(ticks, lo + 1); t += 1) {
      probes += 1;
      if (collides(at(t))) break;
      best = t;
    }
    return { value: at(best), probes, lastProbed: at(Math.min(ticks, best + 1)) };
  }

  function tuneNodes(nodes, options) {
    if (!nodes.length) return null;
    clearFitMarks(nodes);
    const baseFont = Math.max(...nodes.map((node) => parseFloat(node.dataset.baseFont || "8")));
    const baseLineRatio = Math.max(...nodes.map((node) => parseFloat(node.dataset.lineRatio || "1.1")));
    let fontSize = baseFont;
    let lineRatio = baseLineRatio;
    const minFont = Number.isFinite(options.minFont) ? options.minFont : Math.max(4.8, fontSize * 0.55);
    const minLineRatio = Number.isFinite(options.minLineRatio) ? options.minLineRatio : 1.0;
    if (options.coupleFontAndLine) {
      lineRatio = Math.max(minLineRatio, Math.min(options.maxLineRatio, lineRatio));
    }
    if (options.startFromMinimum) {
      fontSize = minFont;
      lineRatio = minLineRatio;
    }
    let stopReason = 'unknown';
    let lastCollision = null;
    applyGroup(nodes, fontSize, lineRatio);
    let safety = 0;
    while (safety < 120 && (!options.allowOverflow || options.enforceInitialCollisionBackoff)) {
      safety += 1;
      // measureGroup forces a synchronous reflow and a full glyph walk per node.
      // Its result here is consumed only through state.overflow, which cannot
      // block when overflow is allowed. Skip the measurement in that case so a
      // grow loop that permits overflow no longer pays for an unused reflow.
      const state = !options.allowOverflow ? measureGroup(nodes) : null;
      const initialProbe = beginBodyIterationProbe(nodes, 'initial-backoff');
      const collision = options.enforceInitialCollisionBackoff
        ? wouldCollideWithBlocks(nodes, options)
        : null;
      recordBodyIterationCollision(collision, initialProbe);
      const blockingOverflow = Boolean(state && state.overflow) && !options.allowOverflow;
      if (!blockingOverflow && !collision) break;
      let changed = false;
      if (!options.coupleFontAndLine && lineRatio > minLineRatio) {
        lineRatio = Math.max(minLineRatio, lineRatio - options.lineStep);
        changed = true;
      } else if (fontSize > minFont) {
        fontSize = Math.max(minFont, fontSize - options.step);
        changed = true;
      }
      applyGroup(nodes, fontSize, lineRatio);
      if (!changed) {
        stopReason = collision ? 'min-block-overlap' : 'min-overflow';
        break;
      }
    }
    safety = 0;
    // The current-state measurement is read only for overflow (inert when
    // overflow is allowed) and for the fill-stop test (inert when the group
    // never stops on fill, e.g. overflow-first body/title/generic text). Skip
    // it whenever neither consumer can act on it.
    const needFillState = options.stopWhenFilled !== false;
    // Purely collision-constrained growth (generic per-node text): the stop
    // condition is a monotone "first colliding tick", with no overflow or fill
    // early-out that would need per-tick measurement. Bracket-and-bisect that
    // boundary instead of probing every tick. Restricted to SINGLE-node groups
    // with a wide remaining range and no initial-backoff anchor (titles); those
    // collide just above baseFont and are better served by the linear scan.
    // window.__gallopDisabled forces the linear path for controlled comparison.
    const remainingTicks = (options.maxFont - fontSize) / options.step;
    const monotoneFontSearch = (typeof window === 'undefined' || window.__gallopDisabled !== true) &&
      options.allowOverflow && !needFillState &&
      options.avoidBlockOverlap && !options.coupleFontAndLine &&
      !options.enforceInitialCollisionBackoff &&
      nodes.length === 1 && remainingTicks >= 8;
    if (monotoneFontSearch && fontSize < options.maxFont) {
      const grown = gallopingGrow(fontSize, options.maxFont, options.step, (value) => {
        applyGroup(nodes, value, lineRatio);
        beginBodyIterationProbe(nodes, 'font-grow');
        return Boolean(textCollisionDetails(nodes, options));
      });
      fontSize = grown.value;
      applyGroup(nodes, fontSize, lineRatio);
      stopReason = fontSize >= options.maxFont - 1e-6 ? 'max-font' : 'block-overlap';
    } else {
      while (safety < 80) {
        safety += 1;
        const state = (!options.allowOverflow || needFillState) ? measureGroup(nodes) : null;
        if (state && state.overflow && !options.allowOverflow) {
          stopReason = 'overflow';
          break;
        }
        if (needFillState && state && state.allReachedBand) {
          stopReason = 'filled';
          break;
        }
        const nextFont = fontSize + options.step;
        if (nextFont > options.maxFont) {
          stopReason = 'max-font';
          break;
        }
        applyGroup(nodes, nextFont, lineRatio);
        const nextState = !options.allowOverflow ? measureGroup(nodes) : null;
        const fontProbe = beginBodyIterationProbe(nodes, 'font-grow');
        const collision = options.avoidBlockOverlap ? textCollisionDetails(nodes, options) : null;
        recordBodyIterationCollision(collision, fontProbe);
        if (collision) {
          applyGroup(nodes, fontSize, lineRatio);
          stopReason = 'block-overlap';
          lastCollision = collision;
          break;
        }
        if (nextState && nextState.overflow && !options.allowOverflow) {
          applyGroup(nodes, fontSize, lineRatio);
          stopReason = 'font-overflow';
          break;
        }
        fontSize = nextFont;
      }
    }
    safety = 0;
    while (!options.coupleFontAndLine && safety < 80 && !(options.skipLineExpansionAfterFontCollision && stopReason === 'block-overlap')) {
      safety += 1;
      const state = (!options.allowOverflow || needFillState) ? measureGroup(nodes) : null;
      if ((state && state.overflow && !options.allowOverflow) || (needFillState && state && state.allReachedBand)) {
        stopReason = state && state.overflow && !options.allowOverflow ? 'overflow' : 'filled';
        break;
      }
      const nextRatio = lineRatio + options.lineStep;
      if (nextRatio > options.maxLineRatio) {
        stopReason = 'max-line';
        break;
      }
      applyGroup(nodes, fontSize, nextRatio);
      const nextState = !options.allowOverflow ? measureGroup(nodes) : null;
      const lineProbe = beginBodyIterationProbe(nodes, 'line-grow');
      const collision = options.avoidBlockOverlap ? textCollisionDetails(nodes, options) : null;
      recordBodyIterationCollision(collision, lineProbe);
      if (collision) {
        applyGroup(nodes, fontSize, lineRatio);
        stopReason = 'block-overlap';
        lastCollision = collision;
        break;
      }
      if (nextState && nextState.overflow && !options.allowOverflow) {
        applyGroup(nodes, fontSize, lineRatio);
        stopReason = 'line-overflow';
        break;
      }
      lineRatio = nextRatio;
    }
    if (options.showLimiter) {
      markLimiter(nodes, fontSize, lineRatio, options, stopReason);
    }
    return { fontSize, lineRatio, stopReason, collision: lastCollision };
  }

  // 正文二次迭代必须始终保持统一字号：所有正文同步增大字号，
  // 发生碰撞时只压缩碰撞源的行距；如果行距降到下限仍无法消除碰撞，
  // 则撤销本轮所有正文的字号增长并结束二次迭代，绝不单独缩小某个正文块。
  function continueUnderfilledNodes(nodes, options) {
    const targetFill = Number.isFinite(options.minTextFillRatio)
      ? options.minTextFillRatio
      : 0.85;
    const bodyNodes = (nodes || []).filter((node) => node && node.style);
    const fillRatio = (node) => {
      const metrics = measureTextBand(node);
      if (!metrics.hasText || node.clientHeight <= 0) return 0;
      return Math.min(1, Math.max(0, metrics.lastBottom) / node.clientHeight);
    };
    if (!bodyNodes.length || !bodyNodes.some((node) => fillRatio(node) < targetFill)) return;

    const minLineRatio = Number.isFinite(options.collisionMinLineRatio)
      ? options.collisionMinLineRatio
      : 1.02;

    const snapshotStyles = () => bodyNodes.map((node) => ({
      node,
      fontSize: layoutControlFontSize(node),
      lineRatio: parseFloat(node.style.lineHeight || node.dataset.lineRatio || '1.1') || 1.1,
    }));

    const restoreStyles = (snapshots) => {
      for (const snapshot of snapshots) {
        applyGroup([snapshot.node], snapshot.fontSize, snapshot.lineRatio);
      }
    };

    const markUniformFontStop = (source, collision, restoredFont) => {
      if (!document.body.classList.contains('layout-debug') || !source || !source.classList) return;
      source.classList.add('fit-limiter');
      source.dataset.fitLabel = 'STOP 统一字号';
      source.dataset.fitDebug = [
        '正文统一字号二次迭代停止',
        'reason=line-backoff-exhausted',
        `font=${restoredFont.toFixed(2)}`,
        `line=${parseFloat(source.style.lineHeight || '0').toFixed(3)}`,
        `fill=${(fillRatio(source) * 100).toFixed(1)}%`,
        collision ? `blocker=${collision.blockerName}` : '',
        `self=${blockDebugName(source)}`,
      ].filter(Boolean).join(' ');
      setDiagnosticTitle(source, source.dataset.fitDebug);
    };

    const recoverCollisionByLineRatio = (source, initialCollision) => {
      let collision = initialCollision;
      const fontSize = layoutControlFontSize(source);
      let lineRatio = parseFloat(source.style.lineHeight || source.dataset.lineRatio || '1.1') || 1.1;
      const sourceMinLineRatio = minLineRatio;

      // 正文碰撞只允许降低碰撞源自己的行距，最低保持 1.02 倍字号；字号
      // 仍属于全文共享状态，禁止任何正文块单独缩小字号。
      for (let safety = 0; collision && safety < 80 && lineRatio > sourceMinLineRatio + 0.001; safety += 1) {
        lineRatio = Math.max(sourceMinLineRatio, lineRatio - options.lineStep);
        applyGroup([source], fontSize, lineRatio);
        const recoveryProbe = beginBodyIterationProbe([source], 'collision-line-backoff');
        collision = textCollisionDetails([source], options);
        recordBodyIterationCollision(collision, recoveryProbe);
      }
      return { collision, fontSize, lineRatio };
    };

    for (let safety = 0; safety < 320; safety += 1) {
      if (!bodyNodes.some((node) => fillRatio(node) < targetFill)) return;

      const snapshots = snapshotStyles();
      const currentFont = Math.min(...snapshots.map((snapshot) => snapshot.fontSize));
      const nextFont = currentFont + options.step;
      if (!Number.isFinite(nextFont) || nextFont > options.maxFont + 0.0001) return;

      // 每个正文块保留自己的行距，但所有正文统一应用同一个候选字号。
      for (const snapshot of snapshots) {
        applyGroup([snapshot.node], nextFont, snapshot.lineRatio);
      }

      const sharedProbe = beginBodyIterationProbe(bodyNodes, 'shared-font-grow');
      let collision = options.avoidBlockOverlap ? textCollisionDetails(bodyNodes, options) : null;
      recordBodyIterationCollision(collision, sharedProbe);

      while (collision) {
        const initialCollision = collision;
        const source = collision.source;
        const recovery = recoverCollisionByLineRatio(source, collision);

        if (initialCollision.blocker && document.body.classList.contains('layout-debug')) {
          drawCollisionDebug(initialCollision);
        }

        if (recovery.collision) {
          // 行距已经降到可读下限仍发生碰撞：撤销整组本轮增长并终止，保持正文统一字号。
          restoreStyles(snapshots);
          markUniformFontStop(source, recovery.collision, currentFont);
          return;
        }

        const retryProbe = beginBodyIterationProbe(bodyNodes, 'shared-recheck');
        collision = options.avoidBlockOverlap
          ? textCollisionDetails(bodyNodes, options)
          : null;
        recordBodyIterationCollision(collision, retryProbe);
      }
    }
  }

  function clampTranslatedOverflow() {
    if (!document.body.classList.contains('layout-translated')) return;
    for (const node of scopedNodes('.layout-flow-stream[data-flow-kind="ref_text"]')) {
      if (!node || !node.style) continue;
      let fontSize = layoutControlFontSize(node);
      let lineRatio = parseFloat(node.style.lineHeight || node.dataset.lineRatio || "1.1") || 1.1;
      const isRef = node.dataset.flowKind === "ref_text";
      const minFont = isRef ? 4.8 : 5.0;
      const minLineRatio = isRef ? 0.98 : 1.0;
      applyGroup([node], fontSize, lineRatio);
      for (let i = 0; i < 120 && node.scrollHeight > node.clientHeight + 1 && (fontSize > minFont || lineRatio > minLineRatio); i += 1) {
        if (lineRatio > minLineRatio) {
          lineRatio = Math.max(minLineRatio, lineRatio - 0.025);
        } else {
          fontSize = Math.max(minFont, fontSize - 0.25);
        }
        applyGroup([node], fontSize, lineRatio);
      }
      node.dataset.baseFont = fontSize.toFixed(2);
      node.dataset.lineRatio = lineRatio.toFixed(3);
    }
  }

  // A translated code block owns a fixed source frame. Let its text become
  // denser before exposing an internal scrollbar; never let the pre silently
  // clip the tail of the translation while the following blocks keep their
  // original positions.
  function clampTranslatedCodeOverflow() {
    const nodes = scopedNodes('#translation-layout .layout-block.type-code');
    let changed = false;
    for (const node of nodes) {
      if (!node || !node.style) continue;
      const code = node.querySelector(':scope > .layout-code') || node.querySelector('.layout-code');
      if (!code) continue;
      const minFont = 7.0;
      const minLineRatio = 1.10;
      const requestedFont = layoutControlFontSize(node, 10);
      const requestedLineRatio = parseFloat(node.style.lineHeight || node.dataset.lineRatio || '1.18') || 1.18;
      let fontSize = Math.max(minFont, requestedFont);
      let lineRatio = Math.max(minLineRatio, requestedLineRatio);
      if (fontSize !== requestedFont || lineRatio !== requestedLineRatio) changed = true;
      code.style.overflow = 'hidden';
      applyGroup([node], fontSize, lineRatio);
      for (let i = 0; i < 160 && code.scrollHeight > code.clientHeight + 1
        && (lineRatio > minLineRatio + 0.001 || fontSize > minFont + 0.001); i += 1) {
        if (lineRatio > minLineRatio + 0.001) {
          lineRatio = Math.max(minLineRatio, lineRatio - 0.025);
        } else {
          fontSize = Math.max(minFont, fontSize - 0.25);
        }
        applyGroup([node], fontSize, lineRatio);
        changed = true;
      }
      if (code.scrollHeight > code.clientHeight + 1) {
        // The fallback is explicit and local to the code frame, so it cannot
        // cover or push any content below the positioned block.
        code.style.overflow = 'auto';
        node.dataset.codeFit = 'scroll';
      } else {
        node.dataset.codeFit = 'fit';
      }
      node.dataset.baseFont = fontSize.toFixed(2);
      node.dataset.lineRatio = lineRatio.toFixed(3);
    }
    return changed;
  }

  // All groups are tuned independently, so perform one final glyph-level
  // audit after every style mutation. Unlike the iteration probes, this checks
  // every visible glyph against every layout box, including cross-group cases
  // such as body text beside references. Only a detected source is backed off.
  function enforceFinalTextCollisionSafety() {
    const nodes = scopedNodes(
      '.layout-flow-stream[data-flow-kind="text"], .layout-flow-stream[data-flow-kind="ref_text"]'
    ).filter((node) => node && node.style);
    const exhausted = new Set();
    const repairCounts = new Map();
    // Covers the full 42px-to-4.8px backoff range with a small margin.
    const MAX_FINAL_COLLISION_REPAIRS_PER_NODE = 192;
    const options = {
      avoidBlockOverlap: true,
      avoidPageOverflow: true,
      includeGroupPeers: true,
      checkAllTextForCollisions: true,
      ignoreTopOverflow: false,
      ignoreBodyTopOverflow: true,
      bodyColumnIndependentFit: true,
      bodyTextCollisionGeometry: true,
      sharedEdgeTolerance: 4.0,
      sharedHorizontalEdgeTolerance: 3.0,
    };
    // The legacy loop restarted from node zero after every backoff.  That is
    // quadratic. Recheck the changed source, then continue in source order.
    let scanIndex = 0;
    while (scanIndex < nodes.length) {
      const candidate = nodes[scanIndex];
      if (!candidate || exhausted.has(candidate)) {
        scanIndex += 1;
        continue;
      }
      const finalProbe = beginBodyIterationProbe([candidate], 'final-safety-audit');
      const collision = textCollisionDetails([candidate], options);
      recordBodyIterationCollision(collision, finalProbe);
      if (!collision) {
        scanIndex += 1;
        continue;
      }
      const source = collision.source;
      const repairs = (repairCounts.get(source) || 0) + 1;
      repairCounts.set(source, repairs);
      if (repairs > MAX_FINAL_COLLISION_REPAIRS_PER_NODE) {
        // The fallback is deliberately local. The rest of the paper still
        // receives an exact audit, and an exceptional source cannot freeze
        // Zotero by repeatedly restarting the entire document scan.
        exhausted.add(source);
        if (document.body.classList.contains('layout-debug') && source.classList) {
          source.classList.add('fit-limiter');
          source.dataset.fitLabel = 'FINAL collision guard';
          source.dataset.fitDebug = `final collision repair limit=${MAX_FINAL_COLLISION_REPAIRS_PER_NODE} self=${blockDebugName(source)}`;
          setDiagnosticTitle(source, source.dataset.fitDebug);
        }
        scanIndex += 1;
        continue;
      }
      let fontSize = layoutControlFontSize(source);
      let lineRatio = parseFloat(source.style.lineHeight || source.dataset.lineRatio || '1.1') || 1.1;
      const minFont = source.dataset.flowKind === 'ref_text' ? 4.8 : 4.8;
      // Short single-column transitions inherit the body baseline but must
      // never constrain its document-wide fit. They can still back off here
      // if a translated sentence genuinely cannot fit its source band.
      const isInheritedBodyText = source.dataset.styleKind === 'body_text'
        && source.dataset.bodyInherited === '1';
      const isBodyText = source.dataset.styleKind === 'body_text'
        && (!isInheritedBodyText || !ALLOW_INHERITED_BODY_FONT_BACKOFF);
      const minLineRatio = isBodyText ? 1.02 : 0.98;
      const ownBox = elementBoxInPage(source);
      const firstLineTopCollision = !isBodyText
        && collision.rect
        && collision.rect.top < ownBox.top - 1;
      // Increase leading when first-line ink crosses the source box's top edge.
      if (ALLOW_INHERITED_BODY_FONT_BACKOFF && isInheritedBodyText && fontSize > minFont + 0.001) {
        // The shared body font is restored first. If this one narrow
        // transition cannot fit, only this source may give back font size.
        fontSize = Math.max(minFont, fontSize - 0.25);
      } else if (firstLineTopCollision && lineRatio < 1.85 - 0.001) {
        lineRatio = Math.min(1.85, lineRatio + 0.025);
      } else if (lineRatio > minLineRatio + 0.001) {
        lineRatio = Math.max(minLineRatio, lineRatio - 0.025);
      } else if (isBodyText) {
        // 最终安全检查同样禁止单独缩小正文。行距到底仍冲突时放弃处理该正文块，
        // 避免最后一道检查重新破坏二次迭代已经保证的统一字号。
        exhausted.add(source);
        scanIndex += 1;
        continue;
      } else if (fontSize > minFont + 0.001) {
        fontSize = Math.max(minFont, fontSize - 0.25);
      } else {
        exhausted.add(source);
        scanIndex += 1;
        continue;
      }
      applyGroup([source], fontSize, lineRatio);
      // Only this source moved, so it is the sole node that needs another
      // glyph-level probe before the audit advances to the next source.
      if (document.body.classList.contains('layout-debug') && source.classList) {
        source.classList.add('fit-limiter');
        source.dataset.fitLabel = 'FINAL collision backoff';
        source.dataset.fitDebug = [
          'final glyph collision backoff',
          `font=${fontSize.toFixed(2)}`,
          `line=${lineRatio.toFixed(3)}`,
          `blocker=${collision.blockerName}`,
          `self=${blockDebugName(source)}`,
        ].join(' ');
        setDiagnosticTitle(source, source.dataset.fitDebug);
      }
    }
  }

  function refreshLayoutPageScales(pageWraps = null) {
    const wraps = pageWraps || [...document.querySelectorAll('.layout-page-wrap')];
    for (const wrap of wraps) {
      const page = wrap?.querySelector?.('.layout-page');
      page?._litmtransRefreshLayoutScale?.(false);
    }
  }

  // This is the only text-fitting rule set used by the Zotero reader. The
  // surrounding scaling and scheduling code adapts it to the Zotero host.
  function runLayoutParityEngine(pageWraps = null, persist = false) {
    activeFitPages = pageWraps ? new Set(pageWraps) : null;
    try {
      const debugMode = document.body.classList.contains('layout-debug');
      const strictSourceFit = document.body.classList.contains('layout-source-strict-fit');
      // Both parsed-source and translated reading views should start compact,
      // then fill until actual glyphs collide. The explicit strict-source view
      // remains an opt-in no-overflow inspection mode.
      const collisionFirstTextFit = !strictSourceFit;
      clearAllCollisionDebugLayers();

      // Apply the page scale before measuring glyphs. Geometry helpers convert
      // the result back to source coordinates, so view scaling does not alter
      // fixed tolerances.
      refreshLayoutPageScales(pageWraps);
      resetBodyIterationInspection(scopedNodes(
        '.layout-flow-stream[data-style-kind="body_text"][data-flow-kind="text"]:not([data-body-inherited="1"])'
      ));
      demoteFalseSingleLineText();
      const titleFitOptions = {
        step: 0.25,
        minFont: 6.0,
        maxFont: 28.0,
        lineStep: 0.025,
        minLineRatio: 0.98,
        maxLineRatio: 1.35,
        // MinerU title boxes commonly describe the source ink band and are
        // only 10-12px tall.  Let translated headings extend beyond that box;
        // their actual glyphs are still checked against every other block's
        // bbox and against the page boundary below.
        allowOverflow: true,
        stopWhenFilled: false,
        avoidBlockOverlap: true,
        avoidPageOverflow: true,
        checkAllTextForCollisions: true,
        enforceInitialCollisionBackoff: true,
        showLimiter: debugMode
      };
      // Article titles retain their own scale.  Every other heading shares one
      // document-wide font/line-height pair, limited by the first heading that
      // reaches another block.  Group peers remain barriers so adjacent
      // section/subsection headings cannot overlap each other.
      tuneEach('.layout-block.type-title.main-title', titleFitOptions);
      tuneGroup('.layout-block.type-title:not(.main-title)', {
        ...titleFitOptions,
        includeGroupPeers: true
      });
      expandUnderfilledTitles('.layout-block.type-title:not(.main-title)', {
        ...titleFitOptions,
        maxFont: 42.0,
        titleFillAreaThreshold: 0.42,
        titleFillDimensionThreshold: 0.72
      });
      clusterTitleFontSizes('.layout-block.type-title', 1.0);
      keepShortTitlesOnOneLine('.layout-block.type-title:not(.main-title)', {
        maxCharacters: 12,
        maxBorrowPx: 18,
        maxWidthRatio: 1.35,
      });
      tuneGroup('.layout-flow-stream[data-style-kind="body_text"][data-flow-kind="text"]:not([data-body-inherited="1"])', {
        step: 0.5,
        minFont: collisionFirstTextFit ? 4.8 : undefined,
        minLineRatio: collisionFirstTextFit ? 1.12 : undefined,
        maxFont: 13,
        lineStep: 0.04,
        maxLineRatio: 1.45,
        // 以原始可读字号作为统一基线。后续二次迭代只允许整组正文同步增大字号，
        // 避免从最小字号起步时被邻近表格或题注不必要地压缩正文。
        allowOverflow: !strictSourceFit,
        avoidBlockOverlap: true,
        avoidPageOverflow: collisionFirstTextFit,
        includeGroupPeers: collisionFirstTextFit,
        // 两栏正文由各自的框宽决定换行；相邻栏的文字不再成为全篇字号上限。
        // 同列上下块、重叠源框及页面边界仍照常保护。
        bodyColumnIndependentFit: true,
        // 只有正文按逐行实际文字检测；其余文本类型保持按布局边框判定。
        bodyTextCollisionGeometry: true,
        // 首轮统一字号本身也可能碰撞，因此先对整组字号做全局安全回退，
        // 再进入“统一字号、局部调行距”的正文二次迭代。
        enforceInitialCollisionBackoff: collisionFirstTextFit,
        // 标题与正文的边界经常完全相邻，首行字形顶部允许少量光学悬出；
        // 正文向下增长，因此仍严格保护底边和左右边界。
        ignoreTopOverflow: collisionFirstTextFit,
        sharedEdgeTolerance: 4.0,
        sharedHorizontalEdgeTolerance: 3.0,
        // 对未填满正文执行二次迭代，但所有正文始终共享同一个字号。
        continueUnderfilledNodes: collisionFirstTextFit,
        minTextFillRatio: 0.85,
        collisionMinLineRatio: 1.02,
        // 首轮共享增长只改字号；二次迭代发生碰撞时，仅允许碰撞源局部降低行距，
        // 禁止任何正文块单独降低字号。
        coupleFontAndLine: true,
        // 首轮字体碰撞后不再对整组放大行距，正文二次迭代会单独处理碰撞源行距。
        skipLineExpansionAfterFontCollision: true,
        showLimiter: debugMode
      });
      syncInheritedBodyFontToBodyGroup();
      tuneGroup('.layout-flow-stream[data-from-list="1"][data-flow-kind="text"]', {
        step: 0.35,
        minFont: collisionFirstTextFit ? 4.8 : undefined,
        minLineRatio: collisionFirstTextFit ? 0.98 : undefined,
        maxFont: 13,
        lineStep: 0.035,
        maxLineRatio: 1.85,
        allowOverflow: !strictSourceFit,
        avoidBlockOverlap: true,
        avoidPageOverflow: collisionFirstTextFit,
        includeGroupPeers: collisionFirstTextFit,
        ignoreTopOverflow: collisionFirstTextFit,
        startFromMinimum: collisionFirstTextFit,
        stopWhenFilled: !collisionFirstTextFit,
        showLimiter: debugMode
      });
      // A recognized contents stream owns its row grid, indentation and page
      // column.  Treating it as generic multi-line prose lets the fitter
      // change its fixed 8.2px/1.22 baseline and can clip a dense directory.
      tuneEach('.layout-flow-stream.debug-text[data-flow-kind="text"][data-original-lines="multi"]', {
        step: 0.35,
        minFont: collisionFirstTextFit ? 4.8 : undefined,
        minLineRatio: collisionFirstTextFit ? 0.98 : undefined,
        maxFont: 13,
        lineStep: 0.035,
        maxLineRatio: 1.85,
        allowOverflow: !strictSourceFit,
        avoidBlockOverlap: true,
        avoidPageOverflow: collisionFirstTextFit,
        ignoreTopOverflow: collisionFirstTextFit,
        startFromMinimum: collisionFirstTextFit,
        stopWhenFilled: !collisionFirstTextFit,
        showLimiter: debugMode
      });
      tuneEach('.layout-block.type-text[data-original-lines="multi"]', {
        step: 0.35,
        minFont: collisionFirstTextFit ? 4.8 : undefined,
        minLineRatio: collisionFirstTextFit ? 0.98 : undefined,
        maxFont: 13,
        lineStep: 0.035,
        maxLineRatio: 1.85,
        allowOverflow: !strictSourceFit,
        avoidBlockOverlap: true,
        avoidPageOverflow: collisionFirstTextFit,
        ignoreTopOverflow: collisionFirstTextFit,
        startFromMinimum: collisionFirstTextFit,
        stopWhenFilled: !collisionFirstTextFit,
        showLimiter: debugMode
      });
      const tuneCaptionGroup = (selector) => tuneGroup(selector, {
        step: 0.25,
        minFont: 5.2,
        maxFont: 10.5,
        lineStep: 0.025,
        minLineRatio: 1.0,
        maxLineRatio: 1.55,
        allowOverflow: false,
        avoidBlockOverlap: true,
        markAll: true,
        labelPrefix: 'CAP',
        showLimiter: debugMode
      });
      tuneCaptionGroup('.layout-block.type-table_caption');
      tuneCaptionGroup('.layout-block.type-table_footnote');
      tuneCaptionGroup('.layout-block.type-chart_caption');
      tuneCaptionGroup('.layout-block.type-image_caption');
      tuneCaptionGroup('.layout-block.type-image_footnote');
      tuneGroup('.layout-flow-stream[data-flow-kind="ref_text"]', {
        step: 0.25,
        minFont: 4.8,
        maxFont: 12,
        lineStep: 0.025,
        minLineRatio: 0.98,
        maxLineRatio: 1.65,
        allowOverflow: false,
        avoidBlockOverlap: true,
        showLimiter: debugMode
      });
      clampTranslatedOverflow();
      clampTranslatedCodeOverflow();
      enforceFinalTextCollisionSafety();
      publishBodyIterationInspection(scopedNodes(
        '.layout-flow-stream[data-style-kind="body_text"][data-flow-kind="text"]:not([data-body-inherited="1"])'
      ));
      if (persist) saveFitCache();
      // A document may save a manual body-font override. Re-fitting must
      // retain it, with line height scaled alongside the font.
      const userBodyFontPt = parseFloat(document.body.dataset.userBodyFontPt || '');
      if (Number.isFinite(userBodyFontPt)) {
        for (const node of document.querySelectorAll(
          '.layout-flow-stream[data-style-kind="body_text"][data-flow-kind="text"]'
        )) {
          node.style.fontSize = `${userBodyFontPt}pt`;
          node.dataset.userBodyFontPt = userBodyFontPt.toFixed(2);
        }
      }
    } catch (error) {
      if (!document.body.classList.contains('layout-debug')) return;
      for (const node of document.querySelectorAll('.layout-flow-stream')) {
        node.classList.add('fit-limiter');
        node.dataset.fitLabel = 'ERROR';
        node.dataset.fitDebug = String(error && error.message ? error.message : error);
        setDiagnosticTitle(node, node.dataset.fitDebug);
      }
    } finally {
      activeFitPages = null;
    }

  }

  // Route the inspection hook through the same fitter used by rendering and
  // ResizeObserver. A second set of font calculations on window resize could
  // overwrite a just-computed single- or dual-pane fit.
  window.__mineruRunLayoutFill = () => {
    const pages = [...document.querySelectorAll('#translation-layout .layout-page')];
    return ensureLayoutFit(pages);
  };
})();
