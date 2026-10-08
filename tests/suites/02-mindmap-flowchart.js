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

function testDiagramDisplayCompatibility() {
  const label = "Cxcr4<sup>-/-</sup> 与 H<sub>2</sub>O";
  const detail = "cm<sup>−1</sup>，x<sub>i</sub> &lt; 5 &times; 10<sup>2</sup>";
  const quote = `${label} &amp; original evidence`;
  const evidence = [{ type: "quote", quote }];
  const rootNode = { id: "root", parentId: null, label, detail, evidence, children: [] };
  const cached = { root: rootNode, nodes: [rootNode], title: label };
  const before = JSON.stringify(cached);
  const scene = MindmapV2.layout(cached);
  assert.equal(scene.entries[0].node.label, "Cxcr4⁻/⁻ 与 H₂O");
  assert.equal(scene.entries[0].node.detail, "cm⁻¹，xᵢ < 5 × 10²");
  const svg = MindmapV2.svgForMap(cached);
  assert(svg.includes("Cxcr4⁻/⁻") && svg.includes("H₂O") && svg.includes("10²"));
  assert(!svg.includes("&lt;sup&gt;") && !svg.includes("&lt;sub&gt;"));
  assert.equal(JSON.stringify(cached), before, "rendering old caches must not mutate stored labels or verbatim evidence");
  assert.equal(scene.entries[0].node.evidence[0].quote, quote);
  const chart = { direction: "TB", nodes: [{ id: "root", type: "process", role: "other", label, detail, evidence }], edges: [{ from: "root", to: "root", label: "温度 &ge; 10<sup>2</sup>" }] };
  const chartBefore = JSON.stringify(chart);
  const source = Flowchart.mermaidSource(chart);
  assert(source.includes("Cxcr4⁻/⁻ 与 H₂O") && source.includes("cm⁻¹") && source.includes("温度 ≥ 10²"));
  assert.equal(JSON.stringify(chart), chartBefore, "flowchart display adaptation must leave old caches intact");
  assert.equal(U.diagramDisplayText("<SUP>2</SUP> &lt;sub&gt;2&lt;/sub&gt; &#215; &#xB1;"), "² ₂ × ±");
  assert.equal(U.diagramDisplayText("x<sup>alpha</sup> y<sub>中文</sub>"), "x^(alpha) y_(中文)");
  assert.equal(U.diagramDisplayText("a_b x^2 $x_i$ <img src=x> &unknown; &#0; &#xD800;"), "a_b x^2 $x_i$ <img src=x> &unknown; &#0; &#xD800;",
    "plain identifiers, LaTeX, unknown markup and invalid entities must remain literal text");
}

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
  const webMarkdown = MindmapV2.parse(`# 论文核心
## 研究问题
- **研究缺口**：待解决的问题
  - **具体表现**：可核对的细节
> [^quote: The  exact source sentence.]
## 结果
- **主要发现**：关键结果`, { allowMarkdown: true });
  assert(!webMarkdown.error
    && webMarkdown.root.children[0].children[0].children[0].label === "具体表现"
    && webMarkdown.root.children[0].children[0].children[0].evidence[0].quote === "The  exact source sentence.",
  "web Markdown mind maps must retain nested nodes and verbatim evidence quotes");
  const longWebOutline = ["# 论文完整知识结构图", ...Array.from({ length: 11 }, (_, branch) =>
    [`## 分支 ${branch + 1}`, ...Array.from({ length: branch < 9 ? 5 : 4 }, (_, node) => `- **节点 ${node + 1}**：具体事实`)]).flat()].join("\n");
  const longWebMap = MindmapV2.parse(longWebOutline, { allowMarkdown: true });
  assert(!longWebMap.error && longWebMap.nodes.length === 65 && MindmapV2.svgForMap(longWebMap).startsWith("<svg"),
    "web mind maps with 65 nodes must parse and render rather than disappear at the old limit");
  const fullOutline = ["# 长文献", "## 研究细节", ...Array.from({ length: 9998 }, (_, index) => `- 事实 ${index}`)].join("\n");
  const fullMap = MindmapV2.parse(fullOutline, { allowMarkdown: true });
  assert(!fullMap.error && fullMap.nodes.length === 10000, "long-document Markdown maps must retain all 10,000 nodes");
  assert.equal(MindmapV2.layout(fullMap).entries.length, 10000, "layout must retain every node at the enlarged limit");
  assert.equal((MindmapV2.svgForMap(fullMap).match(/<text /g) || []).length, 10000, "SVG export must retain every node at the enlarged limit");
  const fullJSON = { version: 2, nodes: fullMap.nodes.map(({ children, ...node }) => node) };
  assert.equal(MindmapV2.parse(`${MindmapV2.MARKER}\n${JSON.stringify(fullJSON)}`).nodes.length, 10000,
    "API JSON maps must accept the same enlarged limit as Markdown maps");
  fullJSON.nodes.push({ id: "extra", parentId: "root", label: "额外节点" });
  assert(MindmapV2.parse(`${MindmapV2.MARKER}\n${JSON.stringify(fullJSON)}`).error, "JSON maps above 10,000 nodes must fail explicitly");
  assert(MindmapV2.parse(`${fullOutline}\n- 额外节点`, { allowMarkdown: true }).error, "Markdown maps above 10,000 nodes must fail explicitly");
  const legacyMap = Mindmap.parseMarkdownMindmap(`${Mindmap.MARKER}\n${fullOutline}`);
  assert.equal(legacyMap.root.children[0].children.length, 9998, "legacy Markdown maps must retain long-document nodes without the old 80-node cutoff");
  assert.equal(MindmapV2.parse("# 普通回答\n## 一般说明\n- 项目一\n- 项目二"), null, "ordinary Markdown must not become a V2 mind map");
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
  const webMarkdown = Flowchart.parseFlowchart(`# 研究逻辑与证据链
## 研究问题
- **问题**：待解决的问题
> [^evidence: The  exact source sentence.]
## 结论
- **结论**：适用边界`, { allowMarkdown: true });
  assert(!webMarkdown.error && webMarkdown.nodes.find(node => node.evidence?.[0])?.evidence[0].quote === "The  exact source sentence.", "web Markdown flowcharts must parse evidence quotes verbatim");
  const branchedMarkdown = Flowchart.parseFlowchart(`# 研究逻辑与证据链
## 问题与缺口
- **问题**：待解决的问题
## 核心设计
### 路径 A：核心方法
- **机制**：处理关键瓶颈的方法
### 路径 B：对照实验
- **比较**：与基线方法的差异
## 汇合结论
- **结论**：两条证据共同支持的判断`, { allowMarkdown: true });
  const design = branchedMarkdown?.nodes.find(node => node.label === "核心设计");
  const pathA = branchedMarkdown?.nodes.find(node => node.label === "路径 A：核心方法");
  const pathB = branchedMarkdown?.nodes.find(node => node.label === "路径 B：对照实验");
  const resultA = branchedMarkdown?.nodes.find(node => node.label === "机制");
  const resultB = branchedMarkdown?.nodes.find(node => node.label === "比较");
  const convergence = branchedMarkdown?.nodes.find(node => node.label === "汇合结论");
  const hasEdge = (from, to) => branchedMarkdown?.edges.some(edge => edge.from === from?.id && edge.to === to?.id);
  assert(!branchedMarkdown?.error && design && pathA && pathB && resultA && resultB && convergence
    && hasEdge(design, pathA) && hasEdge(design, pathB)
    && hasEdge(resultA, convergence) && hasEdge(resultB, convergence),
  "web Markdown flowcharts must preserve parallel branches and converge at the next stage");
  assert.equal(Flowchart.parseFlowchart("# 普通回答\n## 一般说明\n- 项目一\n- 项目二"), null, "ordinary Markdown must not become a flowchart");
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

