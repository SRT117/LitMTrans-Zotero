(function (global) {
  "use strict";

  const L = global.LitMTrans = global.LitMTrans || {};
  const U = L.Utils;
  const ARTIFACTS = ["images", "assets", "mineru-result", "parser-source", "full.md", "full.cleaned.md", "layout.json",
    "model.json", "content-list.json", "asset-map.json", "image-map.json", "mineru-task.json", "document.json",
    "layout-revision.json", "parse-info.json", "parsed-document.v1.json", "translation", "layout-translation",
    "compiled-model.json", "compiled-model.v13.json", "compiled-model.paddle-lines.v1.json",
    "line-geometry.v1.json", "paddle-line-task.json", "fit"];

  function parseRevisionID(documentID, meta = {}) {
    return String(meta?.parseRevisionID || `legacy-${U.hashString([documentID, meta?.parseIdentity || meta?.sourceIdentity || "", meta?.parsedAt || ""].join("|"))}`);
  }

  class DocumentParserService {
    constructor(storage, secrets, mineru = null, paddle = null) {
      this.storage = storage;
      this.secrets = secrets;
      this.mineru = mineru || new L.MinerUService(storage, secrets);
      this.paddle = paddle || new L.PaddleService(storage, secrets);
      this.active = new Set();
    }

    options(values = {}) {
      const provider = String(values.parseProvider || U.getPref("parseProvider", "mineru"));
      if (!["mineru", "paddle"].includes(provider)) throw new Error("不支持所选文献解析服务");
      return { ...values, parseProvider: provider,
        parseModel: provider === "paddle" ? String(values.parseModel || U.getPref("paddleModel", "PaddleOCR-VL-1.6")) : "",
        modelVersion: values.modelVersion || "vlm" };
    }

    async loadParsed(itemOrID) {
      const documentID = typeof itemOrID === "string" ? itemOrID : this.storage.documentID(itemOrID);
      if (!this.active.has(documentID)) await this.recover(documentID);
      const [markdown, meta, hasLayout, layoutRevision, imageMap, assetMap] = await Promise.all([
        this.storage.readText(this.storage.path(documentID, "full.cleaned.md"), ""),
        this.storage.getDocumentMeta(documentID), this.storage.exists(this.storage.path(documentID, "layout.json")),
        this.storage.readJSON(this.storage.path(documentID, "layout-revision.json"), null),
        this.storage.readJSON(this.storage.path(documentID, "image-map.json"), []),
        this.storage.readJSON(this.storage.path(documentID, "asset-map.json"), {})
      ]);
      return { documentID, markdown, meta: meta ? { ...meta, parseRevisionID: parseRevisionID(documentID, meta) } : meta,
        hasLayout, layoutRevision, imageMap, assetMap };
    }

    async copyEntry(source, destination) {
      const stat = await this.storage.stat(source);
      if (!stat) return;
      if (stat.type === "directory") await this.storage.copyTree(source, destination);
      else await this.storage.copyFile(source, destination);
    }

    async archive(documentID) {
      if (!await this.storage.exists(this.storage.path(documentID, "full.cleaned.md"))) return null;
      const name = U.randomID("parse").replace(/[^A-Za-z0-9_-]/g, "");
      const root = this.storage.path(documentID, "parser-history", name);
      await this.storage.ensureDir(root);
      try {
        for (const file of ARTIFACTS) await this.copyEntry(this.storage.path(documentID, file), PathUtils.join(root, file));
        const meta = await this.storage.getDocumentMeta(documentID);
        await this.storage.writeJSON(PathUtils.join(root, "archive.json"), {
          version: 2, complete: true, parseRevisionID: parseRevisionID(documentID, meta),
          provider: meta?.parseProvider || "mineru", model: meta?.parseModel || "vlm", createdAt: new Date().toISOString()
        });
      }
      catch (error) { await this.storage.remove(root, true); throw error; }
      return name;
    }

    async recover(documentID) {
      const path = this.storage.path(documentID, "parser-publication.json");
      const pending = await this.storage.readJSON(path, null);
      if (!pending) return;
      if (!/^[A-Za-z0-9_-]+$/.test(pending.archive || "")) throw new Error("文献解析恢复记录无效，请保留本地缓存后联系开发者");
      const root = this.storage.path(documentID, "parser-history", pending.archive);
      const archive = await this.storage.readJSON(PathUtils.join(root, "archive.json"), null);
      if (!archive?.complete) throw new Error("旧解析备份不完整，已停止覆盖文献数据");
      const temporary = this.storage.temporaryDir("parse-restore");
      try {
        for (const file of ARTIFACTS) await this.copyEntry(PathUtils.join(root, file), PathUtils.join(temporary, file));
        await this.storage.publishEntriesAtomically(ARTIFACTS.map(file => ({ source: PathUtils.join(temporary, file), destination: this.storage.path(documentID, file) })),
          this.storage.path(documentID, ".parser-restore-rollback"));
        await this.storage.removeFile(path);
        // 仅删除本轮已成功回滚的备份；成功解析留下的历史继续保留。
        if (archive.version === 2) await this.storage.remove(root, true);
      }
      finally { await this.storage.remove(temporary, true); }
    }

    async withServiceHint(provider, emit, signal, run) {
      try { return await run(); }
      catch (error) {
        if (!error.cancelled && !signal?.aborted) {
          const alternative = provider === "paddle" ? "MinerU" : "Paddle";
          error.message = `${error.message || error}；可在设置中将解析服务切换为 ${alternative} 后重试`;
          emit?.({ type: "progress", phase: "parser-service-error", progress: null,
            message: `解析失败：${error.message}` });
        }
        throw error;
      }
    }

    async parse(item, filePath, values = {}, emit = null, signal = null) {
      const documentID = this.storage.documentID(item);
      if (this.active.has(documentID)) throw new Error("此文献正在解析，请等待当前任务结束");
      this.active.add(documentID);
      let archive = null;
      try {
        await this.recover(documentID);
        const options = this.options(values);
        const existing = await this.storage.getDocumentMeta(documentID);
        const sourceIdentity = await this.storage.sourceIdentity(item, filePath);
        if (!options.force && existing?.sourceIdentity === sourceIdentity
          && await this.storage.exists(this.storage.path(documentID, "full.cleaned.md"))) {
          emit?.({ type: "progress", phase: "cache", progress: 100, message: "已读取文献解析结果" });
          return this.loadParsed(documentID);
        }
        if (options.parseProvider === "paddle" && U.extension(filePath) !== ".pdf") {
          throw new Error("Paddle解析目前支持PDF文件，请将此文件转换为PDF后重试");
        }
        U.throwIfAborted(signal);
        archive = await this.archive(documentID);
        if (archive) await this.storage.writeJSON(this.storage.path(documentID, "parser-publication.json"), { version: 1, archive });
        let result;
        if (options.parseProvider === "mineru") {
          result = await this.withServiceHint("mineru", emit, signal,
            () => this.mineru.parse(item, filePath, options, emit, signal));
          for (const name of ["paddle-task.json", "parsed-document.v1.json", "parser-source", "compiled-model.json", "compiled-model.v13.json",
            "compiled-model.paddle-lines.v1.json", "line-geometry.v1.json", "paddle-line-task.json", "fit"]) {
            await this.storage.remove(this.storage.path(documentID, name), true);
          }
          const parseModel = String(options.modelVersion || "vlm");
          const revision = U.randomID("parse");
          await this.storage.setDocumentMeta(documentID, { parseProvider: "mineru", parseModel, parseRevisionID: revision, layoutPDFIdentity: "" });
          await this.storage.writeJSON(this.storage.path(documentID, "parse-info.json"), {
            version: 1, provider: "mineru", model: parseModel, apiProtocol: "mineru-v4", parseRevisionID: revision
          });
          result = await this.loadParsed(documentID);
        }
        else result = await this.withServiceHint("paddle", emit, signal,
          () => this.parsePaddle(item, filePath, { ...options, sourceIdentity }, emit, signal));
        await this.storage.removeFile(this.storage.path(documentID, "parser-publication.json"));
        return result;
      }
      catch (error) {
        if (archive) {
          try { await this.recover(documentID); }
          catch (restoreError) { throw new Error(`${error.message}；旧数据恢复尚未完成：${restoreError.message}`); }
        }
        throw error;
      }
      finally { this.active.delete(documentID); }
    }

    async parsePaddle(item, filePath, options, emit, signal) {
      const { id: documentID, dir } = await this.storage.ensureDocument(item);
      const stage = this.storage.temporaryDir("paddle");
      const taskPath = this.storage.path(documentID, "paddle-task.json");
      await this.storage.ensureDir(stage);
      try {
        const result = await this.paddle.prepare(filePath, stage, options, emit, signal, taskPath);
        const parsedAt = new Date().toISOString();
        const meta = { ...(await this.storage.getDocumentMeta(documentID) || {}), documentID,
          itemID: item.id, libraryID: item.libraryID, itemKey: item.key, parentItemID: item.parentID || null,
          parentItemKey: item.parentKey || "", sourceIdentity: options.sourceIdentity,
          sourceFileName: PathUtils.filename(filePath), sourcePath: filePath,
          parseProvider: "paddle", parseModel: result.model, parseRevisionID: U.randomID("parse"), parsedAt, updatedAt: parsedAt,
          layoutPDFIdentity: "",
          parseIdentity: U.hashString(`${options.sourceIdentity}|paddle|${result.model}|1`),
          hasLayout: true, imageCount: result.imageMap.length };
        delete meta.autoSplit;
        delete meta.partCount;
        const layout = await this.storage.readText(PathUtils.join(stage, "layout.json"), "");
        await this.storage.writeJSON(PathUtils.join(stage, "document.json"), meta);
        await this.storage.writeJSON(PathUtils.join(stage, "parse-info.json"), {
          version: 1, provider: "paddle", model: result.model, parseRevisionID: meta.parseRevisionID, apiProtocol: result.document.apiProtocol,
          resultSchema: result.document.resultSchema, adapterVersion: result.document.adapterVersion, jobID: result.task.jobID
        });
        await this.storage.writeJSON(PathUtils.join(stage, "layout-revision.json"), {
          version: 1, sourceFingerprint: U.hashString(layout), assetMapHash: U.hashString(JSON.stringify(result.assetMap)), generatedAt: parsedAt
        });
        U.throwIfAborted(signal);
        await this.storage.publishEntriesAtomically(ARTIFACTS.map(name => ({ source: PathUtils.join(stage, name), destination: PathUtils.join(dir, name) })),
          PathUtils.join(dir, ".paddle-rollback"));
        await this.storage.writeJSON(taskPath, { ...result.task, state: "published" });
        emit?.({ type: "progress", phase: "done", progress: 100, message: "解析完成" });
        return this.loadParsed(documentID);
      }
      finally { await this.storage.remove(stage, true); }
    }

    async parseExternalReference(filePath, cacheRoot, values = {}, emit = null, signal = null) {
      const options = this.options(values);
      if (options.parseProvider === "mineru") return this.withServiceHint("mineru", emit, signal,
        () => this.mineru.parseExternalReference(filePath, cacheRoot, options, emit, signal));
      const stat = await this.storage.stat(filePath);
      if (!stat || stat.type === "directory") throw new Error("参考文件不存在");
      const identity = U.hashString(["paddle", filePath, stat.size, stat.lastModified, options.parseModel, 1].join("|"));
      const root = PathUtils.join(cacheRoot, identity);
      const markdownPath = PathUtils.join(root, "reference.md");
      const cached = await this.storage.readText(markdownPath, "");
      if (!options.force && cached) return { markdown: cached, identity, root, cached: true,
        meta: await this.storage.readJSON(PathUtils.join(root, "reference.json"), {}),
        imageMap: await this.storage.readJSON(PathUtils.join(root, "image-map.json"), []) };
      const stage = this.storage.temporaryDir("paddle-reference");
      try {
        await this.storage.ensureDir(stage);
        const result = await this.withServiceHint("paddle", emit, signal,
          () => this.paddle.prepare(filePath, stage, { ...options, sourceIdentity: identity }, emit, signal, PathUtils.join(root, "paddle-task.json")));
        const meta = { identity, parseProvider: "paddle", parseModel: result.model, parsedAt: new Date().toISOString(), sourceName: PathUtils.filename(filePath) };
        await this.storage.writeText(PathUtils.join(stage, "reference.md"), result.markdown);
        await this.storage.writeJSON(PathUtils.join(stage, "reference.json"), meta);
        await this.storage.publishEntriesAtomically(["images", "asset-map.json", "image-map.json", "reference.md", "reference.json", "parser-source"].map(name => ({
          source: PathUtils.join(stage, name), destination: PathUtils.join(root, name)
        })), PathUtils.join(root, ".paddle-rollback"));
        await this.storage.removeFile(PathUtils.join(root, "paddle-task.json"));
        return { markdown: result.markdown, identity, root, cached: false, meta, imageMap: result.imageMap };
      }
      finally { await this.storage.remove(stage, true); }
    }
  }

  for (const name of ["parse", "loadParsed", "parseExternalReference", "recover"]) {
    const run = DocumentParserService.prototype[name];
    DocumentParserService.prototype[name] = async function (...args) {
      const release = this.storage.beginActivity?.();
      try { return await run.apply(this, args); }
      finally { release?.(); }
    };
  }

  L.DocumentParserService = DocumentParserService;
  L.ParserLineage = { parseRevisionID };
})(this);
