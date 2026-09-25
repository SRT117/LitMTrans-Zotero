(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};

  const refProperties = {
    documentID: { type: "string", description: "LitMTrans documentID，例如 1-ABCD1234" },
    itemKey: { type: "string", description: "Zotero 条目 key" },
    attachmentKey: { type: "string", description: "Zotero 附件 key" },
    itemID: { type: "integer", description: "Zotero 条目 id" }
  };

  function schema(properties = {}, required = []) {
    return { type: "object", properties: { ...refProperties, ...properties }, required, additionalProperties: true };
  }

  function tool(name, description, properties = {}, required = [], operation = "") {
    return {
      name: `litmtrans_${name}`,
      description,
      inputSchema: schema(properties, required),
      _litmtransOperation: operation
    };
  }

  const TOOLS = [
    tool("get_capabilities", "获取 LitMTrans Agent 能力、权限和脱敏配置状态", {}, [], "capabilities"),
    tool("get_client_config", "生成受支持客户端的 LitMTrans 连接配置；普通用户应让智能体自动配置", { client: { type: "string" }, baseURL: { type: "string" } }, [], "client-config"),
    tool("get_active_context", "读取当前 Zotero 选择、打开的 Reader、页面和 LitMTrans 文献上下文", {}, [], "context"),
    tool("get_processing_capacity", "读取解析、翻译、聊天和 DeepSeek Web 的可用状态（不返回凭据）", {}, [], "processing-capacity"),
    tool("approve_external_service", "批准或拒绝一次已显示计划摘要的外部服务调用", { approvalID: { type: "string" }, planHash: { type: "string" }, approved: { type: "boolean" } }, ["approvalID", "approved"], "external-approval"),
    tool("list_libraries", "列出个人库和群组库", {}, [], "library-read"),
    tool("get_library", "读取一个 Zotero 文献库", { libraryID: { type: ["integer", "string"] }, id: { type: ["integer", "string"] }, key: { type: "string" } }, [], "library-read"),
    tool("list_collections", "列出 Collection，并返回完整层级路径", { libraryID: { type: ["integer", "string"] }, query: { type: "string" } }, [], "library-read"),
    tool("get_collection", "读取一个 Collection；可按需返回完整字段、子 Collection 树或条目摘要", { collection: { type: "string" }, collectionID: { type: ["integer", "string"] }, details: { type: "boolean" }, tree: { type: "boolean" }, includeItems: { type: "boolean" }, includeSubcollections: { type: "boolean" }, itemsLimit: { type: "integer" } }, [], "library-read"),
    tool("search_collections", "按名称或完整路径搜索 Collection", { libraryID: { type: ["integer", "string"] }, query: { type: "string" } }, [], "library-read"),
    tool("get_collection_items", "列出 Collection 中的文献，并融合 LitMTrans 状态", { collection: { type: "string" }, collectionID: { type: ["integer", "string"] }, offset: { type: "integer" }, limit: { type: "integer" }, includeStatus: { type: "boolean" } }, [], "library-read"),
    tool("search_items", "搜索 Zotero 条目。支持 q/title/creator/year、日期范围、DOI/ISBN/publication/abstract/language/rights/url/extra、tags/Collection、附件/Note/全文、fieldQueries/operator、relevance 和分页；优先传 itemKey 或 libraryID 缩小范围。", { libraryID: { type: ["integer", "string"] }, key: { type: "string" }, q: { type: "string" }, query: { type: "string" }, title: { type: "string" }, titleOperator: { type: "string", enum: ["contains", "exact", "startsWith", "endsWith", "regex"] }, creator: { type: "string" }, creatorOperator: { type: "string", enum: ["contains", "exact", "startsWith", "endsWith", "regex"] }, year: { type: ["integer", "string"] }, yearFrom: { type: ["integer", "string"] }, yearTo: { type: ["integer", "string"] }, yearRange: { type: "string" }, DOI: { type: "string" }, doi: { type: "string" }, ISBN: { type: "string" }, isbn: { type: "string" }, tag: { type: "string" }, tags: { type: ["string", "array"], items: { type: "string" } }, tagMode: { type: "string", enum: ["any", "all", "none"] }, tagMatch: { type: "string", enum: ["exact", "contains", "startsWith"] }, collection: { type: "string" }, itemType: { type: "string" }, publication: { type: "string" }, publicationTitle: { type: "string" }, publicationTitleOperator: { type: "string", enum: ["contains", "exact"] }, abstract: { type: "string" }, abstractText: { type: "string" }, abstractOperator: { type: "string", enum: ["contains", "regex"] }, language: { type: "string" }, rights: { type: "string" }, url: { type: "string" }, extra: { type: "string" }, attachments: { type: ["boolean", "string"] }, attachmentQuery: { type: "string" }, notes: { type: ["boolean", "string"] }, noteQuery: { type: "string" }, fulltext: { type: ["boolean", "string"] }, fulltextMode: { type: "string", enum: ["attachment", "note", "both"] }, fulltextOperator: { type: "string", enum: ["contains", "exact", "regex"] }, hasAttachment: { type: "boolean" }, hasNote: { type: "boolean" }, dateFrom: { type: "string" }, dateTo: { type: "string" }, dateAdded: { type: "string" }, dateAddedRange: { type: "string" }, dateAddedFrom: { type: "string" }, dateAddedTo: { type: "string" }, dateModified: { type: "string" }, dateModifiedRange: { type: "string" }, dateModifiedFrom: { type: "string" }, dateModifiedTo: { type: "string" }, numPages: { type: ["integer", "string"] }, numPagesRange: { type: "string" }, fieldQueries: { type: ["object", "array"], additionalProperties: true }, operators: { type: "object", additionalProperties: true }, queryLogic: { type: "string", enum: ["and", "or"] }, includeAttachments: { type: "boolean" }, includeNotes: { type: "boolean" }, includeStatus: { type: "boolean" }, includeRelevance: { type: "boolean" }, relevanceScoring: { type: "boolean" }, boostFields: { type: "string" }, sort: { type: "string" }, direction: { type: "string", enum: ["asc", "desc"] }, sortBy: { type: "string" }, sortOrder: { type: "string", enum: ["asc", "desc"] }, offset: { type: "integer" }, limit: { type: "integer" } }, [], "search"),
    tool("literature_search", "按研究问题在本地 Zotero PaperCards 和学术来源中发现候选文献，支持推荐、引用扩展和参考文献扩展。此工具只检索元数据与摘要，不下载全文 PDF；选定候选后调用 litmtrans_acquire_papers 获取并验证 PDF，或通过 litmtrans_literature_import 获取全文。非搜索模式须提供 seedCandidateIDs 或 seedCards。", { query: { type: "string" }, q: { type: "string" }, seedCandidateIDs: { type: "array", items: { type: ["string", "object"] } }, seedCards: { type: "array" }, yearFrom: { type: ["integer", "string"] }, yearTo: { type: ["integer", "string"] }, authors: { type: "string" }, author: { type: "string" }, topic: { type: "string" }, venue: { type: "string" }, openAccessOnly: { type: "boolean" }, limit: { type: "integer" }, offset: { type: "integer" }, localLimit: { type: "integer" }, shortlistLimit: { type: "integer" }, mode: { type: "string", enum: ["search", "recommend", "citations", "references"] }, external: { type: "boolean" }, includeGraph: { type: "boolean" }, includeEvidence: { type: "boolean" } }, [], "literature-discovery"),
    tool("literature_import", "将选定的学术文献按 DOI/题名去重后导入 Zotero。默认尝试获取并验证全文 PDF；设置 acquireFullText=false 可只导入元数据。设置 parse=true 可在获得有效 PDF 后启动 MinerU 解析。", { candidates: { type: "array" }, candidateIDs: { type: "array", items: { type: "string" } }, collection: { type: "string" }, collectionID: { type: "integer" }, acquireFullText: { type: "boolean" }, parse: { type: "boolean" } }, [], "literature-import"),
    tool("acquire_papers", "下载/获取并验证候选文献或已有 Zotero 条目的全文 PDF。复用已有附件，尝试开放获取来源及可用的机构/托管获取通道，去重后将有效 PDF 添加到 Zotero；设置 parse=true 可启动 MinerU 解析。无需手动安装依赖。", { candidates: { type: "array" }, candidateIDs: { type: "array", items: { type: "string" } }, collection: { type: "string" }, collectionID: { type: "integer" }, attachToZotero: { type: "boolean" }, parse: { type: "boolean" }, concurrency: { type: "integer" } }, [], "acquisition-write"),
    tool("fulltext_access", "管理全文 PDF 获取用的机构通道：检查状态、搜索或设置学校、启动网页登录，或重试全文获取任务。系统不会读取或返回 Cookie、密码或令牌。", { action: { type: "string", enum: ["status", "schools", "login", "retry"] }, kind: { type: "string" }, doi: { type: "string" }, identifier: { type: "string" }, query: { type: "string" }, school: { type: "string" }, publisher: { type: "string" }, custom_url: { type: "string" }, jobID: { type: "string" }, candidate: { type: "object" }, candidateID: { type: "string" }, candidates: { type: "array" }, candidateIDs: { type: "array", items: { type: "string" } }, collection: { type: "string" }, collectionID: { type: "integer" }, attachToZotero: { type: "boolean" }, parse: { type: "boolean" }, concurrency: { type: "integer" } }, ["action"], "acquisition-write"),
    tool("literature_graph", "Build or return the citation/topic/author graph for shortlisted literature. Use after metadata discovery when citation or reference expansion is useful; graph nodes and edges remain derived research data. Non-search modes require seedCandidateIDs or seedCards.", { query: { type: "string" }, mode: { type: "string", enum: ["search", "recommend", "citations", "references"] }, seedCandidateIDs: { type: "array", items: { type: ["string", "object"] } }, seedCards: { type: "array" }, limit: { type: "integer" }, external: { type: "boolean" } }, [], "literature-discovery"),
    tool("review_workspace", "Create, refresh, read, update, export, or inspect a citation-backed Literature Review workspace. Use staged candidates and evidence locators; abstract evidence must remain abstract-level and full-text claims require documentID plus page or blockID.", { action: { type: "string", enum: ["create", "refresh", "status", "read", "update", "export"] }, id: { type: "string" }, workspaceID: { type: "string" }, question: { type: "string" }, scope: { type: "object" }, candidates: { type: "array" }, includePapers: { type: "array" }, excludePapers: { type: "array" }, literatureMatrix: { type: "array" }, topicClusters: { type: "array" }, methodMatrix: { type: "array" }, claims: { type: "array" }, evidence: { type: "array" }, gaps: { type: "array" }, conflicts: { type: "array" }, format: { type: "string", enum: ["json", "markdown"] }, section: { type: "string" } }, [], "review-write"),
    tool("get_literature_diagnostics", "Developer diagnostics for the derived PaperCard index, scholarly provider health, metadata cache, and managed acquisition runtime. Does not change source Zotero data.", {}, [], "developer"),
    tool("rebuild_literature_index", "Developer maintenance operation that rebuilds the derived PaperCard index from Zotero metadata and LitMTrans manifests without reading full Markdown bodies.", { libraryID: { type: "integer" } }, [], "developer"),
    tool("get_paper_status", "读取单篇文献的轻量 Manifest 和解析/翻译/图表/公式状态", {}, [], "paper-read"),
    tool("get_paper_manifest", "读取单篇文献 Manifest；不返回整篇正文", {}, [], "paper-read"),
    tool("get_papers_status", "批量读取多篇文献 Manifest", { documents: { type: "array", items: { type: "string" } }, items: { type: "array", items: { type: "string" } } }, [], "paper-read"),
    tool("start_parse", "异步提交 MinerU 解析任务，立即返回 jobID", { force: { type: "boolean" }, modelVersion: { type: "string" }, isOCR: { type: "boolean" }, enableTable: { type: "boolean" }, enableFormula: { type: "boolean" } }, [], "processing"),
    tool("start_stream_translation", "异步提交流式全文翻译任务，沿用 LitMTrans 当前配置", { force: { type: "boolean" }, targetLanguage: { type: "string" }, mode: { type: "string" }, engine: { type: "string" } }, [], "processing"),
    tool("start_layout_translation", "异步提交排版翻译任务，沿用 LitMTrans 当前配置", { force: { type: "boolean" }, targetLanguage: { type: "string" }, mode: { type: "string" }, engine: { type: "string" } }, [], "processing"),
    tool("process_collection", "按 Collection 自动处理缺少解析或译文的文献，返回父 Job", { collection: { type: "string" }, parseMissing: { type: "boolean" }, translateMissing: { type: "boolean" }, translationKind: { type: "string", enum: ["stream", "layout"] }, force: { type: "boolean" } }, [], "processing"),
    tool("process_items", "批量处理指定条目，返回父 Job", { items: { type: "array", items: { type: "string" } }, parseMissing: { type: "boolean" }, translateMissing: { type: "boolean" }, translationKind: { type: "string", enum: ["stream", "layout"] }, force: { type: "boolean" } }, [], "processing"),
    tool("get_job", "读取异步任务状态、进度、结果或统一错误", { jobID: { type: "string" }, id: { type: "string" } }, ["jobID"], "jobs-read"),
    tool("list_jobs", "列出任务历史或运行中的任务", { status: { type: "string" }, kind: { type: "string" }, limit: { type: "integer" } }, [], "jobs-read"),
    tool("cancel_job", "取消尚未完成的任务", { jobID: { type: "string" } }, ["jobID"], "processing"),
    tool("retry_job", "重试失败或重启中断的任务", { jobID: { type: "string" } }, ["jobID"], "processing"),
    tool("read_source", "按需读取解析后的 Markdown 原文", { maxChars: { type: "integer" } }, [], "reading"),
    tool("read_translation", "按需读取流式译文", { maxChars: { type: "integer" } }, [], "reading"),
    tool("list_sections", "列出 Markdown 章节和稳定字符范围", {}, [], "reading"),
    tool("read_section", "精确读取一个章节", { section: { type: "string" }, title: { type: "string" }, maxChars: { type: "integer" } }, [], "reading"),
    tool("list_blocks", "列出排版模型中的文本、媒体、公式和表格块", { page: { type: "integer" }, type: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, [], "reading"),
    tool("read_pages", "按页读取排版块和文本", { pages: { type: "array", items: { type: "integer" } }, page: { type: "integer" } }, [], "reading"),
    tool("read_blocks", "按稳定 Block ID 批量读取排版块", { blockIDs: { type: "array", items: { type: "string" } }, blocks: { type: "array", items: { type: "string" } } }, [], "reading"),
    tool("get_block", "读取一个 Block，并可带 before/after 上下文", { blockID: { type: "string" }, id: { type: "string" }, before: { type: "integer" }, after: { type: "integer" } }, ["blockID"], "reading"),
    tool("list_figures", "列出图片/图表的页码、bbox、caption 和资源 locator", { page: { type: "integer" } }, [], "reading"),
    tool("get_figure", "读取单张图片及其结构化信息；可返回单图 Base64", { figureID: { type: "string" }, id: { type: "string" }, includeData: { type: "boolean" } }, ["figureID"], "reading"),
    tool("get_figure_context", "读取单张图片、caption、前后文和正文引用位置", { figureID: { type: "string" }, id: { type: "string" }, before: { type: "integer" }, after: { type: "integer" } }, ["figureID"], "reading"),
    tool("list_formulas", "列出公式的稳定 ID、页码、bbox、编号和 TeX", {}, [], "reading"),
    tool("get_formula", "读取指定公式，例如 12、(12) 或公式 ID", { formulaID: { type: "string" }, id: { type: "string" }, number: { type: "string" } }, ["formulaID"], "reading"),
    tool("get_formula_context", "读取公式及其相邻原文块", { formulaID: { type: "string" }, id: { type: "string" }, number: { type: "string" }, before: { type: "integer" }, after: { type: "integer" } }, ["formulaID"], "reading"),
    tool("search_formulas", "在单篇文献公式 TeX 和编号中搜索", { query: { type: "string" }, limit: { type: "integer" } }, ["query"], "search"),
    tool("list_tables", "列出表格的页码、bbox、Markdown、HTML 和 CSV", {}, [], "reading"),
    tool("get_table", "读取指定表格", { tableID: { type: "string" }, id: { type: "string" } }, ["tableID"], "reading"),
    tool("get_table_context", "读取表格及其相邻原文块", { tableID: { type: "string" }, id: { type: "string" }, before: { type: "integer" }, after: { type: "integer" } }, ["tableID"], "reading"),
    tool("export_table", "导出单张表格为 Markdown、HTML 或 CSV", { tableID: { type: "string" }, id: { type: "string" }, format: { type: "string", enum: ["markdown", "html", "csv"] }, destination: { type: "string" }, filename: { type: "string" } }, ["tableID"], "export"),
    tool("render_page", "渲染指定PDF页面并返回图片", { page: { type: "integer" }, scale: { type: "number" }, dpi: { type: "number" } }, ["page"], "reading"),
    tool("render_page_region", "渲染PDF页面的矩形区域并返回图片", { page: { type: "integer" }, bbox: { type: "array", items: { type: "number" } }, rect: { type: "array", items: { type: "number" } }, scale: { type: "number" }, dpi: { type: "number" } }, ["page"], "reading"),
    tool("search_paper", "在单篇文献原文、译文、图注、表格和公式中搜索并返回 page/block locator", { query: { type: "string" }, contentTypes: { type: "array", items: { type: "string" } }, limit: { type: "integer" } }, ["query"], "search"),
    tool("search_corpus", "搜索所有已缓存的 LitMTrans 文献，返回 paper/page/block/snippet locator", { query: { type: "string" }, collection: { type: "string" }, tag: { type: "string" }, year: { type: ["integer", "string"] }, parsedOnly: { type: "boolean" }, translatedOnly: { type: "boolean" }, contentTypes: { type: "array", items: { type: "string" } }, mode: { type: "string", enum: ["fulltext", "semantic"] }, limit: { type: "integer" } }, ["query"], "search"),
    tool("read_diagram", "读取 LitMTrans V2 思维导图或流程图缓存", { mode: { type: "string", enum: ["mindmap", "flowchart"] } }, [], "diagram-read"),
    tool("save_diagram", "保存 LitMTrans V2 思维导图或流程图", { mode: { type: "string", enum: ["mindmap", "flowchart"] }, diagram: { type: "object" } }, ["diagram"], "diagram-write"),
    tool("get_mindmap", "读取 LitMTrans V2 思维导图", {}, [], "diagram-read"),
    tool("get_flowchart", "读取 LitMTrans V2 流程图", {}, [], "diagram-read"),
    tool("save_mindmap", "保存 LitMTrans V2 思维导图", { diagram: { type: "object" } }, ["diagram"], "diagram-write"),
    tool("save_flowchart", "保存 LitMTrans V2 流程图", { diagram: { type: "object" } }, ["diagram"], "diagram-write"),
    tool("clear_diagram", "清除一篇文献的思维导图或流程图缓存", { mode: { type: "string", enum: ["mindmap", "flowchart"] } }, [], "diagram-write"),
    tool("resolve_diagram_evidence", "从图节点反查原文证据位置", { mode: { type: "string", enum: ["mindmap", "flowchart"] }, nodeID: { type: "string" }, node: { type: "string" } }, [], "diagram-read"),
    tool("list_chat_sessions", "列出单篇文献的 Chat 会话", {}, [], "chat-read"),
    tool("read_chat_session", "读取单篇文献 Chat 历史", { sessionID: { type: "string" }, id: { type: "string" } }, [], "chat-read"),
    tool("create_chat_message", "使用 LitMTrans 当前 Chat 配置异步提问文献", { sessionID: { type: "string" }, message: { type: "string" }, text: { type: "string" } }, ["message"], "processing"),
    tool("edit_chat_message", "编辑或重新生成一条 Chat 消息", { sessionID: { type: "string" }, messageID: { type: "string" }, id: { type: "string" }, message: { type: "string" }, text: { type: "string" } }, ["messageID"], "processing"),
    tool("delete_chat_turn", "删除一轮 LitMTrans Chat 对话", { sessionID: { type: "string" }, messageID: { type: "string" }, id: { type: "string" } }, ["messageID"], "chat-write"),
    tool("clear_chat_session", "清空一篇文献的 Chat 会话", { sessionID: { type: "string" }, id: { type: "string" } }, [], "chat-write"),
    tool("list_research_artifacts", "列出跨 Agent 共享的研究资产", { type: { type: "string" }, limit: { type: "integer" } }, [], "research-read"),
    tool("get_research_artifact", "读取研究资产", { id: { type: "string" }, artifactID: { type: "string" } }, ["id"], "research-read"),
    tool("create_research_artifact", "创建长期研究资产", { type: { type: "string" }, title: { type: "string" }, origin: { type: "string" }, documentIDs: { type: "array", items: { type: "string" } }, evidence: { type: "array" }, content: { type: "string" }, metadata: { type: "object" } }, ["title", "content"], "research-write"),
    tool("update_research_artifact", "更新研究资产", { id: { type: "string" }, artifactID: { type: "string" }, title: { type: "string" }, content: { type: "string" }, evidence: { type: "array" } }, ["id"], "research-write"),
    tool("delete_research_artifact", "归档并删除研究资产", { id: { type: "string" }, artifactID: { type: "string" } }, ["id"], "research-write"),
    tool("create_collection", "创建 Zotero Collection", { libraryID: { type: "integer" }, name: { type: "string" }, parentID: { type: "integer" } }, ["name"], "library-write"),
    tool("update_collection", "重命名或移动 Zotero Collection", { collection: { type: "string" }, collectionID: { type: ["integer", "string"] }, name: { type: "string" }, parentID: { type: "integer" } }, [], "library-write"),
    tool("move_collection", "移动 Zotero Collection 到新的父级 Collection", { collection: { type: "string" }, collectionID: { type: ["integer", "string"] }, parentID: { type: "integer" } }, ["parentID"], "library-write"),
    tool("add_items_to_collection", "把 Zotero 条目加入 Collection", { collection: { type: "string" }, collectionID: { type: ["integer", "string"] }, items: { type: "array", items: { type: "string" } } }, ["items"], "library-write"),
    tool("remove_items_from_collection", "从 Collection 移除 Zotero 条目", { collection: { type: "string" }, collectionID: { type: ["integer", "string"] }, items: { type: "array", items: { type: "string" } } }, ["items"], "library-write"),
    tool("add_tags", "给 Zotero 条目添加标签", { item: { type: "string" }, itemKey: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, ["tags"], "library-write"),
    tool("remove_tags", "从 Zotero 条目移除标签", { item: { type: "string" }, itemKey: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, ["tags"], "library-write"),
    tool("update_item_metadata", "更新 Zotero 条目的白名单元数据字段", { item: { type: "string" }, fields: { type: "object" } }, ["fields"], "library-write"),
    tool("create_note", "在 Zotero 条目下创建 Note", { item: { type: "string" }, note: { type: "string" }, content: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, ["note"], "library-write"),
    tool("update_note", "更新 Zotero Note", { note: { type: "string" }, noteID: { type: "string" }, id: { type: "string" }, content: { type: "string" } }, ["id"], "library-write"),
    tool("delete_note", "把 Zotero Note 移入 Trash", { note: { type: "string" }, noteID: { type: "string" }, id: { type: "string" } }, ["id"], "library-write"),
    tool("list_annotations", "列出 PDF Annotation，并统一返回 type/text/comment/color/tags/page/position/sortIndex、itemKey/parentKey 和 LitMTrans locator；支持 q、类型、标签、颜色、日期、排序和分页。前提是提供 attachment 或 attachmentKey。", { attachment: { type: "string" }, attachmentKey: { type: "string" }, q: { type: "string" }, type: { type: ["string", "array"], items: { type: "string" } }, tags: { type: ["string", "array"], items: { type: "string" } }, color: { type: "string" }, hasComment: { type: "boolean" }, dateFrom: { type: "string" }, dateTo: { type: "string" }, sort: { type: "string", enum: ["dateAdded", "dateModified", "position", "page", "type"] }, direction: { type: "string", enum: ["asc", "desc"] }, offset: { type: "integer" }, limit: { type: "integer" }, includeStatus: { type: "boolean" } }, [], "annotation-read"),
    tool("create_annotation", "创建 Zotero PDF 高亮、区域或备注 Annotation", { attachment: { type: "string" }, type: { type: "string" }, text: { type: "string" }, comment: { type: "string" }, color: { type: "string" }, page: { type: "integer" }, rect: { type: "object" }, position: { type: "object" }, tags: { type: "array", items: { type: "string" } } }, ["attachment"], "annotation-write"),
    tool("update_annotation", "更新 Zotero PDF Annotation 的文本、备注、颜色或位置", { annotation: { type: "string" }, annotationID: { type: "string" }, id: { type: "string" }, text: { type: "string" }, comment: { type: "string" }, color: { type: "string" }, page: { type: "integer" }, position: { type: "object" }, tags: { type: "array", items: { type: "string" } } }, ["id"], "annotation-write"),
    tool("delete_annotation", "把 PDF Annotation 移入 Trash", { annotation: { type: "string" }, annotationID: { type: "string" }, id: { type: "string" } }, ["id"], "annotation-write"),
    tool("export_research_bundle", "导出单篇论文的 Research Bundle", { destination: { type: "string" } }, [], "export"),
    tool("export_collection_workspace", "导出 Collection Workspace", { collection: { type: "string" }, destination: { type: "string" }, name: { type: "string" } }, ["collection"], "export"),
    tool("export", "导出原文、译文、原始 PDF 或图片", { kind: { type: "string", enum: ["source-markdown", "translation-markdown", "original-pdf", "original-file", "document-images", "research-bundle"] }, destination: { type: "string" } }, ["kind"], "export"),
    tool("generate_citation", "使用 Zotero 条目生成单篇或多篇引用", { items: { type: "array", items: { type: "string" } }, item: { type: "string" }, style: { type: "string" }, locale: { type: "string" } }, [], "library-read"),
    tool("generate_bibliography", "使用 Zotero 条目生成书目列表", { items: { type: "array", items: { type: "string" } }, item: { type: "string" }, style: { type: "string" }, locale: { type: "string" } }, [], "library-read"),
    tool("export_bibtex", "导出 Zotero 条目的 BibTeX", { items: { type: "array", items: { type: "string" } }, item: { type: "string" }, destination: { type: "string" }, filename: { type: "string" } }, [], "export"),
    tool("export_ris", "导出 Zotero 条目的 RIS", { items: { type: "array", items: { type: "string" } }, item: { type: "string" }, destination: { type: "string" }, filename: { type: "string" } }, [], "export"),
    tool("export_csl_json", "导出 Zotero 条目的 CSL JSON", { items: { type: "array", items: { type: "string" } }, item: { type: "string" }, destination: { type: "string" }, filename: { type: "string" } }, [], "export"),
    tool("add_by_doi", "按 DOI 获取元数据并加入 Zotero", { DOI: { type: "string" }, doi: { type: "string" }, libraryID: { type: "integer" }, collection: { type: "string" }, collectionID: { type: "integer" } }, [], "library-write"),
    tool("add_by_url", "按 URL 创建 Zotero 条目（DOI URL 会自动获取元数据）", { url: { type: "string" }, title: { type: "string" }, libraryID: { type: "integer" }, collection: { type: "string" }, collectionID: { type: "integer" } }, ["url"], "library-write"),
    tool("add_by_bibtex", "解析 BibTeX 并把条目加入 Zotero", { bibtex: { type: "string" }, content: { type: "string" }, libraryID: { type: "integer" }, collection: { type: "string" }, collectionID: { type: "integer" } }, [], "library-write"),
    tool("add_by_csl_json", "解析 CSL JSON 并把条目加入 Zotero", { csl: { type: ["object", "array", "string"] }, data: { type: ["object", "array", "string"] }, content: { type: "string" }, libraryID: { type: "integer" }, collection: { type: "string" }, collectionID: { type: "integer" } }, [], "library-write"),
    tool("attach_file", "把本地文件作为 Zotero 附件加入指定条目", { item: { type: "string" }, itemKey: { type: "string" }, parentID: { type: "integer" }, path: { type: "string" }, filePath: { type: "string" } }, ["path"], "library-write"),
    tool("add_local_file", "把本地文件加入 Zotero，可选择挂到指定条目下", { item: { type: "string" }, itemKey: { type: "string" }, parentID: { type: "integer" }, libraryID: { type: "integer" }, path: { type: "string" }, filePath: { type: "string" } }, ["path"], "library-write"),
    tool("get_storage_summary", "读取 LitMTrans 存储概览", {}, [], "storage-summary"),
    tool("validate_document", "检查单篇文献的解析状态和缓存完整性", {}, [], "maintenance"),
    tool("validate_translation", "检查单篇文献的译文状态和来源一致性", {}, [], "maintenance"),
    tool("rebuild_manifest", "重新读取单篇文献 Manifest", {}, [], "maintenance"),
    tool("clear_document_cache", "归档后清理一篇文献的 LitMTrans 缓存", {}, [], "maintenance"),
    tool("clear_translation_cache", "归档后清理一篇文献的译文缓存", {}, [], "maintenance"),
    tool("list_litmtrans_files", "开发者模式下列出 LitMTrans 数据文件", { prefix: { type: "string" }, limit: { type: "integer" } }, [], "developer"),
    tool("read_litmtrans_file", "开发者模式下读取 LitMTrans 数据文件（自动脱敏）", { path: { type: "string" }, relativePath: { type: "string" }, maxChars: { type: "integer" } }, ["path"], "developer"),
    tool("read_diagnostics", "开发者模式下读取脱敏诊断信息", { includeLogs: { type: "boolean" } }, [], "developer"),
    tool("inspect_document_state", "开发者模式下检查一篇文献的存储文件状态", {}, [], "developer"),
    tool("repair_document", "开发者模式下重新准备并读取一篇文献状态", {}, [], "developer"),
    tool("query_agent_index", "开发者模式下查询派生文库索引", { query: { type: "string" }, limit: { type: "integer" } }, ["query"], "developer"),
    tool("rebuild_corpus_index", "开发者模式下重建派生文库索引", {}, [], "developer")
  ];

  const OPERATION_GUIDANCE = {
    capabilities: "使用时机：首次连接或能力变化时。前提：无需文献定位。失败恢复：先检查服务是否已启用，再重新读取能力。",
    "client-config": "使用时机：需要配置客户端时。前提：服务必须已启动；普通用户应使用复制给智能体的自然语言指令。失败恢复：先启用服务再重试。",
    context: "使用时机：需要当前选择或 Reader 上下文时。前提：无；没有当前文献时返回空上下文。失败恢复：改用明确的 itemKey、attachmentKey 或 documentID。",
    "processing-capacity": "使用时机：提交解析、翻译或聊天前。前提：不返回密钥。失败恢复：按返回的 available/reason 选择已配置的 API 服务。",
    "external-approval": "使用时机：仅在服务返回待批准计划后。前提：必须原样提供 approvalID 和 approved；现代请求还要保留 requestState。失败恢复：不要猜测 planHash，重新执行原工具取得新计划。",
    "library-read": "使用时机：浏览或定位 Zotero 文库。前提：优先使用 libraryID、key 或 itemID；名称歧义时先 list/search。失败恢复：改用 list_libraries、list_collections 或 search_items。",
    search: "使用时机：未知条目或需要按字段筛选时。前提：优先给 q、字段条件和 limit/offset；结果里的 key/itemID/documentID 可作为后续 locator。失败恢复：减少条件、确认 libraryID，并用 nextOffset 继续分页。",
    "paper-read": "使用时机：查看一篇文献状态或 Manifest。前提：提供 documentID、itemKey 或 attachmentKey。失败恢复：先 search_items/get_active_context，无法解析时执行 start_parse。",
    processing: "使用时机：解析、翻译或批处理。前提：有明确 documentID/itemKey/collection，且用户已允许配置服务；返回 jobID 后必须用 get_job 轮询。失败恢复：按 job 错误处理、retry_job 或先补充批准。",
    "jobs-read": "使用时机：跟踪异步任务。前提：使用返回的 jobID；不要凭标题猜任务。失败恢复：任务失败时先读 error，再决定 retry_job 或修复配置。",
    reading: "使用时机：读取原文、译文、章节、页面、Block 或媒体。前提：文献已解析并提供 documentID；按 page/blockID/figureID/tableID/formulaID 精确定位。失败恢复：先 get_paper_status 或 start_parse。",
    export: "使用时机：把已有内容写出到用户指定目标。前提：提供 documentID/locator 和 destination；确认目标目录。失败恢复：读取返回的 outputPath/error，不要重复盲写。",
    "diagram-read": "使用时机：读取已有思维导图或流程图。前提：提供 documentID 和 mode。失败恢复：先 get_paper_status 或 read_diagram 确认缓存是否存在。",
    "diagram-write": "使用时机：保存或清除图缓存。前提：需要完整访问和明确 documentID；保留节点 evidence locator。失败恢复：先 read_diagram 校验版本，再重试。",
    "chat-read": "使用时机：读取 LitMTrans 对话历史。前提：用户允许读取历史并提供 documentID；没有 sessionID 时先 list_chat_sessions。失败恢复：若被禁用，改用 paper/read 工具。",
    "chat-write": "使用时机：创建、编辑或清理对话。前提：需要完整访问、documentID 和必要的 session/message locator；外部 AI 可能触发批准。失败恢复：先读取 session 状态，再按 error 处理。",
    "research-read": "使用时机：读取跨文献研究资产。前提：使用 artifactID/id。失败恢复：先 list_research_artifacts 找到准确 ID。",
    "research-write": "使用时机：创建、更新或归档研究资产。前提：需要完整访问，证据必须带 documentID/page/block locator。失败恢复：先 get_research_artifact 确认版本和 ID。",
    "library-write": "使用时机：修改 Zotero 文库。前提：需要完整访问；写入目标必须用 key/id/collection locator；会经过串行保存和 Notifier 提交。失败恢复：读取返回对象或错误后再重试，避免重复创建。",
    "annotation-read": "使用时机：读取 PDF Annotation。前提：先用 attachmentKey 定位；只读模式也允许此操作。失败恢复：先确认附件存在并保留 page/position 和 documentID locator。",
    "annotation-write": "使用时机：创建、更新或删除 PDF Annotation。前提：需要完整科研访问和 attachment/annotation locator。失败恢复：先 list_annotations，避免凭标题重复写入。",
    "literature-discovery": "使用时机：围绕研究问题发现、推荐或扩展文献。前提：先做元数据 shortlist；Provider 由 LitMTrans 自动路由，不要求智能体选择外部服务。失败恢复：保留本地结果，读取 providers 状态后再缩小问题。",
    "literature-import": "使用时机：把已筛选候选加入 Zotero。前提：候选应来自 literature_search 或提供完整 metadata；系统按 DOI/题名去重。失败恢复：读取 duplicate/status，不重复创建。",
    "acquisition-write": "使用时机：为已筛选候选获取并验证全文。前提：只对 shortlist 调用；系统按已有附件、OA、托管获取和 Translator 顺序尝试。失败恢复：读取 provider diagnostics，不要要求智能体安装 Python 或手动下载。",
    "review-write": "使用时机：维护 Literature Review workspace、矩阵、主张和证据台账。前提：全文证据必须有 documentID 及 page 或 blockID；摘要不能伪装成全文证据。失败恢复：先读取工作区并补齐 locator。",
    "review-read": "使用时机：读取、导出或查看 Literature Review workspace。前提：提供 workspaceID；导出前确认 format。失败恢复：先 status 再 read。",
    "storage-summary": "使用时机：查看 LitMTrans 本地存储占用。前提：无需文献定位。失败恢复：缩小到指定 documentID 或转开发者诊断。",
    maintenance: "使用时机：校验、重建或清理 LitMTrans 缓存。前提：提供明确 documentID，并确认清理范围；需要完整访问。失败恢复：先读 status/manifest，清理后重新读取。",
    developer: "使用时机：诊断或索引维护。前提：必须开启开发者模式，不用于普通工作流。失败恢复：先读取脱敏诊断和文件状态，不要直接清理。"
  };
  const TOOL_GUIDANCE = {
    litmtrans_get_capabilities: "连接后先调用本工具，并以返回的 toolsets/permissions 为准。",
    litmtrans_get_active_context: "可用当前选择；若为空，要求用户选择条目或传明确 locator。",
    litmtrans_get_collection_items: "返回分页结果；用 nextOffset 继续，不要一次请求无界数量。",
    litmtrans_create_chat_message: "返回 jobID 后用 get_job，完成后再读 session。",
    litmtrans_render_page: "page 从 1 开始；需要图片证据时再请求，避免无必要的大响应。",
    litmtrans_render_page_region: "page 从 1 开始，bbox/rect 必须来自页面坐标或已有 block locator。",
    litmtrans_add_by_doi: "优先由 Zotero Translator 获取元数据；返回 duplicate 时不要再次创建。",
    litmtrans_add_by_url: "DOI URL 会优先走 Translator/Crossref；无法翻译时会明确标记 fallback。",
    litmtrans_attach_file: "路径只应由用户明确提供；完成后使用返回的 attachmentKey，不要猜文件名。",
    litmtrans_read_litmtrans_file: "仅能读取允许范围并自动脱敏；需要 developer 模式和相对路径。"
  };
  for (const item of TOOLS) {
    const operation = String(item._litmtransOperation || "");
    const guidance = OPERATION_GUIDANCE[operation] || "使用时机：按工具名称选择。前提：提供 schema 要求的定位字段。失败恢复：读取结构化错误后修正参数再重试。";
    const special = TOOL_GUIDANCE[item.name] ? ` ${TOOL_GUIDANCE[item.name]}` : "";
    item.description = `${item.description} ${guidance}${special}`;
  }

  Agent.MCPTools = TOOLS;
  Agent.MCPToolMap = new Map(TOOLS.map(item => [item.name, item]));
})(this);
