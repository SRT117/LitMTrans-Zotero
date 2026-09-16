import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const delay = (ms) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms || 0)));

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
  const targetWin = target.ownerDocument?.defaultView || win;
  try {
    if (typeof target.focus === "function") target.focus();
  } catch (_) {}

  // 1. 重置 React 内部 tracker 缓存
  try {
    const rawTarget = target.wrappedJSObject || target;
    if (rawTarget._valueTracker) {
      rawTarget._valueTracker.setValue("");
    }
  } catch (_) {}

  // 2. 原生 setter 写入
  let valueSet = false;
  try {
    const proto = (targetWin && target instanceof targetWin.HTMLTextAreaElement)
      ? targetWin.HTMLTextAreaElement.prototype
      : (targetWin && target instanceof targetWin.HTMLInputElement)
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

  // 3. 派发 input 与 change 事件
  try {
    const InputEventCtor = targetWin?.InputEvent || targetWin?.Event;
    if (InputEventCtor) {
      target.dispatchEvent(new InputEventCtor("input", {
        bubbles: true,
        cancelable: true,
        data: String(text),
        inputType: "insertText"
      }));
    }
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
  const targetWin = target.ownerDocument?.defaultView || win;
  try {
    if (typeof target.focus === "function") target.focus();
  } catch (_) {}

  try {
    const rawWin = targetWin?.wrappedJSObject || targetWin;
    const DataTransferCtor = rawWin?.DataTransfer || targetWin?.DataTransfer;
    const ClipboardEventCtor = rawWin?.ClipboardEvent || targetWin?.ClipboardEvent;

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
  const targetWin = target.ownerDocument?.defaultView || win;
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
    const KeyboardEventCtor = targetWin?.KeyboardEvent;
    if (KeyboardEventCtor) {
      target.dispatchEvent(new KeyboardEventCtor("keydown", eventInit));
      target.dispatchEvent(new KeyboardEventCtor("keypress", eventInit));
      target.dispatchEvent(new KeyboardEventCtor("keyup", eventInit));
      return true;
    }
  } catch (_) {}

  try {
    const rawWin = targetWin?.wrappedJSObject || targetWin;
    const RawKeyboardEvent = rawWin?.KeyboardEvent;
    const rawTarget = target.wrappedJSObject || target;
    if (RawKeyboardEvent && rawTarget) {
      rawTarget.dispatchEvent(new RawKeyboardEvent("keydown", eventInit));
      rawTarget.dispatchEvent(new RawKeyboardEvent("keypress", eventInit));
      rawTarget.dispatchEvent(new RawKeyboardEvent("keyup", eventInit));
      return true;
    }
  } catch (_) {}

  return false;
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


const THINK_SELECTOR = ".ds-think-content, .ds-think, [class*='thinking'], [class*='reasoning'], .ds-markdown--think";
const DIALOG_SELECTOR = "[role='dialog'], [role='alertdialog'], .ds-modal, .ds-modal-content, .ds-dialog";

function domToMarkdown(root, isReasoning = false) {
  if (!root) return "";
  if (!isReasoning && root.closest?.(THINK_SELECTOR)) return "";

  const clone = root.cloneNode(true);
  if (!isReasoning) {
    for (const junk of clone.querySelectorAll(THINK_SELECTOR)) junk.remove();
  }
  for (const junk of clone.querySelectorAll("button, svg, [class*='copy'], [class*='action'], [class*='feedback'], .ds-markdown-code-copy-button, script, style")) {
    junk.remove();
  }

  function walk(node, parentTag = "") {
    if (!node) return "";
    if (node.nodeType === 3 /* Node.TEXT_NODE */) {
      return node.nodeValue || "";
    }
    if (node.nodeType !== 1 /* Node.ELEMENT_NODE */) {
      return "";
    }

    const tag = (node.tagName || "").toLowerCase();
    const cls = String(node.className || "");

    // KaTeX 数学公式优先提取
    if (cls.includes("katex") || tag === "math") {
      const isDisplay = cls.includes("katex-display") || parentTag === "div";
      let tex = "";
      const annotation = node.querySelector?.("annotation[encoding*='tex'], annotation");
      if (annotation) {
        tex = (annotation.textContent || "").trim();
      }
      if (!tex) {
        tex = (node.textContent || "").trim();
      }
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

function replySnapshot(doc) {
  const items = Array.from(doc.querySelectorAll("[data-virtual-list-item-key]"));
  const replies = items.filter(item => item.querySelector(".ds-assistant-message-main-content, " + THINK_SELECTOR));
  const item = replies.at(-1);
  const bodies = item
    ? Array.from(item.querySelectorAll(".ds-assistant-message-main-content"))
    : Array.from(doc.querySelectorAll(".ds-assistant-message-main-content, [data-role='assistant'], .chat-message-assistant"));
  const body = bodies.at(-1);
  const scope = item || body;
  const think = scope?.matches(THINK_SELECTOR) ? scope : scope?.querySelector(THINK_SELECTOR);

  // 思考区和正文是兄弟节点；没有明确的正文容器时不把任意 markdown 当作回答。
  return {
    text: domToMarkdown(body, false),
    reasoning: domToMarkdown(think, true),
    count: item ? replies.length : bodies.length,
    messageKey: item?.getAttribute("data-virtual-list-item-key") || "",
    url: doc.location.href
  };
}

function sessionURL(value, doc) {
  try {
    const url = new doc.defaultView.URL(value, doc.location.href);
    if (url.origin !== doc.location.origin || !/\/(?:a\/)?chat\/(?:s\/)?[^/]+\/?$/.test(url.pathname)) return "";
    return url.origin + url.pathname.replace(/\/$/, "");
  } catch (_) { return ""; }
}

function currentSessionID(doc, fallbackURL = "") {
  const target = String(fallbackURL || doc?.location?.href || "");
  const match = target.match(/\/(?:a\/)?chat\/(?:s\/)?([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

async function sessionAPI(doc, action, payload = {}) {
  const sessionID = currentSessionID(doc, payload?.expectedURL);
  if (!sessionID) throw new Error("当前页面还没有 DeepSeek 会话 ID");
  const endpoint = action === "rename" ? "/api/v0/chat_session/update_title" : "/api/v0/chat_session/delete";
  const body = action === "rename"
    ? { chat_session_id: sessionID, title: String(payload.newTitle || "").trim() }
    : { chat_session_id: sessionID };
  if (action === "rename" && !body.title) throw new Error("会话标题不能为空");
  const pageWindow = doc.defaultView?.wrappedJSObject || doc.defaultView;

  let token = "";
  try {
    const ls = pageWindow.localStorage;
    if (ls) {
      for (const key of ["userToken", "token", "auth_token", "user_token"]) {
        const raw = ls.getItem(key);
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            token = parsed?.value || parsed?.token || (typeof parsed === "string" ? parsed : "");
          } catch (_) {
            token = raw;
          }
          if (token) break;
        }
      }
    }
  } catch (_) {}

  const headers = { "content-type": "application/json" };
  if (token) {
    headers["authorization"] = "Bearer " + token;
  }

  const response = await pageWindow.fetch(endpoint, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify(body)
  });
  let result = null;
  try { result = await response.json(); } catch (_) {}
  if (!response.ok || (result && result.code && result.code !== 0)) {
    throw new Error(`DeepSeek会话${action === "rename" ? "重命名" : "删除"}接口失败（HTTP ${response.status}${result?.msg ? `: ${result.msg}` : ""}）`);
  }
  if (action === "rename") {
    try {
      const targetURL = sessionURL(payload?.expectedURL, doc);
      const row = sessionRows(doc).find(r => (targetURL && r.url === targetURL) || (sessionID && r.url.endsWith(sessionID)));
      if (row?.element) {
        row.element.setAttribute("title", payload.newTitle);
        const titleEl = row.element.querySelector("[title]") || row.element.querySelector("span, div") || row.element;
        if (titleEl) {
          titleEl.textContent = payload.newTitle;
          titleEl.setAttribute("title", payload.newTitle);
        }
      }
    } catch (_) {}
  }
  if (action === "delete") {
    try {
      const targetURL = sessionURL(payload?.expectedURL, doc);
      const row = sessionRows(doc).find(r => (targetURL && r.url === targetURL) || (sessionID && r.url.endsWith(sessionID)));
      if (row?.element) {
        const container = row.element.closest("[data-virtual-list-item-key], li, [class*='session-item'], [class*='conversation-item'], [class*='chat-item']") || row.element;
        container?.remove();
      }
      doc.defaultView?.history?.replaceState(null, "", "/");
    } catch (_) {}
  }
  return { ok: true, sessionID, result };
}

function sessionRows(doc) {
  const rows = new Map();
  const candidates = doc.querySelectorAll("a[href], [data-href], [data-url], [data-session-id], [data-conversation-id], [class*='session-item'], [class*='conversation-item'], [class*='chat-item']");
  for (const anchor of candidates) {
    const rawURL = anchor.getAttribute("href") || anchor.getAttribute("data-href")
      || anchor.getAttribute("data-url");
    const url = sessionURL(rawURL, doc)
      || (anchor.matches("[aria-current='page'], [aria-selected='true'], .active, [class*='active']")
        ? sessionURL(doc.location.href, doc) : "");
    if (!url) continue;
    const title = (anchor.getAttribute("title") || anchor.querySelector("[title]")?.getAttribute("title") || anchor.textContent || "").trim().replace(/\s+/g, " ");
    rows.set(url, { element: anchor, url, title });
  }
  return [...rows.values()];
}

function visible(element) {
  return element && element.getClientRects().length > 0;
}

function labeledControl(root, labels) {
  const nodes = Array.from(root.querySelectorAll("[role='menuitem'], .ds-dropdown-menu-option, button, [role='button'], div, span"));
  return nodes.find(node => visible(node) && labels.includes((node.textContent || "").trim())
    && !Array.from(node.children).some(child => labels.includes((child.textContent || "").trim())));
}

async function waitFor(find, timeout = 2500) {
  const end = Date.now() + timeout;
  do {
    const value = find();
    if (value) return value;
    await delay(100);
  } while (Date.now() < end);
  return null;
}

async function openSessionMenu(doc, win, expectedURL) {
  const targetURL = sessionURL(expectedURL, doc);
  if (!targetURL || sessionURL(doc.location.href, doc) !== targetURL) throw new Error("当前网页已切换会话，未执行会话操作");
  let row = await waitFor(() => sessionRows(doc).find(row => row.url === targetURL)?.element, 1500);
  if (!row || !visible(row)) {
    const expand = findElement(doc, ["[aria-label*='展开']", "[aria-label*='打开侧边栏']", "[class*='sidebar-toggle']", "[class*='collapse-btn']"]);
    expand?.click();
    row = await waitFor(() => sessionRows(doc).find(row => row.url === targetURL && visible(row.element))?.element);
  }
  if (!row) {
    // 新版 DeepSeek 使用虚拟列表且不暴露 href；当前 URL 对应的活动项仍可通过菜单按钮操作。
    row = doc.querySelector("[aria-current='page'], [aria-selected='true'], [class*='session-item'][class*='active'], [class*='conversation-item'][class*='active'], [class*='chat-item'][class*='active']");
  }
  if (!row) throw new Error("未找到当前会话的侧栏条目");
  row.scrollIntoView({ block: "nearest" });
  row.dispatchEvent(new win.MouseEvent("mouseenter", { bubbles: true }));
  row.dispatchEvent(new win.MouseEvent("mouseover", { bubbles: true }));
  await delay(150);
  let container = row;
  let menu;
  // 菜单按钮可能是链接的兄弟节点，但不能越过包含其他会话的列表。
  for (let level = 0; container && level < 3; level++, container = container.parentElement) {
    if (Array.from(container.querySelectorAll("a[href]")).some(a => {
      const url = sessionURL(a.getAttribute("href"), doc);
      return url && url !== targetURL;
    })) break;
    menu = Array.from(container.querySelectorAll("[aria-haspopup='menu'], [aria-label*='更多'], [aria-label*='More'], [class*='more'], [class*='menu'], button, [role='button']"))
      .find(node => visible(node) && node !== row && (node.querySelector("svg") || node.hasAttribute("aria-haspopup")));
    if (menu) break;
  }
  if (!menu) throw new Error("未找到当前会话的菜单按钮");
  menu.click();
}

export class LitMTransDeepSeekChild extends JSWindowActorChild {
  didDestroy() {}

  async receiveMessage(message) {
    if (message.name !== "LitMTrans:DeepSeek:execute") {
      return null;
    }
    const { action, payload = {} } = message.data || {};
    const win = this.contentWindow;
    const doc = this.document;

    if (action === "read-stream") {
      return { started: false };
    }

    if (action === "ping") {
      return {
        ok: true,
        url: doc?.location?.href || "",
        readyState: doc?.readyState || "",
        hasDocument: !!doc,
        hasWindow: !!win,
      };
    }

    if (action === "check-ready") {
      const href = String(doc?.location?.href || "");
      const isAuth = href.includes("/sign_in") || href.includes("/auth") || href.includes("/login");
      const input = findElement(doc, payload.chatInputSelectors || ["#chat-input", "textarea"]);
      const loginEl = findElement(doc, payload.loginSelectors || ["input[type='tel']", "a[href*='login']", "button:has-text('登录')"]);
      return {
        ready: Boolean(input && !isAuth),
        loggedIn: !isAuth && (!loginEl || Boolean(input)),
        url: href,
        hasInput: Boolean(input)
      };
    }

    if (action === "new-chat") {
      const href = String(doc?.location?.href || "");
      const input = findElement(doc, payload.chatInputSelectors || ["#chat-input", "textarea"]);
      const isFreshRoot = href === "https://chat.deepseek.com/" || href === "https://chat.deepseek.com" || href.endsWith("/chat");
      if (isFreshRoot && !input?.value?.trim()) {
        return { ok: true, skipped: true };
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
        return { ok: true };
      } else {
        try {
          if (doc?.location && !isFreshRoot) {
            doc.location.href = "https://chat.deepseek.com/";
            return { ok: true, navigated: true };
          }
        } catch (_) {}
        return { ok: Boolean(input), reused: true };
      }
    }

    if (action === "submit") {
      const input = findElement(doc, payload.chatInputSelectors || ["#chat-input", "textarea"]);
      if (!input) {
        throw new Error("未找到输入框");
      }

      simulatePaste(input, payload.text, win);
      await delay(100);
      if (!input.value || input.value !== payload.text) {
        fillControlledInput(input, payload.text, win);
      }

      let sendBtn = null;
      const waitStart = Date.now();
      while (Date.now() - waitStart < 5000) {
        sendBtn = findSendButton(doc, input, payload.sendButtonSelectors);
        if (sendBtn) break;
        await delay(150);
      }

      if (sendBtn) {
        try {
          dump(`[LitMTrans-Actor] submit: 找到发送按钮 (${sendBtn.tagName}, class=${sendBtn.className})，派发组合点击\n`);
        } catch (_) {}
        triggerClick(sendBtn, win);
      } else {
        try {
          dump("[LitMTrans-Actor] submit: 未找到已解除禁用的发送按钮，直接触发 Enter\n");
        } catch (_) {}
        triggerEnter(input, win);
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
          dump("[LitMTrans-Actor] submit: 点击后输入框未清空且未开始生成，立即执行 Enter 兜底发送\n");
        } catch (_) {}
        triggerEnter(input, win);
      }

      return { ok: true };
    }

    if (action === "stop") {
      const stopBtn = findElement(doc, payload.stopButtonSelectors || [
        "button[aria-label*='停止']",
        "div[role='button'][aria-label*='停止']",
        "button[aria-label*='Stop']",
        "div[role='button'][aria-label*='Stop']",
        "button:has(svg rect)",
        "div[role='button']:has(svg rect)",
        ".chat-input-stop-button"
      ]);
      if (stopBtn) {
        try { stopBtn.click(); } catch (_) {}
        return { ok: true };
      }
      return { ok: false };
    }

    if (action === "is-generating") {
      const stopBtn = findElement(doc, payload.stopButtonSelectors || [
        "button[aria-label*='停止']",
        "div[role='button'][aria-label*='停止']",
        "button[aria-label*='Stop']",
        "div[role='button'][aria-label*='Stop']",
        "button:has(svg rect)",
        "div[role='button']:has(svg rect)",
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
      return { generating: Boolean(stopBtn), canContinue: Boolean(continueBtn) };
    }

    if (action === "click-continue") {
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
        return { ok: true, clicked: true };
      }
      return { ok: false, clicked: false };
    }

    if (action === "attach-files" || action === "attach-images") {
      const fileInput = findElement(doc, payload.fileInputSelectors || ["input[type='file']"]);
      const chatInput = findElement(doc, payload.chatInputSelectors || ["#chat-input", "textarea"]);
      if (!fileInput && !chatInput) {
        throw new Error("未在DeepSeek页面中找到文件上传控件或输入框");
      }
      const DataTransferCtor = win?.DataTransfer || globalThis.DataTransfer;
      const FileCtor = win?.File || globalThis.File;
      if (!DataTransferCtor || !FileCtor) {
        throw new Error("浏览器环境不支持构造上传文件");
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

      return { ok: true, count: payload.files.length };
    }

    if (action === "wait-attachments-ready") {
      const timeout = Math.max(500, Number(payload.timeout) || 5000);
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const input = findElement(doc, payload.chatInputSelectors || ["#chat-input", "textarea"]);
        const sendBtn = findSendButton(doc, input, payload.sendButtonSelectors);
        // DeepSeek 在附件仍在后台处理时禁用发送。按钮恢复可用即表示
        // 当前附件已可随下一条消息提交，无需等待页面其他区域的加载动画。
        if (sendBtn) return { ready: true };
        await delay(100);
      }
      return { ready: false };
    }

    if (action === "get-assistant-text") return replySnapshot(doc);

    if (action === "session-action") {
      try {
        const subAction = payload.subAction;
        if (subAction === "list") {
          return { sessions: sessionRows(doc).map(({ url, title }) => ({ url, title })) };
        }
      if (subAction === "select") {
          const row = sessionRows(doc).find(row => payload.url
            ? row.url === sessionURL(payload.url, doc)
            : row.title === payload.title);
          if (!row) return { ok: false };
          row.element.click();
          const selected = await waitFor(() => sessionURL(doc.location.href, doc) === row.url);
        return { ok: Boolean(selected), url: row.url };
      }
      if (subAction === "rename" || subAction === "delete") {
        try {
          return await sessionAPI(doc, subAction, payload);
        } catch (apiError) {
          // 接口是首选；网页版本变化或离线时再退回 DOM 菜单操作。
          if (subAction === "rename" && !payload.expectedURL) throw apiError;
        }
      }
      if (subAction === "rename" && sessionRows(doc).some(row =>
          row.url === sessionURL(payload.expectedURL, doc) && row.title === payload.newTitle)) return { ok: true };
        await openSessionMenu(doc, win, payload.expectedURL);
        if (subAction === "rename") {
          const option = await waitFor(() => labeledControl(doc, ["重命名", "Rename"]));
          if (!option) throw new Error("未找到重命名菜单项");
          option.click();
          const input = await waitFor(() => {
            const dialog = doc.querySelector(DIALOG_SELECTOR);
            const row = sessionRows(doc).find(row => row.url === sessionURL(payload.expectedURL, doc))?.element;
            const scope = dialog || row?.parentElement;
            return scope && Array.from(scope.querySelectorAll("input:not([type='file']), textarea"))
              .find(node => visible(node) && node.id !== "chat-input");
          });
          if (!input) throw new Error("未找到会话名称输入框");
          fillControlledInput(input, payload.newTitle, win);
          const dialog = input.closest(DIALOG_SELECTOR);
          const save = dialog && labeledControl(dialog, ["保存", "确认", "确定", "Save", "Confirm"]);
          if (save) {
            save.click();
          } else {
            const rowScope = input.closest("[class*='item'], li, [class*='session']") || input.parentElement;
            const actionButtons = rowScope ? Array.from(rowScope.querySelectorAll("button, [role='button']")).filter(b => visible(b) && b !== input) : [];
            const confirmBtn = actionButtons.find(b => b.querySelector("svg, [class*='check'], [class*='ok']") || /确认|确定|Save|Confirm|OK/i.test(b.textContent || b.getAttribute("aria-label") || ""));
            if (confirmBtn) {
              confirmBtn.click();
            } else {
              triggerEnter(input, win);
              try { input.dispatchEvent(new (win.FocusEvent || win.Event)("blur", { bubbles: true })); } catch (_) {}
              try { input.blur(); } catch (_) {}
            }
          }
          const updated = await waitFor(() => {
            if (sessionRows(doc).some(row => row.url === sessionURL(payload.expectedURL, doc) && row.title === payload.newTitle)) return true;
            if (!visible(input)) {
              const row = sessionRows(doc).find(r => r.url === sessionURL(payload.expectedURL, doc));
              if (row && (row.title.includes(payload.newTitle) || row.element?.textContent?.includes(payload.newTitle))) return true;
            }
            return false;
          }, 3000);
          if (!updated) {
            try {
              const rowScope = input.closest("[class*='item'], li, [class*='session']") || input.parentElement;
              const cancelBtn = rowScope ? Array.from(rowScope.querySelectorAll("button, [role='button']")).find(b =>
                visible(b) && (b.querySelector("svg, [class*='close'], [class*='cancel']") || /取消|Cancel|Close/i.test(b.textContent || b.getAttribute("aria-label") || ""))) : null;
              if (cancelBtn) cancelBtn.click();
              else {
                (doc.activeElement || input).dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
                input.blur();
                doc.body.click();
              }
            } catch (_) {}
            throw new Error("会话名称未更新");
          }
          return { ok: true };
        }
        if (subAction === "delete") {
          const option = await waitFor(() => labeledControl(doc, ["删除", "Delete"]));
          if (!option) throw new Error("未找到删除菜单项");
          option.click();
          const confirm = await waitFor(() => {
            const dialog = doc.querySelector(DIALOG_SELECTOR);
            return dialog && labeledControl(dialog, ["删除", "确认", "确定", "Delete", "Confirm"]);
          });
          if (!confirm) throw new Error("未找到删除确认按钮");
          confirm.click();
          const deleted = await waitFor(() => !sessionRows(doc).some(row =>
            row.url === sessionURL(payload.expectedURL, doc)));
          if (!deleted) throw new Error("会话仍在侧栏中，删除未完成");
          return { ok: true };
        }
      } catch (error) {
        (doc.activeElement || doc.body).dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
        throw error;
      }
    }

    throw new Error(`Unknown action: ${action}`);
  }
}
