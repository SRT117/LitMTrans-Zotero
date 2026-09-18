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

async function testChat() {
  const storage = new MemoryStorage();
  await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Paper\n\nSource context.");
  let lastChatRequest = [];
  const llm = withResolvedChatModel({
    getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000 }),
    async complete(messages, options) {
      lastChatRequest = messages;
      assert(JSON.stringify(messages).includes("Source context"));
      assert(!JSON.stringify(messages).includes("译文上下文。"), "文献AI默认不得把整篇译文加入上下文");
      options.onText?.("回答");
      return { text: "回答", reasoning: "" };
    }
  });
  const translation = { load: async () => ({ markdown: "译文上下文。" }) };
  const chat = new ChatService(storage, llm, translation);
  const summary = chat.responseSummary({ model: "test-model", usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 20 } } }, "test-provider");
  assert(summary.includes("服务商：test-provider") && summary.includes("模型：test-model"));
  assert(summary.includes("输入：100") && summary.includes("输出：50") && summary.includes("缓存命中：20%"));
  const session = await chat.loadSession("doc");
  const result = await chat.send("doc", session.id, "这篇文章讲了什么？", { contextMode: "both" });
  assert.equal(result.message.content, "回答");
  const mindmapResult = await chat.send("doc", session.id, "请画思维导图", { contextMode: "source", mindmap: true });
  assert.equal(mindmapResult.session.messages.at(-2).formatInstruction, ChatInternals.MINDMAP_V2_FORMAT_INSTRUCTION, "mind-map V2 format must persist on the user turn");
  assert.equal(mindmapResult.session.messages.at(-2).taskType, "generic_mindmap", "generic mind-map task must persist independently from its renderer");
  assert(ChatInternals.MINDMAP_FORMAT_INSTRUCTION.includes("真实意图"), "mind-map keyword matching must be advisory, not a forced rendering command");
  assert(JSON.stringify(lastChatRequest).includes(ChatInternals.MINDMAP_V2_FORMAT_INSTRUCTION), "later requests must receive the persisted V2 format instruction as chat history");
  assert.equal(mindmapResult.session.messages.at(-2).attachments.length, 0, "a rendered mind map must never become an AI image attachment");
  assert(mindmapResult.session.messages.at(-2).taskInstruction.includes("必须使用简体中文"), "generic mind-map visible text must default to Simplified Chinese even for English source material");
  assert(mindmapResult.session.messages.at(-2).formatInstruction.includes("evidence 中逐字引用的 quote 必须保持论文原文"), "mind-map language rules must preserve exact source-language evidence quotes");
  const flowchartResult = await chat.send("doc", session.id, "请画算法流程图", { contextMode: "source", flowchart: true });
  assert.equal(flowchartResult.session.messages.at(-2).formatInstruction, ChatInternals.FLOWCHART_V2_FORMAT_INSTRUCTION, "flowchart V2 format must persist on the user turn");
  assert.equal(flowchartResult.session.messages.at(-2).taskType, "generic_flowchart", "generic flowchart task must persist independently from its renderer");
  assert(ChatInternals.FLOWCHART_FORMAT_INSTRUCTION.includes("真实意图"), "flowchart keyword matching must be advisory, not a forced rendering command");
  assert(flowchartResult.session.messages.at(-2).taskInstruction.includes("不得因为论文或上下文原文是英文而输出整句英文"), "generic flowchart visible text must not inherit the source document language");
  const keyPoints = await chat.send("doc", session.id, "请提炼全文", { contextMode: "source", taskType: "key_points" });
  assert.equal(keyPoints.session.messages.at(-2).taskType, "key_points", "key-points must be a first-class task rather than a fabricated quote");
  assert(keyPoints.session.messages.at(-2).taskInstruction.includes("要点提炼任务"), "key-points task instruction must stay on the newest user turn");
  assert(keyPoints.session.messages.at(-2).taskInstruction.endsWith(ChatInternals.DIAGRAM_CHINESE_INSTRUCTION), "key-points language rule must remain after any task preference so it cannot be overridden accidentally");
  assert(ChatInternals.PAPER_MINDMAP_TASK_INSTRUCTION.includes("原文语言"), "paper mind-map prompts must request exact source-language evidence for reliable PDF jumps");
  assert(ChatInternals.PAPER_LOGIC_FLOW_TASK_INSTRUCTION.includes("数值指标") && ChatInternals.PAPER_LOGIC_FLOW_TASK_INSTRUCTION.includes("不能翻译、改写、拼接或编造"), "paper logic-flow prompts must require substantive details and exact evidence quotes");
  const webAutoTask = ChatInternals.taskFor({ taskType: "paper_mindmap", aiMode: "web" }, {});
  assert.equal(webAutoTask.diagramMode, "mindmap", "diagram tasks must persist their renderer mode");
  assert.equal(webAutoTask.formatInstruction, ChatInternals.WEB_MINDMAP_FORMAT_INSTRUCTION, "web auto-injection must request readable Markdown instead of the internal JSON protocol");
  assert(webAutoTask.formatInstruction.includes("[^quote:") && !webAutoTask.formatInstruction.includes("mindmap-v2"), "web Markdown output must carry parseable evidence guidance without exposing the API protocol");
  assert(webAutoTask.taskInstruction.includes("网页模式覆盖") && webAutoTask.taskInstruction.includes("不要输出 evidence JSON"), "web task content rules must override the API evidence representation");
  const webFlowTask = ChatInternals.taskFor({ taskType: "paper_logic_flow", aiMode: "web" }, {});
  assert(webFlowTask.formatInstruction.includes("###")
    && webFlowTask.formatInstruction.includes("并行分支")
    && webFlowTask.formatInstruction.includes("汇合"),
  "web logic-flow prompts must encode parallel branches and convergence instead of a mandatory single chain");
  const explicitAPITask = ChatInternals.taskFor({ taskType: "paper_mindmap", engine: "api", aiMode: "api" }, { chatEngine: "deepseek_web" });
  assert.equal(explicitAPITask.formatInstruction, ChatInternals.MINDMAP_V2_FORMAT_INSTRUCTION, "an explicit API transport must not inherit the web Markdown protocol from preferences");
  const copiedMindmapPrompt = ChatInternals.clipboardTaskPrompt("paper_mindmap", {});
  assert(copiedMindmapPrompt.includes("```mermaid\nflowchart LR") && copiedMindmapPrompt.includes("classDef"), "clipboard mode must use a styled horizontal Mermaid architecture code-block example");
  const sessions = await chat.listSessions("doc");
  assert.deepEqual(sessions.map(row => row.id), ["document-chat"], "each literature attachment must expose one durable conversation");
  const cleared = await chat.clearSession("doc", session.id);
  assert.equal(cleared.id, "document-chat");
  assert.equal(cleared.messages.length, 0, "clearing history must reset only the current literature conversation");
}

