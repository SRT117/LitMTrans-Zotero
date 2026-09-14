(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  LitMTrans.DeepSeekWeb = LitMTrans.DeepSeekWeb || {};
  const U = LitMTrans.Utils;

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
      this.establishedSessions = new Set();
    }

    getDriver(runtime) {
      const browser = runtime?.deepSeekBrowser;
      if (!browser) throw new Error("DeepSeek网页浏览器尚未初始化");
      let driver = this.drivers.get(browser);
      if (!driver) {
        driver = new LitMTrans.DeepSeekWeb.DeepSeekWebDriver(browser);
        this.drivers.set(browser, driver);
      }
      return driver;
    }

    resolveRuntime(options = {}) {
      if (options.runtime?.deepSeekBrowser) return options.runtime;
      if (this.controller?.tabs) {
        if (options.documentID) {
          for (const runtime of this.controller.tabs.values()) {
            if (runtime.documentID === options.documentID && runtime.deepSeekBrowser) {
              return runtime;
            }
          }
        }
        const activeWin = Services.wm?.getMostRecentWindow?.("navigator:browser");
        const selectedTabID = activeWin?.Zotero_Tabs?.selectedID;
        if (selectedTabID && this.controller.tabs.has(selectedTabID)) {
          const activeRuntime = this.controller.tabs.get(selectedTabID);
          if (activeRuntime?.deepSeekBrowser) return activeRuntime;
        }
        for (const runtime of this.controller.tabs.values()) {
          if (runtime.deepSeekBrowser) return runtime;
        }
      }
      throw new Error("未找到可用的文献工作台或DeepSeek网页实例");
    }

    async complete(messages, options = {}) {
      const signal = options.signal || null;
      U.throwIfAborted(signal);

      const runtime = this.resolveRuntime(options);
      this.controller.loadDeepSeekWeb(runtime);
      this.controller.ensureDeepSeekWebVisible?.(runtime);
      const driver = this.getDriver(runtime);

      const isTranslation = options.purpose === "translation"
        || options.purpose === "guide"
        || options.purpose === "layout";

      try {
        if (isTranslation) {
          return await this.completeTranslationTask(driver, messages, options);
        }
        return await this.completeDocumentTask(runtime, driver, messages, options);
      } catch (error) {
        if (String(error?.message || "").includes("尚未登录") || String(error?.message || "").includes("未就绪")) {
          this.controller.ensureDeepSeekWebVisible?.(runtime);
        }
        throw error;
      }
    }

    async completeTranslationTask(driver, messages, options = {}) {
      const signal = options.signal || null;
      U.throwIfAborted(signal);

      // 翻译任务：开启临时会话，用完即焚
      await driver.createNewChat();
      const prompt = formatFullPrompt(messages);

      const abortListener = () => {
        void driver.stop();
        void driver.deleteCurrentSession().catch(() => {});
      };
      signal?.addEventListener("abort", abortListener, { once: true });

      try {
        const result = await driver.submitMessage(prompt, {
          signal,
          timeout: options.timeout || 300000,
          onText: options.onText,
          onReasoning: options.onReasoning,
          onUsage: options.onUsage
        });

        // 任务完成后焚毁临时会话
        await driver.deleteCurrentSession().catch(() => {});

        return {
          text: result.content,
          reasoning: result.reasoning,
          usage: null,
          model: "deepseek-web"
        };
      } catch (error) {
        await driver.deleteCurrentSession().catch(() => {});
        throw error;
      } finally {
        signal?.removeEventListener("abort", abortListener);
      }
    }

    async completeDocumentTask(runtime, driver, messages, options = {}) {
      const signal = options.signal || null;
      U.throwIfAborted(signal);

      const documentID = options.documentID || runtime.documentID || "default";
      const itemTitle = options.itemTitle || runtime.itemTitle || "Paper";
      const sessionTitle = `litmtrans-${sanitizePrefix(itemTitle)}-${documentID}`;

      const abortListener = () => {
        void driver.stop();
      };
      signal?.addEventListener("abort", abortListener, { once: true });

      try {
        let isFirstRound = !this.establishedSessions.has(sessionTitle);

        if (isFirstRound) {
          // 检查网页端是否已有同名会话
          const existingSessions = await driver.listSessions();
          const found = existingSessions.some(s => s.title.includes(sessionTitle) || s.title.includes(documentID));
          if (found) {
            await driver.selectSession(sessionTitle);
            this.establishedSessions.add(sessionTitle);
            isFirstRound = false;
          }
        }

        if (isFirstRound) {
          // 首轮：开启新会话，上传高清图集 + 完整正文 + 指令
          await driver.createNewChat();

          // 渲染并缓存 240~300 dpi 高清页面图片
          let imagePaths = [];
          try {
            const pageResult = await this.pageRenderer.renderAndCachePages(runtime, documentID);
            if (pageResult.downgraded && pageResult.message) {
              options.onReasoning?.(`[系统提醒] ${pageResult.message}\n\n`);
            }
            imagePaths = pageResult.images || [];
          } catch (err) {
            // 图片渲染失败不阻塞纯文本问答
            options.onReasoning?.(`[页面图像准备提醒] ${err.message || err}，将以纯文本模式提交。\n\n`);
          }

          // 一次性上传图集
          if (imagePaths.length) {
            await driver.attachImages(imagePaths, signal);
          }

          // 打包首轮消息
          const userPrompt = extractUserPrompt(messages);
          const markdown = String(options.markdown || runtime.markdown || "").trim();
          let payload = "";
          if (markdown) {
            payload = `${userPrompt}\n\n---\n[文献正文]\n${markdown}`;
          } else {
            payload = formatFullPrompt(messages);
          }

          const result = await driver.submitMessage(payload, {
            signal,
            timeout: options.timeout || 300000,
            onText: options.onText,
            onReasoning: options.onReasoning,
            onUsage: options.onUsage
          });

          // 首轮响应完成后重命名为文献专属名称
          await driver.renameCurrentSession(sessionTitle).catch(() => {});
          this.establishedSessions.add(sessionTitle);

          return {
            text: result.content,
            reasoning: result.reasoning,
            usage: null,
            model: "deepseek-web"
          };
        } else {
          // 后续追问：仅发送当前纯文本问题，零图片、零全文重复
          const prompt = extractUserPrompt(messages);
          const result = await driver.submitMessage(prompt, {
            signal,
            timeout: options.timeout || 300000,
            onText: options.onText,
            onReasoning: options.onReasoning,
            onUsage: options.onUsage
          });

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
