(() => {
  "use strict";

  const host = globalThis;
  const LitMTrans = host.LitMTrans = host.LitMTrans || {};
  const MARKER = "<!-- litmtrans-mindmap -->";
  const MAX_NODES = 80;
  const MAX_DEPTH = 5;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const XHTML_NS = "http://www.w3.org/1999/xhtml";

  function node(label, depth) { return { label: String(label || "").replace(/\s+/g, " ").trim(), depth, children: [] }; }

  // The marker is separate from the Markdown outline so ordinary lists never
  // turn into a diagram unless the user explicitly requested one.
  function parseMarkdownMindmap(value) {
    const source = String(value || "").replace(/\r\n?/g, "\n");
    const markerAt = source.toLowerCase().indexOf(MARKER);
    if (markerAt < 0) return null;
    const outline = source.slice(markerAt + MARKER.length).trim();
    if (!outline) return null;
    const root = node("", 0), stack = [root];
    let count = 0;
    for (const rawLine of outline.split("\n")) {
      const line = rawLine.replace(/\t/g, "  ");
      const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      const list = line.match(/^(\s*)[-*+]\s+(.+)$/);
      if (!heading && !list) continue;
      // Lists sit beneath the preceding heading: H2 -> top-level bullet is
      // depth 3, and each two-space indent adds one further level.
      const depth = heading ? heading[1].length : Math.floor(list[1].length / 2) + 3;
      const label = heading ? heading[2] : list[2];
      if (!label || depth > MAX_DEPTH || count >= MAX_NODES) continue;
      const item = node(label.replace(/`([^`]+)`/g, "$1"), depth);
      while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
      stack[stack.length - 1].children.push(item); stack.push(item); count += 1;
    }
    if (!root.children.length) return null;
    const first = root.children[0];
    if (first.depth === 1) { root.label = first.label; root.children = first.children; }
    else root.label = "要点导图";
    return { root, markdown: outline, truncated: count >= MAX_NODES };
  }

  function escapeHTML(value) {
    return String(value || "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  }

  function mathHTML(label) {
    const katex = host.katex;
    const token = /\\\(([\s\S]*?)\\\)|\$([^$\n]+?)\$/g;
    let offset = 0, output = "", match;
    while ((match = token.exec(String(label || "")))) {
      output += escapeHTML(String(label).slice(offset, match.index));
      const tex = match[1] ?? match[2] ?? "";
      if (katex?.renderToString) {
        try { output += katex.renderToString(tex, { output: "mathml", throwOnError: false }); }
        catch (_) { output += escapeHTML(match[0]); }
      }
      else output += escapeHTML(match[0]);
      offset = match.index + match[0].length;
    }
    return output + escapeHTML(String(label || "").slice(offset));
  }

  function labelMetrics(label) {
    const source = String(label || "").replace(/\$[^$]+\$|\\\([^)]*\\\)/g, "公式");
    const units = [...source].reduce((sum, character) => sum + (/[^\x00-\xff]/.test(character) ? 1 : .56), 0);
    const width = Math.max(142, Math.min(252, Math.ceil(Math.min(units, 17) * 13 + 30)));
    const lines = Math.max(1, Math.min(4, Math.ceil(units / Math.max(8, (width - 30) / 13))));
    return { width, height: lines * 21 + 20 };
  }

  function color(name, fallback) {
    try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; }
    catch (_) { return fallback; }
  }

  function svgDataURL(svg) {
    const source = new XMLSerializer().serializeToString(svg);
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(source)))}`;
  }

  function createMindmapImage(map) {
    const nodes = [];
    const makeEntry = (item, depth, direction, parent = null) => {
      const entry = { item, depth, direction, parent, ...labelMetrics(item.label), x: 0, y: 0, children: [] };
      nodes.push(entry); return entry;
    };
    const descend = (item, depth, direction, parent) => {
      const entry = makeEntry(item, depth, direction, parent);
      entry.children = item.children.map(child => descend(child, depth + 1, direction, entry));
      return entry;
    };
    const root = makeEntry(map.root, 0, 0);
    const branches = map.root.children.map((child, index) => descend(child, 1, index % 2 ? 1 : -1, root));
    root.children = branches;
    const leafCount = entry => entry.children.length ? entry.children.reduce((sum, child) => sum + leafCount(child), 0) : 1;
    const left = branches.filter(item => item.direction < 0), right = branches.filter(item => item.direction > 0);
    const sideLeaves = side => side.reduce((sum, branch) => sum + leafCount(branch), 0);
    const leafGap = 86;
    const sideHeight = Math.max(sideLeaves(left), sideLeaves(right), 1) * leafGap;
    const centreY = Math.max(140, sideHeight / 2 + 38);
    const layoutSide = (side, direction) => {
      let leafIndex = 0;
      const place = entry => {
        entry.children.forEach(place);
        entry.y = entry.children.length
          ? entry.children.reduce((sum, child) => sum + child.y, 0) / entry.children.length
          : centreY - ((sideLeaves(side) - 1) * leafGap) / 2 + leafIndex++ * leafGap;
      };
      side.forEach(place);
      const placeX = entry => {
        if (!entry.parent) return;
        entry.x = direction > 0
          ? entry.parent.x + entry.parent.width + 62
          : entry.parent.x - entry.width - 62;
        entry.children.forEach(placeX);
      };
      side.forEach(placeX);
    };
    root.x = 0; root.y = centreY;
    layoutSide(left, -1); layoutSide(right, 1);
    const minX = Math.min(...nodes.map(item => item.x)), maxX = Math.max(...nodes.map(item => item.x + item.width));
    const shift = 34 - minX;
    nodes.forEach(item => { item.x += shift; });
    const width = Math.max(520, maxX - minX + 68), height = Math.max(280, sideHeight + 76);
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("xmlns", SVG_NS); svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", String(width)); svg.setAttribute("height", String(height));
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    const create = name => document.createElementNS(SVG_NS, name);
    const background = create("rect");
    background.setAttribute("width", "100%"); background.setAttribute("height", "100%"); background.setAttribute("fill", color("--surface", "#ffffff")); svg.appendChild(background);
    for (const item of nodes) for (const child of item.children || []) {
      const path = create("path");
      const startX = child.direction < 0 ? item.x : item.x + item.width;
      const endX = child.direction < 0 ? child.x + child.width : child.x;
      const midX = startX + (endX - startX) / 2;
      path.setAttribute("fill", "none"); path.setAttribute("stroke", color("--line-strong", "#8b8b82")); path.setAttribute("stroke-width", "1.4");
      path.setAttribute("d", `M ${startX} ${item.y} C ${midX} ${item.y}, ${midX} ${child.y}, ${endX} ${child.y}`); svg.appendChild(path);
    }
    for (const item of nodes) {
      const rect = create("rect");
      rect.setAttribute("x", item.x); rect.setAttribute("y", item.y - item.height / 2); rect.setAttribute("width", item.width); rect.setAttribute("height", item.height); rect.setAttribute("rx", item.depth ? "2" : "3");
      rect.setAttribute("fill", item.depth === 0 ? color("--accent", "#171715") : item.depth === 1 ? color("--surface-3", "#ecece7") : color("--surface-2", "#fafaf8"));
      rect.setAttribute("stroke", item.depth === 0 ? color("--accent", "#171715") : color("--line-strong", "#8b8b82")); rect.setAttribute("stroke-width", "1"); svg.appendChild(rect);
      const foreign = create("foreignObject");
      foreign.setAttribute("x", item.x); foreign.setAttribute("y", item.y - item.height / 2); foreign.setAttribute("width", item.width); foreign.setAttribute("height", item.height);
      const label = document.createElementNS(XHTML_NS, "div");
      label.setAttribute("xmlns", XHTML_NS);
      label.setAttribute("style", `box-sizing:border-box;width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:4px 10px;color:${item.depth === 0 ? color("--accent-ink", "#ffffff") : color("--ink-2", "#41413d")};font: ${item.depth === 0 ? "700 " : "400 "}12px/1.35 Inter,Segoe UI,Microsoft YaHei UI,sans-serif;overflow:hidden;overflow-wrap:anywhere;word-break:break-word;text-align:center;`);
      label.innerHTML = mathHTML(item.item.label);
      foreign.appendChild(label); svg.appendChild(foreign);
    }
    return { name: "思维导图.svg", mimeType: "image/svg+xml", dataURL: svgDataURL(svg), width, height };
  }

  function renderMindmap(target, map, onOpen) {
    target.replaceChildren();
    const image = createMindmapImage(map);
    const button = document.createElement("button");
    button.type = "button"; button.className = "chat-mindmap-image"; button.title = "打开思维导图";
    const preview = document.createElement("img");
    preview.src = image.dataURL; preview.alt = `思维导图：${map.root.label}`;
    button.appendChild(preview); button.addEventListener("click", () => onOpen?.(image)); target.appendChild(button);
  }

  LitMTrans.Mindmap = { MARKER, parseMarkdownMindmap, createMindmapImage, renderMindmap };
})();