async function testChatGeminiStreamTimeoutFallback() {
  const storage = new MemoryStorage();
  await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Paper\n\nSource context.");
  const calls = [];
  const llm = withResolvedChatModel({
    getSettings: () => ({
      provider: "gemini",
      targetLanguage: "简体中文",
      chatContextChars: 50000
    }),
    async complete(_messages, options) {
      calls.push({ ...options });
      if (calls.length === 1) {
        const error = new Error("first event stalled");
        error.name = "StreamTimeoutError";
        error.timeout = true;
        throw error;
      }
      assert.equal(options.stream, false);
      assert.equal(options.timeout, 0);
      options.onText?.("降级后回答");
      return { text: "降级后回答", reasoning: "" };
    }
  });
  const events = [];
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  const session = await chat.loadSession("doc");
  const result = await chat.send("doc", session.id, "解释所选内容", {}, event => events.push(event));
  assert.equal(calls.length, 2, "Gemini stream timeout must trigger exactly one non-stream retry");
  assert.equal(calls[0].timeout, 0);
  assert.equal(calls[0].firstEventTimeout, 0);
  assert.equal(calls[0].inactivityTimeout, 0);
  assert.equal(result.message.content, "降级后回答");
  assert(events.some(event => event.type === "warning"), "the transport fallback should remain visible to the user");
}

async function testChatCurrentDocumentAfterClear() {
  const storage = new MemoryStorage();
  await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Paper\n\nSource context.");
  const requests = [];
  const llm = withResolvedChatModel({
    getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000 }),
    async complete(messages, options) {
      requests.push(messages);
      options.onText?.("回答");
      return { text: "回答", reasoning: "" };
    }
  });
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  const session = await chat.loadSession("doc");
  await chat.send("doc", session.id, "第一问");
  await chat.send("doc", session.id, "追问");
  const cleared = await chat.clearSession("doc", session.id);
  await chat.send("doc", cleared.id, "清空后的第一问");

  const currentDocumentCount = request => request.filter(message =>
    message.role === "user" && JSON.stringify(message.content).includes("===== 当前Zotero文献开始 =====")
  ).length;
  assert.equal(currentDocumentCount(requests[0]), 1, "首次对话必须携带当前论文");
  assert.equal(currentDocumentCount(requests[1]), 1, "追问必须复用历史中的论文，不能重复插入");
  assert.equal(currentDocumentCount(requests[2]), 1, "清空历史后的下一轮必须重新携带当前论文");
  const persisted = await chat.loadSession("doc", cleared.id);
  assert.equal(persisted.messages[0].currentDocument, true, "清空后的首轮要重新标记为论文上下文首轮");

  const unavailable = new ChatService(new MemoryStorage(), llm, { load: async () => ({ markdown: "" }) });
  const unavailableSession = await unavailable.loadSession("missing");
  await assert.rejects(
    unavailable.send("missing", unavailableSession.id, "没有论文时不应发送"),
    /没有可用的正文/
  );
}