function testDiagramContentPreservation() {
  const evidence = Array.from({ length: 9 }, (_, index) => ({ type: "quote", quote: `${index}: ${"Original evidence. ".repeat(50)}`.trim() }));
  const longID = `n${"long_identifier_".repeat(5)}`;
  const label = "完整知识描述".repeat(100), detail = "文献直接支持的研究条件与结果。".repeat(100);
  const nodes = Array.from({ length: 20 }, (_, index) => ({
    id: index === 19 ? longID : `n${index}`, parentId: index ? `n${index - 1}` : null,
    label: index === 19 ? label : `层级 ${index}`, detail, evidence
  }));
  const map = MindmapV2.parse(`${MindmapV2.MARKER}\n${JSON.stringify({ version: 2, nodes })}`);
  assert(!map.error, "deep model-produced maps must not be rejected by the old five-level limit");
  assert.equal(map.nodes.at(-1).label, label);
  assert.equal(map.nodes.at(-1).detail, detail);
  assert.equal(map.nodes.at(-1).evidence.length, 9);
  assert.equal(MindmapV2.layout(map).entries.length, 20);
  const svg = MindmapV2.svgForMap(map);
  assert.equal((svg.match(/<text /g) || []).length, 20);
  assert(context.LitMTrans.DiagramCache.build({ taskType: "paper_mindmap", mode: "mindmap", diagram: map }),
    "deep maps and all evidence must remain cache-compatible");
  const headingMap = MindmapV2.parse("# 主题\n## 方法\n### 实验\n#### 条件\n- 参数\n  - 结果\n    - 解释\n      - 边界", { allowMarkdown: true });
  assert(!headingMap.error);
  assert.equal(headingMap.root.children[0].children[0].children[0].label, "条件", "nested Markdown headings must retain their parent relationships");
  const quoteMap = MindmapV2.parse(`# 主题\n## 方法\n- ${label}\n${evidence.map(item => `> [^quote: ${item.quote}]`).join("\n")}`, { allowMarkdown: true });
  assert.equal(quoteMap.nodes.at(-1).evidence.at(-1).quote, evidence.at(-1).quote, "Markdown evidence must not be cut at 500 characters or six quotes");
  const legacy = Mindmap.parseMarkdownMindmap(`${Mindmap.MARKER}\n# 主题\n## 方法\n- 一\n  - 二\n    - 三\n      - 四`);
  assert.equal(legacy.root.children[0].children[0].children[0].children[0].children[0].label, "四");

  const flowNodes = Array.from({ length: 150 }, (_, index) => ({ id: `n${index}`, type: "process", label, detail, evidence }));
  const edges = Array.from({ length: 600 }, (_, index) => ({ from: `n${index % 150}`, to: `n${(index + 1) % 150}`, label: "模型给出的完整关系说明".repeat(8) }));
  const flow = Flowchart.parseFlowchart(`${Flowchart.V2_MARKER}\n${JSON.stringify({ version: 2, nodes: flowNodes, edges })}`);
  assert(!flow.error && flow.nodes.length === 150 && flow.edges.length === 600, "flowcharts must exceed both the old node and edge caps");
  assert.equal(flow.nodes[0].label, label);
  assert.equal(flow.nodes[0].detail, detail);
  assert.equal(flow.nodes[0].evidence.length, 9);
  assert.equal(flow.edges[0].label, edges[0].label);
  assert(Flowchart.mermaidSource(flow).includes(`${label}：${detail}`), "Mermaid source must retain complete node text beyond the old 260-character limit");
  assert(context.LitMTrans.DiagramCache.build({ taskType: "paper_logic_flow", mode: "flowchart", diagram: flow }));
  const webFlow = Flowchart.parseFlowchart(`# 研究逻辑\n## 核心设计\n${Array.from({ length: 150 }, (_, index) => `- 步骤 ${index}`).join("\n")}`, { allowMarkdown: true });
  assert(!webFlow.error && webFlow.nodes.length === 151 && webFlow.edges.length === 150);
  const longWebFlow = Flowchart.parseFlowchart(`# 研究逻辑\n## 核心设计\n- **${label}**：${detail}\n> [^quote: ${evidence[0].quote}]`, { allowMarkdown: true });
  assert.equal(longWebFlow.nodes[1].label, label);
  assert.equal(longWebFlow.nodes[1].detail, detail);
  assert.equal(longWebFlow.nodes[1].evidence[0].quote, evidence[0].quote);
}

