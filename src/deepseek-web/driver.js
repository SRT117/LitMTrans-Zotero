(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  LitMTrans.DeepSeekWeb = LitMTrans.DeepSeekWeb || {};
  const U = LitMTrans.Utils;

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
      "div[role='button'].ds-button--circle:not(.ds-button--disabled):not([aria-disabled='true'])",
      "button.ds-button--circle:not(.ds-button--disabled):not([aria-disabled='true'])",
      ".ds-button--circle:not(.ds-button--disabled):not([aria-disabled='true'])",
      "div[role='button'][aria-label*='发送']",
      "button[aria-label*='发送']",
      "div[role='button'][aria-label*='Send']",
      "button[aria-label*='Send']",
      "button:has-text('发送')",
      "button[type='submit']",
      ".chat-input-send-button"
    ],
    stopButton: [
      "button[aria-label*='停止']",
      "div[role='button'][aria-label*='停止']",
      "button[aria-label*='Stop']",
      "div[role='button'][aria-label*='Stop']",
      "div[role='button'].ds-button--circle svg path[d^='M2 4.88']",
      ".ds-button--circle svg path[d^='M2 4.88']",
      "[aria-label*='stop generating' i]",
      ".chat-input-stop-button"
    ],
    assistantMessage: [
      ".ds-assistant-message-main-content",
      ".ds-markdown",
      ".chat-message-assistant",
      "[data-role='assistant']",
      ".chat-message"
    ],
    reasoningContainer: [
      ".ds-think-content",
      ".ds-think",
      "[class*='thinking']",
      "[class*='reasoning']",
      ".ds-markdown--think"
    ],
    fileInput: [
      "input[type='file'][accept*='image']",
      "input[type='file']"
    ],
    composerAttachment: [
      "[data-resource-id]",
      "[data-attachment-id]",
      "[data-testid*='attachment']",
      "[data-testid*='file']",
      ".ds-upload__file",
      "[class*='attachment']",
      "[class*='upload-file']"
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
      "div:has-text('新对话')",
      "div[role='button']:has-text('新对话')",
      "button:has-text('开启新对话')",
      "div[role='button']:has-text('开启新对话')",
      "button:has-text('New chat')",
      "div:has-text('New chat')",
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

  // Content Process Frame Script (runs inside the browser tab's content process)
  const FRAME_SCRIPT_SOURCE = `
    (function() {
      const SCRIPT_VERSION = 2;
      if (globalThis.__litmtransDeepSeekFrameScriptVersion >= SCRIPT_VERSION) return;
      globalThis.__litmtransDeepSeekFrameScriptVersion = SCRIPT_VERSION;

      // Gecko Frame Script 环境定时器垫片（Frame Script 顶层无全局 setTimeout/clearTimeout）
      const delay = (ms) => new Promise(resolve => {
        const w = (typeof content !== "undefined" && content) ? content : null;
        if (w && typeof w.setTimeout === "function") {
          w.setTimeout(resolve, Math.max(0, ms || 0));
        } else {
          resolve();
        }
      });

      const setTimeout = (fn, ms) => {
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

      const clearTimeout = (id) => {
        const w = (typeof content !== "undefined" && content) ? content : null;
        if (w && typeof w.clearTimeout === "function") {
          return w.clearTimeout(id);
        }
        if (typeof globalThis.clearTimeout === "function") {
          return globalThis.clearTimeout(id);
        }
      };

      function installStreamCapture() {
        const win = content ? (content.wrappedJSObject || content) : null;
        if (!win || win.__wcCaptureInstalled) return;
        win.__wcCaptureInstalled = true;
        win.__wcStream = { text: '', done: false, started: false, status: 0, error: '' };

        const X = win.XMLHttpRequest;
        if (X && X.prototype) {
          const origOpen = X.prototype.open;
          const origSend = X.prototype.send;
          X.prototype.open = function(method, url) {
            this.__wcIsChat = typeof url === 'string' && url.includes('/chat/completion');
            return origOpen.apply(this, arguments);
          };
          X.prototype.send = function() {
            if (this.__wcIsChat) {
              let lastLen = 0;
              this.addEventListener('progress', () => {
                const stream = win.__wcStream;
                if (!stream) return;
                const text = this.responseText || '';
                if (text.length > lastLen) {
                  const delta = text.slice(lastLen);
                  stream.text += delta;
                  lastLen = text.length;
                  try {
                    sendAsyncMessage("litmtrans:deepseek:stream-chunk", {
                      streamId: win.__activeStreamId || 0,
                      delta: delta,
                      text: stream.text,
                      done: false
                    });
                  } catch (_) {}
                }
                stream.started = true;
              });
              this.addEventListener('loadend', () => {
                const stream = win.__wcStream;
                if (!stream) return;
                stream.done = true;
                stream.status = this.status;
                if (this.status >= 400) stream.error = 'HTTP ' + this.status;
                try {
                  sendAsyncMessage("litmtrans:deepseek:stream-chunk", {
                    streamId: win.__activeStreamId || 0,
                    delta: '',
                    text: stream.text,
                    done: true,
                    error: stream.error
                  });
                } catch (_) {}
              });
            }
            return origSend.apply(this, arguments);
          };
        }

        const origFetch = win.fetch ? win.fetch.bind(win) : null;
        if (origFetch) {
          win.fetch = function(input, init) {
            const url = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
            const isChat = typeof url === 'string' && url.includes('/chat/completion');
            return origFetch(input, init).then(response => {
              if (!isChat || !response || !response.body || typeof response.body.tee !== 'function') return response;
              try {
                const [pageStream, captureStream] = response.body.tee();
                const decoder = new win.TextDecoder();
                const reader = captureStream.getReader();
                (async () => {
                  try {
                    while (true) {
                      const { done, value } = await reader.read();
                      if (done) break;
                      const delta = decoder.decode(value, { stream: true });
                      const stream = win.__wcStream;
                      if (stream) {
                        stream.text += delta;
                        stream.started = true;
                      }
                      try {
                        sendAsyncMessage("litmtrans:deepseek:stream-chunk", {
                          streamId: win.__activeStreamId || 0,
                          delta: delta,
                          text: stream ? stream.text : '',
                          done: false
                        });
                      } catch (_) {}
                    }
                    const stream = win.__wcStream;
                    const rest = decoder.decode();
                    if (stream) {
                      if (rest) stream.text += rest;
                      stream.done = true;
                      stream.status = response.status;
                      if (response.status >= 400) stream.error = 'HTTP ' + response.status;
                    }
                    try {
                      sendAsyncMessage("litmtrans:deepseek:stream-chunk", {
                        streamId: win.__activeStreamId || 0,
                        delta: rest,
                        text: stream ? stream.text : '',
                        done: true,
                        error: stream ? stream.error : ''
                      });
                    } catch (_) {}
                  } catch (_) {}
                })();
                return new win.Response(pageStream, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers
                });
              } catch (_) {
                return response;
              }
            });
          };
        }
      }

      function findElement(doc, selectorList) {
        if (!doc) return null;
        for (const sel of selectorList) {
          try {
            if (sel.includes(":has-text(")) {
              const match = sel.match(/^(.*?):has-text\\(['"]?(.*?)['"]?\\)$/);
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
        const doc = target.ownerDocument || win?.document;
        try {
          if (typeof target.focus === "function") target.focus();
          if (typeof target.select === "function") target.select();
          if (doc && typeof doc.execCommand === "function" && doc.execCommand("insertText", false, text)) {
            return true;
          }
        } catch (_) {}

        try {
          const prototype = win?.HTMLTextAreaElement?.prototype
            || win?.HTMLInputElement?.prototype
            || Object.getPrototypeOf(target);
          const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
          if (prototypeValueSetter) {
            prototypeValueSetter.call(target, text);
          } else {
            target.value = text;
          }
        } catch (_) {
          target.value = text;
        }

        const InputEventCtor = win?.InputEvent || globalThis.InputEvent;
        try {
          target.dispatchEvent(new InputEventCtor("input", {
            bubbles: true,
            cancelable: true,
            data: String(text),
            inputType: "insertText"
          }));
        } catch (_) {
          target.dispatchEvent(new win.Event("input", { bubbles: true, cancelable: true }));
        }
        target.dispatchEvent(new win.Event("change", { bubbles: true, cancelable: true }));
        return true;
      }

      function triggerEnter(target, win) {
        if (!target) return false;
        try {
          if (typeof target.focus === "function") target.focus();
        } catch (_) {}

        const wrappedWin = win?.wrappedJSObject || win;
        const KeyboardEventCtor = wrappedWin?.KeyboardEvent || win?.KeyboardEvent || globalThis.KeyboardEvent;

        const eventInit = {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          charCode: 13,
          bubbles: true,
          cancelable: true,
          composed: true,
          shiftKey: false,
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          view: wrappedWin || win
        };

        try {
          const kd = new KeyboardEventCtor("keydown", eventInit);
          try { Object.defineProperty(kd, "keyCode", { get: () => 13 }); } catch (_) {}
          try { Object.defineProperty(kd, "which", { get: () => 13 }); } catch (_) {}
          target.dispatchEvent(kd);

          const kp = new KeyboardEventCtor("keypress", eventInit);
          try { Object.defineProperty(kp, "keyCode", { get: () => 13 }); } catch (_) {}
          try { Object.defineProperty(kp, "which", { get: () => 13 }); } catch (_) {}
          try { Object.defineProperty(kp, "charCode", { get: () => 13 }); } catch (_) {}
          target.dispatchEvent(kp);

          const ku = new KeyboardEventCtor("keyup", eventInit);
          try { Object.defineProperty(ku, "keyCode", { get: () => 13 }); } catch (_) {}
          try { Object.defineProperty(ku, "which", { get: () => 13 }); } catch (_) {}
          target.dispatchEvent(ku);
          return true;
        } catch (_) {
          return false;
        }
      }

      function findSendButton(doc, input, customSelectors) {
        if (!doc) return null;
        const selectors = customSelectors || [
          "div[role='button'].ds-button--circle:not(.ds-button--disabled):not([aria-disabled='true'])",
          "button.ds-button--circle:not(.ds-button--disabled):not([aria-disabled='true'])",
          ".ds-button--circle:not(.ds-button--disabled):not([aria-disabled='true'])",
          "div[role='button'][aria-label*='发送']",
          "button[aria-label*='发送']",
          "[aria-label*='发送']:not([aria-disabled='true'])",
          "div[role='button'][aria-label*='Send']",
          "button[aria-label*='Send']",
          "[aria-label*='Send']:not([aria-disabled='true'])",
          "button[type='submit']:not(:disabled)",
          ".chat-input-send-button"
        ];
        const isExcluded = (el) => {
          if (!el || el.disabled || el.getAttribute("aria-disabled") === "true") return true;
          const label = (el.getAttribute("aria-label") || el.title || el.textContent || "").toLowerCase();
          if (label.includes("停止") || label.includes("stop") || label.includes("暂停")) return true;
          if (label.includes("附件") || label.includes("attach") || label.includes("上传") || label.includes("upload")) return true;
          if (label.includes("搜索") || label.includes("search") || label.includes("联网") || label.includes("web")) return true;
          if (label.includes("思考") || label.includes("think") || label.includes("reason")) return true;
          return false;
        };

        for (const sel of selectors) {
          try {
            const candidates = doc.querySelectorAll(sel);
            for (const el of candidates) {
              if (!isExcluded(el)) return el;
            }
          } catch (_) {}
        }

        if (input) {
          try {
            const container = input.closest("form")
              || input.closest("[class*='input-container']")
              || input.closest("[class*='chat-input']")
              || input.parentElement?.parentElement;
            if (container) {
              const btns = Array.from(container.querySelectorAll("div[role='button'], button"));
              for (let i = btns.length - 1; i >= 0; i--) {
                const b = btns[i];
                if (!isExcluded(b)) return b;
              }
            }
          } catch (_) {}
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
          installStreamCapture();
        } catch (_) {}

        try {
          if (action === "check-ready") {
            const href = String(win?.location?.href || "");
            const isAuth = href.includes("/sign_in") || href.includes("/auth") || href.includes("/login");
            const input = findElement(doc, payload.chatInputSelectors || ["#chat-input", "textarea"]);
            const loginEl = findElement(doc, payload.loginSelectors || ["input[type='tel']", "a[href*='login']", "button:has-text('登录')"]);
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
              "div[role='button']:has-text('新对话')"
            ]);
            if (btn) {
              btn.click();
              sendAsyncMessage("litmtrans:deepseek:response", { id, result: { ok: true } });
            } else {
              win.location.href = "https://chat.deepseek.com/";
              sendAsyncMessage("litmtrans:deepseek:response", { id, result: { ok: true, reloaded: true } });
            }
          } else if (action === "submit") {
            const wrappedWin = win?.wrappedJSObject || win;
            if (wrappedWin) {
              wrappedWin.__activeStreamId = payload.streamId || 0;
              wrappedWin.__wcStream = { text: '', done: false, started: false, status: 0, error: '' };
            }

            const input = findElement(doc, payload.chatInputSelectors || ["#chat-input", "textarea"]);
            if (!input) {
              sendAsyncMessage("litmtrans:deepseek:response", { id, error: "未找到输入框" });
              return;
            }

            fillControlledInput(input, payload.text, wrappedWin);

            // 等待 React 状态机与组件受控输入同步更新
            await delay(180);

            // 1. 发送原生 Enter 键盘事件（这是用户提出的一键 Enter 核心交互）
            triggerEnter(input, wrappedWin);

            // 2. 双重保障：若尚未开始生成，通过发送按钮辅助触发
            await delay(120);

            const isStopBtn = () => {
              const stop = findElement(doc, payload.stopButtonSelectors || [
                "button[aria-label*='停止']",
                "div[role='button'][aria-label*='停止']",
                "button[aria-label*='Stop']"
              ]);
              return Boolean(stop);
            };

            if (!isStopBtn()) {
              const sendBtn = findSendButton(doc, input, payload.sendButtonSelectors);
              if (sendBtn) {
                try {
                  const MouseEventCtor = wrappedWin?.MouseEvent || win?.MouseEvent || globalThis.MouseEvent;
                  const mouseInit = { bubbles: true, cancelable: true, composed: true, view: wrappedWin || win };
                  sendBtn.dispatchEvent(new MouseEventCtor("mousedown", mouseInit));
                  sendBtn.dispatchEvent(new MouseEventCtor("mouseup", mouseInit));
                  sendBtn.click();
                } catch (_) {
                  try { sendBtn.click(); } catch (_) {}
                }
              }
            }

            sendAsyncMessage("litmtrans:deepseek:response", { id, result: { ok: true } });
          } else if (action === "stop") {
            const stopBtn = findElement(doc, payload.stopButtonSelectors || [
              "button[aria-label*='停止']",
              "div[role='button'][aria-label*='停止']",
              "button[aria-label*='Stop']"
            ]);
            if (stopBtn) {
              try { stopBtn.click(); } catch (_) {}
            }
            sendAsyncMessage("litmtrans:deepseek:response", { id, result: { ok: true } });
          } else if (action === "is-generating") {
            const stopBtn = findElement(doc, payload.stopButtonSelectors || [
              "button[aria-label*='停止']",
              "div[role='button'][aria-label*='停止']",
              "button[aria-label*='Stop']"
            ]);
            sendAsyncMessage("litmtrans:deepseek:response", { id, result: { generating: Boolean(stopBtn) } });
          } else if (action === "attach-images") {
            const fileInput = findElement(doc, payload.fileInputSelectors || ["input[type='file']"]);
            if (!fileInput) {
              sendAsyncMessage("litmtrans:deepseek:response", { id, error: "未在DeepSeek页面中找到图片上传控件" });
              return;
            }
            const wrappedWin = win?.wrappedJSObject || win;
            const DataTransferCtor = wrappedWin?.DataTransfer || globalThis.DataTransfer;
            const FileCtor = wrappedWin?.File || globalThis.File;
            if (!DataTransferCtor || !FileCtor) {
              sendAsyncMessage("litmtrans:deepseek:response", { id, error: "浏览器环境不支持构造上传文件" });
              return;
            }
            const dt = new DataTransferCtor();
            for (const item of (payload.files || [])) {
              const binaryStr = atob(item.base64);
              const len = binaryStr.length;
              const bytes = new Uint8Array(len);
              for (let i = 0; i < len; i++) bytes[i] = binaryStr.charCodeAt(i);
              const domFile = new FileCtor([bytes], item.name, { type: item.type || "image/jpeg" });
              dt.items.add(domFile);
            }
            fileInput.files = dt.files;
            fileInput.dispatchEvent(new win.Event("change", { bubbles: true }));
            sendAsyncMessage("litmtrans:deepseek:response", { id, result: { ok: true, count: payload.files.length } });
          } else if (action === "get-assistant-text") {
            const assistants = doc ? doc.querySelectorAll(payload.assistantSelectors?.join(",") || ".ds-markdown, .chat-message-assistant") : [];
            const last = assistants.length ? assistants[assistants.length - 1] : null;
            sendAsyncMessage("litmtrans:deepseek:response", {
              id,
              result: { text: (last?.textContent || "").trim() }
            });
          } else if (action === "session-action") {
            const subAction = payload.subAction;
            if (subAction === "list") {
              const found = [];
              const selectors = payload.sessionSelectors || ["[class*='session-item']", "nav a", "aside a"];
              for (const sel of selectors) {
                const items = doc ? doc.querySelectorAll(sel) : [];
                for (const item of items) {
                  const text = (item.textContent || "").trim().replace(/\\s+/g, " ");
                  if (text && text.length <= 80 && !/^(开启新对话|新对话|New chat|删除|重命名|清空|设置|登出)/i.test(text)) {
                    found.push({ title: text });
                  }
                }
                if (found.length) break;
              }
              sendAsyncMessage("litmtrans:deepseek:response", { id, result: { sessions: found } });
            } else if (subAction === "select") {
              const selectors = payload.sessionSelectors || ["[class*='session-item']", "nav a", "aside a"];
              let selected = false;
              for (const sel of selectors) {
                const items = doc ? doc.querySelectorAll(sel) : [];
                for (const item of items) {
                  const text = (item.textContent || "").trim();
                  if (text.includes(payload.title)) {
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
              const menuBtn = activeItem?.querySelector("[class*='more'], [class*='menu'], [aria-label*='更多'], [aria-label*='More'], svg");
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
              const menuBtn = activeItem?.querySelector("[class*='more'], [class*='menu'], [aria-label*='更多'], [aria-label*='More'], svg");
              if (menuBtn) menuBtn.click();
              await delay(300);
              const deleteOption = findElement(doc, ["div[role='menuitem']:has-text('删除')", "button:has-text('删除')"]);
              if (deleteOption) {
                deleteOption.click();
                await delay(300);
                const confirmBtn = findElement(doc, [
                  "button.ds-button--primary:has-text('删除')",
                  "button:has-text('确认')",
                  "button:has-text('确定')",
                  "button:has-text('Delete')"
                ]);
                if (confirmBtn) confirmBtn.click();
                sendAsyncMessage("litmtrans:deepseek:response", { id, result: { ok: true } });
              } else {
                sendAsyncMessage("litmtrans:deepseek:response", { id, result: { ok: false } });
              }
            }
          }
        } catch (err) {
          sendAsyncMessage("litmtrans:deepseek:response", { id, error: String(err?.message || err) });
        }
      };

      addMessageListener("litmtrans:deepseek:request", globalThis.__litmtransDeepSeekListener);
    })();
  `;

  class DeepSeekWebDriver {
    constructor(browser) {
      this.browser = browser;
      this.messageIdSeq = 0;
      this.pendingRequests = new Map();
      this.streamListeners = new Map();
      this.mmInitialized = false;
      this.setupMessageManager();
    }

    setupMessageManager() {
      const mm = this.browser?.messageManager;
      if (!mm || this.mmInitialized) return;
      this.mmInitialized = true;

      this.messageListener = {
        receiveMessage: (msg) => {
          const name = msg.name;
          const data = msg.data || {};
          if (name === "litmtrans:deepseek:response") {
            const resolver = this.pendingRequests.get(data.id);
            if (resolver) {
              this.pendingRequests.delete(data.id);
              if (data.error) {
                resolver.reject(new Error(data.error));
              } else {
                resolver.resolve(data.result);
              }
            }
          } else if (name === "litmtrans:deepseek:stream-chunk") {
            const listener = this.streamListeners.get(data.streamId);
            if (listener) {
              listener(data);
            }
          }
        }
      };

      try {
        mm.addMessageListener("litmtrans:deepseek:response", this.messageListener);
        mm.addMessageListener("litmtrans:deepseek:stream-chunk", this.messageListener);
      } catch (_) {}

      this.ensureFrameScript();
    }

    ensureFrameScript() {
      const mm = this.browser?.messageManager;
      if (!mm) return;
      try {
        const frameScriptURI = "data:application/javascript;charset=utf-8," + encodeURIComponent(FRAME_SCRIPT_SOURCE);
        mm.loadFrameScript(frameScriptURI, true);
      } catch (_) {}
    }

    sendToContent(action, payload = {}, timeoutMs = 15000) {
      const mm = this.browser?.messageManager;
      if (!mm) {
        return Promise.reject(new Error("浏览器消息管理器不可用"));
      }
      this.ensureFrameScript();
      const id = ++this.messageIdSeq;
      const setTimer = typeof setTimeout === "function" ? setTimeout : (fn, ms) => Zotero.setTimeout(fn, ms);
      const clearTimer = typeof clearTimeout === "function" ? clearTimeout : (t) => Zotero.clearTimeout(t);
      return new Promise((resolve, reject) => {
        const timer = setTimer(() => {
          this.pendingRequests.delete(id);
          reject(new Error(`DeepSeek网页通信超时 (${action})`));
        }, timeoutMs);
        this.pendingRequests.set(id, {
          resolve: (val) => { clearTimer(timer); resolve(val); },
          reject: (err) => { clearTimer(timer); reject(err); }
        });
        try {
          mm.sendAsyncMessage("litmtrans:deepseek:request", { id, action, payload });
        } catch (err) {
          clearTimer(timer);
          this.pendingRequests.delete(id);
          reject(err);
        }
      });
    }

    async ensureReady(timeoutMs = 30000, signal = null) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        U.throwIfAborted(signal);

        // 优先通过 Frame Script 跨进程探测真实 content DOM
        try {
          const res = await this.sendToContent("check-ready", {
            chatInputSelectors: SELECTORS.chatInput,
            loginSelectors: SELECTORS.loginIndicator
          }, 3000);
          if (res) {
            if (res.loggedIn === false || res.url.includes("/sign_in") || res.url.includes("/auth") || res.url.includes("/login")) {
              throw new Error("尚未登录 DeepSeek 官方网页端。请在右侧栏完成账号登录后重试。");
            }
            if (res.ready || res.hasInput) {
              return true;
            }
          }
        } catch (err) {
          if (String(err?.message || "").includes("尚未登录")) throw err;
        }

        // 同进程兜底探测（若环境允许直接读取 contentDocument）
        try {
          const doc = this.browser?.contentDocument;
          if (doc) {
            const href = String(this.browser?.contentWindow?.location?.href || "");
            if (href.includes("/sign_in") || href.includes("/auth") || href.includes("/login")) {
              throw new Error("尚未登录 DeepSeek 官方网页端。请在右侧栏完成账号登录后重试。");
            }
            for (const sel of SELECTORS.chatInput) {
              if (doc.querySelector(sel)) return true;
            }
          }
        } catch (err) {
          if (String(err?.message || "").includes("尚未登录")) throw err;
        }

        await U.sleep(250, signal);
      }

      throw new Error("DeepSeek输入框未就绪，网页加载超时，请检查网络并在右侧栏刷新网页。");
    }

    async isLoggedIn() {
      try {
        const res = await this.sendToContent("check-ready", {
          chatInputSelectors: SELECTORS.chatInput,
          loginSelectors: SELECTORS.loginIndicator
        }, 3000);
        return Boolean(res?.loggedIn);
      } catch (_) {
        return null;
      }
    }

    async createNewChat(signal = null) {
      await this.ensureReady(30000, signal);
      try {
        const res = await this.sendToContent("new-chat", {
          newChatSelectors: SELECTORS.newChatButton,
          chatInputSelectors: SELECTORS.chatInput
        }, 5000);
        await U.sleep(400, signal);
        return res?.ok !== false;
      } catch (_) {
        return false;
      }
    }

    async stop() {
      try {
        await this.sendToContent("stop", { stopButtonSelectors: SELECTORS.stopButton }, 3000);
      } catch (_) {}
    }

    async isGenerating() {
      try {
        const res = await this.sendToContent("is-generating", { stopButtonSelectors: SELECTORS.stopButton }, 2000);
        return Boolean(res?.generating);
      } catch (_) {
        return false;
      }
    }

    async attachImages(filePaths = [], signal = null) {
      if (!filePaths || !filePaths.length) return true;
      await this.ensureReady(10000, signal);

      const filesPayload = [];
      for (const filePath of filePaths) {
        U.throwIfAborted(signal);
        if (!await IOUtils.exists(filePath)) continue;
        const bytes = await IOUtils.read(filePath);
        const fileName = PathUtils.filename(filePath);
        const base64 = uint8ArrayToBase64(bytes);
        filesPayload.push({
          name: fileName,
          type: "image/jpeg",
          base64
        });
      }

      if (!filesPayload.length) return true;

      const res = await this.sendToContent("attach-images", {
        files: filesPayload,
        fileInputSelectors: SELECTORS.fileInput
      }, 15000);

      if (res?.error) throw new Error(res.error);
      await U.sleep(Math.min(3000, Math.max(1200, filesPayload.length * 200)), signal);
      return true;
    }

    async listSessions() {
      try {
        const res = await this.sendToContent("session-action", {
          subAction: "list",
          sessionSelectors: SELECTORS.sessionItem
        }, 5000);
        return res?.sessions || [];
      } catch (_) {
        return [];
      }
    }

    async selectSession(title) {
      try {
        const res = await this.sendToContent("session-action", {
          subAction: "select",
          title,
          sessionSelectors: SELECTORS.sessionItem
        }, 5000);
        await U.sleep(600);
        return Boolean(res?.ok);
      } catch (_) {
        return false;
      }
    }

    async renameCurrentSession(newTitle) {
      try {
        const res = await this.sendToContent("session-action", {
          subAction: "rename",
          newTitle
        }, 5000);
        await U.sleep(300);
        return Boolean(res?.ok);
      } catch (_) {
        return false;
      }
    }

    async deleteCurrentSession() {
      try {
        const res = await this.sendToContent("session-action", {
          subAction: "delete"
        }, 5000);
        await U.sleep(400);
        return Boolean(res?.ok);
      } catch (_) {
        return false;
      }
    }

    async submitMessage(text, options = {}) {
      const signal = options.signal || null;
      U.throwIfAborted(signal);

      await this.ensureReady(options.timeout || 30000, signal);

      const streamId = ++this.messageIdSeq;
      const dispatcher = LitMTrans.DeepSeekWeb.createStreamDispatcher({
        onText: options.onText,
        onReasoning: options.onReasoning,
        onUsage: options.onUsage
      });

      let isStreamFinished = false;
      let hasReceivedAnyStream = false;

      // 监听由 content process 发回的流式数据块
      const onStreamChunk = (data) => {
        if (data.error) {
          isStreamFinished = true;
          return;
        }
        if (data.delta) {
          hasReceivedAnyStream = true;
          dispatcher.feed(data.delta, false);
        }
        if (data.done) {
          isStreamFinished = true;
        }
      };
      this.streamListeners.set(streamId, onStreamChunk);

      try {
        // 向 content 发送填词与提交指令
        await this.sendToContent("submit", {
          streamId,
          text,
          chatInputSelectors: SELECTORS.chatInput,
          sendButtonSelectors: SELECTORS.sendButton
        }, 10000);

        const startTime = Date.now();
        const timeout = options.timeout || 300000;
        let idleCount = 0;
        let lastDOMText = "";

        while (true) {
          U.throwIfAborted(signal);

          if (isStreamFinished || dispatcher.isFinished()) {
            dispatcher.feed("", true);
            break;
          }

          // 若网络流正在传输，检测何时停止生成
          if (hasReceivedAnyStream) {
            const genRes = await this.sendToContent("is-generating", { stopButtonSelectors: SELECTORS.stopButton }, 2000).catch(() => null);
            if (genRes && !genRes.generating) {
              idleCount++;
              if (idleCount > 5) {
                dispatcher.feed("", true);
                break;
              }
            } else {
              idleCount = 0;
            }
          } else {
            // 网络流未拦截到时的 DOM 兜底抽取
            if (Date.now() - startTime > 2500) {
              const domRes = await this.sendToContent("get-assistant-text", { assistantSelectors: SELECTORS.assistantMessage }, 2000).catch(() => null);
              if (domRes && domRes.text) {
                if (domRes.text.length > lastDOMText.length) {
                  const delta = domRes.text.slice(lastDOMText.length);
                  dispatcher.feed(delta, false);
                  lastDOMText = domRes.text;
                }
              }
              const genRes = await this.sendToContent("is-generating", { stopButtonSelectors: SELECTORS.stopButton }, 2000).catch(() => null);
              if (genRes && !genRes.generating && lastDOMText.length > 0) {
                idleCount++;
                if (idleCount > 4) {
                  dispatcher.feed("", true);
                  break;
                }
              }
            }
          }

          if (Date.now() - startTime > timeout) {
            break;
          }

          await U.sleep(200, signal);
        }

        const finalResult = dispatcher.getResult();
        if (!finalResult.content && lastDOMText) {
          finalResult.content = lastDOMText;
          options.onText?.(lastDOMText);
        }
        return finalResult;
      } finally {
        this.streamListeners.delete(streamId);
      }
    }
  }

  LitMTrans.DeepSeekWeb.SELECTORS = SELECTORS;
  LitMTrans.DeepSeekWeb.DeepSeekWebDriver = DeepSeekWebDriver;
})(this);
