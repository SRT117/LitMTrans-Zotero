namespace LitMTransPort {
  export interface GeminiInteractionParts { text: string; reasoning: string; usage: TranslationUsage | null; model: string; done: boolean; error: string; }

  function geminiContentParts(content: unknown): unknown[] {
    if (typeof content === "string") return [{ type: "text", text: sanitizeContentForAPI(content) }];
    if (!Array.isArray(content)) return [{ type: "text", text: String(content || "") }];
    const parts: unknown[] = [];
    for (const item of content) {
      if (typeof item === "string") parts.push({ type: "text", text: sanitizeContentForAPI(item) });
      else if (item && typeof item === "object") {
        const value = item as Record<string, unknown>; const type = String(value.type || "");
        if (type === "text") parts.push({ type: "text", text: sanitizeContentForAPI(value.text || "") });
        else if (type === "image_url") {
          const imageURL = value.image_url;
          const url = typeof imageURL === "string" ? imageURL : String((imageURL && typeof imageURL === "object" ? imageURL as Record<string, unknown> : {}).url || "");
          const match = url.match(/^data:([^;,]+);base64,(.+)$/s);
          if (match) parts.push({ type: "image", mime_type: match[1], data: match[2] });
          else if (url) parts.push({ type: "image", uri: url });
        }
      }
    }
    return parts.length ? parts : [{ type: "text", text: "" }];
  }

  function geminiInteractionInput(messages: LLMMessage[]): unknown[] {
    const conversation = messages
      .filter(message => String(message.role || "user") !== "system");
    // The Interactions API represents a single user turn as a flat list of
    // content blocks. Timeline steps are only needed when replaying history.
    // Wrapping first-turn image blocks in user_input.content can leave the
    // service waiting indefinitely instead of returning a schema error.
    if (
      conversation.length === 1
      && String(conversation[0].role || "user") !== "assistant"
    ) {
      return geminiContentParts(conversation[0].content);
    }
    return conversation.map(message => ({
        type: String(message.role || "user") === "assistant" ? "model_output" : "user_input",
        content: geminiContentParts(message.content)
      }));
  }

  export function buildGeminiInteractionRequest(config: LLMConfig, messages: LLMMessage[], options: { stream?: boolean; temperature?: number | null; maxTokens?: number; responseFormat?: string } = {}): Record<string, unknown> {
    const system = messages
      .filter(message => message.role === "system")
      .map(message => String(message.content || ""))
      .join("\n\n")
      .trim();
    const input = geminiInteractionInput(messages);
    const generationConfig: Record<string, unknown> = {
      ...gemini_translation_thinking_config(config.thinkingMode, config.reasoningEffort, config.model)
    };
    if (config.showReasoning) generationConfig.thinking_summaries = "auto";
    if (options.temperature !== null && options.temperature !== undefined) generationConfig.temperature = Number(options.temperature);
    if (Number(options.maxTokens) > 0) generationConfig.max_output_tokens = Number(options.maxTokens);
    const payload: Record<string, unknown> = {
      model: normalize_gemini_model_id(config.model),
      input: input.length ? input : "",
      store: false,
      stream: options.stream !== false
    };
    if (system) payload.system_instruction = system;
    if (Object.keys(generationConfig).length) payload.generation_config = generationConfig;
    if (options.responseFormat === "json_object") {
      payload.response_format = { type: "text", mime_type: "application/json" };
    }
    return payload;
  }

  function geminiDeltaText(delta: Record<string, unknown>): string {
    if (typeof delta.text === "string") return delta.text;
    const content = delta.content;
    if (typeof content === "string") return content;
    if (content && typeof content === "object") {
      const object = content as Record<string, unknown>;
      if (typeof object.text === "string") return object.text;
    }
    return "";
  }


  export function parseGeminiInteractionEvent(value: unknown): GeminiInteractionParts {
    const event = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const type = String(event.event_type || event.type || "");
    const delta = event.delta && typeof event.delta === "object" ? event.delta as Record<string, unknown> : {};
    let text = "", reasoning = "", usage: TranslationUsage | null = null, model = "", error = "", done = false;
    if (type === "step.delta" || type.endsWith(".delta")) {
      const deltaType = String(delta.type || event.delta_type || "");
      const valueText = geminiDeltaText(delta) || String(event.text || "");
      if (/thought_summary|thought|reason/i.test(deltaType)) reasoning = valueText;
      else if (/text|output/i.test(deltaType) || valueText) text = valueText;
    }
    const interaction = event.interaction && typeof event.interaction === "object" ? event.interaction as Record<string, unknown> : event;
    if (/completed|done/i.test(type)) {
      done = true; model = String(interaction.model || event.model || "");
      if (interaction.usage || event.usage) usage = normalizeUsage(interaction.usage || event.usage);
      if (!text) text = extractGeminiInteractionText(interaction);
      if (!reasoning) reasoning = extractGeminiThoughtSummary(interaction);
    }
    if (/error|failed/i.test(type) || event.error) {
      const raw = event.error && typeof event.error === "object" ? event.error as Record<string, unknown> : event;
      error = String(raw.message || raw.status || "Gemini Interactions API返回错误"); done = true;
    }
    return { text, reasoning, usage, model, done, error };
  }


  export function extractGeminiInteractionText(value: unknown): string {
    const root = value && typeof value === "object" ? value as Record<string, unknown> : {};
    if (typeof root.output_text === "string") return root.output_text;
    const pieces: string[] = [];
    const visit = (item: unknown, reasoning = false) => {
      if (typeof item === "string") { if (!reasoning) pieces.push(item); return; }
      if (Array.isArray(item)) { item.forEach(value => visit(value, reasoning)); return; }
      if (!item || typeof item !== "object") return;
      const object = item as Record<string, unknown>;
      const type = String(object.type || "").toLowerCase();
      const nextReasoning = reasoning || /thought|reason/.test(type);
      if (!nextReasoning && type === "text" && typeof object.text === "string") pieces.push(object.text);
      for (const key of ["steps", "outputs", "output", "content", "parts"]) {
        if (object[key] !== undefined) visit(object[key], nextReasoning);
      }
    };
    visit(root.steps || root.output || root.outputs || []);
    return pieces.join("").trim();
  }


  export function extractGeminiThoughtSummary(value: unknown): string {
    const root = value && typeof value === "object" ? value as Record<string, unknown> : {}; const pieces: string[] = [];
    const visit = (item: unknown, thought = false) => {
      if (typeof item === "string") { if (thought) pieces.push(item); return; }
      if (Array.isArray(item)) { item.forEach(value => visit(value, thought)); return; }
      if (!item || typeof item !== "object") return;
      const object = item as Record<string, unknown>;
      const type = String(object.type || "").toLowerCase();
      const next = thought || /thought_summary|thought|reason/.test(type);
      if (next && type === "text" && typeof object.text === "string") pieces.push(object.text);
      for (const key of ["steps", "outputs", "output", "summary", "content", "parts", "thought_summary"]) {
        if (object[key] !== undefined) visit(object[key], next || key === "summary" || key === "thought_summary");
      }
    };
    visit(root); return pieces.join("").trim();
  }


  export function geminiInteractionsURL(baseURL: string, stream = true): string {
    const base = normalize_ai_base_url(baseURL, "gemini").replace(/\/$/, "");
    return `${base}/interactions${stream ? "?alt=sse" : ""}`;
  }
  export function geminiModelsURL(baseURL: string): string {
    const base = normalize_ai_base_url(baseURL, "gemini").replace(/\/(?:v1|v1beta)$/, "");
    return `${base}/v1beta/models`;
  }
}