function testWebMindmapHierarchyRecovery() {
  const source = "# 研究地图\n## 适用边界与局限\n- **条件性敲除的边界**：\n\n- 仅敲除指定谱系。\n- 尚未评估应激条件。\n- **人类样本的边界**：\n\n- 仅覆盖两个阶段。\n- **后续建议**：开展独立验证。\n## 研究结果\n- 主要发现";
  const map = MindmapV2.parse(source, { allowMarkdown: true });
  assert(!map.error);
  const branch = map.root.children[0];
  assert.equal(branch.children.length, 3, "colon-only bold headings must group subsequent unindented facts rather than become peer leaves");
  assert.equal(branch.children[0].detail, "", "group headings must not display a stray colon");
  assert.equal(branch.children[0].children.length, 2);
  assert.equal(branch.children[1].children[0].label, "仅覆盖两个阶段。");
  assert.equal(branch.children[2].detail, "开展独立验证。", "a complete title/detail node must end inferred grouping");
  assert.equal(map.root.children[1].children[0].label, "主要发现", "grouping must not leak across headings");
  const cachedNodes = [
    { id: "root", parentId: null, label: "研究地图", detail: "", evidence: [] },
    { id: "branch", parentId: "root", label: "适用边界", detail: "", evidence: [] },
    { id: "group", parentId: "branch", label: "条件性敲除的边界", detail: "：", evidence: [] },
    { id: "fact", parentId: "branch", label: "Cxcr4<sup>-/-</sup> 与 H<sub>2</sub>O", detail: "", evidence: [{ type: "quote", quote: "The original evidence." }] },
    { id: "next", parentId: "branch", label: "人类样本的边界", detail: ":", evidence: [] },
    { id: "nextfact", parentId: "branch", label: "仅覆盖两个阶段。", detail: "", evidence: [] }
  ];
  const cached = MindmapV2.parse(`${MindmapV2.MARKER}\n${JSON.stringify({ version: 2, nodes: cachedNodes })}`);
  const before = JSON.stringify(cached);
  const adapted = MindmapV2.adaptMap(cached);
  assert.equal(adapted.root.children[0].children.length, 2);
  assert.equal(adapted.root.children[0].children[0].children[0].id, "fact");
  assert.equal(adapted.nodes.find(node => node.id === "fact").label, "Cxcr4⁻/⁻ 与 H₂O");
  assert.equal(adapted.nodes.find(node => node.id === "fact").evidence[0].quote, "The original evidence.");
  assert.equal(JSON.stringify(cached), before, "runtime recovery must preserve the original cache data and node IDs");
  assert.equal(MindmapV2.layout(cached).entries.find(entry => entry.node.id === "fact").parent.node.id, "group");
  assert.equal(MindmapV2.layout(cached).entries.find(entry => entry.node.id === "nextfact").parent.node.id, "next");
}

