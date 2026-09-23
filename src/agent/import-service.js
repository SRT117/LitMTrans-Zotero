(function (global) {
  "use strict";

  const LitMTrans = global.LitMTrans = global.LitMTrans || {};
  const Agent = LitMTrans.Agent = LitMTrans.Agent || {};
  const C = Agent.Contracts;

  function text(value) { return String(value ?? "").trim(); }

  function normalizeCreator(value, defaultType = "author") {
    if (typeof value === "string") {
      const name = text(value);
      return name ? { creatorType: defaultType, name } : null;
    }
    if (!value || typeof value !== "object") return null;
    const creatorType = text(value.creatorType || defaultType) || defaultType;
    const name = text(value.name || value.literal || value.display_name);
    if (name) return { creatorType, name };
    const firstName = text(value.firstName || value.given);
    const lastName = text(value.lastName || value.family);
    if (!firstName && !lastName) return null;
    return { creatorType, firstName, lastName };
  }

  function normalizeCreators(value, defaultType = "author") {
    const rows = Array.isArray(value) ? value : (value ? [value] : []);
    return rows.map(row => normalizeCreator(row, defaultType)).filter(Boolean);
  }

  function normalizeDOI(value) {
    return text(value).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").replace(/[\s\]}>,.;]+$/g, "");
  }

  function normalizeTitle(value) {
    return text(value).toLocaleLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, " ").trim();
  }

  function parseBibTeX(source) {
    const rows = [];
    const input = text(source);
    const entryRe = /@([a-z]+)\s*\{\s*([^,]+),([\s\S]*?)\}(?=\s*@|\s*$)/gi;
    for (const match of input.matchAll(entryRe)) {
      const fields = {};
      for (const field of match[3].matchAll(/([A-Za-z][\w-]*)\s*=\s*(?:\{([\s\S]*?)\}|"([\s\S]*?)"|([^,\n]+))/g)) {
        fields[String(field[1]).toLowerCase()] = text(field[2] ?? field[3] ?? field[4]).replace(/[{}]/g, "");
      }
      rows.push({ type: String(match[1]).toLowerCase(), key: text(match[2]), fields });
    }
    return rows;
  }

  function parseCSL(value) {
    const rows = Array.isArray(value) ? value : (Array.isArray(value?.items) ? value.items : [value]);
    return rows.filter(row => row && typeof row === "object").map(row => ({
      title: text(row.title), DOI: normalizeDOI(row.DOI), URL: text(row.URL || row.url),
      type: text(row.type || "article-journal"), containerTitle: text(row["container-title"] || row.publicationTitle),
      issued: row.issued?.["date-parts"]?.[0]?.[0] || row.year || "",
      author: (row.author || []).map(author => text(author.literal || [author.given, author.family].filter(Boolean).join(" "))).filter(Boolean),
      volume: text(row.volume), issue: text(row.issue), page: text(row.page), publisher: text(row.publisher)
    }));
  }

  class ImportService {
    constructor(library) {
      this.library = library;
    }

    async existingByDOI(doi, libraryID) {
      if (!normalizeDOI(doi)) return null;
      const result = await this.library.searchItems({ DOI: doi, libraryID, includeStatus: false, limit: 10 });
      return result.items?.[0] || null;
    }

    async existingByTitle(title, libraryID) {
      const wanted = normalizeTitle(title);
      if (wanted.length < 8) return null;
      try {
        const result = await this.library.searchItems({ title: text(title), libraryID, includeStatus: false, limit: 100 });
        return (result.items || []).find(row => normalizeTitle(row.title) === wanted) || null;
      }
      catch (_) { return null; }
    }

    async create(metadata = {}, options = {}) {
      const doi = normalizeDOI(metadata.DOI || metadata.doi);
      if (doi) {
        const existing = await this.existingByDOI(doi, options.libraryID);
        if (existing) return { created: false, duplicate: true, item: existing };
      }
      const titleDuplicate = await this.existingByTitle(metadata.title, options.libraryID);
      if (titleDuplicate) return { created: false, duplicate: true, duplicateReason: "title", item: titleDuplicate };
      const item = new global.Zotero.Item(String(metadata.itemType || metadata.type || "journalArticle") === "book" ? "book" : "journalArticle");
      item.libraryID = Number(options.libraryID || metadata.libraryID || 1);
      const fields = {
        title: metadata.title, abstractNote: metadata.abstractNote || metadata.abstract, date: metadata.date || metadata.year,
        DOI: doi, url: metadata.url || metadata.URL, publicationTitle: metadata.publicationTitle || metadata.containerTitle,
        volume: metadata.volume, issue: metadata.issue, pages: metadata.pages || metadata.page, publisher: metadata.publisher
      };
      for (const [field, value] of Object.entries(fields)) if (text(value)) item.setField?.(field, text(value));
      const creators = normalizeCreators(metadata.creators ?? metadata.author, "author");
      if (typeof item.setCreators === "function") {
        item.setCreators(creators);
      }
      if (this.library.saveEntity) await this.library.saveEntity(item);
      else if (Agent.getZoteroWriteCoordinator) await Agent.getZoteroWriteCoordinator().saveEntity(item, { label: "import" });
      else throw new C.AgentError("WRITE_COORDINATOR_UNAVAILABLE", "Zotero 写入协调器尚未初始化", { recoverable: true, suggestedAction: "retry" });
      const collection = options.collection || options.collectionID;
      if (collection) await this.library.addItemsToCollection(collection, [item.key]);
      return { created: true, duplicate: false, item: await this.library.itemRecord(item, { includeStatus: false }) };
    }

    async addByBibTeX(source, options = {}) {
      const rows = parseBibTeX(source);
      if (!rows.length) throw new C.AgentError("BIBTEX_INVALID", "未解析出 BibTeX 条目", { recoverable: false });
      const created = [];
      for (const row of rows) {
        const fields = row.fields;
        created.push(await this.create({
          itemType: row.type === "book" ? "book" : "journalArticle", title: fields.title, DOI: fields.doi, url: fields.url,
          date: fields.year, publicationTitle: fields.journal || fields.booktitle, volume: fields.volume, issue: fields.number,
          pages: fields.pages, publisher: fields.publisher, author: text(fields.author).split(/\s+and\s+/i).map(name => ({ name }))
        }, options));
      }
      return { count: created.length, items: created };
    }

    async addByCSL(value, options = {}) {
      const rows = parseCSL(typeof value === "string" ? JSON.parse(value) : value);
      if (!rows.length) throw new C.AgentError("CSL_JSON_INVALID", "未解析出 CSL JSON 条目", { recoverable: false });
      const items = [];
      for (const row of rows) items.push(await this.create({ ...row, date: row.issued, publicationTitle: row.containerTitle, author: row.author }, options));
      return { count: items.length, items };
    }

    async addByDOI(value, options = {}) {
      const doi = normalizeDOI(value);
      if (!doi) throw new C.AgentError("DOI_REQUIRED", "DOI 不能为空", { recoverable: false });
      const existing = await this.existingByDOI(doi, options.libraryID);
      if (existing) return { created: false, duplicate: true, item: existing };
      const translated = await this.translateIdentifier(doi, options);
      if (translated) return translated;
      let data = null;
      try {
        const response = await global.fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(`Crossref HTTP ${response.status}`);
        data = (await response.json())?.message;
      }
      catch (error) {
        throw new C.AgentError("DOI_IMPORT_FAILED", `DOI 元数据获取失败：${error?.message || error}`, { recoverable: true, suggestedAction: "add_by_bibtex" });
      }
      const fallback = await this.create({
        DOI: doi, title: data?.title?.[0], author: data?.author?.map(row => ({ firstName: row.given, lastName: row.family })) || [],
        date: data?.published?.["date-parts"]?.[0]?.[0] || data?.issued?.["date-parts"]?.[0]?.[0], publicationTitle: data?.["container-title"]?.[0],
        volume: data?.volume, issue: data?.issue, pages: data?.page, publisher: data?.publisher, url: data?.URL
      }, options);
      return { ...fallback, backend: "fallback-crossref", fallbackReason: "Zotero Translator unavailable or returned no item" };
    }

    async addByURL(value, options = {}) {
      const url = text(value);
      const doi = normalizeDOI(url.match(/10\.\d{4,9}\/[^\s/?#]+/i)?.[0] || "");
      if (doi) return this.addByDOI(doi, options);
      if (!url) throw new C.AgentError("URL_REQUIRED", "URL 不能为空", { recoverable: false });
      const translated = await this.translateURL(url, options);
      if (translated) return translated;
      const fallback = await this.create({ title: options.title || url, url }, options);
      return { ...fallback, backend: "fallback-webpage", fallbackReason: "Zotero Web Translator unavailable or returned no item" };
    }

    async translateIdentifier(identifier, options = {}) {
      const Search = global.Zotero?.Translate?.Search;
      if (typeof Search !== "function") return null;
      try {
        const translate = new Search();
        translate.setIdentifier(identifier);
        const translators = await translate.getTranslators();
        if (!translators?.length) return null;
        translate.setTranslator(translators);
        let collections = options.collectionID ? [Number(options.collectionID)] : undefined;
        if (!collections && options.collection) {
          try { collections = [Number((await this.library.resolveCollection(options.collection, options)).id)]; }
          catch (_) {}
        }
        const items = await translate.translate({ libraryID: Number(options.libraryID || 1), collections, saveAttachments: options.saveAttachments !== false });
        const item = Array.isArray(items) ? items[0] : null;
        if (!item) return null;
        const record = await this.library.itemRecord(item, { includeStatus: false });
        const duplicate = await this.existingByTitle(record.title, options.libraryID);
        if (duplicate && String(duplicate.key) !== String(record.key)) {
          item.deleted = true;
          await this.library.saveEntity?.(item);
          return { created: false, duplicate: true, duplicateReason: "title", backend: "zotero-translator", item: duplicate, importedItem: record };
        }
        return { created: true, duplicate: false, backend: "zotero-translator", item: record, extraItems: (items || []).slice(1).map(row => ({ key: row.key, id: row.id })) };
      }
      catch (_) { return null; }
    }

    async translateURL(url, options = {}) {
      const Web = global.Zotero?.Translate?.Web;
      if (typeof Web !== "function") return null;
      try {
        const translate = new Web();
        translate.setLocation(url);
        const translators = await translate.getTranslators();
        if (!translators?.length) return null;
        translate.setTranslator(translators);
        const items = await translate.translate({ libraryID: Number(options.libraryID || 1), saveAttachments: options.saveAttachments !== false });
        const item = Array.isArray(items) ? items[0] : null;
        if (!item) return null;
        return { created: true, duplicate: false, backend: "zotero-translator", item: await this.library.itemRecord(item, { includeStatus: false }) };
      }
      catch (_) { return null; }
    }

    async attachFile(values = {}) {
      const parent = await this.library.resolveItem(values.item || values.itemKey || values.parentID);
      const filePath = text(values.path || values.filePath);
      if (!filePath || !global.Zotero.Attachments?.importFromFile) throw new C.AgentError("FILE_REQUIRED", "需要本地文件路径", { recoverable: false });
      const attachment = await global.Zotero.Attachments.importFromFile({ file: LitMTrans.Utils.createLocalFile(filePath), parentItemID: parent.id, libraryID: parent.libraryID });
      return { attachmentID: attachment.id, attachmentKey: attachment.key, itemKey: parent.key, fileName: attachment.attachmentFilename || "" };
    }

    async addLocalFile(values = {}) {
      const filePath = text(values.path || values.filePath);
      if (!filePath || !global.Zotero.Attachments?.importFromFile) throw new C.AgentError("FILE_REQUIRED", "需要本地文件路径", { recoverable: false });
      const parent = values.item || values.itemKey || values.parentID ? await this.library.resolveItem(values.item || values.itemKey || values.parentID) : null;
      const attachment = await global.Zotero.Attachments.importFromFile({ file: LitMTrans.Utils.createLocalFile(filePath), parentItemID: parent?.id || false, libraryID: Number(values.libraryID || parent?.libraryID || 1) });
      return { attachmentID: attachment.id, attachmentKey: attachment.key, itemKey: parent?.key || "", fileName: attachment.attachmentFilename || "" };
    }
  }

  Agent.ImportService = ImportService;
  Agent.ImportHelpers = { normalizeDOI, normalizeCreator, normalizeCreators, parseBibTeX, parseCSL };
})(this);
