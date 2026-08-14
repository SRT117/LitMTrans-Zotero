namespace LitMTransPort {
  export function retryableHttpStatus(status: number): boolean { return status === 408 || status === 425 || status === 429 || status >= 500; }
  export function normalizeUsage(value: unknown): TranslationUsage {
    const usage = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const input = Number(usage.input_tokens ?? usage.total_input_tokens ?? usage.prompt_tokens ?? usage.inputTokenCount ?? 0) || 0;
    const output = Number(usage.output_tokens ?? usage.total_output_tokens ?? usage.completion_tokens ?? usage.outputTokenCount ?? 0) || 0;
    const cached = Number(usage.cached_input_tokens ?? usage.total_cached_tokens ?? (usage.prompt_tokens_details as Record<string, unknown>)?.cached_tokens ?? 0) || 0;
    const reasoning = Number(usage.reasoning_tokens ?? usage.total_thought_tokens ?? (usage.completion_tokens_details as Record<string, unknown>)?.reasoning_tokens ?? 0) || 0;
    return { inputTokens: input, outputTokens: output, totalTokens: Number(usage.total_tokens ?? usage.totalTokenCount ?? input + output) || input + output, cachedInputTokens: cached, reasoningTokens: reasoning };
  }
  export function parseSSEFrames(text: string): Array<{ event: string; data: string }> {
    const normalized = String(text || "").replace(/\r\n?/g, "\n");
    const frames: Array<{ event: string; data: string }> = [];
    for (const raw of normalized.split(/\n\n+/)) {
      if (!raw.trim()) continue;
      let event = "message"; const data: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim() || "message";
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length) frames.push({ event, data: data.join("\n") });
    }
    return frames;
  }
  export function redactRequestAudit(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redactRequestAudit);
    if (!value || typeof value !== "object") return value;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = /api[-_]?key|authorization|token|cookie|secret/i.test(key) ? "[REDACTED]" : redactRequestAudit(item);
    }
    return output;
  }
  export function removeLocalAbsolutePaths(value: string): string {
    // A UNC path must contain both a server and a share component.  Matching
    // every `\\` would also redact TeX row breaks (for example `\\ = …`),
    // corrupting display equations before they reach the model. PDF OCR also
    // occasionally turns URL slashes into backslashes (for example
    // `http:\\\\doi.org\\10.1063/...`); that is a citation URL, not a UNC path.
    const text = String(value || "");
    const protectedURLs: string[] = [];
    // Protect complete web links before looking for drive-letter paths. This
    // also covers PDF OCR output such as `http:\\doi.org\10.1063/...`, where
    // the final `p` could otherwise be read as a Windows drive letter.
    const protectedText = text.replace(/https?:[\\/]+[^\s<>'\"]+/gi, match => {
      const token = `__LitMTrans_URL_${protectedURLs.length}__`;
      protectedURLs.push(match);
      return token;
    });
    const redacted = protectedText.replace(/(?:[A-Za-z]:[\\/][^\r\n]*|\\\\[^\s\\/:*?\"<>|]+\\[^\r\n]*)/g, "[本地路径已隐藏]");
    return redacted.replace(/__LitMTrans_URL_(\d+)__/g, (_token, index) => protectedURLs[Number(index)] || "");
  }
}
