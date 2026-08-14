namespace LitMTransPort {
  export interface ReferenceQuote {
    id: string;
    type: "text" | "image" | "formula";
    text: string;
    pane: "source" | "translation";
    page: number | null;
    blockID: string;
    imageTarget: string;
    formula: string;
    title: string;
  }
  export function referenceQuoteIdentity(quote: Partial<ReferenceQuote>): string {
    return fingerprintText(stableStringify({
      type: quote.type || "text", text: String(quote.text || "").trim(), pane: quote.pane || "source",
      page: quote.page ?? null, blockID: quote.blockID || "", imageTarget: quote.imageTarget || "", formula: quote.formula || ""
    }));
  }
  export function normalizeReferenceQuote(value: Partial<ReferenceQuote>): ReferenceQuote {
    const type = ["image", "formula"].includes(String(value.type)) ? value.type as "image" | "formula" : "text";
    const quote: ReferenceQuote = {
      id: String(value.id || ""), type, text: String(value.text || "").trim(),
      pane: value.pane === "translation" ? "translation" : "source",
      page: Number.isFinite(Number(value.page)) ? Number(value.page) : null,
      blockID: String(value.blockID || ""), imageTarget: String(value.imageTarget || ""),
      formula: String(value.formula || ""), title: String(value.title || "")
    };
    if (!quote.id) quote.id = `quote-${referenceQuoteIdentity(quote)}`;
    return quote;
  }
  export function appendPendingReferenceQuote(quotes: ReferenceQuote[], quote: Partial<ReferenceQuote>): ReferenceQuote[] {
    const normalized = normalizeReferenceQuote(quote);
    const id = referenceQuoteIdentity(normalized);
    if (quotes.some(item => referenceQuoteIdentity(item) === id)) return [...quotes];
    return [...quotes, normalized];
  }
  export function combinedPendingReferenceQuote(quotes: ReferenceQuote[]): ReferenceQuote | null {
    const normalized = quotes.map(normalizeReferenceQuote).filter(item => item.text || item.imageTarget || item.formula);
    if (!normalized.length) return null;
    if (normalized.length === 1) return normalized[0];
    return normalizeReferenceQuote({
      type: "text", pane: normalized[0].pane, title: `组合引用（${normalized.length} 项）`,
      text: normalized.map((quote, index) => `[引用 ${index + 1}] ${quote.title || quote.type}\n${quote.text || quote.formula || quote.imageTarget}`).join("\n\n")
    });
  }
  export function locateReference(document: NormalizedDocument, quote: Partial<ReferenceQuote>): { page: number | null; blockID: string; bbox: BoundingBox | null } {
    const normalized = normalizeReferenceQuote(quote);
    for (const page of document.pages || []) {
      const block = page.blocks.find(item => item.id === normalized.blockID || (normalized.text && item.text.includes(normalized.text.slice(0, 80))));
      if (block) return { page: page.page, blockID: block.id, bbox: block.bbox };
    }
    return { page: normalized.page, blockID: normalized.blockID, bbox: null };
  }
}
