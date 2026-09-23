(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const U = LitMTrans.Utils;

  const PAGE_CACHE_ALERT_THRESHOLD_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5 GB
  const PAGE_CACHE_ALERT_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // 3 天

  function classifyDocumentRootFile(name) {
    if (name === "document.json") return "metadata";
    if (name === "asset-map.json" || name === "image-map.json") return "images";
    if (name === "mineru-task.json") return "mineruResult";
    if (name.endsWith(".json") || name.endsWith(".md")) return "model";
    return "other";
  }

  class Storage {
    constructor() {
      this.root = PathUtils.join(Zotero.Profile.dir, "litmtrans");
      this.legacyRoot = PathUtils.join(Zotero.Profile.dir, "ai-literature-translator");
      this.documentsRoot = PathUtils.join(this.root, "documents");
      // ZIP extraction can create deeply nested MinerU asset paths. Keep the
      // transient workspace outside the document hierarchy so Windows path
      // limits do not depend on the user's profile/project location.
      this.tempRoot = PathUtils.join(Zotero.Profile.dir, "litmtrans-tmp");
      this._resourceRegistered = false;
      this._appendQueues = new Map();
    }

    async init() {
      await this.migrateLegacyRoot();
      await this.ensureDir(this.root);
      await this.ensureDir(this.documentsRoot);
      await this.ensureDir(this.tempRoot);
      const handler = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
      handler.setSubstitution(
        "litmtrans-data",
        Services.io.newFileURI(U.createLocalFile(this.documentsRoot))
      );
      // Keep serialized resource URLs from earlier builds readable.
      handler.setSubstitution(
        "ai-literature-translator-data",
        Services.io.newFileURI(U.createLocalFile(this.documentsRoot))
      );
      this._resourceRegistered = true;
    }

    async migrateLegacyRoot() {
      if (!await this.exists(this.legacyRoot)) return;
      if (!await this.exists(this.root)) {
        try {
          await IOUtils.move(this.legacyRoot, this.root, { noOverwrite: true });
          return;
        }
        catch (_) {
          // Fall through to a non-destructive merge if a host or filesystem
          // prevents moving the directory as a unit.
        }
      }
      await this.mergeMissingTree(this.legacyRoot, this.root);
    }

    async mergeMissingTree(source, destination) {
      const info = await this.stat(source);
      if (!info) return;
      if (info.type !== "directory") {
        if (!await this.exists(destination)) await this.copyFile(source, destination);
        return;
      }
      await this.ensureDir(destination);
      for (const child of await this.list(source)) {
        await this.mergeMissingTree(child, PathUtils.join(destination, PathUtils.filename(child)));
      }
    }

    shutdown() {
      if (!this._resourceRegistered) return;
      try {
        const handler = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
        handler.setSubstitution("litmtrans-data", null);
        handler.setSubstitution("ai-literature-translator-data", null);
      }
      catch (_) {}
      this._resourceRegistered = false;
    }

    async exists(path) {
      try {
        return await IOUtils.exists(path);
      }
      catch (_) {
        return false;
      }
    }

    async ensureDir(path) {
      await IOUtils.makeDirectory(path, { createAncestors: true, ignoreExisting: true });
      return path;
    }

    async readText(path, fallback = "") {
      try {
        if (!(await this.exists(path))) return fallback;
        return await IOUtils.readUTF8(path);
      }
      catch (_) {
        return fallback;
      }
    }

    async writeText(path, text) {
      await this.ensureDir(PathUtils.parent(path));
      await IOUtils.writeUTF8(path, String(text ?? ""), { mode: "overwrite" });
      return path;
    }

    async appendText(path, text) {
      const key = String(path || "");
      // Reasoning arrives as small streaming deltas. Serialize appends for a
      // file so concurrent layout groups cannot interleave or overwrite them.
      const previous = this._appendQueues.get(key) || Promise.resolve();
      const task = previous.catch(() => {}).then(async () => {
        await this.ensureDir(PathUtils.parent(path));
        // IOUtils append mode does not create a missing file. The first
        // record must therefore establish it before later queued appends.
        const mode = await this.exists(path) ? "append" : "overwrite";
        await IOUtils.writeUTF8(path, String(text ?? ""), { mode });
        return path;
      });
      this._appendQueues.set(key, task);
      try {
        return await task;
      }
      finally {
        if (this._appendQueues.get(key) === task) this._appendQueues.delete(key);
      }
    }

    async readJSON(path, fallback = null) {
      try {
        const text = await this.readText(path, "");
        if (!text) return fallback;
        return JSON.parse(text);
      }
      catch (_) {
        return fallback;
      }
    }

    async writeJSON(path, value) {
      return this.writeText(path, JSON.stringify(value, null, 2));
    }

    async removeFile(path) {
      try {
        await IOUtils.remove(path, { ignoreAbsent: true });
        return true;
      }
      catch (_) {
        return false;
      }
    }

    async readBytes(path) {
      return IOUtils.read(path);
    }

    async writeBytes(path, bytes) {
      await this.ensureDir(PathUtils.parent(path));
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      await IOUtils.write(path, data, { mode: "overwrite" });
      return path;
    }

    async copyFile(source, destination) {
      const bytes = await this.readBytes(source);
      return this.writeBytes(destination, bytes);
    }

    async copyTree(source, destination) {
      const info = await this.stat(source);
      if (!info) throw new Error(`Source path does not exist: ${source}`);
      if (info.type !== "directory") return this.copyFile(source, destination);
      await this.ensureDir(destination);
      for (const child of await this.list(source)) {
        await this.copyTree(child, PathUtils.join(destination, PathUtils.filename(child)));
      }
      return destination;
    }

    async publishFilesAtomically(files) {
      const rows = (Array.isArray(files) ? files : [])
        .filter(row => row?.source && row?.destination);
      const backups = [];
      const published = [];
      try {
        for (const row of rows) {
          const existed = await this.exists(row.destination);
          backups.push({
            destination: row.destination,
            existed,
            bytes: existed ? await this.readBytes(row.destination) : null
          });
        }
        for (const row of rows) {
          await this.ensureDir(PathUtils.parent(row.destination));
          await IOUtils.move(row.source, row.destination, { noOverwrite: false });
          published.push(row.destination);
        }
      }
      catch (error) {
        for (let index = backups.length - 1; index >= 0; index--) {
          const backup = backups[index];
          try {
            if (backup.existed) await this.writeBytes(backup.destination, backup.bytes);
            else if (published.includes(backup.destination)) await this.remove(backup.destination, false);
          }
          catch (_) {}
        }
        throw error;
      }
      return rows.map(row => row.destination);
    }

    async publishEntriesAtomically(entries, rollbackRoot) {
      const rows = (Array.isArray(entries) ? entries : [])
        .filter(row => row?.source && row?.destination);
      if (!rows.length) return [];
      if (!rollbackRoot) throw new Error("Atomic entry publication requires a rollback directory");
      await this.remove(rollbackRoot, true);
      await this.ensureDir(rollbackRoot);
      const backups = [];
      const published = [];
      let rollbackClean = true;
      try {
        // Move the current generation out of the way first. Files and whole
        // directories stay recoverable without loading large MinerU assets
        // into memory.
        for (let index = 0; index < rows.length; index++) {
          const row = rows[index];
          if (!await this.exists(row.destination)) continue;
          const backup = PathUtils.join(
            rollbackRoot,
            `${String(index).padStart(3, "0")}-${PathUtils.filename(row.destination)}`
          );
          await IOUtils.move(row.destination, backup, { noOverwrite: true });
          backups.push({ destination: row.destination, backup });
        }
        // Missing staging entries intentionally mean that an optional artifact
        // (for example layout.json) is absent in the new parse generation.
        for (const row of rows) {
          if (!await this.exists(row.source)) continue;
          await this.ensureDir(PathUtils.parent(row.destination));
          await IOUtils.move(row.source, row.destination, { noOverwrite: true });
          published.push(row.destination);
        }
      }
      catch (error) {
        for (const destination of [...published].reverse()) {
          try { await IOUtils.remove(destination, { recursive: true, ignoreAbsent: true }); }
          catch (_) { rollbackClean = false; }
        }
        for (const record of [...backups].reverse()) {
          try {
            if (await this.exists(record.backup)) {
              await IOUtils.move(record.backup, record.destination, { noOverwrite: true });
            }
          }
          catch (_) { rollbackClean = false; }
        }
        throw error;
      }
      finally {
        if (rollbackClean) await this.remove(rollbackRoot, true);
      }
      return published;
    }

    async remove(path, recursive = false) {
      try {
        await IOUtils.remove(path, { recursive, ignoreAbsent: true });
      }
      catch (_) {}
    }

    async stat(path) {
      try {
        return await IOUtils.stat(path);
      }
      catch (_) {
        return null;
      }
    }

    async list(path) {
      try {
        return await IOUtils.getChildren(path);
      }
      catch (_) {
        return [];
      }
    }

    async walk(root) {
      const output = [];
      const visit = async (path) => {
        const entries = await this.list(path);
        for (const entry of entries) {
          const info = await this.stat(entry);
          if (!info) continue;
          if (info.type === "directory") await visit(entry);
          else output.push(entry);
        }
      };
      if (await this.exists(root)) await visit(root);
      return output;
    }

    documentID(item) {
      const libraryID = Number(item?.libraryID || 0);
      const key = String(item?.key || item?.id || "unknown");
      return `${libraryID}-${key}`;
    }

    parseDocumentID(documentID) {
      const match = String(documentID || "").match(/^(\d+)-([A-Za-z0-9]+)$/);
      if (!match) return null;
      return { libraryID: Number(match[1]), key: match[2] };
    }

    resolveDocumentItem(documentID, meta = {}) {
      const itemID = Number(meta?.itemID || 0);
      if (itemID) {
        try {
          const item = Zotero.Items.get(itemID);
          if (item && !item.deleted) return item;
        }
        catch (_) {}
      }
      const parsed = this.parseDocumentID(documentID);
      if (!parsed) return null;
      try {
        const item = Zotero.Items.getByLibraryAndKey?.(parsed.libraryID, parsed.key);
        if (typeof item === "number") {
          const resolved = Zotero.Items.get(item);
          return resolved && !resolved.deleted ? resolved : null;
        }
        return item && !item.deleted ? item : null;
      }
      catch (_) {
        return null;
      }
    }

    documentDir(itemOrID) {
      const id = typeof itemOrID === "string" ? itemOrID : this.documentID(itemOrID);
      return PathUtils.join(this.documentsRoot, id);
    }

    path(itemOrID, ...parts) {
      return PathUtils.join(this.documentDir(itemOrID), ...parts);
    }

    temporaryDir(label = "run") {
      const safeLabel = String(label || "run").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8) || "run";
      const suffix = U.randomID("").replace(/[^A-Za-z0-9]/g, "").slice(-10);
      return PathUtils.join(this.tempRoot, `${safeLabel}-${suffix}`);
    }

    resourceURL(itemOrID, relativePath = "") {
      const id = typeof itemOrID === "string" ? itemOrID : this.documentID(itemOrID);
      return U.resourceURL(id, relativePath);
    }

    async sourceIdentity(item, filePath) {
      const stat = await this.stat(filePath);
      const payload = [
        item?.libraryID || 0,
        item?.key || item?.id || "",
        filePath,
        stat?.size || 0,
        stat?.lastModified || 0
      ].join("|");
      return U.hashString(payload);
    }

    async ensureDocument(item) {
      const id = this.documentID(item);
      const dir = this.documentDir(id);
      await this.ensureDir(dir);
      await this.ensureDir(PathUtils.join(dir, "images"));
      await this.ensureDir(PathUtils.join(dir, "translation"));
      await this.ensureDir(PathUtils.join(dir, "layout-translation"));
      await this.ensureDir(PathUtils.join(dir, "chat"));
      return { id, dir };
    }

    async getDocumentMeta(itemOrID) {
      return this.readJSON(this.path(itemOrID, "document.json"), null);
    }

    async setDocumentMeta(itemOrID, patch) {
      const current = await this.getDocumentMeta(itemOrID) || {};
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
      await this.writeJSON(this.path(itemOrID, "document.json"), next);
      return next;
    }

    async clearDocument(itemOrID) {
      const pageStats = await this.deepSeekWebPagesStatsAtDocumentDir?.(this.documentDir(itemOrID)) || { bytes: 0 };
      await this.remove(this.documentDir(itemOrID), true);
      if (pageStats.bytes > 0) this.adjustDeepSeekWebPagesCacheBytes?.(-pageStats.bytes);
    }

    // Zotero's item-deletion notification is delivered after the item may no
    // longer be retrievable.  Match persisted identity metadata instead of
    // asking Zotero.Items for a deleted attachment or its parent.
    async clearDocumentsForDeletedItemIDs(itemIDs) {
      const deleted = new Set((Array.isArray(itemIDs) ? itemIDs : [itemIDs])
        .map(value => Number(value))
        .filter(Number.isFinite));
      if (!deleted.size) return [];
      const cleared = [];
      for (const directory of await this.list(this.documentsRoot)) {
        const meta = await this.readJSON(PathUtils.join(directory, "document.json"), null);
        if (!meta) continue;
        const identities = [meta.itemID, meta.parentItemID]
          .map(value => Number(value))
          .filter(Number.isFinite);
        if (!identities.some(id => deleted.has(id))) continue;
        const pageStats = await this.deepSeekWebPagesStatsAtDocumentDir?.(directory) || { bytes: 0 };
        await this.remove(directory, true);
        if (pageStats.bytes > 0) this.adjustDeepSeekWebPagesCacheBytes?.(-pageStats.bytes);
        cleared.push(PathUtils.filename(directory));
      }
      return cleared;
    }

    async findDocumentIDsForItemIDs(itemIDs) {
      return (await this.findDocumentRecordsForItemIDs(itemIDs)).map(record => record.documentID);
    }

    async findDocumentRecordsForItemIDs(itemIDs) {
      const deleted = new Set((Array.isArray(itemIDs) ? itemIDs : [itemIDs])
        .map(value => Number(value))
        .filter(Number.isFinite));
      if (!deleted.size || !await this.exists(this.documentsRoot)) return [];
      const matches = [];
      for (const directory of await this.list(this.documentsRoot)) {
        const info = await this.stat(directory);
        if (!info || info.type !== "directory") continue;
        const meta = await this.readJSON(PathUtils.join(directory, "document.json"), null);
        const identities = [meta?.itemID, meta?.parentItemID]
          .map(value => Number(value))
          .filter(Number.isFinite);
        const matchedItemIDs = identities.filter(id => deleted.has(id));
        if (matchedItemIDs.length) matches.push({
          documentID: PathUtils.filename(directory),
          itemID: Number(meta?.itemID || 0) || null,
          parentItemID: Number(meta?.parentItemID || 0) || null,
          matchedItemIDs
        });
      }
      return matches;
    }

    async clearTranslation(itemOrID, kind = "all") {
      if (kind === "all" || kind === "stream") {
        await this.remove(this.path(itemOrID, "translation"), true);
        await this.ensureDir(this.path(itemOrID, "translation"));
      }
      if (kind === "all" || kind === "layout") {
        await this.remove(this.path(itemOrID, "layout-translation"), true);
        await this.ensureDir(this.path(itemOrID, "layout-translation"));
      }
    }

    processLogPath(itemOrID) {
      return this.path(itemOrID, "logs", "translation-events.jsonl");
    }

    async appendProcessLog(itemOrID, entry) {
      const record = {
        at: new Date().toISOString(),
        ...entry
      };
      await this.appendText(this.processLogPath(itemOrID), JSON.stringify(record) + "\n");
      return record;
    }

    async readProcessLog(itemOrID, limit = 300) {
      const text = await this.readText(this.processLogPath(itemOrID), "");
      const maximum = Math.max(1, Math.min(2000, Number(limit) || 300));
      const records = text.split(/\r?\n/)
        .filter(Boolean)
        .map(line => {
          try { return JSON.parse(line); }
          catch (_) { return null; }
        })
        .filter(Boolean);
      // Older builds wrote one record per streamed token. Present contiguous
      // fragments as a single normal reasoning message when reading them.
      const merged = [];
      for (const record of records) {
        const previous = merged.at(-1);
        if (
          record.type === "reasoning" &&
          previous?.type === "reasoning" &&
          previous.mode === record.mode &&
          previous.scope === record.scope &&
          previous.group === record.group
        ) {
          previous.text = String(previous.text || "") + String(record.text || "");
          previous.at = record.at || previous.at;
        }
        else merged.push(record);
      }
      return merged.slice(-maximum);
    }

    async writeRequestAudit(itemOrID, requestKind, config, messages, timeoutSeconds) {
      if (!U.getPref("requestAudit", false)) return null;
      const directory = this.path(itemOrID, "AI请求审计");
      await this.ensureDir(directory);
      const now = new Date();
      const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 17);
      const safeKind = U.safeStem(String(requestKind || "翻译请求"), 80, "翻译请求");
      const path = PathUtils.join(directory, `${safeKind}-${stamp}-${U.randomID("audit").slice(-8)}.txt`);
      const body = [
        "LitMTrans请求记录（不含API密钥）",
        `时间: ${now.toISOString()}`,
        `请求类型: ${requestKind}`,
        `提供商: ${config?.provider || ""}`,
        `模型: ${config?.model || ""}`,
        `接口地址: ${config?.baseURL || ""}`,
        `请求缓存标识: ${config?.promptCacheKey || ""}`,
        `超时秒数: ${Number(timeoutSeconds) || 0}`,
        `消息数: ${Array.isArray(messages) ? messages.length : 0}`,
        ""
      ];
      for (let index = 0; index < (messages || []).length; index++) {
        const message = messages[index] || {};
        body.push(`===== MESSAGE ${index + 1} | role=${String(message.role || "")} =====`);
        body.push(typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2));
        body.push("");
      }
      await this.writeText(path, body.join("\n"));
      return path;
    }

    formatBytes(bytes) {
      const n = Number(bytes) || 0;
      if (n <= 0) return "0 B";
      const units = ["B", "KB", "MB", "GB", "TB"];
      const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
      const val = n / Math.pow(1024, i);
      return `${val < 10 && i > 0 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
    }

    async dirStats(dirPath) {
      let bytes = 0;
      let files = 0;
      const visit = async (current) => {
        const entries = await this.list(current);
        for (const entry of entries) {
          const info = await this.stat(entry);
          if (!info) continue;
          if (info.type === "directory") {
            await visit(entry);
          } else {
            bytes += Number(info.size || 0);
            files++;
          }
        }
      };
      if (await this.exists(dirPath)) {
        await visit(dirPath);
      }
      return { bytes, files, formatted: this.formatBytes(bytes) };
    }

    async deepSeekWebPagesStatsAtDocumentDir(docDir) {
      const webDir = PathUtils.join(docDir, "deepseek-web");
      let bytes = 0;
      let files = 0;
      if (!await this.exists(webDir)) return { bytes, files };
      for (const entry of await this.list(webDir)) {
        const name = PathUtils.filename(entry);
        const info = await this.stat(entry);
        if (!info) continue;
        if (info.type === "directory" && name.startsWith("pages-")) {
          const stats = await this.dirStats(entry);
          bytes += stats.bytes;
          files += stats.files;
        } else if (info.type !== "directory" && (name.startsWith("pages-") || name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".png"))) {
          bytes += Number(info.size || 0);
          files++;
        }
      }
      return { bytes, files };
    }

    async getStorageSummary() {
      const documents = [];
      let documentsTotalBytes = 0;
      let deepseekWebTotalBytes = 0;
      let deepseekWebTotalFiles = 0;
      let cajTotalBytes = 0;
      let cajDocumentCount = 0;
      let orphanedCount = 0;
      let orphanedTotalBytes = 0;
      let orphanedDeepSeekWebBytes = 0;
      let orphanedCajBytes = 0;

      if (await this.exists(this.documentsRoot)) {
        const docDirs = await this.list(this.documentsRoot);
        for (const docDir of docDirs) {
          const info = await this.stat(docDir);
          if (!info || info.type !== "directory") continue;
          const documentID = PathUtils.filename(docDir);
          const meta = await this.readJSON(PathUtils.join(docDir, "document.json"), null);
          const cajMeta = await this.readJSON(PathUtils.join(docDir, "caj-source", "source.meta.json"), null);

          // 递归分类分析该文献内部各子目录与文件
          const categories = {
            images: {
              bytes: 0,
              files: 0,
              label: "图片与排版素材",
              key: "images",
              desc: "从 PDF 中高保真提取的图表图像、公式切片以及排版视图渲染所需的图片资源。"
            },
            model: {
              bytes: 0,
              files: 0,
              label: "版面解析与模型",
              key: "model",
              desc: "MinerU 识别的几何版面坐标、段落分栏流、阅读顺序以及编译渲染模型与全文。"
            },
            translation: {
              bytes: 0,
              files: 0,
              label: "双语译文数据",
              key: "translation",
              desc: "双语分块流式译文、版面就地翻译对齐 JSON、公式占位替换映射及翻译状态。"
            },
            cajSource: {
              bytes: 0,
              files: 0,
              label: "CAJ 转换与阅读缓存",
              key: "cajSource",
              desc: "CAJ 转换后的 PDF、页数校验信息以及 Zotero 阅读附件关联数据。清除后下次打开会自动重建，不影响原 CAJ 附件和已导出的 PDF。"
            },
            mineruResult: {
              bytes: 0,
              files: 0,
              label: "原始解析包 (MinerU)",
              key: "mineruResult",
              desc: "MinerU 任务原始下载解压包（含原始 PDF 副本、分卷解析数据及解包产物）。"
            },
            chat: {
              bytes: 0,
              files: 0,
              label: "文献对话与附件",
              key: "chat",
              desc: "针对本文献进行的 AI 深度问答历史记录、提问上下文与临时交互数据。"
            },
            deepseekWeb: {
              bytes: 0,
              files: 0,
              label: "页面转图缓存",
              key: "deepseekWeb",
              desc: "用于 DeepSeek 网页端视觉多模态交互时切分的页面高清截图缓存。"
            },
            diagrams: {
              bytes: 0,
              files: 0,
              label: "图谱快照",
              key: "diagrams",
              desc: "DeepSeek 网页模式生成的思维导图与研究流程快照，可清空后重新生成。"
            },
            logs: {
              bytes: 0,
              files: 0,
              label: "运行日志与审计",
              key: "logs",
              desc: "文献处理流水日志、错误排查记录以及向大模型发起请求的审计明细。"
            },
            other: {
              bytes: 0,
              files: 0,
              label: "其他辅助文件",
              key: "other",
              desc: "文献目录下的其他辅助或临时未分类文件。"
            }
          };

          let docTotalBytes = 0;
          let docTotalFiles = 0;
          let latestMtime = info.lastModified || 0;

          const entries = await this.list(docDir);
          for (const entry of entries) {
            const entryInfo = await this.stat(entry);
            if (!entryInfo) continue;
            if (entryInfo.lastModified && entryInfo.lastModified > latestMtime) {
              latestMtime = entryInfo.lastModified;
            }
            const name = PathUtils.filename(entry);

            if (entryInfo.type === "directory") {
              const subStats = await this.dirStats(entry);
              docTotalBytes += subStats.bytes;
              docTotalFiles += subStats.files;

              if (name === "images" || name === "assets") {
                categories.images.bytes += subStats.bytes;
                categories.images.files += subStats.files;
              } else if (name === "translation" || name === "layout-translation") {
                categories.translation.bytes += subStats.bytes;
                categories.translation.files += subStats.files;
              } else if (name === "caj-source") {
                categories.cajSource.bytes += subStats.bytes;
                categories.cajSource.files += subStats.files;
              } else if (name === "mineru-result") {
                categories.mineruResult.bytes += subStats.bytes;
                categories.mineruResult.files += subStats.files;
              } else if (name === "chat") {
                categories.chat.bytes += subStats.bytes;
                categories.chat.files += subStats.files;
              } else if (name === "deepseek-web") {
                const subEntries = await this.list(entry);
                let pagesBytes = 0;
                let pagesFiles = 0;
                let metaBytes = 0;
                let metaFiles = 0;
                for (const sub of subEntries) {
                  const sName = PathUtils.filename(sub);
                  const sInfo = await this.stat(sub);
                  if (!sInfo) continue;
                  if (sInfo.type === "directory" && sName.startsWith("pages-")) {
                    const ps = await this.dirStats(sub);
                    pagesBytes += ps.bytes;
                    pagesFiles += ps.files;
                  } else if (sInfo.type !== "directory") {
                    const fSize = Number(sInfo.size || 0);
                    if (sName.startsWith("pages-") || sName.endsWith(".jpg") || sName.endsWith(".jpeg") || sName.endsWith(".png")) {
                      pagesBytes += fSize;
                      pagesFiles++;
                    } else {
                      metaBytes += fSize;
                      metaFiles++;
                    }
                  } else {
                    const otherStats = await this.dirStats(sub);
                    metaBytes += otherStats.bytes;
                    metaFiles += otherStats.files;
                  }
                }
                categories.deepseekWeb.bytes += pagesBytes;
                categories.deepseekWeb.files += pagesFiles;
                if (metaFiles > 0) {
                  categories.chat.bytes += metaBytes;
                  categories.chat.files += metaFiles;
                }
              } else if (name === "diagrams") {
                categories.diagrams.bytes += subStats.bytes;
                categories.diagrams.files += subStats.files;
              } else if (name === "logs" || name === "AI请求审计") {
                categories.logs.bytes += subStats.bytes;
                categories.logs.files += subStats.files;
              } else {
                categories.other.bytes += subStats.bytes;
                categories.other.files += subStats.files;
              }
            } else {
              const size = Number(entryInfo.size || 0);
              docTotalBytes += size;
              docTotalFiles++;

              const category = classifyDocumentRootFile(name);
              if (category === "images") {
                categories.images.bytes += size;
                categories.images.files++;
              } else if (category === "mineruResult") {
                categories.mineruResult.bytes += size;
                categories.mineruResult.files++;
              } else if (category === "model") {
                categories.model.bytes += size;
                categories.model.files++;
              } else if (category === "other") {
                categories.other.bytes += size;
                categories.other.files++;
              }
            }
          }

          // 格式化各子项
          const formattedCategories = Object.values(categories).map(cat => ({
            ...cat,
            formatted: this.formatBytes(cat.bytes)
          })).filter(cat => cat.bytes > 0 || cat.files > 0);

          const hasCAJData = Boolean(meta?.isCAJ || categories.cajSource.files > 0 || cajMeta?.format);
          if (categories.cajSource.files > 0 || cajMeta?.format) {
            cajTotalBytes += categories.cajSource.bytes;
            cajDocumentCount++;
          }

          // 精准提取文献名称与检查条目在 Zotero 中是否存在
          let isOrphan = false;
          let zoteroItemTitle = "";
          try {
            const itemID = Number(meta?.itemID || 0);
            const parentItemID = Number(meta?.parentItemID || 0);
            if (itemID) {
              const item = Zotero.Items.get(itemID);
              if (item && !item.deleted) {
                if (item.isAttachment()) {
                  const pId = item.parentItemID || parentItemID;
                  if (pId) {
                    const parent = Zotero.Items.get(pId);
                    if (parent) {
                      zoteroItemTitle = parent.getField?.("title") || parent.getDisplayTitle?.() || "";
                    }
                  }
                }
                if (!zoteroItemTitle) {
                  const titleField = item.getField?.("title");
                  if (titleField && titleField.toLowerCase() !== "pdf") {
                    zoteroItemTitle = titleField;
                  } else {
                    const disp = item.getDisplayTitle?.() || "";
                    if (disp && disp.toLowerCase() !== "pdf") {
                      zoteroItemTitle = disp;
                    }
                  }
                }
              } else if (!hasCAJData && parentItemID) {
                const parent = Zotero.Items.get(parentItemID);
                if (parent) {
                  zoteroItemTitle = parent.getField?.("title") || parent.getDisplayTitle?.() || "";
                } else {
                  isOrphan = true;
                }
              } else {
                isOrphan = true;
              }
            } else {
              const item = this.resolveDocumentItem(documentID, meta);
              if (item) {
                if (item.isAttachment?.()) {
                  const parent = item.parentID ? Zotero.Items.get(item.parentID) : null;
                  zoteroItemTitle = parent?.getField?.("title") || parent?.getDisplayTitle?.() || "";
                }
                if (!zoteroItemTitle) {
                  const titleField = item.getField?.("title");
                  if (titleField && titleField.toLowerCase() !== "pdf") zoteroItemTitle = titleField;
                }
              } else if (this.parseDocumentID(documentID)) {
                // CAJ 缓存可能只写入 source.meta.json，还没有完成首次解析；
                // 这时仍按目录 ID 判断是否已经脱离 Zotero 文献库。
                isOrphan = true;
              }
            }
          } catch (_) {}

          let finalTitle = meta?.title || zoteroItemTitle;
          if (!finalTitle || finalTitle.trim().toLowerCase() === "pdf") {
            const sourceFileName = meta?.sourceFileName || cajMeta?.sourceFileName;
            if (sourceFileName) {
              finalTitle = sourceFileName.replace(/\.[^/.]+$/, "");
            }
          }
          if (!finalTitle || finalTitle.trim().toLowerCase() === "pdf") {
            finalTitle = `文献 #${documentID}`;
          }

          deepseekWebTotalBytes += categories.deepseekWeb.bytes;
          deepseekWebTotalFiles += categories.deepseekWeb.files;

          if (isOrphan) {
            orphanedCount++;
            orphanedTotalBytes += docTotalBytes;
            orphanedDeepSeekWebBytes += categories.deepseekWeb.bytes;
            orphanedCajBytes += categories.cajSource.bytes;
          }
          documentsTotalBytes += docTotalBytes;

          documents.push({
            id: documentID,
            title: finalTitle,
            isCAJ: hasCAJData,
            caj: hasCAJData ? {
              format: String(cajMeta?.format || meta?.cajFormat || ""),
              pageCount: Number(cajMeta?.pageCount || meta?.cajPageCount || 0),
              sourceFileName: String(cajMeta?.sourceFileName || meta?.sourceFileName || ""),
              cacheValidated: Boolean(cajMeta?.cacheValidated || meta?.cajCacheValidated),
              readerAttachmentID: Number(cajMeta?.generatedAttachmentID || 0),
              readerAttachmentMode: String(cajMeta?.readerAttachmentMode || "")
            } : null,
            pageCount: meta?.pageCount || 0,
            updatedAt: meta?.updatedAt || (latestMtime ? new Date(latestMtime).toISOString() : ""),
            isOrphan,
            totalBytes: docTotalBytes,
            totalFiles: docTotalFiles,
            totalBytesFormatted: this.formatBytes(docTotalBytes),
            path: docDir,
            categories: formattedCategories
          });
        }
      }

      // 按体积降序排序
      documents.sort((a, b) => b.totalBytes - a.totalBytes);

      // 临时缓存统计：包含全局导出临时目录 + 所有文献的页面切片缓存（可随时现场重新生成）
      const tempStats = await this.dirStats(this.tempRoot);
      const tempTotalBytes = tempStats.bytes + deepseekWebTotalBytes;
      const tempFilesCount = tempStats.files + deepseekWebTotalFiles;

      // 离线引擎统计
      const edgeLocalDir = PathUtils.join(this.root, "edge-local-translation");
      const edgeStats = await this.dirStats(edgeLocalDir);

      const totalBytes = documentsTotalBytes + tempStats.bytes + edgeStats.bytes;
      const documentsCoreBytes = Math.max(0, documentsTotalBytes - deepseekWebTotalBytes);
      const orphanedCoreBytes = Math.max(0, orphanedTotalBytes - orphanedDeepSeekWebBytes);
      const cajActiveBytes = Math.max(0, cajTotalBytes - orphanedCajBytes);
      const documentsPrimaryBytes = Math.max(0, documentsCoreBytes - orphanedCoreBytes - cajActiveBytes);

      // 零开销校准页面切图累计缓存大小
      this.setDeepSeekWebPagesCacheBytes?.(deepseekWebTotalBytes);
      U.setPref("deepseekWebCacheBytesInitialized", true);

      return {
        rootPath: this.root,
        tempPath: this.tempRoot,
        totalBytes,
        totalBytesFormatted: this.formatBytes(totalBytes),
        documentsTotalBytes,
        documentsTotalBytesFormatted: this.formatBytes(documentsTotalBytes),
        documentsCoreBytes,
        documentsCoreBytesFormatted: this.formatBytes(documentsCoreBytes),
        documentsPrimaryBytes,
        documentsPrimaryBytesFormatted: this.formatBytes(documentsPrimaryBytes),
        cajTotalBytes,
        cajTotalBytesFormatted: this.formatBytes(cajTotalBytes),
        cajActiveBytes,
        cajActiveBytesFormatted: this.formatBytes(cajActiveBytes),
        cajDocumentCount,
        documentsCount: documents.length,
        tempTotalBytes,
        tempTotalBytesFormatted: this.formatBytes(tempTotalBytes),
        tempFilesCount,
        tempGlobalBytes: tempStats.bytes,
        tempGlobalBytesFormatted: tempStats.formatted,
        tempPagesBytes: deepseekWebTotalBytes,
        tempPagesBytesFormatted: this.formatBytes(deepseekWebTotalBytes),
        orphanedCount,
        orphanedTotalBytes,
        orphanedTotalBytesFormatted: this.formatBytes(orphanedTotalBytes),
        orphanedCoreBytes,
        orphanedCoreBytesFormatted: this.formatBytes(orphanedCoreBytes),
        edgeLocalTotalBytes: edgeStats.bytes,
        edgeLocalTotalBytesFormatted: edgeStats.formatted,
        documents
      };
    }

    async clearTempFiles() {
      let clearedBytes = 0;
      let clearedFiles = 0;

      // 1. 清理全局临时目录
      if (await this.exists(this.tempRoot)) {
        const stats = await this.dirStats(this.tempRoot);
        clearedBytes += stats.bytes;
        clearedFiles += stats.files;
        await this.remove(this.tempRoot, true);
        await this.ensureDir(this.tempRoot);
      }

      // 2. 清理所有文献下的页面切图缓存 (deepseek-web/pages-*)，严格保留 session.json 会话元数据
      if (await this.exists(this.documentsRoot)) {
        const docDirs = await this.list(this.documentsRoot);
        for (const docDir of docDirs) {
          const webDir = PathUtils.join(docDir, "deepseek-web");
          if (!await this.exists(webDir)) continue;
          const subEntries = await this.list(webDir);
          for (const sub of subEntries) {
            const sName = PathUtils.filename(sub);
            const sInfo = await this.stat(sub);
            if (!sInfo) continue;
            if (sInfo.type === "directory" && sName.startsWith("pages-")) {
              const ps = await this.dirStats(sub);
              clearedBytes += ps.bytes;
              clearedFiles += ps.files;
              await this.remove(sub, true);
            } else if (sInfo.type !== "directory" && (sName.startsWith("pages-") || sName.endsWith(".jpg") || sName.endsWith(".jpeg") || sName.endsWith(".png"))) {
              clearedBytes += Number(sInfo.size || 0);
              clearedFiles++;
              await this.remove(sub, false);
            }
          }
        }
      }

      // 清零页面切图记账值
      this.setDeepSeekWebPagesCacheBytes?.(0);
      U.setPref("deepseekWebCacheBytesInitialized", true);

      return { clearedBytes, clearedFiles, formatted: this.formatBytes(clearedBytes) };
    }

    async clearEdgeLocalFiles() {
      const edgeRoot = PathUtils.join(this.root, "edge-local-translation");
      const stats = await this.dirStats(edgeRoot);
      await this.remove(edgeRoot, true);
      await this.ensureDir(edgeRoot);
      return {
        clearedBytes: stats.bytes,
        clearedFiles: stats.files,
        formatted: stats.formatted
      };
    }

    async clearOrphanedDocuments() {
      let clearedBytes = 0;
      let clearedCount = 0;
      const clearedDocumentIDs = [];
      if (!await this.exists(this.documentsRoot)) {
        return { clearedBytes, clearedCount, clearedDocumentIDs, formatted: "0 B" };
      }
      const docDirs = await this.list(this.documentsRoot);
      for (const docDir of docDirs) {
        const documentID = PathUtils.filename(docDir);
        const meta = await this.readJSON(PathUtils.join(docDir, "document.json"), null);
        let isOrphan = false;
        try {
          const itemID = Number(meta?.itemID || 0);
          const parentItemID = Number(meta?.parentItemID || 0);
          if (itemID) {
            const item = Zotero.Items.get(itemID);
            if (!item || item.deleted) {
              const parent = parentItemID ? Zotero.Items.get(parentItemID) : null;
              if (!parent || meta?.isCAJ) isOrphan = true;
            }
          } else if (this.parseDocumentID(documentID) && !this.resolveDocumentItem(documentID, meta)) {
            isOrphan = true;
          }
        } catch (_) {}
        if (isOrphan) {
          const stats = await this.dirStats(docDir);
          const pageStats = await this.deepSeekWebPagesStatsAtDocumentDir?.(docDir) || { bytes: 0 };
          clearedBytes += stats.bytes;
          clearedCount++;
          clearedDocumentIDs.push(documentID);
          await this.remove(docDir, true);
          if (pageStats.bytes > 0) this.adjustDeepSeekWebPagesCacheBytes?.(-pageStats.bytes);
        }
      }
      return { clearedBytes, clearedCount, clearedDocumentIDs, formatted: this.formatBytes(clearedBytes) };
    }

    async clearDocumentSubcategory(documentID, subcategory) {
      const docDir = this.documentDir(documentID);
      if (!await this.exists(docDir)) return { cleared: false };

      const measure = async targets => {
        let bytes = 0;
        let files = 0;
        const seen = new Set();
        for (const target of targets) {
          const path = String(target || "");
          if (!path || seen.has(path)) continue;
          seen.add(path);
          const info = await this.stat(path);
          if (!info) continue;
          if (info.type === "directory") {
            const stats = await this.dirStats(path);
            bytes += stats.bytes;
            files += stats.files;
          } else {
            bytes += Number(info.size || 0);
            files++;
          }
        }
        return { bytes, files };
      };

      let targets = [];
      if (!subcategory || subcategory === "all") {
        targets = [docDir];
      } else if (subcategory === "images") {
        targets = [
          PathUtils.join(docDir, "images"),
          PathUtils.join(docDir, "assets"),
          PathUtils.join(docDir, "asset-map.json"),
          PathUtils.join(docDir, "image-map.json")
        ];
      } else if (subcategory === "translation") {
        targets = [
          PathUtils.join(docDir, "translation"),
          PathUtils.join(docDir, "layout-translation")
        ];
      } else if (subcategory === "cajSource") {
        targets = [PathUtils.join(docDir, "caj-source")];
      } else if (subcategory === "mineruResult") {
        targets = [PathUtils.join(docDir, "mineru-result"), PathUtils.join(docDir, "mineru-task.json")];
      } else if (subcategory === "chat") {
        targets = [PathUtils.join(docDir, "chat")];
      } else if (subcategory === "deepseekWeb") {
        const webDir = PathUtils.join(docDir, "deepseek-web");
        if (await this.exists(webDir)) {
          const subEntries = await this.list(webDir);
          for (const sub of subEntries) {
            const sName = PathUtils.filename(sub);
            const sInfo = await this.stat(sub);
            if (!sInfo) continue;
            if (sInfo.type === "directory" && sName.startsWith("pages-")) {
              targets.push(sub);
            } else if (sInfo.type !== "directory" && (sName.startsWith("pages-") || sName.endsWith(".jpg") || sName.endsWith(".jpeg") || sName.endsWith(".png"))) {
              targets.push(sub);
            }
          }
        }
      } else if (subcategory === "diagrams") {
        targets = [PathUtils.join(docDir, "diagrams")];
      } else if (subcategory === "logs") {
        targets = [PathUtils.join(docDir, "logs"), PathUtils.join(docDir, "AI请求审计")];
      } else if (subcategory === "model" || subcategory === "other") {
        const entries = await this.list(docDir);
        for (const entry of entries) {
          const info = await this.stat(entry);
          if (!info || info.type === "directory") continue;
          const name = PathUtils.filename(entry);
          const category = classifyDocumentRootFile(name);
          if (category === subcategory) targets.push(entry);
        }
      }
      const before = await measure(targets);
      const pageStatsBefore = (!subcategory || subcategory === "all")
        ? await this.deepSeekWebPagesStatsAtDocumentDir(docDir)
        : null;

      if (!subcategory || subcategory === "all") {
        await this.remove(docDir, true);
      } else if (subcategory === "images") {
        await this.remove(PathUtils.join(docDir, "images"), true);
        await this.remove(PathUtils.join(docDir, "assets"), true);
        await this.remove(PathUtils.join(docDir, "asset-map.json"), false);
        await this.remove(PathUtils.join(docDir, "image-map.json"), false);
      } else if (subcategory === "translation") {
        await this.clearTranslation(documentID, "all");
      } else if (subcategory === "cajSource") {
        await this.remove(PathUtils.join(docDir, "caj-source"), true);
      } else if (subcategory === "mineruResult") {
        await this.remove(PathUtils.join(docDir, "mineru-result"), true);
        await this.remove(PathUtils.join(docDir, "mineru-task.json"), false);
      } else if (subcategory === "chat") {
        await this.remove(PathUtils.join(docDir, "chat"), true);
      } else if (subcategory === "deepseekWeb") {
        for (const target of targets) {
          const info = await this.stat(target);
          if (info?.type === "directory") {
            await this.remove(target, true);
          } else if (info) {
            await this.remove(target, false);
          }
        }
      } else if (subcategory === "diagrams") {
        await this.remove(PathUtils.join(docDir, "diagrams"), true);
      } else if (subcategory === "logs") {
        await this.remove(PathUtils.join(docDir, "logs"), true);
        await this.remove(PathUtils.join(docDir, "AI请求审计"), true);
      } else if (subcategory === "model" || subcategory === "other") {
        for (const target of targets) {
          if (PathUtils.filename(target) !== "document.json") await this.remove(target, false);
        }
      }

      if (subcategory === "deepseekWeb" && before.bytes > 0 && typeof this.getDeepSeekWebPagesCacheBytes === "function") {
        this.adjustDeepSeekWebPagesCacheBytes?.(-before.bytes);
      } else if ((!subcategory || subcategory === "all") && pageStatsBefore?.bytes > 0) {
        this.adjustDeepSeekWebPagesCacheBytes?.(-pageStatsBefore.bytes);
      }

      return {
        cleared: true,
        clearedBytes: before.bytes,
        clearedFiles: before.files,
        formatted: this.formatBytes(before.bytes)
      };
    }

    openFolder(targetPath) {
      const path = String(targetPath || this.root).trim();
      let file = U.createLocalFile(path);
      try {
        if (!file.exists()) {
          const parentDir = PathUtils.parent(path);
          if (parentDir) file = U.createLocalFile(parentDir);
        }
      } catch (_) {}

      try {
        if (file.isDirectory()) {
          file.launch();
          return true;
        }
      } catch (_) {}
      try {
        if (typeof file.reveal === "function") {
          file.reveal();
          return true;
        }
      } catch (_) {}
      try {
        file.launch();
        return true;
      } catch (_) {
        const service = Cc["@mozilla.org/uriloader/external-protocol-service;1"]
          .getService(Ci.nsIExternalProtocolService);
        service.loadURI(Services.io.newFileURI(file));
        return true;
      }
    }

    getDeepSeekWebPagesCacheBytes() {
      return Number(U.getPref("deepseekWebCacheBytes", 0)) || 0;
    }

    setDeepSeekWebPagesCacheBytes(bytes) {
      const val = Math.max(0, Number(bytes) || 0);
      U.setPref("deepseekWebCacheBytes", val);
      return val;
    }

    recordDeepSeekWebPagesWritten(bytesWritten) {
      return this.adjustDeepSeekWebPagesCacheBytes(Math.max(0, Number(bytesWritten) || 0));
    }

    adjustDeepSeekWebPagesCacheBytes(delta) {
      const current = this.getDeepSeekWebPagesCacheBytes();
      return this.setDeepSeekWebPagesCacheBytes(Math.max(0, current + (Number(delta) || 0)));
    }

    async ensureDeepSeekWebPagesCacheBytesInitialized() {
      if (U.getPref("deepseekWebCacheBytesInitialized", false)) {
        return this.getDeepSeekWebPagesCacheBytes();
      }
      let total = 0;
      if (await this.exists(this.documentsRoot)) {
        for (const docDir of await this.list(this.documentsRoot)) {
          const info = await this.stat(docDir);
          if (!info || info.type !== "directory") continue;
          total += (await this.deepSeekWebPagesStatsAtDocumentDir(docDir)).bytes;
        }
      }
      this.setDeepSeekWebPagesCacheBytes(total);
      U.setPref("deepseekWebCacheBytesInitialized", true);
      return total;
    }

    dismissDeepSeekWebCacheAlert(cooldownMs = PAGE_CACHE_ALERT_COOLDOWN_MS) {
      const until = Date.now() + Math.max(0, Number(cooldownMs) || PAGE_CACHE_ALERT_COOLDOWN_MS);
      U.setPref("deepseekWebCacheAlertDismissedUntil", until);
    }

    shouldAlertDeepSeekWebCache(currentBytes = null) {
      const bytes = currentBytes !== null ? Number(currentBytes) : this.getDeepSeekWebPagesCacheBytes();
      if (bytes < PAGE_CACHE_ALERT_THRESHOLD_BYTES) return false;
      const dismissedUntil = Number(U.getPref("deepseekWebCacheAlertDismissedUntil", 0)) || 0;
      return Date.now() > dismissedUntil;
    }
  }

  LitMTrans.Storage = Storage;
})(this);
