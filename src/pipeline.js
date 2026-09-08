(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const U = LitMTrans.Utils;
  const REASONING_LOG_SEGMENT_CHARS = 16 * 1024;

  /**
   * DocumentPipeline mirrors the responsibility of the original LS_pipeline:
   * it owns document processing order and publication rules, while the Zotero
   * controller only resolves items and transports messages to the workbench.
   */
  class DocumentPipeline {
    constructor({ storage, mineru, translation, layout, chat, getSettings }) {
      this.storage = storage;
      this.mineru = mineru;
      this.translation = translation;
      this.layout = layout;
      this.chat = chat;
      this.getSettings = typeof getSettings === "function" ? getSettings : (() => ({}));
      this._reasoningLogBuffers = new Map();
    }

    async buildLayoutState(documentID, parsed, layoutTranslations) {
      if (!parsed?.hasLayout) {
        return {
          translations: {},
          formulaReplacements: {},
          meta: layoutTranslations?.meta || null,
          model: null,
          fitSnapshot: null,
          stale: false,
          error: ""
        };
      }
      try {
        // A tiny manifest is published atomically with MinerU's layout files.
        // It makes the normal reopen path independent of the full layout.json.
        const revision = await this.layout.ensureRevision(documentID);
        const currentFingerprint = String(revision.sourceFingerprint || "");
        const publishedFingerprint = String(layoutTranslations?.meta?.sourceFingerprint || "");
        const stale = Boolean(publishedFingerprint && publishedFingerprint !== currentFingerprint);
        const translations = stale ? {} : (layoutTranslations?.translations || {});
        const formulaReplacements = stale ? {} : (layoutTranslations?.formulaReplacements || {});
        // The atomically published revision, not translation metadata, proves
        // that compiled-model.json belongs to the current layout source.
        const model = await this.layout.buildModel(documentID, translations, formulaReplacements, revision);
        let fitSnapshot = null;
        try {
          // Use the model fingerprint when translation metadata is stale.
          const identity = String(stale ? model?.sourceFingerprint : (layoutTranslations?.meta?.identity || model?.sourceFingerprint || ""));
          const settings = this.getSettings ? this.getSettings() : {};
          const documentFonts = settings?.layoutReaderFonts || {};
          // Absence of a per-document setting means automatic fitting, not the
          // stream reader's 12pt UI placeholder, owns the body font.
          // This must match workbench.js::layoutFitSnapshotKey exactly or an
          // obsolete injected snapshot can be restored without re-measuring.
          const configuredBodyFont = Number(documentFonts[documentID]);
          const bodyFont = (
            Number.isFinite(configuredBodyFont) && configuredBodyFont > 0
              ? configuredBodyFont
              : 0
          ).toFixed(1);
          const key = `${documentID}|${identity}|${bodyFont}`;
          const fitPath = PathUtils.join(this.storage.documentsRoot, documentID, "fit", `${U.hashString(key)}.json`);
          if (await this.storage.exists(fitPath)) {
            fitSnapshot = await this.storage.readJSON(fitPath, null);
          }
        } catch (_) {}
        return {
          translations,
          formulaReplacements,
          meta: layoutTranslations?.meta || null,
          model,
          fitSnapshot,
          stale,
          error: stale ? "排版源数据已变化，旧排版译文已停用，请重新翻译" : ""
        };
      }
      catch (error) {
        return {
          translations: {},
          formulaReplacements: {},
          meta: layoutTranslations?.meta || null,
          model: null,
          fitSnapshot: null,
          stale: false,
          error: String(error?.message || error || "排版模型读取失败")
        };
      }
    }

    attachImageWidths(parsed, layoutModel) {
      const imageWidths = {};
      if (!layoutModel) {
        parsed.imageWidths = imageWidths;
        return;
      }
      const normalize = value => LitMTrans.MinerUAsset.normalizeAssetKey(String(value || ""));
      // During multipart parsing, layout assets are namespaced as
      // `p001-<MinerU filename>`, while the stream Markdown retains the
      // original `images/<MinerU filename>` target.  Index both identities
      // so layout geometry survives the asset-repackaging boundary.
      const imageIdentity = value => LitMTrans.MinerUAsset.basename(normalize(value))
        .replace(/^p\d{3,}-/i, "");
      const remember = (target, percentage) => {
        const key = normalize(target);
        if (!key || !Number.isFinite(percentage)) return;
        for (const candidate of [key, LitMTrans.MinerUAsset.basename(key), imageIdentity(key)]) {
          imageWidths[candidate] = Math.max(percentage, Number(imageWidths[candidate] || 0));
        }
      };
      for (const page of layoutModel.pages || []) {
        const pageWidth = Math.max(1, Number(page.width || 1));
        for (const block of page.blocks || []) {
          if (!block.imagePath || !Array.isArray(block.bbox) || block.bbox.length < 4) continue;
          const percentage = Math.max(
            0.1,
            Math.min(100, ((Number(block.bbox[2]) - Number(block.bbox[0])) / pageWidth) * 100)
          );
          remember(block.imagePath, percentage);
        }
      }
      for (const record of parsed.imageMap || []) {
        const original = normalize(record.originalTarget);
        const percentage = Number(
          imageWidths[original]
          || imageWidths[LitMTrans.MinerUAsset.basename(original)]
          || imageWidths[imageIdentity(original)]
          || 0
        );
        if (!percentage) continue;
        remember(record.originalTarget, percentage);
        remember(record.cleanTarget, percentage);
      }
      parsed.imageWidths = imageWidths;
    }

    async snapshot(context) {
      const parsed = await this.mineru.loadParsed(context.documentID);
      const loadedStream = await this.translation.load(context.documentID);
      const sourceFingerprint = parsed.markdown ? U.hashString(parsed.markdown) : "";
      const streamStale = Boolean(
        loadedStream?.meta?.sourceFingerprint
        && loadedStream.meta.sourceFingerprint !== sourceFingerprint
      );
      const stream = streamStale
        ? {
            markdown: "",
            live: "",
            meta: loadedStream.meta,
            stale: true,
            error: "解析正文已变化，旧流式译文已停用，请重新翻译"
          }
        : { ...loadedStream, stale: false, error: "" };
      const layoutTranslations = await this.layout.loadTranslations(context.documentID);
      const layout = await this.buildLayoutState(context.documentID, parsed, layoutTranslations);
      this.attachImageWidths(parsed, layout.model);

      let sessions = await this.chat.listSessions(context.documentID);
      const session = await this.chat.loadSession(context.documentID, sessions[0]?.id || "");
      sessions = await this.chat.listSessions(context.documentID);

      const canParse = LitMTrans.Constants.SUPPORTED_INPUT_EXTENSIONS.has(U.extension(context.filePath));
      const hasParsed = Boolean(parsed.markdown);
      const hasLayoutModel = Boolean(layout.model?.pages?.length);
      const hasLayoutTranslation = Boolean(Object.keys(layout.translations || {}).length);
      // The Zotero PDF Reader is useful before MinerU has produced a layout
      // model.  Keep that reader capability separate from the parsed-layout
      // capability so a new attachment does not lose the layout reading mode.
      const canUseLayoutReader = U.extension(context.filePath) === ".pdf";
      return {
        parsed,
        translation: stream,
        layout,
        chat: { sessions, session },
        capabilities: {
          canParse,
          canTranslate: hasParsed || canParse,
          hasParsed,
          hasLayoutSource: Boolean(parsed.hasLayout),
          hasLayout: hasLayoutModel,
          canUseLayoutReader,
          hasTranslation: Boolean(stream.markdown),
          hasLayoutTranslation
        }
      };
    }

    async parse(context, payload = {}, emit = null, signal = null) {
      const settings = this.getSettings();
      const beforeParsed = await this.mineru.loadParsed(context.documentID);
      const beforeTranslation = await this.translation.load(context.documentID);
      const previousFingerprint = beforeParsed.markdown ? U.hashString(beforeParsed.markdown) : "";
      const revisionCaptureRoot = this.storage.path(
        context.documentID,
        "chat",
        ".revision-captures",
        U.randomID("capture").replace(/[^A-Za-z0-9_-]+/g, "")
      );
      try {
        if (previousFingerprint) {
          const oldImages = this.storage.path(context.documentID, "images");
          const oldImageMap = this.storage.path(context.documentID, "image-map.json");
          if (await this.storage.exists(oldImages)) {
            await this.storage.copyTree(oldImages, PathUtils.join(revisionCaptureRoot, "images"));
          }
          if (await this.storage.exists(oldImageMap)) {
            await this.storage.copyFile(oldImageMap, PathUtils.join(revisionCaptureRoot, "image-map.json"));
          }
        }

        const result = await this.mineru.parse(context.attachment, context.filePath, {
          force: Boolean(payload.force),
          modelVersion: String(payload.modelVersion || settings.mineruModel || "vlm"),
          isOCR: payload.isOCR === undefined ? Boolean(settings.mineruOCR) : Boolean(payload.isOCR),
          enableTable: payload.enableTable === undefined ? Boolean(settings.mineruTable) : Boolean(payload.enableTable),
          enableFormula: payload.enableFormula === undefined ? Boolean(settings.mineruFormula) : Boolean(payload.enableFormula)
        }, emit, signal);

        const currentFingerprint = result.markdown ? U.hashString(result.markdown) : "";
        const revision = await this.chat.archiveDocumentRevision(
          context.documentID,
          previousFingerprint,
          currentFingerprint,
          {
            sourceMarkdown: beforeParsed.markdown,
            translatedMarkdown: beforeTranslation.markdown,
            imageSnapshotRoot: revisionCaptureRoot
          }
        );
        if (revision.archived) {
          emit?.({
            type: "log",
            message: `解析正文已变化：已保留旧正文、图片与译文快照，并归档 ${revision.archived} 个旧解析版本对话。`
          });
        }
        return { result, revision };
      }
      finally {
        await this.storage.remove(revisionCaptureRoot, true);
      }
    }

    async translateStream(context, payload = {}, emit = null, signal = null) {
      const parsed = await this.mineru.loadParsed(context.documentID);
      if (!String(parsed.markdown || "").trim()) {
        throw new Error("当前文档尚未完成解析");
      }
      return this.runTranslationWithPersistentLog(context.documentID, "stream", emit, () => this.translation.translate(context.documentID, parsed.markdown, {
        force: Boolean(payload.force),
        mode: String(payload.mode || this.getSettings().translationMode || "full_context")
      }, this.logTranslationEvent(context.documentID, "stream", emit), signal));
    }

    async translateLayout(context, payload = {}, emit = null, signal = null) {
      const parsed = await this.mineru.loadParsed(context.documentID);
      if (!parsed.hasLayout) throw new Error("当前MinerU结果没有可用的页面布局数据");
      const settings = this.getSettings();
      const loggedEmit = this.logTranslationEvent(context.documentID, "layout", emit);
      return this.runTranslationWithPersistentLog(context.documentID, "layout", emit, async () => {
        const webMachine = U.isWebMachineProvider(settings.provider);
        const reference = webMachine
          ? { corpus: "", identity: "" }
          : await this.translation.buildReferenceCorpus(context.documentID, settings, loggedEmit, signal);
        if (webMachine && Array.isArray(settings.translationReferencePaths) && settings.translationReferencePaths.length) {
          const label = settings.provider === "edge_local" ? "Edge本地翻译" : "联网翻译";
          loggedEmit?.({ type: "log", message: `${label}不使用参考文件，已忽略本次添加的参考文件。` });
        }
        if (webMachine && String(settings.customTranslationInstruction || "").trim()) {
          const label = settings.provider === "edge_local" ? "Edge本地翻译" : "联网翻译";
          loggedEmit?.({ type: "log", message: `${label}不使用自定义翻译要求，已忽略本次设置。` });
        }
        return this.layout.translate(context.documentID, {
        force: Boolean(payload.force),
        mode: String(payload.mode || settings.translationMode || "full_context"),
        // Character-mix retry is an opt-in compatibility mode.
        enableUntranslatedCheck: Boolean(payload.enableUntranslatedCheck),
        referenceContext: reference.corpus,
        referenceIdentity: reference.identity,
        // Machine translation has no prompt context.
        customTranslationInstruction: webMachine ? "" : settings.customTranslationInstruction
        }, loggedEmit, signal);
      });
    }

    async manualTranslationCommand(context, mode) {
      const settings = this.getSettings();
      if (mode === "layout") {
        const parsed = await this.mineru.loadParsed(context.documentID);
        if (!parsed.hasLayout) throw new Error("当前MinerU结果没有可用的页面布局数据");
        const records = await this.layout.extractRecords(context.documentID);
        const blocks = records.map(({ id, page, type, text }) => ({ id, page, type, text: this.layout.sanitizeManualText(text) }));
        return (
          `你是一位专业的学术论文翻译家与排版感知编辑。请将以下学术论文排版文本块翻译为 ${settings.targetLanguage}。\n\n` +
          "【排版物理机理与块边界要求】\n" +
          "1. 每个文本块均由视觉版面分析引擎从文献中提取，对应原页面上独立的物理矩形框（Bounding Box）。\n" +
          "2. 翻译完成后，排版引擎会严格按 ID 将译文填回原始坐标；严禁跨块挪移、借调、提前合并内容或遗漏块，否则会导致版面内容严重挤压、文字重叠溢出或区域坍塌。\n" +
          "3. 必须严格保留每一个原始 id，并为每个输入块返回且仅返回一条对应的译文记录。\n\n" +
          "【跨块断句接续规则】\n" +
          "如果一句话因排版分栏或换页被切断在不同块中：\n" +
          "- 严禁在前面的块中提前补全整句话；严禁将整句话推迟挪移到后面的块。\n" +
          "- 每个块只翻译其自身可见的文字部分。允许在接壤断口处结合上下文进行自然的语法行文过渡，目标是：读者顺着跨块连续阅读时整句话通顺流畅，但每个块各自严格忠实于自身文本。\n" +
          "正误对照示例：\n" +
          '  * 原文：块1: "The proposed method achieves" | 块2: "superior accuracy on benchmarks."\n' +
          '  * 正确（各自对应、顺读连贯）：块1: "所提出的方法实现了" | 块2: "在基准测试上的卓越准确率。"\n' +
          '  * 错误（严禁抢翻补全）：块1: "所提出的方法在基准测试上取得了卓越准确率。" [违规提前翻完] | 块2: "具有更高精度。" [违规重复或残缺]\n\n' +
          "【输出格式规范】\n" +
          "1. 行内公式、变量、引用序号、数值、单位必须原样保留 TeX 及定界符；TeX 反斜杠在 JSON 文本中必须转义为双反斜杠（例如 `\\\\frac`）。\n" +
          "2. 采用正式严谨的学术文风，使用规范专业术语。\n" +
          "3. 请只输出一个 `text` 代码块。代码块内使用 JSON Lines：每个输入块对应一条独立、合法的 JSON 记录，并单独占一行，形状严格如下：\n" +
          '{"id":"原始id","text":"该id对应的译文"}\n' +
          "不要添加外层对象、外层数组或 `translations` 字段。必须按输入顺序一次性输出全部记录，不要输出解释或其他文字。译文内部的换行必须写成 JSON 转义 `\\n`；TeX 反斜杠必须转义为两个反斜杠。\n\n" +
          "输入文本块 JSON：\n" + JSON.stringify({ blocks }, null, 2)
        );
      }
      const parsed = await this.mineru.loadParsed(context.documentID);
      const markdown = String(parsed.markdown || "");
      if (!markdown.trim()) throw new Error("当前文档尚未完成解析");
      const marker = await this.translation.manualCompletionMarker(markdown);
      return "请将以下学术论文的 Markdown 完整翻译为 " + settings.targetLanguage + "。保留标题、表格、链接、图片占位符、HTML 锚点、引用和所有公式的 TeX 与分隔符；可修复明显的 OCR、换行和 Markdown 排版错误，但不得增删或臆造内容。\n\n请只输出一个 `text` 代码块，代码块内只放完整译文 Markdown；不要解释，不要在代码块外输出任何内容。全文翻译完成后，必须在代码块内另起最后一行，原样输出结束标记 `" + marker + "`。结束标记不属于译文，不能翻译、改写或添加前后缀。如果无法在一次回答中完成，请不要输出结束标记；用户会让你继续翻译。\n\n===== BEGIN SOURCE MARKDOWN TO TRANSLATE =====\n" + markdown + "\n===== END SOURCE MARKDOWN TO TRANSLATE =====";
    }

    async importManualTranslation(context, mode, responses, emit = null) {
      if (mode === "layout") return this.layout.importManualTranslation(context.documentID, responses, emit);
      const parsed = await this.mineru.loadParsed(context.documentID);
      if (!String(parsed.markdown || "").trim()) throw new Error("当前文档尚未完成解析");
      return this.translation.importManualTranslation(context.documentID, parsed.markdown, responses, emit);
    }

    async mergeManualTranslationResponse(context, mode, existing, response) {
      if (mode !== "layout") return null;
      return this.layout.mergeManualTranslationResponse(context.documentID, existing, response);
    }

    async manualTranslationRecoveryCommand(context, mode, responses) {
      const settings = this.getSettings();
      if (mode !== "layout") {
        const parsed = await this.mineru.loadParsed(context.documentID);
        const marker = await this.translation.manualCompletionMarker(String(parsed.markdown || ""));
        return "继续从上一段译文的准确中断位置翻译，不要重复已经翻译的内容。只输出一个 `text` 代码块，代码块内只放后续译文 Markdown。全文完成后，必须在代码块内另起最后一行原样输出结束标记 `" + marker + "`；未完成时不要输出该标记。";
      }
      const records = await this.layout.extractRecords(context.documentID);
      const received = this.layout.normalizeManualTranslations(records, responses);
      const missing = records.filter(record => !received[record.id]).map(({ id, page, type, text }) => ({ id, page, type, text }));
      return (
        `上一轮排版译文未能通过校验，仍缺少以下文本块。请一次性只翻译这些块，目标语言为 ${settings.targetLanguage}。\n\n` +
        "【核心约束】\n" +
        "1. 严格限定在各块自身可见范围内翻译，绝不得跨块提前补全句子、合并或挪移相邻块内容；每个 id 只返回其自身对应文本。\n" +
        "2. 严格保留每个原始 id，行内公式、变量、引用序号、数值和单位必须原样保留，TeX 反斜杠必须转义为双反斜杠。\n" +
        "3. 请只输出一个 `text` 代码块。代码块内使用 JSON Lines，每个缺失块对应一条独立 JSON 记录并单独占一行：\n" +
        '{"id":"原始id","text":"该id对应的译文"}\n' +
        "不要添加外层对象、外层数组或 `translations` 字段，不要输出解释或其他文字。译文内部的换行必须写成 JSON 转义 `\\n`；TeX 反斜杠必须转义为两个反斜杠。\n\n" +
        "缺失文本块 JSON：\n" + JSON.stringify({ blocks: missing }, null, 2)
      );
    }

    logTranslationEvent(documentID, mode, emit) {
      return event => {
        const type = String(event?.type || "");
        if (type === "reasoning") {
          const text = String(event.delta || "");
          if (text) {
            const key = [documentID, mode, String(event.scope || ""), Number(event.group || 0) || ""].join("\u241f");
            const current = this._reasoningLogBuffers.get(key) || {
              documentID,
              mode,
              scope: String(event.scope || ""),
              group: Number(event.group || 0) || undefined,
              text: ""
            };
            current.text += text;
            this._reasoningLogBuffers.set(key, current);
            // Keep crash-safe persisted progress without retaining an entire
            // long reasoning response in memory. Adjacent segments are merged
            // back into one message when the log is read.
            if (current.text.length >= REASONING_LOG_SEGMENT_CHARS) {
              const segment = current.text;
              current.text = "";
              void this.storage.appendProcessLog(documentID, {
                category: "translation",
                mode,
                type: "reasoning",
                scope: current.scope,
                group: current.group,
                text: segment
              }).catch(() => {});
            }
          }
          emit?.(event);
          return;
        }
        // Persist only operational status and provider-returned reasoning; raw
        // translation deltas would duplicate the completed translation file.
        if (["status", "progress", "log", "warning"].includes(type)) {
          const text = String(event.message || event.phase || "");
          if (text) {
            void this.storage.appendProcessLog(documentID, {
              category: "translation",
              mode,
              type,
              scope: String(event.scope || ""),
              group: Number(event.group || 0) || undefined,
              text
            }).catch(() => {});
          }
        }
        emit?.(event);
      };
    }

    async runTranslationWithPersistentLog(documentID, mode, emit, work) {
      await this.storage.appendProcessLog(documentID, { category: "translation", mode, type: "started", text: mode === "layout" ? "开始排版翻译" : "开始流式翻译" });
      try {
        const result = await work();
        await this.flushReasoningLogs(documentID, mode);
        await this.storage.appendProcessLog(documentID, { category: "translation", mode, type: "completed", text: mode === "layout" ? "排版翻译完成" : "流式翻译完成" });
        return result;
      }
      catch (error) {
        await this.flushReasoningLogs(documentID, mode);
        await this.storage.appendProcessLog(documentID, { category: "translation", mode, type: "error", text: String(error?.message || error || "翻译失败") });
        throw error;
      }
    }

    async flushReasoningLogs(documentID, mode) {
      const records = [];
      for (const [key, value] of this._reasoningLogBuffers) {
        if (value.documentID !== documentID || value.mode !== mode) continue;
        this._reasoningLogBuffers.delete(key);
        if (value.text) records.push(value);
      }
      for (const value of records) {
        await this.storage.appendProcessLog(documentID, {
          category: "translation",
          mode,
          type: "reasoning",
          scope: value.scope,
          group: value.group,
          text: value.text
        });
      }
    }

    async clearTranslation(context, kind = "all") {
      await this.storage.clearTranslation(context.documentID, String(kind || "all"));
    }

    async clearDocument(context) {
      await this.storage.clearDocument(context.documentID);
      await this.storage.ensureDocument(context.attachment);
    }
  }

  LitMTrans.DocumentPipeline = DocumentPipeline;
})(this);