async function testChatImageCitationsStayDisplayOnly() {
  const storage = new MemoryStorage();
  const currentPlaceholder = "![Figure 1](images/figure-1.png)";
  await storage.writeText(
    storage.path("doc", "full.cleaned.md"),
    `# Paper\n\nEvidence.\n\n${currentPlaceholder}\n\nFigure 1 caption.`
  );
  await storage.writeJSON(storage.path("doc", "image-map.json"), [{
    id: "Figure 1", alt: "Figure 1", cleanTarget: "images/figure-1.png", warning: ""
  }]);
  await storage.writeBytes(storage.path("doc", "images", "figure-1.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  const requests = [];
  let call = 0;
  const llm = withResolvedChatModel({
    getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000 }),
    async complete(messages, options) {
      requests.push(JSON.parse(JSON.stringify(messages)));
      const text = ++call === 1 ? `结果见论文图片。\n\n${currentPlaceholder}` : "后续回答";
      options.onText?.(text);
      return { text, reasoning: "" };
    }
  });
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  const session = await chat.loadSession("doc");
  const first = await chat.send("doc", session.id, "结果在哪里？");
  assert(JSON.stringify(requests[0]).includes(ChatInternals.IMAGE_CITATION_INSTRUCTION), "the first document turn must teach the exact image citation protocol");
  assert(ChatInternals.IMAGE_CITATION_INSTRUCTION.includes("每张图片必须另起一行"));
  assert(ChatInternals.IMAGE_CITATION_INSTRUCTION.includes("错误示例"), "the image protocol must explicitly contrast the common reversed source-tag form");
  assert.equal(first.message.citedImages.length, 1, "an exact source placeholder must resolve to one visible cited image");
  assert.equal(first.message.citedImages[0].url, "resource://litmtrans-data/doc/images/figure-1.png");
  const raw = await chat.loadSession("doc", session.id, false);
  assert.equal(raw.messages[1].citedImages[0].relativePath, "images/figure-1.png");
  assert(!("url" in raw.messages[1].citedImages[0]), "persisted citations must keep only a local locator, not a presentation URL");
  assert(!JSON.stringify(raw.messages[1].citedImages).includes("base64"), "persisted citations must never duplicate image data");

  await chat.send("doc", session.id, "继续解释");
  const priorAssistant = requests[1].find(message => message.role === "assistant");
  assert.equal(typeof priorAssistant.content, "string", "a cited assistant image must re-enter API history only as its textual marker");
  assert(!JSON.stringify(priorAssistant).includes("image_url"), "display-only cited images must not become multimodal history parts");

  // MinerU restarts IMAGE_001 numbering in each paper, so source labels must
  // disambiguate identical placeholders across the current and added papers.
  const attachedPlaceholder = currentPlaceholder;
  await storage.writeText(storage.path("doc", "chat", "documents", "extra", "document.md"), attachedPlaceholder);
  await storage.writeBytes(storage.path("doc", "chat", "documents", "extra", "images", "figure-1.png"), new Uint8Array([1, 2, 3]));
  const attachedSession = {
    messages: [{
      role: "user",
      content: "附加文档",
      documents: [{
        id: "extra",
        name: "补充材料.pdf",
        markdownRelativePath: "chat/documents/extra/document.md",
        rootRelativePath: "chat/documents/extra",
        imageMap: [{ id: "Figure 1", alt: "Figure 1", cleanTarget: "images/figure-1.png" }]
      }]
    }]
  };
  const ambiguous = await chat.resolveAssistantImageCitations("doc", attachedSession, 0, attachedPlaceholder);
  assert.equal(ambiguous.length, 0, "an identical placeholder from multiple papers must not display the wrong image without a source label");
  const attached = await chat.resolveAssistantImageCitations(
    "doc", attachedSession, 0, `[图片来源：补充材料.pdf] ${attachedPlaceholder}`
  );
  assert.equal(attached.length, 1, "images from documents added later to the conversation must also be citeable");
  assert.equal(attached[0].relativePath, "chat/documents/extra/images/figure-1.png");
  const proseScoped = await chat.resolveAssistantImageCitations(
    "doc",
    attachedSession,
    0,
    `在文档《补充材料.pdf》中，最重要的图是 **${attachedPlaceholder} (FIG. 3)**。`
  );
  assert.equal(proseScoped.length, 1, "an attached document title in the same sentence must safely disambiguate a model-omitted source tag");
  const responseScoped = await chat.resolveAssistantImageCitations(
    "doc",
    attachedSession,
    0,
    `文档《补充材料.pdf》的图片如下。\n\n${"说明文字。".repeat(80)}\n\n${attachedPlaceholder}`
  );
  assert.equal(responseScoped.length, 0, "a distant document title must not guess the source of a colliding placeholder");
  const reversedCurrentTag = await chat.resolveAssistantImageCitations(
    "doc",
    attachedSession,
    0,
    `**最重要的图片：${attachedPlaceholder}**\n[图片来源：当前文献]`
  );
  assert.equal(reversedCurrentTag.length, 1, "legacy replies with a source tag immediately after the placeholder must be recovered");
  assert.equal(reversedCurrentTag[0].sourceType, "current-document", "a reversed current-document tag must never fall through to an attached document with the same placeholder");
}

async function testChatTurnMutationSemantics() {
  const storage = new MemoryStorage();
  await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Paper\n\nSource context.");
  const calls = [];
  let answerNumber = 0;
  const llm = withResolvedChatModel({
    getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000 }),
    async complete(messages, options) {
      calls.push(JSON.parse(JSON.stringify(messages)));
      const text = `回答-${++answerNumber}`;
      options.onText?.(text);
      return { text, reasoning: "" };
    }
  });
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  const initial = await chat.loadSession("doc");
  const first = await chat.send("doc", initial.id, "第一问", { contextMode: "selected" });
  const firstUserID = first.session.messages[0].id;
  const second = await chat.send("doc", initial.id, "第二问", { contextMode: "selected" });
  const secondAssistantID = second.session.messages[3].id;

  const resent = await chat.resend("doc", initial.id, firstUserID, { contextMode: "selected" });
  assert.deepEqual(
    resent.session.messages.map(message => `${message.role}:${message.content}`),
    ["user:第一问", "assistant:回答-3", "user:第二问", "assistant:回答-2"]
  );
  const resendRequest = calls[2];
  assert(resendRequest.some(message => message.role === "user" && JSON.stringify(message.content).includes("第一问")));
  assert(!resendRequest.some(message => String(message.content).includes("第二问")));
  assert(!resendRequest.some(message => String(message.content).includes("回答-2")));

  const edited = await chat.editMessage("doc", initial.id, resent.message.id, "人工修订回答");
  assert.equal(edited.session.messages[1].content, "人工修订回答");
  assert.equal(calls.length, 3, "editing an assistant response must not call the model");

  const deleted = await chat.deleteTurn("doc", initial.id, secondAssistantID);
  assert.deepEqual(
    deleted.session.messages.map(message => `${message.role}:${message.content}`),
    ["user:第一问", "assistant:人工修订回答"]
  );
  assert.deepEqual(ChatInternals.findTurnRange(deleted.session.messages, 1), { start: 0, end: 2, index: 1 });
}

