(() => {
  "use strict";

  const host = globalThis;
  const LitMTrans = host.LitMTrans = host.LitMTrans || {};
  const MARKER = "<!-- litmtrans-flowchart -->";
  const V2_MARKER = "<!-- litmtrans-flowchart-v2 -->";
  // Research-method diagrams often contain parallel numerical and experimental
  // branches.  Sixty-four nodes still keeps Mermaid layout bounded while
  // allowing a complete paper workflow such as the supplied 44-node example.
  const MAX_NODES = 64;
  const MAX_EDGES = 112;
  const NODE_TYPES = new Set(["terminator", "process", "decision", "io", "input", "output", "subprocess", "database", "document"]);
  const ROLES = new Set(["background", "gap", "question", "hypothesis", "design", "method", "evidence", "result", "inference", "mechanism", "validation", "conclusion", "limitation", "other"]);
  const SHAPES = Object.freeze({ terminator: "stadium", process: "rect", decision: "diam", io: "lean-r", input: "lean-r", output: "lean-l", subprocess: "subproc", database: "cyl", document: "doc" });
  const RENDER_CACHE_LIMIT = 12;
  const renderCache = new Map();
  let mermaidLoadPromise = null;

  function cleanLabel(value, limit = 80) {
    return String(value || "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function comparableID(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function mermaidNodeID(value) { return `lm_${String(value || "")}`; }

  function parseFlowchart(value) {
    const source = String(value || "").replace(/\r\n?/g, "\n");
    const isV2 = source.toLowerCase().indexOf(V2_MARKER) >= 0;
    const marker = isV2 ? V2_MARKER : MARKER;
    const markerAt = source.toLowerCase().indexOf(marker);
    if (markerAt < 0) return null;
    const raw = source.slice(markerAt + marker.length).trim();
    const fenced = raw.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
    let data;
    try {
      const payload = fenced ? fenced[1] : raw;
      // Evidence copied verbatim from papers often contains LaTeX commands.
      // Models occasionally emit their single backslashes directly, which is
      // invalid JSON (for example `\circ` or `\mathrm`).  Reuse the guarded
      // model-JSON reader so one malformed evidence quote cannot discard an
      // otherwise valid diagram.
      data = LitMTrans.Utils?.extractJSONObject
        ? LitMTrans.Utils.extractJSONObject(payload)
        : JSON.parse(payload);
    }
    catch (_) { return { error: "流程图数据不是有效 JSON。" }; }
    if (!data || typeof data !== "object" || Array.isArray(data)) return { error: "流程图必须是一个 JSON 对象。" };
    if (isV2 && Number(data.version) !== 2) return { error: "流程图 V2 缺少 version: 2。" };
    const requestedDirection = String(data.direction || data.layout || "").toUpperCase();
    let direction = ["TB", "LR"].includes(requestedDirection) ? requestedDirection : "";
    if (!Array.isArray(data.nodes) || !data.nodes.length || data.nodes.length > MAX_NODES) return { error: `流程图节点数量必须在 1 到 ${MAX_NODES} 之间。` };
    if (!Array.isArray(data.edges) || data.edges.length > MAX_EDGES) return { error: `流程图边数量不能超过 ${MAX_EDGES}。` };
    const ids = new Set();
    const nodes = [];
    for (const candidate of data.nodes) {
      const id = String(candidate?.id || "").trim();
      let type = String(candidate?.type || "process").toLowerCase();
      if (type === "input" || type === "output") type = "io";
      const label = cleanLabel(candidate?.label);
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(id) || ids.has(id)) return { error: "每个流程图节点都需要唯一的英文字母开头 ID。" };
      if (!NODE_TYPES.has(type) || !label) return { error: "节点类型或节点文字无效。" };
      const role = ROLES.has(String(candidate?.role || "other").toLowerCase()) ? String(candidate.role).toLowerCase() : "other";
      ids.add(id); nodes.push({ id, type, role, label, detail: cleanLabel(candidate?.detail, 420), importance: Math.max(1, Math.min(3, Number(candidate?.importance) || 1)), evidence: Array.isArray(candidate?.evidence) ? candidate.evidence.slice(0, 6) : [] });
    }
    // Models occasionally use a display-style reference such as `no h3o`
    // for an otherwise valid `noh3o` ID.  Resolve only an unambiguous
    // whitespace/punctuation variant; unknown or ambiguous references still
    // fail validation rather than silently changing the graph.
    const comparableIDs = new Map();
    for (const id of ids) {
      const key = comparableID(id);
      comparableIDs.set(key, comparableIDs.has(key) ? null : id);
    }
    const resolveID = value => {
      const exact = String(value || "").trim();
      if (ids.has(exact)) return exact;
      return comparableIDs.get(comparableID(exact)) || "";
    };
    const edges = [];
    for (const candidate of data.edges) {
      const from = resolveID(candidate?.from), to = resolveID(candidate?.to);
      const label = cleanLabel(candidate?.label, 24).replace(/[|]/g, "／");
      if (!ids.has(from) || !ids.has(to)) return { error: "流程图中的边必须引用已声明的节点。" };
      edges.push({ from, to, label });
    }
    // A compact research argument is easier to scan left-to-right.  Dense
    // graphs remain top-to-bottom so labels do not collapse into a ribbon.
    if (!direction) direction = String(data.layout || "").toLowerCase() === "auto" && nodes.length <= 18 ? "LR" : "TB";
    return { version: isV2 ? 2 : 1, mode: cleanLabel(data.mode, 40), title: cleanLabel(data.title, 120), direction, nodes, edges };
  }

  function mermaidSource(chart) {
    // Keep model-provided prose out of Mermaid Markdown/HTML syntax. Rich
    // title/detail styling is applied to the rendered SVG below, after the
    // graph parser has completed successfully.
    const quote = value => JSON.stringify(cleanLabel(value, 260).replace(/[\[\]{}]/g, ""));
    const rows = [`flowchart ${chart.direction}`];
    for (const node of chart.nodes) {
      const visible = node.detail ? `${node.label}：${node.detail}` : node.label;
      rows.push(`${mermaidNodeID(node.id)}@{ shape: ${SHAPES[node.type]}, label: ${quote(visible)} };`);
    }
    for (const edge of chart.edges) rows.push(`${mermaidNodeID(edge.from)} -->${edge.label ? `|${edge.label}|` : ""} ${mermaidNodeID(edge.to)};`);
    // Research-atlas palette: colour encodes argumentative function. The
    // conclusion is the sole dark anchor; all working stages stay paper-light.
    rows.push("classDef terminal fill:#243947,stroke:#243947,color:#ffffff,stroke-width:1.4px;");
    rows.push("classDef process fill:#fbfcfc,stroke:#8799a4,color:#17212b,stroke-width:1.05px;");
    rows.push("classDef decision fill:#faf7f0,stroke:#9b8970,color:#423a2e,stroke-width:1.2px;");
    rows.push("classDef io fill:#f8fafb,stroke:#849aa7,color:#17212b,stroke-width:1.05px;");
    rows.push("classDef model fill:#f3f7f8,stroke:#758e9b,color:#183246,stroke-width:1.15px;");
    rows.push("classDef data fill:#f3f7f5,stroke:#758e82,color:#193c2b,stroke-width:1.15px;");
    rows.push("classDef r_background fill:#f6f7f7,stroke:#9eabb2,color:#26343e,stroke-width:1px;");
    rows.push("classDef r_gap fill:#faf7f0,stroke:#9b8564,color:#493c29,stroke-width:1.2px;");
    rows.push("classDef r_question fill:#f3f7f9,stroke:#6f8999,color:#173747,stroke-width:1.25px;");
    rows.push("classDef r_hypothesis fill:#f7f5f8,stroke:#887c91,color:#3d3344,stroke-width:1.15px;");
    rows.push("classDef r_design fill:#f3f7f9,stroke:#718a99,color:#173747,stroke-width:1.15px;");
    rows.push("classDef r_method fill:#f3f7f9,stroke:#718a99,color:#173747,stroke-width:1.15px;");
    rows.push("classDef r_evidence fill:#f2f7f4,stroke:#718c7d,color:#244334,stroke-width:1.15px;");
    rows.push("classDef r_result fill:#f0f6f3,stroke:#668777,color:#1e4030,stroke-width:1.25px;");
    rows.push("classDef r_inference fill:#f7f5f8,stroke:#887c91,color:#3d3344,stroke-width:1.15px;");
    rows.push("classDef r_mechanism fill:#f5f5f9,stroke:#7c8196,color:#343849,stroke-width:1.2px;");
    rows.push("classDef r_validation fill:#f3f7f9,stroke:#6f8999,color:#173747,stroke-width:1.2px;");
    rows.push("classDef r_conclusion fill:#243947,stroke:#1c303d,color:#ffffff,stroke-width:1.45px;");
    rows.push("classDef r_limitation fill:#faf6f4,stroke:#987d74,color:#573b34,stroke-dasharray:5 3,stroke-width:1.15px;");
    rows.push("classDef r_other fill:#fbfcfc,stroke:#8799a4,color:#17212b,stroke-width:1.05px;");
    const classNames = { terminator: "terminal", process: "process", decision: "decision", io: "io", input: "io", output: "io", subprocess: "model", database: "data", document: "io" };
    for (const node of chart.nodes) {
      rows.push(`class ${mermaidNodeID(node.id)} ${classNames[node.type]};`);
      rows.push(`class ${mermaidNodeID(node.id)} r_${node.role || "other"};`);
    }
    return rows.join("\n");
  }

  function svgDataURL(svg) {
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(String(svg || ""))) )}`;
  }

  function withLightCanvas(svg) {
    return String(svg || "").replace(
      /(<svg\b[^>]*>)/i,
      "$1<rect width=\"100%\" height=\"100%\" fill=\"#f7f9fa\" pointer-events=\"none\"/><style>.edgePath .path{stroke:#81929d;stroke-width:1.15px}.arrowheadPath,.marker{fill:#81929d!important;stroke:#81929d!important}.edgeLabel,.edgeLabel p,.edgeLabel span{font-family:Inter,Segoe UI,Microsoft YaHei UI,sans-serif;font-size:10.5px;color:#52616a!important;background:transparent!important}.edgeLabel p{padding:0!important;margin:0!important;text-shadow:0 0 2px #f7f9fa,0 0 4px #f7f9fa,0 0 6px #f7f9fa}.edgeLabel rect{fill:transparent!important;stroke:none!important;opacity:0}.node&gt;rect,.node&gt;path,.node&gt;polygon,.node&gt;ellipse{filter:drop-shadow(0 1px 1px rgba(30,46,56,.12)) drop-shadow(0 5px 9px rgba(30,46,56,.055))}.process&gt;rect,.model&gt;rect{rx:8px;ry:8px}.r_background&gt;rect,.r_other&gt;rect{fill:url(#flow-surface)!important}.r_gap&gt;rect,.r_gap&gt;path,.r_gap&gt;polygon{fill:url(#flow-warm)!important}.r_question&gt;rect,.r_question&gt;path,.r_design&gt;rect,.r_method&gt;rect,.r_validation&gt;rect{fill:url(#flow-cool)!important}.r_evidence&gt;rect,.r_evidence&gt;path,.r_result&gt;rect,.r_result&gt;path{fill:url(#flow-sage)!important}.r_hypothesis&gt;rect,.r_inference&gt;rect,.r_mechanism&gt;rect{fill:url(#flow-plum)!important}.r_limitation&gt;rect,.r_limitation&gt;path{fill:url(#flow-rose)!important}.r_conclusion&gt;rect,.r_conclusion&gt;path,.r_conclusion&gt;polygon{fill:url(#flow-dark)!important}.nodeLabel{max-width:250px!important;white-space:normal!important;overflow-wrap:anywhere;text-align:center;line-height:1.5;color:#63717a!important;fill:#63717a!important;font-size:10.8px!important;font-weight:400;letter-spacing:.005em}.nodeLabel strong,.nodeLabel b{color:#1b2931!important;fill:#1b2931!important;font-size:13.5px!important;font-weight:650!important;line-height:1.34;letter-spacing:0}.nodeLabel tspan:first-child{fill:#1b2931;font-size:13.5px;font-weight:650}.r_conclusion .nodeLabel,.r_conclusion .nodeLabel span{color:#dce5e9!important;fill:#dce5e9!important}.r_conclusion .nodeLabel strong,.r_conclusion .nodeLabel b,.r_conclusion .nodeLabel tspan:first-child{color:#ffffff!important;fill:#ffffff!important}.cluster rect{rx:10px;ry:10px}</style>"
    );
  }

  function decorateFlowchartSVG(svgText, chart) {
    const parsed = new DOMParser().parseFromString(String(svgText || ""), "image/svg+xml");
    const svg = parsed.documentElement?.localName === "svg" ? parsed.documentElement : null;
    if (!svg) return String(svgText || "");
    const defs = parsed.createElementNS("http://www.w3.org/2000/svg", "defs");
    const gradients = {
      "flow-surface": ["#ffffff", "#f5f7f8"], "flow-cool": ["#fbfdfe", "#edf3f6"],
      "flow-sage": ["#fbfdfc", "#edf4f0"], "flow-warm": ["#fffdf9", "#f7f1e7"],
      "flow-plum": ["#fdfcfd", "#f2eff4"], "flow-rose": ["#fffdfc", "#f7f0ed"],
      "flow-dark": ["#304956", "#203540"]
    };
    for (const [id, colors] of Object.entries(gradients)) {
      const gradient = parsed.createElementNS(defs.namespaceURI, "linearGradient");
      gradient.setAttribute("id", id); gradient.setAttribute("x1", "0"); gradient.setAttribute("y1", "0"); gradient.setAttribute("x2", "0"); gradient.setAttribute("y2", "1");
      colors.forEach((color, index) => { const stop = parsed.createElementNS(defs.namespaceURI, "stop"); stop.setAttribute("offset", index ? "100%" : "0%"); stop.setAttribute("stop-color", color); gradient.appendChild(stop); });
      defs.appendChild(gradient);
    }
    svg.insertBefore(defs, svg.firstChild);
    const nodeElements = flowNodeElements(svg, chart);
    for (const [index, node] of chart.nodes.entries()) {
      const group = nodeElements[index];
      const label = group?.querySelector?.(".nodeLabel");
      if (!label) continue;
      if (String(label.namespaceURI || "").includes("svg") && label.localName === "text") {
        label.replaceChildren();
        const title = parsed.createElementNS("http://www.w3.org/2000/svg", "tspan");
        title.setAttribute("x", "0"); title.setAttribute("dy", node.detail ? "-0.45em" : "0.35em"); title.classList.add("flowchart-node-title"); title.textContent = node.label; label.appendChild(title);
        if (node.detail) {
          const detail = parsed.createElementNS("http://www.w3.org/2000/svg", "tspan");
          detail.setAttribute("x", "0"); detail.setAttribute("dy", "1.65em"); detail.classList.add("flowchart-node-detail"); detail.textContent = node.detail; label.appendChild(detail);
        }
      }
      else {
        label.replaceChildren();
        const title = parsed.createElementNS("http://www.w3.org/1999/xhtml", "strong"); title.setAttribute("class", "flowchart-node-title"); title.textContent = node.label; label.appendChild(title);
        if (node.detail) {
          label.appendChild(parsed.createElementNS("http://www.w3.org/1999/xhtml", "br"));
          const detail = parsed.createElementNS("http://www.w3.org/1999/xhtml", "span"); detail.setAttribute("class", "flowchart-node-detail"); detail.textContent = node.detail; label.appendChild(detail);
        }
      }
    }
    if (!svg.hasAttribute("xmlns")) svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return new XMLSerializer().serializeToString(svg);
  }

  function cachedImage(key, create) {
    if (!renderCache.has(key)) {
      const task = Promise.resolve().then(create).catch(error => {
        renderCache.delete(key);
        throw error;
      });
      renderCache.set(key, task);
      while (renderCache.size > RENDER_CACHE_LIMIT) renderCache.delete(renderCache.keys().next().value);
    }
    return renderCache.get(key);
  }

  function ensureMermaid() {
    const available = () => host.mermaid || host.__esbuild_esm_mermaid_nm?.mermaid;
    if (available()?.render) return Promise.resolve(available());
    if (mermaidLoadPromise) return mermaidLoadPromise;
    mermaidLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "chrome://litmtrans/content/assets/vendor/mermaid/mermaid.min.js";
      script.async = true;
      script.onload = () => available()?.render ? resolve(available()) : reject(new Error("Mermaid 未提供渲染接口。"));
      script.onerror = () => reject(new Error("Mermaid 加载失败。"));
      document.head.appendChild(script);
    }).catch(error => {
      mermaidLoadPromise = null;
      throw error;
    });
    return mermaidLoadPromise;
  }

  async function createImage(chart) {
    const mermaid = await ensureMermaid();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: {
        background: "#f8fafb",
        primaryColor: "#ffffff",
        primaryTextColor: "#17212b",
        primaryBorderColor: "#7890a2",
        lineColor: "#71899a",
        fontFamily: 'Inter, "Segoe UI", "Microsoft YaHei UI", sans-serif',
        fontSize: "15px"
      },
      flowchart: { htmlLabels: true, useMaxWidth: true, wrappingWidth: 250, nodeSpacing: 64, rankSpacing: 82, curve: "basis" }
    });
    const id = `litmtrans-flowchart-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const result = await mermaid.render(id, mermaidSource(chart));
    const svg = withLightCanvas(decorateFlowchartSVG(result.svg, chart));
    return { name: "流程图.svg", mimeType: "image/svg+xml", dataURL: svgDataURL(svg), svg };
  }

  function flowNodeElement(svg, nodeID) {
    const renderedID = mermaidNodeID(nodeID);
    return Array.from(svg.querySelectorAll("g.node, g[data-id], g[id]")).find(element => {
      const id = String(element.id || "");
      return element.getAttribute("data-id") === renderedID
        || id === renderedID
        || id.startsWith(`flowchart-${renderedID}-`);
    }) || null;
  }

  function flowNodeElements(svg, chart) {
    const matched = chart.nodes.map(node => flowNodeElement(svg, node.id));
    if (matched.every(Boolean) && new Set(matched).size === matched.length) return matched;
    const rendered = Array.from(svg.querySelectorAll("g.node"));
    return rendered.length === chart.nodes.length ? rendered : matched;
  }

  function positionDetail(panel, wrapper, nodeElement) {
    const wrapperRect = wrapper.getBoundingClientRect();
    const nodeRect = nodeElement.getBoundingClientRect();
    const scale = wrapper.offsetWidth > 0 ? wrapperRect.width / wrapper.offsetWidth : 1;
    const left = (nodeRect.left + nodeRect.width / 2 - wrapperRect.left) / Math.max(.01, scale) - 140;
    const top = (nodeRect.bottom - wrapperRect.top) / Math.max(.01, scale) + 12;
    panel.style.left = `${Math.max(12, Math.min(wrapper.offsetWidth - 292, left))}px`;
    panel.style.top = `${Math.max(12, top)}px`;
  }

  function evidenceText(item) {
    return String(item?.quote || item?.label || item?.ref || item?.tex || "").trim();
  }

  function showNodeEvidence(wrapper, nodeElement, node, options) {
    const existing = wrapper.querySelector(".flowchart-inline-detail");
    if (existing && nodeElement.classList.contains("selected")) {
      existing.remove(); nodeElement.classList.remove("selected"); return;
    }
    wrapper.querySelector(".flowchart-inline-detail")?.remove();
    wrapper.querySelector(".flowchart-node-interactive.selected")?.classList.remove("selected");
    nodeElement.classList.add("selected");
    const detail = document.createElement("section");
    detail.className = "flowchart-inline-detail";
    const eyebrow = document.createElement("span"); eyebrow.className = "flowchart-inline-detail-label"; eyebrow.textContent = "原文证据"; detail.appendChild(eyebrow);
    const heading = document.createElement("strong"); heading.textContent = node.label; detail.appendChild(heading);
    const list = document.createElement("div"); list.className = "flowchart-evidence-list"; detail.appendChild(list);
    node.evidence.forEach((item, index) => {
      const quote = evidenceText(item);
      if (!quote) return;
      const evidence = document.createElement("article"); evidence.className = "flowchart-evidence-item";
      const text = document.createElement("blockquote"); text.textContent = quote; evidence.appendChild(text);
      list.appendChild(evidence);
      if (typeof options.resolveEvidence === "function") {
        const locations = document.createElement("div"); locations.className = "flowchart-evidence-actions"; evidence.appendChild(locations);
        Promise.resolve(options.resolveEvidence(item)).then(resolved => {
          if (!resolved?.resolved || !locations.isConnected) return;
          const locate = document.createElement("button"); locate.type = "button"; locate.className = "flowchart-detail-locate"; locate.textContent = resolved.approximate ? "定位原文（文本不完全匹配）" : (index ? `定位证据 ${index + 1}` : "定位原文");
          locate.addEventListener("click", event => { event.stopPropagation(); options.onLocate?.(resolved); });
          locations.appendChild(locate);
        }).catch(() => {});
      }
    });
    if (!list.childElementCount) {
      const empty = document.createElement("p"); empty.className = "flowchart-evidence-empty"; empty.textContent = "暂无可核对的原文证据"; list.appendChild(empty);
    }
    wrapper.appendChild(detail);
    positionDetail(detail, wrapper, nodeElement);
    requestAnimationFrame(() => options.onFocus?.(nodeElement, detail));
  }

  async function renderInteractive(target, chart, options = {}) {
    target.replaceChildren();
    const notice = document.createElement("div"); notice.className = "chat-diagram-pending"; notice.textContent = "正在绘制交互流程图…"; target.appendChild(notice);
    try {
      const asset = options.image?.svg ? options.image : await cachedImage(mermaidSource(chart), () => createImage(chart));
      if (!target.isConnected) return;
      const parsed = new DOMParser().parseFromString(asset.svg, "image/svg+xml");
      const parsedSVG = parsed.documentElement?.localName === "svg" ? parsed.documentElement : null;
      if (!parsedSVG) throw new Error("流程图 SVG 无效。");
      const svg = document.importNode(parsedSVG, true);
      svg.classList.add("flowchart-interactive-svg");
      const viewBox = String(svg.getAttribute("viewBox") || "").trim().split(/\s+/).map(Number);
      if (viewBox.length === 4 && viewBox.every(Number.isFinite)) {
        svg.style.width = `${Math.max(1, viewBox[2])}px`;
        svg.style.height = `${Math.max(1, viewBox[3])}px`;
      }
      const wrapper = document.createElement("div"); wrapper.className = "flowchart-interactive-canvas"; wrapper.appendChild(svg);
      target.onclick = event => {
        if (event.target.closest?.(".flowchart-node-interactive, .flowchart-inline-detail")) return;
        wrapper.querySelector(".flowchart-inline-detail")?.remove();
        wrapper.querySelector(".flowchart-node-interactive.selected")?.classList.remove("selected");
      };
      const renderedNodes = flowNodeElements(svg, chart);
      for (const [index, node] of chart.nodes.entries()) {
        const element = renderedNodes[index];
        if (!element) continue;
        element.classList.add("flowchart-node-interactive"); element.setAttribute("role", "button"); element.setAttribute("tabindex", "0"); element.setAttribute("aria-label", `查看原文证据：${node.label}`);
        const openDetail = event => { event.stopPropagation(); showNodeEvidence(wrapper, element, node, options); };
        element.addEventListener("pointerdown", event => event.stopPropagation());
        element.addEventListener("click", openDetail);
        element.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openDetail(event); } });
      }
      target.replaceChildren(wrapper);
      requestAnimationFrame(() => options.onReady?.());
    }
    catch (error) { host.console?.error?.("LitMTrans interactive flowchart render failed", error); if (target.isConnected) notice.textContent = "流程图绘制失败；请查看该回复的原始 JSON。"; }
  }

  async function renderFlowchart(target, chart, onOpen) {
    target.replaceChildren();
    const notice = document.createElement("div");
    notice.className = "chat-diagram-pending";
    notice.textContent = "正在绘制流程图…";
    target.appendChild(notice);
    try {
      const image = await cachedImage(mermaidSource(chart), () => createImage(chart));
      if (!target.isConnected) return;
      const button = document.createElement("button");
      button.type = "button"; button.className = "chat-diagram-image"; button.setAttribute("aria-label", "查看流程图");
      const preview = document.createElement("img"); preview.src = image.dataURL; preview.alt = "生成的流程图";
      button.appendChild(preview); button.addEventListener("click", () => onOpen?.(image));
      target.replaceChildren(button);
    }
    catch (_) { if (target.isConnected) notice.textContent = "流程图绘制失败；请查看该回复的原始 JSON。"; }
  }

  LitMTrans.Flowchart = { MARKER, V2_MARKER, parseFlowchart, mermaidSource, renderFlowchart, renderInteractive };
})();
