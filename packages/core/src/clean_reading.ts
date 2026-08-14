namespace LitMTransPort {
  export interface CleanReadingSnapshot {
    active: boolean;
    mode: "stream" | "layout";
    readerView: "both" | "source" | "translation";
    swapped: boolean;
    sourceSharePercent: number;
    sourceScrollTop: number;
    translationScrollTop: number;
    sourceScrollRatio: number;
    translationScrollRatio: number;
    focusedElementID: string;
    logDrawerOpen: boolean;
    chatRailVisible: boolean;
    enteredAt: number;
  }
  export function readingModeContract(mode: "stream" | "layout"): ReaderModeState {
    return mode === "layout"
      ? { mode, sourceKind: "zotero-reader", translationKind: "layout-pages", view: "both", syncScroll: true, swapped: false, sourceSharePercent: 50 }
      : { mode, sourceKind: "parsed-markdown", translationKind: "stream-markdown", view: "both", syncScroll: false, swapped: false, sourceSharePercent: 50 };
  }
  export function captureCleanReadingSnapshot(input: Partial<CleanReadingSnapshot>): CleanReadingSnapshot {
    const ratio = (top: number, height: number, client: number) => top / Math.max(1, height - client);
    const sourceTop = Number(input.sourceScrollTop || 0), translationTop = Number(input.translationScrollTop || 0);
    return {
      active: true, mode: input.mode === "layout" ? "layout" : "stream",
      readerView: ["source", "translation"].includes(String(input.readerView)) ? input.readerView as "source" | "translation" : "both",
      swapped: Boolean(input.swapped), sourceSharePercent: Math.max(22, Math.min(78, Number(input.sourceSharePercent || 50))),
      sourceScrollTop: sourceTop, translationScrollTop: translationTop,
      sourceScrollRatio: Number.isFinite(Number(input.sourceScrollRatio)) ? Number(input.sourceScrollRatio) : ratio(sourceTop, 1, 0),
      translationScrollRatio: Number.isFinite(Number(input.translationScrollRatio)) ? Number(input.translationScrollRatio) : ratio(translationTop, 1, 0),
      focusedElementID: String(input.focusedElementID || ""), logDrawerOpen: Boolean(input.logDrawerOpen),
      chatRailVisible: Boolean(input.chatRailVisible), enteredAt: Number(input.enteredAt || Date.now())
    };
  }
  export function exitCleanReadingSnapshot(snapshot: CleanReadingSnapshot): CleanReadingSnapshot { return { ...snapshot, active: false }; }
  export function validateReaderModeState(state: ReaderModeState): string[] {
    const errors: string[] = [];
    if (state.mode === "stream" && state.sourceKind !== "parsed-markdown") errors.push("流式模式原文必须为MinerU解析原文");
    if (state.mode === "layout" && state.sourceKind !== "zotero-reader") errors.push("排版模式原文必须为Zotero Reader原始PDF");
    if (state.mode === "layout" && state.translationKind !== "layout-pages") errors.push("排版模式译文必须为排版译文");
    return errors;
  }
}
