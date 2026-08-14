namespace LitMTransPort {
  export interface ZoteroReaderAdapter { openAttachment(attachmentID: number): Promise<void>; openPreview(attachmentID: number, frame: unknown): Promise<unknown>; jumpToPage(attachmentID: number, pageIndex: number, annotationKey?: string): Promise<void>; closePreview(preview: unknown): Promise<void>; }
  export function layoutReaderContract(attachmentID: number): { attachmentID: number; source: "zotero-reader"; parsedSourceToggleAllowed: false } { return { attachmentID, source: "zotero-reader", parsedSourceToggleAllowed: false }; }
  export async function openLayoutSource(adapter: ZoteroReaderAdapter, attachmentID: number, frame: unknown): Promise<unknown> { if (!attachmentID) throw new PortError("HOST_ADAPTER", "缺少Zotero PDF附件 ID"); return adapter.openPreview(attachmentID, frame); }
  export async function jumpLayoutReader(adapter: ZoteroReaderAdapter, attachmentID: number, page: number, annotationKey = ""): Promise<void> { await adapter.jumpToPage(attachmentID, Math.max(0, Math.trunc(page) - 1), annotationKey); }
  export function sourceKindForMode(mode: "stream" | "layout"): "parsed-markdown" | "zotero-reader" { return mode === "layout" ? "zotero-reader" : "parsed-markdown"; }
}
