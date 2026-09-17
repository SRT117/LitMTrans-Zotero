(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const U = LitMTrans.Utils;
  const H = LitMTrans.HTTP;
  const C = LitMTrans.Constants;
  const P = LitMTrans.PortedCore || {};
  const DEEPSEEK_CONCURRENCY_LIMIT = 500;
  // Layout requests are bounded by both source length and mapping count.
  // The layout service is responsible for scheduling the resulting groups.
  const INTERNAL_TRANSLATION_DEFAULTS = Object.freeze({
    sourceLanguage: "自动识别",
    chunkChars: 135000,
    layoutChunkChars: 135000,
    layoutChunkBlocks: 160
  });

  // An omitted timeout gets the normal transport safeguard.  Callers that
  // explicitly pass 0 or null, however, are deliberately opting into a
  // user-cancellable request with no wall-clock deadline.  Do not use `||`
  // here: it turns that opt-in back into the default timeout.
  function requestTimeout(options, fallback = 300000) {
    if (!Object.prototype.hasOwnProperty.call(options || {}, "timeout")) return fallback;
    const value = Number(options.timeout);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function positiveFontSize(value, fallback = 12) {
    const fontSize = Number(value);
    return Number.isFinite(fontSize) && fontSize > 0 ? fontSize : fallback;
  }

  function normalizeThinkingMode(value) {
    const text = String(value || "").trim().toLowerCase();
    const aliases = {
      "": "default",
      "服务商默认": "default",
      "默认": "default",
      "default": "default",
      "开启": "enabled",
      "启用": "enabled",
      "enabled": "enabled",
      "on": "enabled",
      "关闭": "disabled",
      "禁用": "disabled",
      "disabled": "disabled",
      "off": "disabled"
    };
    return aliases[text] || text || "default";
  }

  function isDeepSeekReasoningProtocol(provider, baseURL, model) {
    const id = String(provider || "").toLowerCase();
    const url = String(baseURL || "").toLowerCase();
    const name = String(model || "").toLowerCase();
    return id === "deepseek" || url.includes("deepseek") || name.includes("deepseek");
  }

  function isGeminiProvider(provider, baseURL = "") {
    return String(provider || "").toLowerCase() === "gemini"
      || String(baseURL || "").toLowerCase().includes("generativelanguage.googleapis.com");
  }

  function isDeepSeekProvider(provider, baseURL = "") {
    // Provider profiles imported from older versions can retain the generic
    // OpenAI-compatible id while pointing at the official DeepSeek endpoint.
    // Keep this classification aligned with the actual service, rather than
    // silently falling back to the conservative third-party limit.
    return String(provider || "").trim().toLowerCase() === "deepseek"
      || /(?:^|:\/\/)api\.deepseek\.com(?:[/:]|$)/i.test(String(baseURL || "").trim());
  }

  function isOfficialDeepSeekProvider(provider, baseURL = "") {
    return String(provider || "").trim().toLowerCase() === "deepseek"
      && /(?:^|:\/\/)api\.deepseek\.com(?:[/:]|$)/i.test(String(baseURL || "").trim());
  }

  function providerConcurrencyLimit(provider, fallback, baseURL = "") {
    const defaultLimit = Math.max(1, Math.trunc(Number(fallback) || 1));
    return isDeepSeekProvider(provider, baseURL) ? DEEPSEEK_CONCURRENCY_LIMIT : defaultLimit;
  }

  function geminiOpenAIChatURL(baseURL = "") {
    let base = String(baseURL || "https://generativelanguage.googleapis.com/v1beta")
      .trim()
      .replace(/\/+$/, "")
      .replace(/\/(?:chat\/completions|models|interactions)$/i, "")
      .replace(/\/openai$/i, "");
    if (!/\/v1(?:beta)?$/i.test(base)) base += "/v1beta";
    return `${base}/openai/chat/completions`;
  }

  function normalizeGeminiModelID(model) {
    return P.normalize_gemini_model_id
      ? P.normalize_gemini_model_id(model)
      : String(model || "").trim().replace(/^models\//i, "");
  }

  function geminiSupportsThinkingNone(model) {
    const name = String(model || "").trim().toLowerCase();
    return /^gemini-2\.5-flash(?:-|$)/.test(name)
      || /^gemini-2\.5-flash-lite(?:-|$)/.test(name);
  }

  function normalizeGeminiReasoningEffort(value) {
    const effort = String(value || "").trim().toLowerCase();
    // Gemini exposes four levels.  Map the unified high-end choices to its
    // deepest supported level instead of silently reverting to the default.
    if (["xhigh", "max"].includes(effort)) return "high";
    return ["minimal", "low", "medium", "high"].includes(effort) ? effort : "default";
  }

  function geminiPublicThinkingConfig(config) {
    const model = normalizeGeminiModelID(config.model).toLowerCase();
    const thinkingMode = normalizeThinkingMode(config.thinkingMode);
    const effort = normalizeGeminiReasoningEffort(config.reasoningEffort);
    if (model.startsWith("gemini-2.5-")) {
      const thinkingBudget = thinkingMode === "disabled" && !model.includes("2.5-pro")
        ? 0
        : ({ minimal: 1024, low: 1024, medium: 8192, high: 24576 }[effort] || 8192);
      return { thinking_budget: thinkingBudget, include_thoughts: true };
    }
    let thinkingLevel = effort === "default" ? "medium" : effort;
    if (model.includes("3.1-pro") && thinkingLevel === "minimal") thinkingLevel = "low";
    return { thinking_level: thinkingLevel, include_thoughts: true };
  }

  function isProbablyReasoningModel(model) {
    const name = String(model || "").trim().toLowerCase();
    return [
      "deepseek-reasoner", "deepseek-r1", "deepseek-v4", "gpt-5",
      "o1", "o3", "o4", "qwq", "qwen3", "thinking", "reasoner", "reasoning"
    ].some(marker => name.includes(marker));
  }

  function isProbablyImageModel(model) {
    return U.isProbablyImageModel(model);
  }

  function modelNameTokens(model) {
    return String(model || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  }

  function chooseChatModel(models, current = "") {
    const ids = Array.isArray(models) ? models : [];
    if (current && ids.includes(current)) return current;
    for (const keyword of ["mini", "flash", "lite"]) {
      const match = ids.find(model => modelNameTokens(model).includes(keyword));
      if (match) return match;
    }
    return ids[0] || current;
  }

  function chooseTranslationModel(provider, models, current = "") {
    const ids = Array.isArray(models) ? models : [];
    if (current && ids.includes(current)) return current;
    const preferred = {
      deepseek: ["deepseek-reasoner", "deepseek-chat"],
      oneapi: ["gpt-5-pro", "gpt-5", "gpt-4.1", "gpt-4o"],
      openai_compatible: ["gpt-5-pro", "gpt-5", "gpt-4.1", "gpt-4o"],
      gemini: [
        "gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-3.1-pro-preview",
        "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"
      ]
    }[String(provider || "").toLowerCase()] || [];
    for (const wanted of preferred) {
      const match = ids.find(model => model.toLowerCase() === wanted);
      if (match) return match;
    }
    if (provider === "zai") {
      const flash = ids.find(model => modelNameTokens(model).includes("flash"));
      if (flash) return flash;
    }
    for (const quality of ["ultra", "max", "pro", "reasoner"]) {
      const match = ids.find(model => modelNameTokens(model).includes(quality));
      if (match) return match;
    }
    return ids[0] || current;
  }

  function safeChatProvider(provider, profiles = {}) {
    const requested = U.providerSpec(provider).id;
    if (!U.isWebMachineProvider?.(requested)) return requested;
    const preferred = ["oneapi", "openai_compatible", "openrouter", "deepseek", "gemini", "siliconflow", "zai"];
    const available = Object.keys(profiles || {})
      .map(id => U.providerSpec(id).id)
      .filter(id => !U.isWebMachineProvider?.(id));
    return preferred.find(id => available.includes(id)) || available[0] || "oneapi";
  }

  function applyPromptCacheSession(payload, config) {
    const key = String(config?.promptCacheKey || "").trim();
    const provider = String(config?.provider || "").toLowerCase();
    if (!key) return false;
    if (provider === "openrouter") {
      // OpenRouter uses session_id as its sticky-routing key.  This pins all
      // turns in a local chat session to one provider, allowing DeepSeek's
      // automatic prompt cache to be read after the initial warm-up request.
      payload.session_id = key;
    }
    else if (U.isOpenAICompatibleGateway(provider)) {
      payload.prompt_cache_key = key;
    }
    else {
      return false;
    }
    // `stream_options` is invalid for non-streaming OpenAI-compatible
    // requests (notably DeepSeek and SiliconFlow). Session affinity still
    // applies without it; ordinary JSON responses include usage directly.
    if (payload.stream !== false) {
      payload.stream_options = { ...(payload.stream_options || {}), include_usage: true };
    }
    return true;
  }

  function openRouterCacheMode(model) {
    const id = String(model || "").trim().toLowerCase();
    if (id.startsWith("anthropic/")) return "anthropic-auto";
    if (
      id.startsWith("google/gemini-")
      || /^(?:qwen\/qwen(?:3(?:\.6)?-(?:coder-)?(?:plus|flash)|-plus)|deepseek\/deepseek-v3\.2)/.test(id)
    ) return "explicit-breakpoint";
    return "implicit";
  }

  function addOpenRouterCacheBreakpoint(messages) {
    const rows = Array.isArray(messages) ? messages : [];
    // The final message contains the new question and must remain outside the
    // reusable prefix.  Mark the most recent earlier text block instead.
    for (let index = rows.length - 2; index >= 0; index--) {
      const message = rows[index];
      if (!message || typeof message !== "object") continue;
      const content = message.content;
      if (typeof content === "string" && content.trim()) {
        message.content = [{ type: "text", text: content, cache_control: { type: "ephemeral" } }];
        return true;
      }
      if (!Array.isArray(content)) continue;
      for (let partIndex = content.length - 1; partIndex >= 0; partIndex--) {
        const part = content[partIndex];
        if (!part || !["text", "input_text"].includes(String(part.type || "")) || !String(part.text || "").trim()) continue;
        content[partIndex] = { ...part, cache_control: { type: "ephemeral" } };
        return true;
      }
    }
    return false;
  }

  function applyOpenRouterCacheStrategy(payload, config) {
    if (String(config?.provider || "").toLowerCase() !== "openrouter") return "";
    const mode = openRouterCacheMode(config.model);
    if (mode === "anthropic-auto") {
      payload.cache_control = { type: "ephemeral" };
    }
    else if (mode === "explicit-breakpoint") {
      addOpenRouterCacheBreakpoint(payload.messages);
    }
    return mode;
  }

  function zeroPrice(value) {
    const text = String(value ?? "").trim();
    return text !== "" && Number.isFinite(Number(text)) && Number(text) === 0;
  }

  // OpenRouter returns pricing in USD per token.  Its website conventionally
  // presents the same values in USD per million tokens, which is both useful
  // to readers and avoids misleading strings such as "$0.0000006".
  function formatOpenRouterPricePerMillion(value) {
    const price = Number(value);
    if (!Number.isFinite(price) || price < 0) return "";
    const perMillion = price * 1000000;
    return perMillion.toFixed(9).replace(/\.?0+$/, "");
  }

  function translationModelOptions(provider, records, current = "") {
    const providerID = String(provider || "oneapi").toLowerCase();
    const preferred = {
      deepseek: ["deepseek-reasoner", "deepseek-chat"],
      oneapi: ["gpt-5-pro", "gpt-5", "gpt-4.1", "gpt-4o"],
      openai_compatible: ["gpt-5-pro", "gpt-5", "gpt-4.1", "gpt-4o"],
      gemini: [
        "gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-3.1-pro-preview",
        "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"
      ]
    }[providerID] || [];
    const preferredRank = new Map(preferred.map((id, index) => [id, index]));
    const seen = new Set();
    const options = [];
    for (const raw of Array.isArray(records) ? records : []) {
      const item = typeof raw === "string" ? { id: raw } : (raw || {});
      const id = String(item.id || item.name || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const pricing = item.pricing && typeof item.pricing === "object" ? item.pricing : {};
      const officialName = String(item.name || "").trim()
        || (providerID === "zai" ? id.replace(/^glm/i, "GLM") : id);
      const free = (
        (pricing.prompt !== undefined && pricing.completion !== undefined
          && zeroPrice(pricing.prompt) && zeroPrice(pricing.completion))
        || id.toLowerCase().endsWith(":free")
        || officialName.toLowerCase().includes("(free)")
        || (providerID === "zai" && (id.toLowerCase().includes("flash") || officialName.includes("免费")))
      );
      let priceText = "";
      if (providerID === "openrouter") {
        priceText = free
          ? "免费"
          : (
            pricing.prompt !== undefined && pricing.completion !== undefined
              ? (() => {
                const promptPrice = formatOpenRouterPricePerMillion(pricing.prompt);
                const completionPrice = formatOpenRouterPricePerMillion(pricing.completion);
                return promptPrice && completionPrice
                  ? `输入 $${promptPrice} / 输出 $${completionPrice}（每百万 Tokens）`
                  : "价格未提供";
              })()
              : "价格未提供"
          );
      }
      options.push({
        id,
        label: priceText ? `${officialName}  -  ${priceText}` : officialName,
        officialName,
        priceText,
        free
      });
    }
    options.sort((a, b) => {
      const quality = option => {
        const tokens = modelNameTokens(option.id);
        if (providerID === "zai") return tokens.includes("flash") ? 0 : 1;
        if (providerID === "openrouter") return 0;
        return ["ultra", "max", "pro", "reasoner"].some(token => tokens.includes(token)) ? 0 : 1;
      };
      return (
        (preferredRank.get(a.id.toLowerCase()) ?? 999) - (preferredRank.get(b.id.toLowerCase()) ?? 999)
        || (a.id === current ? 0 : 1) - (b.id === current ? 0 : 1)
        || quality(a) - quality(b)
        || a.officialName.localeCompare(b.officialName)
        || a.id.localeCompare(b.id)
      );
    });
    return options;
  }

  function decodeBase64Bytes(value) {
    const binary = U.base64Decode(String(value || "").replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function decodeImageDataURL(value) {
    try {
      return U.decodeImageDataURL(value);
    }
    catch (_) {
      return null;
    }
  }

  function detectImageMimeType(bytes, fallback = "image/png") {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
    if (data.length >= 12 && String.fromCharCode(...data.subarray(0, 4)) === "RIFF" && String.fromCharCode(...data.subarray(8, 12)) === "WEBP") return "image/webp";
    if (data.length >= 6 && ["GIF87a", "GIF89a"].includes(String.fromCharCode(...data.subarray(0, 6)))) return "image/gif";
    if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) return "image/bmp";
    if (data.length >= 12 && data[0] === 0x00 && data[1] === 0x00 && data[2] === 0x00 && data[3] === 0x0c && data[4] === 0x6a && data[5] === 0x50 && data[6] === 0x20 && data[7] === 0x20) return "image/jp2";
    const prefix = new TextDecoder().decode(data.subarray(0, Math.min(data.length, 256))).replace(/^\uFEFF/, "").trimStart().toLowerCase();
    if (prefix.startsWith("<svg") || prefix.startsWith("<?xml") && prefix.includes("<svg")) return "image/svg+xml";
    return String(fallback || "image/png").toLowerCase();
  }

  function collectImageResponse(result) {
    const imageCandidates = [];
    const textParts = [];
    const seen = new Set();
    const visit = value => {
      if (value === null || value === undefined) return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value !== "object") return;
      for (const [key, item] of Object.entries(value)) {
        const normalizedKey = String(key).toLowerCase();
        if (typeof item === "string") {
          if (normalizedKey === "revised_prompt" && item.trim()) textParts.push(item.trim());
          if (["b64_json", "base64", "image_base64"].includes(normalizedKey) && item.trim()) {
            const identity = `b64:${U.hashString(item)}:${item.length}`;
            if (!seen.has(identity)) {
              seen.add(identity);
              imageCandidates.push({ kind: "base64", value: item });
            }
          }
          else if (
            ["url", "image_url", "image", "output_url"].includes(normalizedKey)
            && /^(?:https?:|data:image\/)/i.test(item.trim())
          ) {
            const identity = `url:${item}`;
            if (!seen.has(identity)) {
              seen.add(identity);
              imageCandidates.push({ kind: "url", value: item.trim() });
            }
          }
        }
        else visit(item);
      }
    };
    visit(result);
    return { imageCandidates, text: [...new Set(textParts)].join("\n") };
  }

  function normalizeReasoningEffort(provider, value, model = "", baseURL = "") {
    const text = String(value || "").trim().toLowerCase();
    if (!text || ["服务商默认", "默认", "default"].includes(text)) return "default";
    // SiliconFlow exposes DeepSeek-named models through its own protocol;
    // their effort values must retain SiliconFlow's budget semantics.
    if (String(provider || "").toLowerCase() === "siliconflow") return text;
    // `max` is the unified UI's highest tier.  OpenAI-compatible APIs name
    // that tier `xhigh`; retain `max` only for the DeepSeek protocol below.
    if (!isDeepSeekReasoningProtocol(provider, baseURL, model)) {
      return text === "max" ? "xhigh" : text;
    }
    return {
      low: "high",
      medium: "high",
      xhigh: "max",
      none: "high",
      minimal: "high"
    }[text] || text;
  }

  function shouldSendTemperature(config) {
    const thinkingMode = normalizeThinkingMode(config.thinkingMode);
    const reasoningEffort = normalizeReasoningEffort(
      config.provider,
      config.reasoningEffort,
      config.model,
      config.baseURL
    );
    return thinkingMode === "default"
      && reasoningEffort === "default"
      && !isProbablyReasoningModel(config.model);
  }

  const SILICONFLOW_THINKING_PREF = "siliconflowThinkingCapabilities";
  const SILICONFLOW_THINKING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  function siliconflowCapabilityKey(baseURL, model) {
    return `${String(baseURL || "").trim().replace(/\/+$/, "").toLowerCase()}\u241f${String(model || "").trim().toLowerCase()}`;
  }

  function siliconflowSupportsThinking(baseURL, model) {
    return siliconflowThinkingCapability(baseURL, model) === true;
  }

  function siliconflowThinkingCapability(baseURL, model) {
    if (String(model || "").trim() === "") return null;
    const stored = readObjectPref(SILICONFLOW_THINKING_PREF);
    const value = stored[siliconflowCapabilityKey(baseURL, model)];
    // Capability checks expire after seven days. Older builds stored a bare
    // boolean; do not let that value bypass the expiry policy, and request a
    // fresh check instead.
    if (!value || typeof value !== "object") return null;
    const checkedAt = Number(value.checkedAt || value.checked_at || 0);
    if (!Number.isFinite(checkedAt) || checkedAt <= 0 || Date.now() - checkedAt > SILICONFLOW_THINKING_TTL_MS) {
      delete stored[siliconflowCapabilityKey(baseURL, model)];
      U.setPref(SILICONFLOW_THINKING_PREF, JSON.stringify(stored));
      return null;
    }
    return typeof value.supported === "boolean" ? value.supported : null;
  }

  function isSiliconflowProvider(provider, baseURL = "") {
    return String(provider || "").trim().toLowerCase() === "siliconflow"
      || String(baseURL || "").toLowerCase().includes("api.siliconflow.cn");
  }

  function markSiliconflowThinkingCapability(baseURL, model, supported) {
    const stored = readObjectPref(SILICONFLOW_THINKING_PREF);
    stored[siliconflowCapabilityKey(baseURL, model)] = {
      supported: Boolean(supported),
      checkedAt: Date.now()
    };
    U.setPref(SILICONFLOW_THINKING_PREF, JSON.stringify(stored));
    return Boolean(supported);
  }

  function applyReasoningPayload(payload, config) {
    const spec = U.providerSpec(config.provider);
    if (isSiliconflowProvider(config.provider, config.baseURL)) {
      if (!siliconflowSupportsThinking(config.baseURL, config.model)) return payload;
      const mode = normalizeThinkingMode(config.thinkingMode);
      const effort = normalizeReasoningEffort(config.provider, config.reasoningEffort, config.model, config.baseURL);
      if (mode !== "default") payload.enable_thinking = mode === "enabled";
      if (mode !== "disabled") {
        const budgets = { minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384, max: 32768 };
        if (budgets[effort]) payload.thinking_budget = budgets[effort];
      }
      return payload;
    }
    if (spec.supportsReasoning === false) return payload;
    const thinkingMode = normalizeThinkingMode(config.thinkingMode);
    const reasoningEffort = normalizeReasoningEffort(
      config.provider,
      config.reasoningEffort,
      config.model,
      config.baseURL
    );
    if (isGeminiProvider(config.provider, config.baseURL)) {
      if (config.showReasoning) {
        // Gemini rejects reasoning_effort combined with custom thinking_config.
        // This native config both controls thinking and asks for the public
        // thought summary used by the UI's reasoning panel.
        payload.extra_body = { google: { thinking_config: geminiPublicThinkingConfig(config) } };
        return payload;
      }
      const geminiEffort = normalizeGeminiReasoningEffort(config.reasoningEffort);
      if (thinkingMode === "disabled") {
        payload.reasoning_effort = geminiSupportsThinkingNone(config.model) ? "none" : "minimal";
      }
      else if (geminiEffort !== "default") {
        payload.reasoning_effort = geminiEffort;
      }
      else if (thinkingMode === "enabled" || thinkingMode === "default") {
        payload.reasoning_effort = "medium";
      }
      return payload;
    }
    if (isDeepSeekReasoningProtocol(config.provider, config.baseURL, config.model)) {
      if (thinkingMode !== "default") payload.thinking = { type: thinkingMode };
      if (thinkingMode !== "disabled" && reasoningEffort !== "default") {
        payload.reasoning_effort = reasoningEffort;
      }
      return payload;
    }
    if (thinkingMode === "disabled") payload.reasoning_effort = "none";
    else if (reasoningEffort !== "default") payload.reasoning_effort = reasoningEffort;
    else if (thinkingMode === "enabled") payload.reasoning_effort = "medium";
    return payload;
  }

  function readStringArrayPref(name) {
    const raw = U.getPref(name, "[]");
    try {
      const value = Array.isArray(raw) ? raw : JSON.parse(String(raw || "[]"));
      return [...new Set(value.map(item => String(item || "").trim()).filter(Boolean))];
    }
    catch (_) {
      return [];
    }
  }

  function readObjectPref(name) {
    const raw = U.getPref(name, "{}");
    try {
      const value = typeof raw === "string" ? JSON.parse(raw || "{}") : raw;
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    }
    catch (_) {
      return {};
    }
  }

  function reasoningPreferenceKey(provider, model) {
    return `${String(provider || "").trim().toLowerCase()} | ${String(model || "").trim().toLowerCase()}`;
  }

  function readReasoningPreferences(scope) {
    return readObjectPref(`${scope === "chat" ? "chat" : "translation"}ReasoningPreferences`);
  }

  function sanitizeContentForAPI(content) {
    if (typeof content === "string") return U.redactLocalPaths(content);
    if (Array.isArray(content)) {
      const output = [];
      for (const part of content) {
        if (typeof part === "string") {
          output.push(U.redactLocalPaths(part));
          continue;
        }
        if (!part || typeof part !== "object") continue;
        const type = String(part.type || "");
        if (type === "text" || type === "input_text") {
          output.push({ type, text: U.redactLocalPaths(String(part.text || "")) });
        }
        else if (type === "image_url") {
          const imageURL = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
          if (imageURL) output.push({ type: "image_url", image_url: { url: String(imageURL) } });
        }
      }
      return output;
    }
    if (!content || typeof content !== "object") return content;
    const output = {};
    for (const [key, value] of Object.entries(content)) {
      output[key] = ["text", "content", "caption", "alt"].includes(String(key).toLowerCase())
        ? sanitizeContentForAPI(value)
        : value;
    }
    return output;
  }

  class AsyncConcurrencyLimiter {
    constructor(limit) {
      this.limit = Math.max(1, Math.trunc(Number(limit) || 1));
      this.active = 0;
      this.waiters = [];
    }

    remove(waiter) {
      const index = this.waiters.indexOf(waiter);
      if (index >= 0) this.waiters.splice(index, 1);
    }

    pump() {
      while (this.active < this.limit && this.waiters.length) {
        const waiter = this.waiters.shift();
        if (waiter.cancelled) continue;
        if (waiter.signal?.aborted) {
          waiter.onAbort();
          continue;
        }
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
        this.active++;
        waiter.resolve(() => this.release());
      }
    }

    release() {
      if (this.active > 0) this.active--;
      this.pump();
    }

    acquire(signal = null) {
      U.throwIfAborted(signal);
      if (this.active < this.limit) {
        this.active++;
        return Promise.resolve(() => this.release());
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve,
          reject,
          signal,
          cancelled: false,
          onAbort: null
        };
        waiter.onAbort = () => {
          if (waiter.cancelled) return;
          waiter.cancelled = true;
          this.remove(waiter);
          reject(new U.CancelledError(typeof signal?.reason === "string" ? signal.reason : "操作已停止"));
        };
        signal?.addEventListener("abort", waiter.onAbort, { once: true });
        this.waiters.push(waiter);
        this.pump();
      });
    }

    async run(operation, signal = null) {
      const release = await this.acquire(signal);
      try {
        return await operation();
      }
      finally {
        release();
      }
    }
  }

  class LLMService {
    constructor(secrets) {
      this.secrets = secrets;
      // DeepSeek's provider limit is shared by all workbench tabs that use
      // this singleton service, so per-document worker pools cannot exceed it.
      this.deepSeekLimiter = new AsyncConcurrencyLimiter(DEEPSEEK_CONCURRENCY_LIMIT);
      this.geminiCooldownUntil = 0;
      this.rateLimitNow = () => Date.now();
      this.rateLimitSleep = (milliseconds, signal) => U.sleep(milliseconds, signal);
      this.manualTransport = null;
      this.webProvider = null;
    }

    setWebProvider(provider) {
      this.webProvider = provider;
    }

    beginManualTransport(response = "") {
      this.manualTransport = { response: String(response || ""), request: null };
    }

    takeManualTransportRequest() {
      const request = this.manualTransport?.request || null;
      if (this.manualTransport) this.manualTransport.request = null;
      return request;
    }

    endManualTransport() {
      this.manualTransport = null;
    }

    async waitForGeminiCooldown(options = {}, reason = "Gemini请求额度暂时受限") {
      while (true) {
        U.throwIfAborted(options.signal);
        const waitMs = Math.max(0, this.geminiCooldownUntil - this.rateLimitNow());
        if (!waitMs) return;
        options.onRateLimitWait?.({ provider: "gemini", waitMs, reason });
        await this.rateLimitSleep(waitMs, options.signal || null);
      }
    }

    registerGeminiCooldown(error, attempt) {
      const serverDelay = Math.max(0, Number(error?.retryAfterMs || 0));
      const fallbackDelay = Math.min(15000 * Math.pow(2, Math.max(0, attempt - 1)), 60000);
      const waitMs = serverDelay || fallbackDelay;
      this.geminiCooldownUntil = Math.max(
        this.geminiCooldownUntil,
        this.rateLimitNow() + waitMs
      );
      return waitMs;
    }

    getSettings(purpose = "translation", options = {}) {
      const scope = purpose === "chat" ? "chat" : "translation";
      const chatUsesTranslationModel = Boolean(U.getPref("chatUsesTranslationModel", true));
      const translation = scope === "chat" ? this.getSettings("translation") : null;
      if (
        scope === "chat"
        && chatUsesTranslationModel
        && !U.isWebMachineProvider?.(translation?.provider)
        && !options.ignoreChatSharing
      ) {
        return { ...translation, purpose: "chat", chatUsesTranslationModel: true };
      }
      const legacyProvider = String(U.getPref("provider", "deepseek") || "deepseek").toLowerCase();
      const requestedProvider = String(U.getPref(`${scope}Provider`, legacyProvider) || legacyProvider).toLowerCase();
      const provider = scope === "chat"
        ? safeChatProvider(requestedProvider, readObjectPref(`${scope}ProviderProfiles`))
        : U.providerSpec(requestedProvider).id;
      const spec = U.providerSpec(provider);
      const legacyBaseURL = U.getPref("baseURL", spec.defaultBaseURL);
      const legacyModel = U.getPref("model", "");
      const providerProfiles = readObjectPref(`${scope}ProviderProfiles`);
      const profile = providerProfiles[provider] || providerProfiles[requestedProvider] || {};
      const storedModel = U.getPref(
        `${scope}Model`,
        profile.model ?? legacyModel
      );
      const model = String(storedModel ?? "");
      const reasoningPreferences = readReasoningPreferences(scope);
      const reasoningPreference = reasoningPreferences[reasoningPreferenceKey(provider, model)] || {};
      return {
        purpose: scope,
        chatUsesTranslationModel: scope === "chat"
          && U.isWebMachineProvider?.(translation?.provider)
          ? false
          : chatUsesTranslationModel,
        provider,
        providerName: spec.name,
        baseURL: U.normalizeBaseURL(U.getPref(`${scope}BaseURL`, profile.baseURL || legacyBaseURL), provider),
        model,
        providerProfiles,
        reasoningPreferences,
        thinkingMode: String(reasoningPreference.thinkingMode ?? profile.thinkingMode ?? (U.getPref(`${scope}ThinkingMode`, "default") || "default")),
        reasoningEffort: String(reasoningPreference.reasoningEffort ?? profile.reasoningEffort ?? (U.getPref(`${scope}ReasoningEffort`, "default") || "default")),
        chatRenderMarkdown: true,
        chatImageSize: String(U.getPref("chatImageSize", "auto") || "auto"),
        chatImageQuality: String(U.getPref("chatImageQuality", "auto") || "auto"),
        chatImageFormat: String(U.getPref("chatImageFormat", "png") || "png"),
        webPageImageQuality: ["none", "low", "medium", "high"].includes(String(U.getPref("webPageImageQuality", "medium")))
          ? String(U.getPref("webPageImageQuality", "medium"))
          : "medium",
        webInputMode: U.getPref("webInputMode", "auto") === "clipboard" ? "clipboard" : "auto",
        deleteWebTranslationSessions: Boolean(U.getPref("deleteWebTranslationSessions", true)),
        targetLanguage: U.normalizeLanguageName(U.getPref("targetLanguage", "简体中文"), "简体中文"),
        sourceLanguage: INTERNAL_TRANSLATION_DEFAULTS.sourceLanguage,
        machineSourceLanguage: U.normalizeLanguageName(U.getPref("machineSourceLanguage", "英文"), "英文"),
        translationMode: String(U.getPref("translationMode", "full_context") || "full_context"),
        deepseekFastLayoutTranslation: Boolean(U.getPref("deepseekFastLayoutTranslation", true)),
        translationReferencePaths: readStringArrayPref("translationReferencePaths"),
        customTranslationInstruction: String(U.getPref("customTranslationInstruction", "") || "").trim(),
        showReasoning: true,
        chatContextChars: 0,
        chunkChars: INTERNAL_TRANSLATION_DEFAULTS.chunkChars,
        layoutChunkChars: INTERNAL_TRANSLATION_DEFAULTS.layoutChunkChars,
        layoutChunkBlocks: INTERNAL_TRANSLATION_DEFAULTS.layoutChunkBlocks,
        mineruModel: "vlm",
        mineruOCR: Boolean(U.getPref("mineruOCR", false)),
        mineruTable: Boolean(U.getPref("mineruTable", true)),
        mineruFormula: Boolean(U.getPref("mineruFormula", true)),
        syncScroll: true,
        streamSyncScroll: true,
        layoutReadingMode: Boolean(U.getPref("layoutReadingMode", true)),
        showLayoutRestoration: Boolean(U.getPref("showLayoutRestoration", true)),
        // Inspection overlays are opt-in and must never change the layout
        // solver's rules or its persisted fit result.
        layoutDevelopmentMode: Boolean(U.getPref("layoutDevelopmentMode", false)),
        readerFontPt: 12,
        requestAudit: false,
        keyPointsPrompt: String(U.getPref("keyPointsPrompt", "") || ""),
        hasAPIKey: this.secrets.has(this.secrets.llmKeyName(provider)),
        hasMinerUToken: this.secrets.has("mineru")
      };
    }

    // The UI needs to display the chat profile that the user last saved even
    // while runtime requests are temporarily following the translation profile.
    getStoredSettings(purpose = "translation") {
      return this.getSettings(purpose, { ignoreChatSharing: true });
    }

    saveSettings(values = {}, purpose = null) {
      const scope = purpose === "chat" || values.purpose === "chat" ? "chat" : "translation";
      // Low-level callers that save only a chat profile still explicitly opt
      // into independent mode. Both settings UIs always pass the checkbox
      // state, so ordinary UI saves do not change it implicitly.
      if (scope === "chat" && !Object.prototype.hasOwnProperty.call(values, "chatUsesTranslationModel")) {
        U.setPref("chatUsesTranslationModel", false);
      }
      const current = this.getStoredSettings(scope);
      const requestedProvider = String(values.provider ?? current.provider).toLowerCase();
      const provider = scope === "chat"
        ? safeChatProvider(requestedProvider, current.providerProfiles)
        : U.providerSpec(requestedProvider).id;
      const spec = U.providerSpec(provider);
      const requestedModel = String((values.model ?? current.model ?? spec.defaultModel) || "");
      const existingReasoningPreference = readReasoningPreferences(scope)[reasoningPreferenceKey(provider, requestedModel)] || {};
      const mappings = {
        [`${scope}Provider`]: provider,
        [`${scope}BaseURL`]: U.normalizeBaseURL(values.baseURL ?? current.baseURL ?? spec.defaultBaseURL, provider),
        [`${scope}Model`]: String((values.model ?? current.model ?? spec.defaultModel) || ""),
        [`${scope}ThinkingMode`]: normalizeThinkingMode(values.thinkingMode ?? existingReasoningPreference.thinkingMode ?? current.thinkingMode),
        [`${scope}ReasoningEffort`]: normalizeReasoningEffort(
          provider,
          values.reasoningEffort ?? existingReasoningPreference.reasoningEffort ?? current.reasoningEffort,
          values.model ?? current.model,
          values.baseURL ?? current.baseURL
        ),
        chatRenderMarkdown: true,
        chatImageSize: String(values.chatImageSize ?? current.chatImageSize ?? "auto"),
        chatImageQuality: String(values.chatImageQuality ?? current.chatImageQuality ?? "auto"),
        chatImageFormat: ["png", "jpeg", "webp"].includes(String(values.chatImageFormat ?? current.chatImageFormat))
          ? String(values.chatImageFormat ?? current.chatImageFormat)
          : "png",
        webPageImageQuality: ["none", "low", "medium", "high"].includes(String(values.webPageImageQuality ?? current.webPageImageQuality))
          ? String(values.webPageImageQuality ?? current.webPageImageQuality)
          : "medium",
        webInputMode: (values.webInputMode ?? current.webInputMode) === "clipboard" ? "clipboard" : "auto",
        deleteWebTranslationSessions: Boolean(values.deleteWebTranslationSessions ?? current.deleteWebTranslationSessions),
        targetLanguage: U.normalizeLanguageName(values.targetLanguage ?? current.targetLanguage, "简体中文"),
        sourceLanguage: INTERNAL_TRANSLATION_DEFAULTS.sourceLanguage,
        machineSourceLanguage: U.normalizeLanguageName(values.machineSourceLanguage ?? current.machineSourceLanguage, "英文"),
        translationMode: String(values.translationMode ?? current.translationMode),
        deepseekFastLayoutTranslation: Boolean(
          values.deepseekFastLayoutTranslation ?? current.deepseekFastLayoutTranslation
        ),
        customTranslationInstruction: String(values.customTranslationInstruction ?? current.customTranslationInstruction ?? "").trim(),
        showReasoning: true,
        chatContextChars: 0,
        chunkChars: INTERNAL_TRANSLATION_DEFAULTS.chunkChars,
        layoutChunkChars: INTERNAL_TRANSLATION_DEFAULTS.layoutChunkChars,
        layoutChunkBlocks: INTERNAL_TRANSLATION_DEFAULTS.layoutChunkBlocks,
        mineruModel: "vlm",
        mineruOCR: Boolean(values.mineruOCR ?? current.mineruOCR),
        mineruTable: Boolean(values.mineruTable ?? current.mineruTable),
        mineruFormula: Boolean(values.mineruFormula ?? current.mineruFormula),
        syncScroll: true,
        streamSyncScroll: true,
        layoutReadingMode: Boolean(values.layoutReadingMode ?? current.layoutReadingMode),
        showLayoutRestoration: Boolean(values.showLayoutRestoration ?? current.showLayoutRestoration),
        layoutDevelopmentMode: Boolean(values.layoutDevelopmentMode ?? current.layoutDevelopmentMode),
        readerFontPt: 12,
        requestAudit: false,
        // A long user preference is semantic task input. Preserve it exactly;
        // only the runtime presentation layer may trim harmless outer space.
        keyPointsPrompt: String(values.keyPointsPrompt ?? current.keyPointsPrompt ?? "")
      };
      for (const [key, value] of Object.entries(mappings)) {
        if (U.getPref(key) !== value) U.setPref(key, value);
      }
      const suppliedProfiles = values.providerProfiles
        || values[`${scope}ProviderProfiles`]
        || {};
      const providerProfiles = {
        ...readObjectPref(`${scope}ProviderProfiles`),
        ...(suppliedProfiles && typeof suppliedProfiles === "object" ? suppliedProfiles : {})
      };
      providerProfiles[provider] = {
        baseURL: mappings[`${scope}BaseURL`],
        model: mappings[`${scope}Model`],
        thinkingMode: mappings[`${scope}ThinkingMode`],
        reasoningEffort: mappings[`${scope}ReasoningEffort`]
      };
      const serializedProfiles = JSON.stringify(providerProfiles);
      if (U.getPref(`${scope}ProviderProfiles`, "") !== serializedProfiles) {
        U.setPref(`${scope}ProviderProfiles`, serializedProfiles);
      }
      // A provider profile tracks its most recent model only. Preserve
      // reasoning controls separately for each model.
      const reasoningPreferences = {
        ...readReasoningPreferences(scope),
        ...(values.reasoningPreferences && typeof values.reasoningPreferences === "object" ? values.reasoningPreferences : {})
      };
      const reasoningKey = reasoningPreferenceKey(provider, mappings[`${scope}Model`]);
      if (reasoningKey !== " | ") {
        reasoningPreferences[reasoningKey] = {
          thinkingMode: mappings[`${scope}ThinkingMode`],
          reasoningEffort: mappings[`${scope}ReasoningEffort`],
          showReasoning: Boolean(
            Object.prototype.hasOwnProperty.call(values, "showReasoning")
              ? values.showReasoning
              : (reasoningPreferences[reasoningKey]?.showReasoning ?? current.showReasoning)
          )
        };
      }
      const serializedReasoning = JSON.stringify(reasoningPreferences);
      if (U.getPref(`${scope}ReasoningPreferences`, "") !== serializedReasoning) {
        U.setPref(`${scope}ReasoningPreferences`, serializedReasoning);
      }
      if (Array.isArray(values.translationReferencePaths)) {
        const serializedRefs = JSON.stringify([...new Set(values.translationReferencePaths.map(item => String(item || "").trim()).filter(Boolean))]);
        if (U.getPref("translationReferencePaths", "") !== serializedRefs) {
          U.setPref("translationReferencePaths", serializedRefs);
        }
      }
      // Keep the original three preferences synchronized with translation
      // settings so upgrades and older builds can still read the active
      // translation endpoint without losing user configuration.
      if (scope === "translation") {
        if (U.getPref("provider") !== mappings.translationProvider) U.setPref("provider", mappings.translationProvider);
        if (U.getPref("baseURL") !== mappings.translationBaseURL) U.setPref("baseURL", mappings.translationBaseURL);
        if (U.getPref("model") !== mappings.translationModel) U.setPref("model", mappings.translationModel);
        if (U.getPref("deepseekFastLayoutTranslation", false) !== mappings.deepseekFastLayoutTranslation) {
          U.setPref("deepseekFastLayoutTranslation", mappings.deepseekFastLayoutTranslation);
        }
      }
      if (typeof values.apiKey === "string" && values.apiKey.trim()) this.secrets.setLLMKey(provider, values.apiKey.trim());
      if (values.clearAPIKey) this.secrets.removeLLMKey(provider);
      if (typeof values.mineruToken === "string" && values.mineruToken.trim()) this.secrets.setMinerUToken(values.mineruToken);
      if (values.clearMinerUToken) this.secrets.removeMinerUToken();
      return this.getSettings(scope);
    }

    isWebEngineActive(options = {}) {
      if (
        options.engine === "deepseek_web"
        || options.provider === "deepseek_web"
        || options.aiMode === "web"
        || options.sessionID === "web-document-chat"
        || options.sessionId === "web-document-chat"
        || options.session?.id === "web-document-chat"
      ) {
        return true;
      }
      const isExplicitAPI = options.engine === "api" || options.aiMode === "api";
      const chatEngine = U.getPref("chatEngine", "api");
      const translationProvider = U.getPref("translationProvider", "");
      if (options.purpose === "chat") {
        if (isExplicitAPI) return false;
        return chatEngine === "deepseek_web";
      }
      if (isExplicitAPI) return false;
      if (translationProvider === "deepseek_web") return true;
      if (chatEngine === "deepseek_web") return true;
      return false;
    }

    resolveConfig(overrides = {}) {
      const purpose = overrides.purpose === "chat" ? "chat" : "translation";
      if (this.isWebEngineActive(overrides)) {
        return {
          purpose,
          provider: "deepseek_web",
          baseURL: "",
          model: "deepseek-web",
          apiKey: "",
          promptCacheKey: String(overrides.promptCacheKey || "").trim(),
          thinkingMode: "default",
          reasoningEffort: "default",
          showReasoning: true
        };
      }
      const settings = this.getSettings(purpose);
      const spec = U.providerSpec(String(overrides.provider || settings.provider).toLowerCase());
      const provider = spec.id;
      if (purpose === "chat" && U.isWebMachineProvider?.(provider)) {
        throw new Error("联网翻译仅用于文献翻译；Edge本地翻译同样不能用于对话。请配置对话模型服务。");
      }
      const config = {
        purpose,
        provider,
        baseURL: U.normalizeBaseURL(overrides.baseURL || settings.baseURL || spec.defaultBaseURL, provider),
        model: String(
          overrides.model !== undefined
            ? overrides.model
            : (settings.model || "")
        ).trim(),
        apiKey: String(overrides.apiKey || this.secrets.getLLMKey(provider) || "").trim(),
        promptCacheKey: String(overrides.promptCacheKey || "").trim(),
        thinkingMode: normalizeThinkingMode(overrides.thinkingMode ?? settings.thinkingMode),
        reasoningEffort: normalizeReasoningEffort(
          provider,
          overrides.reasoningEffort ?? settings.reasoningEffort,
          overrides.model || settings.model,
          overrides.baseURL || settings.baseURL
        ),
        showReasoning: Boolean(overrides.showReasoning ?? settings.showReasoning)
      };
      if (!config.baseURL) throw new Error("尚未配置模型服务API地址");
      if (!config.apiKey) throw new Error(`尚未配置${spec.name}API密钥`);
      return config;
    }

    requestHeaders(config, stream = true) {
      const headers = {};
      if (String(config.provider || "").toLowerCase() === "openrouter" && config.promptCacheKey) {
        headers["x-session-id"] = config.promptCacheKey;
      }
      else if (U.isOpenAICompatibleGateway(config.provider) && config.promptCacheKey) {
        headers["session-id"] = config.promptCacheKey;
        headers["thread-id"] = config.promptCacheKey;
        headers["x-client-request-id"] = config.promptCacheKey;
      }
      if (isGeminiProvider(config.provider, config.baseURL)) {
        if (config.apiKey) headers["x-goog-api-key"] = config.apiKey;
      }
      return headers;
    }

    async listModels(overrides = {}, signal = null) {
      const settings = this.getSettings(overrides.purpose === "chat" ? "chat" : "translation");
      const spec = U.providerSpec(String(overrides.provider || settings.provider).toLowerCase());
      const provider = spec.id;
      const baseURL = U.normalizeBaseURL(overrides.baseURL || settings.baseURL, provider);
      const apiKey = String(overrides.apiKey || this.secrets.getLLMKey(provider) || "").trim();
      if (!baseURL) throw new Error("尚未配置API地址");
      if (!apiKey) throw new Error("尚未配置API密钥");
      const gemini = isGeminiProvider(provider, baseURL);
      const result = await H.requestJSON("GET", gemini && P.geminiModelsURL
        ? P.geminiModelsURL(baseURL)
        : U.endpointURL(baseURL, "models", provider), {
        token: gemini ? "" : apiKey,
        headers: this.requestHeaders({ provider, baseURL, apiKey }, false),
        timeout: overrides.purpose === "chat" ? 30000 : 60000,
        signal
      });
      let source = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : Array.isArray(result?.models) ? result.models : [];
      if (gemini && P.filterTextModels) source = P.filterTextModels(source, "gemini");
      else if (gemini) {
        source = source
          .map(item => typeof item === "string" ? normalizeGeminiModelID(item) : { ...item, id: normalizeGeminiModelID(item?.id || item?.name) })
          .filter(item => !/(?:embed|embedding|imagen|veo|lyria|tts|speech|audio|live)/i.test(typeof item === "string" ? item : item.id));
      }
      if (overrides.details && overrides.purpose !== "chat") {
        return translationModelOptions(provider, source, String(overrides.currentModel || ""));
      }
      const models = [];
      for (const item of source) {
        const id = typeof item === "string" ? item : item?.id || item?.name;
        if (id) models.push(String(id));
      }
      return [...new Set(models)].sort((a, b) => a.localeCompare(b));
    }

    async probeSiliconflowThinking(overrides = {}, signal = null) {
      if (this.isWebEngineActive(overrides)) return { supported: null, cached: false };
      const settings = this.getSettings(overrides.purpose === "chat" ? "chat" : "translation");
      const provider = String(overrides.provider || settings.provider || "").toLowerCase();
      const baseURL = U.normalizeBaseURL(overrides.baseURL || settings.baseURL, provider);
      const model = String(overrides.model ?? settings.model ?? "").trim();
      if (!isSiliconflowProvider(provider, baseURL) || !model) return { supported: null, cached: false };
      const cachedCapability = siliconflowThinkingCapability(baseURL, model);
      if (cachedCapability !== null) return { supported: cachedCapability, cached: true };
      const apiKey = String(overrides.apiKey || this.secrets.getLLMKey(provider) || "").trim();
      if (!apiKey) return { supported: null, cached: false };
      try {
        await H.requestJSON("POST", U.endpointURL(baseURL, "chat/completions", provider), {
          token: apiKey,
          json: {
            model,
            messages: [{ role: "user", content: "ping" }],
            stream: false,
            max_tokens: 1,
            enable_thinking: true,
            thinking_budget: 1024
          },
          timeout: 30000,
          signal
        });
        markSiliconflowThinkingCapability(baseURL, model, true);
        return { supported: true, cached: false };
      }
      catch (error) {
        if (error?.cancelled || signal?.aborted) throw error;
        markSiliconflowThinkingCapability(baseURL, model, false);
        return { supported: false, cached: false, error: String(error?.message || error || "检查失败") };
      }
    }

    async ensureConfiguredModel(config, signal = null) {
      if (this.isWebEngineActive(config)) {
        return { ...config, provider: "deepseek_web", model: "deepseek-web" };
      }
      if (config.model) return config;
      const label = config.purpose === "chat" ? "对话" : "翻译";
      throw new Error(`尚未选择${label}模型；请先刷新模型列表并明确选择模型。`);
    }

    async completeGeminiNative(messages, options, config) {
      if (!P.normalizeLLMConfig || !P.buildGeminiInteractionRequest || !P.geminiInteractionsURL) {
        throw new Error("Gemini服务暂时不可用，请重启LitMTrans后重试");
      }
      const nativeConfig = P.normalizeLLMConfig({
        ...config,
        provider: "gemini",
        protocol: "gemini-interactions"
      });
      const payload = P.buildGeminiInteractionRequest(
        nativeConfig,
        (messages || []).map(message => ({
          role: String(message.role || "user"),
          content: sanitizeContentForAPI(message.content)
        })),
        {
          stream: options.stream !== false,
          temperature: options.temperature !== undefined
            ? options.temperature
            : (shouldSendTemperature(config) ? (options.purpose === "chat" ? 0.7 : 0.2) : null),
          maxTokens: Number(options.maxTokens) || 0,
          responseFormat: options.responseFormat || ""
        }
      );
      const timeout = requestTimeout(options);
      if (payload.stream) {
        return H.streamGeminiInteractions(P.geminiInteractionsURL(config.baseURL, true), payload, {
          apiKey: config.apiKey,
          headers: this.requestHeaders(config, true),
          timeout,
          signal: options.signal || null,
          firstEventTimeout: Number(options.firstEventTimeout || 0),
          inactivityTimeout: Number(options.inactivityTimeout || 0),
          onText: options.onText,
          onReasoning: options.onReasoning,
          onUsage: options.onUsage
        });
      }
      const result = await H.requestJSON("POST", P.geminiInteractionsURL(config.baseURL, false), {
        token: "",
        headers: this.requestHeaders(config, false),
        json: payload,
        timeout,
        signal: options.signal || null
      });
      const text = P.extractGeminiInteractionText?.(result) || "";
      const reasoning = P.extractGeminiThoughtSummary?.(result) || "";
      const usage = result?.usage ? H.geminiUsageToOpenAI(result.usage) : null;
      if (!text.trim()) throw new Error("Gemini接口没有返回正文");
      options.onText?.(text);
      if (reasoning) options.onReasoning?.(reasoning);
      if (usage) options.onUsage?.(usage);
      return { text: text.trim(), reasoning, usage, model: String(result?.model || "").trim() };
    }

    async completeOnce(messages, options = {}) {
      if (
        this.isWebEngineActive(options)
        || options.engine === "deepseek_web"
        || options.aiMode === "web"
        || options.provider === "deepseek_web"
        || options.sessionID === "web-document-chat"
        || options.sessionId === "web-document-chat"
        || options.session?.id === "web-document-chat"
      ) {
        throw new Error("检测到网页模式请求试图调用API链路，已强制拦截以防产生API费用");
      }
      const config = await this.ensureConfiguredModel(this.resolveConfig(options), options.signal);
      const geminiCompatibility = isGeminiProvider(config.provider, config.baseURL);
      const payload = {
        model: config.model,
        messages: (messages || []).map(message => ({
          role: String(message.role || "user"),
          content: sanitizeContentForAPI(message.content)
        })),
        stream: options.stream !== false
      };
      if (options.temperature !== null && options.temperature !== undefined) {
        if (shouldSendTemperature(config)) payload.temperature = Number(options.temperature);
      }
      else if (shouldSendTemperature(config)) {
        payload.temperature = options.purpose === "chat" ? 0.7 : 0.2;
      }
      applyReasoningPayload(payload, config);
      if (Number(options.maxTokens) > 0) payload.max_tokens = Number(options.maxTokens);
      if (applyPromptCacheSession(payload, config)) {
        // The cache-session helper also enables stream usage reporting.
      }
      else if (config.provider === "gemini" && payload.stream) {
        payload.stream_options = { include_usage: true };
      }
      else if (
        payload.stream && isDeepSeekReasoningProtocol(config.provider, config.baseURL, config.model)
      ) {
        payload.stream_options = { include_usage: true };
      }
      applyOpenRouterCacheStrategy(payload, config);
      if (options.responseFormat === "json_object" && config.provider !== "gemini") {
        payload.response_format = { type: "json_object" };
      }
      const endpoint = geminiCompatibility
        ? geminiOpenAIChatURL(config.baseURL)
        : U.endpointURL(config.baseURL, "chat/completions", config.provider);
      const extraHeaders = geminiCompatibility
        ? {}
        : this.requestHeaders(config, payload.stream);
      const request = async () => {
        if (payload.stream) {
          return H.streamOpenAI(endpoint, payload, {
            token: config.apiKey,
            headers: extraHeaders,
            timeout: requestTimeout(options),
            signal: options.signal || null,
            firstEventTimeout: Number(options.firstEventTimeout || 0),
            inactivityTimeout: Number(options.inactivityTimeout || 0),
            onText: options.onText,
            onReasoning: options.onReasoning,
            onUsage: options.onUsage
          });
        }
        const result = await H.requestJSON("POST", endpoint, {
          token: config.apiKey,
          headers: extraHeaders,
          json: payload,
          timeout: requestTimeout(options),
          signal: options.signal || null
        });
        const extracted = H.extractStreamParts(result);
        const text = H.extractOpenAIText(result) || extracted.text;
        if (!text) throw new Error("模型接口没有返回正文");
        options.onText?.(text);
        if (extracted.reasoning) options.onReasoning?.(extracted.reasoning);
        if (result?.usage) options.onUsage?.(result.usage);
        return {
          text,
          reasoning: extracted.reasoning,
          usage: result?.usage || null,
          model: String(result?.model || result?.response?.model || "").trim()
        };
      };
      return isDeepSeekProvider(config.provider, config.baseURL)
        ? this.deepSeekLimiter.run(request, options.signal || null)
        : request();
    }

    async complete(messages, options = {}) {
      if (this.manualTransport) {
        const transport = this.manualTransport;
        if (transport.response) {
          const text = transport.response;
          transport.response = "";
          options.onText?.(text);
          return { text, reasoning: "", usage: null, model: "manual" };
        }
        transport.request = {
          messages: Array.isArray(messages) ? messages.map(message => ({ role: message.role, content: message.content })) : [],
          responseFormat: options.responseFormat || "text"
        };
        const error = new Error("MANUAL_TRANSPORT_PAUSE");
        error.manualTransportPause = true;
        throw error;
      }
      const isWebEngine = this.isWebEngineActive(options);
      if (isWebEngine) {
        if (!this.webProvider) {
          throw new Error("DeepSeek网页服务尚未就绪或未初始化，已阻止请求以防产生API费用");
        }
        return this.webProvider.complete(messages, options);
      }
      const preliminary = this.resolveConfig(options);
      const gemini = isGeminiProvider(preliminary.provider, preliminary.baseURL);
      if (!gemini) return this.completeOnce(messages, options);
      const attempts = Math.max(1, Math.min(6, Number(options.rateLimitAttempts || 4)));
      for (let attempt = 1; attempt <= attempts; attempt++) {
        await this.waitForGeminiCooldown(options);
        try {
          return await this.completeOnce(messages, options);
        }
        catch (error) {
          const quotaLimited = (
            Number(error?.status || 0) === 429
            || /(?:resource[_ -]?exhausted|quota|rate.?limit)/i.test(String(error?.message || ""))
          );
          if (!quotaLimited || attempt >= attempts || error?.cancelled || options.signal?.aborted) throw error;
          this.registerGeminiCooldown(error, attempt);
        }
      }
      throw new Error("Gemini请求额度等待后仍未成功");
    }

    async generateImage(prompt, options = {}) {
      if (
        this.isWebEngineActive(options)
        || options.engine === "deepseek_web"
        || options.aiMode === "web"
        || options.provider === "deepseek_web"
        || options.sessionID === "web-document-chat"
        || options.sessionId === "web-document-chat"
        || options.session?.id === "web-document-chat"
      ) {
        throw new Error("网页模式不支持调用图片生成API，已阻止请求以防产生API费用");
      }
      const config = await this.ensureConfiguredModel(
        this.resolveConfig({ ...options, purpose: "chat" }),
        options.signal
      );
      const spec = U.providerSpec(config.provider);
      if (spec.supportsImages === false || !isProbablyImageModel(config.model)) {
        throw new Error("当前服务商或模型未识别为图片生成模型");
      }
      const size = String(options.imageSize || this.getSettings("chat").chatImageSize || "auto");
      const quality = String(options.imageQuality || this.getSettings("chat").chatImageQuality || "auto");
      const outputFormat = ["png", "jpeg", "webp"].includes(String(options.imageFormat || "").toLowerCase())
        ? String(options.imageFormat).toLowerCase()
        : String(this.getSettings("chat").chatImageFormat || "png");
      const fields = {
        model: config.model,
        prompt: String(prompt || "").trim(),
        size,
        quality,
        output_format: outputFormat
      };
      const editImages = (Array.isArray(options.images) ? options.images : [])
        .filter(item => item?.bytes?.length);
      let result;
      if (editImages.length) {
        const endpoint = U.endpointURL(config.baseURL, "images/edits", config.provider);
        const postMultipart = async fieldName => {
          const form = new FormData();
          for (const [key, value] of Object.entries(fields)) form.append(key, value);
          for (let index = 0; index < editImages.length; index++) {
            const item = editImages[index];
            form.append(
              fieldName,
              new Blob([item.bytes], { type: item.mimeType || "image/png" }),
              String(item.name || `reference-${index + 1}.png`)
            );
          }
          const response = await H.request("POST", endpoint, {
            token: config.apiKey,
            headers: this.requestHeaders(config, false),
            body: form,
            timeout: Number(options.timeout || 300000),
            signal: options.signal || null
          });
          const text = await response.text();
          try { return text ? JSON.parse(text) : {}; }
          catch (_) { throw new H.HTTPError(`图片接口返回不是JSON: ${text.slice(0, 800)}`, response.status, text); }
        };
        try {
          result = await postMultipart(editImages.length > 1 ? "image[]" : "image");
        }
        catch (error) {
          if (editImages.length <= 1) throw error;
          result = await postMultipart("image");
        }
      }
      else {
        result = await H.requestJSON(
          "POST",
          U.endpointURL(config.baseURL, "images/generations", config.provider),
          {
            token: config.apiKey,
            headers: this.requestHeaders(config, false),
            json: fields,
            timeout: Number(options.timeout || 300000),
            signal: options.signal || null
          }
        );
      }

      const extracted = collectImageResponse(result);
      const images = [];
      for (let index = 0; index < extracted.imageCandidates.length; index++) {
        const candidate = extracted.imageCandidates[index];
        let bytes;
        let mimeType = `image/${outputFormat === "jpeg" ? "jpeg" : outputFormat}`;
        if (candidate.kind === "base64") {
          bytes = decodeBase64Bytes(candidate.value);
        }
        else if (String(candidate.value).startsWith("data:")) {
          const decoded = decodeImageDataURL(candidate.value);
          if (!decoded) continue;
          bytes = decoded.bytes;
          mimeType = decoded.mimeType;
        }
        else {
          bytes = await H.requestBytes(candidate.value, {
            timeout: Number(options.timeout || 300000),
            signal: options.signal || null
          });
        }
        if (!bytes?.length) continue;
        mimeType = detectImageMimeType(bytes, mimeType);
        const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1] || outputFormat;
        images.push({
          bytes,
          mimeType,
          name: `generated-image-${images.length + 1}.${extension}`
        });
      }
      if (!images.length && !extracted.text) throw new Error("图片模型有返回，但没有解析到图片或文本");
      return { text: extracted.text, images };
    }
  }

  LitMTrans.LLMService = LLMService;
  LitMTrans.LLMInternals = {
    requestTimeout,
    normalizeThinkingMode,
    providerConcurrencyLimit,
    DEEPSEEK_CONCURRENCY_LIMIT,
    isProbablyImageModel,
    decodeImageDataURL,
    detectImageMimeType,
    collectImageResponse,
    isDeepSeekReasoningProtocol,
    isOfficialDeepSeekProvider,
    isProbablyReasoningModel,
    normalizeReasoningEffort,
    isGeminiProvider,
    geminiOpenAIChatURL,
    normalizeGeminiModelID,
    geminiSupportsThinkingNone,
    normalizeGeminiReasoningEffort,
    geminiPublicThinkingConfig,
    chooseChatModel,
    chooseTranslationModel,
    translationModelOptions,
    formatOpenRouterPricePerMillion,
    applyPromptCacheSession,
    openRouterCacheMode,
    addOpenRouterCacheBreakpoint,
    applyOpenRouterCacheStrategy,
    shouldSendTemperature,
    applyReasoningPayload,
    sanitizeContentForAPI,
    siliconflowCapabilityKey,
    siliconflowSupportsThinking,
    siliconflowThinkingCapability,
    markSiliconflowThinkingCapability,
    isSiliconflowProvider,
    buildGeminiInteractionRequest: P.buildGeminiInteractionRequest,
    parseGeminiInteractionEvent: P.parseGeminiInteractionEvent,
    extractGeminiInteractionText: P.extractGeminiInteractionText,
    extractGeminiThoughtSummary: P.extractGeminiThoughtSummary,
    geminiInteractionsURL: P.geminiInteractionsURL,
    geminiModelsURL: P.geminiModelsURL
  };
})(this);
