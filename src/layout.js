(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const U = LitMTrans.Utils;
  const M = LitMTrans.Markdown;
  const C = LitMTrans.Constants;
  const P = LitMTrans.PortedCore || {};
  const Asset = LitMTrans.MinerUAsset;
  const DEFAULT_LAYOUT_CONCURRENCY = 3;
  const DEEPSEEK_FAST_LAYOUT_TARGET_CHARS = 2000;
  const DEEPSEEK_FAST_LAYOUT_MIN_BODY_CHARS = 500;
  const DEEPSEEK_FAST_LAYOUT_SOFT_OVERFLOW_CHARS = 500;
  const DEEPSEEK_FAST_LAYOUT_CONCURRENCY = 100;
  const DEEPSEEK_FAST_LAYOUT_WARMUP_REQUESTS = 2;
  const DEEPSEEK_FAST_LAYOUT_MIN_CACHE_HIT_RATE = .5;
  const DEEPSEEK_FAST_LAYOUT_RETRY_MIN_CACHE_HIT_RATE = .6;
  const DEEPSEEK_FAST_CACHE_PROTECTION_ERROR_PREFIX = "DEEPSEEK_FAST_CACHE_PROTECTION:";
  // Long-running reasoning is normal for a layout group. Its lifetime is
  // user-controlled, including when a model emits no visible thinking tokens.
  const LAYOUT_REQUEST_TIMEOUT = 0;
  const LAYOUT_FIRST_EVENT_TIMEOUT = 0;
  const LAYOUT_INACTIVITY_TIMEOUT = 0;
  // Isolated, geometry-only recovery for stable single-column papers. Keep
  // this preference separate from the established body classifier so it can
  // be disabled without changing the normal multi-column path.
  const SINGLE_COLUMN_MIN_WIDTH_RATIO = .72;
  const SINGLE_COLUMN_MIN_HEIGHT_RATIO = .025;
  const SINGLE_COLUMN_MIN_SOURCE_LINES = 3;
  const SINGLE_COLUMN_LEFT_TOLERANCE_RATIO = .045;
  const SINGLE_COLUMN_RIGHT_TOLERANCE_RATIO = .055;
  const SINGLE_COLUMN_MIN_SUPPORTING_PAGES = 2;
  const SINGLE_COLUMN_MIN_SUPPORTING_BLOCKS = 3;
  const SINGLE_COLUMN_MIN_SHORT_WIDTH_TO_LANE_RATIO = .20;

  function singleColumnBodyPromotionEnabled() {
    return Boolean(U.getPref("layoutSingleColumnBodyPromotion", true));
  }

  function layoutConcurrencyLimit(provider, baseURL = "") {
    const limit = LitMTrans.LLMInternals?.providerConcurrencyLimit?.(
      provider,
      DEFAULT_LAYOUT_CONCURRENCY,
      baseURL
    );
    return Math.max(1, Math.trunc(Number(limit) || DEFAULT_LAYOUT_CONCURRENCY));
  }

  function isOfficialDeepSeekConfig(settings = {}) {
    const helper = LitMTrans.LLMInternals?.isOfficialDeepSeekProvider;
    if (typeof helper === "function") return helper(settings.provider, settings.baseURL);
    return String(settings.provider || "").trim().toLowerCase() === "deepseek"
      && /(?:^|:\/\/)api\.deepseek\.com(?:[/:]|$)/i.test(String(settings.baseURL || "").trim());
  }

  function stripMarkdownImages(markdown) {
    return String(markdown || "")
      .replace(/!\[[^\]]*\]\([^\n)]*\)/g, "")
      .replace(/<img\b[^>]*>/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function completeJSONObjectCandidates(text) {
    let source = String(text || "").trim();
    source = source
      .replace(/^```(?:text|jsonl|ndjson|json)?[^\S\r\n]*(?:\r?\n)?/i, "")
      .replace(/(?:\r?\n)?```\s*$/i, "")
      .trim();
    const candidates = [];
    const starts = [];
    let inString = false;
    let escaped = false;
    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      if (!starts.length) {
        if (char === "{") starts.push(index);
        continue;
      }
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === "{") starts.push(index);
      else if (char === "}") {
        const start = starts.pop();
        candidates.push(source.slice(start, index + 1));
      }
    }
    return candidates;
  }

  function normalizedMarkdownSearchText(text) {
    return String(text || "")
      .replace(/<[^>]+>/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
  }

  function markdownRecordPositions(records, markdown) {
    const source = normalizedMarkdownSearchText(markdown);
    const positions = new Map();
    let cursor = 0;
    for (const record of records || []) {
      const needle = normalizedMarkdownSearchText(record?.text);
      if (needle.length < 12) continue;
      const start = source.indexOf(needle, cursor);
      if (start < 0) continue;
      positions.set(record.id, [start, start + needle.length]);
      cursor = start + needle.length;
    }
    return positions;
  }

  function recordFinishesSentence(record) {
    const text = String(record?.text || "").replace(/(?:<\/?(?:sup|sub)\b[^>]*>|\s)+$/gi, "");
    return /(?:[.!?。！？]|[)）\]]\s*[.!?。！？])$/.test(text);
  }

  function fastLayoutKind(record) {
    if (record?.type === "text" || record?.type === "ref_text") return "body";
    if (["table_caption", "chart_caption", "image_caption", "image_footnote"].includes(record?.type)) return "caption";
    if (record?.type === "table_footnote") return "table-note";
    return record?.type || "unknown";
  }

  // Treat model output as untrusted transport data. A JSON string containing
  // `\boldsymbol` instead of `\\boldsymbol` is valid JSON, but `\b` becomes
  // U+0008 and must never be handed to the DOM renderer.
  function hasUnsafeControlCharacters(value) {
    for (const character of String(value || "")) {
      const code = character.codePointAt(0);
      if (code === 9 || code === 10 || code === 13) continue;
      if (code < 32 || (code >= 0xD800 && code <= 0xDFFF)) return true;
    }
    return false;
  }

  function sanitizeModelText(value) {
    let output = "";
    for (const character of String(value || "")) {
      const code = character.codePointAt(0);
      if (code === 9 || code === 10 || code === 13 || (code >= 32 && !(code >= 0xD800 && code <= 0xDFFF))) {
        output += character;
      }
    }
    return output;
  }

  function acceptedModelText(value, sanitizeUnsafe = false, allowSanitized = false) {
    const raw = String(value || "");
    if (!hasUnsafeControlCharacters(raw)) return raw;
    if (allowSanitized) return sanitizeModelText(raw);
    return null;
  }

  function validBBox(value) {
    if (!Array.isArray(value) || value.length < 4) return null;
    const numbers = value.slice(0, 4).map(Number);
    if (numbers.some(number => !Number.isFinite(number))) return null;
    if (numbers[2] <= numbers[0] || numbers[3] <= numbers[1]) return null;
    return numbers;
  }

  function spanText(span) {
    if (!span || typeof span !== "object") return "";
    return String(span.content ?? span.text ?? span.value ?? "");
  }

  function lineText(line) {
    const spans = Array.isArray(line?.spans) ? line.spans : [];
    return spans.map(spanText).join("").trim();
  }

  function blockText(block) {
    const lines = Array.isArray(block?.lines) ? block.lines : [];
    return lines.map(lineText).filter(Boolean).join("\n").trim();
  }


  // MinerU can emit an entire contents page inside one text span, so preserve
  // embedded newlines instead of treating the parser line as one visual row.
  function layoutLogicalLines(lines) {
    if (!Array.isArray(lines)) return [];
    const output = [];
    for (const line of lines) {
      if (!line || typeof line !== "object") continue;
      const fragments = (Array.isArray(line.spans) ? line.spans : [])
        .filter(span => span && typeof span === "object" && spanText(span))
        .map(spanText);
      if (!fragments.length) continue;
      output.push(...fragments.join("").replace(/\r\n?/g, "\n").split("\n"));
    }
    return output;
  }

  function layoutVisualLineCount(lines) {
    const parserLineCount = Array.isArray(lines) ? lines.filter(Boolean).length : 0;
    const logicalLineCount = layoutLogicalLines(lines)
      .filter(line => String(line || "").trim()).length;
    return Math.max(1, parserLineCount, logicalLineCount);
  }

  const TOC_ENTRY_RE = /^\s*(\d+(?:\.\d+)*\.?)\s+(.+?)\s*(?:\.{2,}|…{2,}|·{2,}|-{3,})\s*(\d+|[ivxlcdm]+)\s*$/i;

  function parseTocLogicalLines(logicalLines) {
    const entries = [];
    let nonblank = 0;
    for (const rawLine of logicalLines || []) {
      const text = String(rawLine || "").replace(/\s+/g, " ").trim();
      if (!text) {
        entries.push({ gap: true });
        continue;
      }
      nonblank++;
      const match = text.match(TOC_ENTRY_RE);
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

  function parseTocRows(lines) {
    return parseTocLogicalLines(layoutLogicalLines(lines));
  }

  function parseTocTextRows(text) {
    return parseTocLogicalLines(String(text || "").replace(/\r\n?/g, "\n").split("\n"));
  }


  // trim() on individual lines: leading whitespace is semantic in source code.
  function codeTextFromBlock(block) {
    const codeLines = [];
    const visit = value => {
      if (!value || typeof value !== "object") return;
      for (const line of Array.isArray(value.lines) ? value.lines : []) {
        if (!line || typeof line !== "object") continue;
        codeLines.push((Array.isArray(line.spans) ? line.spans : []).map(spanText).join(""));
      }
      for (const child of Array.isArray(value.blocks) ? value.blocks : []) visit(child);
    };
    visit(block);
    return codeLines.join("\n").replace(/^\n+|\n+$/g, "");
  }

  function delimitedLayoutTeX(content, display = false) {
    let raw = String(content || "").trim();
    if (!raw) return "";
    const wrapped = raw.match(/^\\\[([\s\S]*?)\\\]$|^\\\(([\s\S]*?)\\\)$|^\$\$([\s\S]*?)\$\$$|^\$([\s\S]*?)\$$/);
    if (wrapped) raw = String(wrapped[1] ?? wrapped[2] ?? wrapped[3] ?? wrapped[4] ?? "").trim();
    return display ? `\\[${raw}\\]` : `\\(${raw}\\)`;
  }

  function layoutSpansToTranslationText(spans) {
    if (!Array.isArray(spans)) return "";
    return spans.map(fragment => {
      if (!fragment || typeof fragment !== "object") return "";
      const type = String(fragment.type || "").toLowerCase();
      const content = spanText(fragment);
      if (!content) return "";
      if (["equation_inline", "inline_equation"].includes(type)) return delimitedLayoutTeX(content, false);
      if (["equation_block", "block_equation"].includes(type)) return delimitedLayoutTeX(content, true);
      return safeLayoutTextToHTML(content);
    }).join("");
  }

  function isSymbolGlossaryBlock(block) {
    if (!block || String(block.type || "").toLowerCase() !== "text") return false;
    if (block._layout_symbol_glossary === true) return true;
    const lines = Array.isArray(block.lines) ? block.lines.filter(line => line && typeof line === "object") : [];
    if (lines.length < 8) return false;
    const matched = [];
    let nonempty = 0;
    for (const line of lines) {
      const spans = (Array.isArray(line.spans) ? line.spans : []).filter(span => span && typeof span === "object" && spanText(span).trim());
      if (!spans.length) continue;
      nonempty++;
      const first = spans[0];
      const type = String(first.type || "").toLowerCase();
      const symbolBox = validBBox(first.bbox);
      if (!/(?:equation|formula)/.test(type) || !symbolBox || spanText(first).trim().length > 64) continue;
      const definition = spans.slice(1).find(span => String(span.type || "").toLowerCase() === "text" && validBBox(span.bbox));
      const definitionBox = validBBox(definition?.bbox);
      if (!definitionBox || definitionBox[0] - symbolBox[0] < 16) continue;
      matched.push([symbolBox[0], definitionBox[0]]);
    }
    if (nonempty < 8 || matched.length * 5 < nonempty * 4) return false;
    const symbolLeft = matched.map(row => row[0]);
    const definitionLeft = matched.map(row => row[1]);
    return Math.max(...symbolLeft) - Math.min(...symbolLeft) <= 14
      && Math.max(...definitionLeft) - Math.min(...definitionLeft) <= 20;
  }

  function symbolGlossaryMarkers(block) {
    const markers = [];
    for (const line of Array.isArray(block?.lines) ? block.lines : []) {
      const spans = (Array.isArray(line?.spans) ? line.spans : []).filter(span => span && typeof span === "object" && spanText(span).trim());
      const first = spans[0];
      if (!first || !/(?:equation|formula)/.test(String(first.type || "").toLowerCase())) continue;
      const formula = spanText(first).trim();
      if (formula) markers.push(`\\(${formula}\\)`);
    }
    return markers;
  }

  // Preserve TeX delimiters in formula spans while removing renderer-only HTML
  // before sending text to the model. This differs from the display path,
  // which turns TeX into KaTeX markup immediately.
  function plainBlockText(block) {
    const html = (Array.isArray(block?.lines) ? block.lines : [])
      .map(line => layoutSpansToTranslationText(line?.spans))
      .filter(Boolean)
      .join(isSymbolGlossaryBlock(block) ? "\n\n" : "\n");
    const preserved = html.replace(/<\/?(?:sup|sub)\b[^>]*>/gi, match => match);
    return sanitizeModelText(preserved.replace(/<(?!\/?(?:sup|sub)\b)[^>]+>/gi, "").trim());
  }

  function restoreSymbolGlossaryRowBreaks(record, translatedText) {
    let output = String(translatedText || "");
    if (!record?.symbolGlossary || /\r|\n/.test(output)) return output;
    const markers = Array.isArray(record.symbolMarkers) ? record.symbolMarkers : [];
    if (markers.length < 8) return output;
    const positions = [];
    let cursor = 0;
    for (const marker of markers) {
      const position = output.indexOf(marker, cursor);
      if (position < 0) continue;
      positions.push(position);
      cursor = position + marker.length;
    }
    if (positions.length * 5 < markers.length * 4) return output;
    for (let index = positions.length - 1; index >= 1; index--) {
      output = `${output.slice(0, positions[index])}\n\n${output.slice(positions[index])}`;
    }
    return output;
  }

  function symbolGlossaryParagraphs(item) {
    if (!item?.symbolGlossary || !String(item.translatedText || "").trim()) return [];
    const translatedRows = String(item.translatedText).split(/\r?\n\s*\r?\n+/).map(row => row.trim()).filter(Boolean);
    if (translatedRows.length < 2) return [];
    const sourceHTMLRows = String(item.html || "").split(/<br\s*\/?\s*>/i).map(row => row.trim()).filter(Boolean);
    const sourceTextRows = String(item.text || "").split(/\r?\n/).map(row => row.trim()).filter(Boolean);
    return translatedRows.map((translatedText, index) => ({
      parts: [{
        ...item,
        html: sourceHTMLRows[index] || "",
        text: sourceTextRows[index] || "",
        translatedText
      }],
      indent: 0
    }));
  }

  function normalizeCompareText(text) {
    return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function visibleTextLength(text) {
    return String(text || "")
      .replace(/&(?:amp;)?(?:lt|gt);/gi, " ")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, "")
      .length;
  }

  // Character mix alone does not prove that a translation failed.
  function cjkCount(text) {
    return (String(text || "").match(/[\u4e00-\u9fff]/g) || []).length;
  }

  function latinCount(text) {
    return (String(text || "").match(/[A-Za-z]/g) || []).length;
  }

  function targetExpectsCJK(language) {
    const value = String(language || "").toLowerCase();
    return ["中文", "汉语", "chinese", "zh", "简体", "繁体"].some(token => value.includes(token));
  }

  function affiliationLikeText(text) {
    const normalized = normalizeCompareText(text);
    if (!normalized) return false;
    const tokens = ["department", "university", "institute of technology", "faculty", "laboratory", "college", "〒", "japan", "china"];
    return tokens.some(token => normalized.includes(token))
      && !/\b(fig|figure|table|we|this|the|water|shock)\b/i.test(normalized);
  }

  function authorBylineLikeText(text) {
    const source = String(text || "");
    const superscripts = source.match(/<sup>.*?<\/sup>/gis) || [];
    if (superscripts.length < 3) return false;
    const names = source.match(/\b[A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+)+\b/g) || [];
    return names.length >= 3;
  }

  function bibliographyLikeText(text) {
    const source = String(text || "").trim();
    if (!source) return false;
    if (/https?:\/\/\S+/i.test(source)) return true;
    const hasDOI = /\b10\.\d{4,9}\/\S+/i.test(source);
    const hasYear = /[([](?:19|20)\d{2}[)\]]/.test(source);
    const hasPublication = /\b(?:J\.|Journal|Phys\.|Proc\.|Proceedings|Conf\.|Rev\.|Vol\.|Appl\.)\b/i.test(source);
    return hasDOI && (hasYear || hasPublication);
  }

  function shouldCheckTranslation(record) {
    if (!CHECK_TRANSLATED_TYPES.has(String(record?.type || ""))) return false;
    if (
      record.type === "text"
      && (
        affiliationLikeText(record.text)
        || authorBylineLikeText(record.text)
        || bibliographyLikeText(record.text)
      )
    ) return false;
    return true;
  }

  const CHECK_TRANSLATED_TYPES = new Set(["title", "text", "table_caption", "table_footnote", "chart_caption", "image_caption", "image_footnote"]);

  function looksOverexpanded(record, translatedText, targetLanguage = "") {
    if (!CHECK_TRANSLATED_TYPES.has(String(record?.type || ""))) return false;
    const sourceText = String(record?.text || "");
    const sourceSize = visibleTextLength(sourceText);
    const translatedSize = visibleTextLength(translatedText);
    if (sourceSize < 16) return false;

    const sourceIsCJK = cjkCount(sourceText) > (latinCount(sourceText) || 0);
    const targetIsCJK = targetExpectsCJK(targetLanguage) || (cjkCount(translatedText) > (latinCount(translatedText) || 0));

    // CJK source translated into Latin/alphabetic target naturally expands 3.5x-5x in character length.
    if (sourceIsCJK && !targetIsCJK) {
      return translatedSize > Math.max(160, sourceSize * 7);
    }

    return sourceSize >= 24 && translatedSize > Math.max(80, sourceSize * 2);
  }

  function looksUntranslated(record, translatedText, targetLanguage) {
    if (!shouldCheckTranslation(record)) return false;
    const source = String(record?.text || "").trim();
    const translated = String(translatedText || "").trim();
    if (!source) return false;

    // CJK source to non-CJK target: only flag when source is predominantly Chinese and returned unchanged.
    if (!targetExpectsCJK(targetLanguage)) {
      if (!translated) return true;
      const sourceCJK = cjkCount(source);
      const sourceLatin = latinCount(source);
      const same = normalizeCompareText(source) === normalizeCompareText(translated);
      return same && sourceCJK >= 4 && sourceCJK > sourceLatin;
    }

    // Preserve 100% of established English-to-Chinese logic to avoid regressions on short technical tokens.
    const sourceLatin = latinCount(source);
    if (String(record?.type || "") === "title") {
      return sourceLatin >= 4
        && normalizeCompareText(source) === normalizeCompareText(translated)
        && cjkCount(translated) < 2;
    }
    if (sourceLatin < 60) return false;
    if (normalizeCompareText(source) === normalizeCompareText(translated)) return true;
    return cjkCount(translated) < 8 && latinCount(translated) >= Math.max(60, sourceLatin * 0.45);
  }

  const RETRY_REASON_DESCRIPTIONS = {
    missing: "The block ID was missing in the previous JSON response.",
    "unsafe-characters": "The previous output contained forbidden JSON control characters or unescaped TeX backslash artifacts.",
    untranslated: "The block text appeared untranslated.",
    overexpanded: "The translation text over-expanded far beyond layout boundaries.",
    duplicate: "The output duplicated text from a neighboring block ID.",
    "formula-structure": "Inline formulas or LaTeX TeX syntax/delimiters were altered or broken."
  };

  function retryDetailsForRecord(record, translations, reasons = []) {
    const translation = translations?.[record?.id] || "";
    return (reasons || [])
      .map(reason => reason === "formula-structure"
        ? (M.mathMissingFormulaRetryIssue(record?.text, translation) || RETRY_REASON_DESCRIPTIONS[reason])
        : (RETRY_REASON_DESCRIPTIONS[reason] || String(reason)))
      .join("; ");
  }

  function isFormatOnlyRetryReasons(reasons) {
    return Boolean(reasons?.length) && reasons.every(reason => (
      reason === "formula-structure" || reason === "unsafe-characters"
    ));
  }

  function classifyRetryRecords(records, translations, targetLanguage, enableUntranslatedCheck = false) {
    const reasonsByID = new Map();
    const add = (record, reason) => {
      if (!record) return;
      if (!reasonsByID.has(record.id)) reasonsByID.set(record.id, new Set());
      reasonsByID.get(record.id).add(reason);
    };
    for (const record of records) {
      // The model must return every requested ID. This is an objective
      // protocol failure, unlike guessing whether an otherwise valid answer
      // was translated from its character mix.
      if (!translations[record.id]) add(record, "missing");
      if (hasUnsafeControlCharacters(translations[record.id])) add(record, "unsafe-characters");
      if (enableUntranslatedCheck && looksUntranslated(record, translations[record.id], targetLanguage)) {
        add(record, "untranslated");
      }
      if (looksOverexpanded(record, translations[record.id], targetLanguage)) add(record, "overexpanded");
    }
    for (let index = 1; index < records.length; index++) {
      const previous = records[index - 1];
      const current = records[index];
      const previousText = normalizeCompareText(translations[previous.id]);
      const currentText = normalizeCompareText(translations[current.id]);
      if (
        previousText.length >= 80
        && previousText === currentText
        && normalizeCompareText(previous.text) !== normalizeCompareText(current.text)
      ) add(previous, "duplicate");
    }
    for (const record of records) {
      if (!translations[record.id]) continue;
      if (M.mathMissingFormulaRetryIssue(record.text, translations[record.id])) add(record, "formula-structure");
    }
    return records
      .filter(record => reasonsByID.has(record.id))
      .map(record => {
        const reasons = [...reasonsByID.get(record.id)];
        return {
          record,
          reasons,
          details: retryDetailsForRecord(record, translations, reasons)
        };
      });
  }

  function recordsNeedingRetry(records, translations, targetLanguage, enableUntranslatedCheck = false) {
    return classifyRetryRecords(records, translations, targetLanguage, enableUntranslatedCheck).map(item => item.record);
  }

  function retryReasonSummary(classified) {
    const counts = {
      missing: 0,
      untranslated: 0,
      overexpanded: 0,
      duplicate: 0,
      "formula-structure": 0,
      "unsafe-characters": 0
    };
    for (const item of classified || []) {
      for (const reason of item.reasons || []) {
        if (Object.prototype.hasOwnProperty.call(counts, reason)) counts[reason]++;
      }
    }
    return (
      `真正缺失 ${counts.missing}、疑似未译 ${counts.untranslated}、` +
      `越界扩写 ${counts.overexpanded}、错位重复 ${counts.duplicate}、` +
      `公式内容/定界符异常 ${counts["formula-structure"]}、非法控制字符 ${counts["unsafe-characters"]}`
    );
  }

  function untranslatedOrMissingRecords(records, translations, targetLanguage, enableUntranslatedCheck = false) {
    return records.filter(record =>
      !translations[record.id]
      || (enableUntranslatedCheck && looksUntranslated(record, translations[record.id], targetLanguage))
    );
  }

  function unsafeOverexpandedRecords(records, translations, targetLanguage = "") {
    return records.filter(record =>
      Boolean(translations[record.id]) && looksOverexpanded(record, translations[record.id], targetLanguage)
    );
  }

  function suspiciousDuplicateTranslationRecords(records, translations) {
    const output = [];
    for (let index = 1; index < records.length; index++) {
      const previous = records[index - 1];
      const current = records[index];
      const previousText = normalizeCompareText(translations[previous.id]);
      const currentText = normalizeCompareText(translations[current.id]);
      if (
        previousText.length >= 80
        && previousText === currentText
        && normalizeCompareText(previous.text) !== normalizeCompareText(current.text)
      ) output.push(previous);
    }
    return output;
  }

  function sourceEquationNumbers(text) {
    const output = [];
    const source = String(text || "");
    const references = source.match(/\b(?:Eq|Eqs|Equation|Equations)\.?\s+(?:(?![.;。；]\s).){0,120}[（(]\s*[A-Za-z]?\d+[A-Za-z]?\s*[)）]/gi) || [];
    for (const reference of references) {
      for (const match of reference.matchAll(/[（(]\s*([A-Za-z]?\d+[A-Za-z]?)\s*[)）]/g)) {
        if (!output.includes(match[1])) output.push(match[1]);
      }
    }
    return output;
  }

    function repairEquationReferenceTranslation(sourceText, translatedText) {
    let result = String(translatedText || "").replace(/(?<![A-Za-z0-9])(?:[~～〜]\s*)([A-Za-z]?\d+[A-Za-z]?|[a-z])\s*[!！](?![A-Za-z0-9])/g, "($1)");
    for (const number of sourceEquationNumbers(sourceText)) {
      const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result.replace(new RegExp(`(?:[~～〜]\\s*)?${escaped}\\s*[!！]`, "g"), `式 (${number})`);
      result = result.replace(new RegExp(`(?<![A-Za-z0-9])式\\s*${escaped}(?![A-Za-z0-9])`, "g"), `式 (${number})`);
      result = result.replace(new RegExp(`(?<![A-Za-z0-9])方程\\s*${escaped}(?![A-Za-z0-9])`, "g"), `方程 (${number})`);
    }
    return result
      .replace(/(?:方程|公式)\s*[。.]\s*(式\s*\()/g, "$1")
      .replace(/\)\s*(和|与|及)\s*式/g, ") $1式");
  }

  function normalizeWebMachineRecord(record, translatedText) {
    let output = M.normalizeTranslatedInlineHTML(String(translatedText || "").trim());
    if (P.normalizeMathComparisonEntities) output = P.normalizeMathComparisonEntities(output);
    if (P.neutralizeBrokenInlineTex) output = P.neutralizeBrokenInlineTex(output);
    return restoreSymbolGlossaryRowBreaks(record, repairEquationReferenceTranslation(record?.text, output));
  }

  function formulaSpans(block) {
    const output = [];
    for (const line of Array.isArray(block?.lines) ? block.lines : []) {
      for (const span of Array.isArray(line?.spans) ? line.spans : []) {
        const type = String(span?.type || "").toLowerCase();
        const content = spanText(span).trim();
        if (content && (type.includes("equation") || type.includes("formula") || type.includes("latex"))) {
          output.push(content);
        }
      }
    }
    return output;
  }

  function looksLikeDisplayFormula(text) {
    const value = String(text || "").trim();
    if (!value) return false;
    return /^\\begin\{(?:array|[pbvBV]?matrix)\}/.test(value)
      || /\\(?:frac|dfrac|tfrac|left|right|theta|rho|tag|sum|prod|int|times|quad|mathrm|mathbf)\b/.test(value);
  }

  function imagePathFromBlock(block) {
    const direct = block?.image_path || block?.img_path || block?.image || block?.src;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    for (const line of Array.isArray(block?.lines) ? block.lines : []) {
      for (const span of Array.isArray(line?.spans) ? line.spans : []) {
        const path = span?.image_path || span?.img_path || span?.src;
        if (typeof path === "string" && path.trim()) return path.trim();
      }
    }
    return "";
  }

  function inferFontSize(block, bbox, text, lineCount) {
    const height = Math.max(1, bbox[3] - bbox[1]);
    const width = Math.max(1, bbox[2] - bbox[0]);
    const type = String(block?.type || "").toLowerCase();
    let size = height / Math.max(1, lineCount || 1) * 0.72;
    const estimatedLineChars = Math.max(8, width / Math.max(4, size * 0.52));
    const estimatedLines = Math.max(1, Math.ceil(String(text || "").length / estimatedLineChars));
    if (estimatedLines > Math.max(1, lineCount || 1)) size *= Math.sqrt(Math.max(1, lineCount || 1) / estimatedLines);
    if (type === "title") size *= 1.12;
    if (type.includes("caption") || type.includes("footnote")) size *= 0.9;
    return Math.max(5.5, Math.min(type === "title" ? 28 : 18, size));
  }

  function normalizePageSize(page, blocks) {
    const size = page?.page_size;
    if (Array.isArray(size) && Number(size[0]) > 0 && Number(size[1]) > 0) return [Number(size[0]), Number(size[1])];
    const width = Number(page?.width || page?.page_width || 0);
    const height = Number(page?.height || page?.page_height || 0);
    if (width > 0 && height > 0) return [width, height];
    let maxX = 595;
    let maxY = 842;
    for (const block of blocks) {
      const bbox = validBBox(block?.bbox);
      if (bbox) {
        maxX = Math.max(maxX, bbox[2]);
        maxY = Math.max(maxY, bbox[3]);
      }
    }
    return [maxX, maxY];
  }

  function safeLayoutTextToHTML(text) {
    return U.escapeHTML(String(text || ""))
      // The workbench document is XHTML.  A bare HTML <br> makes assigning
      // this snippet to innerHTML throw NS_ERROR_DOM_SYNTAX_ERR in Gecko.
      .replace(/\n/g, "<br />")
      .replace(/&amp;lt;(\/?)(sup|sub|br)&amp;gt;/gi, "&lt;$1$2&gt;")
      .replace(/&amp;lt;br\s*\/&amp;gt;/gi, "&lt;br/&gt;")
      .replace(/&lt;(sup|sub|br)&gt;/gi, "<$1>")
      .replace(/&lt;\/(sup|sub|br)&gt;/gi, "</$1>")
      .replace(/&lt;(br)\s*\/&gt;/gi, "<$1 />");
  }

  function layoutSpansToHTML(spans) {
    if (!Array.isArray(spans)) return "";
    return spans.map(fragment => {
      if (!fragment || typeof fragment !== "object") return "";
      const type = String(fragment.type || "").toLowerCase();
      const content = spanText(fragment);
      if (!content) return "";
      if (["equation_inline", "inline_equation"].includes(type)) return M.renderTeX(content, false);
      if (["equation_block", "block_equation"].includes(type)) return M.renderTeX(content, true);
      return safeLayoutTextToHTML(content);
    }).join("");
  }

  function layoutLinesToHTML(lines, reflow = false) {
    if (!Array.isArray(lines)) return "";
    const rendered = [];
    const plain = [];
    for (const line of lines) {
      if (!line || typeof line !== "object") continue;
      const html = layoutSpansToHTML(line.spans).trim();
      if (!html) continue;
      rendered.push(html);
      plain.push(String(lineText(line) || "").trim());
    }
    if (!reflow) return rendered.join("<br />");
    if (!rendered.length) return "";
    const parts = [rendered[0]];
    for (let index = 1; index < rendered.length; index++) {
      const previous = plain[index - 1].trimEnd();
      const current = plain[index].trimStart();
      if (/[-−–]$/.test(previous)) {
        if (/^[a-z]/.test(current)) {
          parts[parts.length - 1] = parts[parts.length - 1]
            .replace(/[-−–](\s*(?:<\/(?:span|sup|sub|em|strong|i|b)>)*\s*)$/i, "$1");
        }
      }
      else {
        parts.push(" ");
      }
      parts.push(rendered[index]);
    }
    return parts.join("");
  }

  function normalizeLayoutHTMLSnippet(value) {
    return String(value || "")
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[\s\S]*?<\/style>/gi, "")
      .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/\s(?:href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, "")
      .replace(/<eq>([\s\S]*?)<\/eq>/gi, (_match, tex) => M.renderTeX(tex, false));
  }

  function bboxWidth(bbox) {
    return Math.max(0, Number(bbox?.[2] || 0) - Number(bbox?.[0] || 0));
  }

  function bboxHeight(bbox) {
    return Math.max(0, Number(bbox?.[3] || 0) - Number(bbox?.[1] || 0));
  }

  function bboxCenter(bbox) {
    return [
      (Number(bbox?.[0] || 0) + Number(bbox?.[2] || 0)) / 2,
      (Number(bbox?.[1] || 0) + Number(bbox?.[3] || 0)) / 2
    ];
  }

  function bboxUnion(boxes) {
    const valid = (boxes || []).map(validBBox).filter(Boolean);
    if (!valid.length) return [0, 0, 0, 0];
    return [
      Math.min(...valid.map(box => box[0])),
      Math.min(...valid.map(box => box[1])),
      Math.max(...valid.map(box => box[2])),
      Math.max(...valid.map(box => box[3]))
    ];
  }

  function bboxArea(bbox) {
    return bboxWidth(bbox) * bboxHeight(bbox);
  }

  function bboxContainedOverlapRatio(inner, outer) {
    const left = Math.max(Number(inner?.[0] || 0), Number(outer?.[0] || 0));
    const top = Math.max(Number(inner?.[1] || 0), Number(outer?.[1] || 0));
    const right = Math.min(Number(inner?.[2] || 0), Number(outer?.[2] || 0));
    const bottom = Math.min(Number(inner?.[3] || 0), Number(outer?.[3] || 0));
    return Math.max(0, right - left) * Math.max(0, bottom - top) / Math.max(1, bboxArea(inner));
  }

  function medianValue(values, fallback) {
    const numbers = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!numbers.length) return fallback;
    const middle = Math.floor(numbers.length / 2);
    return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
  }

  function streamSideForBBox(bbox, pageWidth) {
    const width = bboxWidth(bbox);
    const center = (Number(bbox[0]) + Number(bbox[2])) / 2;
    if (width > pageWidth * 0.55) return "full";
    return center < pageWidth / 2 ? "left" : "right";
  }

  function estimateLayoutFontSize(blockType, bbox, text) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (!normalized) return null;
    const width = Math.max(18, bboxWidth(bbox));
    const height = Math.max(10, bboxHeight(bbox));
    const base = Math.sqrt(width * height / Math.max(1, normalized.length * 0.62));
    const type = String(blockType || "").toLowerCase();
    const multiplier = {
      title: .9, abstract: .94, abstract_title: .94, text: .94, header: .92, page_header: .92,
      author: .92, affiliation: .90, footer: .9, page_footer: .9, page_number: .88, ref_text: .98,
      table_caption: .95, chart_caption: .95, image_caption: .95, image_footnote: .92
    }[type] ?? .92;
    const limits = {
      title: [9.5, 13], abstract_title: [9.0, 12.0], abstract: [7.8, 11.5], text: [7.2, 11],
      author: [7.4, 10.5], affiliation: [7.0, 9.8], header: [7.8, 11], page_header: [7.8, 11],
      footer: [7.2, 10], page_footer: [7.2, 10], page_number: [7.2, 10],
      ref_text: [7, 9.4], table_caption: [7, 10], chart_caption: [7, 10], image_caption: [7, 10], image_footnote: [6.4, 8.8]
    }[type] || [7.2, 11];
    return Math.max(limits[0], Math.min(limits[1], base * multiplier));
  }

  function fixedLayoutFontSize(blockType) {
    return ({
      table_caption: 7.6,
      table_footnote: 7.2,
      chart_caption: 7.6,
      image_caption: 7.6,
      image_footnote: 7.2,
      text: 7.6,
    })[String(blockType || "").toLowerCase()] ?? null;
  }

  function modelBBoxToPageBBox(bbox, pageWidth, pageHeight) {
    return [
      Number(bbox[0]) * pageWidth,
      Number(bbox[1]) * pageHeight,
      Number(bbox[2]) * pageWidth,
      Number(bbox[3]) * pageHeight
    ];
  }

  function collectModelOCRBoxes(modelPage, pageWidth, pageHeight) {
    if (!Array.isArray(modelPage)) return [];
    const output = [];
    const visit = value => {
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
        return;
      }
      if (!value || typeof value !== "object") return;
      if (String(value.type || "").toLowerCase() === "ocr_text") {
        const bbox = validBBox(value.bbox);
        if (bbox) {
          output.push(Math.max(...bbox.map(Math.abs)) <= 1.5 ? modelBBoxToPageBBox(bbox, pageWidth, pageHeight) : bbox);
        }
      }
      for (const key of ["blocks", "lines", "spans", "children"]) {
        if (value[key]) visit(value[key]);
      }
    };
    visit(modelPage);
    return output;
  }

  function ocrBoxesInRegion(ocrBoxes, bbox, padding = 2) {
    const [x0, y0, x1, y1] = [
      bbox[0] - padding, bbox[1] - padding, bbox[2] + padding, bbox[3] + padding
    ];
    return (ocrBoxes || []).filter(box => {
      const [cx, cy] = bboxCenter(box);
      return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
    });
  }

  function estimateFirstLineIndent(bbox, ocrBoxes) {
    const hits = ocrBoxesInRegion(ocrBoxes, bbox, 1.5)
      .sort((a, b) => bboxCenter(a)[1] - bboxCenter(b)[1] || a[0] - b[0]);
    if (hits.length < 3) return 0;
    const firstCenter = bboxCenter(hits[0])[1];
    const typicalHeight = medianValue(hits.map(bboxHeight), 8);
    const tolerance = Math.max(2.5, Math.min(6, typicalHeight * .55));
    const firstLine = hits.filter(box => Math.abs(bboxCenter(box)[1] - firstCenter) <= tolerance);
    const later = hits.filter(box => !firstLine.includes(box));
    if (!later.length) return 0;
    const indent = Math.min(...firstLine.map(box => box[0])) - medianValue(later.map(box => box[0]), bbox[0]);
    if (indent < 5) return 0;
    return Math.round(Math.min(indent, Math.max(10, bboxWidth(bbox) * .18)) * 100) / 100;
  }

  function refinedTextBBoxFromOCR(bbox, ocrBoxes) {
    const hits = ocrBoxesInRegion(ocrBoxes, bbox, 1.5);
    if (!hits.length) return [...bbox];
    const content = bboxUnion(hits);
    return [
      Math.min(bbox[0], content[0] - 1),
      bbox[1],
      Math.max(bbox[2], content[2] + 1),
      Math.min(bbox[3], content[3] + 2)
    ];
  }

  function collectMediaCarrierBoxes(blocks) {
    const output = [];
    const visit = value => {
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
        return;
      }
      if (!value || typeof value !== "object") return;
      const type = String(value.type || "").toLowerCase();
      const children = Array.isArray(value.blocks) ? value.blocks.filter(Boolean) : [];
      const bbox = validBBox(value.bbox);
      if (bbox && (
        ["table_body", "chart_body", "image_body", "interline_equation", "equation"].includes(type)
        || (["table", "chart", "image"].includes(type) && !children.length)
      )) output.push(bbox);
      for (const child of children) visit(child);
    };
    visit(blocks);
    return output;
  }

  function isLayoutMetadataText(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    const lower = text.toLowerCase();
    return Boolean(
      /^(pacs|keywords?|doi)\s*[:：]/i.test(text)
      || /^pacs\s*(编号|号|分类号|代码|编码)?\s*[:：]/i.test(text)
      || /^(关键词|关键字|数字对象标识符)\s*[:：]/.test(text)
      || lower.startsWith("pacs numbers")
      || lower.startsWith("published under an exclusive license")
      || ["cite as:", "citation:", "submitted:", "accepted:", "published online:", "online publication:"].some(token => lower.startsWith(token))
      || lower.startsWith("authors to whom correspondence")
      || lower.startsWith("author to whom correspondence")
      || lower.includes("all rights reserved")
      || lower.includes("elsevier")
      || lower.includes("copyright")
      || /^(?:©|\(c\)|Ⓒ)/i.test(text)
    );
  }

  function looksLikeBodyProseEvidence(text, item, pageWidth, pageHeight) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    const lower = normalized.toLowerCase();
    if (!normalized || isLayoutMetadataText(normalized)) return false;
    if ([
      "articles you may be interested in", "citation:", "view online:",
      "view table of contents:", "published by "
    ].some(token => lower.startsWith(token))) return false;
    if (/https?:\/\/|www\./i.test(lower)) return false;
    const bbox = item.bbox || [0, 0, 0, 0];
    if (!["left", "right"].includes(streamSideForBBox(bbox, pageWidth))) return false;
    if (bbox[1] < pageHeight * .25) return false;
    if (Number(item.originalLineCount || 0) < 2 && bboxHeight(bbox) <= pageHeight * .025) return false;
    const words = normalized.match(/[A-Za-z][A-Za-z'-]{2,}/g) || [];
    const cjk = normalized.match(/[\u3400-\u9fff]/g) || [];
    const sentences = (normalized.match(/[.!?。！？]/g) || []).length;
    return (words.length >= 32 && normalized.length >= 180 && sentences >= 2)
      || (cjk.length >= 80 && sentences >= 2);
  }

  function isBodyTextCandidate(text, bbox, pageWidth, pageHeight) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    const lower = normalized.toLowerCase();
    if (!normalized || isLayoutMetadataText(normalized)) return false;
    if (lower.startsWith("received ") || lower.startsWith("(received ")) return false;
    if (streamSideForBBox(bbox, pageWidth) === "full") return false;
    return bbox[1] >= pageHeight * .33;
  }

  function looksLikeContinuation(previousText, currentText) {
    const previous = String(previousText || "").trim();
    const current = String(currentText || "").trim();
    if (!previous || !current || /[.!?:;]$/.test(previous)) return false;
    return /^[a-z(\[]/.test(current)
      || /^(and|or|but|with|which|that|where|when|while|whose|who|of|to)\b/i.test(current)
      || /^[,.)\]}]/.test(current);
  }

  function assignLayoutColumnKeys(items, pageWidth) {
    const candidates = items
      .map(item => [Number(item.bbox?.[0]), bboxWidth(item.bbox)])
      .filter(([left, width]) => Number.isFinite(left) && width >= pageWidth * .12 && width <= pageWidth * .82);
    if (!candidates.length) {
      for (const item of items) item.columnKey = item.side || "full";
      return;
    }
    const tolerance = Math.max(8, Math.min(20, medianValue(candidates.map(row => row[1]), pageWidth * .3) * .08));
    const anchors = [];
    for (const [left] of candidates.sort((a, b) => a[0] - b[0])) {
      if (!anchors.length || Math.abs(left - anchors[anchors.length - 1]) > tolerance) anchors.push(left);
      else anchors[anchors.length - 1] = (anchors[anchors.length - 1] + left) / 2;
    }
    for (const item of items) {
      if (!validBBox(item.bbox) || bboxWidth(item.bbox) > pageWidth * .82) {
        item.columnKey = "full";
        continue;
      }
      let nearest = 0;
      for (let index = 1; index < anchors.length; index++) {
        if (Math.abs(item.bbox[0] - anchors[index]) < Math.abs(item.bbox[0] - anchors[nearest])) nearest = index;
      }
      item.columnKey = `column-${nearest}`;
    }
  }

  function bodyColumnProfiles(items, pageWidth, pageHeight) {
    const profiles = {};
    for (const item of items) {
      if (item.kind !== "text" || item.symbolGlossary || item.fromList) continue;
      if (!looksLikeBodyProseEvidence(item.roleText || item.text, item, pageWidth, pageHeight)) continue;
      if (item.columnKey === "full") continue;
      (profiles[item.columnKey] ||= []).push([item.bbox[0] / pageWidth, item.bbox[2] / pageWidth]);
    }
    return profiles;
  }

  function matchesBodyColumnProfile(item, pageWidth, profiles) {
    const candidates = profiles?.[item.columnKey] || [];
    const left = item.bbox[0] / pageWidth;
    const right = item.bbox[2] / pageWidth;
    const width = Math.max(.001, right - left);
    return candidates.some(([refLeft, refRight]) => {
      const refWidth = Math.max(.001, refRight - refLeft);
      return Math.abs(left - refLeft) <= .10 && right <= refRight + .10 && width >= refWidth * .42;
    });
  }

  function bboxMatchesColumn(anchor, bbox) {
    const tolerance = Math.max(18, bboxWidth(anchor) * .08);
    const leftDelta = Math.abs(bbox[0] - anchor[0]);
    const rightDelta = Math.abs(bbox[2] - anchor[2]);
    if (leftDelta <= tolerance && rightDelta <= tolerance) return true;
    return leftDelta <= tolerance && bbox[2] <= anchor[2] + tolerance && bboxWidth(bbox) >= bboxWidth(anchor) * .45;
  }

  function isEarlyFrontMatterItem(item, pageHeight, hasPreviousBody) {
    return !hasPreviousBody && item.bbox[1] <= pageHeight * .55 && Number(item.originalLineCount || 0) <= 1;
  }

  function promoteTextItemsToBody(items, pageWidth, pageHeight, context = {}) {
    const hasPreviousBody = Boolean(context.hasPreviousBody);
    const pageHasBodyProse = items.some(item => item.kind === "text" && !item.symbolGlossary && !item.fromList
      && looksLikeBodyProseEvidence(item.roleText || item.text, item, pageWidth, pageHeight));
    if (!pageHasBodyProse && !hasPreviousBody) return items;
    const seeds = {};
    const bodyCandidate = item => {
      if (isBodyTextCandidate(item.roleText || item.text, item.bbox, pageWidth, pageHeight)) return true;
      return Number(item.pageIndex || 0) >= 2 && item.columnKey !== "full" && !isLayoutMetadataText(item.roleText || item.text);
    };
    const seedEligible = item => Number(item.originalLineCount || 0) > 1
      || bboxHeight(item.bbox) > pageHeight * .035
      || bboxWidth(item.bbox) > pageWidth * .48;
    for (const item of items) {
      if (item.kind !== "text" || item.symbolGlossary || item.debugRole === "toc" || item.fromList || isLayoutMetadataText(item.roleText || item.text)
        || isEarlyFrontMatterItem(item, pageHeight, hasPreviousBody)) continue;
      if (bodyCandidate(item) && seedEligible(item) && item.columnKey !== "full") {
        (seeds[item.columnKey] ||= []).push(item.bbox);
      }
    }
    return items.map(original => {
      if (original.kind !== "text" || original.symbolGlossary || original.debugRole === "toc" || original.fromList || isLayoutMetadataText(original.roleText || original.text)
        || isEarlyFrontMatterItem(original, pageHeight, hasPreviousBody)) return original;
      const item = { ...original };
      if (bodyCandidate(item) && seedEligible(item)) item.debugRole = "body_candidate";
      else if ((seeds[item.columnKey] || []).some(anchor => bboxMatchesColumn(anchor, item.bbox))) item.debugRole = "body_candidate";
      else if (hasPreviousBody && bodyCandidate(item)
        && matchesBodyColumnProfile(item, pageWidth, context.neighborColumnProfiles || {})) item.debugRole = "body_candidate";
      return item;
    });
  }

  function inferSingleColumnProfile(pages) {
    const candidates = [];
    for (const [pageIndex, page] of (pages || []).entries()) {
      if (!page || typeof page !== "object") continue;
      const [pageWidth, pageHeight] = normalizePageSize(page, page.preproc_blocks || []);
      for (const block of Array.isArray(page.preproc_blocks) ? page.preproc_blocks : []) {
        if (String(block?.type || "").toLowerCase() !== "text") continue;
        const bbox = validBBox(block.bbox);
        const sourceLines = Array.isArray(block.lines) ? block.lines.length : 0;
        if (!bbox || sourceLines < SINGLE_COLUMN_MIN_SOURCE_LINES) continue;
        if (bboxWidth(bbox) / pageWidth < SINGLE_COLUMN_MIN_WIDTH_RATIO
          || bboxHeight(bbox) / pageHeight < SINGLE_COLUMN_MIN_HEIGHT_RATIO) continue;
        candidates.push({ pageIndex, left: bbox[0] / pageWidth, right: bbox[2] / pageWidth });
      }
    }
    let best = [];
    for (const candidate of candidates) {
      const cluster = candidates.filter(other =>
        Math.abs(other.left - candidate.left) <= SINGLE_COLUMN_LEFT_TOLERANCE_RATIO
        && Math.abs(other.right - candidate.right) <= SINGLE_COLUMN_RIGHT_TOLERANCE_RATIO);
      if (cluster.length > best.length) best = cluster;
    }
    const supportingPages = new Set(best.map(candidate => candidate.pageIndex));
    if (best.length < SINGLE_COLUMN_MIN_SUPPORTING_BLOCKS
      || supportingPages.size < SINGLE_COLUMN_MIN_SUPPORTING_PAGES) return null;
    return {
      leftRatio: best.reduce((sum, candidate) => sum + candidate.left, 0) / best.length,
      rightRatio: best.reduce((sum, candidate) => sum + candidate.right, 0) / best.length,
      supportingPages,
      supportingBlocks: best.length
    };
  }

  function singleColumnProfileMatches(profile, bbox, pageWidth, pageHeight, sourceLines) {
    const box = validBBox(bbox);
    if (!profile || !box || pageWidth <= 0 || pageHeight <= 0
      || Number(sourceLines || 0) < SINGLE_COLUMN_MIN_SOURCE_LINES
      || bboxHeight(box) / pageHeight < SINGLE_COLUMN_MIN_HEIGHT_RATIO
      || bboxWidth(box) / pageWidth < SINGLE_COLUMN_MIN_WIDTH_RATIO) return false;
    return Math.abs(box[0] / pageWidth - profile.leftRatio) <= SINGLE_COLUMN_LEFT_TOLERANCE_RATIO
      && Math.abs(box[2] / pageWidth - profile.rightRatio) <= SINGLE_COLUMN_RIGHT_TOLERANCE_RATIO;
  }

  function promoteStableSingleColumnItems(items, pageWidth, pageHeight, profile) {
    if (!profile) return items;
    return items.map(original => {
      if (original.kind !== "text" || original.fromList || original.symbolGlossary || original.debugRole === "toc"
        || !singleColumnProfileMatches(profile, original.bbox, pageWidth, pageHeight, original.originalLineCount)) return original;
      return { ...original, debugRole: "body_candidate", columnKey: "single-column" };
    });
  }

  function pageHasParallelReadingLanes(items, pageWidth, pageHeight) {
    const lanes = items.filter(item => item.kind === "text" && !item.fromList
      && Number(item.originalLineCount || 0) >= SINGLE_COLUMN_MIN_SOURCE_LINES
      && validBBox(item.bbox)
      && bboxWidth(item.bbox) / pageWidth >= .18
      && bboxWidth(item.bbox) / pageWidth <= .72
      && bboxHeight(item.bbox) / pageHeight >= SINGLE_COLUMN_MIN_HEIGHT_RATIO);
    for (let index = 0; index < lanes.length; index++) {
      for (const other of lanes.slice(index + 1)) {
        const first = lanes[index].bbox;
        const second = other.bbox;
        const verticalOverlap = Math.min(first[3], second[3]) - Math.max(first[1], second[1]);
        const minimumHeight = Math.min(bboxHeight(first), bboxHeight(second));
        const horizontalGap = Math.max(first[0], second[0]) - Math.min(first[2], second[2]);
        if (minimumHeight > 0 && verticalOverlap >= minimumHeight * .20 && horizontalGap >= pageWidth * .035) return true;
      }
    }
    return false;
  }

  function pageHasSingleColumnAnchor(items, pageWidth, pageHeight, profile) {
    return items.some(item => item.kind === "text" && singleColumnProfileMatches(
      profile, item.bbox, pageWidth, pageHeight, item.originalLineCount));
  }

  function inheritStableSingleColumnShortItems(items, pageWidth, pageHeight, profile) {
    if (!profile || !pageHasSingleColumnAnchor(items, pageWidth, pageHeight, profile)
      || pageHasParallelReadingLanes(items, pageWidth, pageHeight)) return items;
    const laneWidth = Math.max(1, (profile.rightRatio - profile.leftRatio) * pageWidth);
    return items.map(original => {
      if (original.kind !== "text" || original.fromList || original.symbolGlossary || original.debugRole !== "text"
        || Number(original.pageIndex || 0) <= 0 || !validBBox(original.bbox)
        || ![1, 2].includes(Number(original.originalLineCount || 0))) return original;
      const [left, , right] = original.bbox;
      const leftMatches = Math.abs(left / pageWidth - profile.leftRatio) <= SINGLE_COLUMN_LEFT_TOLERANCE_RATIO;
      const staysInside = right / pageWidth <= profile.rightRatio + SINGLE_COLUMN_RIGHT_TOLERANCE_RATIO;
      if (!leftMatches || !staysInside || bboxWidth(original.bbox) < laneWidth * SINGLE_COLUMN_MIN_SHORT_WIDTH_TO_LANE_RATIO) {
        return original;
      }
      // This role inherits the body baseline but never participates in the
      // baseline solver, so a narrow derivation transition cannot shrink the
      // entire document. The first page remains on the legacy path to protect
      // author, affiliation, and address panels.
      return { ...original, debugRole: "body_inherited", columnKey: "single-column" };
    });
  }

  function layoutBarrierBoxes(blocks) {
    const output = [];
    const queue = [...(blocks || [])];
    while (queue.length) {
      const block = queue.shift();
      if (!block || typeof block !== "object") continue;
      const bbox = validBBox(block.bbox);
      if (bbox) output.push(bbox);
      for (const child of Array.isArray(block.blocks) ? block.blocks : []) queue.push(child);
    }
    return output;
  }

  function horizontalOverlapRatio(a, b) {
    const overlap = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
    return overlap / Math.max(1, Math.min(bboxWidth(a), bboxWidth(b)));
  }

  function bodyMergeBlockedByBarrier(merged, next, barriers, blockingItems) {
    if (next[1] <= merged[3]) return false;
    const column = [Math.min(merged[0], next[0]), merged[1], Math.max(merged[2], next[2]), next[3]];
    const boxes = [...(barriers || []), ...(blockingItems || []).map(item => item.bbox).filter(validBBox)];
    return boxes.some(box => horizontalOverlapRatio(column, box) >= .18 && box[1] < next[1] && box[3] > merged[3]);
  }

  function bodyMergeCreatesBarrierIntrusion(parts, next, barriers) {
    const sourceBoxes = [...parts.map(part => part.bbox).filter(validBBox), next];
    const merged = bboxUnion(sourceBoxes);
    return (barriers || []).some(barrier => {
      const hx = Math.min(merged[2], barrier[2]) - Math.max(merged[0], barrier[0]);
      const vy = Math.min(merged[3], barrier[3]) - Math.max(merged[1], barrier[1]);
      if (hx < 8 || vy < 3) return false;
      return !sourceBoxes.some(box =>
        Math.min(box[2], barrier[2]) - Math.max(box[0], barrier[0]) >= 8
        && Math.min(box[3], barrier[3]) - Math.max(box[1], barrier[1]) >= 3);
    });
  }

  function singleLineBodyItemsAreAdjacent(previous, current) {
    if (Number(previous.originalLineCount || 0) !== 1 && Number(current.originalLineCount || 0) !== 1) return false;
    const gap = current.bbox[1] - previous.bbox[3];
    if (gap > Math.max(14, Math.min(bboxHeight(previous.bbox), bboxHeight(current.bbox)) * 1.5)) return false;
    const tolerance = Math.max(18, bboxWidth(previous.bbox) * .08, bboxWidth(current.bbox) * .08);
    return (Math.abs(previous.bbox[0] - current.bbox[0]) <= tolerance
      || Math.abs(previous.bbox[2] - current.bbox[2]) <= tolerance)
      && horizontalOverlapRatio(previous.bbox, current.bbox) >= .45;
  }

  function mergedPartIndent(part, mergedBBox) {
    const explicit = Number(part.indent || 0);
    if (explicit > 0) return explicit;
    const debugLines = (part.debugLines || []).filter(validBBox);
    let firstLineLeft = null;
    if (debugLines.length) {
      const firstTop = Math.min(...debugLines.map(line => line[1]));
      const firstLine = debugLines.filter(line => Math.abs(line[1] - firstTop) <= 3);
      firstLineLeft = Math.min(...firstLine.map(line => line[0]));
    }
    else if (validBBox(part.bbox)) firstLineLeft = part.bbox[0];
    if (firstLineLeft == null) return 0;
    const indent = firstLineLeft - mergedBBox[0];
    if (indent < 5) return 0;
    return Math.round(Math.min(indent, Math.max(10, bboxWidth(mergedBBox) * .18)) * 100) / 100;
  }

  function mergedBodyParagraphs(parts, mergedBBox = null) {
    const box = validBBox(mergedBBox) || bboxUnion(parts.map(part => part.bbox));
    const paragraphs = [];
    let current = null;
    for (const part of parts) {
      if (!current) current = { parts: [part], indent: mergedPartIndent(part, box) };
      else {
        // Use translated wording for paragraph boundaries because punctuation
        // can change and alter whether adjacent parsed fragments belong to one
        // paragraph.
        const previousText = current.parts.map(translatedFlowPlainText).join(" ").trim();
        const currentText = translatedFlowPlainText(part);
        if (/[-−–]$/.test(previousText) || looksLikeContinuation(previousText, currentText)) current.parts.push(part);
        else {
          paragraphs.push(current);
          current = { parts: [part], indent: mergedPartIndent(part, box) };
        }
      }
    }
    if (current) paragraphs.push(current);
    return paragraphs;
  }

  function mergeVerticalBodyItems(items, absoluteBlocks) {
    const body = items.filter(item => item.kind === "text" && item.debugRole === "body_candidate");
    const other = items.filter(item => !(item.kind === "text" && item.debugRole === "body_candidate"));
    const barriers = layoutBarrierBoxes(absoluteBlocks);
    const blockers = other.filter(item => item.kind === "text");
    const result = body.filter(item => item.columnKey === "full");
    const emitMerged = parts => {
      const box = bboxUnion(parts.map(part => part.bbox));
      result.push({
        kind: "text",
        side: parts[0].side,
        columnKey: parts[0].columnKey,
        bbox: box,
        text: parts.map(part => part.text).join("\n\n"),
        roleText: parts.map(part => part.roleText || part.text).join("\n\n"),
        originalLineCount: parts.reduce((sum, part) => sum + Number(part.originalLineCount || 0), 0),
        pageIndex: parts[0].pageIndex,
        debugRole: "merged_body",
        parts,
        paragraphs: mergedBodyParagraphs(parts, box),
        debugLines: parts.flatMap(part => part.debugLines || [])
      });
    };
    const keys = [...new Set(body.filter(item => item.columnKey !== "full").map(item => item.columnKey))].sort();
    for (const key of keys) {
      const sorted = body.filter(item => item.columnKey === key)
        .sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
      if (!sorted.length) continue;
      let current = [sorted[0]];
      for (const item of sorted.slice(1)) {
        const currentBox = bboxUnion(current.map(part => part.bbox));
        const gap = item.bbox[1] - currentBox[3];
        const tolerance = Math.max(18, bboxWidth(currentBox) * .10);
        const normal = gap <= Math.max(18, Math.min(bboxHeight(currentBox), bboxHeight(item.bbox)) * 2)
          && (Math.abs(item.bbox[0] - currentBox[0]) <= tolerance
            || Math.abs(item.bbox[2] - currentBox[2]) <= tolerance
            || horizontalOverlapRatio(currentBox, item.bbox) >= .55);
        const adjacent = singleLineBodyItemsAreAdjacent(current[current.length - 1], item);
        if ((normal || adjacent)
          && !bodyMergeBlockedByBarrier(currentBox, item.bbox, barriers, blockers)
          && !bodyMergeCreatesBarrierIntrusion(current, item.bbox, barriers)) current.push(item);
        else {
          emitMerged(current);
          current = [item];
        }
      }
      emitMerged(current);
    }
    return [...result, ...other];
  }

  function markEquationDenseBodyItems(items, absoluteBlocks, pageHeight) {
    const equations = [];
    const queue = [...absoluteBlocks];
    while (queue.length) {
      const block = queue.shift();
      if (!block || typeof block !== "object") continue;
      if (["interline_equation", "equation"].includes(String(block.type || "").toLowerCase()) && validBBox(block.bbox)) {
        equations.push(block.bbox);
      }
      queue.push(...(Array.isArray(block.blocks) ? block.blocks : []));
    }
    for (const item of items) {
      if (!["body_candidate", "merged_body"].includes(item.debugRole)) continue;
      if (Number(item.originalLineCount || 0) > 4 || bboxHeight(item.bbox) > Math.max(54, pageHeight * .07)) continue;
      const related = equations.filter(eq => horizontalOverlapRatio(item.bbox, eq) >= .35);
      const upper = related.some(eq => item.bbox[1] - eq[3] >= 0 && item.bbox[1] - eq[3] <= 28);
      const lower = related.some(eq => eq[1] - item.bbox[3] >= 0 && eq[1] - item.bbox[3] <= 28);
      if (upper && lower) item.equationDense = true;
    }
    return items;
  }

  function mergeReferenceItems(items) {
    const references = items.filter(item => item.kind === "ref_text");
    const other = items.filter(item => item.kind !== "ref_text");
    const merged = [];
    for (const key of [...new Set(references.map(item => item.columnKey || item.side || "full"))].sort()) {
      const parts = references.filter(item => (item.columnKey || item.side || "full") === key)
        .sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
      if (!parts.length) continue;
      merged.push({
        kind: "ref_text",
        side: parts[0].side,
        columnKey: key,
        bbox: bboxUnion(parts.map(part => part.bbox)),
        text: parts.map(part => part.text).join("\n"),
        roleText: parts.map(part => part.roleText || part.text).join("\n"),
        pageIndex: parts[0].pageIndex,
        debugRole: "merged_reference",
        parts,
        paragraphs: parts.map(part => ({ parts: [part], indent: 0 })),
        debugLines: parts.flatMap(part => part.debugLines || [])
      });
    }

    // Merge reference flows only when their left edges match and their vertical
    // spans overlap. This excludes ordinary multi-column bibliographies.
    const repaired = [];
    const pending = [...merged].sort((a, b) => a.bbox[1] - b.bbox[1]);
    while (pending.length) {
      const current = pending.shift();
      const compatibleIndex = pending.findIndex(candidate => {
        if (Number(candidate.pageIndex || 0) !== Number(current.pageIndex || 0)) return false;
        if (Math.abs(candidate.bbox[0] - current.bbox[0]) > 8) return false;
        const overlap = Math.max(0, Math.min(current.bbox[3], candidate.bbox[3]) - Math.max(current.bbox[1], candidate.bbox[1]));
        const shorterHeight = Math.min(bboxHeight(current.bbox), bboxHeight(candidate.bbox));
        return shorterHeight > 0 && overlap / shorterHeight >= .75;
      });
      if (compatibleIndex < 0) {
        repaired.push(current);
        continue;
      }

      const candidate = pending.splice(compatibleIndex, 1)[0];
      const parts = [...(current.parts || []), ...(candidate.parts || [])]
        .sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
      pending.unshift({
        ...current,
        bbox: bboxUnion(parts.map(part => part.bbox)),
        text: parts.map(part => part.text).join("\n"),
        roleText: parts.map(part => part.roleText || part.text).join("\n"),
        parts,
        paragraphs: parts.map(part => ({ parts: [part], indent: 0 })),
        debugLines: parts.flatMap(part => part.debugLines || [])
      });
    }
    return [...repaired, ...other];
  }

  function lineDebugData(lines) {
    return (Array.isArray(lines) ? lines : []).map(line => {
      let bbox = validBBox(line?.bbox);
      if (!bbox) bbox = bboxUnion((line?.spans || []).map(span => span?.bbox));
      return bboxWidth(bbox) && bboxHeight(bbox) ? bbox : null;
    }).filter(Boolean);
  }

  function prepareFlowItems(page, flatBlocks, ocrBoxes) {
    const pageWidth = normalizePageSize(page, page.preproc_blocks || [])[0];
    const pageHeight = normalizePageSize(page, page.preproc_blocks || [])[1];
    const recordByObject = new Map(flatBlocks.map(record => [record.original, record]));
    const mediaBoxes = collectMediaCarrierBoxes(page.preproc_blocks || []);
    const output = [];
    const add = (block, kind, fromList = false) => {
      const bbox = validBBox(block.bbox);
      const record = recordByObject.get(block);
      const symbolGlossary = kind === "text" && isSymbolGlossaryBlock(block);
      const html = layoutLinesToHTML(block.lines, !symbolGlossary);
      const text = String(record?.text || blockText(block) || "").trim();
      const tocRows = kind === "text" ? parseTocRows(block.lines) : null;
      if (!bbox || !html || mediaBoxes.some(box => bboxContainedOverlapRatio(bbox, box) >= .72)) return;
      output.push({
        id: record?.id || "",
        kind,
        type: String(block.type || kind).toLowerCase(),
        bbox,
        html,
        text,
        translatedText: String(record?.translatedText || ""),
        roleText: String(block._layout_original_plain_text || text),
        originalLineCount: tocRows
          ? layoutLogicalLines(block.lines).length
          : Math.max(
            Number(block._layout_original_line_count || 0),
            layoutVisualLineCount(block.lines)
          ),
        debugLines: lineDebugData(block._layout_debug_lines || block._layout_original_lines || block.lines),
        fontEstimate: estimateLayoutFontSize(kind, bbox, text) || (kind === "ref_text" ? 8.2 : 8.5),
        side: streamSideForBBox(bbox, pageWidth),
        indent: estimateFirstLineIndent(bbox, ocrBoxes),
        pageIndex: Number(page.page_idx || 0),
        debugRole: kind === "ref_text" ? "reference" : (tocRows ? "toc" : "text"),
        tocRows,
        symbolGlossary,
        paragraphs: symbolGlossaryParagraphs({
          symbolGlossary,
          html,
          text,
          translatedText: String(record?.translatedText || "")
        }),
        fromList
      });
    };
    for (const block of Array.isArray(page.preproc_blocks) ? page.preproc_blocks : []) {
      const type = String(block?.type || "").toLowerCase();
      if (type === "text" || type === "ref_text") add(block, type);
      else if (type === "list") {
        let added = false;
        for (const child of Array.isArray(block.blocks) ? block.blocks : []) {
          const childType = String(child?.type || "").toLowerCase();
          if (["text", "ref_text"].includes(childType)) {
            add(child, childType, true);
            added = true;
          }
        }
        if (added) block._litmtransFlowList = true;
      }
    }
    assignLayoutColumnKeys(output, pageWidth);
    return { items: output, recordByObject, pageWidth, pageHeight };
  }

  function columnRightEdgesFromStreams(streams) {
    // Body boxes remain the authority for text fitting.  Formula-number
    // gutters also need ordinary (non-reference) text geometry: a valid
    // single-column paragraph can intentionally stay outside body fitting
    // while still identifying the physical reading lane on this page.
    const edges = { bodyBoxes: [], textBoxes: [] };
    for (const stream of streams) {
      if (!validBBox(stream.bbox)) continue;
      const items = stream.items || [];
      if (!items.length || items.every(item => item.kind === "ref_text")) continue;
      const key = stream.columnKey || stream.items?.[0]?.columnKey || "full";
      const box = {
        columnKey: key, left: stream.bbox[0], right: stream.bbox[2],
        top: stream.bbox[1], bottom: stream.bbox[3], role: stream.debugRole
      };
      edges.textBoxes.push(box);
      if (!["body_candidate", "merged_body", "body_inherited"].includes(stream.debugRole)) continue;
      edges.bodyBoxes.push(box);
      edges[`${key}Left`] = Math.min(edges[`${key}Left`] ?? box.left, box.left);
      edges[key] = Math.max(edges[key] ?? 0, box.right);
    }
    return edges;
  }

  // MinerU's bbox is formula ink geometry. Column evidence is used only as a
  // right-edge anchor for a TeX \tag, never to change formula sizing or its
  // collision frame.
  function equationNumberRightForBBox(bbox, pageWidth, columnRights) {
    const source = validBBox(bbox) ? [...bbox] : null;
    if (!source) return null;
    const [, top, originalRight, bottom] = source;
    if (!columnRights) return originalRight;
    const geometryBoxes = [...(columnRights.bodyBoxes || []), ...(columnRights.textBoxes || [])];
    if (!geometryBoxes.length) return originalRight;

    const left = source[0];
    const width = Math.max(1, originalRight - left);
    const centerX = (left + originalRight) / 2;
    const centerY = (top + bottom) / 2;
    const band = Math.max(40, Math.min(112, (bottom - top) * 1.5));
    const byColumn = new Map();
    const seen = new Set();
    for (const box of geometryBoxes) {
      const boxLeft = Number(box.left);
      const boxRight = Number(box.right);
      const boxTop = Number(box.top);
      const boxBottom = Number(box.bottom);
      const key = String(box.columnKey || "");
      if (![boxLeft, boxRight, boxTop, boxBottom].every(Number.isFinite) || !key) continue;
      const identity = `${key}:${boxLeft}:${boxRight}:${boxTop}:${boxBottom}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const boxCenterY = (boxTop + boxBottom) / 2;
      const verticallyNear = boxBottom >= top - 10 && boxTop <= bottom + 10;
      if (!verticallyNear && Math.abs(boxCenterY - centerY) > band) continue;
      const overlap = Math.max(0, Math.min(originalRight, boxRight) - Math.max(left, boxLeft));
      const containsCenter = boxLeft - 8 <= centerX && centerX <= boxRight + 8;
      if (!containsCenter && overlap < Math.max(14, width * .15)) continue;
      if (!byColumn.has(key)) byColumn.set(key, []);
      byColumn.get(key).push({ box: { ...box, left: boxLeft, right: boxRight }, overlap, containsCenter });
    }
    if (!byColumn.size) return originalRight;

    const ranked = [...byColumn.entries()].sort(([, entriesA], [, entriesB]) => {
      const score = entries => Math.max(...entries.map(({ overlap, containsCenter }) => overlap + (containsCenter ? pageWidth : 0)));
      return score(entriesB) - score(entriesA);
    });
    const [chosenKey, chosenEntries] = ranked[0];
    let chosenRight = Math.max(...chosenEntries.map(entry => entry.box.right));
    const chosenLeft = Math.min(...chosenEntries.map(entry => entry.box.left));
    const overlappingColumns = [...byColumn.values()].filter(entries =>
      Math.max(...entries.map(entry => entry.overlap)) >= Math.max(14, width * .15));
    const chosenColumnWidth = Math.max(1, chosenRight - chosenLeft);
    // A genuinely cross-column formula gets its number at the outside edge of
    // its span, rather than inside an arbitrary middle column.
    if (overlappingColumns.length >= 2 && width >= chosenColumnWidth * 1.25) {
      chosenRight = Math.max(...overlappingColumns.flatMap(entries => entries.map(entry => entry.box.right)));
      for (const [colKey] of byColumn.entries()) {
        const colAuth = Number(columnRights?.[colKey] ?? 0);
        if (colAuth > chosenRight) chosenRight = colAuth;
      }
    } else {
      const columnAuthorityRight = Number(columnRights?.[chosenKey] ?? 0);
      const maxColumnBoxRight = Math.max(
        0,
        ...geometryBoxes.filter(b => b.columnKey === chosenKey).map(b => Number(b.right) || 0)
      );
      const targetColumnRight = Math.max(columnAuthorityRight, maxColumnBoxRight);
      if (targetColumnRight > chosenRight) {
        chosenRight = targetColumnRight;
      }
    }
    return Math.max(originalRight, chosenRight);
  }

  function numberedFormula(block) {
    return block?.kind === "formula"
      && (block.formulas || []).some(tex => /\\tag\s*\{[^}]*\}/.test(String(tex || "")));
  }

  function localColumnRight(stream, edges) {
    const bbox = stream.bbox;
    const key = stream.columnKey || stream.items?.[0]?.columnKey || "full";
    const center = (bbox[1] + bbox[3]) / 2;
    const band = Math.max(36, Math.min(96, bboxHeight(bbox) * .5));
    const near = box => {
      const boxCenter = (box.top + box.bottom) / 2;
      return (box.bottom >= bbox[1] - 8 && box.top <= bbox[3] + 8) || Math.abs(boxCenter - center) <= band;
    };
    const notSelf = box => Math.abs(box.left - bbox[0]) >= 1 || Math.abs(box.right - bbox[2]) >= 1
      || Math.abs(box.top - bbox[1]) >= 1 || Math.abs(box.bottom - bbox[3]) >= 1;
    const same = (edges.bodyBoxes || []).filter(box => box.columnKey === key && near(box) && notSelf(box));
    if (same.length) return Math.max(...same.map(box => box.right));
    const full = (edges.bodyBoxes || []).filter(box => box.columnKey === "full" && near(box) && notSelf(box));
    return full.length ? Math.max(...full.map(box => box.right)) : null;
  }

  function expandNarrowStream(stream, edges, barriers) {
    if (!["body_candidate", "merged_body"].includes(stream.debugRole) || stream.columnKey === "full") return;
    const target = localColumnRight(stream, edges);
    if (target == null) return;
    const leftEdge = edges[`${stream.columnKey}Left`] ?? stream.bbox[0];
    const columnWidth = Math.max(1, target - leftEdge);
    if (bboxWidth(stream.bbox) >= columnWidth * .94 || stream.bbox[0] > target) return;
    const prospective = [stream.bbox[0], stream.bbox[1], target, stream.bbox[3]];
    if ((barriers || []).some(box =>
      Math.min(prospective[2], box[2]) - Math.max(prospective[0], box[0]) >= 8
      && Math.min(prospective[3], box[3]) - Math.max(prospective[1], box[1]) >= 3
      && box[0] > stream.bbox[0] + 24)) return;
    stream.bbox[2] = Math.max(stream.bbox[2], target);
  }

  function retreatIntrudingColumnBoundaries(streams) {
    const candidates = streams.filter(stream => stream.columnKey && stream.columnKey !== "full" && validBBox(stream.bbox));
    for (let index = 0; index < candidates.length; index++) {
      for (let next = index + 1; next < candidates.length; next++) {
        if (candidates[index].columnKey === candidates[next].columnKey) continue;
        let left = candidates[index];
        let right = candidates[next];
        if (left.bbox[0] > right.bbox[0]) [left, right] = [right, left];
        if (Math.min(left.bbox[3], right.bbox[3]) - Math.max(left.bbox[1], right.bbox[1]) <= 2) continue;
        if (left.bbox[2] <= right.bbox[0]) continue;
        const boundary = (left.bbox[2] + right.bbox[0]) / 2;
        if (boundary - left.bbox[0] < 20 || right.bbox[2] - boundary < 20) continue;
        left.bbox[2] = boundary;
        right.bbox[0] = boundary;
      }
    }
  }

  function streamParagraphs(stream) {
    return (stream.items || []).flatMap(item =>
      Array.isArray(item.paragraphs) && item.paragraphs.length ? item.paragraphs : [{ parts: item.parts || [item], indent: item.indent || 0 }]);
  }

  function translatedFlowPlainText(part) {
    // Capacity must be measured from the translated text because that is what
    // the reader lays out. Replace markup with separators and preserve the
    // encoded form used by the renderer so citations and formula-bearing text
    // do not change the fitted body font unexpectedly.
    return String(part?.translatedText || part?.text || "")
      // Only sup/sub survive the translation protocol as real markup. A raw
      // comparison such as "<8.3%" is text, not an unterminated HTML tag.
      .replace(/<\/?(?:sup|sub)\b[^>]*>/gi, " ")
      .replace(/&(?:amp;)?lt;/gi, "<")
      .replace(/&(?:amp;)?gt;/gi, ">")
      // Match the renderer's escaped-text representation before measuring.
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\s+/g, " ")
      .trim();
  }

  function streamInnerBBox(bbox, refsOnly) {
    const leftPad = 2;
    const rightPad = refsOnly ? 2 : 4;
    const topPad = refsOnly ? 1 : 0;
    const bottomPad = refsOnly ? 1 : 0;
    return [
      bbox[0] + leftPad,
      bbox[1] + topPad,
      Math.max(bbox[0] + leftPad + 4, bbox[2] - rightPad),
      Math.max(bbox[1] + topPad + 4, bbox[3] - bottomPad)
    ];
  }

  function estimateStreamUsedHeight(stream, fontSize, lineRatio, paragraphGap, refsOnly) {
    const width = Math.max(12, bboxWidth(streamInnerBBox(stream.bbox, refsOnly)));
    const factor = refsOnly ? .47 : .45;
    let lines = 0;
    const paragraphs = streamParagraphs(stream);
    for (const paragraph of paragraphs) {
      const text = (paragraph.parts || []).map(translatedFlowPlainText).join(" ").replace(/\s+/g, " ").trim();
      if (!text) continue;
      const indent = refsOnly ? 0 : Number(paragraph.indent || 0);
      const full = Math.max(6, width / Math.max(1, fontSize * factor));
      const first = Math.max(4, (width - indent) / Math.max(1, fontSize * factor));

      // integer-ceiling idiom to floating-point character capacities:
      // int((remaining + full_chars - 1) // full_chars). Math.ceil(remaining /
      // full) is only equivalent for integer divisors and changes the winning
      // document-wide font/line-height candidate near a wrap boundary.
      lines += text.length <= first
        ? 1
        : 1 + Math.floor((text.length - first + full - 1) / full);
    }
    const nonEmpty = paragraphs.filter(paragraph =>
      (paragraph.parts || []).some(part => translatedFlowPlainText(part).trim())).length;
    return lines * fontSize * lineRatio + Math.max(0, nonEmpty - 1) * paragraphGap * fontSize;
  }

  function streamLineMetrics(stream, ocrBoxes) {
    const items = stream.items || [];
    if (!items.length) return [8.5, 1.14];
    const refsOnly = items.every(item => item.kind === "ref_text");
    const box = bboxUnion(items.map(item => item.bbox));
    const boxes = ocrBoxesInRegion(ocrBoxes || [], box, 4);
    const heights = boxes.map(bboxHeight);
    const centers = boxes.map(box => bboxCenter(box)[1]).sort((a, b) => a - b);
    const gaps = [];
    for (let index = 0; index + 1 < centers.length; index++) {
      const gap = centers[index + 1] - centers[index];
      if (gap > 1) gaps.push(gap);
    }
    const medianHeight = medianValue(heights, refsOnly ? 10 : 10.8);
    const medianGap = medianValue(gaps, medianHeight * (refsOnly ? 1.14 : 1.18));
    const font = Math.max(refsOnly ? 7.1 : 7.6, Math.min(refsOnly ? 9 : 10.4, medianHeight * (refsOnly ? .92 : .94)));
    const ratio = Math.max(refsOnly ? 1.02 : 1.05, Math.min(refsOnly ? 1.24 : 1.28, medianGap / Math.max(1, font)));
    return [Math.round(font * 100) / 100, Math.round(ratio * 1000) / 1000];
  }

  function streamBottomGap(stream, font, ratio, gap, refsOnly) {
    return Math.max(0, bboxHeight(stream.bbox) - estimateStreamUsedHeight(stream, font, ratio, gap, refsOnly));
  }

  function solveUniformStreamStyle(streams, refsOnly, ocrBoxesByPage = {}) {
    if (!streams.length) return refsOnly ? [7.8, 1.12] : [8.4, 1.16];
    const minFont = refsOnly ? 6.9 : 7.2;
    const maxFont = refsOnly ? 8.8 : 10.6;
    const metrics = streams.map(stream =>
      streamLineMetrics(stream, ocrBoxesByPage[Number(stream.pageIndex || 0)] || []));
    const base = medianValue(metrics.map(value => value[0]), refsOnly ? 7.8 : 8.4);
    const baseRatio = medianValue(metrics.map(value => value[1]), refsOnly ? 1.10 : 1.16);
    const ratios = refsOnly
      ? [baseRatio, Math.max(1, baseRatio * .96), Math.min(1.18, baseRatio * 1.02)]
      : [baseRatio, Math.max(1.03, baseRatio * .95), Math.min(1.18, baseRatio * 1.02), Math.max(1.02, baseRatio * .98)];
    const gaps = refsOnly ? [.10] : [.12, .16, .20];
    let best = [Math.max(minFont, Math.min(maxFont, base)), baseRatio, gaps[0]];
    let bestScore = -Infinity;
    for (const ratio of [...new Set(ratios.map(value => Math.round(value * 1000) / 1000))].sort((a, b) => a - b)) {
      for (const gap of gaps) {
        let low = minFont;
        let high = Math.max(base, Math.min(maxFont, base * (refsOnly ? 1.4 : 1.5)));
        let font = Math.max(minFont, Math.min(maxFont, base));
        for (let count = 0; count < 22; count++) {
          const candidate = (low + high) / 2;
          const fits = streams.every(stream => estimateStreamUsedHeight(stream, candidate, ratio, gap, refsOnly) <= bboxHeight(stream.bbox));
          if (fits) {
            font = candidate;
            low = candidate;
          }
          else high = candidate;
        }
        if (streams.length) {
          const samplePage = Number(streams[0].pageIndex || 0);
          const sampleBoxes = ocrBoxesByPage[samplePage] || [];
          const pageHeight = sampleBoxes.length ? Math.max(...sampleBoxes.map(box => box[3])) / .92 : 792;
          const band = Math.max(6, pageHeight * .02);
          while (font < maxFont) {
            const bottomGaps = streams.map(stream => streamBottomGap(stream, font, ratio, gap, refsOnly));
            if (!bottomGaps.length || Math.min(...bottomGaps) <= band) break;
            const next = Math.min(maxFont, font + .2);
            if (next <= font || streams.some(stream =>
              estimateStreamUsedHeight(stream, next, ratio, gap, refsOnly) > bboxHeight(stream.bbox))) break;
            font = next;
          }
        }
        const fills = streams.map(stream => Math.min(1, estimateStreamUsedHeight(stream, font, ratio, gap, refsOnly) / Math.max(1, bboxHeight(stream.bbox))));
        const score = Math.min(...fills) * 2000 + fills.reduce((sum, value) => sum + value, 0) / fills.length * 260
          + font * 20 - ratio * 4 - gap * 3;
        if (score > bestScore) {
          bestScore = score;
          best = [font, ratio, gap];
        }
      }
    }
    return [Math.round(best[0] * 100) / 100, Math.round(best[1] * 1000) / 1000];
  }

  function absoluteVisuals(blocks, recordByObject, resolveAsset) {
    const output = [];
    const equationTypes = new Set(["interline_equation", "equation", "inline_equation", "block_equation"]);
    const codeTypes = new Set(["code", "code_body"]);
    const containerTypes = new Set(["table", "chart", "image"]);
    const mediaBodyTypes = new Set(["table_body", "chart_body", "image_body"]);
    const pushBlock = (block, type, record, bbox, kind, imagePath, formulas, htmlSpan, textOverride = null) => {
      const text = textOverride == null
        ? String(record?.text || blockText(block) || "")
        : String(textOverride);
      output.push({
        id: record?.id || "",
        type,
        kind,
        bbox,
        text,
        translatedText: String(record?.translatedText || ""),
        sourceHTML: layoutLinesToHTML(block.lines),
        tableHTML: htmlSpan?.html ? normalizeLayoutHTMLSnippet(htmlSpan.html) : "",

        // retained only for the no-TeX fallback, never alongside the TeX node.
        imagePath: kind === "image" ? imagePath : "",
        imageURL: kind === "image" ? resolveAsset(imagePath) : "",
        formulaItems: kind === "formula" ? formulas : [],
        formulas: kind === "formula" ? formulas.map(item => item.tex) : [],
        codeLanguage: kind === "code" ? String(block.guess_lang || block.guessLang || "text") : "",
        // The positioned renderer uses this metadata to include multi-line
        // absolute text in collision iteration.
        lineCount: Math.max(1, Number(block._layout_original_line_count ?? (block.lines || []).length) || 1),
        // Measure the translated absolute text while retaining source text for
        // the source-pane rendering.
        fontSize: fixedLayoutFontSize(type)
          || estimateLayoutFontSize(type, bbox, String(record?.translatedText || text))
          || inferFontSize(block, bbox, String(record?.translatedText || text), (block.lines || []).length),
        lineHeight: ["table_caption", "table_footnote", "chart_caption", "image_caption", "image_footnote"].includes(type)
          ? 1.2
          : (type === "text" ? 1.28 : 1.12),
        debugLines: lineDebugData(block.lines)
      });
    };
    const visit = block => {
      if (!block || typeof block !== "object" || block._litmtransFlowList) return;
      const type = String(block.type || "unknown").toLowerCase();
      const children = Array.isArray(block.blocks) ? block.blocks : [];
      const record = recordByObject.get(block);
      const bbox = validBBox(block.bbox);
      const imagePath = imagePathFromBlock(block);
      const isEquation = equationTypes.has(type);
      const formulas = record?.formulaItems || formulaSpans(block).map((tex, index) => ({
        id: `${record?.id || "formula"}-${index + 1}`, tex
      }));
      // A display-equation span can contain TeX even when its type label is
      // incomplete; use that content before considering an image crop.
      if (isEquation && !formulas.length && blockText(block).trim()) {
        formulas.push({ id: `${record?.id || "formula"}-1`, tex: blockText(block).trim() });
      }
      const htmlSpan = (block.lines || []).flatMap(line => line?.spans || []).find(span => span?.html);
      // Containers do not occupy page coordinates; only their visual children
      // are rendered. Rendering both would duplicate content.
      if (containerTypes.has(type)) {
        for (const child of children) visit(child);
        return;
      }
      if (!bbox) {
        for (const child of children) visit(child);
        return;
      }
      if (codeTypes.has(type)) {
        const codeText = codeTextFromBlock(block);
        if (codeText) pushBlock(block, type, record, bbox, "code", "", [], htmlSpan, codeText);
        else for (const child of children) visit(child);
        return;
      }
      if (isEquation) {
        // A real TeX item wins over an accompanying raster crop. If TeX is
        // unavailable, use the crop as the visual fallback.
        if (formulas.length) pushBlock(block, type, record, bbox, "formula", imagePath, formulas, htmlSpan);
        else if (imagePath) pushBlock(block, type, record, bbox, "image", imagePath, [], htmlSpan);
        else if (blockText(block)) pushBlock(block, type, record, bbox, "text", "", [], htmlSpan);
        return;
      }
      if (mediaBodyTypes.has(type)) {
        const kind = imagePath ? "image" : (type === "table_body" && htmlSpan?.html ? "table" : "text");
        if (imagePath || htmlSpan?.html || blockText(block)) pushBlock(block, type, record, bbox, kind, imagePath, [], htmlSpan);
        else for (const child of children) visit(child);
        return;
      }
      // title/text use their own text renderer. All other types use the
      // generic fallback, which only descends when the current block is empty.
      if (blockText(block) || imagePath || htmlSpan?.html) {
        pushBlock(block, type, record, bbox, imagePath ? "image" : "text", imagePath, [], htmlSpan);
      } else {
        for (const child of children) visit(child);
      }
    };
    for (const block of blocks || []) visit(block);
    return output;
  }

  function modelItemTextHTML(item) {
    const direct = item?.content ?? item?.text;
    if (direct != null && String(direct).trim()) return safeLayoutTextToHTML(String(direct).trim());
    const lineHTML = layoutLinesToHTML(item?.lines);
    if (lineHTML) return lineHTML;
    return Array.isArray(item?.spans) ? layoutSpansToHTML(item.spans) : "";
  }

  function modelFallbackVisuals(modelPage, pageWidth, pageHeight, occupiedBoxes) {
    if (!Array.isArray(modelPage) && (!modelPage || typeof modelPage !== "object")) return [];
    const candidates = [];
    const visit = value => {
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
        return;
      }
      if (!value || typeof value !== "object") return;
      if (validBBox(value.bbox) && modelItemTextHTML(value)) candidates.push(value);
      for (const key of ["blocks", "lines", "spans", "children"]) {
        if (value[key]) visit(value[key]);
      }
    };
    visit(modelPage);
    const output = [];
    const seen = new Set();
    for (const item of candidates) {
      const rawBBox = validBBox(item.bbox);
      const bbox = Math.max(...rawBBox.map(Math.abs)) <= 1.5
        ? modelBBoxToPageBBox(rawBBox, pageWidth, pageHeight)
        : rawBBox;
      const originalType = String(item.type || item.category || "model_item").toLowerCase().replace(/[\s-]+/g, "_");
      if (originalType === "ocr_text" || originalType === "aside_text") continue;
      const type = originalType === "footer" ? "page_footer"
        : (originalType === "header" ? "page_header" : (originalType === "footnote" ? "page_footnote" : originalType));
      const html = modelItemTextHTML(item);
      const plain = String(item.content ?? item.text ?? blockText(item) ?? "").replace(/\s+/g, " ").trim();
      const nearTop = bbox[1] <= pageHeight * .07;
      const nearBottom = bbox[3] >= pageHeight * .93;
      const metadata = ["page_header", "page_footer", "page_footnote", "page_number", "header", "footer", "footnote"].includes(type)
        || ((nearTop || nearBottom) && /^(?:[-–—]?\s*)?\d{1,4}(?:\s*[-–—])?$/.test(plain));
      if (!metadata && occupiedBoxes.some(box => bboxContainedOverlapRatio(bbox, box) >= .72)) continue;
      const key = `${type}\u001f${plain}\u001f${bbox.map(value => Math.round(value)).join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({
        id: `model-${output.length + 1}`,
        type,
        kind: "text",
        bbox,
        text: plain,
        translatedText: "",
        sourceHTML: html,
        tableHTML: "",
        imagePath: "",
        imageURL: "",
        formulaItems: [],
        formulas: [],
        lineCount: Math.max(1, String(plain || "").split(/\r?\n/).filter(Boolean).length),
        fontSize: fixedLayoutFontSize(type) || estimateLayoutFontSize(type, bbox, plain) || 8,
        lineHeight: ["table_caption", "table_footnote", "chart_caption", "image_caption", "image_footnote"].includes(type)
          ? 1.2
          : 1.12,
        debugLines: []
      });
    }
    return output;
  }

  function expandSpecialAbsoluteBlocks(blocks, streams, pageWidth, pageHeight, mainTitleAllowed) {
    let mainTitleUsed = false;
    for (const block of blocks) {
      if (!validBBox(block.bbox)) continue;
      const geometryTitle = block.type === "title"
        && block.bbox[1] <= pageHeight * .35
        && bboxWidth(block.bbox) >= pageWidth * .45
        && bboxHeight(block.bbox) >= Math.max(24, pageHeight * .035);
      // Every title with article-title geometry is independent, including a
      // later paper title in a combined PDF.  The first encountered title is
      // still a safe fallback when the parser omitted the expected geometry.
      const isMainTitle = geometryTitle || (mainTitleAllowed && !mainTitleUsed && block.type === "title");
      if (isMainTitle) {
        // A title remains the article's main title even when this page has no
        // recovered body stream. Keep its source bbox and title role.
        block.mainTitle = true;
        if (mainTitleAllowed) mainTitleUsed = true;
        continue;
      }
      // Keep caption boxes at their source width. Widening them changes the
      // limiting block for the caption group and therefore its fitted font.
    }
    return mainTitleUsed;
  }

  function prepareRestoredPage(page, flatPage, modelPage, resolveAsset, context, singleColumnProfile = null) {
    const ocrBoxes = collectModelOCRBoxes(modelPage, flatPage.width, flatPage.height);
    const prepared = prepareFlowItems(page, flatPage.blocks, ocrBoxes);
    let items = promoteTextItemsToBody(prepared.items, flatPage.width, flatPage.height, context);
    items = promoteStableSingleColumnItems(items, flatPage.width, flatPage.height, singleColumnProfile);
    items = inheritStableSingleColumnShortItems(items, flatPage.width, flatPage.height, singleColumnProfile);
    const absoluteRaw = (page.preproc_blocks || []).filter(block => {
      const type = String(block?.type || "").toLowerCase();
      if (["text", "ref_text"].includes(type)) return false;
      if (type === "list" && block._litmtransFlowList) return false;
      return true;
    });
    items = mergeVerticalBodyItems(items, absoluteRaw);
    items = markEquationDenseBodyItems(items, absoluteRaw, flatPage.height);
    items = mergeReferenceItems(items);

    // Do not re-merge here: mergeVerticalBodyItems() is the single authority
    // for whether two body fragments may share a positioned text box.
    const streams = items
      .sort((a, b) => String(a.side).localeCompare(String(b.side)) || a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0])
      .map(item => ({
        side: item.side,
        columnKey: item.columnKey,
        items: [item],
        bbox: [...item.bbox],
        pageIndex: Number(page.page_idx || 0),
        debugRole: item.debugRole
      }));
    const barriers = layoutBarrierBoxes(absoluteRaw);
    const columnRights = columnRightEdgesFromStreams(streams);
    const absoluteBlocks = absoluteVisuals(absoluteRaw, prepared.recordByObject, resolveAsset);
    for (const block of absoluteBlocks) {
      if (numberedFormula(block)) block.numberRight = equationNumberRightForBBox(block.bbox, flatPage.width, columnRights);
    }
    return {
      streams,
      absoluteBlocks,
      profiles: bodyColumnProfiles(prepared.items, flatPage.width, flatPage.height),
      ocrBoxes,
      barriers,
      columnRights,
      modelPage,
      pageWidth: flatPage.width,
      pageHeight: flatPage.height,
    };
  }

  class LayoutTranslationService {
    constructor(storage, llm, webMachine = null) {
      this.storage = storage;
      this.llm = llm;
      this.webMachine = webMachine;
    }

    paths(documentID, targetLanguage) {
      const slug = U.safeStem(targetLanguage, 32, "target").toLowerCase();
      const root = this.storage.path(documentID, "layout-translation");
      return {
        root,
        translations: PathUtils.join(root, `translations.${slug}.json`),
        formulaReplacements: PathUtils.join(root, `formula-replacements.${slug}.json`),
        meta: PathUtils.join(root, `meta.${slug}.json`),
        guide: PathUtils.join(root, `guide.${slug}.md`)
      };
    }

    async loadLayout(documentID) {
      const path = this.storage.path(documentID, "layout.json");
      const [rawText, modelPayload] = await Promise.all([
        this.storage.readText(path, ""),
        this.storage.readJSON(this.storage.path(documentID, "model.json"), [])
      ]);
      let payload = null;
      try {
        payload = rawText ? JSON.parse(rawText) : null;
      }
      catch (_) {}
      const pages = payload?.pdf_info;
      if (!Array.isArray(pages)) throw new Error("当前文献解析结果缺少页面布局，请重新解析");
      const modelPages = Array.isArray(modelPayload)
        ? modelPayload
        : (Array.isArray(modelPayload?.pages) ? modelPayload.pages : []);
      return { payload, pages, modelPages, rawText };
    }

    async sourceFingerprint(documentID) {
      const layout = await this.loadLayout(documentID);
      return U.hashString(layout.rawText || "");
    }

    async loadRevision(documentID) {
      const revision = await this.storage.readJSON(this.storage.path(documentID, "layout-revision.json"), null);
      if (
        revision?.version === 1
        && String(revision.sourceFingerprint || "")
        && String(revision.assetMapHash || "")
      ) return revision;
      return null;
    }

    // Legacy documents predate layout-revision.json. Pay the one-time full
    // read to create it; every later workbench opening can validate caches by
    // reading this tiny manifest instead of the full MinerU layout payload.
    async ensureRevision(documentID) {
      const existing = await this.loadRevision(documentID);
      if (existing) return existing;
      const [layout, assetMap] = await Promise.all([
        this.loadLayout(documentID),
        this.storage.readJSON(this.storage.path(documentID, "asset-map.json"), {})
      ]);
      const revision = {
        version: 1,
        sourceFingerprint: U.hashString(layout.rawText || ""),
        assetMapHash: U.hashString(JSON.stringify(assetMap)),
        generatedAt: new Date().toISOString()
      };
      try { await this.storage.writeJSON(this.storage.path(documentID, "layout-revision.json"), revision); }
      catch (_) {}
      return revision;
    }

    flattenPage(page, pageIndex, documentID, assetMap) {
      const rawBlocks = Array.isArray(page?.preproc_blocks) ? page.preproc_blocks : Array.isArray(page?.blocks) ? page.blocks : [];
      const pageSize = normalizePageSize(page, rawBlocks);
      const output = [];
      let viewSequence = 0;
      let translationSequence = 0;
      let formulaSequence = 0;

      const resolveAsset = target => {
        const key = Asset.normalizeAssetKey(target);
        const stored = assetMap[key] || assetMap[Asset.normalizeAssetKey(Asset.basename(key))] || "";
        return stored ? this.storage.resourceURL(documentID, stored) : "";
      };

      const visit = (block, depth = 0) => {
        if (!block || typeof block !== "object") return;
        const bbox = validBBox(block.bbox);
        const type = String(block.type || "unknown").toLowerCase();
        if (bbox) {
          viewSequence++;
          // Use formula-preserving text for translation. `blockText()` remains
          // the visual fallback, but it flattens
          // an inline equation span into bare TeX and would make both model
          // preservation and post-translation formula validation impossible.
          const tocRows = type === "text" ? parseTocRows(block.lines) : null;
          const text = tocRows
            ? layoutLogicalLines(block.lines).join("\n").trim()
            : (plainBlockText(block) || blockText(block));
          const formulas = formulaSpans(block);
          if (!formulas.length && looksLikeDisplayFormula(text)) formulas.push(text);
          const imagePath = imagePathFromBlock(block);
          const isEquation = ["interline_equation", "equation", "inline_equation", "block_equation"].includes(type);
          // Use span content directly when the parser omitted a specialised
          // formula label.
          if (isEquation && !formulas.length && text.trim()) formulas.push(text.trim());
          let kind = "text";
          // TeX is authoritative when available; otherwise use the equation
          // crop instead of creating an empty math node.
          if (isEquation && formulas.length) kind = "formula";
          else if (isEquation && imagePath) kind = "image";
          else if (imagePath || ["image", "image_body", "chart", "table"].includes(type)) kind = imagePath ? "image" : "text";
          // Text and caption blocks remain translatable when they contain
          // inline formulas. Only standalone equation blocks become formula
          // visuals; otherwise a prose block could be left untranslated.
          const lines = Array.isArray(block.lines) ? block.lines.length : 1;
          const translatable = kind !== "formula" && C.TRANSLATABLE_LAYOUT_TYPES.has(type) && Boolean(text);
          if (translatable) translationSequence++;
          const id = translatable
            ? `p${String(pageIndex + 1).padStart(3, "0")}_${depth ? "c" : "b"}${String(translationSequence).padStart(4, "0")}`
            : `p${String(pageIndex + 1).padStart(3, "0")}_v${String(viewSequence).padStart(4, "0")}`;
          const formulaItems = formulas.map(tex => {
            formulaSequence++;
            return {
              id: `p${String(pageIndex + 1).padStart(3, "0")}_f${String(formulaSequence).padStart(4, "0")}`,
              page: pageIndex + 1,
              type,
              tex
            };
          });
          output.push({
            id,
            page: pageIndex + 1,
            type,
            kind,
            bbox,
            text,
            formulas,
            formulaItems,
            imagePath,
            imageURL: imagePath ? resolveAsset(imagePath) : "",
            lineCount: Math.max(1, lines),
            fontSize: inferFontSize(block, bbox, text, lines),
            depth,
            translatable,
            original: block
          });
        }
        for (const child of Array.isArray(block.blocks) ? block.blocks : []) visit(child, depth + 1);
      };
      for (const block of rawBlocks) visit(block, 0);
      output.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0] || a.id.localeCompare(b.id));
      return { index: pageIndex + 1, width: pageSize[0], height: pageSize[1], blocks: output };
    }

    // A parsed layout revision is published atomically with layout.json and
    // asset-map.json. Translation metadata may intentionally describe an older
    // source after re-parsing, so it cannot validate this cache.
    async buildModel(documentID, translations = null, formulaReplacements = null, knownRevision = null, signal = null) {
      const loaded = translations === null || formulaReplacements === null
        ? await this.loadTranslations(documentID)
        : null;
      const map = translations || loaded?.translations || {};
      const formulaMap = formulaReplacements || loaded?.formulaReplacements || {};
      const translationsHash = U.hashString(JSON.stringify(map) + "|" + JSON.stringify(formulaMap));
      const currentFingerprint = String(
        typeof knownRevision === "object" ? knownRevision?.sourceFingerprint : knownRevision || ""
      );
      const knownAssetMapHash = String(
        typeof knownRevision === "object" ? knownRevision?.assetMapHash : ""
      );
      const compiledPath = this.storage.path(documentID, "compiled-model.json");
      try {
        const cached = await this.storage.readJSON(compiledPath, null);
        if (
          cached &&
          cached.version === 11 &&
          cached.translationsHash === translationsHash &&
          currentFingerprint &&
          cached.sourceFingerprint === currentFingerprint &&
          knownAssetMapHash &&
          cached.assetMapHash === knownAssetMapHash &&
          cached.model?.pages?.length
        ) {
          return cached.model;
        }
      } catch (_) {}

      const { pages, modelPages, rawText } = await this.loadLayout(documentID);
      U.throwIfAborted(signal);
      const sourceFingerprint = U.hashString(rawText || "");
      const assetMap = await this.storage.readJSON(this.storage.path(documentID, "asset-map.json"), {});
      const assetMapHash = U.hashString(JSON.stringify(assetMap));
      const resolveAsset = target => {
        const key = Asset.normalizeAssetKey(target);
        const stored = assetMap[key] || assetMap[Asset.normalizeAssetKey(Asset.basename(key))] || "";
        return stored ? this.storage.resourceURL(documentID, stored) : "";
      };
      const flatPages = [];
      for (let index = 0; index < pages.length; index++) {
        U.throwIfAborted(signal);
        const page = pages[index];
        const model = this.flattenPage(page, index, documentID, assetMap);
        model.blocks = model.blocks.map(block => {
          const formulaItems = (block.formulaItems || []).map(item => ({
            ...item,
            tex: String(formulaMap[item.id] || item.tex || "")
          }));
          const symbolGlossary = block.type === "text" && isSymbolGlossaryBlock(block.original);
          const translatedText = restoreSymbolGlossaryRowBreaks(
            {
              symbolGlossary,
              symbolMarkers: symbolGlossary ? symbolGlossaryMarkers(block.original) : []
            },
            map[block.id] || ""
          );
          return {
            ...block,
            // A legacy cache may predate transport validation. Keep it
            // renderable while classifyRetryRecords schedules a safe retry.
            translatedText: sanitizeModelText(translatedText),
            formulas: formulaItems.map(item => item.tex),
            formulaItems
          };
        });
        flatPages.push(model);
        if (index % 4 === 3) await U.sleep(0, signal);
      }

      // Body-column evidence is established across the document. A page with
      // mostly figures or equations may then borrow only the
      // geometry of its nearest proven neighbour, never its wording.
      const provisional = [];
      for (let index = 0; index < pages.length; index++) {
        U.throwIfAborted(signal);
        const page = pages[index];
        page.page_idx = Number(page.page_idx ?? index);
        const flat = flatPages[index];
        const ocr = collectModelOCRBoxes(modelPages[index] || [], flat.width, flat.height);
        const prepared = prepareFlowItems(page, flat.blocks, ocr);
        provisional.push({ profiles: bodyColumnProfiles(prepared.items, flat.width, flat.height) });
        if (index % 4 === 3) await U.sleep(0, signal);
      }
      const contexts = [];
      for (let index = 0; index < pages.length; index++) {
        U.throwIfAborted(signal);
        const previous = [];
        const following = [];
        for (let cursor = index - 1; cursor >= 0; cursor--) {
          if (Object.keys(provisional[cursor].profiles || {}).length) {
            previous.push(cursor);
            break;
          }
        }
        for (let cursor = index + 1; cursor < pages.length; cursor++) {
          if (Object.keys(provisional[cursor].profiles || {}).length) {
            following.push(cursor);
            break;
          }
        }
        const neighborColumnProfiles = {};
        for (const neighbor of [...previous, ...following]) {
          for (const [column, profiles] of Object.entries(provisional[neighbor].profiles || {})) {
            (neighborColumnProfiles[column] ||= []).push(...profiles);
          }
        }
        contexts.push({ hasPreviousBody: Boolean(previous.length), neighborColumnProfiles });
        if (index % 4 === 3) await U.sleep(0, signal);
      }
      const singleColumnProfile = singleColumnBodyPromotionEnabled()
        ? inferSingleColumnProfile(pages)
        : null;
      const restored = [];
      for (let index = 0; index < pages.length; index++) {
        U.throwIfAborted(signal);
        restored.push(prepareRestoredPage(
          pages[index],
          flatPages[index],
          modelPages[index] || [],
          resolveAsset,
          contexts[index],
          singleColumnProfile
        ));
        if (index % 4 === 3) await U.sleep(0, signal);
      }
      let mainTitleSeen = false;
      for (let index = 0; index < restored.length; index++) {
        U.throwIfAborted(signal);
        const used = expandSpecialAbsoluteBlocks(
          restored[index].absoluteBlocks,
          restored[index].streams,
          flatPages[index].width,
          flatPages[index].height,
          !mainTitleSeen
        );
        if (used) mainTitleSeen = true;
        if (index % 4 === 3) await U.sleep(0, signal);
      }
      const bodyStreams = restored.flatMap(page => page.streams.filter(stream =>
        ["body_candidate", "merged_body"].includes(stream.debugRole)));
      const referenceStreams = restored.flatMap(page => page.streams.filter(stream =>
        (stream.items || []).every(item => item.kind === "ref_text")));
      const ocrBoxesByPage = Object.fromEntries(restored.map((page, index) => {
        const pageIndex = Number(page?.streams?.[0]?.pageIndex);
        return [Number.isFinite(pageIndex) ? pageIndex : index, page.ocrBoxes || []];
      }));
      const inferredBodyStyle = solveUniformStreamStyle(bodyStreams, false, ocrBoxesByPage);
      // Keep translated CJK text within a readable leading range before the
      // browser fitter tightens crowded blocks.
      const bodyStyle = [
        inferredBodyStyle[0],
        Math.min(1.28, Math.max(1.22, inferredBodyStyle[1] + .06))
      ];
      const referenceStyle = solveUniformStreamStyle(referenceStreams, true, ocrBoxesByPage);
      for (const page of restored) {
        // Solve the document-wide body/reference baseline from the restored
        // boxes before widening narrow columns. Expanding first increases
        // capacity and changes the shared starting font.
        for (const stream of page.streams) {
          expandNarrowStream(stream, page.columnRights, page.barriers);
        }
        retreatIntrudingColumnBoundaries(page.streams);
        const occupied = [
          ...page.streams.map(stream => stream.bbox),
          ...page.absoluteBlocks.map(block => block.bbox),
        ].filter(validBBox);
        page.absoluteBlocks.push(...modelFallbackVisuals(
          page.modelPage,
          page.pageWidth,
          page.pageHeight,
          occupied,
        ));
        for (const stream of page.streams) {
          const refsOnly = (stream.items || []).every(item => item.kind === "ref_text");
          const body = !refsOnly && ["body_candidate", "merged_body", "body_inherited"].includes(stream.debugRole);
          const bodyInherited = stream.debugRole === "body_inherited";
          const toc = stream.debugRole === "toc";
          const style = toc ? [8.2, 1.22] : (refsOnly ? referenceStyle : (body ? bodyStyle : [7.6, 1.28]));
          stream.fontSize = style[0];
          stream.lineHeight = style[1];
          stream.paragraphGap = toc ? 0 : (refsOnly ? .10 : .16);
          stream.styleKind = toc ? "toc" : (refsOnly ? "ref_text" : (body ? "body_text" : "text"));
          stream.bodyInherited = bodyInherited;
          stream.refsOnly = refsOnly;
          stream.equationDense = body && (stream.items || []).some(item => item.equationDense);
        }
      }
      const model = {
        documentID,
        sourceFingerprint: U.hashString(rawText || ""),
        styles: {
          bodyText: { fontSize: bodyStyle[0], lineHeight: bodyStyle[1] },
          referenceText: { fontSize: referenceStyle[0], lineHeight: referenceStyle[1] }
        },
        pages: flatPages.map((page, index) => ({
          index: page.index,
          width: page.width,
          height: page.height,
          blocks: page.blocks.map(block => ({
            id: block.id,
            page: block.page,
            type: block.type,
            kind: block.kind,
            bbox: block.bbox,
            text: block.text,
            translatedText: block.translatedText,
            formulas: block.formulas,
            formulaItems: block.formulaItems,
            imagePath: block.imagePath,
            imageURL: block.imageURL,
            lineCount: block.lineCount,
            fontSize: block.fontSize,
            translatable: block.translatable
          })),
          restoration: {
            streams: restored[index].streams,
            absoluteBlocks: restored[index].absoluteBlocks,
            ocrBoxes: restored[index].ocrBoxes
          }
        }))
      };

      try {
        U.throwIfAborted(signal);
        await this.storage.writeJSON(compiledPath, {
          // Version 11 adds per-row paragraphs for nomenclature panels.
          version: 11,
          sourceFingerprint,
          assetMapHash,
          translationsHash,
          model
        });
      } catch (_) {}

      return model;
    }

    extractRecordsFromLayout(layout, documentID, assetMap = {}) {
      const pages = Array.isArray(layout?.pages) ? layout.pages : [];
      const records = [];
      for (let index = 0; index < pages.length; index++) {
        const model = this.flattenPage(pages[index], index, documentID, assetMap);
        for (const block of model.blocks) {
          if (block.translatable) {
            const original = block.original || {};
            const tocRows = block.type === "text" ? parseTocRows(original.lines) : null;
            const symbolGlossary = block.type === "text" && isSymbolGlossaryBlock(original);
            records.push({
              id: block.id,
              page: block.page,
              type: block.type,
              text: sanitizeModelText(tocRows
                ? layoutLogicalLines(original.lines).join("\n").trim()
                : (plainBlockText(original) || block.text)),
              symbolGlossary,
              symbolMarkers: symbolGlossary ? symbolGlossaryMarkers(original) : [],
              formulas: M.extractMathTokens(block.text)
            });
          }
        }
      }
      return records;
    }

    async extractRecords(documentID, preloadedLayout = null, preloadedAssetMap = null) {
      let layout = preloadedLayout;
      let assetMap = preloadedAssetMap;
      if (!layout || assetMap === null) {
        [layout, assetMap] = await Promise.all([
          layout || this.loadLayout(documentID),
          assetMap === null
            ? this.storage.readJSON(this.storage.path(documentID, "asset-map.json"), {})
            : Promise.resolve(assetMap)
        ]);
      }
      return this.extractRecordsFromLayout(layout, documentID, assetMap);
    }

    async extractFormulaContext(documentID) {
      const { pages } = await this.loadLayout(documentID);
      const assetMap = await this.storage.readJSON(this.storage.path(documentID, "asset-map.json"), {});
      const formulas = [];
      for (let index = 0; index < pages.length; index++) {
        const model = this.flattenPage(pages[index], index, documentID, assetMap);
        for (const block of model.blocks) {
          for (const item of block.formulaItems || []) {
            formulas.push({
              id: item.id,
              page: item.page,
              type: item.type,
              tex: item.tex
            });
          }
        }
      }
      return formulas;
    }

    groupRecords(records, maxChars, maxBlocks) {
      if (!(maxChars > 0) && !(maxBlocks > 0)) return records.length ? [records] : [];
      const groups = [];
      let current = [];
      let length = 0;
      for (const record of records) {
        const nextLength = record.text.length + record.id.length + 80;
        if (current.length && (
          (maxBlocks > 0 && current.length >= maxBlocks)
          || (maxChars > 0 && length + nextLength > maxChars)
        )) {
          groups.push(current);
          current = [];
          length = 0;
        }
        current.push(record);
        length += nextLength;
      }
      if (current.length) groups.push(current);
      return groups;
    }

    fastGroupRecords(records, fullMarkdownContext = "") {
      const source = Array.isArray(records) ? records : [];
      const sourceOrder = new Map(source.map((record, index) => [record.id, index]));
      const positions = markdownRecordPositions(source, fullMarkdownContext);
      // MinerU's visual block order can interleave columns.  When a block can
      // be located in full Markdown, use that textual stream as the reading
      // order; retain the original stable order for unmatched/short blocks.
      const ordered = [...source].sort((first, second) => {
        const firstPosition = positions.get(first.id);
        const secondPosition = positions.get(second.id);
        if (firstPosition && secondPosition) return firstPosition[0] - secondPosition[0];
        if (firstPosition) return -1;
        if (secondPosition) return 1;
        return sourceOrder.get(first.id) - sourceOrder.get(second.id);
      });
      const titles = ordered.filter(record => record.type === "title");
      const groups = titles.length ? [titles] : [];
      const bodyGroups = [];
      const supplementary = [];
      let current = [];
      let currentChars = 0;
      let titleBoundaryAfterCurrent = false;
      const canUseSoftOverflow = (existing, next) => (
        existing >= DEEPSEEK_FAST_LAYOUT_TARGET_CHARS * .5
        && existing + next <= DEEPSEEK_FAST_LAYOUT_TARGET_CHARS + DEEPSEEK_FAST_LAYOUT_SOFT_OVERFLOW_CHARS
      );
      const flush = () => {
        if (current.length) bodyGroups.push(current);
        current = [];
        currentChars = 0;
        titleBoundaryAfterCurrent = false;
      };
      for (const record of ordered) {
        if (record.type === "title") {
          if (current.length) titleBoundaryAfterCurrent = true;
          continue;
        }
        if (fastLayoutKind(record) !== "body") {
          supplementary.push(record);
          continue;
        }
        const size = String(record.text || "").length;
        let previousContinues = false;
        if (current.length && !titleBoundaryAfterCurrent && !recordFinishesSentence(current[current.length - 1])) {
          const previous = positions.get(current[current.length - 1].id);
          const position = positions.get(record.id);
          previousContinues = !fullMarkdownContext || Boolean(
            previous && position && position[0] - previous[1] >= 0 && position[0] - previous[1] <= 160
          );
        }
        if (current.length
          && currentChars + size > DEEPSEEK_FAST_LAYOUT_TARGET_CHARS
          && !previousContinues
          && !canUseSoftOverflow(currentChars, size)) {
          flush();
        }
        current.push(record);
        currentChars += size;
        titleBoundaryAfterCurrent = false;
      }
      flush();
      if (bodyGroups.length > 1 && bodyGroups[0].reduce((sum, record) => sum + String(record.text || "").length, 0) < DEEPSEEK_FAST_LAYOUT_MIN_BODY_CHARS) {
        bodyGroups[1] = [...bodyGroups[0], ...bodyGroups[1]];
        bodyGroups.shift();
      }
      const mergedBodyGroups = [];
      for (const group of bodyGroups) {
        const chars = group.reduce((sum, record) => sum + String(record.text || "").length, 0);
        if (mergedBodyGroups.length && chars < DEEPSEEK_FAST_LAYOUT_MIN_BODY_CHARS) mergedBodyGroups.at(-1).push(...group);
        else mergedBodyGroups.push(group);
      }
      groups.push(...mergedBodyGroups);
      let auxiliary = [];
      let auxiliaryChars = 0;
      for (const record of supplementary) {
        const size = String(record.text || "").length;
        if (auxiliary.length
          && auxiliaryChars + size > DEEPSEEK_FAST_LAYOUT_TARGET_CHARS
          && !canUseSoftOverflow(auxiliaryChars, size)) {
          groups.push(auxiliary);
          auxiliary = [];
          auxiliaryChars = 0;
        }
        auxiliary.push(record);
        auxiliaryChars += size;
      }
      if (auxiliary.length) groups.push(auxiliary);
      return groups;
    }

    async waitForFastCacheSettle(signal) {
      const waitMs = 1000;
      const started = Date.now();
      while (Date.now() - started < waitMs) {
        U.throwIfAborted(signal);
        await new Promise(resolve => setTimeout(resolve, Math.min(100, waitMs - (Date.now() - started))));
      }
    }

    async loadTranslations(documentID, targetLanguage = null) {
      const settings = this.llm.getSettings();
      const paths = this.paths(documentID, targetLanguage || settings.targetLanguage);
      const [translations, formulaReplacements, meta] = await Promise.all([
        this.storage.readJSON(paths.translations, {}),
        this.storage.readJSON(paths.formulaReplacements, {}),
        this.storage.readJSON(paths.meta, null)
      ]);
      return { translations, formulaReplacements, meta };
    }

    async importManualTranslation(documentID, responses, emit = null) {
      const settings = this.llm.getSettings();
      const records = await this.extractRecords(documentID);
      const translations = this.normalizeManualTranslations(records, responses);
      if (!Object.keys(translations).length) {
        throw new Error("未能读取排版译文。请确认回答包含带 id 和 text 的独立 JSON 记录，并放在 text 代码块中。");
      }
      const missing = records.filter(record => !translations[record.id]);
      if (missing.length) throw new Error(`排版译文缺少 ${missing.length} 个文本块，请让AI返回全部 block id 后重试。`);
      const paths = this.paths(documentID, settings.targetLanguage);
      const layout = await this.loadLayout(documentID);
      const sourceFingerprint = U.hashString(layout.rawText || "");
      const meta = {
        // PDF attachment publication is deduplicated by this identity. Include
        // the complete block map so a later manual correction is published as
        // a new translation revision instead of being mistaken for the first
        // manual rendering of the same source document.
        identity: U.hashString([layout.rawText || "", settings.targetLanguage, JSON.stringify(translations), "manual-layout-translation-v1"].join("\u241f")),
        sourceFingerprint,
        mode: "manual",
        complete: true,
        totalBlocks: records.length,
        translatedBlocks: Object.keys(translations).length,
        completedAt: new Date().toISOString()
      };
      await this.storage.writeJSON(paths.translations, translations);
      await this.storage.writeJSON(paths.formulaReplacements, {});
      await this.storage.writeJSON(paths.meta, meta);
      const model = await this.buildModel(documentID, translations, {}, { sourceFingerprint });
      emit?.({ type: "layout-translation", translations, model, complete: true, translatedBlocks: records.length, totalBlocks: records.length });
      return { translations, model, meta };
    }

    normalizeManualTranslations(records, responses) {
      const expected = new Set(records.map(record => record.id));
      const translations = {};
      if (responses && !Array.isArray(responses) && typeof responses === "object") {
        for (const [id, text] of Object.entries(responses)) {
          if (expected.has(id) && String(text || "").trim()) translations[id] = String(text).trim();
        }
        return translations;
      }
      for (const response of (Array.isArray(responses) ? responses : [responses])) {
        const raw = String(response || "").trim();
        if (raw) Object.assign(translations, this.parseManualTranslationResponse(raw, records).translations);
      }
      return translations;
    }

    async mergeManualTranslationResponse(documentID, existing, response) {
      const records = await this.extractRecords(documentID);
      const translations = this.normalizeManualTranslations(records, existing);
      const raw = String(response || "").trim();
      if (!raw) throw new Error("请先粘贴AI的翻译结果");
      const parsed = this.parseManualTranslationResponse(raw, records).translations;
      if (!Object.keys(parsed).length) throw new Error("当前回答没有可识别的 block id 和译文，请检查每条 JSON 记录。");
      Object.assign(translations, parsed);
      return { translations, parsedBlocks: Object.keys(parsed).length, totalBlocks: records.length };
    }

    async buildGuide(records, documentID, settings, paths, identity, emit, signal) {
      const existing = await this.storage.readText(paths.guide, "");
      const meta = await this.storage.readJSON(paths.guide + ".json", null);
      if (existing && meta?.identity === identity) return existing;
      const excerpt = [];
      let excerptChars = 0;
      for (const record of records) {
        const estimated = record.text.length + record.id.length + 80;
        if (excerpt.length && excerptChars + estimated > 24000) break;
        excerpt.push({ id: record.id, page: record.page, type: record.type, text: record.text });
        excerptChars += estimated;
      }
      emit?.({ type: "status", phase: "layout-guide", message: "正在整理全文术语和行文风格" });
      const messages = [
        { role: "system", content: "You are a careful academic translation planner." },
        {
          role: "user",
          content: (
            `Prepare a concise guide for translating the following extracted layout blocks into ${settings.targetLanguage}. ` +
            `${U.targetLanguageInstruction(settings.targetLanguage)} Identify field terminology, title/caption conventions, abbreviations, names, and risks. ` +
            "Do not translate every block. Cover citation/style conventions, formula/symbol handling, and captions. Keep the guide under roughly 1200 words.\n\n" +
            JSON.stringify({ blocks: excerpt })
          )
        }
      ];
      await this.storage.writeRequestAudit?.(
        documentID,
        "排版-术语指南",
        { ...settings, promptCacheKey: settings.promptCacheKey },
        messages,
        0
      );
      const result = await this.llm.complete(messages, {
        purpose: "layout",
        documentID,
        provider: settings.provider,
        baseURL: settings.baseURL,
        model: settings.model,
        apiKey: settings.apiKey,
        promptCacheKey: settings.promptCacheKey,
        engine: settings.engine,
        runtime: settings.runtime,
        emit,
        timeout: LAYOUT_REQUEST_TIMEOUT,
        firstEventTimeout: LAYOUT_FIRST_EVENT_TIMEOUT,
        inactivityTimeout: LAYOUT_INACTIVITY_TIMEOUT,
        signal,
        onRateLimitWait: ({ waitMs }) => emit?.({
          type: "status",
          phase: "rate-limit-wait",
          message: `Gemini请求频率受限，约 ${Math.ceil(waitMs / 1000)} 秒后继续整理术语`
        }),
        onText: delta => emit?.({ type: "guide-delta", delta, scope: "layout" }),
        onReasoning: delta => emit?.({ type: "reasoning", delta, scope: "layout-guide" })
      });
      const probeGuideDone = `[探针3-排版指南] 术语指南完成, length=${result?.text?.length || 0}`;
      emit?.({ type: "log", message: probeGuideDone });
      try { Zotero.debug?.(`[LitMTrans-Probe] ${probeGuideDone}`); } catch (_) {}
      await this.storage.writeText(paths.guide, result.text);
      await this.storage.writeJSON(paths.guide + ".json", { identity, createdAt: new Date().toISOString() });
      return result.text;
    }

    parseTranslationResponse(text, group, options = {}) {
      const expected = new Map(group.map(record => [record.id, record]));
      const translations = {};

      let payload = null;
      try {
        payload = U.extractJSONObject(text);
      } catch (extractError) {
        // 【截断/受损容灾兜底】：当常规全量 JSON 解析失败（如 API 输出截断、未闭合引号或尾部受损）时，
        // 借助独立 JSON 片段扫描机制抢救所有已经完整输出的 {"id": "...", "text": "..."}，避免整组判废重来。
        for (const candidate of completeJSONObjectCandidates(text)) {
          let candidatePayload;
          try {
            candidatePayload = U.extractJSONObject(candidate);
          } catch (_) {
            continue;
          }
          const candidateRows = Array.isArray(candidatePayload?.translations)
            ? candidatePayload.translations
            : (candidatePayload && typeof candidatePayload === "object" ? [candidatePayload] : []);
          for (const row of candidateRows) {
            const id = String(row?.id || "");
            const record = expected.get(id);
            if (!record) continue;
            const rawText = acceptedModelText(row?.text, options.sanitizeUnsafe, Boolean(options.allowSanitized));
            if (rawText === null) continue;
            const translated = restoreSymbolGlossaryRowBreaks(
              record,
              repairEquationReferenceTranslation(record?.text, M.normalizeTranslatedInlineHTML(rawText).trim())
            );
            if (!expected.has(id) || !translated) continue;
            translations[id] = translated;
          }
        }
        // 如果成功挽救出部分有效译文，返回已完成内容，未完成部分将自然流向补译（classifyRetryRecords）
        if (Object.keys(translations).length > 0) {
          return { translations, formulaReplacements: {} };
        }
        // 若一个 block 都未能抢救，抛出原始异常维持原重试行为
        throw extractError;
      }

      const rows = Array.isArray(payload?.translations) ? payload.translations : [];
      for (const row of rows) {
        const id = String(row?.id || "");
        const record = expected.get(id);
        const rawText = acceptedModelText(row?.text, options.sanitizeUnsafe, Boolean(options.allowSanitized));
        if (rawText === null) continue;
        const translated = restoreSymbolGlossaryRowBreaks(
          record,
          repairEquationReferenceTranslation(record?.text, M.normalizeTranslatedInlineHTML(rawText).trim())
        );
        if (!expected.has(id) || !translated) continue;
        translations[id] = translated;
      }
      return { translations, formulaReplacements: {} };
    }

    parseManualTranslationResponse(text, group) {
      // Manual translation deliberately uses independent JSON records so a
      // complete answer does not depend on one document-wide closing brace.
      // Keep the legacy aggregate response readable for answers produced by
      // older commands and for users who reuse an earlier browser session.
      try {
        const legacy = this.parseTranslationResponse(text, group, { sanitizeUnsafe: true });
        if (Object.keys(legacy.translations).length) return legacy;
      }
      catch (_) {}

      const expected = new Map(group.map(record => [record.id, record]));
      const translations = {};
      for (const candidate of completeJSONObjectCandidates(text)) {
        let payload;
        try {
          payload = U.extractJSONObject(candidate);
        }
        catch (_) {
          continue;
        }
        const rows = Array.isArray(payload?.translations)
          ? payload.translations
          : (payload && typeof payload === "object" ? [payload] : []);
        for (const row of rows) {
          const id = String(row?.id || "");
          const record = expected.get(id);
          if (!record) continue;
          const rawText = acceptedModelText(row?.text, true, true);
          if (rawText === null) continue;
          const translated = restoreSymbolGlossaryRowBreaks(
            record,
            repairEquationReferenceTranslation(record.text, M.normalizeTranslatedInlineHTML(rawText).trim())
          );
          if (translated) translations[id] = translated;
        }
      }
      return { translations, formulaReplacements: {} };
    }

    sanitizeManualText(value) {
      return sanitizeModelText(value);
    }

    async translateGroup(group, guide, referenceContext, documentID, identity, settings, index, count, emit, signal) {
      const source = group.map(record => ({ id: record.id, page: record.page, type: record.type, text: record.text }));
      const system = "You are a professional academic paper translator and layout-aware scientific copy editor. Translate with field-aware terminology, preserve scientific facts exactly, respect visual bounding box boundaries, and keep layout block IDs stable. You must output strict JSON only, without Markdown fences.";
      const retryDetails = settings.retryDetails && typeof settings.retryDetails.get === "function"
        ? settings.retryDetails
        : null;
      const buildPrimaryUser = requestRecords => (
        `Translate the following academic-paper layout text blocks into ${settings.targetLanguage}.\n` +
        `${U.targetLanguageInstruction(settings.targetLanguage)}\n` +
        "This is a layout-preserving academic-paper translation task. Each block is an isolated physical layout box extracted by visual layout analysis with an id, page, type, and text.\n" +
        "Our typesetting engine places each translated block back into its exact original coordinates. Therefore, each block's translation must strictly correspond to its own source content; moving or migrating content across blocks is strictly prohibited as it causes severe layout collisions and overflow.\n" +
        "Only the listed text-like blocks and captions are translation targets. Image bodies, table bodies, and standalone equation/media blocks must not be translated, described, or reconstructed.\n" +
        "Return ONLY valid JSON with this exact shape:\n" +
        '{"translations":[{"id":"...","text":"..."}]}\n' +
        "Rules:\n" +
        "1. Preserve every id exactly and return one translation for every input block.\n" +
        "2. Physical block boundary and sentence continuation:\n" +
        "   - Translate strictly within the scope of each block's own text. Never borrow, steal, migrate, or merge content across blocks, and never duplicate neighbouring blocks.\n" +
        "   - If a sentence is split across blocks (e.g. across columns or pages):\n" +
        "     * Do NOT complete the entire sentence inside the first block.\n" +
        "     * Do NOT defer or move the whole sentence into the second block.\n" +
        "     * Each block translates only its visible portion. You may adapt phrasing and tone at the split boundary so that when a reader reads continuously from the first block into the second, the full sentence is grammatically natural and fluent, while each block remains strictly faithful to its own text.\n" +
        "   - Example of split handling:\n" +
        '     * Source: Block 1: "The proposed method achieves", Block 2: "superior accuracy on benchmarks."\n' +
        '     * Correct (faithful scope, continuous reading): Block 1 translates only the first part (e.g. "所提出的方法实现了"); Block 2 translates the continuation (e.g. "在基准测试上的卓越准确率。"). When read continuously, the sentence flows naturally.\n' +
        '     * Incorrect (FORBIDDEN): Block 1 translates the whole sentence prematurely (e.g. "所提出的方法在基准测试上取得了卓越准确率。"), leaving Block 2 empty, truncated, or duplicated.\n' +
        "3. Use formal, accurate, fluent academic style suitable for scientific papers. Prefer standard technical terminology over literal word-by-word translation.\n" +
        "4. Preserve inline formulas, variables, citations, reference numbers, units, chemical symbols, material names, figure/table numbers, and numerical values; copy every inline formula verbatim with its original TeX and delimiters.\n" +
        "4a. Because the response is JSON, encode every literal TeX backslash as a JSON escape: write two consecutive backslashes in JSON text (for example, JSON text `\\\\frac` represents the TeX command `\\frac`). Never emit control characters.\n" +
        "5. Preserve equation-number references exactly.\n" +
        "6. If a citation/reference marker in body text appears to be superscript in the source, mark it explicitly with <sup>...</sup>; preserve the original citation number or symbol and do not invent one.\n" +
        "7. Preserve author names, journal headers, page numbers, URLs, affiliations, and bibliographic tokens mostly unchanged unless natural translation is clearly needed.\n" +
        "8. Keep captions concise because they must fit the original layout boxes, but do not delete scientific meaning.\n" +
        "9. Preserve natural paragraph breaks inside a block with blank lines when the source clearly contains multiple paragraphs.\n" +
        "10. Repair obvious OCR spacing or line-break defects silently; do not invent missing data.\n" +
        "11. Do not add notes, explanations, Markdown fences, or extra fields.\n" +
        (settings.transportRecovery
          ? "\nTransport recovery notice: a previous candidate for one or more of these blocks contained forbidden JSON control characters, usually because TeX backslashes were not escaped. This is not a request for an explanation. Return a fresh complete JSON result only; encode every TeX backslash as two consecutive backslashes in the JSON text, and do not emit any control characters.\n"
          : "") +
        (referenceContext ? `\nUser-provided reference corpus for terminology/style only:\n${referenceContext}\nUse it as soft evidence only; source blocks have absolute priority.\n` : "") +
        (settings.customTranslationInstruction ? `\nUser-provided translation instructions (follow these when they do not conflict with source facts):\n${settings.customTranslationInstruction}\n` : "") +
        (guide ? `\nGlobal translation guide:\n${guide}\n` : "") +
        (settings.fullMarkdownContext
          ? "\nFull paper Markdown context follows. It is context only: do not translate, repeat, summarize, or return it. Use it to resolve continuations across pages or columns, but translate ONLY the target blocks supplied after this fixed context and never merge their output.\n===== BEGIN FULL PAPER MARKDOWN =====\n" +
            `${settings.fullMarkdownContext}\n===== END FULL PAPER MARKDOWN =====\n`
          : "") +
        "\nInput blocks JSON:\n" + JSON.stringify({ blocks: requestRecords }, null, 2)
      );
      const retryPayload = retryDetails
        ? group.map(record => {
          const details = retryDetails.get(record.id) || {};
          const reasons = Array.isArray(details.reasons) ? details.reasons : [];
          const currentTranslation = String(details.currentTranslation || "");
          return {
            id: record.id,
            page: record.page,
            type: record.type,
            text: record.text,
            current_translation: currentTranslation,
            retry_reasons: reasons,
            retry_details: String(details.details || retryDetailsForRecord(
              record,
              { [record.id]: currentTranslation },
              reasons
            ) || ""),
            repair_mode: isFormatOnlyRetryReasons(reasons) ? "symbol-format-only" : "retranslate"
          };
        })
        : [];
      const retryFormatOnly = retryPayload.length > 0
        && retryPayload.every(item => item.repair_mode === "symbol-format-only");
      const retryUser = retryDetails ? (
        retryFormatOnly
          ? "This is a surgical formula/JSON-format check. Do not explain your reasoning, retranslate, or polish prose. retry_reasons and retry_details are fallible program guesses, not factual conclusions; independently verify the source, current_translation, and math structure. If normalized math is already equivalent (whitespace, redundant braces, \\mathrm wrappers, or OCR list markers), or you cannot confirm a real error, return current_translation unchanged. Otherwise repair only the named missing/altered delimiter or math token and keep surrounding prose, citations, and identifiers unchanged. Return only JSON with shape {\"translations\":[{\"id\":\"...\",\"text\":\"...\"}],\"formula_replacements\":[]}; use normal JSON escaping.\n\n"
          : `Review only the complete blocks listed below. Target language is ${settings.targetLanguage || "Simplified Chinese"}. retry_reasons and retry_details are heuristic signals, not factual conclusions; they can be false positives or false negatives. Independently decide the most accurate output from the source and current_translation; change a block only when you confirm a real problem, and return current_translation unchanged if you cannot confirm one. For retranslate, translate strictly within the visible block's own scope. Never complete sentences prematurely with text from other blocks, never merge blocks, and never duplicate or migrate content between blocks. Return only JSON with shape {\"translations\":[{\"id\":\"...\",\"text\":\"...\"}],\"formula_replacements\":[]} and no explanation.\n\n`
      ) + JSON.stringify({ blocks_to_correct: retryPayload }, null, 2) : "";
      const retryContext = retryDetails && Array.isArray(settings.retryContextGroup)
        ? settings.retryContextGroup.map(record => ({ id: record.id, page: record.page, type: record.type, text: record.text }))
        : null;
      const primaryMessages = retryDetails && retryContext?.length
        ? [{ role: "system", content: system }, { role: "user", content: buildPrimaryUser(retryContext) }, { role: "user", content: retryUser }]
        : [{ role: "system", content: system }, { role: "user", content: retryUser || buildPrimaryUser(source) }];
      await this.storage.writeRequestAudit?.(
        documentID,
        `排版-第${index + 1}组`,
        {
          ...settings,
          ...(retryFormatOnly ? { thinkingMode: "disabled", reasoningEffort: "minimal" } : {}),
          promptCacheKey: settings.promptCacheKey
        },
        primaryMessages,
        0
      );
      let streamed = "";
      let latestUsage = null;
      let result;
      try {
        result = await this.llm.complete(primaryMessages, {
          purpose: "layout",
          documentID,
          provider: settings.provider,
          baseURL: settings.baseURL,
          model: settings.model,
          apiKey: settings.apiKey,
          targetLanguage: settings.targetLanguage,
          thinkingMode: settings.thinkingMode,
          reasoningEffort: settings.reasoningEffort,
          ...(retryFormatOnly ? { thinkingMode: "disabled", reasoningEffort: "minimal" } : {}),
          promptCacheKey: settings.promptCacheKey,
          engine: settings.engine,
          runtime: settings.runtime,
          emit,
          timeout: LAYOUT_REQUEST_TIMEOUT,
          firstEventTimeout: LAYOUT_FIRST_EVENT_TIMEOUT,
          inactivityTimeout: LAYOUT_INACTIVITY_TIMEOUT,
          signal,
          onRateLimitWait: ({ waitMs }) => emit?.({
            type: "status",
            phase: "rate-limit-wait",
            message: `Gemini请求频率受限，约 ${Math.ceil(waitMs / 1000)} 秒后继续处理第 ${index + 1} 组`
          }),
          responseFormat: "json_object",
          onText: delta => {
            streamed += delta;
            emit?.({ type: "layout-raw-delta", delta, group: index + 1, groupCount: count, attempt: "primary" });
          },
          onUsage: usage => { latestUsage = usage && typeof usage === "object" ? { ...usage } : null; },
          onReasoning: delta => emit?.({ type: "reasoning", delta, scope: "layout", group: index + 1 })
        });
      } catch (completeError) {
        U.throwIfAborted(signal);
        if (signal?.aborted || completeError?.name === "AbortError") {
          throw completeError;
        }
        const isRetryPass = Boolean(retryDetails || settings.transportRecovery);
        if (streamed && typeof streamed === "string" && streamed.includes("{")) {
          try {
            const partial = this.parseTranslationResponse(streamed, group, { sanitizeUnsafe: true, allowSanitized: isRetryPass });
            if (partial?.translations && Object.keys(partial.translations).length > 0) {
              result = { text: streamed, usage: latestUsage };
            }
          } catch (_) {}
        }
        if (!result) throw completeError;
      }
      const isRetryPass = Boolean(retryDetails || settings.transportRecovery);
      const parsed = this.parseTranslationResponse(result.text, group, { sanitizeUnsafe: true, allowSanitized: isRetryPass });
      const retryClassified = settings.deferLayoutRetry
        ? []
        : classifyRetryRecords(group, parsed.translations, settings.targetLanguage, settings.enableUntranslatedCheck);
      if (retryClassified.length) {
        let currentClassified = retryClassified;
        const formatRetryAttempted = new Set();
        const maxAttempts = 1;
        for (let attempt = 1; attempt <= maxAttempts && currentClassified.length > 0; attempt++) {
          const retryRecords = currentClassified.map(item => item.record);
          const retryFormatOnly = retryRecords.length > 0
            && currentClassified.every(item => isFormatOnlyRetryReasons(item.reasons));
          for (const item of currentClassified) {
            if (isFormatOnlyRetryReasons(item.reasons)) formatRetryAttempted.add(item.record.id);
          }
          emit?.({
            type: "warning",
            message: `第${index + 1}部分有${retryRecords.length}处内容需要校对，正在尝试修正。`
          });
          const retrySource = currentClassified.map(({ record, reasons, details }) => ({
            id: record.id,
            page: record.page,
            type: record.type,
            text: record.text,
            current_translation: parsed.translations[record.id] || "",
            retry_reasons: reasons || [],
            retry_details: details || retryDetailsForRecord(record, parsed.translations, reasons || []),
            repair_mode: isFormatOnlyRetryReasons(reasons) ? "symbol-format-only" : "retranslate"
          }));
          const retryMessages = [
            // Translation-quality retries may keep the complete source group
            // as context. Pure format retries are surgical from the first
            // attempt; later retries are surgical for every reason.
            ...(attempt === 1 && !retryFormatOnly ? primaryMessages : [{ role: "system", content: system }]),
            {
              role: "user",
              content: (
                retryFormatOnly
                  ? "Surgical formula/JSON-format repair only. Do not explain reasoning, retranslate, or polish prose. Treat retry_details as a heuristic signal; if normalized math is equivalent (whitespace, redundant braces, \\mathrm wrappers, or OCR list markers), return current_translation unchanged. Otherwise fix only the named math delimiter/token and keep prose, citations, and identifiers unchanged. Return only JSON with shape {\"translations\":[{\"id\":\"...\",\"text\":\"...\"}],\"formula_replacements\":[]}.\n\n"
                  : `Review only these blocks (attempt ${attempt}/${maxAttempts}). Target language is ${settings.targetLanguage || "Simplified Chinese"}. retry_reasons and retry_details are heuristic signals, not factual conclusions; they can be false positives or false negatives. Change a block only when the source and current_translation show a real problem. Translate only the visible block, never complete, merge, or duplicate a neighbouring block. Return only JSON with shape {\"translations\":[{\"id\":\"...\",\"text\":\"...\"}],\"formula_replacements\":[]} and no explanation.\n\n` +
                JSON.stringify({ blocks_to_correct: retrySource }, null, 2)
              )
            }
          ];
          await this.storage.writeRequestAudit?.(
            documentID,
            `排版-第${index + 1}组重试-${attempt}`,
            {
              ...settings,
              ...(retryFormatOnly ? { thinkingMode: "disabled", reasoningEffort: "minimal" } : {}),
              promptCacheKey: settings.promptCacheKey
            },
            retryMessages,
            0
          );
          const retry = await this.llm.complete(retryMessages, {
            purpose: "layout",
            documentID,
            provider: settings.provider,
            baseURL: settings.baseURL,
            model: settings.model,
            apiKey: settings.apiKey,
            targetLanguage: settings.targetLanguage,
            ...(retryFormatOnly ? { thinkingMode: "disabled", reasoningEffort: "minimal" } : {}),
            promptCacheKey: settings.promptCacheKey,
            engine: settings.engine,
            runtime: settings.runtime,
            timeout: LAYOUT_REQUEST_TIMEOUT,
            firstEventTimeout: LAYOUT_FIRST_EVENT_TIMEOUT,
            inactivityTimeout: LAYOUT_INACTIVITY_TIMEOUT,
            signal,
            onRateLimitWait: ({ waitMs }) => emit?.({
              type: "status",
              phase: "rate-limit-wait",
              message: `Gemini请求频率受限，约${Math.ceil(waitMs / 1000)}秒后继续校对`
            }),
            responseFormat: "json_object",
            onText: delta => emit?.({
              type: "layout-raw-delta",
              delta,
              group: index + 1,
              groupCount: count,
              attempt: `retry-${attempt}`
            }),
            onReasoning: delta => emit?.({ type: "reasoning", delta, scope: `layout-retry-${attempt}`, group: index + 1 })
          });
          const corrected = this.parseTranslationResponse(retry.text, retryRecords, { sanitizeUnsafe: true, allowSanitized: true });
          parsed.translations = { ...parsed.translations, ...corrected.translations };
          parsed.formulaReplacements = { ...parsed.formulaReplacements, ...corrected.formulaReplacements };
          currentClassified = classifyRetryRecords(group, parsed.translations, settings.targetLanguage, settings.enableUntranslatedCheck)
            .filter(item => !isFormatOnlyRetryReasons(item.reasons) || !formatRetryAttempted.has(item.record.id));
        }
      }
      const remaining = settings.deferLayoutRetry
        ? []
        : recordsNeedingRetry(group, parsed.translations, settings.targetLanguage, settings.enableUntranslatedCheck);
      if (remaining.length) {
        const incomplete = untranslatedOrMissingRecords(
          group,
          parsed.translations,
          settings.targetLanguage,
          settings.enableUntranslatedCheck
        );
        if (incomplete.length) {
          emit?.({
            type: "warning",
            message: `自动校对后仍有${incomplete.length}处未能完成，相关结果已保留。`
          });
        }
        const unsafe = unsafeOverexpandedRecords(group, parsed.translations, settings.targetLanguage);
        const unsafeIDs = new Set(unsafe.map(record => record.id));
        for (const record of suspiciousDuplicateTranslationRecords(group, parsed.translations)) {
          if (!unsafeIDs.has(record.id)) {
            unsafe.push(record);
            unsafeIDs.add(record.id);
          }
        }
        if (unsafe.length) {
          emit?.({
            type: "warning",
            message: `自动校对后仍有${unsafe.length}处内容需要留意。结果已保留，您可以查看后决定是否重新翻译。`
          });
        }
      }
      for (const record of group) {
        if (!parsed.translations[record.id]) {
          // During the document-wide first pass/recovery phase, preserve the
          // absence so the coordinator can classify it as genuinely missing.
          // Standalone group calls still receive the legacy safe fallback.
          if (!settings.deferLayoutRetry) parsed.translations[record.id] = record.text;
        }
        else parsed.translations[record.id] = repairEquationReferenceTranslation(
          record.text,
          M.normalizeTranslatedInlineHTML(parsed.translations[record.id])
        );
      }
      return { ...parsed, usage: latestUsage || result?.usage || null };
    }

    async translateWebMachine(documentID, settings, emit, signal) {
      if (!this.webMachine) throw new Error("联网翻译未就绪，请稍后重试");
      const provider = U.providerSpec(settings.provider).id;
      const edgeLocal = provider === "edge_local";
      const sourceLanguage = edgeLocal ? settings.machineSourceLanguage : settings.sourceLanguage;
      const paths = this.paths(documentID, settings.targetLanguage);
      await this.storage.ensureDir(paths.root);
      const [layout, assetMap] = await Promise.all([
        this.loadLayout(documentID),
        this.storage.readJSON(this.storage.path(documentID, "asset-map.json"), {})
      ]);
      const records = await this.extractRecords(documentID, layout, assetMap);
      if (!records.length) throw new Error("当前文档没有可翻译的正文。");
      const sourceFingerprint = U.hashString(layout.rawText || "");
      const identity = U.hashString([
        "layout-web-machine-v3-image-footnote-fit",
        layout.rawText,
        provider,
        sourceLanguage,
        settings.targetLanguage
      ].join("\u241f"));
      const current = await this.loadTranslations(documentID, settings.targetLanguage);
      if (!settings.force && current.meta?.identity === identity && current.meta?.complete) {
        const model = await this.buildModel(documentID, current.translations, current.formulaReplacements, { sourceFingerprint }, signal);
        emit?.({ type: "layout-translation", translations: current.translations, model, complete: true, cached: true });
        return { ...current, model, cached: true };
      }
      emit?.({
        type: "status",
        phase: "web-machine-probe",
        message: edgeLocal ? "正在启动Edge本地翻译…" : "正在连接联网免费机翻，必要时将自动切换Bing。",
        progress: 0
      });
      const translations = await this.webMachine.translateRecords(records, {
        provider,
        targetLanguage: settings.targetLanguage,
        sourceLanguage,
        signal,
        log: message => emit?.({ type: "log", message }),
        liveUpdate: partial => {
          // A string update is progress text, not a translation dictionary;
          // keep it out of the layout checkpoint event.
          if (typeof partial === "string") {
            const progress = /已完成\s*:\s*(\d+)\s*\/\s*(\d+)/.exec(partial);
            emit?.({
              type: "status",
              phase: "web-machine-layout",
              message: partial,
              progress: progress ? Number(progress[1]) / Math.max(1, Number(progress[2])) : 0
            });
            return;
          }
          if (!partial || typeof partial !== "object" || Array.isArray(partial)) return;
          emit?.({
            type: "layout-translation",
            translations: partial,
            model: null,
            complete: false,
            translatedBlocks: Object.keys(partial).length,
            totalBlocks: records.length
          });
        }
      });
      const normalizedTranslations = {};
      for (const record of records) {
        normalizedTranslations[record.id] = normalizeWebMachineRecord(
          record,
          translations[record.id] ?? record.text
        );
      }
      Object.assign(translations, normalizedTranslations);
      const formulaReplacements = {};
      const meta = {
        identity,
        sourceFingerprint,
        complete: true,
        provider,
        service: edgeLocal ? "Edge本地翻译" : "联网免费机翻（Google / Bing）",
        sourceLanguage,
        targetLanguage: settings.targetLanguage,
        translationMode: "web-machine",
        totalBlocks: records.length,
        translatedBlocks: Object.keys(translations).length,
        completedAt: new Date().toISOString()
      };
      if (settings.force && this.storage.temporaryDir) {
        const staging = this.storage.temporaryDir("layout-web-machine");
        const staged = { translations: PathUtils.join(staging, "translations.json"), formulaReplacements: PathUtils.join(staging, "formulas.json"), meta: PathUtils.join(staging, "meta.json") };
        try {
          await this.storage.writeJSON(staged.translations, translations);
          await this.storage.writeJSON(staged.formulaReplacements, formulaReplacements);
          await this.storage.writeJSON(staged.meta, meta);
          await this.storage.publishFilesAtomically([
            { source: staged.translations, destination: paths.translations },
            { source: staged.formulaReplacements, destination: paths.formulaReplacements },
            { source: staged.meta, destination: paths.meta }
          ]);
        } finally { await this.storage.remove(staging, true); }
      } else {
        await this.storage.writeJSON(paths.translations, translations);
        await this.storage.writeJSON(paths.formulaReplacements, formulaReplacements);
        await this.storage.writeJSON(paths.meta, meta);
      }
      const model = await this.buildModel(documentID, translations, formulaReplacements, { sourceFingerprint }, signal);
      emit?.({ type: "layout-translation", translations, model, complete: true });
      return { translations, formulaReplacements, model, meta, cached: false };
    }

    async translate(documentID, options = {}, emit = null, signal = null) {
      let settings = { ...this.llm.getSettings(), ...options };
      if (LitMTrans.WebMachineTranslation?.isWebMachineProvider(settings.provider)) {
        return this.translateWebMachine(documentID, settings, emit, signal);
      }
      // Layout titles and body blocks that are clearly returned unchanged need
      // one of the bounded recovery attempts. This remains a heuristic signal
      // for the model, never a conclusive instruction to rewrite content.
      settings.enableUntranslatedCheck = settings.enableUntranslatedCheck !== false;
      const isWeb = this.llm.isWebEngineActive?.({ purpose: "translation", ...options, ...settings });
      let resolvedModel;
      if (isWeb) {
        resolvedModel = { provider: "deepseek_web", model: "deepseek-web", baseURL: "" };
        settings.provider = "deepseek_web";
        settings.baseURL = "";
        settings.model = "deepseek-web";
        settings.engine = "deepseek_web";
        settings.aiMode = "web";
        settings.runtime = options.runtime;
      } else {
        resolvedModel = await this.llm.ensureConfiguredModel(
          this.llm.resolveConfig({
            purpose: "translation",
            engine: "api",
            aiMode: "api",
            provider: settings.provider,
            baseURL: settings.baseURL,
            model: settings.model,
            apiKey: settings.apiKey
          }),
          signal
        );
        settings.provider = resolvedModel.provider;
        settings.baseURL = resolvedModel.baseURL;
        settings.model = resolvedModel.model;
        settings.engine = "api";
        settings.aiMode = "api";
      }
      // The preference remembers the user's DeepSeek choice while they switch
      // providers. It is only an active request when DeepSeek itself is
      // selected; otherwise Gemini and other providers must not emit a
      // misleading DeepSeek fallback warning.
      const fastModeRequested = Boolean(
        settings.deepseekFastLayoutTranslation
        && String(settings.provider || "").trim().toLowerCase() === "deepseek"
      );
      let fastMode = Boolean(fastModeRequested && isOfficialDeepSeekConfig(settings));
      if (fastModeRequested && !fastMode) {
        emit?.({ type: "warning", message: "快速排版翻译仅支持 DeepSeek 官方接口，本次将使用标准排版翻译。" });
      }
      let fullMarkdownContext = "";
      if (fastMode) {
        fullMarkdownContext = stripMarkdownImages(await this.storage.readText(
          this.storage.path(documentID, "full.cleaned.md"), ""
        ));
        if (!fullMarkdownContext) {
          fastMode = false;
          emit?.({ type: "warning", message: "当前文献缺少快速排版翻译所需的全文内容，本次将使用标准排版翻译。" });
        }
        else {
          settings = {
            ...settings,
            thinkingMode: "disabled",
            fullMarkdownContext
          };
          emit?.({ type: "log", message: "已启用 DeepSeek 快速排版翻译。" });
        }
      }
      const requestedTranslationMode = String(options.mode || settings.translationMode || "full_context") === "chunked"
        ? "chunked"
        : "full_context";
      const translationMode = fastMode ? "deepseek_fast" : requestedTranslationMode;
      const maxConcurrency = layoutConcurrencyLimit(settings.provider, settings.baseURL);
      const configuredConcurrency = Number(settings.layoutConcurrency);
      const layoutMaxChars = requestedTranslationMode === "chunked"
        ? Number(settings.layoutChunkChars ?? 135000)
        : 0;
      const layoutMaxBlocks = requestedTranslationMode === "chunked"
        ? Number(settings.layoutChunkBlocks ?? 160)
        : 0;
      let concurrency = fastMode
        ? DEEPSEEK_FAST_LAYOUT_CONCURRENCY
        : (requestedTranslationMode === "chunked"
        ? Math.max(
          1,
          Math.min(
            maxConcurrency,
            Number.isFinite(configuredConcurrency) && configuredConcurrency > 0
              ? Math.trunc(configuredConcurrency)
              : maxConcurrency
          )
        )
        : 1);
      const paths = this.paths(documentID, settings.targetLanguage);
      await this.storage.ensureDir(paths.root);
      const [layout, assetMap] = await Promise.all([
        this.loadLayout(documentID),
        this.storage.readJSON(this.storage.path(documentID, "asset-map.json"), {})
      ]);
      const records = await this.extractRecords(documentID, layout, assetMap);
      if (!records.length) throw new Error("当前文档没有可翻译的正文。");
      const sourceFingerprint = U.hashString(layout.rawText || "");
      const identity = U.hashString([
        // Change this token when translation inputs or validation rules change.
          "layout-translation-v9-image-footnote-fit",
        layout.rawText,
        settings.provider,
        settings.baseURL,
        settings.model,
        settings.targetLanguage,
        translationMode,
        fastMode ? U.hashString(fullMarkdownContext) : "",
        settings.enableUntranslatedCheck ? "untranslated-check:on" : "untranslated-check:off",
        settings.referenceIdentity || "",
        settings.customTranslationInstruction || ""
      ].join("\u241f"));
      settings.promptCacheKey = U.opaqueCacheKey(
        "layout-translation",
        documentID,
        settings.model,
        settings.targetLanguage,
        identity
      );
      const current = await this.loadTranslations(documentID, settings.targetLanguage);
      if (!options.force && current.meta?.identity === identity && current.meta?.complete) {
        const cacheRetryRecords = recordsNeedingRetry(
          records,
          current.translations,
          settings.targetLanguage,
          settings.enableUntranslatedCheck
        );
        if (!cacheRetryRecords.length) {
          const model = await this.buildModel(documentID, current.translations, current.formulaReplacements, { sourceFingerprint }, signal);
          emit?.({ type: "layout-translation", translations: current.translations, model, complete: true, cached: true });
          return {
            translations: current.translations,
            formulaReplacements: current.formulaReplacements,
            model,
            meta: current.meta,
            cached: true
          };
        }
        emit?.({
          type: "warning",
          message: `已保留可用译文，正在校对${cacheRetryRecords.length}处内容。`
        });
      }

      const preservePublished = Boolean(
        options.force
        && current.meta?.complete
        && Object.keys(current.translations || {}).length
      );
      let stagingRoot = null;
      let activePaths = paths;
      if (options.force) {
        // Layout translation may run under a long document path. Keep the
        // in-progress generation in the shared short temporary root.
        stagingRoot = this.storage.temporaryDir
          ? this.storage.temporaryDir("layout")
          : paths.root;
        activePaths = {
          translations: PathUtils.join(stagingRoot, "translations.json"),
          formulaReplacements: PathUtils.join(stagingRoot, "formulas.json"),
          meta: PathUtils.join(stagingRoot, "meta.json")
        };
      }
      if (options.force) {
        await this.storage.remove(paths.guide, false);
        await this.storage.remove(paths.guide + ".json", false);
        emit?.({
          type: "log",
          message: preservePublished
            ? "正在重新翻译。新译文完成前，当前版本仍可阅读和导出。"
            : "正在重新生成排版译文。"
        });
      }
      let translations = options.force
        ? {}
        : (current.meta?.identity === identity ? { ...current.translations } : {});
      // Independent equations are never revised during text translation.
      // Inline TeX remains inside its complete text block instead.
      let formulaReplacements = {};
      const retryIDs = new Set(
        recordsNeedingRetry(records, translations, settings.targetLanguage, settings.enableUntranslatedCheck).map(record => record.id)
      );
      const remaining = records.filter(record => !translations[record.id] || retryIDs.has(record.id));
      const groups = fastMode
        ? this.fastGroupRecords(remaining, fullMarkdownContext)
        : this.groupRecords(remaining, layoutMaxChars, layoutMaxBlocks);
      // Retry once at document scope after all first-pass groups have returned.
      settings.deferLayoutRetry = true;
      const allGroups = fastMode
        ? this.fastGroupRecords(records, fullMarkdownContext)
        : this.groupRecords(records, layoutMaxChars, layoutMaxBlocks);
      const guide = !fastMode && allGroups.length > 1
        ? await this.buildGuide(records, documentID, settings, paths, identity, emit, signal)
        : "";
      await this.storage.writeJSON(activePaths.meta, {
        identity,
        sourceFingerprint,
        complete: false,
        provider: settings.provider,
        baseURL: settings.baseURL,
        model: settings.model,
        targetLanguage: settings.targetLanguage,
        translationMode,
        concurrency,
        totalBlocks: records.length,
        translatedBlocks: Object.keys(translations).length,
        startedAt: new Date().toISOString()
      });

      const baseTranslations = { ...translations };
      const baseFormulaReplacements = { ...formulaReplacements };
      const completedResults = new Map();
      const failures = [];
      let nextGroupIndex = 0;
      let completedGroupCount = 0;
      let commitTail = Promise.resolve();
      if (groups.length) {
        emit?.({
          type: "log",
          message: fastMode
            ? `正在使用 DeepSeek 快速翻译，共 ${groups.length} 部分。`
            : translationMode === "full_context"
            ? `正在翻译全文，共 ${remaining.length} 个文本区域。`
            : `正在分段翻译，共 ${groups.length} 部分。`
        });
      }
      const commitResult = (index, translated) => {
        const task = commitTail.then(async () => {
          completedResults.set(index, translated);
          translations = { ...baseTranslations };
          formulaReplacements = { ...baseFormulaReplacements };
          for (const groupIndex of [...completedResults.keys()].sort((a, b) => a - b)) {
            const result = completedResults.get(groupIndex);
            translations = { ...translations, ...result.translations };
            formulaReplacements = { ...formulaReplacements, ...result.formulaReplacements };
          }
          completedGroupCount = completedResults.size;
          await this.storage.writeJSON(activePaths.translations, translations);
          await this.storage.writeJSON(activePaths.formulaReplacements, formulaReplacements);
          await this.storage.writeJSON(activePaths.meta, {
            identity,
            sourceFingerprint,
            complete: false,
            provider: settings.provider,
            baseURL: settings.baseURL,
            model: settings.model,
            targetLanguage: settings.targetLanguage,
            translationMode,
            totalBlocks: records.length,
            translatedBlocks: Object.keys(translations).length,
            completedGroups: completedGroupCount,
            groupCount: groups.length,
            concurrency,
            updatedAt: new Date().toISOString()
          });
          // 只由这个串行协调器写检查点；整本文档模型留到最终结果再构建。
          // 中间模型不会触发阅读器渲染，反复构建只会占用主线程和内存。
          emit?.({
            type: "layout-translation",
            translations,
            model: null,
            complete: false,
            translatedBlocks: Object.keys(translations).length,
            totalBlocks: records.length,
            completedGroups: completedGroupCount,
            groupCount: groups.length,
            preview: preservePublished
          });
        });
        commitTail = task.catch(() => {});
        return task;
      };
      const fastTelemetry = new Map();
      const fastPhases = new Map();
      const fastInitialStartedAt = fastMode ? Date.now() : 0;
      let fastInitialFinishedAt = 0;
      let fastSubmittedWaveCount = 0;
      let fastWorkerLimit = 0;
      const recordFastTelemetry = (index, usage, elapsedMs) => {
        if (!fastMode) return;
        const normalizedUsage = usage && typeof usage === "object" ? usage : {};
        const hit = Number(normalizedUsage.prompt_cache_hit_tokens || 0);
        const miss = Number(normalizedUsage.prompt_cache_miss_tokens || 0);
        const prompt = Number(normalizedUsage.prompt_tokens ?? normalizedUsage.input_tokens ?? 0);
        const completion = Number(normalizedUsage.completion_tokens ?? normalizedUsage.output_tokens ?? 0);
        const phase = fastPhases.get(index) || "正文翻译";
        const item = { phase, hit, miss, prompt, completion, elapsedMs, usageReceived: Object.keys(normalizedUsage).length > 0 };
        fastTelemetry.set(index, item);
        emit?.({ type: "log", message: `已完成第 ${index + 1}/${groups.length} 部分。` });
      };
      const translateAndCommit = async index => {
        U.throwIfAborted(signal);
        emit?.({
          type: "status",
          phase: "layout-translate",
          message: fastMode
            ? `正在翻译第 ${index + 1}/${groups.length} 部分`
            : translationMode === "full_context"
            ? "正在生成完整排版译文"
            : `正在翻译第 ${index + 1}/${groups.length} 部分`,
          progress: Math.round(completedGroupCount * 100 / Math.max(1, groups.length))
        });
        try {
          let translated;
          const requestStartedAt = Date.now();
          try {
            translated = await this.translateGroup(groups[index], guide, String(settings.referenceContext || ""), documentID, identity, settings, index, groups.length, emit, signal);
          }
          catch (error) {
            U.throwIfAborted(signal);
            emit?.({ type: "warning", message: `第${index + 1}/${groups.length}部分请求失败，正在自动重试一次：${error?.message || error}` });
            translated = await this.translateGroup(groups[index], guide, String(settings.referenceContext || ""), documentID, identity, { ...settings, transportRecovery: true }, index, groups.length, emit, signal);
          }
          recordFastTelemetry(index, translated?.usage, Date.now() - requestStartedAt);
          await commitResult(index, translated);
          return true;
        }
        catch (error) {
          failures.push({ index, error });
          emit?.({ type: "warning", message: `第${index + 1}/${groups.length}部分翻译失败，其他已完成内容不会丢失：${error?.message || error}` });
          return false;
        }
      };
      const runWorker = async () => {
        while (true) {
          const index = nextGroupIndex++;
          if (index >= groups.length) return;
          await translateAndCommit(index);
        }
      };
      if (fastMode) {
        const warmupCount = Math.min(DEEPSEEK_FAST_LAYOUT_WARMUP_REQUESTS, groups.length);
        let completedWarmupCount = warmupCount;
        let cacheHitConfirmed = false;
        let cacheProbeRate = null;
        for (let index = 0; index < warmupCount; index++) {
          fastPhases.set(index, index === 0 && groups[index]?.every(record => record.type === "title") ? "标题" : "正文");
          await translateAndCommit(index);
          const usage = fastTelemetry.get(index) || {};
          emit?.({ type: "log", message: `正在准备快速翻译（${index + 1}/${warmupCount}）。` });
          if (index === warmupCount - 1 && warmupCount > 1) {
            const cacheTokens = Number(usage.hit || 0) + Number(usage.miss || 0);
            if (cacheTokens > 0) {
              cacheProbeRate = Number(usage.hit || 0) / cacheTokens;
              cacheHitConfirmed = cacheProbeRate >= DEEPSEEK_FAST_LAYOUT_MIN_CACHE_HIT_RATE;
            }
          }
          if (index === 0 && warmupCount > 1) {
            emit?.({ type: "log", message: "正在准备快速翻译…" });
            await this.waitForFastCacheSettle(signal);
          }
        }
        if (warmupCount > 1) {
          emit?.({ type: "log", message: "正在准备快速翻译…" });
          await this.waitForFastCacheSettle(signal);
        }
        // A cold cache can need one more request to settle. Do not release the
        // parallel wave when the second probe misses; first verify a third
        // request can reach the stricter steady-state threshold.
        if (!cacheHitConfirmed && warmupCount > 1 && groups.length > warmupCount) {
          const index = warmupCount;
          fastPhases.set(index, "正文复检");
          emit?.({ type: "log", message: "缓存尚未稳定，正在进行最后一次检查…" });
          await translateAndCommit(index);
          completedWarmupCount++;
          const usage = fastTelemetry.get(index) || {};
          const cacheTokens = Number(usage.hit || 0) + Number(usage.miss || 0);
          cacheProbeRate = cacheTokens > 0 ? Number(usage.hit || 0) / cacheTokens : null;
          cacheHitConfirmed = cacheProbeRate !== null
            && cacheProbeRate >= DEEPSEEK_FAST_LAYOUT_RETRY_MIN_CACHE_HIT_RATE;
        }
        nextGroupIndex = completedWarmupCount;
        fastSubmittedWaveCount = Math.max(0, groups.length - completedWarmupCount);
        if (cacheHitConfirmed) {
          fastWorkerLimit = Math.min(DEEPSEEK_FAST_LAYOUT_CONCURRENCY, fastSubmittedWaveCount);
          emit?.({ type: "log", message: "快速翻译已准备就绪。" });
        }
        else {
          if (fastSubmittedWaveCount && warmupCount > 1) {
            await commitTail;
            const rateText = cacheProbeRate === null
              ? "不可计算（服务未返回缓存 token 统计）"
              : `${(cacheProbeRate * 100).toFixed(1)}%`;
            const message = `DeepSeek 缓存未达到快速翻译要求（本次 ${rateText}，最低 ${DEEPSEEK_FAST_LAYOUT_RETRY_MIN_CACHE_HIT_RATE * 100}%）。为避免重复计费，剩余内容尚未发送。您可以稍后重试，或关闭快速排版翻译后继续。`;
            emit?.({ type: "warning", message });
            throw new Error(DEEPSEEK_FAST_CACHE_PROTECTION_ERROR_PREFIX + message);
          }
          concurrency = 1;
          fastWorkerLimit = 0;
          emit?.({ type: "log", message: "准备检查已结束，当前内容已经处理完毕。" });
        }
        await Promise.all(Array.from({ length: Math.max(1, fastWorkerLimit) }, () => runWorker()));
        fastInitialFinishedAt = Date.now();
      }
      else {
        await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, groups.length)) }, () => runWorker()));
      }
      await commitTail;
      if (failures.length) {
        const first = failures[0];
        throw new Error(
          `${failures.length}部分翻译失败，已完成内容不会丢失。第一个错误出现在第${first.index + 1}部分：${first.error?.message || first.error}`
        );
      }

      const maxDocumentRetryPasses = 1;
      const formatRetryAttempted = new Set();
      const effectiveDocumentRetryPasses = fastMode ? 1 : maxDocumentRetryPasses;
      for (let pass = 1; pass <= effectiveDocumentRetryPasses; pass++) {
        const documentRetryClassified = classifyRetryRecords(
          records,
          translations,
          settings.targetLanguage,
          settings.enableUntranslatedCheck
        ).filter(item => fastMode || !isFormatOnlyRetryReasons(item.reasons) || !formatRetryAttempted.has(item.record.id));
        if (!documentRetryClassified.length) break;

        const documentRetryRecords = documentRetryClassified.map(item => item.record);
        const retryDetails = new Map(documentRetryClassified.map(item => [item.record.id, {
          reasons: item.reasons || [],
          details: item.details || retryDetailsForRecord(item.record, translations, item.reasons || []),
          currentTranslation: translations[item.record.id] || ""
        }]));
        const formatOnly = record => {
          const reasons = retryDetails.get(record.id)?.reasons || [];
          return isFormatOnlyRetryReasons(reasons);
        };
        // One document-level repair request avoids splitting a few fallible
        // checks into several model calls. Each entry includes its source and
        // current translation, so a wider original-group context is not needed.
        const retryJobs = [{ records: documentRetryRecords, context: null }];
        if (!fastMode) for (const record of documentRetryRecords) {
          if (formatOnly(record)) formatRetryAttempted.add(record.id);
        }
        emit?.({
          type: "warning",
          message: fastMode
            ? `正在进行最后一轮定向校对，包含${documentRetryRecords.length}处待修正内容。`
            : `正在进行第${pass}/${effectiveDocumentRetryPasses}轮自动校对，包含${documentRetryRecords.length}处待修正内容。`
        });
        const retryBaseTranslations = { ...translations };
        const retryBaseFormulaReplacements = { ...formulaReplacements };
        const retryResults = new Map();
        const retryFailures = [];
        let nextRetryIndex = 0;
        let retryCommitTail = Promise.resolve();
        const commitRetryResult = (index, result) => {
          const task = retryCommitTail.then(async () => {
            retryResults.set(index, result);
            translations = { ...retryBaseTranslations };
            formulaReplacements = { ...retryBaseFormulaReplacements };
            for (const retryIndex of [...retryResults.keys()].sort((a, b) => a - b)) {
              const translated = retryResults.get(retryIndex);
              translations = { ...translations, ...translated.translations };
              formulaReplacements = { ...formulaReplacements, ...translated.formulaReplacements };
            }
            await this.storage.writeJSON(activePaths.translations, translations);
            await this.storage.writeJSON(activePaths.formulaReplacements, formulaReplacements);
            await this.storage.writeJSON(activePaths.meta, {
              identity,
              sourceFingerprint,
              complete: false,
              provider: settings.provider,
              baseURL: settings.baseURL,
              model: settings.model,
              targetLanguage: settings.targetLanguage,
              translationMode,
              totalBlocks: records.length,
              translatedBlocks: Object.keys(translations).length,
              completedGroups: groups.length,
              groupCount: groups.length,
              completedRetryGroups: retryResults.size,
              retryGroupCount: retryJobs.length,
              concurrency,
              updatedAt: new Date().toISOString()
            });
            emit?.({ type: "layout-translation", translations, model: null, complete: false });
          });
          retryCommitTail = task.catch(() => {});
          return task;
        };
        const runRetryWorker = async () => {
          while (true) {
            U.throwIfAborted(signal);
            const index = nextRetryIndex++;
            if (index >= retryJobs.length) return;
            try {
              const retryJob = retryJobs[index];
              const result = await this.translateGroup(
                retryJob.records,
                guide,
                String(settings.referenceContext || ""),
                documentID,
                identity,
                {
                  ...settings,
                  deferLayoutRetry: true,
                  transportRecovery: true,
                  retryDetails,
                  retryContextGroup: retryJob.context,
                  fullMarkdownContext: ""
                },
                groups.length + index,
                groups.length + retryJobs.length,
                emit,
                signal
              );
              await commitRetryResult(index, result);
            }
            catch (error) {
              retryFailures.push({ index, error });
              emit?.({
                type: "warning",
                message: `第${index + 1}/${retryJobs.length}部分校对失败，其他结果已保留：${error?.message || error}`
              });
            }
          }
        };
        await Promise.all(
          Array.from(
            { length: Math.min(concurrency, Math.max(1, retryJobs.length)) },
            () => runRetryWorker()
          )
        );
        await retryCommitTail;
        if (retryFailures.length) {
          const first = retryFailures[0];
          emit?.({
            type: "warning",
            message: `${retryFailures.length}部分校对重试网络中断，已完成的排版译文已保留：${first.error?.message || first.error}`
          });
          break;
        }
      }

      const remainingClassified = classifyRetryRecords(
        records,
        translations,
        settings.targetLanguage,
        settings.enableUntranslatedCheck
      );
      if (remainingClassified.length) {
        emit?.({
          type: "warning",
          message: `自动校对后仍有${remainingClassified.length}处内容需要留意。结果已保留，您可以查看后决定是否重新翻译。`
        });
      }
      if (fastMode) {
        emit?.({ type: "log", message: `DeepSeek 快速排版翻译完成，共处理 ${groups.length} 部分。` });
      }
      for (const record of records) {
        if (!translations[record.id]) translations[record.id] = sanitizeModelText(record.text);
      }
      const meta = {
        identity,
        sourceFingerprint,
        complete: true,
        provider: settings.provider,
        baseURL: settings.baseURL,
        model: settings.model,
        targetLanguage: settings.targetLanguage,
        translationMode,
        concurrency,
        fastCacheTelemetry: fastMode
          ? [...fastTelemetry.entries()].sort((first, second) => first[0] - second[0]).map(([index, item]) => ({
            request: index + 1,
            phase: item.phase,
            blockIDs: groups[index].map(record => record.id),
            ...item
          }))
          : [],
        totalBlocks: records.length,
        translatedBlocks: Object.keys(translations).length,
        completedAt: new Date().toISOString()
      };
      if (options.force) {
        await this.storage.writeJSON(activePaths.translations, translations);
        await this.storage.writeJSON(activePaths.formulaReplacements, formulaReplacements);
        await this.storage.writeJSON(activePaths.meta, meta);
        try {
          await this.storage.publishFilesAtomically([
            { source: activePaths.translations, destination: paths.translations },
            { source: activePaths.formulaReplacements, destination: paths.formulaReplacements },
            { source: activePaths.meta, destination: paths.meta }
          ]);
        }
        finally {
          await this.storage.remove(activePaths.translations, false);
          await this.storage.remove(activePaths.formulaReplacements, false);
          await this.storage.remove(activePaths.meta, false);
          if (this.storage.temporaryDir) await this.storage.remove(stagingRoot, true);
        }
      }
      else {
        await this.storage.writeJSON(paths.translations, translations);
        await this.storage.writeJSON(paths.formulaReplacements, formulaReplacements);
        await this.storage.writeJSON(paths.meta, meta);
      }
      const model = await this.buildModel(documentID, translations, formulaReplacements, { sourceFingerprint }, signal);
      emit?.({ type: "layout-translation", translations, model, complete: true });
      return { translations, formulaReplacements, model, meta, cached: false };
    }
  }

  LitMTrans.LayoutTranslationService = LayoutTranslationService;
  LitMTrans.LayoutHelpers = {
    validBBox,
    blockText,
    plainBlockText,
    hasUnsafeControlCharacters,
    sanitizeModelText,
    formulaSpans,
    imagePathFromBlock,
    safeLayoutTextToHTML,
    layoutLinesToHTML,
    symbolGlossaryParagraphs,
    layoutLogicalLines,
    layoutVisualLineCount,
    parseTocRows,
    parseTocTextRows,
    codeTextFromBlock,
    inferFontSize,
    fixedLayoutFontSize,
    translatedFlowPlainText,
    streamLineMetrics,
    estimateStreamUsedHeight,
    solveUniformStreamStyle,
    inferSingleColumnProfile,
    columnRightEdgesFromStreams,
    equationNumberRightForBBox,
    promoteStableSingleColumnItems,
    inheritStableSingleColumnShortItems,
    singleColumnBodyPromotionEnabled,
    visibleTextLength,
    affiliationLikeText,
    authorBylineLikeText,
    bibliographyLikeText,
    looksOverexpanded,
    looksUntranslated,
    classifyRetryRecords,
    retryDetailsForRecord,
    retryReasonSummary,
    recordsNeedingRetry,
    repairEquationReferenceTranslation,
    layoutConcurrencyLimit
  };
})(this);
