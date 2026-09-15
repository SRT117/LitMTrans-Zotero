(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  LitMTrans.DeepSeekWeb = LitMTrans.DeepSeekWeb || {};
  const U = LitMTrans.Utils;

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

  function extractUserPrompt(messages = []) {
    if (!Array.isArray(messages) || !messages.length) return "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "user") {
        if (typeof msg.content === "string") return msg.content.trim();
        if (Array.isArray(msg.content)) {
          return msg.content
            .filter(part => part?.type === "text" || typeof part === "string")
            .map(part => typeof part === "string" ? part : part.text || "")
            .join("\n").trim();
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
      if (session.sessionURL && session.driver) {
        try {
          await session.driver.deleteCurrentSession(session.sessionURL);
        } catch (_) {}
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
      if (!driver.onContextMenu && runtime && this.controller?.openDeepSeekContextMenu) {
        driver.onContextMenu = (data) => {
          this.controller.openDeepSeekContextMenu(runtime, data);
        };
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
          timer: null
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
      const itemTitle = options.itemTitle || runtime.itemTitle || "Paper";
      const sessionTitle = `litmtrans-${sanitizePrefix(itemTitle)}-${documentID}`;
      const sessionPath = this.storage.path(documentID, "deepseek-web", "session.json");

      const abortListener = () => {
        void driver.stop();
      };
      signal?.addEventListener("abort", abortListener, { once: true });

      try {
        // 关键：首先确保 DeepSeek 网页端与输入框已完全就绪
        options.emit?.({ type: "log", message: "[探针5-Provider] completeDocumentTask: 开始等待DeepSeek网页就绪" });
        await driver.ensureReady(30000, signal, options.emit);

        if (!this.establishedSessions.has(sessionTitle)) {
          const saved = await this.storage.readJSON(sessionPath, null);
          if (saved?.documentID === documentID && saved.url) this.establishedSessions.set(sessionTitle, saved.url);
        }
        let isFirstRound = !this.establishedSessions.has(sessionTitle);
        if (!isFirstRound) {
          const selected = await driver.selectSession(sessionTitle, documentID, this.establishedSessions.get(sessionTitle));
          if (!selected) {
            this.establishedSessions.delete(sessionTitle);
            isFirstRound = true;
          }
        }
        const pDoc = `[探针5-Provider] completeDocumentTask: docID=${documentID}, session=${sessionTitle}, isFirstRound=${isFirstRound}`;
        options.emit?.({ type: "log", message: pDoc });
        try { Zotero.debug?.(`[LitMTrans-Probe] ${pDoc}`); } catch (_) {}

        if (isFirstRound) {
          // 检查网页端是否已有同名会话（通过专属名称或稳定 documentID 匹配）
          const existingSessions = await driver.listSessions();
          const found = existingSessions.find(s => s.title === sessionTitle);
          if (found) {
            options.emit?.({ type: "log", message: `[探针5-Provider] 找到已有会话，直接切换进入: ${sessionTitle}` });
            if (!await driver.selectSession(sessionTitle, documentID, found.url)) throw new Error("未能打开已有文献会话");
            this.establishedSessions.set(sessionTitle, found.url);
            await this.storage.writeJSON(sessionPath, { documentID, title: sessionTitle, url: found.url });
            isFirstRound = false;
          }
        }

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
              name: `${sanitizePrefix(itemTitle) || "文献正文"}.md`,
              type: "text/markdown",
              base64: mdBase64
            });
          }

          // 页面普通清晰度图集（单页约 100~150KB，用于多模态图表排版理解）
          let imagePaths = [];
          try {
            const maxImages = uploadFiles.length ? 48 : 49;
            const pageResult = await this.pageRenderer.renderAndCachePages(runtime, documentID, {
              maxImages,
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
              options.emit?.({ type: "log", message: `[探针5-Provider] 页面标清图像就绪 (共 ${imagePaths.length} 页)` });
            }
          } catch (err) {
            options.emit?.({ type: "warning", message: `[探针5-Provider] 页面图像准备遇到问题: ${err.message || err}，降级为纯文本模式` });
            options.onReasoning?.(`[页面图像准备提醒] ${err.message || err}，将以纯文本模式提交。\n\n`);
          }

          // 合并上传列表
          for (const imgPath of imagePaths) {
            uploadFiles.push(imgPath);
          }

          // 一次性批量上传附件
          if (uploadFiles.length) {
            options.emit?.({ type: "log", message: `[探针5-Provider] 正在向DeepSeek上传文献资料 (共 ${uploadFiles.length} 个附件)...` });
            await driver.attachFiles(uploadFiles, signal);
            options.emit?.({ type: "log", message: "[探针5-Provider] 附件上传完成" });
          }

          // 打包首轮文本：若正文已作为附件上传，输入框只发送用户指令
          let payload = "";
          if (uploadFiles.some(f => typeof f === "object" && f.name?.endsWith(".md"))) {
            payload = userPrompt || "请根据上传的文献资料，深入分析并回答。";
          } else if (markdown) {
            payload = `${userPrompt}\n\n---\n[文献正文]\n${markdown}`;
          } else {
            payload = formatFullPrompt(messages);
          }

          options.emit?.({ type: "log", message: `[探针5-Provider] 正在提交问答消息 (字数=${payload.length})...` });
          const result = await driver.submitMessage(payload, {
            signal,
            timeout: options.timeout || 300000,
            emit: options.emit,
            onText: options.onText,
            onReasoning: options.onReasoning,
            onUsage: options.onUsage,
            onSessionReady: async url => {
              this.establishedSessions.set(sessionTitle, url);
              await this.storage.writeJSON(sessionPath, { documentID, title: sessionTitle, url });
              try { await driver.renameCurrentSession(sessionTitle, url); }
              catch (error) { options.emit?.({ type: "warning", message: `文献会话命名失败：${error.message}` }); }
            }
          });

          if (result.sessionURL) this.establishedSessions.set(sessionTitle, result.sessionURL);
          try { await driver.renameCurrentSession(sessionTitle, result.sessionURL); }
          catch (error) { options.emit?.({ type: "warning", message: `文献会话命名未完成：${error.message}` }); }

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
