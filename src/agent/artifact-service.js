(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};
  const C = Agent.Contracts;
  const H = Agent.LibraryHelpers;

  function number(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function extension(path) {
    return String(path || "").toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || "";
  }

  function mime(path) {
    const ext = extension(path);
    return ({
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
      ".gif": "image/gif", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".pdf": "application/pdf",
      ".json": "application/json", ".md": "text/markdown", ".txt": "text/plain", ".csv": "text/csv"
    })[ext] || "application/octet-stream";
  }

  function htmlText(value) {
    return String(value || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p\s*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\s+\n/g, "\n")
      .trim();
  }

  function htmlRows(value) {
    const rows = [];
    for (const row of String(value || "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row[1].matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)]
        .map(match => htmlText(match[1]).replace(/\|/g, "\\|"));
      if (cells.length) rows.push(cells);
    }
    return rows;
  }

  function rowsToMarkdown(rows) {
    if (!rows.length) return "";
    const width = Math.max(...rows.map(row => row.length));
    const normalized = rows.map(row => [...row, ...Array(Math.max(0, width - row.length)).fill("")]);
    const header = normalized[0];
    const separator = header.map(() => "---");
    return [
      `| ${header.join(" | ")} |`,
      `| ${separator.join(" | ")} |`,
      ...normalized.slice(1).map(row => `| ${row.join(" | ")} |`)
    ].join("\n");
  }

  function rowsToCSV(rows) {
    return rows.map(row => row.map(cell => {
      const text = String(cell || "");
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }).join(",")).join("\n");
  }

  function modelBlocks(model) {
    const output = [];
    for (const page of model?.pages || []) {
      for (const block of page?.blocks || []) output.push({ ...block, page: number(block.page || page.index, page.index || 1), pageWidth: number(page.width), pageHeight: number(page.height) });
    }
    return output;
  }

  class ArtifactService {
    constructor(controller, library) {
      this.controller = controller;
      this.library = library;
    }

    async resolve(ref, options = {}) {
      const text = String(ref?.documentID || ref?.document || ref?.attachmentKey || ref?.itemKey || ref?.key || ref?.ref || ref || "").trim();
      let item = null;
      if (text && this.controller.storage.parseDocumentID?.(text)) item = this.controller.storage.resolveDocumentItem(text);
      if (!item) item = await this.library.resolveItem(text, options);
      const attachment = await this.controller.resolveAttachment(item);
      const context = await this.controller.attachmentContext(attachment.id, options.prepareCAJ !== false);
      return { item: H.isAttachment(item) ? (item.parentID ? global.Zotero.Items.get(item.parentID) || item : item) : item, attachment, context };
    }

    async snapshot(ref, options = {}) {
      const resolved = await this.resolve(ref, options);
      const snapshot = await this.controller.pipeline.snapshot(resolved.context);
      return { ...resolved, snapshot };
    }

    blockRows(snapshot) {
      return modelBlocks(snapshot?.snapshot?.layout?.model).map((block, index, all) => {
        const formulaItems = Array.isArray(block.formulaItems) ? block.formulaItems : [];
        const imageRefs = block.imagePath ? [String(block.imagePath)] : [];
        return {
          documentID: snapshot.context.documentID,
          blockID: String(block.id || `block-${index + 1}`),
          page: number(block.page, 1),
          type: String(block.type || ""),
          kind: String(block.kind || "text"),
          text: C.safeText(block.text || "", 100000),
          translation: C.safeText(block.translatedText || "", 100000),
          bbox: Array.isArray(block.bbox) ? block.bbox.map(number) : [],
          pageWidth: number(block.pageWidth),
          pageHeight: number(block.pageHeight),
          formulas: formulaItems.map(item => ({ id: String(item.id || ""), page: number(item.page || block.page), type: String(item.type || block.type || ""), tex: String(item.tex || "") })),
          imageRefs,
          image: block.imageURL || "",
          tableHTML: String(block.tableHTML || ""),
          sourceFingerprint: String(snapshot.snapshot?.parsed?.markdown ? LitMTrans.Utils.hashString(snapshot.snapshot.parsed.markdown) : ""),
          index: all.indexOf(block)
        };
      });
    }

    async manifestFromSnapshot(resolved) {
      const { context, attachment, item, snapshot } = resolved;
      const model = snapshot.layout?.model;
      const blocks = modelBlocks(model);
      const figures = blocks.filter(block => String(block.kind || "") === "image" || block.imagePath);
      const tables = blocks.filter(block => String(block.kind || "") === "table" || block.tableHTML || /^table(?:_|$)/i.test(String(block.type || "")));
      const formulas = blocks.reduce((sum, block) => sum + (Array.isArray(block.formulaItems) ? block.formulaItems.length : 0), 0);
      const sourceFingerprint = snapshot.parsed?.markdown ? LitMTrans.Utils.hashString(snapshot.parsed.markdown) : "";
      const translation = snapshot.translation || {};
      const layout = snapshot.layout || {};
      const settings = snapshot.capabilities || {};
      return C.redact({
        documentID: context.documentID,
        itemID: item?.id || null,
        itemKey: item?.key || "",
        attachmentID: attachment?.id || null,
        attachmentKey: attachment?.key || "",
        title: context.title,
        sourceFingerprint,
        parsed: Boolean(snapshot.parsed?.markdown),
        parsedAt: String(snapshot.parsed?.meta?.parsedAt || snapshot.parsed?.meta?.createdAt || ""),
        parseStale: false,
        streamTranslation: Boolean(translation.markdown),
        streamTranslationStale: Boolean(translation.stale),
        streamTranslationUpdatedAt: String(translation.meta?.completedAt || translation.meta?.updatedAt || ""),
        layoutSource: Boolean(snapshot.parsed?.hasLayout),
        layoutTranslation: Boolean(Object.keys(layout.translations || {}).length),
        layoutTranslationStale: Boolean(layout.stale),
        pageCount: number(model?.pages?.length || snapshot.parsed?.meta?.pageCount),
        blockCount: blocks.length,
        figureCount: figures.length,
        tableCount: tables.length,
        formulaCount: formulas,
        diagram: {
          mindmap: Boolean(await this.controller.storage.readJSON(this.controller.storage.path(context.documentID, "diagrams", "paper_mindmap.json"), null)),
          flowchart: Boolean(await this.controller.storage.readJSON(this.controller.storage.path(context.documentID, "diagrams", "paper_logic_flow.json"), null))
        },
        chatSessionCount: Array.isArray(snapshot.chat?.sessions) ? snapshot.chat.sessions.length : 0,
        revisionCount: 0,
        availableExports: ["source-markdown", "translation-markdown", "original-pdf", "document-images", "research-bundle"],
        capabilities: settings
      });
    }

    async getManifest(ref, options = {}) {
      const resolved = await this.snapshot(ref, options);
      return this.manifestFromSnapshot(resolved);
    }

    async getManifests(refs = [], options = {}) {
      const rows = [];
      for (const ref of Array.isArray(refs) ? refs : [refs]) {
        try { rows.push(await this.getManifest(ref, options)); }
        catch (error) { rows.push({ ref, error: C.asAgentError(error).toJSON() }); }
      }
      return rows;
    }

    async readSource(ref, options = {}) {
      const resolved = await this.snapshot(ref, options);
      const source = String(resolved.snapshot?.parsed?.markdown || "");
      return { documentID: resolved.context.documentID, type: "source", text: C.safeText(source, Number(options.maxChars || 200000)), truncated: source.length > Number(options.maxChars || 200000) };
    }

    async readTranslation(ref, options = {}) {
      const resolved = await this.snapshot(ref, options);
      const translation = String(resolved.snapshot?.translation?.markdown || resolved.snapshot?.translation?.live || "");
      return { documentID: resolved.context.documentID, type: "translation", text: C.safeText(translation, Number(options.maxChars || 200000)), stale: Boolean(resolved.snapshot?.translation?.stale), truncated: translation.length > Number(options.maxChars || 200000) };
    }

    async listBlocks(ref, options = {}) {
      const resolved = await this.snapshot(ref, options);
      let rows = this.blockRows(resolved);
      if (options.page) rows = rows.filter(row => row.page === Number(options.page));
      if (options.type) rows = rows.filter(row => row.type === String(options.type));
      const offset = Math.max(0, Number(options.offset || 0));
      const limit = Math.min(500, Math.max(1, Number(options.limit || 100)));
      return { documentID: resolved.context.documentID, total: rows.length, offset, limit, blocks: rows.slice(offset, offset + limit) };
    }

    async readPages(ref, pages, options = {}) {
      const resolved = await this.snapshot(ref, options);
      const wanted = new Set((Array.isArray(pages) ? pages : [pages]).map(Number).filter(Number.isFinite));
      const rows = this.blockRows(resolved).filter(row => !wanted.size || wanted.has(row.page));
      const grouped = new Map();
      for (const row of rows) grouped.set(row.page, [...(grouped.get(row.page) || []), row]);
      return { documentID: resolved.context.documentID, pages: [...grouped.entries()].sort((a, b) => a[0] - b[0]).map(([page, blocks]) => ({ page, blocks, text: blocks.map(block => block.text).filter(Boolean).join("\n") })) };
    }

    async readBlocks(ref, blockIDs, options = {}) {
      const wanted = (Array.isArray(blockIDs) ? blockIDs : [blockIDs]).filter(Boolean);
      const result = await this.listBlocks(ref, { ...options, limit: 500 });
      const set = new Set(wanted.map(String));
      return { documentID: result.documentID, blocks: result.blocks.filter(block => !set.size || set.has(String(block.blockID))) };
    }

    async getBlock(ref, blockRef, options = {}) {
      const resolved = await this.snapshot(ref, options);
      const rows = this.blockRows(resolved);
      const wanted = String(blockRef?.blockID || blockRef?.id || blockRef || "");
      const index = rows.findIndex(row => row.blockID === wanted || row.blockID.endsWith(`_${wanted}`));
      if (index < 0) throw new C.AgentError("BLOCK_NOT_FOUND", `未找到文本块 ${wanted}`, { recoverable: false });
      const before = Math.min(20, Math.max(0, Number(options.before || 0)));
      const after = Math.min(20, Math.max(0, Number(options.after || 0)));
      return { ...rows[index], contextBefore: rows.slice(Math.max(0, index - before), index), contextAfter: rows.slice(index + 1, index + 1 + after) };
    }

    async listSections(ref, options = {}) {
      const resolved = await this.snapshot(ref, options);
      const text = String(resolved.snapshot?.parsed?.markdown || "");
      const sections = [];
      for (const match of text.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gim)) {
        sections.push({ level: match[1].length, title: match[2].trim(), start: match.index, end: 0 });
      }
      for (let index = 0; index < sections.length; index++) sections[index].end = index + 1 < sections.length ? sections[index + 1].start : text.length;
      return { documentID: resolved.context.documentID, sections };
    }

    async readSection(ref, sectionRef, options = {}) {
      const resolved = await this.snapshot(ref, options);
      const text = String(resolved.snapshot?.parsed?.markdown || "");
      const sections = (await this.listSections(ref, options)).sections;
      const wanted = String(sectionRef?.title || sectionRef?.section || sectionRef || "");
      const section = sections.find(row => row.title === wanted || String(row.start) === wanted || String(row.index) === wanted);
      if (!section) throw new C.AgentError("SECTION_NOT_FOUND", `未找到章节 ${wanted}`, { recoverable: false });
      return { documentID: resolved.context.documentID, section, text: C.safeText(text.slice(section.start, section.end), Number(options.maxChars || 100000)) };
    }

    nearby(rows, index, before = 2, after = 2) {
      const target = rows[index];
      const samePage = rows.filter(row => row.page === target.page);
      const localIndex = samePage.findIndex(row => row.blockID === target.blockID);
      return {
        before: samePage.slice(Math.max(0, localIndex - before), localIndex),
        after: samePage.slice(localIndex + 1, localIndex + 1 + after)
      };
    }

    assetPath(documentID, imagePath, assetMap) {
      const normalize = value => LitMTrans.MinerUAsset?.normalizeAssetKey?.(String(value || "")) || String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
      const base = value => LitMTrans.MinerUAsset?.basename?.(normalize(value)) || normalize(value).split("/").pop();
      const key = normalize(imagePath);
      const stored = assetMap?.[key] || assetMap?.[base(key)] || assetMap?.[key.replace(/^images\//i, "")] || "";
      if (stored) return this.controller.storage.path(documentID, ...String(stored).replace(/\\/g, "/").split("/").filter(Boolean));
      return this.controller.storage.path(documentID, ...key.split("/").filter(Boolean));
    }

    async listFigures(ref, options = {}) {
      const resolved = await this.snapshot(ref, options);
      const rows = this.blockRows(resolved);
      const assetMap = resolved.snapshot?.parsed?.assetMap || await this.controller.storage.readJSON(this.controller.storage.path(resolved.context.documentID, "asset-map.json"), {});
      const figures = rows.filter(row => row.kind === "image" || row.imageRefs.length).map((row, index) => {
        const nearby = this.nearby(rows, rows.indexOf(row), 4, 4);
        const caption = [...nearby.before.reverse(), ...nearby.after].find(item => /(?:figure|fig\.?|图)\s*[0-9A-Za-z一二三四五六七八九十]+/i.test(item.text) || /caption/i.test(item.type))?.text || "";
        const imagePath = row.imageRefs[0] || "";
        const stored = imagePath ? this.assetPath(resolved.context.documentID, imagePath, assetMap) : "";
        return {
          figureID: `figure-${String(index + 1).padStart(3, "0")}`,
          ordinal: index + 1,
          blockID: row.blockID,
          page: row.page,
          bbox: row.bbox,
          caption: C.safeText(caption, 20000),
          asset: row.image || (stored ? this.controller.storage.resourceURL(resolved.context.documentID, String(stored).slice(this.controller.storage.documentDir(resolved.context.documentID).length + 1)) : ""),
          path: stored,
          mime: mime(stored || imagePath),
          nearbyBlocks: [...nearby.before, ...nearby.after].map(item => item.blockID),
          sourceFingerprint: row.sourceFingerprint
        };
      });
      return { documentID: resolved.context.documentID, figures };
    }

    async getFigure(ref, figureRef, options = {}) {
      const listed = await this.listFigures(ref, options);
      const wanted = String(figureRef?.figureID || figureRef?.id || figureRef || "");
      const figure = listed.figures.find(row => row.figureID === wanted || row.blockID === wanted || String(row.ordinal) === wanted || `figure-${String(row.ordinal)}` === wanted);
      if (!figure) throw new C.AgentError("FIGURE_NOT_FOUND", `未找到图片 ${wanted}`, { recoverable: false });
      const output = { ...figure };
      if (options.includeData !== false && figure.path) {
        try {
          const bytes = await this.controller.storage.readBytes(figure.path);
          const maxBytes = Math.min(12 * 1024 * 1024, Math.max(1024, Number(options.maxBytes || 8 * 1024 * 1024)));
          if (bytes?.length && bytes.length <= maxBytes) output.data = LitMTrans.Utils.encodeBytesBase64(bytes);
          else output.dataOmitted = true;
        }
        catch (_) { output.dataOmitted = true; }
      }
      return output;
    }

    async getFigureContext(ref, figureRef, options = {}) {
      const figure = await this.getFigure(ref, figureRef, options);
      const block = await this.getBlock(ref, figure.blockID, { ...options, before: options.before ?? 3, after: options.after ?? 3 });
      const source = String((await this.readSource(ref, { ...options, maxChars: 500000 })).text || "");
      const label = figure.caption.match(/(?:figure|fig\.?|图)\s*[0-9A-Za-z一二三四五六七八九十]+/i)?.[0] || `Figure ${figure.ordinal}`;
      const hits = [];
      for (const match of source.matchAll(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"))) hits.push({ start: match.index, end: match.index + label.length });
      return { figure, caption: figure.caption, previous: block.contextBefore, next: block.contextAfter, references: hits.slice(0, 20) };
    }

    async listFormulas(ref, options = {}) {
      const resolved = await this.snapshot(ref, options);
      const rows = this.blockRows(resolved);
      const formulas = [];
      for (const row of rows) for (const formula of row.formulas) {
        const numberMatch = String(formula.tex || "").match(/(?:\\tag\s*\{\s*([^}]+)\s*\}|\((\d+[A-Za-z]?)\)\s*$)/);
        formulas.push({
          formulaID: formula.id,
          ordinal: formulas.length + 1,
          page: row.page,
          blockID: row.blockID,
          bbox: row.bbox,
          number: numberMatch ? String(numberMatch[1] || numberMatch[2] || "") : "",
          tex: formula.tex,
          previousText: rows[Math.max(0, rows.indexOf(row) - 1)]?.text || "",
          nextText: rows[rows.indexOf(row) + 1]?.text || "",
          sourceFingerprint: row.sourceFingerprint
        });
      }
      return { documentID: resolved.context.documentID, formulas };
    }

    async getFormula(ref, formulaRef, options = {}) {
      const listed = await this.listFormulas(ref, options);
      let wanted = String(formulaRef?.formulaID || formulaRef?.id || formulaRef?.number || formulaRef || "").trim();
      wanted = wanted.replace(/^式\s*[（(]?/i, "").replace(/[）)]$/, "");
      const formula = listed.formulas.find(row => row.formulaID === wanted || row.number === wanted || String(row.ordinal) === wanted || String(row.formulaID).endsWith(wanted));
      if (!formula) throw new C.AgentError("FORMULA_NOT_FOUND", `未找到公式 ${formulaRef}`, { recoverable: false });
      return formula;
    }

    async getFormulaContext(ref, formulaRef, options = {}) {
      const formula = await this.getFormula(ref, formulaRef, options);
      const block = await this.getBlock(ref, formula.blockID, { ...options, before: options.before ?? 2, after: options.after ?? 2 });
      return { formula, previous: block.contextBefore, next: block.contextAfter };
    }

    async searchFormulas(ref, options = {}) {
      const query = String(options.query || "").trim().toLocaleLowerCase();
      if (!query) throw new C.AgentError("INVALID_QUERY", "公式搜索词不能为空", { recoverable: false });
      const rows = (await this.listFormulas(ref, options)).formulas.filter(row => `${row.number} ${row.tex}`.toLocaleLowerCase().includes(query));
      return { documentID: rows[0]?.documentID || (await this.resolve(ref, options)).context.documentID, query, formulas: rows.slice(0, Math.min(200, Number(options.limit || 50))) };
    }

    async listTables(ref, options = {}) {
      const resolved = await this.snapshot(ref, options);
      const rows = this.blockRows(resolved);
      const tables = rows.filter(row => row.kind === "table" || row.tableHTML || /^table(?:_|$)/i.test(row.type)).map((row, index) => {
        const raw = row.tableHTML || row.text;
        const parsedRows = htmlRows(raw);
        return {
          tableID: `table-${String(index + 1).padStart(3, "0")}`,
          ordinal: index + 1,
          blockID: row.blockID,
          page: row.page,
          bbox: row.bbox,
          caption: row.type.includes("caption") ? row.text : "",
          markdown: parsedRows.length ? rowsToMarkdown(parsedRows) : C.safeText(row.text, 100000),
          html: row.tableHTML,
          rows: parsedRows,
          columns: parsedRows.length ? Math.max(...parsedRows.map(item => item.length)) : 0,
          csv: rowsToCSV(parsedRows),
          nearbyBlocks: this.nearby(rows, rows.indexOf(row), 3, 3),
          sourceFingerprint: row.sourceFingerprint
        };
      });
      return { documentID: resolved.context.documentID, tables };
    }

    async getTable(ref, tableRef, options = {}) {
      const listed = await this.listTables(ref, options);
      const wanted = String(tableRef?.tableID || tableRef?.id || tableRef || "");
      const table = listed.tables.find(row => row.tableID === wanted || row.blockID === wanted || String(row.ordinal) === wanted || `table-${String(row.ordinal)}` === wanted);
      if (!table) throw new C.AgentError("TABLE_NOT_FOUND", `未找到表格 ${wanted}`, { recoverable: false });
      return table;
    }

    async getTableContext(ref, tableRef, options = {}) {
      const table = await this.getTable(ref, tableRef, options);
      const block = await this.getBlock(ref, table.blockID, { ...options, before: options.before ?? 2, after: options.after ?? 2 });
      return { table, previous: block.contextBefore, next: block.contextAfter };
    }

    async exportTable(ref, tableRef, format = "markdown", options = {}) {
      const table = await this.getTable(ref, tableRef, options);
      const normalized = String(format || "markdown").toLowerCase();
      const extension = normalized === "csv" ? "csv" : (normalized === "html" ? "html" : "md");
      const content = normalized === "csv" ? table.csv : (normalized === "html" ? table.html : table.markdown);
      const destination = String(options.destination || "").trim() || PathUtils.join(this.controller.storage.root, "exports", "tables");
      await this.controller.storage.ensureDir(destination);
      const filename = String(options.filename || `${table.tableID}.${extension}`).replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_");
      const path = PathUtils.join(destination, filename.endsWith(`.${extension}`) ? filename : `${filename}.${extension}`);
      await this.controller.storage.writeText(path, content || "");
      return { documentID: table.documentID, tableID: table.tableID, format: normalized, path };
    }

    runtimeForAttachment(attachmentID) {
      const rows = [...(this.controller.tabs?.values?.() || [])];
      return rows.find(row => String(row?.attachmentID || "") === String(attachmentID || "")) || rows.at(-1) || null;
    }

    async renderPage(ref, page, options = {}) {
      const resolved = await this.resolve(ref, { prepareCAJ: true });
      let renderer = this.controller.deepSeekWebProvider?.pageRenderer;
      if (!renderer?.renderPage && LitMTrans.DeepSeekWeb?.PDFPageRenderer) {
        renderer = new LitMTrans.DeepSeekWeb.PDFPageRenderer(this.controller);
      }
      if (!renderer?.renderPage) throw new C.AgentError("PDF_RENDER_UNAVAILABLE", "当前环境没有可用的PDF页面渲染器", { recoverable: true, suggestedAction: "retry_render_page" });
      const runtime = this.runtimeForAttachment(resolved.attachment.id);
      // Reader 打开后复用 iframe；没有 Reader 时交给 PDF.js 自加载附件字节。
      const renderRuntime = runtime || { attachmentID: resolved.attachment.id, libraryID: resolved.attachment.libraryID };
      const result = await renderer.renderPage(renderRuntime, page, options);
      return { documentID: resolved.context.documentID, attachmentID: resolved.attachment.id, ...result };
    }

    async renderPageRegion(ref, page, region, options = {}) {
      const rect = Array.isArray(region) ? region : (region?.rect || region?.bbox || region);
      if (!rect) throw new C.AgentError("REGION_REQUIRED", "页面区域不能为空", { recoverable: false });
      return this.renderPage(ref, page, { ...options, rect, rectFormat: options.rectFormat || (options.bbox ? "xyxy" : "xywh") });
    }

    async searchPaper(ref, options = {}) {
      const resolved = await this.snapshot(ref, options);
      const query = String(options.query || "").trim().toLocaleLowerCase();
      if (!query) throw new C.AgentError("INVALID_QUERY", "搜索词不能为空", { recoverable: false });
      const contentTypes = new Set((Array.isArray(options.contentTypes) ? options.contentTypes : []).map(String));
      const source = String(resolved.snapshot?.parsed?.markdown || "");
      const translation = String(resolved.snapshot?.translation?.markdown || "");
      const results = [];
      const addTextHits = (text, type, base = {}) => {
        const lower = text.toLocaleLowerCase();
        let cursor = 0;
        while (cursor < lower.length && results.length < 200) {
          const index = lower.indexOf(query, cursor);
          if (index < 0) break;
          results.push({ documentID: resolved.context.documentID, type, score: 1, snippet: C.safeText(text.slice(Math.max(0, index - 180), Math.min(text.length, index + query.length + 260)), 600), ...base, start: index });
          cursor = index + query.length;
        }
      };
      if (!contentTypes.size || contentTypes.has("text")) addTextHits(source, "text", { source: "source" });
      if (!contentTypes.size || contentTypes.has("translation")) addTextHits(translation, "translation", { source: "translation" });
      const blocks = this.blockRows(resolved);
      for (const block of blocks) {
        if ((!contentTypes.size || contentTypes.has("text")) && block.text.toLocaleLowerCase().includes(query)) addTextHits(block.text, "block", { blockID: block.blockID, page: block.page, locator: { blockID: block.blockID, page: block.page, type: block.type } });
        if ((!contentTypes.size || contentTypes.has("figure")) && (block.kind === "image" || block.imageRefs.length) && block.text.toLocaleLowerCase().includes(query)) addTextHits(block.text, "figure", { blockID: block.blockID, page: block.page });
        if ((!contentTypes.size || contentTypes.has("formula")) && block.formulas.some(item => item.tex.toLocaleLowerCase().includes(query))) addTextHits(block.formulas.map(item => item.tex).join("\n"), "formula", { blockID: block.blockID, page: block.page });
        if ((!contentTypes.size || contentTypes.has("table")) && (block.tableHTML || block.kind === "table") && `${block.text} ${block.tableHTML}`.toLocaleLowerCase().includes(query)) addTextHits(block.text || block.tableHTML, "table", { blockID: block.blockID, page: block.page });
      }
      return { documentID: resolved.context.documentID, query, results: results.sort((a, b) => b.score - a.score).slice(0, Math.min(200, Number(options.limit || 50))) };
    }

    async readDiagram(ref, mode = "mindmap", options = {}) {
      const resolved = await this.resolve(ref, options);
      const normalizedMode = mode === "flowchart" || mode === "flow" ? "flowchart" : "mindmap";
      const taskType = LitMTrans.DiagramCache.taskType(options.taskType || (normalizedMode === "flowchart" ? "paper_logic_flow" : "paper_mindmap"));
      const file = LitMTrans.DiagramCache.file(taskType);
      const data = await this.controller.storage.readJSON(this.controller.storage.path(resolved.context.documentID, "diagrams", file), null);
      const source = String(resolved.snapshot?.parsed?.markdown || await this.controller.storage.readText(this.controller.storage.path(resolved.context.documentID, "full.cleaned.md"), "") || await this.controller.storage.readText(this.controller.storage.path(resolved.context.documentID, "full.md"), ""));
      const normalized = LitMTrans.DiagramCache.normalize(data, taskType, normalizedMode);
      if (!normalized || normalized.mode !== normalizedMode || !source || normalized.sourceFingerprint !== LitMTrans.DiagramCache.sourceFingerprint(source)) {
        throw new C.AgentError("DIAGRAM_NOT_FOUND", `当前文献没有${normalizedMode === "flowchart" ? "流程图" : "思维导图"}缓存`, { recoverable: true });
      }
      return { documentID: resolved.context.documentID, ...normalized };
    }

    async saveDiagram(ref, mode, diagram, options = {}) {
      const resolved = await this.resolve(ref, options);
      const normalizedMode = mode === "flowchart" || mode === "flow" ? "flowchart" : "mindmap";
      const taskType = LitMTrans.DiagramCache.taskType(options.taskType || (normalizedMode === "flowchart" ? "paper_logic_flow" : "paper_mindmap"));
      const file = LitMTrans.DiagramCache.file(taskType);
      const path = this.controller.storage.path(resolved.context.documentID, "diagrams", file);
      await this.controller.storage.ensureDir(PathUtils.parent(path));
      const source = String(resolved.snapshot?.parsed?.markdown || await this.controller.storage.readText(this.controller.storage.path(resolved.context.documentID, "full.cleaned.md"), "") || await this.controller.storage.readText(this.controller.storage.path(resolved.context.documentID, "full.md"), ""));
      const payload = LitMTrans.DiagramCache.build({
        taskType,
        mode: normalizedMode,
        title: options.title,
        sourceFingerprint: LitMTrans.DiagramCache.sourceFingerprint(source),
        diagram: C.redact(diagram),
        updatedAt: C.now()
      });
      if (!payload || !source) throw new C.AgentError("DIAGRAM_INVALID", "图形缓存内容或原文指纹无效", { recoverable: false });
      await this.controller.storage.writeJSON(path, payload);
      return payload;
    }

    async clearDiagram(ref, mode = "mindmap", options = {}) {
      const resolved = await this.resolve(ref, options);
      const normalizedMode = mode === "flowchart" || mode === "flow" ? "flowchart" : "mindmap";
      const taskType = LitMTrans.DiagramCache.taskType(options.taskType || (normalizedMode === "flowchart" ? "paper_logic_flow" : "paper_mindmap"));
      const file = LitMTrans.DiagramCache.file(taskType);
      const path = this.controller.storage.path(resolved.context.documentID, "diagrams", file);
      if (await this.controller.storage.exists(path)) await this.controller.storage.removeFile(path);
      return { documentID: resolved.context.documentID, mode, cleared: true };
    }

    async resolveDiagramEvidence(ref, mode, nodeRef, options = {}) {
      const diagram = await this.readDiagram(ref, mode, options);
      const nodeID = String(nodeRef || "");
      const nodes = [];
      const walk = value => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) { for (const item of value) walk(item); return; }
        const id = String(value.id || value.nodeID || value.key || "");
        const label = String(value.text || value.title || value.label || value.name || "");
        if (id || label) nodes.push({ id, label, evidence: value.evidence || value.source || value.sources || null });
        for (const child of Object.values(value)) if (child && typeof child === "object") walk(child);
      };
      walk(diagram.diagram);
      const node = nodes.find(row => row.id === nodeID || row.label === nodeID) || null;
      const source = String((await this.readSource(ref, { ...options, maxChars: 500000 })).text || "");
      const query = String(node?.label || nodeID).trim();
      const references = [];
      if (query) for (const match of source.matchAll(new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"))) references.push({ start: match.index, end: match.index + query.length });
      return { documentID: diagram.documentID, mode, node, references: references.slice(0, 30) };
    }
  }

  Agent.ArtifactService = ArtifactService;
  Agent.ArtifactHelpers = { modelBlocks, htmlRows, rowsToMarkdown, rowsToCSV, mime };
})(this);
