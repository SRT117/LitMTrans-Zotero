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

  const previousValue = String(target.value || target.textContent || "");

  if (target.isContentEditable) {
    try {
      target.textContent = text;
      target.dispatchEvent(new targetWin.InputEvent("input", {
        bubbles: true,
        cancelable: true,
        data: String(text),
        inputType: "insertText"
      }));
      return true;
    } catch (_) {}
  }

  // React 需要得知写入前的值，才能接收原生 setter 触发的 input 事件。
  try {
    const rawTarget = target.wrappedJSObject || target;
    if (rawTarget._valueTracker) {
      rawTarget._valueTracker.setValue(previousValue);
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

  const defaultSelectors = [
    "div[role='button'].ds-button--primary:not(.ds-button--disabled):not([aria-disabled='true'])",
    "button.ds-button--primary:not(.ds-button--disabled):not([aria-disabled='true'])",
    ".ds-button--primary:not(.ds-button--disabled):not([aria-disabled='true']):has(svg)",
    ".ds-button--filled.ds-button--circle:not(.ds-button--disabled):not([aria-disabled='true'])",
    ".ds-button[style*='34px']:has(svg):not(.ds-button--disabled):not([aria-disabled='true'])",
    "div[role='button']._52c986b:not(.ds-button--disabled):not([aria-disabled='true'])",
    "div[role='button'][aria-label*='发送']:not([aria-disabled='true'])",
    "button[aria-label*='发送']:not([aria-disabled='true'])",
    "div[role='button'][aria-label*='Send']:not([aria-disabled='true'])",
    "button[aria-label*='Send']:not([aria-disabled='true'])",
    "div[role='button'].ds-button--circle:not(.ds-button--disabled):not([aria-disabled='true'])",
    "button.ds-button--circle:not(.ds-button--disabled):not([aria-disabled='true'])",
    ".ds-button--circle:not(.ds-button--disabled):not([aria-disabled='true'])",
    ".chat-input-send-button"
  ];
  const selectors = Array.isArray(customSelectors) && customSelectors.length
    ? [...new Set([...customSelectors, ...defaultSelectors])]
    : defaultSelectors;

  const isExcluded = (el, root) => {
    if (!el || el.disabled || el.getAttribute("aria-disabled") === "true") return true;
    const className = String(el.className || "");
    if (className.includes("disabled") || className.includes("Tertiary")) return true;
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


function sessionRows(doc) {
  const rows = new Map();
  const currentURL = sessionURL(doc.location.href, doc);
  const currentID = currentSessionID(doc);
  const candidates = doc.querySelectorAll("a[href], [data-href], [data-url], [data-session-id], [data-conversation-id], [data-virtual-list-item-key], [data-key], [class*='session-item'], [class*='conversation-item'], [class*='chat-item']");
  for (const anchor of candidates) {
    const rawURL = anchor.getAttribute("href") || anchor.getAttribute("data-href")
      || anchor.getAttribute("data-url");
    const virtualKey = [
      anchor.getAttribute("data-virtual-list-item-key"),
      anchor.getAttribute("data-session-id"),
      anchor.getAttribute("data-conversation-id"),
      anchor.getAttribute("data-key"),
      anchor.id
    ].filter(Boolean).join(" ");
    const url = sessionURL(rawURL, doc)
      || (currentID && virtualKey.includes(currentID) ? currentURL : "")
      || (anchor.matches("[aria-current='page'], [aria-selected='true'], .active, [class*='active']")
        ? currentURL : "");
    if (!url) continue;
    const title = (anchor.getAttribute("title") || anchor.querySelector("[title]")?.getAttribute("title") || anchor.textContent || "").trim().replace(/\s+/g, " ");
    rows.set(url, { element: anchor, url, title });
  }
  return [...rows.values()];
}

function visible(element) {
  if (!element || element.getClientRects().length === 0) return false;
  const rect = element.getBoundingClientRect();
  const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
  if (style && (style.visibility === "hidden" || style.display === "none" || style.opacity === "0")) return false;
  // 必须真正落在屏幕可见范围内，防止误选屏幕外负坐标的隐藏/折叠控件
  return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0;
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
  let row = await waitFor(() => sessionRows(doc).find(row => row.url === targetURL && visible(row.element))?.element, 2000);
  if (!row || !visible(row)) {
    // 宽屏/窄屏自适应：若侧栏收起，寻找顶部左侧合法的侧栏/抽屉展开按钮
    let expand = findElement(doc, [
      "[aria-label*='展开']",
      "[aria-label*='打开侧边栏']",
      "[aria-label*='侧边栏']",
      "[aria-label*='历史']",
      "[class*='sidebar-toggle']",
      "[class*='collapse-btn']",
      "._4f3769f"
    ]);
    if (!expand || !visible(expand)) {
      const winWidth = win.innerWidth || doc.documentElement?.clientWidth || 350;
      const maxLeft = Math.min(Math.max(winWidth * 0.4, 96), 180);
      expand = Array.from(doc.querySelectorAll("button, [role='button'], .ds-button, div[tabindex]"))
        .filter(visible)
        .map(node => ({ node, rect: node.getBoundingClientRect() }))
        .filter(({ rect }) => rect.left >= 0 && rect.left <= maxLeft && rect.top >= 0 && rect.top <= 80 && rect.width > 0 && rect.height > 0)
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)[0]?.node || null;
    }
    if (expand) {
      expand.click();
      await delay(400);
    }
    row = await waitFor(() => sessionRows(doc).find(row => row.url === targetURL && visible(row.element))?.element, 4500);
  }
  if (!row) {
    // 新版 DeepSeek 使用虚拟列表且不暴露 href；当前 URL 对应的活动项仍可通过菜单按钮操作。
    const sessionID = currentSessionID(doc, targetURL);
    row = Array.from(doc.querySelectorAll("[data-virtual-list-item-key], [data-session-id], [data-conversation-id], [data-key], [aria-current='page'], [aria-selected='true'], [class*='session-item'][class*='active'], [class*='conversation-item'][class*='active'], [class*='chat-item'][class*='active']"))
      .find(node => {
        const key = [node.getAttribute("data-virtual-list-item-key"), node.getAttribute("data-session-id"), node.getAttribute("data-conversation-id"), node.getAttribute("data-key"), node.id].filter(Boolean).join(" ");
        return sessionID && key.includes(sessionID);
      })
      || doc.querySelector("[aria-current='page'], [aria-selected='true'], [class*='session-item'][class*='active'], [class*='conversation-item'][class*='active'], [class*='chat-item'][class*='active']");
  }
  if (!row) {
    const sidebarNodes = Array.from(doc.querySelectorAll("aside, nav, [role='navigation'], [data-virtual-list-item-key], [aria-current='page'], [aria-selected='true']"))
      .slice(0, 20)
      .map(node => {
        const text = (node.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
        const key = node.getAttribute("data-virtual-list-item-key") || node.getAttribute("data-key") || "";
        return `${node.tagName.toLowerCase()} class=${String(node.className || "").slice(0, 80)} key=${key} text=${text}`;
      });
    const controls = Array.from(doc.querySelectorAll("button, [role='button'], [aria-label], [title]"))
      .filter(visible)
      .slice(0, 30)
      .map(node => {
        const label = node.getAttribute("aria-label") || node.getAttribute("title") || (node.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
        const rect = node.getBoundingClientRect();
        const path = node.querySelector("svg path")?.getAttribute("d") || "";
        return `${node.tagName.toLowerCase()} class=${String(node.className || "").slice(0, 60)} at=${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)}x${Math.round(rect.height)} icon=${path.slice(0, 40)} label=${label}`;
      });
    throw new Error(`未找到当前会话的侧栏条目（侧栏摘要：${sidebarNodes.join(" | ") || "无可见候选"}；可见控件：${controls.join(" | ") || "无"}）`);
  }
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
  return row;
}

export class LitMTransDeepSeekChild extends JSWindowActorChild {
  // contextmenu 由 registerWindowActor 的 events 配置派发到 handleEvent，
  // 不再重复手动监听，避免同一 frame 双路触发。
  handleEvent(event) {
    if (event.type !== "contextmenu") return;
    try {
      const win = this.contentWindow;
      const selectedText = String(win?.getSelection?.()?.toString?.() || "").trim();
      this.sendAsyncMessage("LitMTrans:DeepSeek:contextmenu", {
        screenX: Number(event.screenX || 0),
        screenY: Number(event.screenY || 0),
        clientX: Number(event.clientX || 0),
        clientY: Number(event.clientY || 0),
        selectedText
      });
      event.preventDefault();
      event.stopPropagation();
    } catch (err) {
      try { dump(`[LitMTrans:DeepSeekChild] contextmenu report error: ${err?.message || err}\n`); } catch (_) {}
    }
  }

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

    if (action === "append-draft") {
      const input = findElement(doc, payload.chatInputSelectors || ["#chat-input", "textarea"]);
      if (!input) throw new Error("未找到DeepSeek输入框，请先登录网页。");
      const text = String(payload.text || "");
      const current = String(input.value ?? input.textContent ?? "");
      const draft = `${current}${current ? "\n\n" : ""}${text}\n\n`;
      if (text) {
        if (payload.paste) {
          simulatePaste(input, draft, win);
          await delay(100);
        }
        const observed = String(input.value ?? input.textContent ?? "");
        if (observed !== draft && !fillControlledInput(input, draft, win)) {
          throw new Error("无法写入DeepSeek输入框。");
        }
      }
      input.focus();
      return { ok: true };
    }

    if (action === "new-chat") {
      const href = String(doc?.location?.href || "");
      const input = findElement(doc, payload.chatInputSelectors || ["#chat-input", "textarea"]);
      const isFreshRoot = href === "https://chat.deepseek.com/" || href === "https://chat.deepseek.com" || href.endsWith("/chat");
      if (isFreshRoot && !input?.value?.trim()) {
        return { ok: true, skipped: true };
      }
      const btn = findElement(doc, payload.newChatSelectors || [
        "div[tabindex]:has-text('开启新对话')",
        "button:has-text('新对话')",
        "button:has-text('开启新对话')",
        "button:has-text('New chat')",
        "div[role='button']:has-text('新对话')",
        "div[role='button']:has-text('开启新对话')",
        "div[tabindex]:has-text('新对话')",
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

      if (!attached) throw new Error("无法将附件添加到DeepSeek网页，请稍后重试。");
      return { ok: true, count: payload.files.length };
    }

    if (action === "wait-attachments-ready") {
      const timeout = Math.max(1000, Number(payload.timeout) || 15000);
      const expectedCount = Number(payload.expectedCount) || 0;
      const start = Date.now();
      let attachmentObserved = false;
      let uploading = false;
      let attachmentCount = 0;
      while (Date.now() - start < timeout) {
        const input = findElement(doc, payload.chatInputSelectors || ["#chat-input", "textarea"]);
        const composer = (input && (
          input.closest?.("form, [class*='chat-input'], [class*='composer'], [class*='input-box'], [class*='bottom']")
          || input.parentElement?.parentElement
        )) || null;

        // 顶层外壳（Shell）：DeepSeek 外壳通常包含卡片插槽（Child 0）与输入区（Child 1）
        const shell = composer?.parentElement || composer;

        const hasUploading = Boolean(
          (shell || composer || doc)?.querySelector?.("[class*='loading'], [class*='spin'], [aria-busy='true'], .ds-loading")
        );
        uploading = hasUploading;
        if (hasUploading) attachmentObserved = true;

        // 在外壳与输入区范围内查找已渲染的图片、缩略图或文档卡片
        const searchScope = shell || composer;
        let thumbsCount = 0;
        if (searchScope) {
          const cardItems = searchScope.querySelectorAll("img, [class*='thumb'], [class*='file-item'], [class*='attachment'], [class*='_967f3f9'], [class*='b40079d7'] > div");
          thumbsCount = cardItems.length;
          if (thumbsCount === 0) {
            const fallbackCards = Array.from(searchScope.querySelectorAll("div")).filter(el => {
              if (el.contains(input) || el === composer || el === shell) return false;
              const text = el.textContent || "";
              return text.length > 0 && text.length < 120 && /\.(?:md|txt|pdf|docx?|xlsx?|pptx?|png|jpe?g|webp)/i.test(text);
            });
            thumbsCount = fallbackCards.length;
          }
        }
        attachmentCount = Math.max(attachmentCount, thumbsCount);
        if (attachmentCount > 0) attachmentObserved = true;

        const hasInputText = Boolean(input && (String(input.value || input.textContent || "").trim().length > 0));
        const sendBtn = findSendButton(doc, input, payload.sendButtonSelectors);

        // 条件 1：输入框原本无文字时，发送按钮被上传完备的附件点亮激活，且无上传加载动画
        // 这是 DeepSeek 官方对于附件全部就绪最直接的权威信号
        if (!hasInputText && sendBtn && !hasUploading) {
          return { ready: true, attachmentObserved: true, attachmentCount: Math.max(attachmentCount, 1) };
        }

        // 条件 2：输入区/卡片槽中附件卡片已渲染，且无上传加载动画
        if (!hasUploading && attachmentCount > 0 && (expectedCount <= 0 || attachmentCount >= expectedCount)) {
          return { ready: true, attachmentObserved: true, attachmentCount };
        }

        await delay(100);
      }
      return { ready: false, attachmentObserved, uploading, attachmentCount };
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
        if (subAction === "rename" && sessionRows(doc).some(row =>
            row.url === sessionURL(payload.expectedURL, doc) && row.title === payload.newTitle)) return { ok: true };
        const menuRow = await openSessionMenu(doc, win, payload.expectedURL);
        if (subAction === "rename") {
          const option = await waitFor(() => labeledControl(doc, ["重命名", "Rename"]));
          if (!option) throw new Error("未找到重命名菜单项");
          option.click();
          const input = await waitFor(() => {
            const dialog = doc.querySelector(DIALOG_SELECTOR);
            const currentRow = sessionRows(doc).find(row => row.url === sessionURL(payload.expectedURL, doc))?.element;
            const scopes = [dialog, currentRow, menuRow, menuRow?.parentElement, menuRow?.parentElement?.parentElement]
              .filter(Boolean);
            for (const scope of scopes) {
              const found = Array.from(scope.querySelectorAll("input:not([type='file']), textarea, [role='textbox'], [contenteditable='true']"))
                .find(node => visible(node) && node.id !== "chat-input");
              if (found) return found;
            }
            return Array.from(doc.querySelectorAll("input:not([type='file']), textarea, [role='textbox'], [contenteditable='true']"))
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
            return dialog && labeledControl(dialog, ["删除", "删除该对话", "确认", "确定", "Delete", "Confirm"]);
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
