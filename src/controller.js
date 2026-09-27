(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const U = LitMTrans.Utils;
  const DEFAULT_CHAT_ENGINE = LitMTrans.Constants?.DEFAULT_CHAT_ENGINE || "deepseek_web";
  const CAJ_CACHE_VERSION = 5;
  const DIAGRAM_CACHE_TASK_TYPES = LitMTrans.DiagramCache.TASK_TYPES;
  const DIAGRAM_CACHE_MAX_CHARS = LitMTrans.DiagramCache.MAX_CHARS;
  LitMTrans.FEEDBACK_FORM_URL = "https://acnndsd03tis.feishu.cn/share/base/form/shrcn3I4qD4YIyhM6H1KAEQ59zb";

  function diagramCacheTaskType(value) {
    return LitMTrans.DiagramCache.taskType(value);
  }

  function diagramCacheMode(value, taskType) {
    return LitMTrans.DiagramCache.mode(value, taskType);
  }

  function isDiagramCacheShape(diagram, mode) {
    return LitMTrans.DiagramCache.validate(diagram, mode);
  }

  function localize(zh, en) {
    const locale = String(Zotero.locale || "").toLowerCase();
    return locale.startsWith("zh") ? zh : en;
  }

  function displayTitle(item, attachment) {
    const parent = attachment?.parentID ? Zotero.Items.get(attachment.parentID) : null;
    return String(parent?.getField?.("title") || item?.getField?.("title") || attachment?.getField?.("title") || attachment?.attachmentFilename || localize("未命名文献", "Untitled document"));
  }

  function safeChatRelativePath(value) {
    const path = String(value || "").replace(/\\/g, "/");
    if (!path || path.startsWith("/") || /^[A-Za-z]:(?:\/|$)/.test(path)) return false;
    return path.split("/").every(part => part && part !== "." && part !== ".." && !part.includes("\0"));
  }

  // Evidence links always remain available. Exact text is preferred, while a
  // visibly approximate nearest match lets the reader make the final judgment.
  function evidenceTextKey(value) {
    return String(value || "").normalize("NFKC").replace(/-\s*\n\s*/g, "").replace(/\s+/g, " ").trim();
  }

  function fuzzyEvidenceKey(value) {
    return evidenceTextKey(value).toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  }

  function evidenceNgrams(value, size = 3) {
    const text = fuzzyEvidenceKey(value);
    const grams = new Set();
    for (let index = 0; index <= text.length - size; index++) grams.add(text.slice(index, index + size));
    return { text, grams };
  }

  function quoteCoverageScore(source, candidate) {
    const expectedText = fuzzyEvidenceKey(source), actualText = fuzzyEvidenceKey(candidate);
    if (!expectedText || !actualText) return 0;
    if (actualText.includes(expectedText)) return 1;
    const size = Math.min(3, expectedText.length);
    const expected = evidenceNgrams(expectedText, size); const actual = evidenceNgrams(actualText, size);
    if (!expected.grams.size || !actual.grams.size) return 0;
    let overlap = 0;
    for (const gram of expected.grams) if (actual.grams.has(gram)) overlap++;
    return overlap / expected.grams.size;
  }

  function evidenceQuoteSegments(value) {
    return String(value || "").split(/(?:\.{3,}|…+|⋯+)/u).map(fuzzyEvidenceKey).filter(part => part.length >= 2);
  }

  function findEvidenceSegmentRanges(pageText, quote) {
    const source = fuzzyEvidenceKey(pageText); const segments = evidenceQuoteSegments(quote);
    if (!source || !segments.length) return [];
    const ranges = []; let cursor = 0;
    for (const segment of segments) {
      const start = source.indexOf(segment, cursor);
      if (start < 0) return [];
      ranges.push({ start, end: start + segment.length }); cursor = start + segment.length;
    }
    return ranges;
  }

  function pdfTextHighlightRects(pageView, quote, pdfWindow) {
    const spans = Array.from(pageView?.div?.querySelectorAll?.(".textLayer span") || []).filter(span => String(span.textContent || "").trim());
    if (!spans.length || !quote) return [];
    let rawPage = ""; const rawMap = [];
    for (const span of spans) {
      const raw = String(span.textContent || "");
      if (rawPage && !/\s$/.test(rawPage)) { rawPage += " "; rawMap.push(null); }
      for (let offset = 0; offset < raw.length;) {
        const point = raw.codePointAt(offset); const character = String.fromCodePoint(point); const nextOffset = offset + character.length;
        for (let index = 0; index < character.length; index++) { rawPage += character[index]; rawMap.push({ span, start: offset, end: nextOffset }); }
        offset = nextOffset;
      }
    }
    let normalized = ""; const normalizedMap = [];
    for (let index = 0; index < rawPage.length;) {
      const point = rawPage.codePointAt(index); const character = String.fromCodePoint(point); const nextIndex = index + character.length;
      const clean = character.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
      for (const output of clean) { normalized += output; normalizedMap.push({ ...rawMap[index], rawIndex: index }); }
      index = nextIndex;
    }
    const sentenceRanges = []; const sentencePattern = /[^.!?。！？]+(?:[.!?。！？]+|$)/gu; let sentenceMatch;
    while ((sentenceMatch = sentencePattern.exec(rawPage))) {
      let start = sentenceMatch.index, end = sentenceMatch.index + sentenceMatch[0].length;
      while (start < end && /\s/.test(rawPage[start])) start++;
      while (end > start && /\s/.test(rawPage[end - 1])) end--;
      if (end > start) sentenceRanges.push({ start, end, text: rawPage.slice(start, end) });
    }
    const fragmentRanges = findEvidenceSegmentRanges(normalized, quote);
    let selectedSentence = null;
    if (fragmentRanges.length) {
      const rawStart = normalizedMap[fragmentRanges[0].start]?.rawIndex;
      const rawEnd = normalizedMap[fragmentRanges.at(-1).end - 1]?.rawIndex;
      const firstSentence = sentenceRanges.find(range => rawStart >= range.start && rawStart < range.end);
      const lastSentence = sentenceRanges.find(range => rawEnd >= range.start && rawEnd < range.end);
      if (firstSentence && lastSentence) selectedSentence = { start: firstSentence.start, end: lastSentence.end };
    }
    if (!selectedSentence && sentenceRanges.length) {
      const segments = evidenceQuoteSegments(quote);
      selectedSentence = sentenceRanges.map(range => {
        const segmentScore = segments.length ? segments.reduce((sum, segment) => sum + quoteCoverageScore(segment, range.text), 0) / segments.length : 0;
        return { ...range, score: Math.max(quoteCoverageScore(quote, range.text), segmentScore) };
      }).sort((left, right) => right.score - left.score)[0];
    }
    if (!selectedSentence) return [];
    let first = selectedSentence.start, last = selectedSentence.end - 1;
    while (first <= last && !rawMap[first]) first++;
    while (last >= first && !rawMap[last]) last--;
    const firstCharacter = rawMap[first], lastCharacter = rawMap[last];
    if (!firstCharacter || !lastCharacter) return [];
    const pageRect = pageView.div.getBoundingClientRect(); if (!pageRect.width || !pageRect.height) return [];
    const rects = [];
    try {
      const range = pdfWindow.document.createRange();
      range.setStart(firstCharacter.span.firstChild || firstCharacter.span, firstCharacter.start); range.setEnd(lastCharacter.span.firstChild || lastCharacter.span, lastCharacter.end);
      for (const rect of range.getClientRects()) {
        if (!rect.width || !rect.height) continue;
        rects.push({ x: (rect.left - pageRect.left) / pageRect.width, y: (rect.top - pageRect.top) / pageRect.height, width: rect.width / pageRect.width, height: rect.height / pageRect.height });
      }
    }
    catch (_) {}
    return rects;
  }

  function evidenceBlockLocation(block, approximate = false, confidence = 1, highlightText = "") {
    const bbox = Array.isArray(block.bbox) ? block.bbox.map(Number) : [];
    const base = { page: block.page, blockID: String(block.id || ""), approximate, confidence, highlightText: String(highlightText || "") };
    if (bbox.length < 4 || !bbox.every(Number.isFinite) || !block.pageWidth || !block.pageHeight) return base;
    return { ...base, highlightRects: [{ x: bbox[0] / block.pageWidth, y: bbox[1] / block.pageHeight, width: (bbox[2] - bbox[0]) / block.pageWidth, height: (bbox[3] - bbox[1]) / block.pageHeight }] };
  }

  function compiledEvidenceMatches(compiled, evidence) {
    const model = compiled?.model || compiled || {};
    const blocks = (Array.isArray(model.pages) ? model.pages : []).flatMap(page => Array.isArray(page?.blocks) ? page.blocks.map(block => ({ ...block, page: Number(block.page || page.index || 1), pageWidth: Number(page.width || 0), pageHeight: Number(page.height || 0) })) : []);
    const type = String(evidence?.type || (evidence?.quote ? "quote" : ""));
    const source = type === "quote" ? evidenceTextKey(evidence.quote) : (type === "formula" ? evidenceTextKey(evidence.tex) : evidenceTextKey(evidence.ref));
    if (!source) return null;
    const candidates = blocks.filter(block => {
      if (type === "formula") return (block.formulaItems || []).some(item => evidenceTextKey(item?.tex) === source);
      if (type === "image") return evidenceTextKey(block.imagePath).endsWith(source) || evidenceTextKey(block.imagePath).includes(source);
      return evidenceTextKey(block.text).includes(source) || findEvidenceSegmentRanges(block.text, evidence?.quote).length > 0;
    });
    if (candidates.length === 1) {
      const omitted = type === "quote" && !evidenceTextKey(candidates[0].text).includes(source);
      return evidenceBlockLocation(candidates[0], omitted, 1, type === "quote" ? evidence.quote : "");
    }
    if (type !== "quote") return null;

    // Always expose the closest quote block. The UI explicitly labels this as
    // an approximate match so readers can judge it against the highlighted sentence.
    const ranked = blocks
      .filter(block => evidenceTextKey(block.text))
      .map(block => ({ block, score: quoteCoverageScore(source, block.text) }))
      .sort((left, right) => right.score - left.score);
    const best = ranked[0];
    if (!best) return null;
    return evidenceBlockLocation(best.block, true, Math.round(best.score * 1000) / 1000, evidence.quote);
  }

  class Controller {
    constructor({ id, version, rootURI }) {
      this.id = id;
      this.version = version;
      this.rootURI = rootURI;
      this.storage = new LitMTrans.Storage();
      this.secrets = new LitMTrans.Secrets();
      this.llm = new LitMTrans.LLMService(this.secrets);
      if (LitMTrans.DeepSeekWeb?.Provider) {
        this.deepSeekWebProvider = new LitMTrans.DeepSeekWeb.Provider(this);
        this.llm.setWebProvider(this.deepSeekWebProvider);
      }
      this.webMachine = new LitMTrans.WebMachineTranslationService({
        edgeDownloadConsent: (sourceLanguage, targetLanguage) => this.confirmEdgeModelDownload(sourceLanguage, targetLanguage)
      });
      this.mineru = new LitMTrans.MinerUService(this.storage, this.secrets);
      this.translation = new LitMTrans.TranslationService(this.storage, this.llm, this.mineru, this.webMachine);
      this.layout = new LitMTrans.LayoutTranslationService(this.storage, this.llm, this.webMachine);
      this.chat = new LitMTrans.ChatService(this.storage, this.llm, this.translation, this.mineru);
      this.pipeline = new LitMTrans.DocumentPipeline({
        storage: this.storage,
        mineru: this.mineru,
        translation: this.translation,
        layout: this.layout,
        chat: this.chat,
        getSettings: () => this.getSettings()
      });
      this.windows = new Set();
      this.windowBindings = new WeakMap();
      this.tabs = new Map();
      this.operations = new Map();
      this.operationTasks = new Map();
      this.operationStopping = new Map();
      this.diagramCacheLocks = new Map();
      this.readerHandlers = [];
      this.itemPaneSectionID = null;
      this.itemNotifierID = null;
      this.diagnosticTimer = null;
      this.diagnosticBusy = false;
      this._initialized = false;
      this.availableUpdate = null;
      this.announcements = [];
      const AgentBackend = LitMTrans.Agent?.AgentBackend || LitMTrans.AgentBackend;
      this.agent = AgentBackend ? new AgentBackend(this) : null;
    }

    log(message) {
      if (U.getPref("debug", false)) Zotero.debug(`[LitMTrans] ${message}`);
    }

    getDismissedAnnouncementIds() {
      try {
        const raw = U.getPref("dismissedAnnouncementIds", "[]");
        const list = JSON.parse(raw);
        return new Set(Array.isArray(list) ? list.map(String) : []);
      } catch (_) {
        return new Set();
      }
    }

    dismissAnnouncement(id, broadcast = true) {
      if (!id) return false;
      try {
        const set = this.getDismissedAnnouncementIds();
        set.add(String(id));
        U.setPref("dismissedAnnouncementIds", JSON.stringify([...set].slice(-200)));
        if (broadcast) this.broadcastAnnouncements();
        return true;
      } catch (_) {
        return false;
      }
    }

    dismissAnnouncements(ids) {
      if (!Array.isArray(ids) || !ids.length) return true;
      try {
        const set = this.getDismissedAnnouncementIds();
        let changed = false;
        for (const id of ids) {
          if (id) {
            set.add(String(id));
            changed = true;
          }
        }
        if (changed) {
          U.setPref("dismissedAnnouncementIds", JSON.stringify([...set].slice(-200)));
          this.broadcastAnnouncements();
        }
        return true;
      } catch (_) {
        return false;
      }
    }

    getAnnouncementHistory() {
      try {
        const raw = U.getPref("announcementHistory", "[]");
        const list = JSON.parse(raw);
        return Array.isArray(list) ? list : [];
      } catch (_) {
        return [];
      }
    }

    saveAnnouncementHistory(list) {
      try {
        const dismissed = this.getDismissedAnnouncementIds();
        const items = Array.isArray(list) ? list : [];
        if (items.length > 30) {
          // Keep all applicable unread alerts, then fill up to 30 with most recent items
          const unreadAlerts = items.filter(it => {
            if (!it || it.level !== "alert" || dismissed.has(String(it.id))) return false;
            return !LitMTrans.Updater?.isAnnouncementApplicable
              || LitMTrans.Updater.isAnnouncementApplicable(it, this.version, new Set());
          });
          const unreadAlertRefs = new Set(unreadAlerts);
          const others = items.filter(it => !unreadAlertRefs.has(it));
          const remainingSlots = Math.max(0, 30 - unreadAlerts.length);
          const finalItems = [...unreadAlerts, ...others.slice(0, remainingSlots)];
          finalItems.sort((a, b) => {
            const tA = Date.parse(a.date || a.expireAt || 0) || 0;
            const tB = Date.parse(b.date || b.expireAt || 0) || 0;
            return tB - tA;
          });
          U.setPref("announcementHistory", JSON.stringify(finalItems));
          return;
        }
        U.setPref("announcementHistory", JSON.stringify(items));
      } catch (_) {}
    }

    mergeAnnouncements(incoming) {
      if (!Array.isArray(incoming) || !incoming.length) return;
      const history = this.getAnnouncementHistory();
      const map = new Map();
      for (const item of history) {
        if (item && item.id) map.set(item.id, item);
      }
      for (const item of incoming) {
        if (item && item.id) {
          map.set(item.id, { ...(map.get(item.id) || {}), ...item });
        }
      }
      const merged = [...map.values()];
      merged.sort((a, b) => {
        const tA = Date.parse(a.date || a.expireAt || 0) || 0;
        const tB = Date.parse(b.date || b.expireAt || 0) || 0;
        return tB - tA;
      });
      this.saveAnnouncementHistory(merged);
      this.broadcastAnnouncements();
    }

    broadcastAnnouncements() {
      const data = this.getAnnouncementsForWorkbench();
      if (this.tabs instanceof Map) {
        for (const runtime of this.tabs.values()) {
          try { this.emit(runtime, { type: "announcements-updated", announcements: data }); } catch (_) {}
        }
      }
    }

    getAnnouncementsForWorkbench() {
      const history = this.getAnnouncementHistory();
      const dismissed = this.getDismissedAnnouncementIds();
      let pendingAlert = null;
      let unreadCount = 0;

      for (const item of history) {
        const isDismissed = dismissed.has(item.id);
        const isApplicable = LitMTrans.Updater?.isAnnouncementApplicable
          ? LitMTrans.Updater.isAnnouncementApplicable(item, this.version, new Set())
          : true;

        if (!isDismissed && isApplicable) {
          unreadCount++;
          if (!pendingAlert && item.level === "alert") {
            pendingAlert = item;
          }
        }
      }

      return {
        pendingAlert,
        unreadCount,
        history: history.map(item => {
          const isApplicable = LitMTrans.Updater?.isAnnouncementApplicable
            ? LitMTrans.Updater.isAnnouncementApplicable(item, this.version, new Set())
            : true;
          return {
            ...item,
            isDismissed: dismissed.has(item.id),
            isApplicable
          };
        })
      };
    }

    async hasExistingUserState() {
      if (this.secrets.getMinerUToken()) return true;
      const providers = Object.values(LitMTrans.Constants?.PROVIDERS || {});
      if (providers.some(provider => this.secrets.getLLMKey(provider.id))) return true;

      try {
        for (const child of await this.storage.list(this.storage.documentsRoot)) {
          if ((await this.storage.stat(child))?.type === "directory") return true;
        }
      }
      catch (_) {}

      const generatedPrefs = new Set([
        "agentPort",
        "agentTestNetworkStub",
        "agentTestShutdownProbe",
        "announcementHistory",
        "deepseekWebCacheAlertDismissedUntil",
        "deepseekWebCacheBytes",
        "deepseekWebCacheBytesInitialized",
        "dismissedAnnouncementIds",
        "lastUpdateCheckTime",
        "nonMultimodalModelMarks",
        "promptLibraryInitialized",
        "siliconflowThinkingCapabilities",
        "startupNoticeVersion"
      ]);
      try {
        const branchName = LitMTrans.Constants?.PREF_BRANCH || "extensions.litmtrans.";
        const branch = Services.prefs.getBranch(branchName);
        const names = branch.getChildList("");
        return names.some(name => {
          if (generatedPrefs.has(name) || String(name).startsWith("migration.")) return false;
          if (name === "promptLibrary") {
            const raw = U.getPref("promptLibrary", "");
            const defaults = JSON.stringify(LitMTrans.Constants?.DEFAULT_PROMPT_LIBRARY || []);
            if (!raw || raw === defaults) return false;
          }
          return Services.prefs.prefHasUserValue(`${branchName}${name}`);
        });
      }
      catch (_) {
        return false;
      }
    }

    async getStartupNotice() {
      const version = String(this.version || "").trim();
      const previousVersion = String(U.getPref("startupNoticeVersion", "") || "").trim();
      if (!version) return null;
      if (previousVersion) {
        const compare = LitMTrans.Updater?.compareVersions;
        if (typeof compare === "function" && compare(version, previousVersion) <= 0) return null;
        if (typeof compare !== "function" && version === previousVersion) return null;
      }

      const guide = LitMTrans.StartupContent?.welcome || {
        title: "欢迎使用LitMTrans",
        paragraphs: [],
        calloutTitle: "开始使用",
        calloutText: "新用户只需先配置免费的MinerU令牌；默认网页模式无需配置API。"
      };
      const notes = LitMTrans.ReleaseNotes?.[version] || {};
      const entries = (Array.isArray(notes.entries) ? notes.entries : [])
        .map(item => typeof item === "string"
          ? item.trim()
          : { title: String(item?.title || "").trim(), detail: String(item?.detail || "").trim() })
        .filter(item => typeof item === "string" ? item : item.title || item.detail);
      if (!previousVersion && !await this.hasExistingUserState()) {
        return {
          type: "welcome",
          version,
          title: String(guide.title || "欢迎使用LitMTrans"),
          paragraphs: Array.isArray(guide.paragraphs) ? guide.paragraphs.map(String) : [],
          calloutTitle: String(guide.calloutTitle || "开始使用"),
          calloutText: String(guide.calloutText || "")
        };
      }

      return {
        type: "update",
        version,
        title: String(notes.title || `本次更新 · v${version}`),
        date: String(notes.date || ""),
        entries: entries.length ? entries : ["本版本暂无额外更新说明。"]
      };
    }

    markStartupNoticeSeen(version = "") {
      const currentVersion = String(this.version || "").trim();
      if (!currentVersion || String(version || "").trim() !== currentVersion) return false;
      U.setPref("startupNoticeVersion", currentVersion);
      return true;
    }

    async diagramDocumentID(attachmentID) {
      const attachment = await this.resolveAttachment(attachmentID);
      return this.storage.documentID(attachment);
    }

    async diagramSourceFingerprint(documentID) {
      let markdown = await this.storage.readText(this.storage.path(documentID, "full.cleaned.md"), "");
      if (!markdown) markdown = await this.storage.readText(this.storage.path(documentID, "full.md"), "");
      return markdown ? U.hashString(markdown) : "";
    }

    async withDiagramCacheLock(filePath, operation) {
      const previous = this.diagramCacheLocks.get(filePath) || Promise.resolve();
      const current = previous.catch(() => {}).then(operation);
      this.diagramCacheLocks.set(filePath, current);
      try {
        return await current;
      }
      finally {
        if (this.diagramCacheLocks.get(filePath) === current) this.diagramCacheLocks.delete(filePath);
      }
    }

    scheduleAutoUpdateCheck() {
      if (this.autoUpdateTimer) {
        clearInterval(this.autoUpdateTimer);
        this.autoUpdateTimer = null;
      }

      const runCheckIfDue = async () => {
        if (!U.getPref("autoUpdate", true)) return;
        const lastCheck = Number(U.getPref("lastUpdateCheckTime", "0") || 0);
        const oneDayMs = 24 * 60 * 60 * 1000;
        if (Date.now() - lastCheck < oneDayMs) return;

        try {
          if (!U.getPref("autoUpdate", true)) return;
          U.setPref("lastUpdateCheckTime", String(Date.now()));
          if (LitMTrans.Updater) {
            const result = await LitMTrans.Updater.checkUpdate(this.version);
            if (result && result.hasUpdate) {
              this.availableUpdate = result;
              this.log(`发现可用新版本: v${result.version}`);
            }
            if (Array.isArray(result?.announcements)) {
              this.announcements = result.announcements;
              this.mergeAnnouncements(result.announcements);
            }
          }
        } catch (_) {}
      };

      setTimeout(() => { void runCheckIfDue(); }, 15000);
      this.autoUpdateTimer = setInterval(() => { void runCheckIfDue(); }, 6 * 60 * 60 * 1000);
    }

    async checkForUpdates({ manual = false, onProgress = null, runtime = null } = {}) {
      if (!LitMTrans.Updater) throw new Error("更新模块未就绪");
      U.setPref("lastUpdateCheckTime", String(Date.now()));
      const progressHandler = manual ? (p => {
        if (typeof onProgress === "function") onProgress(p);
        if (runtime) this.emit(runtime, { type: "update-progress", ...p });
      }) : null;
      const result = await LitMTrans.Updater.checkUpdate(this.version, progressHandler);
      if (result && result.hasUpdate) {
        this.availableUpdate = result;
      }
      if (Array.isArray(result?.announcements)) {
        this.announcements = result.announcements;
        this.mergeAnnouncements(result.announcements);
      }
      return result;
    }

    async applyUpdate(payload = {}, onProgress = null, runtime = null) {
      if (!LitMTrans.Updater) throw new Error("更新模块未就绪");
      const updateInfo = payload.updateInfo || this.availableUpdate;
      if (!updateInfo || !updateInfo.version) throw new Error("缺少待更新版本信息");
      const progressHandler = p => {
        if (typeof onProgress === "function") onProgress(p);
        if (runtime) this.emit(runtime, { type: "update-progress", ...p });
      };
      return await LitMTrans.Updater.applyUpdate(updateInfo, progressHandler);
    }

    async init() {
      this._cajShuttingDown = false;
      if (this._initialized) return;
      await this.storage.init();
      try { await this.agent?.init?.(); }
      catch (error) { this.log(`Agent backend 初始化失败: ${error?.message || error}`); }
      this.registerItemDeletionObserver();
      // Item-pane section labels are resolved in the shared Zotero window.
      // Insert the plugin Fluent resource before registering that section.
      const enumerator = Services.wm.getEnumerator("navigator:browser");
      while (enumerator.hasMoreElements()) this.ensureWindowLocalization(enumerator.getNext());
      this.registerReaderIntegrations();
      this.registerItemPaneSection();
      await this.startDeveloperDiagnostics();
      this.scheduleAutoUpdateCheck();
      this._initialized = true;
    }

    async shutdown() {
      this._cajShuttingDown = true;
      try { await this.agent?.shutdown?.(); }
      catch (error) { this.log(`Agent backend 关闭失败: ${error?.message || error}`); }
      for (const cancel of this._cajWorkerTasks || []) cancel();
      if (this.itemNotifierID !== null) {
        try { Zotero.Notifier.unregisterObserver(this.itemNotifierID); } catch (_) {}
        this.itemNotifierID = null;
      }
      for (const [type, handler] of this.readerHandlers) {
        try { Zotero.Reader.unregisterEventListener(type, handler); } catch (_) {}
      }
      this.readerHandlers = [];
      if (this.itemPaneSectionID) {
        try { Zotero.ItemPaneManager.unregisterSection(this.itemPaneSectionID); } catch (_) {}
      }
      this.itemPaneSectionID = null;
      for (const win of [...this.windows]) this.removeFromWindow(win);
      for (const tabID of [...this.tabs.keys()]) this.cleanupTab(tabID);
      for (const operationMap of this.operations.values()) {
        for (const controller of operationMap.values()) controller.abort("插件已停止");
      }
      const pendingOperations = [...this.operationTasks.values()]
        .flatMap(tasks => [...tasks.values()]);
      if (pendingOperations.length) {
        const pending = Promise.allSettled(pendingOperations);
        let timeout = null;
        await Promise.race([
          pending,
          new Promise(resolve => { timeout = setTimeout(resolve, 5000); })
        ]);
        if (timeout) clearTimeout(timeout);
      }
      this.operations.clear();
      this.operationTasks.clear();
      this.operationStopping.clear();
      if (this.diagnosticTimer) {
        clearInterval(this.diagnosticTimer);
        this.diagnosticTimer = null;
      }
      if (this.autoUpdateTimer) {
        clearInterval(this.autoUpdateTimer);
        this.autoUpdateTimer = null;
      }
      await this.webMachine?.shutdown?.();
      this.storage.shutdown();
      this._initialized = false;
    }

    loadDeepSeekWeb(runtime, reload = false) {
      const doc = runtime.browser?.contentDocument;
      let browser = runtime.deepSeekBrowser;
      if (!browser) {
        const slot = doc?.getElementById("deepseek-web-frame");
        if (!slot) throw new Error("网页容器尚未就绪，请重试。");
        browser = slot.firstElementChild;
        if (!browser) {
          const createDoc = runtime.window?.document || doc;
          browser = createDoc.createXULElement("browser");
          browser.setAttribute("type", "content");
          browser.setAttribute("remote", "true");
          browser.setAttribute("maychangeremoteness", "true");
          browser.setAttribute("disableglobalhistory", "true");
          browser.style.cssText = "display:flex;flex:1;min-width:0;min-height:0;width:100%;height:100%";
          slot.appendChild(browser);
        }
        runtime.deepSeekBrowser = browser;
      }
      if (!browser) throw new Error("网页容器尚未就绪，请重试。");
      this.ensureDeepSeekDriver(runtime);
      if (!runtime.deepSeekContextMenuWarmupBound && typeof browser?.addEventListener === "function") {
        runtime.deepSeekContextMenuWarmupBound = true;
        browser.addEventListener("load", () => {
          setTimeout(() => {
            try {
              const url = String(browser.currentURI?.spec || "");
              if (/^https:\/\/chat\.deepseek\.com\//.test(url)) {
                this.ensureDeepSeekDriver(runtime)?.getActor?.();
              }
            } catch (_) {}
          }, 0);
        }, true);
      }
      if (reload || !browser.getAttribute("data-deepseek-loaded")) {
        // 提前建立 frameloader，避免 loadURI 与远程度/进程建立竞态，
        // 导致页面停留在 about:blank 的空白面板（Zotero 7 上更易触发）。
        void this.appendDeepSeekProbe(`[探针7-网页] loadDeepSeekWeb: reload=${reload}, browser存在=${Boolean(browser)}, isRemoteBrowser=${browser.isRemoteBrowser}, remoteType=${browser.remoteType || "-"}`);
        try { void browser.frameLoader; } catch (_) {}
        browser.loadURI(Services.io.newURI("https://chat.deepseek.com/"), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
        browser.setAttribute("data-deepseek-loaded", "true");
        this.traceDeepSeekLoadState(runtime);
      }
      return { opened: true };
    }

    appendDeepSeekProbe(message) {
      // 探针7落盘：白屏场景下工作台面板无 emit 可见，直接写 profile 日志文件取证
      try {
        const logDir = PathUtils.join(this.storage.root, "logs");
        IOUtils.makeDirectory(logDir, { createAncestors: true, ignoreExisting: true }).then(() => {
          const line = `${new Date().toISOString()} ${String(message)}\n`;
          return IOUtils.writeUTF8(PathUtils.join(logDir, "deepseek-web-probe.log"), line, { append: true });
        }).catch(() => {});
      } catch (_) {}
    }

    traceDeepSeekLoadState(runtime) {
      // 探针7：留痕内嵌网页加载进度（进程建立 → 导航 → 文档就绪），供跨版本白屏定位
      const browser = runtime?.deepSeekBrowser;
      if (!browser) return;
      const snap = label => {
        let readyState = "", url = "";
        try { readyState = browser.contentDocument?.readyState || ""; } catch (_) {}
        try { url = String(browser.currentURI?.spec || ""); } catch (_) {}
        const line = `[探针7-网页] ${label}: remote=${browser.isRemoteBrowser}, remoteType=${browser.remoteType || "-"}, url=${url || "-"}, readyState=${readyState || "-"}`;
        try {
          Zotero.debug?.(`[LitMTrans-Probe] ${line}`);
        } catch (_) {}
        this.appendDeepSeekProbe(line);
      };
      snap("loadURI后0s");
      setTimeout(() => snap("loadURI后2s"), 2000);
      setTimeout(() => {
        snap("loadURI后5s");
        let url = "";
        try { url = String(browser.currentURI?.spec || ""); } catch (_) {}
        if (!/^https:\/\/chat\.deepseek\.com\//.test(url)) {
          // 首次导航丢失（frameloader 竟态）时自愈重试一次
          this.appendDeepSeekProbe("[探针7-网页] 首次导航未达 DeepSeek，已自动重试加载");
          try {
            browser.loadURI(Services.io.newURI("https://chat.deepseek.com/"), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
          } catch (_) {}
        }
      }, 5000);
    }

    setDeepSeekWebBounds(runtime, bounds = {}) {
      const browser = runtime.deepSeekBrowser;
      if (!browser) return { ok: false };
      const placementParent = runtime.deepSeekStack || runtime.container;
      let mask = runtime.deepSeekMask;
      if (!mask && runtime.window && placementParent) {
        mask = runtime.window.document.createXULElement("box");
        mask.setAttribute("hidden", "true");
        mask.style.cssText = "background:rgba(0,0,0,0.42);pointer-events:auto;";
        placementParent.appendChild(mask);
        runtime.deepSeekMask = mask;
      }
      const visible = Boolean(bounds.visible);
      if (!visible) {
        browser.setAttribute("hidden", "true");
        browser.style.display = "none";
        if (mask) {
          mask.setAttribute("hidden", "true");
          mask.style.display = "none";
        }
        return { ok: true, visible: false };
      }
      const left = Math.max(0, Math.round(Number(bounds.left) || 0));
      const top = Math.max(0, Math.round(Number(bounds.top) || 0));
      const width = Math.max(0, Math.round(Number(bounds.width) || 0));
      const height = Math.max(0, Math.round(Number(bounds.height) || 0));
      // v10 上 CSS absolute 定位正常；Z7 等版本存在 absolute 被忽略的运行时差异。
      // 写入标准样式后实测 rect，偏差超过 2px 时用 transform 补偿实测偏移，全版本自适应
      const applyBounds = (node, targetLeft, targetTop, targetWidth, targetHeight) => {
        node.removeAttribute("hidden");
        node.style.position = "absolute";
        node.style.left = `${targetLeft}px`;
        node.style.top = `${targetTop}px`;
        node.style.width = `${targetWidth}px`;
        node.style.height = `${targetHeight}px`;
        try {
          // 先清空上次补偿，实测布局引擎的实际落点后再计算偏差。
          // rect 是主窗口视口坐标，target 是 workbench 页面视口坐标，
          // 必须借 stack/container 的实测 rect 把两者换算到同一参照系
          node.style.transform = "";
          const ref = (runtime.deepSeekStack || runtime.container)?.getBoundingClientRect();
          const r = node.getBoundingClientRect();
          if (!ref) return;
          const dx = (ref.left + targetLeft) - r.left;
          const dy = (ref.top + targetTop) - r.top;
          if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
            node.style.transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`;
          }
        } catch (_) {}
      };
      applyBounds(browser, left, top, width, height);
      // 远程 browser 位于原生层，HTML dialog 无法可靠地盖住它。模态界面
      // 打开时让它留在原位但变暗且不可交互，既维持侧栏结构也不会抢焦点。
      if (Boolean(bounds.dimmed)) {
        browser.style.opacity = "0.38";
        browser.style.pointerEvents = "none";
        if (mask) {
          mask.setAttribute("hidden", "true");
          mask.style.display = "none";
        }
        return { ok: true, visible: true, dimmed: true, left, top, width, height };
      }
      browser.style.opacity = "";
      browser.style.pointerEvents = "";
      browser.style.display = "flex";

      const dimmed = false;
      if (mask) {
        if (dimmed) {
          applyBounds(mask, left, top, width, height);
          mask.style.display = "block";
          if (!mask.getAttribute("data-bound-click")) {
            mask.setAttribute("data-bound-click", "true");
            mask.addEventListener("click", () => {
              this.sendToPage(runtime, { type: "event", payload: { type: "close-active-dialog" } });
            });
          }
        } else {
          mask.setAttribute("hidden", "true");
          mask.style.display = "none";
        }
      }
      try {
        const rect = browser.getBoundingClientRect();
        const line = `[探针7-网页] bounds: visible=${visible}, left=${left}, top=${top}, width=${width}, height=${height}, rect=${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.left)},${Math.round(rect.top)}, transform=${browser.style.transform || "-"}, remote=${browser.isRemoteBrowser}, remoteType=${browser.remoteType || "-"}, display=${browser.style.display || "-"}`;
        Zotero.debug?.(`[LitMTrans-Probe] ${line}`);
        this.appendDeepSeekProbe(line);
        const cs = runtime.window?.getComputedStyle?.(browser);
        if (cs) {
          const csLine = `[探针7-网页] computed: position=${cs.position}, left=${cs.left}, top=${cs.top}, width=${cs.width}, height=${cs.height}`;
          Zotero.debug?.(`[LitMTrans-Probe] ${csLine}`);
          this.appendDeepSeekProbe(csLine);
        }
        if (runtime.deepSeekStack || runtime.container) {
          const fmtRect = r => `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}`;
          const parts = [];
          if (runtime.deepSeekStack) parts.push(`stack=${fmtRect(runtime.deepSeekStack.getBoundingClientRect())}`);
          if (runtime.container) parts.push(`container=${fmtRect(runtime.container.getBoundingClientRect())}`);
          const prLine = `[探针7-网页] parents: ${parts.join(", ")}`;
          this.appendDeepSeekProbe(prLine);
        }
      } catch (_) {}
      return { ok: true, visible: true, dimmed, left, top, width, height };
    }

    ensureDeepSeekWebVisible(runtime) {
      if (!runtime) return;
      this.sendToPage(runtime, { type: "event", payload: { type: "ensure-ai-mode", mode: "web" } });
    }

    ensureDeepSeekDriver(runtime) {
      if (!runtime?.deepSeekBrowser) return null;
      if (runtime.deepSeekDriver) return runtime.deepSeekDriver;
      if (!LitMTrans.DeepSeekWeb?.DeepSeekWebDriver) return null;
      try {
        const driver = new LitMTrans.DeepSeekWeb.DeepSeekWebDriver(runtime.deepSeekBrowser);
        runtime.deepSeekDriver = driver;
        return driver;
      } catch (_) {
        return null;
      }
    }

    populateDeepSeekContextMenu(runtime, popup, payload = {}) {
      if (!popup) return;
      const hostWindow = runtime.browser?.ownerGlobal || runtime.window || Zotero.getMainWindow();
      if (!hostWindow?.document) return;

      while (popup.firstChild) {
        popup.removeChild(popup.firstChild);
      }

      const selectedText = String(payload?.selectedText || "").trim();
      if (selectedText) {
        const copyItem = hostWindow.document.createXULElement("menuitem");
        copyItem.setAttribute("label", "复制");
        copyItem.addEventListener("command", () => {
          try {
            this.writeClipboardText(selectedText);
          } catch (_) {}
        });
        popup.appendChild(copyItem);
        popup.appendChild(hostWindow.document.createXULElement("menuseparator"));
      }

      const addPaperSourceItem = hostWindow.document.createXULElement("menuitem");
      addPaperSourceItem.setAttribute("label", "原文添加至AI");
      addPaperSourceItem.addEventListener("command", () => {
        void this.addPaperSourceToAI(runtime);
      });
      popup.appendChild(addPaperSourceItem);

      const addPaperPagesItem = hostWindow.document.createXULElement("menuitem");
      addPaperPagesItem.setAttribute("label", "图形式添加至AI");
      addPaperPagesItem.addEventListener("command", () => {
        void this.addPaperPagesToAI(runtime);
      });
      popup.appendChild(addPaperPagesItem);

      const pasteItem = hostWindow.document.createXULElement("menuitem");
      pasteItem.setAttribute("label", "粘贴");
      pasteItem.addEventListener("command", () => {
        void this.pasteClipboardToAI(runtime).catch(() => {});
      });
      popup.appendChild(pasteItem);
      popup.appendChild(hostWindow.document.createXULElement("menuseparator"));

      const reloadItem = hostWindow.document.createXULElement("menuitem");
      reloadItem.setAttribute("label", "刷新");
      reloadItem.addEventListener("command", () => {
        void this.loadDeepSeekWeb(runtime, true);
      });
      popup.appendChild(reloadItem);

      const openExternalItem = hostWindow.document.createXULElement("menuitem");
      openExternalItem.setAttribute("label", "在浏览器中打开");
      openExternalItem.addEventListener("command", () => {
        void this.openExternalURL("https://chat.deepseek.com/");
      });
      popup.appendChild(openExternalItem);
    }

    openDeepSeekContextMenu(runtime, payload = {}) {
      if (!runtime) return { ok: false };
      // content 各 frame 与工作台回退通路会重复上报同一位置右键，坐标窗口内去重。
      const now = Date.now();
      const sx = Number(payload?.screenX || 0);
      const sy = Number(payload?.screenY || 0);
      const last = this._deepSeekMenuDedupe;
      if (last && (now - last.time < 300) && Math.abs(sx - last.screenX) <= 8 && Math.abs(sy - last.screenY) <= 8) {
        // 后到通路可能带有先到通路缺失的选中文字（工作台侧拿不到网页内选区），
        // 用它重新填充菜单，保证「复制」项不因触发顺序而丢失。
        const lateText = String(payload?.selectedText || "").trim();
        const opened = runtime.deepSeekNativePopup;
        if (lateText && opened?.isConnected) {
          runtime.deepSeekMenuPayload = payload;
          this.populateDeepSeekContextMenu(runtime, opened, payload);
        }
        return { ok: true, deduped: true };
      }
      this._deepSeekMenuDedupe = { time: now, screenX: sx, screenY: sy };
      const hostWindow = runtime.browser?.ownerGlobal || runtime.window || Zotero.getMainWindow();
      if (!hostWindow?.document) return { ok: false };

      const doc = hostWindow.document;
      let popup = runtime.deepSeekNativePopup;
      if (!popup || !popup.isConnected) {
        let popupset = runtime.popupset;
        if (!popupset || !popupset.isConnected) {
          popupset = doc.getElementById("mainPopupSet");
          if (!popupset || !popupset.isConnected) {
            popupset = doc.createXULElement("popupset");
            try {
              (runtime.container || doc.documentElement || doc.body).appendChild(popupset);
              runtime.popupset = popupset;
            } catch (_) {}
          }
        }
        popup = doc.createXULElement("menupopup");
        popup.className = "litmtrans-deepseek-context-menu";
        popupset.appendChild(popup);
        runtime.deepSeekNativePopup = popup;
      }

      // 记录本次右键的 payload，popupshowing 重新填充时复用同一份，
      // 否则打开菜单会同步触发 popupshowing 并用空 payload 把「复制」项清掉。
      runtime.deepSeekMenuPayload = payload;
      this.populateDeepSeekContextMenu(runtime, popup, payload);

      const clientX = Number(payload?.clientX || 0);
      const clientY = Number(payload?.clientY || 0);
      const screenX = Number(payload?.screenX || 0);
      const screenY = Number(payload?.screenY || 0);

      const doOpen = () => {
        try {
          if (Number.isFinite(screenX) && Number.isFinite(screenY) && screenX > 0 && screenY > 0) {
            popup.openPopupAtScreen(Math.round(screenX), Math.round(screenY), true);
            return;
          }
          const browserNode = runtime.deepSeekBrowser || runtime.browser;
          const rect = browserNode?.getBoundingClientRect?.();
          if (rect) {
            const relX = (clientX > 0) ? clientX : 20;
            const relY = (clientY > 0) ? clientY : 20;
            if (hostWindow.windowUtils?.toScreenRectInCSSUnits) {
              const pt = hostWindow.windowUtils.toScreenRectInCSSUnits(
                rect.left + relX,
                rect.top + relY,
                0, 0
              );
              popup.openPopupAtScreen(pt.x, pt.y, true);
              return;
            }
            const calcX = (hostWindow.screenX || 0) + rect.left + relX;
            const calcY = (hostWindow.screenY || 0) + rect.top + relY;
            popup.openPopupAtScreen(Math.round(calcX), Math.round(calcY), true);
            return;
          }
          if (browserNode) {
            popup.openPopup(browserNode, "after_start", 10, 10, true, false);
          }
        } catch (_) {}
      };

      if (typeof hostWindow.setTimeout === "function") {
        hostWindow.setTimeout(doOpen, 0);
      } else {
        doOpen();
      }

      return { ok: true };
    }

    async appendPaperSourceToDeepSeek(runtime) {
      const context = await this.attachmentContext(runtime.attachmentID);
      const snapshot = await this.pipeline.snapshot(context);
      let markdown = String(snapshot?.parsed?.markdown || "").trim();
      // 未解析时先询问用户，确认后触发解析，解析成功自动继续添加
      if (!markdown) {
        const win = runtime.window || runtime.browser?.ownerGlobal || Zotero.getMainWindow();
        const flags = Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING
          + Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_IS_STRING;
        const choice = Services.prompt.confirmEx(
          win,
          "原文添加至AI",
          "该论文尚未解析，是否先解析原文？",
          flags,
          "解析并添加",
          "取消",
          null, null, {}
        );
        if (choice !== 0) return { cancelled: true };
        this.sendToPage(runtime, {
          type: "event",
          payload: { type: "toast", message: "开始解析论文原文...", level: "info" }
        });
        await this.withOperation(runtime, "parse", async (signal, emit) => {
          const parseContext = await this.attachmentContext(runtime.attachmentID);
          await this.pipeline.parse(parseContext, {}, emit, signal);
          this.emit(runtime, { type: "document-state", state: await this.stateForAttachment(runtime.attachmentID) });
        });
        markdown = String((await this.pipeline.snapshot(context))?.parsed?.markdown || "").trim();
        if (!markdown) throw new Error("解析未能产出原文，请调整解析设置后重试。");
      }
      await this.loadDeepSeekWeb(runtime, false);
      const driver = this.ensureDeepSeekDriver(runtime);
      if (!driver) throw new Error("DeepSeek网页尚未就绪，请稍后重试。");
      const name = `${U.safeStem(context.title || context.attachment.attachmentFilename || "paper", 100)}.md`;
      try {
        await driver.attachFiles([{
          name,
          type: "text/markdown",
          base64: U.encodeBytesBase64(new TextEncoder().encode(markdown))
        }]);
        return { attached: true };
      } catch (error) {
        // 保险丝：若页面上实际上已存在已完成的附件卡片且不在上传中，说明上传已就绪，绝不执行全文回退粘贴
        try {
          const checkReady = await driver.execute("wait-attachments-ready", { timeout: 1000 }, 2000);
          if (checkReady?.ready || (checkReady?.attachmentCount > 0 && !checkReady?.uploading)) {
            this.log("检测到 DeepSeek 页面已存在附件卡片，忽略等待异常，取消全文回退粘贴。");
            return { attached: true };
          }
        } catch (_) {}
        this.log(`上传论文原文附件失败，改为粘贴文本: ${error?.message || error}`);
        return driver.pasteDraft(markdown);
      }
    }

    // 图形式添加：与要点提炼同一管线，把PDF页面渲染为图片后上传到DeepSeek
    async appendPaperPagesToDeepSeek(runtime, options = {}) {
      const context = await this.attachmentContext(runtime.attachmentID);
      const webSettings = this.getSettings?.() || {};
      const rawQuality = String(webSettings.webPageImageQuality || "high").trim().toLowerCase();
      const quality = ["low", "medium", "high"].includes(rawQuality) ? rawQuality : "high";
      options.emit?.({ type: "progress", phase: "deepseek-pages", message: "正在准备 DeepSeek 网页…", progress: 5 });
      await this.loadDeepSeekWeb(runtime, false);
      U.throwIfAborted(options.signal);
      const driver = this.ensureDeepSeekDriver(runtime);
      if (!driver) throw new Error("DeepSeek网页尚未就绪，请稍后重试。");
      const pageResult = await this.deepSeekWebProvider.pageRenderer.renderAndCachePages(runtime, context.documentID, {
        maxImages: 49,
        quality,
        signal: options.signal,
        emit: options.emit
      });
      if (pageResult.error) throw new Error(pageResult.error);
      const imagePaths = pageResult.images || [];
      if (!imagePaths.length) throw new Error("未能生成页面图像，请确认文献已在预览中打开。");
      options.emit?.({
        type: "progress",
        phase: "deepseek-pages",
        message: pageResult.cached
          ? `已读取页面图缓存，正在上传 ${imagePaths.length} 张图像…`
          : `页面图像生成完成，正在上传 ${imagePaths.length} 张图像…`,
        progress: 80
      });
      await driver.attachFiles(imagePaths, options.signal, {
        emit: options.emit,
        waitIndefinitely: true
      });
      if (pageResult.downgraded && pageResult.message) {
        this.sendToPage(runtime, {
          type: "event",
          payload: { type: "toast", message: pageResult.message, level: "warning" }
        });
      }
      return { attached: imagePaths.length };
    }

    async addPaperSourceToAI(runtime) {
      try {
        const result = await this.appendPaperSourceToDeepSeek(runtime);
        return result;
      } catch (error) {
        this.log(`添加论文原文到DeepSeek失败: ${error?.message || error}`);
        this.sendToPage(runtime, {
          type: "event",
          payload: { type: "toast", message: `添加论文原文失败：${error?.message || error}`, level: "error" }
        });
        throw error;
      }
    }

    async addPaperPagesToAI(runtime) {
      try {
        const result = await this.withOperation(runtime, "deepseek-pages", async (signal, emit) => {
          const attached = await this.appendPaperPagesToDeepSeek(runtime, { signal, emit });
          emit({
            type: "progress",
            phase: "deepseek-pages",
            message: `页面图像已添加至 DeepSeek（共 ${attached?.attached || 0} 张）`,
            progress: 100
          });
          emit({ type: "toast", message: `页面图像已添加至 DeepSeek（共 ${attached?.attached || 0} 张）`, level: "success" });
          return attached;
        });
        return result;
      } catch (error) {
        this.log(`添加论文页面图像到DeepSeek失败: ${error?.message || error}`);
        this.sendToPage(runtime, {
          type: "event",
          payload: { type: "toast", message: `添加论文页面图像失败：${error?.message || error}`, level: "error" }
        });
        throw error;
      }
    }

    async pasteClipboardToAI(runtime) {
      const text = String(this.readClipboardText() || "");
      if (!text) {
        this.sendToPage(runtime, {
          type: "event",
          payload: { type: "toast", message: "剪贴板没有可粘贴的文字", level: "info" }
        });
        return { pasted: false, empty: true };
      }
      this.sendToPage(runtime, {
        type: "event",
        payload: { type: "toast", message: "正在粘贴到DeepSeek输入框...", level: "info" }
      });
      try {
        await this.loadDeepSeekWeb(runtime, false);
        const driver = this.ensureDeepSeekDriver(runtime);
        if (!driver) throw new Error("DeepSeek网页尚未就绪，请稍后重试。");
        const result = await driver.pasteDraft(text, "无法将剪贴板内容粘贴到DeepSeek输入框。");
        this.sendToPage(runtime, {
          type: "event",
          payload: { type: "toast", message: "已粘贴到DeepSeek输入框", level: "success" }
        });
        return { pasted: true, result };
      } catch (error) {
        this.log(`粘贴剪贴板内容到DeepSeek失败: ${error?.message || error}`);
        this.sendToPage(runtime, {
          type: "event",
          payload: { type: "toast", message: `粘贴到DeepSeek输入框失败：${error?.message || error}`, level: "error" }
        });
        throw error;
      }
    }

    registerItemDeletionObserver() {
      if (this.itemNotifierID !== null || typeof Zotero.Notifier?.registerObserver !== "function") return false;
      const observer = {
        notify: (event, type, ids) => {
          // A normal Zotero delete first moves an item to the trash; `delete`
          // is emitted when it is later erased permanently. Both must clear
          // this plugin's independently stored document data.
          if (!["trash", "delete"].includes(event) || type !== "item") return;
          void this.clearCachesForDeletedItems(ids, event).catch(error => Zotero.logError(error));
        }
      };
      try {
        this.itemNotifierID = Zotero.Notifier.registerObserver(observer, ["item"], this.id);
        return true;
      }
      catch (error) {
        this.log(`Item deletion observer is unavailable: ${error}`);
        return false;
      }
    }

    async clearCachesForDeletedItems(itemIDs, event = "delete") {
      const deleted = new Set((Array.isArray(itemIDs) ? itemIDs : [itemIDs])
        .map(value => Number(value))
        .filter(Number.isFinite));
      if (!deleted.size) return [];
      for (const itemID of deleted) {
        this.stopOperations(this.tabIDForAttachment(itemID));
        this.cleanupTab(this.tabIDForAttachment(itemID));
      }
      const relatedRecords = await this.storage.findDocumentRecordsForItemIDs?.([...deleted]) || [];
      const relatedDocumentIDs = new Set(relatedRecords.map(record => record?.documentID).filter(Boolean));
      for (const itemID of deleted) {
        try {
          const item = Zotero.Items.get(itemID);
          if (item) relatedDocumentIDs.add(this.storage.documentID(item));
        }
        catch (_) {}
      }
      for (const documentID of relatedDocumentIDs) {
        try {
          await this.removeCAJReaderAttachment(documentID, { required: false });
        }
        catch (error) {
          Zotero.logError?.(error);
        }
      }
      const cleared = await this.storage.clearDocumentsForDeletedItemIDs([...deleted]);
      const clearedDocumentIDs = Array.isArray(cleared) ? cleared : (cleared?.clearedDocumentIDs || []);
      const index = this.agent?.facade?.literature?.index;
      for (const documentID of clearedDocumentIDs) {
        try {
          const record = relatedRecords.find(row => String(row?.documentID || "") === String(documentID)) || null;
          const parentDeleted = Boolean(record?.parentItemID && deleted.has(Number(record.parentItemID)));
          if (event === "delete" && parentDeleted) await index?.removeDocument?.(documentID);
          else await index?.removeDocumentStatus?.(documentID, { documentID });
        }
        catch (error) { Zotero.logError?.(error); }
      }
      if (clearedDocumentIDs.length) this.log(`Cleared ${clearedDocumentIDs.length} document cache(s) for deleted Zotero item(s)`);
      return cleared;
    }

    developerDiagnosticsPaths() {
      const directory = PathUtils.join(this.storage.root, "dev-diagnostics");
      return {
        directory,
        marker: PathUtils.join(directory, "enabled"),
        command: PathUtils.join(directory, "command.json"),
        latest: PathUtils.join(directory, "latest.json")
      };
    }

    async startDeveloperDiagnostics() {
      const paths = this.developerDiagnosticsPaths();
      if (!await this.storage.exists(paths.marker)) return false;
      await this.storage.ensureDir(paths.directory);
      this.diagnosticTimer = setInterval(() => {
        void this.pollDeveloperDiagnostics();
      }, 400);
      void this.pollDeveloperDiagnostics();
      this.log(`隔离检查模式已启用：${paths.directory}`);
      return true;
    }

    async pollDeveloperDiagnostics() {
      if (this.diagnosticBusy) return;
      const paths = this.developerDiagnosticsPaths();
      const command = await this.storage.readJSON(paths.command, null);
      if (!command?.id || !command?.operation) return;
      this.diagnosticBusy = true;
      await this.storage.remove(paths.command, false);
      let result;
      try {
        const payload = await this.runDeveloperDiagnostic(command);
        result = {
          id: String(command.id),
          operation: String(command.operation),
          ok: true,
          completedAt: new Date().toISOString(),
          ...payload
        };
      }
      catch (error) {
        const normalized = U.normalizeError(error);
        result = {
          id: String(command.id),
          operation: String(command.operation),
          ok: false,
          completedAt: new Date().toISOString(),
          error: {
            name: String(normalized.name || "Error"),
            message: String(normalized.message || "检查失败")
          }
        };
      }
      try {
        await this.storage.writeJSON(
          PathUtils.join(paths.directory, `result.${String(command.id).replace(/[^A-Za-z0-9_-]+/g, "")}.json`),
          result
        );
        await this.storage.writeJSON(paths.latest, result);
      }
      finally {
        this.diagnosticBusy = false;
      }
    }

    async runDeveloperDiagnostic(command) {
      const operation = String(command.operation || "");
      if (operation === "snapshot") return this.developerDiagnosticSnapshot();
      if (operation === "multimodal-probe") return this.runMultimodalProbe(command);
      if (operation === "document-multimodal-probe") return this.runDocumentMultimodalProbe(command);
      if (operation === "document-streaming-probe") {
        return this.runDocumentMultimodalProbe({ ...command, stream: true });
      }
      if (operation === "chat-roundtrip-probe") return this.runChatRoundtripProbe(command);
      if (operation === "provider-cache-probe") return this.runProviderCacheProbe(command);
      if (operation === "gemini-transport-probe") return this.runGeminiTransportProbe();
      if (operation === "edge-local-probe") return this.runEdgeLocalProbe();
      if (operation === "edge-document-probe") return this.runEdgeDocumentProbe(command);
      if (operation === "caj-probe") return this.runCAJProbe(command);
      if (operation === "caj-reader-probe") return this.runCAJReaderProbe(command);
      if (operation === "caj-storage-probe") return this.runCAJStorageProbe(command);
      throw new Error(`不支持的检查操作：${operation}`);
    }

    async runCAJProbe(command) {
      const directory = String(command.directory || "").trim();
      if (!directory || !await this.storage.exists(directory)) throw new Error("CAJ 样本目录不存在");
      const paths = (await this.storage.list(directory))
        .filter(path => /\.caj$/i.test(String(path)))
        .sort((left, right) => String(left).localeCompare(String(right), "zh-CN"));
      if (!paths.length) throw new Error("CAJ 样本目录中没有 .caj 文件");
      const files = [];
      for (const sourcePath of paths) {
        const bytes = await this.storage.readBytes(sourcePath);
        const format = LitMTrans.CAJConverter.detectFormat(bytes);
        const pdf = format === "HN" || format === "C8"
          ? await this.convertWithNativeBackend(sourcePath, format)
          : await LitMTrans.CAJConverter.convertToPDF(bytes);
        const normalizedPDF = this.normalizeCAJBytes(pdf);
        const parsed = await PDFLib.PDFDocument.load(normalizedPDF, {
          throwOnInvalidObject: true,
          updateMetadata: false
        });
        const pageCount = parsed.getPageCount();
        if (!pageCount) throw new Error(`${PathUtils.filename(sourcePath)} 转换后没有页面`);
        files.push({
          name: PathUtils.filename(sourcePath),
          format,
          sourceBytes: bytes.byteLength || bytes.length || 0,
          pdfBytes: normalizedPDF.byteLength || normalizedPDF.length || 0,
          pageCount
        });
      }
      return { passed: true, directory, fileCount: files.length, files };
    }

    async runCAJReaderProbe(command) {
      const directory = String(command.directory || "").trim();
      if (!directory || !await this.storage.exists(directory)) throw new Error("CAJ 样本目录不存在");
      const sourcePaths = (await this.storage.list(directory))
        .filter(path => /\.caj$/i.test(String(path)))
        .sort((left, right) => String(left).localeCompare(String(right), "zh-CN"));
      if (!sourcePaths.length) throw new Error("CAJ 样本目录中没有 .caj 文件");
      const mainWindow = Zotero.getMainWindow?.();
      if (!mainWindow?.Zotero_Tabs?.add) throw new Error("无法创建隔离的 Zotero 工作台标签页");
      const createdIDs = [];
      const files = [];
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      for (const sourcePath of sourcePaths) {
        let sourceAttachment = null;
        let readerAttachment = null;
        let tabID = "";
        try {
          sourceAttachment = await Zotero.Attachments.linkFromFile({
            file: U.createLocalFile(sourcePath),
            title: PathUtils.filename(sourcePath),
            contentType: "application/octet-stream",
            libraryID: Zotero.Libraries.userLibraryID
          });
          createdIDs.push(sourceAttachment.id);
          const pdfPath = await this.cachedPDFForCAJ(sourceAttachment);
          readerAttachment = await this.ensureCAJReaderAttachment(sourceAttachment, pdfPath);
          if (!readerAttachment.isPDFAttachment?.()) throw new Error("转换附件未被 Zotero 识别为 PDF");
          createdIDs.push(readerAttachment.id);
          const readerPath = await readerAttachment.getFilePathAsync?.() || readerAttachment.getFilePath?.();
          if (this.normalizeCAJPath(readerPath) !== this.normalizeCAJPath(pdfPath)) {
            throw new Error("Reader 附件未指向缓存 PDF");
          }
          tabID = await this.openWorkbench(sourceAttachment, { window: mainWindow });
          const runtime = this.tabs.get(tabID);
          const deadline = Date.now() + 90000;
          while (Date.now() < deadline) {
            const pdfWindow = runtime?.pdfPreview?._internalReader?._primaryView?._iframeWindow;
            const viewer = pdfWindow?.PDFViewerApplication?.pdfViewer;
            if (viewer && Number(viewer.pagesCount || 0) > 0) break;
            await wait(250);
          }
          const pdfWindow = runtime?.pdfPreview?._internalReader?._primaryView?._iframeWindow;
          const viewer = pdfWindow?.PDFViewerApplication?.pdfViewer;
          const pageCount = Number(viewer?.pagesCount || 0);
          if (!viewer || pageCount <= 0) throw new Error("LitMTrans 工作台未创建 PDF.js 页面");
          files.push({
            name: PathUtils.filename(sourcePath),
            readerAttachmentID: readerAttachment.id,
            pageCount
          });
        }
        finally {
          if (tabID) {
            try { mainWindow.Zotero_Tabs.close(tabID); } catch (_) { this.cleanupTab(tabID); }
          }
          for (const id of createdIDs.splice(-2).reverse()) {
            try { await Zotero.Items.trashTx(id); } catch (_) {}
          }
        }
      }
      return { passed: files.length === sourcePaths.length, directory, fileCount: files.length, files };
    }

    async runCAJStorageProbe(command) {
      const directory = String(command.directory || "").trim();
      if (!directory || !await this.storage.exists(directory)) throw new Error("CAJ 样本目录不存在");
      const sourcePath = (await this.storage.list(directory))
        .filter(path => /\.caj$/i.test(String(path)))
        .sort((left, right) => String(left).localeCompare(String(right), "zh-CN"))[0];
      if (!sourcePath) throw new Error("CAJ 样本目录中没有 .caj 文件");

      const createdIDs = [];
      let sourceAttachment = null;
      let readerAttachment = null;
      try {
        sourceAttachment = await Zotero.Attachments.linkFromFile({
          file: U.createLocalFile(sourcePath),
          title: PathUtils.filename(sourcePath),
          contentType: "application/octet-stream",
          libraryID: Zotero.Libraries.userLibraryID
        });
        createdIDs.push(sourceAttachment.id);

        const pdfPath = await this.cachedPDFForCAJ(sourceAttachment);
        readerAttachment = await this.ensureCAJReaderAttachment(sourceAttachment, pdfPath);
        createdIDs.push(readerAttachment.id);
        const documentID = this.storage.documentID(sourceAttachment);
        const summary = await this.storage.getStorageSummary();
        const document = summary.documents.find(row => row.id === documentID);
        const cajCategory = document?.categories?.find(row => row.key === "cajSource");
        if (!document?.isCAJ || !cajCategory?.files || !document.caj?.cacheValidated) {
          throw new Error("存储管理器未识别 CAJ 转换缓存");
        }

        const cleared = await this.clearStorageData({
          target: "document",
          documentID,
          category: "cajSource"
        }, sourceAttachment.id);
        if (await this.storage.exists(pdfPath)) throw new Error("CAJ 缓存清理后 source.pdf 仍存在");
        const deletedReader = Zotero.Items.get(readerAttachment.id);
        if (deletedReader && !deletedReader.deleted) throw new Error("CAJ 自动阅读附件未同步清理");

        const rebuiltPath = await this.cachedPDFForCAJ(sourceAttachment);
        const rebuiltReader = await this.ensureCAJReaderAttachment(sourceAttachment, rebuiltPath);
        createdIDs.push(rebuiltReader.id);
        if (!(await this.storage.exists(rebuiltPath)) || !rebuiltReader.isPDFAttachment?.()) {
          throw new Error("CAJ 缓存清理后无法重建阅读附件");
        }
        return {
          passed: true,
          name: PathUtils.filename(sourcePath),
          format: String(document.caj.format || ""),
          pageCount: Number(document.caj.pageCount || 0),
          cachedBytes: cajCategory.bytes,
          clearedBytes: Number(cleared.clearedBytes || 0),
          readerAttachmentRemoved: Boolean(cleared.readerAttachmentRemoved),
          rebuiltReaderAttachmentID: rebuiltReader.id
        };
      }
      finally {
        if (sourceAttachment) {
          try { await this.storage.clearDocument(sourceAttachment); }
          catch (_) {}
        }
        for (const id of createdIDs.reverse()) {
          try { await Zotero.Items.trashTx(id); }
          catch (_) {}
        }
      }
    }

    async runEdgeDocumentProbe(command) {
      const documentID = String(command.documentID || "");
      if (!/^\d+-[A-Z0-9]+$/.test(documentID)) throw new Error("文档 ID 无效");
      const source = await this.storage.readText(PathUtils.join(this.storage.documentsRoot, documentID, "full.cleaned.md"), "");
      if (!source.trim()) throw new Error("文献全文不存在");
      const directory = PathUtils.join(this.developerDiagnosticsPaths().directory, `edge-document-${command.id}`);
      await this.storage.ensureDir(directory);
      await this.storage.writeText(PathUtils.join(directory, "source.md"), source);
      const calls = [], messages = [];
      const translator = new LitMTrans.EdgeLocalTranslator("简体中文", "英文", {
        downloadConsent: async () => true,
        log: message => messages.push(String(message))
      });
      const translate = translator.translate.bind(translator);
      translator.translate = async (text, signal) => {
        const row = { source: text, startedAt: new Date().toISOString() };
        calls.push(row);
        try { row.translation = await translate(text, signal); return row.translation; }
        catch (error) { row.error = U.normalizeError(error); throw error; }
        finally { await this.storage.writeJSON(PathUtils.join(directory, "calls.json"), calls); }
      };
      try {
        if (command.mode === "layout") {
          const storage = new LitMTrans.Storage();
          storage.root = directory;
          storage.documentsRoot = PathUtils.join(directory, "documents");
          await storage.ensureDir(storage.path(documentID));
          for (const name of ["layout.json", "model.json", "asset-map.json", "image-map.json", "document.json", "layout-revision.json"]) {
            const input = this.storage.path(documentID, name);
            if (await this.storage.exists(input)) await storage.copyFile(input, storage.path(documentID, name));
          }
          const webMachine = {
            translateRecords: (records, options) => this.webMachine.translateRecords(records, { ...options, translator })
          };
          const layout = new LitMTrans.LayoutTranslationService(storage, this.llm, webMachine);
          const records = await layout.extractRecords(documentID);
          await storage.writeJSON(PathUtils.join(directory, "records.json"), records);
          const result = await layout.translateWebMachine(documentID, {
            provider: "edge_local", machineSourceLanguage: "英文", targetLanguage: "简体中文", force: true
          }, event => { if (event.type === "log") messages.push(event.message); });
          await storage.writeJSON(PathUtils.join(directory, "translations.json"), result.translations);
          await storage.writeJSON(PathUtils.join(directory, "render-model.json"), result.model);
          return { passed: true, mode: "layout", documentID, directory, records: records.length,
            translatedRecords: Object.keys(result.translations).length, calls: calls.length, cached: result.cached };
        }
        const output = await this.webMachine.translateMarkdown(source, {
          provider: "edge_local", sourceLanguage: "英文", targetLanguage: "简体中文", translator,
          log: message => messages.push(String(message))
        });
        await this.storage.writeText(PathUtils.join(directory, "translation.md"), output);
        return { passed: true, documentID, directory, sourceChars: source.length, translationChars: output.length,
          calls: calls.length, addedColonCalls: calls.filter(row => !/[:：]/u.test(row.source) && /[:：]/u.test(row.translation || "")).length };
      }
      finally {
        await translator.close();
        await this.storage.writeJSON(PathUtils.join(directory, "messages.json"), messages);
      }
    }

    async runEdgeLocalProbe() {
      const source = "This is a local translation test for an academic paper.";
      const messages = [];
      const options = {
        provider: "edge_local",
        targetLanguage: "简体中文",
        sourceLanguage: "英文",
        log: message => messages.push(String(message)),
        edgeDownloadConsent: async () => true
      };
      const translator = new LitMTrans.EdgeLocalTranslator("简体中文", "英文", {
        log: options.log,
        downloadConsent: async () => true
      });
      try {
        const translation = await translator.translate(source);
        const punctuationCases = [];
        for (const text of [
          "Abstract", "Introduction", "Results and discussion", "Conclusion",
          "The model improves translation accuracy.",
          "The results are shown in Figure 2.",
          "We propose a new method for image classification.",
          "Note: the model uses two parameters.",
          "The ratio is 1:2.",
          "The measured value is $x^2$ in Eq. (16).",
          "The measured value is ZXQH0123456789ABHQXZ in Eq. (16).",
          "The following equation defines the loss:",
          "Figure 2. Comparison of the proposed method and the baseline.",
          "Accuracy\nThe model improves prediction accuracy."
        ]) {
          try {
            const output = await translator.translate(text);
            punctuationCases.push({ source: text, translation: output,
              addedColon: !/[:：]/u.test(text) && /[:：]/u.test(output),
              repeatedPunctuation: /[:：]{2,}|[。.!！?？]{3,}/u.test(output) });
          }
          catch (error) {
            punctuationCases.push({ source: text, error: U.normalizeError(error) });
          }
        }
        await translator.endJob();
        const streamSource = "# ABSTRACT\n\nThe model uses $x^2$ in Eq. (16).";
        const streamTranslation = await this.webMachine.translateMarkdown(streamSource, options);
        const layoutSource = [{ id: "edge-layout-probe", text: "FIGURE 2. The measured value is $x^2$ in Eq. (16)." }];
        const layoutTranslations = await this.webMachine.translateRecords(layoutSource, options);
        const layoutTranslation = layoutTranslations["edge-layout-probe"] || "";
        return {
          passed: Boolean(
            translation && translation !== source && /[\u3400-\u9fff]/u.test(translation)
            && /[\u3400-\u9fff]/u.test(streamTranslation)
            && streamTranslation.includes("$x^2$") && streamTranslation.includes("(16)")
            && /[\u3400-\u9fff]/u.test(layoutTranslation)
            && layoutTranslation.includes("$x^2$") && layoutTranslation.includes("(16)")
          ),
          source,
          translation,
          streamSource,
          streamTranslation,
          layoutSource: layoutSource[0].text,
          layoutTranslation,
          punctuationCases,
          punctuationQualityPassed: !punctuationCases.some(row => row.error || row.addedColon || row.repeatedPunctuation)
            && !/[:：]/u.test(streamTranslation) && !/[:：]/u.test(layoutTranslation),
          messages
        };
      }
      finally {
        await translator.close();
      }
    }

    async runGeminiTransportProbe() {
      const config = await this.llm.ensureConfiguredModel(
        this.llm.resolveConfig({ purpose: "chat", engine: "api", aiMode: "api" })
      );
      if (String(config.provider || "") !== "gemini" || !config.apiKey) {
      throw new Error("Gemini传输检查需要先配置Gemini对话模型和API密钥");
      }
      const base = String(config.baseURL || "https://generativelanguage.googleapis.com/v1beta")
        .replace(/\/+$/, "")
        .replace(/\/(?:v1|v1beta)$/i, "");
      const payload = {
        model: String(config.model || ""),
        input: "Reply with exactly OK.",
        store: false,
        stream: false,
        generation_config: { thinking_level: "minimal", max_output_tokens: 16 }
      };
      const variants = [
        { name: "v1beta-minimal", url: `${base}/v1beta/interactions` },
        { name: "v1-minimal", url: `${base}/v1/interactions` }
      ];
      const attempts = [];
      for (const variant of variants) {
        const startedAt = Date.now();
        try {
          const result = await LitMTrans.HTTP.requestJSON("POST", variant.url, {
            token: "",
            headers: {
              "x-goog-api-key": config.apiKey,
              "Content-Type": "application/json"
            },
            json: payload,
            timeout: 20000
          });
          const text = String(LitMTrans.PortedCore?.extractGeminiInteractionText?.(result) || "").trim();
          attempts.push({
            name: variant.name,
            ok: true,
            elapsedMs: Date.now() - startedAt,
            responseChars: text.length,
            responsePreview: text.slice(0, 80)
          });
          return {
            provider: "gemini",
            model: String(config.model || ""),
            attempts,
            passed: true
          };
        }
        catch (error) {
          attempts.push({
            name: variant.name,
            ok: false,
            elapsedMs: Date.now() - startedAt,
            error: U.normalizeError(error)
          });
        }
      }
      return {
        provider: "gemini",
        model: String(config.model || ""),
        attempts,
        passed: false
      };
    }

    async developerDiagnosticSnapshot() {
      const documents = [];
      for (const directory of await this.storage.list(this.storage.documentsRoot)) {
        const documentID = PathUtils.filename(directory);
        const meta = await this.storage.readJSON(PathUtils.join(directory, "document.json"), null);
        const chat = await this.storage.readJSON(PathUtils.join(directory, "chat", "session.document-chat.json"), null);
        const imageMap = await this.storage.readJSON(PathUtils.join(directory, "image-map.json"), []);
        const sourceReady = Boolean(String(await this.storage.readText(PathUtils.join(directory, "full.cleaned.md"), "")).trim());
        const transportParts = sourceReady
          ? await this.chat.currentDocumentMessageParts(documentID, "transport check snapshot", null, {})
          : [];
        const transportText = (Array.isArray(transportParts) ? transportParts : [])
          .filter(part => part?.type === "text")
          .map(part => String(part.text || ""))
          .join("");
        const imageDiagnostics = sourceReady
          ? await this.chat.diagnoseCurrentDocumentImages(documentID, null, {})
          : [];
        documents.push({
          documentID,
          title: String(meta?.title || meta?.fileName || ""),
          sourceReady,
          imageCount: Array.isArray(imageMap) ? imageMap.filter(row => !row?.warning).length : 0,
          transportImageCount: (Array.isArray(transportParts) ? transportParts : [])
            .filter(part => part?.type === "image_url" && String(part?.image_url?.url || "").startsWith("data:image/"))
            .length,
          transportReadFailures: (transportText.match(/\[提示：读取图片失败/g) || []).length,
          imageDiagnostics,
          chatMessageCount: Array.isArray(chat?.messages) ? chat.messages.length : 0,
          chatModel: String(chat?.sessionModel || "")
        });
      }
      const settings = this.llm.getSettings("chat");
      return {
        profile: "isolated-development",
        provider: String(settings.provider || ""),
        model: String(settings.model || ""),
        baseURL: String(settings.baseURL || ""),
        hasAPIKey: Boolean(settings.hasAPIKey),
        documents
      };
    }

    diagnosticPayloadSummary(config, messages) {
      if (!LitMTrans.PortedCore?.buildGeminiInteractionRequest || String(config.provider || "") !== "gemini") {
        return {
          protocol: String(config.protocol || "chat_completions"),
          messageCount: messages.length,
          imageCount: messages.reduce((count, message) => count + (
            Array.isArray(message.content)
              ? message.content.filter(part => part?.type === "image_url").length
              : 0
          ), 0)
        };
      }
      const payload = LitMTrans.PortedCore.buildGeminiInteractionRequest(config, messages, { stream: false });
      const content = (Array.isArray(payload.input) ? payload.input : [])
        .flatMap(step => Array.isArray(step?.content) ? step.content : [step]);
      const images = content.filter(part => part?.type === "image");
      return {
        protocol: "gemini-interactions",
        model: String(payload.model || ""),
        inputStepCount: Array.isArray(payload.input) ? payload.input.length : 0,
        imageCount: images.length,
        imageParts: images.map(part => ({
          type: String(part.type || ""),
          mimeType: String(part.mime_type || ""),
          dataChars: String(part.data || "").length,
          hasURI: Boolean(part.uri)
        }))
      };
    }

    async runMultimodalProbe(command) {
      const paths = this.developerDiagnosticsPaths();
      const imageName = String(command.imageFileName || "multimodal-probe.png")
        .replace(/[^A-Za-z0-9._-]+/g, "");
      const imagePath = PathUtils.join(paths.directory, imageName);
      if (!await this.storage.exists(imagePath)) {
        throw new Error(`检查图片不存在：${imageName}`);
      }
      const bytes = await this.storage.readBytes(imagePath);
      if (!bytes?.length) throw new Error("测试图片为空");
      let binary = "";
      const chunkSize = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
      }
      const dataURL = `data:image/png;base64,${U.base64Encode(binary)}`;
      const expectedToken = String(command.expectedToken || "LitMTrans-7391").trim();
      const messages = [{
        role: "user",
        content: [
          {
            type: "text",
            text: (
              "This is an automated multimodal transport check. Read the attached image itself. " +
              `Return only the exact large verification code visible in the image. The expected format begins with LitMTrans-.`
            )
          },
          { type: "image_url", image_url: { url: dataURL } }
        ]
      }];
      const config = await this.llm.ensureConfiguredModel(
        this.llm.resolveConfig({ purpose: "chat", engine: "api", aiMode: "api" })
      );
      if (!config.apiKey) throw new Error("隔离测试 profile 尚未配置聊天API密钥");
      const request = this.diagnosticPayloadSummary(config, messages);
      if (Number(request.imageCount || 0) !== 1) {
        throw new Error("图片请求内容不符合预期");
      }
      const startedAt = Date.now();
      const response = await this.llm.complete(messages, {
        purpose: "chat",
        engine: "api",
        aiMode: "api",
        stream: false,
        temperature: 0,
        timeout: 90000
      });
      const text = String(response?.text || "").trim();
      return {
        provider: String(config.provider || ""),
        model: String(config.model || ""),
        baseURL: String(config.baseURL || ""),
        apiKeyPresent: true,
        image: {
          fileName: imageName,
          mimeType: "image/png",
          byteLength: bytes.length,
          fingerprint: U.hashString(dataURL)
        },
        request,
        response: {
          text,
          model: String(response?.model || ""),
          elapsedMs: Date.now() - startedAt
        },
        expectedToken,
        passed: text.toUpperCase().includes(expectedToken.toUpperCase())
      };
    }

    async runDocumentMultimodalProbe(command) {
      const requestedDocumentID = String(command.documentID || "");
      const documentDirectories = await this.storage.list(this.storage.documentsRoot);
      const firstDocumentDirectory = documentDirectories[0] || "";
      const documentID = requestedDocumentID || (
        firstDocumentDirectory ? PathUtils.filename(firstDocumentDirectory) : ""
      );
      if (!documentID) throw new Error("隔离测试库没有可供检查的文献数据");
      const question = (
        "Automated document-image transport check. Inspect the first real image embedded in the supplied paper, not its Markdown placeholder or caption. " +
        "Return only a comma-separated subset of these exact English labels that are visibly present in that first image: " +
        "MOON, LIGHTNING, RETINA, X-RAY, RECLINING PERSON."
      );
      const content = await this.chat.currentDocumentMessageParts(documentID, question, null, {});
      const imageCount = (Array.isArray(content) ? content : [])
        .filter(part => part?.type === "image_url" && String(part?.image_url?.url || "").startsWith("data:image/"))
        .length;
      const transportText = (Array.isArray(content) ? content : [])
        .filter(part => part?.type === "text")
        .map(part => String(part.text || ""))
        .join("");
      const readFailures = (transportText.match(/\[提示：读取图片失败/g) || []).length;
      if (!imageCount || readFailures) {
        throw new Error(`文献图片传输构建失败：imageCount=${imageCount}, readFailures=${readFailures}`);
      }
      const messages = [{ role: "user", content }];
      const config = await this.llm.ensureConfiguredModel(
        this.llm.resolveConfig({ purpose: "chat", engine: "api", aiMode: "api" })
      );
      if (!config.apiKey) throw new Error("隔离测试 profile 尚未配置聊天API密钥");
      const request = this.diagnosticPayloadSummary(config, messages);
      const startedAt = Date.now();
      const stream = command.stream === true;
      let streamedText = "";
      let streamedReasoning = "";
      let textDeltaCount = 0;
      let reasoningDeltaCount = 0;
      const response = await this.llm.complete(messages, {
        purpose: "chat",
        engine: "api",
        aiMode: "api",
        stream,
        temperature: 0,
        timeout: 120000,
        onText: delta => {
          streamedText += String(delta || "");
          textDeltaCount += 1;
        },
        onReasoning: delta => {
          streamedReasoning += String(delta || "");
          reasoningDeltaCount += 1;
        }
      });
      const text = String(response?.text || "").trim();
      const normalized = text.toUpperCase();
      const expectedLabels = ["MOON", "LIGHTNING", "RETINA", "X-RAY", "RECLINING PERSON"];
      const matchedLabels = expectedLabels.filter(label => normalized.includes(label));
      return {
        documentID,
        provider: String(config.provider || ""),
        model: String(config.model || ""),
        imageCount,
        readFailures,
        stream,
        request,
        response: {
          text,
          streamedText: streamedText.trim(),
          streamedReasoning: streamedReasoning.trim(),
          textDeltaCount,
          reasoningDeltaCount,
          model: String(response?.model || ""),
          elapsedMs: Date.now() - startedAt
        },
        matchedLabels,
        passed: Number(request.imageCount || 0) === imageCount && matchedLabels.length >= 3
      };
    }

    async runChatRoundtripProbe(command) {
      const requestedDocumentID = String(command.documentID || "");
      const documentDirectories = await this.storage.list(this.storage.documentsRoot);
      const firstDocumentDirectory = documentDirectories[0] || "";
      const documentID = requestedDocumentID || (
        firstDocumentDirectory ? PathUtils.filename(firstDocumentDirectory) : ""
      );
      if (!documentID) throw new Error("隔离测试库没有可供检查的文献数据");
      const sessionID = this.chat.documentSessionID();
      const sessionPath = this.chat.sessionPath(documentID, sessionID);
      const hadSession = await this.storage.exists(sessionPath);
      const originalSession = hadSession ? await this.storage.readText(sessionPath, "") : "";
      const events = [];
      const startedAt = Date.now();
      try {
        const result = await this.chat.send(
          documentID,
          sessionID,
          "请只回复“PDF引用链路正常”。",
          {
            contextMode: "source",
            responseLanguage: "简体中文",
            referenceQuotes: [{
              type: "text",
              text: "This is an automated native Zotero PDF selection transport check.",
              title: "Zotero PDF选文",
              origin: "zotero-reader",
              readerMode: "zotero-reader",
              pane: "source",
              page: 1,
              nativePageIndex: 0
            }],
            images: [],
            documents: [],
            documentOptions: {
              imageMode: "full_with_images",
              compressImages: true,
              sequentialImages: true
            }
          },
          event => {
            events.push({
              type: String(event?.type || ""),
              deltaChars: String(event?.delta || "").length,
              message: String(event?.message || "").slice(0, 240)
            });
          },
          null
        );
        const text = String(result?.message?.content || "").trim();
        return {
          documentID,
          elapsedMs: Date.now() - startedAt,
          responseText: text,
          eventCount: events.length,
          eventTypes: events.map(event => event.type),
          events,
          passed: text.includes("PDF引用链路正常")
        };
      }
      finally {
        if (hadSession) await this.storage.writeText(sessionPath, originalSession);
        else await this.storage.remove(sessionPath, false);
      }
    }

    diagnosticUsage(usage) {
      const source = usage && typeof usage === "object" ? usage : {};
      const prompt = source.prompt_tokens_details && typeof source.prompt_tokens_details === "object"
        ? source.prompt_tokens_details : {};
      const completion = source.completion_tokens_details && typeof source.completion_tokens_details === "object"
        ? source.completion_tokens_details : {};
      const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
      return {
        promptTokens: number(source.prompt_tokens),
        completionTokens: number(source.completion_tokens),
        totalTokens: number(source.total_tokens),
        reasoningTokens: number(completion.reasoning_tokens),
        cachedTokens: number(prompt.cached_tokens ?? source.cached_input_tokens ?? source.prompt_cache_hit_tokens),
        cacheWriteTokens: number(prompt.cache_write_tokens ?? source.cache_write_tokens),
        promptCacheHitTokens: number(source.prompt_cache_hit_tokens),
        promptCacheMissTokens: number(source.prompt_cache_miss_tokens),
        cacheDiscount: number(source.cache_discount)
      };
    }

    diagnosticError(error) {
      const normalized = U.normalizeError(error);
      return {
        name: String(normalized?.name || "Error"),
        message: String(normalized?.message || "请求失败")
          .replace(/(?:api[_ -]?key|authorization|bearer)\s*[:=]\s*[^\s,;]+/ig, "$1=[已隐藏]")
          .replace(/[A-Za-z]:\\[^\r\n]+/g, "[本地路径已隐藏]")
          .slice(0, 500)
      };
    }

    async runProviderCacheProbe(command) {
      const requestedDocumentID = String(command.documentID || "1-5YJXBVAU");
      if (!await this.storage.exists(this.storage.path(requestedDocumentID, "full.cleaned.md"))) {
        throw new Error(`找不到用于缓存检查的论文正文：${requestedDocumentID}`);
      }
      const chatSettings = this.llm.getStoredSettings("chat");
      const translationSettings = this.llm.getStoredSettings("translation");
      const profiles = new Map();
      const requestedProviders = new Set((Array.isArray(command.providers) ? command.providers : [])
        .map(value => U.providerSpec(String(value || "")).id).filter(Boolean));
      for (const settings of [chatSettings, translationSettings]) {
        for (const [providerKey, profile] of Object.entries(settings.providerProfiles || {})) {
          const provider = U.providerSpec(providerKey).id;
          const model = String(profile?.model || "").trim();
          if (!provider || !model || profiles.has(provider)) continue;
          profiles.set(provider, { provider, model, baseURL: String(profile?.baseURL || "").trim() });
        }
        if (settings.provider && settings.model && !profiles.has(settings.provider)) {
          profiles.set(settings.provider, {
            provider: settings.provider,
            model: String(settings.model),
            baseURL: String(settings.baseURL || "")
          });
        }
      }
      const system = (
        "You are the document assistant embedded in Zotero. Answer only from the supplied paper. " +
        "Be concise, preserve scientific terminology and units, and answer in Simplified Chinese."
      );
      const paperParts = await this.chat.currentDocumentMessageParts(
        requestedDocumentID,
        "",
        null,
        { imageMode: "full_no_images", compressImages: true, sequentialImages: true }
      );
      if (!Array.isArray(paperParts) || !paperParts.length) throw new Error("论文正文未准备好");
      // This text-model probe follows ChatService's non-multimodal fallback:
      // preserve the exact document text and cache order, omit image payloads.
      const paperTextParts = paperParts.filter(part => part?.type === "text");
      const questions = ["请提炼本文要点。", "测试api连通性", "缓存命中测试"];
      const results = [];
      for (const profile of profiles.values()) {
        if (requestedProviders.size && !requestedProviders.has(profile.provider)) continue;
        const base = {
          purpose: "chat",
          engine: "api",
          aiMode: "api",
          provider: profile.provider,
          baseURL: profile.baseURL,
          model: profile.model,
          temperature: 0,
          stream: true,
          maxTokens: Math.max(16, Math.min(1024, Number(command.maxTokens) || 64)),
          timeout: 120000,
          // A fresh key makes turn 1 a genuine cold start; turns 2 and 3
          // remain sticky within this one probe run.
          promptCacheKey: `ltm-${U.hashString([
            String(command.id || U.randomID("run")), requestedDocumentID, profile.provider, profile.model
          ].join("|"))}`
        };
        const item = {
          provider: profile.provider,
          model: profile.model,
          baseURL: profile.baseURL.replace(/^https?:\/\/([^/]+).*$/i, "$1"),
          apiKeyPresent: this.secrets.has(this.secrets.llmKeyName(profile.provider)),
          smallRequest: null,
          paperRequests: []
        };
        if (!item.apiKeyPresent) {
          item.skipped = "未保存该服务商的API密钥";
          results.push(item);
          continue;
        }
        try {
          const small = await this.llm.complete([
            { role: "system", content: "Reply with exactly OK." },
            { role: "user", content: "ping" }
          ], base);
          item.smallRequest = {
            ok: true,
            model: String(small?.model || profile.model),
            usage: this.diagnosticUsage(small?.usage),
            responseChars: String(small?.text || "").trim().length
          };
        }
        catch (error) {
          item.smallRequest = { ok: false, error: this.diagnosticError(error) };
          results.push(item);
          continue;
        }
        const messages = [{ role: "system", content: system }, {
          role: "user",
          content: [...paperTextParts, { type: "text", text: `\n\n===== 用户问题 =====\n${questions[0]}` }]
        }];
        for (let index = 0; index < questions.length; index++) {
          if (index > 0) messages.push({ role: "user", content: questions[index] });
          const startedAt = Date.now();
          try {
            const response = await this.llm.complete(messages, base);
            const answer = String(response?.text || "").trim();
            item.paperRequests.push({
              turn: index + 1,
              request: questions[index],
              ok: true,
              model: String(response?.model || profile.model),
              elapsedMs: Date.now() - startedAt,
              responseChars: answer.length,
              usage: this.diagnosticUsage(response?.usage)
            });
            messages.push({ role: "assistant", content: answer || "[模型未返回正文]" });
          }
          catch (error) {
            item.paperRequests.push({
              turn: index + 1,
              request: questions[index],
              ok: false,
              elapsedMs: Date.now() - startedAt,
              error: this.diagnosticError(error)
            });
            break;
          }
        }
        results.push(item);
      }
      return {
        documentID: requestedDocumentID,
        paperTitle: "Spontaneous Raman Scattering from Shocked Water",
        requestMode: "真实论文AI上下文；全文无图；同一服务商/模型连续对话；固定会话缓存键",
        results
      };
    }

    addToAllWindows() {
      const enumerator = Services.wm.getEnumerator("navigator:browser");
      while (enumerator.hasMoreElements()) this.addToWindow(enumerator.getNext());
    }

    detachWindowItemBindings(win, state) {
      if (!state) return;
      try { state.observer?.disconnect?.(); } catch (_) {}
      state.observer = null;
      try {
        if (state.itemMenu && state.itemMenuRefresh) {
          state.itemMenu.removeEventListener("popupshowing", state.itemMenuRefresh);
        }
      }
      catch (_) {}
      try { state.menuItem?.remove?.(); } catch (_) {}
      try {
        if (state.itemsTree && state.onDblClick) {
          state.itemsTree.removeEventListener("dblclick", state.onDblClick, true);
        }
      }
      catch (_) {}
      state.itemMenu = null;
      state.itemMenuRefresh = null;
      state.menuItem = null;
      state.itemsTree = null;
      state.onDblClick = null;
      state.ensureScheduled = false;
      if (this.windowBindings.get(win) === state) this.windowBindings.delete(win);
    }

    bindWindowItemInteractions(win) {
      if (!win?.document) return;
      let state = this.windowBindings.get(win);
      if (state) {
        state.ensure?.();
        return;
      }
      state = { itemMenu: null, itemMenuRefresh: null, menuItem: null, itemsTree: null, onDblClick: null, observer: null, ensureScheduled: false, ensure: null };
      this.windowBindings.set(win, state);

      const schedule = () => {
        if (state.ensureScheduled || this.windowBindings.get(win) !== state || !this.windows.has(win)) return;
        state.ensureScheduled = true;
        const timer = win.setTimeout || global.setTimeout;
        timer(() => {
          state.ensureScheduled = false;
          if (this.windowBindings.get(win) === state && this.windows.has(win)) state.ensure?.();
        }, 0);
      };

      const ensure = () => {
        if (this.windowBindings.get(win) !== state || !this.windows.has(win)) return;
        const doc = win.document;
        const itemMenu = doc.getElementById("zotero-itemmenu");
        if (state.itemMenu !== itemMenu) {
          if (state.itemMenu && state.itemMenuRefresh) {
            try { state.itemMenu.removeEventListener("popupshowing", state.itemMenuRefresh); } catch (_) {}
          }
          try { state.menuItem?.remove?.(); } catch (_) {}
          state.itemMenu = itemMenu || null;
          state.itemMenuRefresh = null;
          state.menuItem = null;
        }

        // 兼容旧版本已注入的 CAJ 菜单项，确保更新后不再残留。
        try { itemMenu?.querySelector('[id="litmtrans-convert-caj-menuitem"]')?.remove?.(); } catch (_) {}

        const menuBindingsStale = itemMenu && state.itemMenu === itemMenu
          && (!state.menuItem || state.menuItem.parentNode !== itemMenu);
        if (menuBindingsStale) {
          try {
            if (state.itemMenuRefresh) itemMenu.removeEventListener("popupshowing", state.itemMenuRefresh);
          }
          catch (_) {}
          try { state.menuItem?.remove?.(); } catch (_) {}
          state.itemMenuRefresh = null;
          state.menuItem = null;
        }

        if (itemMenu && !state.menuItem) {
          const menuItem = itemMenu.querySelector('[id="litmtrans-item-menuitem"]') || doc.createXULElement("menuitem");
          menuItem.id = "litmtrans-item-menuitem";
          menuItem.setAttribute("label", localize("用LitMtrans打开", "Open with LitMtrans"));
          menuItem.setAttribute("class", "menuitem-iconic");
          menuItem.setAttribute("image", this.rootURI + "assets/icon.ico");
          if (!menuItem._litmtransCommandAttached) {
            menuItem.addEventListener("command", () => this.openFromCurrentSelection(win));
            menuItem._litmtransCommandAttached = true;
          }
          if (!menuItem.parentNode) itemMenu.appendChild(menuItem);

          const refresh = () => {
            try {
              const selected = win.ZoteroPane?.getSelectedItems?.() || [];
              menuItem.hidden = !selected.some(item => this.itemCouldHaveAttachment(item));
            }
            catch (error) {
              // 菜单刷新失败不能中断 Zotero 原生菜单。
              menuItem.hidden = true;
              this.log(`Item menu refresh error: ${error}`);
            }
          };
          state.menuItem = menuItem;
          state.itemMenuRefresh = refresh;
          itemMenu.addEventListener("popupshowing", refresh);
        }

        const itemsTree = doc.getElementById("zotero-items-tree");
        if (state.itemsTree !== itemsTree) {
          if (state.itemsTree && state.onDblClick) {
            try { state.itemsTree.removeEventListener("dblclick", state.onDblClick, true); } catch (_) {}
          }
          state.itemsTree = itemsTree || null;
          state.onDblClick = null;
        }
        if (itemsTree && !state.onDblClick) {
          const onDblClick = async (event) => {
            try {
              // 未配置时每次询问；已有用户选择仍由首选项中的值决定。
              const action = U.getPref("cajDoubleClickAction", "ask");
              if (action === "default" || action === "external") return;
              const selected = win.ZoteroPane?.getSelectedItems?.() || [];
              if (selected.length !== 1 || event.button !== 0) return;
              const cajAttachment = this.getCAJAttachment(selected[0]);
              if (!cajAttachment) return;

              if (action === "litmtrans") {
                event.preventDefault();
                event.stopPropagation();
                await this.openFromCurrentSelection(win);
                return;
              }

              if (action === "ask") {
                const prompts = Services.prompt;
                const checkState = { value: false };
                const flags = (prompts.BUTTON_POS_0 * prompts.BUTTON_TITLE_IS_STRING) +
                              (prompts.BUTTON_POS_1 * prompts.BUTTON_TITLE_IS_STRING);
                const button0Title = localize("使用 LitMTrans 打开", "Open in LitMTrans");
                const button1Title = localize("默认 / 外部或其他插件处理", "Default / Other Plugins");
                const checkMsg = localize("记住我的选择，不再提示", "Remember my choice and do not ask again");
                const dialogTitle = localize("打开 CAJ 文献", "Open CAJ Document");
                const dialogText = localize("检测到此文献为 CAJ 格式。您希望如何打开？", "This item is a CAJ document. How would you like to open it?");
                const buttonPressed = prompts.confirmEx(win, dialogTitle, dialogText, flags, button0Title, button1Title, null, checkMsg, checkState);
                if (checkState.value) U.setPref("cajDoubleClickAction", buttonPressed === 0 ? "litmtrans" : "default");
                if (buttonPressed !== 1) {
                  event.preventDefault();
                  event.stopPropagation();
                }
                if (buttonPressed === 0) {
                  event.stopPropagation();
                  await this.openFromCurrentSelection(win);
                }
              }
            }
            catch (error) { this.log(`Double click handler error: ${error}`); }
          };
          state.onDblClick = onDblClick;
          itemsTree.addEventListener("dblclick", onDblClick, true);
        }
      };
      state.ensure = ensure;

      try {
        const Observer = win.MutationObserver || global.MutationObserver;
        if (Observer && win.document.documentElement) {
          state.observer = new Observer(schedule);
          state.observer.observe(win.document.documentElement, { childList: true, subtree: true });
        }
      }
      catch (error) { this.log(`Unable to observe Zotero item pane: ${error}`); }
      ensure();
    }

    ensureWindowLocalization(win) {
      try {
        win?.MozXULElement?.insertFTLIfNeeded?.("litmtrans.ftl");
      }
      catch (error) {
        this.log(`Unable to register Fluent resource: ${error}`);
      }
    }

    addToWindow(win) {
      if (!win) return;
      // Preference panes execute in a separate window/sandbox. Expose the
      // controller explicitly on every main Zotero window so they can use the
      // same authoritative settings service rather than an empty local copy.
      try { win.LitMTransController = this; }
      catch (_) {}
      if (this.windows.has(win)) return;
      this.ensureWindowLocalization(win);
      this.windows.add(win);
      const doc = win.document;
      try {
        const toolsPopup = doc.getElementById("menu_ToolsPopup") || doc.getElementById("menu_toolsPopup");
        if (toolsPopup && !doc.getElementById("litmtrans-tools-menuitem")) {
          const item = doc.createXULElement("menuitem");
          item.id = "litmtrans-tools-menuitem";
          item.setAttribute("label", localize("打开LitMTrans", "Open LitMTrans"));
          item.setAttribute("class", "menuitem-iconic");
          item.setAttribute("image", this.rootURI + "assets/icon.ico");
          item.addEventListener("command", () => this.openFromCurrentSelection(win));
          toolsPopup.appendChild(item);
        }
      }
      catch (error) { Zotero.logError(error); }

      this.bindWindowItemInteractions(win);
    }

    removeFromWindow(win) {
      if (!win) return;
      try { if (win.LitMTransController === this) delete win.LitMTransController; }
      catch (_) {}
      this.windows.delete(win);
      const doc = win.document;
      try { doc.getElementById("litmtrans-tools-menuitem")?.remove(); } catch (_) {}
      try { doc.querySelector('link[href="litmtrans.ftl"]')?.remove(); } catch (_) {}
      try {
        const state = this.windowBindings.get(win);
        this.detachWindowItemBindings(win, state);
      }
      catch (_) {}
      try {
        const item = doc.getElementById("litmtrans-item-menuitem");
        if (item?._litmtransRefresh) doc.getElementById("zotero-itemmenu")?.removeEventListener("popupshowing", item._litmtransRefresh);
        item?.remove();
      }
      catch (_) {}
      try {
        const convertItem = doc.getElementById("litmtrans-convert-caj-menuitem");
        convertItem?.remove();
      }
      catch (_) {}
      try {
        const itemsTree = doc.getElementById("zotero-items-tree");
        if (itemsTree?._litmtransDblClickHandler) {
          itemsTree.removeEventListener("dblclick", itemsTree._litmtransDblClickHandler, true);
          delete itemsTree._litmtransDblClickHandler;
          delete itemsTree._litmtransDblClickAttached;
        }
      }
      catch (_) {}
      for (const [tabID, runtime] of [...this.tabs]) {
        if (runtime.window === win) this.cleanupTab(tabID);
      }
    }

    hasCAJAttachment(item) {
      if (!item) return false;
      try {
        if (item.isAttachment?.()) {
          const fn = item.attachmentFilename || item.getFilePath?.() || "";
          return LitMTrans.CAJConverter?.isCAJExtension(fn);
        }
        const ids = item.getAttachments?.() || [];
        for (const id of ids) {
          const att = Zotero.Items.get(id);
          if (att) {
            const fn = att.attachmentFilename || att.getFilePath?.() || "";
            if (LitMTrans.CAJConverter?.isCAJExtension(fn)) return true;
          }
        }
        return false;
      }
      catch (_) { return false; }
    }

    getCAJAttachment(item) {
      if (!item) return null;
      try {
        if (item.isAttachment?.()) {
          const fn = item.attachmentFilename || item.getFilePath?.() || "";
          if (LitMTrans.CAJConverter?.isCAJExtension(fn)) return item;
          const title = String(item.getField?.("title") || "");
          if (!title.includes("（LitMTrans）")) return null;
          item = item.parentID ? Zotero.Items.get(item.parentID) : null;
          if (!item) return null;
        }
        const ids = item.getAttachments?.() || [];
        for (const id of ids) {
          const att = Zotero.Items.get(id);
          if (att) {
            const fn = att.attachmentFilename || att.getFilePath?.() || "";
            if (LitMTrans.CAJConverter?.isCAJExtension(fn)) return att;
          }
        }
        return null;
      }
      catch (_) { return null; }
    }

    async findCAJSourceAttachmentForGeneratedPDF(item) {
      if (!item?.isAttachment?.()
        || String(item.attachmentContentType || "").toLowerCase() !== "application/pdf") return null;
      const attachmentID = Number(item.id || 0);
      if (!attachmentID) return null;
      try {
        const parent = item.parentID ? Zotero.Items.get(item.parentID) : null;
        if (parent && !this.getCAJAttachment(parent)) return null;
        for (const directory of await this.storage.list(this.storage.documentsRoot)) {
          const sourceMeta = await this.storage.readJSON(
            PathUtils.join(directory, "caj-source", "source.meta.json"),
            null
          );
          if (Number(sourceMeta?.generatedAttachmentID || 0) !== attachmentID
            && Number(sourceMeta?.exportAttachmentID || 0) !== attachmentID) continue;
          const documentID = PathUtils.filename(directory);
          const source = this.storage.resolveDocumentItem(
            documentID,
            await this.storage.getDocumentMeta(documentID)
          );
          if (source && this.hasCAJAttachment(source)) return source;
        }
      }
      catch (_) {}
      return null;
    }

    async createCAJPreview(context, frame) {
      // Reader 的正常数据通道使用 zotero://attachment/... URL。把百 MB 级
      // Uint8Array 跨进程 clone 给 reader.html 会同时占用多份内存，HN 文献
      // 因此很容易在 PDF.js 尚未启动前就空白。将缓存文件注册为链接附件，
      // 让 Zotero 10 自己按文件路径加载，工作台仍然保留原 CAJ 的文档 ID。
      const readerAttachment = await this.ensureCAJReaderAttachment(context.attachment, context.filePath);
      return Zotero.Reader.openPreview(readerAttachment.id, frame);
    }

    normalizeCAJBytes(value) {
      // IOUtils may return a typed array from a privileged compartment;
      // pdf-lib validates the typed-array constructor from its own realm.
      return value instanceof global.Uint8Array
        ? value
        : global.Uint8Array.from(value || []);
    }

    async validateCachedCAJPDF(pdfPath) {
      const stat = await this.storage.stat(pdfPath);
      if (!stat || Number(stat.size || 0) < 32) throw new Error("缓存 PDF 文件不完整");
      const bytes = this.normalizeCAJBytes(await this.storage.readBytes(pdfPath));
      if (bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46) {
        throw new Error("缓存文件不是有效 PDF");
      }
      const parsed = await PDFLib.PDFDocument.load(bytes, {
        throwOnInvalidObject: true,
        updateMetadata: false
      });
      const pageCount = parsed.getPageCount();
      if (!pageCount) throw new Error("缓存 PDF 没有可用页面");
      return { pageCount, size: Number(stat.size || bytes.length) };
    }

    normalizeCAJPath(value) {
      const path = String(value || "").replace(/[\\/]+/g, "/").replace(/\/+$/, "");
      return Zotero.isWin ? path.toLowerCase() : path;
    }

    async findCAJReaderAttachment(attachment, pdfPath, meta = {}) {
      const candidateIDs = [];
      const rememberedID = Number(meta?.generatedAttachmentID || 0);
      if (rememberedID > 0) candidateIDs.push(rememberedID);
      const parent = attachment.parentID ? Zotero.Items.get(attachment.parentID) : null;
      for (const id of parent?.getAttachments?.() || []) candidateIDs.push(id);
      const targetPath = this.normalizeCAJPath(pdfPath);
      const seen = new Set();
      for (const id of candidateIDs) {
        const candidateID = Number(id);
        if (!candidateID || seen.has(candidateID) || candidateID === Number(attachment.id)) continue;
        seen.add(candidateID);
        const candidate = Zotero.Items.get(candidateID);
        if (!candidate || candidate.deleted) continue;
        if (candidate.libraryID !== attachment.libraryID) continue;
        if (String(candidate.attachmentContentType || "").toLowerCase() !== "application/pdf") continue;
        try {
          const candidatePath = await candidate.getFilePathAsync?.() || candidate.getFilePath?.();
          const importedCache = candidateID === rememberedID
            && candidate.key === meta.generatedAttachmentKey
            && meta.readerAttachmentMode === "imported-cache"
            && meta.readerIdentity === meta.identity
            && meta.readerVersion === meta.version;
          if (!importedCache && this.normalizeCAJPath(candidatePath) !== targetPath) continue;
          if (!(await this.storage.exists(candidatePath))) continue;
          return candidate;
        }
        catch (_) {}
      }
      return null;
    }

    async removeCAJReaderAttachment(documentID, options = {}) {
      const metaPath = this.storage.path(documentID, "caj-source", "source.meta.json");
      const meta = await this.storage.readJSON(metaPath, null);
      const generatedID = Number(meta?.generatedAttachmentID || 0);
      if (!generatedID) return { removed: false, stale: false };

      let attachment = null;
      try { attachment = await Zotero.Items.getAsync?.(generatedID); }
      catch (_) {}
      if (!attachment) {
        try { attachment = Zotero.Items.get(generatedID); }
        catch (_) {}
      }
      if (!attachment || attachment.deleted) return { removed: false, stale: true };

      const mode = String(meta?.readerAttachmentMode || "");
      const title = String(attachment.getField?.("title") || "");
      const source = this.storage.parseDocumentID(documentID);
      const isGenerated = (['linked-cache', 'imported-cache'].includes(mode) || title.includes("（LitMTrans）"))
        && String(attachment.attachmentContentType || "").toLowerCase() === "application/pdf"
        && (!source || attachment.libraryID === source.libraryID)
        && (!meta.generatedAttachmentKey || attachment.key === meta.generatedAttachmentKey)
        && Number(attachment.id) === generatedID;
      if (!isGenerated) {
        if (options.required) throw new Error("CAJ 阅读附件关联信息异常，已停止清理以避免误删 Zotero 附件");
        return { removed: false, stale: false };
      }
      if (typeof Zotero.Items.trashTx !== "function") {
        if (options.required) throw new Error("当前 Zotero 无法安全移除 CAJ 自动阅读附件，已保留缓存");
        return { removed: false, stale: false };
      }
      await Zotero.Items.trashTx(generatedID);
      return { removed: true, attachmentID: generatedID, mode };
    }

    async ensureCAJReaderAttachment(attachment, pdfPath = null) {
      this._cajReaderAttachments ||= new Map();
      const key = this.storage.documentID(attachment);
      if (this._cajReaderAttachments.has(key)) return this._cajReaderAttachments.get(key);
      const task = (async () => {
        const path = pdfPath || await this.cachedPDFForCAJ(attachment);
        const metaPath = this.storage.path(attachment, "caj-source", "source.meta.json");
        const meta = await this.storage.readJSON(metaPath) || {};
        const existing = await this.findCAJReaderAttachment(attachment, path, meta);
        if (existing) {
          const linkedMode = existing.attachmentLinkMode === Zotero.Attachments?.LINK_MODE_LINKED_FILE
            ? "linked-cache"
            : "imported-cache";
          const sourceFileName = String(meta.sourceFileName || attachment.attachmentFilename || "document.caj");
          if (Number(meta.generatedAttachmentID) !== Number(existing.id)
            || meta.readerAttachmentMode !== linkedMode
            || meta.sourceFileName !== sourceFileName) {
            await this.storage.writeJSON(metaPath, {
              ...meta,
              generatedAttachmentID: existing.id,
              generatedAttachmentKey: existing.key,
              readerAttachmentMode: linkedMode,
              sourceFileName
            });
          }
          return existing;
        }

        if (meta.readerAttachmentMode === "imported-cache" && meta.generatedAttachmentID) {
          await this.removeCAJReaderAttachment(key, { required: true });
        }

        const filename = String(attachment.attachmentFilename || "document.caj");
        const stem = U.safeStem(filename.replace(/\.caj$/i, "") || "document", 90);
        const title = `${stem}.pdf（LitMTrans）`;
        const options = {
          file: U.createLocalFile(path),
          title,
          contentType: "application/pdf",
          libraryID: attachment.libraryID
        };
        if (attachment.parentID) options.parentItemID = attachment.parentID;
        else options.collections = attachment.getCollections?.() || [];

        // 链接到稳定的插件缓存，避免再次复制大型 HN PDF；Zotero 10 的
        // Reader 对链接附件和导入附件使用同一 zotero://attachment 通道。
        const createLinked = Zotero.Attachments?.linkFromFile;
        let readerAttachment;
        let readerAttachmentMode = "imported-cache";
        if (typeof createLinked === "function") {
          try {
            readerAttachment = await createLinked.call(Zotero.Attachments, options);
            readerAttachmentMode = "linked-cache";
          }
          catch (error) {
            // 群组库不允许链接附件；此时只把缓存复制到 Zotero 存储，
            // 保证阅读功能仍可用，并把原因留在日志而不打断用户。
            Zotero.logError?.(error);
          }
        }
        if (!readerAttachment) readerAttachment = await Zotero.Attachments.importFromFile(options);
        readerAttachment.setField("title", title);
        await readerAttachment.saveTx();
        await this.storage.writeJSON(metaPath, {
          ...meta,
          generatedAttachmentID: readerAttachment.id,
          generatedAttachmentKey: readerAttachment.key,
          readerAttachmentMode,
          readerIdentity: meta.identity,
          readerVersion: meta.version,
          sourceFileName: String(meta.sourceFileName || attachment.attachmentFilename || "document.caj")
        });
        return readerAttachment;
      })();
      this._cajReaderAttachments.set(key, task);
      try { return await task; }
      finally { this._cajReaderAttachments.delete(key); }
    }

    async persistCAJDocumentMeta(attachment, sourceFileName, patch = {}) {
      await this.storage.setDocumentMeta(attachment, {
        documentID: this.storage.documentID(attachment),
        itemID: attachment.id,
        libraryID: attachment.libraryID,
        itemKey: attachment.key,
        parentItemID: attachment.parentID || null,
        parentItemKey: attachment.parentKey || "",
        sourceFileName,
        isCAJ: true,
        ...patch
      });
    }

    async cachedPDFForCAJ(attachment) {
      const sourcePath = await this.attachmentPath(attachment);
      const sourceFileName = String(attachment.attachmentFilename || PathUtils.filename(sourcePath) || "document.caj");
      const identity = await this.storage.sourceIdentity(attachment, sourcePath);
      const pdfPath = this.storage.path(attachment, "caj-source", "source.pdf");
      const metaPath = this.storage.path(attachment, "caj-source", "source.meta.json");
      const meta = await this.storage.readJSON(metaPath);
      const cachedStat = meta?.identity === identity && meta?.version === CAJ_CACHE_VERSION
        ? await this.storage.stat(pdfPath)
        : null;
      if (cachedStat && Number(cachedStat.size || 0) > 0) {
        if (meta.cacheValidated && Number(meta.pageCount) > 0
          && (!meta.outputBytes || Number(meta.outputBytes) === Number(cachedStat.size))) {
          if (meta.sourceFileName !== sourceFileName) {
            await this.storage.writeJSON(metaPath, { ...meta, sourceFileName });
          }
          await this.persistCAJDocumentMeta(attachment, sourceFileName, {
            sourceIdentity: identity,
            cajFormat: meta.format || "",
            cajPageCount: Number(meta.pageCount || 0),
            cajCacheValidated: true
          });
          return pdfPath;
        }
        try {
          const cached = await this.validateCachedCAJPDF(pdfPath);
          await this.storage.writeJSON(metaPath, {
            ...meta,
            cacheValidated: true,
            pageCount: cached.pageCount,
            outputBytes: cached.size,
            sourceFileName
          });
          await this.persistCAJDocumentMeta(attachment, sourceFileName, {
            sourceIdentity: identity,
            cajFormat: meta.format || "",
            cajPageCount: cached.pageCount,
            cajCacheValidated: true
          });
          return pdfPath;
        }
        catch (_) {
          // 旧版本可能在转换中断前写入了元数据；下面会原子地重建缓存。
        }
      }
      this._cajConversions ||= new Map();
      const key = this.storage.documentID(attachment);
      if (this._cajConversions.has(key)) return this._cajConversions.get(key);
      const task = (async () => {
        const progress = new Zotero.ProgressWindow({ closeOnClick: false });
        progress.changeHeadline("正在准备 CAJ");
        progress.show();
        const row = new progress.ItemProgress("attachment", sourceFileName);
        const stage = new progress.ItemProgress("", "正在读取文件");
        const started = Date.now();
        let message = "正在读取文件";
        const update = event => {
          message = event.message;
          stage.setText(`${message} · 已用 ${Math.floor((Date.now() - started) / 1000)} 秒`);
          if (event.total > 0) row.setProgress(Math.min(95, Math.round(event.completed / event.total * 90)));
        };
        const timer = setInterval(() => update({ message }), 1000);
        try {
          const result = await this.convertCAJInWorker(sourcePath, update);
          const normalizedPDF = result.pdf;
          const { pageCount, format } = result;
          update({ message: "正在保存 PDF" });
          await this.storage.ensureDir(PathUtils.parent(pdfPath));
          await IOUtils.write(pdfPath, normalizedPDF, { tmpPath: pdfPath + ".tmp" });
          await this.storage.writeJSON(metaPath, {
            ...(meta && typeof meta === "object" ? meta : {}),
            identity,
            version: CAJ_CACHE_VERSION,
            format,
            pageCount,
            outputBytes: normalizedPDF.byteLength || normalizedPDF.length || 0,
            cacheValidated: true,
            sourceFileName
          });
          await this.persistCAJDocumentMeta(attachment, sourceFileName, {
            sourceIdentity: identity,
            cajFormat: format,
            cajPageCount: pageCount,
            cajCacheValidated: true
          });
          row.setProgress(100);
          stage.setText(`已准备 ${pageCount} 页`);
          progress.startCloseTimer(1800);
          return pdfPath;
        }
        catch (error) {
          row.setError();
          stage.setText(`准备失败：${error?.message || error}`);
          progress.startCloseTimer(8000);
          throw error;
        }
        finally { clearInterval(timer); }
      })();
      this._cajConversions.set(key, task);
      try { return await task; }
      finally { this._cajConversions.delete(key); }
    }

    // HN/C8 格式交给随插件分发的 WebAssembly 转换模块（caj2pdf-core 编译产物，全平台可用）
    async convertWithNativeBackend(sourcePath, format) {
      return (await this.convertCAJInWorker(sourcePath)).pdf;
    }

    async convertCAJInWorker(sourcePath, onProgress = () => {}) {
      const previous = this._cajWorkerQueue || Promise.resolve();
      let release;
      this._cajWorkerQueue = new Promise(resolve => { release = resolve; });
      onProgress({ message: "等待转换" });
      try {
        await previous;
        if (this._cajShuttingDown) throw new Error("插件已停止");
        onProgress({ message: "正在读取文件" });
        const bytes = this.normalizeCAJBytes(await this.storage.readBytes(sourcePath));
        const format = LitMTrans.CAJConverter.detectFormat(bytes);
        const module = format === "HN" || format === "C8" ? await this.loadNativeCAJModule() : null;
        const font = format === "HN" || format === "C8" ? await this.loadNativeCAJFont() : null;
        if ((format === "HN" || format === "C8") && !module) {
          throw new Error(`CAJ 转换组件加载失败：${this._cajWasmError?.message || "请重启 Zotero 后重试"}`);
        }
        if ((format === "HN" || format === "C8") && !font?.bytes?.length) {
          throw new Error(`CAJ 文字渲染组件加载失败：${this._cajFontError?.message || "内置思源宋体读取失败，请重新安装插件"}`);
        }
        if (this._cajShuttingDown) throw new Error("插件已停止");
        const WorkerClass = global.ChromeWorker || Zotero.getMainWindow()?.ChromeWorker;
        if (!WorkerClass) throw new Error("当前 Zotero 无法启动 CAJ 后台转换线程");
        return await new Promise((resolve, reject) => {
          const worker = new WorkerClass("chrome://litmtrans/content/src/caj-worker.js");
          this._cajWorkerTasks ||= new Set();
          const finish = (error, result) => {
            worker.terminate();
            this._cajWorkerTasks.delete(cancel);
            if (error) reject(error);
            else resolve(result);
          };
          const cancel = () => finish(new Error("插件已停止"));
          this._cajWorkerTasks.add(cancel);
          worker.onmessage = ({ data }) => {
            if (data.type === "progress") onProgress(data);
            else if (data.type === "error") finish(new Error(data.message));
            else if (data.type === "result") finish(null, { ...data, pdf: new Uint8Array(data.pdf) });
          };
          worker.onerror = event => {
            event.preventDefault?.();
            finish(new Error(event.message || "CAJ 后台转换失败"));
          };
          try {
            // 每份文献使用独立线程，完成即释放 WASM 的高水位内存。
            const source = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
              ? bytes.buffer
              : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            worker.postMessage({ source, wasm: module?.bytes, font: font?.bytes }, [source]);
          }
          catch (error) { finish(error); }
        });
      }
      finally { release(); }
    }

    // 加载随插件分发的 WebAssembly 转换模块并缓存
    async loadNativeCAJModule() {
      if (this._cajWasmModule) return this._cajWasmModule;
      if (this._cajWasmLoading) return this._cajWasmLoading;
      this._cajWasmLoading = (async () => {
        try {
          const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
          const channel = NetUtil.newChannel({
            uri: this.rootURI + "native/caj2pdf/caj2pdf.wasm",
            loadUsingSystemPrincipal: true
          });
          const bytes = await new Promise((resolve, reject) => {
            NetUtil.asyncFetch(channel, (input, status) => {
              if (!Components.isSuccessCode(status)) {
                reject(new Error(`无法读取 CAJ 转换组件（${status}）`));
                return;
              }
              const stream = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
              try {
                stream.setInputStream(input);
                resolve(Uint8Array.from(stream.readByteArray(stream.available())));
              }
              catch (error) { reject(error); }
              finally { stream.close(); }
            });
          });
          this._cajWasmModule = { bytes };
        }
        catch (error) {
          this._cajWasmError = error;
          this._cajWasmModule = null;
          Zotero.logError?.(new Error(`LitMTrans CAJ wasm 加载失败：${error?.message || error}`));
        }
        return this._cajWasmModule;
      })();
      try { return await this._cajWasmLoading; }
      finally { this._cajWasmLoading = null; }
    }

    // 加载包内思源宋体并缓存，用于 HN/C8 转换时向 WASM 提供字体渲染数据
    async loadNativeCAJFont() {
      if (this._cajFontModule) return this._cajFontModule;
      if (this._cajFontLoading) return this._cajFontLoading;
      this._cajFontLoading = (async () => {
        try {
          const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
          const channel = NetUtil.newChannel({
            uri: this.rootURI + "assets/fonts/SourceHanSerifCN-Regular.ttf",
            loadUsingSystemPrincipal: true
          });
          const bytes = await new Promise((resolve, reject) => {
            NetUtil.asyncFetch(channel, (input, status) => {
              if (!Components.isSuccessCode(status)) {
                reject(new Error(`无法读取思源宋体字体文件（${status}）`));
                return;
              }
              const stream = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
              try {
                stream.setInputStream(input);
                resolve(Uint8Array.from(stream.readByteArray(stream.available())));
              }
              catch (error) { reject(error); }
              finally { stream.close(); }
            });
          });
          this._cajFontModule = { bytes };
        }
        catch (error) {
          this._cajFontError = error;
          this._cajFontModule = null;
          Zotero.logError?.(new Error(`LitMTrans CAJ 字体加载失败：${error?.message || error}`));
        }
        return this._cajFontModule;
      })();
      try { return await this._cajFontLoading; }
      finally { this._cajFontLoading = null; }
    }

    async convertSelectedCAJToPDF(win) {
      const items = win?.ZoteroPane?.getSelectedItems?.() || [];
      if (!items.length) {
        this.alert(localize("请先选择包含 CAJ 附件的文献条目", "Please select an item with a CAJ attachment first"), win);
        return;
      }
      let cajAttachment = null;
      for (const item of items) {
        cajAttachment = this.getCAJAttachment(item);
        if (cajAttachment) break;
      }
      if (!cajAttachment) {
        this.alert(localize("所选条目未找到 CAJ 格式附件", "No CAJ attachment found in the selected item"), win);
        return;
      }
      try {
        const baseCaj = U.safeStem(
          (cajAttachment.attachmentFilename || "document.caj").replace(/\.caj$/i, "") || "document",
          120
        );
        const pdfPath = await this.cachedPDFForCAJ(cajAttachment);
        const title = `${baseCaj}.pdf`;
        const sourcePath = await this.attachmentPath(cajAttachment);
        const sourceIdentity = await this.storage.sourceIdentity(cajAttachment, sourcePath);
        const metaPath = this.storage.path(cajAttachment, "caj-source", "source.meta.json");
        const meta = await this.storage.readJSON(metaPath) || {};
        let outputAttachment = null;
        let created = false;
        if (meta.exportIdentity === sourceIdentity && Number(meta.exportAttachmentID) > 0) {
          const remembered = Zotero.Items.get(Number(meta.exportAttachmentID));
          if (remembered && !remembered.deleted
            && String(remembered.getField?.("title") || "") === title
            && String(remembered.attachmentContentType || "").toLowerCase() === "application/pdf") {
            try {
              const rememberedPath = await remembered.getFilePathAsync?.() || remembered.getFilePath?.();
              if (rememberedPath && await this.storage.exists(rememberedPath)) outputAttachment = remembered;
            }
            catch (_) {}
          }
        }
        if (!outputAttachment) {
          const options = { file: U.createLocalFile(pdfPath), libraryID: cajAttachment.libraryID };
          if (cajAttachment.parentID) options.parentItemID = cajAttachment.parentID;
          else options.collections = cajAttachment.getCollections();
          outputAttachment = await Zotero.Attachments.importFromFile(options);
          outputAttachment.setField("title", title);
          await outputAttachment.saveTx();
          created = true;
          await this.storage.writeJSON(metaPath, {
            ...meta,
            exportAttachmentID: outputAttachment.id,
            exportAttachmentKey: outputAttachment.key,
            exportIdentity: sourceIdentity
          });
        }
        const message = created
          ? localize(`已将 CAJ 转换为 PDF 并添加至条目：\n${title}`, `Converted the CAJ file to PDF and added it to the item:\n${title}`)
          : localize(`该文献已经有对应的 PDF 附件：\n${title}\n未重复创建。`, `A matching PDF attachment already exists:\n${title}\nNo duplicate was created.`);
        this.alert(message, win);
      }
      catch (error) {
        this.alert(localize(`CAJ 转换失败：${error.message || error}`, `CAJ conversion failed: ${error.message || error}`), win);
      }
    }

    itemCouldHaveAttachment(item) {
      if (!item) return false;
      try {
        return Boolean(item.isAttachment?.() || item.isRegularItem?.() || item.isDocument?.());
      }
      catch (_) { return false; }
    }

    async resolveAttachment(itemOrID) {
      let item = typeof itemOrID === "number" || typeof itemOrID === "string" ? Zotero.Items.get(Number(itemOrID)) : itemOrID;
      if (!item) throw new Error(localize("未找到所选条目", "The selected item could not be found"));
      if (item.isAttachment?.()) return item;

      try {
        const best = await item.getBestAttachment?.();
        if (best) return typeof best === "number" ? Zotero.Items.get(best) : best;
      }
      catch (_) {}

      const ids = item.getAttachments?.() || [];
      const attachments = ids.map(id => Zotero.Items.get(id)).filter(Boolean);
      const preferred = attachments.find(att => String(att.attachmentContentType || "").toLowerCase() === "application/pdf")
        || attachments.find(att => LitMTrans.Constants.SUPPORTED_INPUT_EXTENSIONS.has(U.extension(att.attachmentFilename || "")))
        || attachments[0];
      if (!preferred) throw new Error(localize("这个条目没有可用于翻译的附件", "This item has no attachment available for translation"));
      return preferred;
    }

    async attachmentPath(attachment) {
      const path = await attachment.getFilePathAsync?.() || attachment.getFilePath?.();
      if (!path) throw new Error(localize("附件尚未下载，请先在Zotero中下载", "Download the attachment in Zotero first"));
      if (!(await this.storage.exists(path))) throw new Error(localize("附件文件不存在，请先在Zotero中重新下载", "The attachment file is missing. Download it again in Zotero."));
      return path;
    }

    async selectedAttachment(win) {
      const items = win?.ZoteroPane?.getSelectedItems?.() || [];
      if (!items.length) throw new Error(localize("请先选择一个带有附件的条目", "Select an item with an attachment first"));
      return this.getCAJAttachment(items[0]) || this.resolveAttachment(items[0]);
    }

    async selectReferenceFiles(win = null, currentPaths = []) {
      const target = win?.document ? win : Zotero.getMainWindow?.() || Services.wm.getMostRecentWindow("navigator:browser");
      let selected = [];
      if (typeof Zotero.FilePicker === "function") {
        const picker = new Zotero.FilePicker();
        picker.init(target, localize("选择翻译参考语料", "Select translation reference documents"), picker.modeOpenMultiple);
        picker.appendFilter(
          localize("支持的参考文件", "Supported reference files"),
          "*.pdf; *.doc; *.docx; *.ppt; *.pptx; *.xls; *.xlsx; *.html; *.htm; *.png; *.jpg; *.jpeg; *.webp; *.md; *.markdown; *.txt"
        );
        picker.appendFilters(picker.filterAll);
        const result = await picker.show();
        if (result === picker.returnOK) {
          selected = Array.isArray(picker.files) ? picker.files : [];
        }
      }
      else {
        const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
        picker.init(target.browsingContext || target, localize("选择翻译参考语料", "Select translation reference documents"), Ci.nsIFilePicker.modeOpenMultiple);
        picker.appendFilter(
          localize("支持的参考文件", "Supported reference files"),
          "*.pdf; *.doc; *.docx; *.ppt; *.pptx; *.xls; *.xlsx; *.html; *.htm; *.png; *.jpg; *.jpeg; *.webp; *.md; *.markdown; *.txt"
        );
        picker.appendFilters(Ci.nsIFilePicker.filterAll);
        const result = await new Promise(resolve => picker.open(resolve));
        if (result === Ci.nsIFilePicker.returnOK) {
          const files = picker.files;
          while (files?.hasMoreElements?.()) {
            selected.push(files.getNext().QueryInterface(Ci.nsIFile).path);
          }
        }
      }
      const normalized = selected.map(file => typeof file === "string" ? file : file?.path).filter(Boolean);
      return [...new Set([...(Array.isArray(currentPaths) ? currentPaths : []), ...normalized].map(String))];
    }

    async selectChatDocumentFile(win = null) {
      const target = win?.document ? win : Zotero.getMainWindow?.() || Services.wm.getMostRecentWindow("navigator:browser");
      if (typeof Zotero.FilePicker === "function") {
        const picker = new Zotero.FilePicker();
        picker.init(target, localize("添加本轮对话文档", "Attach a document to this turn"), picker.modeOpen);
        picker.appendFilter(
          localize("支持的文档", "Supported documents"),
          "*.pdf; *.doc; *.docx; *.ppt; *.pptx; *.xls; *.xlsx; *.html; *.htm; *.png; *.jpg; *.jpeg; *.jp2; *.webp; *.gif; *.bmp; *.md; *.markdown; *.txt; *.text; *.log; *.csv; *.tsv; *.json; *.jsonl; *.xml; *.yaml; *.yml; *.toml; *.ini; *.cfg; *.conf; *.py; *.m; *.r; *.js; *.ts; *.jsx; *.tsx; *.css; *.scss; *.less; *.java; *.c; *.h; *.cpp; *.hpp; *.cc; *.cs; *.go; *.rs; *.php; *.rb; *.swift; *.kt; *.kts; *.sh; *.bash; *.bat; *.ps1; *.sql"
        );
        picker.appendFilters(picker.filterAll);
        const result = await picker.show();
        if (result !== picker.returnOK) return "";
        return String(picker.file?.path || "");
      }
      const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      picker.init(target.browsingContext || target, localize("添加本轮对话文档", "Attach a document to this turn"), Ci.nsIFilePicker.modeOpen);
      picker.appendFilter(
        localize("支持的文档", "Supported documents"),
        "*.pdf; *.doc; *.docx; *.ppt; *.pptx; *.xls; *.xlsx; *.html; *.htm; *.png; *.jpg; *.jpeg; *.jp2; *.webp; *.gif; *.bmp; *.md; *.markdown; *.txt; *.text; *.log; *.csv; *.tsv; *.json; *.jsonl; *.xml; *.yaml; *.yml; *.toml; *.ini; *.cfg; *.conf; *.py; *.m; *.r; *.js; *.ts; *.jsx; *.tsx; *.css; *.scss; *.less; *.java; *.c; *.h; *.cpp; *.hpp; *.cc; *.cs; *.go; *.rs; *.php; *.rb; *.swift; *.kt; *.kts; *.sh; *.bash; *.bat; *.ps1; *.sql"
      );
      picker.appendFilters(Ci.nsIFilePicker.filterAll);
      const result = await new Promise(resolve => picker.open(resolve));
      return result === Ci.nsIFilePicker.returnOK ? String(picker.file?.path || "") : "";
    }

    async selectPDFExportPath(win, defaultName) {
      const target = win?.document ? win : Zotero.getMainWindow?.() || Services.wm.getMostRecentWindow("navigator:browser");
      const safeName = `${U.safeStem(String(defaultName || "document").replace(/\.pdf$/i, ""), 100)}.pdf`;
      if (typeof Zotero.FilePicker === "function") {
        const picker = new Zotero.FilePicker();
        picker.init(target, localize("导出PDF", "Export PDF"), picker.modeSave);
        picker.appendFilter("PDF", "*.pdf");
        picker.defaultString = safeName;
        const result = await picker.show();
        if (result !== picker.returnOK && result !== picker.returnReplace) return "";
        const path = String(picker.file?.path || "");
        return /\.pdf$/i.test(path) ? path : `${path}.pdf`;
      }
      const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      picker.init(target.browsingContext || target, localize("导出PDF", "Export PDF"), Ci.nsIFilePicker.modeSave);
      picker.appendFilter("PDF", "*.pdf");
      picker.defaultString = safeName;
      const result = await new Promise(resolve => picker.open(resolve));
      if (result !== Ci.nsIFilePicker.returnOK && result !== Ci.nsIFilePicker.returnReplace) return "";
      const path = String(picker.file?.path || "");
      return /\.pdf$/i.test(path) ? path : `${path}.pdf`;
    }

    async selectMarkdownExportPath(win, defaultName) {
      const target = win?.document ? win : Zotero.getMainWindow?.() || Services.wm.getMostRecentWindow("navigator:browser");
      const safeName = `${U.safeStem(String(defaultName || "document").replace(/\.(?:md|markdown)$/i, ""), 100)}.md`;
      if (typeof Zotero.FilePicker === "function") {
        const picker = new Zotero.FilePicker();
        picker.init(target, localize("导出Markdown", "Export Markdown"), picker.modeSave);
        picker.appendFilter("Markdown", "*.md; *.markdown");
        picker.defaultString = safeName;
        const result = await picker.show();
        if (result !== picker.returnOK && result !== picker.returnReplace) return "";
        const path = String(picker.file?.path || "");
        return /\.(?:md|markdown)$/i.test(path) ? path : `${path}.md`;
      }
      const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      picker.init(target.browsingContext || target, localize("导出Markdown", "Export Markdown"), Ci.nsIFilePicker.modeSave);
      picker.appendFilter("Markdown", "*.md; *.markdown");
      picker.defaultString = safeName;
      const result = await new Promise(resolve => picker.open(resolve));
      if (result !== Ci.nsIFilePicker.returnOK && result !== Ci.nsIFilePicker.returnReplace) return "";
      const path = String(picker.file?.path || "");
      return /\.(?:md|markdown)$/i.test(path) ? path : `${path}.md`;
    }

    async selectCAJExportPath(win, defaultName) {
      const target = win?.document ? win : Zotero.getMainWindow?.() || Services.wm.getMostRecentWindow("navigator:browser");
      const safeName = `${U.safeStem(String(defaultName || "document").replace(/\.caj$/i, ""), 100)}.caj`;
      if (typeof Zotero.FilePicker === "function") {
        const picker = new Zotero.FilePicker();
        picker.init(target, localize("导出CAJ", "Export CAJ"), picker.modeSave);
        picker.appendFilter("CAJ", "*.caj");
        picker.defaultString = safeName;
        const result = await picker.show();
        if (result !== picker.returnOK && result !== picker.returnReplace) return "";
        const path = String(picker.file?.path || "");
        return /\.caj$/i.test(path) ? path : `${path}.caj`;
      }
      const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      picker.init(target.browsingContext || target, localize("导出CAJ", "Export CAJ"), Ci.nsIFilePicker.modeSave);
      picker.appendFilter("CAJ", "*.caj");
      picker.defaultString = safeName;
      const result = await new Promise(resolve => picker.open(resolve));
      if (result !== Ci.nsIFilePicker.returnOK && result !== Ci.nsIFilePicker.returnReplace) return "";
      const path = String(picker.file?.path || "");
      return /\.caj$/i.test(path) ? path : `${path}.caj`;
    }

    async selectDirectoryExportPath(win, title) {
      const target = win?.document ? win : Zotero.getMainWindow?.() || Services.wm.getMostRecentWindow("navigator:browser");
      if (typeof Zotero.FilePicker === "function") {
        const picker = new Zotero.FilePicker();
        picker.init(target, localize(title, title), picker.modeGetFolder);
        const result = await picker.show();
        return result === picker.returnOK ? String(picker.file?.path || "") : "";
      }
      const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      picker.init(target.browsingContext || target, localize(title, title), Ci.nsIFilePicker.modeGetFolder);
      const result = await new Promise(resolve => picker.open(resolve));
      return result === Ci.nsIFilePicker.returnOK ? String(picker.file?.path || "") : "";
    }

    decodeImageDataURL(dataURL, win = null) {
      return U.decodeImageDataURL(dataURL, win);
    }

    async selectImageExportPath(win, defaultName, mimeType) {
      const target = win?.document ? win : Zotero.getMainWindow?.() || Services.wm.getMostRecentWindow("navigator:browser");
      const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/bmp": "bmp", "image/jp2": "jp2", "image/svg+xml": "svg" };
      const extension = extensions[mimeType] || "png";
      const stem = U.safeStem(String(defaultName || "generated_image").replace(/\.[^.]+$/, ""), 100);
      if (typeof Zotero.FilePicker === "function") {
        const picker = new Zotero.FilePicker();
        picker.init(target, localize("图片另存为", "Save image as"), picker.modeSave);
        picker.appendFilter(`${extension.toUpperCase()} image`, `*.${extension}`);
        picker.appendFilter(localize("所有文件", "All files"), "*.*");
        picker.defaultString = `${stem}.${extension}`;
        const result = await picker.show();
        if (result !== picker.returnOK && result !== picker.returnReplace) return "";
        const path = String(picker.file?.path || "");
        return new RegExp(`\\.${extension}$`, "i").test(path) ? path : `${path}.${extension}`;
      }
      const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      picker.init(target.browsingContext || target, localize("图片另存为", "Save image as"), Ci.nsIFilePicker.modeSave);
      picker.appendFilter(`${extension.toUpperCase()} image`, `*.${extension}`);
      picker.appendFilters(Ci.nsIFilePicker.filterAll);
      picker.defaultString = `${stem}.${extension}`;
      const result = await new Promise(resolve => picker.open(resolve));
      if (result !== Ci.nsIFilePicker.returnOK && result !== Ci.nsIFilePicker.returnReplace) return "";
      const path = String(picker.file?.path || "");
      return new RegExp(`\\.${extension}$`, "i").test(path) ? path : `${path}.${extension}`;
    }

    async saveImageData(runtime, payload) {
      const decoded = this.decodeImageDataURL(payload.dataURL, runtime.window);
      const path = await this.selectImageExportPath(runtime.window, payload.name, decoded.mimeType);
      if (!path) return { cancelled: true };
      await this.storage.writeBytes(path, decoded.bytes);
      return { cancelled: false, path, size: decoded.bytes.length };
    }

    copyImageData(runtime, payload) {
      const decoded = this.decodeImageDataURL(payload.dataURL, runtime.window);
      const transferable = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
      transferable.init(null);

      if (decoded.mimeType === "image/svg+xml") {
        const text = new TextDecoder().decode(decoded.bytes);
        const str = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
        str.data = text;
        transferable.addDataFlavor("image/svg+xml");
        transferable.setTransferData("image/svg+xml", str);
        transferable.addDataFlavor("text/unicode");
        transferable.setTransferData("text/unicode", str);
        Services.clipboard.setData(transferable, null, Services.clipboard.kGlobalClipboard);
        return { copied: true };
      }

      const imageTools = Cc["@mozilla.org/image/tools;1"].getService(Ci.imgITools);
      const buffer = decoded.bytes.buffer.slice(
        decoded.bytes.byteOffset,
        decoded.bytes.byteOffset + decoded.bytes.byteLength
      );
      const image = imageTools.decodeImageFromArrayBuffer(buffer, decoded.mimeType);
      transferable.addDataFlavor("application/x-moz-nativeimage");
      transferable.setTransferData("application/x-moz-nativeimage", image);
      Services.clipboard.setData(transferable, null, Services.clipboard.kGlobalClipboard);
      return { copied: true };
    }

    readClipboardText() {
      try {
        const transferable = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
        transferable.init(null);
        // 同时注册纯文本与Unicode类型，优先读取标准纯文本
        const flavors = ["text/plain", "text/unicode"];
        for (const flavor of flavors) {
          try {
            transferable.addDataFlavor(flavor);
          }
          catch (_) {}
        }
        try {
          Services.clipboard.getData(transferable, Services.clipboard.kGlobalClipboard);
        }
        catch (_) {
          return "";
        }
        for (const flavor of flavors) {
          const value = {};
          try {
            transferable.getTransferData(flavor, value);
          }
          catch (_) {
            continue;
          }
          if (!value.value) continue;
          try {
            const data = value.value.QueryInterface(Ci.nsISupportsString)?.data;
            if (typeof data === "string" && data.length > 0) return data;
          }
          catch (_) {}
          try {
            const data = value.value.QueryInterface(Ci.nsISupportsCString)?.data;
            if (typeof data === "string" && data.length > 0) return data;
          }
          catch (_) {}
        }
      }
      catch (_) {}
      return "";
    }

    writeClipboardText(value) {
      try {
        const stringValue = String(value || "");
        const text = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
        text.data = stringValue;
        const transferable = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
        transferable.init(null);
        for (const flavor of ["text/plain", "text/unicode"]) {
          try {
            transferable.addDataFlavor(flavor);
            transferable.setTransferData(flavor, text);
          }
          catch (_) {}
        }
        Services.clipboard.setData(transferable, null, Services.clipboard.kGlobalClipboard);
        return { copied: true };
      }
      catch (error) {
        return { copied: false, error: String(error?.message || error) };
      }
    }

    openWithDefaultApplication(filePath) {
      const file = U.createLocalFile(filePath);
      try {
        file.launch();
      }
      catch (_) {
        const service = Cc["@mozilla.org/uriloader/external-protocol-service;1"]
          .getService(Ci.nsIExternalProtocolService);
        service.loadURI(Services.io.newFileURI(file));
      }
    }

    async openTokenGuide() {
      const resourceURL = this.rootURI + "assets/docs/token-guide.pdf";
      const guideDir = PathUtils.join(this.storage.root, "guides");
      const guidePath = PathUtils.join(guideDir, "令牌创建指南.pdf");
      const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
      const channel = NetUtil.newChannel({
        uri: resourceURL,
        loadUsingSystemPrincipal: true
      });
      const bytes = await new Promise((resolve, reject) => {
        NetUtil.asyncFetch(channel, (input, status) => {
          if (!Components.isSuccessCode(status)) {
            reject(new Error(`无法读取内置指南（${status}）`));
            return;
          }
          try {
            const stream = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
            stream.setInputStream(input);
            resolve(Uint8Array.from(stream.readByteArray(stream.available())));
            stream.close();
          }
          catch (error) { reject(error); }
        });
      });
      await IOUtils.makeDirectory(guideDir, { createAncestors: true, ignoreExisting: true });
      await IOUtils.write(guidePath, bytes, { mode: "overwrite" });
      this.openWithDefaultApplication(guidePath);
      return { opened: true };
    }

    buildDiagnosticReport() {
      const zoteroVersion = Zotero.version || "未知版本";
      const pluginVersion = this.version || "2.0.0";
      const os = Services.appinfo?.OS || (Zotero.isWin ? "Windows" : (Zotero.isMac ? "macOS" : "Linux"));
      const arch = Services.appinfo?.XPCOMABI || "";

      return [
        "【LitMTrans 运行环境与诊断信息】",
        `- 插件版本: v${pluginVersion}`,
        `- Zotero版本: ${zoteroVersion} (${os} ${arch})`
      ].join("\n");
    }

    async openFeedback() {
      const report = this.buildDiagnosticReport();
      try {
        this.writeClipboardText(report);
      }
      catch (error) {
        Zotero.logError(error);
      }
      this.openExternalURL(LitMTrans.FEEDBACK_FORM_URL);
      return { opened: true, copied: true, report };
    }

    openExternalURL(value) {
      let raw = String(value || "").trim();
      if (!raw) throw new Error("官网地址无效");
      if (/^doi:\s*/i.test(raw)) raw = "https://doi.org/" + raw.replace(/^doi:\s*/i, "");
      let uri;
      try { uri = Services.io.newURI(raw); }
      catch (_) { throw new Error("官网地址无效"); }
      if (!uri.schemeIs("http") && !uri.schemeIs("https")) throw new Error("只允许打开 HTTP(S) 官网地址");

      if (typeof Zotero?.launchURL === "function") {
        Zotero.launchURL(uri.spec);
        return { opened: true };
      }

      try {
        const service = Cc["@mozilla.org/uriloader/external-protocol-service;1"]
          ?.getService(Ci.nsIExternalProtocolService);
        if (service && Ci.nsIHandlerInfo) {
          const handler = service.getProtocolHandlerInfo("http");
          handler.preferredAction = Ci.nsIHandlerInfo.useSystemDefault;
          handler.launchWithURI(uri, null);
          return { opened: true };
        }
      }
      catch (_) {
        const service = Cc["@mozilla.org/uriloader/external-protocol-service;1"]
          ?.getService(Ci.nsIExternalProtocolService);
        service?.loadURI(uri, null);
      }
      return { opened: true };
    }


    async printWorkbenchPDF(runtime, payload = {}) {
      const context = await this.attachmentContext(runtime.attachmentID);
      const pane = payload.pane === "source" ? "source" : "translation";
      const layout = Boolean(payload.layout);
      const suffix = pane === "source" ? (layout ? "排版原文" : "原文") : (layout ? "排版译文" : "译文");
      const defaultName = `${U.safeStem(context.title || context.attachment.attachmentFilename || "document", 90)}-${suffix}.pdf`;
      const providedPath = String(payload.path || "");
      const outPath = providedPath || await this.selectPDFExportPath(runtime.window, defaultName);
      if (!outPath) return { cancelled: true };
      const browsingContext = runtime.browser?.browsingContext;
      if (!browsingContext?.print) throw new Error("当前Zotero版本不支持浏览上下文PDF打印");

      const service = Cc["@mozilla.org/gfx/printsettings-service;1"].getService(Ci.nsIPrintSettingsService);
      const settings = service.createNewPrintSettings();
      settings.printerName = "Mozilla Save to PDF";
      settings.outputDestination = Ci.nsIPrintSettings.kOutputDestinationFile;
      settings.outputFormat = Ci.nsIPrintSettings.kOutputFormatPDF;
      settings.toFileName = outPath;
      settings.printSilent = true;
      settings.printBGColors = true;
      settings.printBGImages = true;
      settings.printSelectionOnly = false;
      settings.headerStrLeft = "";
      settings.headerStrCenter = "";
      settings.headerStrRight = "";
      settings.footerStrLeft = "";
      settings.footerStrCenter = "";
      settings.footerStrRight = "";
      const layoutPaper = payload.layout ? payload.layoutPaper : null;
      const paperWidth = Number(layoutPaper?.width || 0);
      const paperHeight = Number(layoutPaper?.height || 0);
      if (paperWidth > 0 && paperHeight > 0) {
        // The workbench supplies the paint-scaled sheet in CSS pixels. Using
        // that exact physical size prevents the backend from falling back to
        // its saved Letter paper (the source of right/bottom blank space).
        // `paperWidth`/`paperHeight` are always expressed in inches by the
        // native settings object.  Do not assign optional metadata such as
        // `paperName`/`paperSizeUnit`: Zotero 9 exposes this object as a
        // non-extensible WrappedNative and rejects unknown expandos.
        settings.paperWidth = paperWidth / 96;
        settings.paperHeight = paperHeight / 96;
      }
      await browsingContext.print(settings);

      let lastSize = 0;
      let stableChecks = 0;
      for (let attempt = 0; attempt < 240; attempt++) {
        const stat = await this.storage.stat(outPath);
        if (stat && Number(stat.size || 0) > 1024) {
          const size = Number(stat.size || 0);
          // `browsingContext.print()` can resolve once the PDF writer has
          // created its first bytes, while Gecko is still reading the DOM for
          // later pages. Do not let the workbench remove its print-only DOM
          // and styles until the file has stayed unchanged for a short window.
          // Otherwise the first page is a layout snapshot and the remainder
          // can unexpectedly become the live application chrome.
          stableChecks = size === lastSize ? stableChecks + 1 : 0;
          lastSize = size;
          if (stableChecks < 12) {
            await new Promise(resolve => setTimeout(resolve, 100));
            continue;
          }
          const expectedPages = Math.max(0, Number(payload.expectedPages || 0));
          if (layout && expectedPages) {
            const bytes = global.Uint8Array.from(await this.storage.readBytes(outPath));
            const printedPDF = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
            // Firefox's silent print path can produce one empty continuation
            // page after every fixed layout sheet. This is detectable without
            // guessing from visual pixels: it doubles the requested page
            // count exactly. Keep the first page from each pair, which is the
            // page containing the frozen print root, and retain all PDF text,
            // vectors, links and images by copying the original PDF pages.
            if (printedPDF.getPageCount() === expectedPages * 2) {
              const compactPDF = await PDFLib.PDFDocument.create();
              const contentIndexes = Array.from({ length: expectedPages }, (_, index) => index * 2);
              const contentPages = await compactPDF.copyPages(printedPDF, contentIndexes);
              for (const page of contentPages) compactPDF.addPage(page);
              await this.storage.writeBytes(outPath, await compactPDF.save());
            }
          }
          if (expectedPages) {
            const bytes = global.Uint8Array.from(await this.storage.readBytes(outPath));
            const printedPDF = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
            if (printedPDF.getPageCount() !== expectedPages) {
              throw new Error(`排版PDF页数异常：预期 ${expectedPages} 页，实际 ${printedPDF.getPageCount()} 页`);
            }
          }
          // The export is complete only after the output file becomes stable.
          // Launch user-requested exports then, so the system PDF application
          // receives a fully written document. Internal attachment generation
          // provides a path and must remain a non-interactive background task.
          const opened = !providedPath;
          if (opened) this.openWithDefaultApplication(outPath);
          return { cancelled: false, path: outPath, size, opened };
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error("PDF打印已结束，但没有生成有效文件");
    }

    isGeneratedExportAttachment(item) {
      try {
        const title = String(item?.getField?.("title") || "");
        return title.includes("（LitMTrans）")
          || /(?:^|[-_])译文(?:对照版)?[-_]/.test(title);
      }
      catch (_) { return false; }
    }

    sameFilePath(left, right) {
      const normalize = value => String(value || "")
        .replace(/\\/g, "/")
        .replace(/\/+$/, "")
        .toLocaleLowerCase();
      return Boolean(left && right && normalize(left) === normalize(right));
    }

    async exportAttachmentForKind(context, kind) {
      const expectedExtension = kind === "caj" ? ".caj" : ".pdf";
      const candidates = [];
      const seen = new Set();
      const add = item => {
        if (!item || this.isGeneratedExportAttachment(item)) return;
        const id = Number(item.id || 0);
        if (id && seen.has(id)) return;
        if (id) seen.add(id);
        candidates.push(item);
      };
      add(context?.attachment);
      const parent = context?.parent?.isRegularItem?.()
        ? context.parent
        : (context?.attachment?.parentID ? Zotero.Items.get(context.attachment.parentID) : null);
      for (const id of parent?.getAttachments?.() || []) add(Zotero.Items.get(id));

      for (const attachment of candidates) {
        try {
          const path = await this.attachmentPath(attachment);
          if (U.extension(path).toLowerCase() !== expectedExtension) continue;
          return { attachment, path };
        }
        catch (_) {}
      }
      return null;
    }

    async documentImageFiles(documentID) {
      const imageRoot = this.storage.path(documentID, "images");
      const files = await this.storage.walk(imageRoot);
      return files
        .filter(path => /\.(?:png|jpe?g|jp2|webp|gif|bmp|svg)$/i.test(String(path)))
        .sort((left, right) => String(left).localeCompare(String(right), undefined, { numeric: true }));
    }

    async nextAvailableExportFilePath(outputDir, fileName, reserved = new Set()) {
      let safeName = PathUtils.filename(String(fileName || "").replace(/\\/g, "/"));
      safeName = safeName
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
        .replace(/[. ]+$/g, "");
      if (!safeName) safeName = "image.png";
      const extension = /\.[^.]+$/.test(safeName) ? safeName.slice(safeName.lastIndexOf(".")) : "";
      const base = (extension ? safeName.slice(0, -extension.length) : safeName) || "image";
      const keyFor = name => Zotero.isWin ? name.toLocaleLowerCase() : name;
      for (let serial = 1; serial < 1000; serial++) {
        const candidate = serial === 1 ? `${base}${extension}` : `${base}-${serial}${extension}`;
        const key = keyFor(candidate);
        if (reserved.has(key)) continue;
        const path = PathUtils.join(outputDir, candidate);
        if (await this.storage.exists(path)) continue;
        return { path, name: candidate, key };
      }
      throw new Error("无法为导出图片找到不冲突的文件名");
    }

    async nextAvailableExportDirectory(parentDir, baseName) {
      const base = U.safeStem(baseName, 90, "assets");
      for (let serial = 1; serial < 1000; serial++) {
        const name = serial === 1 ? base : `${base}-${serial}`;
        const path = PathUtils.join(parentDir, name);
        if (!await this.storage.exists(path)) return { path, name };
      }
      throw new Error("无法为导出图片找到不冲突的资源目录");
    }

    parseMarkdownImageTarget(value) {
      let target = String(value || "").trim();
      const wrapped = target.startsWith("<") && target.endsWith(">");
      if (wrapped) target = target.slice(1, -1).trim();
      if (!target || /^(?:data:|[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) return null;
      const suffixMatch = target.match(/([?#].*)$/s);
      const suffix = suffixMatch ? suffixMatch[1] : "";
      let pathPart = suffix ? target.slice(0, -suffix.length) : target;
      try { pathPart = decodeURIComponent(pathPart); }
      catch (_) {}
      pathPart = pathPart.replace(/\\/g, "/").replace(/^\.\//, "");
      const segments = pathPart.split("/");
      if (!segments.length || !["images", "assets"].includes(segments[0].toLocaleLowerCase())) return null;
      if (segments.some(segment => !segment || segment === "." || segment === ".." || segment.includes("\0"))) return null;
      return { relative: segments.join("/"), suffix, wrapped };
    }

    encodeMarkdownAssetPath(relativePath) {
      return String(relativePath || "")
        .split("/")
        .map(segment => encodeURIComponent(segment))
        .join("/");
    }

    async exportMarkdownImageBundle(markdown, documentID, outputPath) {
      const sourceMarkdown = String(markdown || "");
      const documentRoot = this.storage.documentDir(documentID);
      const references = new Map();
      const replacements = [];
      const collect = (token, start, end) => {
        const parsed = this.parseMarkdownImageTarget(token);
        if (!parsed) return;
        let reference = references.get(parsed.relative);
        if (!reference) {
          reference = {
            ...parsed,
            sourcePath: PathUtils.join(documentRoot, ...parsed.relative.split("/")),
            available: false
          };
          references.set(parsed.relative, reference);
        }
        replacements.push({ start, end, token, reference });
      };

      const markdownPattern = /!\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/gs;
      for (const match of sourceMarkdown.matchAll(markdownPattern)) {
        const token = String(match[1] || "");
        const delimiter = match[0].match(/\]\(\s*/);
        const offset = delimiter ? delimiter.index + delimiter[0].length : -1;
        if (offset >= 0) collect(token, match.index + offset, match.index + offset + token.length);
      }
      const htmlPattern = /<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gis;
      for (const match of sourceMarkdown.matchAll(htmlPattern)) {
        const token = String(match[2] || "");
        const attribute = match[0].match(/\bsrc\s*=\s*["']/i);
        const offset = attribute ? attribute.index + attribute[0].length : -1;
        if (offset >= 0) collect(token, match.index + offset, match.index + offset + token.length);
      }

      const available = [];
      let missingCount = 0;
      for (const reference of references.values()) {
        if (await this.storage.exists(reference.sourcePath)) {
          reference.available = true;
          available.push(reference);
        }
        else missingCount++;
      }
      if (!available.length) return { markdown: sourceMarkdown, assetDirectory: "", assetCount: 0, missingCount };

      const outputParent = PathUtils.parent(outputPath);
      const outputStem = PathUtils.filename(outputPath).replace(/\.(?:md|markdown)$/i, "");
      const directory = await this.nextAvailableExportDirectory(outputParent, `${outputStem}-assets`);
      try {
        await this.storage.ensureDir(directory.path);
        for (const reference of available) {
          await this.storage.copyFile(
            reference.sourcePath,
            PathUtils.join(directory.path, ...reference.relative.split("/"))
          );
        }
      }
      catch (error) {
        await this.storage.remove(directory.path, true);
        throw error;
      }

      const replacementText = replacement => {
        const relative = `${directory.name}/${this.encodeMarkdownAssetPath(replacement.reference.relative)}${replacement.reference.suffix}`;
        if (replacement.reference.wrapped || /\s/.test(relative)) return `<${relative}>`;
        return relative;
      };
      let bundled = sourceMarkdown;
      for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
        if (!replacement.reference.available) continue;
        const replacementValue = replacementText(replacement);
        bundled = bundled.slice(0, replacement.start) + replacementValue + bundled.slice(replacement.end);
      }
      return {
        markdown: bundled,
        assetDirectory: directory.path,
        assetCount: available.length,
        missingCount
      };
    }

    async streamMarkdownForExport(documentID, pane) {
      const parsed = await this.mineru.loadParsed(documentID);
      if (pane === "source") return String(parsed?.markdown || "");
      const loaded = await this.translation.load(documentID);
      const sourceFingerprint = parsed?.markdown ? U.hashString(parsed.markdown) : "";
      if (loaded?.meta?.sourceFingerprint && sourceFingerprint
        && loaded.meta.sourceFingerprint !== sourceFingerprint) return "";
      return String(loaded?.markdown || "");
    }

    async exportStreamMarkdown(runtime, payload = {}) {
      const context = await this.attachmentContext(runtime.attachmentID, false);
      const pane = payload.pane === "source" ? "source" : "translation";
      const markdown = await this.streamMarkdownForExport(context.documentID, pane);
      if (!markdown.trim()) throw new Error(`当前没有可导出的${pane === "source" ? "原文" : "译文"}`);
      const suffix = pane === "source" ? "流式原文" : "流式译文";
      const defaultName = `${U.safeStem(context.title || PathUtils.filename(context.filePath) || "document", 90)}-${suffix}.md`;
      const outputPath = await this.selectMarkdownExportPath(runtime.window, defaultName);
      if (!outputPath) return { cancelled: true };
      const bundle = await this.exportMarkdownImageBundle(markdown, context.documentID, outputPath);
      try {
        await this.storage.writeText(outputPath, bundle.markdown);
      }
      catch (error) {
        if (bundle.assetDirectory) await this.storage.remove(bundle.assetDirectory, true);
        throw error;
      }
      return {
        cancelled: false,
        path: outputPath,
        size: bundle.markdown.length,
        assetDirectory: bundle.assetDirectory,
        assetCount: bundle.assetCount,
        missingCount: bundle.missingCount
      };
    }

    async exportDocumentImages(runtime) {
      const context = await this.attachmentContext(runtime.attachmentID, false);
      const files = await this.documentImageFiles(context.documentID);
      if (!files.length) throw new Error("当前文献没有可导出的图片");
      const defaultName = `${U.safeStem(context.title || "document", 90)}-图片`;
      const outputDir = await this.selectDirectoryExportPath(runtime.window, "选择文献图片导出文件夹");
      if (!outputDir) return { cancelled: true };
      const reserved = new Set();
      const copied = [];
      try {
        for (const sourcePath of files) {
          const selected = await this.nextAvailableExportFilePath(
            outputDir,
            PathUtils.filename(sourcePath),
            reserved
          );
          reserved.add(selected.key);
          await this.storage.copyFile(sourcePath, selected.path);
          copied.push(selected.path);
        }
      }
      catch (error) {
        await Promise.all(copied.map(path => this.storage.remove(path, false)));
        throw error;
      }
      return { cancelled: false, path: outputDir, files: copied, count: copied.length, defaultName };
    }

    async exportOriginalFile(runtime, payload = {}) {
      const context = await this.attachmentContext(runtime.attachmentID, false);
      const kind = payload.kind === "caj" ? "caj" : "pdf";
      const source = await this.exportAttachmentForKind(context, kind);
      if (!source) throw new Error(`当前文献没有可导出的原始${kind === "caj" ? "CAJ" : "PDF"}文件`);
      const defaultName = PathUtils.filename(source.path) || `document.${kind}`;
      const outputPath = kind === "pdf"
        ? await this.selectPDFExportPath(runtime.window, defaultName)
        : await this.selectCAJExportPath(runtime.window, defaultName);
      if (!outputPath) return { cancelled: true };
      if (this.sameFilePath(source.path, outputPath)) throw new Error("导出路径不能覆盖原始附件");
      await this.storage.copyFile(source.path, outputPath);
      const stat = await this.storage.stat(outputPath);
      return { cancelled: false, path: outputPath, size: Number(stat?.size || 0) };
    }

    async exportCapabilities(runtime) {
      const context = await this.attachmentContext(runtime.attachmentID, false);
      const [originalPDF, originalCAJ, parsed, translation, images] = await Promise.all([
        this.exportAttachmentForKind(context, "pdf"),
        this.exportAttachmentForKind(context, "caj"),
        this.mineru.loadParsed(context.documentID),
        this.translation.load(context.documentID),
        this.documentImageFiles(context.documentID)
      ]);
      const sourceFingerprint = parsed?.markdown ? U.hashString(parsed.markdown) : "";
      const translationReady = Boolean(translation?.markdown)
        && !(translation?.meta?.sourceFingerprint && sourceFingerprint
          && translation.meta.sourceFingerprint !== sourceFingerprint);
      return {
        originalPDF: Boolean(originalPDF),
        originalCAJ: Boolean(originalCAJ),
        pdfPages: Boolean(originalPDF || originalCAJ),
        streamSource: Boolean(parsed?.markdown),
        streamTranslation: translationReady,
        imageCount: images.length,
        title: context.title,
        fileName: PathUtils.filename(context.filePath)
      };
    }

    async exportLayoutComparisonPDF(runtime, payload = {}) {
      const context = await this.attachmentContext(runtime.attachmentID);
      const original = await this.exportAttachmentForKind(context, "pdf");
      const sourcePath = original?.path || context.filePath;
      if (!sourcePath || !await this.storage.exists(sourcePath)) throw new Error("当前文献没有可用于生成对照版的PDF原文");
      const defaultName = `${U.safeStem(context.title || "document", 90)}-排版对照版.pdf`;
      const outputPath = await this.selectPDFExportPath(runtime.window, defaultName);
      if (!outputPath) return { cancelled: true };
      if (this.sameFilePath(sourcePath, outputPath)) throw new Error("导出路径不能覆盖原始附件");
      const staging = this.storage.temporaryDir("compare");
      const translationPath = PathUtils.join(staging, "translation.pdf");
      try {
        await this.storage.ensureDir(staging);
        await this.printWorkbenchPDF(runtime, {
          pane: "translation",
          layout: true,
          path: translationPath,
          expectedPages: payload.expectedPages,
          layoutPaper: payload.layoutPaper
        });
        await this.createLayoutComparisonPDF(sourcePath, translationPath, outputPath);
        this.openWithDefaultApplication(outputPath);
        const stat = await this.storage.stat(outputPath);
        return { cancelled: false, path: outputPath, size: Number(stat?.size || 0), opened: true };
      }
      finally {
        await this.storage.remove(staging, true);
      }
    }

    async exportPDFPages(runtime, payload = {}, signal = null, emit = null) {
      const context = await this.attachmentContext(runtime.attachmentID);
      const outputDir = await this.selectDirectoryExportPath(runtime.window, "选择文献页面图导出文件夹");
      if (!outputDir) return { cancelled: true };
      const renderer = this.deepSeekWebProvider?.pageRenderer;
      if (!renderer?.renderPagesToDirectory) throw new Error("当前环境没有可用的PDF页面渲染器");
      const result = await renderer.renderPagesToDirectory(runtime, outputDir, {
        stem: U.safeStem(context.title || PathUtils.filename(context.filePath) || "document", 90),
        signal,
        emit
      });
      return { cancelled: false, path: outputDir, ...result };
    }

    async createGeneratedPDFAttachment(context, filePath, title) {
      const parent = context.parent?.isRegularItem?.() ? context.parent : null;
      const parentItemID = parent?.id || false;
      // Retain exactly one current pair for this document. `getAttachments()`
      // already scopes this to the parent item's attachments, so the stable
      // generated title is the reliable replacement key across Zotero builds.
      // Do not silently skip deletion when a version lacks
      // `isPDFAttachment()`; that created duplicate generated exports after a
      // retranslation.
      if (parentItemID) {
        const existing = Zotero.Items.get(parentItemID)?.getAttachments?.() || [];
        for (const id of existing) {
          const item = Zotero.Items.get(id);
          if (item?.getField?.("title") !== title) continue;
          // `trashTx()` belongs to Zotero.Items, not individual Zotero.Item
          // instances. Calling it on the attachment made retranslation fail as
          // soon as an earlier generated PDF with this stable title existed.
          if (typeof Zotero.Items.trashTx !== "function") {
            throw new Error(`无法替换已有的排版PDF附件：${title}`);
          }
          await Zotero.Items.trashTx(id);
        }
      }
      const attachment = await Zotero.Attachments.importFromFile({
        file: U.createLocalFile(filePath),
        parentItemID,
        libraryID: context.attachment.libraryID
      });
      attachment.setField("title", title);
      await attachment.saveTx();
      return attachment;
    }

    async createLayoutComparisonPDF(sourcePath, translationPath, outputPath) {
      // IOUtils can return a Uint8Array from a different privileged realm.
      // pdf-lib validates the array using its own realm and otherwise can
      // interpret the foreign value as a numeric length (NaN). This mirrors
      // the proven normalization used by MinerU's long-PDF splitter.
      const normalizePDFBytes = value => value instanceof global.Uint8Array
        ? value
        : global.Uint8Array.from(value || []);
      const sourceBytes = normalizePDFBytes(await this.storage.readBytes(sourcePath));
      const translationBytes = normalizePDFBytes(await this.storage.readBytes(translationPath));
      const source = await PDFLib.PDFDocument.load(sourceBytes, { ignoreEncryption: true });
      const translation = await PDFLib.PDFDocument.load(translationBytes, { ignoreEncryption: true });
      const output = await PDFLib.PDFDocument.create();
      const count = Math.max(source.getPageCount(), translation.getPageCount());
      if (!count) throw new Error("无法生成空的排版译文对照版PDF");
      const margin = 12;
      const gutter = 10;
      for (let index = 0; index < count; index++) {
        const sourcePage = index < source.getPageCount() ? await output.embedPage(source.getPage(index)) : null;
        const translatedPage = index < translation.getPageCount() ? await output.embedPage(translation.getPage(index)) : null;
        const candidates = [sourcePage, translatedPage].filter(Boolean);
        const height = Math.max(...candidates.map(page => page.height));
        const halfWidth = Math.max(...candidates.map(page => page.width * height / page.height)) + margin * 2;
        const page = output.addPage([halfWidth * 2 + gutter, height + margin * 2]);
        const draw = (embedded, x) => {
          if (!embedded) return;
          const scale = Math.min((halfWidth - margin * 2) / embedded.width, height / embedded.height);
          const width = embedded.width * scale;
          const drawnHeight = embedded.height * scale;
          page.drawPage(embedded, {
            x: x + margin + (halfWidth - margin * 2 - width) / 2,
            y: margin + (height - drawnHeight) / 2,
            width,
            height: drawnHeight
          });
        };
        draw(sourcePage, 0);
        draw(translatedPage, halfWidth + gutter);
      }
      await this.storage.writeBytes(outputPath, await output.save());
      return outputPath;
    }

    async createLayoutPDFAttachments(runtime, payload = {}) {
      const context = await this.attachmentContext(runtime.attachmentID);
      if (U.extension(context.filePath) !== ".pdf") throw new Error("排版译文PDF附件仅支持PDF原文");
      // The workbench only sends this command from its explicit completed
      // publication path, after final layout fitting. Passing that immutable
      // identity avoids re-reading a preference-dependent language path here.
      const layoutPDFIdentity = String(payload.layoutIdentity || "");
      if (!layoutPDFIdentity) throw new Error("缺少已完成排版译文的版本标识");
      const stem = U.safeStem(context.title || context.attachment.attachmentFilename || "document", 90);
      // The attachment title should identify the translation language, not
      // its rendering mode.  Use the language carried by the completed
      // translation so a settings change while the reader remains open does
      // not mislabel an already translated document.
      const targetLanguage = U.safeStem(
        U.normalizeLanguageName(payload.targetLanguage || this.getSettings().targetLanguage, "简体中文"),
        32,
        "目标语言"
      );
      const translationTitle = `${targetLanguage}-译文-${stem}`;
      const comparisonTitle = `${targetLanguage}-译文对照版-${stem}`;
      const staging = this.storage.temporaryDir("layoutpdf");
      const translationPath = PathUtils.join(staging, `${translationTitle}.pdf`);
      const comparisonPath = PathUtils.join(staging, `${comparisonTitle}.pdf`);
      try {
        await this.storage.ensureDir(staging);
        await this.printWorkbenchPDF(runtime, {
          pane: "translation",
          layout: true,
          path: translationPath,
          expectedPages: payload.expectedPages,
          layoutPaper: payload.layoutPaper
        });
        await this.createLayoutComparisonPDF(context.filePath, translationPath, comparisonPath);
        const translationAttachment = await this.createGeneratedPDFAttachment(context, translationPath, translationTitle);
        const comparisonAttachment = await this.createGeneratedPDFAttachment(context, comparisonPath, comparisonTitle);
        await this.storage.setDocumentMeta(context.documentID, { layoutPDFIdentity });
        return {
          translationAttachmentID: translationAttachment.id,
          comparisonAttachmentID: comparisonAttachment.id,
          translationTitle,
          comparisonTitle
        };
      }
      finally {
        await this.storage.remove(staging, true);
      }
    }

    async openFromCurrentSelection(win) {
      try {
        const attachment = await this.selectedAttachment(win);
        return await this.openWorkbench(attachment, { window: win });
      }
      catch (error) {
        this.alert(error.message, win);
      }
    }

    alert(message, win = null) {
      const target = win || Zotero.getMainWindow?.() || Services.wm.getMostRecentWindow("navigator:browser");
      try {
        const doc = target?.document;
        if (!doc?.createXULElement || !doc.documentElement) throw new Error("当前Zotero窗口无法显示提示");
        const panel = doc.createXULElement("panel");
        panel.setAttribute("type", "arrow");
        panel.setAttribute("noautohide", "true");
        panel.setAttribute("role", "alertdialog");
        panel.style.cssText = "max-width: min(560px, calc(100vw - 32px));";

        const box = doc.createXULElement("vbox");
        box.setAttribute("flex", "1");
        box.style.cssText = "padding: 14px; gap: 10px;";
        const title = doc.createXULElement("label");
        title.setAttribute("value", "LitMTrans");
        title.style.cssText = "font-weight: 600;";
        const text = doc.createXULElement("description");
        text.textContent = String(message || "");
        text.style.cssText = "white-space: pre-wrap; max-width: 520px;";
        const button = doc.createXULElement("button");
        button.setAttribute("label", localize("确定", "OK"));
        button.addEventListener("command", () => panel.hidePopup());
        panel.addEventListener("popuphidden", () => panel.remove(), { once: true });
        box.append(title, text, button);
        panel.appendChild(box);
        doc.documentElement.appendChild(panel);
        panel.openPopupAtScreen(target.screenX + Math.max(24, (target.outerWidth - 360) / 2), target.screenY + Math.max(24, (target.outerHeight - 180) / 2), false);
        button.focus();
        return;
      }
      catch (error) {
        // Never fall back to the native prompt service: its Windows dialog
        // plays the system notification sound. Logging keeps this failure visible
        // without reintroducing an audible notification path.
        Zotero.logError?.(new Error(`LitMTrans notification: ${String(message || "")}`));
        this.log(`Unable to show silent notification: ${error}`);
      }
    }

    async confirmEdgeModelDownload(sourceLanguage, targetLanguage) {
      const win = Zotero.getMainWindow?.() || [...this.windows][0] || null;
      const doc = win?.document;
      if (!doc?.createXULElement || !doc.documentElement) return false;
      return new Promise(resolve => {
        const panel = doc.createXULElement("panel");
        panel.setAttribute("type", "arrow");
        panel.setAttribute("noautohide", "true");
        panel.setAttribute("role", "alertdialog");
        panel.style.cssText = "max-width: min(580px, calc(100vw - 32px));";
        const box = doc.createXULElement("vbox");
        box.style.cssText = "padding: 14px; gap: 10px;";
        const title = doc.createXULElement("label");
        title.setAttribute("value", "下载Edge本地翻译模型");
        title.style.cssText = "font-weight: 600;";
        const description = doc.createXULElement("description");
        description.textContent = `Edge本地翻译需要下载${String(sourceLanguage || "源语言")}→${String(targetLanguage || "目标语言")}的本地翻译模型。\n\n模型仅保存在当前隔离Zotero配置中，下载完成后可离线使用。是否现在下载？`;
        description.style.cssText = "white-space: pre-wrap; max-width: 540px;";
        const buttons = doc.createXULElement("hbox");
        buttons.style.cssText = "gap: 8px; justify-content: flex-end;";
        const decline = doc.createXULElement("button");
        decline.setAttribute("label", localize("暂不下载", "Not now"));
        const approve = doc.createXULElement("button");
        approve.setAttribute("label", localize("下载", "Download"));
        let answered = false;
        const finish = answer => {
          if (answered) return;
          answered = true;
          resolve(Boolean(answer));
          try { panel.hidePopup(); } catch (_) { panel.remove(); }
        };
        decline.addEventListener("command", () => finish(false));
        approve.addEventListener("command", () => finish(true));
        panel.addEventListener("popuphidden", () => {
          panel.remove();
          if (!answered) finish(false);
        }, { once: true });
        buttons.append(decline, approve);
        box.append(title, description, buttons);
        panel.appendChild(box);
        doc.documentElement.appendChild(panel);
        panel.openPopupAtScreen(win.screenX + Math.max(24, (win.outerWidth - 420) / 2), win.screenY + Math.max(24, (win.outerHeight - 220) / 2), false);
        approve.focus();
      });
    }

    openWorkbenchSafely(itemOrID, options = {}) {
      void this.openWorkbench(itemOrID, options).catch(error => {
        Zotero.logError(error);
        this.alert(error.message, options.window);
      });
    }

    registerReaderIntegrations() {
      const register = (type, handler) => {
        try {
          if (typeof Zotero.Reader?.registerEventListener !== "function") return false;
          Zotero.Reader.registerEventListener(type, handler, this.id);
          this.readerHandlers.push([type, handler]);
          return true;
        }
        catch (error) {
          this.log(`Reader integration ${type} is unavailable: ${error}`);
          return false;
        }
      };

      register("renderToolbar", event => {
        const { reader, doc, append } = event;
        // Zotero may ask an add-on to render the same Reader toolbar again
        // after a tab refresh or a development reload.  The callback is
        // append-only, so guard the document rather than creating a duplicate
        // workbench entry point on every notification.
        if (doc.getElementById("litmtrans-reader-toolbar-button")) return;
        const button = doc.createElement("button");
        button.id = "litmtrans-reader-toolbar-button";
        button.type = "button";
        button.className = "toolbar-button";
        button.title = localize("打开LitMTrans，阅读原文与译文并进行文献对话", "Open LitMTrans to read, translate, and discuss the document");
        button.setAttribute("aria-label", button.title);
        // This SVG trace is loaded with the privileged plugin scripts before
        // this callback runs, so Reader needs no runtime resource request.
        button.innerHTML = LitMTrans.readerToolbarIconSVG || "▤";
        const svg = button.firstElementChild;
        if (svg?.tagName?.toLowerCase() === "svg") {
          svg.setAttribute("width", "19");
          svg.setAttribute("height", "19");
          svg.setAttribute("style", "display:block");
        }
        else {
          button.style.color = "#9b0e18";
          button.style.fontSize = "19px";
          button.style.fontWeight = "700";
        }
        button.style.cssText = "display:inline-flex;align-items:center;justify-content:center;min-width:28px;width:28px;height:28px;padding:0;white-space:nowrap";
        button.addEventListener("click", () => {
          const itemID = this.readerItemID(reader, event.params);
          if (itemID) this.openWorkbenchSafely(itemID, { window: reader._window || Zotero.getMainWindow?.() });
        });
        append(button);
      });

      register("renderTextSelectionPopup", event => {
        if (!Boolean(U.getPref("showNativeReaderAskAI", true))) return;
        const text = String(event.params?.annotation?.text || event.params?.text || "").trim();
        if (!text) return;
        const { reader, doc, append } = event;
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "toolbar-button";
        button.title = localize("把选中文本发送到当前文献对话", "Send the selected text to the document conversation");
        button.setAttribute("aria-label", button.title);
        button.innerHTML = LitMTrans.readerToolbarIconSVG || "";
        const svg = button.querySelector("svg");
        if (svg) {
          svg.setAttribute("width", "16");
          svg.setAttribute("height", "16");
          svg.setAttribute("aria-hidden", "true");
          svg.style.cssText = "display:block;flex:0 0 16px";
        }
        const label = doc.createElement("span");
        label.textContent = localize("询问AI", "Ask AI");
        label.style.cssText = "display:block;white-space:nowrap;line-height:1.2";
        button.appendChild(label);
        button.style.cssText = "display:inline-flex;align-items:center;justify-content:center;gap:5px;min-width:max-content;width:auto;max-width:none;height:30px;padding:4px 9px;white-space:nowrap;overflow:visible";
        button.addEventListener("click", () => {
          const itemID = this.readerItemID(reader, event.params);
          const annotation = event.params?.annotation || {};
          const rawPageLabel = String(annotation.pageLabel || "").trim();
          let annotationPosition = annotation.position;
          if (typeof annotationPosition === "string") {
            try { annotationPosition = JSON.parse(annotationPosition); }
            catch (_) { annotationPosition = null; }
          }
          const rawPageIndex = Number(
            annotation.pageIndex
            ?? annotationPosition?.pageIndex
            ?? event.params?.pageIndex
          );
          const numericPageLabel = Number(rawPageLabel);
          const physicalPage = Number.isFinite(rawPageIndex)
            ? rawPageIndex + 1
            : (Number.isFinite(numericPageLabel) && numericPageLabel > 0 ? numericPageLabel : 0);
          // The external Reader event can be wrapped differently between
          // Zotero releases. Geometry is an enhancement only: it must never
          // prevent the Ask AI action from opening the LitMTrans task.
          let pdfRects = [];
          let pdfRawRects = [];
          try {
            pdfRawRects = Array.from(annotationPosition?.rects || [])
              .map(rect => Array.from(rect || []).slice(0, 4).map(Number))
              .filter(rect => rect.length === 4 && rect.every(Number.isFinite));
            const pdfView = reader?._internalReader?._primaryView;
            const pdfWindow = pdfView?._iframeWindow;
            const pageView = pdfWindow?.PDFViewerApplication?.pdfViewer?.getPageView?.(
              Number.isFinite(rawPageIndex) ? Math.max(0, Math.trunc(rawPageIndex)) : 0
            );
            const viewport = pageView?.viewport;
            pdfRects = (Array.isArray(annotationPosition?.rects) ? annotationPosition.rects : [])
              .map(rect => Array.isArray(rect) ? rect.map(Number) : [])
              .filter(rect => rect.length >= 4 && rect.slice(0, 4).every(Number.isFinite))
              .map(rect => {
                const converted = viewport?.convertToViewportRectangle?.(rect.slice(0, 4));
                if (!Array.isArray(converted) || !viewport?.width || !viewport?.height) return null;
                const left = Math.min(converted[0], converted[2]);
                const top = Math.min(converted[1], converted[3]);
                return {
                  x: Math.max(0, Math.min(1, left / viewport.width)),
                  y: Math.max(0, Math.min(1, top / viewport.height)),
                  width: Math.max(.001, Math.min(1, Math.abs(converted[2] - converted[0]) / viewport.width)),
                  height: Math.max(.001, Math.min(1, Math.abs(converted[3] - converted[1]) / viewport.height))
                };
              })
              .filter(Boolean);
          }
          catch (error) {
            this.log(`无法读取Zotero PDF选区坐标，将仅按页码定位：${error}`);
          }
          if (itemID) this.openWorkbenchSafely(itemID, {
            window: reader._window || Zotero.getMainWindow?.(),
            quote: {
              type: "text",
              text,
              pane: "source",
              readerMode: "zotero-reader",
              origin: "zotero-reader",
              page: physicalPage,
              pageLabel: rawPageLabel || (physicalPage ? String(physicalPage) : ""),
              nativePageIndex: Number.isFinite(rawPageIndex) ? Math.max(0, Math.trunc(rawPageIndex)) : null,
              pdfRects,
              pdfRawRects,
              pdfReaderView: "both",
              title: localize("Zotero阅读器选文", "Zotero Reader selection")
            }
          });
        });
        append(button);
      });

      register("createViewContextMenu", event => {
        try {
          if (this.isWorkbenchReader(event?.reader)) return;
          const itemID = this.readerItemID(event?.reader, event?.params);
          if (!itemID) return;
          event.append({
            label: localize("在LitMTrans中打开", "Open in LitMTrans"),
            onCommand: () => this.openWorkbenchSafely(itemID, { window: event?.reader?._window || Zotero.getMainWindow?.() })
          });
        } catch (error) {
          this.log(`createViewContextMenu error: ${error?.message || error}`);
        }
      });
    }

    isWorkbenchReader(reader) {
      if (!reader) return false;
      try {
        if (reader._isLitMTransWorkbench || reader._runtime) return true;
        try {
          if (reader._internalReader?._isLitMTransWorkbench || reader._internalReader?._runtime) return true;
        } catch (_) {}
        if (this.tabs instanceof Map) {
          for (const runtime of this.tabs.values()) {
            if (!runtime) continue;
            if (runtime.pdfPreview === reader) return true;
            try {
              if (runtime.pdfPreview?._internalReader === reader) return true;
            } catch (_) {}
            try {
              if (reader._preview && runtime.pdfPreview === reader._preview) return true;
            } catch (_) {}
          }
        }
      } catch (_) {}
      return false;
    }

    isRuntimeWebMode(runtime) {
      if (!runtime) return false;
      try {
        if (runtime.aiMode === "web") return true;
        if (runtime.aiMode === "api") return false;
      } catch (_) {}
      try {
        if (runtime.deepSeekBrowser && !runtime.deepSeekBrowser.hidden && runtime.deepSeekBrowser.getAttribute("hidden") !== "true") {
          return true;
        }
      } catch (_) {}
      try {
        const doc = runtime.browser?.contentDocument;
        if (doc) {
          const webContainer = doc.getElementById?.("deepseek-web-container");
          if (webContainer && !webContainer.hidden) return true;
          const webBtn = doc.getElementById?.("ai-mode-web-button");
          if (webBtn?.classList?.contains?.("active")) return true;
        }
      } catch (_) {}
      try {
        return U.getPref("chatEngine", DEFAULT_CHAT_ENGINE) === "deepseek_web";
      } catch (_) {
        return false;
      }
    }

    readerItemID(reader, params = {}) {
      return Number(params?.itemID || reader?.itemID || reader?._item?.id || reader?._itemID || 0) || null;
    }

    registerItemPaneSection() {
      try {
        this.itemPaneSectionID = Zotero.ItemPaneManager.registerSection({
          paneID: "litmtrans-section",
          pluginID: this.id,
          header: {
            l10nID: "litmtrans-item-pane-header",
            icon: this.rootURI + "assets/icon.ico"
          },
          onRender: ({ body, item, setEnabled, setSectionSummary }) => {
            while (body.firstChild) body.firstChild.remove();
            const renderToken = U.randomID("item-pane");
            body._litmtransRenderToken = renderToken;
            setEnabled(Boolean(item && this.itemCouldHaveAttachment(item)));
            if (!item || !this.itemCouldHaveAttachment(item)) return;
            const doc = body.ownerDocument;
            const wrap = doc.createElement("div");
            wrap.style.cssText = "display:grid;gap:8px;padding:8px 2px;font:message-box";
            const status = doc.createElement("div");
            status.textContent = localize("正在读取状态…", "Loading status…");
            status.style.cssText = "color:var(--fill-secondary);line-height:1.45";
            const button = doc.createElement("button");
            button.type = "button";
            button.textContent = localize("打开LitMTrans", "Open LitMTrans");
            button.style.cssText = "min-height:32px;text-align:center";
            button.addEventListener("click", () => this.openWorkbenchSafely(item, { window: doc.defaultView }));
            wrap.append(status, button);
            body.appendChild(wrap);
            void (async () => {
              try {
                const attachment = await this.resolveAttachment(item);
                const documentID = this.storage.documentID(attachment);
                const [parsed, stream, layout] = await Promise.all([
                  this.mineru.loadParsed(documentID),
                  this.translation.load(documentID),
                  this.layout.loadTranslations(documentID)
                ]);
                const states = [
                  parsed.markdown ? localize("已解析", "Parsed") : localize("未解析", "Not parsed"),
                  stream.markdown ? localize("有流式译文", "Streaming translation ready") : localize("无流式译文", "No streaming translation"),
                  Object.keys(layout.translations || {}).length ? localize("有排版译文", "Layout translation ready") : localize("无排版译文", "No layout translation")
                ];
                if (body._litmtransRenderToken !== renderToken || !status.isConnected) return;
                status.textContent = states.join(" · ");
                setSectionSummary(states[0]);
              }
              catch (error) {
                if (body._litmtransRenderToken !== renderToken || !status.isConnected) return;
                status.textContent = error.message;
                setSectionSummary(localize("不可用", "Unavailable"));
              }
            })();
          }
        });
      }
      catch (error) {
        Zotero.logError(error);
      }
    }

    tabIDForAttachment(attachmentID) {
      return `litmtrans-${Number(attachmentID)}`;
    }

    async openWorkbench(itemOrID, options = {}) {
      const rawItem = typeof itemOrID === "number" || typeof itemOrID === "string"
        ? Zotero.Items.get(Number(itemOrID))
        : itemOrID;
      // 选中文献条目时优先使用 CAJ 子附件。Zotero 的 getBestAttachment()
      // 可能在同一条目同时存在 PDF 和 CAJ 时返回 PDF，导致 CAJ 入口被绕过。
      const cajAttachment = this.getCAJAttachment(rawItem);
      let attachment = cajAttachment || await this.resolveAttachment(rawItem);
      if (!cajAttachment) {
        const sourceAttachment = await this.findCAJSourceAttachmentForGeneratedPDF(attachment);
        if (sourceAttachment) attachment = sourceAttachment;
      }
      const mainWindow = Zotero.getMainWindow?.() || Services.wm.getMostRecentWindow("navigator:browser");
      const win = mainWindow?.Zotero_Tabs?.add
        ? mainWindow
        : (options.window?.Zotero_Tabs?.add ? options.window : null);
      if (!win?.Zotero_Tabs?.add) throw new Error(localize("当前Zotero窗口无法打开LitMTrans标签页", "This Zotero window cannot open a LitMTrans tab"));
      const tabID = this.tabIDForAttachment(attachment.id);
      if (this.tabs.has(tabID)) {
        const runtime = this.tabs.get(tabID);
        runtime.pendingOpen = { quote: options.quote || null, prompt: String(options.prompt || "") };
        runtime.window?.Zotero_Tabs?.select(tabID);
        try { runtime.window?.focus?.(); } catch (_) {}
        this.sendToPage(runtime, { type: "open-context", payload: runtime.pendingOpen });
        return tabID;
      }

      if (this.hasCAJAttachment(attachment)) {
        const pdfPath = await this.cachedPDFForCAJ(attachment);
        await this.ensureCAJReaderAttachment(attachment, pdfPath);
        if (this.tabs.has(tabID)) return this.openWorkbench(attachment, options);
      }

      const parentItem = attachment.parentID ? Zotero.Items.get(attachment.parentID) : attachment;
      const result = win.Zotero_Tabs.add({
        id: tabID,
        type: "litmtrans",
        title: `${localize("LitMTrans：", "LitMTrans: ")}${displayTitle(parentItem, attachment)}`,
        data: {
          // Zotero Reader locates an already-open PDF tab through data.itemID.
          // A workbench is not a Reader tab; using that shared key lets
          // Reader.open() mistake this custom tab for the PDF and rewrite its
          // title/state when a native-reader citation is opened.
          litmtransAttachmentID: attachment.id,
          kind: "litmtrans",
          icon: "litmtrans",
          iconURI: this.rootURI + "assets/icon.ico"
        },
        select: true,
        onClose: () => this.cleanupTab(tabID)
      });
      const container = result?.container;
      if (!container) throw new Error(localize("无法打开LitMTrans", "Unable to open LitMTrans"));
      // Custom tabs are appended as <tab-content> children of Zotero's deck.
      // Unlike the built-in Reader, they do not automatically make the deck's
      // intermediate hbox consume the remaining window height. Size that
      // entire parent chain before attaching the browser.
      const deck = container.parentElement;
      const deckRow = deck?.parentElement;
      for (const node of [deckRow, deck, container]) {
        if (!node) continue;
        node.setAttribute("flex", "1");
        node.style.minHeight = "0";
        node.style.height = "100%";
      }
      container.setAttribute("flex", "1");
      container.style.display = "flex";
      container.style.flex = "1 1 auto";
      container.style.alignSelf = "stretch";
      // Z7 的 XUL 布局引擎忽略 CSS absolute 定位（left/top/height 失效导致白屏），
      // 改用 XUL <stack> 容器 + left/top/width/height 属性定位（FF 全版本成熟机制）
      const stack = win.document.createXULElement("stack");
      stack.setAttribute("flex", "1");
      stack.style.width = "100%";
      stack.style.height = "100%";
      stack.style.minWidth = "0";
      stack.style.position = "relative";
      container.appendChild(stack);

      const browser = win.document.createXULElement("browser");
      browser.setAttribute("flex", "1");
      browser.setAttribute("type", "content");
      browser.setAttribute("transparent", "true");
      browser.setAttribute("maychangeremoteness", "true");
      browser.style.width = "100%";
      browser.style.height = "100%";
      browser.style.minHeight = "100%";
      stack.appendChild(browser);

      const deepSeekBrowser = win.document.createXULElement("browser");
      deepSeekBrowser.setAttribute("type", "content");
      deepSeekBrowser.setAttribute("remote", "true");
      deepSeekBrowser.setAttribute("maychangeremoteness", "true");
      deepSeekBrowser.setAttribute("disableglobalhistory", "true");
      deepSeekBrowser.setAttribute("hidden", "true");
      deepSeekBrowser.style.cssText = "background:#ffffff;border:none;box-sizing:border-box;";
      stack.appendChild(deepSeekBrowser);

      const deepSeekMask = win.document.createXULElement("box");
      deepSeekMask.setAttribute("hidden", "true");
      deepSeekMask.style.cssText = "background:rgba(0,0,0,0.42);pointer-events:auto;";
      stack.appendChild(deepSeekMask);

      const popupset = win.document.createXULElement("popupset");
      container.appendChild(popupset);

      const popupID = `litmtrans-deepseek-context-menu-${String(tabID).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      const nativePopup = win.document.createXULElement("menupopup");
      nativePopup.id = popupID;
      nativePopup.className = "litmtrans-deepseek-context-menu";
      popupset.appendChild(nativePopup);

      const documentID = `${attachment.libraryID}-${attachment.key}`;
      const itemTitle = String(parentItem?.getField("title") || attachment.getField("title") || "");
      const prefChatEngine = U.getPref("chatEngine", DEFAULT_CHAT_ENGINE);
      const runtime = {
        tabID,
        attachmentID: attachment.id,
        documentID,
        itemTitle,
        window: win,
        container,
        deepSeekStack: stack,
        popupset,
        deepSeekNativePopup: nativePopup,
        browser,
        deepSeekBrowser,
        deepSeekMask,
        bridgeInstalled: false,
        bridgeInstalling: false,
        hostReadySent: false,
        closed: false,
        aiMode: prefChatEngine === "deepseek_web" ? "web" : "api",
        pdfPreviewInitializationTask: null,
        pdfPreviewInitializationTasks: new Set(),
        pendingOpen: { quote: options.quote || null, prompt: String(options.prompt || "") }
      };
      this.tabs.set(tabID, runtime);
      // 打开菜单会同步触发 popupshowing：必须复用本次右键的 payload 重新填充，
      // 否则空 payload 会把按选中文字生成的「复制」项抹掉；菜单关闭后清掉。
      nativePopup.addEventListener("popupshowing", () => {
        this.populateDeepSeekContextMenu(runtime, nativePopup, runtime.deepSeekMenuPayload || {});
      });
      nativePopup.addEventListener("popuphidden", () => {
        runtime.deepSeekMenuPayload = null;
      });
      deepSeekBrowser.addEventListener("contextmenu", event => {
        event.preventDefault();
        event.stopPropagation();
        this.openDeepSeekContextMenu(runtime, {
          screenX: event.screenX,
          screenY: event.screenY,
          clientX: event.clientX,
          clientY: event.clientY
        });
      });
      browser.addEventListener("load", event => {
        if (event.target === browser.contentDocument) this.installBridge(runtime);
      }, true);
      browser.setAttribute("src", `chrome://litmtrans/content/src/workbench.xhtml?itemID=${attachment.id}&tabID=${encodeURIComponent(tabID)}&v=${encodeURIComponent(this.version)}`);
      win.Zotero_Tabs.select(tabID);
      return tabID;
    }

    cleanupTab(tabID) {
      const runtime = this.tabs.get(tabID);
      if (!runtime) return;
      this.stopOperations(tabID);
      runtime.closed = true;
      for (const task of runtime.pdfPreviewInitializationTasks || []) {
        try { task.cancel?.(); } catch (_) {}
      }
      try { runtime.pdfPreviewCleanup?.(); } catch (_) {}
      try { runtime.pdfPreview?.uninit?.(); } catch (_) {}
      try { runtime.deepSeekNativePopup?.remove?.(); } catch (_) {}
      try { runtime.popupset?.remove?.(); } catch (_) {}
      try { runtime.deepSeekMask?.remove?.(); } catch (_) {}
      try { runtime.deepSeekBrowser?.remove?.(); } catch (_) {}
      try { runtime.browser?.remove(); } catch (_) {}
      this.tabs.delete(tabID);
    }

    installBridge(runtime) {
      if (runtime.bridgeInstalling) return false;
      const contentWindow = runtime.browser?.contentWindow;
      if (!contentWindow) return;
      runtime.bridgeInstalling = true;
      const target = contentWindow.wrappedJSObject || contentWindow;
      const hostCall = (method, payloadJSON, requestID) => {
        let payload = {};
        try { payload = payloadJSON ? JSON.parse(String(payloadJSON)) : {}; }
        catch (_) {}
        void this.handleBridgeCall(runtime, String(method || ""), payload, String(requestID || ""));
      };
      let injected = false;
      try {
        Cu.exportFunction(hostCall, target, { defineAs: "__LitMTrans_HOST_CALL__", allowCrossOriginArguments: true });
        injected = typeof target.__LitMTrans_HOST_CALL__ === "function";
      }
      catch (error) {
        this.log(`LitMTrans bridge exportFunction 失败: ${error}`);
      }
      if (!injected) {
        try {
          target.__LitMTrans_HOST_CALL__ = hostCall;
          injected = typeof target.__LitMTrans_HOST_CALL__ === "function";
        }
        catch (error) {
          this.log(`LitMTrans bridge fallback 注入失败: ${error}`);
        }
      }
      runtime.bridgeInstalled = injected;
      runtime.bridgeInstalling = false;
      if (!injected) {
        this.log("LitMTrans bridge 未建立：页面不可见 __LitMTrans_HOST_CALL__");
        return false;
      }
      const readySent = this.sendToPage(runtime, { type: "host-ready", payload: { version: this.version } });
      runtime.hostReadySent = readySent;
      if (!readySent) {
        this.log("LitMTrans bridge 已注入，但 host-ready 未送达页面");
      }
      if (runtime.pendingOpen?.quote || runtime.pendingOpen?.prompt) {
        const contextSent = this.sendToPage(runtime, { type: "open-context", payload: runtime.pendingOpen });
        if (!contextSent) this.log("LitMTrans bridge 已注入，但 open-context 未送达页面");
      }
      return true;
    }

    sendToPage(runtime, message) {
      if (!runtime?.browser?.contentWindow) return false;
      const target = runtime.browser.contentWindow.wrappedJSObject || runtime.browser.contentWindow;
      try {
        const receiver = target.__LitMTrans_RECEIVE__;
        if (typeof receiver !== "function") return false;
        receiver(JSON.stringify(U.clonePlain(message)));
        return true;
      }
      catch (error) {
        this.log(`Page message failed: ${error}`);
        return false;
      }
    }

    emit(runtime, event) {
      this.sendToPage(runtime, { type: "event", payload: event });
    }

    notifyDeepSeekWebCacheWarning(payload = {}) {
      const event = {
        type: "deepseek-web-cache-warning",
        bytes: Number(payload?.bytes || 0),
        formatted: String(payload?.formatted || "1.5 GB")
      };
      for (const runtime of this.runtimes.values()) {
        try { this.emit(runtime, event); } catch (_) {}
      }
    }

    async handleBridgeCall(runtime, method, payload, requestID) {
      try {
        const result = await this.dispatch(runtime, method, payload || {});
        this.sendToPage(runtime, { type: "response", requestID, ok: true, payload: U.clonePlain(result) });
      }
      catch (error) {
        const normalized = U.normalizeError(error);
        if (!normalized.cancelled) Zotero.logError(error);
        this.sendToPage(runtime, { type: "response", requestID, ok: false, error: normalized });
      }
    }

    operationMap(tabID) {
      if (!this.operations.has(tabID)) this.operations.set(tabID, new Map());
      return this.operations.get(tabID);
    }

    activeOperationMap(tabID) {
      return this.operations.get(tabID) || new Map();
    }

    operationTaskMap(tabID) {
      if (!this.operationTasks.has(tabID)) this.operationTasks.set(tabID, new Map());
      return this.operationTasks.get(tabID);
    }

    stoppingOperationSet(tabID) {
      if (!this.operationStopping.has(tabID)) this.operationStopping.set(tabID, new Set());
      return this.operationStopping.get(tabID);
    }

    assertOperationAvailable(runtime, key) {
      const map = this.activeOperationMap(runtime.tabID);
      const activeKeys = [...map.keys()].filter(active => active !== key);
      const exclusive = new Set(["parse", "document"]);
      let conflict = "";
      if (exclusive.has(key)) conflict = activeKeys[0] || "";
      else if (key === "chat") conflict = activeKeys.find(active => exclusive.has(active)) || "";
      else if (["translate", "layout"].includes(key)) {
        conflict = activeKeys.find(active => exclusive.has(active) || ["translate", "layout"].includes(active)) || "";
      }
      if (conflict) throw new Error("另一项任务正在进行，请等待完成或先停止当前任务");
    }

    beginOperation(runtime, key) {
      this.assertOperationAvailable(runtime, key);
      const map = this.operationMap(runtime.tabID);
      if (map.has(key)) throw new Error("上一项任务正在停止，请稍候再试");
      const controller = U.newAbortController(runtime.window);
      map.set(key, controller);
      this.emit(runtime, { type: "operation", operation: key, running: true });
      return controller;
    }

    finishOperation(runtime, key, controller) {
      const map = this.operations.get(runtime.tabID);
      if (!map || map.get(key) !== controller) return;
      map.delete(key);
      if (!map.size) this.operations.delete(runtime.tabID);
      const tasks = this.operationTasks.get(runtime.tabID);
      tasks?.delete(key);
      if (tasks && !tasks.size) this.operationTasks.delete(runtime.tabID);
      const stopping = this.operationStopping.get(runtime.tabID);
      stopping?.delete(key);
      if (stopping && !stopping.size) this.operationStopping.delete(runtime.tabID);
      this.emit(runtime, { type: "operation", operation: key, running: false });
    }

    stopOperations(tabID, key = "") {
      const map = this.operations.get(tabID);
      if (!map) return;
      const runtime = this.tabs.get(tabID);
      if (key) {
        const controller = map.get(key);
        if (controller) {
          controller.abort("用户已停止操作");
          this.stoppingOperationSet(tabID).add(key);
          if (runtime) this.emit(runtime, { type: "operation", operation: key, running: true, stopping: true });
        }
      }
      else {
        for (const [operation, controller] of map.entries()) {
          controller.abort("用户已停止操作");
          this.stoppingOperationSet(tabID).add(operation);
          if (runtime) this.emit(runtime, { type: "operation", operation, running: true, stopping: true });
        }
      }
    }

    async withOperation(runtime, key, task) {
      const controller = this.beginOperation(runtime, key);
      const operationTask = (async () => {
        try {
          return await task(controller.signal, event => this.emit(runtime, event));
        }
        finally {
          this.finishOperation(runtime, key, controller);
        }
      })();
      if (this.operations.get(runtime.tabID)?.get(key) === controller) {
        this.operationTaskMap(runtime.tabID).set(key, operationTask);
      }
      return operationTask;
    }

    async attachmentContext(attachmentID, prepareCAJ = true) {
      const attachment = await this.resolveAttachment(attachmentID);
      const filePath = this.hasCAJAttachment(attachment)
        ? (prepareCAJ ? await this.cachedPDFForCAJ(attachment) : this.storage.path(attachment, "caj-source", "source.pdf"))
        : await this.attachmentPath(attachment);
      const parent = attachment.parentID ? Zotero.Items.get(attachment.parentID) : attachment;
      return {
        attachment,
        parent,
        filePath,
        documentID: this.storage.documentID(attachment),
        title: displayTitle(parent, attachment)
      };
    }

    async pdfPageCount(attachmentID) {
      const context = await this.attachmentContext(attachmentID);
      if (U.extension(context.filePath) !== ".pdf") return { pageCount: 0 };
      try {
        if (this.hasCAJAttachment(context.attachment)) {
          const meta = await this.storage.readJSON(this.storage.path(context.documentID, "caj-source", "source.meta.json"));
          if (meta?.cacheValidated && Number(meta.pageCount) > 0) return { pageCount: Number(meta.pageCount) };
        }
        const pdf = await PDFLib.PDFDocument.load(this.normalizeCAJBytes(await this.storage.readBytes(context.filePath)), {
          ignoreEncryption: true
        });
        return { pageCount: pdf.getPageCount() };
      }
      catch (error) {
        // A page-count advisory must never prevent a user from translating a
        // PDF that the existing MinerU path can still process.
        Zotero.logError?.(error);
        return { pageCount: 0 };
      }
    }

    async stateForAttachment(attachmentID, prepareCAJ = true) {
      const context = await this.attachmentContext(attachmentID, prepareCAJ);
      const snapshot = await this.pipeline.snapshot(context);
      const contentType = U.extension(context.filePath) === ".pdf" ? "application/pdf" : String(context.attachment.attachmentContentType || "").toLowerCase();
      const documentMeta = snapshot?.parsed?.meta || await this.storage.getDocumentMeta(context.documentID);
      const readerMode = documentMeta?.readerMode === "stream" ? "stream" : "layout";
      const isCAJ = this.hasCAJAttachment(context.attachment);
      return {
        pluginVersion: this.version,
        item: {
          attachmentID: context.attachment.id,
          parentItemID: context.parent?.id || null,
          title: context.title,
          attachmentTitle: String(context.attachment.getField?.("title") || context.attachment.attachmentFilename || ""),
          fileName: String(context.attachment.attachmentFilename || PathUtils.filename(context.filePath)),
          contentType,
          isCAJ,
          documentID: context.documentID,
          // New documents intentionally start in layout mode. A document-level
          // value is kept alongside its translation artifacts, rather than in
          // the global preferences shared by every paper.
          readerMode,
          layoutPDFIdentity: String(documentMeta?.layoutPDFIdentity || "")
        },
        ...snapshot,
        settings: this.getSettings()
      };
    }

    async dispatch(runtime, method, payload) {
      const attachmentID = runtime.attachmentID;
      switch (method) {
        case "save-layout-cache": {
          const documentID = await this.pdfDocumentID(attachmentID);
          if (documentID && payload.key && payload.data) {
            const dir = PathUtils.join(this.storage.documentsRoot, documentID, "fit");
            await this.storage.ensureDir(dir);
            await this.storage.writeJSON(
              PathUtils.join(dir, `${U.hashString(payload.key)}.json`),
              payload.data
            );
          }
          return;
        }

        case "load-layout-cache": {
          const documentID = await this.pdfDocumentID(attachmentID);
          if (documentID && payload.key) {
            const file = PathUtils.join(this.storage.documentsRoot, documentID, "fit", `${U.hashString(payload.key)}.json`);
            if (await this.storage.exists(file)) {
              return await this.storage.readJSON(file, null);
            }
          }
          return null;
        }

        case "operation-state":
          return {
            operations: [...this.activeOperationMap(runtime.tabID).keys()],
            stopping: [...(this.operationStopping.get(runtime.tabID) || [])]
          };

        case "bridge-handshake":
          return { ready: true, pluginVersion: this.version, tabID: runtime.tabID };

        case "pdf-page-count":
          return this.pdfPageCount(attachmentID);

        case "initialize":
        case "refresh":
          return this.stateForAttachment(attachmentID);

        case "viewport": {
          const rect = runtime.browser?.getBoundingClientRect?.() || runtime.container?.getBoundingClientRect?.();
          return {
            width: Math.max(0, Math.round(Number(rect?.width || 0))),
            height: Math.max(0, Math.round(Number(rect?.height || 0)))
          };
        }

        case "fit-pdf-preview": {
          if (!runtime.pdfPreview || Number(runtime.pdfPreviewAttachmentID) !== attachmentID) return { available: false };
          const pdfWindow = runtime.pdfPreview._internalReader?._primaryView?._iframeWindow;
          const viewer = pdfWindow?.PDFViewerApplication?.pdfViewer;
          if (!viewer) return { available: false };
          const container = pdfWindow.document.getElementById("viewerContainer");
          for (let attempt = 0; attempt < 20; attempt++) {
            if (Number(container?.clientWidth || 0) > 0 && Number(container?.clientHeight || 0) > 0) break;
            await Zotero.Promise.delay(50);
          }
          if (!Number(container?.clientWidth || 0) || !Number(container?.clientHeight || 0)) return { available: false };
          viewer.scrollMode = 0;
          viewer.spreadMode = 0;
          viewer.currentScaleValue = "page-width";
          try { viewer.update?.(); } catch (_) {}
          return { available: true, scale: viewer.currentScale, scaleValue: viewer.currentScaleValue };
        }

        case "initialize-pdf-preview": {
          const activeTask = runtime.pdfPreviewInitializationTask;
          if (activeTask && !activeTask.done) return { available: false, initializing: true };
          const task = {
            done: false,
            cancelled: false,
            timedOut: false,
            openStarted: false,
            openSettled: true,
            cleanupRequested: false,
            cleanupDone: false,
            preview: null,
            cancel: null
          };
          const tasks = runtime.pdfPreviewInitializationTasks || (runtime.pdfPreviewInitializationTasks = new Set());
          tasks.add(task);
          runtime.pdfPreviewInitializationTask = task;
          const runtimeIsActive = () => this.tabs.get(runtime.tabID) === runtime && !runtime.closed;
          const finishTask = () => {
            if (task.openStarted && !task.openSettled) return;
            task.done = true;
            tasks.delete(task);
            if (runtime.pdfPreviewInitializationTask === task) runtime.pdfPreviewInitializationTask = null;
          };
          let cleanupPreview = () => {};
          task.cancel = () => {
            task.cancelled = true;
            cleanupPreview();
          };
          const ensureTaskActive = () => {
            if (task.cancelled || !runtimeIsActive()) {
              task.cancelled = true;
              cleanupPreview();
              throw new Error("PDF阅读器初始化已取消");
            }
          };
          const initializePreview = async () => {
          const context = await this.attachmentContext(attachmentID);
          const attachment = context.attachment;
          if (U.extension(context.filePath) !== ".pdf") return { available: false };
          ensureTaskActive();
          if (runtime.pdfPreview && Number(runtime.pdfPreviewAttachmentID) === attachmentID) return { available: true };
          if (runtime.pdfPreview) {
            try { runtime.pdfPreviewCleanup?.(); } catch (_) {}
            try { runtime.pdfPreview.uninit?.(); } catch (_) {}
            runtime.pdfPreview = null;
            runtime.pdfPreviewAttachmentID = 0;
          }
          const frame = runtime.browser?.contentDocument?.getElementById("source-pdf");
          if (!frame) throw new Error("PDF阅读器尚未准备好，请稍后重试");
          await new Promise((resolve, reject) => {
            let timer = null;
            const finish = callback => value => {
              if (timer) clearTimeout(timer);
              frame.removeEventListener("load", onLoad);
              callback(value);
            };
            const onLoad = finish(resolve);
            frame.addEventListener("load", onLoad, { once: true });
            timer = setTimeout(() => finish(reject)(new Error("Zotero PDF阅读器页面加载超时")), 15000);
            try { frame.setAttribute("src", "resource://zotero/reader/reader.html"); }
            catch (error) { finish(reject)(error); }
          });
          const preview = this.hasCAJAttachment(attachment)
            ? await this.createCAJPreview(context, frame)
            : await Zotero.Reader.openPreview(attachmentID, frame);
          preview._isLitMTransWorkbench = true;
          preview._runtime = runtime;
          if (preview._internalReader) {
            preview._internalReader._isLitMTransWorkbench = true;
            preview._internalReader._runtime = runtime;
          }
          // ReaderPreview 面向缩略图，默认 _getState() 会返回 { scale: "page-height" }，
          // 并在 _open() 及阅读器 resize 时强制使用 page-height。
          // 这里是完整阅读窗格，必须在 _open() 前覆写 _getState 与 updatePDFAttr，
          // 并向 _open() 传入初始 state: { scale: "page-width" }。
          preview._getState = async () => ({
            pageIndex: 0,
            scale: "page-width",
            scrollMode: 0,
            spreadMode: 0
          });
          const nativeUpdatePDFAttr = preview.updatePDFAttr;
          const updatePDFToWidth = () => {
            try {
              const viewer = preview._internalReader?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer;
              if (viewer) {
                viewer.scrollMode = 0;
                viewer.spreadMode = 0;
                viewer.currentScaleValue = "page-width";
              }
            } catch (_) {}
          };
          const disableThumbnailPDFAttr = updatePDFToWidth;
          try {
            Object.defineProperty(preview, "updatePDFAttr", {
              configurable: true,
              enumerable: true,
              writable: true,
              value: disableThumbnailPDFAttr
            });
          }
          catch (_) {
            preview.updatePDFAttr = disableThumbnailPDFAttr;
          }
          // Zotero's ReaderPreview explicitly starts PDF.js with
          // `textLayerMode: 0`. That is ideal for an inert thumbnail, but it
          // removes the DOM text layer altogether: the original PDF remains
          // visible while selection, annotation, and the reader context menu
          // all stop working. Keep its embeddable lifecycle, but make the
          // reader created inside this workbench a full interactive reader.
          const readerHost = frame.contentWindow?.wrappedJSObject || frame.contentWindow;
          const createReader = readerHost?.createReader;
          if (typeof createReader === "function") {
            const createInteractiveReader = options => {
              try { options.preview = false; } catch (_) {}
              return createReader.call(readerHost, options);
            };
            try {
              Cu.exportFunction(createInteractiveReader, readerHost, {
                defineAs: "createReader",
                allowCrossOriginArguments: true
              });
            }
            catch (_) {
              try { readerHost.createReader = createInteractiveReader; } catch (_) {}
            }
          }
          preview._isReadOnly = () => false;
          // ReaderPreview has no host window or popupset, so its inherited
          // context-menu callback quietly fails even after text selection is
          // restored. Give this embedded reader a popup host and translate its
          // nested iframe coordinates into the Zotero window's screen space.
          const controller = this;
          const hostWindow = runtime.browser?.ownerGlobal || Zotero.getMainWindow();
          const popupset = hostWindow.document.createXULElement("popupset");
          hostWindow.document.documentElement.appendChild(popupset);
          preview._window = hostWindow;
          preview._popupset = popupset;
          preview._openContextMenu = async ({ x, y, itemGroups }) => {
            try {
              if (!hostWindow) return;
              const targetPopupset = popupset;
              if (!targetPopupset) return;

              const popup = hostWindow.document.createXULElement("menupopup");
              targetPopupset.appendChild(popup);
              const done = Zotero.Promise.defer();
              popup.addEventListener("popuphidden", event => {
                if (event.target !== popup) return;
                try { popup.remove(); } catch (_) {}
                done.resolve();
              });

              const openInLitMTransLabel = localize("在LitMTrans中打开", "Open in LitMTrans");
              const isOpenInLitMTrans = (it) => {
                const label = String(it?.label || "").trim();
                return label === openInLitMTransLabel || label === "在LitMTrans中打开" || label === "Open in LitMTrans";
              };

              let filteredGroups = [];
              try {
                filteredGroups = (itemGroups || [])
                  .map(group => (group || []).filter(item => !isOpenInLitMTrans(item)))
                  .filter(group => group.length > 0);
              } catch (_) {
                filteredGroups = itemGroups || [];
              }

              let isWeb = false;
              try {
                isWeb = controller.isRuntimeWebMode(runtime);
              } catch (_) {}

              if (isWeb) {
                filteredGroups.push([
                  {
                    label: "原文添加至AI",
                    onCommand: () => {
                      void controller.addPaperSourceToAI(runtime);
                    }
                  },
                  {
                    label: "图形式添加至AI",
                    onCommand: () => {
                      void controller.addPaperPagesToAI(runtime);
                    }
                  }
                ]);
              }

              // 嵌入的原始PDF属于Zotero Reader子文档，右键事件不会冒泡到
              // 工作台。把请求转回工作台，复用解析版排版原文的完整导出链路。
              filteredGroups.push([{
                label: "导出排版原文为PDF",
                onCommand: () => {
                  const sent = controller.sendToPage(runtime, {
                    type: "event",
                    payload: { type: "export-reader-pdf", pane: "source" }
                  });
                  if (!sent) controller.log("排版原文导出请求未送达工作台");
                }
              }]);

              for (const [groupIndex, group] of filteredGroups.entries()) {
                for (const item of group || []) {
                  if (item.groups) {
                    const menu = hostWindow.document.createXULElement("menu");
                    menu.setAttribute("label", item.label || "");
                    const submenu = hostWindow.document.createXULElement("menupopup");
                    menu.appendChild(submenu);
                    for (const nestedGroup of item.groups || []) {
                      for (const nestedItem of nestedGroup || []) {
                        const nested = hostWindow.document.createXULElement("menuitem");
                        nested.setAttribute("label", nestedItem.label || "");
                        nested.setAttribute("disabled", Boolean(nestedItem.disabled));
                        nested.addEventListener("command", () => nestedItem.onCommand?.());
                        submenu.appendChild(nested);
                      }
                    }
                    popup.appendChild(menu);
                    continue;
                  }
                  const menuitem = hostWindow.document.createXULElement("menuitem");
                  menuitem.setAttribute("label", item.label || "");
                  menuitem.setAttribute("disabled", Boolean(item.disabled));
                  if (item.color) {
                    menuitem.className = "menuitem-iconic";
                    try {
                      menuitem.setAttribute("image", preview._getColorIcon(item.color, item.checked));
                    } catch (_) {}
                  }
                  else if (item.checked) {
                    menuitem.setAttribute("type", "checkbox");
                    menuitem.setAttribute("checked", "true");
                  }
                  menuitem.addEventListener("command", () => item.onCommand?.());
                  popup.appendChild(menuitem);
                }
                if (groupIndex < filteredGroups.length - 1) {
                  popup.appendChild(hostWindow.document.createXULElement("menuseparator"));
                }
              }

              let screenX = 0;
              let screenY = 0;
              try {
                const outerRect = runtime.browser?.getBoundingClientRect?.() || { x: 0, y: 0 };
                const frameRect = frame.getBoundingClientRect();
                const screenPoint = hostWindow.windowUtils.toScreenRectInCSSUnits(
                  Number(outerRect.x || 0) + frameRect.x + Number(x || 0),
                  Number(outerRect.y || 0) + frameRect.y + Number(y || 0),
                  0, 0
                );
                screenX = screenPoint.x;
                screenY = screenPoint.y;
              } catch (_) {
                screenX = Number(x || 0);
                screenY = Number(y || 0);
              }

              setTimeout(() => {
                try {
                  popup.openPopupAtScreen(screenX, screenY, true);
                } catch (e) {
                  popup.remove();
                  controller.log(`popup.openPopupAtScreen error: ${e?.message || e}`);
                  done.resolve();
                }
              });

              return done.promise;
            } catch (err) {
              controller.log(`preview._openContextMenu error: ${err?.message || err}`);
            }
          };
          task.preview = preview;
          cleanupPreview = () => {
            task.cleanupRequested = true;
            if (task.openStarted && !task.openSettled) return;
            if (task.cleanupDone) return;
            task.cleanupDone = true;
            try { popupset.remove(); } catch (_) {}
            try { preview.uninit?.(); } catch (_) {}
            finishTask();
          };
          ensureTaskActive();
          task.openStarted = true;
          task.openSettled = false;
          const initialReaderState = {
            pageIndex: 0,
            scale: "page-width",
            scrollMode: 0,
            spreadMode: 0
          };
          const openPromise = Promise.resolve().then(() => preview._open({
            state: initialReaderState
          }));
          openPromise.then(
            () => {
              task.openSettled = true;
              try {
                if (preview._internalReader) {
                  preview._internalReader._isLitMTransWorkbench = true;
                  preview._internalReader._runtime = runtime;
                }
              } catch (_) {}
              if (task.cleanupRequested || task.cancelled || task.timedOut || !runtimeIsActive()) cleanupPreview();
            },
            () => {
              task.openSettled = true;
              cleanupPreview();
            }
          );
          let openTimer = null;
          const opened = await Promise.race([
            openPromise,
            new Promise((_, reject) => {
              openTimer = setTimeout(() => reject(new Error("Zotero PDF阅读器初始化超时")), 45000);
            })
          ]).catch(error => {
            // 超时只会结束等待，不能取消 Zotero 内部的 _open()。等它迟到完成
            // 或失败后再清理，避免旧实例与下一次重试并行存活。
            task.timedOut = true;
            cleanupPreview();
            throw error;
          }).finally(() => {
            if (openTimer) clearTimeout(openTimer);
          });
          if (!opened) {
            cleanupPreview();
            throw new Error("无法打开Zotero PDF阅读器");
          }
          ensureTaskActive();
          // ReaderPreview is intended for compact, single-page previews. Its
          // defaults deliberately hide the viewer scroller and force page
          // mode, which is unsuitable for the workbench's reading pane.
          const pdfWindow = preview._internalReader?._primaryView?._iframeWindow;
          const pdfViewer = pdfWindow?.PDFViewerApplication?.pdfViewer;
          if (!pdfWindow || !pdfViewer) {
            cleanupPreview();
            throw new Error("Zotero PDF阅读器未能加载此页面");
          }
          pdfWindow.removeEventListener("resize", preview.updatePDFAttr);
          pdfWindow.removeEventListener("resize", nativeUpdatePDFAttr);
          // The selection toolbar (including our “Ask AI” section) belongs
          // to the outer reader.html document, rather than PDF.js's nested
          // iframe. ReaderPreview hides that outer UI by default, so restore
          // it there and hide only its redundant top toolbar.
          const readerWindow = preview._iframeWindow || frame.contentWindow;
          const readerStyle = readerWindow?.document?.createElement?.("style");
          if (readerStyle) {
            readerStyle.id = "litmtrans-interactive-reader-ui";
            readerStyle.textContent = `
              #reader-ui { display: block !important; height: 100% !important; }
              #reader-ui > div > div:first-child { display: none !important; }
              #reader-ui > div > div:nth-child(2), #reader-ui .sidebar, #reader-ui .sidebar-resizer { display: none !important; }
            `;
            readerWindow.document.head.appendChild(readerStyle);
          }
          const style = pdfWindow.document.createElement("style");
          style.id = "litmtrans-scrollable-original-pdf";
          style.textContent = `
            #viewerContainer { overflow: auto !important; }
            .pdfViewer { padding-bottom: 24px !important; }
          `;
          pdfWindow.document.head.appendChild(style);
          pdfViewer.scrollMode = 0;
          pdfViewer.spreadMode = 0;
          pdfViewer.currentScaleValue = "page-width";
          const fitPDFToWidth = () => {
            try {
              pdfViewer.scrollMode = 0;
              pdfViewer.spreadMode = 0;
              pdfViewer.currentScaleValue = "page-width";
            } catch (_) {}
          };
          pdfWindow.addEventListener("resize", fitPDFToWidth, { passive: true });
          ensureTaskActive();
          runtime.pdfPreview = preview;
          runtime.pdfPreviewAttachmentID = attachmentID;
          const eventBus = pdfWindow.PDFViewerApplication?.eventBus;
          if (eventBus?.on) {
            eventBus.on("pagesloaded", fitPDFToWidth);
            eventBus.on("pagesinit", fitPDFToWidth);
          }
          const viewerContainer = pdfWindow.document.getElementById("viewerContainer");
          const anchorRatio = .35;
          let locationFrame = 0;
          const zoomOriginalPDF = event => {
            if (!event.ctrlKey || !event.deltaY) return;
            // Keep the source PDF's Ctrl+wheel behavior inside the embedded
            // Reader. This changes only PDF.js's viewport scale; the Zotero
            // attachment and every translated-layout datum remain untouched.
            event.preventDefault();
            event.stopPropagation();
            const current = Number(pdfViewer.currentScale || 1);
            const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
            pdfViewer.currentScaleValue = String(Math.max(.5, Math.min(4, current * factor)));
          };
          const emitLocation = event => {
            if (locationFrame) return;
            locationFrame = pdfWindow.requestAnimationFrame(() => {
              locationFrame = 0;
              const page = Math.max(1, Number(event?.pageNumber || pdfViewer.currentPageNumber || 1));
              const pageView = pdfViewer.getPageView?.(page - 1);
              const pageRect = pageView?.div?.getBoundingClientRect?.();
              const viewerRect = viewerContainer?.getBoundingClientRect?.();
              const focusY = (viewerRect?.top || 0) + Number(viewerContainer?.clientHeight || 0) * anchorRatio;
              const pageRatio = pageRect
                ? Math.max(0, Math.min(1, (focusY - pageRect.top) / Math.max(1, pageRect.height)))
                : 0;
              this.sendToPage(runtime, { type: "event", payload: { type: "reader-location", page, pageRatio, anchorRatio } });
            });
          };
          const readerScroll = () => emitLocation();
          let selectionFrame = 0;
          const emitSelection = () => {
            if (selectionFrame) return;
            selectionFrame = pdfWindow.requestAnimationFrame(() => {
              selectionFrame = 0;
              const selection = pdfWindow.getSelection?.();
              const text = String(selection?.toString?.() || "").replace(/\s+/g, " ").trim();
              if (!text || selection.isCollapsed || !selection.rangeCount) {
                this.sendToPage(runtime, { type: "event", payload: { type: "native-pdf-selection" } });
                return;
              }
              const rangeRect = selection.getRangeAt(0).getBoundingClientRect?.();
              const pdfFrame = preview._internalReader?._primaryView?._iframe;
              const outerRect = frame.getBoundingClientRect();
              const pdfRect = pdfFrame?.getBoundingClientRect?.();
              const page = Math.max(1, Number(pdfViewer.currentPageNumber || 1));
              const pageRect = pdfViewer.getPageView?.(page - 1)?.div?.getBoundingClientRect?.();
              const pdfRects = pageRect?.width && pageRect?.height
                ? Array.from(selection.getRangeAt(0).getClientRects?.() || [])
                  .map(rect => ({
                    x: (rect.left - pageRect.left) / pageRect.width,
                    y: (rect.top - pageRect.top) / pageRect.height,
                    width: rect.width / pageRect.width,
                    height: rect.height / pageRect.height
                  }))
                  .filter(rect => rect.width > 0 && rect.height > 0 && rect.x < 1 && rect.y < 1 && rect.x + rect.width > 0 && rect.y + rect.height > 0)
                  .map(rect => ({
                    x: Math.max(0, rect.x), y: Math.max(0, rect.y),
                    width: Math.min(1, rect.width), height: Math.min(1, rect.height)
                  }))
                : [];
              this.sendToPage(runtime, {
                type: "event",
                payload: {
                  type: "native-pdf-selection",
                  text,
                  page,
                  pdfRects,
                  x: outerRect.x + Number(pdfRect?.x || 0) + Number(rangeRect?.left || 0) + Number(rangeRect?.width || 0) / 2,
                  y: outerRect.y + Number(pdfRect?.y || 0) + Number(rangeRect?.bottom || 0)
                }
              });
            });
          };
          if (eventBus?.on) {
            eventBus.on("pagechanging", emitLocation);
          }
          if (viewerContainer) {
            viewerContainer.addEventListener("scroll", readerScroll, { passive: true });
            pdfWindow.document.addEventListener("selectionchange", emitSelection);
            // Capture before PDF.js handles the wheel event so it cannot
            // escape the iframe as an application/browser zoom gesture.
            viewerContainer.addEventListener("wheel", zoomOriginalPDF, { capture: true, passive: false });
          }
          if (eventBus?.on || viewerContainer) {
            runtime.pdfPreviewCleanup = () => {
              try { eventBus?.off?.("pagesloaded", fitPDFToWidth); } catch (_) {}
              try { eventBus?.off?.("pagesinit", fitPDFToWidth); } catch (_) {}
              try { eventBus?.off?.("pagechanging", emitLocation); } catch (_) {}
              try { viewerContainer?.removeEventListener("scroll", readerScroll); } catch (_) {}
              try { pdfWindow.document.removeEventListener("selectionchange", emitSelection); } catch (_) {}
              try { viewerContainer?.removeEventListener("wheel", zoomOriginalPDF, true); } catch (_) {}
              try { pdfWindow.removeEventListener("resize", fitPDFToWidth); } catch (_) {}
              try { if (locationFrame) pdfWindow.cancelAnimationFrame(locationFrame); } catch (_) {}
              try { if (selectionFrame) pdfWindow.cancelAnimationFrame(selectionFrame); } catch (_) {}
              try { readerStyle?.remove(); } catch (_) {}
              try { popupset?.remove(); } catch (_) {}
              runtime.pdfPreviewCleanup = null;
            };
          }
          return { available: true, page: Number(pdfViewer.currentPageNumber || 1) };
          };
          try {
            return await initializePreview();
          }
          catch (error) {
            cleanupPreview();
            if (task.timedOut) {
              return { available: false, initializing: true, retryable: false, reopenRequired: true };
            }
            throw error;
          }
          finally {
            if (!task.openStarted || task.openSettled) finishTask();
          }
        }

        case "reader-preview-location": {
          const pdfWindow = runtime.pdfPreview?._internalReader?._primaryView?._iframeWindow;
          const pdfViewer = pdfWindow?.PDFViewerApplication?.pdfViewer;
          if (!pdfViewer) return { available: false, page: 0 };
          return { available: true, page: Math.max(1, Number(pdfViewer.currentPageNumber || 1)) };
        }

        case "reader-preview-jump": {
          const pdfWindow = runtime.pdfPreview?._internalReader?._primaryView?._iframeWindow;
          const pdfViewer = pdfWindow?.PDFViewerApplication?.pdfViewer;
          if (!pdfViewer) throw new Error("Zotero PDF阅读器尚未准备好");
          const page = Math.max(1, Math.min(Number(pdfViewer.pagesCount || Infinity), Math.trunc(Number(payload.page || 1))));
          const pageRatio = Math.max(0, Math.min(1, Number(payload.pageRatio || 0)));
          const anchorRatio = Math.max(0, Math.min(1, Number(payload.anchorRatio ?? .5)));
          const highlightText = String(payload.highlightText || "");
          const highlightRects = (Array.isArray(payload.highlightRects) ? payload.highlightRects : [])
            .map(rect => ({ x: Number(rect?.x), y: Number(rect?.y), width: Number(rect?.width), height: Number(rect?.height) }))
            .filter(rect => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0);
          const highlightRawRects = (Array.isArray(payload.highlightRawRects) ? payload.highlightRawRects : [])
            .map(rect => Array.isArray(rect) ? rect.slice(0, 4).map(Number) : [])
            .filter(rect => rect.length === 4 && rect.every(Number.isFinite));
          if (typeof pdfViewer.scrollPageIntoView === "function") {
            pdfViewer.scrollPageIntoView({ pageNumber: page });
          }
          else {
            pdfViewer.currentPageNumber = page;
          }
          // scrollPageIntoView only reaches the page boundary. Match the
          // translation pane's viewport anchor after PDF.js has materialised
          // the target view, so long pages stay aligned within the page too.
          pdfWindow.requestAnimationFrame(() => {
            const viewerContainer = pdfWindow.document.getElementById("viewerContainer");
            const pageView = pdfViewer.getPageView?.(page - 1);
            if (!viewerContainer || !pageView?.div) return;
            const top = pageView.div.offsetTop + pageView.div.offsetHeight * pageRatio - viewerContainer.clientHeight * anchorRatio;
            const range = Math.max(0, viewerContainer.scrollHeight - viewerContainer.clientHeight);
            viewerContainer.scrollTop = Math.max(0, Math.min(range, top));
            const drawHighlight = (attempt = 0) => {
              pdfWindow.document.getElementById("litmtrans-pdf-reference-focus")?.remove();
              const pageViewport = pageView?.viewport;
              const convertedRawRects = highlightRawRects.map(rect => {
                const converted = pageViewport?.convertToViewportRectangle?.(rect);
                if (!Array.isArray(converted) || !pageViewport?.width || !pageViewport?.height) return null;
                const left = Math.min(converted[0], converted[2]);
                const top = Math.min(converted[1], converted[3]);
                return { x: left / pageViewport.width, y: top / pageViewport.height, width: Math.abs(converted[2] - converted[0]) / pageViewport.width, height: Math.abs(converted[3] - converted[1]) / pageViewport.height };
              }).filter(Boolean);
              const sentenceRects = pdfTextHighlightRects(pageView, highlightText, pdfWindow);
              if (highlightText && !sentenceRects.length && attempt < 5) {
                pdfWindow.setTimeout(() => drawHighlight(attempt + 1), 120 * (attempt + 1)); return;
              }
              const allHighlightRects = sentenceRects.length ? sentenceRects : (highlightRects.length ? highlightRects : convertedRawRects);
              if (!allHighlightRects.length || !pageView?.div) return;
              if (sentenceRects.length) {
                const firstRect = sentenceRects[0]; const lastRect = sentenceRects.at(-1);
                const centerY = (Math.max(0, firstRect.y) + Math.max(0, lastRect.y + lastRect.height)) / 2;
                const sentenceTop = pageView.div.offsetTop + centerY * pageView.div.offsetHeight - viewerContainer.clientHeight * .5;
                viewerContainer.scrollTop = Math.max(0, Math.min(range, sentenceTop));
              }
              const overlay = pdfWindow.document.createElement("div");
              overlay.id = "litmtrans-pdf-reference-focus";
              overlay.style.cssText = "position:absolute;inset:0;z-index:20;pointer-events:none";
              for (const rect of allHighlightRects) {
                const mark = pdfWindow.document.createElement("span");
                mark.style.cssText = `position:absolute;left:${Math.max(0, rect.x) * 100}%;top:${Math.max(0, rect.y) * 100}%;width:${Math.min(1, rect.width) * 100}%;height:${Math.min(1, rect.height) * 100}%;box-sizing:border-box;border:2px solid #d89400;background:rgba(255,193,7,.28);border-radius:2px`;
                overlay.appendChild(mark);
              }
              pageView.div.appendChild(overlay);
              pdfWindow.setTimeout(() => overlay.remove(), 4200);
            };
            pdfWindow.requestAnimationFrame(() => drawHighlight());
          });
          return { available: true, page, pageRatio, anchorRatio };
        }

        case "reveal-native-reference": {
          const attachment = await this.resolveAttachment(attachmentID);
          if (!attachment.isPDFAttachment?.() && !this.hasCAJAttachment(attachment)) {
            throw new Error("这条引用来自PDF，但当前附件不是PDF文件");
          }
          const nativePageIndex = Number(payload.nativePageIndex);
          const fallbackPage = Number(payload.page);
          const pageIndex = Number.isFinite(nativePageIndex)
            ? Math.max(0, Math.trunc(nativePageIndex))
            : Math.max(0, Math.trunc(Number.isFinite(fallbackPage) && fallbackPage > 0 ? fallbackPage - 1 : 0));
          if (this.hasCAJAttachment(attachment)) {
            return this.dispatch(runtime, "reader-preview-jump", { page: pageIndex + 1 });
          }
          await Zotero.Reader.open(attachment.id, { pageIndex });
          return { opened: true, pageIndex, page: pageIndex + 1 };
        }

        case "parse":
          return this.withOperation(runtime, "parse", async (signal, emit) => {
            const context = await this.attachmentContext(attachmentID);
            const result = await this.pipeline.parse(context, payload, emit, signal);
            return { ...result, state: await this.stateForAttachment(attachmentID) };
          });

        case "translate":
          return this.withOperation(runtime, "translate", async (signal, emit) => {
            const context = await this.attachmentContext(attachmentID);
            const prefTransProvider = U.getPref("translationProvider", "");
            const isWeb = payload.engine === "deepseek_web" || payload.aiMode === "web" || prefTransProvider === "deepseek_web";
            const engine = isWeb ? "deepseek_web" : (payload.engine || undefined);
            const probeMsg = `[探针2-控制器] translate: doc=${context.documentID}, engine=${engine}, aiMode=${payload.aiMode}, hasRuntime=${Boolean(runtime)}, hasBrowser=${Boolean(runtime?.deepSeekBrowser)}`;
            emit?.({ type: "log", message: probeMsg });
            try { Zotero.debug?.(`[LitMTrans-Probe] ${probeMsg}`); } catch (_) {}
            return this.pipeline.translateStream(context, { ...payload, engine, aiMode: isWeb ? "web" : payload.aiMode, runtime }, emit, signal);
          });

        case "translate-layout":
          return this.withOperation(runtime, "layout", async (signal, emit) => {
            const context = await this.attachmentContext(attachmentID);
            const prefTransProvider = U.getPref("translationProvider", "");
            const isWeb = payload.engine === "deepseek_web" || payload.aiMode === "web" || prefTransProvider === "deepseek_web";
            const engine = isWeb ? "deepseek_web" : (payload.engine || undefined);
            const probeMsg = `[探针2-控制器] translate-layout: doc=${context.documentID}, engine=${engine}, aiMode=${payload.aiMode}, hasRuntime=${Boolean(runtime)}, hasBrowser=${Boolean(runtime?.deepSeekBrowser)}`;
            emit?.({ type: "log", message: probeMsg });
            try { Zotero.debug?.(`[LitMTrans-Probe] ${probeMsg}`); } catch (_) {}
            return this.pipeline.translateLayout(context, { ...payload, engine, aiMode: isWeb ? "web" : payload.aiMode, runtime }, emit, signal);
          });

        case "manual-translation-command": {
          const context = await this.attachmentContext(attachmentID);
          return { command: await this.pipeline.manualTranslationCommand(context, payload.mode === "layout" ? "layout" : "stream") };
        }

        case "manual-translation-import":
          return this.withOperation(runtime, "manual-translation", async (signal, emit) => {
            const context = await this.attachmentContext(attachmentID);
            const result = await this.pipeline.importManualTranslation(context, payload.mode === "layout" ? "layout" : "stream", payload.responses, emit, signal);
            return { ...result, state: await this.stateForAttachment(attachmentID) };
          });

        case "manual-translation-merge-response": {
          const context = await this.attachmentContext(attachmentID);
          return this.pipeline.mergeManualTranslationResponse(context, payload.mode === "layout" ? "layout" : "stream", payload.translations, payload.response);
        }

        case "manual-translation-recovery-command": {
          const context = await this.attachmentContext(attachmentID);
          return { command: await this.pipeline.manualTranslationRecoveryCommand(context, payload.mode === "layout" ? "layout" : "stream", payload.responses) };
        }

        case "save-reader-mode": {
          const mode = payload.mode === "stream" ? "stream" : "layout";
          const context = await this.attachmentContext(attachmentID);
          await this.storage.setDocumentMeta(context.documentID, { readerMode: mode });
          return { readerMode: mode };
        }

        case "create-layout-pdf-attachments":
          return this.createLayoutPDFAttachments(runtime, payload);

        case "translation-logs": {
          const context = await this.attachmentContext(attachmentID);
          return this.storage.readProcessLog(context.documentID, payload.limit);
        }

        case "diagram-resolve-evidence": {
          const context = await this.attachmentContext(attachmentID);
          const evidence = payload.evidence && typeof payload.evidence === "object" ? payload.evidence : null;
          if (!evidence) return { resolved: false };
          const compiled = await this.storage.readJSON(this.storage.path(context.documentID, "compiled-model.json"), null);
          const match = compiledEvidenceMatches(compiled, evidence);
          return match ? { resolved: true, ...match } : { resolved: false };
        }

        case "diagram-get-cached": {
          const documentID = await this.diagramDocumentID(attachmentID);
          const taskType = diagramCacheTaskType(payload.taskType);
          if (!taskType) return { cached: false };
          const filePath = this.storage.path(documentID, "diagrams", `${taskType}.json`);
          return this.withDiagramCacheLock(filePath, async () => {
            const data = await this.storage.readJSON(filePath, null);
            const normalized = LitMTrans.DiagramCache.normalize(data, taskType);
            const mode = String(normalized?.mode || "");
            const sourceFingerprint = await this.diagramSourceFingerprint(documentID);
            const serialized = normalized?.diagram ? JSON.stringify(normalized.diagram) : "";
            if (
              !normalized
              || !sourceFingerprint
              || normalized.sourceFingerprint !== sourceFingerprint
              || diagramCacheMode(mode, taskType) !== mode
              || !isDiagramCacheShape(normalized.diagram, mode)
              || serialized.length > DIAGRAM_CACHE_MAX_CHARS
            ) return { cached: false };
            return { cached: true, data: normalized };
          });
        }

        case "diagram-save-cached": {
          const documentID = await this.diagramDocumentID(attachmentID);
          const taskType = diagramCacheTaskType(payload.taskType);
          const mode = diagramCacheMode(payload.mode, taskType);
          if (!taskType || !mode || !isDiagramCacheShape(payload.diagram, mode)) return { saved: false };
          const serialized = JSON.stringify(payload.diagram);
          if (serialized.length > DIAGRAM_CACHE_MAX_CHARS) return { saved: false };
          const filePath = this.storage.path(documentID, "diagrams", `${taskType}.json`);
          return this.withDiagramCacheLock(filePath, async () => {
            const sourceFingerprint = await this.diagramSourceFingerprint(documentID);
            if (!sourceFingerprint) return { saved: false };
            const data = LitMTrans.DiagramCache.build({ taskType, mode, title: payload.title, sourceFingerprint, diagram: payload.diagram });
            if (!data) return { saved: false };
            await this.storage.writeJSON(filePath, data);
            return { saved: true };
          });
        }

        case "diagram-clear-cached": {
          const documentID = await this.diagramDocumentID(attachmentID);
          const taskType = diagramCacheTaskType(payload.taskType);
          if (!taskType) return { cleared: false };
          const filePath = this.storage.path(documentID, "diagrams", `${taskType}.json`);
          return this.withDiagramCacheLock(filePath, async () => ({
            cleared: await this.storage.removeFile(filePath)
          }));
        }

        case "chat-send":
          return this.withOperation(runtime, "chat", async (signal, emit) => {
            const context = await this.attachmentContext(attachmentID);
            const prefEngine = U.getPref("chatEngine", DEFAULT_CHAT_ENGINE) === "deepseek_web" ? "deepseek_web" : "api";
            const engine = (payload.engine === "deepseek_web" || payload.aiMode === "web")
              ? "deepseek_web"
              : ((payload.engine === "api" || payload.aiMode === "api") ? "api" : prefEngine);
            const targetSessionID = engine === "deepseek_web"
              ? this.chat.documentSessionID("web")
              : (payload.sessionID || this.chat.documentSessionID());
            return this.chat.send(context.documentID, targetSessionID, payload.text, {
              contextMode: payload.contextMode,
              selectedText: payload.selectedText,
              referenceQuotes: Array.isArray(payload.referenceQuotes) ? payload.referenceQuotes : [],
              responseLanguage: payload.responseLanguage,
              images: Array.isArray(payload.images) ? payload.images : [],
              documents: Array.isArray(payload.documents) ? payload.documents : [],
              documentOptions: payload.documentOptions,
              taskType: String(payload.taskType || ""),
              mindmap: Boolean(payload.mindmap),
              flowchart: Boolean(payload.flowchart),
              engine,
              aiMode: engine === "deepseek_web" ? "web" : "api",
              runtime
            }, emit, signal);
          });

        case "chat-resend":
          return this.withOperation(runtime, "chat", async (signal, emit) => {
            const context = await this.attachmentContext(attachmentID);
            const prefEngine = U.getPref("chatEngine", DEFAULT_CHAT_ENGINE) === "deepseek_web" ? "deepseek_web" : "api";
            const engine = (payload.engine === "deepseek_web" || payload.aiMode === "web")
              ? "deepseek_web"
              : ((payload.engine === "api" || payload.aiMode === "api") ? "api" : prefEngine);
            const targetSessionID = engine === "deepseek_web"
              ? this.chat.documentSessionID("web")
              : (payload.sessionID || this.chat.documentSessionID());
            return this.chat.resend(context.documentID, targetSessionID, payload.messageID, {
              contextMode: payload.contextMode,
              selectedText: payload.selectedText,
              referenceQuotes: Array.isArray(payload.referenceQuotes) ? payload.referenceQuotes : [],
              responseLanguage: payload.responseLanguage,
              engine,
              aiMode: engine === "deepseek_web" ? "web" : "api",
              runtime
            }, emit, signal);
          });

        case "chat-edit-message": {
          const context = await this.attachmentContext(attachmentID);
          const session = await this.chat.loadSession(context.documentID, payload.sessionID);
          const message = session.messages.find(row => row.id === payload.messageID);
          if (message?.role === "user") {
            return this.withOperation(runtime, "chat", async (signal, emit) => {
              const prefEngine = U.getPref("chatEngine", DEFAULT_CHAT_ENGINE) === "deepseek_web" ? "deepseek_web" : "api";
              const engine = (payload.engine === "deepseek_web" || payload.aiMode === "web")
                ? "deepseek_web"
                : ((payload.engine === "api" || payload.aiMode === "api") ? "api" : prefEngine);
              const targetSessionID = engine === "deepseek_web"
                ? this.chat.documentSessionID("web")
                : (payload.sessionID || this.chat.documentSessionID());
              return this.chat.editMessage(context.documentID, targetSessionID, payload.messageID, payload.text, {
                contextMode: payload.contextMode,
                selectedText: payload.selectedText,
                referenceQuotes: Array.isArray(payload.referenceQuotes) ? payload.referenceQuotes : [],
                responseLanguage: payload.responseLanguage,
                engine,
                aiMode: engine === "deepseek_web" ? "web" : "api",
                runtime
              }, emit, signal);
            });
          }
          return this.chat.editMessage(
            context.documentID,
            payload.sessionID,
            payload.messageID,
            payload.text
          );
        }

        case "chat-delete-turn": {
          const context = await this.attachmentContext(attachmentID);
          return this.chat.deleteTurn(context.documentID, payload.sessionID, payload.messageID);
        }

        case "chat-add-document": {
          const filePath = await this.selectChatDocumentFile(runtime.window);
          if (!filePath) return { cancelled: true };
          return this.withOperation(runtime, "document", async (signal, emit) => {
            const context = await this.attachmentContext(attachmentID);
            const document = await this.chat.prepareDocument(context.documentID, filePath, {}, emit, signal);
            return { cancelled: false, document };
          });
        }

        case "chat-open-document": {
          const relativePath = String(payload.relativePath || "").replace(/\\/g, "/");
          if (!relativePath.startsWith("chat/documents/") || !safeChatRelativePath(relativePath)) {
            throw new Error("文档原始文件路径无效");
          }
          const context = await this.attachmentContext(attachmentID);
          const fullPath = this.storage.path(context.documentID, ...relativePath.split("/"));
          if (!await this.storage.exists(fullPath)) throw new Error("未找到这条消息对应的原始文档副本");
          this.openWithDefaultApplication(fullPath);
          return { opened: true };
        }

        case "provider-card-save":
          return this.saveProviderCard(payload);

        case "provider-card-get-api-key":
          return this.getProviderCardAPIKey(payload.cardID);

        case "provider-card-apply":
          return this.applyProviderCard(payload.cardID, payload.purpose);

        case "provider-card-delete":
          return this.deleteProviderCard(payload.cardID);

        case "chat-list": {
          const context = await this.attachmentContext(attachmentID);
          return this.chat.listSessions(context.documentID);
        }
        case "chat-load": {
          const context = await this.attachmentContext(attachmentID);
          return this.chat.loadSession(context.documentID, payload.sessionID);
        }
        case "chat-clear": {
          const context = await this.attachmentContext(attachmentID);
          return this.chat.clearSession(context.documentID, payload.sessionID);
        }

        case "get-settings":
          return this.getSettings();
        case "get-agent-status":
          return this.getAgentStatusSnapshot();
        case "get-agent-client-config":
          return this.getAgentClientConfig(payload.client);
        case "get-agent-bootstrap-instruction":
          return this.getAgentBootstrapInstruction(payload.client);
        case "get-startup-notice":
          return this.getStartupNotice();
        case "mark-startup-notice-seen":
          return this.markStartupNoticeSeen(payload.version);
        case "clipboard-read-text":
          return { text: this.readClipboardText() };
        case "clipboard-write-text":
          return this.writeClipboardText(payload.text);
        case "get-provider-api-key":
          return this.getProviderAPIKey(payload.provider);
        case "save-provider-api-key":
          return this.saveProviderAPIKey(payload.provider, payload.apiKey);
        case "save-mineru-token":
          return this.saveMinerUToken(payload.token);
        case "save-settings":
          return this.saveSettings(payload);
        case "check-for-updates":
          return this.checkForUpdates({ manual: true, runtime });
        case "apply-update":
          return this.applyUpdate(payload, null, runtime);
        case "dismiss-announcement":
          return { success: this.dismissAnnouncement(payload.id) };
        case "mark-all-announcements-read": {
          const history = this.getAnnouncementHistory();
          const ids = history.map(item => item?.id).filter(Boolean);
          const success = this.dismissAnnouncements(ids);
          return { success };
        }
        case "save-prompt-library":
          return this.savePromptLibrary(payload.library);
        case "list-models":
          return this.withOperation(runtime, "models", (signal) => this.listModels(payload, signal));
        case "probe-siliconflow-thinking":
          return this.withOperation(runtime, "models", (signal) => this.probeSiliconflowThinking(payload, signal));
        case "select-reference-files":
          return this.selectReferenceFiles(runtime.window, payload.paths);

        case "stop":
          this.stopOperations(runtime.tabID, String(payload.operation || ""));
          return { stopped: true };

        case "clear-translation": {
          if (this.activeOperationMap(runtime.tabID).size) throw new Error("请先停止当前任务，再清除译文缓存");
          const context = await this.attachmentContext(attachmentID);
          await this.pipeline.clearTranslation(context, payload.kind);
          return this.stateForAttachment(attachmentID);
        }

        case "clear-document": {
          if (this.activeOperationMap(runtime.tabID).size) throw new Error("请先停止当前任务，再清除文档缓存");
          const attachment = await this.resolveAttachment(attachmentID);
          const result = await this.clearStorageData({ target: "document", documentID: this.storage.documentID(attachment), category: "all" }, attachmentID);
          return result.nextState;
        }

        case "get-storage-summary":
          return this.getStorageSummary(attachmentID);

        case "open-storage-folder":
          return this.openStorageFolder(payload);

        case "clear-storage-data":
          return this.clearStorageData(payload, attachmentID);

        case "open-native-pdf":
          await Zotero.Reader.open(attachmentID);
          return { opened: true };

        case "open-preferences":
          this.openPreferences(runtime.window);
          return { opened: true };

        case "load-deepseek-web":
          runtime.aiMode = "web";
          return this.loadDeepSeekWeb(runtime, Boolean(payload.reload));

        case "deepseek-web-reference": {
          await this.loadDeepSeekWeb(runtime, false);
          const driver = this.ensureDeepSeekDriver(runtime);
          if (!driver) throw new Error("DeepSeek网页尚未就绪，请稍后重试。");
          if (payload.image) {
            const decoded = this.decodeImageDataURL(payload.image.dataURL, runtime.window);
            const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/bmp": "bmp", "image/jp2": "jp2", "image/svg+xml": "svg" }[decoded.mimeType];
            const name = `${U.safeStem(String(payload.image.name || "reference-image").replace(/\.(?:png|jpe?g|webp|gif|bmp|jp2|svg)$/i, ""), 100)}.${extension}`;
            try {
              await driver.attachFiles([{ name, type: decoded.mimeType, base64: U.encodeBytesBase64(decoded.bytes) }], null);
            } catch (error) {
              this.sendToPage(runtime, {
                type: "event",
                payload: { type: "toast", message: `图片未能添加到输入框（${error?.message || error}），已继续添加文本引用。`, level: "warning" }
              });
            }
          }
          const quote = payload.quote;
          const text = String(quote?.formulaTex || quote?.text || "").trim();
          const page = quote?.pageLabel || quote?.page;
          return driver.appendDraft(text ? `[${quote?.type === "formula" ? "公式引用" : "文献引用"}${page ? ` · 第 ${page} 页` : ""}]\n${text}` : "");
        }

        case "deepseek-web-add-paper-source":
          return this.addPaperSourceToAI(runtime);

        case "deepseek-web-add-paper-pages":
          return this.addPaperPagesToAI(runtime);

        case "deepseek-web-paste-clipboard":
          return this.pasteClipboardToAI(runtime);

        case "set-deepseek-web-bounds":
          return this.setDeepSeekWebBounds(runtime, payload);

        case "open-deepseek-context-menu":
          return this.openDeepSeekContextMenu(runtime, payload);

        case "save-chat-engine": {
          const engine = payload?.chatEngine === "deepseek_web" ? "deepseek_web" : "api";
          U.setPref("chatEngine", engine);
          runtime.aiMode = engine === "deepseek_web" ? "web" : "api";
          return { chatEngine: engine };
        }

        case "open-external-url":
          return this.openExternalURL(payload.url);

        case "open-token-guide":
          return this.openTokenGuide();

        case "open-feedback":
          return this.openFeedback();

        case "export-pdf":
          return this.withOperation(runtime, "export", async () => this.printWorkbenchPDF(runtime, payload));

        case "export-capabilities":
          return this.exportCapabilities(runtime);

        case "export-stream-markdown":
          return this.withOperation(runtime, "export", async () => this.exportStreamMarkdown(runtime, payload));

        case "export-original-file":
          return this.withOperation(runtime, "export", async () => this.exportOriginalFile(runtime, payload));

        case "export-document-images":
          return this.withOperation(runtime, "export", async () => this.exportDocumentImages(runtime, payload));

        case "export-layout-comparison-pdf":
          return this.withOperation(runtime, "export", async () => this.exportLayoutComparisonPDF(runtime, payload));

        case "export-pdf-pages":
          return this.withOperation(runtime, "export", (signal, emit) => this.exportPDFPages(runtime, payload, signal, emit));

        case "save-image":
          return this.saveImageData(runtime, payload);

        case "copy-image":
          return this.copyImageData(runtime, payload);

        case "dismiss-deepseek-web-cache-alert":
          this.storage.dismissDeepSeekWebCacheAlert(payload?.cooldownMs);
          return { success: true };

        default:
          throw new Error(`不支持的操作：${method}`);
      }
    }

    getSettings() {
      const translation = this.llm.getSettings("translation");
      // Keep the saved chat profile observable in both UI entry points. When
      // sharing is enabled, runtime chat requests still resolve to translation.
      const chat = this.llm.getStoredSettings("chat");
      const chatUsesTranslationModel = !U.isWebMachineProvider(translation.provider)
        && Boolean(U.getPref("chatUsesTranslationModel", true));
      let layoutReaderFonts = {};
      try {
        const raw = U.getPref("layoutReaderFonts", "{}");
        layoutReaderFonts = typeof raw === "string" ? JSON.parse(raw || "{}") : raw;
      }
      catch (_) {}
      if (!layoutReaderFonts || typeof layoutReaderFonts !== "object" || Array.isArray(layoutReaderFonts)) layoutReaderFonts = {};
      return {
        ...translation,
        translationProvider: translation.provider,
        translationBaseURL: translation.baseURL,
        translationModel: translation.model,
        translationThinkingMode: translation.thinkingMode,
        translationReasoningEffort: translation.reasoningEffort,
        translationProviderProfiles: translation.providerProfiles || {},
        chatProvider: chat.provider,
        chatBaseURL: chat.baseURL,
        chatModel: chat.model,
        chatThinkingMode: chat.thinkingMode,
        chatReasoningEffort: chat.reasoningEffort,
        chatUsesTranslationModel,
        chatEngine: U.getPref("chatEngine", DEFAULT_CHAT_ENGINE),
        translationShowReasoning: translation.showReasoning,
        chatShowReasoning: chat.showReasoning,
        translationReasoningPreferences: translation.reasoningPreferences,
        chatReasoningPreferences: chat.reasoningPreferences,
        chatProviderProfiles: chat.providerProfiles || {},
        keyPointsDefaultPrompt: LitMTrans.ChatInternals.DEFAULT_KEY_POINTS_PROMPT,
        effectiveKeyPointsPrompt: String(translation.keyPointsPrompt || LitMTrans.ChatInternals.DEFAULT_KEY_POINTS_PROMPT),
        clipboardTaskPrompts: Object.fromEntries(
          ["key_points", "paper_mindmap", "paper_logic_flow", "generic_mindmap", "generic_flowchart"]
            .map(taskType => [taskType, LitMTrans.ChatInternals.clipboardTaskPrompt(taskType, translation)])
        ),
        providerCards: this.providerCards(),
        apiKey: this.secrets.getLLMKey(translation.provider),
        chatAPIKey: this.secrets.getLLMKey(chat.provider),
        mineruToken: this.secrets.getMinerUToken(),
        cajDoubleClickAction: ["ask", "litmtrans"].includes(U.getPref("cajDoubleClickAction", "ask")) ? U.getPref("cajDoubleClickAction", "ask") : "default",
        showNativeReaderAskAI: Boolean(U.getPref("showNativeReaderAskAI", true)),
        autoUpdate: Boolean(U.getPref("autoUpdate", true)),
        availableUpdate: this.availableUpdate || null,
        announcements: this.getAnnouncementsForWorkbench(),
        agent: this.agent?.settingsSnapshot?.() || {
          enabled: Boolean(U.getPref("agentEnabled", true)),
          mode: String(U.getPref("agentAccessMode", "full") || "full"),
          allowConfiguredServices: Boolean(U.getPref("agentAllowConfiguredServices", true)),
          allowChatHistory: Boolean(U.getPref("agentAllowChatHistory", true)),
          backgroundProvider: String(U.getPref("agentBackgroundProvider", "auto") || "auto"),
          server: { running: false, url: "" }
        },
        layoutReaderFonts,
        promptLibrary: this.promptLibrary(),
        hasChatAPIKey: chat.hasAPIKey,
        providers: Object.values(LitMTrans.Constants.PROVIDERS).map(spec => ({
          id: spec.id,
          name: spec.name,
          defaultBaseURL: spec.defaultBaseURL,
          defaultModel: spec.defaultModel,
          chatDefaultModel: "",
          supportsImages: spec.supportsImages !== false,
          supportsChat: spec.supportsChat !== false && !U.isWebMachineProvider(spec.id),
          webDriver: spec.webDriver === true
        }))
      };
    }

    async getAgentClientConfig(client) {
      if (!this.agent?.facade) throw new Error("LitMTrans智能体尚未初始化");
      if (!this.agent?.server?.socket && Boolean(U.getPref("agentEnabled", true))) {
        try { await this.agent?.applySettings?.(); } catch (_) {}
      }
      return this.agent.facade.invoke("get_client_config", { client });
    }

    async getAgentStatusSnapshot() {
      return this.agent?.settingsSnapshot?.() || {
        enabled: Boolean(U.getPref("agentEnabled", true)),
        mode: String(U.getPref("agentAccessMode", "full") || "full"),
        server: { running: false, url: "" },
        connection: { connected: false, clientName: "", clients: [] }
      };
    }

    async getAgentBootstrapInstruction(_client = "") {
      let snapshot = this.agent?.settingsSnapshot?.() || {};
      let endpoint = String(snapshot.server?.url || "").trim();
      if (!endpoint && Boolean(U.getPref("agentEnabled", true))) {
        try {
          await this.agent?.applySettings?.();
          snapshot = this.agent?.settingsSnapshot?.() || {};
          endpoint = String(snapshot.server?.url || "").trim();
        } catch (_) {}
      }
      if (!endpoint) return { ready: false, endpoint: "", instruction: "请先启用智能体连接，等待服务准备好后再复制。" };
      const tools = this.agent?.facade?.visibleTools?.() || [];
      return {
        ready: true,
        endpoint,
        serverName: "zotero-litmtrans",
        instruction: LitMTrans.Agent.buildAgentBootstrapInstruction(endpoint, "zotero-litmtrans", { toolCount: tools.length })
      };
    }

    savePromptLibrary(library) {
      const rows = (Array.isArray(library) ? library : []).map(item => ({
        id: String(item?.id || "").replace(/[^A-Za-z0-9_-]+/g, "") || U.randomID("prompt"),
        title: String(item?.title || "").trim().slice(0, 80),
        content: String(item?.content || "")
      })).filter(item => item.id && (item.title || item.content));
      U.setPref("promptLibrary", JSON.stringify(rows));
      U.setPref("promptLibraryInitialized", true);
      return this.promptLibrary();
    }

    promptLibrary() {
      const isInitialized = Boolean(U.getPref("promptLibraryInitialized", false));
      if (!isInitialized) {
        const rawExisting = U.getPref("promptLibrary", null);
        if (rawExisting === null) {
          const defaults = (LitMTrans.Constants.DEFAULT_PROMPT_LIBRARY || []).map(item => ({ ...item }));
          U.setPref("promptLibrary", JSON.stringify(defaults));
          U.setPref("promptLibraryInitialized", true);
          return defaults;
        }
        U.setPref("promptLibraryInitialized", true);
      }
      let rows = [];
      try {
        const raw = U.getPref("promptLibrary", "[]");
        rows = Array.isArray(raw) ? raw : JSON.parse(String(raw || "[]"));
      }
      catch (_) {}
      if (!Array.isArray(rows)) rows = [];
      return rows.map(item => ({
        id: String(item?.id || ""),
        title: String(item?.title || "").trim().slice(0, 80),
        content: String(item?.content || "")
      })).filter(item => item.id && (item.title || item.content));
    }

    getProviderAPIKey(providerID) {
      const provider = U.providerSpec(String(providerID || "oneapi")).id;
      return {
        provider,
        apiKey: this.secrets.getLLMKey(provider),
        hasAPIKey: this.secrets.has(this.secrets.llmKeyName(provider))
      };
    }

    saveProviderAPIKey(providerID, value) {
      const provider = U.providerSpec(String(providerID || "oneapi")).id;
      const apiKey = String(value || "").trim();
      if (apiKey) this.secrets.setLLMKey(provider, apiKey);
      else this.secrets.removeLLMKey(provider);
      return { provider, hasAPIKey: Boolean(apiKey) };
    }

    saveMinerUToken(value) {
      const token = String(value || "").trim();
      if (token) this.secrets.setMinerUToken(token);
      else this.secrets.removeMinerUToken();
      return { hasToken: Boolean(token) };
    }

    providerCards() {
      let rows = [];
      try {
        const raw = U.getPref("providerCards", "[]");
        rows = Array.isArray(raw) ? raw : JSON.parse(String(raw || "[]"));
      }
      catch (_) {}
      return (Array.isArray(rows) ? rows : []).map(card => ({
        id: String(card?.id || "").replace(/[^A-Za-z0-9_-]+/g, ""),
        name: String(card?.name || "").trim().slice(0, 80),
        provider: String(card?.provider || "oneapi").toLowerCase(),
        baseURL: String(card?.baseURL || "").trim(),
        hasAPIKey: this.secrets.has(`provider-card:${String(card?.id || "").replace(/[^A-Za-z0-9_-]+/g, "")}`)
      })).filter(card => card.id && card.name);
    }

    writeProviderCards(cards) {
      const rows = (Array.isArray(cards) ? cards : []).map(card => ({
        id: card.id,
        name: card.name,
        provider: card.provider,
        baseURL: card.baseURL
      }));
      U.setPref("providerCards", JSON.stringify(rows));
      return this.providerCards();
    }

    getProviderCardAPIKey(cardID) {
      const card = this.providerCards().find(item => item.id === String(cardID || ""));
      if (!card) throw new Error("未找到这张记忆卡片");
      const apiKey = this.secrets.get(`provider-card:${card.id}`);
      return { cardID: card.id, apiKey, hasAPIKey: Boolean(apiKey) };
    }

    saveProviderCard(values = {}) {
      const name = String(values.name || "").trim().slice(0, 80);
      if (!name) throw new Error("请填写记忆卡片名称");
      const cards = this.providerCards();
      const requestedID = String(values.cardID || "").replace(/[^A-Za-z0-9_-]+/g, "");
      let card = cards.find(item => item.id === requestedID)
        || cards.find(item => item.name.trim().toLowerCase() === name.toLowerCase());
      if (!card) {
        card = {
          id: U.randomID("provider-card").replace(/[^A-Za-z0-9_-]+/g, ""),
          name,
          provider: "oneapi",
          baseURL: "",
          hasAPIKey: false
        };
        cards.push(card);
      }
      card.name = name;
      card.provider = String(values.provider || card.provider || "oneapi").toLowerCase();
      card.baseURL = U.normalizeBaseURL(values.baseURL || card.baseURL, card.provider);
      if (typeof values.apiKey === "string") {
        const apiKey = values.apiKey.trim();
        if (apiKey) this.secrets.set(`provider-card:${card.id}`, apiKey);
        else this.secrets.remove(`provider-card:${card.id}`);
      }
      const saved = this.writeProviderCards(cards).find(item => item.id === card.id);
      return { card: saved, cards: this.providerCards() };
    }

    applyProviderCard(cardID, requestedPurpose = "chat") {
      const card = this.providerCards().find(item => item.id === String(cardID || ""));
      if (!card) throw new Error("未找到这张记忆卡片");
      const apiKey = this.secrets.get(`provider-card:${card.id}`);
      // Provider cards are shared reusable connection profiles.  Keep the
      // model selection purpose-specific: a card changes only the model
      // settings panel from which it was applied.
      const purpose = requestedPurpose === "translation" ? "translation" : "chat";
      const current = this.llm.getSettings(purpose);
      if (purpose === "translation") {
        // Route translation-card changes through the controller policy so a
        // web-machine -> LLM transition also restores shared chat settings.
        this.saveSettings({
          translationProvider: card.provider,
          translationBaseURL: card.baseURL,
          translationModel: current.providerProfiles?.[card.provider]?.model ?? "",
          translationThinkingMode: current.thinkingMode,
          translationReasoningEffort: current.reasoningEffort,
          translationProviderProfiles: current.providerProfiles,
          apiKey
        });
      }
      else {
        this.llm.saveSettings({
          purpose,
          provider: card.provider,
          baseURL: card.baseURL,
          model: current.providerProfiles?.[card.provider]?.model ?? "",
          apiKey
        }, purpose);
      }
      return { card, purpose, settings: this.getSettings() };
    }

    deleteProviderCard(cardID) {
      const id = String(cardID || "");
      const cards = this.providerCards();
      const card = cards.find(item => item.id === id);
      if (!card) throw new Error("未找到这张记忆卡片");
      this.secrets.remove(`provider-card:${id}`);
      return { deleted: card, cards: this.writeProviderCards(cards.filter(item => item.id !== id)) };
    }

    saveSettings(values = {}) {
      const requestedTranslationProvider = values?.translationProvider
        ?? values?.provider
        ?? this.llm.getSettings("translation").provider;
      const currentTranslation = this.llm.getSettings("translation");
      const currentChat = this.llm.getStoredSettings("chat");
      const nextTranslationProvider = U.providerSpec(requestedTranslationProvider).id;
      const wasWebMachine = U.isWebMachineProvider(currentTranslation.provider);
      const isWebMachine = U.isWebMachineProvider(nextTranslationProvider);
      let shareChatModel = Object.prototype.hasOwnProperty.call(values || {}, "chatUsesTranslationModel")
        ? values.chatUsesTranslationModel === true
        : Boolean(U.getPref("chatUsesTranslationModel", true));
      // Web machine translation cannot be a chat backend.  Leaving the old
      // default sharing flag untouched would make chat resolve the empty
      // machine-translation endpoint and fail before the first request.
      if (isWebMachine) shareChatModel = false;
      // Returning from web translation is an explicit mode transition: the
      // translation model becomes the authoritative chat model again.
      else if (wasWebMachine && !isWebMachine) shareChatModel = true;
      U.setPref("chatUsesTranslationModel", shareChatModel);
      if (Object.prototype.hasOwnProperty.call(values || {}, "chatEngine")) {
        U.setPref("chatEngine", values.chatEngine === "deepseek_web" ? "deepseek_web" : "api");
      }
      if (Object.prototype.hasOwnProperty.call(values || {}, "webInputMode")) {
        U.setPref("webInputMode", values.webInputMode === "clipboard" ? "clipboard" : "auto");
      }
      if (Object.prototype.hasOwnProperty.call(values || {}, "cajDoubleClickAction")) {
        U.setPref("cajDoubleClickAction", ["ask", "litmtrans"].includes(values.cajDoubleClickAction) ? values.cajDoubleClickAction : "default");
      }
      if (Object.prototype.hasOwnProperty.call(values || {}, "showNativeReaderAskAI")) {
        U.setPref("showNativeReaderAskAI", values.showNativeReaderAskAI === true);
      }
      if (Object.prototype.hasOwnProperty.call(values || {}, "autoUpdate")) {
        U.setPref("autoUpdate", values.autoUpdate === true);
      }
      if (Object.prototype.hasOwnProperty.call(values || {}, "agentEnabled")) {
        U.setPref("agentEnabled", values.agentEnabled === true);
      }
      if (Object.prototype.hasOwnProperty.call(values || {}, "agentAccessMode")) {
        const mode = ["read", "full", "developer"].includes(String(values.agentAccessMode)) ? String(values.agentAccessMode) : "full";
        U.setPref("agentAccessMode", mode);
      }
      if (Object.prototype.hasOwnProperty.call(values || {}, "agentAllowConfiguredServices")) {
        U.setPref("agentAllowConfiguredServices", values.agentAllowConfiguredServices === true);
      }
      if (Object.prototype.hasOwnProperty.call(values || {}, "agentAllowChatHistory")) {
        U.setPref("agentAllowChatHistory", values.agentAllowChatHistory === true);
      }
      if (Object.prototype.hasOwnProperty.call(values || {}, "agentBackgroundProvider")) {
        const provider = String(values.agentBackgroundProvider || "auto").trim().toLowerCase();
        const allowed = new Set(["auto", "deepseek", "oneapi", "openai_compatible", "gemini", "siliconflow", "zai", "openrouter"]);
        U.setPref("agentBackgroundProvider", allowed.has(provider) ? provider : "auto");
      }
      if (Object.prototype.hasOwnProperty.call(values || {}, "agentPort")) {
        const port = Math.max(0, Math.min(65535, Number(values.agentPort) || 0));
        U.setPref("agentPort", port);
      }
      if (values && values.layoutReaderFonts && typeof values.layoutReaderFonts === "object" && !Array.isArray(values.layoutReaderFonts)) {
        const fonts = {};
        for (const [documentID, value] of Object.entries(values.layoutReaderFonts)) {
          const id = String(documentID || "").trim();
          const font = Number(value);
          if (id && Number.isFinite(font) && font > 0) fonts[id] = font;
        }
        U.setPref("layoutReaderFonts", JSON.stringify(fonts));
      }
      const translationValues = {
        ...values,
        purpose: "translation",
        provider: values.translationProvider ?? values.provider,
        baseURL: values.translationBaseURL ?? values.baseURL,
        model: values.translationModel ?? values.model,
        thinkingMode: values.translationThinkingMode ?? values.thinkingMode,
        reasoningEffort: values.translationReasoningEffort ?? values.reasoningEffort,
        showReasoning: values.translationShowReasoning ?? values.showReasoning
      };
      const translation = this.llm.saveSettings(translationValues, "translation");
      const hasChatValues = [
        "chatProvider", "chatBaseURL", "chatModel", "chatThinkingMode",
        "chatReasoningEffort", "chatProviderProfiles", "chatAPIKey", "clearChatAPIKey",
        "chatShowReasoning", "chatReasoningPreferences"
      ].some(key => Object.prototype.hasOwnProperty.call(values, key));
      const requestedChatProvider = U.providerSpec(values?.chatProvider ?? currentChat.provider).id;
      const currentChatProvider = U.providerSpec(currentChat.provider).id;
      const useCurrentChatFallback = U.isWebMachineProvider(requestedChatProvider);
      const chatProvider = useCurrentChatFallback
        ? (U.isWebMachineProvider(currentChatProvider) ? "oneapi" : currentChatProvider)
        : requestedChatProvider;
      const chatProfileSource = useCurrentChatFallback
        ? (currentChat.providerProfiles || {})
        : (values.chatProviderProfiles || currentChat.providerProfiles || {});
      const chatProfile = chatProfileSource[chatProvider] || {};
      const shouldPersistChat = shareChatModel
        || hasChatValues
        || isWebMachine
        || (wasWebMachine && !isWebMachine);
      if (shouldPersistChat) {
        // Always retain two profiles. In shared mode, copy the newly saved
        // translation profile into chat; in independent mode, retain the chat
        // profile provided by the form. Disabling sharing therefore restores
        // the last independently saved chat configuration instead of cloning
        // the translation form at toggle time.
        const chatValues = shareChatModel ? {
          purpose: "chat",
          provider: translation.provider,
          baseURL: translation.baseURL,
          model: translation.model,
          thinkingMode: translation.thinkingMode,
          reasoningEffort: translation.reasoningEffort,
          showReasoning: translation.showReasoning,
          providerProfiles: translation.providerProfiles,
          apiKey: this.secrets.getLLMKey(translation.provider),
          chatUsesTranslationModel: true,
          webInputMode: values.webInputMode ?? translation.webInputMode
        } : {
          purpose: "chat",
          provider: chatProvider,
          baseURL: useCurrentChatFallback ? currentChat.baseURL : (values.chatBaseURL ?? currentChat.baseURL ?? chatProfile.baseURL),
          model: useCurrentChatFallback ? currentChat.model : (values.chatModel ?? currentChat.model ?? chatProfile.model),
          thinkingMode: useCurrentChatFallback ? currentChat.thinkingMode : (values.chatThinkingMode ?? currentChat.thinkingMode ?? chatProfile.thinkingMode),
          reasoningEffort: useCurrentChatFallback ? currentChat.reasoningEffort : (values.chatReasoningEffort ?? currentChat.reasoningEffort ?? chatProfile.reasoningEffort),
          showReasoning: useCurrentChatFallback ? currentChat.showReasoning : (values.chatShowReasoning ?? currentChat.showReasoning),
          reasoningPreferences: values.chatReasoningPreferences,
          providerProfiles: chatProfileSource,
          apiKey: useCurrentChatFallback ? this.secrets.getLLMKey(chatProvider) : values.chatAPIKey,
          clearAPIKey: values.clearChatAPIKey,
          chatUsesTranslationModel: false,
          webInputMode: values.webInputMode ?? translation.webInputMode
        };
        this.llm.saveSettings(chatValues, "chat");
      }
      void this.agent?.applySettings?.();
      return {
        ...translation,
        ...this.getSettings(),
        providers: Object.values(LitMTrans.Constants.PROVIDERS).map(spec => ({
          id: spec.id,
          name: spec.name,
          defaultBaseURL: spec.defaultBaseURL,
          defaultModel: spec.defaultModel,
          chatDefaultModel: "",
          supportsImages: spec.supportsImages !== false,
          supportsChat: spec.supportsChat !== false && !U.isWebMachineProvider(spec.id),
          webDriver: spec.webDriver === true
        }))
      };
    }

    listModels(values = {}, signal = null) {
      return this.llm.listModels({
        ...values,
        details: values.purpose !== "chat"
      }, signal);
    }

    probeSiliconflowThinking(values = {}, signal = null) {
      return this.llm.probeSiliconflowThinking(values, signal);
    }

    openPreferences(win = null) {
      const target = win || Zotero.getMainWindow?.() || Services.wm.getMostRecentWindow("navigator:browser");
      try {
        if (target?.ZoteroPane?.openPreferences) {
          target.ZoteroPane.openPreferences("litmtrans-preferences");
          return;
        }
      }
      catch (_) {}
      target?.openDialog?.("chrome://zotero/content/preferences/preferences.xhtml", "zotero-prefs", "chrome,titlebar,toolbar,centerscreen,resizable", "litmtrans-preferences");
    }

    async getStorageSummary(currentAttachmentID = null) {
      const summary = await this.storage.getStorageSummary();
      let currentDocumentID = "";
      if (currentAttachmentID) {
        try {
          const item = await Zotero.Items.getAsync(currentAttachmentID);
          if (item) currentDocumentID = this.storage.documentID(item);
        } catch (_) {}
      }
      return { ...summary, currentDocumentID };
    }

    openStorageFolder(payload = {}) {
      let targetPath = this.storage.root;
      if (payload?.kind === "temp") {
        targetPath = this.storage.tempRoot;
      } else if (payload?.kind === "edge") {
        targetPath = PathUtils.join(this.storage.root, "edge-local-translation");
      } else if (payload?.kind === "runtime") {
        targetPath = PathUtils.join(this.storage.root, "runtime");
      } else if (payload?.kind === "documentsRoot") {
        targetPath = this.storage.documentsRoot;
      } else if (payload?.kind === "document" && payload?.documentID) {
        targetPath = this.storage.documentDir(payload.documentID);
      } else if (payload?.kind === "subcategory" && payload?.documentID) {
        const docDir = this.storage.documentDir(payload.documentID);
        const subMap = {
          images: "images",
          assets: "assets",
          translation: "translation",
          cajSource: "caj-source",
          mineruResult: "mineru-result",
          chat: "chat",
          deepseekWeb: "deepseek-web",
          diagrams: "diagrams",
          logs: "logs"
        };
        const sub = subMap[payload?.subcategory];
        if (sub) {
          targetPath = PathUtils.join(docDir, sub);
        } else {
          targetPath = docDir;
        }
      } else if (payload?.path) {
        targetPath = payload.path;
      }
      const opened = this.storage.openFolder(targetPath);
      return { opened };
    }

    async clearStorageData(payload = {}, currentAttachmentID = null) {
      const target = String(payload?.target || "");
      if (target === "temp") {
        const res = await this.storage.clearTempFiles();
        return { success: true, ...res };
      }
      if (target === "edge") {
        const res = await this.storage.clearEdgeLocalFiles();
        return { success: true, ...res };
      }
      if (target === "runtime-cache") {
        const res = await this.storage.clearRuntimeCache();
        return { success: true, ...res };
      }
      if (target === "runtime") {
        try {
          if (this.agent?.facade?.acquisition) {
            await this.agent.facade.acquisition.shutdown();
          }
        } catch (_) {}
        const res = await this.storage.clearRuntime();
        try {
          const runtime = this.agent?.facade?.acquisition?.runtime;
          if (runtime) {
            runtime.invalidateHealth?.("runtime-deleted");
            if (runtime.state && typeof runtime.state === "object") {
              runtime.state.status = "uninstalled";
              runtime.state.version = "";
              runtime.state.executable = "";
              runtime.state.healthResult = null;
              runtime.state.healthCheckedAt = 0;
              runtime.state.lastHealthCheck = "";
            }
          }
        } catch (_) {}
        return { success: true, ...res };
      }
      if (target === "orphaned") {
        const summary = await this.storage.getStorageSummary();
        let readerAttachmentsRemoved = 0;
        let clearedBytes = 0;
        const clearedDocumentIDs = [];
        for (const document of summary.documents || []) {
          if (!document.isOrphan) continue;
          const result = await this.clearStorageData({ target: "document", documentID: document.id, category: "all" });
          if (result.readerAttachmentRemoved) readerAttachmentsRemoved++;
          clearedBytes += Number(result.clearedBytes || 0);
          if (result.cleared) clearedDocumentIDs.push(document.id);
        }
        return { success: true, clearedBytes, clearedCount: clearedDocumentIDs.length,
          clearedDocumentIDs, formatted: this.storage.formatBytes(clearedBytes), readerAttachmentsRemoved };
      }
      if (target === "document") {
        const docID = String(payload?.documentID || "");
        if (!docID) throw new Error("未指定要清理的文献ID");
        const subcategory = String(payload?.category || "all");

        // 安全互斥检测：若任何标签页正在对该文献进行操作，则禁止清除
        for (const [tabID, opMap] of this.operations.entries()) {
          if (opMap && opMap.size > 0) {
            const tabAttachment = this.tabs.get(tabID)?.attachmentID;
            if (tabAttachment) {
              const tabItem = await Zotero.Items.getAsync(tabAttachment).catch(() => null);
              if (tabItem && this.storage.documentID(tabItem) === docID) {
                throw new Error("该文献当前有任务正在运行，请先停止后再清理缓存");
              }
            }
          }
        }

        let readerAttachmentRemoved = false;
        if (subcategory === "all" || subcategory === "cajSource") {
          if (this._cajConversions?.has(docID) || this._cajReaderAttachments?.has(docID)) {
            throw new Error("正在准备 CAJ 阅读缓存，请稍后再清理");
          }
          for (const runtime of this.tabs.values()) {
            const item = Zotero.Items.get(runtime.attachmentID);
            if (!item || this.storage.documentID(item) !== docID || !this.hasCAJAttachment(item)) continue;
            if (runtime.pdfPreviewInitializationTasks?.size) throw new Error("阅读器正在加载，请稍后再清理");
          }
          const result = await this.removeCAJReaderAttachment(docID, { required: true });
          readerAttachmentRemoved = Boolean(result.removed);
          for (const runtime of this.tabs.values()) {
            const item = Zotero.Items.get(runtime.attachmentID);
            if (!item || this.storage.documentID(item) !== docID || !this.hasCAJAttachment(item)) continue;
            try { runtime.pdfPreviewCleanup?.(); } catch (_) {}
            try { runtime.pdfPreview?.uninit?.(); } catch (_) {}
            runtime.pdfPreview = null;
            runtime.pdfPreviewAttachmentID = null;
            this.emit(runtime, { type: "caj-cache-cleared" });
          }
        }
        const clearResult = await this.storage.clearDocumentSubcategory(docID, subcategory);
        if (subcategory === "cajSource" && clearResult.cleared) {
          await this.storage.setDocumentMeta(docID, {
            isCAJ: true,
            cajCacheValidated: false,
            cajPageCount: 0,
            cajFormat: ""
          });
        }

        let isCurrentDoc = false;
        if (currentAttachmentID) {
          try {
            const currentItem = await Zotero.Items.getAsync(currentAttachmentID);
            if (currentItem && this.storage.documentID(currentItem) === docID) {
              isCurrentDoc = true;
            }
          } catch (_) {}
        }

        let nextState = null;
        let isCurrentCAJ = false;
        if (isCurrentDoc) {
          try {
            const currentItem = await Zotero.Items.getAsync(currentAttachmentID);
            isCurrentCAJ = Boolean(currentItem && this.hasCAJAttachment(currentItem));
          }
          catch (_) {}
        }
        if (isCurrentDoc && (subcategory === "all" || subcategory === "translation")) {
          nextState = await this.stateForAttachment(currentAttachmentID, !(isCurrentCAJ && subcategory === "all"));
        }
        return {
          success: true,
          ...clearResult,
          isCurrentDoc,
          isCurrentCAJ,
          readerAttachmentRemoved,
          nextState
        };
      }
      throw new Error(`未知的清理目标: ${target}`);
    }
  }

  LitMTrans.createController = options => new Controller(options);
  LitMTrans.Controller = Controller;
  LitMTrans.ControllerInternals = { compiledEvidenceMatches, quoteCoverageScore, findEvidenceSegmentRanges, pdfTextHighlightRects };
})(this);
