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

function testOpenRouterModelPricing() {
  const priced = LLMInternals.translationModelOptions("openrouter", [{
    id: "example/paid-model",
    name: "Paid model",
    pricing: { prompt: "0.0000006", completion: "0.0000025" }
  }]);
  assert.equal(
    priced[0].priceText,
    "输入 $0.6 / 输出 $2.5（每百万 Tokens）",
    "OpenRouter's per-token pricing must be displayed in the conventional per-million-token unit"
  );
  assert.equal(LLMInternals.formatOpenRouterPricePerMillion("0.000000125"), "0.125");
  assert.equal(LLMInternals.formatOpenRouterPricePerMillion("not-a-price"), "");
  const free = LLMInternals.translationModelOptions("openrouter", [{
    id: "example/free-model:free",
    pricing: { prompt: "0e-7", completion: "0" }
  }]);
  assert.equal(free[0].priceText, "免费", "free OpenRouter models must retain their free label");
}

function testHTTPParsing() {
  const parts = H.extractStreamParts({
    choices: [{ delta: { content: "answer", reasoning_content: "thought" } }],
    usage: { total_tokens: 3 }
  });
  assert.equal(parts.text, "answer");
  assert.equal(parts.reasoning, "thought");
  assert.equal(parts.usage.total_tokens, 3);
  const gatewayReasoning = H.extractStreamParts({
    reasoning_delta: "event-level thought",
    choices: [{ delta: { reasoning_details: { analysis: "analysis" } } }]
  });
  assert.equal(gatewayReasoning.reasoning, "analysis", "a choice-level reasoning delta must not be duplicated by an alias");
  const duplicatedOpenRouterShape = H.extractStreamParts({
    choices: [{ delta: {
      reasoning: "same public thought",
      reasoning_details: [{ type: "reasoning.text", text: "same public thought" }]
    }}]
  });
  assert.equal(duplicatedOpenRouterShape.reasoning, "same public thought", "equivalent OpenRouter reasoning fields must be treated as alternatives");
  assert.equal(H.extractStreamParts({ type: "message.delta", delta: { text: "compat text" } }).text, "compat text");
  assert.equal(H.extractStreamParts({ type: "content.delta", delta: "legacy text" }).text, "legacy text");
  assert.equal(H.extractStreamParts({ type: "content_block_delta", delta: { type: "text_delta", text: "anthropic text" } }).text, "anthropic text");
  assert.equal(H.extractStreamParts({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "anthropic thought" } }).reasoning, "anthropic thought");
  assert.equal(H.extractStreamParts({ output: [{ type: "reasoning", content: [{ type: "summary_text", text: "response thought" }] }] }).reasoning, "response thought");
  assert.equal(H.extractStreamParts({ content: "answer", reasoning_content: "top-level thought" }).reasoning, "top-level thought");
  assert.equal(H.extractOpenAIText({ output: [
    { type: "reasoning", content: [{ type: "summary_text", text: "hidden thought" }] },
    { type: "message", content: [{ type: "output_text", text: "visible answer" }] }
  ] }), "visible answer");
  assert.equal(H.extractOpenAIText({ choices: [{ message: { content: "ok" } }] }), "ok");
  assert.equal(
    H.geminiUsageToOpenAI({ promptTokenCount: 8000, candidatesTokenCount: 40, cachedContentTokenCount: 7600 }).prompt_tokens_details.cached_tokens,
    7600,
    "Gemini cachedContentTokenCount must reach the per-turn cache diagnostics"
  );
}

function testCacheFriendlyChatMessageOrdering() {
  const messages = [
    { role: "system", content: "fixed system" },
    { role: "user", content: "fixed document\n\nquestion" }
  ];
  ChatInternals.appendDynamicContextToLatestUser(messages, "selected excerpt that changes per turn");
  assert.equal(messages.length, 2, "dynamic selection context must not become an early system message");
  assert(messages[1].content.endsWith("selected excerpt that changes per turn"));
  assert(messages[0].content === "fixed system", "the cacheable system prefix must remain byte-stable");
}