async function testOrderedReferenceQuotes() {
  const quotes = [
    {
      type: "text",
      text: "First quoted passage.",
      pane: "source",
      readerMode: "zotero-reader",
      origin: "zotero-reader",
      nativePageIndex: 1,
      page: 2
    },
    { type: "formula", text: "E = mc^2", formulaTex: "E = mc^2", pane: "translation", page: 3 },
    {
      type: "text",
      text: "First quoted passage.",
      pane: "source",
      readerMode: "zotero-reader",
      origin: "zotero-reader",
      nativePageIndex: 1,
      page: 2
    }
  ];
  const normalized = ChatInternals.normalizeReferenceQuotes(quotes);
  assert.equal(normalized.length, 2, "duplicate references must be removed without changing order");
  assert.equal(normalized[0].readerMode, "zotero-reader");
  assert.equal(normalized[0].origin, "zotero-reader");
  assert.equal(normalized[0].nativePageIndex, 1, "native Zotero page index must survive persistence");
  assert.equal(
    ChatInternals.combinedReferenceText(normalized),
    "[引用 1 · 第 2 页]\nFirst quoted passage.\n\n[公式 2 · 第 3 页]\nE = mc^2"
  );
  const invalidPage = ChatInternals.normalizeReferenceQuotes([{ type: "text", text: "safe", page: "not-a-page" }]);
  assert.equal(invalidPage[0].page, 0, "invalid quote page values must normalize to zero");
  const legacyMessage = ChatInternals.normalizeMessage({
    role: "user",
    content: [{ type: "text", text: "legacy question" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }]
  });
  assert.equal(legacyMessage.content, "legacy question", "legacy multimodal message arrays must retain their text");
  assert.equal(legacyMessage.legacyContentParts.filter(part => part.type === "image_url").length, 1);
  for (const mime of ["image/bmp", "image/jp2", "image/svg+xml"]) {
    const legacyImage = ChatInternals.normalizeMessage({
      role: "user",
      content: [{ type: "image_url", image_url: { url: `data:${mime};base64,AA==` } }]
    });
    assert.equal(legacyImage.legacyContentParts.length, 1, `legacy ${mime} image must be retained`);
  }
  assert.equal(ChatInternals.normalizeMessage({ role: "assistant", content: [{ type: "image_url", image_url: { url: "https://remote.invalid/a.png" } }] }), null, "remote legacy image URLs must not be persisted");
  assert.equal(ChatInternals.normalizeMessage({ role: "user", content: [], text: "legacy text fallback" }).content, "legacy text fallback");
  const safeFilename = ChatInternals.normalizeMessage({
    role: "user",
    content: "document",
    documents: [{
      id: "doc",
      markdownRelativePath: "chat/documents/doc/paper..draft.md",
      rootRelativePath: "chat/documents/doc",
      imageMap: [{ cleanTarget: "fig..1.png" }]
    }]
  });
  assert.equal(safeFilename.documents[0].markdownRelativePath, "chat/documents/doc/paper..draft.md");
  assert.equal(safeFilename.documents[0].imageMap[0].cleanTarget, "fig..1.png");
  assert.equal(ChatInternals.normalizeMessage({
    role: "user", content: "unsafe", documents: [{
      markdownRelativePath: "chat/documents/doc/../escape.md",
      rootRelativePath: "chat/documents/doc"
    }]
  }).documents.length, 0, "path traversal segments must be rejected");
  assert.equal(ChatInternals.normalizeMessage({
    role: "user", content: "unsafe", documents: [{
      markdownRelativePath: "/chat/documents/doc/paper.md",
      rootRelativePath: "chat/documents/doc"
    }]
  }).documents.length, 0, "absolute document paths must be rejected");
  const legacyAssistant = ChatInternals.normalizeMessage({
    role: "assistant", content: "answer", thinking: "old reasoning", interrupted: "false"
  });
  assert.equal(legacyAssistant.reasoning, "old reasoning");
  assert.equal(legacyAssistant.interrupted, false, "string false must not become a truthy interruption flag");
  const invalidCounts = ChatInternals.normalizeMessage({
    role: "user", content: "counts", attachments: [{ mimeType: "image/png", relativePath: "chat/attachments/a.png", size: "bad" }],
    documents: [{ id: "d", name: "doc", markdownRelativePath: "chat/documents/d/document.md", rootRelativePath: "chat/documents/d", charCount: "bad", imageCount: "bad" }]
  });
  assert.equal(invalidCounts.attachments[0].size, 0);
  assert.equal(invalidCounts.documents[0].charCount, 0);
  assert.equal(invalidCounts.documents[0].imageCount, 0);
  const apiText = ChatInternals.messageTextForAPI({
    role: "user",
    content: "",
    referenceQuotes: normalized
  });
  assert(apiText.includes("用户引用了文档中的以下内容"));
  assert(apiText.includes("请解释这段内容的含义"));

  const storage = new MemoryStorage();
  await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Paper\n\nSource context.");
  let request = null;
  const llm = withResolvedChatModel({
    getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000 }),
    async complete(messages, options) {
      request = messages;
      options.onText?.("引用回答");
      return { text: "引用回答", reasoning: "" };
    }
  });
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  const session = await chat.loadSession("doc");
  const result = await chat.send("doc", session.id, "", {
    contextMode: "selected",
    referenceQuotes: quotes
  });
  assert.equal(result.session.messages[0].content, "");
  assert.equal(result.session.messages[0].referenceQuotes.length, 2);
  assert(request.some(message => message.role === "user" && JSON.stringify(message.content).includes("First quoted passage.")));
}

async function testLegacyChatSessionMigration() {
  const storage = new MemoryStorage();
  const llm = withResolvedChatModel({ getSettings: () => ({ targetLanguage: "简体中文" }) });
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  await storage.ensureDir(storage.path("doc", "chat"));
  await storage.writeJSON(storage.path("doc", "chat", "index.json"), [
    { id: "older", updatedAt: "2020-01-01T00:00:00Z" },
    { id: "newer", updatedAt: "2024-01-01T00:00:00Z" }
  ]);
  await storage.writeJSON(storage.path("doc", "chat", "session.older.json"), { messages: [{ role: "user", content: "old" }] });
  await storage.writeJSON(storage.path("doc", "chat", "session.newer.json"), {
    messages: [{ role: "user", content: "migrated" }], apiCacheSessionID: "legacy-cache"
  });
  const migrated = await chat.loadSession("doc");
  assert.equal(migrated.id, "document-chat");
  assert.equal(migrated.messages[0].content, "migrated");
  assert.equal(migrated.apiCacheSessionID, "legacy-cache");
  const index = await storage.readJSON(storage.path("doc", "chat", "index.json"), []);
  assert.deepEqual(index.map(row => row.id), ["document-chat", "older"]);
  const again = await chat.loadSession("doc", "older");
  assert.equal(again.id, "document-chat", "a legacy session ID must not open another conversation in embedded mode");
  assert.equal(again.messages[0].content, "migrated");
}

