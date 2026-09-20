(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const U = LitMTrans.Utils;
  const C = LitMTrans.Constants;
  const MINDMAP_FORMAT_INSTRUCTION = "系统根据用户消息中的“思维导图 / 脑图 / mind map”等关键词附加了这条格式建议。请先按用户的真实意图判断是否确实要求绘制思维导图：若用户只是在讨论、引用或询问某个已有思维导图，而未要求你制作一张图，请忽略本格式建议，按正常文字回答，且不要输出任何标记。只有在用户明确希望你制作、生成、绘制或总结为思维导图时，才以思维导图格式回答：第一行必须是 <!-- litmtrans-mindmap -->；随后只输出 Markdown 层级大纲，使用一个一级标题作为中心主题、二级标题作为主分支、无序列表补充至多两层细节；每个节点必须是少于18个汉字的短语，不要完整句；不要使用代码块、Mermaid、HTML、引言或结语。";
  const FLOWCHART_FORMAT_INSTRUCTION = "系统根据用户消息中的“流程图 / 算法图 / flowchart / workflow”等关键词附加了这条格式建议。请先按用户的真实意图判断是否确实要求绘制流程图：若用户只是在讨论、引用或询问某个已有流程图，而未要求你制作一张图，请忽略本格式建议，按正常文字回答，且不要输出任何标记。只有在用户明确希望你制作、生成、绘制或总结为流程图时，才以流程图格式回答：第一行必须是 <!-- litmtrans-flowchart -->；随后只输出一个 JSON 对象，包含 direction（TB 或 LR）、nodes 和 edges。nodes 中每项必须为 {id,type,label}；type 只能是 terminator、process、decision、input、output、subprocess、database。edges 中每项必须为 {from,to,label?}，其中 from 和 to 必须逐字使用 nodes 中已声明的 id，不能使用节点 label；判断分支的 label 使用“是”“否”等简短文字，循环用指回条件节点的边表示。不要使用代码块、Mermaid、HTML 或其他文字。";
  const IMAGE_CITATION_INSTRUCTION = "需要引用论文图片时，每张图片必须另起一行，并且只使用以下完整格式：[图片来源：文档来源标签] ![IMAGE_xxx](images/image_xxx.ext)。来源标签必须逐字复制随文档给出的“图片来源标签”；Markdown 图片占位符也必须从该文档正文逐字复制。即使上文已经写过文档标题，每张图仍必须重复完整来源标签。来源标签必须放在图片占位符之前；不要把图片占位符放进粗体、斜体、代码或链接中；不要改写路径、自行编号或引用未提供的图片。正确示例：[图片来源：当前文献] ![IMAGE_001](images/image_001.jpg)。错误示例：![IMAGE_001](images/image_001.jpg) [图片来源：当前文献]。界面会依据这一整行显示本地图片。";

  const DEFAULT_KEY_POINTS_PROMPT = `你是一名科研文献要点提炼助手。你的任务是以尽可能少的信息，帮助科研读者快速判断：

* 这篇论文研究什么问题，前人方案卡在何处（Research Gap）；
* 作者提出了什么核心机制，如何解决该矛盾；
* 取得了什么经严格验证的关键结果，对比基线提升幅度如何；
* 这些结论在什么适用范围和条件下成立。

仅使用所提供文档中的信息。

在生成结果前，根据文档内容识别其研究类型，例如实验/观察研究、方法或工具论文、理论研究、系统综述或 Meta 分析、定性研究、数据或资源论文等。研究类型仅用于决定信息的重要性和四个分支的具体含义，不需要单独输出。

将论文要点提炼为中文思维导图。

中心主题固定为“论文核心”，并使用以下四个主分支：

* 问题：研究对象与核心假设。重点提炼前人代表性方案的缺陷或现有范式未解决的具体矛盾（Research Gap），避免泛泛罗列宏观大背景。
* 方法：作者获得核心证据的关键设计、模型、算法、材料或实验路线。重点说明克服上述瓶颈的核心机理，禁止单纯堆砌组件或模块名称。
* 结果：论文最重要的发现或经严格验证的结论。量化指标优先给出相对于主要基线（vs. Baseline/SOTA）的增益幅度或对照差异，避免缺乏参照系的孤立绝对值。
* 边界：研究实际覆盖的人群、数据分布、工况、场景、条件或理论假设，以及作者明确披露的重要局限、失效边界或证据不足之处。

不同研究类型按其实际内容理解上述分支：

* 实验或观察研究：重点关注研究设计、样本/对象、干预或比较、主要结局及不确定性。
* 方法、模型或工具论文：重点关注核心机制创新、与什么基线比较、在哪些任务或数据上验证，以及性能成立的前提条件。
* 理论研究：方法包括核心公理与假设、推导或证明思路；结果包括主要定理、理论推论及成立条件。
* 系统综述或 Meta 分析：方法重点关注检索、纳入和综合方式；结果重点关注综合效应量、异质性及证据确定性。
* 定性研究：方法重点关注研究对象、资料收集和分析方式；结果重点关注核心主题、模式或解释机制。
* 数据、材料或资源论文：方法重点关注资源如何构建和清洗验证；结果重点关注资源规模、质量、覆盖范围和验证结果。

内容规则：

1. 每个节点只表达一个核心信息，不合并互不相关的发现。
2. 每个主分支通常保留一至三个关键节点；必要时方法和结果可增加一层子节点。
3. 总节点通常控制在八至十四个，最多十六个。不得为了达到节点数量而补充次要信息。
4. 优先保留最能体现论文新增贡献的内容。独立贡献通常保留最重要的两项；只有第三项同样属于论文核心时才保留。
5. 数字只有在影响效应大小、比较判断、可信程度或适用条件时优先保留。
6. 保留关键数字时，必须指明指标、单位、比较对象（如对比基线名称）或实验条件，杜绝无参照系孤立数字。
7. 优先保留会改变结果解释的信息，例如样本或数据范围、主要基线、评价条件、效应大小、不确定性、置信区间或统计显著性。
8. 痛点对齐与机制对应：方法分支提炼的核心机制，必须与问题分支指出的前人缺陷形成逻辑呼应，点明其为何能突破瓶颈。
9. 剔除宣传修辞：删除“开创性的”、“卓越的”、“前所未有的”等主观宣传用词，仅保留客观机理、对比幅度与可信证据。
10. 不得把相关性表述为因果关系，不得扩大作者结论的适用范围，不得删除会实质改变结论含义的限定词。
11. 公式、模型名称、参数、材料、设备、数据集或软件名称，仅在理解核心贡献、证据或复现条件所必需时保留。
12. “边界”可以根据研究设计直接说明研究实际覆盖的对象和条件，但不得自行推导作者未提出的缺陷、风险或批评。
13. 作者明确说明的局限可以直接提炼；未明确说明的局限不得自行补充。
14. 仅使用文档明确支持的信息，不使用外部知识，不猜测作者意图。
15. 对于本应与理解论文核心有关、但文档确实未提供的信息，使用“文档未明确”；对于该研究类型本身不适用的事项，不要使用“文档未明确”强行填充。
16. 如果 PDF/OCR/公式/表格/图注等解析异常导致某项内容无法可靠确认，在受影响节点末尾添加“[解析存疑]”。不要用该标记表示论文自身的不确定性。
17. 不提供一般背景综述、逐章节复述、扩展教学解释、建议、未来工作、引言或结语。
18. 不以不同措辞重复同一信息。
19. 在最终输出前检查每个节点：必须能在文档中找到直接支持；若无法找到，删除或改为“文档未明确”。
20. 输出格式严格遵循系统附加的思维导图格式要求。

信息取舍的优先级依次为：

核心贡献与主要结论 ＞ 影响结论解释的证据与条件 ＞ 核心方法机理 ＞ 适用范围与重要局限 ＞ 次要实验和实现细节。`;
  const DIAGRAM_CHINESE_INSTRUCTION = "语言要求：除 evidence 中逐字引用的 quote 必须保持论文原文外，title、所有节点的 label/detail、以及边的可见 label 必须使用简体中文。专业名词可在中文后保留必要的英文名称或缩写，但不得因为论文或上下文原文是英文而输出整句英文。协议字段 id、kind、type、role、relation 仍按协议使用英文值。";
  const EVIDENCE_JSON_ESCAPE_INSTRUCTION = "evidence quote 必须逐字保留原文；如果原文包含反斜杠，必须按照 JSON 字符串规则写成两个反斜杠，解析后仍还原为一个原文反斜杠。";
  const MINDMAP_V2_FORMAT_INSTRUCTION = `只输出图形协议：第一行必须是 <!-- litmtrans-mindmap-v2 -->，随后只输出一个 JSON 对象。对象必须包含 version:2、mode、title、nodes。nodes 只有一个 parentId 为 null 的 root；每个节点必须有唯一 ASCII id、parentId、包含完整表达语义的 label、可选 detail、kind、importance(1-3)、可选 evidence(必须是对象数组)。注意：图表引擎不支持渲染 LaTeX，请绝对不要在 label 和 detail 中使用任何 LaTeX 公式或反斜杠转义符号，必须全部使用纯文本或 Unicode 字符替代（例如用 H₂O 代替公式写法，用 cm⁻¹ 代替复杂的物理单位公式）。${EVIDENCE_JSON_ESCAPE_INSTRUCTION}不得输出 Markdown、代码围栏、颜色、SVG 或任何额外文字。${DIAGRAM_CHINESE_INSTRUCTION}`;
  const FLOWCHART_V2_FORMAT_INSTRUCTION = `只输出图形协议：第一行必须是 <!-- litmtrans-flowchart-v2 -->，随后只输出一个 JSON 对象。对象必须包含 version:2、mode、title、layout、nodes、edges。节点有唯一 ASCII id、type、role、包含完整表达语义的 label (必须且只能叫 label，不能用其他字段名)、可选 detail、importance(1-3)、可选 evidence(必须是对象数组)。注意：图表引擎不支持渲染 LaTeX，请绝对不要在节点 label/detail 或边的可见 label 中使用任何 LaTeX 公式或反斜杠转义符号，必须全部使用纯文本或 Unicode 字符替代（例如用 H₂O 代替公式写法，用 cm⁻¹ 代替复杂的物理单位公式）。${EVIDENCE_JSON_ESCAPE_INSTRUCTION}type 只可为 terminator/process/decision/io/subprocess/database/document，role 只表达科研角色。边必须有 from/to/relation 和可选短 label。不得输出 Markdown、代码围栏、颜色、SVG 或任何额外文字。${DIAGRAM_CHINESE_INSTRUCTION}`;
  const WEB_MINDMAP_FORMAT_INSTRUCTION = `网页自动注入模式只输出可读的 Markdown 结构化笔记，不输出 JSON、Mermaid、代码围栏或解释性前后文。使用一个一级标题作为中心主题、二级标题作为主分支、无序列表作为节点；列表项使用“**节点标题**：具体事实”格式，关键节点下一行可附一条逐字原文证据，格式为“> [^quote: 原文]”。节点应保留关键数字、条件、比较对象和结论边界，不要把论文目录直接当作分支。示例：
# 论文核心
## 研究问题
- **研究缺口**：论文明确指出的待解决问题
> [^quote: The exact source sentence.]
## 核心结果
- **主要发现**：结果、指标及成立条件。`;
  const WEB_FLOWCHART_FORMAT_INSTRUCTION = `网页自动注入模式只输出可读的 Markdown 研究逻辑大纲，不输出 JSON、Mermaid、代码围栏或解释性前后文。请把论文画成“阶段—并行路径—汇合判断”的有向论证图，而不是一条从上到下的线：
1. 使用一个一级标题作为流程主题；每个二级标题（##）表示一个按论证推进的阶段或汇合点，例如问题与缺口、核心设计、并行证据、结论与边界。
2. 同一个二级阶段下，如果论文存在不同实验、对照组、消融、参数条件、机制解释或相互独立的证据，必须为每条真实路径使用一个三级标题（###）。同级三级标题是并行分支，不能写成连续的“然后……再……”；下一个二级标题才表示这些分支汇合后的判断。
3. 事实写在标题下的无序列表中，使用“**节点标题**：具体对象、条件、数值、比较和结论”格式。三级分支下至少保留一个有实际信息的列表节点；不要为了好看凭空制造分支。若论文确实只有单一路径，才使用单线结构。
4. 关键节点下一行可附一条逐字原文证据，格式为“> [^quote: 原文]”。证据必须紧跟它支持的节点，不能翻译、改写或编造。

示例（三级标题表示并行，最后一个二级标题表示汇合）：
# 研究逻辑与证据链
## 1. 问题与缺口
- **研究问题**：论文要解决的具体问题与现有方法缺口
## 2. 核心设计
### 路径 A：核心方法
- **机制**：方法如何处理关键瓶颈
> [^quote: The exact source sentence.]
### 路径 B：对照或替代方案
- **比较对象**：与基线/替代设计的差异
## 3. 并行证据与验证
### 实验结果
- **结果**：在具体数据和条件下得到的指标
### 消融或稳健性
- **边界证据**：去除组件或改变条件后的变化
## 4. 汇合结论与边界
- **结论**：哪些证据共同支持结论，以及结论的适用条件。`;
  const WEB_DIAGRAM_CONTENT_INSTRUCTION = "网页模式覆盖：上文的内容取舍要求仍然有效，但不要输出 evidence JSON、LitMTrans 内部标记、Mermaid 或其他协议字段；所有节点和逐字证据必须改用下方 Markdown 格式表达。";
  const PAPER_MINDMAP_TASK_INSTRUCTION = "为当前论文建立完整科研认知地图。先判断论文类型，再围绕核心问题或贡献组织树：研究背景/缺口、问题或假设、设计与关键方法、数据或证据、主要结果、机制或推理、验证与比较、贡献、适用边界。不要把目录或 Introduction/Methods/Results/Discussion 当作分支；用 25–55 个有价值节点（短文可更少），3–4 层为主，label 应包含完整的知识认知要点，无需刻意简短或拆分；原始证据放入 evidence。为最重要的结果、方法、结论或边界节点补充 evidence：使用 {type:\"quote\",quote:\"…\"}，quote 必须逐字复制当前文献原文语言的短句，不能翻译、改写或编造；没有可靠短句时留空。只使用文献直接支持的信息。";
  const PAPER_LOGIC_FLOW_TASK_INSTRUCTION = "重建当前论文的研究逻辑与证据链，而不是章节目录、摘要路线图或只有‘方法—验证—结论’的空泛框架。根据论文类型组织从背景/痛点、缺口、研究问题或假设、核心设计、关键证据、结果、推理/机制、结论到边界的有向关系；边优先表达 motivates/tests/produces/supports/explains/validates/limits。通常保留 10–24 个有实际信息的节点，必要时把并行实验、对照组、消融、参数变化和相互矛盾的证据拆成独立分支后汇合。每个节点都必须回答一个具体问题：做了什么、在什么条件下、得到什么结果、支持或限制什么判断；除纯背景/问题节点外必须填写 detail，用一至三句保留关键对象、方法配置、样本或工况、数值指标、比较基线、方向与幅度、失败条件或适用阈值。禁止使用‘开展实验’‘验证与对比’‘获得结果’‘得出结论’等没有对象和结果的空洞节点；label 可以简洁，但 detail 必须直接呈现实际干货，不能把节点信息藏进点击展开区。每个包含论文事实的节点都必须补充至少一条原文逐字 evidence quote，格式为 {type:\"quote\",quote:\"…\"}；只有纯粹用于组织关系、且论文中没有对应原句的节点可以没有 evidence。不要把多个不同结果压缩成一个总结节点。只有真实条件判断才使用 decision，绝不为了装饰滥用菱形或数据库。quote 必须逐字复制当前文献原文语言的短句，不能翻译、改写、拼接或编造，不能可靠逐字引用时不要编造。只使用文献直接支持的信息。";
  const GENERIC_MINDMAP_TASK_INSTRUCTION = "把用户明确要求整理的内容转换成一张层级清晰的语义思维导图。保留用户指定的范围，不套用论文目录。label 应直接包含完整的知识描述，无需拆分到 detail。";
  const GENERIC_FLOWCHART_TASK_INSTRUCTION = "把用户明确要求的过程、算法、计划或研究逻辑转换成真实有向流程图。节点形状只表达流程语义，边表达实际关系；不要为视觉效果制造无依据分支。";
  const KEY_POINTS_SYSTEM_PROTOCOL = "这是要点提炼任务（系统内部协议）：严格根据上述要点提炼要求与倾向生成内容。为最重要的结果或结论补充原文逐字 evidence quote（{type:\"quote\",quote:\"…\"}），quote 必须逐字复制当前文献原文语言的短句，不能翻译、改写或编造；不能可靠逐字引用时留空。用户的要点提炼要求指导内容提炼倾向与认知重点，图形协议与输出结构严格遵循系统附加的思维导图格式要求。";
  const KEY_POINTS_TASK_FRAME = KEY_POINTS_SYSTEM_PROTOCOL;
  const TASK_TYPES = new Set(["chat", "key_points", "paper_mindmap", "paper_logic_flow", "generic_mindmap", "generic_flowchart"]);
  function taskFor(options, settings) {
    let taskType = TASK_TYPES.has(String(options?.taskType || "")) ? String(options.taskType) : "chat";
    if (taskType === "chat" && options?.mindmap) taskType = "generic_mindmap";
    if (taskType === "chat" && options?.flowchart) taskType = "generic_flowchart";
    const keyPointsPrompt = String(settings?.keyPointsPrompt || DEFAULT_KEY_POINTS_PROMPT).trim();
    const frames = {
      key_points: `${keyPointsPrompt}\n\n${KEY_POINTS_SYSTEM_PROTOCOL}`,
      paper_mindmap: PAPER_MINDMAP_TASK_INSTRUCTION,
      paper_logic_flow: PAPER_LOGIC_FLOW_TASK_INSTRUCTION,
      generic_mindmap: GENERIC_MINDMAP_TASK_INSTRUCTION,
      generic_flowchart: GENERIC_FLOWCHART_TASK_INSTRUCTION
    };
    const diagramMode = ["key_points", "paper_mindmap", "generic_mindmap"].includes(taskType) ? "mindmap" : (["paper_logic_flow", "generic_flowchart"].includes(taskType) ? "flowchart" : "none");
    const frame = frames[taskType] || "";
    const hasExplicitTransport = Boolean(options?.engine || options?.aiMode || options?.provider);
    const isWeb = options?.aiMode === "web"
      || options?.engine === "deepseek_web"
      || options?.provider === "deepseek_web"
      || (!hasExplicitTransport && settings?.chatEngine === "deepseek_web");
    const taskInstruction = diagramMode === "none" || !frame
      ? frame
      : `${frame}\n\n${DIAGRAM_CHINESE_INSTRUCTION}${isWeb ? `\n\n${WEB_DIAGRAM_CONTENT_INSTRUCTION}` : ""}`;
    const formatInstruction = diagramMode === "mindmap"
      ? (isWeb ? WEB_MINDMAP_FORMAT_INSTRUCTION : MINDMAP_V2_FORMAT_INSTRUCTION)
      : (diagramMode === "flowchart"
        ? (isWeb ? WEB_FLOWCHART_FORMAT_INSTRUCTION : FLOWCHART_V2_FORMAT_INSTRUCTION)
        : "");
    return { taskType, taskInstruction, diagramMode, formatInstruction };
  }

  const IMAGE_MIME_EXTENSIONS = Object.freeze({
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
    "image/jp2": ".jp2",
    "image/svg+xml": ".svg",
  });
  const DIRECT_TEXT_EXTENSIONS = new Set([
    ".md", ".markdown", ".txt", ".text", ".log", ".csv", ".tsv", ".json", ".jsonl",
    ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".py", ".m", ".r",
    ".js", ".ts", ".jsx", ".tsx", ".css", ".scss", ".less", ".java", ".c", ".h",
    ".cpp", ".hpp", ".cc", ".cs", ".go", ".rs", ".php", ".rb", ".swift", ".kt",
    ".kts", ".sh", ".bash", ".bat", ".ps1", ".sql"
  ]);

  function decodeTextDocument(bytes) {
    const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    for (const encoding of ["utf-8", "gb18030"]) {
      try {
        return new TextDecoder(encoding, { fatal: true }).decode(source).replace(/^\uFEFF/, "");
      }
      catch (_) {}
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(source).replace(/^\uFEFF/, "");
  }

  function normalizeReferenceQuote(quote) {
    if (typeof quote === "string") quote = { type: "text", text: quote };
    if (!quote || typeof quote !== "object") return null;
    const type = ["text", "formula", "image"].includes(String(quote.type || "").toLowerCase())
      ? String(quote.type).toLowerCase()
      : "text";
    const text = String(quote.text || quote.formulaTex || quote.formula_tex || "").trim();
    if (!text) return null;
    const pageValue = Number(quote.page ?? quote.pageNumber ?? 0);
    return {
      type,
      text,
      formulaTex: String(quote.formulaTex || quote.formula_tex || ""),
      pane: ["source", "translation"].includes(String(quote.pane || "")) ? String(quote.pane) : "source",
      readerMode: ["stream", "layout", "zotero-reader"].includes(String(quote.readerMode || quote.reader_mode || ""))
        ? String(quote.readerMode || quote.reader_mode)
        : "",
      origin: ["workbench", "zotero-reader"].includes(String(quote.origin || ""))
        ? String(quote.origin)
        : "",
      page: Number.isFinite(pageValue) ? Math.max(0, pageValue) : 0,
      pageLabel: String(quote.pageLabel || quote.page_label || "").trim().slice(0, 40),
      blockID: String(quote.blockID || quote.blockId || quote.block_id || ""),
      imageSrc: String(quote.imageSrc || quote.image_src || ""),
      imageAlt: String(quote.imageAlt || quote.image_alt || "").slice(0, 240),
      nativePageIndex: Number.isFinite(Number(quote.nativePageIndex ?? quote.native_page_index))
        ? Math.max(0, Math.trunc(Number(quote.nativePageIndex ?? quote.native_page_index)))
        : null,
      title: String(quote.title || "").slice(0, 180),
      anchorRatio: Number.isFinite(Number(quote.anchorRatio ?? quote.anchor_ratio))
        ? Math.max(0, Math.min(1, Number(quote.anchorRatio ?? quote.anchor_ratio)))
        : null,
      anchorRect: quote.anchorRect || quote.anchor_rect || null,
      anchorPoint: quote.anchorPoint || quote.anchor_point || null,
      pdfReaderView: ["both", "source"].includes(String(quote.pdfReaderView || quote.pdf_reader_view || ""))
        ? String(quote.pdfReaderView || quote.pdf_reader_view)
        : "",
      pdfRects: (Array.isArray(quote.pdfRects || quote.pdf_rects) ? (quote.pdfRects || quote.pdf_rects) : [])
        .map(rect => ({ x: Number(rect?.x), y: Number(rect?.y), width: Number(rect?.width), height: Number(rect?.height) }))
        .filter(rect => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0)
        .map(rect => ({ x: Math.min(1, rect.x), y: Math.min(1, rect.y), width: Math.min(1, rect.width), height: Math.min(1, rect.height) })),
      pdfRawRects: (Array.isArray(quote.pdfRawRects || quote.pdf_raw_rects) ? (quote.pdfRawRects || quote.pdf_raw_rects) : [])
        .map(rect => Array.isArray(rect) ? rect.slice(0, 4).map(Number) : [])
        .filter(rect => rect.length === 4 && rect.every(Number.isFinite))
    };
  }

  function referenceQuoteIdentity(quote) {
    const item = normalizeReferenceQuote(quote);
    return item
      ? [item.type, item.origin, item.readerMode, item.pane, item.page, item.pageLabel, item.blockID, item.imageSrc, item.formulaTex || item.text].join("\u001f")
      : "";
  }

  function normalizeReferenceQuotes(quotes) {
    const source = Array.isArray(quotes) ? quotes : (quotes ? [quotes] : []);
    const output = [];
    const seen = new Set();
    for (const quote of source) {
      const normalized = normalizeReferenceQuote(quote);
      const identity = referenceQuoteIdentity(normalized);
      if (!normalized || !identity || seen.has(identity)) continue;
      seen.add(identity);
      output.push(normalized);
    }
    return output;
  }

  function normalizeBoolean(value, fallback = false) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "off", ""].includes(normalized)) return false;
    }
    return fallback;
  }

  function nonNegativeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, number) : fallback;
  }

  function normalizeLegacyContentParts(content) {
    if (!Array.isArray(content)) return [];
    return content.map(part => {
      if (typeof part === "string") return { type: "text", text: part };
      if (!part || typeof part !== "object") return null;
      if (["text", "input_text"].includes(String(part.type || ""))) {
        return { type: "text", text: String(part.text || "") };
      }
      if (part.type === "image_url") {
        const value = typeof part.image_url === "object" ? part.image_url?.url : part.image_url;
        return /^data:image\/(?:png|jpe?g|webp|gif|bmp|jp2|svg\+xml);base64,/i.test(String(value || ""))
          ? { type: "image_url", image_url: { url: String(value) } }
          : null;
      }
      return null;
    }).filter(Boolean);
  }

  function combinedReferenceText(quotes) {
    const rows = normalizeReferenceQuotes(quotes);
    if (!rows.length) return "";
    return rows.map((quote, index) => {
      const kind = quote.type === "formula" ? "公式" : (quote.type === "image" ? "图片" : "引用");
      const location = quote.pageLabel
        ? ` · 页码 ${quote.pageLabel}`
        : (quote.page ? ` · 第 ${quote.page} 页` : "");
      return `[${kind} ${index + 1}${location}]\n${quote.text}`;
    }).join("\n\n");
  }

  function messageTextForAPI(message) {
    const content = U.redactLocalPaths(String(message?.content || ""));
    const quoteText = combinedReferenceText(message?.referenceQuotes);
    const taskInstruction = message?.role === "user" ? String(message?.taskInstruction || "").trim() : "";
    const formatInstruction = message?.role === "user" ? String(message?.formatInstruction || "").trim() : "";
    const question = content.trim() || "请解释这段内容的含义，并结合全文说明它在论文中的作用。";
    const answer = quoteText ? (
      "用户引用了文档中的以下内容，请结合全文回答：\n\n" +
      `“${quoteText}”\n\n` +
      "用户问题：\n" +
      question
    ) : question;
    const task = taskInstruction ? `\n\n本轮任务：\n${taskInstruction}` : "";
    return formatInstruction ? `${answer}${task}\n\n输出格式要求：\n${formatInstruction}` : `${answer}${task}`;
  }

  const MERMAID_MINDMAP_INSTRUCTION = `请将分析结果输出为标准 Mermaid 横向全景架构图代码块：
\`\`\`mermaid
flowchart LR
  root[论文核心] --> gap[研究问题与缺口]
  gap --> method[核心方法与机制]
  method --> evidence[关键证据与结果]
  evidence --> boundary[结论与适用边界]
  classDef root fill:#304956,stroke:#1c303d,color:#ffffff,stroke-width:1.4px
  classDef stage fill:#f3f7f8,stroke:#758e9b,color:#183246,stroke-width:1.1px
  classDef result fill:#f0f6f3,stroke:#668777,color:#1e4030,stroke-width:1.2px
  class root root
  class gap,method stage
  class evidence,boundary result
\`\`\`。
要求：
1. 只输出 Mermaid 代码块，不输出解释、JSON、LitMTrans 内部标记或其他格式；
2. 使用 flowchart LR 的横向关系表达全景结构，节点使用精炼短语表达事实，重要数值和核心发现直接写入节点；
3. 保持低饱和学术配色，不要使用荧光色、HTML 标签、复杂样式或未声明的节点引用。`;

  const MERMAID_FLOWCHART_INSTRUCTION = `请将分析对象的研究逻辑与证据链条输出为标准 Mermaid 流程图代码块：
\`\`\`mermaid
flowchart LR
  problem[研究问题] --> method[核心方法]
  method --> evidence[关键证据]
  evidence --> conclusion[结论与边界]
  classDef stage fill:#f3f7f8,stroke:#758e9b,color:#183246,stroke-width:1.1px
  classDef result fill:#f0f6f3,stroke:#668777,color:#1e4030,stroke-width:1.2px
  class problem,method stage
  class evidence,conclusion result
\`\`\`。
要求：
1. 只输出 Mermaid 代码块，不输出解释、JSON、LitMTrans 内部标记或其他格式；
2. 使用 flowchart LR 的横向关系，真实反映从痛点/假设、方法验证、实验结果到结论边界的关系，边上使用简短动词标注；
3. 保持低饱和学术配色，不要使用荧光色、HTML 标签、复杂样式或未声明的节点引用。`;

  function clipboardTaskPrompt(taskType, settings) {
    // 仅复制模式：供用户复制到外部网页使用。为了在外部网页原生直接渲染出美观的图形，优先采用标准的 Mermaid 协议，杜绝内部代码或 JSON 裸奔。
    if (taskType === "key_points") {
      const keyPointsPrompt = String(settings?.keyPointsPrompt || DEFAULT_KEY_POINTS_PROMPT).trim();
      return `${keyPointsPrompt}\n\n${MERMAID_MINDMAP_INSTRUCTION}\n\n仅复制模式覆盖规则：不要输出 LitMTrans 内部标记、JSON 或其他格式；最终只输出上面的 Mermaid 代码块。`;
    }
    if (taskType === "paper_mindmap") {
      return `请基于当前论文内容，建立完整的科研全景认知地图。\n\n${MERMAID_MINDMAP_INSTRUCTION}`;
    }
    if (taskType === "paper_logic_flow") {
      return `请重建当前论文的研究逻辑与证据链条。\n\n${MERMAID_FLOWCHART_INSTRUCTION}`;
    }
    if (taskType === "generic_mindmap") {
      return `请根据用户当前输入的主题或内容，建立层级清晰的 Mermaid 思维导图。\n\n${MERMAID_MINDMAP_INSTRUCTION}`;
    }
    if (taskType === "generic_flowchart") {
      return `请根据用户当前输入的过程、算法或逻辑，建立真实反映关系的 Mermaid 流程图。\n\n${MERMAID_FLOWCHART_INSTRUCTION}`;
    }
    const task = taskFor({ taskType }, settings);
    return messageTextForAPI({
      role: "user",
      content: taskType === "key_points" ? "要点提炼" : "请分析当前文献。",
      ...task
    });
  }

  function normalizeAttachment(attachment, resourceResolver = null, includeDataURL = true) {
    if (!attachment || typeof attachment !== "object") return null;
    const mimeType = String(attachment.mimeType || attachment.type || "").toLowerCase();
    const relativePath = String(attachment.relativePath || "").replace(/\\/g, "/");
    if (!IMAGE_MIME_EXTENSIONS[mimeType] || !isSafeRelativePath(relativePath)) return null;
    const source = ["paste", "drop", "file", "reuse", "reader", "generated"].includes(String(attachment.source || ""))
      ? String(attachment.source)
      : "";
    const normalized = {
      id: String(attachment.id || U.randomID("image")),
      name: String(attachment.name || `image${IMAGE_MIME_EXTENSIONS[mimeType]}`).slice(0, 180),
      mimeType,
      relativePath,
      size: nonNegativeNumber(attachment.size),
      source,
      originalName: String(attachment.originalName || "").slice(0, 180),
      capturedAt: String(attachment.capturedAt || "").slice(0, 80),
      width: nonNegativeNumber(attachment.width),
      height: nonNegativeNumber(attachment.height),
      originalWidth: nonNegativeNumber(attachment.originalWidth),
      originalHeight: nonNegativeNumber(attachment.originalHeight),
      optimizedForVision: normalizeBoolean(attachment.optimizedForVision)
    };
    // Keep pasted-image data URLs in conversation history after a successful
    // reply. The file path is a recoverable cache, not the only source used to
    // recreate a turn.
    const dataURL = String(attachment.dataURL || attachment.data_url || "").trim();
    if (includeDataURL && dataURL) {
      try {
        const decoded = decodeImageDataURL(dataURL);
        if (decoded.mimeType === mimeType) normalized.dataURL = dataURL;
      }
      catch (_) {}
    }
    if (typeof resourceResolver === "function") normalized.url = resourceResolver(relativePath);
    return normalized;
  }

  function attachmentConversationReference(role, turnOrdinal, imageOrdinal) {
    const prefix = role === "assistant" ? "助手图片" : "用户图片";
    return `${prefix} ${Math.max(1, Number(turnOrdinal) || 1)}-${Math.max(1, Number(imageOrdinal) || 1)}`;
  }

  function attachmentTransportLabel(attachment, options = {}) {
    const reference = attachmentConversationReference(options.role, options.turnOrdinal, options.imageOrdinal);
    const timing = options.latest && options.role === "user"
      ? "当前最新一轮新增"
      : `第 ${Math.max(1, Number(options.turnOrdinal) || 1)} 轮`;
    const dimensions = attachment?.width && attachment?.height
      ? `；发送尺寸：${Math.trunc(attachment.width)}×${Math.trunc(attachment.height)}`
      : "";
    const optimization = attachment?.optimizedForVision ? "；已为视觉识别放大" : "";
    return {
      reference,
      text: (
        `===== ${timing}${options.role === "assistant" ? "助手输出图片" : "用户附加图片"} [${reference}] =====\n` +
        `文件名：${String(attachment?.name || "未命名图片")}${dimensions}${optimization}\n` +
        "请直接读取紧随其后的图片像素，不要只根据文件名、论文正文或更早轮次猜测。\n"
      )
    };
  }

  function isSafeRelativePath(value) {
    const path = String(value || "").replace(/\\/g, "/");
    if (!path || path.startsWith("/") || /^[A-Za-z]:(?:\/|$)/.test(path)) return false;
    const relative = path.replace(/^\/+/, "");
    return relative.split("/").every(part => part && part !== "." && part !== ".." && !part.includes("\0"));
  }

  function normalizeDocumentAttachment(document) {
    if (!document || typeof document !== "object") return null;
    const relativePath = String(document.markdownRelativePath || document.relativePath || "")
      .replace(/\\/g, "/");
    const rootRelativePath = String(document.rootRelativePath || "")
      .replace(/\\/g, "/");
    const originalRelativePath = String(document.originalRelativePath || "")
      .replace(/\\/g, "/");
    if (
      !relativePath.startsWith("chat/documents/")
      || !isSafeRelativePath(relativePath)
      || !rootRelativePath.startsWith("chat/documents/")
      || !isSafeRelativePath(rootRelativePath)
    ) return null;
    return {
      id: String(document.id || U.hashString(relativePath)),
      name: String(document.name || "未命名文档").slice(0, 180),
      markdownRelativePath: relativePath,
      rootRelativePath,
      charCount: nonNegativeNumber(document.charCount),
      imageCount: nonNegativeNumber(document.imageCount),
      originalRelativePath: originalRelativePath.startsWith("chat/documents/") && isSafeRelativePath(originalRelativePath)
        ? originalRelativePath
        : "",
      imageMap: (Array.isArray(document.imageMap) ? document.imageMap : []).map(record => ({
        id: String(record?.id || ""),
        alt: String(record?.alt || ""),
        cleanTarget: String(record?.cleanTarget || record?.clean_target || "").replace(/\\/g, "/").replace(/^\/+/, ""),
        warning: String(record?.warning || "")
      })).filter(record => isSafeRelativePath(record.cleanTarget))
    };
  }

  function normalizeDocumentOptions(options) {
    // Keep attachment and image ordering policies internal so UI overrides
    // cannot desynchronise the conversation from the reader.
    return {
      imageMode: "full_with_images",
      compressImages: true,
      sequentialImages: true
    };
  }

  function markdownImagePlaceholders(markdown) {
    const pattern = /!\[(?<alt>[^\]]*)\]\(\s*(?<target><[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/gs;
    return [...String(markdown || "").matchAll(pattern)].map(match => ({
      markdownRef: String(match[0] || ""),
      alt: String(match.groups?.alt || "").trim(),
      target: String(match.groups?.target || "").replace(/^<|>$/g, "").trim().replace(/\\/g, "/"),
      index: Number(match.index || 0)
    })).filter(item => item.markdownRef && item.target);
  }

  function imagePlaceholderKey(alt, target) {
    return `${String(alt || "").trim()}\u001f${String(target || "").trim().replace(/^<|>$/g, "").replace(/\\/g, "/")}`;
  }

  function normalizeCitedImage(citation, resourceResolver = null) {
    if (!citation || typeof citation !== "object") return null;
    const relativePath = String(citation.relativePath || "").replace(/\\/g, "/");
    if (!isSafeRelativePath(relativePath)) return null;
    const sourceType = citation.sourceType === "document" ? "document" : "current-document";
    const normalized = {
      id: String(citation.id || U.hashString(`${sourceType}:${relativePath}`)),
      sourceType,
      sourceDocumentID: String(citation.sourceDocumentID || ""),
      sourceDocumentName: String(citation.sourceDocumentName || (sourceType === "current-document" ? "当前文献" : "附加文档")).slice(0, 180),
      markdownRef: String(citation.markdownRef || "").slice(0, 1200),
      alt: String(citation.alt || "").slice(0, 240),
      target: String(citation.target || "").replace(/\\/g, "/").slice(0, 800),
      name: String(citation.name || relativePath.split("/").pop() || "论文图片").slice(0, 180),
      relativePath
    };
    if (typeof resourceResolver === "function") normalized.url = resourceResolver(relativePath);
    return normalized;
  }

  function normalizeMessage(message, resourceResolver = null) {
    if (!message || typeof message !== "object") return null;
    const role = String(message.role || "").toLowerCase();
    if (!["user", "assistant"].includes(role)) return null;
    const legacyContentParts = normalizeLegacyContentParts(message.content);
    const content = Array.isArray(message.content)
      ? (legacyContentParts
        .filter(part => typeof part === "string" || part?.type === "text" || part?.type === "input_text")
        .map(part => typeof part === "string" ? part : String(part.text || ""))
        .join("\n")
        .trim() || String(message.text || "").trim())
      : String(message.content ?? message.text ?? "").trim();
    const attachments = (Array.isArray(message.attachments) ? message.attachments : [])
      // Resource URLs are enough for the workbench preview. Do not send the
      // durable Base64 history back across the chrome/content bridge.
      .map(item => normalizeAttachment(item, resourceResolver, typeof resourceResolver !== "function")).filter(Boolean);
    const referenceQuotes = role === "user"
      ? normalizeReferenceQuotes(message.referenceQuotes || message.referenceQuote)
      : [];
    const documents = role === "user"
      ? (Array.isArray(message.documents) ? message.documents : []).map(normalizeDocumentAttachment).filter(Boolean)
      : [];
    const citedImages = role === "assistant"
      ? (Array.isArray(message.citedImages) ? message.citedImages : [])
        .map(item => normalizeCitedImage(item, resourceResolver)).filter(Boolean)
      : [];
    if (!content && !attachments.length && !referenceQuotes.length && !documents.length && !legacyContentParts.some(part => part.type === "image_url")) return null;
    return {
      id: String(message.id || U.randomID("message")),
      role,
      content,
      attachments,
      legacyContentParts: legacyContentParts.length ? legacyContentParts : [],
      documents,
      documentOptions: role === "user" ? normalizeDocumentOptions(message.documentOptions) : normalizeDocumentOptions(null),
      currentDocument: role === "user" ? Boolean(message.currentDocument) : false,
      referenceQuotes,
      citedImages,
      taskType: role === "user" && TASK_TYPES.has(String(message.taskType || "")) ? String(message.taskType) : "chat",
      taskInstruction: role === "user" ? String(message.taskInstruction || "").trim() : "",
      diagramMode: role === "user" && ["none", "mindmap", "flowchart"].includes(String(message.diagramMode || "")) ? String(message.diagramMode) : "none",
      formatInstruction: role === "user" ? String(message.formatInstruction || "").trim() : "",
      transport: role === "user" && (message.transport?.engine === "deepseek_web" || message.engine === "deepseek_web" || message.aiMode === "web")
        ? { engine: "deepseek_web" }
        : { engine: "api" },
      reasoning: role === "assistant"
        ? String(message.reasoning ?? message.reasoning_content ?? message.thinking ?? "")
        : "",
      responseInfo: role === "assistant" && message.responseInfo && typeof message.responseInfo === "object"
        ? {
          provider: String(message.responseInfo.provider || ""),
          model: String(message.responseInfo.model || ""),
          inputTokens: Number(message.responseInfo.inputTokens || 0),
          outputTokens: Number(message.responseInfo.outputTokens || 0),
          totalTokens: Number(message.responseInfo.totalTokens || 0),
          reasoningTokens: Number(message.responseInfo.reasoningTokens || 0),
          cachedTokens: Number(message.responseInfo.cachedTokens || 0),
          cacheWriteTokens: Number(message.responseInfo.cacheWriteTokens || 0),
          cacheDiscount: Number(message.responseInfo.cacheDiscount || 0)
        }
        : null,
      interrupted: role === "assistant" ? normalizeBoolean(message.interrupted) : false,
      createdAt: String(message.createdAt || new Date().toISOString())
    };
  }

  function responseInfo(result, provider = "") {
    const usage = result?.usage && typeof result.usage === "object" ? result.usage : {};
    const promptDetails = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
      ? usage.prompt_tokens_details : {};
    const completionDetails = usage.completion_tokens_details && typeof usage.completion_tokens_details === "object"
      ? usage.completion_tokens_details : {};
    const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
    return {
      provider: String(provider || ""),
      model: String(result?.model || ""),
      inputTokens: number(usage.prompt_tokens),
      outputTokens: number(usage.completion_tokens),
      totalTokens: number(usage.total_tokens),
      reasoningTokens: number(completionDetails.reasoning_tokens),
      cachedTokens: number(promptDetails.cached_tokens ?? usage.cached_input_tokens ?? usage.prompt_cache_hit_tokens),
      cacheWriteTokens: number(promptDetails.cache_write_tokens),
      cacheDiscount: number(usage.cache_discount)
    };
  }

  function deriveTitle(messages, fallback = "当前文献对话") {
    const first = (messages || []).find(message => message?.role === "user" && String(message.content || "").trim());
    if (!first) return fallback;
    return String(first.content)
      .replace(/\s+/g, " ")
      .replace(/^【[^】]+】\s*/, "")
      .trim()
      .slice(0, 52) || fallback;
  }

  function trimContext(text, limit) {
    const value = String(text || "").trim();
    const requested = Number(limit);
    if (!Number.isFinite(requested) || requested <= 0) return value;
    const max = Math.max(10000, requested);
    if (value.length <= max) return value;
    const headLength = Math.floor(max * 0.72);
    const tailLength = max - headLength;
    return (
      value.slice(0, headLength).trimEnd() +
      "\n\n[中间部分因模型上下文预算被本地截断；文档开头与结尾均已保留。]\n\n" +
      value.slice(-tailLength).trimStart()
    );
  }

  function decodeImageDataURL(value) {
    return U.decodeImageDataURL(value);
  }

  function encodeBytesBase64(bytes) {
    const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    const chunkSize = 0x8000;
    let binary = "";
    for (let offset = 0; offset < source.length; offset += chunkSize) {
      binary += String.fromCharCode(...source.subarray(offset, Math.min(source.length, offset + chunkSize)));
    }
    return U.base64Encode(binary);
  }

  function looksLikePayloadTooLargeError(error) {
    const text = `${error?.message || error || ""} ${error?.body || ""}`.toLowerCase();
    return Number(error?.status || 0) === 413
      || /\b413\b/.test(text)
      || text.includes("payload too large")
      || text.includes("entity too large");
  }

  function looksLikeImageUnsupportedError(error) {
    if (looksLikePayloadTooLargeError(error)) return false;
    const text = `${error?.message || error || ""} ${error?.body || ""}`.toLowerCase();

    // 2. 报错中直接提到了图片相关字段（例如 image_url、input_image、OpenAICompletionImageUrl）
    if (
      text.includes("image_url") ||
      text.includes("input_image") ||
      text.includes("openaicompletionimageurl")
    ) {
      return true;
    }

    // 3. 多模态/视觉能力拒绝提示（包含中英文及 VLM 特征）
    const visionKeywords = [
      "not a vlm", "vision language model", "text-only",
      "multimodal", "vision", "image input", "image content",
      "does not support image", "not support image", "unsupported image",
      "不支持图片", "不支持图像", "不支持多模态", "非多模态", "纯文本模型",
      "仅支持文本", "只支持文本", "无法识别图片", "无法处理图片"
    ];
    if (visionKeywords.some(kw => text.includes(kw))) {
      return true;
    }

    // 4. OpenAI 兼容接口标准 content.type 错误（如 GLM、各类中转代理）
    const textOnlyContentTypeError =
      /messages?(\[\d+\])?\.content(\[\d+\])?(\.type)?/.test(text) &&
      /(参数非法|取值范围|invalid(?:\s+value)?|expected|type)/.test(text) &&
      /(text|string)/.test(text);
    if (textOnlyContentTypeError) {
      return true;
    }

    // 5. 通用反序列化或非支持类型异常（涉及消息内容）
    if (
      (text.includes("deserialize") || text.includes("unknown variant") || text.includes("unsupported")) &&
      (text.includes("message") || text.includes("content") || text.includes("image"))
    ) {
      return true;
    }

    return false;
  }

  function textOnlyMessages(messages) {
    return (messages || []).map(message => {
      if (!Array.isArray(message?.content)) return message;
      const text = message.content
        .filter(part => part && (part.type === "text" || part.type === "input_text"))
        .map(part => String(part.text || ""))
        .join("\n")
        .trim();
      return { ...message, content: text || "（原图已自动省略）" };
    });
  }

  function appendDynamicContextToLatestUser(messages, context) {
    const text = String(context || "").trim();
    if (!text) return messages;
    const rows = Array.isArray(messages) ? messages : [];
    for (let index = rows.length - 1; index >= 0; index--) {
      const message = rows[index];
      if (String(message?.role || "") !== "user") continue;
      if (Array.isArray(message.content)) {
        message.content = [...message.content, { type: "text", text: `\n\n${text}` }];
      }
      else {
        message.content = `${String(message.content || "").trim()}\n\n${text}`.trim();
      }
      return rows;
    }
    rows.push({ role: "user", content: text });
    return rows;
  }

  function messageContentToText(content) {
    if (!Array.isArray(content)) return String(content || "");
    return content
      .filter(part => part && (part.type === "text" || part.type === "input_text"))
      .map(part => String(part.text || ""))
      .join("\n");
  }

  function messageContentImageDataURLs(content) {
    if (!Array.isArray(content)) return [];
    return content.map(part => {
      if (!part || !["image_url", "input_image"].includes(String(part.type || ""))) return "";
      const value = typeof part.image_url === "object" ? part.image_url?.url : (part.image_url || part.image);
      return /^data:image\//i.test(String(value || "")) ? String(value) : "";
    }).filter(Boolean);
  }

  function findTurnRange(messages, messageIDOrIndex) {
    const rows = Array.isArray(messages) ? messages : [];
    let index = Number.isInteger(messageIDOrIndex)
      ? messageIDOrIndex
      : rows.findIndex(message => String(message?.id || "") === String(messageIDOrIndex || ""));
    if (index < 0 || index >= rows.length) return null;
    let start = index;
    while (start > 0 && rows[start]?.role !== "user") start--;
    if (rows[start]?.role !== "user") start = index;
    let end = start + 1;
    while (end < rows.length && rows[end]?.role !== "user") end++;
    return { start, end, index };
  }

  const NON_MULTIMODAL_MARK_TTL_MS = 2 * 24 * 60 * 60 * 1000;

  class ChatService {
    constructor(storage, llm, translation, mineru = null) {
      this.storage = storage;
      this.llm = llm;
      this.translation = translation;
      this.mineru = mineru;
      this.documentImageCompressionCache = new Map();
      this.imageUnsupportedModels = new Map();
      try {
        const stored = JSON.parse(String(U.getPref("nonMultimodalModelMarks", "{}") || "{}"));
        const cutoff = Date.now() - NON_MULTIMODAL_MARK_TTL_MS;
        let hasExpired = false;
        for (const [key, value] of Object.entries(stored || {})) {
          const timestamp = Number(value?.timestamp || value || 0);
          const model = String(value?.model || key.split("\u001f").pop() || key).trim().toLowerCase();
          if (timestamp >= cutoff && model) {
            this.imageUnsupportedModels.set(model, timestamp);
          } else if (model) {
            hasExpired = true;
          }
        }
        if (hasExpired) {
          this.persistImageUnsupportedModels();
        }
      }
      catch (_) {}
    }

    persistImageUnsupportedModels() {
      const cutoff = Date.now() - NON_MULTIMODAL_MARK_TTL_MS;
      const payload = {};
      for (const [modelKey, timestamp] of this.imageUnsupportedModels) {
        if (timestamp >= cutoff) payload[modelKey] = { model: modelKey, timestamp };
        else this.imageUnsupportedModels.delete(modelKey);
      }
      U.setPref("nonMultimodalModelMarks", JSON.stringify(payload));
    }

    isImageUnsupported(key) {
      const model = String(key || "").trim().toLowerCase();
      if (!model) return false;
      const timestamp = this.imageUnsupportedModels.get(model);
      if (!timestamp) return false;
      if (Date.now() - timestamp >= NON_MULTIMODAL_MARK_TTL_MS) {
        this.imageUnsupportedModels.delete(model);
        this.persistImageUnsupportedModels();
        return false;
      }
      return true;
    }

    root(documentID) {
      return this.storage.path(documentID, "chat");
    }

    documentSessionID(engine = "api") {
      // 网页端的本地编排缓存不能与可见的 API 对话共用同一会话；远程
      // DeepSeek 会话仍由网页驱动以文献 ID 单独管理。
      return engine === "deepseek_web" || engine === "web"
        ? "web-document-chat"
        : "document-chat";
    }

    indexPath(documentID) {
      return PathUtils.join(this.root(documentID), "index.json");
    }

    sessionPath(documentID, sessionID) {
      const safeID = String(sessionID || "").replace(/[^A-Za-z0-9_-]+/g, "");
      return PathUtils.join(this.root(documentID), `session.${safeID}.json`);
    }

    attachmentDir(documentID, sessionID) {
      const safeID = String(sessionID || "").replace(/[^A-Za-z0-9_-]+/g, "") || "unknown";
      return PathUtils.join(this.root(documentID), "attachments", safeID);
    }

    documentCacheRoot(documentID) {
      return this.storage.path(documentID, "chat", "documents");
    }

    revisionRoot(documentID) {
      return this.storage.path(documentID, "chat", "revisions");
    }

    async currentDocumentFingerprint(documentID) {
      try {
        const text = await this.storage.readText(this.storage.path(documentID, "full.cleaned.md"), "");
        if (text) return U.hashString(text);
        const raw = await this.storage.readText(this.storage.path(documentID, "full.md"), "");
        return raw ? U.hashString(raw) : "";
      }
      catch (_) {
        return "";
      }
    }

    markImageUnsupported(key) {
      const model = String(key || "").trim().toLowerCase();
      if (!model) return;
      this.imageUnsupportedModels.set(model, Date.now());
      this.persistImageUnsupportedModels();
    }

    async prepareDocument(documentID, filePath, options = {}, emit = null, signal = null) {
      const stat = await this.storage.stat(filePath);
      if (!stat || stat.type === "directory") throw new Error("所选文档不存在或不是普通文件");
      const extension = U.extension(filePath);
      const name = PathUtils.filename(filePath) || "未命名文档";
      const root = this.documentCacheRoot(documentID);
      await this.storage.ensureDir(root);
      let markdown = "";
      let identity = "";
      let parseRoot = "";
      let imageMap = [];
      if (DIRECT_TEXT_EXTENSIONS.has(extension)) {
        identity = U.hashString([filePath, stat.size || 0, stat.lastModified || 0, "direct-text-v1"].join("|"));
        parseRoot = PathUtils.join(root, identity);
        await this.storage.ensureDir(parseRoot);
        const markdownPath = PathUtils.join(parseRoot, "document.md");
        markdown = decodeTextDocument(await this.storage.readBytes(filePath));
        if (!markdown.trim()) throw new Error(`文档 ${name} 的文本内容为空`);
        if (![".md", ".markdown"].includes(extension)) {
          markdown = (
            "```text\n" +
            `文件名: ${name}\n` +
            `文件类型: ${extension || "无扩展名"}\n` +
            "```\n\n" +
            markdown
          );
        }
        await this.storage.writeText(markdownPath, markdown);
        await this.storage.writeJSON(PathUtils.join(parseRoot, "document.json"), {
          identity,
          sourceName: name,
          sourceSize: stat.size || 0,
          sourceModified: stat.lastModified || 0,
          parsedAt: new Date().toISOString()
        });
      }
      else if (C.SUPPORTED_INPUT_EXTENSIONS.has(extension)) {
        if (!this.mineru?.parseExternalReference) throw new Error("当前运行环境不能解析附加文档");
        const settings = this.llm.getSettings("chat");
        const parsed = await this.mineru.parseExternalReference(filePath, root, {
          modelVersion: settings.mineruModel || "vlm",
          isOCR: Boolean(settings.mineruOCR),
          enableFormula: settings.mineruFormula !== false,
          enableTable: settings.mineruTable !== false
        }, emit, signal);
        markdown = parsed.markdown;
        identity = parsed.identity;
        parseRoot = parsed.root;
        imageMap = parsed.imageMap || [];
      }
      else {
        throw new Error(`暂不支持作为对话附件的文档格式：${extension || "无扩展名"}`);
      }
      const markdownName = DIRECT_TEXT_EXTENSIONS.has(extension) ? "document.md" : "reference.md";
      const rootRelativePath = ["chat", "documents", identity].join("/");
      const originalName = `original${extension || ""}`;
      const originalPath = PathUtils.join(parseRoot, originalName);
      if (!await this.storage.exists(originalPath)) await this.storage.copyFile(filePath, originalPath);
      return normalizeDocumentAttachment({
        id: identity,
        name,
        markdownRelativePath: `${rootRelativePath}/${markdownName}`,
        rootRelativePath,
        originalRelativePath: `${rootRelativePath}/${originalName}`,
        charCount: markdown.length,
        imageCount: imageMap.length,
        imageMap
      });
    }

    presentMessage(documentID, message) {
      return normalizeMessage(message, relativePath => this.storage.resourceURL(documentID, relativePath));
    }

    presentSession(documentID, session) {
      return {
        ...session,
        messages: (Array.isArray(session?.messages) ? session.messages : [])
          .map(message => this.presentMessage(documentID, message)).filter(Boolean)
      };
    }

    async discoverStoredSessions(documentID) {
      const indexed = await this.storage.readJSON(this.indexPath(documentID), []);
      const rows = new Map();
      const sessions = new Map();
      const indexedIDs = new Set();
      for (const row of Array.isArray(indexed) ? indexed : []) {
        const id = String(row?.id || "").replace(/[^A-Za-z0-9_-]+/g, "");
        if (!id) continue;
        indexedIDs.add(id);
        rows.set(id, { ...row, id });
        const raw = await this.storage.readJSON(this.sessionPath(documentID, id), null);
        if (raw && typeof raw === "object") sessions.set(id, { ...row, ...raw, id });
      }
      for (const path of await this.storage.list(this.root(documentID))) {
        const match = /^session\.([A-Za-z0-9_-]+)\.json$/u.exec(PathUtils.filename(path));
        if (!match) continue;
        const id = match[1];
        const raw = await this.storage.readJSON(path, null);
        if (!raw || typeof raw !== "object") continue;
        const session = { ...(rows.get(id) || {}), ...raw, id };
        sessions.set(id, session);
        rows.set(id, { ...(rows.get(id) || {}), ...this.sessionIndexRow(session), id });
      }
      return { rows: [...rows.values()], sessions, needsIndexRepair: [...sessions.keys()].some(id => !indexedIDs.has(id)) };
    }

    async ensureDocumentSession(documentID, sessionID = "") {
      await this.storage.ensureDir(this.root(documentID));
      const id = String(sessionID || this.documentSessionID()).replace(/[^A-Za-z0-9_-]+/g, "") || this.documentSessionID();
      const catalog = await this.discoverStoredSessions(documentID);
      const existing = catalog.sessions.get(id);
      if (existing) {
        if (catalog.needsIndexRepair) await this.writeIndex(documentID, catalog.rows);
        return existing;
      }

      const legacySessions = id === this.documentSessionID()
        ? [...catalog.sessions.values()]
          .filter(session => session?.id && session.id !== id && session.id !== this.documentSessionID("web") && !session.archivedDocumentRevision)
          .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
        : [];
      const legacy = legacySessions[0] || null;
      const now = new Date().toISOString();
      const session = {
        ...(legacy && typeof legacy === "object" ? legacy : {}),
        version: 3,
        id,
        title: String(legacy?.title || (id === this.documentSessionID("web") ? "网页端文献会话" : "当前文献对话")),
        titleCustom: Boolean(legacy?.titleCustom),
        createdAt: String(legacy?.createdAt || now),
        updatedAt: String(legacy?.updatedAt || now),
        apiCacheSessionID: String(legacy?.apiCacheSessionID || U.randomCacheKey()),
        sessionModel: id === this.documentSessionID("web") ? "deepseek-web" : String(legacy?.sessionModel || ""),
        documentFingerprint: String(legacy?.documentFingerprint || await this.currentDocumentFingerprint(documentID) || ""),
        archivedDocumentRevision: Boolean(legacy?.archivedDocumentRevision),
        archivedAt: String(legacy?.archivedAt || ""),
        revisionSourceRelativePath: String(legacy?.revisionSourceRelativePath || ""),
        revisionTranslationRelativePath: String(legacy?.revisionTranslationRelativePath || ""),
        migratedFromSessionID: String(legacy?.id || ""),
        messages: (Array.isArray(legacy?.messages) ? legacy.messages : []).map(m => ({
          ...m,
          id: String(m?.id || U.randomID("message"))
        }))
      };
      await this.storage.writeJSON(this.sessionPath(documentID, id), session);
      await this.writeIndex(documentID, [...catalog.rows, this.sessionIndexRow(session)]);
      return session;
    }

    async listSessions(documentID) {
      const current = await this.ensureDocumentSession(documentID);
      const catalog = await this.discoverStoredSessions(documentID);
      const hidden = new Set([this.documentSessionID("web"), String(current.migratedFromSessionID || "")]);
      return [...catalog.sessions.values()]
        .filter(session => !hidden.has(String(session.id || "")))
        .map(session => this.sessionIndexRow(session))
        .sort((a, b) => a.id === current.id ? -1 : b.id === current.id ? 1 : String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    }

    async writeIndex(documentID, sessions) {
      const current = await this.storage.readJSON(this.indexPath(documentID), []);
      const merged = new Map();
      for (const row of [...(Array.isArray(current) ? current : []), ...(sessions || [])]) {
        if (row?.id) merged.set(String(row.id), row);
      }
      const normalized = [...merged.values()]
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      await this.storage.writeJSON(this.indexPath(documentID), normalized);
      return normalized;
    }

    async loadSession(documentID, sessionID = "", present = true) {
      const requested = String(sessionID || "").replace(/[^A-Za-z0-9_-]+/g, "");
      const catalog = await this.discoverStoredSessions(documentID);
      const id = requested && catalog.sessions.has(requested) ? requested : (requested === this.documentSessionID("web") ? requested : this.documentSessionID());
      const raw = catalog.sessions.get(id) || await this.ensureDocumentSession(documentID, id);
      const session = {
        version: 3,
        id: String(raw.id || id),
        title: String(raw.title || (id === this.documentSessionID("web") ? "网页端文献会话" : "当前文献对话")),
        titleCustom: Boolean(raw.titleCustom),
        createdAt: String(raw.createdAt || new Date().toISOString()),
        updatedAt: String(raw.updatedAt || raw.createdAt || new Date().toISOString()),
        apiCacheSessionID: String(raw.apiCacheSessionID || U.randomCacheKey()),
        sessionModel: id === this.documentSessionID("web") ? "deepseek-web" : String(raw.sessionModel || ""),
        documentFingerprint: String(raw.documentFingerprint || ""),
        archivedDocumentRevision: Boolean(raw.archivedDocumentRevision),
        archivedAt: String(raw.archivedAt || ""),
        revisionSourceRelativePath: String(raw.revisionSourceRelativePath || ""),
        revisionTranslationRelativePath: String(raw.revisionTranslationRelativePath || ""),
        migratedFromSessionID: String(raw.migratedFromSessionID || ""),
        messages: (Array.isArray(raw.messages) ? raw.messages : []).map(message => normalizeMessage(message)).filter(Boolean)
      };
      // Older replies and models that omitted the explicit source tag may
      // still contain a valid image placeholder plus an unambiguous attached
      // document title in the surrounding sentence. Rebuild only the small
      // display locators on load; image bytes never enter the session history.
      let latestUserIndex = -1;
      for (let index = 0; index < session.messages.length; index++) {
        const message = session.messages[index];
        if (message.role === "user") {
          latestUserIndex = index;
          continue;
        }
        if (
          latestUserIndex < 0
          || message.role !== "assistant"
          || !markdownImagePlaceholders(message.content).length
        ) continue;
        try {
          message.citedImages = await this.resolveAssistantImageCitations(
            documentID, session, latestUserIndex, message.content
          );
        }
        catch (_) {}
      }
      return present ? this.presentSession(documentID, session) : session;
    }

    async saveSession(documentID, session, present = true) {
      const messages = (Array.isArray(session?.messages) ? session.messages : []).map(message => normalizeMessage(message)).filter(Boolean);
      const now = new Date().toISOString();
      const normalized = {
        version: 3,
        id: String(session?.id || this.documentSessionID()),
        title: String(session?.title || "当前文献对话").slice(0, 80),
        titleCustom: Boolean(session?.titleCustom),
        createdAt: String(session?.createdAt || now),
        updatedAt: now,
        apiCacheSessionID: String(session?.apiCacheSessionID || U.randomCacheKey()),
        sessionModel: String(session?.sessionModel || ""),
        documentFingerprint: String(
          session?.documentFingerprint
          || await this.currentDocumentFingerprint(documentID)
          || ""
        ),
        archivedDocumentRevision: Boolean(session?.archivedDocumentRevision),
        archivedAt: String(session?.archivedAt || ""),
        revisionSourceRelativePath: String(session?.revisionSourceRelativePath || ""),
        revisionTranslationRelativePath: String(session?.revisionTranslationRelativePath || ""),
        migratedFromSessionID: String(session?.migratedFromSessionID || ""),
        messages
      };
      await this.storage.writeJSON(this.sessionPath(documentID, normalized.id), normalized);
      const rows = await this.storage.readJSON(this.indexPath(documentID), []);
      const nextRows = (Array.isArray(rows) ? rows : []).filter(row => String(row?.id || "") !== normalized.id);
      await this.writeIndex(documentID, [...nextRows, this.sessionIndexRow(normalized)]);
      return present ? this.presentSession(documentID, normalized) : normalized;
    }

    sessionIndexRow(session) {
      return {
        id: String(session?.id || ""),
        title: String(session?.title || "当前文献对话"),
        createdAt: String(session?.createdAt || ""),
        updatedAt: String(session?.updatedAt || session?.createdAt || ""),
        messageCount: Array.isArray(session?.messages) ? session.messages.length : 0,
        sessionModel: String(session?.sessionModel || ""),
        documentFingerprint: String(session?.documentFingerprint || ""),
        archivedDocumentRevision: Boolean(session?.archivedDocumentRevision),
        archivedAt: String(session?.archivedAt || ""),
        migratedFromSessionID: String(session?.migratedFromSessionID || "")
      };
    }

    async archiveDocumentRevision(documentID, previousFingerprint, currentFingerprint, snapshots = {}) {
      const previous = String(previousFingerprint || "").trim();
      let current = typeof currentFingerprint === "string" ? currentFingerprint.trim() : "";
      let snap = snapshots;
      if (typeof currentFingerprint === "object" && currentFingerprint !== null && Object.keys(snapshots).length === 0) {
        snap = currentFingerprint;
        current = String(snap.currentFingerprint || "").trim();
      }

      const rawIndex = await this.storage.readJSON(this.indexPath(documentID), []);
      const index = Array.isArray(rawIndex) ? rawIndex.filter(row => row?.id) : [];
      if (!index.length) return { archived: 0, session: null };

      const safeFingerprint = (previous || "legacy").replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 48) || "legacy";
      const revisionRoot = PathUtils.join(this.revisionRoot(documentID), safeFingerprint);
      await this.storage.ensureDir(revisionRoot);
      const sourceRelativePath = ["chat", "revisions", safeFingerprint, "source.md"].join("/");
      const translationRelativePath = ["chat", "revisions", safeFingerprint, "translation.md"].join("/");
      if (String(snap.sourceMarkdown || "")) {
        await this.storage.writeText(PathUtils.join(revisionRoot, "source.md"), snap.sourceMarkdown);
      }
      if (String(snap.translatedMarkdown || "")) {
        await this.storage.writeText(PathUtils.join(revisionRoot, "translation.md"), snap.translatedMarkdown);
      }
      const imageSnapshotRoot = String(snap.imageSnapshotRoot || "");
      if (imageSnapshotRoot && await this.storage.exists(imageSnapshotRoot)) {
        const snapshotImages = PathUtils.join(imageSnapshotRoot, "images");
        const snapshotImageMap = PathUtils.join(imageSnapshotRoot, "image-map.json");
        if (await this.storage.exists(snapshotImages)) {
          await this.storage.remove(PathUtils.join(revisionRoot, "images"), true);
          await this.storage.copyTree(snapshotImages, PathUtils.join(revisionRoot, "images"));
        }
        if (await this.storage.exists(snapshotImageMap)) {
          await this.storage.copyFile(snapshotImageMap, PathUtils.join(revisionRoot, "image-map.json"));
        }
      }

      let archived = 0;
      let mainSessionArchived = false;
      const newIndex = [];
      for (const row of index) {
        const id = String(row.id || "");
        if (id === this.documentSessionID("web")) {
          newIndex.push(row);
          continue;
        }
        const raw = await this.storage.readJSON(this.sessionPath(documentID, id), null);
        if (!raw || raw.archivedDocumentRevision) {
          newIndex.push(row);
          continue;
        }
        const recordedFingerprint = String(raw.documentFingerprint || row.documentFingerprint || "");
        // 若会话已标记为最新指纹，说明是刚刚创建的新会话，无需归档
        if (current && recordedFingerprint === current) {
          newIndex.push(row);
          continue;
        }
        // 指纹不同且不是旧格式时跳过
        if (recordedFingerprint && previous && recordedFingerprint !== previous && recordedFingerprint.length < 64) {
          newIndex.push(row);
          continue;
        }

        const baseTitle = String(raw.title || row.title || "当前文献对话").replace(/（旧解析版本）$/u, "");
        const archivedTitle = `${baseTitle}（旧解析版本）`.slice(0, 80);
        const archivedAt = new Date().toISOString();

        if (id === this.documentSessionID()) {
          // 当前默认主会话若有消息，完整克隆出独立的历史会话副本，绝不丢失用户消息
          if (Array.isArray(raw.messages) && raw.messages.length > 0) {
            const archiveID = `archived-${safeFingerprint}-${Date.now()}`;
            const remapAttachmentPath = path => {
              if (typeof path !== "string") return path;
              return path.replace(
                new RegExp(`chat/attachments/${id}/`, "g"),
                `chat/attachments/${archiveID}/`
              );
            };
            const clonedMessages = (raw.messages || []).map(msg => {
              const updated = { ...msg };
              if (Array.isArray(updated.attachments)) {
                updated.attachments = updated.attachments.map(att => {
                  if (!att || typeof att !== "object") return att;
                  const newAtt = { ...att };
                  if (newAtt.relativePath) {
                    newAtt.relativePath = remapAttachmentPath(newAtt.relativePath);
                  }
                  return newAtt;
                });
              }
              return updated;
            });

            const archivedSession = {
              ...raw,
              id: archiveID,
              title: archivedTitle,
              titleCustom: true,
              messages: clonedMessages,
              documentFingerprint: previous || recordedFingerprint,
              archivedDocumentRevision: true,
              archivedAt,
              revisionSourceRelativePath: String(snap.sourceMarkdown || "") ? sourceRelativePath : "",
              revisionTranslationRelativePath: String(snap.translatedMarkdown || "") ? translationRelativePath : ""
            };
            await this.storage.writeJSON(this.sessionPath(documentID, archiveID), archivedSession);
            const oldAttachDir = this.attachmentDir(documentID, id);
            const newAttachDir = this.attachmentDir(documentID, archiveID);
            if (typeof this.storage.exists === "function" && await this.storage.exists(oldAttachDir)) {
              if (typeof this.storage.copyTree === "function") {
                await this.storage.copyTree(oldAttachDir, newAttachDir);
              }
            }
            newIndex.push(this.sessionIndexRow(archivedSession));
            archived++;
            mainSessionArchived = true;
          } else {
            // 当前主会话无消息，不进行克隆，但在索引中保留当前主会话
            newIndex.push(row);
          }
        } else {
          // 独立已命名历史会话，直接就地打上归档标记
          raw.title = archivedTitle;
          raw.titleCustom = true;
          raw.documentFingerprint = previous || recordedFingerprint;
          raw.archivedDocumentRevision = true;
          raw.archivedAt = archivedAt;
          raw.revisionSourceRelativePath = String(snap.sourceMarkdown || "") ? sourceRelativePath : "";
          raw.revisionTranslationRelativePath = String(snap.translatedMarkdown || "") ? translationRelativePath : "";
          await this.storage.writeJSON(this.sessionPath(documentID, id), raw);
          newIndex.push({
            ...row,
            title: raw.title,
            documentFingerprint: raw.documentFingerprint,
            archivedDocumentRevision: true,
            archivedAt: raw.archivedAt
          });
          archived++;
        }
      }

      if (!archived) {
        const currentSession = await this.loadSession(documentID, this.documentSessionID(), false);
        return { archived: 0, session: this.presentSession(documentID, currentSession) };
      }

      let activeSession = null;
      if (mainSessionArchived) {
        // 仅当当前主会话确实被克隆归档时，才重置并生成全新的当前主会话
        const session = await this.clearSession(documentID, this.documentSessionID());
        session.title = "当前文献对话";
        session.titleCustom = false;
        session.documentFingerprint = String(current || snap.currentFingerprint || "");
        session.archivedDocumentRevision = false;
        session.archivedAt = "";
        session.revisionSourceRelativePath = "";
        session.revisionTranslationRelativePath = "";
        await this.saveSession(documentID, session, false);
        newIndex.push(this.sessionIndexRow(session));
        activeSession = session;
      } else {
        // 主会话未归档（例如正文指纹未变或主会话已是新版），保持当前主会话原样
        activeSession = await this.loadSession(documentID, this.documentSessionID(), false);
        if (!newIndex.some(r => r.id === this.documentSessionID())) {
          newIndex.push(this.sessionIndexRow(activeSession));
        }
      }

      await this.writeIndex(documentID, newIndex);
      return { archived, session: this.presentSession(documentID, activeSession) };
    }

    async clearSession(documentID, sessionID) {
      const session = await this.loadSession(documentID, sessionID || this.documentSessionID(), false);
      session.messages = [];
      session.sessionModel = "";
      session.apiCacheSessionID = U.randomCacheKey();
      return this.saveSession(documentID, session, false);
    }

    updateSessionModel(session, emit = null, options = null) {
      const isWeb = session?.id === "web-document-chat"
        || session?.id === this.documentSessionID("web")
        || options?.engine === "deepseek_web"
        || options?.aiMode === "web"
        || options?.provider === "deepseek_web";
      if (isWeb) {
        session.sessionModel = "deepseek-web";
        return session;
      }
      const model = String(this.llm.getSettings("chat").model || "").trim();
      const previous = String(session?.sessionModel || "").trim();
      if (previous && previous !== "deepseek-web" && model && model !== previous) {
        emit?.({
          type: "warning",
          message: "对话模型已经更改。历史记录会保留，后续回答将使用新模型。"
        });
      }
      if (model) session.sessionModel = model;
      return session;
    }

    async removeMessageAttachments(documentID, messages) {
      for (const message of Array.isArray(messages) ? messages : []) {
        for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
          const normalized = normalizeAttachment(attachment);
          if (!normalized) continue;
          try {
            await this.storage.remove(this.storage.path(documentID, normalized.relativePath), false);
          }
          catch (_) {}
        }
      }
    }

    async editMessage(documentID, sessionID, messageID, text, options = {}, emit = null, signal = null) {
      const content = String(text || "").trim();
      if (!content) throw new Error("消息内容不能为空");
      const transportSessionID = options.engine === "deepseek_web" || options.aiMode === "web"
        ? this.documentSessionID("web")
        : sessionID;
      let session = await this.loadSession(documentID, transportSessionID, false);
      const index = session.messages.findIndex(message => message.id === messageID);
      if (index < 0) throw new Error("未找到要编辑的消息");
      if (session.messages[index].role === "user") {
        return this.resend(documentID, session.id, messageID, options, emit, signal, content);
      }
      let citedUserIndex = index - 1;
      while (citedUserIndex > 0 && session.messages[citedUserIndex]?.role !== "user") citedUserIndex--;
      session.messages[index] = {
        ...session.messages[index],
        content,
        citedImages: await this.resolveAssistantImageCitations(
          documentID,
          session,
          Math.max(0, citedUserIndex),
          content
        )
      };
      session = await this.saveSession(documentID, session, false);
      emit?.({ type: "chat-session", session: this.presentSession(documentID, session) });
      return {
        session: this.presentSession(documentID, session),
        message: this.presentMessage(documentID, session.messages[index])
      };
    }

    async deleteTurn(documentID, sessionID, messageID) {
      let session = await this.loadSession(documentID, sessionID, false);
      const range = findTurnRange(session.messages, messageID);
      if (!range) throw new Error("未找到要删除的对话轮次");
      const removed = session.messages.slice(range.start, range.end);
      session.messages.splice(range.start, range.end - range.start);
      await this.removeMessageAttachments(documentID, removed);
      session = await this.saveSession(documentID, session, false);
      return { session: this.presentSession(documentID, session), removedMessageIDs: removed.map(message => message.id) };
    }

    async persistIncomingImages(documentID, sessionID, messageID, images) {
      const source = Array.isArray(images) ? images : [];
      if (!source.length) return [];
      const directory = this.attachmentDir(documentID, sessionID);
      await this.storage.ensureDir(directory);
      const output = [];
      const createdPaths = [];
      try {
        for (let index = 0; index < source.length; index++) {
          const input = source[index] || {};
          const decoded = decodeImageDataURL(input.dataURL);
          const id = U.randomID("image");
          const extension = IMAGE_MIME_EXTENSIONS[decoded.mimeType];
          const imageSource = ["paste", "drop", "file", "reuse", "reader"].includes(String(input.source || ""))
            ? String(input.source)
            : "file";
          const capturedAt = String(input.capturedAt || new Date().toISOString());
          const requestedName = String(input.name || "").trim();
          const displayName = imageSource === "paste" && !U.isIdentifiedPastedImageName(requestedName)
            ? U.pastedImageName(capturedAt, index + 1, decoded.mimeType)
            : (requestedName || `image-${index + 1}${extension}`);
          const fileName = `${String(messageID).replace(/[^A-Za-z0-9_-]+/g, "")}-${String(index + 1).padStart(2, "0")}-${id.slice(-10)}${extension}`;
          const fullPath = PathUtils.join(directory, fileName);
          await this.storage.writeBytes(fullPath, decoded.bytes);
          createdPaths.push(fullPath);
          const relativePath = ["chat", "attachments", String(sessionID).replace(/[^A-Za-z0-9_-]+/g, ""), fileName].join("/");
          output.push(normalizeAttachment({
            id,
            name: displayName,
            mimeType: decoded.mimeType,
            relativePath,
            size: decoded.bytes.length,
            source: imageSource,
            originalName: String(input.originalName || requestedName || ""),
            capturedAt,
            width: input.width,
            height: input.height,
            originalWidth: input.originalWidth,
            originalHeight: input.originalHeight,
            optimizedForVision: input.optimizedForVision,
            // The data URL is the canonical message payload; the on-disk image
            // is a recoverable cache and is not required for sending.
            dataURL: `data:${decoded.mimeType};base64,${encodeBytesBase64(decoded.bytes)}`
          }, path => this.storage.resourceURL(documentID, path)));
        }
        return output.filter(Boolean);
      }
      catch (error) {
        for (const path of createdPaths) await this.storage.remove(path, false);
        throw error;
      }
    }

    async persistGeneratedImages(documentID, sessionID, messageID, images) {
      const source = (Array.isArray(images) ? images : []).filter(item => item?.bytes?.length);
      if (!source.length) return [];
      const directory = this.attachmentDir(documentID, sessionID);
      await this.storage.ensureDir(directory);
      const output = [];
      const createdPaths = [];
      try {
        for (let index = 0; index < source.length; index++) {
          const input = source[index];
          const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes || []);
          const mimeType = IMAGE_MIME_EXTENSIONS[String(input.mimeType || "").toLowerCase()]
            ? String(input.mimeType).toLowerCase()
            : "image/png";
          const id = U.randomID("image");
          const extension = IMAGE_MIME_EXTENSIONS[mimeType];
          const fileName = `${String(messageID).replace(/[^A-Za-z0-9_-]+/g, "")}-generated-${String(index + 1).padStart(2, "0")}-${id.slice(-10)}${extension}`;
          const fullPath = PathUtils.join(directory, fileName);
          await this.storage.writeBytes(fullPath, bytes);
          createdPaths.push(fullPath);
          output.push(normalizeAttachment({
            id,
            name: String(input.name || `generated-image-${index + 1}${extension}`),
            mimeType,
            relativePath: ["chat", "attachments", String(sessionID).replace(/[^A-Za-z0-9_-]+/g, ""), fileName].join("/"),
            size: bytes.length,
            source: "generated",
            capturedAt: new Date().toISOString()
          }, path => this.storage.resourceURL(documentID, path)));
        }
        return output.filter(Boolean);
      }
      catch (error) {
        for (const path of createdPaths) await this.storage.remove(path, false);
        throw error;
      }
    }

    async attachmentDataURL(documentID, attachment) {
      const normalized = normalizeAttachment(attachment);
      if (!normalized) return "";
      if (normalized.dataURL) return normalized.dataURL;
      const path = this.storage.path(documentID, normalized.relativePath);
      const bytes = await this.storage.readBytes(path);
      if (!bytes?.length) return "";
      return `data:${normalized.mimeType};base64,${encodeBytesBase64(bytes)}`;
    }

    async appendAttachmentParts(documentID, parts, attachments, options = {}) {
      const references = [];
      const failures = [];
      const loadedAttachmentIDs = options.loadedAttachmentIDs instanceof Set
        ? options.loadedAttachmentIDs
        : null;
      const rows = (Array.isArray(attachments) ? attachments : [])
        .map(item => normalizeAttachment(item)).filter(Boolean);
      for (let index = 0; index < rows.length; index++) {
        const attachment = rows[index];
        try {
          const dataURL = await this.attachmentDataURL(documentID, attachment);
          if (!dataURL) {
            failures.push(attachment);
            continue;
          }
          const label = attachmentTransportLabel(attachment, {
            ...options,
            imageOrdinal: index + 1
          });
          this.appendTextPart(parts, `\n\n${label.text}`);
          parts.push({
            type: "image_url",
            image_url: { url: dataURL },
            localAttachmentID: attachment.id,
            localAttachmentReference: label.reference
          });
          loadedAttachmentIDs?.add(attachment.id);
          references.push(label.reference);
        }
        catch (_) {
          failures.push(attachment);
        }
      }
      return { references, failures, expected: rows.length };
    }

    appendUserQuestionAfterImages(parts, text, references, latest) {
      const question = String(text || "").trim();
      const imageReferences = (Array.isArray(references) ? references : []).map(reference => `[${reference}]`);
      if (imageReferences.length) {
        this.appendTextPart(
          parts,
          `\n\n===== ${latest ? "当前最新一轮" : "该轮"}用户问题 =====\n` +
          `${latest ? "请优先查看当前轮新增的" : "该问题对应"}${imageReferences.join("、")}。` +
          `${latest ? "问题中的“这张图”、“这个”、“上述图片”默认指这些当前轮图片，不要与论文内图片或更早轮次图片混淆。" : ""}\n` +
          question
        );
        return;
      }
      this.appendTextPart(parts, `\n\n===== 用户问题 =====\n${question}`);
    }

    appendTextPart(parts, text) {
      if (!text) return;
      const last = parts[parts.length - 1];
      if (last?.type === "text") last.text += String(text);
      else parts.push({ type: "text", text: String(text) });
    }

    async compressDocumentImage(bytes, mimeType, cacheKey) {
      const key = `${cacheKey}:${bytes.length}`;
      const cached = this.documentImageCompressionCache.get(key);
      if (cached) return cached;
      try {
        const win = Services.appShell.hiddenDOMWindow;
        const blob = new win.Blob([bytes], { type: mimeType });
        const bitmap = await win.createImageBitmap(blob);
        const maxSide = 1024;
        const scale = Math.min(1, maxSide / Math.max(1, bitmap.width), maxSide / Math.max(1, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { alpha: false });
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.drawImage(bitmap, 0, 0, width, height);
        bitmap.close?.();
        const dataURL = canvas.toDataURL("image/jpeg", .78);
        const payload = String(dataURL).split(",", 2)[1] || "";
        const binary = U.base64Decode(payload);
        const compressed = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) compressed[index] = binary.charCodeAt(index);
        const result = { bytes: compressed, mimeType: "image/jpeg" };
        this.documentImageCompressionCache.set(key, result);
        // Avoid retaining an unbounded number of full binary images for very
        // long sessions while still preventing repeat work on normal chats.
        if (this.documentImageCompressionCache.size > 64) {
          this.documentImageCompressionCache.delete(this.documentImageCompressionCache.keys().next().value);
        }
        return result;
      }
      catch (_) {
        return { bytes, mimeType };
      }
    }

    async documentImageDataURL(documentID, document, target, alt = "", options = {}) {
      const normalized = normalizeDocumentAttachment(document);
      if (!normalized) return null;
      const cleanTarget = String(target || "").trim().replace(/^<|>$/g, "").replace(/\\/g, "/");

      // If the in-memory image map is empty, reload the published map from
      // disk before resolving the reference.
      let imageMap = normalized.imageMap;
      if (!imageMap.length) {
        try {
          const diskMap = await this.storage.readJSON(
            this.storage.path(documentID, ...normalized.rootRelativePath.split("/"), "image-map.json"),
            []
          );
          imageMap = (Array.isArray(diskMap) ? diskMap : []).map(record => ({
            id: String(record?.id || ""),
            alt: String(record?.alt || ""),
            cleanTarget: String(record?.cleanTarget || record?.clean_target || "")
              .replace(/\\/g, "/").replace(/^\/+/, ""),
            warning: String(record?.warning || "")
          })).filter(record => isSafeRelativePath(record.cleanTarget));
        }
        catch (_) {
          // Disk map also unavailable — proceed with direct path match.
        }
      }

      const mapped = imageMap.find(record =>
        record.id === alt || record.alt === alt || record.cleanTarget === cleanTarget
      );
      // Consistent with currentDocumentImageDataURL: skip images whose asset
      // could not be located during parse-time asset resolution.
      if (mapped?.warning) return null;
      const relative = String(mapped?.cleanTarget || cleanTarget).replace(/^\/+/, "");
      if (!isSafeRelativePath(relative)) return null;
      const fullPath = this.storage.path(documentID, ...normalized.rootRelativePath.split("/"), ...relative.split("/"));
      let bytes;
      try {
        bytes = await this.storage.readBytes(fullPath);
      }
      catch (error) {
        Zotero.debug?.(`[LitMTrans] documentImageDataURL: 读取图片异常 alt=${alt} target=${cleanTarget} resolved=${relative} path=${fullPath} error=${error}`);
        return null;
      }
      if (!bytes?.length) {
        Zotero.debug?.(`[LitMTrans] documentImageDataURL: 无法读取图片(空) alt=${alt} target=${cleanTarget} resolved=${relative} path=${fullPath}`);
        return null;
      }
      const extension = U.extension(relative);
      let mimeType = {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp", ".jp2": "image/jp2", ".svg": "image/svg+xml"
      }[extension] || "image/png";
      if (normalizeDocumentOptions(options).compressImages) {
        const compressed = await this.compressDocumentImage(bytes, mimeType, `${normalized.id}:${relative}`);
        bytes = compressed.bytes;
        mimeType = compressed.mimeType;
      }
      return {
        dataURL: `data:${mimeType};base64,${encodeBytesBase64(bytes)}`,
        name: relative.split("/").filter(Boolean).pop() || alt || "document-image.png",
        relative
      };
    }

    async currentDocumentImageDataURL(documentID, target, alt = "", baseRelativePath = "", options = {}) {
      const cleanTarget = String(target || "").trim().replace(/^<|>$/g, "").replace(/\\/g, "/");
      const safeBase = String(baseRelativePath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      if (safeBase && !isSafeRelativePath(safeBase)) return null;
      const baseParts = safeBase ? safeBase.split("/") : [];
      const imageMap = await this.storage.readJSON(
        this.storage.path(documentID, ...baseParts, "image-map.json"),
        []
      );
      const mapped = (Array.isArray(imageMap) ? imageMap : []).find(record =>
        String(record?.id || "") === alt
        || String(record?.alt || "") === alt
        || String(record?.cleanTarget || record?.clean_target || "") === cleanTarget
      );
      if (mapped?.warning) return null;
      const relative = String(mapped?.cleanTarget || mapped?.clean_target || cleanTarget)
        .replace(/^\/+/, "");
      if (!isSafeRelativePath(relative)) return null;
      const fullPath = this.storage.path(documentID, ...baseParts, ...relative.split("/"));
      let bytes;
      try {
        bytes = await this.storage.readBytes(fullPath);
      }
      catch (error) {
        return null;
      }
      if (!bytes?.length) return null;
      const extension = U.extension(relative);
      let mimeType = {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp", ".jp2": "image/jp2", ".svg": "image/svg+xml"
      }[extension] || "image/png";
      const storageRelative = [...baseParts, ...relative.split("/")].join("/");
      if (normalizeDocumentOptions(options).compressImages) {
        const compressed = await this.compressDocumentImage(bytes, mimeType, `current-document:${documentID}:${storageRelative}`);
        bytes = compressed.bytes;
        mimeType = compressed.mimeType;
      }
      return {
        dataURL: `data:${mimeType};base64,${encodeBytesBase64(bytes)}`,
        name: relative.split("/").filter(Boolean).pop() || alt || "document-image.png",
        relative: storageRelative
      };
    }

    async currentDocumentImageLocator(documentID, target, alt = "", baseRelativePath = "") {
      const cleanTarget = String(target || "").trim().replace(/^<|>$/g, "").replace(/\\/g, "/");
      const safeBase = String(baseRelativePath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      if (safeBase && !isSafeRelativePath(safeBase)) return null;
      const baseParts = safeBase ? safeBase.split("/") : [];
      const imageMap = await this.storage.readJSON(
        this.storage.path(documentID, ...baseParts, "image-map.json"),
        []
      );
      const mapped = (Array.isArray(imageMap) ? imageMap : []).find(record =>
        String(record?.id || "") === alt
        || String(record?.alt || "") === alt
        || String(record?.cleanTarget || record?.clean_target || "") === cleanTarget
      );
      if (mapped?.warning) return null;
      const relative = String(mapped?.cleanTarget || mapped?.clean_target || cleanTarget).replace(/^\/+/, "");
      if (!isSafeRelativePath(relative)) return null;
      const relativePath = [...baseParts, ...relative.split("/")].join("/");
      const stat = await this.storage.stat(this.storage.path(documentID, ...relativePath.split("/")));
      if (!stat || stat.type === "directory") return null;
      return { name: relative.split("/").pop() || alt || "document-image.png", relativePath };
    }

    async documentImageLocator(documentID, document, target, alt = "") {
      const normalized = normalizeDocumentAttachment(document);
      if (!normalized) return null;
      const cleanTarget = String(target || "").trim().replace(/^<|>$/g, "").replace(/\\/g, "/");
      let imageMap = normalized.imageMap;
      if (!imageMap.length) {
        imageMap = await this.storage.readJSON(
          this.storage.path(documentID, ...normalized.rootRelativePath.split("/"), "image-map.json"),
          []
        );
      }
      const mapped = (Array.isArray(imageMap) ? imageMap : []).find(record =>
        String(record?.id || "") === alt
        || String(record?.alt || "") === alt
        || String(record?.cleanTarget || record?.clean_target || "") === cleanTarget
      );
      if (mapped?.warning) return null;
      const relative = String(mapped?.cleanTarget || mapped?.clean_target || cleanTarget).replace(/^\/+/, "");
      if (!isSafeRelativePath(relative)) return null;
      const relativePath = `${normalized.rootRelativePath}/${relative}`;
      const stat = await this.storage.stat(this.storage.path(documentID, ...relativePath.split("/")));
      if (!stat || stat.type === "directory") return null;
      return { name: relative.split("/").pop() || alt || "document-image.png", relativePath };
    }

    async resolveAssistantImageCitations(documentID, session, userIndex, content) {
      const requested = markdownImagePlaceholders(content);
      if (!requested.length) return [];
      const revisionSource = String(session?.revisionSourceRelativePath || "");
      const archived = Boolean(session?.archivedDocumentRevision && revisionSource);
      const revisionBase = archived
        ? revisionSource.replace(/\\/g, "/").split("/").slice(0, -1).join("/")
        : "";
      const currentMarkdown = await this.storage.readText(
        archived
          ? this.storage.path(documentID, ...revisionSource.split("/"))
          : this.storage.path(documentID, "full.cleaned.md"),
        ""
      );
      const sources = [{
        type: "current-document",
        id: documentID,
        name: "当前文献",
        markdown: currentMarkdown,
        resolve: reference => this.currentDocumentImageLocator(
          documentID, reference.target, reference.alt, revisionBase
        )
      }];
      const seenDocuments = new Set();
      for (const message of (Array.isArray(session?.messages) ? session.messages : []).slice(0, userIndex + 1)) {
        for (const rawDocument of Array.isArray(message?.documents) ? message.documents : []) {
          const document = normalizeDocumentAttachment(rawDocument);
          if (!document || seenDocuments.has(document.id)) continue;
          seenDocuments.add(document.id);
          const markdown = await this.storage.readText(
            this.storage.path(documentID, ...document.markdownRelativePath.split("/")),
            ""
          );
          sources.push({
            type: "document",
            id: document.id,
            name: document.name,
            markdown,
            resolve: reference => this.documentImageLocator(
              documentID, document, reference.target, reference.alt
            )
          });
        }
      }

      const cited = [];
      const seen = new Set();
      for (const reference of requested) {
        const candidates = [];
        for (const source of sources) {
          const exact = markdownImagePlaceholders(source.markdown).find(candidate =>
            candidate.markdownRef === reference.markdownRef
            && imagePlaceholderKey(candidate.alt, candidate.target) === imagePlaceholderKey(reference.alt, reference.target)
          );
          if (!exact) continue;
          candidates.push({ source, exact });
        }
        const prefix = String(content || "").slice(Math.max(0, reference.index - 240), reference.index);
        const suffix = String(content || "").slice(
          reference.index + reference.markdownRef.length,
          reference.index + reference.markdownRef.length + 240
        );
        const sourceHintBefore = String(prefix.match(/\[图片来源：([^\]\r\n]+)\][*_`~\s]*$/)?.[1] || "").trim();
        // Accept the model's common reversed form for recovery, even though
        // the prompt now requires the source tag before the placeholder.
        const sourceHintAfter = String(
          suffix.match(/^[*_`~\s]*(?:\([^)\r\n]{0,80}\)[*_`~\s]*)?\[图片来源：([^\]\r\n]+)\]/)?.[1] || ""
        ).trim();
        const sourceHint = sourceHintBefore || sourceHintAfter;
        const explicitlyMentioned = sourceHint
          ? candidates.filter(candidate => candidate.source.name === sourceHint)
          : candidates.filter(candidate => {
            if (candidate.source.type !== "document") return false;
            const name = String(candidate.source.name || "").trim();
            return Boolean(name && (prefix.includes(`《${name}》`) || prefix.includes(name)));
          });
        const selected = explicitlyMentioned.length === 1
          ? explicitlyMentioned
          : (candidates.length === 1 ? candidates : []);
        for (const { source, exact } of selected) {
          const image = await source.resolve(exact);
          if (!image?.relativePath || !isSafeRelativePath(image.relativePath)) continue;
          const identity = `${source.type}:${source.id}:${image.relativePath}`;
          if (seen.has(identity)) continue;
          seen.add(identity);
          cited.push(normalizeCitedImage({
            id: U.hashString(identity),
            sourceType: source.type,
            sourceDocumentID: source.id,
            sourceDocumentName: source.name,
            markdownRef: exact.markdownRef,
            alt: exact.alt,
            target: exact.target,
            name: image.name,
            relativePath: image.relativePath
          }));
        }
      }
      return cited.filter(Boolean);
    }

    async currentDocumentMessageParts(documentID, question = "", session = null, documentOptions = {}) {
      const options = normalizeDocumentOptions(documentOptions);
      const revisionSource = String(session?.revisionSourceRelativePath || "");
      const archived = Boolean(session?.archivedDocumentRevision && revisionSource);
      const revisionBase = archived
        ? revisionSource.replace(/\\/g, "/").split("/").slice(0, -1).join("/")
        : "";
      const markdown = await this.storage.readText(
        archived
          ? this.storage.path(documentID, ...revisionSource.split("/"))
          : this.storage.path(documentID, "full.cleaned.md"),
        ""
      );
      if (!markdown.trim()) return null;
      const parts = [];
      this.appendTextPart(
        parts,
        "以下是当前Zotero文献全文。请基于这篇文献回答后续问题；不要裁切、摘取或忽略正文内容。\n" +
        `文档发送方式: ${options.imageMode === "full_no_images" ? "全文无图" : `全文带图 · ${options.compressImages ? "压缩图片" : "原图"} · ${options.sequentialImages ? "顺序读图" : "全文后附图"}`}\n` +
        "注意：Markdown中的 IMAGE_001 等图片占位符会与随后的图片说明和图片数据对应。\n" +
        "本篇文献的图片来源标签：当前文献。\n" +
        `图片引用协议：${IMAGE_CITATION_INSTRUCTION}\n\n` +
        "===== 当前Zotero文献开始 =====\n\n"
      );
      const sentImages = new Set();
      const imagePattern = /!\[(?<alt>[^\]]*)\]\(\s*(?<target><[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/gs;
      let lastEnd = 0;
      const matches = [...markdown.matchAll(imagePattern)];
      if (options.imageMode === "full_no_images") {
        this.appendTextPart(parts, markdown);
        this.appendTextPart(parts, "\n\n===== 当前Zotero文献结束 =====");
        if (String(question || "").trim()) this.appendTextPart(parts, `\n\n===== 用户问题 =====\n${String(question).trim()}`);
        return parts;
      }
      if (!options.sequentialImages) this.appendTextPart(parts, markdown);
      for (const match of matches) {
        if (options.sequentialImages) {
          this.appendTextPart(parts, markdown.slice(lastEnd, match.index));
          this.appendTextPart(parts, `\n\n${match[0]}\n`);
        }
        const alt = String(match.groups?.alt || "").trim();
        const target = String(match.groups?.target || "").replace(/^<|>$/g, "").trim();
        try {
          const image = await this.currentDocumentImageDataURL(documentID, target, alt, revisionBase, options);
          if (!image) {
            this.appendTextPart(parts, "\n[这张图片暂时无法读取，已保留文中的图片引用。]\n");
          }
          else if (sentImages.has(image.relative)) {
            this.appendTextPart(parts, `\n该图片文件此前已经发送过，当前为重复引用，不重复发送图片数据：${image.name}\n`);
          }
          else {
            const imageID = alt || `IMAGE_${String(sentImages.size + 1).padStart(3, "0")}`;
            this.appendTextPart(
              parts,
              `\n\n下面是当前Zotero文献中的图片 ${imageID}。\n` +
              `Markdown引用: ${match[0]}\n图片文件: ${image.name}\n` +
              "请把这张图片与正文中的对应占位符、图注和上下文一起阅读。\n"
            );
            parts.push({ type: "image_url", image_url: { url: image.dataURL } });
            sentImages.add(image.relative);
          }
        }
        catch (_) {
          this.appendTextPart(parts, "\n[提示：读取图片失败，因此本处只保留Markdown图片引用。]\n");
        }
        lastEnd = Number(match.index || 0) + match[0].length;
      }
      if (options.sequentialImages) this.appendTextPart(parts, markdown.slice(lastEnd));
      this.appendTextPart(parts, "\n\n===== 当前Zotero文献结束 =====");
      if (String(question || "").trim()) {
        this.appendTextPart(parts, `\n\n===== 用户问题 =====\n${String(question).trim()}`);
      }
      return parts;
    }

    async diagnoseCurrentDocumentImages(documentID, session = null, documentOptions = {}) {
      const revisionSource = String(session?.revisionSourceRelativePath || "");
      const archived = Boolean(session?.archivedDocumentRevision && revisionSource);
      const revisionBase = archived
        ? revisionSource.replace(/\\/g, "/").split("/").slice(0, -1).join("/")
        : "";
      const markdown = await this.storage.readText(
        archived
          ? this.storage.path(documentID, ...revisionSource.split("/"))
          : this.storage.path(documentID, "full.cleaned.md"),
        ""
      );
      const imagePattern = /!\[(?<alt>[^\]]*)\]\(\s*(?<target><[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/gs;
      const rows = [];
      for (const match of markdown.matchAll(imagePattern)) {
        const alt = String(match.groups?.alt || "").trim();
        const target = String(match.groups?.target || "").replace(/^<|>$/g, "").trim();
        try {
          const image = await this.currentDocumentImageDataURL(
            documentID,
            target,
            alt,
            revisionBase,
            documentOptions
          );
          rows.push({
            alt,
            target,
            ok: Boolean(image?.dataURL?.startsWith("data:image/")),
            mimeType: String(image?.dataURL || "").match(/^data:([^;,]+)/)?.[1] || "",
            dataChars: String(image?.dataURL || "").length,
            relative: String(image?.relative || "")
          });
        }
        catch (error) {
          rows.push({
            alt,
            target,
            ok: false,
            errorName: String(error?.name || "Error"),
            errorMessage: String(error?.message || error || "读取失败")
              .replace(/[A-Za-z]:\\[^\r\n]+/g, "[本地路径已隐藏]")
          });
        }
      }
      return rows;
    }

    async hasCurrentDocumentSource(documentID, session = null) {
      const revisionSource = String(session?.revisionSourceRelativePath || "");
      const archived = Boolean(session?.archivedDocumentRevision && revisionSource);
      const sourcePath = archived
        ? this.storage.path(documentID, ...revisionSource.replace(/\\/g, "/").split("/"))
        : this.storage.path(documentID, "full.cleaned.md");
      return Boolean(String(await this.storage.readText(sourcePath, "")).trim());
    }

    async attachCurrentDocumentToFirstTurn(documentID, session, userIndex, emit = null) {
      // Attach the current document once per conversation. Clearing the
      // conversation removes the marker so the next question attaches it again.
      const priorMessages = session.messages.slice(0, userIndex);
      if (priorMessages.some(message => message?.role === "user" && message.currentDocument)) {
        return session;
      }
      if (!await this.hasCurrentDocumentSource(documentID, session)) {
        throw new Error("当前文献没有可用的正文，请先重新解析后再提问");
      }
      session.messages[userIndex] = {
        ...session.messages[userIndex],
        currentDocument: true
      };
      session = await this.saveSession(documentID, session, false);
      emit?.({ type: "chat-session", session: this.presentSession(documentID, session) });
      emit?.({ type: "log", message: "当前文献的正文和图片已加入对话，后续可以直接追问。" });
      return session;
    }

    async documentMessageParts(documentID, message, selectedAttachmentIDs, transportOptions = {}) {
      const documents = (Array.isArray(message?.documents) ? message.documents : [])
        .map(normalizeDocumentAttachment).filter(Boolean);
      if (!documents.length) return null;
      const options = normalizeDocumentOptions(message.documentOptions);
      const parts = [];
      this.appendTextPart(
        parts,
        "以下是用户添加的文档全文。请基于这些文档回答后续问题；不要裁切、摘取或忽略正文内容。\n" +
        `文档发送方式: ${options.imageMode === "full_no_images" ? "全文无图" : `全文带图 · ${options.compressImages ? "压缩图片" : "原图"} · ${options.sequentialImages ? "顺序读图" : "全文后附图"}`}\n` +
        "注意：Markdown中的 IMAGE_001 等图片占位符会与随后的图片说明和图片数据对应。\n" +
        `图片引用协议：${IMAGE_CITATION_INSTRUCTION}\n\n`
      );
      const sentImages = new Set();
      const imagePattern = /!\[(?<alt>[^\]]*)\]\(\s*(?<target><[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/gs;
      for (let docIndex = 0; docIndex < documents.length; docIndex++) {
        const document = documents[docIndex];
        const markdown = await this.storage.readText(
          this.storage.path(documentID, ...document.markdownRelativePath.split("/")),
          ""
        );
        this.appendTextPart(parts, `\n\n===== 文档 ${docIndex + 1}: ${document.name} =====\n图片来源标签：${document.name}\n\n`);
        let lastEnd = 0;
        const matches = [...markdown.matchAll(imagePattern)];
        if (options.imageMode === "full_no_images") {
          this.appendTextPart(parts, markdown);
          continue;
        }
        if (!options.sequentialImages) this.appendTextPart(parts, markdown);
        for (const match of matches) {
          if (options.sequentialImages) {
            this.appendTextPart(parts, markdown.slice(lastEnd, match.index));
            this.appendTextPart(parts, `\n\n${match[0]}\n`);
          }
          const alt = String(match.groups?.alt || "").trim();
          const target = String(match.groups?.target || "").replace(/^<|>$/g, "").trim();
          try {
            const image = await this.documentImageDataURL(documentID, document, target, alt, options);
            if (!image) {
              this.appendTextPart(parts, "\n[这张图片暂时无法读取，已保留文中的图片引用。]\n");
            }
            else if (sentImages.has(`${document.id}:${image.relative}`)) {
              this.appendTextPart(parts, `\n该图片文件此前已经发送过，当前为重复引用，不重复发送图片数据：${image.name}\n`);
            }
            else {
              const imageID = alt || `IMAGE_${String(sentImages.size + 1).padStart(3, "0")}`;
              this.appendTextPart(
                parts,
                `\n\n下面是文档《${document.name}》中的图片 ${imageID}。\n` +
                `Markdown引用: ${match[0]}\n图片文件: ${image.name}\n` +
                "请把这张图片与正文中的对应占位符、图注和上下文一起阅读。\n"
              );
              parts.push({ type: "image_url", image_url: { url: image.dataURL } });
              sentImages.add(`${document.id}:${image.relative}`);
            }
          }
          catch (error) {
            Zotero.debug?.(`[LitMTrans] documentMessageParts 读取图片失败: ${String(error?.stack || error)}`);
            this.appendTextPart(parts, "\n[提示：读取图片失败，因此本处只保留Markdown图片引用。]\n");
          }
          lastEnd = Number(match.index || 0) + match[0].length;
        }
        if (options.sequentialImages) this.appendTextPart(parts, markdown.slice(lastEnd));
        if (sentImages.size || matches.length) {
          Zotero.debug?.(`[LitMTrans] documentMessageParts: 文档"${document.name}" 共${matches.length}个图片引用，成功发送${sentImages.size}个`);
        }
      }
      if (transportOptions.includeQuestion !== false) {
        this.appendTextPart(parts, `\n\n===== 用户问题 =====\n${messageTextForAPI(message)}`);
      }
      if (transportOptions.includeAttachments !== false) {
        for (const attachment of Array.isArray(message.attachments) ? message.attachments : []) {
          const normalized = normalizeAttachment(attachment);
          if (!normalized || !selectedAttachmentIDs.has(normalized.id)) continue;
          try {
            const dataURL = await this.attachmentDataURL(documentID, normalized);
            if (!dataURL) continue;
            this.appendTextPart(parts, `\n\n下面是用户随本轮问题额外附加的图片，名称：${normalized.name}。\n`);
            parts.push({ type: "image_url", image_url: { url: dataURL } });
          }
          catch (_) {}
        }
      }
      return parts;
    }

    async historyMessagesForAPI(documentID, messages, session = null, loadedAttachmentIDs = null) {
      const history = Array.isArray(messages) ? messages : [];
      const selected = new Set();
      for (let messageIndex = history.length - 1; messageIndex >= 0; messageIndex--) {
        const attachments = Array.isArray(history[messageIndex]?.attachments) ? history[messageIndex].attachments : [];
        for (let attachmentIndex = attachments.length - 1; attachmentIndex >= 0; attachmentIndex--) {
          const attachment = normalizeAttachment(attachments[attachmentIndex]);
          if (!attachment) continue;
          selected.add(attachment.id);
        }
      }

      const output = [];
      let userTurnOrdinal = 0;
      let assistantTurnOrdinal = 0;
      for (let messageIndex = 0; messageIndex < history.length; messageIndex++) {
        const message = history[messageIndex];
        const latest = messageIndex === history.length - 1;
        const turnOrdinal = message.role === "user" ? ++userTurnOrdinal : ++assistantTurnOrdinal;
        const text = messageTextForAPI(message);
        const attachments = (Array.isArray(message.attachments) ? message.attachments : [])
          .map(item => normalizeAttachment(item)).filter(item => item && selected.has(item.id));
        if (message.role === "user" && message.currentDocument) {
          const hasExtraDocuments = Array.isArray(message.documents) && message.documents.length;
          const currentParts = await this.currentDocumentMessageParts(
            documentID,
            "",
            session,
            message.documentOptions
          );
          const documentParts = hasExtraDocuments
            ? await this.documentMessageParts(documentID, message, selected, {
              includeQuestion: false,
              includeAttachments: false
            })
            : null;
          const content = [
            ...(currentParts || []),
            ...(documentParts || [])
          ];
          const attachmentResult = await this.appendAttachmentParts(documentID, content, attachments, {
            role: message.role,
            turnOrdinal,
            latest,
            loadedAttachmentIDs
          });
          this.appendUserQuestionAfterImages(content, text, attachmentResult.references, latest);
          output.push({ role: message.role, content: content.length ? content : text });
          continue;
        }
        if (message.role === "user" && Array.isArray(message.documents) && message.documents.length) {
          const content = await this.documentMessageParts(documentID, message, selected, {
            includeQuestion: false,
            includeAttachments: false
          }) || [];
          const attachmentResult = await this.appendAttachmentParts(documentID, content, attachments, {
            role: message.role,
            turnOrdinal,
            latest,
            loadedAttachmentIDs
          });
          this.appendUserQuestionAfterImages(content, text, attachmentResult.references, latest);
          output.push({ role: message.role, content: content.length ? content : text });
          continue;
        }
        if (!attachments.length) {
          const legacyParts = Array.isArray(message.legacyContentParts)
            ? message.legacyContentParts.filter(part => part?.type === "image_url" || (part?.type === "text" && String(part.text || "")))
            : [];
          if (legacyParts.some(part => part.type === "image_url")) {
            output.push({ role: message.role, content: legacyParts });
            continue;
          }
          output.push({ role: message.role, content: text });
          continue;
        }
        const content = [];
        if (message.role === "assistant") this.appendTextPart(content, text);
        const attachmentResult = await this.appendAttachmentParts(documentID, content, attachments, {
          role: message.role,
          turnOrdinal,
          latest,
          loadedAttachmentIDs
        });
        if (message.role === "user") {
          this.appendUserQuestionAfterImages(content, text, attachmentResult.references, latest);
        }
        output.push({ role: message.role, content: content.length ? content : text });
      }
      return output;
    }

    responseSummary(result, provider = "") {
      const usage = result?.usage;
      if (!usage || typeof usage !== "object") return "";
      const input = Number(usage.prompt_tokens) || 0;
      const output = Number(usage.completion_tokens) || 0;
      const promptDetails = usage.prompt_tokens_details || {};
      const cached = Number(promptDetails.cached_tokens ?? usage.cached_input_tokens ?? usage.prompt_cache_hit_tokens) || 0;
      const hitRate = input > 0 ? Math.round((cached / input) * 100) : 0;
      const model = String(result?.model || "").trim();
      return `服务商：${provider}；模型：${model}；输入：${input}；输出：${output}；缓存命中：${hitRate}%`;
    }

    async buildContext(documentID, options = {}, session = null) {
      const settings = this.llm.getSettings("chat");
      const selectedText = String(options.selectedText || "").trim();
      const archived = Boolean(session?.archivedDocumentRevision);
      const revisionSource = String(session?.revisionSourceRelativePath || "");
      const source = archived && revisionSource
        ? await this.storage.readText(this.storage.path(documentID, ...revisionSource.split("/")), "")
        : await this.storage.readText(this.storage.path(documentID, "full.cleaned.md"), "");
      const pieces = [];
      if (selectedText) {
        pieces.push(`===== 用户当前引用/选中文本 =====\n${selectedText}\n===== 引用结束 =====`);
      }
      if (!options.excludeSource && source) {
        pieces.push(`===== 文献原文 =====\n${source}\n===== 原文结束 =====`);
      }
      return trimContext(pieces.join("\n\n"), settings.chatContextChars);
    }

    buildImageConversationPrompt(messages, userIndex, useEditMode) {
      const history = (Array.isArray(messages) ? messages : []).slice(0, userIndex + 1);
      const latest = history[userIndex];
      const lines = [
        "请阅读下面按时间顺序整理的完整对话历史，理解用户需求如何逐步变化。",
        "如果较早要求与较新要求冲突，请以后面的要求为准。",
        "最后一段“最新一轮用户要求”优先级最高，必须优先满足。",
        "",
        "===== 按时间顺序的历史对话 ====="
      ];
      history.forEach((message, index) => {
        const role = message.role === "user" ? "用户" : "助手";
        const text = messageContentToText(message.content).trim();
        const imageCount = messageContentImageDataURLs(message.content).length
          || (Array.isArray(message.attachments) ? message.attachments.length : 0);
        lines.push(`[${index + 1}] ${role}`);
        lines.push(text || "（本条没有文字内容）");
        if (imageCount) lines.push(`（本条包含 ${imageCount} 张${message.role === "assistant" ? "助手生成" : "用户提供"}图片）`);
        lines.push("");
      });
      lines.push("===== 最新一轮用户要求（最高优先级） =====");
      lines.push(messageContentToText(latest?.content).trim() || (useEditMode ? "请根据参考图继续修改。" : "请生成一张图片。"));
      if (useEditMode) {
        lines.push("");
        lines.push("请结合本次随请求附带的参考图进行编辑；如果附带了多张图，请综合参考它们。");
      }
      return lines.join("\n").trim();
    }

    async imageInputsForTurn(documentID, messages, userIndex, currentAPIContent = null) {
      const rows = Array.isArray(messages) ? messages : [];
      const user = rows[userIndex];
      const contentImages = messageContentImageDataURLs(currentAPIContent);
      if (contentImages.length) {
        const images = [];
        for (let index = 0; index < contentImages.length; index++) {
          try {
            const decoded = decodeImageDataURL(contentImages[index]);
            images.push({
              bytes: decoded.bytes,
              mimeType: decoded.mimeType,
              name: `turn-image-${index + 1}${IMAGE_MIME_EXTENSIONS[decoded.mimeType] || ".png"}`
            });
          }
          catch (_) {}
        }
        if (images.length) {
          return {
            images,
            label: `本轮文档/图片输入 ${images.length} 张`
          };
        }
      }
      let attachments = Array.isArray(user?.attachments) ? user.attachments : [];
      let label = attachments.length ? `本轮图片附件 ${attachments.length} 张` : "";
      if (!attachments.length) {
        for (let index = userIndex - 1; index >= 0; index--) {
          const candidates = Array.isArray(rows[index]?.attachments) ? rows[index].attachments : [];
          if (!candidates.length) continue;
          attachments = [candidates[candidates.length - 1]];
          label = rows[index]?.role === "assistant"
            ? "已自动复用最近一张历史输出图"
            : "已自动复用最近一张历史用户图片";
          break;
        }
      }
      const images = [];
      for (const item of attachments) {
        const normalized = normalizeAttachment(item);
        if (!normalized) continue;
        try {
          const bytes = await this.storage.readBytes(this.storage.path(documentID, normalized.relativePath));
          if (bytes?.length) images.push({
            bytes,
            mimeType: normalized.mimeType,
            name: normalized.name
          });
        }
        catch (_) {}
      }
      return { images, label };
    }

    async generateImageReply(documentID, session, userIndex, options = {}, emit = null, signal = null) {
      const insertIndex = userIndex + 1;
      const apiHistory = await this.historyMessagesForAPI(documentID, session.messages.slice(0, insertIndex), session);
      const currentAPIContent = apiHistory[apiHistory.length - 1]?.content;
      const input = await this.imageInputsForTurn(documentID, session.messages, userIndex, currentAPIContent);
      const prompt = this.buildImageConversationPrompt(apiHistory, apiHistory.length - 1, Boolean(input.images.length));
      const settings = this.llm.getSettings("chat");
      if (input.label) emit?.({ type: "warning", message: `图片编辑将使用${input.label}。` });
      const result = await this.llm.generateImage(prompt, {
        purpose: "chat",
        imageSize: settings.chatImageSize,
        imageQuality: settings.chatImageQuality,
        imageFormat: settings.chatImageFormat,
        images: input.images,
        timeout: 300000,
        signal
      });
      const assistantID = U.randomID("message");
      const attachments = await this.persistGeneratedImages(documentID, session.id, assistantID, result.images);
      const assistant = {
        id: assistantID,
        role: "assistant",
        content: String(result.text || "").trim() || (attachments.length ? "图片已生成。" : "图片模型已返回。"),
        attachments,
        reasoning: "",
        interrupted: false,
        createdAt: new Date().toISOString()
      };
      session.messages.splice(insertIndex, 0, assistant);
      session = await this.saveSession(documentID, session, false);
      emit?.({ type: "chat-complete", session: this.presentSession(documentID, session), message: this.presentMessage(documentID, assistant), insertIndex });
      return { session: this.presentSession(documentID, session), message: this.presentMessage(documentID, assistant) };
    }

    async generateReply(documentID, session, userIndex, options = {}, emit = null, signal = null) {
      const isWebSession = session?.id === this.documentSessionID("web")
        || session?.id === "web-document-chat"
        || session?.messages?.[userIndex]?.transport?.engine === "deepseek_web";
      const isWeb = isWebSession
        || options.engine === "deepseek_web"
        || options.aiMode === "web"
        || this.llm.isWebEngineActive?.({ purpose: "chat", ...options });
      const replyOptions = isWeb
        ? { ...options, engine: "deepseek_web", aiMode: "web", provider: "deepseek_web" }
        : options;
      let resolvedModel;
      let settings;
      if (isWeb) {
        resolvedModel = { provider: "deepseek_web", model: "deepseek-web", baseURL: "" };
        settings = { ...this.llm.getSettings("chat"), provider: "deepseek_web", model: "deepseek-web", baseURL: "" };
      } else {
        resolvedModel = await this.llm.ensureConfiguredModel(
          this.llm.resolveConfig({ purpose: "chat" }),
          signal
        );
        settings = { ...this.llm.getSettings("chat"), model: resolvedModel.model };
      }
      this.updateSessionModel(session, emit, replyOptions);
      const insertIndex = userIndex + 1;
      const sourceAlreadyInHistory = session.messages
        .slice(0, userIndex)
        .some(message => message?.role === "user" && message.currentDocument);
      if (!sourceAlreadyInHistory) {
        session = await this.attachCurrentDocumentToFirstTurn(documentID, session, userIndex, emit);
      }
      const provider = U.providerSpec(settings.provider);
      if (
        provider.supportsImages !== false
        && LitMTrans.LLMInternals?.isProbablyImageModel?.(settings.model)
      ) {
        return this.generateImageReply(documentID, session, userIndex, options, emit, signal);
      }
      const context = await this.buildContext(
        documentID,
        { ...options, excludeSource: true },
        session
      );
      const loadedAttachmentIDs = new Set();
      const history = await this.historyMessagesForAPI(
        documentID,
        session.messages.slice(0, insertIndex),
        session,
        loadedAttachmentIDs
      );
      const currentUserAttachments = (Array.isArray(session.messages[userIndex]?.attachments)
        ? session.messages[userIndex].attachments
        : []).map(normalizeAttachment).filter(Boolean);
      // The model transport rebuilds message parts in a separate host realm.
      // Do not let loss of the transient `loadedAttachmentIDs` bookkeeping
      // reject an image that was written successfully. Re-read a missing
      // current-turn attachment and put it back into the final user payload.
      const currentHistoryMessage = history[history.length - 1];
      const recoveredCurrentAttachmentIDs = new Set();
      for (const attachment of currentUserAttachments) {
        if (loadedAttachmentIDs.has(attachment.id)) continue;
        try {
          const dataURL = await this.attachmentDataURL(documentID, attachment);
          if (!dataURL) continue;
          loadedAttachmentIDs.add(attachment.id);
          recoveredCurrentAttachmentIDs.add(attachment.id);
          if (!currentHistoryMessage) continue;
          const existing = Array.isArray(currentHistoryMessage.content)
            ? currentHistoryMessage.content
            : [{ type: "text", text: String(currentHistoryMessage.content || "") }];
          const label = attachmentTransportLabel(attachment, {
            role: "user",
            turnOrdinal: currentUserAttachments.length,
            latest: true,
            imageOrdinal: recoveredCurrentAttachmentIDs.size
          });
          currentHistoryMessage.content = [
            { type: "text", text: `\n\n${label.text}` },
            {
              type: "image_url",
              image_url: { url: dataURL },
              localAttachmentID: attachment.id,
              localAttachmentReference: label.reference
            },
            ...existing
          ];
        }
        catch (_) {}
      }
      const loadedCurrentUserAttachments = currentUserAttachments
        .filter(attachment => loadedAttachmentIDs.has(attachment.id));
      if (loadedCurrentUserAttachments.length !== currentUserAttachments.length) {
        const missingNames = currentUserAttachments
          .filter(attachment => !loadedAttachmentIDs.has(attachment.id))
          .map(attachment => attachment.name);
        throw new Error(
          `无法读取本轮添加的图片${missingNames.length ? `“${missingNames.join("、")}”` : ""}，请重新粘贴后再试。`
        );
      }
      const imagePayloads = history.flatMap(message =>
        Array.isArray(message.content)
          ? message.content.filter(part => part?.type === "image_url" && String(part?.image_url?.url || "").startsWith("data:image/"))
          : []
      );
      const hasImagePayload = Boolean(imagePayloads.length);
      const imagePayloadBytes = imagePayloads.reduce((total, part) => {
        const dataURL = String(part?.image_url?.url || "");
        const base64 = dataURL.slice(dataURL.indexOf(",") + 1);
        return total + Math.max(0, Math.floor(base64.length * 3 / 4) - (base64.endsWith("==") ? 2 : (base64.endsWith("=") ? 1 : 0)));
      }, 0);
      const system = (
        "You are the document assistant embedded in Zotero. Answer the user's question using the supplied document context, images, and conversation history. " +
        "Be precise about what the document explicitly supports. Distinguish source text from translated text when that distinction matters. " +
        "Preserve formulas, symbols, units, citation numbers, section names, and uncertainty. Do not claim to have read content not supplied. " +
        `Answer in ${options.responseLanguage || settings.targetLanguage || "简体中文"} unless the user clearly requests another language. ` +
        "For document-grounded answers, cite recognizable section names, page numbers, quotation fragments, figure/table labels, or formula identifiers when available."
      );
      let messages = [{ role: "system", content: system }];
      messages.push(...history);
      // Current selections vary from turn to turn.  They must follow the
      // stable system prompt, document source, and conversation history or
      // they invalidate the long reusable prefix used by Z.AI, Gemini, and
      // SiliconFlow automatic context caches.
      appendDynamicContextToLatestUser(messages, context);
      const imageCapabilityKey = String(settings.model || "").trim().toLowerCase();
      let outgoingImageCount = imagePayloads.length;
      let outgoingCurrentUserImageCount = loadedCurrentUserAttachments.length;
      if (hasImagePayload && this.isImageUnsupported(imageCapabilityKey)) {
        messages = textOnlyMessages(messages);
        outgoingImageCount = 0;
        outgoingCurrentUserImageCount = 0;
        emit?.({ type: "warning", message: "当前模型此前已确认不支持图片输入，本轮保留文档全文并自动省略图片。" });
      }

      const assistant = {
        id: U.randomID("message"),
        role: "assistant",
        content: "",
        reasoning: "",
        interrupted: false,
        createdAt: new Date().toISOString()
      };
      let persistTimer = null;
      const persist = async () => {
        if (!assistant.content && !assistant.reasoning) return;
        const messages = session.messages.slice();
        messages.splice(insertIndex, 0, { ...assistant });
        const pending = {
          ...session,
          messages
        };
        await this.saveSession(documentID, pending, false);
      };
      const schedulePersist = () => {
        if (persistTimer) return;
        persistTimer = setTimeout(async () => {
          persistTimer = null;
          try { await persist(); } catch (_) {}
        }, 900);
      };
      const completionOptions = {
        purpose: "chat",
        clipboardPrompt: messageTextForAPI(session.messages[userIndex]),
        taskType: session.messages[userIndex]?.taskType || options.taskType || "chat",
        documentID,
        sessionID: session.id,
        provider: settings.provider,
        engine: isWeb ? "deepseek_web" : options.engine,
        aiMode: isWeb ? "web" : options.aiMode,
        promptCacheKey: session.apiCacheSessionID,
        runtime: options.runtime,
        emit,
        // Reasoning models may take an arbitrary time before emitting a token.
        // The user, rather than a client deadline, controls when to stop.
        timeout: 0,
        firstEventTimeout: 0,
        inactivityTimeout: 0,
        signal,
        onText: delta => {
          assistant.content += delta;
          // Send the new fragment only.  Re-sending the complete accumulated
          // answer for every SSE event makes long answers allocate O(n²) text
          // across the host and embedded workbench while they are streaming.
          emit?.({ type: "chat-delta", sessionID: session.id, messageID: assistant.id, insertIndex, delta });
          schedulePersist();
        },
        onReasoning: delta => {
          assistant.reasoning += delta;
          emit?.({ type: "reasoning", scope: "chat", sessionID: session.id, messageID: assistant.id, delta });
          schedulePersist();
        }
      };

      try {
        emit?.({
          type: "log",
          message: "正在发送问题…"
        });
        let result;
        try {
          result = await this.llm.complete(messages, completionOptions);
        }
        catch (error) {
          if (
            !assistant.content
            && !assistant.reasoning
            && String(error?.name || "") === "StreamTimeoutError"
            && String(settings.provider || "") === "gemini"
          ) {
            emit?.({
              type: "warning",
              message: "Gemini响应较慢，正在更换连接方式重试。"
            });
            result = await this.llm.complete(messages, {
              ...completionOptions,
              stream: false,
              timeout: 0,
              firstEventTimeout: 0,
              inactivityTimeout: 0
            });
          }
          else if (!assistant.content && outgoingImageCount > 0 && looksLikePayloadTooLargeError(error)) {
            emit?.({ type: "warning", message: "请求内容过大，本轮将省略图片，根据文字和文献内容重试。原图已保留。" });
            messages = textOnlyMessages(messages);
            outgoingImageCount = 0;
            outgoingCurrentUserImageCount = 0;
            result = await this.llm.complete(messages, completionOptions);
          }
          else if (!assistant.content && hasImagePayload && looksLikeImageUnsupportedError(error)) {
            this.markImageUnsupported(imageCapabilityKey);
            const currentUserMessage = session.messages[userIndex];
            if (Array.isArray(currentUserMessage?.attachments) && currentUserMessage.attachments.length) {
              await this.removeMessageAttachments(documentID, [{ attachments: currentUserMessage.attachments }]);
              currentUserMessage.attachments = [];
              // The files have already been removed, so persist the matching
              // message state before retrying. Otherwise a failed text-only
              // retry would leave a session pointing at deleted attachments.
              session = await this.saveSession(documentID, session, false);
              emit?.({ type: "chat-session", session: this.presentSession(documentID, session) });
            }
            emit?.({ type: "warning", message: "当前模型不支持图片输入，本轮将根据文字和文献内容继续回答。" });
            messages = textOnlyMessages(messages);
            outgoingImageCount = 0;
            outgoingCurrentUserImageCount = 0;
            result = await this.llm.complete(messages, completionOptions);
          }
          else throw error;
        }
        assistant.content = String(result.text || assistant.content).trim();
        assistant.reasoning = String(result.reasoning || assistant.reasoning || "");
        assistant.responseInfo = responseInfo(result, settings.provider);
        if (!assistant.content) throw new Error("模型没有返回正文");
        assistant.citedImages = await this.resolveAssistantImageCitations(
          documentID, session, userIndex, assistant.content
        );
        session.messages.splice(insertIndex, 0, assistant);
        session = await this.saveSession(documentID, session, false);
        const responseSummary = this.responseSummary(result, settings.provider);
        if (responseSummary) emit?.({ type: "chat-usage", sessionID: session.id, message: responseSummary });

        if (
          settings.showReasoning
          && !assistant.reasoning.trim()
        ) {
          const reasoningTokens = Number(result?.usage?.completion_tokens_details?.reasoning_tokens || 0);
          emit?.({
            type: "system-info",
            message: reasoningTokens > 0
              ? "模型进行了内部推理，但服务商没有返回可显示的思考过程。"
              : "服务商没有返回可显示的思考过程。"
          });
        }
        emit?.({ type: "chat-complete", session: this.presentSession(documentID, session), message: this.presentMessage(documentID, assistant), insertIndex });
        return { session: this.presentSession(documentID, session), message: this.presentMessage(documentID, assistant) };
      }
      catch (error) {
        // Keep useful partial output when a request is stopped or a gateway
        // disconnects. The saved flag makes it explicit that this is not a
        // completed answer and prevents an abrupt stop from discarding work.
        if (String(assistant.content || "").trim()) {
          assistant.content = String(assistant.content).trim();
          assistant.reasoning = String(assistant.reasoning || "");
          assistant.interrupted = true;
          assistant.citedImages = await this.resolveAssistantImageCitations(
            documentID, session, userIndex, assistant.content
          );
          session.messages.splice(insertIndex, 0, assistant);
          session = await this.saveSession(documentID, session, false);
        }
        else if (userIndex >= 0 && userIndex === session.messages.length - 1 && session.messages[userIndex]?.role === "user") {
          // 若 Assistant 没有任何输出且当前轮次处于会话末尾，移除该孤立提问以防止污染后续历史
          session.messages.splice(userIndex, 1);
          session = await this.saveSession(documentID, session, false);
        }
        emit?.({ type: "chat-error", sessionID: session.id, session: this.presentSession(documentID, session), error: U.normalizeError(error) });
        throw error;
      }
      finally {
        if (persistTimer) clearTimeout(persistTimer);
      }
    }

    async resend(documentID, sessionID, messageID, options = {}, emit = null, signal = null, editedText = undefined) {
      let session = await this.loadSession(documentID, sessionID, false);
      const range = findTurnRange(session.messages, messageID);
      if (!range || session.messages[range.start]?.role !== "user") {
        throw new Error("只能从用户消息所在的轮次重新生成回答");
      }
      const storedEngine = session.messages[range.start]?.transport?.engine;
      const isWeb = session.id === this.documentSessionID("web")
        || session.id === "web-document-chat"
        || storedEngine === "deepseek_web"
        || session.messages[range.start]?.transport?.aiMode === "web"
        || options.engine === "deepseek_web"
        || options.aiMode === "web"
        || this.llm.isWebEngineActive?.({ purpose: "chat", ...options });
      const transport = isWeb
        ? { ...options, engine: "deepseek_web", aiMode: "web", provider: "deepseek_web" }
        : (options.engine || options.aiMode
          ? options
          : { ...options, engine: storedEngine === "deepseek_web" ? "deepseek_web" : "api", aiMode: storedEngine === "deepseek_web" ? "web" : "api" });
      this.updateSessionModel(session, emit, transport);
      if (isWeb && ["key_points", "paper_mindmap", "paper_logic_flow"].includes(session.messages[range.start]?.taskType)) {
        const task = taskFor({ taskType: session.messages[range.start].taskType, aiMode: "web" }, this.llm.getSettings("chat"));
        session.messages[range.start] = {
          ...session.messages[range.start],
          taskInstruction: task.taskInstruction,
          diagramMode: task.diagramMode,
          formatInstruction: task.formatInstruction
        };
      }
      if (editedText !== undefined) {
        const content = String(editedText || "").trim();
        if (!content) throw new Error("消息内容不能为空");
        session.messages[range.start] = {
          ...session.messages[range.start],
          content
        };
      }
      if (isWeb) {
        session.messages[range.start].transport = {
          ...(session.messages[range.start].transport || {}),
          engine: "deepseek_web"
        };
      }
      session.messages.splice(range.start + 1, range.end - range.start - 1);
      session = await this.saveSession(documentID, session, false);
      emit?.({ type: "chat-session", session: this.presentSession(documentID, session) });
      return this.generateReply(documentID, session, range.start, transport, emit, signal);
    }

    async send(documentID, sessionID, userText, options = {}, emit = null, signal = null) {
      const isWeb = sessionID === "web-document-chat"
        || sessionID === this.documentSessionID("web")
        || options.engine === "deepseek_web"
        || options.aiMode === "web"
        || this.llm.isWebEngineActive?.({ purpose: "chat", ...options });
      const sendOptions = isWeb
        ? { ...options, engine: "deepseek_web", aiMode: "web", provider: "deepseek_web" }
        : options;
      const incomingImages = Array.isArray(sendOptions.images) ? sendOptions.images : [];
      const documents = (Array.isArray(sendOptions.documents) ? sendOptions.documents : [])
        .map(normalizeDocumentAttachment).filter(Boolean);
      const referenceQuotes = normalizeReferenceQuotes(sendOptions.referenceQuotes);
      const rawQuestion = String(userText || "").trim();
      const imageCapabilityKey = String(this.llm.getSettings("chat").model || "").trim().toLowerCase();
      const imagesAlreadyUnsupported = !isWeb && incomingImages.length && this.isImageUnsupported(imageCapabilityKey);
      if (imagesAlreadyUnsupported && !rawQuestion && !documents.length && !referenceQuotes.length) {
        throw new Error("当前模型不支持图片输入。请更换支持图片的模型，或输入文字问题。");
      }
      if (imagesAlreadyUnsupported) {
        emit?.({
          type: "warning",
          message: "当前模型不支持图片输入，本轮将只发送文字和文献内容。"
        });
      }
      const question = String(userText || "").trim()
        || (documents.length ? "请先阅读并概括这些文档。" : (incomingImages.length ? "请结合当前文献分析这些图片。" : ""));
      if (!question && !referenceQuotes.length) throw new Error("请输入问题、添加图片、附加文档或引用文档内容");
      let session = await this.loadSession(documentID, sessionID, false);
      this.updateSessionModel(session, emit, sendOptions);
      while (session.messages.length && session.messages[session.messages.length - 1]?.role === "user") {
        session.messages.pop();
      }
      const priorDocumentIDs = new Set(
        session.messages.flatMap(message =>
          (Array.isArray(message?.documents) ? message.documents : [])
            .map(document => String(document?.id || "")).filter(Boolean)
        )
      );
      const duplicateDocuments = documents.filter(document => priorDocumentIDs.has(document.id));
      if (duplicateDocuments.length) {
        throw new Error(
          `文件“${duplicateDocuments.map(document => document.name).join("、")}”已经发送进当前对话上下文；` +
          "可以直接继续追问；如需重新发送，请先清空当前文献的对话记录。"
        );
      }
      const userMessageID = U.randomID("message");
      const task = taskFor(sendOptions, this.llm.getSettings("chat"));
      const attachments = await this.persistIncomingImages(
        documentID,
        session.id,
        userMessageID,
        imagesAlreadyUnsupported ? [] : incomingImages
      );
      session.messages.push({
        id: userMessageID,
        role: "user",
        content: question,
        attachments,
        documents,
        documentOptions: normalizeDocumentOptions(sendOptions.documentOptions),
        referenceQuotes,
        taskType: task.taskType,
        taskInstruction: task.taskInstruction,
        diagramMode: task.diagramMode,
        formatInstruction: task.formatInstruction,
        transport: {
          engine: isWeb ? "deepseek_web" : "api"
        },
        createdAt: new Date().toISOString()
      });
      session = await this.saveSession(documentID, session, false);
      emit?.({ type: "chat-session", session: this.presentSession(documentID, session) });
      return this.generateReply(documentID, session, session.messages.length - 1, sendOptions, emit, signal);
    }
  }

  LitMTrans.ChatService = ChatService;
  LitMTrans.ChatInternals = {
    NON_MULTIMODAL_MARK_TTL_MS,
    DEFAULT_KEY_POINTS_PROMPT,
    KEY_POINTS_TASK_FRAME,
    KEY_POINTS_SYSTEM_PROTOCOL,
    DIAGRAM_CHINESE_INSTRUCTION,
    MINDMAP_FORMAT_INSTRUCTION,
    FLOWCHART_FORMAT_INSTRUCTION,
    MINDMAP_V2_FORMAT_INSTRUCTION,
    FLOWCHART_V2_FORMAT_INSTRUCTION,
    WEB_MINDMAP_FORMAT_INSTRUCTION,
    WEB_FLOWCHART_FORMAT_INSTRUCTION,
    PAPER_MINDMAP_TASK_INSTRUCTION,
    PAPER_LOGIC_FLOW_TASK_INSTRUCTION,
    taskFor,
    clipboardTaskPrompt,
    IMAGE_CITATION_INSTRUCTION,
    decodeImageDataURL,
    findTurnRange,
    normalizeReferenceQuote,
    normalizeReferenceQuotes,
    normalizeMessage,
    normalizeCitedImage,
    markdownImagePlaceholders,
    attachmentConversationReference,
    attachmentTransportLabel,
    referenceQuoteIdentity,
    combinedReferenceText,
    messageTextForAPI,
    looksLikeImageUnsupportedError,
    textOnlyMessages,
    appendDynamicContextToLatestUser
  };
})(this);
