namespace LitMTransPort {
  export const CACHE_SCHEMA_VERSION = 3;
  export const TRANSLATION_SCHEMA_VERSION = 3;

  export interface CacheManifest {
    schemaVersion: number;
    documentID: string;
    sourceFingerprint: string;
    parsedAt: string;
    files: Record<string, { size: number; hash: string }>;
    translations: Record<string, { sourceFingerprint: string; createdAt: string; provider: string; model: string }>;
    archives: VersionArchiveEntry[];
  }


  export function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
  }
  export function fingerprintText(value: string): string {
    const normalized = String(value || "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
    let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
    for (let i = 0; i < normalized.length; i++) {
      const code = normalized.charCodeAt(i);
      h1 = Math.imul((h1 ^ code) >>> 0, 0x01000193) >>> 0;
      h2 = Math.imul((h2 ^ (code + (i + 1) * 131)) >>> 0, 0x85ebca6b) >>> 0;
    }
    return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
  }
  export function sourceFingerprint(document: Pick<NormalizedDocument, "markdown" | "pages" | "images" | "formulas">): string {
    return fingerprintText(stableStringify({
      markdown: String(document.markdown || "").replace(/\r\n?/g, "\n"),
      pages: (document.pages || []).map(page => ({
        page: page.page, width: page.width, height: page.height,
        blocks: (page.blocks || []).map(block => ({ id: block.id, type: block.type, text: block.text, bbox: block.bbox, order: block.order }))
      })),
      images: (document.images || []).map(image => ({ id: image.id, target: image.cleanTarget, page: image.page, bbox: image.bbox })),
      formulas: (document.formulas || []).map(formula => ({ id: formula.id, tex: formula.tex, page: formula.page, bbox: formula.bbox }))
    }));
  }
  export function translationIsCurrent(artifact: Pick<TranslationArtifact, "sourceFingerprint" | "status"> | null | undefined, currentFingerprint: string): boolean {
    return Boolean(artifact && artifact.status === "complete" && artifact.sourceFingerprint && artifact.sourceFingerprint === currentFingerprint);
  }
  export function assertTranslationCurrent(artifact: Pick<TranslationArtifact, "sourceFingerprint" | "status"> | null | undefined, currentFingerprint: string): void {
    if (!translationIsCurrent(artifact, currentFingerprint)) {
      throw new PortError("STALE_TRANSLATION", "解析正文已变化，当前译文已失效，请重新翻译", {
        detail: { published: artifact?.sourceFingerprint || "", current: currentFingerprint }
      });
    }
  }
  export function migrateCacheManifest(input: unknown, documentID = ""): CacheManifest {
    const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const files = value.files && typeof value.files === "object" && !Array.isArray(value.files) ? value.files as CacheManifest["files"] : {};
    const translations = value.translations && typeof value.translations === "object" && !Array.isArray(value.translations)
      ? value.translations as CacheManifest["translations"] : {};
    const archives = Array.isArray(value.archives) ? value.archives.filter(item => item && typeof item === "object") as VersionArchiveEntry[] : [];
    return {
      schemaVersion: CACHE_SCHEMA_VERSION,
      documentID: String(value.documentID || documentID || ""),
      sourceFingerprint: String(value.sourceFingerprint || value.source_fingerprint || ""),
      parsedAt: String(value.parsedAt || value.parsed_at || ""),
      files: { ...files }, translations: { ...translations }, archives: archives.map(entry => ({ ...entry }))
    };
  }
  export function latest_translation_path(documentID: string, kind: "stream" | "layout" = "stream"): string {
    return `${safe_document_stem(documentID, "document")}/translation/${kind}/latest.json`;
  }
  export function currentWorkDir(documentID: string): string { return `${safe_document_stem(documentID, "document")}/work`; }
  export function output_dir_for_pdf(documentID: string): string { return `${safe_document_stem(documentID, "document")}/parsed`; }
  export function latest_output_dir_for_file(documentID: string): string { return output_dir_for_pdf(documentID); }
  export function markGeneratedOutputDir(manifest: CacheManifest, marker = "generated-output"): CacheManifest {
    return { ...manifest, files: { ...manifest.files, [`.${marker}`]: { size: 0, hash: marker } } };
  }
  export function isGeneratedOutputDir(manifest: CacheManifest, marker = "generated-output"): boolean {
    return Boolean(manifest.files?.[`.${marker}`]);
  }
  export function createArchiveEntry(documentID: string, previousFingerprint: string, nextFingerprint: string, files: string[], sessions: string[], now = new Date()): VersionArchiveEntry {
    const createdAt = now.toISOString();
    return {
      archiveID: `${createdAt.replace(/[^0-9]/g, "").slice(0, 17)}-${shortHash(previousFingerprint || documentID)}`,
      documentID, sourceFingerprint: previousFingerprint, nextSourceFingerprint: nextFingerprint,
      createdAt, files: [...new Set(files.filter(Boolean))], chatSessionIDs: [...new Set(sessions.filter(Boolean))]
    };
  }
}