async function testMultimodalChat() {
  const storage = new MemoryStorage();
  await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Paper\n\nSource context.");
  const tinyPNG = "data:image/png;base64,iVBORw0KGgo=";
  let calls = 0;
  const events = [];
  const userRequests = [];
  const llm = withResolvedChatModel({
    getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000 }),
    async complete(messages, options) {
      calls++;
      const user = [...messages].reverse().find(message => message.role === "user");
      assert(Array.isArray(user.content));
      userRequests.push(user.content);
      const imageIndex = user.content.findIndex(part => part.type === "image_url" && part.image_url.url.startsWith("data:image/png;base64,"));
      const questionIndex = user.content.findIndex(part => part.type === "text" && part.text.includes("当前最新一轮用户问题"));
      assert(imageIndex >= 0, "the latest pasted image must reach the model payload");
      assert(questionIndex > imageIndex, "the current question must follow its pasted image so the visual reference is unambiguous");
      options.onText?.("图像回答");
      return { text: "图像回答", reasoning: "" };
    }
  });
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  const session = await chat.loadSession("doc");
  const first = await chat.send("doc", session.id, "解释截图", {
    contextMode: "source",
    images: [{
      name: "image.png",
      originalName: "image.png",
      source: "paste",
      capturedAt: "2026-08-04T02:34:55.123Z",
      mimeType: "image/png",
      dataURL: tinyPNG,
      width: 1177,
      height: 256,
      originalWidth: 262,
      originalHeight: 57,
      optimizedForVision: true
    }]
  }, event => events.push(event));
  const second = await chat.send("doc", first.session.id, "我指的是当前这张图", {
    contextMode: "source",
    images: [{
      name: "image.png",
      originalName: "image.png",
      source: "paste",
      capturedAt: "2026-08-04T02:35:37.456Z",
      mimeType: "image/png",
      dataURL: tinyPNG,
      width: 1177,
      height: 256,
      originalWidth: 262,
      originalHeight: 57,
      optimizedForVision: true
    }]
  }, event => events.push(event));
  assert.equal(calls, 2);
  const users = second.session.messages.filter(message => message.role === "user");
  assert.equal(users.length, 2);
  assert.equal(users[0].attachments.length, 1);
  assert.equal(users[1].attachments.length, 1);
  assert(users[0].attachments[0].url.startsWith("resource://litmtrans-data/doc/chat/attachments/"));
  assert(U.isIdentifiedPastedImageName(users[0].attachments[0].name));
  assert(U.isIdentifiedPastedImageName(users[1].attachments[0].name));
  assert.notEqual(users[0].attachments[0].name, users[1].attachments[0].name, "successive clipboard images must remain distinguishable");
  assert(userRequests[0].some(part => part.type === "text" && part.text.includes("[用户图片 1-1]")));
  assert(userRequests[1].some(part => part.type === "text" && part.text.includes("[用户图片 2-1]")));
  assert(userRequests[1].some(part => part.type === "text" && part.text.includes("不要与论文内图片或更早轮次图片混淆")));
  assert.equal(storage.bytes.size, 2);
}

async function testMissingCurrentImageIsNotMaskedByHistory() {
  const storage = new MemoryStorage();
  await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Paper\n\nSource context.");
  const tinyPNG = "data:image/png;base64,iVBORw0KGgo=";
  let calls = 0;
  const llm = withResolvedChatModel({
    getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000 }),
    async complete(messages, options) {
      calls++;
      options.onText?.("历史图片回答");
      return { text: "历史图片回答", reasoning: "" };
    }
  });
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  const session = await chat.loadSession("doc");
  const first = await chat.send("doc", session.id, "解释第一张图", {
    contextMode: "source",
    images: [{ name: "history.png", mimeType: "image/png", dataURL: tinyPNG }]
  });
  assert.equal(calls, 1);
  first.session.messages.push({
    id: "message-current-missing",
    role: "user",
    content: "解释当前这张图",
    attachments: [{
      id: "image-current-missing",
      name: "粘贴图片-20260804-104500-000-01.png",
      mimeType: "image/png",
      relativePath: "chat/attachments/document-chat/missing-current.png",
      size: 2906,
      source: "paste",
      capturedAt: "2026-08-04T02:45:00.000Z"
    }],
    createdAt: "2026-08-04T02:45:00.000Z"
  });
  await assert.rejects(
    () => chat.generateReply("doc", first.session, first.session.messages.length - 1, { contextMode: "source" }),
    /无法读取本轮添加的图片.*粘贴图片-20260804-104500-000-01\.png/,
    "a readable historical image must not mask failure to load the current pasted image"
  );
  assert.equal(calls, 1, "the provider must not be called when the current image payload is missing");
}

async function testCurrentImageValidationSurvivesTransientPartMetadataLoss() {
  const storage = new MemoryStorage();
  await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Paper\n\nSource context.");
  const tinyPNG = "data:image/png;base64,iVBORw0KGgo=";
  let calls = 0;
  const llm = withResolvedChatModel({
    getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000 }),
    async complete(messages, options) {
      calls++;
      const user = [...messages].reverse().find(message => message.role === "user");
      assert(Array.isArray(user.content));
      assert(user.content.some(part => part.type === "image_url"));
      assert(user.content.every(part => !part.localAttachmentID), "the simulated Zotero path must strip transient part metadata");
      options.onText?.("图片已读取");
      return { text: "图片已读取", reasoning: "" };
    }
  });
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  const originalHistoryMessagesForAPI = chat.historyMessagesForAPI.bind(chat);
  chat.historyMessagesForAPI = async (...args) => {
    const history = await originalHistoryMessagesForAPI(...args);
    for (const message of history) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part?.type !== "image_url") continue;
        delete part.localAttachmentID;
        delete part.localAttachmentReference;
      }
    }
    return history;
  };
  const session = await chat.loadSession("doc");
  const result = await chat.send("doc", session.id, "解释当前图片", {
    contextMode: "source",
    images: [{
      name: "image.png",
      source: "paste",
      capturedAt: "2026-08-04T03:40:27.901Z",
      mimeType: "image/png",
      dataURL: tinyPNG
    }]
  });
  assert.equal(calls, 1);
  assert.equal(result.message.content, "图片已读取");
}

