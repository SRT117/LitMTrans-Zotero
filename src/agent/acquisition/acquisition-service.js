(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};
  const C = Agent.Contracts;

  function text(value) { return String(value ?? "").trim(); }
  function abort(signal) { if (signal?.aborted) throw new C.AgentError("JOB_CANCELLED", "任务已取消", { recoverable: true }); }
  function concurrency(options) { return Math.min(8, Math.max(1, Number(options?.concurrency || 2) || 2)); }

  class PaperAcquisitionService {
    constructor(controller, options = {}) {
      this.controller = controller;
      this.library = options.library || controller?.agent?.facade?.library;
      this.importer = options.importer || controller?.agent?.facade?.importer;
      this.index = options.index || controller?.agent?.facade?.literature?.index || null;
      this.statusForAttachment = options.statusForAttachment || null;
      this.runtime = options.runtime || new Agent.ManagedRuntimeManager(controller?.storage, options.runtimeOptions);
      this.providers = options.providers || [
        new Agent.ExistingAttachmentProvider(this.library, controller, options),
        new Agent.DirectKnownLocationProvider(controller?.storage, options),
        new Agent.ScanSciProvider(this.runtime, options)
      ];
      this.parseCallback = options.parseCallback || null;
      this.initialized = false;
    }

    async init() { if (!this.initialized) { await this.runtime.init(); this.initialized = true; } return this.runtime.state; }

    async shutdown() {
      for (const provider of this.providers) {
        try { await provider?.shutdown?.(); }
        catch (error) { try { this.controller?.log?.(`文献获取服务关闭失败：${error?.message || error}`); } catch (_) {} }
      }
      this.initialized = false;
      return { stopped: true };
    }

    async existing(candidate, options = {}) {
      const doi = Agent.PaperCardHelpers?.normalizeDOI?.(candidate?.identifiers?.doi || candidate?.doi || "") || "";
      let item = null;
      if (candidate?.local?.itemKey && this.library) {
        try { item = await this.library.resolveItem(candidate.local.itemKey, { libraryID: candidate.local.libraryID }); } catch (_) {}
      }
      if (!item && doi && this.importer?.existingByDOI) item = await this.importer.existingByDOI(doi, options.libraryID);
      if (!item && candidate?.metadata?.title && this.importer?.existingByTitle) item = await this.importer.existingByTitle(candidate.metadata.title, options.libraryID);
      return item;
    }

    async providerAcquire(candidate, options = {}) {
      let lastUnavailable = null;
      let lastProviderResult = null;
      for (const provider of this.providers) {
        abort(options.signal);
        const result = await provider.acquire(candidate, options);
        if (result?.status === "available") return result;
        if (result?.status === "unavailable") lastUnavailable = result;
        if (["failed", "invalid", "unresolved"].includes(result?.status)) lastProviderResult = result;
        if (result?.code === "INSTITUTION_LOGIN_REQUIRED") return result;
        if (result?.status === "failed" && provider.name === "managed-scansci" && options.stopOnScanSciFailure) return result;
      }
      if (options.attachToZotero !== false) {
        const translated = await this.translatorAcquire(candidate, options);
        if (translated.status !== "unavailable") return translated;
        if (translated.reason === "no-translatable-identifier" && lastProviderResult) return lastProviderResult;
        lastUnavailable = translated;
      }
      return lastProviderResult || lastUnavailable || { status: "failed", reason: "acquisition failed", provider: "all" };
    }

    async translatorAcquire(candidate, options = {}) {
      if (!this.importer) return { status: "unavailable", provider: "zotero-translator-fallback", reason: "acquisition unavailable", diagnostics: "Zotero importer is not configured" };
      const doi = Agent.PaperCardHelpers?.normalizeDOI?.(candidate?.identifiers?.doi || candidate?.doi || "") || "";
      const url = text(candidate?.identifiers?.url || candidate?.url);
      if (!doi && !/^https?:\/\//i.test(url)) return { status: "unavailable", provider: "zotero-translator-fallback", reason: "no-translatable-identifier" };
      try {
        const imported = doi
          ? await this.importer.addByDOI(doi, { ...options, libraryID: candidate?.local?.libraryID || options.libraryID, saveAttachments: true })
          : await this.importer.addByURL(url, { ...options, libraryID: candidate?.local?.libraryID || options.libraryID, saveAttachments: true, title: candidate?.metadata?.title });
        const itemRef = imported?.item;
        if (!itemRef) return { status: "metadata-only", provider: "zotero-translator-fallback", imported, provenance: { source: imported?.backend || "zotero-translator", retrievedAt: new Date().toISOString() } };
        const item = await this.library.resolveItem(itemRef);
        const attachment = await this.library.resolveAttachment(item);
        const path = await this.controller.attachmentPath(attachment);
        const validation = await Agent.PDFValidator.validateFile(path, options);
        if (!validation.valid) return { status: "metadata-only", provider: "zotero-translator-fallback", item: imported.item, imported, validation, provenance: { source: imported?.backend || "zotero-translator", retrievedAt: new Date().toISOString() } };
        return { status: "available", provider: "zotero-translator-fallback", path, item, attachment, validation, imported, backend: imported?.backend || "zotero-translator", provenance: { source: imported?.backend || "zotero-translator", retrievedAt: new Date().toISOString() } };
      }
      catch (error) {
        return { status: "unavailable", provider: "zotero-translator-fallback", reason: "acquisition unavailable", diagnostics: String(error?.message || error) };
      }
    }

    async attach(path, item, options = {}) {
      if (!path || !item) throw new C.AgentError("ACQUISITION_ATTACH_FAILED", "文献获取成功但缺少 Zotero 条目或文件", { recoverable: true });
      const attached = await this.importer.attachFile({ item: item.key || item.itemKey || item.id, path });
      if (options.collection || options.collectionID) await this.library.addItemsToCollection(options.collection || options.collectionID, [item.key || attached.itemKey]);
      return attached;
    }

    async cleanupStaged(path) {
      const root = String(this.controller?.storage?.root || "").replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
      const value = String(path || "").replace(/\\/g, "/").toLowerCase();
      if (!root || !value.startsWith(`${root}/staging/acquisition/`)) return false;
      try { await this.controller?.storage?.removeFile?.(path); return true; }
      catch (_) { return false; }
    }

    async upsertPaperCard(item) {
      if (!item || !this.index || typeof Agent.PaperCard?.fromItem !== "function") return;
      try {
        const card = await Agent.PaperCard.fromItem(item, { storage: this.controller?.storage, statusForAttachment: this.statusForAttachment });
        await this.index.upsert(card);
      }
      catch (error) { try { this.controller?.log?.(`PaperCard 更新失败：${error?.message || error}`); } catch (_) {} }
    }

    async importPaper(candidate, options = {}) {
      const existingItem = await this.existing(candidate, options);
      if (existingItem) return { status: "imported", reused: true, duplicate: true, item: await this.library.itemRecord(existingItem, { includeStatus: false }) };
      if (!this.importer?.create) throw new C.AgentError("LITERATURE_IMPORT_UNAVAILABLE", "当前环境无法创建 Zotero 文献条目", { recoverable: true });
      const imported = await this.importer.create({
        title: candidate?.metadata?.title,
        abstract: candidate?.summary?.abstract,
        DOI: candidate?.identifiers?.doi,
        URL: candidate?.identifiers?.url,
        date: candidate?.metadata?.date || candidate?.metadata?.year,
        publicationTitle: candidate?.metadata?.venue || candidate?.metadata?.journal,
        publisher: candidate?.metadata?.publisher,
        author: candidate?.metadata?.authors || []
      }, { libraryID: candidate?.local?.libraryID || options.libraryID, collection: options.collection, collectionID: options.collectionID });
      if (imported?.item) {
        const importedItem = await this.library.resolveItem(imported.item.key || imported.item.itemKey || imported.item.id);
        await this.upsertPaperCard(importedItem);
      }
      return { status: "imported", reused: false, duplicate: Boolean(imported?.duplicate), item: imported?.item || null };
    }

    async acquirePaper(candidate, options = {}) {
      await this.init();
      abort(options.signal);
      const input = candidate || {};
      const existingItem = await this.existing(input, options);
      if (existingItem) {
        try {
          const attachment = await this.library.resolveAttachment(existingItem);
          const path = await this.controller.attachmentPath(attachment);
          const validation = await Agent.PDFValidator.validateFile(path, options);
          if (validation.valid) {
            await this.upsertPaperCard(existingItem);
            options.onProgress?.({ phase: "validate", completed: 1, total: 1, progress: 100, message: "已复用现有附件" });
            return { status: "available", reused: true, duplicate: true, item: await this.library.itemRecord(existingItem, { includeStatus: false }), attachment: { key: attachment.key, id: attachment.id }, path, validation, provenance: { source: "existing-zotero", retrievedAt: new Date().toISOString() } };
          }
        }
        catch (_) {}
      }
      options.onProgress?.({ phase: "download", message: "正在获取文献全文" });
      const fetched = await this.providerAcquire(input, options);
      if (fetched.status !== "available") return { ...fetched, candidateID: input.candidateID || Agent.LiteratureRanking?.identifier?.(input) || "" };
      options.onProgress?.({ phase: "validate", message: "正在校验全文文件" });
      let item = existingItem || fetched.item || null;
      let imported = null;
      let attached = null;
      let standaloneAttachment = null;
      let standaloneAttached = false;

      try {
        if (!item && options.attachToZotero !== false) {
          const doi = Agent.PaperCardHelpers?.normalizeDOI?.(input.identifiers?.doi || input.doi || "");
          const url = text(input.identifiers?.url || input.url || "");
          const hasTitle = Boolean(input.metadata?.title);
          const libID = Number(input.local?.libraryID || options.libraryID || 1);

          // 1. 若调用方未显式提供标题（例如按 DOI 下载），优先以独立附件形式导入并触发 Zotero 原生 RecognizeDocument 解析
          //    这与用户手动把 PDF 拖入 Zotero 触发的是完全相同的原生引擎，能提取出完整的标题、作者以及摘要（Abstract）
          if (!hasTitle && fetched.path && global.Zotero?.Attachments?.importFromFile && (global.Zotero?.RecognizeDocument?.recognizeItems || global.Zotero?.RecognizeDocument?.autoRecognizeItems)) {
            try {
              const localFile = LitMTrans.Utils?.createLocalFile?.(fetched.path);
              if (localFile) {
                standaloneAttachment = await global.Zotero.Attachments.importFromFile({
                  file: localFile,
                  parentItemID: false,
                  libraryID: libID
                });
                if (standaloneAttachment && global.Zotero.RecognizeDocument.canRecognize?.(standaloneAttachment)) {
                  options.onProgress?.({ phase: "recognize", message: "正在触发 Zotero 原生元数据与摘要识别" });
                  try {
                    await global.Zotero.RecognizeDocument.recognizeItems([standaloneAttachment]);
                    if (standaloneAttachment.parentID) {
                      standaloneAttached = true;
                      item = await this.library.resolveItem(standaloneAttachment.parentID);
                      attached = {
                        attachmentID: standaloneAttachment.id,
                        attachmentKey: standaloneAttachment.key,
                        itemKey: item.key || item.itemKey || "",
                        fileName: standaloneAttachment.attachmentFilename || ""
                      };
                    }
                  } catch (_) {}
                }
              }
            } catch (_) {}
          }

          // 2. 若 Zotero 原生识别未运行或未匹配到父条目，走 Crossref / Zotero Translator 学术流水线
          if (!item) {
            try {
              if (!hasTitle && doi && typeof this.importer?.addByDOI === "function") {
                try {
                  imported = await this.importer.addByDOI(doi, {
                    libraryID: libID,
                    collection: options.collection,
                    collectionID: options.collectionID,
                    saveAttachments: false
                  });
                  if (imported?.item) {
                    item = await this.library.resolveItem(imported.item.key || imported.item.itemKey || imported.item.id);
                  }
                } catch (_) {}
              } else if (!hasTitle && url && typeof this.importer?.addByURL === "function") {
                try {
                  imported = await this.importer.addByURL(url, {
                    libraryID: libID,
                    collection: options.collection,
                    collectionID: options.collectionID,
                    saveAttachments: false
                  });
                  if (imported?.item) {
                    item = await this.library.resolveItem(imported.item.key || imported.item.itemKey || imported.item.id);
                  }
                } catch (_) {}
              }

              if (!item) {
                if (!this.importer?.create) throw new C.AgentError("LITERATURE_IMPORT_UNAVAILABLE", "当前环境无法创建 Zotero 文献条目", { recoverable: true });
                const fallbackTitle = input.metadata?.title
                  || (fetched.path ? PathUtils.filename(fetched.path).replace(/\.pdf$/i, "") : (doi ? `DOI: ${doi}` : "未命名文献"));
                imported = await this.importer.create({
                  title: fallbackTitle,
                  abstract: input.summary?.abstract,
                  abstractNote: input.summary?.abstract,
                  DOI: doi || input.identifiers?.doi,
                  URL: url || input.identifiers?.url,
                  date: input.metadata?.date || input.metadata?.year,
                  publicationTitle: input.metadata?.venue || input.metadata?.journal,
                  publisher: input.metadata?.publisher,
                  author: input.metadata?.authors || [],
                  libraryID: libID
                }, { libraryID: libID, collection: options.collection, collectionID: options.collectionID });
                item = imported.item ? await this.library.resolveItem(imported.item.key || imported.item.itemKey || imported.item.id) : null;
              }
            }
            catch (error) {
              this.runtime?.invalidateHealth?.("import-failed");
              throw error;
            }
          }
          if (item && doi && typeof item.setField === "function" && !item.getField?.("DOI")) {
            item.setField("DOI", doi);
            if (!item.getField?.("url")) item.setField("url", `https://doi.org/${doi}`);
            await this.library.saveEntity?.(item);
          }
        }

        if (options.attachToZotero !== false && item) {
          const existingAttachment = fetched.attachment;
          try {
            if (!attached) {
              if (standaloneAttachment) {
                standaloneAttachment.parentID = item.id;
                await this.library.saveEntity?.(standaloneAttachment);
                standaloneAttached = true;
                attached = {
                  attachmentID: standaloneAttachment.id,
                  attachmentKey: standaloneAttachment.key,
                  itemKey: item.key || item.itemKey || "",
                  fileName: standaloneAttachment.attachmentFilename || ""
                };
                if (options.collection || options.collectionID) {
                  await this.library.addItemsToCollection(options.collection || options.collectionID, [item.key]);
                }
              } else {
                attached = existingAttachment || await this.attach(fetched.path, item, options);
              }
            }
            fetched.attachment = existingAttachment && typeof existingAttachment === "object"
              ? { attachmentID: existingAttachment.id || 0, attachmentKey: existingAttachment.key || "", itemKey: item.key || item.itemKey || "", fileName: existingAttachment.attachmentFilename || "" }
              : attached;
            fetched.item = await this.library.itemRecord(item, { includeStatus: false });
            fetched.imported = imported;
            await this.upsertPaperCard(item);
            options.onProgress?.({ phase: "attach", message: "正在写入 Zotero 附件" });
            if (options.parse) {
              if (typeof this.parseCallback === "function") fetched.parse = await this.parseCallback(item, attached, options);
              else fetched.parse = { requested: true, status: "not-started", reason: "parse callback unavailable" };
            }
          }
          catch (error) {
            this.runtime?.invalidateHealth?.("import-failed");
            throw error;
          }
          finally {
            if (await this.cleanupStaged(fetched.path)) {
              fetched.stagedPathCleaned = true;
              fetched.path = "";
            }
          }
        }
      }
      finally {
        // 若创建了独立附件但最终未能成功持久化挂接到父条目，及时擦除孤立附件，避免污染文献库
        if (standaloneAttachment && !standaloneAttached) {
          try {
            standaloneAttachment.parentID = false;
            await standaloneAttachment.eraseTx?.();
          }
          catch (_) {}
        }
      }
      return { ...fetched, status: "available", reused: false, duplicate: Boolean(existingItem) };
    }

    async acquirePapers(candidates, options = {}) {
      const rows = Array.isArray(candidates) ? candidates : [];
      const output = new Array(rows.length);
      let next = 0;
      const worker = async () => {
        while (true) {
          abort(options.signal);
          const index = next++;
          if (index >= rows.length) return;
          try { output[index] = await this.acquirePaper(rows[index], options); }
          catch (error) { output[index] = { status: options.signal?.aborted ? "cancelled" : "failed", error: String(error?.message || error), candidateID: rows[index]?.candidateID || "" }; }
          if (typeof options.onProgress === "function") options.onProgress({ completed: output.filter(Boolean).length, total: rows.length, progress: Math.round(output.filter(Boolean).length / Math.max(1, rows.length) * 100) });
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency(options), rows.length || 1) }, () => worker()));
      return { total: rows.length, results: output, available: output.filter(row => row?.status === "available").length, failed: output.filter(row => row?.status !== "available").length };
    }

    institutionToolsAvailable(action = "") {
      return this.providers.some(provider => provider.name === "managed-scansci" && provider.institutionToolsAvailable?.(action));
    }

    institutionActions() {
      const provider = this.providers.find(item => item.name === "managed-scansci");
      return provider?.institutionActions?.() || [];
    }

    async institutionAccess(action, args = {}, options = {}) {
      const provider = this.providers.find(item => item.name === "managed-scansci");
      if (!provider?.institutionAccess) return { status: "unavailable", code: "INSTITUTION_ACCESS_UNAVAILABLE", reason: "managed-provider-unavailable" };
      return provider.institutionAccess(action, args, options);
    }

    diagnostics() {
      return {
        runtime: this.runtime.diagnostics(),
        providers: [...this.providers.map(provider => provider.name), "zotero-translator-fallback"],
        institutionAccess: { available: this.institutionToolsAvailable(), actions: this.institutionActions() }
      };
    }
  }

  Agent.PaperAcquisitionService = PaperAcquisitionService;
})(this);
