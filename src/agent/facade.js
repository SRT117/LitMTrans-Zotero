(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};
  const C = Agent.Contracts;

  function recordAgentShutdownProbe(name) {
    try {
      const utils = LitMTrans.Utils;
      if (!utils?.getPref?.("agentTestShutdownProbe", false)) return;
      utils.setPref(name, true);
      global.Services?.prefs?.savePrefFile?.(null);
    }
    catch (_) {}
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  class AgentFacade {
    constructor(controller) {
      this.controller = controller;
      this.policy = new Agent.CapabilityPolicy(controller);
      this.library = new Agent.LibraryService(controller);
      this.artifact = new Agent.ArtifactService(controller, this.library);
      this.research = new Agent.ResearchService(controller.storage);
      this.tasks = new Agent.AgentTaskManager(controller.storage);
      this.approvals = new Agent.ExternalApprovalService(controller.storage);
      this.corpus = new Agent.CorpusIndex(controller, this.artifact);
      this.exporter = new Agent.ExportService(controller, this.artifact, this.library);
      this.citation = new Agent.CitationService(controller, this.library);
      this.importer = new Agent.ImportService(this.library);
      this.literature = new Agent.LiteratureDiscoveryService(controller, {
        library: this.library,
        statusForAttachment: attachment => this.lightweightDocumentStatus(attachment)
      });
      this.acquisition = new Agent.PaperAcquisitionService(controller, {
        library: this.library,
        importer: this.importer,
        index: this.literature.index,
        statusForAttachment: attachment => this.lightweightDocumentStatus(attachment),
        parseCallback: (item, attachment, options) => this.startProcessing("parse", { ref: attachment?.attachmentKey || attachment?.key || item?.key, options })
      });
      this.review = new Agent.ReviewWorkspaceService(controller, { discovery: this.literature });
      this.library.statusProvider = attachment => this.statusForAttachment(attachment);
      this.initialized = false;
    }

    async init() {
      if (this.initialized) return;
      await this.approvals.init();
      await this.tasks.init();
      await this.research.init();
      await this.exporter.init();
      await this.corpus.init();
      await this.literature.init();
      await this.acquisition.init();
      this.tasks.setResolver("parse", input => this.processingRunner("parse", input));
      this.tasks.setResolver("stream_translation", input => this.processingRunner("stream_translation", input));
      this.tasks.setResolver("layout_translation", input => this.processingRunner("layout_translation", input));
      this.tasks.setResolver("chat", input => this.processingRunner("chat", input));
      this.tasks.setResolver("batch", input => this.startBatchRunner(input));
      this.tasks.setResolver("acquisition", (input, _old, parentID) => this.acquisitionRunner(input, parentID));
      this.initialized = true;
    }

    async shutdown() {
      recordAgentShutdownProbe("agentTestShutdownProbeAgentShutdownStarted");
      const taskShutdown = this.tasks.shutdown();
      const acquisitionShutdown = this.acquisition.shutdown?.();
      await taskShutdown;
      await acquisitionShutdown;
      recordAgentShutdownProbe("agentTestShutdownProbeAcquisitionShutdownCompleted");
      await this.literature.shutdown?.();
      await Agent.flushZoteroWrites?.(5000);
      this.initialized = false;
    }

    settings() {
      return this.policy.settings();
    }

    async statusForAttachment(attachment) {
      const context = await this.controller.attachmentContext(attachment.id, false);
      const snapshot = await this.controller.pipeline.snapshot(context);
      return this.artifact.manifestFromSnapshot({ attachment, item: context.parent, context, snapshot });
    }

    async lightweightDocumentStatus(attachment) {
      const storage = this.controller.storage;
      const context = await this.controller.attachmentContext(attachment.id, false);
      const documentID = String(context.documentID || storage.documentID(attachment) || "");
      let hasAttachment = false;
      try {
        const attachmentPath = await this.controller.attachmentPath(attachment);
        hasAttachment = Boolean(attachmentPath && await storage.exists(attachmentPath));
      }
      catch (_) {
        try {
          hasAttachment = typeof attachment?.fileExists === "function" ? Boolean(await attachment.fileExists()) : attachment?.fileExists === true;
        }
        catch (_) { hasAttachment = false; }
      }
      const documentMeta = storage.getDocumentMeta
        ? await storage.getDocumentMeta(documentID)
        : await storage.readJSON(storage.path(documentID, "document.json"), null);
      const parsed = Boolean(
        await storage.exists(storage.path(documentID, "full.cleaned.md"))
        || documentMeta?.parsedAt
        || documentMeta?.parseIdentity
      );
      const settings = this.controller.getSettings?.() || {};
      const targetLanguage = String(settings.targetLanguage || "target");
      const translationPaths = this.controller.translation?.paths?.(documentID, targetLanguage);
      const layoutPaths = this.controller.layout?.paths?.(documentID, targetLanguage);
      const [translationMeta, layoutMeta, translationExists, layoutExists, layoutSourceExists] = await Promise.all([
        translationPaths ? storage.readJSON(translationPaths.meta, null) : null,
        layoutPaths ? storage.readJSON(layoutPaths.meta, null) : null,
        translationPaths ? storage.exists(translationPaths.final) : false,
        layoutPaths ? storage.exists(layoutPaths.translations) : false,
        storage.exists(storage.path(documentID, "layout.json"))
      ]);
      const streamTranslation = Boolean(translationExists && (!translationMeta || translationMeta.complete !== false));
      const layoutTranslation = Boolean(layoutExists && (!layoutMeta || layoutMeta.complete !== false));
      return {
        hasAttachment,
        parsed,
        parseStale: Boolean(documentMeta?.parseStale),
        parsedAt: String(documentMeta?.parsedAt || documentMeta?.updatedAt || ""),
        streamTranslation,
        streamTranslationStale: Boolean(translationMeta?.stale),
        streamTranslationUpdatedAt: String(translationMeta?.completedAt || translationMeta?.updatedAt || ""),
        layoutSource: Boolean(documentMeta?.hasLayout || layoutSourceExists),
        layoutTranslation,
        layoutTranslationStale: Boolean(layoutMeta?.stale),
        layoutTranslationUpdatedAt: String(layoutMeta?.completedAt || layoutMeta?.updatedAt || ""),
        pageCount: Number(documentMeta?.pageCount || 0) || null,
        blockCount: Number(documentMeta?.blockCount || 0) || null,
        figureCount: Number(documentMeta?.figureCount ?? documentMeta?.imageCount ?? 0) || (documentMeta ? 0 : null),
        tableCount: Number(documentMeta?.tableCount || 0) || (documentMeta ? 0 : null),
        formulaCount: Number(documentMeta?.formulaCount || 0) || (documentMeta ? 0 : null),
        provenance: { source: "document-metadata", targetLanguage }
      };
    }

    async activeContext() {
      const win = global.Zotero?.getMainWindow?.() || global.Services?.wm?.getMostRecentWindow?.("navigator:browser");
      const selected = win?.ZoteroPane?.getSelectedItems?.() || [];
      const tabs = [...(this.controller.tabs?.values?.() || [])];
      const runtime = tabs.at(-1) || null;
      const nativeReaders = Array.isArray(global.Zotero?.Reader?._readers) ? global.Zotero.Reader._readers : [];
      const selectedTabID = String(win?.Zotero_Tabs?.selectedID || win?.Zotero_Tabs?.selectedTabID || "");
      let nativeReader = nativeReaders.find(reader => selectedTabID && String(reader?.tabID || reader?._tabID || "") === selectedTabID) || null;
      if (!nativeReader) nativeReader = nativeReaders.find(reader => reader?._internalReader?._primaryView) || nativeReaders.at(-1) || null;
      const nativeAttachmentID = Number(
        nativeReader?.itemID
        || nativeReader?._itemID
        || nativeReader?.attachmentID
        || nativeReader?._attachmentID
        || 0
      ) || 0;
      const output = {
        libraryID: Number(selected[0]?.libraryID || runtime?.libraryID || 0) || null,
        collection: null,
        selectedItem: selected[0] ? await this.library.itemRecord(selected[0], { includeStatus: false }) : null,
        selectedItems: [],
        activeAttachment: null,
        activeReader: null,
        activePage: null,
        documentID: "",
        workbench: Boolean(runtime),
        nativeReader: Boolean(nativeReader)
      };
      for (const item of Array.isArray(selected) ? selected.slice(0, 30) : []) {
        try { output.selectedItems.push(await this.library.itemRecord(item, { includeStatus: false })); }
        catch (_) {}
      }
      if (runtime?.attachmentID) {
        try {
          const resolved = await this.artifact.resolve(runtime.attachmentID, { prepareCAJ: false });
          output.activeAttachment = { id: resolved.attachment.id, key: resolved.attachment.key, fileName: resolved.attachment.attachmentFilename || "" };
          output.activeReader = { attachmentID: resolved.attachment.id, tabID: runtime.tabID || "" };
          output.documentID = resolved.context.documentID;
          output.activePage = Number(runtime.currentPage || runtime.page || runtime.readerPage || 0) || null;
        }
        catch (_) {}
      }
      if (!output.activeAttachment && nativeAttachmentID) {
        try {
          const resolved = await this.artifact.resolve(nativeAttachmentID, { prepareCAJ: false });
          output.activeAttachment = { id: resolved.attachment.id, key: resolved.attachment.key, fileName: resolved.attachment.attachmentFilename || "" };
          output.activeReader = {
            attachmentID: resolved.attachment.id,
            tabID: String(nativeReader?.tabID || nativeReader?._tabID || selectedTabID || "")
          };
          output.documentID = resolved.context.documentID;
          output.activePage = Number(
            nativeReader?.currentPage
            || nativeReader?._currentPage
            || nativeReader?._state?.pageIndex
            || nativeReader?._state?.page
            || 0
          ) || null;
          output.libraryID = output.libraryID || Number(resolved.attachment.libraryID || 0) || null;
        }
        catch (_) {}
      }
      return C.redact(output);
    }

    async capabilities() {
      const backgroundAI = Agent.publicBackgroundAIProfile(Agent.resolveBackgroundAIProfile(this.controller, "translation"));
      const developer = this.policy.settings().mode === "developer";
      const indexStats = this.literature.indexStats();
      const acquisitionDiagnostics = this.acquisition.diagnostics();
      return {
        protocol: { name: "litmtrans", version: "1", modern: "2026-07-28", legacy: ["2025-11-25", "2025-03-26", "2024-11-05"], transport: "streamable-http", endpoint: "/litmtrans/mcp" },
        product: { name: "LitMTrans Agent Backend", version: String(this.controller.version || "") },
        permissions: this.policy.capabilities(),
        settings: C.safeSettings(this.controller),
        externalServices: {
          approvalRequired: true,
          webInteractiveAvailable: backgroundAI.webInteractiveAvailable,
          webBackgroundAllowed: false,
          deepSeekWebConfigured: backgroundAI.deepSeekWebConfigured,
          deepSeekWebRuntimeLoaded: backgroundAI.deepSeekWebRuntimeLoaded,
          backgroundAI
        },
        exports: {
          exposed: ["source-markdown", "translation-markdown", "original-pdf", "original-file", "document-images", "research-bundle", "bibtex", "ris", "csl-json"],
          notExposed: ["layout-source-pdf", "layout-translation-pdf", "comparison-pdf", "pdf-pages", "caj-original"]
        },
        instructions: [
          "LitMTrans 允许正常的读取、解析、翻译、标签、Note、Annotation、Collection 整理、导出和研究记录自主执行。",
          "支持学术文献发现与全文 PDF 下载：用 litmtrans_literature_search 查找候选，再用 litmtrans_acquire_papers 获取、验证并添加 PDF 到 Zotero；也可用 litmtrans_literature_import 获取全文（acquireFullText=false 时只导入元数据）。获取到有效 PDF 后可用 parse=true 启动 MinerU 解析，之后可继续翻译。全文能否获取取决于开放来源和机构权限，解析与翻译取决于相应服务配置。",
          "正文未解析时可以主动提交解析任务；译文缺失时可以主动使用当前配置翻译。",
          "优先复用未过期缓存，长任务使用 Job，批量任务使用父 Job 和子 Job。",
          "不要索取已经由 LitMTrans 配置的 API Key、MinerU Token 或网页登录凭据。",
          "读取图片、公式和表格时优先使用结构化 Artifact API；PDF 页面 fallback 在当前环境仍可能不可用。",
          "Agent 导出目前不包含排版原文/译文/对照 PDF、PDF 页面或 CAJ 原件。"
        ],
        literature: {
          index: developer ? indexStats : { backend: indexStats.backend, cardCount: indexStats.cardCount, updatedAt: indexStats.updatedAt, stale: indexStats.stale },
          providers: developer ? Object.keys(this.literature.providers) : { routing: "automatic", available: Object.keys(this.literature.providers).length },
          acquisition: developer ? acquisitionDiagnostics : { available: acquisitionDiagnostics.runtime?.state?.status === "installed", state: acquisitionDiagnostics.runtime?.state?.status || "not-installed" },
          reviewWorkspace: true,
          evidenceLevels: ["metadata", "abstract", "full-text-block", "figure", "table", "formula"]
        },
        resources: [
          "litmtrans://paper/{documentID}/source",
          "litmtrans://paper/{documentID}/translation",
          "litmtrans://paper/{documentID}/figure/{figureID}",
          "litmtrans://paper/{documentID}/table/{tableID}",
          "litmtrans://paper/{documentID}/formula/{formulaID}",
          "litmtrans://paper/{documentID}/diagram/{mode}",
          "litmtrans://paper/{documentID}/chat/{sessionID}",
          "litmtrans://research/{artifactID}"
        ]
      };
    }

    async processingCapacity() {
      const settings = C.safeSettings(this.controller);
      const translation = Agent.resolveBackgroundAIProfile(this.controller, "translation");
      const chat = Agent.resolveBackgroundAIProfile(this.controller, "chat");
      return {
        mineruConfigured: settings.mineruConfigured,
        translation: settings.translation,
        chat: settings.chat,
        backgroundAI: {
          translation: Agent.publicBackgroundAIProfile(translation),
          chat: Agent.publicBackgroundAIProfile(chat)
        },
        webInteractiveAvailable: Boolean(translation.webInteractiveAvailable || chat.webInteractiveAvailable),
        webBackgroundAllowed: false,
        deepSeekWebConfigured: Boolean(translation.deepSeekWebConfigured || chat.deepSeekWebConfigured),
        deepSeekWebRuntimeLoaded: Boolean(translation.deepSeekWebRuntimeLoaded || chat.deepSeekWebRuntimeLoaded),
        deepSeekWebSession: (translation.deepSeekWebRuntimeLoaded || chat.deepSeekWebRuntimeLoaded) ? "interactive-only" : "not_loaded"
      };
    }

    contextRef(input = {}) {
      return input.documentID || input.attachmentKey || input.itemKey || input.itemID || input.key || input.item || input.attachment || input.ref || input;
    }

    citationRefs(args = {}) {
      const candidate = args.items || args.itemKeys || args.keys || args.ids;
      if (Array.isArray(candidate) && candidate.length) return candidate.filter(Boolean);
      const single = args.item || args.itemKey || args.itemID || args.attachmentKey || args.documentID || args.key || args.ref;
      if (single != null && single !== "" && typeof single !== "object") return [single];
      if (typeof single === "object" && single) {
        const keyOrID = single.key || single.itemKey || single.id || single.itemID || single.documentID;
        if (keyOrID) return [keyOrID];
      }
      return [];
    }

    processingRunner(kind, input = {}) {
      const payload = { ...input };
      return async ({ signal, emit }) => {
        const approvalInput = {
          ...payload,
          approvalID: payload.approvalID || payload.options?.approvalID || "",
          approved: payload.approved === true || payload.options?.approved === true
        };
        if (payload.skipApproval !== true) await this.ensureExternalApproval(kind, approvalInput);
        const ref = this.contextRef(payload);
        const resolved = await this.artifact.resolve(ref, { prepareCAJ: true });
        const options = { ...(payload.options || payload) };
        delete options.ref;
        delete options.documentID;
        delete options.itemKey;
        delete options.attachmentKey;
        delete options.itemID;
        delete options.key;
        delete options.item;
        delete options.attachment;
        if (kind === "parse") {
          emit({ type: "status", phase: "parse", message: "正在解析文献" });
          await this.controller.pipeline.parse(resolved.context, options, emit, signal);
          this.corpus.markStale?.();
          await this.literature.updateDocumentStatus(resolved.context.documentID, {
            hasAttachment: true,
            parsed: true,
            parseStale: false
          }, { item: resolved.context.parent, attachmentKey: resolved.context.attachment?.key });
        }
        else if (kind === "stream_translation") {
          const profile = Agent.resolveBackgroundAIProfile(this.controller, "translation");
          if (!profile.available) throw new C.AgentError("BACKGROUND_AI_UNAVAILABLE", profile.reason, { recoverable: true, suggestedAction: "configure_agent_background_provider", details: Agent.publicBackgroundAIProfile(profile) });
          Object.assign(options, { engine: "api", aiMode: "api", provider: profile.provider, baseURL: profile.baseURL, model: profile.model, apiKey: profile.apiKey });
          emit({ type: "status", phase: "translate-stream", message: "正在翻译全文" });
          await this.controller.pipeline.translateStream(resolved.context, options, emit, signal);
          this.corpus.markStale?.();
          await this.literature.updateDocumentStatus(resolved.context.documentID, {
            hasAttachment: true,
            streamTranslation: true,
            streamTranslationStale: false
          }, { item: resolved.context.parent, attachmentKey: resolved.context.attachment?.key });
        }
        else if (kind === "layout_translation") {
          const profile = Agent.resolveBackgroundAIProfile(this.controller, "translation");
          if (!profile.available) throw new C.AgentError("BACKGROUND_AI_UNAVAILABLE", profile.reason, { recoverable: true, suggestedAction: "configure_agent_background_provider", details: Agent.publicBackgroundAIProfile(profile) });
          Object.assign(options, { engine: "api", aiMode: "api", provider: profile.provider, baseURL: profile.baseURL, model: profile.model, apiKey: profile.apiKey });
          emit({ type: "status", phase: "translate-layout", message: "正在翻译排版文献" });
          await this.controller.pipeline.translateLayout(resolved.context, options, emit, signal);
          this.corpus.markStale?.();
          await this.literature.updateDocumentStatus(resolved.context.documentID, {
            hasAttachment: true,
            layoutTranslation: true,
            layoutTranslationStale: false
          }, { item: resolved.context.parent, attachmentKey: resolved.context.attachment?.key });
        }
        else if (kind === "chat") {
          const profile = Agent.resolveBackgroundAIProfile(this.controller, "chat");
          if (!profile.available) throw new C.AgentError("BACKGROUND_AI_UNAVAILABLE", profile.reason, { recoverable: true, suggestedAction: "configure_agent_background_provider", details: Agent.publicBackgroundAIProfile(profile) });
          Object.assign(options, { engine: "api", aiMode: "api", provider: profile.provider, baseURL: profile.baseURL, model: profile.model, apiKey: profile.apiKey });
          const sessionID = String(payload.sessionID || "");
          const message = String(payload.message || payload.text || "").trim();
          if (!message) throw new C.AgentError("MESSAGE_REQUIRED", "问题不能为空", { recoverable: false });
          await this.controller.chat.send(resolved.context.documentID, sessionID, message, { ...options, signal }, emit, signal);
          this.corpus.markStale?.();
        }
        else throw new C.AgentError("JOB_KIND_UNSUPPORTED", `不支持的任务类型 ${kind}`, { recoverable: false });
        return { documentID: resolved.context.documentID, manifest: await this.artifact.getManifest(ref, { prepareCAJ: false }) };
      };
    }

    async planExternal(kind, input = {}) {
      const operation = String(kind || "");
      const ref = this.contextRef(input);
      if (operation === "parse") {
        const resolved = await this.artifact.resolve(ref, { prepareCAJ: false });
        const settings = this.controller.getSettings?.() || {};
        return {
          services: ["MinerU"],
          provider: "MinerU",
          model: String(input.modelVersion || settings.mineruModel || "vlm"),
          documentCount: 1,
          operation: "parse",
          allowedOperations: ["parse"],
          estimatedScope: resolved.context.documentID,
          documentIDs: [resolved.context.documentID]
        };
      }
      const purpose = operation === "chat" ? "chat" : "translation";
      const profile = Agent.resolveBackgroundAIProfile(this.controller, purpose);
      if (!profile.available) throw new C.AgentError("BACKGROUND_AI_UNAVAILABLE", profile.reason, { recoverable: true, suggestedAction: "configure_agent_background_provider", details: Agent.publicBackgroundAIProfile(profile) });
      const resolved = await this.artifact.resolve(ref, { prepareCAJ: false });
      return {
        services: [profile.provider],
        provider: profile.provider,
        model: profile.model,
        documentCount: 1,
        operation,
        allowedOperations: [operation],
        estimatedScope: resolved.context.documentID,
        documentIDs: [resolved.context.documentID]
      };
    }

    async ensureExternalApproval(kind, input = {}) {
      const plan = await this.planExternal(kind, input);
      return this.approvals.ensure(plan, input);
    }

    async ensureImportApproval(kind, input = {}) {
      const plan = {
        services: [kind === "add_by_url" ? "Zotero Web Translator" : "Zotero Identifier Translator / Crossref"],
        provider: kind === "add_by_url" ? "Zotero Web Translator" : "Crossref/Zotero",
        model: "",
        documentCount: 1,
        operation: "import",
        allowedOperations: ["import"],
        estimatedScope: String(input.url || input.doi || input.DOI || "").slice(0, 240),
        documentIDs: []
      };
      return this.approvals.ensure(plan, input);
    }

    async startProcessing(kind, input = {}) {
      this.policy.assert("processing", { kind });
      const approval = await this.ensureExternalApproval(kind, input);
      const runner = this.processingRunner(kind, input);
      const taskInput = { ...input, approvalID: approval.approvalID || input.approvalID || "", approved: approval.approved === true || input.approved === true };
      return this.tasks.start(kind, taskInput, this.processingRunner(kind, taskInput), { resolver: oldInput => this.processingRunner(kind, oldInput) });
    }

    async waitForJob(jobID, signal) {
      while (true) {
        if (signal?.aborted) throw new C.AgentError("JOB_CANCELLED", "父任务已取消", { recoverable: true });
        const job = this.tasks.raw(jobID);
        if (!job) throw new C.AgentError("JOB_NOT_FOUND", `子任务 ${jobID} 不存在`, { recoverable: false });
        if (["completed", "failed", "cancelled", "interrupted"].includes(job.status)) return Agent.publicJob(job);
        await sleep(100);
      }
    }

    async collectBatchItems(options = {}) {
      const items = [];
      if (options.collection || options.collectionID || options.collectionKey) {
        const listing = await this.library.collectAllCollectionItems(options.collection || options.collectionID || options.collectionKey, {
          includeStatus: true,
          includeAttachments: Boolean(options.includeAttachments),
          pageSize: Math.max(1, Number(options.pageSize || options.limit || 100))
        });
        items.push(...(listing.items || []));
      }
      else {
        for (const ref of Array.isArray(options.items) ? options.items : []) {
          try { items.push(await this.library.itemRecord(await this.library.resolveItem(ref), { includeStatus: true })); }
          catch (_) {}
        }
      }
      const seen = new Set();
      return items.filter(item => {
        const key = String(item.attachmentKey || item.key || item.id || "");
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    async planBatchExternal(options = {}) {
      const items = await this.collectBatchItems(options);
      const translateKind = String(options.translationKind || "stream") === "layout" ? "layout_translation" : "stream_translation";
      const parseItems = items.filter(item => Boolean(options.force) || (options.parseMissing !== false && !item.litmtrans?.parsed));
      const translateItems = items.filter(item => Boolean(options.force) || (options.translateMissing === true && (translateKind === "layout_translation" ? !item.litmtrans?.layoutTranslation : !item.litmtrans?.streamTranslation)));
      const services = [];
      let provider = "";
      let model = "";
      const providers = [];
      const models = [];
      const serviceCounts = {};
      if (parseItems.length) services.push("MinerU");
      if (translateItems.length) {
        const profile = Agent.resolveBackgroundAIProfile(this.controller, "translation");
        if (!profile.available) throw new C.AgentError("BACKGROUND_AI_UNAVAILABLE", profile.reason, { recoverable: true, suggestedAction: "configure_agent_background_provider", details: Agent.publicBackgroundAIProfile(profile) });
        services.push(profile.provider);
        provider = profile.provider;
        model = profile.model;
        providers.push(profile.provider);
        models.push(profile.model);
        serviceCounts[profile.provider] = translateItems.length;
      }
      if (parseItems.length) {
        providers.push("MinerU");
        const mineruModel = String(options.modelVersion || this.controller.getSettings?.()?.mineruModel || "vlm");
        models.push(mineruModel);
        serviceCounts.MinerU = parseItems.length;
      }
      const affectedIDs = [...new Set([...parseItems, ...translateItems].map(item => String(
        item.documentID || (item.libraryID && item.attachmentKey ? `${item.libraryID}-${item.attachmentKey}` : "")
      ).trim()).filter(Boolean))];
      if (parseItems.length && translateItems.length) provider = "mixed";
      if (parseItems.length && translateItems.length) model = "mixed";
      return {
        items,
        parseItems,
        translateItems,
        translateKind,
        plan: {
          services,
          provider,
          providers,
          model,
          models,
          serviceCounts,
          parseCount: parseItems.length,
          translateCount: translateItems.length,
          documentCount: affectedIDs.length,
          operation: "batch",
          allowedOperations: ["batch", "parse", translateKind],
          estimatedScope: options.collection || options.collectionID || options.collectionKey ? `Collection ${options.collection || options.collectionID || options.collectionKey}` : `${items.length} 篇指定文献`,
          documentIDs: affectedIDs
        }
      };
    }

    async runPool(entries, concurrency, worker, signal) {
      const rows = Array.isArray(entries) ? entries : [];
      const output = new Array(rows.length);
      let cursor = 0;
      const workerCount = Math.min(rows.length, Math.max(1, Number(concurrency || 2)));
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (true) {
          if (signal?.aborted) throw new C.AgentError("JOB_CANCELLED", "批量任务已取消", { recoverable: true });
          const index = cursor++;
          if (index >= rows.length) return;
          output[index] = await worker(rows[index], index);
        }
      }));
      return output;
    }

    batchRunner(options = {}, parentID = () => "") {
      return async ({ signal, emit }) => {
        const planned = await this.planBatchExternal(options);
        const items = planned.items;
        const translateKind = planned.translateKind;
        const results = [];
        const childOptions = { ...options, approvalID: options.approvalID || "", approved: true };
        const totalWork = planned.parseItems.length + planned.translateItems.length;
        let completedWork = 0;
        const report = message => emit({ type: "progress", phase: "batch", progress: Math.round((completedWork / Math.max(1, totalWork)) * 100), message });
        const parseResults = new Map();
        const parseRows = await this.runPool(planned.parseItems, options.parseConcurrency || 2, async item => {
          const ref = item.attachmentKey || item.key;
          const childInput = { ref, options: childOptions };
          const child = this.tasks.start("parse", childInput, this.processingRunner("parse", childInput), { parentJobID: parentID(), resolver: oldInput => this.processingRunner("parse", oldInput) });
          const result = await this.waitForJob(child.id, signal);
          parseResults.set(String(ref), result);
          results.push(result);
          completedWork += 1;
          report(`解析完成 ${completedWork}/${Math.max(1, totalWork)} 个任务`);
          return result;
        }, signal);
        void parseRows;

        const translateRows = planned.translateItems.filter(item => {
          const ref = String(item.attachmentKey || item.key || "");
          const parse = parseResults.get(ref);
          return !parse || parse.status === "completed";
        });
        await this.runPool(translateRows, options.translationConcurrency || 2, async item => {
          const ref = item.attachmentKey || item.key;
          const childInput = { ref, options: childOptions };
          const child = this.tasks.start(translateKind, childInput, this.processingRunner(translateKind, childInput), { parentJobID: parentID(), resolver: oldInput => this.processingRunner(translateKind, oldInput) });
          const result = await this.waitForJob(child.id, signal);
          results.push(result);
          completedWork += 1;
          report(`翻译完成 ${completedWork}/${Math.max(1, totalWork)} 个任务`);
          return result;
        }, signal);
        return { total: items.length, parsed: planned.parseItems.length, translated: translateRows.length, results };
      };
    }

    async startBatch(options = {}) {
      this.policy.assert("processing");
      const planned = await this.planBatchExternal(options);
      const approval = await this.approvals.ensure(planned.plan, options);
      const holder = { id: "" };
      const taskOptions = { ...options, approvalID: approval.approvalID || options.approvalID || "", approved: true };
      const runner = this.batchRunner(taskOptions, () => holder.id);
      const job = this.tasks.start("batch", C.redact(taskOptions), runner, { resolver: oldInput => this.batchRunner(oldInput) });
      holder.id = job.id;
      return job;
    }

    startBatchRunner(input) {
      return this.batchRunner(input);
    }

    acquisitionRunner(input = {}, parentID = () => "") {
      const getParentID = typeof parentID === "function" ? parentID : () => String(parentID || "");
      return async ({ signal, emit }) => {
        const candidates = Array.isArray(input.candidates) ? input.candidates : [];
        emit({ type: "progress", phase: "prepare-runtime", progress: 2, message: "正在检查文献获取运行时" });
        const needsManagedRuntime = candidates.some(candidate => !candidate?.local?.attachmentKey && !candidate?.local?.hasFullText && !candidate?.discovery?.bestOALocation?.pdfURL);
        const runtime = needsManagedRuntime
          ? await this.acquisition.runtime.ensure({ signal, onProgress: event => emit({ type: "progress", phase: "runtime", progress: 5, message: event.message || "正在准备文献获取运行时" }) })
          : { available: false, skipped: true, reason: "existing-or-known-oa-path" };
        emit({ type: "progress", phase: "resolve", progress: 12, message: runtime.available ? "文献获取运行时已就绪" : "运行时暂不可用，继续尝试本地附件和开放获取直链" });
        emit({ type: "progress", phase: "download", progress: 14, message: "正在获取候选文献全文" });
        const acquisitionOptions = {
          ...input,
          parse: false,
          signal,
          onProgress: event => emit({
            type: "progress",
            phase: event.phase || "download",
            progress: 10 + Math.round(Number(event.progress || 0) * 0.65),
            message: event.message || `已处理 ${event.completed || 0}/${event.total || candidates.length}`
          })
        };
        if (!runtime.skipped && Agent.RuntimePreflightToken) acquisitionOptions[Agent.RuntimePreflightToken] = runtime;
        const acquisition = await this.acquisition.acquirePapers(candidates, acquisitionOptions);
        emit({ type: "progress", phase: "import", progress: 76, message: "正在整理全文获取结果" });
        const parseResults = [];
        if (input.parse === true) {
          const available = acquisition.results.filter(row => row?.status === "available" && (row.attachment?.attachmentKey || row.attachment?.key || row.item?.key));
          let completed = 0;
          for (const row of available) {
            if (signal?.aborted) throw new C.AgentError("JOB_CANCELLED", "父任务已取消", { recoverable: true });
            const ref = row.attachment?.attachmentKey || row.attachment?.key || row.item?.key;
            const childInput = {
              ref,
              approvalID: input.approvalID || "",
              approved: true,
              skipApproval: true,
              options: { ...(input.options || {}), approvalID: input.approvalID || "", approved: true, skipApproval: true }
            };
            const child = this.tasks.start("parse", childInput, this.processingRunner("parse", childInput), { parentJobID: getParentID(), resolver: oldInput => this.processingRunner("parse", oldInput) });
            const result = await this.waitForJob(child.id, signal);
            parseResults.push(result);
            completed += 1;
            emit({ type: "progress", phase: "parse", progress: 75 + Math.round(completed / Math.max(1, available.length) * 25), message: `解析完成 ${completed}/${available.length}` });
          }
        }
        emit({ type: "progress", phase: "complete", progress: 100, message: "全文获取任务完成" });
        return { jobType: "acquire_papers", total: candidates.length, runtime, acquisition, parsed: parseResults.length, parseResults };
      };
    }

    async startAcquisitionBatch(options = {}) {
      this.policy.assert("acquisition-write");
      const candidates = Array.isArray(options.candidates) ? [...options.candidates] : [];
      if (Array.isArray(options.candidateIDs) && !candidates.length) {
        for (const candidateID of options.candidateIDs.slice(0, 200)) {
          const card = await this.literature.resolveCandidate(candidateID);
          candidates.push(card || this.literature.seedCardFromIdentifier?.(candidateID));
        }
      }
      const usable = candidates.filter(Boolean).slice(0, 200);
      if (!usable.length) throw new C.AgentError("LITERATURE_CANDIDATES_REQUIRED", "文献获取至少需要一个 candidate 或 candidateID", { recoverable: false });
      let approval = { approvalID: options.approvalID || "", approved: options.approved === true };
      if (options.parse === true) {
        approval = await this.approvals.ensure({
          services: ["MinerU"],
          provider: "MinerU",
          model: String(options.modelVersion || this.controller.getSettings?.()?.mineruModel || "vlm"),
          documentCount: usable.length,
          parseCount: usable.length,
          operation: "acquisition_batch",
          allowedOperations: ["acquisition_batch", "parse"],
          estimatedScope: `${usable.length} 篇候选文献`,
          documentIDs: [],
          unresolvedDocumentScope: true
        }, options);
      }
      const holder = { id: "" };
      const input = C.redact({ ...options, candidates: usable, approvalID: approval.approvalID || options.approvalID || "", approved: approval.approved === true || options.approved === true });
      const runner = this.acquisitionRunner(input, () => holder.id);
      const job = this.tasks.start("acquisition", input, runner, { resolver: (oldInput, _old, parentID) => this.acquisitionRunner(oldInput, parentID) });
      holder.id = job.id;
      return job;
    }

    async readChatSessions(ref) {
      this.policy.assert("chat-read");
      const resolved = await this.artifact.resolve(ref, { prepareCAJ: false });
      return { documentID: resolved.context.documentID, sessions: await this.controller.chat.listSessions(resolved.context.documentID) };
    }

    async readChatSession(ref, sessionID) {
      this.policy.assert("chat-read");
      const resolved = await this.artifact.resolve(ref, { prepareCAJ: false });
      return this.controller.chat.loadSession(resolved.context.documentID, sessionID || "", true);
    }

    async editChatMessage(ref, sessionID, messageID, text, options = {}) {
      this.policy.assert("chat-write");
      const resolved = await this.artifact.resolve(ref, { prepareCAJ: false });
      const session = await this.controller.chat.loadSession(resolved.context.documentID, sessionID || "", false);
      const message = (session.messages || []).find(row => String(row?.id || "") === String(messageID || ""));
      if (!message) throw new C.AgentError("CHAT_MESSAGE_NOT_FOUND", "未找到要编辑的消息", { recoverable: false });
      if (message.role !== "user") {
        return this.controller.chat.editMessage(resolved.context.documentID, sessionID || "", messageID, text, { ...options, localOnly: true });
      }
      this.policy.assert("processing", { operation: "chat-edit" });
      const profile = Agent.resolveBackgroundAIProfile(this.controller, "chat");
      if (!profile.available) throw new C.AgentError("BACKGROUND_AI_UNAVAILABLE", profile.reason, { recoverable: true, suggestedAction: "configure_agent_background_provider", details: Agent.publicBackgroundAIProfile(profile) });
      const approval = await this.ensureExternalApproval("chat", { ...options, documentID: resolved.context.documentID, ref: resolved.context.documentID });
      return this.controller.chat.editMessage(resolved.context.documentID, sessionID || "", messageID, text, {
        ...options,
        engine: "api",
        aiMode: "api",
        provider: profile.provider,
        baseURL: profile.baseURL,
        model: profile.model,
        apiKey: profile.apiKey,
        forceAPI: true,
        agentExternal: true,
        approvalID: approval.approvalID || "",
        approved: true
      });
    }

    async deleteChatTurn(ref, sessionID, messageID) {
      this.policy.assert("chat-write");
      const resolved = await this.artifact.resolve(ref, { prepareCAJ: false });
      return this.controller.chat.deleteTurn(resolved.context.documentID, sessionID || "", messageID);
    }

    async clearChatSession(ref, sessionID) {
      this.policy.assert("chat-write");
      const resolved = await this.artifact.resolve(ref, { prepareCAJ: false });
      return this.controller.chat.clearSession(resolved.context.documentID, sessionID || "");
    }

    async getStorageSummary() {
      this.policy.assert("storage-summary");
      return this.controller.getStorageSummary?.() || this.controller.storage.getStorageSummary();
    }

    safeStoragePath(relativePath) {
      const relative = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
      if (!relative || relative.includes("\0") || /^[A-Za-z]:/.test(relative) || relative.split("/").includes("..")) throw new C.AgentError("INVALID_STORAGE_PATH", "存储路径必须位于 LitMTrans 数据目录内", { recoverable: false });
      return PathUtils.join(this.controller.storage.root, ...relative.split("/").filter(Boolean));
    }

    async validateDocument(ref, options = {}) {
      const manifest = await this.artifact.getManifest(typeof ref === "object" ? this.contextRef(ref) : ref, options);
      const issues = [];
      if (!manifest.parsed) issues.push({ code: "PAPER_NOT_PARSED", message: "当前文献尚未解析" });
      if (manifest.parseStale) issues.push({ code: "PARSE_STALE", message: "解析结果可能已过期" });
      return { valid: issues.length === 0, issues, manifest };
    }

    async validateTranslation(ref, options = {}) {
      const manifest = await this.artifact.getManifest(typeof ref === "object" ? this.contextRef(ref) : ref, options);
      const issues = [];
      if (!manifest.parsed) issues.push({ code: "PAPER_NOT_PARSED", message: "当前文献尚未解析" });
      if (!manifest.streamTranslation && !manifest.layoutTranslation) issues.push({ code: "TRANSLATION_MISSING", message: "当前文献没有可用译文" });
      if (manifest.streamTranslationStale || manifest.layoutTranslationStale) issues.push({ code: "TRANSLATION_STALE", message: "译文可能与当前原文不一致" });
      return { valid: issues.length === 0, issues, manifest };
    }

    async clearDocumentCache(ref, kind = "all", options = {}) {
      this.policy.assert("maintenance");
      const resolved = await this.artifact.resolve(typeof ref === "object" ? this.contextRef(ref) : ref, { prepareCAJ: false });
      const documentDir = this.controller.storage.documentDir(resolved.context.documentID);
      const archiveRoot = PathUtils.join(this.controller.storage.root, "agent", "cache-archive", `${resolved.context.documentID}-${Date.now()}`);
      const targets = kind === "translation"
        ? [PathUtils.join(documentDir, "translation"), PathUtils.join(documentDir, "layout-translation")]
        : [documentDir];
      const refreshStatus = async () => {
        const status = await this.lightweightDocumentStatus(resolved.context.attachment);
        await this.literature.updateDocumentStatus(resolved.context.documentID, status, {
          documentID: resolved.context.documentID,
          item: resolved.context.parent,
          itemKey: resolved.context.parent?.key,
          attachmentKey: resolved.context.attachment?.key
        });
        return status;
      };
      const existingTargets = [];
      for (const target of targets) if (await this.controller.storage.exists(target)) existingTargets.push(target);
      if (!existingTargets.length) return { cleared: false, documentID: resolved.context.documentID, reason: "not_found", status: await refreshStatus() };
      for (const target of existingTargets) {
        const archiveTarget = targets.length > 1 ? PathUtils.join(archiveRoot, PathUtils.filename(target)) : archiveRoot;
        await this.controller.storage.copyTree(target, archiveTarget);
        await this.controller.storage.remove(target, true);
      }
      return { cleared: true, documentID: resolved.context.documentID, kind, archivePath: archiveRoot, status: await refreshStatus() };
    }

    async listLitMTransFiles(options = {}) {
      this.policy.assert("developer");
      const prefix = String(options.prefix || "").replace(/\\/g, "/").replace(/^\/+/, "");
      const files = (await this.controller.storage.walk(this.controller.storage.root))
        .map(file => String(file).slice(String(this.controller.storage.root).length).replace(/^[\\/]+/, "").replace(/\\/g, "/"))
        .filter(file => !prefix || file.startsWith(prefix))
        .slice(0, Math.min(1000, Math.max(1, Number(options.limit || 200))));
      return { root: this.controller.storage.root, files };
    }

    async readLitMTransFile(relativePath, options = {}) {
      this.policy.assert("developer");
      const path = this.safeStoragePath(relativePath);
      const info = await this.controller.storage.stat(path);
      if (!info || info.type === "directory") throw new C.AgentError("FILE_NOT_FOUND", `未找到 LitMTrans 文件 ${relativePath}`, { recoverable: false });
      const content = C.redactText(await this.controller.storage.readText(path, ""));
      return { path: String(relativePath), mimeType: "text/plain", text: C.safeText(content, Number(options.maxChars || 500000)), size: Number(info.size || content.length) };
    }

    async readDiagnostics(options = {}) {
      this.policy.assert("developer");
      return C.redact({ settings: this.policy.capabilities(), storage: await this.getStorageSummary(), jobs: this.tasks.list({ limit: 50 }), logs: options.includeLogs ? await this.listLitMTransFiles({ prefix: "logs", limit: 100 }) : undefined });
    }

    async inspectDocumentState(ref, options = {}) {
      this.policy.assert("developer");
      const resolved = await this.artifact.resolve(this.contextRef({ ref }), { prepareCAJ: false });
      const root = this.controller.storage.documentDir(resolved.context.documentID);
      const files = (await this.controller.storage.walk(root)).map(file => String(file).slice(String(root).length).replace(/^[\\/]+/, "").replace(/\\/g, "/"));
      return { documentID: resolved.context.documentID, root, files };
    }

    async invoke(name, args = {}) {
      const tool = String(name || "").replace(/^litmtrans_/, "");
      switch (tool) {
        case "get_capabilities": return this.capabilities();
        case "get_client_config": {
          this.policy.assert("client-config");
          const client = String(args.client || "generic").trim() || "generic";
          const status = this.controller.agent?.server?.status?.() || {};
          const endpoint = String(status.url || "").trim();
          if (!endpoint) throw new C.AgentError("AGENT_SERVER_NOT_RUNNING", "Agent MCP 服务尚未启动，请先在设置中启用 Agent 服务", { recoverable: true, suggestedAction: "enable_agent_server", details: { client, instructions: "请先启用 Agent MCP 服务，再重新生成客户端配置。" } });
          return { client, endpoint, ...Agent.ClientConfig.descriptor(client, endpoint) };
        }
        case "get_active_context": return this.activeContext();
        case "get_processing_capacity": return this.processingCapacity();
        case "list_libraries": this.policy.assert("library-read"); return this.library.libraries();
        case "get_library": this.policy.assert("library-read"); return this.library.getLibrary(args.libraryID ?? args.id ?? args.key);
        case "list_collections": this.policy.assert("library-read"); return this.library.listCollections(args);
        case "get_collection": this.policy.assert("library-read"); return this.library.getCollection(args.collection ?? args.collectionID ?? args.key, args);
        case "search_collections": this.policy.assert("library-read"); return this.library.listCollections(args);
        case "get_collection_items": this.policy.assert("library-read"); return this.library.getCollectionItems(args.collection ?? args.collectionID ?? args.key, args);
        case "search_items": this.policy.assert("search"); return this.library.searchItems(args);
        case "get_paper_status":
        case "get_paper_manifest": this.policy.assert("paper-read"); return this.artifact.getManifest(this.contextRef(args), args);
        case "get_papers_status": this.policy.assert("paper-read"); return this.artifact.getManifests(args.documents || args.items || [], args);
         case "start_parse": return await this.startProcessing("parse", { ...args, ref: this.contextRef(args), options: args });
         case "start_stream_translation": return await this.startProcessing("stream_translation", { ...args, ref: this.contextRef(args), options: args });
         case "start_layout_translation": return await this.startProcessing("layout_translation", { ...args, ref: this.contextRef(args), options: args });
         case "process_collection": return await this.startBatch(args);
         case "process_items": return await this.startBatch(args);
        case "get_job": return this.tasks.get(args.jobID || args.id);
        case "list_jobs": return this.tasks.list(args);
        case "cancel_job": this.policy.assert("processing"); return this.tasks.cancel(args.jobID || args.id);
        case "retry_job": this.policy.assert("processing"); return this.tasks.retry(args.jobID || args.id);
        case "read_source": this.policy.assert("reading"); return this.artifact.readSource(this.contextRef(args), args);
        case "read_translation": this.policy.assert("reading"); return this.artifact.readTranslation(this.contextRef(args), args);
        case "list_sections": this.policy.assert("reading"); return this.artifact.listSections(this.contextRef(args), args);
        case "read_section": this.policy.assert("reading"); return this.artifact.readSection(this.contextRef(args), args.section || args.title || args.sectionID, args);
        case "list_blocks": this.policy.assert("reading"); return this.artifact.listBlocks(this.contextRef(args), args);
        case "read_pages": this.policy.assert("reading"); return this.artifact.readPages(this.contextRef(args), args.pages || args.page, args);
        case "read_blocks": this.policy.assert("reading"); return this.artifact.readBlocks(this.contextRef(args), args.blockIDs || args.blocks, args);
        case "get_block": this.policy.assert("reading"); return this.artifact.getBlock(this.contextRef(args), args.blockID || args.id, args);
        case "list_figures": this.policy.assert("reading"); return this.artifact.listFigures(this.contextRef(args), args);
        case "get_figure": this.policy.assert("reading"); return this.artifact.getFigure(this.contextRef(args), args.figureID || args.id || args.figure, args);
        case "get_figure_context": this.policy.assert("reading"); return this.artifact.getFigureContext(this.contextRef(args), args.figureID || args.id || args.figure, args);
        case "list_formulas": this.policy.assert("reading"); return this.artifact.listFormulas(this.contextRef(args), args);
        case "get_formula": this.policy.assert("reading"); return this.artifact.getFormula(this.contextRef(args), args.formulaID || args.id || args.number || args.formula, args);
        case "get_formula_context": this.policy.assert("reading"); return this.artifact.getFormulaContext(this.contextRef(args), args.formulaID || args.id || args.number || args.formula, args);
        case "search_formulas": this.policy.assert("search"); return this.artifact.searchFormulas(this.contextRef(args), args);
        case "list_tables": this.policy.assert("reading"); return this.artifact.listTables(this.contextRef(args), args);
        case "get_table": this.policy.assert("reading"); return this.artifact.getTable(this.contextRef(args), args.tableID || args.id || args.table, args);
        case "get_table_context": this.policy.assert("reading"); return this.artifact.getTableContext(this.contextRef(args), args.tableID || args.id || args.table, args);
        case "export_table": this.policy.assert("export"); return this.artifact.exportTable(this.contextRef(args), args.tableID || args.id || args.table, args.format, args);
        case "render_page": this.policy.assert("reading"); return this.artifact.renderPage(this.contextRef(args), args.page, args);
        case "render_page_region": this.policy.assert("reading"); return this.artifact.renderPageRegion(this.contextRef(args), args.page, args.bbox || args.rect, { ...args, bbox: args.bbox, rect: args.rect });
        case "search_paper": this.policy.assert("search"); return this.artifact.searchPaper(this.contextRef(args), args);
        case "search_corpus": this.policy.assert("search"); return this.corpus.search(args);
        case "literature_search": this.policy.assert("literature-discovery"); return this.literature.search({ ...args, providers: undefined });
        case "literature_graph": this.policy.assert("literature-discovery"); return this.literature.search({ ...args, providers: undefined, includeGraph: true, limit: args.limit || 20 });
        case "literature_import": {
          this.policy.assert("literature-import");
          const candidates = Array.isArray(args.candidates) ? args.candidates : [];
          if (args.candidateIDs && !candidates.length) {
            for (const candidateID of args.candidateIDs) {
              const card = await this.literature.resolveCandidate(candidateID);
              if (card) candidates.push(card);
            }
          }
          if (args.acquireFullText !== false && candidates.length) {
            return this.startAcquisitionBatch({ ...args, candidates, parse: args.parse === true });
          }
          const results = [];
          for (const candidate of candidates.slice(0, 100)) {
            if (args.acquireFullText === false) results.push(await this.acquisition.importPaper(candidate, args));
            else results.push(await this.acquisition.acquirePaper(candidate, { ...args, attachToZotero: true, parse: args.parse === true }));
          }
          return { total: results.length, results };
        }
        case "acquire_papers": {
          this.policy.assert("acquisition-write");
          return this.startAcquisitionBatch({ ...args, attachToZotero: args.attachToZotero !== false, parse: args.parse === true });
        }
        case "fulltext_access": {
          this.policy.assert("acquisition-write");
          const action = String(args.action || "status").trim().toLowerCase();
          if (action === "retry") {
            if (args.jobID) return this.tasks.retry(args.jobID);
            const candidates = Array.isArray(args.candidates) ? [...args.candidates] : [];
            if (args.candidate && typeof args.candidate === "object") candidates.push(args.candidate);
            const candidateIDs = Array.isArray(args.candidateIDs) ? args.candidateIDs.slice(0, 200) : [];
            if (args.candidateID && !candidates.length && !candidateIDs.length) candidateIDs.push(args.candidateID);
            for (const candidateID of candidateIDs) {
              const resolved = await this.literature.resolveCandidate(candidateID);
              candidates.push(resolved || this.literature.seedCardFromIdentifier(candidateID));
            }
            return this.startAcquisitionBatch({ ...args, candidates, parse: args.parse === true, attachToZotero: args.attachToZotero !== false });
          }
          return this.acquisition.institutionAccess(action, args);
        }
        case "review_workspace": {
          this.policy.assert(args.action === "read" || args.action === "status" || args.action === "export" ? "review-read" : "review-write");
          const action = String(args.action || "status").toLowerCase();
          if (action === "create") return this.review.create(args);
          if (action === "refresh") return this.review.refresh(args);
          if (action === "read") return this.review.read(args);
          if (action === "export") return this.review.export(args);
          if (action === "update") return this.review.update(args);
          return this.review.status(args);
        }
        case "rebuild_literature_index": this.policy.assert("developer"); return this.literature.rebuildIndex(args);
        case "get_literature_diagnostics": this.policy.assert("developer"); return { index: this.literature.indexStats(), providers: this.literature.providerHealth(), cache: this.literature.cacheStats(), acquisition: this.acquisition.diagnostics() };
        case "rebuild_corpus_index": this.policy.assert("developer"); return this.corpus.rebuild(args);
        case "read_diagram": this.policy.assert("diagram-read"); return this.artifact.readDiagram(this.contextRef(args), args.mode || "mindmap", args);
        case "save_diagram": this.policy.assert("diagram-write"); return this.artifact.saveDiagram(this.contextRef(args), args.mode || "mindmap", args.diagram, args);
        case "get_mindmap": this.policy.assert("diagram-read"); return this.artifact.readDiagram(this.contextRef(args), "mindmap", args);
        case "get_flowchart": this.policy.assert("diagram-read"); return this.artifact.readDiagram(this.contextRef(args), "flowchart", args);
        case "save_mindmap": this.policy.assert("diagram-write"); return this.artifact.saveDiagram(this.contextRef(args), "mindmap", args.diagram, args);
        case "save_flowchart": this.policy.assert("diagram-write"); return this.artifact.saveDiagram(this.contextRef(args), "flowchart", args.diagram, args);
        case "clear_diagram": this.policy.assert("diagram-write"); return this.artifact.clearDiagram(this.contextRef(args), args.mode || "mindmap", args);
        case "resolve_diagram_evidence": this.policy.assert("diagram-read"); return this.artifact.resolveDiagramEvidence(this.contextRef(args), args.mode || "mindmap", args.nodeID || args.node, args);
        case "list_chat_sessions": return this.readChatSessions(this.contextRef(args));
        case "read_chat_session": return this.readChatSession(this.contextRef(args), args.sessionID || args.id);
         case "create_chat_message": this.policy.assert("processing"); return await this.startProcessing("chat", { ...args, ref: this.contextRef(args), options: args });
         case "approve_external_service": this.policy.assert("external-approval"); return this.approvals.approve(args.approvalID || args.id, args);
        case "edit_chat_message": return this.editChatMessage(this.contextRef(args), args.sessionID, args.messageID || args.id, args.message || args.text, args);
        case "delete_chat_turn": return this.deleteChatTurn(this.contextRef(args), args.sessionID, args.messageID || args.id);
        case "clear_chat_session": return this.clearChatSession(this.contextRef(args), args.sessionID || args.id);
        case "list_research_artifacts": this.policy.assert("research-read"); return this.research.list(args);
        case "get_research_artifact": this.policy.assert("research-read"); return this.research.get(args.id || args.artifactID);
        case "create_research_artifact": this.policy.assert("research-write"); return this.research.create(args);
        case "update_research_artifact": this.policy.assert("research-write"); return this.research.update(args.id || args.artifactID, args);
        case "delete_research_artifact": this.policy.assert("research-write"); return this.research.remove(args.id || args.artifactID);
        case "create_collection": this.policy.assert("library-write"); return this.library.createCollection(args);
        case "update_collection":
        case "rename_collection":
        case "move_collection": this.policy.assert("library-write"); return this.library.updateCollection(args.collection ?? args.collectionID ?? args.key, args);
        case "add_items_to_collection": this.policy.assert("library-write"); return this.library.addItemsToCollection(args.collection ?? args.collectionID ?? args.key, this.citationRefs(args));
        case "remove_items_from_collection": this.policy.assert("library-write"); return this.library.removeItemsFromCollection(args.collection ?? args.collectionID ?? args.key, this.citationRefs(args));
        case "add_tags": this.policy.assert("library-write"); return this.library.addTags(args.item || args.itemKey || args.key, args.tags || args.tag || []);
        case "remove_tags": this.policy.assert("library-write"); return this.library.removeTags(args.item || args.itemKey || args.key, args.tags || args.tag || []);
        case "update_item_metadata": this.policy.assert("library-write"); return this.library.updateItemMetadata(args.item || args.itemKey || args.key, args.fields || args.metadata || args);
        case "create_note": this.policy.assert("library-write"); return this.library.createNote(args.item || args.itemKey || args.key, args);
        case "update_note": this.policy.assert("library-write"); return this.library.updateNote(args.note || args.noteID || args.id, args);
        case "delete_note": this.policy.assert("library-write"); return this.library.deleteItem(args.note || args.noteID || args.id);
        case "list_annotations": this.policy.assert("annotation-read"); return this.library.listAnnotations(args.attachment || args.attachmentKey || args.item || args.itemKey, args);
        case "create_annotation": this.policy.assert("annotation-write"); return this.library.createAnnotation(args);
        case "update_annotation": this.policy.assert("annotation-write"); return this.library.updateAnnotation(args.annotation || args.annotationID || args.id, args);
        case "delete_annotation": this.policy.assert("annotation-write"); return this.library.deleteItem(args.annotation || args.annotationID || args.id);
        case "export_research_bundle": this.policy.assert("export"); return this.exporter.bundle(this.contextRef(args), { ...args, allowChatHistory: this.settings().allowChatHistory });
        case "export_collection_workspace": this.policy.assert("export"); return this.exporter.collectionWorkspace({ ...args, allowChatHistory: this.settings().allowChatHistory });
        case "export": this.policy.assert("export"); return this.exporter.exportFile(this.contextRef(args), args.kind, { ...args, allowChatHistory: this.settings().allowChatHistory });
        case "get_storage_summary": return this.getStorageSummary();
        case "validate_document": this.policy.assert("maintenance"); return this.validateDocument(args);
        case "validate_translation": this.policy.assert("maintenance"); return this.validateTranslation(args);
        case "rebuild_manifest": this.policy.assert("maintenance"); return this.artifact.getManifest(this.contextRef(args), args);
        case "clear_document_cache": return this.clearDocumentCache(args, "all");
        case "clear_translation_cache": return this.clearDocumentCache(args, "translation");
        case "list_litmtrans_files": return this.listLitMTransFiles(args);
        case "read_litmtrans_file": return this.readLitMTransFile(args.path || args.relativePath, args);
        case "read_diagnostics": return this.readDiagnostics(args);
        case "inspect_document_state": return this.inspectDocumentState(this.contextRef(args), args);
        case "repair_document": this.policy.assert("developer"); return this.artifact.getManifest(this.contextRef(args), { ...args, prepareCAJ: true });
        case "query_agent_index": this.policy.assert("developer"); return this.corpus.search(args);
        case "generate_citation": this.policy.assert("library-read"); return this.citation.generateCitation(this.citationRefs(args), args);
        case "generate_bibliography": this.policy.assert("library-read"); return this.citation.generateBibliography(this.citationRefs(args), args);
        case "export_bibtex": this.policy.assert("export"); return this.citation.exportFormat(this.citationRefs(args), "bibtex", args);
        case "export_ris": this.policy.assert("export"); return this.citation.exportFormat(this.citationRefs(args), "ris", args);
        case "export_csl_json": this.policy.assert("export"); return this.citation.exportFormat(this.citationRefs(args), "csl-json", args);
         case "add_by_doi": {
           this.policy.assert("library-write");
           const existing = await this.importer.existingByDOI(Agent.ImportHelpers.normalizeDOI(args.doi || args.DOI), args.libraryID);
           if (existing) return { created: false, duplicate: true, item: existing, backend: "local-duplicate-check" };
           await this.ensureImportApproval("add_by_doi", args);
           return this.importer.addByDOI(args.doi || args.DOI, args);
         }
         case "add_by_url": {
           this.policy.assert("library-write");
           const doi = Agent.ImportHelpers.normalizeDOI(String(args.url || "").match(/10\.[0-9]{4,9}\/[^/?#]+/i)?.[0] || "");
           if (doi) {
             const existing = await this.importer.existingByDOI(doi, args.libraryID);
             if (existing) return { created: false, duplicate: true, item: existing, backend: "local-duplicate-check" };
           }
           await this.ensureImportApproval("add_by_url", args);
           return this.importer.addByURL(args.url, args);
         }
        case "add_by_bibtex": this.policy.assert("library-write"); return this.importer.addByBibTeX(args.bibtex || args.content || args.text || "", args);
        case "add_by_csl_json": this.policy.assert("library-write"); return this.importer.addByCSL(args.csl || args.data || args.content || args.text, args);
        case "attach_file": this.policy.assert("library-write"); return this.importer.attachFile(args);
        case "add_local_file": this.policy.assert("library-write"); return this.importer.addLocalFile(args);
        default: throw new C.AgentError("TOOL_NOT_FOUND", `未知的 LitMTrans 工具 ${name}`, { recoverable: false });
      }
    }

    visibleTools(options = {}) {
      const settings = this.policy.settings();
      const translation = Agent.resolveBackgroundAIProfile(this.controller, "translation");
      const chat = Agent.resolveBackgroundAIProfile(this.controller, "chat");
      const mineruConfigured = Boolean(C.safeSettings(this.controller).mineruConfigured);
      const requestedCategories = new Set((Array.isArray(options.categories) ? options.categories : (options.categories ? [options.categories] : (options.category ? [options.category] : [])))
        .map(value => String(value || "").trim().toLowerCase()).filter(Boolean));
      const categoryOf = operation => {
        if (["capabilities", "client-config", "context", "processing-capacity"].includes(operation)) return "core";
        if (["library-read", "library-write", "search", "annotation", "annotation-read", "annotation-write", "literature-discovery", "literature-import", "acquisition-read", "acquisition-write", "review-read", "review-write"].includes(operation)) return "library";
        if (["paper-read", "reading", "resource"].includes(operation)) return "reading";
        if (["processing", "jobs-read"].includes(operation)) return "processing";
        if (operation.startsWith("chat-")) return "chat";
        if (operation.startsWith("research-")) return "research";
        if (operation.includes("diagram")) return "diagram";
        if (operation === "export") return "export";
        if (operation === "developer" || operation === "maintenance" || operation === "storage-summary") return "developer";
        return operation;
      };
      return Agent.MCPTools.filter(tool => {
        const operation = String(tool._litmtransOperation || "");
        if (requestedCategories.size && !requestedCategories.has(categoryOf(operation)) && !requestedCategories.has(operation)) return false;
        if (operation === "developer" && settings.mode !== "developer") return false;
        if (operation === "chat-read" && !settings.allowChatHistory) return false;
        if (["processing", "chat-write", "annotation-write", "literature-import", "acquisition-write", "review-write"].includes(operation) && settings.mode === "read") return false;
        if (operation === "processing" && !settings.allowConfiguredServices) return false;
        const name = String(tool.name || "");
        if (name.includes("start_parse") && !mineruConfigured) return false;
        if (name === "litmtrans_fulltext_access" && !this.acquisition.institutionToolsAvailable()) return false;
        if (["litmtrans_start_stream_translation", "litmtrans_start_layout_translation", "litmtrans_process_collection", "litmtrans_process_items"].includes(name) && !translation.available) return false;
        if (["litmtrans_create_chat_message", "litmtrans_edit_chat_message"].includes(name) && !chat.available) return false;
        return true;
      });
    }

    async readResource(uri) {
      const value = String(uri || "");
      const match = value.match(/^litmtrans:\/\/(paper|research)\/([^/]+)(?:\/(.*))?$/i);
      if (!match) throw new C.AgentError("RESOURCE_NOT_FOUND", `不支持的资源 URI ${value}`, { recoverable: false });
      if (match[1].toLowerCase() === "research") return { uri: value, mimeType: "application/json", text: JSON.stringify(await this.research.get(match[2]), null, 2) };
      const documentID = decodeURIComponent(match[2]);
      const path = String(match[3] || "source");
      if (path === "source") return { uri: value, mimeType: "text/markdown", text: (await this.artifact.readSource(documentID, {})).text };
      if (path === "translation") return { uri: value, mimeType: "text/markdown", text: (await this.artifact.readTranslation(documentID, {})).text };
      const figure = path.match(/^figure\/(.+)$/i);
      if (figure) {
        const row = await this.artifact.getFigure(documentID, decodeURIComponent(figure[1]), { includeData: true });
        if (row.data) return { uri: value, mimeType: row.mime, blob: row.data };
        return { uri: value, mimeType: "application/json", text: JSON.stringify(row, null, 2) };
      }
      const table = path.match(/^table\/(.+)$/i);
      if (table) return { uri: value, mimeType: "text/markdown", text: (await this.artifact.getTable(documentID, decodeURIComponent(table[1]), {})).markdown };
      const formula = path.match(/^formula\/(.+)$/i);
      if (formula) return { uri: value, mimeType: "application/json", text: JSON.stringify(await this.artifact.getFormula(documentID, decodeURIComponent(formula[1]), {}), null, 2) };
      const diagram = path.match(/^diagram\/(mindmap|flowchart)$/i);
      if (diagram) return { uri: value, mimeType: "application/json", text: JSON.stringify(await this.artifact.readDiagram(documentID, diagram[1], {}), null, 2) };
      const chat = path.match(/^chat\/(.+)$/i);
      if (chat) return { uri: value, mimeType: "application/json", text: JSON.stringify(await this.readChatSession(documentID, decodeURIComponent(chat[1])), null, 2) };
      throw new C.AgentError("RESOURCE_NOT_FOUND", `未找到资源 ${value}`, { recoverable: false });
    }
  }

  Agent.AgentFacade = AgentFacade;
})(this);