function testReasoningRequestConstruction() {
  const deepseekPayload = { model: "deepseek-reasoner", messages: [], stream: true };
  const deepseekConfig = {
    provider: "deepseek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-reasoner",
    thinkingMode: "enabled",
    reasoningEffort: "medium"
  };
  LLMInternals.applyReasoningPayload(deepseekPayload, deepseekConfig);
  assert.deepEqual(deepseekPayload.thinking, { type: "enabled" });
  assert.equal(deepseekPayload.reasoning_effort, "high");
  assert.equal(LLMInternals.shouldSendTemperature(deepseekConfig), false);

  const oneAPIPayload = { model: "gpt-5.6", messages: [], stream: true };
  LLMInternals.applyReasoningPayload(oneAPIPayload, {
    provider: "oneapi",
    baseURL: "https://gateway.invalid/v1",
    model: "gpt-5.6",
    thinkingMode: "disabled",
    reasoningEffort: "default"
  });
  assert.equal(oneAPIPayload.reasoning_effort, "none");

  const geminiPayload = { model: "gemini-3.5-flash", messages: [], stream: true };
  LLMInternals.applyReasoningPayload(geminiPayload, {
    provider: "gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.5-flash",
    thinkingMode: "disabled",
    reasoningEffort: "default"
  });
  assert.equal(geminiPayload.reasoning_effort, "minimal");

  const geminiFlashPayload = { model: "gemini-2.5-flash", messages: [], stream: true };
  LLMInternals.applyReasoningPayload(geminiFlashPayload, {
    provider: "gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    thinkingMode: "disabled",
    reasoningEffort: "default"
  });
  assert.equal(geminiFlashPayload.reasoning_effort, "none");
  assert.equal(LLMInternals.normalizeGeminiModelID("models/gemini-2.5-flash"), "gemini-2.5-flash");
  assert.equal(LLMInternals.normalizeGeminiReasoningEffort("xhigh"), "high");
  assert.equal(LLMInternals.normalizeGeminiReasoningEffort("max"), "high");
  assert.equal(LLMInternals.normalizeReasoningEffort("oneapi", "max", "gpt-5.6"), "xhigh");
  const siliconConfig = { provider: "siliconflow", baseURL: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V4-Flash", thinkingMode: "enabled", reasoningEffort: "high" };
  const siliconPayload = LLMInternals.applyReasoningPayload({}, siliconConfig);
  assert.equal(siliconPayload.enable_thinking, undefined, "SiliconFlow must not send thinking before capability detection");
  LLMInternals.markSiliconflowThinkingCapability(siliconConfig.baseURL, siliconConfig.model, true);
  assert.deepEqual(LLMInternals.applyReasoningPayload({}, siliconConfig), { enable_thinking: true, thinking_budget: 8192 });
  assert.deepEqual(LLMInternals.applyReasoningPayload({}, { ...siliconConfig, thinkingMode: "default", reasoningEffort: "default" }), {});
  assert.deepEqual(LLMInternals.applyReasoningPayload({}, { ...siliconConfig, thinkingMode: "enabled", reasoningEffort: "low" }), { enable_thinking: true, thinking_budget: 2048 });
  LLMInternals.markSiliconflowThinkingCapability(siliconConfig.baseURL, siliconConfig.model, false);
  assert.equal(LLMInternals.siliconflowThinkingCapability(siliconConfig.baseURL, siliconConfig.model), false);
  assert.equal(LLMInternals.siliconflowThinkingCapability(siliconConfig.baseURL, "never-probed"), null);
  const siliconKey = LLMInternals.siliconflowCapabilityKey(siliconConfig.baseURL, siliconConfig.model);
  context.LitMTrans.Utils.setPref("siliconflowThinkingCapabilities", JSON.stringify({
    [siliconKey]: { supported: true, checkedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 }
  }));
  assert.equal(
    LLMInternals.siliconflowThinkingCapability(siliconConfig.baseURL, siliconConfig.model),
    null,
    "expired SiliconFlow capability probes must be discarded"
  );
  context.LitMTrans.Utils.setPref("siliconflowThinkingCapabilities", JSON.stringify({ [siliconKey]: true }));
  assert.equal(
    LLMInternals.siliconflowThinkingCapability(siliconConfig.baseURL, siliconConfig.model),
    null,
    "legacy bare-boolean capability records must be re-probed"
  );
  const sanitized = LLMInternals.sanitizeContentForAPI([
    { type: "text", text: "来源: C:\\Users\\Alice\\paper.pdf" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AA==", extra: "drop" } },
    { type: "tool_result", content: "must not leak" }
  ]);
  assert.deepEqual(sanitized, [
    { type: "text", text: "来源: [本地路径已隐藏]" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }
  ]);

  const geminiDefaultPayload = { model: "gemini-2.5-flash", messages: [], stream: true };
  LLMInternals.applyReasoningPayload(geminiDefaultPayload, {
    provider: "gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    thinkingMode: "default",
    reasoningEffort: "default"
  });
  assert.equal(geminiDefaultPayload.reasoning_effort, "medium");
  assert.equal(
    LLMInternals.geminiOpenAIChatURL("https://generativelanguage.googleapis.com/v1beta"),
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    "Gemini chat must retain the Python project's OpenAI-compatible transport"
  );

  const geminiThoughtPayload = { model: "gemini-3.1-flash-lite", messages: [], stream: true };
  LLMInternals.applyReasoningPayload(geminiThoughtPayload, {
    provider: "gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.1-flash-lite",
    thinkingMode: "default",
    reasoningEffort: "default",
    showReasoning: true
  });
  assert.equal(geminiThoughtPayload.reasoning_effort, undefined);
  assert.deepEqual(geminiThoughtPayload.extra_body, {
    google: { thinking_config: { thinking_level: "medium", include_thoughts: true } }
  });
}

async function testIndependentTranslationAndChatSettings() {
  assert.equal(LLMInternals.requestTimeout({}), 300000, "an omitted timeout must retain the transport default");
  assert.equal(LLMInternals.requestTimeout({ timeout: 0 }), 0, "an explicit zero timeout must disable the wall-clock deadline");
  assert.equal(LLMInternals.requestTimeout({ timeout: null }), 0, "an explicit null timeout must disable the wall-clock deadline");
  const secrets = {
    has: () => false,
    hasMinerUToken: false,
    llmKeyName: provider => `llm:${provider}`,
    getLLMKey: () => "",
    setLLMKey() {},
    removeLLMKey() {},
    setMinerUToken() {},
    removeMinerUToken() {}
  };
  const llm = new LLMService(secrets);
  const defaults = llm.getSettings();
  assert.equal(llm.getSettings("chat").chatUsesTranslationModel, true, "chat must share the translation model by default");
  assert.equal(defaults.sourceLanguage, "自动识别", "LLM translation must infer the source language");
  assert.equal(defaults.chunkChars, 135000, "chunked fallback must use the Python default boundary");
  assert.equal(defaults.layoutChunkChars, 135000, "layout translation must cap each JSON group at the shared character boundary");
  assert.equal(defaults.layoutChunkBlocks, 160, "layout translation must cap the number of id mappings per group");
  llm.saveSettings({
    webPageImageQuality: "high",
    webInputMode: "clipboard",
    deleteWebTranslationSessions: false
  }, "translation");
  const savedWebSettings = llm.getSettings("translation");
  assert.equal(savedWebSettings.webPageImageQuality, "high", "web page image quality must persist independently of input mode");
  assert.equal(savedWebSettings.webInputMode, "clipboard", "web input mode must persist");
  assert.equal(savedWebSettings.deleteWebTranslationSessions, false, "web translation session cleanup preference must persist");
  llm.saveSettings({ webPageImageQuality: "none" }, "translation");
  const legacyNoneWebSettings = llm.getSettings("translation");
  assert.equal(legacyNoneWebSettings.webPageImageQuality, "high", "legacy none page image quality must migrate to high");
  llm.saveSettings({
    webPageImageQuality: "invalid",
    webInputMode: "invalid",
    deleteWebTranslationSessions: "false"
  }, "translation");
  const normalizedWebSettings = llm.getSettings("translation");
  assert.equal(normalizedWebSettings.webPageImageQuality, "high", "invalid web page image quality must fall back to high");
  assert.equal(normalizedWebSettings.webInputMode, "auto", "invalid web input mode must fall back to auto");
  assert.equal(normalizedWebSettings.deleteWebTranslationSessions, false, "string false must remain false when restoring web settings");
  llm.saveSettings({ sourceLanguage: "日文", chunkChars: 20000, layoutChunkChars: 60000, layoutChunkBlocks: 20 }, "translation");
  const fixedTranslationDefaults = llm.getSettings("translation");
  assert.equal(fixedTranslationDefaults.sourceLanguage, "自动识别", "source-language preferences must not affect LLM translation");
  assert.equal(fixedTranslationDefaults.chunkChars, 135000, "chunk boundaries must remain internal");
  assert.equal(fixedTranslationDefaults.layoutChunkChars, 135000, "layout character grouping must remain internal");
  assert.equal(fixedTranslationDefaults.layoutChunkBlocks, 160, "layout block grouping must remain internal");
  llm.saveSettings({ customTranslationInstruction: "统一保留缩写" }, "translation");
  assert.equal(llm.getSettings("translation").customTranslationInstruction, "统一保留缩写");
  assert(new TranslationService({}, llm).baseSystemPrompt(llm.getSettings("translation")).includes("统一保留缩写"), "custom translation instructions must be sent with translation prompts");
  llm.saveSettings({ readerFontPt: 36.25 }, "translation");
  assert.equal(llm.getSettings("translation").readerFontPt, 12, "reader font size must remain the built-in default");
  assert.equal(context.LitMTransPort.normalizeSettings({ readerFontPt: 3.25 }).readerFontPt, 3.25, "core settings must preserve positive reader font sizes below the former lower bound");
  llm.saveSettings({
    provider: "deepseek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-reasoner",
    thinkingMode: "enabled",
    reasoningEffort: "max"
  }, "translation");
  llm.saveSettings({
    provider: "openrouter",
    baseURL: "https://openrouter.ai/api",
    model: "chat-model",
    thinkingMode: "disabled",
    reasoningEffort: "default"
  }, "chat");
  const translation = llm.getSettings("translation");
  const chat = llm.getSettings("chat");
  assert.equal(translation.provider, "deepseek");
  assert.equal(translation.model, "deepseek-reasoner");
  assert.equal(translation.thinkingMode, "enabled", "translation thinking mode must persist");
  assert.equal(translation.reasoningEffort, "max", "translation reasoning effort must persist");
  llm.saveSettings({
    provider: "deepseek", baseURL: "https://api.deepseek.com", model: "translation-fast-model",
    thinkingMode: "disabled", reasoningEffort: "low"
  }, "translation");
  llm.saveSettings({ provider: "deepseek", baseURL: "https://api.deepseek.com", model: "deepseek-reasoner" }, "translation");
  const restoredTranslationReasoningModel = llm.getSettings("translation");
  assert.equal(restoredTranslationReasoningModel.thinkingMode, "enabled", "translation reasoning mode must be restored per model");
  assert.equal(restoredTranslationReasoningModel.reasoningEffort, "max", "translation reasoning effort must be restored per model");
  assert.equal(chat.provider, "openrouter");
  assert.equal(chat.baseURL, "https://openrouter.ai/api/v1");
  assert.equal(chat.model, "chat-model");
  assert.equal(chat.thinkingMode, "disabled");
  assert.equal(chat.chatUsesTranslationModel, false, "saving a dedicated chat profile must disable model sharing");
  // Python stores reasoning controls per provider/model, not globally. A
  // fast chat model and a reasoning model must recover their own visibility.
  llm.saveSettings({
    provider: "oneapi", baseURL: "https://gateway.invalid/v1", model: "reasoning-model",
    thinkingMode: "enabled", reasoningEffort: "high", showReasoning: true
  }, "chat");
  llm.saveSettings({
    provider: "oneapi", baseURL: "https://gateway.invalid/v1", model: "fast-model",
    thinkingMode: "disabled", reasoningEffort: "default", showReasoning: false
  }, "chat");
  llm.saveSettings({
    provider: "oneapi", baseURL: "https://gateway.invalid/v1", model: "reasoning-model"
  }, "chat");
  const restoredReasoningModel = llm.getSettings("chat");
  assert.equal(restoredReasoningModel.thinkingMode, "enabled");
  assert.equal(restoredReasoningModel.reasoningEffort, "high");
  assert.equal(restoredReasoningModel.showReasoning, true);
  await assert.rejects(
    () => llm.ensureConfiguredModel({ purpose: "translation", model: "" }),
    /尚未选择翻译模型/
  );
  assert.equal(typeof ChatInternals.DEFAULT_KEY_POINTS_PROMPT, "string");
  assert(ChatInternals.DEFAULT_KEY_POINTS_PROMPT.trim().length > 0, "default key-points prompt must stay non-empty");
}

async function testHTTPStreaming() {
  const originalFetch = context.fetch;
  const encoder = new TextEncoder();
  const chunks = [
    encoder.encode('data: {"choices":[{"delta":{"content":"A"}}]}\n'),
    encoder.encode('data: {"choices":[{"delta":{"content":"<thought>reason"}}]}\n'),
    encoder.encode('data: {"choices":[{"delta":{"content":"ing</thought>B"}}]}\n'),
    encoder.encode('data: [DONE]\n')
  ];
  let index = 0;
  context.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: name => String(name).toLowerCase() === 'content-type' ? 'text/event-stream' : '' },
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[index++] };
          },
          async cancel() {}
        };
      }
    }
  });
  try {
    let streamed = '';
    let reasoning = '';
    const result = await H.streamOpenAI('https://example.invalid/chat/completions', { stream: true }, {
      token: 'x',
      onText: delta => { streamed += delta; },
      onReasoning: delta => { reasoning += delta; }
    });
    assert.equal(streamed, 'AB');
    assert.equal(result.text, 'AB');
    assert.equal(reasoning, 'reasoning');
    assert.equal(result.reasoning, 'reasoning');

    let cancelled = false;
    context.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: name => String(name).toLowerCase() === 'content-type' ? 'text/event-stream' : '' },
      body: {
        getReader() {
          return {
            read() { return new Promise(() => {}); },
            async cancel() { cancelled = true; }
          };
        }
      }
    });
    await assert.rejects(
      () => H.streamOpenAI('https://example.invalid/chat/completions', { stream: true }, {
        token: 'x',
        timeout: 1000,
        firstEventTimeout: 10
      }),
      error => error?.name === 'StreamTimeoutError' && error?.timeout === true
    );
    assert.equal(cancelled, true, 'a stalled stream reader must be cancelled after the first-event deadline');
  }
  finally {
    context.fetch = originalFetch;
  }
}

