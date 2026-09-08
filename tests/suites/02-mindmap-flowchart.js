"use strict";

module.exports = function createSuite(env) {
  const {
    assert, fs, path, root, prefValues, context, zlib, nodeCrypto, vm,
    crc32, zipU16, zipU32, zipU64, oneEntryZip, oneEntryZip64,
    MemoryStorage, withResolvedChatModel,
    U, M, H, LLMService, LLMInternals,
    TranslationService, TranslationInternals,
    WebMachineTranslationService, WebMachineTranslation,
    EdgeLocalTranslation, LayoutTranslationService, LayoutHelpers,
    MinerUService, MinerUInternals, Mindmap, MindmapV2, Flowchart,
    ChatService, ChatInternals, ControllerInternals, DocumentPipeline
  } = env;

function testMindmap() {
  const map = Mindmap.parseMarkdownMindmap(`<!-- litmtrans-mindmap -->
# 论文核心
## 方法
- 双盲实验
  - 500 名参与者
## 结果
- 准确率提升 12%`);
  assert(map, "explicitly marked Markdown outlines must parse as mind maps");
  assert.equal(map.root.label, "论文核心");
  assert.equal(map.root.children[0].label, "方法");
  assert.equal(map.root.children[0].children[0].children[0].label, "500 名参与者");
  assert.equal(Mindmap.parseMarkdownMindmap("# 普通回答\n- 不应被当作导图"), null, "ordinary Markdown must remain a normal chat reply");
  assert.equal(Mindmap.parseMarkdownMindmap(`${Mindmap.MARKER}\n这不是大纲`), null, "a marker without a hierarchy must not create an empty map");
  const v2 = MindmapV2.parse(`${MindmapV2.MARKER}\n${JSON.stringify({ version: 2, mode: "paper_mindmap", title: "研究地图", nodes: [
    { id: "root", parentId: null, label: "核心贡献", kind: "root", importance: 3 },
    { id: "result", parentId: "root", label: "关键结果", detail: "与基线相比显著提升", kind: "result", importance: 3 }
  ] })}`);
  assert(!v2.error && v2.root.children[0].id === "result", "semantic Mindmap V2 must build a validated tree");
  const invalidV2 = MindmapV2.parse(`${MindmapV2.MARKER}\n{"version":2,"nodes":[{"id":"a","parentId":"b","label":"A"},{"id":"b","parentId":"a","label":"B"}]}`);
  assert(invalidV2.error, "cyclic V2 mind maps must fail gracefully");
  const latexEvidence = MindmapV2.parse(`${MindmapV2.MARKER}\n{"version":2,"nodes":[{"id":"root","parentId":null,"label":"结果","kind":"root","evidence":[{"type":"quote","quote":"The value is $T_{\\mathrm{b}}$."}]}]}`);
  assert(!latexEvidence.error, "bare LaTeX backslashes in model-provided mind-map evidence must be repaired");
  assert.equal(latexEvidence.root.evidence[0].quote, "The value is $T_{\\mathrm{b}}$.", "repairing model JSON must preserve the evidence quote");
}

function testFlowchart() {
  const chart = Flowchart.parseFlowchart(`<!-- litmtrans-flowchart -->
{"direction":"TB","nodes":[{"id":"start","type":"terminator","label":"开始"},{"id":"check","type":"decision","label":"还有元素？"},{"id":"body","type":"process","label":"处理元素"},{"id":"end","type":"terminator","label":"结束"}],"edges":[{"from":"start","to":"check"},{"from":"check","to":"body","label":"是"},{"from":"check","to":"end","label":"否"},{"from":"body","to":"check"}]}`);
  assert(!chart.error, "a flowchart with a decision and back edge must parse");
  assert.equal(chart.edges.at(-1).to, "check", "cycles must be retained as ordinary directed edges");
  assert(Flowchart.mermaidSource(chart).includes('lm_check@{ shape: diam, label: "还有元素？" };'), "decision nodes must use the robust Mermaid diamond shape syntax with parser-safe IDs");
  const tolerant = Flowchart.parseFlowchart(`${Flowchart.MARKER}\n{"nodes":[{"id":"noh3o","type":"process","label":"检查结果"}],"edges":[{"from":"no h3o","to":"noh3o"}]}`);
  assert.equal(tolerant.edges[0].from, "noh3o", "unambiguous spacing differences in model edge IDs should be repaired");
  const researchScale = Flowchart.parseFlowchart(`${Flowchart.MARKER}\n${JSON.stringify({
    nodes: Array.from({ length: 44 }, (_, index) => ({ id: `n${index}`, type: "process", label: `步骤 ${index + 1}` })),
    edges: []
  })}`);
  assert(!researchScale.error, "a 44-node research workflow must not be rejected by the safety limit");
  assert(Flowchart.parseFlowchart(`${Flowchart.MARKER}\n{"nodes":[{"id":"ok","type":"process","label":"步骤"}],"edges":[{"from":"ok","to":"missing"}]}`).error, "unknown edge endpoints must be rejected");
  const v2 = Flowchart.parseFlowchart(`${Flowchart.V2_MARKER}\n${JSON.stringify({ version: 2, mode: "paper_logic_flow", title: "研究逻辑", layout: "LR", nodes: [{ id: "gap", type: "process", role: "gap", label: "研究缺口" }, { id: "evidence", type: "io", role: "evidence", label: "关键证据", detail: "准确率相对基线提高 12%", evidence: [{ type: "quote", quote: "Accuracy increased by 12%." }] }], edges: [{ from: "gap", to: "evidence", relation: "motivates", label: "驱动" }] })}`);
  assert(!v2.error && v2.version === 2 && v2.nodes[1].type === "io", "flowchart V2 must retain distinct process and research semantics");
  assert.equal(v2.nodes[1].detail, "准确率相对基线提高 12%", "flowchart V2 must retain substantive node details for the interactive viewer");
  assert.equal(v2.nodes[1].evidence[0].quote, "Accuracy increased by 12%.", "flowchart V2 must retain evidence used by PDF location actions");
  const latexEvidence = Flowchart.parseFlowchart(`${Flowchart.V2_MARKER}\n{"version":2,"nodes":[{"id":"result","type":"process","role":"result","label":"方向结果","evidence":[{"type":"quote","quote":"The $0^{\\circ}$ direction is strongest and $R_{\\mathrm{b}}$ is measured."}]}],"edges":[]}`);
  assert(!latexEvidence.error, "bare LaTeX backslashes in model-provided flowchart evidence must be repaired");
  assert.equal(latexEvidence.nodes[0].evidence[0].quote, "The $0^{\\circ}$ direction is strongest and $R_{\\mathrm{b}}$ is measured.", "flowchart JSON repair must preserve evidence text");
  assert(Flowchart.mermaidSource(v2).includes('label: "关键证据：准确率相对基线提高 12%"'), "flowchart nodes must expose substantive detail without fragile Mermaid Markdown labels");
  assert(Flowchart.mermaidSource(v2).includes("class lm_evidence io;\nclass lm_evidence r_evidence;"), "node shape and research-role palettes must be assigned as distinct Mermaid classes");
  const flowchartSource = fs.readFileSync(path.join(root, "src", "flowchart.js"), "utf8");
  const evidencePanel = flowchartSource.match(/function showNodeEvidence[\s\S]*?\n  async function renderInteractive/)?.[0] || "";
  assert(flowchartSource.includes('element.classList.add("flowchart-node-interactive")')
    && flowchartSource.includes("function flowNodeElements(svg, chart)")
    && flowchartSource.includes("const nodeElements = flowNodeElements(svg, chart);")
    && !flowchartSource.includes('if (!evidence.length) continue;'),
  "Mermaid node-ID fallback must preserve both title/detail decoration and interaction for every flowchart node");
  assert(evidencePanel.includes('eyebrow.textContent = "原文证据"')
    && evidencePanel.includes("evidenceText(item)")
    && evidencePanel.includes("options.resolveEvidence(item)")
    && !evidencePanel.includes("node.detail")
    && !evidencePanel.includes("onAsk"),
  "expanding a flowchart node must reveal only verbatim evidence and its source-location action");
  const viewerSource = fs.readFileSync(path.join(root, "src", "diagram-viewer.js"), "utf8");
  const workbenchCSS = fs.readFileSync(path.join(root, "src", "workbench.css"), "utf8");
  assert(viewerSource.includes('centerOnElements(diagram, { behavior: "auto" })')
    && !viewerSource.includes("viewport.scrollLeft = 0; viewport.scrollTop = 0;"),
  "fitted diagrams must center their rendered bounds instead of resetting the viewport to the top-left corner");
  assert(!workbenchCSS.includes('content: "打开交互图"')
    && !viewerSource.includes("点击“证据”节点查看原文")
    && !flowchartSource.includes("flowchart-evidence-marker")
    && !workbenchCSS.includes("flowchart-evidence-marker"),
  "diagram UI must not narrate implemented interaction through redundant developer-facing hints");
}

function testDiagramEvidenceMatching() {
  const compiled = { model: { pages: [{ index: 10, width: 1000, height: 1400, blocks: [
    { id: "unrelated", text: "The experimental configuration and pressure measurements are described here.", bbox: [10, 20, 500, 80] },
    { id: "wall", text: "To sum up, the influence of the wall on the first period of bubble oscillation is greater than that on the bubble maximum radius in near-wall underwater explosion, and these influences decrease rapidly as the bubble is away from the wall.", bbox: [100, 200, 900, 360] }
  ] }] } };
  const fuzzy = ControllerInternals.compiledEvidenceMatches(compiled, { type: "quote", quote: "In the near-wall underwater explosion, the influence of the wall on the first period of bubble oscillation is greater than that on the bubble maximum radius in near-wall underwater explosion, and these influences decrease rapidly as the bubble is away from the wall." });
  assert(fuzzy?.approximate && fuzzy.blockID === "wall" && fuzzy.confidence >= .72, "a uniquely strong near-verbatim quote must fall back to an explicitly approximate PDF location");
  assert(fuzzy.highlightText.startsWith("In the near-wall"), "resolved quote locations must retain text for sentence-level PDF highlighting");
  const omitted = ControllerInternals.compiledEvidenceMatches(compiled, { type: "quote", quote: "influence of the wall...bubble maximum radius...away from the wall" });
  assert(omitted?.blockID === "wall" && omitted.approximate, "ellipsis-style AI quotes must resolve ordered fragments in one source block");
  const distant = ControllerInternals.compiledEvidenceMatches(compiled, { type: "quote", quote: "A substantially rewritten claim that shares almost no literal wording." });
  assert(distant?.resolved !== false && distant?.blockID && distant.approximate, "even a weak quote match must retain a nearest-location action for reader judgment");
  assert.deepEqual(ControllerInternals.findEvidenceSegmentRanges("prefix aaa middle bbb end ccc suffix", "aaa...bbb…ccc"), [{ start: 6, end: 9 }, { start: 15, end: 18 }, { start: 21, end: 24 }], "ASCII and Unicode ellipses must produce ordered sentence-fragment ranges");
  const ambiguous = { model: { pages: [{ index: 1, blocks: [{ id: "a", text: "This repeated evidence sentence contains the same important result for testing." }, { id: "b", text: "This repeated evidence sentence contains the same important result for testing." }] }] } };
  const nearest = ControllerInternals.compiledEvidenceMatches(ambiguous, { type: "quote", quote: "This repeated evidence sentence contains the same important result for testing." });
  assert(nearest?.approximate && nearest.blockID, "an ambiguous quote must still expose a visibly approximate nearest location");
}

  return {
    testMindmap,
    testFlowchart,
    testDiagramEvidenceMatching,
  };
};
