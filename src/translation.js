(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const U = LitMTrans.Utils;
  const M = LitMTrans.Markdown;
  const C = LitMTrans.Constants;

  const REFERENCE_RECOMMENDED_FILES = 6;
  const REFERENCE_WARNING_CHARS = 300000;
  const STREAM_CHUNK_CONCURRENCY = 3;
  const STREAM_CONTINUATION_MAX_ROUNDS = 64;
  const STREAM_PROTOCOL_VERSION = "stream-chunk-v2-continuations";
  // A reasoning model can spend an unbounded time thinking before its first
  // visible token. Translation lifetime is therefore user-controlled: stop
  // only when the caller explicitly cancels the task.
  const TRANSLATION_REQUEST_TIMEOUT = 0;
  const TRANSLATION_FIRST_EVENT_TIMEOUT = 0;
  const TRANSLATION_INACTIVITY_TIMEOUT = 0;

  function streamChunkConcurrency(provider, baseURL = "") {
    const limit = LitMTrans.LLMInternals?.providerConcurrencyLimit?.(
      provider,
      STREAM_CHUNK_CONCURRENCY,
      baseURL
    );
    return Math.max(1, Math.trunc(Number(limit) || STREAM_CHUNK_CONCURRENCY));
  }

  function compactReferenceMarkdown(text) {
    return String(text || "")
      .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
      .replace(/<img\b[^>]*>/gis, "")
      .replace(/<details\b[^>]*>[\s\S]*?<\/details>/gis, "")
      .replace(/\n{4,}/g, "\n\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function referenceContextInstruction(referenceContext) {
    if (!String(referenceContext || "").trim()) return "";
    return (
      " An optional direct target-journal/domain reference corpus is supplied by the user. " +
      "Use it only as soft evidence for terminology, collocations, register, sentence rhythm, and discourse conventions. " +
      "The source paper always has priority. Never import facts, claims, data, citations, mechanisms, formulas, or certainty from references, " +
      "and never copy or patchwrite their sentences."
    );
  }

  function languageSlug(language) {
    return U.safeStem(String(language || "target"), 32, "target").toLowerCase();
  }

  function completionInstruction(marker) {
    return (
      "Completion token requirement:\n" +
      `- The exact completion token is: ${marker}\n` +
      "- This token is a machine-detection sentinel, not a phrase to translate.\n" +
      "- Do NOT replace it with 'TRANSLATION COMPLETE', 'translation complete', '完成', '结束', or any other words.\n" +
      "- After the entire translation is complete, output the exact token on a new final line.\n" +
      "- The final line must contain only the token itself, with no prefix, suffix, label, explanation, punctuation, or code fence."
    );
  }

  async function stableTranslationMarker(markdown) {
    try {
      const bytes = new TextEncoder().encode(String(markdown || ""));
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      let prefix = 0n;
      for (let index = 0; index < 6; index++) prefix = (prefix << 8n) | BigInt(digest[index]);
      return `<<<${String(prefix % 100000000n).padStart(8, "0")}>>>`;
    }
    catch (_) {
      const prefix = String(U.hashString(markdown)).slice(0, 12);
      const number = Number.parseInt(prefix, 16) % 100000000;
      return `<<<${String(number || 0).padStart(8, "0")}>>>`;
    }
  }

  function translationMarkerDetected(text, marker) {
    const value = String(text || "");
    if (!marker) return false;
    if (value.includes(marker)) return true;
    const digits = String(marker).replace(/\D/g, "");
    if (!digits) return false;
    const separators = "[\\s_\\-.,:;|/\\\\]*";
    const pattern = new RegExp(`(?<!\\d)${digits.split("").join(separators)}`, "u");
    return pattern.test(value.slice(-1200));
  }

  function stripTranslationMarker(text, marker) {
    let value = String(text || "");
    const exactStart = marker ? value.lastIndexOf(marker) : -1;
    if (exactStart >= 0) {
      const lineStart = value.lastIndexOf("\n", exactStart - 1) + 1;
      const prefix = value.slice(lineStart, exactStart);
      const start = !prefix.trim() || /^[\W_]+$/u.test(prefix.trim()) ? lineStart : exactStart;
      return value.slice(0, start).trimEnd() + "\n";
    }
    const digits = String(marker || "").replace(/\D/g, "");
    if (digits) {
      const separators = "[\\s_\\-.,:;|/\\\\]*";
      const pattern = new RegExp(`(?<!\\d)${digits.split("").join(separators)}`, "gu");
      const matches = [...value.matchAll(pattern)];
      const match = matches.at(-1);
      if (match) {
        let start = Number(match.index);
        const lineStart = value.lastIndexOf("\n", start - 1) + 1;
        const prefix = value.slice(lineStart, start);
        if (!prefix.trim() || /^[\W_]+$/u.test(prefix.trim())) start = lineStart;
        value = value.slice(0, start);
      }
    }
    return value.trimEnd() + "\n";
  }

  function cleanTranslationTailArtifacts(text, marker = "") {
    let normalized = String(text || "").trimEnd();
    if (marker) normalized = stripTranslationMarker(normalized, marker).trimEnd();
    const lines = normalized.split("\n");
    if (!lines.length || (lines.length === 1 && !lines[0])) return "\n";
    const tailWindow = 6;
    const head = lines.length > tailWindow ? lines.slice(0, -tailWindow) : [];
    const tail = lines.length > tailWindow ? lines.slice(-tailWindow) : lines.slice();
    const label = /^(?:(?:结束标记|截止标记|完成标记|结束符|标记|end\s*marker|completion\s*token|stop\s*marker|final\s*marker|marker|token)\s*[：:\-—]?\s*(?:<<<.*?>>>|[\[(]?\s*\d[\d\s_\-.,:;|/\\]*\s*[\])])?)$/iu;
    const dangling = /^(?:<<<.*?|>>>|[（(]?\s*(?:end\s*marker|marker|token|结束标记|截止标记|标记)\s*[)）]?)$/iu;
    while (tail.length) {
      const last = tail.at(-1).trim();
      if (!last || label.test(last) || dangling.test(last)) tail.pop();
      else break;
    }
    return [...head, ...tail].join("\n").trimEnd() + "\n";
  }

  function continuationPrompt(targetLanguage, marker) {
    return (
      `Continue translating from the exact previous interruption point into ${targetLanguage}. ` +
      "Do not repeat translated content. Continue preserving Markdown, formulas, image placeholders, links, and anchor ids. " +
      "Keep gently repairing only obvious Markdown/LaTeX/formatting defects, without inventing missing scientific content. " +
      "The surrounding application will continue automatically if this reply ends before the full paper is finished, so keep translating as far as possible instead of stopping early because of length concerns. " +
      "Never mention token limits, context windows, truncation, or capacity constraints. " +
      "Never ask the user to split the paper into sections or resend parts. " +
      "Continue directly with the remaining translation and output only translated Markdown plus the final completion token when finished. " +
      "When the full text is finally completed, output the exact machine-detection completion token on a separate final line. " +
      "Do not replace it with TRANSLATION COMPLETE or any other words.\n" +
      completionInstruction(marker)
    );
  }

  class TranslationService {
    constructor(storage, llm, mineru = null, webMachine = null) {
      this.storage = storage;
      this.llm = llm;
      this.mineru = mineru;
      this.webMachine = webMachine;
    }

    translationIdentity(markdown, settings, mode) {
      return U.hashString([
        markdown,
        settings.provider,
        settings.baseURL,
        settings.model,
        settings.targetLanguage,
        mode,
        settings.referenceIdentity || "",
        settings.customTranslationInstruction || ""
      ].join("\u241f"));
    }

    paths(documentID, targetLanguage) {
      const slug = languageSlug(targetLanguage);
      const root = this.storage.path(documentID, "translation");
      return {
        root,
        final: PathUtils.join(root, `translation.${slug}.md`),
        meta: PathUtils.join(root, `translation.${slug}.json`),
        guide: PathUtils.join(root, `translation-guide.${slug}.md`),
        transcript: PathUtils.join(root, `full-context.${slug}.transcript.json`),
        state: PathUtils.join(root, `full-context.${slug}.state.json`),
        live: PathUtils.join(root, `full-context.${slug}.live.md`),
        progress: PathUtils.join(root, `translation.${slug}.progress.json`),
        partPrefix: `full-context.${slug}.part-`,
        chunkPrefix: `chunk.${slug}.`
      };
    }

    async publishFinal(paths, markdown, meta) {
      // Keep temporary files out of the document path. Target-language names
      // may be non-ASCII and the document/profile path can already be long on
      // Windows, causing IOUtils.write to fail before the atomic publish.
      const stagingRoot = this.storage.temporaryDir
        ? this.storage.temporaryDir("trans")
        : paths.root;
      const stagedFinal = PathUtils.join(stagingRoot, "translation.md");
      const stagedMeta = PathUtils.join(stagingRoot, "translation.json");
      await this.storage.writeText(stagedFinal, markdown);
      await this.storage.writeJSON(stagedMeta, meta);
      try {
        await this.storage.publishFilesAtomically([
          { source: stagedFinal, destination: paths.final },
          { source: stagedMeta, destination: paths.meta }
        ]);
      }
      finally {
        await this.storage.remove(stagedFinal, false);
        await this.storage.remove(stagedMeta, false);
        if (this.storage.temporaryDir) await this.storage.remove(stagingRoot, true);
      }
      await this.storage.remove(paths.progress, false);
    }

    async manualCompletionMarker(markdown) {
      return stableTranslationMarker(markdown);
    }

    async importManualTranslation(documentID, sourceMarkdown, responses, emit = null) {
      const settings = this.llm.getSettings("translation");
      const marker = await this.manualCompletionMarker(sourceMarkdown);
      const raw = (Array.isArray(responses) ? responses : [responses])
        .map(response => String(response || "").trim().replace(/^```text\s*\n?/i, "").replace(/\n?```\s*$/, "").trim())
        .filter(Boolean)
        .join("\n");
      if (!translationMarkerDetected(raw, marker)) {
        throw new Error(`未检测到完整翻译的结束标记 ${marker}。请让AI继续翻译，并在最后一行原样输出该标记。`);
      }
      const text = cleanTranslationTailArtifacts(raw, marker).trim();
      if (!text) throw new Error("请先粘贴AI的翻译结果");
      const paths = this.paths(documentID, settings.targetLanguage);
      await this.storage.ensureDir(paths.root);
      const markdown = M.repairEquationReferenceTranslation(
        sourceMarkdown,
        M.normalizeTranslatedInlineHTML(text)
      ).trimEnd() + "\n";
      const meta = {
        identity: U.hashString([sourceMarkdown, settings.targetLanguage, "manual-translation-v1"].join("\u241f")),
        sourceFingerprint: U.hashString(sourceMarkdown),
        mode: "manual",
        complete: true,
        provider: "manual",
        targetLanguage: settings.targetLanguage,
        completedAt: new Date().toISOString()
      };
      await this.publishFinal(paths, markdown, meta);
      emit?.({ type: "translation", mode: "manual", markdown, complete: true });
      return { markdown, meta };
    }

    async buildReferenceCorpus(documentID, settings, emit, signal) {
      const paths = [...new Set(
        (Array.isArray(settings.translationReferencePaths) ? settings.translationReferencePaths : [])
          .map(item => String(item || "").trim())
          .filter(Boolean)
      )];
      if (!paths.length) return { corpus: "", identity: "", documents: [] };
      if (paths.length > REFERENCE_RECOMMENDED_FILES) {
        emit?.({
          type: "warning",
          message: `已添加${paths.length}个参考文件。文件较多时，处理时间可能增加，部分服务也可能无法一次接收全部内容。`
        });
      }

      const root = this.storage.path(documentID, "reference-context");
      const parsedRoot = PathUtils.join(root, "parsed");
      await this.storage.ensureDir(parsedRoot);
      const results = new Array(paths.length);
      let nextIndex = 0;
      let completedCount = 0;
      let firstError = null;
      const referenceController = U.newAbortController();
      const referenceSignal = referenceController.signal;
      const relayAbort = () => {
        if (!referenceSignal.aborted) referenceController.abort(signal?.reason || "操作已停止");
      };
      if (signal?.aborted) relayAbort();
      else signal?.addEventListener?.("abort", relayAbort, { once: true });
      const prepareReference = async index => {
        U.throwIfAborted(referenceSignal);
        const filePath = paths[index];
        const fileName = PathUtils.filename(filePath) || filePath;
        const stat = await this.storage.stat(filePath);
        if (!stat || stat.type === "directory") throw new Error(`参考文件不存在：${fileName}`);
        const extension = U.extension(filePath);
        const emitReference = event => {
          if (!event) return;
          const payload = { ...event };
          if (payload.message) payload.message = `[参考 ${index + 1}/${paths.length}] ${payload.message}`;
          emit?.(payload);
        };
        emitReference({
          type: "status",
          phase: "reference-context",
          message: `正在准备：${fileName}`,
          progress: Math.round(completedCount * 100 / Math.max(1, paths.length))
        });
        let markdown = "";
        if ([".md", ".markdown", ".txt"].includes(extension)) {
          markdown = await this.storage.readText(filePath, "");
        }
        else if (C.SUPPORTED_INPUT_EXTENSIONS.has(extension)) {
          if (!this.mineru?.parseExternalReference) {
            throw new Error(`参考文件解析服务未就绪，请重启LitMTrans后重试：${fileName}`);
          }
          const parsed = await this.mineru.parseExternalReference(filePath, parsedRoot, {
            modelVersion: settings.mineruModel || "vlm",
            isOCR: false,
            enableFormula: true,
            enableTable: true
          }, emitReference, referenceSignal);
          markdown = parsed.markdown;
        }
        else {
          throw new Error(`暂不支持这种参考文件格式：${extension || "无扩展名"}`);
        }
        const compacted = compactReferenceMarkdown(markdown);
        results[index] = {
          fingerprint: [filePath, stat.size || 0, stat.lastModified || 0].join("|"),
          document: compacted ? { name: fileName, markdown: compacted } : null
        };
        completedCount += 1;
        emitReference({
          type: "status",
          phase: "reference-context",
          message: `已准备：${fileName}`,
          progress: Math.round(completedCount * 100 / Math.max(1, paths.length))
        });
      };
      const runReferenceWorker = async () => {
        while (!firstError) {
          const index = nextIndex++;
          if (index >= paths.length) return;
          try {
            await prepareReference(index);
          }
          catch (error) {
            if (!firstError) {
              firstError = error;
              referenceController.abort(error?.message || "参考文件准备失败");
            }
          }
        }
      };
      try {
        await Promise.all(Array.from({ length: Math.min(2, Math.max(1, paths.length)) }, () => runReferenceWorker()));
      }
      finally {
        signal?.removeEventListener?.("abort", relayAbort);
      }
      if (firstError) throw firstError;
      const fingerprints = results.map(result => result.fingerprint);
      const documents = results.map(result => result.document).filter(Boolean);
      const identity = U.hashString([
        "v3_full_direct_corpus",
        settings.targetLanguage,
        ...fingerprints
      ].join("\n"));
      const cachePath = PathUtils.join(root, `reference-corpus.${identity}.md`);
      const cached = await this.storage.readText(cachePath, "");
      if (cached) return { corpus: cached, identity, documents };

      let totalChars = 0;
      const sections = [];
      for (let index = 0; index < documents.length; index++) {
        const item = documents[index];
        totalChars += item.markdown.length;
        sections.push(
          `===== Full reference corpus ${index + 1}: ${item.name} =====\n` +
          item.markdown + "\n" +
          `===== End full reference corpus ${index + 1}: ${item.name} =====`
        );
      }
      if (!sections.length) return { corpus: "", identity, documents: [] };
      if (totalChars > REFERENCE_WARNING_CHARS) {
        emit?.({
          type: "warning",
          message: `参考文件内容较多，部分服务可能无法一次处理全部内容；可以减少参考文件后重试。`
        });
      }
      const corpus = (
        `【Direct Reference Corpus for Translation into ${settings.targetLanguage}】\n` +
        "The following materials are complete user-selected target-language/domain reference papers. " +
        "They are provided directly, without prior summarization or sampling, so that the translator can absorb terminology, collocations, register, sentence rhythm, discourse flow, and academic expression habits from intact discourse.\n\n" +
        "Use policy:\n" +
        "1. Treat the corpus as soft stylistic and terminological evidence only.\n" +
        "2. The source document to be translated has absolute priority over the reference corpus.\n" +
        "3. Do not import facts, claims, citations, data, mechanisms, experimental conditions, or certainty levels from the references.\n" +
        "4. Do not copy or patchwrite reference sentences; avoid plagiarism and excessive imitation.\n" +
        "5. If the reference style conflicts with the source meaning, preserve the source meaning.\n" +
        "6. Prefer broadly accepted academic usage visible across the corpus rather than idiosyncratic wording from one paper.\n" +
        "7. The real translation source will appear after this corpus; translate that source, not the references.\n\n" +
        sections.join("\n\n")
      );
      await this.storage.writeText(cachePath, corpus);
      await this.storage.writeJSON(cachePath + ".json", {
        identity,
        files: documents.map(item => item.name),
        totalChars,
        createdAt: new Date().toISOString()
      });
      return { corpus, identity, documents };
    }

    async load(documentID, targetLanguage = null) {
      const settings = this.llm.getSettings();
      const paths = this.paths(documentID, targetLanguage || settings.targetLanguage);
      const [markdown, meta, live] = await Promise.all([
        this.storage.readText(paths.final, ""),
        this.storage.readJSON(paths.meta, null),
        this.storage.readText(paths.live, "")
      ]);
      return { markdown, meta, live };
    }

    async audit(documentID, requestKind, settings, messages, timeout, promptCacheKey = "") {
      return this.storage.writeRequestAudit?.(
        documentID,
        requestKind,
        { ...settings, promptCacheKey },
        messages,
        timeout / 1000
      );
    }

    async buildGuide(markdown, documentID, settings, paths, emit, signal) {
      const existing = await this.storage.readText(paths.guide, "");
      const guideMeta = await this.storage.readJSON(paths.guide + ".json", null);
      const key = U.hashString([markdown, settings.provider, settings.model, settings.targetLanguage].join("|"));
      if (existing && guideMeta?.key === key) return existing;
      emit?.({ type: "status", phase: "translation-guide", message: "正在整理全文术语和行文风格" });
      const sample = markdown.slice(0, 24000);
      const messages = [
        {
          role: "system",
          content: "You are a terminology reviewer for academic paper translation projects."
        },
        {
          role: "user",
          content: (
            `Please read the following academic-paper Markdown excerpt and prepare a concise translation guide for translating the paper into ${settings.targetLanguage}.\n` +
            `${U.targetLanguageInstruction(settings.targetLanguage)}\n` +
            "The excerpt may contain parsing/OCR/Markdown/LaTeX defects. Identify the research field, style requirements, key terminology, and any formatting risks that should be handled carefully during translation.\n" +
            "Include a terminology table mapping source terms to recommended target-language terms. Do not translate the full paper.\n\n" +
            sample
          )
        }
      ];
      await this.audit(documentID, "流式-术语指南", settings, messages, TRANSLATION_REQUEST_TIMEOUT, settings.promptCacheKey);
      const result = await this.llm.complete(messages, {
        purpose: "translation",
        documentID,
        provider: settings.provider,
        baseURL: settings.baseURL,
        model: settings.model,
        apiKey: settings.apiKey,
        promptCacheKey: settings.promptCacheKey,
        engine: settings.engine,
        aiMode: settings.aiMode,
        runtime: settings.runtime,
        emit,
        timeout: TRANSLATION_REQUEST_TIMEOUT,
        firstEventTimeout: TRANSLATION_FIRST_EVENT_TIMEOUT,
        inactivityTimeout: TRANSLATION_INACTIVITY_TIMEOUT,
        signal,
        onRateLimitWait: ({ waitMs }) => emit?.({
          type: "status",
          phase: "rate-limit-wait",
          message: `Gemini请求频率受限，约 ${Math.ceil(waitMs / 1000)} 秒后自动继续`
        }),
        onText: delta => emit?.({ type: "guide-delta", delta }),
        onReasoning: delta => emit?.({ type: "reasoning", delta, scope: "guide" })
      });
      await this.storage.writeText(paths.guide, result.text);
      await this.storage.writeJSON(paths.guide + ".json", { key, createdAt: new Date().toISOString() });
      return result.text;
    }

    baseSystemPrompt(settings) {
      return (
        `You are a professional academic translator and Markdown cleanup editor. Translate the provided academic-paper Markdown into ${settings.targetLanguage}. ` +
        `${U.targetLanguageInstruction(settings.targetLanguage)} ` +
        "The source Markdown may contain OCR/parsing defects, broken Markdown tables, imperfect LaTeX, misplaced spaces, duplicated line breaks, or formatting that does not fully reproduce the original paper. " +
        "Use academic judgment to repair obvious Markdown/LaTeX/formatting defects while translating, but do not invent missing data, references, equations, captions, or conclusions. " +
        "Preserve the document structure, headings, tables, code blocks, inline code, HTML tags, links, and image placeholders such as IMAGE_001. " +
        "Keep anchor tags, ids, image references, and table structure intact whenever they are present. " +
        "Be conservative about formatting: do not turn normal prose into headings, captions, centered text, bold text, lists, or tables unless the Markdown structure clearly indicates it. " +
        "Act like a careful journal copy editor for layout cleanup: keep ordinary body paragraphs as body text with normal paragraph flow, repair obvious paragraph breaks, and separate merged captions from explanatory prose. " +
        "Figure/table captions should remain separate from body paragraphs; true captions such as 'Figure 1.', 'Fig. 1', 'Table 2.', or their translated equivalents should be caption-like blocks, while body paragraphs that merely mention figures or tables, such as 'Figure 1 shows ...' or 'Table 2 reports ...', must stay normal paragraphs. " +
        "Where the rendered output supports it, captions should be visually distinct from body text: centered where appropriate, slightly smaller than body text, and not followed by accidental centered body paragraphs. " +
        "Preserve or normalize citation markers as academic citations; bracketed numeric references such as [1], [2-4], and [5,6] should remain citation tokens suitable for superscript styling in PDF export rather than being translated into prose. " +
        "Preserve equation-number references exactly: translate 'Eq. (16)' or 'Eqs. (3) and (4)' as normal equation references with the original parenthesized numbers, never as ~16!, ~3!, punctuation, or prose words. " +
        "Hard output rule: this reader renders mathematics with MathJax. A formula is part of the paper's meaning, not formatting. Copy every mathematical expression verbatim, including its TeX body and delimiters such as \\(...\\), \\[...\\], $...$, and $$...$$. A naked TeX body such as R _ { 0 } is not renderable. Translate surrounding prose only; never rewrite, normalize, omit, or move a formula. " +
        "If a formula, number, symbol, citation, or fragment is ambiguous, keep the original token rather than guessing. Do not add explanations, comments, or code fences." +
        (settings.customTranslationInstruction
          ? `\n\nUser-provided translation instructions (follow these when they do not conflict with the source document's facts):\n${settings.customTranslationInstruction}`
          : "")
      );
    }

    async translate(documentID, markdown, options = {}, emit = null, signal = null) {
        if (!String(markdown || "").trim()) throw new Error("当前文档尚未完成解析");
      const settings = { ...this.llm.getSettings("translation"), ...options };
      if (LitMTrans.WebMachineTranslation?.isWebMachineProvider(settings.provider)) {
        return this.translateWebMachine(documentID, markdown, settings, emit, signal);
      }
      const isWeb = this.llm.isWebEngineActive?.({ purpose: "translation", ...options, ...settings });
      let resolvedModel;
      if (isWeb) {
        resolvedModel = { provider: "deepseek_web", model: "deepseek-web", baseURL: "" };
        settings.provider = "deepseek_web";
        settings.baseURL = "";
        settings.model = "deepseek-web";
        settings.engine = "deepseek_web";
        settings.aiMode = "web";
        settings.runtime = options.runtime;
      } else {
        resolvedModel = await this.llm.ensureConfiguredModel(
          this.llm.resolveConfig({
            purpose: "translation",
            engine: "api",
            aiMode: "api",
            provider: settings.provider,
            baseURL: settings.baseURL,
            model: settings.model,
            apiKey: settings.apiKey
          }),
          signal
        );
        settings.provider = resolvedModel.provider;
        settings.baseURL = resolvedModel.baseURL;
        settings.model = resolvedModel.model;
        settings.engine = "api";
        settings.aiMode = "api";
      }
      const mode = String(options.mode || settings.translationMode || "full_context");
      if (mode === "layout") throw new Error("排版翻译暂时无法启动，请稍后重试");
      const paths = this.paths(documentID, settings.targetLanguage);
      await this.storage.ensureDir(paths.root);
      const reference = await this.buildReferenceCorpus(documentID, settings, emit, signal);
      settings.referenceContext = reference.corpus;
      settings.referenceIdentity = reference.identity;
      const identity = this.translationIdentity(markdown, settings, mode);
      settings.sourceFingerprint = U.hashString(markdown);
      settings.promptCacheKey = U.opaqueCacheKey(
        "translation",
        documentID,
        settings.model,
        settings.targetLanguage,
        identity
      );
      const [meta, cached] = await Promise.all([
        this.storage.readJSON(paths.meta, null),
        this.storage.readText(paths.final, "")
      ]);
      if (!options.force && cached && meta?.identity === identity && meta?.complete) {
        emit?.({ type: "translation", mode, markdown: cached, complete: true, cached: true });
        return { markdown: cached, meta, cached: true };
      }
      const clearWorkingState = async () => {
        const workingNames = [
          PathUtils.filename(paths.guide),
          PathUtils.filename(paths.guide) + ".json",
          PathUtils.filename(paths.transcript),
          PathUtils.filename(paths.state),
          PathUtils.filename(paths.live),
          PathUtils.filename(paths.progress)
        ];
        for (const entry of await this.storage.list(paths.root)) {
          const name = PathUtils.filename(entry);
          if (
            workingNames.includes(name)
            || name.startsWith(paths.chunkPrefix)
            || name.startsWith(paths.partPrefix)
          ) {
            await this.storage.remove(entry, true);
          }
        }
      };
      if (options.force) {
        await clearWorkingState();
        emit?.({ type: "log", message: "正在重新翻译。新译文完成前，当前译文仍可继续阅读。" });
      }
      else if (meta?.identity && meta.identity !== identity) {
        await clearWorkingState();
        emit?.({ type: "log", message: "原文或翻译设置已更改，正在按新设置生成译文。当前译文会保留到新版完成。" });
      }
      if (mode === "chunked") return this.translateChunked(documentID, markdown, settings, paths, identity, emit, signal);
      return this.translateFullContext(documentID, markdown, settings, paths, identity, emit, signal);
    }

    async translateWebMachine(documentID, markdown, settings, emit, signal) {
      if (!this.webMachine) throw new Error("联网翻译服务未加载");
      const mode = "web-machine";
      const provider = U.providerSpec(settings.provider).id;
      const edgeLocal = provider === "edge_local";
      const sourceLanguage = edgeLocal ? settings.machineSourceLanguage : settings.sourceLanguage;
      const paths = this.paths(documentID, settings.targetLanguage);
      await this.storage.ensureDir(paths.root);
      if (Array.isArray(settings.translationReferencePaths) && settings.translationReferencePaths.length) {
        emit?.({ type: "log", message: `${edgeLocal ? "Edge本地翻译" : "联网翻译"}不使用参考文件，已忽略本次添加的参考文件。` });
      }
      if (String(settings.customTranslationInstruction || "").trim()) {
        emit?.({ type: "log", message: `${edgeLocal ? "Edge本地翻译" : "联网翻译"}不使用自定义翻译要求，已忽略本次设置。` });
      }
      const webSettings = {
        ...settings,
        // Neither references nor custom prompt text participates in the web
        // translator request or its cache identity. Preserve the saved values
        // in preferences so they return when the user switches back to an LLM.
        translationReferencePaths: [],
        customTranslationInstruction: "",
        referenceContext: "",
        referenceIdentity: ""
      };
      const identity = this.translationIdentity(markdown, {
        ...webSettings,
        provider,
        baseURL: "",
        model: edgeLocal ? `edge-on-device-v1-${sourceLanguage}` : "google-then-bing-web-v2-no-context",
        referenceIdentity: ""
      }, mode);
      const [cached, previous] = await Promise.all([
        this.storage.readText(paths.final, ""),
        this.storage.readJSON(paths.meta, null)
      ]);
      if (!settings.force && cached && previous?.identity === identity && previous?.complete) {
        emit?.({ type: "translation", mode, markdown: cached, complete: true, cached: true });
        return { markdown: cached, meta: previous, cached: true };
      }
      emit?.({
        type: "status",
        phase: "web-machine-probe",
        message: edgeLocal ? "正在启动Edge本地翻译…" : "正在连接联网免费机翻，必要时将自动切换Bing。",
        progress: 0
      });
      const markdownResult = await this.webMachine.translateMarkdown(markdown, {
        provider,
        targetLanguage: webSettings.targetLanguage,
        sourceLanguage,
        signal,
        log: message => emit?.({ type: "log", message }),
        liveUpdate: live => emit?.({ type: "translation", mode, markdown: live, complete: false })
      });
      const meta = {
        identity,
        sourceFingerprint: U.hashString(markdown),
        mode,
        complete: true,
        provider,
        service: edgeLocal ? "Edge本地翻译" : "联网免费机翻（Google / Bing）",
        sourceLanguage,
        targetLanguage: settings.targetLanguage,
        completedAt: new Date().toISOString()
      };
      await this.publishFinal(paths, markdownResult, meta);
      emit?.({ type: "translation", mode, markdown: markdownResult, complete: true });
      return { markdown: markdownResult, meta, cached: false };
    }

    async translateChunked(documentID, markdown, settings, paths, identity, emit, signal) {
      const guide = await this.buildGuide(markdown, documentID, settings, paths, emit, signal);
      const chunks = M.splitForTranslation(markdown, Number(settings.chunkChars || 135000));
      const system = this.baseSystemPrompt(settings);
      const concurrency = streamChunkConcurrency(settings.provider, settings.baseURL);
      await this.storage.writeJSON(paths.progress, {
        identity,
        sourceFingerprint: settings.sourceFingerprint,
        mode: "chunked",
        protocol: STREAM_PROTOCOL_VERSION,
        complete: false,
        provider: settings.provider,
        baseURL: settings.baseURL,
        model: settings.model,
        targetLanguage: settings.targetLanguage,
        chunkCount: chunks.length,
        concurrency,
        maxRoundsPerChunk: STREAM_CONTINUATION_MAX_ROUNDS,
        startedAt: new Date().toISOString()
      });

      const results = new Array(chunks.length);
      const committed = [];
      const errors = [];
      let nextWorkIndex = 0;
      let nextCommitIndex = 0;
      let commitChain = Promise.resolve();

      const commitResult = async (index, translatedChunk, cachedChunk) => {
        results[index] = { translatedChunk, cachedChunk };
        commitChain = commitChain.then(async () => {
          while (nextCommitIndex < results.length && results[nextCommitIndex]) {
            const item = results[nextCommitIndex];
            committed.push(item.translatedChunk.trimEnd());
            nextCommitIndex++;
            const current = committed.join("\n\n") + "\n";
            await this.storage.writeText(paths.live, current);
            emit?.({
              type: "translation",
              mode: "chunked",
              markdown: current,
              complete: false,
              chunk: nextCommitIndex,
              chunkCount: chunks.length,
              cachedChunk: item.cachedChunk
            });
          }
        });
        await commitChain;
      };

      const translateOneChunk = async index => {
        U.throwIfAborted(signal);
        const chunk = chunks[index];
        const chunkKey = U.hashString(chunk);
        const cachePath = PathUtils.join(paths.root, `${paths.chunkPrefix}${String(index + 1).padStart(4, "0")}.${chunkKey}.md`);
        const cacheMetaPath = cachePath + ".json";
        const statePath = cachePath + ".state.json";
        const cacheMeta = await this.storage.readJSON(cacheMetaPath, null);
        let translatedChunk = await this.storage.readText(cachePath, "");
        if (
          translatedChunk &&
          cacheMeta?.protocol === STREAM_PROTOCOL_VERSION &&
          cacheMeta?.identity === identity &&
          cacheMeta?.chunkKey === chunkKey &&
          cacheMeta?.complete
        ) {
          translatedChunk = M.repairEquationReferenceTranslation(chunk, M.normalizeTranslatedInlineHTML(translatedChunk));
          return { translatedChunk: translatedChunk.trim(), cachedChunk: true };
        }

        emit?.({
          type: "status",
          phase: "translate-chunk",
          message: `正在翻译第${index + 1}/${chunks.length}部分`,
          progress: Math.round(index * 100 / chunks.length)
        });
        let marker = await stableTranslationMarker(`${identity}\n${index + 1}\n${chunkKey}\n${chunk}`);
        const userPrompt = (
          (settings.referenceContext
            ? `Optional direct target-journal/domain reference corpus loaded from cache. Read for style and terminology only; translate the source chunk after it:\n\n${settings.referenceContext}\n\n`
            : "") +
          `Translation guide for this paper:\n\n${guide}\n\n` +
          `Translate the following academic-paper Markdown source chunk into ${settings.targetLanguage}. ${U.targetLanguageInstruction(settings.targetLanguage)} ` +
          "While translating, gently fix clear Markdown/table formatting problems caused by parsing, such as malformed table separators, obvious heading/caption formatting issues, and excessive line breaks. Preserve meaning and do not over-correct uncertain scientific content. " +
          "Do not introduce new centering, bolding, heading levels, list markers, or caption formatting unless the source Markdown clearly marks that block as such. " +
          "As a journal copy editor, split true figure/table captions away from surrounding explanatory paragraphs when they are merged, and restore the surrounding explanation to normal paragraph formatting. " +
          "Keep figure/table captions separate from body paragraphs; a paragraph that discusses a figure/table is still normal prose. Captions may be centered or caption-styled only when the block is clearly a caption. " +
          "Keep numeric reference citations such as [1], [2-4], and [5,6] intact as citation markers suitable for superscript PDF export styling. " +
          "Hard output rule: the reader uses MathJax. Copy every source formula verbatim with its TeX body and delimiters; never emit a naked TeX body such as R _ { 0 }. Translate only the surrounding natural language. " +
          "Keep equation-number references such as Eq. (16) and Eqs. (3) and (4) as equation references with the original parenthesized numbers; never turn them into ~16!, ~3!, punctuation, or prose words. " +
          "Use the optional direct reference corpus only for terminology, collocation, register, rhythm, and target-field conventions; never distort the source meaning to fit it. " +
          "Preserve image references, HTML tags, links, anchor ids, and all placeholders. Do not omit content and do not add explanations. " +
          "If one response is not enough, translate as far as possible; the application will ask you to continue in the same chunk conversation.\n\n" +
          completionInstruction(marker) + "\n\n" +
          "===== BEGIN SOURCE CHUNK TO TRANSLATE =====\n" + chunk + "\n===== END SOURCE CHUNK TO TRANSLATE =====\n\n" +
          "Final reminder:\n" + completionInstruction(marker)
        );

        let messages = [];
        let parts = [];
        let startRound = 1;
        let emptyRounds = 0;
        let repeatedRounds = 0;
        const savedState = await this.storage.readJSON(statePath, null);
        if (
          savedState?.protocol === STREAM_PROTOCOL_VERSION &&
          savedState?.identity === identity &&
          savedState?.chunkKey === chunkKey &&
          savedState?.marker &&
          Array.isArray(savedState.messages) &&
          Array.isArray(savedState.parts) &&
          !savedState.complete &&
          Number(savedState.round) > 0 &&
          Number(savedState.round) < STREAM_CONTINUATION_MAX_ROUNDS
        ) {
          marker = String(savedState.marker);
          messages = savedState.messages
            .filter(message => message && ["system", "user", "assistant"].includes(message.role) && typeof message.content === "string")
            .map(message => ({ role: message.role, content: message.content }));
          parts = savedState.parts.map(part => String(part || "")).filter(Boolean);
          startRound = Number(savedState.round) + 1;
          emptyRounds = Number(savedState.emptyRounds || 0);
          repeatedRounds = Number(savedState.repeatedRounds || 0);
          if (messages.at(-1)?.role === "assistant") {
            messages.push({ role: "user", content: continuationPrompt(settings.targetLanguage, marker) });
          }
          emit?.({ type: "log", message: `正在继续第${index + 1}部分的翻译。` });
        }
        else {
          messages = [
            { role: "system", content: system + " " + completionInstruction(marker) },
            { role: "user", content: userPrompt }
          ];
        }

        let complete = false;
        for (let round = startRound; round <= STREAM_CONTINUATION_MAX_ROUNDS; round++) {
          U.throwIfAborted(signal);
          await this.audit(
            documentID,
            `流式-分块翻译-第${index + 1}块-第${round}轮`,
            settings,
            messages,
            TRANSLATION_REQUEST_TIMEOUT,
            settings.promptCacheKey
          );
          let live = "";
          const result = await this.llm.complete(messages, {
            purpose: "translation",
            documentID,
            provider: settings.provider,
            baseURL: settings.baseURL,
            model: settings.model,
            apiKey: settings.apiKey,
            promptCacheKey: settings.promptCacheKey,
            engine: settings.engine,
            runtime: settings.runtime,
            emit,
            timeout: TRANSLATION_REQUEST_TIMEOUT,
            firstEventTimeout: TRANSLATION_FIRST_EVENT_TIMEOUT,
            inactivityTimeout: TRANSLATION_INACTIVITY_TIMEOUT,
            signal,
            onRateLimitWait: ({ waitMs }) => emit?.({
              type: "status",
              phase: "rate-limit-wait",
              message: `Gemini请求频率受限，约 ${Math.ceil(waitMs / 1000)} 秒后继续第 ${index + 1} 块`
            }),
            onText: delta => {
              live += delta;
              if (index !== nextCommitIndex) return;
              emit?.({
                type: "translation",
                mode: "chunked",
                complete: false,
                chunk: index + 1,
                chunkCount: chunks.length,
                round,
                delta
              });
            },
            onReasoning: delta => emit?.({
              type: "reasoning",
              delta,
              scope: "translation",
              chunk: index + 1,
              round
            })
          });
          const content = String(result.text || "");
          const normalizedContent = content.trim();
          emptyRounds = normalizedContent ? 0 : emptyRounds + 1;
          repeatedRounds = normalizedContent && normalizedContent === String(parts.at(-1) || "").trim()
            ? repeatedRounds + 1
            : 0;
          if (emptyRounds >= 3 || repeatedRounds >= 3) {
            throw new Error(`第${index + 1}部分多次续写后仍未完成。您可以稍后重试，已有进度不会丢失。`);
          }
          if (normalizedContent) parts.push(content);
          messages.push({ role: "assistant", content });
          complete = translationMarkerDetected(parts.join("\n"), marker);
          if (!complete) messages.push({ role: "user", content: continuationPrompt(settings.targetLanguage, marker) });
          await this.storage.writeJSON(statePath, {
            protocol: STREAM_PROTOCOL_VERSION,
            identity,
            chunkKey,
            marker,
            round,
            complete,
            emptyRounds,
            repeatedRounds,
            parts,
            messages,
            updatedAt: new Date().toISOString()
          });
          if (complete) break;
        }

        if (!complete) {
          throw new Error(
            `第${index + 1}部分未完整返回，已达到自动续写次数上限，请稍后重试。`
          );
        }
        translatedChunk = cleanTranslationTailArtifacts(parts.join("\n"), marker);
        translatedChunk = M.repairEquationReferenceTranslation(
          chunk,
          M.normalizeTranslatedInlineHTML(translatedChunk)
        ).trim();
        let issue = M.mathIntegrityIssue(chunk, translatedChunk);
        let retryIssue = M.mathRetryIssue(chunk, translatedChunk);
        if (issue && !retryIssue) {
          emit?.({
            type: "status",
            phase: "formula-review-warning",
            message: `第${index + 1}部分的公式需要核对，当前译文已保留。`
          });
        }
        if (retryIssue) {
          const retryMessages = [
            {
              role: "system",
              content: system + " " + completionInstruction(marker)
            },
            {
              role: "user",
              content: (
                "Re-translate the complete source chunk below. The previous complete draft damaged or omitted mathematical markup. " +
                "Output the entire corrected translation, not a patch and not an explanation. Copy every source formula verbatim with its TeX body and original delimiters. " +
                "Do not omit any paragraph.\n\n" +
                completionInstruction(marker) + "\n\n" +
                "===== BEGIN SOURCE CHUNK TO TRANSLATE =====\n" + chunk +
                "\n===== END SOURCE CHUNK TO TRANSLATE ====="
              )
            }
          ];
          await this.audit(
            documentID,
            `流式-分块严格重试-第${index + 1}块`,
            settings,
            retryMessages,
            TRANSLATION_REQUEST_TIMEOUT,
            settings.promptCacheKey
          );
          const retry = await this.llm.complete(retryMessages, {
            purpose: "translation",
            documentID,
            provider: settings.provider,
            baseURL: settings.baseURL,
            model: settings.model,
            apiKey: settings.apiKey,
            promptCacheKey: settings.promptCacheKey,
            engine: settings.engine,
            runtime: settings.runtime,
            timeout: TRANSLATION_REQUEST_TIMEOUT,
            firstEventTimeout: TRANSLATION_FIRST_EVENT_TIMEOUT,
            inactivityTimeout: TRANSLATION_INACTIVITY_TIMEOUT,
            signal,
            onRateLimitWait: ({ waitMs }) => emit?.({
              type: "status",
              phase: "rate-limit-wait",
              message: `Gemini请求频率受限，约 ${Math.ceil(waitMs / 1000)} 秒后继续校对`
            }),
            onReasoning: delta => emit?.({
              type: "reasoning",
              delta,
              scope: "translation-retry",
              chunk: index + 1
            })
          });
          if (translationMarkerDetected(retry.text, marker)) {
            const retryText = M.repairEquationReferenceTranslation(
              chunk,
              M.normalizeTranslatedInlineHTML(cleanTranslationTailArtifacts(retry.text, marker))
            ).trim();
            const correctedRetryIssue = M.mathRetryIssue(chunk, retryText);
            if (!correctedRetryIssue) {
              translatedChunk = retryText;
              issue = M.mathIntegrityIssue(chunk, retryText);
              retryIssue = "";
            }
          }
        }
        await this.storage.writeText(cachePath, translatedChunk + "\n");
        await this.storage.writeJSON(cacheMetaPath, {
          protocol: STREAM_PROTOCOL_VERSION,
          identity,
          chunkKey,
          marker,
          complete: true,
          rounds: parts.length,
          formulaIssue: issue,
          completedAt: new Date().toISOString()
        });
        await this.storage.remove(statePath, false);
        return { translatedChunk, cachedChunk: false };
      };

      const worker = async () => {
        while (!errors.length) {
          const index = nextWorkIndex++;
          if (index >= chunks.length) return;
          try {
            const result = await translateOneChunk(index);
            await commitResult(index, result.translatedChunk, result.cachedChunk);
          }
          catch (error) {
            errors.push({ index, error });
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(concurrency, Math.max(1, chunks.length)) },
          () => worker()
        )
      );
      await commitChain;
      if (errors.length) {
        const first = errors.sort((a, b) => a.index - b.index)[0];
        throw first.error;
      }

      const finalText = cleanTranslationTailArtifacts(committed.join("\n\n"));
      const formulaIssue = M.mathIntegrityIssue(markdown, finalText);
      // Formula-token comparison remains metadata because it is heuristic: a
      // model may alter TeX delimiters without changing the formula. Do not
      // present a raw count mismatch as a user-facing warning.
      await this.storage.writeText(paths.live, finalText);
      const meta = {
        identity,
        sourceFingerprint: settings.sourceFingerprint,
        mode: "chunked",
        complete: true,
        provider: settings.provider,
        baseURL: settings.baseURL,
        model: settings.model,
        targetLanguage: settings.targetLanguage,
        chunkCount: chunks.length,
        concurrency,
        maxRoundsPerChunk: STREAM_CONTINUATION_MAX_ROUNDS,
        protocol: STREAM_PROTOCOL_VERSION,
        formulaIssue,
        completedAt: new Date().toISOString()
      };
      await this.publishFinal(paths, finalText, meta);
      emit?.({ type: "translation", mode: "chunked", markdown: finalText, complete: true });
      return { markdown: finalText, meta, cached: false };
    }

    async translateFullContext(documentID, markdown, settings, paths, identity, emit, signal) {
      let marker = await stableTranslationMarker(markdown);
      const makeSystem = () => (
        this.baseSystemPrompt(settings) +
        " First understand the research field, core concepts, terminology chain, and argument structure. " +
        "Keep terminology consistent and use formal, accurate, fluent academic style. " +
        "The surrounding application is designed to continue automatically with follow-up requests if your reply ends before the full paper is finished, so keep translating as far as possible instead of stopping early because of length concerns. " +
        "Never mention token limits, context windows, truncation, or capacity constraints. Never ask the user to split the paper into sections or send it again in smaller chunks. " +
        "If the source is long, continue translating directly and output only translated Markdown, not a refusal, warning, or meta explanation. " +
        referenceContextInstruction(settings.referenceContext) + " " +
        completionInstruction(marker)
      );
      const makeUser = () => (
        `Translate the following academic-paper Markdown completely into ${settings.targetLanguage}.\n\n` +
        "Rules:\n" +
        "1. Understand the research field and terminology before translating.\n" +
        "2. Preserve all Markdown tables, formulas, image references, HTML anchor ids, and placeholders such as IMAGE_001.\n" +
        "3. While translating, fix obvious parsing-related Markdown/formatting defects, including broken table syntax, excessive line breaks, and malformed captions. Preserve every formula verbatim with its original TeX delimiters; never output naked TeX as ordinary text.\n" +
        "4. Act like a journal copy editor for clear layout damage: split captions away from merged explanatory paragraphs, restore ordinary paragraphs to normal body formatting, and prevent caption centering from leaking into following body text.\n" +
        "5. Be conservative about visual formatting: do not introduce new centering, bolding, heading levels, list markers, or caption formatting unless the original Markdown block clearly requires it.\n" +
        "6. Keep figure/table captions and body paragraphs distinct; sentences that discuss figures or tables, such as 'Figure 1 shows ...' or 'Table 2 reports ...', must remain normal paragraphs.\n" +
        "7. True figure/table captions may be caption-like blocks, centered when appropriate, and visually smaller than body text where the output format allows; surrounding explanatory paragraphs must stay normal body text.\n" +
        "8. Preserve numeric reference citations such as [1], [2-4], and [5,6] as citation markers suitable for superscript styling in PDF export.\n" +
        "9. Preserve equation-number references such as Eq. (16) and Eqs. (3) and (4) as equation references with the original parenthesized numbers; never turn them into ~16!, ~3!, punctuation, or prose words.\n" +
        "10. Do not over-correct: if a formula, number, citation, symbol, or sentence fragment is ambiguous, keep the original token or translate literally rather than guessing.\n" +
        "11. Do not invent missing content, do not delete difficult content, and do not add translator notes or explanations.\n" +
        "12. If an optional direct reference corpus is provided, use it only for terminology, collocation, register, rhythm, and target-field conventions; never distort the source meaning to fit it.\n" +
        "13. The surrounding application will continue automatically if your reply ends before the full paper is finished, so keep translating as far as possible instead of stopping early because of length concerns.\n" +
        "14. Never mention token limits, context windows, truncation, or capacity constraints, and never ask for chapter-by-chapter resubmission.\n" +
        "15. The completion token is not a natural-language phrase. Never replace it with TRANSLATION COMPLETE or any similar words.\n\n" +
        completionInstruction(marker) + "\n\n" +
        (settings.referenceContext
          ? `Optional direct target-journal/domain reference corpus. Read for style and terminology only; translate the source paper after it:\n\n${settings.referenceContext}\n\n`
          : "") +
        "Markdown to translate begins after this line. Translate only this Markdown source, not the reference corpus above.\n\n" +
        "===== BEGIN SOURCE MARKDOWN TO TRANSLATE =====\n" + markdown +
        "\n===== END SOURCE MARKDOWN TO TRANSLATE =====\n\nFinal reminder:\n" + completionInstruction(marker)
      );

      let messages = [];
      let parts = [];
      let combined = "";
      let startRound = 1;
      let startedAt = new Date().toISOString();

      if (!settings.force) {
        const resumeState = await this.storage.readJSON(paths.state, null);
        const resumeMeta = await this.storage.readJSON(
          paths.progress,
          await this.storage.readJSON(paths.meta, null)
        );
        const resumeTranscript = await this.storage.readJSON(paths.transcript, null);
        if (
          resumeState?.identity === identity &&
          resumeMeta?.identity === identity &&
          !resumeState?.complete &&
          Number(resumeState?.round) > 0 &&
          Number(resumeState?.round) < STREAM_CONTINUATION_MAX_ROUNDS &&
          resumeState?.marker &&
          Array.isArray(resumeTranscript)
        ) {
          marker = String(resumeState.marker);
          messages = resumeTranscript
            .filter(message => message && ["system", "user", "assistant"].includes(message.role) && typeof message.content === "string")
            .map(message => ({ role: message.role, content: message.content }));
          parts = messages.filter(message => message.role === "assistant").map(message => message.content);
          combined = parts.join("\n");
          startRound = Number(resumeState.round) + 1;
          startedAt = String(resumeMeta.startedAt || startedAt);
          if (messages.at(-1)?.role === "assistant") {
            messages.push({ role: "user", content: continuationPrompt(settings.targetLanguage, marker) });
          }
          emit?.({ type: "status", phase: "translate-resume", message: "正在继续上次未完成的翻译", progress: Math.min(90, startRound * 7) });
          if (combined) emit?.({
            type: "translation",
            mode: "full_context",
            markdown: cleanTranslationTailArtifacts(combined, marker),
            complete: false,
            round: startRound - 1,
            resumed: true
          });
        }
        else {
          const partPaths = (await this.storage.list(paths.root))
            .filter(path => PathUtils.filename(path).startsWith(paths.partPrefix) && PathUtils.filename(path).endsWith(".md"))
            .sort((a, b) => PathUtils.filename(a).localeCompare(PathUtils.filename(b)));
          const recoveredParts = [];
          for (const path of partPaths) {
            const content = await this.storage.readText(path, "");
            if (content.trim()) recoveredParts.push(content.trim());
          }
          if (recoveredParts.length) {
            parts = recoveredParts;
            combined = parts.join("\n");
            if (translationMarkerDetected(parts.at(-1), marker) || translationMarkerDetected(combined, marker)) {
              const finalText = M.repairEquationReferenceTranslation(
                markdown,
                M.normalizeTranslatedInlineHTML(cleanTranslationTailArtifacts(combined, marker))
              );
              const formulaIssue = M.mathIntegrityIssue(markdown, finalText);
              await this.storage.writeText(paths.live, finalText);
              const recoveredMeta = {
                identity,
                sourceFingerprint: settings.sourceFingerprint,
                mode: "full_context",
                complete: true,
                provider: settings.provider,
                baseURL: settings.baseURL,
                model: settings.model,
                targetLanguage: settings.targetLanguage,
                rounds: parts.length,
                formulaIssue,
                recoveredAt: new Date().toISOString()
              };
              await this.publishFinal(paths, finalText, recoveredMeta);
              emit?.({ type: "translation", mode: "full_context", markdown: finalText, complete: true, recovered: true });
              return { markdown: finalText, meta: recoveredMeta, cached: true };
            }
            messages = [
              { role: "system", content: makeSystem() },
              { role: "user", content: makeUser() }
            ];
            for (const part of parts) {
              messages.push({ role: "assistant", content: part });
              messages.push({ role: "user", content: continuationPrompt(settings.targetLanguage, marker) });
            }
            startRound = parts.length + 1;
            emit?.({
              type: "status",
              phase: "translate-resume",
              message: "已恢复上次的翻译进度，正在继续",
              progress: Math.min(90, startRound * 7)
            });
            emit?.({
              type: "translation",
              mode: "full_context",
              markdown: cleanTranslationTailArtifacts(combined, marker),
              complete: false,
              round: parts.length,
              resumed: true
            });
          }
        }
      }

      if (!messages.length) {
        messages = [
          { role: "system", content: makeSystem() },
          { role: "user", content: makeUser() }
        ];
        parts = [];
        combined = "";
        startRound = 1;
      }

      await this.storage.writeJSON(paths.progress, {
        identity,
        sourceFingerprint: settings.sourceFingerprint,
        mode: "full_context",
        complete: false,
        marker,
        provider: settings.provider,
        baseURL: settings.baseURL,
        model: settings.model,
        targetLanguage: settings.targetLanguage,
        startedAt,
        resumedAt: startRound > 1 ? new Date().toISOString() : undefined
      });

      let persistTimer = null;
      const schedulePersist = () => {
        if (persistTimer) return;
        persistTimer = setTimeout(async () => {
          persistTimer = null;
          try { await this.storage.writeText(paths.live, cleanTranslationTailArtifacts(combined, marker)); }
          catch (_) {}
        }, 500);
      };

      try {
        for (let round = startRound; round <= STREAM_CONTINUATION_MAX_ROUNDS; round++) {
          U.throwIfAborted(signal);
          emit?.({ type: "status", phase: "translate-full", message: round === 1 ? "正在翻译全文" : "正在继续生成全文译文", progress: Math.min(95, 5 + round * 7) });
          let current = "";
          await this.audit(documentID, `流式-全文连续翻译-第${round}轮`, settings, messages, TRANSLATION_REQUEST_TIMEOUT, settings.promptCacheKey);
          const result = await this.llm.complete(messages, {
            purpose: "translation",
            documentID,
            provider: settings.provider,
            baseURL: settings.baseURL,
            model: settings.model,
            apiKey: settings.apiKey,
            promptCacheKey: settings.promptCacheKey,
            engine: settings.engine,
            runtime: settings.runtime,
            timeout: TRANSLATION_REQUEST_TIMEOUT,
            firstEventTimeout: TRANSLATION_FIRST_EVENT_TIMEOUT,
            inactivityTimeout: TRANSLATION_INACTIVITY_TIMEOUT,
            signal,
            onRateLimitWait: ({ waitMs }) => emit?.({
              type: "status",
              phase: "rate-limit-wait",
              message: `Gemini请求频率受限，约 ${Math.ceil(waitMs / 1000)} 秒后继续全文翻译`
            }),
            onText: delta => {
              current += delta;
              combined = [...parts, current].join("\n");
              schedulePersist();
              emit?.({
                type: "translation",
                mode: "full_context",
                complete: false,
                round,
                delta
              });
            },
            onReasoning: delta => emit?.({ type: "reasoning", delta, scope: "translation", round })
          });
          const content = M.repairEquationReferenceTranslation(
            markdown,
            M.normalizeTranslatedInlineHTML(result.text)
          ).trim();
          parts.push(content);
          combined = parts.join("\n");
          await this.storage.writeText(PathUtils.join(paths.root, `${paths.partPrefix}${String(round).padStart(4, "0")}.md`), content + "\n");
          await this.storage.writeText(paths.live, cleanTranslationTailArtifacts(combined, marker));
          messages.push({ role: "assistant", content });
          await this.storage.writeJSON(paths.transcript, messages);
          await this.storage.writeJSON(paths.state, {
            identity,
            sourceFingerprint: settings.sourceFingerprint,
            marker,
            round,
            complete: translationMarkerDetected(content, marker),
            updatedAt: new Date().toISOString()
          });

          if (translationMarkerDetected(content, marker) || translationMarkerDetected(combined, marker)) {
            const finalText = M.repairEquationReferenceTranslation(
              markdown,
              M.normalizeTranslatedInlineHTML(cleanTranslationTailArtifacts(combined, marker))
            );
            const formulaIssue = M.mathIntegrityIssue(markdown, finalText);
            await this.storage.writeText(paths.live, finalText);
            const meta = {
              identity,
              sourceFingerprint: settings.sourceFingerprint,
              mode: "full_context",
              complete: true,
              provider: settings.provider,
              baseURL: settings.baseURL,
              model: settings.model,
              targetLanguage: settings.targetLanguage,
              rounds: round,
              formulaIssue,
              startedAt,
              completedAt: new Date().toISOString()
            };
            await this.publishFinal(paths, finalText, meta);
            await this.storage.writeJSON(paths.state, {
              identity,
              sourceFingerprint: settings.sourceFingerprint,
              marker,
              round,
              complete: true,
              updatedAt: meta.completedAt
            });
            emit?.({ type: "translation", mode: "full_context", markdown: finalText, complete: true, round });
            return { markdown: finalText, meta, cached: false };
          }
          messages.push({ role: "user", content: continuationPrompt(settings.targetLanguage, marker) });
          await this.storage.writeJSON(paths.transcript, messages);
        }
        throw new Error("模型多次续写后仍未返回完整译文。已有进度已保存，请稍后重试。");
      }
      finally {
        if (persistTimer) clearTimeout(persistTimer);
      }
    }
  }

  LitMTrans.TranslationService = TranslationService;
  LitMTrans.TranslationInternals = {
    compactReferenceMarkdown,
    referenceContextInstruction,
    completionInstruction,
    stableTranslationMarker,
    translationMarkerDetected,
    stripTranslationMarker,
    cleanTranslationTailArtifacts,
    REFERENCE_RECOMMENDED_FILES,
    REFERENCE_WARNING_CHARS,
    STREAM_CHUNK_CONCURRENCY,
    streamChunkConcurrency,
    STREAM_CONTINUATION_MAX_ROUNDS,
    STREAM_PROTOCOL_VERSION
  };
})(this);
