(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};
  const C = Agent.Contracts;

  function escapeBib(value) {
    return String(value || "").replace(/[\\{}]/g, match => `\\${match}`);
  }

  function key(record, index) {
    const creator = String(record.creators?.[0]?.lastName || record.creators?.[0]?.name || "item").replace(/[^A-Za-z0-9]+/g, "").toLowerCase() || "item";
    const year = String(record.year || "nodate").slice(0, 4);
    return `${creator}${year}${index + 1}`;
  }

  function firstCreator(record) {
    return record.creators?.[0]?.name || record.creator || "";
  }

  function citationText(record, style = "apa") {
    const creators = Array.isArray(record.creators) ? record.creators : [];
    const author = creators.length > 1
      ? `${creators[0].name}${creators.length > 2 ? ", …" : ` & ${creators[1].name}`}`
      : firstCreator(record);
    const year = record.year || "n.d.";
    const title = record.title || "Untitled";
    const publication = record.publication || record.journal || "";
    if (/ieee/i.test(style)) return `${author}, “${title},” ${publication ? `${publication}, ` : ""}${year}.`;
    if (/gb|中国国家标准|7714/i.test(style)) return `${author}. ${title}${publication ? `. ${publication}` : ""}, ${year}.`;
    return `${author ? `${author} ` : ""}(${year}). ${title}.${publication ? ` ${publication}.` : ""}`;
  }

  function bibtex(record, citationKey) {
    const type = /book/i.test(record.itemType) ? "book" : "article";
    const creators = (record.creators || []).map(row => row.name).filter(Boolean).join(" and ");
    const fields = [
      ["author", creators], ["title", record.title], ["year", record.year], ["journal", record.publication || record.journal],
      ["volume", record.volume], ["issue", record.issue], ["pages", record.pages], ["publisher", record.publisher], ["doi", record.DOI], ["url", record.url]
    ].filter(([, value]) => String(value || "").trim());
    return `@${type}{${citationKey},\n${fields.map(([name, value]) => `  ${name} = {${escapeBib(value)}}`).join(",\n")}\n}`;
  }

  function ris(record) {
    const type = /book/i.test(record.itemType) ? "BOOK" : "JOUR";
    const lines = [`TY  - ${type}`];
    for (const creator of record.creators || []) lines.push(`AU  - ${creator.name}`);
    if (record.title) lines.push(`TI  - ${record.title}`);
    if (record.publication || record.journal) lines.push(`JO  - ${record.publication || record.journal}`);
    if (record.year) lines.push(`PY  - ${record.year}`);
    if (record.DOI) lines.push(`DO  - ${record.DOI}`);
    if (record.url) lines.push(`UR  - ${record.url}`);
    lines.push("ER  -");
    return lines.join("\n");
  }

  class CitationService {
    constructor(controller, library) {
      this.controller = controller;
      this.library = library;
      this.storage = controller.storage;
    }

    async records(refs = [], options = {}) {
      const values = (Array.isArray(refs) ? refs : [refs]).filter(Boolean);
      const rows = [];
      for (const ref of values) {
        let item = await this.library.resolveItem(ref, options);
        if (Agent.LibraryHelpers?.isAttachment?.(item) || item?.isAttachment?.()) {
          const pid = Agent.LibraryHelpers?.parentID?.(item) || item?.parentItemID;
          if (pid) {
            const parent = global.Zotero?.Items?.get ? global.Zotero.Items.get(pid) : null;
            if (parent) item = parent;
          }
        }
        rows.push(await this.library.itemRecord(item, { includeStatus: false }));
      }
      if (!rows.length) throw new C.AgentError("ITEMS_REQUIRED", "至少需要一个 Zotero 条目", { recoverable: false });
      return rows;
    }

    async generateCitation(refs, options = {}) {
      const rows = await this.records(refs, options);
      const style = String(options.style || "apa");
      let citation = "";
      let backend = "fallback";
      try {
        const cite = global.Zotero?.Cite;
        const ids = rows.map(row => row.id).filter(Boolean);
        if (cite?.makeCitationCluster && ids.length) {
          citation = await Promise.resolve(cite.makeCitationCluster(ids, { style, locale: options.locale || "en-US" }));
          if (citation) backend = "zotero-csl";
        }
      }
      catch (_) {}
      if (!citation || typeof citation !== "string") citation = rows.map(row => citationText(row, style)).join("; ");
      return C.redact({ style, locale: options.locale || "en-US", backend, items: rows.map(row => ({ id: row.id, key: row.key, title: row.title })), citation });
    }

    async generateBibliography(refs, options = {}) {
      const rows = await this.records(refs, options);
      const style = String(options.style || "apa");
      let textOutput = "";
      let backend = "fallback";
      try {
        const cite = global.Zotero?.Cite;
        const ids = rows.map(row => row.id).filter(Boolean);
        if (cite?.makeBibliography && ids.length) {
          const native = await Promise.resolve(cite.makeBibliography(ids, { style, locale: options.locale || "en-US" }));
          textOutput = typeof native === "string" ? native : String(native?.bib || native?.bibliography || native?.text || "");
          if (textOutput) backend = "zotero-csl";
        }
      }
      catch (_) {}
      const entries = textOutput ? textOutput.split(/\r?\n/).filter(Boolean) : rows.map(row => citationText(row, style));
      return C.redact({ style, locale: options.locale || "en-US", backend, entries, text: entries.join("\n") });
    }

    async nativeExport(items, format) {
      const Export = global.Zotero?.Translate?.Export;
      if (typeof Export !== "function") return "";
      const translation = new Export();
      const translators = await Promise.resolve(translation.getTranslators?.() || []);
      const rows = Array.isArray(translators) ? translators : Object.values(translators || {});
      const normalized = String(format || "").toLowerCase();
      const translator = rows.find(row => {
        const label = String(row?.label || row?.name || "").toLowerCase();
        const target = String(row?.target || "").toLowerCase();
        if (normalized === "bibtex" || normalized === "bib") return /better bibtex|bibtex/.test(label) || target === "bibtex";
        if (normalized === "ris") return /(?:^|\b)ris(?:\b|$)/.test(label) || target === "ris";
        return /csl.?json|citation style language/.test(label) || target === "csl-json";
      });
      if (!translator) return "";
      translation.setItems(items);
      translation.setTranslator(translator);
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          callback(value);
        };
        translation.setHandler?.("done", (output, worked) => {
          if (!worked) return finish(reject, new Error("Zotero export translator failed"));
          finish(resolve, String(output?.string || ""));
        });
        try {
          const result = translation.translate?.();
          if (result && typeof result.then === "function") {
            result.then(value => {
              if (typeof value === "string") finish(resolve, value);
            }).catch(error => finish(reject, error));
          }
        }
        catch (error) { finish(reject, error); }
      });
    }

    async exportFormat(refs, format, options = {}) {
      const rows = await this.records(refs, options);
      const normalized = String(format || "bibtex").toLowerCase();
      let content = "";
      let extension = normalized;
      let backend = "fallback";
      const nativeItems = [];
      for (const ref of Array.isArray(refs) ? refs : [refs]) {
        try { nativeItems.push(await this.library.resolveItem(ref, options)); }
        catch (_) {}
      }
      try {
        if (nativeItems.length) {
          content = await this.nativeExport(nativeItems, normalized);
          if (content) backend = "zotero-translator";
        }
      }
      catch (_) { content = ""; }
      if (normalized === "bibtex" || normalized === "bib") {
        extension = "bib";
        if (!content) content = rows.map((row, index) => bibtex(row, key(row, index))).join("\n\n");
      }
      else if (normalized === "ris") {
        if (!content) content = rows.map(ris).join("\n\n");
      }
      else if (normalized === "csl" || normalized === "csl-json" || normalized === "json") {
        extension = "json";
        if (!content) {
          content = JSON.stringify(rows.map(row => ({
            id: row.key || String(row.id), type: row.itemType === "book" ? "book" : "article-journal", title: row.title,
            author: (row.creators || []).map(creator => ({ literal: creator.name })), issued: row.year ? { "date-parts": [[Number(row.year)]] } : undefined,
            DOI: row.DOI || undefined, URL: row.url || undefined, "container-title": row.publication || row.journal || undefined
          })), null, 2);
        }
      }
      else throw new C.AgentError("CITATION_FORMAT_UNSUPPORTED", `不支持的引用格式 ${format}`, { recoverable: false });
      const destination = String(options.destination || "").trim() || PathUtils.join(this.storage.root, "exports", "citations");
      await this.storage.ensureDir(destination);
      const filename = String(options.filename || `references.${extension}`).replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_");
      const path = PathUtils.join(destination, filename.endsWith(`.${extension}`) ? filename : `${filename}.${extension}`);
      await this.storage.writeText(path, content);
      return { format: normalized, backend, path, count: rows.length, items: rows.map(row => ({ id: row.id, key: row.key, title: row.title })) };
    }
  }

  Agent.CitationService = CitationService;
})(this);
