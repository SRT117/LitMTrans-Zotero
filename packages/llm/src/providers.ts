namespace LitMTransPort {
  export type ProviderProtocol = "openai-chat" | "gemini-interactions" | "anthropic-messages";
  export interface ProviderSpec {
    id: string; name: string; protocol: ProviderProtocol; defaultBaseURL: string; defaultModel: string;
    supportsReasoning: boolean; supportsImages: boolean; supportsChat: boolean; textModelFilter: RegExp;
  }
  export const PROVIDER_SPECS: Record<string, ProviderSpec> = Object.freeze({
    free_machine: { id: "free_machine", name: "联网免费机翻", protocol: "openai-chat", defaultBaseURL: "", defaultModel: "", supportsReasoning: false, supportsImages: false, supportsChat: false, textModelFilter: /$^/ },
    edge_local: { id: "edge_local", name: "Edge本地翻译", protocol: "openai-chat", defaultBaseURL: "", defaultModel: "", supportsReasoning: false, supportsImages: false, supportsChat: false, textModelFilter: /$^/ },
    deepseek: { id: "deepseek", name: "DeepSeek", protocol: "openai-chat", defaultBaseURL: "https://api.deepseek.com", defaultModel: "deepseek-chat", supportsReasoning: true, supportsImages: false, supportsChat: true, textModelFilter: /deepseek-(?:chat|reasoner)/i },
    oneapi: { id: "oneapi", name: "OpenAI兼容", protocol: "openai-chat", defaultBaseURL: "", defaultModel: "", supportsReasoning: true, supportsImages: true, supportsChat: true, textModelFilter: /./ },
    openai_compatible: { id: "openai_compatible", name: "OpenAI 兼容接口", protocol: "openai-chat", defaultBaseURL: "", defaultModel: "", supportsReasoning: true, supportsImages: true, supportsChat: true, textModelFilter: /./ },
    gemini: { id: "gemini", name: "Google Gemini", protocol: "gemini-interactions", defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta", defaultModel: "gemini-3.5-flash", supportsReasoning: true, supportsImages: true, supportsChat: true, textModelFilter: /gemini/i },
    siliconflow: { id: "siliconflow", name: "SiliconFlow", protocol: "openai-chat", defaultBaseURL: "https://api.siliconflow.cn/v1", defaultModel: "", supportsReasoning: true, supportsImages: false, supportsChat: true, textModelFilter: /./ },
    zai: { id: "zai", name: "Z.ai", protocol: "openai-chat", defaultBaseURL: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "", supportsReasoning: true, supportsImages: false, supportsChat: true, textModelFilter: /./ },
    openrouter: { id: "openrouter", name: "OpenRouter", protocol: "openai-chat", defaultBaseURL: "https://openrouter.ai/api/v1", defaultModel: "", supportsReasoning: true, supportsImages: true, supportsChat: true, textModelFilter: /./ }
  });
  const PROVIDER_ALIASES: Record<string, string> = Object.freeze({
    google_free: "free_machine",
    bing_free: "free_machine",
    machine_translate: "free_machine"
  });
  export function normalizeProviderID(value: string): string {
    const requested = String(value || "oneapi").trim().toLowerCase();
    const id = PROVIDER_ALIASES[requested]
      || (requested.endsWith("_web") ? "free_machine" : requested);
    return PROVIDER_SPECS[id] ? id : "oneapi";
  }
  export function providerSpec(value: string): ProviderSpec { return PROVIDER_SPECS[normalizeProviderID(value)]; }
  export function normalize_ai_base_url(value: string, provider = "oneapi"): string {
    const spec = providerSpec(provider); let url = String(value || spec.defaultBaseURL || "").trim().replace(/\/+$/, "");
    if (spec.protocol === "gemini-interactions") url = url.replace(/\/v1beta\/openai$/i, "/v1beta").replace(/\/v1\/openai$/i, "/v1beta").replace(/\/openai$/i, "");
    return url;
  }
  export function normalize_gemini_model_id(value: string): string { return String(value || "").trim().replace(/^models\//i, ""); }
  export function is_gemini_provider(provider: string, baseURL = ""): boolean { return normalizeProviderID(provider) === "gemini" || /generativelanguage\.googleapis\.com/i.test(baseURL); }
  export function gemini_translation_thinking_config(mode: string, effort: string, model = ""): Record<string, unknown> {
    const normalizedMode = String(mode || "default").toLowerCase();
    const normalizedEffort = String(effort || "default").toLowerCase();
    const normalizedModel = normalize_gemini_model_id(model).toLowerCase();
    if (normalizedModel.startsWith("gemini-2.5-")) {
      if (normalizedMode === "disabled" && !normalizedModel.includes("2.5-pro")) return { thinking_budget: 0 };
      const budgets: Record<string, number> = { minimal: 1024, low: 1024, medium: 8192, high: 24576 };
      return normalizedEffort !== "default" ? { thinking_budget: budgets[normalizedEffort] || 8192 } : {};
    }
    if (normalizedMode === "disabled") return { thinking_level: "none" };
    const levels: Record<string, string> = { minimal: "minimal", low: "low", medium: "medium", high: "high", none: "none" };
    let level = levels[normalizedEffort] || "";
    if (normalizedModel.includes("3.1-pro") && level === "minimal") level = "low";
    return level ? { thinking_level: level } : {};
  }
  export function parseProviders(value: unknown): Record<string, ProviderSpec> {
    const output = { ...PROVIDER_SPECS };
    if (!value || typeof value !== "object" || Array.isArray(value)) return output;
    for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const base = providerSpec(id); const item = raw as Partial<ProviderSpec>;
      output[id] = { ...base, ...item, id, textModelFilter: base.textModelFilter };
    }
    return output;
  }
}
