namespace LitMTransPort {
  const TRANSLATABLE_TYPES = new Set(["title", "text", "table_caption", "table_footnote", "chart_caption", "image_caption", "image_footnote", "ref_text"]);


  export function normalizeBBox(value: unknown): BoundingBox | null {
    const source = Array.isArray(value) ? value : (value && typeof value === "object" ? [
      (value as Record<string, unknown>).x0 ?? (value as Record<string, unknown>).left,
      (value as Record<string, unknown>).y0 ?? (value as Record<string, unknown>).top,
      (value as Record<string, unknown>).x1 ?? (value as Record<string, unknown>).right,
      (value as Record<string, unknown>).y1 ?? (value as Record<string, unknown>).bottom
    ] : []);
    if (source.length < 4) return null;
    const numbers = source.slice(0, 4).map(Number);
    if (numbers.some(value => !Number.isFinite(value))) return null;
    const [x0, y0, x1, y1] = numbers;
    return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
  }
  export function normalizeBlockType(value: unknown): string {
    const type = String(value || "text").toLowerCase().replace(/[\s-]+/g, "_");
    const aliases: Record<string, string> = { paragraph: "text", body: "text", heading: "title", equation: "interline_equation", image: "image", figure: "image", table_foot_note: "table_footnote" };
    return aliases[type] || type;
  }
  export interface TocRow {
    gap?: boolean;
    text?: string;
    number?: string;
    title?: string;
    page?: string;
    level?: number;
  }
  export function layoutLogicalLines(lines: unknown): string[] {
    if (!Array.isArray(lines)) return [];
    const output: string[] = [];
    for (const line of lines) {
      if (!line || typeof line !== "object") continue;
      const spans = Array.isArray((line as Record<string, unknown>).spans)
        ? (line as Record<string, unknown>).spans as unknown[]
        : [];
      const fragments = spans
        .filter(span => span && typeof span === "object")
        .map(span => {
          const value = span as Record<string, unknown>;
          return String(value.content ?? value.text ?? value.value ?? "");
        })
        .filter(Boolean);
      if (fragments.length) output.push(...fragments.join("").replace(/\r\n?/g, "\n").split("\n"));
    }
    return output;
  }
  export function parseTocRows(lines: unknown): TocRow[] | null {
    const entries: TocRow[] = [];
    let nonblank = 0;
    const pattern = /^\s*(\d+(?:\.\d+)*\.?)\s+(.+?)\s*(?:\.{2,}|…{2,}|·{2,}|-{3,})\s*(\d+|[ivxlcdm]+)\s*$/i;
    for (const rawLine of layoutLogicalLines(lines)) {
      const text = String(rawLine || "").replace(/\s+/g, " ").trim();
      if (!text) {
        entries.push({ gap: true });
        continue;
      }
      nonblank++;
      const match = text.match(pattern);
      if (!match) {
        entries.push({ text });
        continue;
      }
      const number = match[1];
      entries.push({
        number,
        title: match[2].trim(),
        page: match[3],
        level: Math.max(0, number.replace(/\.$/, "").split(".").filter(Boolean).length - 1)
      });
    }
    const matched = entries.filter(entry => entry.page).length;
    return matched >= 6 && matched / Math.max(1, nonblank) >= .70 ? entries : null;
  }
  export function codeTextFromLayoutBlock(raw: unknown): string {
    const lines: string[] = [];
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      for (const line of Array.isArray(record.lines) ? record.lines : []) {
        if (!line || typeof line !== "object") continue;
        const spans = Array.isArray((line as Record<string, unknown>).spans)
          ? (line as Record<string, unknown>).spans as unknown[]
          : [];
        lines.push(spans.map(span => {
          if (!span || typeof span !== "object") return "";
          const item = span as Record<string, unknown>;
          return String(item.content ?? item.text ?? item.value ?? "");
        }).join(""));
      }
      for (const child of Array.isArray(record.blocks) ? record.blocks : []) visit(child);
    };
    visit(raw);
    return lines.join("\n").replace(/^\n+|\n+$/g, "");
  }
  export function normalizeLayoutBlock(raw: Record<string, unknown>, page: number, order: number): DocumentBlock {
    const type = normalizeBlockType(raw.type || raw.block_type || raw.category);
    const id = String(raw.id || raw.block_id || `p${page}-b${order}`);
    const preservedCode = ["code", "code_body"].includes(type) ? codeTextFromLayoutBlock(raw) : "";
    const tocRows = type === "text" ? parseTocRows(raw.lines) : null;
    const contentsText = tocRows ? layoutLogicalLines(raw.lines).join("\n").trim() : "";
    const text = String(preservedCode || contentsText || raw.text || raw.content || raw.markdown || raw.html || "").replace(/\r\n?/g, "\n");
    const imagePath = String(raw.image_path || raw.imagePath || raw.img_path || raw.path || "");
    const formulaIDs = (Array.isArray(raw.formula_ids) ? raw.formula_ids : Array.isArray(raw.formulas) ? raw.formulas : []).map(value => typeof value === "object" ? String((value as Record<string, unknown>).id || "") : String(value)).filter(Boolean);
    return {
      id, type, text, translatedText: String(raw.translatedText || raw.translated_text || ""), page,
      bbox: normalizeBBox(raw.bbox || raw.box || raw.rect), order,
      translatable: TRANSLATABLE_TYPES.has(type) && Boolean(text.trim()), imagePath,
      formulaIDs, referenceIDs: (Array.isArray(raw.reference_ids) ? raw.reference_ids : []).map(String),
      parentID: String(raw.parent_id || raw.parentID || ""),
      metadata: {
        tocRows: (tocRows || []) as unknown as PlainValue,
        codeLanguage: String(raw.guess_lang || raw.guessLang || "")
      }
    };
  }
  export function collectRawPages(raw: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(raw)) return raw.map(item => item && typeof item === "object" ? item as Record<string, unknown> : {});
    if (!raw || typeof raw !== "object") return [];
    const value = raw as Record<string, unknown>;
    for (const key of ["pages", "pdf_info", "layout", "page_info"]) {
      if (Array.isArray(value[key])) return (value[key] as unknown[]).map(item => item && typeof item === "object" ? item as Record<string, unknown> : {});
    }
    return [];
  }
  export function normalizeLayoutDocument(raw: unknown, documentID: string, markdown = "", imageMap: DocumentImage[] = []): NormalizedDocument {
    const pages = collectRawPages(raw).map((pageRaw, index): DocumentPage => {
      const page = Number(pageRaw.page_idx ?? pageRaw.page_index ?? pageRaw.page_no ?? pageRaw.page ?? index) + (pageRaw.page_idx !== undefined || pageRaw.page_index !== undefined ? 1 : 0);
      const width = Math.max(1, Number(pageRaw.width || (pageRaw.page_size as Record<string, unknown>)?.width || 1000));
      const height = Math.max(1, Number(pageRaw.height || (pageRaw.page_size as Record<string, unknown>)?.height || 1400));
      const rawBlocks = (Array.isArray(pageRaw.blocks) ? pageRaw.blocks : Array.isArray(pageRaw.para_blocks) ? pageRaw.para_blocks : Array.isArray(pageRaw.layout_dets) ? pageRaw.layout_dets : []) as unknown[];
      const blocks: DocumentBlock[] = [];
      const visit = (items: unknown[], parentID = "") => {
        for (const item of items) {
          if (!item || typeof item !== "object") continue;
          const rawBlock = item as Record<string, unknown>;
          const block = normalizeLayoutBlock({ ...rawBlock, parent_id: rawBlock.parent_id || parentID }, page || index + 1, blocks.length);
          blocks.push(block);
          const children = (Array.isArray(rawBlock.blocks) ? rawBlock.blocks : Array.isArray(rawBlock.children) ? rawBlock.children : []) as unknown[];
          if (children.length) visit(children, block.id);
        }
      };
      visit(rawBlocks);
      return { page: page || index + 1, width, height, blocks, imageIDs: [], formulaIDs: [...new Set(blocks.flatMap(block => block.formulaIDs))] };
    });
    const formulas: DocumentFormula[] = [];
    for (const page of pages) for (const block of page.blocks) {
      if (["interline_equation", "inline_equation", "formula"].includes(block.type) && block.text.trim()) {
        const id = block.formulaIDs[0] || `formula-${block.id}`;
        block.formulaIDs = [id];
        formulas.push({ id, tex: stripTexWrappers(block.text), page: page.page, bbox: block.bbox, inline: block.type === "inline_equation" });
      }
    }
    for (const image of imageMap) {
      const page = pages.find(item => item.page === image.page);
      if (page) page.imageIDs.push(image.id);
    }
    const partial: NormalizedDocument = {
      schemaVersion: 3, documentID, title: "", sourcePathHint: "", markdown: cleanMarkdownText(markdown), pages,
      images: imageMap.map(image => ({ ...image })), formulas, references: [], sourceFingerprint: "", generatedAt: new Date().toISOString(), metadata: {}
    };
    partial.sourceFingerprint = sourceFingerprint(partial);
    return partial;
  }
  export function stripTexWrappers(value: string): string {
    let text = String(value || "").trim();
    for (const pair of [["$$", "$$"], ["\\[", "\\]"], ["\\(", "\\)"], ["$", "$"]] as const) {
      if (text.startsWith(pair[0]) && text.endsWith(pair[1]) && text.length >= pair[0].length + pair[1].length) text = text.slice(pair[0].length, -pair[1].length).trim();
    }
    return text;
  }
  export function extractBraced(value: string, start: number): { text: string; end: number } | null {
    if (value[start] !== "{") return null;
    let depth = 0;
    for (let index = start; index < value.length; index++) {
      if (value[index] === "{" && value[index - 1] !== "\\") depth++;
      if (value[index] === "}" && value[index - 1] !== "\\") depth--;
      if (depth === 0) return { text: value.slice(start + 1, index), end: index + 1 };
    }
    return null;
  }
  export function texCommandToText(command: string): string {
    const map: Record<string, string> = { mu: "μ", alpha: "α", beta: "β", gamma: "γ", delta: "δ", cdot: "·", times: "×", le: "≤", ge: "≥", neq: "≠", pm: "±", prime: "′", star: "*" };
    return map[String(command || "").replace(/^\\/, "")] || String(command || "");
  }
  export function splitTexGroup(value: string): string[] { return String(value || "").split(/(?<!\\)[,;]/).map(item => item.trim()).filter(Boolean); }
  export function parseTexishSegments(value: string): Array<{ kind: "text" | "command"; value: string }> {
    const segments: Array<{ kind: "text" | "command"; value: string }> = [];
    const pattern = /\\[A-Za-z]+|[^\\]+|\\./g;
    for (const match of String(value || "").matchAll(pattern)) segments.push({ kind: match[0].startsWith("\\") ? "command" : "text", value: match[0] });
    return segments;
  }
  export function normalizeHtmlTableCellText(value: string): string { return String(value || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").trim(); }
  export function parseRawHtmlTable(html: string): string[][] {
    const rows: string[][] = [];
    for (const row of String(html || "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      rows.push([...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => normalizeHtmlTableCellText(cell[1])));
    }
    return rows.filter(row => row.length);
  }
  export function splitMarkdownTableCells(row: string): string[] {
    const text = String(row || "").trim().replace(/^\|/, "").replace(/\|$/, "");
    const cells: string[] = []; let current = "", escaped = false;
    for (const char of text) {
      if (escaped) { current += char; escaped = false; }
      else if (char === "\\") { current += char; escaped = true; }
      else if (char === "|") { cells.push(current.trim()); current = ""; }
      else current += char;
    }
    cells.push(current.trim()); return cells;
  }
  export function isMarkdownSeparatorRow(row: string): boolean { return splitMarkdownTableCells(row).every(cell => /^:?-{3,}:?$/.test(cell)); }
  export function markdownTableRow(cells: string[]): string { return `| ${cells.map(cell => String(cell || "").replace(/\|/g, "\\|")).join(" | ")} |`; }
  export function repairPipeTableBlock(block: string): string {
    const rows = String(block || "").split("\n").filter(line => line.includes("|"));
    if (rows.length < 2) return block;
    const parsed = rows.map(splitMarkdownTableCells); const width = Math.max(...parsed.map(row => row.length));
    const normalized = parsed.map(row => [...row, ...Array(Math.max(0, width - row.length)).fill("")]);
    if (!isMarkdownSeparatorRow(markdownTableRow(normalized[1]))) normalized.splice(1, 0, Array(width).fill("---"));
    return normalized.map(markdownTableRow).join("\n");
  }
  export function repairMalformedPipeTables(markdown: string): string {
    return markdownBlocks(markdown).map(block => block.kind === "table" || block.text.split("\n").filter(line => line.includes("|")).length >= 2 ? repairPipeTableBlock(block.text) : block.text).join("\n\n") + "\n";
  }
  export function researchCss(): string { return ".layout-page{position:relative}.layout-block{position:absolute;overflow:visible}.layout-formula{white-space:nowrap}"; }
}
