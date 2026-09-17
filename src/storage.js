(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const U = LitMTrans.Utils;

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
      await this.remove(this.documentDir(itemOrID), true);
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
        await this.remove(directory, true);
        cleared.push(PathUtils.filename(directory));
      }
      return cleared;
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

    async getStorageSummary() {
      const documents = [];
      let documentsTotalBytes = 0;
      let orphanedCount = 0;
      let orphanedTotalBytes = 0;

      if (await this.exists(this.documentsRoot)) {
        const docDirs = await this.list(this.documentsRoot);
        for (const docDir of docDirs) {
          const info = await this.stat(docDir);
          if (!info || info.type !== "directory") continue;
          const documentID = PathUtils.filename(docDir);
          const meta = await this.readJSON(PathUtils.join(docDir, "document.json"), null);

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
              } else if (name === "mineru-result") {
                categories.mineruResult.bytes += subStats.bytes;
                categories.mineruResult.files += subStats.files;
              } else if (name === "chat") {
                categories.chat.bytes += subStats.bytes;
                categories.chat.files += subStats.files;
              } else if (name === "deepseek-web") {
                categories.deepseekWeb.bytes += subStats.bytes;
                categories.deepseekWeb.files += subStats.files;
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

              if (name === "asset-map.json" || name === "image-map.json") {
                categories.images.bytes += size;
                categories.images.files++;
              } else if (name === "mineru-task.json") {
                categories.mineruResult.bytes += size;
                categories.mineruResult.files++;
              } else if (name.endsWith(".json") || name.endsWith(".md") || name === "document.json") {
                categories.model.bytes += size;
                categories.model.files++;
              } else {
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

          // 精准提取文献名称与检查条目在 Zotero 中是否存在
          let isOrphan = false;
          let zoteroItemTitle = "";
          try {
            const itemID = Number(meta?.itemID || 0);
            const parentItemID = Number(meta?.parentItemID || 0);
            if (itemID) {
              const item = Zotero.Items.get(itemID);
              if (item) {
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
              } else if (parentItemID) {
                const parent = Zotero.Items.get(parentItemID);
                if (parent) {
                  zoteroItemTitle = parent.getField?.("title") || parent.getDisplayTitle?.() || "";
                } else {
                  isOrphan = true;
                }
              } else {
                isOrphan = true;
              }
            }
          } catch (_) {}

          let finalTitle = meta?.title || zoteroItemTitle;
          if (!finalTitle || finalTitle.trim().toLowerCase() === "pdf") {
            if (meta?.sourceFileName) {
              finalTitle = meta.sourceFileName.replace(/\.[^/.]+$/, "");
            }
          }
          if (!finalTitle || finalTitle.trim().toLowerCase() === "pdf") {
            finalTitle = `文献 #${documentID}`;
          }

          if (isOrphan) {
            orphanedCount++;
            orphanedTotalBytes += docTotalBytes;
          }
          documentsTotalBytes += docTotalBytes;

          documents.push({
            id: documentID,
            title: finalTitle,
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

      // 临时缓存统计
      const tempStats = await this.dirStats(this.tempRoot);

      // 离线引擎统计
      const edgeLocalDir = PathUtils.join(this.root, "edge-local-translation");
      const edgeStats = await this.dirStats(edgeLocalDir);

      const totalBytes = documentsTotalBytes + tempStats.bytes + edgeStats.bytes;

      return {
        rootPath: this.root,
        tempPath: this.tempRoot,
        totalBytes,
        totalBytesFormatted: this.formatBytes(totalBytes),
        documentsTotalBytes,
        documentsTotalBytesFormatted: this.formatBytes(documentsTotalBytes),
        documentsCount: documents.length,
        tempTotalBytes: tempStats.bytes,
        tempTotalBytesFormatted: tempStats.formatted,
        tempFilesCount: tempStats.files,
        orphanedCount,
        orphanedTotalBytes,
        orphanedTotalBytesFormatted: this.formatBytes(orphanedTotalBytes),
        edgeLocalTotalBytes: edgeStats.bytes,
        edgeLocalTotalBytesFormatted: edgeStats.formatted,
        documents
      };
    }

    async clearTempFiles() {
      let clearedBytes = 0;
      let clearedFiles = 0;
      if (await this.exists(this.tempRoot)) {
        const stats = await this.dirStats(this.tempRoot);
        clearedBytes = stats.bytes;
        clearedFiles = stats.files;
        await this.remove(this.tempRoot, true);
        await this.ensureDir(this.tempRoot);
      }
      return { clearedBytes, clearedFiles, formatted: this.formatBytes(clearedBytes) };
    }

    async clearOrphanedDocuments() {
      let clearedBytes = 0;
      let clearedCount = 0;
      if (!await this.exists(this.documentsRoot)) return { clearedBytes, clearedCount, formatted: "0 B" };
      const docDirs = await this.list(this.documentsRoot);
      for (const docDir of docDirs) {
        const meta = await this.readJSON(PathUtils.join(docDir, "document.json"), null);
        let isOrphan = false;
        try {
          const itemID = Number(meta?.itemID || 0);
          const parentItemID = Number(meta?.parentItemID || 0);
          if (itemID) {
            const item = Zotero.Items.get(itemID);
            if (!item) {
              const parent = parentItemID ? Zotero.Items.get(parentItemID) : null;
              if (!parent) isOrphan = true;
            }
          }
        } catch (_) {}
        if (isOrphan) {
          const stats = await this.dirStats(docDir);
          clearedBytes += stats.bytes;
          clearedCount++;
          await this.remove(docDir, true);
        }
      }
      return { clearedBytes, clearedCount, formatted: this.formatBytes(clearedBytes) };
    }

    async clearDocumentSubcategory(documentID, subcategory) {
      const docDir = this.documentDir(documentID);
      if (!await this.exists(docDir)) return { cleared: false };

      if (!subcategory || subcategory === "all") {
        await this.remove(docDir, true);
        return { cleared: true };
      }

      if (subcategory === "images") {
        await this.remove(PathUtils.join(docDir, "images"), true);
        await this.remove(PathUtils.join(docDir, "assets"), true);
        await this.remove(PathUtils.join(docDir, "asset-map.json"), false);
        await this.remove(PathUtils.join(docDir, "image-map.json"), false);
      } else if (subcategory === "translation") {
        await this.clearTranslation(documentID, "all");
      } else if (subcategory === "mineruResult") {
        await this.remove(PathUtils.join(docDir, "mineru-result"), true);
        await this.remove(PathUtils.join(docDir, "mineru-task.json"), false);
      } else if (subcategory === "chat") {
        await this.remove(PathUtils.join(docDir, "chat"), true);
      } else if (subcategory === "deepseekWeb") {
        await this.remove(PathUtils.join(docDir, "deepseek-web"), true);
      } else if (subcategory === "logs") {
        await this.remove(PathUtils.join(docDir, "logs"), true);
        await this.remove(PathUtils.join(docDir, "AI请求审计"), true);
      }
      return { cleared: true };
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
  }

  LitMTrans.Storage = Storage;
})(this);
