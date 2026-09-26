(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};
  const C = Agent.Contracts;

  function lower(value) { return String(value || "").toLocaleLowerCase(); }

  class CorpusIndex {
    constructor(controller, artifactService) {
      this.controller = controller;
      this.artifact = artifactService;
      this.storage = controller.storage;
      this.path = PathUtils.join(this.storage.root, "agent", "agent-index.json");
      this.rows = [];
      this.updatedAt = "";
      this.stale = true;
    }

    async init() {
      const saved = await this.storage.readJSON(this.path, null);
      if (saved?.version === 2 && Array.isArray(saved.documents)) {
        this.rows = saved.documents;
        this.updatedAt = String(saved.updatedAt || "");
        this.stale = false;
      }
    }

    markStale() {
      this.stale = true;
    }

    async rebuild(options = {}) {
      const documents = [];
      for (const directory of await this.storage.list(this.storage.documentsRoot)) {
        const info = await this.storage.stat(directory);
        if (!info || info.type !== "directory") continue;
        const documentID = PathUtils.filename(directory);
        const meta = await this.storage.readJSON(PathUtils.join(directory, "document.json"), {}) || {};
        const source = await this.storage.readText(PathUtils.join(directory, "full.cleaned.md"), "");
        const translationRoot = PathUtils.join(directory, "translation");
        let translation = "";
        for (const file of await this.storage.list(translationRoot)) {
          if (/translation\.[^/]+\.md$/i.test(file)) {
            translation = await this.storage.readText(file, "");
            if (translation) break;
          }
        }
        const compiled = await this.storage.readJSON(PathUtils.join(directory, "compiled-model.json"), null);
        const blocks = [];
        for (const page of compiled?.model?.pages || compiled?.pages || []) {
          for (const block of page?.blocks || []) blocks.push({
            blockID: String(block.id || ""), page: Number(block.page || page.index || 1), type: String(block.type || ""),
            kind: String(block.kind || "text"), text: String(block.text || ""), translation: String(block.translatedText || "")
          });
        }
        if (!source && !translation && !meta.title) continue;
        documents.push({
          documentID,
          itemID: Number(meta.itemID || 0),
          parentItemID: Number(meta.parentItemID || 0),
          title: String(meta.title || meta.sourceFileName || documentID),
          year: String(meta.year || ""),
          tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
          collections: Array.isArray(meta.collections) ? meta.collections.map(String) : [],
          parsed: Boolean(source),
          translated: Boolean(translation),
          sourceFingerprint: String(meta.sourceFingerprint || meta.updatedAt || ""),
          source,
          translation,
          blocks,
          updatedAt: String(meta.updatedAt || "")
        });
      }
      this.rows = documents;
      this.updatedAt = C.now();
      await this.storage.ensureDir(PathUtils.parent(this.path));
      await this.storage.writeJSON(this.path, { version: 2, backend: "json-fallback", updatedAt: this.updatedAt, documents });
      this.stale = false;
      return { rebuilt: true, backend: "json-fallback", documentCount: documents.length, updatedAt: this.updatedAt };
    }

    async ensureFresh() {
      if (this.stale || !this.rows.length) await this.rebuild();
    }

    async search(options = {}) {
      await this.ensureFresh();
      const query = lower(options.query).trim();
      if (!query) throw new C.AgentError("INVALID_QUERY", "搜索词不能为空", { recoverable: false });
      const tokens = query.split(/\s+/).filter(Boolean);
      const contentTypes = new Set((Array.isArray(options.contentTypes) ? options.contentTypes : []).map(String));
      const rows = [];
      for (const document of this.rows) {
        if (options.documentID && String(document.documentID) !== String(options.documentID)) continue;
        if (options.parsedOnly && !document.parsed) continue;
        if (options.translatedOnly && !document.translated) continue;
        if (options.year && String(document.year) !== String(options.year)) continue;
        if (options.collection && !document.collections.includes(String(options.collection))) continue;
        if (options.tag && !document.tags.includes(String(options.tag))) continue;
        const fields = [];
        if (!contentTypes.size || contentTypes.has("text")) fields.push(["text", document.source]);
        if (!contentTypes.size || contentTypes.has("translation")) fields.push(["translation", document.translation]);
        for (const block of document.blocks || []) {
          const blockType = block.kind === "image" ? "figure" : (block.kind === "table" ? "table" : (block.formula || /formula/i.test(block.type) ? "formula" : "text"));
          if (contentTypes.size && !contentTypes.has(blockType)) continue;
          fields.push([blockType, block.text || block.translation || "", block]);
        }
        const candidates = [];
        for (const [type, text, block] of fields) {
          const lowerText = lower(text);
          const matched = tokens.filter(token => lowerText.includes(token)).length;
          if (!matched) continue;
          const start = Math.max(0, lowerText.indexOf(tokens[0]));
          const score = matched / tokens.length;
          const candidate = {
            documentID: document.documentID,
            sourceFingerprint: document.sourceFingerprint || "",
            title: document.title,
            type,
              score,
              page: block?.page || null,
              blockID: block?.blockID || "",
              locator: block ? { documentID: document.documentID, page: block.page, blockID: block.blockID, type: block.type } : { documentID: document.documentID, type },
              snippet: C.safeText(String(text).slice(Math.max(0, start - 180), start + 520), 800)
          };
          candidates.push(candidate);
        }
        candidates.sort((a, b) => b.score - a.score || (a.blockID ? -1 : 1));
        const perDocumentLimit = Math.max(0, Number(options.perDocumentLimit || 0) || 0);
        if (perDocumentLimit) rows.push(...candidates.slice(0, perDocumentLimit));
        else if (candidates[0]) rows.push(candidates[0]);
      }
      rows.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
      return { backend: "json-fallback", query: options.query, indexUpdatedAt: this.updatedAt, total: rows.length, results: rows.slice(0, Math.min(200, Number(options.limit || 50))) };
    }
  }

  Agent.CorpusIndex = CorpusIndex;
})(this);
