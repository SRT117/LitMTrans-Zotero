namespace LitMTransPort {
  export interface LLMMessage { role: string; content: unknown; }
  export function sanitizeContentForAPI(content: unknown): unknown {
    if (typeof content === "string") return removeLocalAbsolutePaths(content);
    if (Array.isArray(content)) return content.map(sanitizeContentForAPI);
    if (!content || typeof content !== "object") return content;
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(content as Record<string, unknown>)) output[key] = ["text", "content", "caption", "alt"].includes(key.toLowerCase()) ? sanitizeContentForAPI(value) : value;
    return output;
  }
  export function buildOpenAIChatPayload(config: LLMConfig, messages: LLMMessage[], options: { stream?: boolean; temperature?: number | null; maxTokens?: number; responseFormat?: string } = {}): Record<string, unknown> {
    const payload: Record<string, unknown> = { model: config.model, messages: messages.map(message => ({ role: String(message.role || "user"), content: sanitizeContentForAPI(message.content) })), stream: options.stream !== false };
    if (options.temperature !== null && options.temperature !== undefined) payload.temperature = Number(options.temperature);
    if (Number(options.maxTokens) > 0) payload.max_tokens = Number(options.maxTokens);
    if (options.responseFormat === "json_object") payload.response_format = { type: "json_object" };
    if (config.promptCacheKey) payload.prompt_cache_key = config.promptCacheKey;
    const effort = String(config.reasoningEffort || "default").toLowerCase();
    if (effort !== "default") payload.reasoning_effort = effort;
    return payload;
  }
  export function buildAnthropicMessagesPayload(config: LLMConfig, messages: LLMMessage[], options: { stream?: boolean; maxTokens?: number } = {}): Record<string, unknown> {
    const system = messages.filter(message => message.role === "system").map(message => String(message.content || "")).join("\n\n");
    return { model: config.model, system, messages: messages.filter(message => message.role !== "system").map(message => ({ role: message.role === "assistant" ? "assistant" : "user", content: sanitizeContentForAPI(message.content) })), stream: options.stream !== false, max_tokens: Number(options.maxTokens || 8192) };
  }
}
