(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  LitMTrans.DeepSeekWeb = LitMTrans.DeepSeekWeb || {};
  const U = LitMTrans.Utils;
  const TEXT_ONLY_DOCUMENT_TASKS = new Set(["key_points", "paper_mindmap", "paper_logic_flow"]);

  function uint8ArrayToBase64(bytes) {
    let binary = "";
    const len = bytes.byteLength;
    const chunkSize = 8192;
    for (let i = 0; i < len; i += chunkSize) {
      const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  function sanitizePrefix(title = "") {
    const clean = String(title || "")
      .replace(/[^\w\u4e00-\u9fa5]/g, "")
      .slice(0, 16);
    return clean || "Doc";
  }

  function extractTrailingLayoutJson(text) {
    const value = String(text || "");
    let start = value.lastIndexOf("\n{");
    if (start < 0 && value.trimStart().startsWith("{")) start = value.indexOf("{");
    while (start >= 0) {
      const jsonStart = start + (value[start] === "\n" ? 1 : 0);
      const source = value.slice(jsonStart).trim();
      try {
        const payload = JSON.parse(source);
        if (payload && typeof payload === "object"
          && (Object.prototype.hasOwnProperty.call(payload, "blocks")
            || Object.prototype.hasOwnProperty.call(payload, "blocks_to_correct"))) {
          return { source, start: jsonStart };
        }
      } catch (_) {}
      start = value.lastIndexOf("\n{", start - 1);
    }
    return null;
  }

  function extractUserPrompt(messages = []) {
    if (!Array.isArray(messages) || !messages.length) return "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "user") {
        if (typeof msg.content === "string") return msg.content.trim();
        if (Array.isArray(msg.content)) {
          const text = msg.content
            .filter(part => part?.type === "text" || typeof part === "string")
            .map(part => typeof part === "string" ? part : part.text || "")
            .join("\n").trim();
          // ChatService 为 API 组装的首轮内容含有整篇文献；网页端已将
          // 正文作为附件上传，只保留末尾的用户问题及本轮引用上下文。
          const marker = "===== 用户问题 =====";
          const markerIndex = text.lastIndexOf(marker);
          return (markerIndex >= 0 ? text.slice(markerIndex + marker.length) : text).trim();
        }
      }
    }
    return String(messages[messages.length - 1]?.content || "").trim();
  }

  function formatFullPrompt(messages = []) {
    if (!Array.isArray(messages) || !messages.length) return "";
    const parts = [];
    for (const msg of messages) {
      let text = "";
      if (typeof msg.content === "string") text = msg.content;
      else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter(part => part?.type === "text" || typeof part === "string")
          .map(part => typeof part === "string" ? part : part.text || "")
          .join("\n");
      }
      if (text.trim()) {
        parts.push(text.trim());
      }
    }
    return parts.join("\n\n");
  }

  function latestUserImageFiles(messages = []) {
    const latest = [...(Array.isArray(messages) ? messages : [])].reverse()
      .find(message => message?.role === "user");
    const parts = Array.isArray(latest?.content) ? latest.content : [];
    const files = [];
    for (const part of parts) {
      // 文献正文中的图没有本地附件 ID，已由网页端按页图策略上传。
      // 这里只接收用户在本轮从阅读器额外加入的图片。
      if (!String(part?.localAttachmentID || "")) continue;
      const dataURL = String(part?.image_url?.url || "");
      const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataURL);
      if (!match) continue;
      const mimeType = match[1].toLowerCase();
      const extension = mimeType === "image/jpeg" ? "jpg" : (mimeType.split("/")[1] || "png").replace(/[^a-z0-9]+/g, "");
      files.push({ name: `litmtrans-question-image-${files.length + 1}.${extension || "png"}`, type: mimeType, base64: match[2] });
    }
    return files;
  }

  class DeepSeekWebProvider {
    constructor(controller) {
      this.controller = controller;
      this.storage = controller.storage;
      this.pageRenderer = new LitMTrans.DeepSeekWeb.PDFPageRenderer(controller);
      this.drivers = new WeakMap();
      this.establishedSessions = new Map();
      this.pendingTasks = new WeakMap();
      this.activeTranslationSessions = new Map();

      // 监听控制器操作生命周期，在翻译（初译+补译流水线）全部结束时触发“阅后即焚”删除临时会话
      if (this.controller?.finishOperation) {
        const origFinishOperation = this.controller.finishOperation.bind(this.controller);
        this.controller.finishOperation = (runtime, key, opController) => {
          const map = this.controller.operations?.get(runtime?.tabID);
          const isCurrentOp = Boolean(map && map.get(key) === opController);
          try {
            origFinishOperation(runtime, key, opController);
          } finally {
            if (isCurrentOp && (key === "layout" || key === "translate")) {
              const docID = runtime?.documentID;
              let hasActiveOp = false;
              if (this.controller?.operations && this.controller?.tabs) {
                for (const [tabID, oMap] of this.controller.operations.entries()) {
                  const rt = this.controller.tabs.get(tabID);
                  if (rt?.documentID === docID && oMap?.size > 0) {
                    hasActiveOp = true;
                    break;
                  }
                }
              }
              if (!hasActiveOp && docID) {
                void this.finalizeTranslationSession(docID, "operation-finished");
              }
            }
          }
        };
      }
    }

  async finalizeTranslationSession(documentID, reason = "", expectedSession = null) {
    const session = this.activeTranslationSessions.get(documentID);
    if (!session) return;
      if (expectedSession && session !== expectedSession) return;
      this.activeTranslationSessions.delete(documentID);
      if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    const emit = (type, message) => {
      try { session.emit?.({ type, message }); } catch (_) {}
    };
    if (this.controller?.getSettings?.().deleteWebTranslationSessions === false) {
      emit("log", "[DeepSeek网页] 已按设置保留本次翻译会话");
    } else if (!session.sessionURL || !session.driver) {
      emit("warning", "[DeepSeek网页] 临时翻译会话未取得地址，无法自动清理");
    } else {
      emit("log", `[DeepSeek网页] 正在清理临时翻译会话（${reason || "unknown"}）`);
      try {
        await session.driver.deleteCurrentSession(session.sessionURL);
        emit("log", "[DeepSeek网页] 临时翻译会话已清理");
      } catch (error) {
        const message = `[DeepSeek网页] 临时翻译会话清理失败（${reason || "unknown"}）：${error?.message || error}`;
        emit("warning", message);
        try { Zotero.debug?.(message); } catch (_) {}
        try { this.controller?.appendDeepSeekProbe?.(message); } catch (_) {}
      }
    }
    }

    getDriver(runtime) {
      const browser = runtime?.deepSeekBrowser;
      if (!browser) throw new Error("DeepSeek网页浏览器尚未初始化");
      let driver = this.drivers.get(browser) || runtime?.deepSeekDriver;
      if (!driver) {
        driver = new LitMTrans.DeepSeekWeb.DeepSeekWebDriver(browser);
        this.drivers.set(browser, driver);
      }
      if (runtime && !runtime.deepSeekDriver) runtime.deepSeekDriver = driver;
      return driver;
    }

    resolveRuntime(options = {}) {
      if (options.runtime) return options.runtime;
      if (this.controller?.tabs) {
        if (options.documentID) {
          for (const runtime of this.controller.tabs.values()) {
            if (runtime.documentID === options.documentID) {
              return runtime;
            }
          }
        }
        const activeWin = Services.wm?.getMostRecentWindow?.("navigator:browser");
        const selectedTabID = activeWin?.Zotero_Tabs?.selectedID;
        if (selectedTabID && this.controller.tabs.has(selectedTabID)) {
          const activeRuntime = this.controller.tabs.get(selectedTabID);
          if (activeRuntime) return activeRuntime;
        }
        for (const runtime of this.controller.tabs.values()) {
          return runtime;
        }
      }
      throw new Error("未找到可用的文献工作台或DeepSeek网页实例");
    }

    emitDeepSeekBrowserState(runtime, emit, label = "") {
      // 探针7：把 DeepSeek 内嵌网页的加载状态汇报到流式日志面板，跨版本白屏定位
      const browser = runtime?.deepSeekBrowser;
      if (!browser || typeof emit !== "function") return;
      let readyState = "", url = "";
      try { readyState = browser.contentDocument?.readyState || ""; } catch (_) {}
      try { url = String(browser.currentURI?.spec || ""); } catch (_) {}
      let rect = "";
      try {
        const r = browser.getBoundingClientRect();
        rect = `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}`;
      } catch (_) {}
      const probe = `[探针7-网页] ${label}: remote=${browser.isRemoteBrowser}, remoteType=${browser.remoteType || "-"}, url=${url || "-"}, readyState=${readyState || "-"}, display=${browser.style.display || "-"}, rect=${rect || "-"}`;
      try { emit({ type: "log", message: probe }); } catch (_) {}
      try { Zotero.debug?.(`[LitMTrans-Probe] ${probe}`); } catch (_) {}
      try { this.controller?.appendDeepSeekProbe?.(probe); } catch (_) {}
    }

    async complete(messages, options = {}) {
      const signal = options.signal || null;
      U.throwIfAborted(signal);

      const probeMsg = `[探针5-Provider] complete: purpose=${options.purpose}, docID=${options.documentID}, hasRuntime=${Boolean(options.runtime)}`;
      options.emit?.({ type: "log", message: probeMsg });
      try { Zotero.debug?.(`[LitMTrans-Probe] ${probeMsg}`); } catch (_) {}

      const runtime = this.resolveRuntime(options);
      const webSettings = this.controller?.getSettings?.() || {};
      const isTranslationTask = options.purpose === "translation"
        || options.purpose === "guide"
        || options.purpose === "layout";
      if (webSettings.webInputMode === "clipboard" && !isTranslationTask) {
        // 仅接受调用方独立提供的提示词，不能从已混入全文的消息反推。
        const prompt = String(options.clipboardPrompt || "").trim();
        if (!prompt) throw new Error("当前处于仅复制模式，此任务未提供独立提示词，请切换为自动注入模式后重试。");
        this.controller.loadDeepSeekWeb(runtime);
        this.controller.ensureDeepSeekWebVisible?.(runtime);
        const copied = this.controller.writeClipboardText?.(prompt);
        if (!copied?.copied) throw new Error("提示词复制到剪贴板失败");
        throw new Error("当前处于仅复制模式，已复制提示词到剪贴板");
      }
      this.controller.loadDeepSeekWeb(runtime);
      this.controller.ensureDeepSeekWebVisible?.(runtime);
      this.emitDeepSeekBrowserState(runtime, options.emit, "网页面板打开");
      setTimeout(() => this.emitDeepSeekBrowserState(runtime, options.emit, "打开3秒后"), 3000);
      setTimeout(() => this.emitDeepSeekBrowserState(runtime, options.emit, "打开8秒后"), 8000);
      const driver = this.getDriver(runtime);

      const probeDriverMsg = `[探针5-Provider] driver已获取: hasBrowser=${Boolean(runtime?.deepSeekBrowser)}`;
      options.emit?.({ type: "log", message: probeDriverMsg });
      try { Zotero.debug?.(`[LitMTrans-Probe] ${probeDriverMsg}`); } catch (_) {}

      const previous = this.pendingTasks.get(driver) || Promise.resolve();
      let release;
      const pending = new Promise(resolve => { release = resolve; });
      this.pendingTasks.set(driver, pending);
      await previous;

      const isTranslation = options.purpose === "translation"
        || options.purpose === "guide"
        || options.purpose === "layout";

      try {
        U.throwIfAborted(signal);
        if (isTranslation) {
          return await this.completeTranslationTask(driver, messages, { ...options, runtime,
            documentID: options.documentID || runtime.documentID, itemTitle: options.itemTitle || runtime.itemTitle });
        }
        return await this.completeDocumentTask(runtime, driver, messages, options);
      } catch (error) {
        const probeErr = `[探针5-Provider] complete执行出错: ${error?.message || error}`;
        options.emit?.({ type: "log", message: probeErr });
        try { Zotero.debug?.(`[LitMTrans-Probe] ${probeErr}`); } catch (_) {}
        if (String(error?.message || "").includes("尚未登录") || String(error?.message || "").includes("未就绪")) {
          this.controller.ensureDeepSeekWebVisible?.(runtime);
        }
        throw error;
      } finally {
        release();
        if (this.pendingTasks.get(driver) === pending) this.pendingTasks.delete(driver);
      }
    }

    async completeTranslationTask(driver, messages, options = {}) {
      const signal = options.signal || null;
      U.throwIfAborted(signal);

      const documentID = options.documentID || "default";
      let activeSession = this.activeTranslationSessions.get(documentID);
      if (activeSession && activeSession.timer) {
        clearTimeout(activeSession.timer);
        activeSession.timer = null;
      }

      const isFollowUp = Boolean(activeSession && activeSession.sessionURL);

      if (!isFollowUp) {
        const p1 = `[探针5-Provider] completeTranslationTask: 开始创建新翻译会话 (driver.createNewChat)`;
        options.emit?.({ type: "log", message: p1 });
        try { Zotero.debug?.(`[LitMTrans-Probe] ${p1}`); } catch (_) {}

        await driver.createNewChat(signal, options.emit);
      activeSession = {
        driver,
        documentID,
        sessionURL: "",
        timer: null,
        emit: options.emit
      };
        this.activeTranslationSessions.set(documentID, activeSession);
      } else {
        const pReuse = `[探针5-Provider] completeTranslationTask: 复用当前文献翻译会话继续追问补译: docID=${documentID}`;
        options.emit?.({ type: "log", message: pReuse });
        try { Zotero.debug?.(`[LitMTrans-Probe] ${pReuse}`); } catch (_) {}
        if (activeSession.sessionURL) {
          const currentURL = (driver.browser?.currentURI?.spec || "").split(/[?#]/)[0].replace(/\/$/, "");
          const targetURL = activeSession.sessionURL.split(/[?#]/)[0].replace(/\/$/, "");
          if (currentURL !== targetURL) {
            const switched = await driver.selectSession("", documentID, targetURL);
            if (!switched) {
              throw new Error(`未能切回目标文献翻译会话: ${targetURL}`);
            }
          }
        }
      }

      let prompt = isFollowUp ? (extractUserPrompt(messages) || formatFullPrompt(messages)) : formatFullPrompt(messages);
      if (options.targetLanguage && !prompt.includes(options.targetLanguage)) {
        prompt = `[Target Language: ${options.targetLanguage}]\n${prompt}`;
      }

      let attachment = null;
      if (options.purpose === "translation") {
        const sourceMatch = prompt.match(/===== BEGIN SOURCE (MARKDOWN|CHUNK) TO TRANSLATE =====\r?\n([\s\S]*?)\r?\n===== END SOURCE \1 TO TRANSLATE =====/);
        if (sourceMatch && sourceMatch[2]) {
          attachment = {
            source: sourceMatch[2],
            name: `${sanitizePrefix(options.itemTitle || "Doc")}-source-${U.hashString(sourceMatch[2]).slice(0, 8)}.md`,
            type: "text/markdown",
            prompt: prompt.replace(sourceMatch[0], "The source to translate is in the uploaded Markdown attachment.")
          };
        }
      } else if (options.purpose === "layout") {
        const layoutJson = extractTrailingLayoutJson(prompt);
        if (layoutJson) {
          attachment = {
            source: layoutJson.source,
            name: `${sanitizePrefix(options.itemTitle || "Doc")}-layout-${U.hashString(layoutJson.source).slice(0, 8)}.json`,
            type: "application/json",
            prompt: `${prompt.slice(0, layoutJson.start)}The layout translation input is in the uploaded JSON attachment.`
          };
        }
      }

      if (attachment) {
        options.emit?.({
          type: "log",
          message: `[探针5-Provider] 正在上传网页翻译源文附件 (${attachment.source.length} 字)...`
        });
        try {
          await driver.attachFiles([{
            name: attachment.name,
            type: attachment.type,
            base64: uint8ArrayToBase64(new TextEncoder().encode(attachment.source))
          }], signal, { settleMs: 1000 });
          prompt = attachment.prompt;
          options.emit?.({ type: "log", message: "[探针5-Provider] 网页翻译源文附件已就绪，输入框仅提交翻译指令" });
        } catch (error) {
          U.throwIfAborted(signal);
          options.emit?.({
            type: "warning",
            message: `[探针5-Provider] 网页翻译源文附件上传失败，降级为文字输入: ${error?.message || error}`
          });
        }
      }

      const p2 = `[探针5-Provider] completeTranslationTask: 会话就绪，准备提交消息 (字数=${prompt.length}, 追问=${isFollowUp})`;
      options.emit?.({ type: "log", message: p2 });
      try { Zotero.debug?.(`[LitMTrans-Probe] ${p2}`); } catch (_) {}

      const currentSessionInstance = activeSession;
      const abortListener = () => {
        void driver.stop();
        void this.finalizeTranslationSession(documentID, "aborted", currentSessionInstance);
      };
      signal?.addEventListener("abort", abortListener, { once: true });

      try {
        const result = await driver.submitMessage(prompt, {
          signal,
          timeout: options.timeout || 300000,
          emit: options.emit,
          onText: options.onText,
          onReasoning: options.onReasoning,
          onUsage: options.onUsage,
          onSessionReady: async url => {
            if (activeSession) activeSession.sessionURL = url;
          }
        });

        if (result.sessionURL && activeSession) {
          activeSession.sessionURL = result.sessionURL;
        }

        const p3 = `[探针5-Provider] completeTranslationTask: 消息提交完成，获取回复 length=${result?.content?.length || 0}`;
        options.emit?.({ type: "log", message: p3 });
        try { Zotero.debug?.(`[LitMTrans-Probe] ${p3}`); } catch (_) {}

        // 设定兜底自动清理定时器（3分钟内若无后续补译请求且未触发 finishOperation，则释放会话资源）
        if (activeSession) {
          const timerSessionInstance = activeSession;
          activeSession.timer = setTimeout(() => {
            let isOperationActive = false;
            if (this.controller?.operations && this.controller?.tabs) {
              for (const [tabID, opMap] of this.controller.operations.entries()) {
                const rt = this.controller.tabs.get(tabID);
                if (rt?.documentID === documentID && opMap?.size > 0) {
                  isOperationActive = true;
                  break;
                }
              }
            }
            if (!isOperationActive) {
              void this.finalizeTranslationSession(documentID, "idle-timeout", timerSessionInstance);
            }
          }, 180000);
        }

        return {
          text: result.content,
          reasoning: result.reasoning,
          usage: null,
          model: "deepseek-web"
        };
      } catch (err) {
        throw err;
      } finally {
        signal?.removeEventListener("abort", abortListener);
      }
    }

    async completeDocumentTask(runtime, driver, messages, options = {}) {
      const signal = options.signal || null;
      U.throwIfAborted(signal);

      const documentID = options.documentID || runtime.documentID || "default";
      if (this.activeTranslationSessions.has(documentID)) {
        await this.finalizeTranslationSession(documentID, "switch-to-document-task");
      }
      const attachmentTitle = options.itemTitle || runtime.itemTitle || "文献正文";
      const sessionKey = documentID;
      const sessionPath = this.storage.path(documentID, "deepseek-web", "session.json");
      const questionImages = latestUserImageFiles(messages);
      const textOnlyDocumentTask = TEXT_ONLY_DOCUMENT_TASKS.has(String(options.taskType || ""));

      const abortListener = () => {
        void driver.stop();
      };
      signal?.addEventListener("abort", abortListener, { once: true });

      try {
        // 关键：首先确保 DeepSeek 网页端与输入框已完全就绪
        options.emit?.({ type: "log", message: "[探针5-Provider] completeDocumentTask: 开始等待DeepSeek网页就绪" });
        await driver.ensureReady(30000, signal, options.emit);

        if (!this.establishedSessions.has(sessionKey)) {
          const saved = await this.storage.readJSON(sessionPath, null);
          if (saved?.documentID === documentID && saved.url) this.establishedSessions.set(sessionKey, saved.url);
        }
        let isFirstRound = !this.establishedSessions.has(sessionKey);
        if (!isFirstRound) {
          const selected = await driver.selectSession("", documentID, this.establishedSessions.get(sessionKey));
          if (!selected) {
            this.establishedSessions.delete(sessionKey);
            await this.storage.removeFile(sessionPath).catch(() => {});
            isFirstRound = true;
          }
        }
        const pDoc = `[探针5-Provider] completeDocumentTask: docID=${documentID}, isFirstRound=${isFirstRound}`;
        options.emit?.({ type: "log", message: pDoc });
        try { Zotero.debug?.(`[LitMTrans-Probe] ${pDoc}`); } catch (_) {}

        if (isFirstRound) {
          // 首轮：开启新会话，上传文献资料 + 指令
          options.emit?.({ type: "log", message: "[探针5-Provider] 开启新对话处理首轮问答..." });
          await driver.createNewChat(signal, options.emit);

          const userPrompt = extractUserPrompt(messages);
          let markdown = String(options.markdown || runtime?.markdown || "").trim();
          if (!markdown && this.controller?.mineru) {
            try {
              const parsed = await this.controller.mineru.loadParsed(documentID);
              if (parsed?.markdown) markdown = String(parsed.markdown).trim();
            } catch (_) {}
          }
          if (!markdown && this.storage) {
            try {
              markdown = await this.storage.readText(this.storage.path(documentID, "full.cleaned.md"), "");
              if (!markdown) markdown = await this.storage.readText(this.storage.path(documentID, "full.md"), "");
            } catch (_) {}
          }

          const uploadFiles = [];
          // 若有文献正文，将全文作为 Markdown 附件上传（占用 1 个附件名额，避免数万字塞爆输入框）
          if (markdown) {
            options.emit?.({ type: "log", message: `[探针5-Provider] 正在打包文献全文附件 (${markdown.length} 字)...` });
            const encoder = new TextEncoder();
            const mdBytes = encoder.encode(markdown);
            const mdBase64 = uint8ArrayToBase64(mdBytes);
            uploadFiles.push({
              name: `${sanitizePrefix(attachmentTitle) || "文献正文"}.md`,
              type: "text/markdown",
              base64: mdBase64
            });
          }

          const rawPageImageQuality = String(this.controller?.getSettings?.().webPageImageQuality || "high").trim().toLowerCase();
          const pageImageQuality = ["low", "medium", "high"].includes(rawPageImageQuality) ? rawPageImageQuality : "high";
          let imagePaths = [];
          if (textOnlyDocumentTask) {
            options.emit?.({ type: "log", message: "[探针5-Provider] 当前任务仅注入文献文本，跳过论文页面图像" });
          } else {
            try {
              const maxImages = Math.max(0, (uploadFiles.length ? 48 : 49) - questionImages.length);
              const pageResult = await this.pageRenderer.renderAndCachePages(runtime, documentID, {
                maxImages,
                quality: pageImageQuality,
                emit: options.emit
              });
              if (pageResult.downgraded && pageResult.message) {
                options.onReasoning?.(`[系统提醒] ${pageResult.message}\n\n`);
              }
              if (pageResult.error) {
                options.emit?.({ type: "warning", message: `[探针5-Provider] ${pageResult.error}，跳过页面图像` });
              }
              imagePaths = pageResult.images || [];
              if (imagePaths.length) {
                const labels = { low: "低清晰度", medium: "中等清晰度", high: "高清晰度" };
                options.emit?.({ type: "log", message: `[探针5-Provider] 页面${labels[pageImageQuality] || "高清晰度"}图像就绪 (共 ${imagePaths.length} 页)` });
              }
            } catch (err) {
              options.emit?.({ type: "warning", message: `[探针5-Provider] 页面图像准备遇到问题: ${err.message || err}，降级为纯文本模式` });
              options.onReasoning?.(`[页面图像准备提醒] ${err.message || err}，将以纯文本模式提交。\n\n`);
            }
          }

          // 合并上传列表
          for (const imgPath of imagePaths) {
            uploadFiles.push(imgPath);
          }

          // 一次性批量上传附件；网页端禁止附件上传时降级为纯文本输入
          let attachmentsRejected = false;
          if (uploadFiles.length) {
            options.emit?.({ type: "log", message: `[探针5-Provider] 正在向DeepSeek上传文献资料 (共 ${uploadFiles.length} 个附件)...` });
            try {
              await driver.attachFiles(uploadFiles, signal);
              options.emit?.({ type: "log", message: "[探针5-Provider] 附件上传完成" });
            } catch (error) {
              attachmentsRejected = true;
              const msg = `[探针5-Provider] 附件上传失败，降级为纯文本输入: ${error?.message || error}`;
              options.emit?.({ type: "warning", message: msg });
              options.onReasoning?.(`[系统提醒] 附件上传未能成功，本轮已降级为纯文本模式提交。\n\n`);
            }
          }
          if (questionImages.length) {
            options.emit?.({ type: "log", message: `[DeepSeek网页] 正在附加本轮图片（${questionImages.length} 张）` });
            try {
              await driver.attachImages(questionImages, signal);
            } catch (error) {
              options.emit?.({ type: "warning", message: `[DeepSeek网页] 本轮图片上传被拒绝，已跳过: ${error?.message || error}` });
            }
          }

          // 打包首轮文本：仅当正文附件真正生效时才只发用户指令；
          // 附件被拒时把正文拼入输入框（超长时截断，避免塞爆输入框）。
          const mdAttached = !attachmentsRejected
            && uploadFiles.some(f => typeof f === "object" && f.name?.endsWith(".md"));
          let payload = "";
          if (mdAttached) {
            payload = userPrompt || "请根据上传的文献资料，深入分析并回答。";
          } else if (markdown) {
            const MAX_INPUT_CHARS = 12000;
            const body = markdown.length > MAX_INPUT_CHARS
              ? markdown.slice(0, MAX_INPUT_CHARS) + "\n\n…（全文过长，已截断，仅提交前半部分）"
              : markdown;
            if (markdown.length > MAX_INPUT_CHARS) {
              options.emit?.({ type: "warning", message: `[探针5-Provider] 附件被禁止且正文过长(${markdown.length}字)，已截断至${MAX_INPUT_CHARS}字` });
            }
            payload = `${userPrompt}\n\n---\n[文献正文]\n${body}`;
          } else {
            payload = formatFullPrompt(messages);
          }

          options.emit?.({ type: "log", message: `[探针5-Provider] 正在提交问答消息 (字数=${payload.length})...` });
          let sessionURL = "";
          const result = await driver.submitMessage(payload, {
            signal,
            timeout: options.timeout || 300000,
            emit: options.emit,
            onText: options.onText,
            onReasoning: options.onReasoning,
            onUsage: options.onUsage,
            onSessionReady: async url => {
              sessionURL = url;
              this.establishedSessions.set(sessionKey, url);
              await this.storage.writeJSON(sessionPath, { documentID, url });
            }
          });

          sessionURL = result.sessionURL || sessionURL || this.establishedSessions.get(sessionKey) || "";
          if (sessionURL) {
            this.establishedSessions.set(sessionKey, sessionURL);
            await this.storage.writeJSON(sessionPath, { documentID, url: sessionURL });
          }

          options.emit?.({ type: "log", message: `[探针5-Provider] 问答首轮响应完成 (字数=${result?.content?.length || 0})` });
          return {
            text: result.content,
            reasoning: result.reasoning,
            usage: null,
            model: "deepseek-web"
          };
        } else {
          // 后续追问：仅发送当前纯文本问题，零附件重复
          const prompt = extractUserPrompt(messages);
          if (questionImages.length) {
            options.emit?.({ type: "log", message: `[DeepSeek网页] 正在附加本轮图片（${questionImages.length} 张）` });
            try {
              await driver.attachImages(questionImages, signal);
            } catch (error) {
              options.emit?.({ type: "warning", message: `[DeepSeek网页] 本轮图片上传被拒绝，已跳过: ${error?.message || error}` });
            }
          }
          options.emit?.({ type: "log", message: `[探针5-Provider] 正在提交追问消息 (字数=${prompt.length})...` });
          const result = await driver.submitMessage(prompt, {
            signal,
            timeout: options.timeout || 300000,
            emit: options.emit,
            onText: options.onText,
            onReasoning: options.onReasoning,
            onUsage: options.onUsage
          });

          options.emit?.({ type: "log", message: `[探针5-Provider] 追问响应完成 (字数=${result?.content?.length || 0})` });
          return {
            text: result.content,
            reasoning: result.reasoning,
            usage: null,
            model: "deepseek-web"
          };
        }
      } finally {
        signal?.removeEventListener("abort", abortListener);
      }
    }
  }

  LitMTrans.DeepSeekWeb.Provider = DeepSeekWebProvider;
})(this);
