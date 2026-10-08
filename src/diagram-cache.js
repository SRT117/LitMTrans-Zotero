(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const U = LitMTrans.Utils || {};
  const TASK_TYPES = new Set(["key_points", "paper_mindmap", "paper_logic_flow"]);
  const MAX_CHARS = 64 * 1024 * 1024;
  const MAX_MINDMAP_NODES = 10000;
  const MAX_FLOWCHART_NODES = 10000;
  const MAX_FLOWCHART_EDGES = 100000;

  function taskType(value) {
    const normalized = String(value || "").trim();
    return TASK_TYPES.has(normalized) ? normalized : "";
  }

  function mode(value, type) {
    const normalized = String(value || "").trim();
    const expected = type === "paper_logic_flow" ? "flowchart" : "mindmap";
    if (!normalized) return expected;
    return normalized === expected ? normalized : "";
  }

  function file(type) {
    return `${taskType(type)}.json`;
  }

  function validate(diagram, diagramMode) {
    if (!diagram || typeof diagram !== "object" || Array.isArray(diagram)) return false;
    if (!Array.isArray(diagram.nodes) || diagram.nodes.length < 1 || diagram.nodes.length > (diagramMode === "mindmap" ? MAX_MINDMAP_NODES : MAX_FLOWCHART_NODES)) return false;
    if (diagramMode === "mindmap") {
      if (!diagram.root || typeof diagram.root !== "object" || !Array.isArray(diagram.root.children)) return false;
      const seenIDs = new Set();
      for (const node of diagram.nodes) {
        const id = String(node?.id || "");
        if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id) || seenIDs.has(id) || !String(node?.label || "").trim()) return false;
        if (!Array.isArray(node?.evidence)) return false;
        seenIDs.add(id);
      }
      const seenNodes = new Set();
      const treeIDs = new Set();
      const pending = [diagram.root];
      while (pending.length) {
        const node = pending.pop();
        if (!node || typeof node !== "object" || seenNodes.has(node)) return false;
        if (treeIDs.has(node.id)) return false;
        if (!seenIDs.has(String(node.id || "")) || !String(node.label || "").trim()) return false;
        if (!Array.isArray(node.children) || node.children.length > MAX_MINDMAP_NODES) return false;
        seenNodes.add(node);
        treeIDs.add(node.id);
        for (const child of node.children) pending.push(child);
      }
      return diagram.root.parentId == null && seenNodes.size === diagram.nodes.length;
    }
    if (!Array.isArray(diagram.edges) || diagram.edges.length > MAX_FLOWCHART_EDGES) return false;
    const nodeIDs = new Set(diagram.nodes.map(node => String(node?.id || "")));
    if ([...nodeIDs].some(id => !/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) || nodeIDs.size !== diagram.nodes.length) return false;
    if (diagram.nodes.some(node => !String(node?.label || "").trim())) return false;
    return diagram.edges.every(edge => nodeIDs.has(String(edge?.from || "")) && nodeIDs.has(String(edge?.to || "")));
  }

  function sourceFingerprint(source) {
    return source ? (U.hashString?.(String(source)) || "") : "";
  }

  function build(options = {}) {
    const normalizedType = taskType(options.taskType);
    const normalizedMode = mode(options.mode, normalizedType);
    if (!normalizedType || !normalizedMode || !validate(options.diagram, normalizedMode)) return null;
    return {
      file: file(normalizedType),
      version: 2,
      taskType: normalizedType,
      mode: normalizedMode,
      title: String(options.title || "图形").trim() || "图形",
      sourceFingerprint: String(options.sourceFingerprint || ""),
      diagram: options.diagram,
      updatedAt: String(options.updatedAt || new Date().toISOString())
    };
  }

  function normalize(data, expectedType = "", expectedMode = "") {
    if (!data || typeof data !== "object") return null;
    const normalizedType = taskType(data.taskType || expectedType);
    const normalizedMode = mode(data.mode || expectedMode, normalizedType);
    if (!normalizedType || !normalizedMode || !validate(data.diagram, normalizedMode)) return null;
    return {
      file: String(data.file || file(normalizedType)),
      version: Number(data.version || 1),
      taskType: normalizedType,
      mode: normalizedMode,
      title: String(data.title || "图形").trim() || "图形",
      sourceFingerprint: String(data.sourceFingerprint || ""),
      diagram: data.diagram,
      updatedAt: String(data.updatedAt || "")
    };
  }

  LitMTrans.DiagramCache = { TASK_TYPES, MAX_CHARS, taskType, mode, file, validate, sourceFingerprint, build, normalize };
  LitMTrans.Agent = LitMTrans.Agent || {};
  LitMTrans.Agent.DiagramCache = LitMTrans.DiagramCache;
})(this);
