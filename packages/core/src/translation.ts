namespace LitMTransPort {
  export interface TranslationChunk { id: string; index: number; start: number; end: number; markdown: string; marker: string; }
  export interface TranslationRequestRecord { chunk: TranslationChunk; messages: Array<{ role: string; content: unknown }>; attempt: number; }


  export function generatedOutputMarkerPath(documentID: string): string { return `${safe_document_stem(documentID, "document")}/.generated-output`; }
  export function targetLanguageInstruction(targetLanguage: string): string {
    const language = String(targetLanguage || "简体中文").trim();
    return ["简体中文", "繁体中文"].includes(language)
      ? `Use ${language}. Prefer standard academic Chinese terminology and retain necessary English abbreviations.`
      : `Use ${language}. Do not switch to Chinese unless Chinese source text itself must be translated into ${language}.`;
  }
  export function buildKeyPointsPromptForDocument(targetLanguage = "简体中文"): string {
    return `请阅读完整文档，以${targetLanguage}输出：研究问题、方法、关键数据、结论、限制、可复现性线索。引用文档中的页码、图表或公式时保留定位信息；不要虚构原文没有的内容。`;
  }
  export function buildTranslationChunks(markdown: string, maxChars = 135000): TranslationChunk[] {
    let offset = 0;
    return splitMarkdownByChars(markdown, maxChars).map((part, index) => {
      const start = String(markdown || "").indexOf(part.trim(), offset);
      const actualStart = start >= 0 ? start : offset;
      const end = actualStart + part.length;
      offset = end;
      const marker = `[[AITL_END_${String(index + 1).padStart(4, "0")}_${shortHash(part)}]]`;
      return { id: `chunk-${String(index + 1).padStart(4, "0")}`, index, start: actualStart, end, markdown: part, marker };
    });
  }
  export function buildStreamTranslationMessages(chunk: TranslationChunk, options: {
    targetLanguage: string; sourceLanguage?: string; referenceContext?: string; previousTranslation?: string;
  }): Array<{ role: string; content: string }> {
    const reference = String(options.referenceContext || "").trim();
    const previous = String(options.previousTranslation || "").trim();
    const system = [
      "You are an academic document translator.", targetLanguageInstruction(options.targetLanguage),
      "Preserve Markdown structure, image targets, formulas, citation labels, headings, tables, lists and code.",
      "Do not summarize, omit, merge, reorder or invent content.",
      `Append the exact completion marker ${chunk.marker} after the translated chunk.`
    ].join("\n");
    const context = [reference ? `Reference material:\n${reference}` : "", previous ? `Previous translated tail for continuity:\n${previous.slice(-12000)}` : ""].filter(Boolean).join("\n\n");
    return [
      { role: "system", content: system },
      { role: "user", content: `${context}${context ? "\n\n" : ""}Translate this source chunk:\n\n${chunk.markdown}` }
    ];
  }
  export function acceptStreamChunk(raw: string, chunk: TranslationChunk): string {
    if (!markerDetected(raw, chunk.marker)) throw new PortError("MODEL_PROTOCOL", `模型未返回分块结束标记: ${chunk.id}`, { retryable: true });
    const cleaned = stripCompletionMarker(raw, chunk.marker);
    const math = formulaDelimiterBalance(cleaned);
    if (!math.ok) throw new PortError("MODEL_PROTOCOL", `译文公式分隔符不完整: ${chunk.id}`, { retryable: true, detail: math });
    return cleaned;
  }
  export function mergeTranslatedChunks(chunks: Array<{ chunk: TranslationChunk; text: string }>): string {
    const ordered = [...chunks].sort((a, b) => a.chunk.index - b.chunk.index);
    for (let index = 0; index < ordered.length; index++) {
      if (ordered[index].chunk.index !== index) throw new PortError("TRANSLATION_FAILED", `译文分块缺失或乱序: expected ${index}`);
    }
    return cleanMarkdownText(ordered.map(item => item.text.trim()).join("\n\n"));
  }
  export function createTranslationArtifact(documentID: string, fingerprint: string, kind: "stream" | "layout", values: Partial<TranslationArtifact>): TranslationArtifact {
    return {
      schemaVersion: TRANSLATION_SCHEMA_VERSION, kind, documentID, sourceFingerprint: fingerprint,
      provider: String(values.provider || ""), model: String(values.model || ""), targetLanguage: String(values.targetLanguage || "简体中文"),
      status: values.status || "complete", markdown: String(values.markdown || ""), translations: { ...(values.translations || {}) },
      formulaReplacements: { ...(values.formulaReplacements || {}) },
      usage: values.usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
      createdAt: String(values.createdAt || new Date().toISOString()), error: String(values.error || "")
    };
  }
  export function shouldPublishTranslation(artifact: TranslationArtifact, expectedFingerprint: string): boolean {
    return artifact.status === "complete" && artifact.sourceFingerprint === expectedFingerprint && (Boolean(artifact.markdown.trim()) || Object.keys(artifact.translations).length > 0);
  }
  export function readKeyFileLines(value: string): string[] { return String(value || "").split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#")); }
  export function loadLabelledSecret(lines: string[], label: string): string {
    const normalized = String(label || "").toLowerCase();
    for (const line of lines) {
      const match = line.match(/^\s*([^:=]+)\s*[:=]\s*(.+)\s*$/);
      if (match && match[1].trim().toLowerCase() === normalized) return match[2].trim();
    }
    return "";
  }
  export function loadKeySetting(lines: string[], labels: string[]): string {
    for (const label of labels) { const value = loadLabelledSecret(lines, label); if (value) return value; }
    return "";
  }
  export function saveKey(store: SecretStore, value: string): string {
    saveSecret(store, "mineru", "official", value);
    return secretPath("mineru", "official");
  }
  export function createReaderWindow(mode: "stream" | "layout"): ReaderModeState {
    return Object.freeze({ ...readingModeContract(mode) });
  }
}
