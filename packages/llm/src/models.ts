namespace LitMTransPort {
  export interface ModelRecord { id: string; name: string; displayName: string; description: string; supportedActions: string[]; inputModalities: string[]; outputModalities: string[]; }
  export function normalizeModelRecord(value: unknown): ModelRecord {
    const raw = typeof value === "string" ? { id: value } : value && typeof value === "object" ? value as Record<string, unknown> : {};
    const id = normalize_gemini_model_id(String(raw.id || raw.name || raw.model || ""));
    const list = (item: unknown) => Array.isArray(item) ? item.map(String) : [];
    return { id, name: id, displayName: String(raw.displayName || raw.display_name || id), description: String(raw.description || ""), supportedActions: list(raw.supportedActions || raw.supported_actions || raw.supportedGenerationMethods), inputModalities: list(raw.inputModalities || raw.input_modalities), outputModalities: list(raw.outputModalities || raw.output_modalities) };
  }
  export function isTextGenerationModel(value: unknown, provider = "oneapi"): boolean {
    const model = normalizeModelRecord(value); const id = model.id.toLowerCase();
    if (!id) return false;
    if (/(?:embedding|embed-|imagen|veo|lyria|tts|speech|audio|live|robotics|aqa|rerank|moderation)/i.test(id)) return false;
    if (model.outputModalities.length && !model.outputModalities.some(item => /text/i.test(item))) return false;
    if (model.supportedActions.length && !model.supportedActions.some(item => /generate|interact|chat|predict/i.test(item))) return false;
    return providerSpec(provider).textModelFilter.test(model.id);
  }
  export function filterTextModels(values: unknown[], provider: string): ModelRecord[] {
    return [...new Map(values.map(normalizeModelRecord).filter(model => isTextGenerationModel(model, provider)).map(model => [model.id, model])).values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  export function chooseTranslationModel(provider: string, models: unknown[], current = ""): string {
    const filtered = filterTextModels(models, provider).map(model => model.id);
    if (current && filtered.includes(normalize_gemini_model_id(current))) return normalize_gemini_model_id(current);
    const preferred = [providerSpec(provider).defaultModel, "gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-2.5-flash", "deepseek-chat", "gpt-4.1-mini"].filter(Boolean);
    return preferred.find(model => filtered.includes(model)) || filtered[0] || "";
  }
  export function chooseChatModel(models: unknown[], current = "", provider = "oneapi"): string { return chooseTranslationModel(provider, models, current); }
}