async function testCurrentImagePayloadRecoversWhenTransportBookkeepingIsLost() {
  const storage = new MemoryStorage();
  await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Paper\n\nSource context.");
  const tinyPNG = "data:image/png;base64,iVBORw0KGgo=";
  let calls = 0;
  const llm = withResolvedChatModel({
    getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000 }),
    async complete(messages, options) {
      calls++;
      const user = [...messages].reverse().find(message => message.role === "user");
      assert(Array.isArray(user.content));
      assert(user.content.some(part => part?.type === "image_url" && part.image_url.url === tinyPNG));
      options.onText?.("已从附件恢复图片");
      return { text: "已从附件恢复图片", reasoning: "" };
    }
  });
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  const originalHistoryMessagesForAPI = chat.historyMessagesForAPI.bind(chat);
  chat.historyMessagesForAPI = async (...args) => {
    const history = await originalHistoryMessagesForAPI(...args);
    args[3]?.clear();
    const latest = history[history.length - 1];
    if (Array.isArray(latest?.content)) latest.content = latest.content.filter(part => part?.type !== "image_url");
    return history;
  };
  const session = await chat.loadSession("doc");
  const result = await chat.send("doc", session.id, "解释当前图片", {
    contextMode: "source",
    images: [{
      name: "image.png",
      source: "paste",
      capturedAt: "2026-08-04T04:11:53.332Z",
      mimeType: "image/png",
      dataURL: tinyPNG
    }]
  });
  assert.equal(calls, 1);
  assert.equal(result.message.content, "已从附件恢复图片");
}

async function testPastedImageHistoryKeepsOriginalDataURL() {
  const storage = new MemoryStorage();
  await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Paper\n\nSource context.");
  const tinyPNG = "data:image/png;base64,iVBORw0KGgo=";
  let calls = 0;
  const llm = withResolvedChatModel({
    getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000 }),
    async complete(messages, options) {
      calls++;
      const user = [...messages].reverse().find(message => message.role === "user");
      assert(Array.isArray(user.content));
      assert(user.content.some(part => part?.type === "image_url" && part.image_url.url === tinyPNG));
      options.onText?.("图片历史正常");
      return { text: "图片历史正常", reasoning: "" };
    }
  });
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  const session = await chat.loadSession("doc");
  const first = await chat.send("doc", session.id, "解释当前图片", {
    contextMode: "source",
    images: [{ name: "image.png", source: "paste", mimeType: "image/png", dataURL: tinyPNG }]
  });
  const raw = await storage.readJSON(storage.path("doc", "chat", "session.document-chat.json"), null);
  assert.equal(raw.messages[0].attachments[0].dataURL, tinyPNG, "pasted image data must persist with the conversation like the Python implementation");
  await storage.remove(storage.path("doc", raw.messages[0].attachments[0].relativePath), false);
  const retry = await chat.resend("doc", first.session.id, raw.messages[0].id, { contextMode: "source" });
  assert.equal(calls, 2, "resending a historical pasted image must not depend on its cache file");
  assert.equal(retry.message.content, "图片历史正常");
}

async function testMultimodalFallback() {
  const storage = new MemoryStorage();
  await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Paper\n\nSource context.");
  const tinyPNG = "data:image/png;base64,iVBORw0KGgo=";
  let calls = 0;
  const warnings = [];
  const llm = withResolvedChatModel({
    getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000 }),
    async complete(messages, options) {
      calls++;
      const user = [...messages].reverse().find(message => message.role === "user");
      if (calls === 1) {
        assert(Array.isArray(user.content));
        throw new Error("HTTP 400: {\"error\":{\"code\":\"1210\",\"message\":\"messages.content.type 参数非法，取值范围 ['text']\"}}");
      }
      assert.equal(typeof user.content, "string");
      options.onText?.("纯文本回答");
      return { text: "纯文本回答", reasoning: "" };
    }
  });
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  const session = await chat.loadSession("doc");
  const result = await chat.send("doc", session.id, "解释截图", {
    contextMode: "selected",
    images: [{ name: "figure.png", mimeType: "image/png", dataURL: tinyPNG }]
  }, event => { if (event.type === "warning") warnings.push(event.message); });
  assert.equal(calls, 2);
  assert.equal(result.message.content, "纯文本回答");
  assert.equal(warnings.length, 1);
  assert(ChatInternals.looksLikeImageUnsupportedError(new Error("unknown image_url variant")));
  assert(ChatInternals.looksLikeImageUnsupportedError(new Error("messages.content.type 参数非法，取值范围 ['text']")));
  assert(!ChatInternals.looksLikeImageUnsupportedError(new Error("messages.content.type 参数非法，取值范围 ['json']")));
  assert(ChatInternals.looksLikeImageUnsupportedError(new Error('Failed to deserialize the JSON body into the target type: messages[0]: invalid type: string "https://example.com/test.png", expected struct OpenAICompletionImageUrl at line 1 column 184')));
  assert(ChatInternals.looksLikeImageUnsupportedError(new Error('{"code":20041,"message":"The model is not a VLM (Vision Language Model). Please use text-only prompts.","data":null}')));
  assert(ChatInternals.looksLikeImageUnsupportedError(new Error("当前模型不支持图片输入，请使用纯文本")));
  assert(!ChatInternals.looksLikeImageUnsupportedError(new Error("HTTP 413: <html><title>413 Request Entity Too Large</title></html>")));
}

