(function() {
  "use strict";

  const SCRIPT_VERSION = 10;
  try {
    dump("[LitMTrans-ContentScript] Loaded into: " + (content?.location?.href || "none") + "\n");
  } catch (_) {}

  if (globalThis.__litmtransDeepSeekFrameScriptVersion >= SCRIPT_VERSION) return;
  globalThis.__litmtransDeepSeekFrameScriptVersion = SCRIPT_VERSION;

  try {
    sendAsyncMessage("litmtrans:deepseek:ready", {
      version: SCRIPT_VERSION,
      url: String(content?.location?.href || "")
    });
  } catch (_) {}

  // Gecko Frame Script 环境定时器垫片（Frame Script 顶层无全局 setTimeout/clearTimeout）
  const delay = (ms) => new Promise(resolve => {
    const w = (typeof content !== "undefined" && content) ? content : null;
    if (w && typeof w.setTimeout === "function") {
      w.setTimeout(resolve, Math.max(0, ms || 0));
    } else {
      resolve();
    }
  });

  const setTimeoutShim = (fn, ms) => {
    const w = (typeof content !== "undefined" && content) ? content : null;
    if (w && typeof w.setTimeout === "function") {
      return w.setTimeout(fn, ms);
    }
    if (typeof globalThis.setTimeout === "function") {
      return globalThis.setTimeout(fn, ms);
    }
    fn();
    return null;
  };

  const clearTimeoutShim = (id) => {
    const w = (typeof content !== "undefined" && content) ? content : null;
    if (w && typeof w.clearTimeout === "function") {
      return w.clearTimeout(id);
    }
    if (typeof globalThis.clearTimeout === "function") {
      return globalThis.clearTimeout(id);
    }
  };

  function findElement(doc, selectorList) {
    if (!doc) return null;
    for (const sel of selectorList) {
      try {
        if (sel.includes(":has-text(")) {
          const match = sel.match(/^(.*?):has-text\(['"]?(.*?)['"]?\)$/);
          if (match) {
            const base = match[1] || "*";
            const text = match[2];
            const candidates = doc.querySelectorAll(base);
            for (const el of candidates) {
              if ((el.textContent || "").includes(text)) return el;
            }
          }
          continue;
        }
        const el = doc.querySelector(sel);
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  function fillControlledInput(target, text, win) {
    if (!target) return false;
    const targetWin = target.ownerDocument?.defaultView || win || content;
    try {
      if (typeof target.focus === "function") target.focus();
    } catch (_) {}

    // 1. 重置 React 内部 tracker 缓存，确保后续 value 赋值被 React 识别为有更新
    try {
      const rawTarget = target.wrappedJSObject || target;
      if (rawTarget._valueTracker) {
        rawTarget._valueTracker.setValue("");
      }
    } catch (_) {}

    // 2. 使用 HTMLTextAreaElement/HTMLInputElement 原型链上的原生 setter 写入值
    let valueSet = false;
    try {
      const proto = (target instanceof targetWin.HTMLTextAreaElement)
        ? targetWin.HTMLTextAreaElement.prototype
        : (target instanceof targetWin.HTMLInputElement)
          ? targetWin.HTMLInputElement.prototype
          : Object.getPrototypeOf(target);
      const prototypeValueSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (prototypeValueSetter) {
        prototypeValueSetter.call(target, text);
        valueSet = true;
      }
    } catch (_) {}

    if (!valueSet) {
      try {
        target.value = text;
      } catch (_) {}
    }

    // 3. 派发 input 与 change 事件驱动 React 同步更新组件状态
    try {
      const InputEventCtor = targetWin.InputEvent || targetWin.Event;
      target.dispatchEvent(new InputEventCtor("input", {
        bubbles: true,
        cancelable: true,
        data: String(text),
        inputType: "insertText"
      }));
    } catch (_) {
      try {
        target.dispatchEvent(new targetWin.Event("input", { bubbles: true, cancelable: true }));
      } catch (_) {}
    }

    try {
      target.dispatchEvent(new targetWin.Event("change", { bubbles: true, cancelable: true }));
    } catch (_) {}

    return true;
  }

  function simulatePaste(target, text, win) {
    if (!target) return false;
    const targetWin = target.ownerDocument?.defaultView || win || content;
    try {
      if (typeof target.focus === "function") target.focus();
    } catch (_) {}

    // 优先通过标准 ClipboardEvent 派发真实的 paste 事件，让 DeepSeek 前端将超长文本自动折叠为附件卡片
    try {
      const rawWin = targetWin.wrappedJSObject || targetWin;
      const DataTransferCtor = rawWin.DataTransfer || targetWin.DataTransfer || globalThis.DataTransfer;
      const ClipboardEventCtor = rawWin.ClipboardEvent || targetWin.ClipboardEvent || globalThis.ClipboardEvent;

      if (DataTransferCtor && ClipboardEventCtor) {
        const dt = new DataTransferCtor();
        dt.setData("text/plain", String(text || ""));
        const pasteEvent = new ClipboardEventCtor("paste", {
          bubbles: true,
          cancelable: true,
          composed: true,
          clipboardData: dt,
          view: rawWin
        });
        const rawTarget = target.wrappedJSObject || target;
        rawTarget.dispatchEvent(pasteEvent);
        return true;
      }
    } catch (_) {}

    return fillControlledInput(target, text, targetWin);
  }

  function triggerEnter(target, win) {
    if (!target) return false;
    const targetWin = target.ownerDocument?.defaultView || win || content;
    try {
      if (typeof target.focus === "function") target.focus();
    } catch (_) {}

    const eventInit = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      isComposing: false,
      view: targetWin
    };

    try {
      const KeyboardEventCtor = targetWin.KeyboardEvent || KeyboardEvent;
      const kd = new KeyboardEventCtor("keydown", eventInit);
      target.dispatchEvent(kd);

      const ku = new KeyboardEventCtor("keyup", eventInit);
      target.dispatchEvent(ku);
      return true;
    } catch (e) {
      try {
        const rawWin = targetWin.wrappedJSObject || targetWin;
        const RawKeyboardEvent = rawWin.KeyboardEvent || KeyboardEvent;
        const rawTarget = target.wrappedJSObject || target;
        const kd = new RawKeyboardEvent("keydown", eventInit);
        rawTarget.dispatchEvent(kd);
        const ku = new RawKeyboardEvent("keyup", eventInit);
        rawTarget.dispatchEvent(ku);
        return true;
      } catch (_) {
        return false;
      }
    }
  }

  function triggerClick(btn, targetWin) {
    if (!btn) return false;
    const win = targetWin || btn.ownerDocument?.defaultView || globalThis;
    const rawBtn = btn.wrappedJSObject || btn;
    try { if (typeof rawBtn.focus === "function") rawBtn.focus(); } catch (_) {}
    const eventInit = { bubbles: true, cancelable: true, composed: true, view: win };
    try { rawBtn.dispatchEvent(new (win.PointerEvent || PointerEvent)("pointerdown", eventInit)); } catch (_) {}
    try { rawBtn.dispatchEvent(new (win.MouseEvent || MouseEvent)("mousedown", eventInit)); } catch (_) {}
    try { rawBtn.dispatchEvent(new (win.PointerEvent || PointerEvent)("pointerup", eventInit)); } catch (_) {}
    try { rawBtn.dispatchEvent(new (win.MouseEvent || MouseEvent)("mouseup", eventInit)); } catch (_) {}
    try {
      if (typeof rawBtn.click === "function") rawBtn.click();
      else btn.click();
      return true;
    } catch (_) {
      try { btn.click(); return true; } catch (_) { return false; }
    }
  }

  function findSendButton(doc, input, customSelectors) {
    if (!doc) return null;
    // 严格限定在输入框（Composer）容器范围内查找，禁止全局 DOM 盲扫造成误中历史消息卡片中的复制/朗读等按钮
    const composer = (input && (
      input.closest?.("form, [class*='chat-input'], [class*='composer'], [class*='input-box'], [class*='bottom']")
      || input.parentElement?.parentElement
    )) || null;

    const searchRoots = composer ? [composer, doc] : [doc];

    const selectors = customSelectors || [
      "div[role='button'][aria-label*='发送']:not([aria-disabled='true'])",
      "button[aria-label*='发送']:not([aria-disabled='true'])",
      "div[role='button'][aria-label*='Send']:not([aria-disabled='true'])",
      "button[aria-label*='Send']:not([aria-disabled='true'])",
      "div[role='button'].ds-button--circle:not(.ds-button--disabled):not([aria-disabled='true'])",
      "button.ds-button--circle:not(.ds-button--disabled):not([aria-disabled='true'])",
      ".ds-button--circle:not(.ds-button--disabled):not([aria-disabled='true'])",
      ".chat-input-send-button"
    ];

    const isExcluded = (el, root) => {
      if (!el || el.disabled || el.getAttribute("aria-disabled") === "true") return true;
      const className = String(el.className || "");
      if (className.includes("disabled")) return true;
      // 若在正文消息或列表项内部，绝不是发送按钮
      if (el.closest?.("[data-role='assistant'], .chat-message, [class*='assistant-message'], .ds-markdown")) return true;
      const label = (el.getAttribute("aria-label") || el.title || el.textContent || "").toLowerCase();
      if (label.includes("停止") || label.includes("stop") || label.includes("暂停")) return true;
      if (label.includes("附件") || label.includes("attach") || label.includes("上传") || label.includes("upload")) return true;
      if (label.includes("搜索") || label.includes("search") || label.includes("联网") || label.includes("web")) return true;
      if (label.includes("思考") || label.includes("think") || label.includes("reason")) return true;
      if (label.includes("复制") || label.includes("copy") || label.includes("重新生成") || label.includes("regenerate")) return true;
      if (label.includes("朗读") || label.includes("语音") || label.includes("like") || label.includes("dislike")) return true;
      return false;
    };

    for (const root of searchRoots) {
      for (const sel of selectors) {
        try {
          const candidates = root.querySelectorAll(sel);
          for (let i = candidates.length - 1; i >= 0; i--) {
            const el = candidates[i];
            if (!isExcluded(el, root)) return el;
          }
        } catch (_) {}
      }
    }

    return null;
  }

  if (globalThis.__litmtransDeepSeekListener) {
    try {
      removeMessageListener("litmtrans:deepseek:request", globalThis.__litmtransDeepSeekListener);
    } catch (_) {}
  }

  globalThis.__litmtransDeepSeekListener = async function(msg) {
    const { id, action, payload } = msg.data || {};
    const win = content;
    const doc = content?.document;

    try {
      dump("[LitMTrans-ContentScript] 收到请求: action=" + action + ", id=" + id + ", url=" + (win?.location?.href || "none") + "\n");
    } catch (_) {}

    try {
      if (action === "check-ready") {
        const href = String(win?.location?.href || "");
        const isAuth = href.includes("/sign_in") || href.includes("/auth") || href.includes("/login");
        const input = findElement(doc, payload?.chatInputSelectors || ["#chat-input", "textarea"]);
        const loginEl = findElement(doc, payload?.loginSelectors || ["input[type='tel']", "a[href*='login']", "button:has-text('登录')"]);
        sendAsyncMessage("litmtrans:deepseek:response", {
          id,
          result: {
            ready: Boolean(input && !isAuth),
            loggedIn: !isAuth && (!loginEl || Boolean(input)),
            url: href,
            hasInput: Boolean(input)
          }
        });
      } else if (action === "new-chat") {
        const href = String(win?.location?.href || "");
        const input = findElement(doc, payload.chatInputSelectors || ["#chat-input", "textarea"]);
        const isFreshRoot = href === "https://chat.deepseek.com/" || href === "https://chat.deepseek.com" || href.endsWith("/chat");
        if (isFreshRoot && !input?.value?.trim()) {
          sendAsyncMessage("litmtrans:deepseek:response", { id, result: { ok: true, skipped: true } });
          return;
        }
        const btn = findElement(doc, payload.newChatSelectors || [
          "button:has-text('新对话')",
          "button:has-text('开启新对话')",
          "button:has-text('New chat')",
          "div[role='button']:has-text('新对话')",
          "div[role='button']:has-text('开启新对话')",
          "[aria-label*='新对话']",
          "[aria-label*='New chat']"
        ]);
        if (btn) {
          try { btn.click(); } catch (_) {}
          sendAsyncMessage("litmtrans:deepseek:response", { id, result: { ok: true } });
        } else {
          // 找不到新对话按钮时（如侧栏折叠），直接通过路由切回根地址，100% 触发开启新对话
          try {
            if (win?.location && !isFreshRoot) {
              win.location.href = "https://chat.deepseek.com/";
              sendAsyncMessage("litmtrans:deepseek:response", { id, result: { ok: true, navigated: true } });
              return;
            }
          } catch (_) {}
          sendAsyncMessage("litmtrans:deepseek:response", { id, result: { ok: Boolean(input), reused: true } });
        }
      } else if (action === "submit") {
        const targetWin = content;
        const wrappedWin = win?.wrappedJSObject || content?.wrappedJSObject || content;
        if (wrappedWin) {
          wrappedWin.__activeStreamId = payload.streamId || 0;
          wrappedWin.__wcStream = { text: '', done: false, started: false, status: 0, error: '' };
        }

        const input = findElement(doc, payload.chatInputSelectors || ["#chat-input", "textarea"]);
        if (!input) {
          sendAsyncMessage("litmtrans:deepseek:response", { id, error: "未找到输入框" });
          return;
        }

        // 1. 填入受控文本并驱动 React 内部状态机同步
        simulatePaste(input, payload.text, targetWin);
        await delay(100);
        if (!input.value || input.value !== payload.text) {
          fillControlledInput(input, payload.text, targetWin);
        }

        // 2. 轮询等待发送按钮解除禁用（等待 React 状态机就绪），最多等待 4 秒
        let sendBtn = null;
        const waitStart = Date.now();
        while (Date.now() - waitStart < 5000) {
          sendBtn = findSendButton(doc, input, payload.sendButtonSelectors);
          if (sendBtn) break;
          await delay(150);
        }

        if (sendBtn) {
          try {
            dump(`[LitMTrans-ContentScript] submit: 找到发送按钮 (${sendBtn.tagName}, class=${sendBtn.className})，派发组合点击\n`);
          } catch (_) {}
          triggerClick(sendBtn, targetWin);
        } else {
          try {
            dump("[LitMTrans-ContentScript] submit: 未找到已解除禁用的发送按钮，直接触发 Enter\n");
          } catch (_) {}
          triggerEnter(input, targetWin);
        }

        // 验证提交状态：若 350ms 后输入框内容仍未清空且未进入生成，立即分发 Enter 兜底强制提交
        await delay(350);
        const isStillFull = Boolean(input.value && input.value.trim().length > 0);
        const stopBtn = findElement(doc, payload.stopButtonSelectors || [
          "button[aria-label*='停止']",
          "div[role='button'][aria-label*='停止']",
          "button[aria-label*='Stop']",
          "div[role='button'][aria-label*='Stop']",
          "button:has(svg rect)",
          "div[role='button']:has(svg rect)",
          ".chat-input-stop-button"
        ]);

        if (isStillFull && !stopBtn) {
          try {
            dump("[LitMTrans-ContentScript] submit: 点击后输入框未清空且未开始生成，立即执行 Enter 兜底发送\n");
          } catch (_) {}
          triggerEnter(input, targetWin);
        }

        sendAsyncMessage("litmtrans:deepseek:response", { id, result: { ok: true } });
      } else if (action === "stop") {
        const stopBtn = findElement(doc, payload.stopButtonSelectors || [
          "button[aria-label*='停止']",
          "div[role='button'][aria-label*='停止']",
          "button[aria-label*='Stop']",
          "div[role='button'][aria-label*='Stop']",
          "button:has(svg rect)",
          "div[role='button']:has(svg rect)",
          "div[role='button'].ds-button--circle svg path[d^='M2 4.88']",
          ".ds-button--circle svg path[d^='M2 4.88']",
          "[aria-label*='stop generating' i]",
          ".chat-input-stop-button"
        ]);
        if (stopBtn) {
          try { stopBtn.click(); } catch (_) {}
          sendAsyncMessage("litmtrans:deepseek:response", { id, result: { ok: true } });
        } else {
          sendAsyncMessage("litmtrans:deepseek:response", { id, result: { ok: false } });
        }
      } else if (action === "is-generating") {
        const stopBtn = findElement(doc, payload.stopButtonSelectors || [
          "button[aria-label*='停止']",
          "div[role='button'][aria-label*='停止']",
          "button[aria-label*='Stop']",
          "div[role='button'][aria-label*='Stop']",
          "button:has(svg rect)",
          "div[role='button']:has(svg rect)",
          "div[role='button'].ds-button--circle svg path[d^='M2 4.88']",
          ".ds-button--circle svg path[d^='M2 4.88']",
          "[aria-label*='stop generating' i]",
          ".chat-input-stop-button"
        ]);
        const continueBtn = findElement(doc, payload.continueButtonSelectors || [
          "button:has-text('继续生成')",
          "div[role='button']:has-text('继续生成')",
          "button:has-text('Continue generating')",
          "button:has-text('Continue generation')",
          "button:has-text('Continue')",
          "[aria-label*='继续生成']",
          "[aria-label*='Continue']"
        ]);
        sendAsyncMessage("litmtrans:deepseek:response", { id, result: { generating: Boolean(stopBtn), canContinue: Boolean(continueBtn) } });
      } else if (action === "click-continue") {
        const continueBtn = findElement(doc, payload.continueButtonSelectors || [
          "button:has-text('继续生成')",
          "div[role='button']:has-text('继续生成')",
          "button:has-text('Continue generating')",
          "button:has-text('Continue generation')",
          "button:has-text('Continue')",
          "[aria-label*='继续生成']",
          "[aria-label*='Continue']"
        ]);
        if (continueBtn) {
          try { continueBtn.click(); } catch (_) {}
          sendAsyncMessage("litmtrans:deepseek:response", { id, result: { ok: true, clicked: true } });
        } else {
          sendAsyncMessage("litmtrans:deepseek:response", { id, result: { ok: false, clicked: false } });
        }
      } else if (action === "attach-files" || action === "attach-images") {
        const fileInput = findElement(doc, payload.fileInputSelectors || ["input[type='file']"]);
        const chatInput = findElement(doc, payload.chatInputSelectors || ["#chat-input", "textarea"]);
        if (!fileInput && !chatInput) {
          sendAsyncMessage("litmtrans:deepseek:response", { id, error: "未在DeepSeek页面中找到文件上传控件或输入框" });
          return;
        }
        const DataTransferCtor = win?.DataTransfer || globalThis.DataTransfer;
        const FileCtor = win?.File || globalThis.File;
        if (!DataTransferCtor || !FileCtor) {
          sendAsyncMessage("litmtrans:deepseek:response", { id, error: "浏览器环境不支持构造上传文件" });
          return;
        }
        const dt = new DataTransferCtor();
        const filesList = [];
        for (const item of (payload.files || [])) {
          const binaryStr = atob(item.base64);
          const len = binaryStr.length;
          const bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) bytes[i] = binaryStr.charCodeAt(i);
          const defaultMime = item.name?.endsWith(".md") ? "text/markdown" : (item.name?.endsWith(".txt") ? "text/plain" : "image/jpeg");

          let fileBits;
          if (typeof cloneInto === "function") {
            fileBits = cloneInto([bytes], win);
          } else if (typeof Components !== "undefined" && Components?.utils?.cloneInto) {
            fileBits = Components.utils.cloneInto([bytes], win);
          } else if (typeof win?.structuredClone === "function") {
            fileBits = win.structuredClone([bytes]);
          } else {
            fileBits = [bytes];
          }

          const domFile = new FileCtor(fileBits, item.name, { type: item.type || defaultMime });
          dt.items.add(domFile);
          filesList.push(domFile);
        }

        let attached = false;
        if (fileInput) {
          try {
            fileInput.files = dt.files;
            fileInput.dispatchEvent(new win.Event("change", { bubbles: true }));
            attached = true;
          } catch (_) {
            if (typeof fileInput.mozSetFileArray === "function") {
              try {
                fileInput.mozSetFileArray(filesList);
                fileInput.dispatchEvent(new win.Event("change", { bubbles: true }));
                attached = true;
              } catch (__) {}
            }
          }
        }

        if (!attached && chatInput) {
          try {
            const ClipboardEventCtor = win?.ClipboardEvent || globalThis.ClipboardEvent;
            const pasteEvent = new ClipboardEventCtor("paste", {
              bubbles: true,
              cancelable: true,
              composed: true,
              clipboardData: dt,
              view: win
            });
            chatInput.dispatchEvent(pasteEvent);
            attached = true;
          } catch (_) {}
        }

        sendAsyncMessage("litmtrans:deepseek:response", { id, result: { ok: true, count: payload.files.length } });
      } else if (action === "wait-attachments-ready") {
        const timeout = Math.max(3000, Number(payload.timeout) || 15000);
        const start = Date.now();
        let ready = false;
        await delay(400);
        while (Date.now() - start < timeout) {
          const loadingEl = doc?.querySelector("[class*='loading'], [class*='spin'], [aria-busy='true'], .ds-loading");
          if (!loadingEl) {
            ready = true;
            break;
          }
          await delay(250);
        }
        sendAsyncMessage("litmtrans:deepseek:response", { id, result: { ready } });
      } else if (action === "get-assistant-text") {
        const assistantSelectors = payload.assistantSelectors || [
          "[data-role='assistant']",
          ".chat-message-assistant",
          "[class*='assistant-message']",
          ".ds-assistant-message-main-content",
          ".ds-markdown",
          ".chat-message"
        ];
        let lastAssistant = null;
        if (doc) {
          for (const sel of assistantSelectors) {
            const candidates = doc.querySelectorAll(sel);
            if (candidates.length > 0) {
              lastAssistant = candidates[candidates.length - 1];
              break;
            }
          }
        }
        function domToMarkdown(root, isReasoning = false) {
          if (!root) return "";
          const thinkSelector = ".ds-think-content, .ds-think, [class*='thinking'], [class*='reasoning'], .ds-markdown--think";
          if (!isReasoning && root.closest?.(thinkSelector)) return "";

          const clone = root.cloneNode(true);
          if (!isReasoning) {
            for (const junk of clone.querySelectorAll(thinkSelector)) junk.remove();
          }
          for (const junk of clone.querySelectorAll("button, svg, [class*='copy'], [class*='action'], [class*='feedback'], .ds-markdown-code-copy-button, script, style")) {
            junk.remove();
          }

          function walk(node, parentTag = "") {
            if (!node) return "";
            if (node.nodeType === 3 /* Node.TEXT_NODE */) return node.nodeValue || "";
            if (node.nodeType !== 1 /* Node.ELEMENT_NODE */) return "";

            const tag = (node.tagName || "").toLowerCase();
            const cls = String(node.className || "");

            // KaTeX 数学公式优先提取
            if (cls.includes("katex") || tag === "math") {
              const isDisplay = cls.includes("katex-display") || parentTag === "div";
              let tex = "";
              const annotation = node.querySelector?.("annotation[encoding*='tex'], annotation");
              if (annotation) tex = (annotation.textContent || "").trim();
              if (!tex) tex = (node.textContent || "").trim();
              return isDisplay ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
            }

            const walkChildren = (pTag = tag) => {
              let res = "";
              for (const child of node.childNodes) {
                res += walk(child, pTag);
              }
              return res;
            };

            switch (tag) {
              case "br":
                return "\n";
              case "hr":
                return "\n\n---\n\n";
              case "h1":
              case "h2":
              case "h3":
              case "h4":
              case "h5":
              case "h6": {
                const level = Number(tag[1]) || 1;
                const text = walkChildren().trim();
                return text ? `\n\n${"#".repeat(level)} ${text}\n\n` : "";
              }
              case "p": {
                const text = walkChildren().trim();
                return text ? `\n\n${text}\n\n` : "";
              }
              case "strong":
              case "b": {
                const text = walkChildren().trim();
                return text ? `**${text}**` : "";
              }
              case "em":
              case "i": {
                const text = walkChildren().trim();
                return text ? `*${text}*` : "";
              }
              case "s":
              case "del":
              case "strike": {
                const text = walkChildren().trim();
                return text ? `~~${text}~~` : "";
              }
              case "pre": {
                const codeEl = node.querySelector?.("code") || node;
                const className = String(codeEl.className || "");
                const langMatch = className.match(/language-([a-zA-Z0-9_-]+)/);
                const lang = langMatch ? langMatch[1] : "";
                const rawCode = (codeEl.textContent || "").replace(/\r\n/g, "\n");
                return `\n\n\`\`\`${lang}\n${rawCode.replace(/\n+$/, "")}\n\`\`\`\n\n`;
              }
              case "code": {
                if (parentTag === "pre") return node.textContent || "";
                const text = (node.textContent || "").replace(/`/g, "\\`");
                return `\`${text}\``;
              }
              case "ul": {
                const items = [];
                const children = Array.from(node.children || []);
                for (const child of children) {
                  if ((child.tagName || "").toLowerCase() === "li") {
                    const itemText = walk(child, "li").trim();
                    if (itemText) items.push(`- ${itemText}`);
                  } else {
                    const itemText = walk(child, "ul").trim();
                    if (itemText) items.push(itemText);
                  }
                }
                return items.length ? `\n\n${items.join("\n")}\n\n` : "";
              }
              case "ol": {
                let index = 1;
                const items = [];
                const children = Array.from(node.children || []);
                for (const child of children) {
                  if ((child.tagName || "").toLowerCase() === "li") {
                    const itemText = walk(child, "ol").trim();
                    if (itemText) items.push(`${index++}. ${itemText}`);
                  } else {
                    const itemText = walk(child, "ol").trim();
                    if (itemText) items.push(itemText);
                  }
                }
                return items.length ? `\n\n${items.join("\n")}\n\n` : "";
              }
              case "li":
                return walkChildren();
              case "blockquote": {
                const text = walkChildren().trim();
                return text ? `\n\n> ${text.replace(/\n/g, "\n> ")}\n\n` : "";
              }
              case "table": {
                const rows = Array.from(node.querySelectorAll("tr"));
                if (!rows.length) return walkChildren();
                const tableLines = [];
                let headerWidth = 0;
                rows.forEach((row, rowIndex) => {
                  const cells = Array.from(row.querySelectorAll("th, td")).map(cell =>
                    walk(cell, "td").trim().replace(/\|/g, "\\|").replace(/\n/g, " ")
                  );
                  if (rowIndex === 0) {
                    headerWidth = cells.length;
                    tableLines.push(`| ${cells.join(" | ")} |`);
                    tableLines.push(`| ${Array(headerWidth).fill("---").join(" | ")} |`);
                  } else {
                    while (cells.length < headerWidth) cells.push("");
                    tableLines.push(`| ${cells.join(" | ")} |`);
                  }
                });
                return `\n\n${tableLines.join("\n")}\n\n`;
              }
              case "th":
              case "td":
                return walkChildren();
              case "a": {
                const href = node.getAttribute?.("href") || "";
                const text = walkChildren().trim();
                if (!href || href.startsWith("javascript:")) return text;
                const imgMatch = href.match(/(?:https?:\/\/)?(?:images\/)?(image_\d+\.[a-zA-Z0-9]+)/i)
                  || text.match(/(?:https?:\/\/)?(?:images\/)?(image_\d+\.[a-zA-Z0-9]+)/i);
                if (imgMatch) {
                  const filename = imgMatch[1];
                  const imageID = filename.replace(/\.[^.]+$/, "").toUpperCase();
                  return `\n\n![${imageID}](images/${filename})\n\n`;
                }
                return `[${text || href}](${href})`;
              }
              case "img": {
                const src = node.getAttribute?.("src") || "";
                const alt = node.getAttribute?.("alt") || "";
                const imgMatch = src.match(/(?:https?:\/\/)?(?:images\/)?(image_\d+\.[a-zA-Z0-9]+)/i)
                  || alt.match(/(?:https?:\/\/)?(?:images\/)?(image_\d+\.[a-zA-Z0-9]+)/i);
                if (imgMatch) {
                  const filename = imgMatch[1];
                  const imageID = filename.replace(/\.[^.]+$/, "").toUpperCase();
                  return `\n\n![${imageID}](images/${filename})\n\n`;
                }
                return src ? `![${alt}](${src})` : "";
              }
              default:
                return walkChildren();
            }
          }

          const raw = walk(clone);
          return raw.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
        }

        let text = "";
        let reasoning = "";
        if (lastAssistant) {
          const thinkEl = lastAssistant.querySelector(".ds-think-content, .ds-think, [class*='thinking'], [class*='reasoning'], .ds-markdown--think");
          if (thinkEl) {
            reasoning = domToMarkdown(thinkEl, true);
          }
          // 提取正文：排除思考容器，避免思考内容混入正文
          const markdownEls = Array.from(lastAssistant.querySelectorAll(".ds-markdown, [class*='markdown']"))
            .filter(el => !el.closest(".ds-think-content, .ds-think, [class*='thinking'], [class*='reasoning'], .ds-markdown--think") && !el.classList.contains("ds-markdown--think"));

          if (markdownEls.length > 0) {
            text = markdownEls.map(el => domToMarkdown(el, false)).filter(Boolean).join("\n\n");
          } else {
            text = domToMarkdown(lastAssistant, false);
          }
        }
        sendAsyncMessage("litmtrans:deepseek:response", {
          id,
          result: { text, reasoning }
        });
      } else if (action === "session-action") {
        const subAction = payload.subAction;
        function ensureSidebarOpen() {
          const expandBtn = findElement(doc, [
            "button[aria-label*='展开']",
            "button[aria-label*='打开侧边栏']",
            "button[aria-label*='侧边栏']",
            "div[role='button'][aria-label*='展开']",
            "[class*='sidebar-toggle']",
            "[class*='collapse-btn']"
          ]);
          if (expandBtn) {
            try { expandBtn.click(); } catch (_) {}
          }
        }

        if (subAction === "list") {
          let found = [];
          const selectors = payload.sessionSelectors || ["[class*='session-item']", "nav a", "aside a"];
          for (const sel of selectors) {
            const items = doc ? doc.querySelectorAll(sel) : [];
            for (const item of items) {
              const text = (item.textContent || "").trim().replace(/\s+/g, " ");
              if (text && text.length <= 80 && !/^(开启新对话|新对话|New chat|删除|重命名|清空|设置|登出)/i.test(text)) {
                found.push({ title: text });
              }
            }
            if (found.length) break;
          }
          if (!found.length) {
            ensureSidebarOpen();
            await delay(200);
            for (const sel of selectors) {
              const items = doc ? doc.querySelectorAll(sel) : [];
              for (const item of items) {
                const text = (item.textContent || "").trim().replace(/\s+/g, " ");
                if (text && text.length <= 80 && !/^(开启新对话|新对话|New chat|删除|重命名|清空|设置|登出)/i.test(text)) {
                  found.push({ title: text });
                }
              }
              if (found.length) break;
            }
          }
          sendAsyncMessage("litmtrans:deepseek:response", { id, result: { sessions: found } });
        } else if (subAction === "select") {
          const selectors = payload.sessionSelectors || ["[class*='session-item']", "nav a", "aside a"];
          let selected = false;
          const targetTitle = String(payload.title || "").trim();
          const targetDocID = String(payload.documentID || "").trim();
          for (const sel of selectors) {
            const items = doc ? doc.querySelectorAll(sel) : [];
            for (const item of items) {
              const text = (item.textContent || "").trim();
              if ((targetTitle && text.includes(targetTitle)) || (targetDocID && text.includes(targetDocID))) {
                try { item.scrollIntoView?.({ block: "center" }); } catch (_) {}
                item.click();
                selected = true;
                break;
              }
            }
            if (selected) break;
          }
          sendAsyncMessage("litmtrans:deepseek:response", { id, result: { ok: selected } });
        } else if (subAction === "rename") {
          const activeItem = doc?.querySelector("[class*='session-item'][class*='active'], [class*='item--active'], [aria-selected='true']") || doc?.querySelector("[class*='session-item']");
          if (activeItem) {
            try {
              const MouseEventCtor = win?.MouseEvent || MouseEvent;
              activeItem.dispatchEvent(new MouseEventCtor("mouseenter", { bubbles: true }));
              activeItem.dispatchEvent(new MouseEventCtor("mouseover", { bubbles: true }));
            } catch (_) {}
          }
          await delay(150);
          const menuBtn = activeItem?.querySelector("[class*='more'], [class*='menu'], [aria-label*='更多'], [aria-label*='More'], button:has(svg), svg");
          if (menuBtn) menuBtn.click();
          await delay(300);
          const renameOption = findElement(doc, ["div[role='menuitem']:has-text('重命名')", "button:has-text('重命名')"]);
          if (renameOption) {
            renameOption.click();
            await delay(300);
            const renameInput = activeItem?.querySelector("input") || doc?.querySelector("input[value]");
            if (renameInput) {
              fillControlledInput(renameInput, payload.newTitle, win?.wrappedJSObject || win);
              triggerEnter(renameInput, win?.wrappedJSObject || win);
            }
            sendAsyncMessage("litmtrans:deepseek:response", { id, result: { ok: true } });
          } else {
            sendAsyncMessage("litmtrans:deepseek:response", { id, result: { ok: false } });
          }
        } else if (subAction === "delete") {
          const activeItem = doc?.querySelector("[class*='session-item'][class*='active'], [class*='item--active'], [aria-selected='true']") || doc?.querySelector("[class*='session-item']");
          if (activeItem) {
            try {
              const MouseEventCtor = win?.MouseEvent || MouseEvent;
              activeItem.dispatchEvent(new MouseEventCtor("mouseenter", { bubbles: true }));
              activeItem.dispatchEvent(new MouseEventCtor("mouseover", { bubbles: true }));
            } catch (_) {}
          }
          await delay(150);
          const menuBtn = activeItem?.querySelector("[class*='more'], [class*='menu'], [aria-label*='更多'], [aria-label*='More'], button:has(svg), svg");
          if (menuBtn) menuBtn.click();
          await delay(250);
          const deleteOption = findElement(doc, ["div[role='menuitem']:has-text('删除')", "button:has-text('删除')"]);
          if (deleteOption) {
            deleteOption.click();
            let confirmed = false;
            const confirmWaitStart = Date.now();
            while (Date.now() - confirmWaitStart < 2000) {
              await delay(150);
              const confirmBtn = findElement(doc, [
                "button.ds-button--primary:has-text('删除')",
                "button:has-text('确认')",
                "button:has-text('确定')",
                "button:has-text('Delete')",
                ".ds-modal button.ds-button--primary"
              ]);
              if (confirmBtn) {
                confirmBtn.click();
                confirmed = true;
                break;
              }
            }
            sendAsyncMessage("litmtrans:deepseek:response", { id, result: { ok: confirmed } });
          } else {
            sendAsyncMessage("litmtrans:deepseek:response", { id, result: { ok: false } });
          }
        }
      }
    } catch (err) {
      try {
        dump("[LitMTrans-ContentScript] 处理异常: action=" + action + ", id=" + id + ", err=" + (err?.message || err) + "\n");
      } catch (_) {}
      sendAsyncMessage("litmtrans:deepseek:response", { id, error: String(err?.message || err) });
    }
  };

  addMessageListener("litmtrans:deepseek:request", globalThis.__litmtransDeepSeekListener);

  if (!globalThis.__litmtransDeepSeekContextMenuBound) {
    globalThis.__litmtransDeepSeekContextMenuBound = true;
    addEventListener("contextmenu", event => {
      try {
        const sel = String(content?.getSelection?.()?.toString?.() || "").trim();
        sendAsyncMessage("litmtrans:deepseek:contextmenu", {
          screenX: Number(event.screenX || 0),
          screenY: Number(event.screenY || 0),
          selectedText: sel
        });
        event.preventDefault();
      } catch (_) {}
    }, true);
  }
})();
