namespace LitMTransPort {
  export type WorkbenchDialog = "model-settings" | "key-points-prompt" | "provider-cards" | null;
  export interface WorkbenchUIState {
    mode: "stream" | "layout";
    readerView: "both" | "source" | "translation";
    cleanReading: boolean;
    runningOperations: string[];
    selectedQuotes: ReferenceQuote[];
    embedded: boolean;
    topBarVisible: boolean;
    compactStyle: boolean;
    activeDialog: WorkbenchDialog;
    modelOptionsVisible: boolean;
    layoutChildrenVisible: boolean;
    groupChildrenVisible: boolean;
    documentToolEnabled: boolean;
    requestBodyMode: "chat_completions" | "responses" | "gemini-interactions";
    reasoningPreferences: Record<string, { thinkingMode: string; reasoningEffort: string; showReasoning: boolean }>;
  }
  export function createWorkbenchUIState(): WorkbenchUIState {
    return {
      mode: "stream", readerView: "both", cleanReading: false, runningOperations: [], selectedQuotes: [],
      embedded: true, topBarVisible: true, compactStyle: true, activeDialog: null,
      modelOptionsVisible: true, layoutChildrenVisible: false, groupChildrenVisible: false,
      documentToolEnabled: false, requestBodyMode: "chat_completions", reasoningPreferences: {}
    };
  }
  export function applyModeToWorkbench(state: WorkbenchUIState, mode: "stream" | "layout"): WorkbenchUIState {
    return { ...state, mode, layoutChildrenVisible: mode === "layout", groupChildrenVisible: mode === "layout" && state.groupChildrenVisible };
  }
  export function eventFilter<T extends { type?: string; key?: string }>(event: T): { accepted: boolean; event: T } {
    const type = String(event?.type || "");
    const key = String(event?.key || "");
    return { accepted: !(type === "keydown" && key === "Escape"), event };
  }
  export function Init(): WorkbenchUIState { return createWorkbenchUIState(); }
  export function closeEvent(state: WorkbenchUIState): WorkbenchUIState {
    return { ...state, runningOperations: [], cleanReading: false, activeDialog: null };
  }
  export function shutdownForApplicationExit(state: WorkbenchUIState): WorkbenchUIState { return closeEvent(state); }
  export function configureEmbeddedMode(state: WorkbenchUIState, embedded = true): WorkbenchUIState { return { ...state, embedded }; }
  export function createEmbeddedTopBar(state: WorkbenchUIState, visible = true): WorkbenchUIState { return { ...state, topBarVisible: visible }; }
  export function applyEmbeddedCompactStyle(state: WorkbenchUIState, enabled = true): WorkbenchUIState { return { ...state, compactStyle: enabled }; }
  export function openModelSettingsDialog(state: WorkbenchUIState): WorkbenchUIState { return { ...state, activeDialog: "model-settings" }; }
  export function keyPointsDefaultPrompt(language = "简体中文"): string { return buildKeyPointsPromptForDocument(language); }
  export function keyPointsPrompt(value: string, language = "简体中文"): string { return String(value || "").trim() || keyPointsDefaultPrompt(language); }
  export function saveKeyPointsPromptSetting(value: string): string { return String(value || "").trim(); }
  export function openKeyPointsPromptDialog(state: WorkbenchUIState): WorkbenchUIState { return { ...state, activeDialog: "key-points-prompt" }; }
  export function initUi(): WorkbenchUIState { return createWorkbenchUIState(); }
  export function applyLeftControlHeightPolicy(value: number): number { return Math.max(0, Math.min(720, Number(value) || 0)); }
  export function getCurrentProvider(settings: SettingsSnapshot): string { return settings.chatProvider; }
  export function ensureChatSettingsFields(settings: Partial<SettingsSnapshot>): SettingsSnapshot { return normalizeSettings(settings); }
  export function reasoningPreferenceKey(provider: string, model: string): string { return `${normalizeProviderID(provider)}|${String(model || "")}`; }
  export function saveReasoningPreferences(
    state: WorkbenchUIState,
    provider: string,
    model: string,
    value: { thinkingMode: string; reasoningEffort: string; showReasoning: boolean }
  ): WorkbenchUIState {
    const key = reasoningPreferenceKey(provider, model);
    return { ...state, reasoningPreferences: { ...state.reasoningPreferences, [key]: { ...value } } };
  }
  export function restoreReasoningPreferences(
    state: WorkbenchUIState,
    provider: string,
    model: string
  ): { thinkingMode: string; reasoningEffort: string; showReasoning: boolean } {
    return state.reasoningPreferences[reasoningPreferenceKey(provider, model)] || { thinkingMode: "default", reasoningEffort: "default", showReasoning: false };
  }
  export function requestBodyModeForProvider(provider: string): WorkbenchUIState["requestBodyMode"] {
    const protocol = providerSpec(provider).protocol;
    return protocol === "gemini-interactions" ? "gemini-interactions" : "chat_completions";
  }
  export function setRequestBodyModeForCurrentProvider(state: WorkbenchUIState, value: string): WorkbenchUIState {
    const mode = value === "gemini-interactions" ? "gemini-interactions" : normalizeOneapiRequestBodyMode(value);
    return { ...state, requestBodyMode: mode };
  }
  export function syncFromAppSettings(settings: Partial<SettingsSnapshot>): SettingsSnapshot { return normalizeSettings(settings); }
  export function openProviderCardsDialog(state: WorkbenchUIState): WorkbenchUIState { return { ...state, activeDialog: "provider-cards" }; }
  export function currentAiKeyAvailable(store: SecretStore, provider: string): boolean { return store.has("llm", normalizeProviderID(provider)); }
  export function currentDocumentToolAdapter<T>(): T | null { return getDocumentToolAdapter<T>(); }
  export function documentToolName(): string { return "MinerU"; }
  export function documentToolKeyAvailable(store: SecretStore): boolean { return store.has("mineru", "official"); }
  export function refreshDocumentToolControls(state: WorkbenchUIState, available: boolean): WorkbenchUIState { return { ...state, documentToolEnabled: Boolean(available) }; }
  export function mineruKeyAvailable(store: SecretStore): boolean { return documentToolKeyAvailable(store); }
  export function promptForMissingStartupKeys(missing: string[]): Array<{ scope: string; required: true }> {
    return [...new Set((missing || []).map(String).map(value => value.trim()).filter(Boolean))].map(scope => ({ scope, required: true }));
  }
  export function setModelOptionsVisible(state: WorkbenchUIState, value: boolean): WorkbenchUIState { return { ...state, modelOptionsVisible: Boolean(value) }; }
  export function setLayoutChildrenVisible(state: WorkbenchUIState, value: boolean): WorkbenchUIState { return { ...state, layoutChildrenVisible: Boolean(value) }; }
  export function setGroupChildrenVisible(state: WorkbenchUIState, value: boolean): WorkbenchUIState { return { ...state, groupChildrenVisible: Boolean(value) }; }
  export function conversationHistoryPath(documentID: string): string { return `${safe_document_stem(documentID, "document")}/chat/sessions.json`; }
  export function currentTimestampText(now = new Date()): string { return now.toISOString(); }
  export function makeConversationId(documentID: string, now = new Date()): string { return `session-${now.toISOString().replace(/\D/g, "")}-${shortHash(documentID)}`; }
  export function saveKeys(store: SecretStore, values: Record<string, string>): string[] {
    const saved: string[] = [];
    for (const [provider, value] of Object.entries(values || {})) {
      const key = String(value || "").trim();
      if (!key) continue;
      store.set("llm", normalizeProviderID(provider), key);
      saved.push(normalizeProviderID(provider));
    }
    return saved;
  }
  export interface SafeComboState { items: string[]; selected: string; popupOpen: boolean; destroyed: boolean; }
  export function SafeCombo(items: string[] = [], selected = ""): SafeComboState {
    const normalized = [...new Set(items.map(String).map(value => value.trim()).filter(Boolean))];
    return { items: normalized, selected: normalized.includes(selected) ? selected : (normalized[0] || ""), popupOpen: false, destroyed: false };
  }
  export function ShowPopupSafely(value: SafeComboState): SafeComboState { return value.destroyed ? value : { ...value, popupOpen: true }; }
  export function OnComboDestroyed(value: SafeComboState): SafeComboState { return { ...value, popupOpen: false, destroyed: true }; }
}