function testDeepSeekNestedListExtraction() {
  const source = fs.readFileSync(path.join(root, "src/deepseek-web/content-script.js"), "utf8");
  const start = source.indexOf("        function domToMarkdown(");
  const end = source.indexOf("\n\n        let text =", start);
  assert(start >= 0 && end > start);
  const text = value => ({ nodeType: 3, nodeValue: value });
  const element = (tagName, ...childNodes) => ({
    nodeType: 1, tagName, className: "", childNodes,
    children: childNodes.filter(node => node.nodeType === 1),
    cloneNode() { return this; }, closest() { return null; }, querySelectorAll() { return []; }
  });
  const rootNode = element("div", element("h1", text("研究地图")), element("h2", text("适用边界")),
    element("ul", element("li", element("p", element("strong", text("条件性敲除的边界")), text("：")),
      element("ul", element("li", text("仅敲除指定谱系。")), element("li", text("尚未评估应激条件。"))))));
  const markdown = vm.runInNewContext(`(${source.slice(start, end).trim()})(rootNode)`, { rootNode });
  assert(markdown.includes("  - 仅敲除指定谱系。"), "DeepSeek DOM extraction must indent nested list items");
  const map = MindmapV2.parse(markdown, { allowMarkdown: true });
  assert(!map.error && map.root.children[0].children[0].children.length === 2, "real extracted nested lists must retain their grouping when parsed");
  const orderedRoot = element("div", element("h1", text("研究地图")), element("h2", text("研究方法")),
    element("ol", element("li", text("实验"), element("ol", element("li", text("参数"))))));
  const ordered = vm.runInNewContext(`(${source.slice(start, end).trim()})(rootNode)`, { rootNode: orderedRoot });
  assert(ordered.includes("   1. 参数"), "ordered-list continuation indent must account for the marker width");
  const orderedMap = MindmapV2.parse(ordered, { allowMarkdown: true });
  assert(!orderedMap.error && orderedMap.root.children[0].children[0].children[0].label === "参数");
  const orderedFlow = Flowchart.parseFlowchart(ordered, { allowMarkdown: true });
  assert(!orderedFlow.error && orderedFlow.nodes.length === 3, "research workflows must also retain extracted ordered-list nodes");
  assert(orderedFlow.edges.some(edge => edge.from === orderedFlow.nodes[1].id && edge.to === orderedFlow.nodes[2].id));
  const flow = Flowchart.parseFlowchart("# 研究逻辑\n## 核心设计\n- **路径 A**：\n- 事实 A1\n- 事实 A2\n- **路径 B**：\n- 事实 B1\n## 汇合结论\n- 结论", { allowMarkdown: true });
  assert(!flow.error);
  const find = label => flow.nodes.find(node => node.label === label);
  const hasEdge = (from, to) => flow.edges.some(edge => edge.from === find(from).id && edge.to === find(to).id);
  assert.equal(find("路径 A").detail, "", "empty workflow group descriptions must not render a colon");
  assert(hasEdge("核心设计", "路径 A") && hasEdge("核心设计", "路径 B"));
  assert(hasEdge("路径 A", "事实 A1") && hasEdge("路径 A", "事实 A2") && hasEdge("路径 B", "事实 B1"));
  assert(hasEdge("事实 A1", "汇合结论") && hasEdge("事实 A2", "汇合结论") && hasEdge("事实 B1", "汇合结论"),
    "recovering workflow groups must preserve convergence from every evidence branch");
}

