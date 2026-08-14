namespace LitMTransPort {
  export interface ChatContentPart { type: "text" | "image_url"; text?: string; image_url?: { url: string }; }
  export interface ChatMessage { id: string; role: "system" | "user" | "assistant"; content: string | ChatContentPart[]; createdAt: string; reasoning?: string; usage?: TranslationUsage | null; }
  export interface ChatSession { id: string; documentID: string; title: string; sourceFingerprint: string; createdAt: string; updatedAt: string; messages: ChatMessage[]; archivedRevisions: string[]; }


  export function messageContentTextParts(content: string | ChatContentPart[]): string[] {
    if (typeof content === "string") return [content];
    return (content || []).filter(part => part?.type === "text").map(part => String(part.text || ""));
  }
  export function messageContentToFullText(content: string | ChatContentPart[]): string { return messageContentTextParts(content).join("\n").trim(); }
  export function messageContentToDisplayText(content: string | ChatContentPart[]): string {
    if (typeof content === "string") return content;
    return (content || []).map(part => part.type === "text" ? String(part.text || "") : "[图片]").join("\n").trim();
  }
  export function normalizeChatMessage(value: Partial<ChatMessage>): ChatMessage {
    const role = value.role === "assistant" || value.role === "system" ? value.role : "user";
    const createdAt = String(value.createdAt || new Date().toISOString());
    return { id: String(value.id || `msg-${createdAt.replace(/\D/g, "")}-${shortHash(messageContentToDisplayText(value.content || ""))}`), role, content: value.content || "", createdAt, reasoning: String(value.reasoning || ""), usage: value.usage || null };
  }
  export function createChatSession(documentID: string, fingerprint: string, title = "新对话", now = new Date()): ChatSession {
    const timestamp = now.toISOString();
    return { id: `session-${timestamp.replace(/\D/g, "")}-${shortHash(documentID + title)}`, documentID, title, sourceFingerprint: fingerprint, createdAt: timestamp, updatedAt: timestamp, messages: [], archivedRevisions: [] };
  }
  export function archiveDocumentRevision(session: ChatSession, previousFingerprint: string, nextFingerprint: string): ChatSession {
    if (!previousFingerprint || previousFingerprint === nextFingerprint || session.sourceFingerprint !== previousFingerprint) return { ...session, messages: [...session.messages] };
    return { ...session, sourceFingerprint: nextFingerprint, archivedRevisions: [...new Set([...session.archivedRevisions, previousFingerprint])], updatedAt: new Date().toISOString(), messages: [...session.messages] };
  }
  export function markdownImageReferences(markdown: string): Array<{ alt: string; target: string }> {
    return [...String(markdown || "").matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)].map(match => ({ alt: match[1], target: match[2].trim() }));
  }
  export function buildDocumentContextForMessage(document: NormalizedDocument, question: string, options: {
    includeImages?: boolean; maxChars?: number; resolveImage?: (target: string) => string;
  } = {}): ChatContentPart[] {
    const maxChars = Number(options.maxChars || 0);
    const source = maxChars > 0 ? document.markdown.slice(0, maxChars) : document.markdown;
    const parts: ChatContentPart[] = [{ type: "text", text: `Document sourceFingerprint: ${document.sourceFingerprint}\n\n${source}\n\nUser question:\n${String(question || "")}` }];
    if (options.includeImages) {
      for (const reference of markdownImageReferences(source)) {
        const image = document.images.find(item => item.cleanTarget === reference.target || item.originalTarget === reference.target);
        if (!image || image.warning) continue;
        const url = options.resolveImage?.(image.cleanTarget) || "";
        if (url) parts.push({ type: "image_url", image_url: { url } });
      }
    }
    return parts;
  }
  export function buildSearchAgentStylesheet(): string { return ".chat-message{white-space:normal}.chat-message pre{white-space:pre-wrap}.chat-reference{border-left:3px solid currentColor;padding-left:.75rem}"; }
  export interface DocumentToolAdapter {
    parse(path: string, signal?: AbortLikeSignal | null): Promise<NormalizedDocument>;
    cancel?(reason?: string): void;
  }
  export function buildDocumentToolAdapter(adapter: DocumentToolAdapter): DocumentToolAdapter {
    if (!adapter || typeof adapter.parse !== "function") throw new PortError("HOST_ADAPTER", "文档解析适配器缺少 parse 方法");
    return Object.freeze({
      async parse(path: string, signal?: AbortLikeSignal | null): Promise<NormalizedDocument> {
        const source = String(path || "").trim();
        if (!source) throw new PortError("INVALID_INPUT", "文档路径为空");
        return adapter.parse(source, signal);
      },
      cancel(reason?: string): void { adapter.cancel?.(reason); }
    });
  }
  let documentToolAdapter: unknown = null;
  export function setDocumentToolAdapter(adapter: unknown): void { documentToolAdapter = adapter; }
  export function getDocumentToolAdapter<T = unknown>(): T | null { return documentToolAdapter as T | null; }
  export interface AgentConfiguration { provider: string; baseURL: string; model: string; enabled: boolean; }
  function normalizeAgentConfiguration(config: Partial<AgentConfiguration>): AgentConfiguration {
    const provider = normalizeProviderID(config.provider || "oneapi");
    return { provider, baseURL: normalize_ai_base_url(config.baseURL || providerSpec(provider).defaultBaseURL, provider), model: String(config.model || providerSpec(provider).defaultModel), enabled: config.enabled !== false };
  }
  export function configureResearchAiBase(config: Partial<AgentConfiguration>): AgentConfiguration { return normalizeAgentConfiguration(config); }
  export function configureSearchAiBase(config: Partial<AgentConfiguration>): AgentConfiguration { return normalizeAgentConfiguration(config); }
  export interface AgentDialogCommand { kind: "open-agent-dialog"; agent: "research" | "search" | "document"; payload: Record<string, unknown>; }
  export function openAiAgentDialog(agent: AgentDialogCommand["agent"], payload: Record<string, unknown> = {}): AgentDialogCommand { return { kind: "open-agent-dialog", agent, payload: { ...payload } }; }
  export function openDocumentChat(documentID: string, fingerprint: string): ChatSession { return createChatSession(documentID, fingerprint); }
  export function installSearchAgentDialogStyleFilter(value: string): string {
    const base = String(value || "").trim();
    return [base, buildSearchAgentStylesheet(), ".agent-dialog{min-width:32rem;max-width:min(72rem,96vw)}"].filter(Boolean).join("\n");
  }
}