async function testGeminiQuotaCooldownUsesRetryAfter() {
  assert.equal(H.retryAfterMilliseconds({ get: () => "2" }, 0), 2000);
  assert.equal(
    H.retryAfterMilliseconds({ get: () => "Thu, 01 Jan 1970 00:00:03 GMT" }, 1000),
    2000
  );
  const llm = new LLMService({
    has: () => true,
    llmKeyName: provider => `llm:${provider}`,
    getLLMKey: () => "test-key"
  });
  llm.resolveConfig = () => ({
    provider: "gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-test",
    apiKey: "test-key"
  });
  let now = 1000;
  const waits = [];
  const notices = [];
  llm.rateLimitNow = () => now;
  llm.rateLimitSleep = async milliseconds => {
    waits.push(milliseconds);
    now += milliseconds;
  };
  let calls = 0;
  llm.completeOnce = async () => {
    calls++;
    if (calls === 1) throw new H.HTTPError("HTTP 429: RESOURCE_EXHAUSTED", 429, "", 2500);
    return { text: "恢复成功", reasoning: "", usage: null };
  };
  const result = await llm.complete([], {
    onRateLimitWait: event => notices.push(event)
  });
  assert.equal(result.text, "恢复成功");
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2500], "Gemini retries must respect Retry-After instead of imposing a proactive RPM limit");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].waitMs, 2500);
}

