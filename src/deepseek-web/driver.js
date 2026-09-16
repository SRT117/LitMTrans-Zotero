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
      const actor = this.getActor();
      const started = Date.now();
      const query = actor.sendQuery("LitMTrans:DeepSeek:execute", { action, payload });
      let timer;
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
        }, timeoutMs);
      });

      try {
        return await Promise.race([query, timeout]);
      } finally {
        if (timer) {
          clearTimer(timer);
        }
      }
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

    async attachFiles(files = [], signal = null) {
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

      const res = await this.execute("attach-files", {
        files: filesPayload,
        fileInputSelectors: SELECTORS.fileInput
      }, 20000);

      if (res?.error) throw new Error(res.error);

      // 上传完成后以输入区发送按钮恢复可用为准；不能用全页 loading 状态，
      // 否则页面其他异步组件会让已经完成的附件额外空等数秒。
      const waitTimeout = Math.min(12000, Math.max(1500, filesPayload.length * 250));
      const ready = await this.execute("wait-attachments-ready", {
        timeout: waitTimeout,
        chatInputSelectors: SELECTORS.chatInput,
        sendButtonSelectors: SELECTORS.sendButton
      }, waitTimeout + 1000).catch(() => null);

      if (!ready?.ready) await U.sleep(150, signal);
      return true;
    }

    async attachImages(filePaths = [], signal = null) {
      return this.attachFiles(filePaths, signal);
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

async renameCurrentSession(newTitle, expectedURL) {
const res = await this.execute("session-action", { subAction: "rename", newTitle, expectedURL }, 12000);
if (!res?.ok) throw new Error(res?.error || "DeepSeek会话重命名未完成");
return true;
}

async deleteCurrentSession(expectedURL) {
const res = await this.execute("session-action", { subAction: "delete", expectedURL }, 12000);
if (!res?.ok) throw new Error(res?.error || "DeepSeek临时会话删除未完成");
await this.navigate("https://chat.deepseek.com/");
return true;
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
