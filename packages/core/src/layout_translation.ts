namespace LitMTransPort {
  export interface LayoutTranslationRecord { blockID: string; sourceText: string; translatedText: string; type: string; page: number; order: number; }
  export interface FormulaContextRecord { formulaID: string; tex: string; page: number; blockID: string; }


  export function inlineTexToSafeText(value: string): string {
    return stripTexWrappers(value).replace(/\\([A-Za-z]+)/g, (_m, command) => texCommandToText(command)).replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
  }
  export function neutralizeBrokenInlineTex(value: string): string {
    const balance = formulaDelimiterBalance(value);
    if (balance.ok) return value;
    return String(value || "").replace(/(?<!\\)\$/g, "\\$").replace(/\\\[(?![\s\S]*\\\])/g, "[").replace(/\\\](?![\s\S]*\\\[)/g, "]");
  }
  export function normalizeMathComparisonEntities(value: string): string { return String(value || "").replace(/&lt;|＆lt；/gi, "<").replace(/&gt;|＆gt；/gi, ">").replace(/&le;|≤/gi, "≤").replace(/&ge;|≥/gi, "≥"); }
  export function inlineFormulaIntegrityIssue(source: string, translated: string): string {
    const sourceMath = String(source || "").match(/\$[^$]+\$|\\\([\s\S]*?\\\)/g) || [];
    const translatedMath = String(translated || "").match(/\$[^$]+\$|\\\([\s\S]*?\\\)/g) || [];
    if (translatedMath.length < sourceMath.length) return "inline-formula-missing";
    if (!formulaDelimiterBalance(translated).ok) return "inline-formula-unbalanced";
    return "";
  }

  function formulaTokenBody(value: string): string {
    const token = String(value || "");
    if ((token.startsWith("\\(") && token.endsWith("\\)")) || (token.startsWith("\\[") && token.endsWith("\\]"))) return token.slice(2, -2);
    if (token.startsWith("$$") && token.endsWith("$$")) return token.slice(2, -2);
    if (token.startsWith("$") && token.endsWith("$")) return token.slice(1, -1);
    return token;
  }

  function collapseRedundantFormulaBraces(value: string): string {
    let output = String(value || "");
    let previous = "";
    while (output !== previous) {
      previous = output;
      output = output.replace(/\{\s*\{([^{}]*)\}\s*\}/g, "{$1}");
    }
    return output;
  }

  export function normalizeMathBodyForRetry(value: string): string {
    let output = String(value || "").normalize("NFKC")
      .replace(/&(?:amp;)?lt;/gi, "<")
      .replace(/&(?:amp;)?gt;/gi, ">")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/(?:\\[,;:!]\s*|[,;:]\s+|\s+)\((?:i{1,3}|iv|v|[a-c])\)\s*$/i, "");
    output = collapseRedundantFormulaBraces(output);
    let previous = "";
    while (output !== previous) {
      previous = output;
      output = output
        .replace(/\\mathrm\s*\{([^{}]*)\}/g, "$1")
        .replace(/\\mathrm\s+([A-Za-z])/g, "$1")
        .replace(/\\mathrm(?=[A-Za-z])/g, "");
      output = collapseRedundantFormulaBraces(output);
    }
    return output.replace(/[\s,.;:，。；：、]+/g, "");
  }

  export function inlineFormulaRetryIssue(source: string, translated: string): string {
    const tokens = (value: string) => String(value || "").match(/\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?<!\\)\$\$[\s\S]*?(?<!\\)\$\$|(?<!\\)\$(?![\s$])[^\n$]*(?<!\\)\$(?!\d)/g) || [];
    const isOCRNonMathToken = (token: string) => {
      const body = formulaTokenBody(token).replace(/&(?:amp;)?lt;/gi, "<").replace(/&(?:amp;)?gt;/gi, ">");
      return /^\s*\\operatorname\s*\{\s*e\s*q\s*\.?\s*\}\s*$/i.test(body)
        || /^\s*[-+]?\d+(?:\s*\.\s*\d+)?\s*\^\s*\{\s*\\circ\s*\}\s*\\mathrm\s*\{\s*[CFK]\s*\}\s*$/i.test(body)
        || /^\s*(?:\\mathrm\s*\{\s*)?a\s*l\s*\.\s*\^\s*\{\s*(?:\d\s*)+(?:[-,]\s*(?:\d\s*)+)*\}\s*\}?\s*$/i.test(body)
        || /^\s*\\mathrm\s*\{\s*(?:[A-Za-z]\s*){1,8}\.\s*\^\s*\{\s*(?:\d\s*)+(?:[-,]\s*(?:\d\s*)+)*\}\s*\}\s*$/i.test(body);
    };
    const sourceMath = tokens(source).filter(token => !isOCRNonMathToken(token));
    if (!sourceMath.length) return "";
    const translatedMath = tokens(translated).filter(token => !isOCRNonMathToken(token));
    // Same-count TeX differences are review-only.  Models often normalize
    // OCR notation or presentation wrappers correctly, so automatic layout
    // retries are reserved for an objectively missing formula token.
    if (translatedMath.length < sourceMath.length) {
      const missingIndex = translatedMath.length;
      return `公式${missingIndex + 1}缺少可渲染的数学内容`;
    }
    return "";
  }
  export function plainBlockText(block: DocumentBlock): string { return String(block.text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
  export function iterTranslatableBlocks(document: NormalizedDocument): DocumentBlock[] { return document.pages.flatMap(page => page.blocks).filter(block => block.translatable); }
  export function iterFormulaContext(document: NormalizedDocument): FormulaContextRecord[] {
    const blocks = new Map(document.pages.flatMap(page => page.blocks).map(block => [block.id, block]));
    return document.formulas.map(formula => {
      const block = [...blocks.values()].find(item => item.formulaIDs.includes(formula.id));
      return { formulaID: formula.id, tex: formula.tex, page: formula.page || block?.page || 0, blockID: block?.id || "" };
    });
  }
  const LATEX_SIMPLE_ESCAPE_COMMANDS = new Set([
    "nu", "nabla", "neq", "neg", "not", "notag", "notin", "nexists", "natural", "nobreakspace", "nobreakdash", "noalign", "nonumber", "nonumberline", "norm", "normalfont", "newcommand", "newenvironment", "newtheorem", "nocite", "numberwithin", "ne", "ncong", "ngeq", "ngeqq", "ngeqslant", "ngtr", "nleq", "nleqq", "nleqslant", "nless", "nmid", "nparallel", "nprec", "npreceq", "nrightarrow", "nRightarrow", "nsubset", "nsubseteq", "nsucc", "nsucceq", "nsupset", "nsupseteq", "ntriangleleft", "ntrianglelefteq", "ntriangleright", "ntrianglerighteq",
    "rho", "right", "rangle", "rbrace", "rceil", "rfloor", "rvert", "rVert", "ref", "relax", "renewcommand", "renewenvironment", "renewtheorem", "raisebox", "raggedleft", "raggedright", "roman", "rm", "rmfamily", "rule", "root", "rotatebox", "resizebox", "rightarrow", "rightharpoonup", "rightharpoondown", "rightleftarrows", "rightleftharpoons",
    "text", "textbf", "textit", "textrm", "textsf", "texttt", "textsl", "textsc", "textmd", "textup", "textnormal", "textstyle", "textcolor", "textwidth", "textheight", "textsuperscript", "textsubscript", "theoremstyle", "thispagestyle", "thanks", "title", "tableofcontents",
    "tau", "theta", "tilde", "times", "top", "to", "tfrac", "tbinom", "tag", "tan", "tanh", "tiny", "thinspace", "thickspace", "today", "triangle", "triangledown", "triangleleft", "triangleright", "tt", "ttfamily", "twocolumn", "typeout", "toprule", "midrule", "bottomrule"
  ]);
  function isLatexSimpleEscape(text: string, index: number): boolean {
    const next = text[index + 1];
    if (next === "b" || next === "f") return /[a-zA-Z]/.test(text[index + 2] || "");
    if (!["n", "r", "t"].includes(next)) return false;
    const command = text.slice(index + 1).match(/^([a-zA-Z]+)/)?.[1] || "";
    return LATEX_SIMPLE_ESCAPE_COMMANDS.has(command);
  }
  export function repairInvalidJsonEscapes(value: string): string {
    const text = String(value || "");
    const validSimple = new Set(["\"", "\\", "/", "b", "f", "n", "r", "t"]);
    let output = "";
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (character !== "\\") {
        output += character;
        continue;
      }
      const next = text[index + 1];
      if (next && validSimple.has(next)) {
        if (isLatexSimpleEscape(text, index)) {
          output += "\\\\";
        } else {
          output += character + next;
          index++;
        }
      } else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6))) {
        output += text.slice(index, index + 6);
        index += 5;
      } else {
        output += "\\\\";
      }
    }
    return output;
  }
  export function extractJsonObject(value: string): Record<string, unknown> {
    const text = String(value || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const candidates = [text]; const start = text.indexOf("{"); const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
    let last: unknown = null;
    for (const candidate of candidates) {
      const repaired = repairInvalidJsonEscapes(candidate);
      const variants = repaired !== candidate ? [repaired, candidate] : [candidate];
      for (const variant of variants) {
        try { return JSON.parse(variant) as Record<string, unknown>; } catch (error) { last = error; }
      }
    }
    throw new PortError("MODEL_PROTOCOL", "模型返回内容无法解析，请稍后重试", { retryable: true, detail: { cause: String((last as Error)?.message || last || "") } });
  }
  export function blockPayload(record: LayoutTranslationRecord): Record<string, unknown> { return { id: record.blockID, type: record.type, page: record.page, order: record.order, text: record.sourceText }; }
  export function formulaPayload(record: FormulaContextRecord): Record<string, unknown> { return { id: record.formulaID, tex: record.tex, page: record.page, block_id: record.blockID }; }
  export function normalizeFormulaTex(value: string): string { return stripTexWrappers(String(value || "")).replace(/\u0000/g, "").trim(); }
  export function targetExpectsCjk(language: string): boolean { return /中文|Chinese|日本語|Japanese|한국어|Korean/i.test(String(language || "")); }
  export function cjkCount(value: string): number { return (String(value || "").match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length; }
  export function latinCount(value: string): number { return (String(value || "").match(/[A-Za-z]/g) || []).length; }
  export function normalizedCompareText(value: string): string { return String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, "").replace(/[\p{P}\p{S}]/gu, ""); }
  export function sourceEquationNumbers(value: string): string[] { return [...String(value || "").matchAll(/\((\d+(?:\.\d+)*)\)/g)].map(match => match[1]); }
  export function repairEquationReferenceTranslation(source: string, translated: string): string {
    let output = String(translated || "");
    for (const number of sourceEquationNumbers(source)) if (!output.includes(`(${number})`)) output += ` (${number})`;
    return output.trim();
  }
  export function affiliationLikeText(value: string): boolean { return /\b(university|institute|department|laboratory|school|college|hospital)\b|大学|学院|研究所|实验室/i.test(String(value || "")); }
  export function authorBylineLikeText(value: string): boolean {
    const text = String(value || "").trim();
    return text.length < 260 && /(?:\b[A-Z][a-z]+\s+[A-Z][a-z]+\b|\borcid\b|\*|†|‡)/i.test(text) && !/[.!?。！？]\s*$/.test(text);
  }
  export function shouldCheckTranslation(record: LayoutTranslationRecord): boolean { return Boolean(record.sourceText.trim()) && !authorBylineLikeText(record.sourceText) && !affiliationLikeText(record.sourceText); }
  export function visibleTextLength(value: string): number { return normalizedCompareText(String(value || "").replace(/\$[^$]*\$|\\\[[\s\S]*?\\\]/g, "")).length; }
  export function looksOverexpanded(record: LayoutTranslationRecord): boolean {
    const source = Math.max(1, visibleTextLength(record.sourceText)), translated = visibleTextLength(record.translatedText);
    return translated > Math.max(120, source * 5.5);
  }
  export function looksUntranslated(record: LayoutTranslationRecord, targetLanguage: string): boolean {
    if (!record.translatedText.trim()) return true;
    if (!shouldCheckTranslation(record)) return false;
    const same = normalizedCompareText(record.sourceText) === normalizedCompareText(record.translatedText);
    if (record.type === "title") {
      return targetExpectsCjk(targetLanguage)
        && latinCount(record.sourceText) >= 4
        && same
        && cjkCount(record.translatedText) < 2;
    }
    if (same) return true;
    if (targetExpectsCjk(targetLanguage) && latinCount(record.translatedText) > 50 && cjkCount(record.translatedText) < Math.max(2, latinCount(record.translatedText) / 16)) return true;
    return false;
  }
  export function suspiciousDuplicateTranslationRecords(records: LayoutTranslationRecord[]): LayoutTranslationRecord[] {
    const bad: LayoutTranslationRecord[] = [];
    for (let i = 1; i < records.length; i++) {
      const previous = normalizedCompareText(records[i - 1].translatedText), current = normalizedCompareText(records[i].translatedText);
      if (previous.length > 24 && previous === current && normalizedCompareText(records[i - 1].sourceText) !== normalizedCompareText(records[i].sourceText)) bad.push(records[i - 1]);
    }
    return bad;
  }
  export function recordsNeedingRetry(records: LayoutTranslationRecord[], targetLanguage: string): LayoutTranslationRecord[] {
    const bad = records.filter(record => looksUntranslated(record, targetLanguage) || looksOverexpanded(record) || Boolean(inlineFormulaRetryIssue(record.sourceText, record.translatedText)));
    return [...new Map([...bad, ...suspiciousDuplicateTranslationRecords(records)].map(record => [record.blockID, record])).values()];
  }
  export function repairRecordTranslation(record: LayoutTranslationRecord): LayoutTranslationRecord {
    return { ...record, translatedText: repairEquationReferenceTranslation(record.sourceText, neutralizeBrokenInlineTex(normalizeMathComparisonEntities(record.translatedText))).trim() };
  }
  export function repairRecordTranslations(records: LayoutTranslationRecord[]): LayoutTranslationRecord[] { return records.map(repairRecordTranslation); }
  export function applyFormulaReplacements(document: NormalizedDocument, replacements: Record<string, string>): number {
    let changed = 0;
    for (const formula of document.formulas) {
      const value = normalizeFormulaTex(replacements[formula.id] || "");
      if (value && value !== formula.tex) { formula.tex = value; changed++; }
    }
    return changed;
  }
  export function buildGlobalGuide(records: LayoutTranslationRecord[], targetLanguage: string): string {
    return `Translate all blocks into ${targetLanguage}. Preserve ids, visual layout block boundaries, formulas, citations, names, affiliations and block order. Each block maps to an exact physical layout box; do not complete a split fragment with text from another block, and never migrate or merge content across blocks.`;
  }
  export function buildTranslationPrompt(records: LayoutTranslationRecord[], targetLanguage: string, referenceContext = ""): string {
    return [
      buildGlobalGuide(records, targetLanguage),
      'Return JSON: {"translations":[{"id":"...","text":"..."}]}',
      referenceContext ? `Reference context:\n${referenceContext}` : "",
      `Blocks:\n${JSON.stringify(records.map(blockPayload))}`
    ].filter(Boolean).join("\n\n");
  }
  export function splitRecords(records: LayoutTranslationRecord[], maxChars = 0, maxBlocks = 0): LayoutTranslationRecord[][] {
    if (maxChars <= 0 && maxBlocks <= 0) return records.length ? [[...records]] : [];
    const groups: LayoutTranslationRecord[][] = []; let current: LayoutTranslationRecord[] = [], chars = 0;
    for (const record of records) {
      const overflowChars = maxChars > 0 && current.length && chars + record.sourceText.length > maxChars;
      const overflowBlocks = maxBlocks > 0 && current.length >= maxBlocks;
      if (overflowChars || overflowBlocks) { groups.push(current); current = []; chars = 0; }
      current.push(record); chars += record.sourceText.length;
    }
    if (current.length) groups.push(current); return groups;
  }
}