async function testFlowchartExportCache() {
  let renders = 0, config, fail = false;
  const rendererContext = {
    btoa: value => Buffer.from(value, "binary").toString("base64"),
    DOMParser: class { parseFromString() { return { documentElement: { localName: "parsererror" } }; } },
    mermaid: {
    initialize(value) { config = value; },
    async render() { renders++; if (fail) throw new Error("render failed"); return { svg: "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>" }; }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/flowchart.js"), "utf8"), rendererContext);
  const renderer = rendererContext.LitMTrans.Flowchart;
  assert.equal(rendererContext.LitMTrans.DiagramCache, undefined, "workbench rendering must work without host-only cache scripts");
    const chart = { direction: "LR", nodes: [{ id: "export_cache", type: "process", label: "复用渲染", role: "other" }], edges: [] };
    const [first, second] = await Promise.all([renderer.imageForChart(chart), renderer.imageForChart(chart)]);
    assert.strictEqual(first, second, "viewer export and rendering must share the same generated asset");
    assert.equal(renders, 1);
    assert.equal(config.maxTextSize, context.LitMTrans.DiagramCache.MAX_CHARS);
    assert.equal(config.maxEdges, 100000, "Mermaid's hidden 500-edge limit must also be enlarged");
    assert(first.dataURL.startsWith("data:image/svg+xml;base64,"));
    chart.nodes[0].label = "重试绘图";
    fail = true;
    await assert.rejects(renderer.imageForChart(chart), /render failed/);
    fail = false;
    assert((await renderer.imageForChart(chart)).dataURL, "a failed render must allow retry rather than poison the cache");
}

async function testDiagramViewerExport() {
  const elements = new Map();
  const makeElement = () => ({
    style: {}, handlers: {}, disabled: false, open: false,
    addEventListener(name, handler) { this.handlers[name] = handler; },
    querySelector() { return null; }, replaceChildren() {},
    appendChild(child) { this.firstElementChild = child; },
    show() { this.open = true; }, close() { this.open = false; }
  });
  for (const id of ["dialog", "stage", "title", "export", "close"]) elements.set(`diagram-viewer-${id}`, makeElement());
  let generated = 0, exported = 0, errors = [];
  const image = { dataURL: "data:image/svg+xml;base64,PHN2Zy8+", name: "流程图.svg" };
  const sandbox = {
    LitMTrans: { Flowchart: { renderInteractive() {}, async imageForChart() { generated++; return image; } } },
    document: { getElementById(id) { return elements.get(id) || null; }, createElement: makeElement },
    requestAnimationFrame() {}, console: { error() {} }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/diagram-viewer.js"), "utf8"), sandbox);
  const viewer = sandbox.LitMTrans.DiagramViewer;
  viewer.init();
  const payload = { mode: "flowchart", diagram: {}, onExport(value) { assert.strictEqual(value, image); exported++; }, onError(error) { errors.push(error.message); } };
  viewer.open(payload);
  const button = elements.get("diagram-viewer-export");
  button.handlers.click(); button.handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(generated, 1);
  assert.equal(exported, 1, "cached flowcharts without an image must generate and export an asset");
  assert.equal(button.disabled, false);
  button.handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(generated, 1, "repeated export must reuse the active image");
  assert.equal(exported, 2);
  sandbox.LitMTrans.Flowchart.imageForChart = async () => { throw new Error("绘图失败"); };
  viewer.open({ ...payload, image: null });
  button.handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, ["绘图失败"], "render failures must produce user-visible feedback");
  assert.equal(button.disabled, false);
  let complete;
  sandbox.LitMTrans.Flowchart.imageForChart = () => new Promise(resolve => { complete = resolve; });
  viewer.open({ ...payload, image: null }); button.handlers.click();
  viewer.close(); complete(image);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(exported, 2, "closing the viewer while rendering must not open a stale save dialog");
}

async function testFilePickerCompatibility() {
  const controller = Object.create(context.LitMTrans.Controller.prototype);
  const original = { picker: context.Zotero.FilePicker, chrome: context.ChromeUtils, cc: context.Cc, ci: context.Ci, appinfo: context.Services.appinfo };
  const win = { document: {}, browsingContext: {} };
  let nextFile = "/tmp/selected", nextResult = 0, initializedTarget, filters;
  class FilePicker {
    constructor() { Object.assign(this, { returnOK: 0, returnCancel: 1, returnReplace: 2, modeSave: 1, modeOpen: 0, modeGetFolder: 2, filterAll: 1 }); this.file = nextFile; filters = []; }
    init(target) { initializedTarget = target; }
    appendFilter(title, pattern) { filters.push(pattern); }
    appendFilters(mask) { assert.equal(mask, 1); }
    async show() { return nextResult; }
    open(resolve) { resolve(nextResult); }
  }
  try {
    context.Zotero.FilePicker = FilePicker;
    assert.equal(await controller.selectImageExportPath(win, "图形.svg", "image/svg+xml"), "/tmp/selected.svg");
    assert.strictEqual(initializedTarget, win);
    assert.deepEqual(filters, ["*.svg"]);
    assert.equal(await controller.selectPDFExportPath(win, "文献"), "/tmp/selected.pdf");
    assert.equal(await controller.selectMarkdownExportPath(win, "文献"), "/tmp/selected.md");
    assert.equal(await controller.selectDirectoryExportPath(win, "目录"), "/tmp/selected");
    assert.equal(await controller.selectChatDocumentFile(win), "/tmp/selected");
    nextResult = 1;
    assert.equal(await controller.selectImageExportPath(win, "图形.svg", "image/svg+xml"), "");
    nextResult = 2; nextFile = "/tmp/replace.svg";
    assert.equal(await controller.selectImageExportPath(win, "图形.svg", "image/svg+xml"), nextFile);
    nextFile = "";
    await assert.rejects(controller.selectImageExportPath(win, "图形.svg", "image/svg+xml"), /path|路径/);
    context.Zotero.FilePicker = undefined;
    context.ChromeUtils = { importESModule(uri) { assert.equal(uri, "chrome://zotero/content/modules/filePicker.mjs"); return { FilePicker }; } };
    nextResult = 0; nextFile = "/tmp/imported.svg";
    assert.equal(await controller.selectImageExportPath(win, "图形.svg", "image/svg+xml"), nextFile, "standard Zotero module must work when Zotero.FilePicker is absent");
    context.ChromeUtils = { importESModule() { throw new Error("unavailable"); } };
    context.Ci = { nsIFilePicker: { modeSave: 1, returnOK: 0, returnReplace: 2, filterAll: 1 } };
    context.Cc = { "@mozilla.org/filepicker;1": { createInstance() { return new FilePicker(); } } };
    nextFile = { path: "/tmp/native.svg" };
    for (const version of ["115.0", "128.0", "140.0"]) {
      context.Services.appinfo = { platformVersion: version };
      assert.equal(await controller.selectImageExportPath(win, "图形.svg", "image/svg+xml"), nextFile.path);
      assert.strictEqual(initializedTarget, version === "115.0" ? win : win.browsingContext, "native FilePicker init must match the Gecko version's required parent type");
    }
  }
  finally {
    context.Zotero.FilePicker = original.picker; context.ChromeUtils = original.chrome;
    context.Cc = original.cc; context.Ci = original.ci; context.Services.appinfo = original.appinfo;
  }
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
    testDiagramDisplayCompatibility,
    testMindmap,
    testFlowchart,
    testDiagramContentPreservation,
    testWebMindmapHierarchyRecovery,
    testDeepSeekNestedListExtraction,
    testFlowchartExportCache,
    testDiagramViewerExport,
    testFilePickerCompatibility,
    testDiagramEvidenceMatching,
  };
};