async function testDeepSeekGlobalConcurrencyLimit() {
  const llm = new LLMService({
    getLLMKey: () => "test-key"
  });
  llm.resolveConfig = () => ({
    provider: "deepseek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-chat",
    apiKey: "test-key"
  });
  const originalStreamOpenAI = H.streamOpenAI;
  let active = 0;
  let maximumActive = 0;
  H.streamOpenAI = async () => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    return { text: "ok", reasoning: "", usage: null };
  };
  try {
    const requestCount = LLMInternals.DEEPSEEK_CONCURRENCY_LIMIT + 5;
    const results = await Promise.all(
      Array.from({ length: requestCount }, () => llm.complete([], { stream: true }))
    );
    assert.equal(results.length, requestCount);
    assert(maximumActive > 3 && maximumActive <= LLMInternals.DEEPSEEK_CONCURRENCY_LIMIT,
      `expected the shared DeepSeek limiter to allow up to 500 requests without exceeding it, got ${maximumActive}`);
  }
  finally {
    H.streamOpenAI = originalStreamOpenAI;
  }
}

async function testPresignedUploadHeaders() {
  const originalFetch = context.fetch;
  let received = null;
  context.fetch = async (_url, options) => {
    received = options;
    return { ok: true, status: 200, statusText: "OK", headers: { get: () => "" } };
  };
  try {
    await H.uploadBytes("https://oss.example.invalid/presigned", new Uint8Array([1, 2, 3]));
    assert.equal(received.method, "PUT");
    assert.equal(received.headers["Content-Type"], undefined, "presigned MinerU upload must not add Content-Type");
    assert.equal(received.headers["User-Agent"], "LitMTrans/2.0.0");
  }
  finally {
    context.fetch = originalFetch;
  }
}

