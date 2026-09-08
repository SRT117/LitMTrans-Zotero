(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const U = LitMTrans.Utils;

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
      this.tabs = new Map();
      this.operations = new Map();
      this.readerHandlers = [];
      this.itemPaneSectionID = null;
      this.itemNotifierID = null;
      this.diagnosticTimer = null;
      this.diagnosticBusy = false;
      this._initialized = false;
    }

    log(message) {
      if (U.getPref("debug", false)) Zotero.debug(`[LitMTrans] ${message}`);
    }

    async init() {
      if (this._initialized) return;
      await this.storage.init();
      this.registerItemDeletionObserver();
      // Item-pane section labels are resolved in the shared Zotero window.
      // Insert the plugin Fluent resource before registering that section.
      const enumerator = Services.wm.getEnumerator("navigator:browser");
      while (enumerator.hasMoreElements()) this.ensureWindowLocalization(enumerator.getNext());
      this.registerReaderIntegrations();
      this.registerItemPaneSection();
      await this.startDeveloperDiagnostics();
      this._initialized = true;
    }

    async shutdown() {
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
      this.operations.clear();
      if (this.diagnosticTimer) {
        clearInterval(this.diagnosticTimer);
        this.diagnosticTimer = null;
      }
      await this.webMachine?.shutdown?.();
      this.storage.shutdown();
      this._initialized = false;
    }

    registerItemDeletionObserver() {
      if (this.itemNotifierID !== null || typeof Zotero.Notifier?.registerObserver !== "function") return false;
      const observer = {
        notify: (event, type, ids) => {
          // A normal Zotero delete first moves an item to the trash; `delete`
          // is emitted when it is later erased permanently. Both must clear
          // this plugin's independently stored document data.
          if (!["trash", "delete"].includes(event) || type !== "item") return;
          void this.clearCachesForDeletedItems(ids).catch(error => Zotero.logError(error));
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

    async clearCachesForDeletedItems(itemIDs) {
      const deleted = new Set((Array.isArray(itemIDs) ? itemIDs : [itemIDs])
        .map(value => Number(value))
        .filter(Number.isFinite));
      if (!deleted.size) return [];
      for (const itemID of deleted) {
        this.stopOperations(this.tabIDForAttachment(itemID));
        this.cleanupTab(this.tabIDForAttachment(itemID));
      }
      const cleared = await this.storage.clearDocumentsForDeletedItemIDs([...deleted]);
      if (cleared.length) this.log(`Cleared ${cleared.length} document cache(s) for deleted Zotero item(s)`);
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
      throw new Error(`不支持的检查操作：${operation}`);
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
        this.llm.resolveConfig({ purpose: "chat" })
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
        this.llm.resolveConfig({ purpose: "chat" })
      );
      if (!config.apiKey) throw new Error("隔离测试 profile 尚未配置聊天API密钥");
      const request = this.diagnosticPayloadSummary(config, messages);
      if (Number(request.imageCount || 0) !== 1) {
        throw new Error("图片请求内容不符合预期");
      }
      const startedAt = Date.now();
      const response = await this.llm.complete(messages, {
        purpose: "chat",
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
        this.llm.resolveConfig({ purpose: "chat" })
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

      try {
        const itemMenu = doc.getElementById("zotero-itemmenu");
        if (itemMenu && !doc.getElementById("litmtrans-item-menuitem")) {
          const menuItem = doc.createXULElement("menuitem");
          menuItem.id = "litmtrans-item-menuitem";
          menuItem.setAttribute("label", localize("LitMTrans：解析、翻译与阅读", "LitMTrans: Parse, Translate, and Read"));
          menuItem.setAttribute("class", "menuitem-iconic");
          menuItem.setAttribute("image", this.rootURI + "assets/icon.ico");
          menuItem.addEventListener("command", () => this.openFromCurrentSelection(win));
          itemMenu.appendChild(menuItem);
          const refresh = () => {
            const selected = win.ZoteroPane?.getSelectedItems?.() || [];
            menuItem.hidden = !selected.some(item => this.itemCouldHaveAttachment(item));
          };
          itemMenu.addEventListener("popupshowing", refresh);
          menuItem._litmtransRefresh = refresh;
        }
      }
      catch (error) { Zotero.logError(error); }
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
        const item = doc.getElementById("litmtrans-item-menuitem");
        if (item?._litmtransRefresh) doc.getElementById("zotero-itemmenu")?.removeEventListener("popupshowing", item._litmtransRefresh);
        item?.remove();
      }
      catch (_) {}
      for (const [tabID, runtime] of [...this.tabs]) {
        if (runtime.window === win) this.cleanupTab(tabID);
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
      return this.resolveAttachment(items[0]);
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

    decodeImageDataURL(dataURL, win = null) {
      const match = String(dataURL || "").match(/^data:(image\/(?:png|jpeg|webp|gif|bmp|jp2|svg\+xml));base64,([A-Za-z0-9+/=\s]+)$/i);
      if (!match) throw new Error("图片数据格式无效");
      const decoder = win?.atob?.bind(win) || globalThis.atob?.bind(globalThis);
      if (!decoder) throw new Error("当前Zotero环境不能解码图片数据");
      const binary = decoder(match[2].replace(/\s+/g, ""));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      return { mimeType: String(match[1]).toLowerCase(), bytes };
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
      const imageTools = Cc["@mozilla.org/image/tools;1"].getService(Ci.imgITools);
      const buffer = decoded.bytes.buffer.slice(
        decoded.bytes.byteOffset,
        decoded.bytes.byteOffset + decoded.bytes.byteLength
      );
      const image = imageTools.decodeImageFromArrayBuffer(buffer, decoded.mimeType);
      const transferable = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
      transferable.init(null);
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
        return this.openWorkbench(attachment, { window: win });
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
            },
            prompt: localize("请解释这段内容，并说明它在全文中的作用。", "Explain this passage and its role in the document.")
          });
        });
        append(button);
      });

      register("createViewContextMenu", event => {
        const itemID = this.readerItemID(event.reader, event.params);
        if (!itemID) return;
        event.append({
          label: localize("在LitMTrans中打开", "Open in LitMTrans"),
          onCommand: () => this.openWorkbenchSafely(itemID, { window: event.reader?._window || Zotero.getMainWindow?.() })
        });
      });
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
                const parsed = await this.mineru.loadParsed(documentID);
                const stream = await this.translation.load(documentID);
                const layout = await this.layout.loadTranslations(documentID);
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
      const attachment = await this.resolveAttachment(itemOrID);
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
      const browser = win.document.createXULElement("browser");
      browser.setAttribute("flex", "1");
      browser.setAttribute("type", "content");
      browser.setAttribute("transparent", "true");
      browser.setAttribute("maychangeremoteness", "true");
      browser.style.width = "100%";
      browser.style.height = "100%";
      browser.style.minHeight = "100%";
      container.appendChild(browser);

      const runtime = {
        tabID,
        attachmentID: attachment.id,
        window: win,
        container,
        browser,
        bridgeInstalled: false,
        pendingOpen: { quote: options.quote || null, prompt: String(options.prompt || "") }
      };
      this.tabs.set(tabID, runtime);
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
      try { runtime.pdfPreviewCleanup?.(); } catch (_) {}
      try { runtime.pdfPreview?.uninit?.(); } catch (_) {}
      try { runtime.browser?.remove(); } catch (_) {}
      this.tabs.delete(tabID);
    }

    installBridge(runtime) {
      const contentWindow = runtime.browser?.contentWindow;
      if (!contentWindow) return;
      const target = contentWindow.wrappedJSObject || contentWindow;
      const hostCall = (method, payloadJSON, requestID) => {
        let payload = {};
        try { payload = payloadJSON ? JSON.parse(String(payloadJSON)) : {}; }
        catch (_) {}
        void this.handleBridgeCall(runtime, String(method || ""), payload, String(requestID || ""));
      };
      try {
        Cu.exportFunction(hostCall, target, { defineAs: "__LitMTrans_HOST_CALL__", allowCrossOriginArguments: true });
      }
      catch (_) {
        try { target.__LitMTrans_HOST_CALL__ = hostCall; } catch (error) { Zotero.logError(error); }
      }
      runtime.bridgeInstalled = true;
      this.sendToPage(runtime, { type: "host-ready", payload: { version: this.version } });
      if (runtime.pendingOpen?.quote || runtime.pendingOpen?.prompt) {
        this.sendToPage(runtime, { type: "open-context", payload: runtime.pendingOpen });
      }
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
      map.get(key)?.abort("已由新的操作替代");
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
      this.emit(runtime, { type: "operation", operation: key, running: false });
    }

    stopOperations(tabID, key = "") {
      const map = this.operations.get(tabID);
      if (!map) return;
      const runtime = this.tabs.get(tabID);
      if (key) {
        const controller = map.get(key);
        if (controller) controller.abort("用户已停止操作");
        map.delete(key);
        if (runtime) this.emit(runtime, { type: "operation", operation: key, running: false });
      }
      else {
        for (const [operation, controller] of map.entries()) {
          controller.abort("用户已停止操作");
          if (runtime) this.emit(runtime, { type: "operation", operation, running: false });
        }
        map.clear();
      }
      if (!map.size) this.operations.delete(tabID);
    }

    async withOperation(runtime, key, task) {
      const controller = this.beginOperation(runtime, key);
      try {
        return await task(controller.signal, event => this.emit(runtime, event));
      }
      finally {
        this.finishOperation(runtime, key, controller);
      }
    }

    async attachmentContext(attachmentID) {
      const attachment = await this.resolveAttachment(attachmentID);
      const filePath = await this.attachmentPath(attachment);
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
        const pdf = await PDFLib.PDFDocument.load(await this.storage.readBytes(context.filePath), {
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

    async stateForAttachment(attachmentID) {
      const context = await this.attachmentContext(attachmentID);
      const snapshot = await this.pipeline.snapshot(context);
      const contentType = String(context.attachment.attachmentContentType || "").toLowerCase();
      const documentMeta = await this.storage.getDocumentMeta(context.documentID);
      const readerMode = documentMeta?.readerMode === "stream" ? "stream" : "layout";
      return {
        pluginVersion: this.version,
        item: {
          attachmentID: context.attachment.id,
          parentItemID: context.parent?.id || null,
          title: context.title,
          attachmentTitle: String(context.attachment.getField?.("title") || context.attachment.attachmentFilename || ""),
          fileName: String(context.attachment.attachmentFilename || PathUtils.filename(context.filePath)),
          contentType,
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
          return { operations: [...this.activeOperationMap(runtime.tabID).keys()] };

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

        case "initialize-pdf-preview": {
          const attachment = await this.resolveAttachment(attachmentID);
          if (!attachment.isPDFAttachment?.()) return { available: false };
          if (runtime.pdfPreview) return { available: true };
          const frame = runtime.browser?.contentDocument?.getElementById("source-pdf");
          if (!frame) throw new Error("PDF阅读器尚未准备好，请稍后重试");
          await new Promise((resolve, reject) => {
            const onLoad = () => resolve();
            frame.addEventListener("load", onLoad, { once: true });
            try { frame.setAttribute("src", "resource://zotero/reader/reader.html"); }
            catch (error) { frame.removeEventListener("load", onLoad); reject(error); }
          });
          const preview = await Zotero.Reader.openPreview(attachmentID, frame);
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
          const hostWindow = runtime.browser?.ownerGlobal || Zotero.getMainWindow();
          const popupset = hostWindow?.document?.createXULElement?.("popupset");
          try { runtime.container?.appendChild?.(popupset); } catch (_) {}
          preview._window = hostWindow;
          preview._popupset = popupset;
          preview._openContextMenu = async ({ x, y, itemGroups }) => {
            if (!hostWindow || !popupset) return;
            const popup = hostWindow.document.createXULElement("menupopup");
            popupset.appendChild(popup);
            const done = Zotero.Promise.defer();
            popup.addEventListener("popuphidden", () => {
              try { popup.remove(); } catch (_) {}
              done.resolve();
            }, { once: true });
            for (const [groupIndex, group] of (itemGroups || []).entries()) {
              for (const item of group || []) {
                if (item.groups) {
                  const menu = hostWindow.document.createXULElement("menu");
                  menu.setAttribute("label", item.label);
                  const submenu = hostWindow.document.createXULElement("menupopup");
                  menu.appendChild(submenu);
                  for (const nestedGroup of item.groups) {
                    for (const nestedItem of nestedGroup) {
                      const nested = hostWindow.document.createXULElement("menuitem");
                      nested.setAttribute("label", nestedItem.label);
                      nested.setAttribute("disabled", Boolean(nestedItem.disabled));
                      nested.addEventListener("command", () => nestedItem.onCommand());
                      submenu.appendChild(nested);
                    }
                  }
                  popup.appendChild(menu);
                  continue;
                }
                const menuitem = hostWindow.document.createXULElement("menuitem");
                menuitem.setAttribute("label", item.label);
                menuitem.setAttribute("disabled", Boolean(item.disabled));
                if (item.color) {
                  menuitem.className = "menuitem-iconic";
                  menuitem.setAttribute("image", preview._getColorIcon(item.color, item.checked));
                }
                else if (item.checked) {
                  menuitem.setAttribute("type", "checkbox");
                  menuitem.setAttribute("checked", true);
                }
                menuitem.addEventListener("command", () => item.onCommand());
                popup.appendChild(menuitem);
              }
              if (groupIndex < itemGroups.length - 1) popup.appendChild(hostWindow.document.createXULElement("menuseparator"));
            }
            const outerRect = runtime.browser?.getBoundingClientRect?.();
            const frameRect = frame.getBoundingClientRect();
            const screenPoint = hostWindow.windowUtils.toScreenRectInCSSUnits(
              Number(outerRect?.x || 0) + frameRect.x + Number(x || 0),
              Number(outerRect?.y || 0) + frameRect.y + Number(y || 0),
              0, 0
            );
            popup.openPopupAtScreen(screenPoint.x, screenPoint.y, true);
            return done.promise;
          };
          const opened = await preview._open({});
          if (!opened) {
            try { popupset?.remove(); } catch (_) {}
            try { preview.uninit?.(); } catch (_) {}
            throw new Error("无法打开Zotero PDF阅读器");
          }
          // ReaderPreview is intended for compact, single-page previews. Its
          // defaults deliberately hide the viewer scroller and force page
          // mode, which is unsuitable for the workbench's reading pane.
          const pdfWindow = preview._internalReader?._primaryView?._iframeWindow;
          const pdfViewer = pdfWindow?.PDFViewerApplication?.pdfViewer;
          if (!pdfWindow || !pdfViewer) {
            try { preview.uninit?.(); } catch (_) {}
            throw new Error("Zotero PDF阅读器未能加载此页面");
          }
          pdfWindow.removeEventListener("resize", preview.updatePDFAttr);
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
          runtime.pdfPreview = preview;
          const eventBus = pdfWindow.PDFViewerApplication?.eventBus;
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
              try { eventBus?.off?.("pagechanging", emitLocation); } catch (_) {}
              try { viewerContainer?.removeEventListener("scroll", readerScroll); } catch (_) {}
              try { pdfWindow.document.removeEventListener("selectionchange", emitSelection); } catch (_) {}
              try { viewerContainer?.removeEventListener("wheel", zoomOriginalPDF, true); } catch (_) {}
              try { if (locationFrame) pdfWindow.cancelAnimationFrame(locationFrame); } catch (_) {}
              try { if (selectionFrame) pdfWindow.cancelAnimationFrame(selectionFrame); } catch (_) {}
              try { readerStyle?.remove(); } catch (_) {}
              try { popupset?.remove(); } catch (_) {}
              runtime.pdfPreviewCleanup = null;
            };
          }
          return { available: true, page: Number(pdfViewer.currentPageNumber || 1) };
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
          if (!attachment.isPDFAttachment?.()) {
            throw new Error("这条引用来自PDF，但当前附件不是PDF文件");
          }
          const nativePageIndex = Number(payload.nativePageIndex);
          const fallbackPage = Number(payload.page);
          const pageIndex = Number.isFinite(nativePageIndex)
            ? Math.max(0, Math.trunc(nativePageIndex))
            : Math.max(0, Math.trunc(Number.isFinite(fallbackPage) && fallbackPage > 0 ? fallbackPage - 1 : 0));
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
            return this.pipeline.translateStream(context, payload, emit, signal);
          });

        case "translate-layout":
          return this.withOperation(runtime, "layout", async (signal, emit) => {
            const context = await this.attachmentContext(attachmentID);
            return this.pipeline.translateLayout(context, payload, emit, signal);
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

        case "chat-send":
          return this.withOperation(runtime, "chat", async (signal, emit) => {
            const context = await this.attachmentContext(attachmentID);
            return this.chat.send(context.documentID, payload.sessionID, payload.text, {
              contextMode: payload.contextMode,
              selectedText: payload.selectedText,
              referenceQuotes: Array.isArray(payload.referenceQuotes) ? payload.referenceQuotes : [],
              responseLanguage: payload.responseLanguage,
              images: Array.isArray(payload.images) ? payload.images : [],
              documents: Array.isArray(payload.documents) ? payload.documents : [],
              documentOptions: payload.documentOptions,
              // taskType is deliberately separate from the renderer protocol.
              // The chat service owns all fixed task prompts so UI input can
              // never overwrite the stable schema or cache prefix.
              taskType: String(payload.taskType || ""),
              mindmap: Boolean(payload.mindmap),
              flowchart: Boolean(payload.flowchart)
            }, emit, signal);
          });

        case "chat-resend":
          return this.withOperation(runtime, "chat", async (signal, emit) => {
            const context = await this.attachmentContext(attachmentID);
            return this.chat.resend(context.documentID, payload.sessionID, payload.messageID, {
              contextMode: payload.contextMode,
              selectedText: payload.selectedText,
              referenceQuotes: Array.isArray(payload.referenceQuotes) ? payload.referenceQuotes : [],
              responseLanguage: payload.responseLanguage
            }, emit, signal);
          });

        case "chat-edit-message": {
          const context = await this.attachmentContext(attachmentID);
          const session = await this.chat.loadSession(context.documentID, payload.sessionID);
          const message = session.messages.find(row => row.id === payload.messageID);
          if (message?.role === "user") {
            return this.withOperation(runtime, "chat", async (signal, emit) => {
              return this.chat.editMessage(context.documentID, payload.sessionID, payload.messageID, payload.text, {
                contextMode: payload.contextMode,
                selectedText: payload.selectedText,
                referenceQuotes: Array.isArray(payload.referenceQuotes) ? payload.referenceQuotes : [],
                responseLanguage: payload.responseLanguage
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
          const context = await this.attachmentContext(attachmentID);
          await this.pipeline.clearDocument(context);
          return this.stateForAttachment(attachmentID);
        }

        case "open-native-pdf":
          await Zotero.Reader.open(attachmentID);
          return { opened: true };

        case "open-preferences":
          this.openPreferences(runtime.window);
          return { opened: true };

        case "open-external-url":
          return this.openExternalURL(payload.url);

        case "open-token-guide":
          return this.openTokenGuide();

        case "export-pdf":
          return this.withOperation(runtime, "export", async () => this.printWorkbenchPDF(runtime, payload));

        case "save-image":
          return this.saveImageData(runtime, payload);

        case "copy-image":
          return this.copyImageData(runtime, payload);

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
        translationShowReasoning: translation.showReasoning,
        chatShowReasoning: chat.showReasoning,
        translationReasoningPreferences: translation.reasoningPreferences,
        chatReasoningPreferences: chat.reasoningPreferences,
        chatProviderProfiles: chat.providerProfiles || {},
        keyPointsDefaultPrompt: LitMTrans.ChatInternals.DEFAULT_KEY_POINTS_PROMPT,
        effectiveKeyPointsPrompt: String(translation.keyPointsPrompt || LitMTrans.ChatInternals.DEFAULT_KEY_POINTS_PROMPT),
        providerCards: this.providerCards(),
        apiKey: this.secrets.getLLMKey(translation.provider),
        chatAPIKey: this.secrets.getLLMKey(chat.provider),
        mineruToken: this.secrets.getMinerUToken(),
        layoutReaderFonts,
        hasChatAPIKey: chat.hasAPIKey,
        providers: Object.values(LitMTrans.Constants.PROVIDERS).map(spec => ({
          id: spec.id,
          name: spec.name,
          defaultBaseURL: spec.defaultBaseURL,
          defaultModel: spec.defaultModel,
          chatDefaultModel: "",
          supportsImages: spec.supportsImages !== false,
          supportsChat: spec.supportsChat !== false && !U.isWebMachineProvider(spec.id)
        }))
      };
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
          chatUsesTranslationModel: true
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
          chatUsesTranslationModel: false
        };
        this.llm.saveSettings(chatValues, "chat");
      }
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
          supportsChat: spec.supportsChat !== false && !U.isWebMachineProvider(spec.id)
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
  }

  LitMTrans.createController = options => new Controller(options);
  LitMTrans.Controller = Controller;
  LitMTrans.ControllerInternals = { compiledEvidenceMatches, quoteCoverageScore, findEvidenceSegmentRanges, pdfTextHighlightRects };
})(this);
