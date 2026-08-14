namespace LitMTransPort {
  export interface DocumentIdentityInput { libraryID: number | string; itemKey: string; attachmentKey: string; filePath: string; }
  export function documentID(input: DocumentIdentityInput): string {
    const base = `${input.libraryID}:${input.itemKey}:${input.attachmentKey}`;
    return `zotero-${safe_document_stem(String(input.libraryID), "library", 24)}-${safe_document_stem(input.itemKey || input.attachmentKey || shortHash(input.filePath), "item", 48)}-${shortHash(base)}`;
  }
  export function normalizeOriginalPathHint(path: string): string {
    const value = String(path || "").replace(/\\/g, "/");
    return value.slice(value.lastIndexOf("/") + 1);
  }
  export function newNormalizedDocument(id: string, markdown: string): NormalizedDocument {
    const document: NormalizedDocument = { schemaVersion: 3, documentID: id, title: "", sourcePathHint: "", markdown: cleanMarkdownText(markdown), pages: [], images: [], formulas: [], references: [], sourceFingerprint: "", generatedAt: new Date().toISOString(), metadata: {} };
    document.sourceFingerprint = sourceFingerprint(document); return document;
  }
  export function updateDocumentFingerprint(document: NormalizedDocument): NormalizedDocument { return { ...document, sourceFingerprint: sourceFingerprint(document) }; }
  export function sourceChanged(previous: NormalizedDocument | null, current: NormalizedDocument): boolean { return Boolean(previous?.sourceFingerprint && previous.sourceFingerprint !== current.sourceFingerprint); }
}