async function testRequestAuditExcludesSecrets() {
  const storage = new MemoryStorage();
  U.setPref("requestAudit", true);
  const path = await context.LitMTrans.Storage.prototype.writeRequestAudit.call(
    storage,
    "doc",
    "流式-全文连续翻译-第1轮",
    {
      provider: "oneapi",
      baseURL: "https://gateway.invalid/v1",
      model: "test-model",
      apiKey: "must-not-appear",
      promptCacheKey: "cache-key"
    },
    [
      { role: "system", content: "system prompt" },
      { role: "user", content: "full source text" }
    ],
    300
  );
  const saved = await storage.readText(path, "");
  assert(saved.includes("system prompt"));
  assert(saved.includes("full source text"));
  assert(saved.includes("请求缓存标识: cache-key"));
  assert(!saved.includes("must-not-appear"));
  U.setPref("requestAudit", false);
}

async function testImageGenerationRequest() {
  const secrets = {
    has: () => true,
    hasMinerUToken: false,
    llmKeyName: provider => `llm:${provider}`,
    getLLMKey: () => "test-key",
    setLLMKey() {}, removeLLMKey() {}, setMinerUToken() {}, removeMinerUToken() {}
  };
  const llm = new LLMService(secrets);
  llm.saveSettings({
    provider: "oneapi", baseURL: "https://gateway.invalid/v1", model: "gpt-image-test",
    showReasoning: false
  }, "chat");
  const originalRequestJSON = H.requestJSON;
  let request = null;
  H.requestJSON = async (method, url, options) => {
    request = { method, url, options };
    return { data: [{ b64_json: "iVBORw0KGgo=" }], revised_prompt: "revised" };
  };
  try {
    const result = await llm.generateImage("draw a figure", {
      imageSize: "1024x1024", imageQuality: "high", imageFormat: "png"
    });
    assert.equal(request.method, "POST");
    assert.equal(request.url, "https://gateway.invalid/v1/images/generations");
    assert.deepEqual(request.options.json, {
      model: "gpt-image-test", prompt: "draw a figure", size: "1024x1024", quality: "high", output_format: "png"
    });
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].mimeType, "image/png");
    assert(result.text.includes("revised"));
  }
  finally {
    H.requestJSON = originalRequestJSON;
  }
}

