namespace LitMTransPort {
  export interface SettingsSnapshot {
    translationProvider: string; translationBaseURL: string; translationModel: string;
    chatProvider: string; chatBaseURL: string; chatModel: string;
    targetLanguage: string; sourceLanguage: string; machineSourceLanguage: string; translationMode: string;
    chunkChars: number; layoutChunkChars: number; layoutChunkBlocks: number;
    layoutReadingMode: boolean; streamSyncScroll: boolean; readerFontPt: number;
    showReasoning: boolean; requestAudit: boolean;
  }
  export const DEFAULT_SETTINGS: SettingsSnapshot = Object.freeze({
    translationProvider: "deepseek", translationBaseURL: "", translationModel: "",
    chatProvider: "deepseek", chatBaseURL: "", chatModel: "", targetLanguage: "简体中文", sourceLanguage: "英文", machineSourceLanguage: "英文",
    translationMode: "full_context", chunkChars: 135000, layoutChunkChars: 135000, layoutChunkBlocks: 160,
    layoutReadingMode: true, streamSyncScroll: false, readerFontPt: 12, showReasoning: false, requestAudit: false
  });
  export function normalizeSettings(input: Partial<SettingsSnapshot>): SettingsSnapshot {
    return {
      ...DEFAULT_SETTINGS, ...input,
      chunkChars: Math.max(10000, Math.min(300000, Number(input.chunkChars ?? DEFAULT_SETTINGS.chunkChars) || DEFAULT_SETTINGS.chunkChars)),
      layoutChunkChars: Math.max(0, Math.min(300000, Number(input.layoutChunkChars ?? DEFAULT_SETTINGS.layoutChunkChars) || 0)),
      layoutChunkBlocks: Math.max(0, Math.min(2000, Number(input.layoutChunkBlocks ?? DEFAULT_SETTINGS.layoutChunkBlocks) || 0)),
      readerFontPt: positiveFontSize(input.readerFontPt),
      layoutReadingMode: Boolean(input.layoutReadingMode), streamSyncScroll: Boolean(input.streamSyncScroll),
      showReasoning: Boolean(input.showReasoning), requestAudit: Boolean(input.requestAudit)
    };
  }

  function positiveFontSize(value: unknown, fallback = DEFAULT_SETTINGS.readerFontPt): number {
    const fontSize = Number(value);
    return Number.isFinite(fontSize) && fontSize > 0 ? fontSize : fallback;
  }
  export function normalizeOneapiRequestBodyMode(value: string): "chat_completions" | "responses" {
    return String(value || "").toLowerCase().includes("response") ? "responses" : "chat_completions";
  }
  export function editOneapiRequestBodyMode(value: string): "chat_completions" | "responses" { return normalizeOneapiRequestBodyMode(value); }

  export interface SecretProtector {
    protect(value: Uint8Array): Uint8Array;
    unprotect(value: Uint8Array): Uint8Array;
  }
  function utf8Bytes(value: string): Uint8Array { return new TextEncoder().encode(String(value || "")); }
  function utf8Text(value: Uint8Array): string { return new TextDecoder().decode(value); }
  function requireSecretProtector(protector: SecretProtector | null | undefined): SecretProtector {
    if (!protector) throw new PortError("HOST_ADAPTER", "当前环境无法安全保存密钥，请重启Zotero后重试");
    return protector;
  }

