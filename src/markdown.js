(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const U = LitMTrans.Utils;

  const INLINE_MATH_PATTERNS = [
    /\\\[[\s\S]*?\\\]/g,
    /\\\([\s\S]*?\\\)/g,
    /\$\$[\s\S]*?\$\$/g,
    /(?<!\\)\$(?!\s|\$)(?:\\.|[^$\n\\])+?(?<!\s|\\)\$(?!\$)/g
  ];

  function markdownBlocks(text) {
    const lines = U.cleanText(text).split("\n");
    const blocks = [];
    let current = [];
    let inFence = false;
    let fenceMarker = "";
    let inMath = false;
    let inTable = false;

    const flush = () => {
      if (!current.length) return;
      blocks.push(current.join("\n") + "\n");
      current = [];
    };

    for (const line of lines) {
      const stripped = line.trim();
      const fence = stripped.match(/^(```+|~~~+)/);
      if (fence) {
        if (!inFence) {
          flush();
          inFence = true;
          fenceMarker = fence[1][0];
          current.push(line);
        }
        else {
          current.push(line);
          if (fence[1][0] === fenceMarker) {
            inFence = false;
            fenceMarker = "";
            flush();
          }
        }
        continue;
      }
      if (inFence) {
        current.push(line);
        continue;
      }

      // Keep display-math blocks together, matching the Python pipeline.
      // MinerU occasionally emits the opening/closing $$ on adjacent lines
      // without a blank separator; treating those lines as ordinary prose can
      // split a formula across translation requests.
      const startsMath = stripped === "$$" || stripped === "\\[" || stripped === "\\]" || stripped.startsWith("$$");
      if (startsMath && stripped.startsWith("$$")) {
        current.push(line);
        if (stripped === "$$") inMath = !inMath;
        if (!inMath && stripped === "$$") flush();
        continue;
      }
      if (inMath) {
        current.push(line);
        if (stripped === "\\]") {
          inMath = false;
          flush();
        }
        continue;
      }
      if (stripped === "\\[") {
        current.push(line);
        inMath = true;
        continue;
      }

      const isTableLine = /^\s*\|.*\|\s*$/.test(line) || (/\|/.test(line) && /^\s*:?-{3,}/.test(stripped));
      if (isTableLine) {
        if (!inTable) flush();
        inTable = true;
        current.push(line);
        continue;
      }
      if (inTable) {
        flush();
        inTable = false;
      }

      if (!stripped) {
        current.push(line);
        flush();
        continue;
      }
      if (/^#{1,6}\s+/.test(line) && current.length) flush();
      current.push(line);
    }
    flush();
    return blocks;
  }

  // Keep scroll anchors independent of rendered paragraphs. Translation can
  // legitimately change line wrapping and even paragraph element choices; a
  // stable marker before each Markdown block gives both reader panes a common
  // coordinate system, mirroring the original desktop reader.
  function injectSyncAnchors(markdown) {
    const lines = String(markdown || "").split("\n");
    const output = [];
    let index = 0;
    let inFence = false;
    let pending = true;
    for (const line of lines) {
      const trimmed = line.trim();
      const fence = /^(```+|~~~+)/.test(trimmed);
      if ((fence || (!inFence && trimmed)) && pending) {
        index++;
        output.push(`<a id="doc-block-${String(index).padStart(4, "0")}" class="litmtrans-sync-anchor"></a>`);
        pending = false;
      }
      output.push(line);
      if (fence) inFence = !inFence;
      if (!inFence && !trimmed) pending = true;
    }
    return output.join("\n");
  }

  function mathRanges(text) {
    const value = String(text || "");
    const ranges = [];
    for (const pattern of INLINE_MATH_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(value))) {
        ranges.push({ start: match.index, end: match.index + match[0].length });
        if (!match[0]) pattern.lastIndex++;
      }
    }
    ranges.sort((a, b) => a.start - b.start || b.end - a.end);
    const accepted = [];
    let lastEnd = -1;
    for (const range of ranges) {
      if (range.start < lastEnd) continue;
      accepted.push(range);
      lastEnd = range.end;
    }
    return accepted;
  }

  function splitOversizedBlock(block, maxChars) {
    const output = [];
    const ranges = mathRanges(block);
    let start = 0;
    while (start < block.length) {
      if (block.length - start <= maxChars) {
        output.push(block.slice(start));
        break;
      }
      const hardEnd = Math.min(block.length, start + maxChars);
      const minEnd = Math.min(hardEnd, start + Math.max(1, Math.floor(maxChars * 0.55)));
      let end = hardEnd;

      // Never cut through a TeX token. Prefer the token start; if the token is
      // itself larger than the budget, keep it intact and allow one large part.
      const crossing = ranges.find(range => range.start < end && range.end > end);
      if (crossing) {
        end = crossing.start > start ? crossing.start : crossing.end;
      }

      if (end <= hardEnd && end > minEnd) {
        const window = block.slice(minEnd, end);
        const candidates = [
          window.lastIndexOf("\n\n") >= 0 ? window.lastIndexOf("\n\n") + 2 : -1,
          window.lastIndexOf("\n") >= 0 ? window.lastIndexOf("\n") + 1 : -1
        ];
        const sentence = [...window.matchAll(/[。！？.!?；;](?:[\"'”’）)\]]*)\s+/g)].pop();
        if (sentence) candidates.push(sentence.index + sentence[0].length);
        const whitespace = [...window.matchAll(/\s+/g)].pop();
        if (whitespace) candidates.push(whitespace.index + whitespace[0].length);
        const best = Math.max(...candidates);
        if (best > 0) end = minEnd + best;
      }

      if (end <= start) end = Math.min(block.length, start + maxChars);
      output.push(block.slice(start, end));
      start = end;
    }
    return output;
  }

  function splitForTranslation(text, maxChars = 135000) {
    maxChars = Math.max(1000, Number(maxChars) || 135000);
    const chunks = [];
    let current = "";
    for (const block of markdownBlocks(text)) {
      if (current && current.length + block.length > maxChars) {
        chunks.push(current);
        current = "";
      }
      if (block.length > maxChars) {
        // Preserve exact source bytes and never split inside a recognized TeX
        // expression. Natural-language boundaries are preferred over raw cuts.
        if (current) {
          chunks.push(current);
          current = "";
        }
        chunks.push(...splitOversizedBlock(block, maxChars));
      }
      else {
        current += block;
      }
    }
    if (current) chunks.push(current);
    const original = String(text || "");
    if (chunks.length && chunks.join("") === original + "\n") {
      chunks[chunks.length - 1] = chunks[chunks.length - 1].slice(0, -1);
    }
    return chunks.length ? chunks : [original];
  }

  function extractMathTokens(text) {
    const value = String(text || "");
    const ranges = [];
    for (const pattern of INLINE_MATH_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(value))) {
        ranges.push({ start: match.index, end: match.index + match[0].length, text: match[0].replace(/\s+/g, " ").trim() });
        if (!match[0]) pattern.lastIndex++;
      }
    }
    ranges.sort((a, b) => a.start - b.start || b.end - a.end);
    const accepted = [];
    let lastEnd = -1;
    for (const range of ranges) {
      if (range.start < lastEnd) continue;
      accepted.push(range.text);
      lastEnd = range.end;
    }
    return accepted;
  }

  function formulaTokenBody(token) {
    const value = String(token || "");
    if (
      (value.startsWith("\\(") && value.endsWith("\\)"))
      || (value.startsWith("\\[") && value.endsWith("\\]"))
    ) return value.slice(2, -2);
    if (value.startsWith("$$") && value.endsWith("$$")) return value.slice(2, -2);
    if (value.startsWith("$") && value.endsWith("$")) return value.slice(1, -1);
    return value;
  }

  function collapseRedundantFormulaBraces(value) {
    let output = String(value || "");
    let previous = "";
    // Collapse only nested groups. Braces that delimit a fraction,
    // subscript, superscript, or command argument remain significant.
    while (output !== previous) {
      previous = output;
      output = output.replace(/\{\s*\{([^{}]*)\}\s*\}/g, "{$1}");
    }
    return output;
  }

  function normalizeMathBodyForRetry(value) {
    let output = String(value || "").normalize("NFKC");
    output = output
      .replace(/&(?:amp;)?lt;/gi, "<")
      .replace(/&(?:amp;)?gt;/gi, ">")
      .replace(/\s+/g, " ")
      .trim();
    // MinerU/OCR occasionally absorbs an ordered-list marker such as
    // ``; (ii)`` into the inline formula. Moving that marker outside the
    // formula is a safe layout repair, not a mathematical change.
    output = output.replace(
      /(?:\\[,;:!]\s*|[,;:]\s+|\s+)\((?:i{1,3}|iv|v|[a-c])\)\s*$/i,
      ""
    );
    output = collapseRedundantFormulaBraces(output);
    // Treat upright-text wrappers as presentation-only for retry decisions:
    // ``\\mathrm{H}``, ``\\mathrm { H }`` and ``H`` have the same visible
    // symbol in the OCR/layout cases this checker is meant to guard.
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

  function formulaRetryDetail(expected, actual, expectedIndex, actualIndex) {
    const expectedBody = normalizeMathBodyForRetry(formulaTokenBody(expected));
    const actualBody = actual ? normalizeMathBodyForRetry(formulaTokenBody(actual)) : "";
    const label = `公式#${expectedIndex + 1}`;
    if (!actual) {
      return `${label}缺少可渲染的数学定界符或主体（源: ${String(expected || "").slice(0, 180)}）`;
    }
    return `${label}数学主体疑似变化（标准化源: ${expectedBody.slice(0, 180)}；标准化当前值: ${actualBody.slice(0, 180)}；当前公式序号: ${actualIndex + 1}）`;
  }

  function mathIntegrityIssue(source, translated) {
    const expected = extractMathTokens(source);
    if (!expected.length) return "";
    const actual = extractMathTokens(translated);
    if (expected.length === actual.length && expected.every((token, index) => token === actual[index])) return "";
    return `原文含 ${expected.length} 个数学表达式，译文保留 ${actual.length} 个；行内/行间公式必须保留原TeX、定界符与顺序。`;
  }

  function mathRetryIssue(source, translated) {
    const expected = extractMathTokens(source);
    if (!expected.length) return "";
    const actual = extractMathTokens(translated);
    const expectedBodies = expected.map(token => normalizeMathBodyForRetry(formulaTokenBody(token)));
    const actualBodies = actual.map(token => normalizeMathBodyForRetry(formulaTokenBody(token)));
    let actualIndex = 0;
    for (let expectedIndex = 0; expectedIndex < expectedBodies.length; expectedIndex++) {
      const expectedBody = expectedBodies[expectedIndex];
      let combined = "";
      const firstActualIndex = actualIndex;
      while (actualIndex < actualBodies.length) {
        const actualBody = actualBodies[actualIndex];
        const proposed = combined + actualBody;
        if (expectedBody.startsWith(proposed)) {
          combined = proposed;
          actualIndex++;
          if (combined === expectedBody) break;
          continue;
        }
        // Extra formulas stay visible to the exact-integrity warning, but do
        // not justify another paid request. Keep searching for the source
        // mathematical payload in its original order.
        actualIndex++;
      }
      if (combined !== expectedBody) {
        const candidateIndex = Math.min(firstActualIndex, actual.length - 1);
        return formulaRetryDetail(
          expected[expectedIndex],
          candidateIndex >= 0 ? actual[candidateIndex] : null,
          expectedIndex,
          candidateIndex
        );
      }
    }
    return "";
  }

  function isOCRNonMathFormulaToken(token) {
    const body = String(formulaTokenBody(token) || "").replace(/&(?:amp;)?lt;/gi, "<").replace(/&(?:amp;)?gt;/gi, ">");
    if (/^\s*\\operatorname\s*\{\s*e\s*q\s*\.?\s*\}\s*$/i.test(body)) return true;
    if (/^\s*[-+]?\d+(?:\s*\.\s*\d+)?\s*\^\s*\{\s*\\circ\s*\}\s*\\mathrm\s*\{\s*[CFK]\s*\}\s*$/i.test(body)) return true;
    if (/^\s*(?:\\mathrm\s*\{\s*)?a\s*l\s*\.\s*\^\s*\{\s*(?:\d\s*)+(?:[-,]\s*(?:\d\s*)+)*\}\s*\}?\s*$/i.test(body)) return true;
    if (/^\s*\\mathrm\s*\{\s*(?:[A-Za-z]\s*){1,8}\.\s*\^\s*\{\s*(?:\d\s*)+(?:[-,]\s*(?:\d\s*)+)*\}\s*\}\s*$/i.test(body)) return true;
    const stripped = body.replace(/\\mathrm\s*\{([^{}]*)\}/gi, "$1").replace(/[\s()\[\]{};,]+/g, " ").trim();
    return /^(?:i\s*\.\s*e|e\s*\.\s*g|et(?:\s+|~|\\ )*al|etc|cf|vs)\s*\.?$/i.test(stripped);
  }

  // Layout translation uses a deliberately narrower automatic retry gate.
  // Differences in a same-count formula pair remain visible through
  // mathIntegrityIssue, but only a missing recognizable token is certain
  // enough to spend another model request.
  function mathMissingFormulaRetryIssue(source, translated) {
    const expected = extractMathTokens(source).filter(token => !isOCRNonMathFormulaToken(token));
    if (!expected.length) return "";
    const actual = extractMathTokens(translated).filter(token => !isOCRNonMathFormulaToken(token));
    if (actual.length >= expected.length) return "";
    const missingIndex = actual.length;
    return formulaRetryDetail(expected[missingIndex], null, missingIndex, missingIndex);
  }

  function normalizeTranslatedInlineHTML(text) {
    return normalizeEscapedTeXDelimiters(String(text || ""))
      .replace(/&lt;(\/?)(sup|sub)&gt;/gi, "<$1$2>")
      .replace(/&amp;lt;(\/?)(sup|sub)&amp;gt;/gi, "<$1$2>")
      .replace(/\r\n?/g, "\n");
  }

  function sourceEquationReferenceNumbers(text) {
    const equationReference = /\b(?:Eq|Eqs|Equation|Equations)\.?\s+(?:(?![.;。；]\s)[\s\S]){0,120}?[（(]\s*[A-Za-z]?\d+[A-Za-z]?\s*[)）]/gi;
    const numberPattern = /[（(]\s*([A-Za-z]?\d+[A-Za-z]?)\s*[)）]/g;
    const numbers = [];
    for (const match of String(text || "").matchAll(equationReference)) {
      numberPattern.lastIndex = 0;
      let numberMatch;
      while ((numberMatch = numberPattern.exec(match[0]))) {
        const number = String(numberMatch[1] || "").trim();
        if (number && !numbers.includes(number)) numbers.push(number);
      }
    }
    return numbers;
  }

  function repairEquationReferenceTranslation(source, translated) {
    const numbers = sourceEquationReferenceNumbers(source);
    let result = repairTranslatedImagePlaceholders(String(translated || "")).replace(
      /(?<![A-Za-z0-9])(?:\\?[~～〜]\s*)([A-Za-z]?\d+[A-Za-z]?|[a-z])\s*[!！](?![A-Za-z0-9])/gi,
      "($1)"
    );
    for (const number of numbers) {
      const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result
        .replace(new RegExp(`(?:[~～〜]\\s*)?${escaped}\\s*[!！]`, "g"), `式 (${number})`)
        .replace(new RegExp(`(?<![A-Za-z0-9])式\\s*${escaped}(?![A-Za-z0-9])`, "g"), `式 (${number})`)
        .replace(new RegExp(`(?<![A-Za-z0-9])方程\\s*${escaped}(?![A-Za-z0-9])`, "g"), `方程 (${number})`);
    }
    return result
      .replace(/(?:方程|公式)\s*[。.]\s*(式\s*\()/g, "$1")
      .replace(/\)\s*(和|与|及)\s*式/g, ") $1式");
  }

  function repairTranslatedImagePlaceholders(text) {
    if (!text) return "";
    let s = String(text);
    // 1. 匹配类似 [https://images/image_004.jpg](https://images/image_004.jpg) 或 [image_004.jpg](images/image_004.jpg)
    s = s.replace(/(?<!!)\[[^\]]*\]\((?:https?:\/\/(?:images\/)?)?(?:images\/)?(image_\d+\.[a-zA-Z0-9]+)\)/gi, (m, file) => {
      const id = file.replace(/\.[^.]+$/, "").toUpperCase();
      return `\n\n![${id}](images/${file})\n\n`;
    });
    // 2. 匹配带有 https:// 前缀的图片语法 ![IMAGE_004](https://images/image_004.jpg)
    s = s.replace(/!\[([^\]]*)\]\((?:https?:\/\/(?:images\/)?)?(?:images\/)?(image_\d+\.[a-zA-Z0-9]+)\)/gi, (m, alt, file) => {
      const id = alt || file.replace(/\.[^.]+$/, "").toUpperCase();
      return `\n\n![${id}](images/${file})\n\n`;
    });
    // 3. 匹配单独成行的超链接或路径 https://images/image_004.jpg 或 images/image_004.jpg
    s = s.replace(/^[ \t]*(?:https?:\/\/(?:images\/)?)?(?:images\/)?(image_\d+\.[a-zA-Z0-9]+)[ \t]*$/gim, (m, file) => {
      const id = file.replace(/\.[^.]+$/, "").toUpperCase();
      return `\n\n![${id}](images/${file})\n\n`;
    });
    return s;
  }

  const TEX_COMMANDS = Object.freeze({
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
    zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ",
    lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", omicron: "ο", pi: "π", varpi: "ϖ",
    rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ",
    phi: "φ", varphi: "ϕ", chi: "χ", psi: "ψ", omega: "ω",
    Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
    Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
    times: "×", cdot: "·", pm: "±", mp: "∓", div: "÷", leq: "≤", le: "≤",
    geq: "≥", ge: "≥", neq: "≠", ne: "≠", approx: "≈", sim: "∼", simeq: "≃",
    equiv: "≡", propto: "∝", infty: "∞", partial: "∂", nabla: "∇", sum: "∑",
    prod: "∏", int: "∫", iint: "∬", iiint: "∭", oint: "∮", sqrt: "√",
    to: "→", rightarrow: "→", leftarrow: "←", leftrightarrow: "↔", Rightarrow: "⇒",
    Leftarrow: "⇐", Leftrightarrow: "⇔", mapsto: "↦", degree: "°", circ: "°",
    ell: "ℓ", ldots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱", forall: "∀",
    exists: "∃", in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆", supset: "⊃",
    supseteq: "⊇", cup: "∪", cap: "∩", land: "∧", lor: "∨", neg: "¬",
    angle: "∠", perp: "⊥", parallel: "∥", mid: "∣", hbar: "ℏ"
  });

  function readTeXAtom(source, start) {
    if (start >= source.length) return { body: "", end: start };
    if (source[start] === "{") {
      let depth = 0;
      let body = "";
      for (let i = start; i < source.length; i++) {
        const ch = source[i];
        if (ch === "{") {
          depth++;
          if (depth > 1) body += ch;
        }
        else if (ch === "}") {
          depth--;
          if (depth === 0) return { body, end: i + 1 };
          body += ch;
        }
        else body += ch;
      }
      return { body, end: source.length };
    }
    if (source[start] === "\\") {
      const match = source.slice(start).match(/^\\[A-Za-z]+/);
      if (match) return { body: match[0], end: start + match[0].length };
    }
    return { body: source[start], end: start + 1 };
  }

  function renderTeXMatrix(raw, depth) {
    const match = raw.match(/^\\begin\{([pbvBV]?matrix|array)\}([\s\S]*?)\\end\{\1\}$/);
    if (!match) return null;
    // array has a leading alignment declaration, e.g. {lcr}; it is not a cell.
    const matrixBody = match[1] === "array" ? match[2].replace(/^\s*\{[^{}]*\}\s*/, "") : match[2];
    const rows = matrixBody.split(/\\\\/).map(row => row.trim()).filter(Boolean);
    const body = rows.map(row => {
      const cells = row.split("&").map(cell => `<td>${renderTeXBody(cell.trim(), depth + 1)}</td>`).join("");
      return `<tr>${cells}</tr>`;
    }).join("");
    return `<span class="litmtrans-matrix"><span class="litmtrans-matrix-bracket">[</span><table>${body}</table><span class="litmtrans-matrix-bracket">]</span></span>`;
  }

  function renderTeXBody(raw, depth = 0) {
    if (depth > 12) return U.escapeHTML(raw);
    const matrix = renderTeXMatrix(raw.trim(), depth);
    if (matrix) return matrix;
    let output = "";
    let i = 0;
    while (i < raw.length) {
      const ch = raw[i];
      if (ch === "\\") {
        const commandMatch = raw.slice(i).match(/^\\([A-Za-z]+|.)/);
        if (!commandMatch) {
          output += "\\";
          i++;
          continue;
        }
        const command = commandMatch[1];
        i += commandMatch[0].length;
        if (command === "frac" || command === "dfrac" || command === "tfrac") {
          const top = readTeXAtom(raw, i);
          const bottom = readTeXAtom(raw, top.end);
          output += `<span class="litmtrans-frac"><span>${renderTeXBody(top.body, depth + 1)}</span><span>${renderTeXBody(bottom.body, depth + 1)}</span></span>`;
          i = bottom.end;
          continue;
        }
        if (command === "sqrt") {
          const atom = readTeXAtom(raw, i);
          output += `<span class="litmtrans-root"><span class="litmtrans-root-sign">√</span><span class="litmtrans-root-body">${renderTeXBody(atom.body, depth + 1)}</span></span>`;
          i = atom.end;
          continue;
        }
        if (["text", "mathrm", "mathbf", "mathit", "mathsf", "mathtt", "operatorname"].includes(command)) {
          const atom = readTeXAtom(raw, i);
          const cls = command === "mathbf" ? " litmtrans-math-bold" : command === "mathit" ? " litmtrans-math-italic" : "";
          output += `<span class="litmtrans-math-text${cls}">${renderTeXBody(atom.body, depth + 1)}</span>`;
          i = atom.end;
          continue;
        }
        if (["left", "right", "displaystyle", "textstyle", "scriptstyle", "limits", "nolimits"].includes(command)) {
          continue;
        }
        if (TEX_COMMANDS[command]) output += U.escapeHTML(TEX_COMMANDS[command]);
        else if (command.length === 1) output += U.escapeHTML(command);
        else output += `<span class="litmtrans-tex-command">\\${U.escapeHTML(command)}</span>`;
        continue;
      }
      if (ch === "^" || ch === "_") {
        const atom = readTeXAtom(raw, i + 1);
        const tag = ch === "^" ? "sup" : "sub";
        output += `<${tag}>${renderTeXBody(atom.body, depth + 1)}</${tag}>`;
        i = atom.end;
        continue;
      }
      if (ch === "{") {
        const atom = readTeXAtom(raw, i);
        output += renderTeXBody(atom.body, depth + 1);
        i = atom.end;
        continue;
      }
      if (ch === "}") {
        i++;
        continue;
      }
      if (ch === "~") output += "&nbsp;";
      else output += U.escapeHTML(ch);
      i++;
    }
    return output;
  }

  // KaTeX renderToString is a pure function of (trimmed source, display) but
  // runs synchronously for every formula on every reader open. A translated
  // paper re-renders the identical TeX each launch, so memoize the produced
  // HTML. This only shrinks the work done while the layout reveal mask is up;
  // it never changes the output or when a page is shown.
  const renderTeXCache = new Map();
  const RENDER_TEX_CACHE_LIMIT = 4000;
  function renderTeXUncached(source, display = false) {
    let raw = String(source || "").trim();
    if (raw.startsWith("\\[") && raw.endsWith("\\]")) {
      display = true;
      raw = raw.slice(2, -2);
    }
    else if (raw.startsWith("\\(") && raw.endsWith("\\)")) raw = raw.slice(2, -2);
    else if (raw.startsWith("$$") && raw.endsWith("$$")) {
      display = true;
      raw = raw.slice(2, -2);
    }
    else if (raw.startsWith("$") && raw.endsWith("$")) raw = raw.slice(1, -1);
    // MinerU/translation fixtures can preserve comparison operators as HTML
    // entities inside TeX delimiters. MathJax receives their decoded DOM text
    // in the Python reader; passing the literal `&gt;`/`&lt;` token to KaTeX
    // instead produces red error text and changes the caption/body fit.
    raw = raw
      .replace(/&(?:amp;)?lt;/gi, "<")
      .replace(/&(?:amp;)?gt;/gi, ">")
      .replace(/&amp;/gi, "&");
    // KaTeX is bundled with the add-on.  It is deliberately local: rendering
    // a formula must never make a network request or depend on a web CDN.
    if (global.katex?.renderToString) {
      try {
        return global.katex.renderToString(raw.trim(), {
          displayMode: display,
          throwOnError: false,
          strict: "ignore",
          trust: false,
          output: "htmlAndMathml"
        });
      }
      catch (_) {}
    }
    const html = renderTeXBody(raw.trim());
    return `<span class="litmtrans-math ${display ? "litmtrans-math-display" : "litmtrans-math-inline"}" title="${U.escapeAttribute(source)}">${html}</span>`;
  }

  function renderTeX(source, display = false) {
    const key = `${display ? "1" : "0"} ${String(source || "")}`;
    const cached = renderTeXCache.get(key);
    if (cached !== undefined) return cached;
    const result = renderTeXUncached(source, display);
    // Bound the cache so a long session across many documents cannot grow it
    // without limit; drop the oldest entry once over the ceiling.
    if (renderTeXCache.size >= RENDER_TEX_CACHE_LIMIT) {
      renderTeXCache.delete(renderTeXCache.keys().next().value);
    }
    renderTeXCache.set(key, result);
    return result;
  }

  function splitTableRow(line) {
    let value = String(line || "").trim();
    if (value.startsWith("|")) value = value.slice(1);
    if (value.endsWith("|")) value = value.slice(0, -1);
    const cells = [];
    let current = "";
    let escaped = false;
    for (const ch of value) {
      if (ch === "\\" && !escaped) {
        escaped = true;
        current += ch;
        continue;
      }
      if (ch === "|" && !escaped) {
        cells.push(current.trim());
        current = "";
      }
      else current += ch;
      escaped = false;
    }
    cells.push(current.trim());
    return cells;
  }

  function repairPipeTableBlock(lines) {
    const rows = [];
    for (const rawLine of lines || []) {
      const pieces = String(rawLine || "").trim().split(/\s*\|\|\s*/).filter(piece => piece.trim());
      for (let piece of pieces) {
        if (!piece.includes("|")) continue;
        piece = piece.trim();
        if (!piece.startsWith("|")) piece = `| ${piece}`;
        if (!piece.endsWith("|")) piece = `${piece} |`;
        if (isTableSeparator(piece)) continue;
        const cells = splitTableRow(piece);
        if (cells.length >= 2) rows.push(cells);
      }
    }
    if (rows.length < 2) return null;
    const width = Math.max(...rows.map(row => row.length));
    if (width < 2) return null;
    const merged = [];
    for (const row of rows) {
      if (merged.length && merged[merged.length - 1].length < width && row.length < width) {
        merged[merged.length - 1].push(...row);
      }
      else merged.push(row);
    }
    const tableRow = row => {
      const padded = row.slice(0, width).map(cell => String(cell || "").trim());
      while (padded.length < width) padded.push("");
      return `| ${padded.join(" | ")} |`;
    };
    return [
      tableRow(merged[0]),
      `| ${Array(width).fill("---").join(" | ")} |`,
      ...merged.slice(1).map(tableRow)
    ];
  }

  function repairMalformedPipeTables(markdown) {
    const lines = String(markdown || "").split("\n");
    const output = [];
    let block = [];
    let inFence = false;
    const flush = () => {
      if (!block.length) return;
      output.push(...(repairPipeTableBlock(block) || block));
      block = [];
    };
    for (const line of lines) {
      const stripped = line.trim();
      if (/^(?:```|~~~)/.test(stripped)) {
        flush();
        inFence = !inFence;
        output.push(line);
        continue;
      }
      if (inFence) {
        output.push(line);
        continue;
      }
      const pipeish = line.includes("|") && !stripped.startsWith("![");
      const likelyTable = pipeish && (
        stripped.startsWith("|")
        || stripped.endsWith("|")
        || stripped.includes("||")
        || isTableSeparator(stripped)
      );
      if (likelyTable) {
        block.push(line);
        continue;
      }
      flush();
      output.push(line);
    }
    flush();
    return output.join("\n");
  }

  function repairFragmentedInlineMath(markdown) {
    const inlineFragment = String.raw`\$(?:[_^][^$]*|\\[A-Za-z]+[^$]*?)\$`;
    return repairPaddedDollarMath(String(markdown || ""))
      .replace(new RegExp(`(?<=[A-Za-z0-9)/\\\\\\]])\\s+(${inlineFragment})(?=\\s*[A-Za-z0-9(])`, "g"), "$1")
      .replace(new RegExp(`(?<=[A-Za-z0-9)/\\\\\\]])(${inlineFragment})\\s+(?=[A-Za-z0-9(])`, "g"), "$1");
  }

  function repairPaddedDollarMath(markdown) {
    // MinerU occasionally preserves a visual space immediately before the
    // closing dollar delimiter (for example `$R / R _ { 0 } = 6 $`).  The
    // reader's inline tokenizer deliberately rejects that form so ordinary
    // prose such as `$price $` is not swallowed as mathematics.  Normalize
    // only candidates with unambiguous TeX syntax, then let the usual strict
    // tokenizer render them.
    return String(markdown || "").replace(
      /(?<!\\)\$(?![\s$])([^$\n]*?)(\s+)\$(?!\$)/g,
      (raw, body) => /(?:\\[A-Za-z]+|[_^{}=<>])/.test(body) ? `$${body.trimEnd()}$` : raw
    );
  }

  function normalizeBareTeXFragments(text) {
    // Chat models occasionally omit the math delimiters around a compact
    // scientific token (for example `s_{\text{wp}}`).  MathJax in the Python
    // workbench only receives delimited TeX; without restoring those markers
    // here the add-on displays the source literally.  Restrict this repair to
    // a variable/command followed by a TeX sub- or superscript so prose,
    // Windows paths, and ordinary Markdown are never promoted to maths.
    const protectedParts = [];
    const protect = value => {
      const key = `@@LitMTransMATH${protectedParts.length.toString().padStart(5, "0")}@@`;
      protectedParts.push(value);
      return key;
    };
    // Protect complete Markdown images before looking for bare TeX. MinerU's
    // standard alt ids (for example IMAGE_004) otherwise look exactly like a
    // TeX subscript and get rewritten inside `![...](...)`, which can leak the
    // renderer's internal @@LitMTrans...@@ tokens into chat output.
    let value = String(text || "").replace(
      /!\[[^\]]*\]\(\s*(?:<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/g,
      protect
    ).replace(
      /\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|(?<!\\)\$(?!\s|\$)(?:\\.|[^$\n\\])+?(?<!\s|\\)\$(?!\$)/g,
      protect
    );
    const braced = String.raw`\{(?:[^{}\n]|\{[^{}\n]*\})+\}`;
    // TeX permits both `u_{\\text{wp}}` and the shorter
    // `u_\\text{wp}`.  The latter is what the current model response uses.
    const script = String.raw`\s*[_^]\s*(?:${braced}|\\[A-Za-z]+(?:${braced})?|[A-Za-z0-9])`;
    const bareTeX = new RegExp(String.raw`(?<![\\\w])(?:[A-Za-z][A-Za-z0-9]*|\\[A-Za-z]+)(?:${script})+`, "g");
    value = value.replace(bareTeX, raw => `\\(${raw}\\)`);
    return value.replace(/@@LitMTransMATH(\d{5})@@/g, (_match, index) => protectedParts[Number(index)] ?? _match);
  }

  function normalizeEscapedTeXDelimiters(text) {
    // Some OpenAI-compatible gateways return an already JSON-escaped formula
    // in `message.content`, leaving two literal backslashes in the rendered
    // reply.  Decode only a complete escaped TeX expression; never touch
    // ordinary prose or file paths.
    return String(text || "").replace(/\\{2}\(([^\n]*?)\\{2}\)/g, (_match, body) => {
      const normalizedBody = String(body || "").replace(/\\{2,}/g, run => (
        run.length % 2 === 0 ? "\\".repeat(run.length / 2) : run
      ));
      return `\\(${normalizedBody}\\)`;
    });
  }

  function isTableSeparator(line) {
    const cells = splitTableRow(line);
    return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")));
  }

  function protectInline(value, pattern, render, placeholders) {
    return value.replace(pattern, (...args) => {
      const raw = args[0];
      const key = `@@LitMTrans${placeholders.length.toString().padStart(5, "0")}@@`;
      placeholders.push(render(raw, ...args.slice(1, -2)));
      return key;
    });
  }

  function safeAllowedHTML(raw) {
    const value = String(raw || "");
    if (/^<br\s*\/?\s*>$/i.test(value)) return "<br />";
    if (/^<\/?(?:sup|sub|kbd|mark)>$/i.test(value)) return value.toLowerCase();
    const anchor = value.match(/^<a\s+id=["']([A-Za-z0-9_.:\-]+)["'](?:\s+class=["']litmtrans-sync-anchor["'])?\s*><\/a>$/i);
    if (anchor) {
      const sync = /\blitmtrans-sync-anchor\b/i.test(value) ? " litmtrans-sync-anchor" : "";
      return `<a id="${U.escapeAttribute(anchor[1])}" class="litmtrans-anchor${sync}"></a>`;
    }
    return U.escapeHTML(value);
  }

  function renderInline(text, options = {}) {
    const placeholders = [];
    let value = String(text || "");
    const imageLoading = options.imageLoading === "eager" ? "eager" : "lazy";

    value = protectInline(value, /`([^`\n]+)`/g, raw => `<code>${U.escapeHTML(raw.slice(1, -1))}</code>`, placeholders);
    value = protectInline(value, /\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$/g, raw => renderTeX(raw, true), placeholders);
    value = protectInline(value, /\\\([\s\S]*?\\\)|(?<!\\)\$(?!\s|\$)(?:\\.|[^$\n\\])+?(?<!\s|\\)\$(?!\$)/g, raw => renderTeX(raw, false), placeholders);
    value = protectInline(value, /<a\s+id=["'][A-Za-z0-9_.:\-]+["']\s*><\/a>|<br\s*\/?\s*>|<\/?(?:sup|sub|kbd|mark)>/gi, safeAllowedHTML, placeholders);

    value = protectInline(value, /!\[([^\]]*)\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/g, (raw, alt, target) => {
      let source = String(target || "").replace(/^<|>$/g, "");
      // A missing layout measurement means "use the image's natural width",
      // not a near-zero-width figure.  Stream reading normally has no
      // imageWidths map, while layout-derived readers may supply one.
      const width = Math.max(0, Math.min(100, Number(options.resolveImageWidth?.(source) || 0)));
      source = options.resolveImage ? options.resolveImage(source) : source;
      const label = /^IMAGE_\d+$/i.test(String(alt || "").trim()) ? "" : String(alt || "");
      if (!/^(?:resource|data|file|chrome):/i.test(source)) return `<span class="litmtrans-image-missing">[图片：${U.escapeHTML(label || source)}]</span>`;
      const style = width ? ` style="width:${width.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}%"` : "";
      return `<figure class="litmtrans-figure"><img loading="${imageLoading}" src="${U.escapeAttribute(source)}" alt="${U.escapeAttribute(label)}"${style} />${label ? `<figcaption>${U.escapeHTML(label)}</figcaption>` : ""}</figure>`;
    }, placeholders);

    value = protectInline(value, /\[([^\]]+)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/g, (raw, label, href) => {
      const safeHref = /^(?:https?|zotero|doi|mlitmtranso):/i.test(href) ? href : "";
      return safeHref
        ? `<a href="${U.escapeAttribute(safeHref)}" class="litmtrans-link">${U.escapeHTML(label)}</a>`
        : U.escapeHTML(label);
    }, placeholders);

    value = U.escapeHTML(value);
    value = value
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
      .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
      .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>")
      .replace(/(?<!_)_([^_\n]+)_(?!_)/g, "<em>$1</em>")
      .replace(/\\([\\`*{}\[\]()#+.!_>\-])/g, "$1");

    value = value.replace(/@@LitMTrans(\d{5})@@/g, (match, index) => placeholders[Number(index)] ?? match);
    return value;
  }

  function startsRawHTMLTable(lines, index) {
    const sample = lines.slice(index, Math.min(lines.length, index + 4)).join("\n").trimStart();
    return /^(?:<(?:div|center)\b[^>]*>\s*)*<table\b/i.test(sample);
  }

  function renderRawHTMLTable(raw, options = {}) {
    let document;
    try {
      document = new global.DOMParser().parseFromString(String(raw || ""), "text/html");
    }
    catch (_) {
      return "";
    }
    const sourceTable = document?.querySelector?.("table");
    if (!sourceTable) return "";

    const safeURL = (value, image = false) => {
      let result = String(value || "").trim();
      if (image && options.resolveImage) result = options.resolveImage(result);
      const pattern = image
        ? /^(?:resource|data|file|chrome):/i
        : /^(?:https?|zotero|doi|mlitmtranso):/i;
      return pattern.test(result) ? result : "";
    };
    const renderChildren = node => [...(node?.childNodes || [])].map(renderNode).join("");
    const renderNode = node => {
      if (!node) return "";
      if (node.nodeType === 3) return renderInline(node.nodeValue || "", options);
      if (node.nodeType !== 1) return "";
      const tag = String(node.localName || "").toLowerCase();
      if (tag === "br") return "<br />";
      if (["strong", "b", "em", "i", "code", "kbd", "mark", "sup", "sub"].includes(tag)) {
        const safeTag = tag === "b" ? "strong" : tag === "i" ? "em" : tag;
        return `<${safeTag}>${renderChildren(node)}</${safeTag}>`;
      }
      if (["p", "div"].includes(tag)) return `<span class="litmtrans-table-line">${renderChildren(node)}</span>`;
      if (tag === "span") return renderChildren(node);
      if (tag === "a") {
        const id = String(node.getAttribute("id") || "").trim();
        const href = safeURL(node.getAttribute("href"));
        const anchor = /^[A-Za-z0-9_.:\-]+$/.test(id)
          ? `<a id="${U.escapeAttribute(id)}" class="litmtrans-anchor"></a>`
          : "";
        return anchor + (href
          ? `<a href="${U.escapeAttribute(href)}" class="litmtrans-link">${renderChildren(node)}</a>`
          : renderChildren(node));
      }
      if (tag === "img") {
        const src = safeURL(node.getAttribute("src"), true);
        const alt = String(node.getAttribute("alt") || "");
        return src
          ? `<img loading="${imageLoading}" class="litmtrans-table-image" src="${U.escapeAttribute(src)}" alt="${U.escapeAttribute(alt)}" />`
          : `<span class="litmtrans-image-missing">[图片：${U.escapeHTML(alt || "无法读取")}]</span>`;
      }
      return renderChildren(node);
    };
    const cellAttributes = cell => {
      const attributes = [];
      for (const name of ["rowspan", "colspan"]) {
        const value = Math.max(1, Math.min(1000, Number.parseInt(cell.getAttribute(name) || "1", 10) || 1));
        if (value > 1) attributes.push(`${name}="${value}"`);
      }
      const inlineStyle = String(cell.getAttribute("style") || "");
      const styleAlign = inlineStyle.match(/(?:^|;)\s*text-align\s*:\s*(left|right|center|justify)\b/i)?.[1];
      const align = String(cell.getAttribute("align") || styleAlign || "").toLowerCase();
      if (["left", "right", "center", "justify"].includes(align)) {
        attributes.push(`style="text-align:${align}"`);
      }
      return attributes.length ? ` ${attributes.join(" ")}` : "";
    };
    const renderRow = row => {
      const cells = [...row.children].filter(cell => ["th", "td"].includes(String(cell.localName || "").toLowerCase()));
      if (!cells.length) return "";
      return `<tr>${cells.map(cell => {
        const tag = String(cell.localName || "").toLowerCase() === "th" ? "th" : "td";
        return `<${tag}${cellAttributes(cell)}>${renderChildren(cell)}</${tag}>`;
      }).join("")}</tr>`;
    };
    const renderSection = section => {
      const tag = String(section.localName || "").toLowerCase();
      const rows = [...section.children].filter(row => String(row.localName || "").toLowerCase() === "tr");
      return rows.length ? `<${tag}>${rows.map(renderRow).join("")}</${tag}>` : "";
    };

    const body = [];
    for (const child of sourceTable.children) {
      const tag = String(child.localName || "").toLowerCase();
      if (tag === "caption") body.push(`<caption>${renderChildren(child)}</caption>`);
      else if (["thead", "tbody", "tfoot"].includes(tag)) body.push(renderSection(child));
      else if (tag === "tr") body.push(renderRow(child));
    }
    if (!body.length) return "";
    return `<div class="litmtrans-table-wrap litmtrans-html-table-wrap"><table>${body.join("")}</table></div>`;
  }

  function toXHTMLFragment(html) {
    // DOMParser("text/html") serializes HTML void elements as <br> / <img>.
    // The workbench itself is XHTML, where assigning either form to innerHTML
    // raises NS_ERROR_DOM_SYNTAX_ERR. Normalize at the renderer boundary so
    // every consumer (stream reader, layout reader, and chat) gets XML-safe
    // markup even after a browser HTML round trip.
    return String(html || "").replace(
      /<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)(\b[^<>]*?)(?<!\/)>/gi,
      "<$1$2 />"
    );
  }

  function applyReaderPolish(html) {
    let document;
    try {
      document = new global.DOMParser().parseFromString(String(html || ""), "text/html");
    }
    catch (_) {
      return toXHTMLFragment(html);
    }
    const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
    const captionLead = text => /^(?:(?:图|表)\s*[\d一二三四五六七八九十IVXivx]+(?=\s*[（(.:：．、\-—]|$)|(?:Figure|Fig\.?|Table)\s*\d+[A-Za-z]?(?=\s*[\(\[.:：．、\-—]|$))/i.test(normalize(text));
    const captionContinuation = text => {
      const value = normalize(text);
      if (!value || value.length > 120 || captionLead(value) || /^(?:As shown|Figure|Fig\.?|Table|图|表)\b/i.test(value)) return false;
      return /^(?:[\(\[]?[a-z0-9]|at\s+\d|and\s+|or\s+|with\s+|where\s+|when\s+|[（(]?[a-z0-9])/i.test(value)
        || /[。.]\s*$/u.test(value);
    };
    let recentVisual = false;
    let previousCaption = false;
    for (const node of [...(document.body?.children || [])]) {
      const visual = node.matches?.("figure.litmtrans-figure, .litmtrans-table-wrap") || Boolean(node.querySelector?.("img, table"));
      if (visual) {
        recentVisual = true;
        previousCaption = false;
        continue;
      }
      const text = normalize(node.textContent);
      if (node.localName === "p" && text) {
        const mark = (captionLead(text) && (recentVisual || previousCaption))
          || (previousCaption && captionContinuation(text));
        if (mark) node.classList.add("caption-like");
        previousCaption = mark;
        recentVisual = false;
      }
      else if (text) {
        recentVisual = false;
        previousCaption = false;
      }
    }
    return toXHTMLFragment(document.body?.innerHTML || String(html || ""));
  }

  function renderMarkdown(markdown, options = {}) {
    const prepared = repairTranslatedImagePlaceholders(repairFragmentedInlineMath(repairMalformedPipeTables(markdown)));
    const lines = U.cleanText(prepared).split("\n");
    const output = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) {
        i++;
        continue;
      }

      const syncAnchor = trimmed.match(/^<a\s+id=["'](doc-block-\d+)["']\s+class=["']litmtrans-sync-anchor["']\s*><\/a>$/i);
      if (syncAnchor) {
        output.push(`<a id="${syncAnchor[1]}" class="litmtrans-anchor litmtrans-sync-anchor"></a>`);
        i++;
        continue;
      }

      const fence = trimmed.match(/^(```+|~~~+)\s*([^\s]*)/);
      if (fence) {
        const marker = fence[1][0];
        const language = fence[2] || "";
        const body = [];
        i++;
        while (i < lines.length && !new RegExp(`^\\s*${marker}{3,}`).test(lines[i])) {
          body.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++;
        output.push(`<pre class="litmtrans-code"><code data-language="${U.escapeAttribute(language)}">${U.escapeHTML(body.join("\n"))}</code></pre>`);
        continue;
      }

      // MinerU commonly writes display mathematics on three or more lines:
      // $$\n...formula...\n$$.  Keep that block intact before paragraph parsing.
      const displayClose = trimmed === "$$" ? "$$" : trimmed === "\\[" ? "\\]" : "";
      if (displayClose) {
        const opening = trimmed;
        const body = [];
        i++;
        while (i < lines.length && lines[i].trim() !== displayClose) {
          body.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++;
        const formula = `${opening}\n${body.join("\n")}\n${displayClose}`;
        output.push(`<div class="litmtrans-display-formula">${renderTeX(formula, true)}</div>`);
        continue;
      }

      if (startsRawHTMLTable(lines, i)) {
        const tableLines = [];
        let closed = false;
        while (i < lines.length) {
          tableLines.push(lines[i]);
          if (/<\/table\s*>/i.test(lines[i])) {
            closed = true;
            i++;
            while (
              i < lines.length
              && /^(?:\s*<\/(?:div|center)\s*>\s*)+$/.test(lines[i])
            ) {
              tableLines.push(lines[i]);
              i++;
            }
            break;
          }
          i++;
        }
        const rendered = closed ? renderRawHTMLTable(tableLines.join("\n"), options) : "";
        output.push(rendered || `<pre class="litmtrans-code litmtrans-invalid-table">${U.escapeHTML(tableLines.join("\n"))}</pre>`);
        continue;
      }

      const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        const level = heading[1].length;
        output.push(`<h${level}>${renderInline(heading[2], options)}</h${level}>`);
        i++;
        continue;
      }

      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        output.push("<hr />");
        i++;
        continue;
      }

      if (/^\s*!\[[^\]]*\]\(\s*(?:<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)\s*$/.test(line)) {
        output.push(renderInline(line.trim(), options));
        i++;
        continue;
      }

      if (i + 1 < lines.length && line.includes("|") && isTableSeparator(lines[i + 1])) {
        const header = splitTableRow(line);
        const align = splitTableRow(lines[i + 1]).map(cell => {
          const clean = cell.replace(/\s/g, "");
          if (clean.startsWith(":") && clean.endsWith(":")) return "center";
          if (clean.endsWith(":")) return "right";
          return "left";
        });
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
          rows.push(splitTableRow(lines[i]));
          i++;
        }
        output.push(`<div class="litmtrans-table-wrap"><table><thead><tr>${header.map((cell, idx) => `<th style="text-align:${align[idx] || "left"}">${renderInline(cell, options)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${header.map((_, idx) => `<td style="text-align:${align[idx] || "left"}">${renderInline(row[idx] || "", options)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
        continue;
      }

      if (/^\s*>/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        output.push(`<blockquote>${renderMarkdown(quote.join("\n"), options)}</blockquote>`);
        continue;
      }

      const listMatch = line.match(/^\s*([-+*]|\d+[.)])\s+(.+)$/);
      if (listMatch) {
        const ordered = /^\d/.test(listMatch[1]);
        const tag = ordered ? "ol" : "ul";
        const items = [];
        while (i < lines.length) {
          const match = lines[i].match(/^\s*([-+*]|\d+[.)])\s+(.+)$/);
          if (!match || /^\d/.test(match[1]) !== ordered) break;
          items.push(match[2]);
          i++;
        }
        output.push(`<${tag}>${items.map(item => `<li>${renderInline(item, options)}</li>`).join("")}</${tag}>`);
        continue;
      }

      const paragraph = [line];
      i++;
      while (i < lines.length && lines[i].trim()) {
        const next = lines[i];
        if (/^\s*(?:#{1,6}\s+|```|~~~|>|[-+*]\s+|\d+[.)]\s+)/.test(next)) break;
        if (startsRawHTMLTable(lines, i)) break;
        if (i + 1 < lines.length && next.includes("|") && isTableSeparator(lines[i + 1])) break;
        paragraph.push(next);
        i++;
      }
      output.push(`<p>${paragraph.map(part => renderInline(part, options)).join("<br />")}</p>`);
    }
    return applyReaderPolish(output.join("\n"));
  }

  function extractHeadings(markdown) {
    const headings = [];
    for (const line of U.cleanText(markdown).split("\n")) {
      const match = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (match) headings.push({ level: match[1].length, text: match[2].replace(/[*_`]/g, "").trim() });
    }
    return headings;
  }

  LitMTrans.Markdown = {
    markdownBlocks,
    injectSyncAnchors,
    splitForTranslation,
    extractMathTokens,
    normalizeMathBodyForRetry,
    mathIntegrityIssue,
    mathRetryIssue,
    mathMissingFormulaRetryIssue,
    normalizeTranslatedInlineHTML,
    sourceEquationReferenceNumbers,
    repairEquationReferenceTranslation,
    renderTeX,
    renderInline,
    renderRawHTMLTable,
    toXHTMLFragment,
    repairFragmentedInlineMath,
    normalizeBareTeXFragments,
    normalizeEscapedTeXDelimiters,
    repairMalformedPipeTables,
    repairTranslatedImagePlaceholders,
    renderMarkdown,
    extractHeadings,
    splitTableRow
  };
})(this);
