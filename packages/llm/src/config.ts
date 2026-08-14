namespace LitMTransPort {
  export interface LLMConfig {
    purpose: "translation" | "chat"; provider: string; protocol: ProviderProtocol; baseURL: string; model: string; apiKey: string;
    thinkingMode: string; reasoningEffort: string; showReasoning: boolean; promptCacheKey: string;
  }
  export function normalizeLLMConfig(value: Partial<LLMConfig>): LLMConfig {
    const provider = normalizeProviderID(value.provider || "deepseek"); const spec = providerSpec(provider);
    return { purpose: value.purpose === "chat" ? "chat" : "translation", provider, protocol: spec.protocol, baseURL: normalize_ai_base_url(value.baseURL || spec.defaultBaseURL, provider), model: provider === "gemini" ? normalize_gemini_model_id(value.model || spec.defaultModel) : String(value.model || spec.defaultModel), apiKey: String(value.apiKey || "").trim(), thinkingMode: String(value.thinkingMode || "default"), reasoningEffort: String(value.reasoningEffort || "default"), showReasoning: Boolean(value.showReasoning), promptCacheKey: String(value.promptCacheKey || "") };
  }
  export function assertLLMConfig(config: LLMConfig): void {
    if (!config.baseURL) throw new PortError("PROVIDER_CONFIGURATION", "请先在LitMTrans设置中填写API地址");
    if (!config.apiKey) throw new PortError("PROVIDER_CONFIGURATION", `请先配置${providerSpec(config.provider).name}的API密钥`);
    if (!config.model) throw new PortError("PROVIDER_CONFIGURATION", "请先选择模型");
  }
}