function testProviderCardsApplyToSelectedPurpose() {
  const controller = context.LitMTrans.createController({
    id: "litmtrans@local",
    version: "1.0.0",
    rootURI: "file:///plugin/"
  });
  const secrets = new Map();
  controller.secrets = {
    has: key => secrets.has(key),
    get: key => secrets.get(key) || "",
    set: (key, value) => secrets.set(key, value),
    remove: key => secrets.delete(key),
    llmKeyName: provider => `llm:${provider}`,
    getLLMKey: provider => secrets.get(`llm:${provider}`) || "",
    setLLMKey: (provider, value) => secrets.set(`llm:${provider}`, value),
    removeLLMKey: provider => secrets.delete(`llm:${provider}`),
    getMinerUToken: () => "",
    hasMinerUToken: () => false
  };
  controller.llm = new LLMService(controller.secrets);
  const previousCards = context.LitMTrans.Utils.getPref("providerCards", "[]");
  try {
    controller.writeProviderCards([]);
    const saved = controller.saveProviderCard({
      name: "翻译线路",
      provider: "deepseek",
      baseURL: "https://api.deepseek.com",
      apiKey: "card-key"
    });
    assert.deepEqual(controller.getProviderCardAPIKey(saved.card.id), {
      cardID: saved.card.id,
      apiKey: "card-key",
      hasAPIKey: true
    }, "a memory card editor must receive the real saved key for an unambiguous masked display");
    controller.llm.saveSettings({ provider: "deepseek", model: "remembered-translation-model" }, "translation");
    controller.llm.saveSettings({ provider: "oneapi", model: "translate-model" }, "translation");
    controller.llm.saveSettings({ provider: "openrouter", model: "chat-model" }, "chat");
    const applied = controller.applyProviderCard(saved.card.id, "translation");
    assert.equal(applied.purpose, "translation");
    assert.equal(controller.llm.getSettings("translation").provider, "deepseek");
    assert.equal(controller.llm.getSettings("translation").baseURL, "https://api.deepseek.com");
    assert.equal(controller.llm.getSettings("translation").model, "remembered-translation-model", "a card must retain that provider's remembered translation model");
    assert.equal(controller.llm.getSettings("chat").provider, "openrouter", "applying to translation must not alter a dedicated chat model");
    assert.equal(controller.llm.getSettings("translation").hasAPIKey, true);
    const cleared = controller.saveProviderCard({
      cardID: saved.card.id,
      name: "翻译线路",
      provider: "deepseek",
      baseURL: "https://api.deepseek.com",
      apiKey: ""
    });
    assert.equal(cleared.card.hasAPIKey, false, "clearing a visible memory-card key must delete it instead of silently retaining it");
    assert.equal(controller.getProviderCardAPIKey(saved.card.id).apiKey, "");
  }
  finally {
    context.LitMTrans.Utils.setPref("providerCards", previousCards);
  }
}