async function testPayloadTooLargePreservesImageCapability() {
  const errors = [
    Object.assign(new Error("image_url request rejected"), { status: 413 }),
    new Error("HTTP 413: <html><title>413 Request Entity Too Large</title></html>"),
    new Error("Payload too large"),
    Object.assign(new Error("Request rejected"), { body: "Request entity too large: image_url" })
  ];
  for (const error of errors) {
    const storage = new MemoryStorage();
    U.setPref("nonMultimodalModelMarks", "{}");
    await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Paper\n\nSource context.");
    const tinyPNG = "data:image/png;base64,iVBORw0KGgo=";
    const model = "vision-payload-limit-test";
    let calls = 0;
    const warnings = [];
    const llm = withResolvedChatModel({
      getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000, model }),
      resolveConfig: () => ({ provider: "openai", model }),
      async complete(messages) {
        calls++;
        const user = [...messages].reverse().find(message => message.role === "user");
        if (calls === 2) {
          assert(messages.every(message => typeof message.content === "string"));
          assert(user.content.includes("解释截图"));
          return { text: "纯文本回答", reasoning: "" };
        }
        assert(Array.isArray(user.content));
        assert(user.content.some(part => part?.type === "image_url" && part.image_url.url === tinyPNG));
        if (calls === 1) throw error;
        return { text: "图片回答", reasoning: "" };
      }
    });
    const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
    const session = await chat.loadSession("doc");
    const options = {
      contextMode: "selected",
      images: [{ name: "figure.png", mimeType: "image/png", dataURL: tinyPNG }]
    };
    await chat.send("doc", session.id, "解释截图", options, event => {
      if (event.type === "warning") warnings.push(event.message);
    });
    assert.equal(calls, 2);
    assert.equal(warnings.length, 1);
    assert(warnings[0].includes("请求内容过大"));
    assert(!chat.imageUnsupportedModels.has(model));
    assert.equal(U.getPref("nonMultimodalModelMarks", "{}"), "{}");
    const saved = await chat.loadSession("doc");
    assert.equal(saved.messages[0].attachments.length, 1);
    const attachment = saved.messages[0].attachments[0];
    assert((await storage.readBytes(storage.path("doc", attachment.relativePath))).length > 0);
    assert.equal(await chat.attachmentDataURL("doc", attachment), tinyPNG);
    const reloaded = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
    await reloaded.send("doc", session.id, "解释下一张小图", options);
    assert.equal(calls, 3);
  }
}

async function testDeepSeekDeserializeFallbackAndRollback() {
  const storage = new MemoryStorage();
  U.setPref("nonMultimodalModelMarks", "{}");
  await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Paper\n\nSource context.");
  const tinyPNG = "data:image/png;base64,iVBORw0KGgo=";
  let calls = 0;
  const warnings = [];
  const llm = withResolvedChatModel({
    getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000, model: "deepseek-v4-flash" }),
    resolveConfig: () => ({ provider: "deepseek", baseURL: "https://api.deepseek.com", model: "deepseek-v4-flash" }),
    async complete(messages, options) {
      calls++;
      const user = [...messages].reverse().find(message => message.role === "user");
      if (calls === 1) {
        assert(Array.isArray(user.content));
        throw new Error('HTTP 400: {"error":{"message":"Failed to deserialize the JSON body into the target type: messages[0]: invalid type: string \\"https://example.com/test.png\\", expected struct OpenAICompletionImageUrl at line 1 column 184","type":"invalid_request_error"}}');
      }
      assert.equal(typeof user.content, "string");
      options.onText?.("降级纯文本回答成功");
      return { text: "降级纯文本回答成功", reasoning: "" };
    }
  });
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  const session = await chat.loadSession("doc");
  const result = await chat.send("doc", session.id, "分析这篇文献", {
    contextMode: "selected",
    images: [{ name: "fig.png", mimeType: "image/png", dataURL: tinyPNG }]
  }, event => { if (event.type === "warning") warnings.push(event.message); });
  assert.equal(calls, 2);
  assert.equal(result.message.content, "降级纯文本回答成功");
  assert.equal(warnings.length, 1);

  const failingLLM = withResolvedChatModel({
    getSettings: () => ({ targetLanguage: "简体中文", chatContextChars: 50000, model: "deepseek-v4-flash" }),
    resolveConfig: () => ({ provider: "deepseek", baseURL: "https://api.deepseek.com", model: "deepseek-v4-flash" }),
    async complete() {
      throw new Error("Fatal network error 500");
    }
  });
  const chatWithFail = new ChatService(storage, failingLLM, { load: async () => ({ markdown: "" }) });
  let failed = false;
  try {
    await chatWithFail.send("doc", session.id, "一次失败的提问", { contextMode: "source" });
  }
  catch (_) {
    failed = true;
  }
  assert(failed);
  const reloadedSession = await chatWithFail.loadSession("doc");
  assert.notEqual(reloadedSession.messages[reloadedSession.messages.length - 1]?.content, "一次失败的提问");
}

