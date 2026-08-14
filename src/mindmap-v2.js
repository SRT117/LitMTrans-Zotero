(() => {
  "use strict";

  const host = globalThis;
  const LitMTrans = host.LitMTrans = host.LitMTrans || {};
  const MARKER = "<!-- litmtrans-mindmap-v2 -->";
  const MAX_NODES = 64;
  const MAX_DEPTH = 5;
  const KIND = new Set(["root", "background", "problem", "gap", "hypothesis", "method", "data", "result", "mechanism", "comparison", "validation", "contribution", "limitation", "implication", "other"]);

  const clean = (value, limit) => String(value || "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
  const safeJSON = source => {
    const fenced = String(source || "").trim().match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
    try {
      const payload = fenced ? fenced[1] : source;
      return LitMTrans.Utils?.extractJSONObject
        ? LitMTrans.Utils.extractJSONObject(payload)
        : JSON.parse(payload);
    }
    catch (_) { return null; }
  };

  function parse(value) {
    const source = String(value || "").replace(/\r\n?/g, "\n");
    const at = source.toLowerCase().indexOf(MARKER);
    if (at < 0) return null;
    const data = safeJSON(source.slice(at + MARKER.length).trim());
    if (!data || typeof data !== "object" || Array.isArray(data) || Number(data.version) !== 2) return { error: "思维导图数据不是有效的 V2 JSON。" };
    if (!Array.isArray(data.nodes) || !data.nodes.length || data.nodes.length > MAX_NODES) return { error: `思维导图节点数量必须在 1 到 ${MAX_NODES} 之间。` };
    const ids = new Set();
    const nodes = [];
    for (const raw of data.nodes) {
      const id = String(raw?.id || "").trim();
      const parentId = raw?.parentId == null ? null : String(raw.parentId).trim();
      const label = clean(raw?.label, 300);
      const kind = KIND.has(String(raw?.kind || "other")) ? String(raw.kind) : "other";
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(id) || ids.has(id) || !label) return { error: "每个思维导图节点都需要唯一 ID 和标题。" };
      ids.add(id);
      nodes.push({ id, parentId, label, detail: clean(raw?.detail, 420), kind, importance: Math.max(1, Math.min(3, Number(raw?.importance) || 1)), evidence: Array.isArray(raw?.evidence) ? raw.evidence.slice(0, 6) : [] });
    }
    const roots = nodes.filter(node => !node.parentId);
    if (roots.length !== 1 || !roots[0]) return { error: "思维导图必须且只能有一个根节点。" };
    const byID = new Map(nodes.map(node => [node.id, { ...node, children: [] }]));
    for (const node of byID.values()) {
      if (!node.parentId) continue;
      const parent = byID.get(node.parentId);
      if (!parent) return { error: "思维导图包含不存在的父节点。" };
      parent.children.push(node);
    }
    const root = byID.get(roots[0].id);
    const seen = new Set(); let depthError = false;
    const visit = (node, depth) => {
      if (seen.has(node.id)) return false;
      seen.add(node.id); if (depth > MAX_DEPTH) depthError = true;
      return node.children.every(child => visit(child, depth + 1));
    };
    if (!visit(root, 0) || seen.size !== nodes.length || depthError) return { error: "思维导图不能有环，且层级不能超过 5 层。" };
    return { version: 2, mode: clean(data.mode, 32) || "mindmap", title: clean(data.title, 120) || root.label, paperType: clean(data.paperType, 32), core: clean(data.core, 360), root, nodes: [...byID.values()] };
  }

  function metrics(node) {
    const labelUnits = [...String(node.label || "")].reduce((n, char) => n + (/[^\x00-\xff]/.test(char) ? 1 : .56), 0);
    const detailUnits = [...String(node.detail || "")].reduce((n, char) => n + (/[^\x00-\xff]/.test(char) ? 1 : .56), 0);
    const units = labelUnits + (detailUnits ? detailUnits + 2 : 0);
    const width = Math.max(122, Math.min(380, Math.ceil(Math.min(units, 32) * 12 + 28)));
    
    const maxUnitsPerLine = Math.max(7, (width - 24) / 12);
    const labelLines = Math.ceil(labelUnits / maxUnitsPerLine);
    const detailLines = detailUnits ? Math.ceil(detailUnits / (maxUnitsPerLine * 0.95)) : 0;
    const totalLines = labelLines + detailLines + (detailLines ? 0.6 : 0);
    
    return { width, height: Math.max(34, Math.min(480, 18 + totalLines * 18)) };
  }

  function layout(map) {
    const entries = [];
    const branchWeight = node => !node.children.length ? 1 : node.children.reduce((sum, child) => sum + branchWeight(child), 0);
    const make = (node, parent, side, depth) => {
      const entry = { node, parent, side, depth, children: [], ...metrics(node), x: 0, y: 0 };
      entries.push(entry);
      return entry;
    };
    const descend = (node, parent, side, depth) => {
      const entry = make(node, parent, side, depth);
      entry.children = node.children.map(child => descend(child, entry, side, depth + 1));
      return entry;
    };
    const root = make(map.root, null, 0, 0);
    const children = map.root.children.slice().sort((a, b) => branchWeight(b) - branchWeight(a));
    const left = [], right = [];
    let lw = 0, rw = 0;
    for (const child of children) { const target = lw <= rw ? left : right; target.push(child); if (target === left) lw += branchWeight(child); else rw += branchWeight(child); }
    root.children = [...left.map(child => descend(child, root, -1, 1)), ...right.map(child => descend(child, root, 1, 1))];
    const ySpacing = 36;
    const xSpacing = 64;
    const placeSide = (nodes, side) => {
      const leaves = [];
      const getLeaves = entry => { if (entry.children.length) entry.children.forEach(getLeaves); else leaves.push(entry); };
      nodes.forEach(getLeaves);
      
      const totalHeight = leaves.reduce((sum, leaf) => sum + leaf.height, 0) + Math.max(0, leaves.length - 1) * ySpacing;
      let currentY = -totalHeight / 2;
      
      const y = entry => {
        if (!entry.children.length) {
          entry.y = currentY + entry.height / 2;
          currentY += entry.height + ySpacing;
        } else {
          entry.children.forEach(y);
          entry.y = entry.children.reduce((sum, child) => sum + child.y, 0) / entry.children.length;
        }
      };
      nodes.forEach(y);
      
      const x = entry => { entry.x = side > 0 ? entry.parent.x + entry.parent.width + xSpacing : entry.parent.x - entry.width - xSpacing; entry.children.forEach(x); };
      nodes.forEach(x);
    };
    root.x = 0; root.y = 0;
    placeSide(root.children.filter(item => item.side < 0), -1);
    placeSide(root.children.filter(item => item.side > 0), 1);
    
    const minX = Math.min(...entries.map(item => item.x)); const maxX = Math.max(...entries.map(item => item.x + item.width));
    const minY = Math.min(...entries.map(item => item.y - item.height / 2)); const maxY = Math.max(...entries.map(item => item.y + item.height / 2));
    
    for (const item of entries) { item.x += 32 - minX; item.y += 32 - minY; }
    return { entries, width: Math.max(480, maxX - minX + 64), height: Math.max(220, maxY - minY + 64) };
  }

  function render(target, map, options = {}) {
    target.replaceChildren();
    const collapsed = options.collapsed || new Set();
    const selectedID = String(options.selectedID || "");
    const scene = layout(map);
    const canvas = document.createElement("div"); canvas.className = "mindmap-v2-canvas"; canvas.style.width = `${scene.width}px`; canvas.style.height = `${scene.height}px`;
    target.onclick = event => {
      if (event.target.closest?.(".mindmap-v2-node, .mindmap-v2-inline-detail")) return;
      if (selectedID) render(target, map, { ...options, collapsed, selectedID: "" });
    };
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.classList.add("mindmap-v2-edges"); svg.setAttribute("viewBox", `0 0 ${scene.width} ${scene.height}`); svg.setAttribute("width", scene.width); svg.setAttribute("height", scene.height);
    const isVisible = entry => {
      for (let parent = entry.parent; parent; parent = parent.parent) if (collapsed.has(parent.node.id)) return false;
      return true;
    };
    for (const entry of scene.entries) {
      if (!isVisible(entry)) continue;
      if (!entry.parent) continue;
      if (!isVisible(entry.parent)) continue;
      const startX = entry.side < 0 ? entry.parent.x : entry.parent.x + entry.parent.width;
      const endX = entry.side < 0 ? entry.x + entry.width : entry.x;
      const middle = (startX + endX) / 2;
      const path = document.createElementNS(svg.namespaceURI, "path"); path.setAttribute("d", `M${startX} ${entry.parent.y} C${middle} ${entry.parent.y} ${middle} ${entry.y} ${endX} ${entry.y}`); path.setAttribute("data-kind", entry.node.kind); svg.appendChild(path);
    }
    canvas.appendChild(svg);
    for (const entry of scene.entries) {
      if (!isVisible(entry)) continue;
      const button = document.createElement("button"); button.type = "button"; button.className = `mindmap-v2-node depth-${entry.depth} kind-${entry.node.kind}${selectedID === entry.node.id ? " selected" : ""}`; button.style.left = `${entry.x}px`; button.style.top = `${entry.y - entry.height / 2}px`; button.style.width = `${entry.width}px`; button.style.minHeight = `${entry.height}px`;
      const label = document.createElement("span"); label.className = "mindmap-v2-node-label"; label.textContent = entry.node.label; button.appendChild(label);
      if (entry.node.detail) {
        const detail = document.createElement("div"); 
        detail.className = "mindmap-v2-node-detail"; 
        detail.style.fontSize = "0.95em";
        detail.style.opacity = "0.85";
        detail.style.marginTop = "4px";
        detail.style.whiteSpace = "normal";
        detail.textContent = entry.node.detail; 
        button.appendChild(detail);
      }
      if (entry.node.children.length) button.dataset.collapsible = "true";
      button.addEventListener("click", () => {
        options.onSelect?.(entry.node);
        if (entry.node.children.length && options.interactive !== false && options.toggleOnClick) collapsed.has(entry.node.id) ? collapsed.delete(entry.node.id) : collapsed.add(entry.node.id);
        render(target, map, { ...options, collapsed, selectedID: selectedID === entry.node.id ? "" : entry.node.id });
      });
      canvas.appendChild(button);
    }
    const selected = scene.entries.find(entry => entry.node.id === selectedID && isVisible(entry));
    if (selected && selected.node.evidence?.length) {
      const detail = document.createElement("section"); detail.className = "mindmap-v2-inline-detail";
      detail.style.left = `${Math.max(18, Math.min(scene.width - 286, selected.x + selected.width / 2 - 130))}px`;
      detail.style.top = `${selected.y + selected.height / 2 + 12}px`;
      const heading = document.createElement("strong"); heading.textContent = selected.node.label; detail.appendChild(heading);
      const evidence = selected.node.evidence.map(item => String(item?.quote || item?.label || item?.ref || item?.tex || "")).filter(Boolean);
      if (evidence.length) { const note = document.createElement("small"); note.textContent = `证据：${evidence.join("；")}`; detail.appendChild(note); }
      if (typeof options.resolveEvidence === "function" && selected.node.evidence.length) {
        const locations = document.createElement("div"); locations.className = "mindmap-v2-evidence-actions";
        selected.node.evidence.forEach((item, index) => {
          Promise.resolve(options.resolveEvidence(item)).then(resolved => {
            if (!resolved?.resolved || !locations.isConnected) return;
            const locate = document.createElement("button"); locate.type = "button"; locate.className = "mindmap-v2-detail-locate"; locate.textContent = resolved.approximate ? "定位原文（文本不完全匹配）" : (index ? `定位证据 ${index + 1}` : "定位原文");
            locate.addEventListener("click", event => { event.stopPropagation(); options.onLocate?.(resolved); });
            locations.appendChild(locate);
          }).catch(() => {});
        });
        detail.appendChild(locations);
      }
      if (typeof options.onAsk === "function") { const ask = document.createElement("button"); ask.type = "button"; ask.className = "mindmap-v2-detail-ask"; ask.textContent = "就此提问"; ask.addEventListener("click", event => { event.stopPropagation(); options.onAsk(selected.node); }); detail.appendChild(ask); }
      canvas.appendChild(detail);
      const selectedButton = canvas.querySelector(".mindmap-v2-node.selected");
      requestAnimationFrame(() => options.onFocus?.(selectedButton, detail));
    }
    target.appendChild(canvas); return scene;
  }

  function svgForMap(map) {
    const scene = layout(map);
    const escape = value => String(value || "").replace(/[&<>\"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
    const edge = scene.entries.filter(entry => entry.parent).map(entry => {
      const start = entry.side < 0 ? entry.parent.x : entry.parent.x + entry.parent.width;
      const end = entry.side < 0 ? entry.x + entry.width : entry.x;
      const middle = (start + end) / 2;
      return `<path d="M${start} ${entry.parent.y} C${middle} ${entry.parent.y} ${middle} ${entry.y} ${end} ${entry.y}"/>`;
    }).join("");
    const boxes = scene.entries.map(entry => {
      const fill = entry.depth === 0 ? "#171715" : (entry.depth === 1 ? "#ecece7" : "#ffffff");
      const ink = entry.depth === 0 ? "#ffffff" : "#11110f";
      const x = entry.x, y = entry.y - entry.height / 2;
      
      const chunk = (text) => {
        const chars = [...String(text || "")];
        const maxUnitsPerLine = Math.max(7, (entry.width - 24) / 12);
        const lines = [];
        let currentLine = "";
        let currentUnits = 0;
        for (const char of chars) {
          const u = /[^\x00-\xff]/.test(char) ? 1 : .56;
          if (currentUnits + u > maxUnitsPerLine && currentLine) {
            lines.push(currentLine);
            currentLine = char;
            currentUnits = u;
          } else {
            currentLine += char;
            currentUnits += u;
          }
        }
        if (currentLine) lines.push(currentLine);
        return lines;
      };

      const labelLines = chunk(entry.node.label);
      const detailLines = chunk(entry.node.detail);
      const totalLines = labelLines.length + (detailLines.length ? detailLines.length + 0.5 : 0);
      
      const lineHeight = 18;
      const startY = entry.y - (totalLines - 1) * lineHeight / 2 + 5;
      
      let textContent = labelLines.map((line, i) => `<tspan x="${x + entry.width / 2}" y="${startY + i * lineHeight}" font-size="13.5" font-weight="${entry.node.detail ? 'bold' : 'normal'}">${escape(line)}</tspan>`).join("");
      
      if (detailLines.length) {
         const detailStartY = startY + (labelLines.length + 0.5) * lineHeight;
         textContent += detailLines.map((line, i) => `<tspan x="${x + entry.width / 2}" y="${detailStartY + i * lineHeight}" font-size="11" fill="${ink}dd">${escape(line)}</tspan>`).join("");
      }
      
      return `<rect x="${x}" y="${y}" width="${entry.width}" height="${entry.height}" rx="2" fill="${fill}" stroke="#8b8b82"/><text x="${x + entry.width / 2}" y="${startY}" text-anchor="middle" fill="${ink}" font-family="Segoe UI,Microsoft YaHei,sans-serif" font-size="12">${textContent}</text>`;
    }).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}"><rect width="100%" height="100%" fill="#ffffff"/><g fill="none" stroke="#8b8b82" stroke-width="1.35">${edge}</g>${boxes}</svg>`;
  }

  function imageForMap(map) {
    const svg = svgForMap(map);
    return { name: "思维导图.svg", mimeType: "image/svg+xml", dataURL: `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}` };
  }

  LitMTrans.MindmapV2 = { MARKER, MAX_NODES, parse, layout, render, svgForMap, imageForMap };
})();
