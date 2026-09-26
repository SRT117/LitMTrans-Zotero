(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};
  const C = Agent.Contracts;

  function safeStem(value, fallback = "paper") {
    return LitMTrans.Utils?.safeStem?.(String(value || ""), 100, fallback)
      || String(value || fallback).replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").trim().slice(0, 100)
      || fallback;
  }

  class ExportService {
    constructor(controller, artifactService, library) {
      this.controller = controller;
      this.storage = controller.storage;
      this.artifact = artifactService;
      this.library = library;
      this.root = PathUtils.join(this.storage.root, "exports");
    }

    async init() {
      await this.storage.ensureDir(this.root);
    }

    async destination(value, stem) {
      const requested = String(value || "").trim();
      const root = requested || this.root;
      await this.storage.ensureDir(root);
      const folder = PathUtils.join(root, safeStem(stem, "paper"));
      await this.storage.ensureDir(folder);
      return folder;
    }

    async copyAsset(documentID, sourcePath, folder, name) {
      if (!sourcePath || !(await this.storage.exists(sourcePath))) return "";
      const target = PathUtils.join(folder, safeStem(name || PathUtils.filename(sourcePath), "asset"));
      await this.storage.copyFile(sourcePath, target);
      return target;
    }

    async bundle(ref, options = {}, emit = null) {
      const resolved = await this.artifact.snapshot(ref, options);
      const manifest = await this.artifact.manifestFromSnapshot(resolved);
      const folder = await this.destination(options.destination, resolved.context.title || resolved.context.documentID);
      const documentID = resolved.context.documentID;
      const parsed = resolved.snapshot.parsed || {};
      const translation = resolved.snapshot.translation || {};
      const model = resolved.snapshot.layout?.model || null;
      const blocks = this.artifact.blockRows(resolved);
      const figures = await this.artifact.listFigures(ref, options);
      const tables = await this.artifact.listTables(ref, options);
      const formulas = await this.artifact.listFormulas(ref, options);
      const files = [];
      const write = async (relative, value, binary = false) => {
        const path = PathUtils.join(folder, ...String(relative).replace(/\\/g, "/").split("/").filter(Boolean));
        await this.storage.ensureDir(PathUtils.parent(path));
        if (binary) await this.storage.writeBytes(path, value);
        else if (typeof value === "object") await this.storage.writeJSON(path, value);
        else await this.storage.writeText(path, value);
        files.push(path);
        return path;
      };
      await write("manifest.json", manifest);
      await write("metadata.json", C.redact({ documentID, title: resolved.context.title, itemKey: resolved.item?.key || "", attachmentKey: resolved.attachment?.key || "", sourceMeta: parsed.meta || {} }));
      await write("source.md", String(parsed.markdown || ""));
      await write("translation.md", String(translation.markdown || translation.live || ""));
      await write("layout/blocks.json", { documentID, pages: model?.pages || [], blocks });
      await write("formulas.json", formulas.formulas);
      await write("tables/index.json", tables.tables.map(table => ({ ...table, nearbyBlocks: undefined })));
      for (const table of tables.tables) {
        await write(`tables/${table.tableID}.md`, table.markdown || "");
        await write(`tables/${table.tableID}.csv`, table.csv || "");
      }
      const assetMap = parsed.assetMap || await this.storage.readJSON(this.storage.path(documentID, "asset-map.json"), {});
      for (const figure of figures.figures) {
        const sourcePath = figure.path || "";
        if (sourcePath && await this.storage.exists(sourcePath)) {
          const target = PathUtils.join(folder, "figures", `${figure.figureID}${String(sourcePath).match(/\.[a-z0-9]+$/i)?.[0] || ".bin"}`);
          await this.storage.ensureDir(PathUtils.parent(target));
          await this.storage.copyFile(sourcePath, target);
          files.push(target);
        }
      }
      for (const mode of ["paper_mindmap", "paper_logic_flow"]) {
        const diagram = await this.storage.readJSON(this.storage.path(documentID, "diagrams", `${mode}.json`), null);
        if (diagram) await write(`diagrams/${mode}.json`, diagram);
      }
      if (options.allowChatHistory === false) {
        await write("chat/index.json", { omitted: true, reason: "agentAllowChatHistory=false" });
      }
      else {
        const sessions = await this.controller.chat.listSessions(documentID).catch(() => []);
        await write("chat/index.json", sessions);
      }
      const research = [];
      for (const file of await this.storage.list(this.storage.root + "/research")) {
        if (!/\.json$/i.test(file)) continue;
        const value = await this.storage.readJSON(file, null);
        if (value && (value.documentIDs || []).includes(documentID)) research.push(value);
      }
      await write("research/index.json", research);
      emit?.({ type: "progress", phase: "export-bundle", progress: 100, message: "Research Bundle 导出完成" });
      return { outputPath: folder, documentID, files, manifest };
    }

    async collectionWorkspace(options = {}, emit = null) {
      const collection = options.collection || options.collectionID || options.collectionKey;
      if (!collection) throw new C.AgentError("COLLECTION_REQUIRED", "导出 Collection Workspace 需要指定 Collection", { recoverable: false });
      const listing = await this.library.collectAllCollectionItems(collection, { ...options, includeStatus: false, pageSize: options.pageSize || 100 });
      const root = await this.destination(options.destination, options.name || listing.collection.path || listing.collection.name || "collection");
      const index = { name: options.name || listing.collection.name, collection: listing.collection, createdAt: C.now(), papers: [] };
      for (let indexNumber = 0; indexNumber < listing.items.length; indexNumber++) {
        const item = listing.items[indexNumber];
        try {
          const output = await this.bundle(item.attachmentKey || item.key, { ...options, destination: PathUtils.join(root, `paper-${String(indexNumber + 1).padStart(3, "0")}`) }, event => emit?.({ ...event, progress: Math.round((indexNumber / Math.max(1, listing.items.length)) * 100) }));
          index.papers.push({ itemKey: item.key, title: item.title, documentID: output.documentID, path: output.outputPath });
        }
        catch (error) {
          index.papers.push({ itemKey: item.key, title: item.title, error: C.asAgentError(error).toJSON() });
        }
      }
      await this.storage.writeJSON(PathUtils.join(root, "index.json"), index);
      return { outputPath: root, index };
    }

    async exportFile(ref, kind, options = {}) {
      const resolved = await this.artifact.resolve(ref, options);
      const folder = await this.destination(options.destination, resolved.context.title || resolved.context.documentID);
      const safeKind = String(kind || "source-markdown");
      if (safeKind === "research-bundle") return this.bundle(ref, { ...options, destination: options.destination });
      if (safeKind === "source-markdown" || safeKind === "translation-markdown") {
        const source = safeKind === "source-markdown"
          ? await this.artifact.readSource(ref, options)
          : await this.artifact.readTranslation(ref, options);
        const path = PathUtils.join(folder, safeKind === "source-markdown" ? "source.md" : "translation.md");
        await this.storage.writeText(path, source.text || "");
        return { outputPath: path, documentID: resolved.context.documentID, kind: safeKind };
      }
      if (safeKind === "original-pdf" || safeKind === "original-file") {
        const ext = LitMTrans.Utils.extension(resolved.context.filePath) || ".bin";
        const path = PathUtils.join(folder, `original${ext}`);
        await this.storage.copyFile(resolved.context.filePath, path);
        return { outputPath: path, documentID: resolved.context.documentID, kind: safeKind };
      }
      if (safeKind === "document-images") {
        const figures = await this.artifact.listFigures(ref, options);
        const output = [];
        for (const figure of figures.figures) {
          if (!figure.path) continue;
          const path = PathUtils.join(folder, "figures", `${figure.figureID}${String(figure.path).match(/\.[a-z0-9]+$/i)?.[0] || ".bin"}`);
          await this.storage.ensureDir(PathUtils.parent(path));
          await this.storage.copyFile(figure.path, path);
          output.push(path);
        }
        return { outputPath: folder, documentID: resolved.context.documentID, kind: safeKind, files: output };
      }
      throw new C.AgentError("EXPORT_KIND_UNSUPPORTED", `不支持的导出类型 ${safeKind}`, { recoverable: false });
    }
  }

  Agent.ExportService = ExportService;
})(this);