async function testDocumentImageSendOptions() {
  const storage = new MemoryStorage();
  const markdownPath = storage.path("doc", "chat", "documents", "ref", "document.md");
  const imagePath = storage.path("doc", "chat", "documents", "ref", "images", "figure.png");
  await storage.writeText(markdownPath, "# Reference\n\n![FIGURE_001](images/figure.png)\n\nBody.");
  await storage.writeBytes(imagePath, new Uint8Array([137, 80, 78, 71]));
  await storage.writeText(storage.path("doc", "full.cleaned.md"), "# Current\n\n![FIGURE_001](images/figure.png)\n\nCurrent body.");
  await storage.writeJSON(storage.path("doc", "image-map.json"), [{ alt: "FIGURE_001", cleanTarget: "images/figure.png" }]);
  await storage.writeBytes(storage.path("doc", "images", "figure.png"), new Uint8Array([137, 80, 78, 71]));
  const chat = new ChatService(storage, withResolvedChatModel({ getSettings: () => ({ chatContextChars: 50000 }) }), null);
  const document = {
    id: "ref",
    name: "Reference",
    markdownRelativePath: "chat/documents/ref/document.md",
    rootRelativePath: "chat/documents/ref",
    imageMap: [{ alt: "FIGURE_001", cleanTarget: "images/figure.png" }]
  };
  const forcedImages = await chat.documentMessageParts("doc", {
    documents: [document],
    documentOptions: { imageMode: "full_no_images" },
    content: "请概括"
  }, new Set());
  assert.equal(forcedImages.filter(part => part.type === "image_url").length, 1, "embedded mode must ignore a caller's text-only override");
  assert(forcedImages.some(part => part.type === "text" && part.text.includes("===== 用户问题 =====")));
  const withImages = await chat.documentMessageParts("doc", {
    documents: [document],
    documentOptions: { imageMode: "full_with_images", compressImages: false, sequentialImages: true },
    content: "请概括"
  }, new Set());
  assert.equal(withImages.filter(part => part.type === "image_url").length, 1);
  const stillSequential = await chat.documentMessageParts("doc", {
    documents: [document],
    documentOptions: { imageMode: "full_with_images", compressImages: false, sequentialImages: false },
    content: "请概括"
  }, new Set());
  assert.equal(stillSequential.filter(part => part.type === "image_url").length, 1);
  assert(stillSequential.some(part => part.type === "text" && part.text.includes("Body.")));
  const currentForcedImages = await chat.currentDocumentMessageParts("doc", "请概括", null, { imageMode: "full_no_images" });
  assert.equal(currentForcedImages.filter(part => part.type === "image_url").length, 1);
  assert(currentForcedImages.some(part => part.type === "text" && part.text.includes("===== 当前Zotero文献结束 =====")));
  const currentWithImages = await chat.currentDocumentMessageParts("doc", "请概括", null, { imageMode: "full_with_images", compressImages: false });
  assert.equal(currentWithImages.filter(part => part.type === "image_url").length, 1);
  const currentStillSequential = await chat.currentDocumentMessageParts("doc", "请概括", null, { imageMode: "full_with_images", compressImages: false, sequentialImages: false });
  assert.equal(currentStillSequential.filter(part => part.type === "image_url").length, 1);
  assert(currentStillSequential.some(part => part.type === "text" && part.text.includes("Current body.")));
}

async function testNonMultimodalModelMarksTTL() {
  const ttl = ChatInternals.NON_MULTIMODAL_MARK_TTL_MS;
  assert.equal(ttl, 2 * 24 * 60 * 60 * 1000, "TTL must be 2 days");
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const initialMarks = {
    "recent-model": { model: "recent-model", timestamp: now - 1 * dayMs },
    "expired-3d-model": { model: "expired-3d-model", timestamp: now - 3 * dayMs },
    "expired-8d-model": { model: "expired-8d-model", timestamp: now - 8 * dayMs }
  };
  U.setPref("nonMultimodalModelMarks", JSON.stringify(initialMarks));
  const storage = new MemoryStorage();
  const llm = { getSettings: () => ({ targetLanguage: "简体中文" }) };
  const chat = new ChatService(storage, llm, { load: async () => ({ markdown: "" }) });
  assert(chat.imageUnsupportedModels.has("recent-model"), "recent mark within 2 days must be preserved");
  assert(!chat.imageUnsupportedModels.has("expired-3d-model"), "mark older than 2 days must be pruned");
  assert(!chat.imageUnsupportedModels.has("expired-8d-model"), "mark older than 7 days must be pruned");

  // 构造时已自动清理持久化首选项
  const diskAfterConstruct = JSON.parse(U.getPref("nonMultimodalModelMarks", "{}"));
  assert.equal(typeof diskAfterConstruct["recent-model"], "object");
  assert.equal(diskAfterConstruct["expired-3d-model"], undefined, "constructor must sanitize disk pref");
  assert.equal(diskAfterConstruct["expired-8d-model"], undefined, "constructor must sanitize disk pref");

  // 运行时 TTL 动态检查：在进程无需重启的情况下，时间推移导致标记超时
  chat.imageUnsupportedModels.set("aging-model", Date.now() - 3 * dayMs);
  assert.equal(chat.isImageUnsupported("aging-model"), false, "runtime TTL must expire aging models");
  assert(!chat.imageUnsupportedModels.has("aging-model"), "aging model must be evicted from map");
  const diskAfterEviction = JSON.parse(U.getPref("nonMultimodalModelMarks", "{}"));
  assert.equal(diskAfterEviction["aging-model"], undefined, "evicted model must be removed from pref");

  chat.markImageUnsupported("new-model");
  assert(chat.imageUnsupportedModels.has("new-model"));
  assert.equal(chat.isImageUnsupported("new-model"), true);
  const saved = JSON.parse(U.getPref("nonMultimodalModelMarks", "{}"));
  assert.equal(typeof saved["recent-model"], "object");
  assert.equal(typeof saved["new-model"], "object");
  assert.equal(saved["expired-3d-model"], undefined);
  assert.equal(saved["expired-8d-model"], undefined);
  U.setPref("nonMultimodalModelMarks", "{}");
}

  return {
    testChat,
    testChatGeminiStreamTimeoutFallback,
    testChatCurrentDocumentAfterClear,
    testChatImageCitationsStayDisplayOnly,
    testChatTurnMutationSemantics,
    testOrderedReferenceQuotes,
    testLegacyChatSessionMigration,
    testMultimodalChat,
    testMissingCurrentImageIsNotMaskedByHistory,
    testCurrentImageValidationSurvivesTransientPartMetadataLoss,
    testCurrentImagePayloadRecoversWhenTransportBookkeepingIsLost,
    testPastedImageHistoryKeepsOriginalDataURL,
    testMultimodalFallback,
    testPayloadTooLargePreservesImageCapability,
    testDeepSeekDeserializeFallbackAndRollback,
    testDocumentImageSendOptions,
    testNonMultimodalModelMarksTTL,
  };
};
