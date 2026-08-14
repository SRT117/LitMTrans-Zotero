namespace LitMTransPort {
  export interface CompletionOptions { stream?: boolean; temperature?: number | null; maxTokens?: number; responseFormat?: string; signal?: AbortLikeSignal | null; onText?: (value: string) => void; onReasoning?: (value: string) => void; onUsage?: (value: TranslationUsage) => void; }
  export function providerEndpoint(config: LLMConfig, operation: "models" | "complete"): string {
    if (config.protocol === "gemini-interactions") return operation === "models" ? geminiModelsURL(config.baseURL) : geminiInteractionsURL(config.baseURL, true);
    return `${config.baseURL.replace(/\/$/, "")}/${operation === "models" ? "models" : "chat/completions"}`;
  }
  export function providerHeaders(config: LLMConfig): Record<string, string> {
    return config.protocol === "gemini-interactions" ? { "x-goog-api-key": config.apiKey, "Content-Type": "application/json" } : { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" };
  }
  export async function listProviderModels(http: HttpClient, config: LLMConfig, signal: AbortLikeSignal | null = null): Promise<ModelRecord[]> {
    assertLLMConfig(config);
    const result = await http.requestJSON<Record<string, unknown>>("GET", providerEndpoint(config, "models"), { headers: providerHeaders(config), signal });
    const source = Array.isArray(result) ? result : Array.isArray(result.data) ? result.data : Array.isArray(result.models) ? result.models : [];
    return filterTextModels(source, config.provider);
  }
  export function requestConstruction(config: LLMConfig, messages: LLMMessage[], options: CompletionOptions = {}): { url: string; headers: Record<string, string>; payload: Record<string, unknown> } {
    assertLLMConfig(config);
    const payload = config.protocol === "gemini-interactions" ? buildGeminiInteractionRequest(config, messages, options) : buildOpenAIChatPayload(config, messages, options);
    return { url: config.protocol === "gemini-interactions" ? geminiInteractionsURL(config.baseURL, options.stream !== false) : providerEndpoint(config, "complete"), headers: providerHeaders(config), payload };
  }
  export function getProviderSpec(id: string): ProviderSpec { return providerSpec(id); }
  export function getTranslationProviderSpec(id: string): ProviderSpec { return providerSpec(id); }
  export function translationProviderName(id: string): string { return providerSpec(id).name; }
  export function providerDefaultBaseUrl(id: string): string { return providerSpec(id).defaultBaseURL; }
  export function providerPreferredModels(id: string): string[] { return [providerSpec(id).defaultModel].filter(Boolean); }
  export function providerDefaultModel(id: string): string { return providerSpec(id).defaultModel; }
  export function providerModelListUrl(id: string, baseURL: string): string { const config = normalizeLLMConfig({ provider: id, baseURL, apiKey: "x", model: providerSpec(id).defaultModel }); return providerEndpoint(config, "models"); }
  export function nonMultimodalModelKey(provider: string, model: string): string { return `${normalizeProviderID(provider)}|${String(model || "").trim()}`; }
  export function thinkingCapabilityKey(provider: string, baseURL: string, model: string): string { return `${normalizeProviderID(provider)}|${normalize_ai_base_url(baseURL, provider)}|${String(model || "")}`; }
  export function loadNonMultimodalModelMarks(value: string): string[] { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; } }
  export function saveNonMultimodalModelMarks(values: string[]): string { return JSON.stringify([...new Set(values)]); }
  export function cleanupNonMultimodalModelMarks(values: string[], active: string[]): string[] { const keep = new Set(active); return values.filter(value => keep.has(value)); }
  export function loadThinkingCapabilities(value: string): Record<string, boolean> { try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } }
  export function saveThinkingCapabilities(value: Record<string, boolean>): string { return JSON.stringify(value); }
  export function cachedThinkingCapability(value: Record<string, boolean>, key: string): boolean | null { return Object.prototype.hasOwnProperty.call(value, key) ? Boolean(value[key]) : null; }
  export function markThinkingCapability(value: Record<string, boolean>, key: string, supported: boolean): Record<string, boolean> { return { ...value, [key]: Boolean(supported) }; }
  export function cleanupThinkingCapabilities(value: Record<string, boolean>, active: string[]): Record<string, boolean> { const keep = new Set(active); return Object.fromEntries(Object.entries(value).filter(([key]) => keep.has(key))); }
  export function isMarkedNonMultimodalModel(values: string[], provider: string, model: string): boolean { return values.includes(nonMultimodalModelKey(provider, model)); }
  export function markNonMultimodalModel(values: string[], provider: string, model: string): string[] { return [...new Set([...values, nonMultimodalModelKey(provider, model)])]; }
  export function makeParseOutputDir(documentID: string): string { return `${safe_document_stem(documentID, "document")}/references`; }
  export function isDirectTextInputFile(path: string): boolean { return is_direct_text_input_file(path); }
  export function storedOriginalPath(documentID: string, path: string): string { return `${makeParseOutputDir(documentID)}/original/${safe_document_stem(normalizeOriginalPathHint(path), "source", 120)}`; }
  export function findStoredOriginal(paths: string[]): string { return paths.find(path => /\/original\//.test(path.replace(/\\/g, "/"))) || ""; }
  export function debugPrintModelResponse(value: unknown): string { return stableStringify(redactRequestAudit(value)); }
  export function debugPrintModelSummary(value: unknown): string { const text = debugPrintModelResponse(value); return text.length > 1200 ? `${text.slice(0, 1200)}…` : text; }
  export function loadProviderSecret(store: SecretStore, provider: string): string { return store.get("llm", normalizeProviderID(provider)); }
  export function loadProviderBaseUrl(store: PreferenceStore, provider: string): string { return normalize_ai_base_url(store.get(`${normalizeProviderID(provider)}BaseURL`, providerSpec(provider).defaultBaseURL), provider); }
  export function loadProviderModelSetting(store: PreferenceStore, provider: string): string { return String(store.get(`${normalizeProviderID(provider)}Model`, providerSpec(provider).defaultModel)); }
  export function accept(value: string): string { return String(value || "").trim(); }
  export function loadProviderKey(store: SecretStore, provider: string): string { return loadProviderSecret(store, provider); }
}
