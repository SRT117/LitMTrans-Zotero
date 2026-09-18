(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  LitMTrans.DeepSeekWeb = LitMTrans.DeepSeekWeb || {};
  const U = LitMTrans.Utils;
  const { setTimeout: setTimer, clearTimeout: clearTimer } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

  const SELECTORS = {
    chatInput: [
      "#chat-input",
      "textarea#chat-input",
      "textarea[placeholder*='给 DeepSeek']",
      "textarea[placeholder*='发送消息']",
      "textarea[placeholder*='Send message']",
      "textarea[placeholder*='Send a message']",
      "div[contenteditable='true']",
      "textarea"
    ],
    sendButton: [
      "div[role='button'][aria-label*='发送']:not([aria-disabled='true'])",
      "button[aria-label*='发送']:not([aria-disabled='true'])",
      "div[role='button'][aria-label*='Send']:not([aria-disabled='true'])",
      "button[aria-label*='Send']:not([aria-disabled='true'])",
      "button:has-text('发送')",
      "div[role='button'].ds-button--circle:not(.ds-button--disabled):not([aria-disabled='true'])",
      "button.ds-button--circle:not(.ds-button--disabled):not([aria-disabled='true'])",
      ".ds-button--circle:not(.ds-button--disabled):not([aria-disabled='true'])",
      ".chat-input-send-button"
    ],
    stopButton: [
      "button:has(svg rect)",
      "div[role='button']:has(svg rect)",
      "button[aria-label*='停止']",
      "div[role='button'][aria-label*='停止']",
      "button[aria-label*='Stop']",
      "div[role='button'][aria-label*='Stop']",
      "div[role='button'].ds-button--circle svg path[d^='M2 4.88']",
      ".ds-button--circle svg path[d^='M2 4.88']",
      "[aria-label*='stop generating' i]",
      ".chat-input-stop-button"
    ],
    continueButton: [
      "button:has-text('继续生成')",
      "div[role='button']:has-text('继续生成')",
      "button:has-text('Continue generating')",
      "button:has-text('Continue generation')",
      "button:has-text('Continue')",
      "[aria-label*='继续生成']",
      "[aria-label*='Continue']"
    ],
    assistantMessage: [
      "[data-role='assistant']",
      ".chat-message-assistant",
      "[class*='assistant-message']",
      ".ds-assistant-message-main-content",
      ".ds-markdown",
      ".chat-message"
    ],
    loginIndicator: [
      "input[type='tel']",
      "input[placeholder*='手机号']",
      "input[placeholder*='验证码']",
      "a[href*='login']",
      "a[href*='sign_in']",
      "button:has-text('登录')",
      "button:has-text('Sign in')",
      "button:has-text('Log in')",
      "[data-testid='login-button']"
    ],
    newChatButton: [
      "button:has-text('新对话')",
      "div[role='button']:has-text('新对话')",
      "button:has-text('开启新对话')",
      "div[role='button']:has-text('开启新对话')",
      "button:has-text('New chat')",
      "div[role='button']:has-text('New chat')",
      "[class*='newChat' i]",
      "[class*='new-chat' i]",
      "[aria-label*='新对话']",
      "[aria-label*='New chat']",
      "a[href='/']"
    ],
    sessionItem: [
      "[class*='session-item']",
      "[class*='conversation-item']",
      "[class*='chat-item']",
      "nav a",
      "aside a"
    ],
    fileInput: [
      "input[type='file']",
      "input[type='file'][accept*='image']"
    ]
  };

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

  function extractDelta(previous, current) {
    if (!current || current === previous) return "";
    if (!previous) return current;
    if (current.startsWith(previous)) {
      return current.slice(previous.length);
    }
    let lcp = 0;
    const maxLen = Math.min(previous.length, current.length);
    while (lcp < maxLen && previous.charCodeAt(lcp) === current.charCodeAt(lcp)) {
      lcp++;
    }
    if (lcp >= previous.length - 8 || lcp >= previous.length * 0.9) {
      return current.slice(lcp);
    }
    if (current.length > previous.length) {
      return current.slice(previous.length);
    }
    return "";
  }

  class DeepSeekWebDriver {
    constructor(browser) {
      this.browser = browser;
    }

    getActor() {
      if (LitMTrans.DeepSeekWeb.actorRegistrationError) {
        throw new Error(`DeepSeek通信模块注册失败：${LitMTrans.DeepSeekWeb.actorRegistrationError}`);
      }
      const browser = this.browser;
      const bc = browser?.browsingContext;
      const wg = bc?.currentWindowGlobal;
      try {
        Zotero.debug(
          `[DeepSeekActor] currentURI=${browser?.currentURI?.spec || ""} ` +
          `remote=${browser?.isRemoteBrowser} ` +
          `remoteType=${browser?.remoteType || ""} ` +
          `bc=${bc?.id || "none"} ` +
          `wg=${!!wg}`
        );
      } catch (_) {}
      if (!wg) {
        throw new Error("DeepSeek WindowGlobal 尚未建立");
      }
      return wg.getActor("LitMTransDeepSeek");
    }

    async testActor(timeoutMs = 5000) {
      return this.execute("ping", {}, timeoutMs);
    }

    async execute(action, payload = {}, timeoutMs = 15000) {
      // 页面路由提交时会短暂替换 WindowGlobal。读取状态和会话管理可以在
      // 新 Actor 建立后安全重试；提交消息本身不可重试，避免重复发送。
      const mayRetryAfterNavigation = new Set([
        "check-ready", "get-assistant-text", "is-generating", "click-continue", "session-action"
      ]).has(action);
      const deadline = Date.now() + timeoutMs;
      let lastError = null;
      for (let attempt = 0; attempt < (mayRetryAfterNavigation ? 3 : 1); attempt++) {
        const started = Date.now();
        let timer;
        try {
          const actor = this.getActor();
          const query = actor.sendQuery("LitMTrans:DeepSeek:execute", { action, payload });
          const remaining = Math.max(1, deadline - Date.now());
          const timeout = new Promise((_, reject) => {
            timer = setTimer(() => {
              let detail = "";
              try {
                const errors = Services.console.getMessageArray().filter(entry =>
                  Number(entry.timeStamp) >= started
                  && /DeepSeekActorChild|LitMTransDeepSeek/.test(`${entry.sourceName || ""} ${entry.message || ""}`));
                detail = errors.slice(-2).map(entry => entry.message).join("；");
              } catch (_) {}
              reject(new Error(`DeepSeek网页通信超时 (${action})${detail ? `：${detail}` : ""}`));
            }, remaining);
          });
          return await Promise.race([query, timeout]);
        } catch (error) {
          lastError = error;
          const message = String(error?.message || error);
          const actorReplaced = /Actor ['"]LitMTransDeepSeek['"] destroyed|WindowGlobal 尚未建立/i.test(message);
          if (!mayRetryAfterNavigation || !actorReplaced || Date.now() >= deadline || attempt >= 2) throw error;
          await U.sleep(300);
        } finally {
          if (timer) clearTimer(timer);
        }
      }
      throw lastError || new Error(`DeepSeek网页通信失败 (${action})`);
    }

    async ensureReady(timeoutMs = 30000, signal = null, emit = null) {
      const start = Date.now();
      let lastReport = 0;
      while (Date.now() - start < timeoutMs) {
        U.throwIfAborted(signal);
        const windowGlobal = this.browser?.browsingContext?.currentWindowGlobal;
        const url = windowGlobal?.documentURI?.spec || "";
        if (!/^https:\/\/chat\.deepseek\.com\//.test(url)) {
          await U.sleep(300, signal);
          continue;
        }
        let res;
        try {
          res = await this.execute("check-ready", {
            chatInputSelectors: SELECTORS.chatInput,
            loginSelectors: SELECTORS.loginIndicator
          }, Math.min(5000, Math.max(1, timeoutMs - (Date.now() - start))));
        } catch (error) {
          U.throwIfAborted(signal);
          // 导航会销毁旧 Actor；只在文档确实发生切换时重新获取。
          if (windowGlobal !== this.browser?.browsingContext?.currentWindowGlobal) continue;
          throw error;
        }
        if (res) {
          if (res.loggedIn === false || res.url.includes("/sign_in") || res.url.includes("/auth") || res.url.includes("/login")) {
            throw new Error("尚未登录 DeepSeek 官方网页端。请在右侧栏完成账号登录后重试。");
          }
          if (res.ready || res.hasInput) {
            const okMsg = `[探针6-Driver] ensureReady就绪: url=${res.url}, hasInput=${res.hasInput}`;
            emit?.({ type: "log", message: okMsg });
            try { Zotero.debug?.(`[LitMTrans-Probe] ${okMsg}`); } catch (_) {}
            return true;
          }
          if (Date.now() - lastReport > 2000) {
            lastReport = Date.now();
            const waitMsg = `[探针6-Driver] 等待DeepSeek输入框渲染: url=${res.url}`;
            emit?.({ type: "log", message: waitMsg });
            try { Zotero.debug?.(`[LitMTrans-Probe] ${waitMsg}`); } catch (_) {}
          }
        }

        await U.sleep(300, signal);
      }

      throw new Error("DeepSeek输入框未就绪，网页加载超时，请检查网络并在右侧栏刷新网页。");
    }

    async isLoggedIn() {
      try {
        const res = await this.execute("check-ready", {
          chatInputSelectors: SELECTORS.chatInput,
          loginSelectors: SELECTORS.loginIndicator
        }, 3000);
        return Boolean(res?.loggedIn);
      } catch (_) {
        return null;
      }
    }

    async createNewChat(signal = null, emit = null) {
      await this.navigate("https://chat.deepseek.com/", signal, emit);
      return true;
    }

    async navigate(url, signal = null, emit = null) {
      const previous = this.browser.browsingContext.currentWindowGlobal;
      this.browser.loadURI(Services.io.newURI(url), {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
      });
      const started = Date.now();
      while (this.browser.browsingContext?.currentWindowGlobal === previous) {
        U.throwIfAborted(signal);
        if (Date.now() - started > 30000) throw new Error("DeepSeek会话页面未打开");
        await U.sleep(100, signal);
      }
      await this.ensureReady(30000, signal, emit);
      return true;
    }

    async stop() {
      try {
        await this.execute("stop", { stopButtonSelectors: SELECTORS.stopButton }, 3000);
      } catch (_) {}
    }

    async isGenerating() {
      try {
        const res = await this.execute("is-generating", { stopButtonSelectors: SELECTORS.stopButton }, 2000);
        return Boolean(res?.generating);
      } catch (_) {
        return false;
      }
    }

    async attachFiles(files = [], signal = null, options = {}) {
      if (!files || !files.length) return true;
      await this.ensureReady(10000, signal);

      const filesPayload = [];
      for (const item of files) {
        U.throwIfAborted(signal);
        if (typeof item === "string") {
          if (!await IOUtils.exists(item)) continue;
          const bytes = await IOUtils.read(item);
          const fileName = PathUtils.filename(item);
          const ext = fileName.split(".").pop().toLowerCase();
          const mimeType = ext === "md" ? "text/markdown" : (ext === "txt" ? "text/plain" : (ext === "pdf" ? "application/pdf" : "image/jpeg"));
          filesPayload.push({
            name: fileName,
            type: mimeType,
            base64: uint8ArrayToBase64(bytes)
          });
        } else if (item && item.base64 && item.name) {
          filesPayload.push(item);
        }
      }

      if (!filesPayload.length) return true;

      let res;
      try {
        res = await this.execute("attach-files", {
          files: filesPayload,
          fileInputSelectors: SELECTORS.fileInput,
          chatInputSelectors: SELECTORS.chatInput
        }, 20000);
      } catch (cause) {
        const error = new Error(String(cause?.message || cause || "DeepSeek拒绝了附件上传"));
        error.code = /通信超时/i.test(error.message)
          ? "DEEPSEEK_ATTACHMENT_TIMEOUT"
          : "DEEPSEEK_ATTACHMENT_REJECTED";
        throw error;
      }

      if (res?.error) {
        const error = new Error(res.error);
        error.code = "DEEPSEEK_ATTACHMENT_REJECTED";
        throw error;
      }

      // 每轮只做有限时长的状态检查；只要网页已经显示上传迹象，就持续等待，
      // 不因用户网速慢而中止或擅自降级。用户仍可通过任务停止按钮取消。
      const waitTimeout = Math.min(60000, Math.max(30000, filesPayload.length * 1000));
      let attachmentObserved = false;
      while (true) {
        U.throwIfAborted(signal);
        let ready;
        try {
          ready = await this.execute("wait-attachments-ready", {
            timeout: waitTimeout,
            expectedCount: filesPayload.length,
            chatInputSelectors: SELECTORS.chatInput,
            sendButtonSelectors: SELECTORS.sendButton
          }, waitTimeout + 3000);
        } catch (cause) {
          if (!attachmentObserved) {
            const error = new Error(String(cause?.message || cause || "DeepSeek附件状态检查超时"));
            error.code = "DEEPSEEK_ATTACHMENT_TIMEOUT";
            throw error;
          }
          ready = { ready: false, attachmentObserved: true };
        }

        attachmentObserved ||= Boolean(ready?.attachmentObserved);
        if (ready?.ready) break;
        if (!attachmentObserved) {
          const error = new Error("DeepSeek网页当前未接受附件上传。");
          error.code = "DEEPSEEK_ATTACHMENT_REJECTED";
          throw error;
        }
        if (options.throwOnTimeout === true) {
          const error = new Error("DeepSeek附件仍在上传或解析，等待超时，请稍后重试。");
          error.code = "DEEPSEEK_ATTACHMENT_TIMEOUT";
          throw error;
        }
        options.emit?.({
          type: "progress",
          phase: "deepseek-attachments",
          message: "网络较慢，DeepSeek仍在上传或解析附件，请继续等待…"
        });
        try {
          Zotero.debug(`[DeepSeekWeb] 附件仍在上传或解析（已继续等待 ${waitTimeout}ms）`);
        } catch (_) {}
      }
      if (options.settleMs) await U.sleep(Math.max(0, Number(options.settleMs) || 0), signal);
      return true;
    }

    async attachImages(filePaths = [], signal = null, options = {}) {
      return this.attachFiles(filePaths, signal, options);
    }

    async appendDraft(text) {
      await this.ensureReady(10000);
      const result = await this.execute("append-draft", { text, chatInputSelectors: SELECTORS.chatInput });
      if (!result?.ok) throw new Error(result?.error || "无法将引用添加到DeepSeek输入框。");
      return result;
    }

    async pasteDraft(text, errorMessage = "无法将内容粘贴到DeepSeek输入框。") {
      await this.ensureReady(10000);
      const result = await this.execute("append-draft", {
        text,
        paste: true,
        chatInputSelectors: SELECTORS.chatInput
      });
      if (!result?.ok) throw new Error(result?.error || errorMessage);
      return result;
    }

    async listSessions() {
      const res = await this.execute("session-action", {
        subAction: "list",
        sessionSelectors: SELECTORS.sessionItem
      }, 5000);
      return res?.sessions || [];
    }

    async selectSession(title, documentID = "", url = "") {
      if (url) {
        if (!/^https:\/\/chat\.deepseek\.com\/(?:a\/)?chat\/(?:s\/)?[^/?#]+$/.test(url)) {
          throw new Error("文献会话地址无效");
        }
        if (this.browser.currentURI?.spec?.replace(/\/$/, "") !== url) await this.navigate(url);
        else await this.ensureReady();
        return this.browser.currentURI?.spec?.replace(/\/$/, "") === url;
      }
      const res = await this.execute("session-action", { subAction: "select", title, documentID, url }, 8000);
      if (!res?.ok) return false;
      await this.ensureReady();
      return true;
    }

    async deleteCurrentSession(expectedURL) {
      const rootURL = "https://chat.deepseek.com/";
      const targetURL = String(expectedURL || "").split(/[?#]/)[0].replace(/\/$/, "");
      if (!targetURL) throw new Error("DeepSeek临时翻译会话地址为空，未执行删除");
      const deleteByAPI = async () => {
        const res = await this.execute("session-action", { subAction: "delete", expectedURL: targetURL, forceAPI: true }, 12000);
        if (!res?.ok) throw new Error(res?.error || "DeepSeek临时翻译会话删除未完成");
      };
      const apiErrors = [];
      const currentURL = String(this.browser.currentURI?.spec || "").split(/[?#]/)[0].replace(/\/$/, "");

      // 当前会话页和新建会话页都尝试一次接口，避免页面切换时丢掉可用的认证上下文。
      if (currentURL === targetURL) {
        try {
          await deleteByAPI();
          return true;
        } catch (error) {
          apiErrors.push(error);
        }
      }

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // 离开活动会话后再重试接口，不依赖窄侧栏是否挂载目标条目。
          await this.navigate(rootURL);
          await deleteByAPI();
          return true;
        } catch (error) {
          apiErrors.push(error);
        }
      }

      let menuError = null;
      try {
        // 接口不可用时回到目标会话，再走原有侧栏菜单；不能在根页面直接调用它。
        await this.navigate(targetURL);
        const res = await this.execute("session-action", { subAction: "delete", expectedURL: targetURL }, 12000);
        if (!res?.ok) throw new Error(res?.error || "DeepSeek临时翻译会话删除未完成");
        try { await this.navigate(rootURL); } catch (_) {}
        return true;
      } catch (error) {
        menuError = error;
      }

      const describe = error => String(error?.message || error).replace(/\s+/g, " ").slice(0, 600);
      const apiDetail = apiErrors.map(describe).filter(Boolean).join("；") || "未知接口错误";
      throw new Error(`DeepSeek临时翻译会话删除失败（接口：${apiDetail}；侧栏菜单：${describe(menuError)}）`);
    }

    async submitMessage(text, options = {}) {
      const signal = options.signal || null;
      const emit = options.emit;
      U.throwIfAborted(signal);

      emit?.({ type: "log", message: `[探针6-Driver] submitMessage: 准备提交消息 (字数=${text.length})` });
      try { Zotero.debug?.(`[LitMTrans-Probe] [探针6-Driver] submitMessage: 准备提交消息 (字数=${text.length})`); } catch (_) {}

      await this.ensureReady(options.timeout || 30000, signal, emit);

      const baseline = await this.execute("get-assistant-text", {
        assistantSelectors: SELECTORS.assistantMessage
      }, 3000);
      await this.execute("submit", {
        text,
        chatInputSelectors: SELECTORS.chatInput,
        sendButtonSelectors: SELECTORS.sendButton
      }, 10000);

      const dispatcher = LitMTrans.DeepSeekWeb.createStreamDispatcher({
        onText: options.onText, onReasoning: options.onReasoning, onUsage: options.onUsage
      });
      let streamOffset = 0;
      let sessionURL = "";
      let content = "";
      let reasoning = "";
      let receivedReply = false;
      let idleSince = 0;
      const started = Date.now();
      const timeout = options.timeout || 300000;
      try {
        while (Date.now() - started < timeout) {
          U.throwIfAborted(signal);
          const snapshot = await this.execute("get-assistant-text", {
            assistantSelectors: SELECTORS.assistantMessage
          }, 3000);
          const currentURL = this.browser.currentURI?.spec || snapshot?.url || "";
          if (!sessionURL && /\/(?:a\/)?chat\/(?:s\/)?[^/?#]+/.test(currentURL)) {
            sessionURL = currentURL.split(/[?#]/)[0].replace(/\/$/, "");
            await options.onSessionReady?.(sessionURL);
          }
          if (sessionURL && currentURL && currentURL.split(/[?#]/)[0].replace(/\/$/, "") !== sessionURL && /\/(?:a\/)?chat\/(?:s\/)?[^/?#]+/.test(currentURL)) {
            throw new Error("DeepSeek网页已切换到其他会话，本次任务已停止");
          }

          const state = await this.execute("is-generating", {
            stopButtonSelectors: SELECTORS.stopButton,
            continueButtonSelectors: SELECTORS.continueButton
          }, 3000);
          U.throwIfAborted(signal);

          // 新回复出现前，页面仍然保留上一轮的最后一条回复。
          receivedReply ||= snapshot.count > baseline.count
            || Boolean(snapshot.messageKey && snapshot.messageKey !== baseline.messageKey)
            || snapshot.text !== baseline.text || snapshot.reasoning !== baseline.reasoning;
          const changed = receivedReply
            && (snapshot.text !== content || snapshot.reasoning !== reasoning);
          if (receivedReply) {
            // DOM 快照不是 SSE；通过 extractDelta 计算跨段落换行与追加增量。
            const textDelta = extractDelta(content, snapshot.text);
            if (textDelta) options.onText?.(textDelta);
            const reasoningDelta = extractDelta(reasoning, snapshot.reasoning);
            if (reasoningDelta) options.onReasoning?.(reasoningDelta);
            content = snapshot.text;
            reasoning = snapshot.reasoning;
          }
          if (state.generating || changed || !content) {
            idleSince = 0;
          } else if (!idleSince) {
            idleSince = Date.now();
          } else if (Date.now() - idleSince >= 2000) {
            if (state.canContinue) {
              emit?.({ type: "log", message: "[探针6-Driver] 检测到DeepSeek触发长文本截断，自动点击【继续生成】..." });
              const clickRes = await this.execute("click-continue", {
                continueButtonSelectors: SELECTORS.continueButton
              }, 3000).catch(() => null);
              if (clickRes?.clicked) {
                idleSince = 0;
                await U.sleep(600, signal);
                continue;
              }
            }
            return { content: content.trim(), reasoning: reasoning.trim(), finished: true, sessionURL };
          }
          await U.sleep(250, signal);
        }
        throw new Error("DeepSeek网页回复超时，请检查右侧网页的生成状态后重试。");
      } catch (error) {
        const currentURL = (this.browser.currentURI?.spec || "").split(/[?#]/)[0].replace(/\/$/, "");
        if (!sessionURL || currentURL === sessionURL) await this.stop();
        throw error;
      }
    }
  }

  LitMTrans.DeepSeekWeb.SELECTORS = SELECTORS;
  LitMTrans.DeepSeekWeb.DeepSeekWebDriver = DeepSeekWebDriver;
})(this);