  export function protectSecret(value: string, protector?: SecretProtector | null): Uint8Array {
    return requireSecretProtector(protector).protect(utf8Bytes(value));
  }
  export function unprotectSecret(value: Uint8Array, protector?: SecretProtector | null): string {
    return utf8Text(requireSecretProtector(protector).unprotect(new Uint8Array(value)));
  }
  export function BlobFromBytes(value: Uint8Array): Uint8Array { return new Uint8Array(value); }
  export function DpapiProtect(value: Uint8Array, protector?: SecretProtector | null): Uint8Array {
    return requireSecretProtector(protector).protect(new Uint8Array(value));
  }
  export function DpapiUnprotect(value: Uint8Array, protector?: SecretProtector | null): Uint8Array {
    return requireSecretProtector(protector).unprotect(new Uint8Array(value));
  }
  export function SettingsFromDict(value: Partial<SettingsSnapshot>): SettingsSnapshot { return normalizeSettings(value); }
  export function loadSettings(store: PreferenceStore): SettingsSnapshot {
    const values: Partial<SettingsSnapshot> = {};
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof SettingsSnapshot>) values[key] = store.get(key, DEFAULT_SETTINGS[key]) as never;
    return normalizeSettings(values);
  }
  export function saveSettings(store: PreferenceStore, values: Partial<SettingsSnapshot>): SettingsSnapshot {
    const normalized = normalizeSettings({ ...loadSettings(store), ...values });
    for (const [key, value] of Object.entries(normalized)) store.set(key, value);
    return normalized;
  }
  export function secretPath(scope: string, provider: string): string { return `${safe_document_stem(scope, "scope", 32)}/${safe_document_stem(provider, "provider", 48)}`; }
  export function saveSecret(store: SecretStore, scope: string, provider: string, value: string): void { store.set(scope, provider, String(value || "").trim()); }
  export function loadSecret(store: SecretStore, scope: string, provider: string): string { return store.get(scope, provider); }
  export function deleteSecret(store: SecretStore, scope: string, provider: string): void { store.delete(scope, provider); }
  export function getBasePath(root: string): string { return String(root || "").replace(/[\\/]+$/, ""); }

  export interface HostStyleState { classes: string[]; stylesheet: string; }
  function normalizeClasses(classes: string[]): string[] { return [...new Set(classes.map(String).map(value => value.trim()).filter(Boolean))]; }
  export function applyElevation(value: HostStyleState): HostStyleState {
    return { ...value, classes: normalizeClasses([...(value.classes || []), "litmtrans-elevated"]) };
  }
  export function removeElevation(value: HostStyleState): HostStyleState {
    return { ...value, classes: normalizeClasses((value.classes || []).filter(name => name !== "litmtrans-elevated")) };
  }
  export function buildDarkPremiumStylesheet(): string {
    return ":root{color-scheme:dark light;--litmtrans-panel-bg:color-mix(in srgb,Canvas 94%,CanvasText 6%);--litmtrans-border:color-mix(in srgb,CanvasText 18%,transparent)}";
  }
  export function applyMonochromeAppStyle(value: string): string {
    const base = String(value || "").trim();
    const monochrome = ":root{--litmtrans-accent:CanvasText;--litmtrans-muted:GrayText}button,input,select{accent-color:CanvasText}";
    return [base, monochrome].filter(Boolean).join("\n");
  }
  export interface StructuredNotification { message: string; native: false; level: "info" | "warning" | "error"; }
  export function createSilentMessageBox(message: string, level: StructuredNotification["level"] = "info"): StructuredNotification {
    return { message: String(message || ""), native: false, level };
  }
  export interface SilentApplicationAdapter { suppressNativeDialogs: true; notificationMode: "structured"; }
  export function configureSilentApplication(): SilentApplicationAdapter {
    return { suppressNativeDialogs: true, notificationMode: "structured" };
  }
  export function showSilentMessage(message: string): StructuredNotification { return createSilentMessageBox(message); }
  export function makeStaticMessage(message: string): { show: () => StructuredNotification } { return { show: () => createSilentMessageBox(message) }; }
  export function show(message: string): StructuredNotification { return createSilentMessageBox(message); }
  export function about(message: string): StructuredNotification { return createSilentMessageBox(message); }
  export function applyGoogleSansCodeFont(value: string): string {
    const stack = '"Google Sans Code","SFMono-Regular",Consolas,"Liberation Mono",monospace';
    const current = String(value || "").trim();
    return current ? `${stack},${current}` : stack;
  }
  export interface WarningFilter { ignore: RegExp[]; report: RegExp[]; }
  export function installQtWarningFilter(): WarningFilter {
    return { ignore: [/QFont::setPixelSize/i, /QPainter::begin/i], report: [/error|failed|exception/i] };
  }
  export function messageHandler(message: string, filter: WarningFilter = installQtWarningFilter()): { ignored: boolean; message: string } {
    const text = String(message || "");
    return { ignored: filter.ignore.some(pattern => pattern.test(text)) && !filter.report.some(pattern => pattern.test(text)), message: text };
  }
  export function ensureValidApplicationFont(value: string): string {
    const cleaned = String(value || "").replace(/[\u0000-\u001f]/g, "").trim();
    return cleaned || "system-ui";
  }
  export interface ComboPopupPolicy { openOnPrimaryClick: true; preserveKeyboardNavigation: true; closeOnSelection: true; }
  export function makeComboPopupOnClick(): ComboPopupPolicy {
    return { openOnPrimaryClick: true, preserveKeyboardNavigation: true, closeOnSelection: true };
  }
}
