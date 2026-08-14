namespace LitMTransPort {
  export type Scalar = string | number | boolean | null;
  export type PlainValue = Scalar | PlainValue[] | { [key: string]: PlainValue };

  export interface BoundingBox { x0: number; y0: number; x1: number; y1: number; }
  export interface DocumentImage {
    id: string;
    originalTarget: string;
    cleanTarget: string;
    page: number | null;
    bbox: BoundingBox | null;
    mimeType: string;
    warning: string;
  }
  export interface DocumentFormula {
    id: string;
    tex: string;
    page: number | null;
    bbox: BoundingBox | null;
    inline: boolean;
  }
  export interface DocumentReference {
    id: string;
    text: string;
    page: number | null;
    blockID: string;
    kind: "citation" | "figure" | "table" | "formula" | "selection" | "other";
  }
  export interface DocumentBlock {
    id: string;
    type: string;
    text: string;
    translatedText: string;
    page: number;
    bbox: BoundingBox | null;
    order: number;
    translatable: boolean;
    imagePath: string;
    formulaIDs: string[];
    referenceIDs: string[];
    parentID: string;
    metadata: Record<string, PlainValue>;
  }
  export interface DocumentPage {
    page: number;
    width: number;
    height: number;
    blocks: DocumentBlock[];
    imageIDs: string[];
    formulaIDs: string[];
  }
  export interface NormalizedDocument {
    schemaVersion: number;
    documentID: string;
    title: string;
    sourcePathHint: string;
    markdown: string;
    pages: DocumentPage[];
    images: DocumentImage[];
    formulas: DocumentFormula[];
    references: DocumentReference[];
    sourceFingerprint: string;
    generatedAt: string;
    metadata: Record<string, PlainValue>;
  }
  export interface TranslationUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedInputTokens: number;
    reasoningTokens: number;
  }
  export interface TranslationArtifact {
    schemaVersion: number;
    kind: "stream" | "layout";
    documentID: string;
    sourceFingerprint: string;
    provider: string;
    model: string;
    targetLanguage: string;
    status: "complete" | "cancelled" | "failed";
    markdown: string;
    translations: Record<string, string>;
    formulaReplacements: Record<string, string>;
    usage: TranslationUsage;
    createdAt: string;
    error: string;
  }
  export interface VersionArchiveEntry {
    archiveID: string;
    documentID: string;
    sourceFingerprint: string;
    nextSourceFingerprint: string;
    createdAt: string;
    files: string[];
    chatSessionIDs: string[];
  }
  export interface ReaderModeState {
    mode: "stream" | "layout";
    sourceKind: "parsed-markdown" | "zotero-reader";
    translationKind: "stream-markdown" | "layout-pages";
    view: "both" | "source" | "translation";
    syncScroll: boolean;
    swapped: boolean;
    sourceSharePercent: number;
  }
}
