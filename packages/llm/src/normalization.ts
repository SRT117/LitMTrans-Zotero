namespace LitMTransPort {
  export interface CompletionResult { text: string; reasoning: string; usage: TranslationUsage | null; model: string; terminalState: "completed" | "cancelled" | "failed"; }
  export function normalizeCompletionResult(value: Partial<CompletionResult>): CompletionResult {
    return { text: String(value.text || "").trim(), reasoning: String(value.reasoning || ""), usage: value.usage || null, model: String(value.model || ""), terminalState: value.terminalState || "completed" };
  }
  export function mergeUsage(left: TranslationUsage | null, right: TranslationUsage | null): TranslationUsage | null {
    if (!left) return right ? { ...right } : null; if (!right) return { ...left };
    return { inputTokens: left.inputTokens + right.inputTokens, outputTokens: left.outputTokens + right.outputTokens, totalTokens: left.totalTokens + right.totalTokens, cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens, reasoningTokens: left.reasoningTokens + right.reasoningTokens };
  }
  export function normalizeProviderError(error: unknown, provider: string): PortError {
    const normalized = normalizePortError(error, "MODEL_PROTOCOL");
    return new PortError(normalized.code, `${providerSpec(provider).name}: ${normalized.message}`, { retryable: normalized.retryable, detail: { ...normalized.detail, provider }, cause: error });
  }
}