function testGeminiRequestHeadersDoNotImpersonateGoogleSDK() {
  const llm = new LLMService(new MemoryStorage(), {
    getLLMKey: () => "test-key"
  });
  const headers = llm.requestHeaders({
    provider: "gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "test-key"
  });
  assert.equal(headers["x-goog-api-key"], "test-key");
  assert.equal(
    headers["x-goog-api-client"],
    undefined,
    "the plugin must not send an invented Google SDK identification header"
  );
}

function testOneAPIRequestHeadersKeepCacheSessionStable() {
  const llm = new LLMService(new MemoryStorage(), {
    getLLMKey: () => "test-key"
  });
  const headers = llm.requestHeaders({
    provider: "oneapi",
    baseURL: "https://gateway.invalid/v1",
    apiKey: "test-key",
    promptCacheKey: "4b8e51bf-91ea-4a2d-b6c8-100000000001"
  });
  assert.equal(headers["session-id"], "4b8e51bf-91ea-4a2d-b6c8-100000000001");
  assert.equal(headers["thread-id"], headers["session-id"]);
  assert.equal(headers["x-client-request-id"], headers["session-id"]);

  const compatibleHeaders = llm.requestHeaders({
    provider: "openai_compatible",
    baseURL: "https://gateway.invalid/v1",
    apiKey: "test-key",
    promptCacheKey: "4b8e51bf-91ea-4a2d-b6c8-100000000002"
  });
  assert.equal(compatibleHeaders["session-id"], "4b8e51bf-91ea-4a2d-b6c8-100000000002");

  const openRouterKey = "4b8e51bf-91ea-4a2d-b6c8-100000000003";
  const openRouterHeaders = llm.requestHeaders({
    provider: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKey: "test-key", promptCacheKey: openRouterKey
  });
  assert.equal(openRouterHeaders["x-session-id"], openRouterKey, "OpenRouter must receive its documented sticky-routing session header");
  assert.equal(openRouterHeaders["session-id"], undefined, "OpenRouter must not receive gateway-specific cache headers");
  const openRouterPayload = { model: "deepseek/deepseek-v4-flash-0731", messages: [], stream: true };
  assert.equal(LLMInternals.applyPromptCacheSession(openRouterPayload, { provider: "openrouter", promptCacheKey: openRouterKey }), true);
  assert.equal(openRouterPayload.session_id, openRouterKey);
  assert.deepEqual(openRouterPayload.stream_options, { include_usage: true });
  const anthropicPayload = { messages: [{ role: "system", content: "stable" }, { role: "user", content: "question" }] };
  assert.equal(LLMInternals.applyOpenRouterCacheStrategy(anthropicPayload, { provider: "openrouter", model: "anthropic/claude-sonnet-4" }), "anthropic-auto");
  assert.deepEqual(anthropicPayload.cache_control, { type: "ephemeral" });
  const qwenPayload = { messages: [{ role: "system", content: "stable" }, { role: "user", content: "question" }] };
  assert.equal(LLMInternals.applyOpenRouterCacheStrategy(qwenPayload, { provider: "openrouter", model: "qwen/qwen3-coder-plus" }), "explicit-breakpoint");
  assert.deepEqual(qwenPayload.messages[0].content[0].cache_control, { type: "ephemeral" }, "explicit-cache models must mark the stable prompt prefix");
}

  return {
    testOpenRouterModelPricing,
    testHTTPParsing,
    testCacheFriendlyChatMessageOrdering,
    testReasoningRequestConstruction,
    testIndependentTranslationAndChatSettings,
    testHTTPStreaming,
    testGeminiQuotaCooldownUsesRetryAfter,
    testDeepSeekGlobalConcurrencyLimit,
    testPresignedUploadHeaders,
    testRequestAuditExcludesSecrets,
    testImageGenerationRequest,
    testProviderCardsApplyToSelectedPurpose,
    testGeminiRequestHeadersDoNotImpersonateGoogleSDK,
    testOneAPIRequestHeadersKeepCacheSessionStable,
  };
};
