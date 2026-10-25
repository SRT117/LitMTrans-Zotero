(function (global) {
  "use strict";
  const L = global.LitMTrans = global.LitMTrans || {};
  const U = L.Utils;
  const escape = value => U.escapeHTML(String(value));

  function restoreLegacyStructure(payload, document) {
    if (payload?.parser_schema !== L.ParserModel.SCHEMA || document?.schema !== L.ParserModel.SCHEMA) return payload;
    return { ...payload, pdf_info: payload.pdf_info.map((page, index) => {
      const source = document.pages?.[index];
      if (!source || JSON.stringify(page.page_size) !== JSON.stringify([source.width, source.height])) return page;
      const restore = block => {
        if (block.type !== "table" || block.parser?.schema !== L.ParserModel.SCHEMA) return block;
        const candidates = (source.blocks || []).filter(item => item.id === block.parser.id && item.role === "table"
          && JSON.stringify(item.bbox) === JSON.stringify(block.bbox));
        if (candidates.length !== 1) return block;
        const original = candidates[0];
        if (!/<table[\s>]/i.test(original.text || "")) return block;
        return { ...block, blocks: (block.blocks || []).map(body => {
          if (body.type !== "table_body" || body.parser?.id !== `${original.id}-asset`
            || JSON.stringify(body.bbox) !== JSON.stringify(original.bbox)
            || !original.asset || body.image_path !== original.asset
            || (body.lines || []).some(line => (line.spans || []).some(span => span.html))) return body;
          // 只在内存中补回同一表格的结构，保留原始图片和磁盘缓存。
          return { ...body, lines: [{ bbox: body.bbox, spans: [{ type: "table", html: original.text }] }] };
        }) };
      };
      return { ...page, preproc_blocks: (page.preproc_blocks || []).map(restore) };
    }) };
  }

  function parseGrid(html, Parser = global.DOMParser || global.Zotero?.getMainWindow?.()?.DOMParser) {
    if (!Parser || !html || html.length > 1000000) return null;
    const doc = new Parser().parseFromString(html, "text/html");
    const tables = doc.querySelectorAll("table");
    if (tables.length !== 1 || doc.querySelector("img,svg,canvas,script,iframe,object,math")) return null;
    const table = tables[0];
    const rows = [...table.querySelectorAll("tr")];
    if (!rows.length || rows.length > 1000) return null;
    const grid = [], cells = [];
    let columns = 0;
    for (let row = 0; row < rows.length; row++) {
      grid[row] ||= [];
      let column = 0;
      const elements = [...rows[row].children];
      if (elements.some(cell => !["TD", "TH"].includes(cell.tagName.toUpperCase()))) return null;
      for (const element of elements) {
        while (grid[row][column]) column++;
        const rowspan = Number(element.getAttribute("rowspan") || 1);
        const colspan = Number(element.getAttribute("colspan") || 1);
        if (!Number.isInteger(rowspan) || !Number.isInteger(colspan) || rowspan < 1 || colspan < 1
          || row + rowspan > rows.length || column + colspan > 100) return null;
        for (let y = row; y < row + rowspan; y++) {
          grid[y] ||= [];
          for (let x = column; x < column + colspan; x++) {
            if (grid[y][x]) return null;
            grid[y][x] = true;
          }
        }
        const tokens = [];
        let unsupported = false;
        const protect = (source, html) => {
          const marker = `⟦${tokens.length}⟧`;
          tokens.push({ marker, source, html });
          return marker;
        };
        const read = node => {
          if (node.nodeType === 3) return node.textContent;
          if (node.nodeType !== 1) return "";
          const tag = node.tagName.toLowerCase();
          if (!["td", "th", "span", "b", "strong", "i", "em", "u", "sup", "sub", "br", "p", "div", "eq"].includes(tag)) unsupported = true;
          if (tag === "br") return "\n";
          if (tag === "eq") return protect(`\\(${node.textContent}\\)`, null);
          if (tag === "sup" || tag === "sub") return protect(node.textContent, `<${tag}>${escape(node.textContent)}</${tag}>`);
          const text = [...node.childNodes].map(read).join("");
          return ["p", "div"].includes(tag) ? `${text}\n` : text;
        };
        let text = read(element).trim();
        if (unsupported || /⟦|⟧/.test(element.textContent)) return null;
        text = text.replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/g,
          source => protect(source, null));
        text = text.replace(/\b[A-Za-z]+[-_]?\d+[A-Za-z\d._-]*\b/g,
          source => protect(source, `<span class="layout-table-fixed-cell">${escape(source)}</span>`));
        text = text.split(/(⟦\d+⟧)/g).map(part => /^⟦\d+⟧$/.test(part) ? part : part.replace(
          /[+−-]?\d+(?:[.,]\d+)*(?:[eE][+−-]?\d+)?%?/g,
          source => protect(source, `<span class="layout-table-fixed-cell">${escape(source)}</span>`)
        )).join("");
        const plain = text.replace(/⟦\d+⟧/g, "");
        const unitText = plain.trim().replace(/^[+−-]?\d+(?:[.,]\d+)?(?:\s*[±×]\s*\d+(?:[.,]\d+)?)?\s*/, "");
        const unitOnly = /^(?:%|°[CF]?|[kmunpµμ]?m|[kmunpµμ]?s|[kmunpµμ]?g|[kMG]?Hz|[kMGT]?Pa|[kM]?J|[kM]?W|[mkµμ]?A|[mkµμ]?V|[mkµμ]?L|mol|rad|rpm|[mkµμ]?m\/s)(?:[²³23−-]|\^[-+]?\d+)?$/u.test(unitText);
        cells.push({ index: cells.length, row, column, rowspan, colspan,
          header: element.tagName.toLowerCase() === "th", text, tokens,
          translate: !unitOnly && /[A-Za-z\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]{2}/.test(plain)
        });
        column += colspan;
      }
      columns = Math.max(columns, grid[row].length);
    }
    if (!columns || cells.length > 10000 || grid.some(row => row.length !== columns || Array.from({ length: columns }, (_, i) => !row[i]).some(Boolean))) return null;
    return { rows: rows.length, columns, cells };
  }

  function extract(layout, Parser) {
    const output = [];
    for (const [page, data] of (layout.pages || []).entries()) {
      const roots = data.preproc_blocks || [];
      const blockText = block => (block.lines || []).flatMap(line => line.spans || []).map(span => span.content || "").join("");
      const captions = roots.filter(block => /caption/.test(block.type || ""));
      const visit = (block, path, parentType = "", tableCaption = "") => {
        const type = String(block.type || "");
        if (["image", "chart", "image_body", "chart_body"].includes(type)) return;
        if (type === "table" && (block.blocks || []).some(child =>
          /^\s*(?:fig(?:ure)?\.?\s*\d|图\s*\d)/i.test(blockText(child))
          || /doi\.org\/\S+\.g\d+\b/i.test(blockText(child)))) return;
        if (type === "table_body" || (type === "table" && !block.blocks?.length)) {
          const html = (block.lines || []).flatMap(line => line.spans || []).find(span => span.html)?.html;
          const bbox = block.bbox;
          if (!html || !Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)
            || bbox[2] <= bbox[0] || bbox[3] <= bbox[1] || (parentType && parentType !== "table")) return;
          const caption = tableCaption || captions.filter(item => item.bbox && Math.abs(item.bbox[3] - bbox[1]) < 35)
            .map(item => (item.lines || []).flatMap(line => line.spans || []).map(span => span.content || "").join("")).join(" ");
          if (/forest\s+plot|森林图/i.test(caption + " " + html)) return;
          const grid = parseGrid(html, Parser);
          if (grid) {
            const headings = grid.cells.filter(cell => cell.row === 0).map(cell => cell.text).join(" ");
            if (/study or subgroup/i.test(headings) && /\bIV\s*,?\s*(?:Random|Fixed)\b/i.test(headings)) return;
            if (roots.some(item => ["image", "chart"].includes(item.type) && item.bbox
              && item.bbox[1] >= bbox[3] && item.bbox[1] - bbox[3] < 12
              && Math.abs(item.bbox[0] - bbox[0]) < 12 && Math.abs(item.bbox[2] - bbox[2]) < 12)) return;
          }
          if (grid?.cells.some(cell => cell.translate)) output.push({ id: `table:${page}:${path}`, page, bbox: [...bbox], caption, ...grid,
            fingerprint: U.hashString(JSON.stringify([page, path, bbox, grid])) });
          return;
        }
        const context = type === "table" ? (block.blocks || []).filter(child => /caption/.test(child.type)).map(blockText).join(" ") : tableCaption;
        for (const [index, child] of (block.blocks || []).entries()) visit(child, `${path}.${index}`, type, context);
      };
      for (const [index, block] of (data.preproc_blocks || []).entries()) visit(block, String(index));
    }
    return output;
  }

  function validText(cell, value) {
    if (typeof value !== "string" || (cell.text.trim() && !value.trim())) return false;
    const markers = value.match(/⟦\d+⟧/g) || [];
    return markers.length === cell.tokens.length
      && cell.tokens.every(token => markers.filter(marker => marker === token.marker).length === 1);
  }

  function render(table, translations) {
    const cellHTML = cell => {
      let text = cell.translate ? translations[cell.index] : cell.text;
      if (cell.translate && !validText(cell, text)) throw new Error("表格译文缺失或保护内容发生变化");
      let html = escape(text).replace(/\n/g, "<br />");
      for (const token of cell.tokens) {
        // 已保护的公式直接渲染，避免带空格的美元定界符被普通行内解析跳过。
        const rendered = token.html || L.Markdown.renderTeX(token.source);
        html = html.replace(token.marker, () => /class="katex-error"/.test(rendered) ? escape(token.source) : rendered);
      }
      const tag = cell.header ? "th" : "td";
      return `<${tag}${cell.translate ? "" : ' class="layout-table-fixed-cell"'} rowspan="${cell.rowspan}" colspan="${cell.colspan}">${html}</${tag}>`;
    };
    return `<table><tbody>${Array.from({ length: table.rows }, (_, row) => `<tr>${table.cells.filter(cell => cell.row === row).map(cellHTML).join("")}</tr>`).join("")}</tbody></table>`;
  }

  function attach(model, cache) {
    if (!model?.pages) return model;
    const active = cache?.version === 1 && cache.sourceFingerprint === model.sourceFingerprint && cache.tables?.length;
    if (!active && !model.tableTranslationHash) return model;
    const { tableTranslationHash: _previousHash, ...base } = model;
    return { ...base, ...(active ? { tableTranslationHash: U.hashString(`table-render-v2|${JSON.stringify(cache)}`) } : {}), pages: model.pages.map((page, index) => {
      const apply = block => {
        const { translatedTableHTML: _previousHTML, originalTableHTML: _previousOriginal, ...clean } = block;
        if (!active) return clean;
        const matches = (cache.tables || []).filter(table => table.page === index && JSON.stringify(table.bbox) === JSON.stringify(block.bbox));
        if (matches.length !== 1 || !["table", "table_body"].includes(block.type)) return clean;
        const table = matches[0];
        try { return { ...clean, translatedTableHTML: render(table, table.translations),
          originalTableHTML: render(table, Object.fromEntries(table.cells.filter(cell => cell.translate).map(cell => [cell.index, cell.text]))) }; }
        catch (_) { return clean; }
      };
      return { ...page, blocks: (page.blocks || []).map(apply), restoration: page.restoration ? {
        ...page.restoration, absoluteBlocks: (page.restoration.absoluteBlocks || []).map(apply)
      } : page.restoration };
    }) };
  }

  function fitColumnWidths(minimum, preferred, width, balanced = false) {
    const total = minimum.reduce((sum, value) => sum + value, 0);
    if (!minimum.length || total > width) return null;
    const weights = preferred.map((value, index) => {
      const extra = Math.max(0, value - minimum[index]);
      return balanced ? Math.sqrt(extra) : extra;
    });
    const weight = weights.reduce((sum, value) => sum + value, 0);
    return minimum.map((value, index) => value + (width - total) * (weight ? weights[index] / weight : 1 / minimum.length));
  }

  function visibleModel(model, enabled) {
    return enabled ? model : attach(model, null);
  }

  function requestPlan(layout, enabled, machine = false, reserved = new Set(), sourceTag = "") {
    const tables = enabled ? extract(layout) : [];
    const records = [];
    for (const [index, table] of tables.entries()) {
      let id = `tbl${index}${sourceTag ? `_${sourceTag}` : ""}`;
      while (reserved.has(id) || table.cells.some(cell => reserved.has(`${id}c${cell.index}`))) id = `_${id}`;
      table.requestID = id;
      const cells = table.cells.filter(cell => cell.translate);
      if (machine) {
        records.push(...cells.map(cell => ({ id: `${id}c${cell.index}`, page: table.page + 1, type: "table_cell", text: cell.text })));
      } else {
        const items = cells.map(cell => [cell.index, cell.text]);
        records.push({ id, page: table.page + 1, type: "table_cells", cells: items, caption: table.caption, text: JSON.stringify(items) });
      }
    }
    return { tables, records, machine, ids: new Set(records.map(record => record.id)) };
  }

  function responseCells(record, row) {
    let items = row?.cells;
    if (!items && typeof row?.text === "string") {
      try { items = JSON.parse(row.text); } catch (_) { return null; }
    }
    if (!Array.isArray(items) || items.length !== record.cells.length) return null;
    const wanted = new Map(record.cells), seen = new Set();
    for (const item of items) {
      if (!Array.isArray(item) || item.length !== 2 || !wanted.has(item[0]) || seen.has(item[0]) || typeof item[1] !== "string") return null;
      const source = wanted.get(item[0]);
      const tokens = (source.match(/⟦\d+⟧/g) || []).map(marker => ({ marker }));
      if (!validText({ text: source, tokens }, item[1])) return null;
      seen.add(item[0]);
    }
    return JSON.stringify(items);
  }

  function cacheFromRecords(plan, translations, sourceFingerprint, targetLanguage) {
    const tables = [];
    for (const table of plan.tables) {
      const values = {};
      if (plan.machine) {
        for (const cell of table.cells.filter(cell => cell.translate)) values[cell.index] = translations[`${table.requestID}c${cell.index}`];
      } else {
        const record = plan.records.find(record => record.id === table.requestID);
        const text = responseCells(record, { text: translations[table.requestID] });
        if (!text) continue;
        for (const [index, value] of JSON.parse(text)) values[index] = value;
      }
      try {
        render(table, values);
        tables.push({ ...table, translations: values });
      } catch (_) {}
    }
    return { version: 1, sourceFingerprint, targetLanguage, tables };
  }

  function cachedRecords(plan, cache, sourceFingerprint) {
    const values = {};
    if (cache?.sourceFingerprint !== sourceFingerprint) return values;
    for (const table of plan.tables) {
      const cached = cache.tables?.find(item => item.fingerprint === table.fingerprint);
      if (!cached) continue;
      try { render(table, cached.translations); } catch (_) { continue; }
      const cells = table.cells.filter(cell => cell.translate);
      if (plan.machine) {
        for (const cell of cells) values[`${table.requestID}c${cell.index}`] = cached.translations[cell.index];
      } else values[table.requestID] = JSON.stringify(cells.map(cell => [cell.index, cached.translations[cell.index]]));
    }
    return values;
  }

  function bodyTranslations(plan, translations) {
    return Object.fromEntries(Object.entries(translations).filter(([id]) => !plan.ids.has(id)));
  }

  L.LayoutTables = { restoreLegacyStructure, parseGrid, extract, validText, render, attach, visibleModel, fitColumnWidths,
    requestPlan, responseCells, cacheFromRecords, cachedRecords, bodyTranslations };
})(this);
